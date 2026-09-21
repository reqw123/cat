// 匯出分享：把一張卡片「旋轉一圈」錄成 WebM／GIF，或匯出 PNG（透明背景）。
//
// 做法（每一步都是實測後才定案，見 桌面掛件說明.md〈匯出分享〉）：
//   - 不去截桌面上那個「真的在用」的掛件視窗：它有使用者自己的縮放／透明度／位置，穿透模式、
//     被別的視窗蓋住、螢幕解析度不夠高都會影響成品。改成另開一個看不見的離屏視窗（座標放在
//     螢幕外、不搶焦點、不進工作列）重新載入同一份卡片 html，固定 500×680 的畫面、卡片 372 寬置中。
//   - 用 Chrome DevTools Protocol 的 Page.captureScreenshot 截圖：能指定解析度倍率（PNG/WebM 用 2 倍、
//     GIF 用 0.8 倍直接算出來，不是事後縮圖）、會強制重畫（webContents.capturePage() 實測有「畫面落後一格」）、
//     Emulation.setDefaultBackgroundColorOverride 能得到真正的透明背景。
//     ⚠️ 視窗如果是 show:false 的隱藏視窗，Chromium 會把它降到約 1 fps（每格 4 秒）——所以是「顯示但放在螢幕外」。
//   - 旋轉由這裡接管，不跟卡片自己的動畫搶：所有卡片的 .card 都是
//     transform: rotateX(var(--rx)) rotateY(var(--ry))，匯出時改成吃 --exp-rx/--exp-ry 兩個變數，
//     每一格精準指定角度（速度不均勻的原生翻面動畫沒辦法對齊影格）。
//     全息光澤／主體視差／背景視差是卡片自己依「滑鼠位置」算的，所以每格另外送一個合成的 pointermove
//     （跟外殼穿透模式追蹤游標用的同一招），位置隨相位繞一圈——光澤才會在旋轉過程中流動。
//   - 編碼放在另一個隱藏視窗（encoder.html），main process 不被壓縮運算卡住。
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ⚠️ 放在螢幕外的視窗會被 Chromium 的「原生視窗遮蔽偵測」判成 document.visibilityState === 'hidden'，
// requestAnimationFrame 直接停擺（卡片的緩動動畫不動、每格的「等兩個 rAF」永遠不回來）；視窗放在螢幕上
// 但完全透明（opacity 0）也一樣。實測只有關掉遮蔽偵測才會恢復。這兩個旗標必須在 app ready 之前設定，
// 所以放在模組載入時（main.js 一開頭就 require 這支）。影響範圍只有這個 process：桌面掛件本來就永遠
// 置頂、沒有「被蓋住就省電不畫」這回事，所以對平常使用沒有影響。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const VIEW_W = 500; // 匯出畫面的 CSS 尺寸：卡片 372×520.8 置中，四周留白給陰影、破框的主體與旋轉時的透視放大
const VIEW_H = 680;
const OFFSCREEN = -20000; // 離屏視窗的座標

const FORMATS = {
  png: { ext: 'png', label: 'PNG 圖片', scale: 2 },
  webm: { ext: 'webm', label: 'WebM 影片（旋轉一圈）', scale: 2, fps: 30, bitrate: 6000000 },
  gif: { ext: 'gif', label: 'GIF 動圖（旋轉一圈）', scale: 1.5, fps: 25 },
};
// GIF 尺寸倍率：單張＝500×680 CSS px × 倍率（1.5＝750×1020；以前 0.8＝400×544）。呼叫端可用 o.gifScale 覆寫（main.js：環境變數 GIF_SCALE／package.json 的 gifScale）。
const GIF_SCALE_DEFAULT = FORMATS.gif.scale;
const gifScaleOf = (o) => Math.min(2.5, Math.max(0.5, Number(o.gifScale) > 0 ? Number(o.gifScale) : GIF_SCALE_DEFAULT));
// 影片／GIF 每一格的擷取格式：GIF 用 PNG 無損（量化成 256 色前不要先有 JPEG 雜訊），影片用 JPEG q92（VP9 再壓一次，PNG 沒有意義）。
const frameShot = (format) => (format === 'gif' ? { format: 'png', fromSurface: true } : { format: 'jpeg', quality: 92, fromSurface: true });

// 注入卡片頁面：接管旋轉。t＝迴圈相位（0～1，可以略小於 0 做預熱），
// mode 'spin' 轉一整圈（緩入緩出：起點終點角速度為 0，前後正面各停留一下，循環播放不會突兀），
// mode 'still' 固定正面、游標放左上，讓全息光澤打出一點高光。
const PAGE_SCRIPT = `(function(){
  if (window.__exp) return;
  var card = document.getElementById('card');
  var root = document.documentElement;
  var TAU = Math.PI * 2;
  document.body.classList.add('__exp');
  function raf2(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }); }
  window.__exp = {
    info: function(){
      var m = (window.cardFx && window.cardFx.meta) || {};
      return { name: m.name || '', colors: m.colors || null, rarity: window.cardFx ? window.cardFx.rarity() : '' };
    },
    step: function(t, mode){
      var deg, rx, ox, oy;
      if (mode === 'spin') {
        deg = 360 * (t - Math.sin(TAU * t) / TAU);
        rx = 7 * Math.sin(TAU * t);
        ox = 0.8 * Math.sin(TAU * t);
        oy = 0.5 * Math.cos(TAU * t);
      } else if (mode === 'sway') {
        deg = 12 * Math.sin(TAU * t); rx = 5 * Math.cos(TAU * t);
        ox = 0.7 * Math.sin(TAU * t * 2); oy = 0.45 * Math.cos(TAU * t * 2);
      } else {
        deg = 0; rx = 0; ox = -0.5; oy = -0.42;
      }
      root.style.setProperty('--exp-ry', deg.toFixed(3) + 'deg');
      root.style.setProperty('--exp-rx', rx.toFixed(3) + 'deg');
      if (card) {
        var r = card.getBoundingClientRect();
        window.dispatchEvent(new PointerEvent('pointermove', {
          clientX: r.left + (0.5 + 0.5 * ox) * r.width,
          clientY: r.top + (0.5 + 0.5 * oy) * r.height,
          bubbles: true, pointerType: 'mouse'
        }));
      }
      return raf2();
    }
  };
})()`;

// stars=false 時把常駐的小星星層（.fx-stars）藏起來，跟桌面掛件的「環境星光」設定一致（預設參數 true＝維持舊行為）。
function exportCss(bg, stars = true) {
  return `html,body{ margin:0 !important; background:${bg} !important; overflow:hidden !important; }
html{ height:100% !important; }
:root{ --card-w:372px !important; }
.stage{ position:fixed !important; left:50% !important; top:50% !important; transform:translate(-50%,-50%) scale(var(--exp-scale,1)) !important; padding:0 !important; gap:0 !important; }
.hint{ display:none !important; }
::-webkit-scrollbar{ display:none; }
${stars ? '' : '.fx-stars{ display:none !important; }'}
body.__exp{ cursor:none; }
body.__exp .card{ transition:none !important; transform:rotateX(var(--exp-rx,0deg)) rotateY(var(--exp-ry,0deg)) !important; }`;
}

// 影片／GIF 沒有透明背景可用，墊一層以卡片主題色打光的深色背景（畫在頁面裡，陰影與混合模式才會跟背景正確合成）。
function themeBackdrop(colors) {
  const hex = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
  const c1 = colors && hex(colors[0]);
  const c2 = colors && hex(colors[1]);
  const glow = c1 && c2
    ? `radial-gradient(ellipse 78% 62% at 50% 46%, ${c1}38 0%, ${c2}18 46%, transparent 78%), `
    : '';
  return `${glow}linear-gradient(#070a12, #04060b)`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e && e.message) || String(e);

let busy = false;
let currentEnc = null; // { resolveReady, resolveDone, rejectDone, senderId }

ipcMain.on('cx-ready', (event) => {
  if (currentEnc && currentEnc.senderId === event.sender.id && currentEnc.resolveReady) currentEnc.resolveReady();
});
ipcMain.on('cx-progress', (event, n) => { // GIF 編碼進度（已編完幾格）；影片編碼不回報
  if (currentEnc && currentEnc.senderId === event.sender.id && currentEnc.onProgress) currentEnc.onProgress(n);
});
ipcMain.on('cx-done', (event, result) => {
  if (!currentEnc || currentEnc.senderId !== event.sender.id) return;
  if (result && result.ok) currentEnc.resolveDone(Buffer.from(result.bytes));
  else currentEnc.rejectDone(new Error((result && result.error) || '編碼失敗'));
});

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'card';
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 匯出一張卡片。
 * @param {object} o
 * @param {string} o.file        卡片 html 的絕對路徑
 * @param {'png'|'webm'|'gif'} o.format
 * @param {string} o.outDir      輸出資料夾（不存在會建立）
 * @param {number} [o.seconds]   旋轉一圈的秒數（預設 3）
 * @param {(msg:string, frac?:number)=>void} [o.onStatus]  frac＝整體進度 0～1（載入 0.03、錄製 0.06～0.88、編碼 0.9）
 * @param {(info:{name:string,colors:string[]|null,rarity:string})=>void} [o.onInfo]  卡片載入後回報卡名（給狀態面板顯示中文名）
 * @returns {Promise<{path:string, bytes:number, format:string, name:string, png?:Buffer}>}
 */
async function exportCard(o) {
  if (busy) throw new Error('上一個匯出還沒結束');
  const spec = FORMATS[o.format];
  if (!spec) throw new Error(`不支援的匯出格式：${o.format}`);
  busy = true;
  const status = o.onStatus || (() => {});
  const wins = [];
  let cdp = null;
  try {
    // ---- 卡片離屏視窗
    const cardWin = new BrowserWindow({
      x: OFFSCREEN, y: OFFSCREEN, width: VIEW_W, height: VIEW_H, useContentSize: true,
      show: true, frame: false, transparent: true, resizable: false, focusable: false,
      skipTaskbar: true, hasShadow: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true },
    });
    wins.push(cardWin);
    const wc = cardWin.webContents;
    wc.setAudioMuted(true);
    // ⚠️ 視窗還沒載入任何頁面就掛 debugger 並送 Emulation.* 指令，整個主程序會「無聲崩潰」
    // （沒有例外、沒有錯誤訊息，程序直接消失；實測）——所以先載入 about:blank 再掛。
    await wc.loadURL('about:blank');
    cdp = wc.debugger;
    cdp.attach('1.3');
    const send = (method, params) => cdp.sendCommand(method, params || {});
    const scale = o.format === 'gif' ? gifScaleOf(o) : spec.scale;
    await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: scale, mobile: false });
    // 使用者的 Windows 常回報 prefers-reduced-motion:reduce，會讓星光／稜鏡等環境特效整個關掉——
    // 匯出要的是「完整效果」的成品，所以在載入前就強制成 no-preference。
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    if (o.format === 'png') {
      await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    status('載入卡片…', 0.03);
    // 開機自動啟動／缺檔時 loadURL 會 reject，讓呼叫端顯示錯誤
    await wc.loadURL(pathToFileURL(o.file).href);
    // 這個 file:// 來源的頁面縮放若被別的程式記成非 1（Electron 依來源記縮放），畫面尺寸會跑掉
    if (wc.getZoomFactor() !== 1) wc.setZoomFactor(1);
    await wc.executeJavaScript('document.fonts ? document.fonts.ready.then(function(){ return 1; }) : 1');
    await wc.executeJavaScript(PAGE_SCRIPT);
    const info = await wc.executeJavaScript('window.__exp.info()');
    if (o.onInfo) { try { o.onInfo(info); } catch (e) { /* 呼叫端的問題不該讓匯出失敗 */ } }
    await wc.insertCSS(exportCss(o.format === 'png' ? 'transparent' : themeBackdrop(info.colors), o.stars !== false));
    await wait(500); // 圖片解碼／首次繪製

    const name = safeFileName(info.name || path.basename(o.file, '.html').replace(/[_-]?(phantom_card|幻影卡)$/i, ''));
    fs.mkdirSync(o.outDir, { recursive: true });
    const outPath = path.join(o.outDir, `${name}_${o.format === 'png' ? 'still' : 'spin'}_${stamp(new Date())}.${spec.ext}`);
    const step = (t, mode) => send('Runtime.evaluate', {
      expression: `window.__exp.step(${t}, ${JSON.stringify(mode)})`, awaitPromise: true,
    });

    // ---- PNG：單張，透明背景
    if (o.format === 'png') {
      status('拍照中…', 0.5);
      for (let k = 0; k < 14; k++) await step(0, 'still'); // 讓卡片自己的緩動收斂到位
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const png = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(outPath, png);
      return { path: outPath, bytes: png.length, format: 'png', name, png };
    }

    // ---- WebM／GIF：編碼器視窗
    const seconds = Number(o.seconds) > 0 ? Number(o.seconds) : 3;
    const frames = Math.max(8, Math.round(spec.fps * seconds));
    const width = Math.round(VIEW_W * scale);
    const height = Math.round(VIEW_H * scale);
    const encWin = new BrowserWindow({
      show: false, width: 320, height: 240,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, preload: path.join(__dirname, 'encoder-preload.js') },
    });
    wins.push(encWin);
    const ready = new Promise((resolve) => { currentEnc = { senderId: encWin.webContents.id, resolveReady: resolve }; });
    const done = new Promise((resolve, reject) => { currentEnc.resolveDone = resolve; currentEnc.rejectDone = reject; });
    done.catch(() => {}); // 只在最後 await；中途出錯時避免 unhandled rejection
    await encWin.loadURL(pathToFileURL(path.join(__dirname, 'encoder.html')).href);
    await ready;
    encWin.webContents.send('cx-init', { format: o.format, width, height, fps: spec.fps, bitrate: spec.bitrate || 0, frames });
    // GIF 是收一格編一格：編碼比擷取慢，所以進度以「已編完幾格」為準（6%～94%），錄製迴圈本身不另外報
    if (o.format === 'gif') currentEnc.onProgress = (n) => status(`編碼 ${n}/${frames}`, 0.06 + 0.88 * Math.min(1, n / frames));

    const WARM = 8; // 沿著路徑的「前幾格」先跑過但不錄，讓卡片的緩動在起點就處於穩定的落後狀態，首尾才接得起來
    for (let k = WARM; k >= 1; k--) await step(-k / frames, 'spin');
    for (let i = 0; i < frames; i++) {
      if (o.format !== 'gif') status(`錄製 ${i + 1}/${frames}`, 0.06 + 0.82 * (i + 1) / frames);
      await step(i / frames, 'spin');
      const shot = await send('Page.captureScreenshot', frameShot(o.format));
      encWin.webContents.send('cx-frame', i, Buffer.from(shot.data, 'base64'));
    }
    if (o.format !== 'gif') status('編碼中…', 0.9);
    encWin.webContents.send('cx-finish');
    const bytes = await Promise.race([
      done,
      wait(o.format === 'gif' ? 300000 : 120000).then(() => { throw new Error('編碼逾時'); }),
    ]);
    fs.writeFileSync(outPath, bytes);
    return { path: outPath, bytes: bytes.length, format: o.format, name };
  } finally {
    try { if (cdp) cdp.detach(); } catch (e) { /* 已分離 */ }
    for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch (e) { /* 已關閉 */ } }
    currentEnc = null;
    busy = false;
  }
}


// ==================== 多卡：整個版面／時鐘轉圈 ====================
// 版面 = 把所有卡放在同一個畫面裡（用桌面上「目前」的格位座標與每張卡各自的縮放），一起旋轉；
// 時鐘轉圈 = 卡片沿著橢圓繞一圈（軌道由呼叫端的 cycle 設定給，跟桌面掛件 F8 是同一組橢圓參數）。
// 幾何：格位的實際大小 w×h = 560×820×k（k＝整體縮放×這張卡的縮放）；卡片本體 372k×520.8k，
// 中心在格位頂端往下 404/820（不是正中央，因為 .stage 有上邊距與下方提示文字）——匯出時卡片放在 iframe 正中央，
// 所以每格的位置以「卡片中心」為準來擺，才會跟桌面上看到的相對位置一致。
const BODY_W = 372;
const BODY_H = 520.8;
const STAGE_TARGET_LONG_SIDE = { png: 2600, webm: 1600 }; // 多卡畫面比單張大很多，影片的長邊比單張匯出小一點，檔案才不會太肥；GIF 的長邊＝gifScale × 600（預設 1.5 → 900）

function stageGeometry(o) {
  const slots = o.slots;
  const center = (i, phiDeg) => {
    const sl = slots[i];
    const k = sl.w / 560;
    if (o.kind === 'orbit' && o.cycle) {
      if (o.cycle.offsets[i] === null) return { x: o.cycle.cx, y: o.cycle.cy - 6 * k }; // 固定不動的卡（5 卡版面的中央那張）
      const th = ((o.cycle.offsets[i] + phiDeg) * Math.PI) / 180;
      return { x: o.cycle.cx + o.cycle.rx * Math.sin(th), y: o.cycle.cy - o.cycle.ry * Math.cos(th) - 6 * k };
    }
    return { x: sl.x + sl.w / 2, y: sl.y + (sl.h * 404) / 820 };
  };
  const phis = [];
  if (o.kind === 'orbit') { for (let a = 0; a < 360; a += 4) phis.push(a); } else phis.push(0);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, kMax = 0;
  for (let i = 0; i < slots.length; i++) {
    const k = slots[i].w / 560;
    kMax = Math.max(kMax, k);
    for (const phi of phis) {
      const c = center(i, phi);
      x0 = Math.min(x0, c.x - (BODY_W * k) / 2); x1 = Math.max(x1, c.x + (BODY_W * k) / 2);
      y0 = Math.min(y0, c.y - (BODY_H * k) / 2); y1 = Math.max(y1, c.y + (BODY_H * k) / 2);
    }
  }
  const m = 70 * kMax; // 外框光暈／陰影／旋轉時透視放大的留白
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  return { center, x0, y0, w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

function stageHtml(o, geo, urls) {
  const cells = o.slots.map((sl, i) => {
    const c = geo.center(i, 0);
    return `<div class="slot" style="left:${(c.x - sl.w / 2 - geo.x0).toFixed(2)}px;top:${(c.y - sl.h / 2 - geo.y0).toFixed(2)}px;width:${sl.w}px;height:${sl.h}px"><iframe src="${urls[i]}#slot=${i}"></iframe></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}.slot{position:absolute}.slot iframe{width:100%;height:100%;border:0;background:transparent}</style></head><body>${cells}</body></html>`;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * 匯出多卡的「整個版面」或「時鐘轉圈」。
 * @param {object} o
 * @param {{file:string,x:number,y:number,w:number,h:number}[]} o.slots  目前每格實際的位置與大小（含縮放）
 * @param {'layout'|'orbit'} o.kind
 * @param {'png'|'webm'|'gif'} o.format
 * @param {string} o.outDir
 * @param {number} o.seconds     layout＝旋轉一圈秒數；orbit＝繞一圈秒數
 * @param {{cx:number,cy:number,rx:number,ry:number,offsets:number[]}|null} o.cycle  orbit 用（格位中心的橢圓）
 * @param {boolean} [o.stars]
 * @param {(msg:string, frac?:number)=>void} [o.onStatus]
 */
async function exportStage(o) {
  if (busy) throw new Error('上一個匯出還沒結束');
  const spec = FORMATS[o.format];
  if (!spec) throw new Error(`不支援的匯出格式：${o.format}`);
  if (o.kind === 'orbit' && !o.cycle) throw new Error('這個版面不能做時鐘轉圈（要 3 張以上）');
  if (o.kind === 'orbit' && o.format === 'png') throw new Error('時鐘轉圈是動畫，不能存成 PNG');
  if (!Array.isArray(o.slots) || !o.slots.length) throw new Error('沒有任何卡片');
  busy = true;
  const status = o.onStatus || (() => {});
  const wins = [];
  let cdp = null;
  let stageFile = null;
  try {
    const geo = stageGeometry(o);
    const targetLong = o.format === 'gif' ? Math.round(gifScaleOf(o) * 600) : STAGE_TARGET_LONG_SIDE[o.format];
    const dsf = Math.max(0.25, Math.min(2, targetLong / Math.max(geo.w, geo.h)));
    const outW = even(geo.w * dsf);
    const outH = even(geo.h * dsf);
    // GIF 的格間隔只能是 1/100 秒的整數：25 fps＝4、12.5 fps＝8，播放速度才精準（時鐘轉圈動作慢、又要繞 10 秒以上，12.5 fps 可以讓檔案不要太肥）
    const fps = o.format === 'gif' ? (o.kind === 'orbit' ? 12.5 : 25) : 30;
    const seconds = Number(o.seconds) > 0 ? Number(o.seconds) : (o.kind === 'orbit' ? 10 : 3);
    const frames = o.format === 'png' ? 1 : Math.max(8, Math.round(fps * seconds));

    const cardWin = new BrowserWindow({
      x: OFFSCREEN, y: OFFSCREEN, width: Math.min(geo.w, 1600), height: Math.min(geo.h, 1000), useContentSize: true,
      show: true, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, hasShadow: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true },
    });
    wins.push(cardWin);
    const wc = cardWin.webContents;
    wc.setAudioMuted(true);
    await wc.loadURL('about:blank'); // 見 exportCard()：還沒載入任何頁面就掛 debugger 會讓主程序無聲崩潰
    cdp = wc.debugger;
    cdp.attach('1.3');
    const send = (method, params) => cdp.sendCommand(method, params || {});
    const contexts = [];
    cdp.on('message', (_e, method, params) => {
      if (method === 'Runtime.executionContextCreated' && params.context && params.context.auxData && params.context.auxData.isDefault) contexts.push(params.context.id);
    });
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: geo.w, height: geo.h, deviceScaleFactor: dsf, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    if (o.format === 'png') await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    status('載入卡片…', 0.03);
    const urls = o.slots.map((sl) => pathToFileURL(sl.file).href);
    stageFile = path.join(app.getPath('temp'), `phantom-stage-export-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(stageFile, stageHtml(o, geo, urls), 'utf8');
    await wc.loadURL(pathToFileURL(stageFile).href);
    if (wc.getZoomFactor() !== 1) wc.setZoomFactor(1);

    // 等每個 iframe 的卡片都載入完，依網址的 #slot=<i> 對回格位索引，注入匯出用的 CSS 與 PAGE_SCRIPT
    const cardCtx = new Array(o.slots.length).fill(null);
    const deadline = Date.now() + 20000;
    while (cardCtx.some((c) => c === null)) {
      if (Date.now() > deadline) throw new Error('有卡片載入逾時');
      for (const id of contexts.slice()) {
        let hash = '';
        try {
          const r = await send('Runtime.evaluate', { contextId: id, expression: 'location.hash + "|" + (document.readyState) + "|" + (!!document.getElementById("card"))', returnByValue: true });
          hash = (r.result && r.result.value) || '';
        } catch (e) { continue; }
        const m = /^#slot=(\d+)\|complete\|true$/.exec(hash);
        if (m && cardCtx[Number(m[1])] === null) cardCtx[Number(m[1])] = id;
      }
      if (cardCtx.some((c) => c === null)) await wait(150);
    }
    let bgTheme = 'linear-gradient(#070a12, #04060b)';
    for (let i = 0; i < cardCtx.length; i++) {
      const k = o.slots[i].w / 560;
      await send('Runtime.evaluate', { contextId: cardCtx[i], awaitPromise: true, expression: 'document.fonts ? document.fonts.ready.then(function(){ return 1; }) : 1' });
      await send('Runtime.evaluate', { contextId: cardCtx[i], expression: PAGE_SCRIPT });
      await send('Runtime.evaluate', {
        contextId: cardCtx[i],
        expression: `(function(){ var st = document.createElement('style'); st.textContent = ${JSON.stringify(exportCss('transparent', o.stars !== false))}; document.head.appendChild(st); document.documentElement.style.setProperty('--exp-scale', ${k.toFixed(5)}); })()`,
      });
      if (i === 0) {
        const r = await send('Runtime.evaluate', { contextId: cardCtx[i], expression: 'window.__exp.info()', returnByValue: true });
        if (r.result && r.result.value) bgTheme = themeBackdrop(r.result.value.colors);
      }
    }
    // 頁面背景：PNG 透明；影片／GIF 墊主題色深色底（畫在最外層，光暈與陰影才會跟背景正確合成）
    await wc.executeJavaScript(`document.documentElement.style.background = ${JSON.stringify(o.format === 'png' ? 'transparent' : bgTheme)}; document.body.style.background = 'transparent'; 1`);
    await wait(500);

    const setPositions = (phi) => {
      const pos = o.slots.map((sl, i) => { const c = geo.center(i, phi); return [c.x - sl.w / 2 - geo.x0, c.y - sl.h / 2 - geo.y0]; });
      // 5 卡「中央＋四角」：繞行的卡在中心卡下半部時蓋在前面、上半部躲到後面（跟桌面掛件舞台頁面同一規則）
      const zs = o.slots.map((sl, i) => (!o.cycle || !o.cycle.fixed ? '' : (o.cycle.offsets[i] === null ? 1 : (Math.cos(((o.cycle.offsets[i] + phi) * Math.PI) / 180) < 0 ? 2 : 0))));
      return send('Runtime.evaluate', { expression: `(function(p, z){ var s = document.querySelectorAll('.slot'); for (var i = 0; i < s.length; i++) { s[i].style.left = p[i][0].toFixed(2) + 'px'; s[i].style.top = p[i][1].toFixed(2) + 'px'; s[i].style.zIndex = z[i]; } })(${JSON.stringify(pos)}, ${JSON.stringify(zs)})` });
    };
    const N = o.slots.length;
    const stepAll = (t, mode) => Promise.all(cardCtx.map((id, j) => {
      // layout：每張卡錯開一點點相位（波浪感）；orbit：每張卡搖擺的相位錯開 j/N
      const tj = mode === 'spin' ? ((t - j * 0.035) % 1 + 1) % 1 : (mode === 'sway' ? (t + j / N) % 1 : t);
      return send('Runtime.evaluate', { contextId: id, awaitPromise: true, expression: `window.__exp.step(${tj.toFixed(5)}, ${JSON.stringify(mode)})` });
    }));

    fs.mkdirSync(o.outDir, { recursive: true });
    const tag = o.kind === 'orbit' ? 'orbit' : (o.format === 'png' ? 'layout-still' : 'layout');
    const name = `版面${N}張`;
    const outPath = path.join(o.outDir, `${name}_${tag}_${stamp(new Date())}.${spec.ext}`);

    if (o.format === 'png') {
      status('拍照中…', 0.5);
      for (let k = 0; k < 14; k++) await stepAll(0, 'still');
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const png = Buffer.from(shot.data, 'base64');
      fs.writeFileSync(outPath, png);
      return { path: outPath, bytes: png.length, format: 'png', name, png };
    }

    const encWin = new BrowserWindow({
      show: false, width: 320, height: 240,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, preload: path.join(__dirname, 'encoder-preload.js') },
    });
    wins.push(encWin);
    const ready = new Promise((resolve) => { currentEnc = { senderId: encWin.webContents.id, resolveReady: resolve }; });
    const done = new Promise((resolve, reject) => { currentEnc.resolveDone = resolve; currentEnc.rejectDone = reject; });
    done.catch(() => {});
    await encWin.loadURL(pathToFileURL(path.join(__dirname, 'encoder.html')).href);
    await ready;
    const bitrate = o.format === 'webm' ? Math.max(2e6, Math.min(12e6, Math.round(outW * outH * fps * 0.07))) : 0;
    encWin.webContents.send('cx-init', { format: o.format, width: outW, height: outH, fps, bitrate, frames });
    if (o.format === 'gif') currentEnc.onProgress = (n) => status(`編碼 ${n}/${frames}`, 0.06 + 0.88 * Math.min(1, n / frames)); // 同 exportCard

    const mode = o.kind === 'orbit' ? 'sway' : 'spin';
    const WARM = 8;
    for (let k = WARM; k >= 1; k--) {
      const t = -k / frames;
      if (o.kind === 'orbit') await setPositions(360 * ((t % 1 + 1) % 1));
      await stepAll(((t % 1) + 1) % 1, mode);
    }
    for (let i = 0; i < frames; i++) {
      if (o.format !== 'gif') status(`錄製 ${i + 1}/${frames}`, 0.06 + 0.82 * (i + 1) / frames);
      const t = i / frames;
      if (o.kind === 'orbit') await setPositions(360 * t);
      await stepAll(t, mode);
      const shot = await send('Page.captureScreenshot', o.format === 'gif' ? frameShot('gif') : { format: 'jpeg', quality: 90, fromSurface: true });
      encWin.webContents.send('cx-frame', i, Buffer.from(shot.data, 'base64'));
    }
    if (o.format !== 'gif') status('編碼中…', 0.9);
    encWin.webContents.send('cx-finish');
    const bytes = await Promise.race([done, wait(o.format === 'gif' ? 600000 : 240000).then(() => { throw new Error('編碼逾時'); })]);
    fs.writeFileSync(outPath, bytes);
    return { path: outPath, bytes: bytes.length, format: o.format, name };
  } finally {
    try { if (cdp) cdp.detach(); } catch (e) { /* 已分離 */ }
    for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch (e) { /* 已關閉 */ } }
    if (stageFile) { try { fs.unlinkSync(stageFile); } catch (e) { /* 已刪除 */ } }
    currentEnc = null;
    busy = false;
  }
}

// PAGE_SCRIPT／exportCss 一併匯出，給 card-slim 的渲染比對測試共用（同一套「固定姿勢」機制，不用複製一份）。
module.exports = { exportCard, exportStage, FORMATS, isBusy: () => busy, errText, PAGE_SCRIPT, exportCss };
