// 讓任何一張（或好幾張）「全息殘影卡」html 變成「桌面掛件」的共用 Electron 外殼。
// 純網頁本身無法做到透明背景／永遠置頂／點擊穿透——這些是 OS 視窗層級的能力，
// 瀏覽器基於安全考量不開放給網頁自己設定，所以需要 Electron 這層原生視窗殼。
// 做法比照 C:\question\desktop-pet\main.js 的 createWindow()：transparent +
// frame:false + alwaysOnTop('screen-saver' 最高置頂等級) + 全域快捷鍵切換整個
// 視窗的點擊穿透（setIgnoreMouseEvents），不做逐像素判斷。
//
// 這支殼支援兩種模式，由 package.json 的形狀決定，共用同一份 main.js/preload.js：
//   - 單卡模式：package.json 有 cardFile。視窗只做「跟卡片差不多大」，不是蓋滿
//     整個螢幕——原因是如果蓋滿整個螢幕，兩個「單卡」exe 同時開著時，兩個視窗
//     的「看不見但可以點」範圍會整片互相重疊，滑鼠右鍵在桌面上隨便一點，可能
//     點到的其實是疊在上面、但那個位置剛好透明看不見的另一張卡，抓錯目標。
//     右鍵拖曳＝搬動這個視窗本身（win.setPosition），位置存檔案跨重開機記住。
//   - 多卡合一模式：package.json 有 cards（陣列，每個 { file, x, y }）。這種情況
//     整個視窗蓋滿螢幕、裡面用一個 iframe 放一張卡（每張卡的 html/js 完全不用改，
//     iframe 天生就有自己獨立的 document，卡片原本 getElementById('card') 之類
//     的邏輯不會互相打架）。每個 iframe 各自能右鍵拖曳，只搬動自己在這個共用
//     視窗裡的位置（不牽涉搬動 OS 視窗本身），位置存同一個 json 檔（依卡片索引）。
//     F9/quit 這類快捷鍵是整個視窗共用一份，不用像單卡模式那樣每張卡各自配一個
//     快捷鍵才不衝突。
//
// 要包一張新卡片（單卡）或一組新的合輯（多卡），都寫一個小 build/*.yml（extends
// 共用的 electron-builder.yml）覆蓋 productName/extraMetadata 就好，不用複製
// main.js。範例見 build/gojo-phantom.yml（單卡）、build/duo-jimmy-gojo.yml（多卡）。
const { app, BrowserWindow, globalShortcut, ipcMain, screen, webFrameMain, session, Tray, Menu, nativeImage, dialog, shell, clipboard } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
// 匯出分享（PNG／WebM／GIF）。⚠️ 要在 app ready 之前 require：模組載入時會設定 Chromium 旗標（見該檔開頭）。
const cardExporter = require('./card-export/exporter');

// 環境變數可覆蓋 package.json 的設定，方便包裝成 exe 之前先用 npm start 快速
// 預覽，不用真的去改 package.json：
//   CARD_FILE=cards/gojo_phantom_card.html npx electron .
//   CARDS_JSON='[{"file":"cards/jimmy_phantom_card.html","x":80,"y":80},{"file":"cards/gojo_phantom_card.html","x":700,"y":80}]' npx electron .
const pkg = require('./package.json');
const CARD_FILE = process.env.CARD_FILE || pkg.cardFile || null;
const MULTI_CARDS = process.env.CARDS_JSON ? JSON.parse(process.env.CARDS_JSON) : pkg.cards || null;
const TOGGLE_KEY = process.env.TOGGLE_KEY || pkg.toggleKey || 'F9';
const QUIT_KEY = process.env.QUIT_KEY || pkg.quitKey || 'F10';
// 重設卡片位置：單卡、多卡都適用（不像 cycleKey/gestureKey 限定多卡），跟
// toggleKey/quitKey 同一種「環境變數 > package.json > 預設值」的慣例。
const RESET_KEY = process.env.RESET_KEY || pkg.resetKey || 'F11';
// 每秒自動翻面循環（見 cards/{六狗}_phantom_card.html 的 toggleAutoFlip()）：
// 單卡、多卡都適用，跟 resetKey 同一種慣例。故意選 F 鍵而不是卡片自己原本
// 單獨用瀏覽器打開時綁的 L 鍵——globalShortcut 是「整台電腦」層級的攔截，
// 綁一般英數字鍵會讓使用者在任何其他視窗打字時只要按到 L 就被這個掛件搶走，
// F6～F11 已經被其他功能用掉。⚠️ 不能用 F12：Windows 的 RegisterHotKey 把 F12
// 保留給除錯器，實測 globalShortcut.register('F12') 直接回傳 false（註冊失敗），
// 所以往下挑 F4（使用者可以在 builder-gui 或 package.json 自己改成別的鍵）。
// 卡片本身在瀏覽器裡單獨打開時，L 鍵那組監聽器完全不受這裡影響，兩套機制並存。
const AUTOFLIP_KEY = process.env.AUTOFLIP_KEY || pkg.autoFlipKey || 'F4';
// 卡片特效（card-fx：技能演出／稀有度切換／音效靜音，見 card-fx/fx.js 與 桌面掛件說明.md）：
// 單卡、多卡都適用，跟 autoFlipKey 同一種慣例（環境變數 > package.json > 預設值）。
// 預設用 Ctrl+Alt+數字 1/2/3（實測 Ctrl+Alt+R／M 在使用者機器上已被其他程式占用，數字鍵是空的），而不是 F2/F3/F5 這類單鍵——全域快捷鍵是整台電腦層級的攔截，
// F2（檔案總管重新命名）／F3（尋找下一個）／F5（重新整理）會讓使用者在其他程式裡失去這些
// 常用鍵，組合鍵幾乎不會跟日常操作撞。想改成別的鍵可以在 builder-gui 或 package.json 設定。
const SKILL_KEY = process.env.SKILL_KEY || pkg.skillKey || 'Ctrl+Alt+1';
const RARITY_KEY = process.env.RARITY_KEY || pkg.rarityKey || 'Ctrl+Alt+2';
const MUTE_KEY = process.env.MUTE_KEY || pkg.muteKey || 'Ctrl+Alt+3';
// 開機自動啟動（Windows 登入時自動把這個掛件打開）：這裡只是「預設值」，由
// builder-gui 的勾選框寫進 package.json 的 launchAtLogin，只在這個 exe「第一次
// 啟動、使用者還沒表態過」時套用一次；之後以系統匣選單的勾選項目為準（存在
// userData/settings.json），使用者在系統匣取消勾選後，重新打包也不會又被偷偷
// 打開。環境變數 LAUNCH_AT_LOGIN=true/false 可覆蓋，方便測試。
const LAUNCH_AT_LOGIN_DEFAULT = process.env.LAUNCH_AT_LOGIN != null
  ? process.env.LAUNCH_AT_LOGIN === 'true'
  : !!pkg.launchAtLogin;
// 時鐘式循環（多卡模式 3 張以上，見 computeCycleConfig()）：預設不會自動轉，要按這個快捷鍵才開始／再按一次暫停
// （見 computeCycleConfig() 上方的〈時鐘式循環〉說明）。
const CYCLE_KEY = process.env.CYCLE_KEY || pkg.cycleKey || 'F8';
const CYCLE_PERIOD_MS = (Number(process.env.CYCLE_PERIOD_SECONDS) || pkg.cyclePeriodSeconds || 10) * 1000;
// 時鐘式循環：多卡模式 3 張以上都能用（以前限定剛好 6 張）。6 張沿用原本「上三下三」的固定角度；其他張數見 computeCycleConfigAny()。
const CYCLE_MODE = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length >= 3;
// 手勢散開（布）／收縮（拳頭）：參考 C:\hand-tracker 用 MediaPipe Hands 讀攝影機
// 判斷手勢的做法，套用在「多卡合一」的所有格位上（任何張數都能用，不像時鐘循環要 3 張以上），
// 平常不會偷偷開攝影機——預設關閉，要按這個快捷鍵才會要求攝影機權限、開始
// 偵測，再按一次關閉並釋放攝影機（見 buildStageHtml() 的〈手勢散開/收縮〉）。
const GESTURE_KEY = process.env.GESTURE_KEY || pkg.gestureKey || 'F7';
const GESTURE_TRANSITION_MS = (Number(process.env.GESTURE_TRANSITION_SECONDS) || pkg.gestureTransitionSeconds || 3) * 1000;
// 手部骨架視覺效果：復刻 C:\hand-tracker 那種發光骨架疊加畫面（每根手指不同
// 顏色＋節點發光暈染），開啟手勢偵測時可以看到自己的手在幹嘛，不是完全黑箱。
// 預設開啟（最貼近 hand-tracker 原本「一直顯示」的樣子），builder-gui 可以
// 關掉這個選項，只留手勢控制卡片、畫面上不疊加骨架。
const GESTURE_SHOW_SKELETON = process.env.GESTURE_SHOW_SKELETON != null
  ? process.env.GESTURE_SHOW_SKELETON === 'true'
  : (pkg.gestureShowSkeleton !== undefined ? !!pkg.gestureShowSkeleton : true);
// 骨架視覺效果開關鍵：跟 gestureKey 一樣只有多卡模式才會註冊（見下面 isMulti
// 判斷），單卡模式沒有手勢辨識這個概念，開關骨架沒有意義。
const SKELETON_KEY = process.env.SKELETON_KEY || pkg.skeletonKey || 'F6';
// 卡片整體等比例縮放：以現有卡片設計（560×820 視窗/容器、卡片本體 372×520.8）
// 為基準，單卡、多卡都適用（多卡的每一格都共用同一個 WIN_W/WIN_H fallback，
// 見 buildStageHtml() 的 `c.w || WIN_W`）。
//   ⚠️ 只調 WIN_W/WIN_H（容器像素大小）不夠：cards/*.html 自己的 --card-w 是
//   clamp(272px, min(86vw,58vh), 372px)，這個 vw/vh 是相對「瀏覽器/iframe 的
//   實際渲染視窗」算的——如果直接把渲染視窗本身放大/縮小成 WIN_W×CARD_SCALE
//   這麼大，clamp() 會先用新的視窗大小重新算一次（縮小到某個門檻以下 vw/vh
//   會先讓卡片變小，放大則大多會卡在 372px 上限不變），這時候如果再疊一層
//   CSS transform:scale(CARD_SCALE) 去縮放整個畫面，就會產生「clamp() 縮一次、
//   transform 又縮一次」的雙重縮放，倍率跑掉（尤其縮小到八成以下開始明顯跟
//   預期不成比例；實測 60% 縮放算出來的卡片只有理論值的一半左右）。
//   ⚠️ 也試過 Electron 的頁面縮放（webContents.setZoomFactor()）想讓 vw/vh
//   維持在原始 560×820 視窗下計算——實測單卡模式偶爾有效、偶爾完全沒作用
//   （疑似跟 Chromium 內部 HostZoomMap 依 origin/呼叫時機記錄縮放值的機制
//   互動有關，行為不穩定），多卡模式更是完全沒用：iframe 沒有獨立的
//   webContents 可以設定縮放（WebFrameMain 沒有 setZoomFactor() 這個方法），
//   只能靠渲染程序自己的 webFrame 模組，但注入進 iframe 頁面主世界執行的腳本
//   在 contextIsolation:true 下拿不到 require（就算開了
//   nodeIntegrationInSubFrames 也一樣，實測跑出 "require is not defined"），
//   放棄這條路。
//   ✅ 實際採用的做法：直接把 `--card-w` 這個 CSS 變數鎖死在基準值 372px
//   （不管視窗/iframe 實際多大，卡片自己內部的 layout 永遠照原始 100% 設計去
//   算，徹底跟 vw/vh、跟外層容器大小脫鉤），再對整個 .stage 疊一層
//   transform:scale(CARD_SCALE)——因為 .stage 的「縮放前」版面已經被鎖定成
//   固定值，這層 transform 是唯一一次縮放，不會有雙重縮放的問題，在極端縮放
//   （實測 30%～140%）都驗證出正確的線性等比例結果。transform 是視覺層級的
//   縮放，會連 padding、間距、字體、陰影、金屬外框厚度全部一起等比例縮放
//   （不像只鎖 --card-w 那樣只會動到卡片本體寬高），也不會跟卡片自己
//   rotateX/rotateY 的 3D 傾斜效果打架（傾斜是 .card 子層自己的另一個獨立
//   transform）。
const CARD_SCALE = Number(process.env.CARD_SCALE) || pkg.cardScale || 1;
// 環境星光（卡面上常駐的小星星，card-fx 的 .fx-stars 層：72 顆 ✦，依稀有度顯示 10／24／48／72 顆）。
// card-fx 加進來之前的卡片沒有這一層，所以預設關閉（＝以前的樣子）；builder-gui 的「✨ 環境星光」勾選框
// 寫進 yml 的 extraMetadata.ambientStars。純外觀選項：只是把 .fx-stars 層隱藏，技能演出的粒子（canvas）、
// 稀有度的邊框／全息強度／稜鏡都不受影響。環境變數 AMBIENT_STARS=true/false 可覆蓋（測試用）。
// 單卡、多卡都適用（走 CARD_SCALE_CSS，兩種模式共用同一條規則）；匯出分享也會照這個設定。
const AMBIENT_STARS = process.env.AMBIENT_STARS != null ? process.env.AMBIENT_STARS === 'true' : !!pkg.ambientStars;
// windowWidth／windowHeight 是既有的手動覆蓋欄位（給想跳過縮放比例、直接自訂
// 容器像素大小的進階用法），沒設定才用 cardScale 算出來的等比例大小。
const WIN_W = pkg.windowWidth || Math.round(560 * CARD_SCALE);
const WIN_H = pkg.windowHeight || Math.round(820 * CARD_SCALE);
// cardScale=1 時完全是空字串，不會多插入任何 CSS 規則，維持跟改動前一模一樣
// 的輸出。transform-origin 刻意不指定、用瀏覽器預設值（50% 50%，正中央）——
// .stage 本身透過 body{display:grid;place-items:center} 已經置中在容器裡，
// 縮放前的版面位置不受 CARD_SCALE 影響（因為 --card-w 鎖死了），從自己的中心
// 縮放，縮放後的視覺結果自然還是置中的，不用額外算位移。
// 執行期縮放／透明度（滾輪或快捷鍵，見下面〈縮放與透明度〉）也走同一條規則，所以現在不論
// cardScale 是多少都會插入：縮放倍率改成 CSS 變數 --shell-scale（預設就是 CARD_SCALE，
// 執行期由外殼寫入 CARD_SCALE × zoom），透明度是 --shell-opacity（預設 1＝完全不透明，
// opacity:1 不會多建 stacking context，跟沒設一樣）。cardScale=1 時 --card-w 鎖 372px
// 跟原本 clamp() 在 560×820 視窗下算出來的值相同，所以預設外觀不變。
// ::-webkit-scrollbar：縮小時卡片的「布局尺寸」不變（只有 transform 縮小），文件比視窗大會長出
// 滾動條，把它藏起來（滾輪本來就被拿去縮放，不會真的捲動）。
// .stage 改成 position:fixed + translate(-50%,-50%) 置中：原本靠 body 的 grid place-items:center，
// 但視窗比卡片布局小（縮小）時，溢出的 grid 項目會退成靠左上對齊（safe alignment），縮小後卡片
// 就偏到右下角；固定定位的置中跟視窗大小無關，縮放永遠以視窗中心為準。
const CARD_SCALE_CSS = `:root{ --card-w:372px !important; } .stage{ position:fixed; left:50%; top:50%; transform:translate(-50%,-50%) scale(var(--shell-scale, ${CARD_SCALE})); } body{ opacity:var(--shell-opacity, 1); } ::-webkit-scrollbar{ display:none; } .hint{ height:32px !important; overflow:visible !important; font-size:14px !important; font-weight:600 !important; line-height:1.5 !important; letter-spacing:.04em !important; color:rgba(240,244,250,.9) !important; text-shadow:0 1px 4px #000,0 0 8px rgba(0,0,0,.85) !important; }${AMBIENT_STARS ? '' : ' .fx-stars{ display:none !important; }'}`;

// ==================== 縮放與透明度（常數） ====================
// zoom＝相對「設定的卡片大小」（cardScale 那個基準）的倍率，預設 1；有效縮放＝CARD_SCALE × zoom，
// 限制在 0.25～2.5 倍。opacity 0.2～1。單卡存在 window-position.json（跟位置一起），多卡每一格
// 各自存在 card-slots.json。滾輪（游標在卡片上）＝縮放、Alt＋滾輪＝透明度、滑鼠中鍵＝重設；
// 也可以用下面四個全域快捷鍵（多卡時對「全部卡片」一起調）。組合鍵選 Ctrl+Alt+= - ] [ 是因為
// 實測這台機器上是空的（Ctrl+Alt+方向鍵在部分 Intel 顯示卡驅動下是旋轉螢幕，故意避開）。
const SCALE_MIN = 0.25;
const SCALE_MAX = 2.5;
const ZOOM_MIN = SCALE_MIN / CARD_SCALE;
const ZOOM_MAX = SCALE_MAX / CARD_SCALE;
const OPACITY_MIN = 0.2;
const ZOOM_IN_KEY = process.env.ZOOM_IN_KEY || pkg.zoomInKey || 'Ctrl+Alt+=';
const ZOOM_OUT_KEY = process.env.ZOOM_OUT_KEY || pkg.zoomOutKey || 'Ctrl+Alt+-';
const OPACITY_UP_KEY = process.env.OPACITY_UP_KEY || pkg.opacityUpKey || 'Ctrl+Alt+]';
const OPACITY_DOWN_KEY = process.env.OPACITY_DOWN_KEY || pkg.opacityDownKey || 'Ctrl+Alt+[';

// ==================== 匯出分享（常數） ====================
// 把卡片「旋轉一圈」錄成 WebM／GIF，或匯出 PNG（透明背景）。實作在 card-export/（見 桌面掛件說明.md〈匯出分享〉）。
// 快捷鍵用預設格式匯出：單卡＝這張卡；多卡＝「滑鼠游標所在的那張卡」（游標不在任何卡片上就提示，不亂猜）。
// 系統匣選單可以選任意格式、（多卡時）任意一張或全部。Ctrl+Alt+4 實測在這台機器上是空的（1/2/3 已被特效用掉）。
// 輸出資料夾預設「圖片\幻影卡匯出」，匯出完成的通知點一下會打開資料夾並選取檔案（PNG 同時複製到剪貼簿）。
const EXPORT_KEY = process.env.EXPORT_KEY || pkg.exportKey || 'Ctrl+Alt+4';
// 多卡才用：把「整個版面」（所有卡一起）用預設格式匯出。時鐘轉圈動畫只放在系統匣選單（比較少用，不佔快捷鍵）。
const EXPORT_LAYOUT_KEY = process.env.EXPORT_LAYOUT_KEY || pkg.exportLayoutKey || 'Ctrl+Alt+5';
const EXPORT_FORMAT_RAW = String(process.env.EXPORT_FORMAT || pkg.exportFormat || 'webm').toLowerCase();
const EXPORT_FORMAT = cardExporter.FORMATS[EXPORT_FORMAT_RAW] ? EXPORT_FORMAT_RAW : 'webm';
const EXPORT_SECONDS = Number(process.env.EXPORT_SECONDS) || pkg.exportSeconds || 3;
// GIF 尺寸倍率（單張＝500×680×倍率；多卡版面長邊約 900×倍率）：預設 1.5（高畫質、檔案大）；GUI「GIF 尺寸」選單／yml gifScale／環境變數 GIF_SCALE 可改。
const GIF_SCALE = Number(process.env.GIF_SCALE) || Number(pkg.gifScale) || undefined;
const EXPORT_DIR = process.env.EXPORT_DIR || path.join(app.getPath('pictures'), '幻影卡匯出');
function clampNum(v, a, b, fallback) {
  if (v === null || v === undefined || v === '') return fallback; // Number(null) 是 0，不能當有效值
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : fallback;
}
const clampZoom = (z) => clampNum(z, ZOOM_MIN, ZOOM_MAX, 1);
const clampOpacity = (o) => clampNum(o, OPACITY_MIN, 1, 1);
// kind: 'zoom'｜'opacity'｜'reset'；dir: +1／-1；big: 快捷鍵步距較大（滾輪一格較小）。
function nextView(cur, kind, dir, big) {
  if (kind === 'reset') return { zoom: 1, opacity: 1 };
  if (kind === 'zoom') return { zoom: clampZoom(cur.zoom * Math.pow(big ? 1.1 : 1.05, dir)), opacity: cur.opacity };
  return { zoom: cur.zoom, opacity: clampOpacity(Math.round((cur.opacity + dir * (big ? 0.1 : 0.05)) * 100) / 100) };
}
// 快捷鍵／系統匣指令字串 → [kind, dir]
function parseViewCmd(cmd) {
  if (cmd === 'reset') return ['reset', 0];
  return [cmd.startsWith('zoom') ? 'zoom' : 'opacity', /-(in|up)$/.test(cmd) ? 1 : -1];
}
// 單卡模式：卡片「第一次啟動、還沒被拖過」時的預設位置偏移量（相對螢幕正中央，
// 往右/往下為正）。拖過一次之後，位置會存檔案（見 POSITION_FILE），這個預設值
// 就不會再生效。多卡模式不用這個，每張卡的初始位置直接寫在 cards[].x/y。
const DEFAULT_OFFSET = pkg.defaultOffset || { x: 0, y: 0 };
const LOG_TAG = `[${pkg.name}]`;

let win = null;
let clickThrough = false; // 預設可互動：滑鼠移到卡片上旋轉、按住右鍵拖曳移動位置

const POSITION_FILE = path.join(app.getPath('userData'), 'window-position.json');
const SLOTS_FILE = path.join(app.getPath('userData'), 'card-slots.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let savePositionTimer = null;
let saveSlotsTimer = null;
let currentSlots = null; // 多卡模式：目前每張卡的 {x,y,zoom,opacity}，索引對應 MULTI_CARDS
let view = { zoom: 1, opacity: 1 }; // 單卡模式：目前的縮放／透明度

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function schedulePositionSave() {
  // 拖曳中 setPosition 會連續觸發很多次 'moved'，用個小 debounce 避免每個
  // mousemove 都寫一次磁碟。
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    try {
      fs.writeFileSync(POSITION_FILE, JSON.stringify({ x, y, zoom: view.zoom, opacity: view.opacity }));
    } catch (e) {
      console.warn(`${LOG_TAG} 存檔卡片位置失敗：`, e);
    }
  }, 300);
}

function scheduleSlotsSave() {
  clearTimeout(saveSlotsTimer);
  saveSlotsTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SLOTS_FILE, JSON.stringify(currentSlots));
    } catch (e) {
      console.warn(`${LOG_TAG} 存檔卡片格位失敗：`, e);
    }
  }, 300);
}

// 注入到每張卡片頁面裡的通用腳本，不動任何一張卡片本身的 html：
// 1) 加上「在卡片上按住滑鼠右鍵拖曳＝移動這張卡的位置」。監聽器刻意掛在 .stage
//    本身（不是 window），拖曳才只會在滑鼠真的按在卡片上時才開始。卡片原本的
//    旋轉效果是 hover-based（滑鼠移到哪、卡片就朝哪傾斜，見卡片 html 裡的
//    pointermove/aim()），完全不看滑鼠按鍵，所以右鍵可以放心整個挪來做別的事。
// 2) 實際搬動位置要走 main process 或（多卡模式）父頁面，渲染頁面自己沒有這個
//    權限，所以透過 preload.js 暴露的 cardShell.moveBy() 轉發：單卡模式裡這個
//    frame 本身就是最上層視窗，moveBy 會送 IPC 給 main.js 呼叫 win.setPosition()；
//    多卡模式裡這個 frame 是個 iframe，moveBy 改成 postMessage 給父頁面
//    （stage 頁面），只搬動這張卡在共用視窗裡的位置，不牽涉 OS 視窗本身
//    （這個判斷寫在 preload.js，卡片腳本本身不用知道自己在哪種模式下執行）。
// 3) 多卡模式才會用到：接住 stage 頁面（父頁面）broadcastFlip() 送來的「手勢
//    剪刀」翻面訊息，轉發成卡片自己原本就有的雙擊翻面事件——細節見下面
//    window.addEventListener('message', ...) 那段的註解。
const INJECTED_SCRIPT = `
(function(){
  if (window.__phantomCardDragInit) return;
  window.__phantomCardDragInit = true;

  var stage = document.querySelector('.stage') || document.body;
  var dragging = false, lastX = 0, lastY = 0;

  window.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  stage.addEventListener('mousedown', function(e){
    if (e.button !== 2 || !window.cardShell) return;
    dragging = true;
    lastX = e.screenX; lastY = e.screenY;
    document.body.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e){
    if (!dragging) return;
    var dx = e.screenX - lastX, dy = e.screenY - lastY;
    lastX = e.screenX; lastY = e.screenY;
    window.cardShell.moveBy(dx, dy);
  });

  function stopDrag(){
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  }
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('mouseleave', stopDrag);
  window.addEventListener('blur', stopDrag);

  // 手勢「剪刀」翻面轉發（只有多卡模式、這個 frame 是 iframe 時才會收到訊息，
  // 單卡模式沒有父頁面會送這個，這段程式碼留著也不會做任何事）：卡片本身的
  // <script> 已經有 card.addEventListener('dblclick', flip)（見各卡片 html），
  // flip() 是「切換到另一面」，不是「設成指定的哪一面」，所以不能收到訊息就
  // 無腦送一次雙擊——如果使用者自己先手動雙擊過這張卡，兩邊會對不起來，越轉
  // 越亂。做法是自己追蹤目前翻到哪一面：不管是使用者真的雙擊、還是下面
  // dispatchEvent 自己送出的合成雙擊，都會被這個 listener 算到（兩個 listener
  // 掛在同一個 target 上，事件一定會被兩邊同時收到，不用擔心漏算），只有算出
  // 來的現況跟收到的目標不一樣時才真的送出合成雙擊，狀態不會因為手勢跟使用者
  // 手動雙擊穿插而兜不起來。
  var card = document.getElementById('card');
  var flipped = false;
  if (card) card.addEventListener('dblclick', function(){ flipped = !flipped; });
  window.addEventListener('message', function(e){
    if (!e.data || typeof e.data.__phantomCardFlip !== 'boolean' || !card) return;
    if (e.data.__phantomCardFlip === flipped) return;
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });

  // 每秒自動翻面循環開關轉發：這個 INJECTED_SCRIPT 是用 executeJavaScript 注入
  // 到「主世界」執行的，跟卡片自己的 <script> 共用同一個 window——所有卡片
  // 都會把 toggleAutoFlip 掛在 window 上（見各卡片 html），萬一有卡片沒有這個
  // 函式，下面這行單純是 no-op，不會噴錯。單卡模式時
  // main.js 直接對這個 frame 呼叫 executeJavaScript 已經夠用，不會走這條
  // postMessage 路徑，但留著也無妨（單卡模式沒有父頁面會送這個訊息）。
  window.addEventListener('message', function(e){
    if (!e.data || !e.data.__phantomCardAutoFlipToggle) return;
    if (window.toggleAutoFlip) window.toggleAutoFlip();
  });

  // 點擊穿透模式下的全域滑鼠追蹤（見 main.js「穿透模式下的全域滑鼠追蹤」）：穿透時
  // 視窗收不到滑鼠事件，外殼改用游標座標輪詢，換算成這個 frame 的視窗座標
  // {x, y}（或離開追蹤時的 null）送進來。這裡把它「翻譯」成卡片原本就在聽的
  // 兩種事件——window 上的 pointermove（更新傾斜/視差目標）、card 上的
  // pointerleave（放開、回到閒置擺動）——所以每張卡片的程式碼完全不用改，
  // 也不需要卡片知道有這個功能。游標離卡片中心超過 CURSOR_RANGE 張卡寬/高
  // 就視為離開，避免螢幕另一端的游標把卡片永遠扳到最大傾斜角。
  var CURSOR_RANGE = 1.6;
  var cursorInside = false;
  function applyCursor(p){
    var c = document.getElementById('card');
    if (!c) return;
    var inRange = false;
    if (p) {
      var r = c.getBoundingClientRect();
      var dx = (p.x - (r.left + r.width / 2)) / r.width;
      var dy = (p.y - (r.top + r.height / 2)) / r.height;
      inRange = Math.hypot(dx, dy) < CURSOR_RANGE;
    }
    if (inRange) {
      cursorInside = true;
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, bubbles: true, pointerType: 'mouse' }));
    } else if (cursorInside) {
      cursorInside = false;
      c.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }));
    }
  }
  // 單卡模式：這個 frame 就是最上層視窗，直接接 IPC。多卡模式：這個 frame 是
  // iframe，由 stage 頁面換算好座標後 postMessage 進來。
  if (window.top === window.self && window.cardShell && window.cardShell.onCursor) {
    window.cardShell.onCursor(applyCursor);
  }
  window.addEventListener('message', function(e){
    if (!e.data || !e.data.__phantomCursor) return;
    applyCursor(e.data.p);
  });

  // card-fx 指令轉發（技能演出 cast／稀有度 rarity／靜音 mute）：卡片裡的 fx.js 把
  // window.cardFx 掛在主世界，跟 toggleAutoFlip 一樣的路徑。多卡模式由 stage 頁面
  // postMessage 進來（sound:false 表示這張卡這次不發聲，避免好幾張卡的音效疊在一起）。
  window.__phantomCardFxRun = function(cmd, sound){
    var fx = window.cardFx;
    if (!fx) return;
    var o = { sound: sound !== false };
    if (cmd === 'cast') fx.cast(o);
    else if (cmd === 'rarity') fx.cycleRarity(o);
    else if (cmd === 'mute') fx.toggleMute();
  };
  window.addEventListener('message', function(e){
    if (!e.data || !e.data.__phantomCardFx) return;
    window.__phantomCardFxRun(e.data.__phantomCardFx, e.data.sound);
  });

  // 縮放／透明度（見 main.js〈縮放與透明度〉）：套用＝寫兩個 CSS 變數，規則本身在 CARD_SCALE_CSS。
  // 初始值：單卡由 main.js 載入後呼叫；多卡藏在 iframe 網址的 #view=<縮放>,<透明度>。
  window.__phantomCardViewSet = function(scale, opacity){
    var st = document.documentElement.style;
    st.setProperty('--shell-scale', String(scale));
    st.setProperty('--shell-opacity', String(opacity));
  };
  (function(){
    var m = /view=([0-9.]+),([0-9.]+)/.exec(location.hash);
    if (m) window.__phantomCardViewSet(m[1], m[2]);
  })();
  window.addEventListener('message', function(e){
    if (!e.data || !e.data.__phantomCardViewSet) return;
    window.__phantomCardViewSet(e.data.__phantomCardViewSet.scale, e.data.__phantomCardViewSet.opacity);
  });
  // 滾輪＝縮放、Alt＋滾輪＝透明度、中鍵＝重設；實際調整交給 main.js／stage 頁面（要動視窗大小、要存檔）。
  var lastWheel = 0;
  window.addEventListener('wheel', function(e){
    if (!window.cardShell || !window.cardShell.viewBy) return;
    e.preventDefault();
    var now = Date.now();
    if (now - lastWheel < 30) return;
    lastWheel = now;
    window.cardShell.viewBy(e.altKey ? 'opacity' : 'zoom', e.deltaY < 0 ? 1 : -1, false);
  }, { passive: false });
  stage.addEventListener('mousedown', function(e){
    if (e.button !== 1 || !window.cardShell || !window.cardShell.viewBy) return;
    e.preventDefault();
    window.cardShell.viewBy('reset', 0, false);
  });

  // 卡片下方那行操作提示：卡片自己寫的是「單獨用瀏覽器開」的按法（按 L 鍵切換自動翻面），在桌面掛件裡 L 鍵沒有作用，
  // 實際是全域快捷鍵，而且也沒提到匯出。這裡依外殼「實際設定的鍵」改寫：拿掉講 L 鍵的那一段，補上自動翻面與匯出分享。
  // 不改任何卡片 html（瀏覽器單獨開的卡片維持原樣）；提示高度在 CARD_SCALE_CSS 固定成 32px，加長不會讓卡片位置跑掉。
  (function(){
    var h = document.querySelector('.hint');
    if (!h || h.getAttribute('data-shell-hint')) return;
    var parts = h.textContent.trim().split(' · ').filter(function(p){ return p && !/L 鍵/.test(p); });
    parts.push(${JSON.stringify(AUTOFLIP_KEY)} + ' 自動翻面', ${JSON.stringify(EXPORT_KEY)} + ' 匯出分享');
    h.textContent = parts.join(' · ');
    h.setAttribute('data-shell-hint', '1');
  })();
})();
`;

// 單卡模式的卡片頁面本身就是這個視窗最上層的文件，CARD_SCALE_CSS 直接混進這條
// 既有的 insertCSS 字串就好。
const TRANSPARENT_CSS = `html,body{ background:transparent !important; overflow:visible !important; } ${CARD_SCALE_CSS}`;

// ==================== 單卡模式 ====================
function createSingleWindow() {
  const saved = loadJson(POSITION_FILE);
  if (saved) view = { zoom: clampZoom(saved.zoom), opacity: clampOpacity(saved.opacity) };
  const winW = Math.round(WIN_W * view.zoom);
  const winH = Math.round(WIN_H * view.zoom);
  let x, y;
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    ({ x, y } = saved);
  } else {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    x = Math.round((sw - winW) / 2) + DEFAULT_OFFSET.x;
    y = Math.round((sh - winH) / 2) + DEFAULT_OFFSET.y;
  }

  win = new BrowserWindow({
    x,
    y,
    width: winW,
    height: winH,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    // 刻意留在工作列（不是 true）：這個視窗沒有標題列，原生沒有 X 可以按，
    // 快捷鍵又可能因為跟其他同時開著的卡片掛件搶鍵而失效（見下面系統匣圖示
    // 那段的說明）——留在工作列，使用者就能在工作列圖示上按右鍵選「關閉視窗」
    // （Windows 內建的工作列右鍵選單本來就有這個選項，不用自己刻），是除了
    // 系統匣圖示以外，另一個不依賴全域快捷鍵、隨時保證關得掉的入口。
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      backgroundThrottling: false,
      // card-fx 的 WebAudio 音效由全域快捷鍵/系統匣觸發，頁面沒有使用者手勢；預設的
      // autoplay 政策會讓 AudioContext 卡在 suspended 而完全沒聲音。
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  startKeepOnTop();
  win.on('moved', schedulePositionSave);

  // ⚠️ 不能用 win.loadFile(path)：它不會替路徑編碼，檔名裡有 % # ? 就會被當成網址語法
  // （例如 `xxx%3F2.html` 的 %3F 被解成 `?`），找不到檔案、整個視窗一片空白——圖片一鍵生成
  // 的卡片名稱是使用者可以隨便打的，實際發生過。pathToFileURL 會正確編碼。
  win.loadURL(pathToFileURL(path.join(__dirname, CARD_FILE)).href);

  win.webContents.on('did-finish-load', () => {
    autoFlipOn = false;
    win.webContents.insertCSS(TRANSPARENT_CSS);
    win.webContents.executeJavaScript(INJECTED_SCRIPT).catch((err) => {
      console.warn(`${LOG_TAG} 右鍵拖曳腳本注入失敗：`, err);
    }).then(pushSingleView);
  });

  win.setIgnoreMouseEvents(clickThrough, { forward: true });
}

ipcMain.on('card-move-by', (_event, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// ==================== 縮放與透明度（單卡） ====================
// 縮放＝把視窗依中心縮放（setBounds）＋把 --shell-scale 設成 CARD_SCALE × zoom（卡片內容跟著
// 等比例）；透明度＝ --shell-opacity（CSS，不用 win.setOpacity——多卡模式沒有各自的視窗，
// 兩種模式用同一套做法）。結果跟位置存在同一個 window-position.json。
function pushSingleView() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `window.__phantomCardViewSet && window.__phantomCardViewSet(${(CARD_SCALE * view.zoom).toFixed(4)}, ${view.opacity})`
  ).catch(() => {});
}

function setSingleView(next) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const w = Math.round(WIN_W * next.zoom);
  const h = Math.round(WIN_H * next.zoom);
  view = { zoom: next.zoom, opacity: next.opacity };
  win.setBounds({
    x: Math.round(b.x + (b.width - w) / 2),
    y: Math.round(b.y + (b.height - h) / 2),
    width: w,
    height: h,
  });
  pushSingleView();
  schedulePositionSave(); // setBounds 不一定會觸發 'moved'，明確存一次
}

function stepSingleView(kind, dir, big) {
  if (!['zoom', 'opacity', 'reset'].includes(kind)) return;
  setSingleView(nextView(view, kind, dir < 0 ? -1 : 1, !!big));
}

ipcMain.on('view-by', (_event, kind, dir, big) => {
  if (!(Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0)) stepSingleView(kind, dir, big);
});

// 快捷鍵／系統匣指令：'zoom-in'｜'zoom-out'｜'opacity-up'｜'opacity-down'｜'reset'。
// 單卡直接處理；多卡送 IPC 給 stage 頁面，對「全部卡片」一起調。
function sendView(cmd) {
  if (!win || win.isDestroyed()) return;
  if (Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0) {
    win.webContents.send('view-cmd', cmd);
  } else {
    const [kind, dir] = parseViewCmd(cmd);
    stepSingleView(kind, dir, true);
  }
}

// ==================== 多卡合一模式 ====================
// 時鐘式循環（6 張的固定角度版）：把 6 個格位分成上排/下排各 3 個，指定各自在「時鐘錶面」上的
// 角度（0°＝12 點鐘方向，順著時鐘方向增加）——剛好 6 等分對應鐘面的 10/12/2
// （上排）跟 4/6/8（下排）點鐘位置，跟「上三下三」的版面形狀自然對得起來。
// 角度是直接從目前設定的格位座標「反推」出來的（哪格 x 最靠左/右、y 是上排
// 還是下排），不是寫死的絕對座標，所以套用在任何 6 卡排法（不管是內建的
// 「排成 6 卡」按鈕排的、還是使用者自己用座標挑選器喬過的）都會自動對齊。
// ⚠️ 數學上，「6 個點剛好落在一個矩形的兩排」跟「6 個點剛好是同一個橢圓上
// 等角度分布的 6 個點」這兩件事沒辦法同時成立（矩形上排 3 個點等高，但橢圓上
// 10/12/2 點鐘這三個角度算出來的高度並不相等，除非橢圓整個扁掉）——所以套用
// 這個功能、第一次按下 CYCLE_KEY 開始轉的瞬間，卡片會從「格位原本的矩形座標」
// 平滑滑向「橢圓上最接近的那個點」再開始繞圈（見 buildStageHtml() 的
// TWEEN_MS），不是無縫接軌；橢圓的 rx/ry 用格位座標的左右/上下範圍算，所以
// 繞圈的軌跡剛好內接在原本 6 格排出來的那個矩形範圍裡，不會轉出去外面。
// 3 張以上、不是剛好 6 張的版面：依每張卡「目前的位置」換算成鐘面角度（0＝12 點鐘，順時針），依角度排序後平均分配
// 360/N（第一張留在原本的角度，其餘依序等距），橢圓中心與半徑由所有卡中心的範圍決定（半徑至少 150px，避免全部排成一列時半徑是 0）。
function computeCycleConfigAny(cards) {
  const n = cards.length;
  const centers = cards.map((c) => ({ cx: c.x + (c.w || WIN_W) / 2, cy: c.y + (c.h || WIN_H) / 2 }));
  const xs = centers.map((c) => c.cx);
  const ys = centers.map((c) => c.cy);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const rx = Math.max((Math.max(...xs) - Math.min(...xs)) / 2, 150);
  const ry = Math.max((Math.max(...ys) - Math.min(...ys)) / 2, 150);
  const ang = centers.map((c) => (((Math.atan2((c.cx - cx) / rx, -(c.cy - cy) / ry) * 180) / Math.PI) + 360) % 360);
  const order = ang.map((_, i) => i).sort((a, b) => ang[a] - ang[b]);
  const offsets = new Array(n);
  order.forEach((idx, k) => { offsets[idx] = (ang[order[0]] + (k * 360) / n) % 360; });
  return { cx, cy, rx, ry, offsets, periodMs: CYCLE_PERIOD_MS };
}

// 剛好 5 張＝「中央＋四角」版面：第 1 張（清單第一張）固定在正中央不動，其餘 4 張原本站在四個角落，時鐘循環只讓這 4 張
// 繞著第 1 張轉（橢圓的圓心就是第 1 張的中心，半徑取 4 張到中心的平均水平／垂直距離）。4 張角度依目前位置換算、排序後每隔 90° 均分，
// 所以站在四角時剛好是 45°／135°／225°／315°；offsets[0] 是 null＝固定不動。fixed:true 告訴舞台頁面要做前後遮擋：
// 轉到中心卡下半部的那張蓋在它前面、轉到上半部的那張躲到它後面，看起來才像真的繞著它轉。
function computeCycleConfigCentre(cards) {
  const centers = cards.map((c) => ({ cx: c.x + (c.w || WIN_W) / 2, cy: c.y + (c.h || WIN_H) / 2 }));
  const c0 = centers[0];
  const others = centers.slice(1);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const rx = Math.max(avg(others.map((c) => Math.abs(c.cx - c0.cx))), 150);
  const ry = Math.max(avg(others.map((c) => Math.abs(c.cy - c0.cy))), 150);
  const ang = others.map((c) => (((Math.atan2((c.cx - c0.cx) / rx, -(c.cy - c0.cy) / ry) * 180) / Math.PI) + 360) % 360);
  const order = ang.map((_, i) => i).sort((a, b) => ang[a] - ang[b]);
  const offsets = new Array(cards.length).fill(null);
  order.forEach((idx, k) => { offsets[idx + 1] = (ang[order[0]] + (k * 360) / others.length) % 360; });
  return { cx: c0.cx, cy: c0.cy, rx, ry, offsets, periodMs: CYCLE_PERIOD_MS, fixed: true };
}

function computeCycleConfig(cards) {
  if (!Array.isArray(cards) || cards.length < 3) return null;
  if (cards.length === 5) return computeCycleConfigCentre(cards);
  if (cards.length !== 6) return computeCycleConfigAny(cards);
  const centers = cards.map((c) => ({
    cx: c.x + (c.w || WIN_W) / 2,
    cy: c.y + (c.h || WIN_H) / 2,
  }));
  const order = centers.map((_, i) => i).sort((a, b) => centers[a].cy - centers[b].cy);
  const topIdx = order.slice(0, 3).sort((a, b) => centers[a].cx - centers[b].cx);
  const bottomIdx = order.slice(3).sort((a, b) => centers[a].cx - centers[b].cx);
  const TOP_ANGLES = [300, 0, 60]; // 左→右：10 點、12 點、2 點
  const BOTTOM_ANGLES = [240, 180, 120]; // 左→右：8 點、6 點、4 點（順時針要接在 2 點後面接 4 點，所以角度反而往回走）
  const offsets = new Array(6);
  topIdx.forEach((idx, rank) => { offsets[idx] = TOP_ANGLES[rank]; });
  bottomIdx.forEach((idx, rank) => { offsets[idx] = BOTTOM_ANGLES[rank]; });

  const xs = centers.map((c) => c.cx);
  const topYs = topIdx.map((i) => centers[i].cy);
  const bottomYs = bottomIdx.map((i) => centers[i].cy);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const rx = (Math.max(...xs) - Math.min(...xs)) / 2;
  const topY = avg(topYs);
  const bottomY = avg(bottomYs);
  const cy = (topY + bottomY) / 2;
  const ry = (bottomY - topY) / 2;

  return { cx, cy, rx, ry, offsets, periodMs: CYCLE_PERIOD_MS };
}

// 手勢散開（布）／收縮（拳頭）的圓心／收縮點：直接用目前格位座標的 bounding
// box 中心（不是螢幕正中央），這樣不管卡片群原本排在螢幕哪個角落，散開/收縮
// 都會繞著這群卡片自己的中心動，感覺才自然。散開半徑用「N 張卡剛好等距圍成
// 一圈、彼此邊緣不重疊」的最小外接圓公式（CARD_W / (2*sin(π/N))）再乘 1.15
// 留一點間隙；只有 1 張卡時半徑是 0（散開/收縮都停在同一點，跟「只有一張卡
// 沒什麼好散開」的直覺一致）。任何張數的多卡合一都適用。
function computeGestureLayout(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const n = cards.length;
  const minX = Math.min(...cards.map((c) => c.x));
  const minY = Math.min(...cards.map((c) => c.y));
  const maxX = Math.max(...cards.map((c) => c.x + (c.w || WIN_W)));
  const maxY = Math.max(...cards.map((c) => c.y + (c.h || WIN_H)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = n > 1 ? (WIN_W / (2 * Math.sin(Math.PI / n))) * 1.15 : 0;
  return { cx, cy, radius, transitionMs: GESTURE_TRANSITION_MS, showSkeleton: GESTURE_SHOW_SKELETON };
}

function buildStageHtml(cards, cycleConfig, gestureConfig) {
  const slots = cards
    .map((c, i) => {
      // 同上：檔名要經過 pathToFileURL 編碼（含 % # ? 的檔名不能直接串成網址），再轉義成 HTML 屬性安全。
      const src = pathToFileURL(path.join(__dirname, c.file)).href.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const bw = c.baseW || c.w || WIN_W;
      const bh = c.baseH || c.h || WIN_H;
      const z = c.zoom || 1;
      const o = c.opacity == null ? 1 : c.opacity;
      const w = Math.round(bw * z);
      const h = Math.round(bh * z);
      // 縮放/透明度的初始值放在網址 #view=<有效縮放>,<透明度>，卡片裡的注入腳本載入時讀（見 INJECTED_SCRIPT）
      return `<div class="card-slot" data-idx="${i}" data-zoom="${z}" data-defzoom="${c.defZoom == null ? 1 : c.defZoom}" data-opacity="${o}" data-basew="${bw}" data-baseh="${bh}" style="position:absolute; left:${c.x}px; top:${c.y}px; width:${w}px; height:${h}px;">
      <iframe src="${src}#view=${(CARD_SCALE * z).toFixed(4)},${o}" style="width:100%; height:100%; border:0; background:transparent;"></iframe>
    </div>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html,body{ margin:0; height:100%; background:transparent; overflow:hidden; }
  .card-slot{ overflow:visible; perspective:1600px; }
  .card-slot iframe{ overflow:visible; }
  /* 剪刀手勢＝翻到背面：以前這裡自己刻一層 .flip-inner／.flip-face 3D 容器，
     翻面時整格一起轉，背面畫外殼統一的通用「幻影卡背」樣式（金底＋一個
     ✦），完全不管裡面是哪張卡片——但每張卡片 html 現在都有自己設計的背面
     （雙擊卡片本身即可翻到），兩套背面長得不一樣，手勢翻出來的反而是比較
     陽春的舊版，變成兩套機制各做各的、對不起來。
     現在改成：剪刀進來/離開時，main.js 的 INJECTED_SCRIPT（見 main.js，
     注入到每張卡片的 iframe 裡）收到這裡 postMessage 送出的目標翻面狀態，
     轉發成卡片自己原本就有的雙擊翻面事件（card.addEventListener('dblclick',
     flip)），秀出來的就是卡片自己設計的那個背面，不用再維護一套獨立的通用
     背面樣式，也不用改任何一張卡片本身的程式碼。見下面 broadcastFlip()。 */
  #gestureVideo{ display:none; }
  #gestureStatus{
    position:fixed; left:12px; bottom:12px; z-index:999999; display:none;
    font:12px/1.4 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif;
    color:#e6f6ff; background:rgba(10,14,20,.55); border:1px solid rgba(255,255,255,.14);
    border-radius:8px; padding:4px 10px; pointer-events:none;
    text-shadow:0 1px 3px rgba(0,0,0,.6);
  }
  /* 手部骨架視覺效果：疊在卡片之上的全螢幕透明畫布，滑鼠事件一律穿透（不能
     擋到卡片原本的 hover/拖曳），只有真的偵測到手、且 gestureShowSkeleton
     開啟時才會畫東西上去，見下面〈手部骨架視覺效果〉。 */
  #gestureSkeletonCanvas{
    position:fixed; inset:0; width:100%; height:100%;
    z-index:999998; pointer-events:none; background:transparent;
  }
</style>
<!-- 手勢散開/收縮：只載入 @mediapipe/hands（不用連 camera_utils 一起載，攝影機
     的啟停自己手刻，理由見下面〈手勢散開/收縮〉開頭的說明）。腳本本身很輕，
     真正的模型檔案要等第一次按 GESTURE_KEY、真的 new Hands() 才會去抓，平常
     不會多耗流量/啟動時間。 -->
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js" crossorigin="anonymous"></script>
</head>
<body>
${slots}
<video id="gestureVideo" autoplay playsinline muted></video>
<canvas id="gestureSkeletonCanvas"></canvas>
<div id="gestureStatus"></div>
<script>
(function(){
  var slotEls = Array.prototype.slice.call(document.querySelectorAll('.card-slot'));
  var CYCLE = ${cycleConfig ? JSON.stringify(cycleConfig) : 'null'};
  var GESTURE = ${gestureConfig ? JSON.stringify(gestureConfig) : 'null'};
  // 預設不轉，要按 CYCLE_KEY 才開始（見 main.js 說明）。
  var cycleRunning = false;
  var globalAngleDeg = 0;
  var lastFrameTs = null;
  // 每次「從暫停恢復轉動」（包含第一次按下 CYCLE_KEY）都不是直接跳到橢圓上的
  // 點，而是花 TWEEN_MS 的時間平滑滑過去——見 computeCycleConfig() 開頭那段
  // 「矩形跟橢圓沒辦法完全疊合」的說明，這裡用補間掩蓋那個必然存在的落差，
  // 不會讓卡片瞬間「跳」一下。
  var TWEEN_MS = 500;
  var tweenStartTs = null;
  var tweenFrom = null; // 補間起點：[{left, top}, ...]，索引對應 slotEls

  function cyclePointFor(i, angleDeg){
    var el = slotEls[i];
    var w = parseFloat(el.style.width) || 0;
    var h = parseFloat(el.style.height) || 0;
    // offsets[i] 是 null＝固定不動的卡（5 卡版面的中央那張）：留在圓心
    if (CYCLE.offsets[i] === null) return { left: CYCLE.cx - w / 2, top: CYCLE.cy - h / 2 };
    var thetaRad = (CYCLE.offsets[i] + angleDeg) * Math.PI / 180;
    // 時鐘參數式：theta=0 在 12 點鐘方向（正上方），角度增加＝順時針。
    return {
      left: CYCLE.cx + CYCLE.rx * Math.sin(thetaRad) - w / 2,
      top: CYCLE.cy - CYCLE.ry * Math.cos(thetaRad) - h / 2,
    };
  }

  // 5 卡「中央＋四角」：繞行的卡轉到中心卡的下半部（cos<0）就蓋在它前面，上半部就躲到它後面；中心卡 z=1
  function applyCycleDepth(i, angleDeg){
    if (!CYCLE.fixed) return;
    if (CYCLE.offsets[i] === null) { slotEls[i].style.zIndex = 1; return; }
    slotEls[i].style.zIndex = Math.cos((CYCLE.offsets[i] + angleDeg) * Math.PI / 180) < 0 ? 2 : 0;
  }

  function applyCyclePositions(angleDeg){
    for (var i = 0; i < slotEls.length; i++) {
      var p = cyclePointFor(i, angleDeg);
      slotEls[i].style.left = p.left + 'px';
      slotEls[i].style.top = p.top + 'px';
      applyCycleDepth(i, angleDeg);
    }
  }

  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }

  function startTween(ts){
    tweenStartTs = ts;
    tweenFrom = slotEls.map(function(el){
      return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 };
    });
  }

  // ==================== 手勢散開（布）／收縮（拳頭）／翻面（剪刀） ====================
  // 參考 C:\\hand-tracker 用 MediaPipe Hands 讀攝影機判斷手勢的做法，但這裡
  // 不需要畫發光骨架，只要分類手勢驅動卡片位置/正反面，所以只載入
  // @mediapipe/hands，攝影機開關自己手刻（不用它的 camera_utils 工具），開關
  // 邏輯才能跟 GESTURE_KEY 的「按一次開、再按一次關並釋放攝影機」對得上。
  var BASE_POSITIONS = slotEls.map(function(el){
    return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 };
  });
  var gestureEnabled = false;
  var gestureState = 'base'; // 'base'（原始格位）｜'paper'（散開成圓）｜'fist'（收縮成一張）｜'scissors'（翻到背面，位置不變）
  var cardsFlipped = false; // 目前是不是背面朝上，見 startGestureTween() 對 'scissors' 的處理
  var gestureTweenStartTs = null;
  var gestureTweenFrom = null;
  var gestureTargets = null;
  var handsInstance = null;
  var handsReadyPromise = null; // new Hands() 的 wasm/模型檔案下載＋編譯進度，見 ensureHandsInstance()
  var gestureStream = null;
  var gestureRafId = null;
  var candidateGesture = null;
  var candidateCount = 0;
  var noGestureCount = 0; // 連續判斷不到手勢（手離開畫面，或姿勢不明確）的幀數，見 handleGestureResults()
  var STABLE_FRAMES_NEEDED = 4; // 連續 4 幀分類一致才真的切換，濾掉手部過渡動作的雜訊
  // 手部關鍵點的平滑濾波（指數移動平均）：MediaPipe 每一幀重新估計 21 個點，
  // 就算手完全不動，逐幀估計值本身也有雜訊，加上把 640×480 攝影機畫面的正規化
  // 座標直接放大貼到全螢幕畫布，這點雜訊會被放大成看得見的抖動——不是使用者
  // 手真的在抖，是沒做時間平滑的關鍵點偵測本來就這樣。SMOOTH_ALPHA 越小畫面
  // 越穩但跟手的實際動作會有一點點延遲，0.4 是「肉眼看起來穩、但揮手時還跟得
  // 上」的折衷值。分類手勢跟畫骨架都用平滑後的點，濾掉雜訊同時也讓手勢判斷
  // 更穩定。手消失時重置，避免手重新出現在完全不同位置時還跟舊位置做平滑、
  // 讓骨架用「飄過去」的方式追上去。
  var SMOOTH_ALPHA = 0.4;
  var smoothedLandmarks = null;
  function smoothLandmarks(raw){
    if (!smoothedLandmarks) {
      smoothedLandmarks = raw.map(function(p){ return { x: p.x, y: p.y }; });
      return smoothedLandmarks;
    }
    for (var i = 0; i < raw.length; i++) {
      smoothedLandmarks[i].x += (raw[i].x - smoothedLandmarks[i].x) * SMOOTH_ALPHA;
      smoothedLandmarks[i].y += (raw[i].y - smoothedLandmarks[i].y) * SMOOTH_ALPHA;
    }
    return smoothedLandmarks;
  }
  var videoEl = document.getElementById('gestureVideo');
  var statusEl = document.getElementById('gestureStatus');

  // ---------- 手部骨架視覺效果（復刻 C:\\hand-tracker 的發光骨架） ----------
  // 跟 hand-tracker\\index.html 的 onResults()／drawGlowSkeleton() 完全同一套
  // 畫法（分組上色、線段＋節點分兩層畫、shadowBlur 當發光暈染），差別只在這裡
  // 疊在卡片舞台上而不是自己單獨一個視窗。預設值由 GESTURE.showSkeleton
  // （builder-gui 的選單勾選）決定，執行期也可以用系統匣選單「手部骨架視覺
  // 效果」即時開/關（見下面 window.cardShell.onSkeletonToggle），關掉的話
  // Hands 偵測跟手勢控制卡片完全不受影響，只是不畫骨架。
  var SHOW_SKELETON = !!(GESTURE && GESTURE.showSkeleton);
  var skeletonCanvas = document.getElementById('gestureSkeletonCanvas');
  var skeletonCtx = skeletonCanvas.getContext('2d');
  var HAND_GROUPS = [
    { color: '#8fe9ff', bones: [[0, 1], [0, 5], [5, 9], [9, 13], [13, 17], [17, 0]] },
    { color: '#ff6b81', bones: [[1, 2], [2, 3], [3, 4]] },
    { color: '#ffd166', bones: [[5, 6], [6, 7], [7, 8]] },
    { color: '#7bdf7b', bones: [[9, 10], [10, 11], [11, 12]] },
    { color: '#7ea8ff', bones: [[13, 14], [14, 15], [15, 16]] },
    { color: '#d68bff', bones: [[17, 18], [18, 19], [19, 20]] },
  ];
  var FINGERTIP_INDEXES = { 4: true, 8: true, 12: true, 16: true, 20: true };

  function resizeSkeletonCanvas(){
    skeletonCanvas.width = window.innerWidth;
    skeletonCanvas.height = window.innerHeight;
  }
  resizeSkeletonCanvas();
  window.addEventListener('resize', resizeSkeletonCanvas);

  function drawGlowSkeleton(ctx, points){
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    for (var g = 0; g < HAND_GROUPS.length; g++) {
      var group = HAND_GROUPS[g];
      ctx.strokeStyle = group.color;
      ctx.shadowColor = group.color;
      ctx.shadowBlur = 14;
      for (var b = 0; b < group.bones.length; b++) {
        var a = group.bones[b][0], bIdx = group.bones[b][1];
        ctx.beginPath();
        ctx.moveTo(points[a].x, points[a].y);
        ctx.lineTo(points[bIdx].x, points[bIdx].y);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var isTip = !!FINGERTIP_INDEXES[i];
      var glowRadius = isTip ? 15 : 9;
      var coreRadius = isTip ? 4.5 : 3;
      var glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowRadius);
      glow.addColorStop(0, 'rgba(255,255,255,0.9)');
      glow.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, coreRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 跟 handleGestureResults() 分開成獨立函式（不是塞進同一個 function），純粹
  // 是關注點分離：這裡只管「畫不畫得出來」，手勢分類的邏輯完全不用管骨架有沒
  // 有畫、SHOW_SKELETON 開關也不影響手勢辨識的準確度或速度。吃平滑後的座標
  // （見 smoothLandmarks()），不是每幀重新估計、還帶雜訊的原始座標，畫面才不
  // 會抖動。
  function renderSkeletonFrame(smoothedLm){
    skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
    if (!SHOW_SKELETON || !gestureEnabled || !smoothedLm) return;
    skeletonCtx.save();
    // 水平鏡像，道理跟 hand-tracker 一樣：舉右手時骨架要畫在畫面右邊，符合
    // 「照鏡子」的直覺。
    skeletonCtx.translate(skeletonCanvas.width, 0);
    skeletonCtx.scale(-1, 1);
    var points = smoothedLm.map(function(lm){
      return { x: lm.x * skeletonCanvas.width, y: lm.y * skeletonCanvas.height };
    });
    drawGlowSkeleton(skeletonCtx, points);
    skeletonCtx.restore();
  }

  function gesturePointsFor(state){
    if (state === 'paper' && GESTURE) {
      var n = slotEls.length;
      var pts = [];
      for (var i = 0; i < n; i++) {
        var theta = (i * 360 / n) * Math.PI / 180;
        var w = parseFloat(slotEls[i].style.width) || 0;
        var h = parseFloat(slotEls[i].style.height) || 0;
        pts.push({
          left: GESTURE.cx + GESTURE.radius * Math.sin(theta) - w / 2,
          top: GESTURE.cy - GESTURE.radius * Math.cos(theta) - h / 2,
        });
      }
      return pts;
    }
    if (state === 'fist' && GESTURE) {
      return slotEls.map(function(el){
        var w = parseFloat(el.style.width) || 0;
        var h = parseFloat(el.style.height) || 0;
        return { left: GESTURE.cx - w / 2, top: GESTURE.cy - h / 2 };
      });
    }
    if (state === 'scissors') {
      // 剪刀只負責翻面，不改變位置——目標就是「目前畫面上的座標」，等於一段
      // 距離是 0 的補間（沒有視覺位移），維持散開/收縮/循環當下的排法，只是
      // 卡片會翻到背面（見 startGestureTween() 對 cardsFlipped 的處理跟
      // broadcastFlip() 轉發給每張卡片自己的雙擊翻面事件）。
      return slotEls.map(function(el){
        return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 };
      });
    }
    // 'base'：手勢放開/關閉時要「還給」卡片的位置。六卡循環如果正在轉，還給
    // 循環目前算到的角度位置（不是原始格位座標）——不然會先蓋回原始格位，下
    // 一幀又被循環瞬間跳到目前角度，看起來像兩段不連續的動作；循環沒在轉
    // （cycleRunning 是 false）才真的回到原始格位座標。
    if (CYCLE && cycleRunning) {
      var basePts = [];
      for (var bi = 0; bi < slotEls.length; bi++) basePts.push(cyclePointFor(bi, globalAngleDeg));
      return basePts;
    }
    return BASE_POSITIONS;
  }

  function startGestureTween(targetState, ts){
    // 手勢判斷成功、要從「base」接管卡片位置的瞬間：讓六卡循環的「時鐘」在這裡
    // 停表（只清 lastFrameTs，不動 cycleRunning 本身）——這樣手勢放開時循環會
    // 從暫停當下的角度接著轉，不會因為手勢控制期間經過的這段真實時間被一次
    // 補上，讓卡片瞬間跳一大圈。這就是「手勢判斷成功時才忽略轉圈功能」：
    // gestureEnabled（攝影機在背景看）本身不影響循環，只有真的判斷出「布」／
    // 「拳頭」／「剪刀」（targetState 不是 'base'）的那一刻才暫停時鐘，見
    // tick() 的 gestureActive 判斷式。
    if (targetState !== 'base') {
      lastFrameTs = null;
      tweenStartTs = null;
    }
    gestureState = targetState;
    gestureTargets = gesturePointsFor(targetState);
    gestureTweenStartTs = ts;
    gestureTweenFrom = slotEls.map(function(el){
      return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 };
    });
    // 翻面是轉發給每張卡片自己的雙擊翻面事件（見 broadcastFlip()），跟位置
    // 補間完全獨立、不用等 tween 跑完——剪刀進來就翻成背面，換成布/拳頭/放開
    // 手勢就翻回正面，跟位置動畫同時發生也沒關係。
    cardsFlipped = targetState === 'scissors';
    broadcastFlip(cardsFlipped);
  }

  // 把「現在要不要翻到背面」轉發給每張卡片的 iframe，讓卡片用自己原本就有的
  // 雙擊翻面邏輯處理（見 buildStageHtml() 開頭那則關於剪刀手勢的說明）。每個
  // iframe 裡的 INJECTED_SCRIPT（main.js）自己追蹤目前翻到哪一面，只有目標
  // 跟現況不一樣才會真的翻，所以這裡不用管某張卡是不是已經被使用者自己雙擊
  // 過、現在是哪一面，只要單純廣播「現在整組要不要是背面」就好。
  function broadcastFlip(flipped){
    for (var i = 0; i < slotEls.length; i++) {
      var f = slotEls[i].querySelector('iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ __phantomCardFlip: flipped }, '*');
    }
  }

  // 每秒自動翻面循環開關：main.js 按下 AUTOFLIP_KEY 全域快捷鍵時送
  // 'autoflip-toggle' 給 stage 頁面（見下面 window.cardShell.onAutoFlipToggle），
  // 這裡再廣播給每張卡片自己的 iframe，讓 INJECTED_SCRIPT 呼叫該卡片的
  // window.toggleAutoFlip()（所有卡片都有定義這個函式，沒定義的卡片收到
  // 也不會有反應，見 INJECTED_SCRIPT 開頭的說明）。
  // card-fx 指令廣播：cast／rarity 送給每張卡（各自演出、各自切下一階），但只有第一張卡發聲；
  // mute 只送第一張（靜音狀態存在 localStorage，各卡每次發聲前都會重新讀，所以不用逐張切換，
  // 逐張切換反而會因為每張初始狀態不同而錯亂）。
  function broadcastFx(cmd){
    for (var i = 0; i < slotEls.length; i++) {
      if (cmd === 'mute' && i > 0) break;
      var f = slotEls[i].querySelector('iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ __phantomCardFx: cmd, sound: i === 0 }, '*');
    }
  }

  function broadcastAutoFlipToggle(){
    for (var i = 0; i < slotEls.length; i++) {
      var f = slotEls[i].querySelector('iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ __phantomCardAutoFlipToggle: true }, '*');
    }
  }

  // 判斷「布」／「拳頭」／「剪刀」：比較食/中/無名/小指的指尖到手腕距離、跟
  // 同一根手指「第二關節（PIP）」到手腕距離的大小——手指伸直時指尖比 PIP 離
  // 手腕更遠，握拳時指尖會彎回來比 PIP 更靠近手腕。不管手掌朝向、角度怎麼轉
  // 都成立，比單純比較 y 座標（手勢比讚、側翻時會誤判）更穩，不用刻意要求
  // 正對鏡頭。4 指裡 3 根以上伸直算「布」，1 根以下算「拳頭」，剛好食指＋中指
  // 伸直、無名／小指彎曲算「剪刀」，其餘組合（例如中指＋無名指，或只有小指）
  // 算「不明確」不更新——都故意跳過拇指（拇指伸直/彎曲的判斷方式跟其他手指
  // 不一樣，這三種手勢光看其他 4 指就能穩定分辨，不用增加複雜度）。
  function classifyLandmarks(lm){
    function dist(a, b){ var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
    var wrist = lm[0];
    var FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]; // [mcp, pip, tip]：食/中/無名/小指
    var ext = FINGERS.map(function(f){
      var pip = lm[f[1]], tip = lm[f[2]];
      return dist(tip, wrist) > dist(pip, wrist);
    });
    var extendedCount = ext.filter(Boolean).length;
    if (extendedCount >= 3) return 'paper';
    if (extendedCount === 2 && ext[0] && ext[1]) return 'scissors'; // 食指+中指伸直，無名/小指彎曲
    if (extendedCount <= 1) return 'fist';
    return null; // 其餘 2 指組合（不是食指+中指）算過渡動作，不明確
  }

  function handleGestureResults(results){
    var rawLm = results.multiHandLandmarks && results.multiHandLandmarks[0];
    var lm = rawLm ? smoothLandmarks(rawLm) : null;
    if (!rawLm) smoothedLandmarks = null; // 手消失，下次重新出現不要跟舊位置做平滑
    renderSkeletonFrame(lm);
    if (!gestureEnabled) return;
    var raw = lm ? classifyLandmarks(lm) : null;
    if (!raw) {
      candidateGesture = null; candidateCount = 0;
      if (statusEl) statusEl.textContent = lm ? '🤔 手勢不明確' : '🖐 尋找手部中…';
      // 連續幾幀都判斷不到手勢（手離開畫面，或姿勢過渡不明確）：卡片飄回原位，
      // 六卡循環（如果 F8 是開著的）就會從暫停當下的角度接著轉——「布」「拳頭」
      // 「剪刀」都是要手一直維持姿勢才生效的瞬時狀態，不是按一下就固定住的
      // 開關，鬆手/手離開鏡頭視野就該放開接管權，不然循環會永遠卡在暫停。
      noGestureCount++;
      if (noGestureCount >= STABLE_FRAMES_NEEDED && gestureState !== 'base') {
        startGestureTween('base', performance.now());
      }
      return;
    }
    noGestureCount = 0;
    if (raw === candidateGesture) candidateCount++; else { candidateGesture = raw; candidateCount = 1; }
    var label = raw === 'paper' ? '✋ 布' : raw === 'fist' ? '✊ 拳頭' : '✌️ 剪刀';
    if (statusEl) statusEl.textContent = label + '（' + Math.min(candidateCount, STABLE_FRAMES_NEEDED) + '/' + STABLE_FRAMES_NEEDED + '）';
    if (candidateCount >= STABLE_FRAMES_NEEDED && gestureState !== raw) {
      startGestureTween(raw, performance.now());
    }
  }

  // gestureSession：快速連按 GESTURE_KEY 好幾下（開/關/開...）時，前一次
  // enableGestureTracking() 的 getUserMedia() 可能還沒 resolve，下一次又呼叫
  // 了一次——只靠 gestureEnabled 是否為 false 判斷「使用者是不是已經關掉了」
  // 不夠，因為開/關/開 三次之後 gestureEnabled 又變回 true，會讓那個「其實已經過期」的
  // 舊 getUserMedia 結果誤以為自己還有效，蓋掉新的 gestureStream，導致舊的那
  // 條攝影機串流/輪詢迴圈永遠沒被 stop()，變成攝影機一直亮著也關不掉。每次
  // enable/disable 都把 gestureSession 加一，getUserMedia 的 callback 只認自己
  // 出發當下記住的那個編號，編號對不上就直接把拿到的 stream 關掉，不去動任何
  // 共用狀態。
  var gestureSession = 0;

  // 建立 Hands 實例本身不會碰攝影機（不會跳權限提示、鏡頭燈也不會亮)，只是
  // 讓 @mediapipe/hands 去下載＋編譯 wasm／模型檔案，可以提早做。晚做的話，
  // 這些檔案就會拖到「使用者剛按下 GESTURE_KEY」那一刻才去抓，跟 getUserMedia
  // 的攝影機啟動搶頻寬/主執行緒，是第一次按 F7 明顯卡頓的主因。獨立成這個函式
  // 讓 enableGestureTracking() 跟下面的預熱呼叫共用，用 handsReadyPromise 記住
  // 「是不是已經在載入/載入完了」，不會因為連按兩次而重複建立、重複下載。
  function ensureHandsInstance(){
    if (!handsReadyPromise) {
      handsInstance = new Hands({ locateFile: function(file){ return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file; } });
      handsInstance.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
      handsInstance.onResults(handleGestureResults);
      handsReadyPromise = handsInstance.initialize()
        .then(function(){
          // initialize() 只保證 wasm／模型檔案下載＋編譯完成，不代表跑起來
          // 快——WASM 常見的「第一次真正呼叫還要另外做一輪 JIT/SIMD 熱路徑
          // 編譯，之後才會變快」，這跟前面的檔案下載是兩個不同的成本，實測
          // 下來就是使用者按下 F7、鏡頭第一幀送進來時還會感覺到的那一瞬間
          // 卡頓。這裡趁預熱時機，先送一張空白畫布跑一次完整推論把這筆成本
          // 一併付掉（gestureEnabled 這時還是 false，handleGestureResults()
          // 開頭就會提早 return，不會誤更新狀態文字、不會畫骨架、更不會誤
          // 觸發任何手勢），使用者真的按下 F7 時，wasm 熱路徑早就編譯過了。
          var warmupCanvas = document.createElement('canvas');
          warmupCanvas.width = 640; warmupCanvas.height = 480;
          var wctx = warmupCanvas.getContext('2d');
          wctx.fillStyle = '#000'; wctx.fillRect(0, 0, warmupCanvas.width, warmupCanvas.height);
          return handsInstance.send({ image: warmupCanvas });
        })
        .catch(function(err){
          console.warn('[gesture] 手勢模型預先載入失敗，等實際開攝影機時會再重試：', err);
          handsReadyPromise = null; // 讓下一次 enableGestureTracking() 有機會重新嘗試，而不是永遠卡在失敗的 promise
        });
    }
    return handsReadyPromise;
  }

  function enableGestureTracking(){
    var mySession = ++gestureSession;
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = '🎥 啟動攝影機中…'; }
    var handsReady = ensureHandsInstance();
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }).then(function(stream){
      if (mySession !== gestureSession) { stream.getTracks().forEach(function(t){ t.stop(); }); return; } // 這次 enable 期間又被開關過，這個結果已經過期
      gestureStream = stream;
      videoEl.srcObject = stream;
      videoEl.onloadeddata = function(){
        function loop(){
          if (mySession !== gestureSession) return;
          handsInstance.send({ image: videoEl }).then(function(){ gestureRafId = requestAnimationFrame(loop); });
        }
        // 攝影機串流通常比背景預熱的 wasm/模型下載晚就緒（開背景預熱的時間點
        // 更早），這裡再等一次 handsReady 只是保險——多數情況下它早就 resolve
        // 過了，不會多等；真的還沒載完（例如網路很慢）才會在這裡多卡一下，
        // 而不是讓 handsInstance.send() 在還沒初始化好時噴錯。
        Promise.resolve(handsReady).then(function(){
          if (mySession !== gestureSession) return;
          loop();
        });
      };
    }).catch(function(err){
      console.warn('[gesture] 攝影機啟動失敗：', err);
      if (mySession === gestureSession && statusEl) statusEl.textContent = '⚠️ 無法開啟攝影機（權限被拒或沒有攝影機）';
      if (mySession === gestureSession && window.cardShell && window.cardShell.reportToggle) window.cardShell.reportToggle('gesture', false, 'camera');
    });
  }

  function disableGestureTracking(){
    gestureSession++; // 讓所有還沒 resolve 的舊 enable 呼叫全部失效
    if (statusEl) statusEl.style.display = 'none';
    candidateGesture = null; candidateCount = 0; noGestureCount = 0;
    if (gestureRafId) cancelAnimationFrame(gestureRafId);
    gestureRafId = null;
    if (gestureStream) { gestureStream.getTracks().forEach(function(t){ t.stop(); }); gestureStream = null; }
    videoEl.srcObject = null;
    skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  }

  function tick(ts){
    // 只有「手勢已經判斷成功、正在接管卡片位置」（gestureState 不是 'base'）
    // 或還在飄回 base 的補間途中，才略過六卡循環——單純攝影機開著在看
    // （gestureEnabled）但還沒判斷出任何手勢時，完全不影響循環，這是這裡跟
    // 舊版「一開手勢偵測就整個暫停循環」最主要的差別。
    var gestureActive = gestureState !== 'base' || gestureTweenStartTs !== null;
    if (gestureActive) {
      if (gestureTweenStartTs !== null) {
        var gp = Math.min(1, (ts - gestureTweenStartTs) / GESTURE.transitionMs);
        var ge = easeOutCubic(gp);
        for (var gi = 0; gi < slotEls.length; gi++) {
          var gt = gestureTargets[gi];
          slotEls[gi].style.left = (gestureTweenFrom[gi].left + (gt.left - gestureTweenFrom[gi].left) * ge) + 'px';
          slotEls[gi].style.top = (gestureTweenFrom[gi].top + (gt.top - gestureTweenFrom[gi].top) * ge) + 'px';
        }
        if (gp >= 1) gestureTweenStartTs = null;
      }
      requestAnimationFrame(tick);
      return;
    }
    if (!CYCLE || !cycleRunning) { lastFrameTs = null; requestAnimationFrame(tick); return; }
    if (tweenStartTs !== null) {
      var tp = Math.min(1, (ts - tweenStartTs) / TWEEN_MS);
      var e = easeOutCubic(tp);
      for (var i = 0; i < slotEls.length; i++) {
        var target = cyclePointFor(i, globalAngleDeg);
        slotEls[i].style.left = (tweenFrom[i].left + (target.left - tweenFrom[i].left) * e) + 'px';
        slotEls[i].style.top = (tweenFrom[i].top + (target.top - tweenFrom[i].top) * e) + 'px';
        applyCycleDepth(i, globalAngleDeg);
      }
      if (tp >= 1) { tweenStartTs = null; lastFrameTs = ts; }
    } else {
      if (lastFrameTs !== null) {
        var dtMs = ts - lastFrameTs;
        globalAngleDeg = (globalAngleDeg + (360 * dtMs / CYCLE.periodMs)) % 360;
      }
      lastFrameTs = ts;
      applyCyclePositions(globalAngleDeg);
    }
    requestAnimationFrame(tick);
  }
  // 只要格位裡至少有一張卡就啟動這個迴圈（不像以前只在 CYCLE 存在時才跑）——
  // 手勢功能任何張數的多卡合一都適用，tick() 本身在兩種功能都沒啟用時幾乎不做
  // 事，一直跑著也不會有感的效能負擔。
  requestAnimationFrame(tick);

  // 時鐘循環開關：main.js 按下 CYCLE_KEY 全域快捷鍵時送這個事件過來，同一個鍵
  // 開/關切換。只有 3 張以上的多卡合一（CYCLE 非 null）才會用到；開／關之後
  // 用 reportCycle() 回報實際狀態，main.js 據此顯示畫面提示。
  if (CYCLE && window.cardShell && window.cardShell.onCycleToggle) {
    window.cardShell.onCycleToggle(function(){
      cycleRunning = !cycleRunning;
      if (cycleRunning) startTween(performance.now());
      if (window.cardShell.reportCycle) window.cardShell.reportCycle(cycleRunning, '');
    });
  }

  // 手勢散開/收縮開關：main.js 按下 GESTURE_KEY 全域快捷鍵時送這個事件過來，
  // 同一個鍵開/關切換。開啟只是打開攝影機開始「看」，不會動到六卡循環——真正
  // 判斷出「布」或「拳頭」的那一刻才會接管卡片位置、暫停循環的時鐘（見
  // startGestureTween()／tick() 的 gestureActive 判斷式），兩個功能才不會一
  // 開手勢偵測就互搶。關閉手勢偵測時讓卡片飄回（循環有在轉就飄回循環目前的
  // 角度，沒在轉才回原始格位座標）並釋放攝影機。
  if (GESTURE) {
    // 背景預熱：頁面載入後找個空檔（瀏覽器閒置時，最多等 2 秒）就先把
    // ensureHandsInstance() 呼叫一次，讓 wasm/模型檔案提早下載＋編譯完，
    // 不用等到使用者真的按下 GESTURE_KEY 才開始——這步驟完全不會碰攝影機，
    // 不會跳權限提示也不會點亮鏡頭燈，只是先把之後會用到的資源準備好，
    // 消除第一次按 F7 時的卡頓感。
    var warmupHands = function(){ ensureHandsInstance(); };
    if (window.requestIdleCallback) requestIdleCallback(warmupHands, { timeout: 2000 });
    else setTimeout(warmupHands, 300);
  }
  if (GESTURE && window.cardShell && window.cardShell.onGestureToggle) {
    window.cardShell.onGestureToggle(function(){
      gestureEnabled = !gestureEnabled;
      if (gestureEnabled) {
        enableGestureTracking();
      } else {
        disableGestureTracking();
        startGestureTween('base', performance.now());
      }
      if (window.cardShell.reportToggle) window.cardShell.reportToggle('gesture', gestureEnabled, '');
    });
  }

  // 手部骨架視覺效果開關：系統匣選單切換，跟 GESTURE_KEY／CYCLE_KEY 一樣同一個
  // 項目開/關切換。只是「畫不畫得出來」的顯示層開關，不重新啟動攝影機、不影響
  // 手勢辨識，見上面 renderSkeletonFrame() 的說明。關閉當下順手把畫布清掉，
  // 不然殘留的骨架會停在畫面上不動，直到下一次有新的偵測結果才會被蓋掉。
  if (GESTURE && window.cardShell && window.cardShell.onSkeletonToggle) {
    window.cardShell.onSkeletonToggle(function(){
      SHOW_SKELETON = !SHOW_SKELETON;
      if (!SHOW_SKELETON) skeletonCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
      if (window.cardShell.reportToggle) window.cardShell.reportToggle('skeleton', SHOW_SKELETON, '');
    });
  }

  // 每秒自動翻面循環：跟 cycleKey/gestureKey 不同，任何張數的多卡合一都可以用
  // （不限定六卡、不限定卡片有沒有支援——沒支援的卡片收到訊息也只是沒反應），
  // 所以這裡不像上面兩段包在 CYCLE/GESTURE 判斷式裡。
  if (window.cardShell && window.cardShell.onAutoFlipToggle) {
    window.cardShell.onAutoFlipToggle(function(){
      broadcastAutoFlipToggle();
    });
  }
  if (window.cardShell && window.cardShell.onFxCommand) {
    window.cardShell.onFxCommand(function(cmd){ broadcastFx(cmd); });
  }

  // 點擊穿透模式下的全域滑鼠追蹤（多卡模式）：main.js 送來相對整個視窗的游標座標
  // （離開追蹤時是 null），這裡依每個 iframe 目前的位置換算成 iframe 內座標，
  // 再 postMessage 給各卡片裡的 INJECTED_SCRIPT 翻譯成 pointermove/pointerleave。
  if (window.cardShell && window.cardShell.onCursor) {
    window.cardShell.onCursor(function(p){
      for (var i = 0; i < slotEls.length; i++) {
        var f = slotEls[i].querySelector('iframe');
        if (!f || !f.contentWindow) continue;
        var r = f.getBoundingClientRect();
        f.contentWindow.postMessage({ __phantomCursor: true, p: p ? { x: p.x - r.left, y: p.y - r.top } : null }, '*');
      }
    });
  }

  // 縮放／透明度（多卡）：每一格各自的 zoom/opacity 存在格位元素的 data-*，調整時依中心改格位大小、
  // 通知 iframe 更新 CSS 變數、存檔。滾輪來自各卡片 iframe（只調那一格），快捷鍵/系統匣調全部。
  var CARD_SCALE_V = ${CARD_SCALE};
  var ZOOM_MIN = ${ZOOM_MIN}, ZOOM_MAX = ${ZOOM_MAX}, OPACITY_MIN = ${OPACITY_MIN};
  function clampV(v, a, b){ return v < a ? a : (v > b ? b : v); }
  function nextView(cur, kind, dir, big, defZoom){
    if (kind === 'reset') return { zoom: defZoom || 1, opacity: 1 };
    if (kind === 'zoom') return { zoom: clampV(cur.zoom * Math.pow(big ? 1.1 : 1.05, dir), ZOOM_MIN, ZOOM_MAX), opacity: cur.opacity };
    return { zoom: cur.zoom, opacity: clampV(Math.round((cur.opacity + dir * (big ? 0.1 : 0.05)) * 100) / 100, OPACITY_MIN, 1) };
  }
  function applySlotView(i, v){
    var el = slotEls[i];
    var bw = parseFloat(el.dataset.basew), bh = parseFloat(el.dataset.baseh);
    var ow = parseFloat(el.style.width), oh = parseFloat(el.style.height);
    var nw = Math.round(bw * v.zoom), nh = Math.round(bh * v.zoom);
    var left = (parseFloat(el.style.left) || 0) + (ow - nw) / 2;
    var top = (parseFloat(el.style.top) || 0) + (oh - nh) / 2;
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.width = nw + 'px'; el.style.height = nh + 'px';
    el.dataset.zoom = v.zoom; el.dataset.opacity = v.opacity;
    var f = el.querySelector('iframe');
    if (f && f.contentWindow) f.contentWindow.postMessage({ __phantomCardViewSet: { scale: CARD_SCALE_V * v.zoom, opacity: v.opacity } }, '*');
    if (window.cardShell) {
      // 時鐘循環／手勢接管位置時，現在的座標不是使用者排的位置，只存縮放/透明度（main.js 會依中心補償）
      var moving = cycleRunning || gestureState !== 'base';
      window.cardShell.saveSlot(i, moving ? null : left, moving ? null : top, { zoom: v.zoom, opacity: v.opacity });
    }
  }
  function viewStep(i, kind, dir, big){
    var el = slotEls[i];
    var cur = { zoom: parseFloat(el.dataset.zoom) || 1, opacity: el.dataset.opacity == null ? 1 : parseFloat(el.dataset.opacity) };
    applySlotView(i, nextView(cur, kind, dir, big, parseFloat(el.dataset.defzoom) || 1));
  }
  window.addEventListener('message', function(e){
    var d = e.data && e.data.__phantomCardViewBy;
    if (!d) return;
    for (var i = 0; i < slotEls.length; i++) {
      var f = slotEls[i].querySelector('iframe');
      if (f && f.contentWindow === e.source) { viewStep(i, d.kind, d.dir < 0 ? -1 : 1, !!d.big); break; }
    }
  });
  if (window.cardShell && window.cardShell.onViewCommand) {
    window.cardShell.onViewCommand(function(cmd){
      var kind = cmd === 'reset' ? 'reset' : (cmd.indexOf('zoom') === 0 ? 'zoom' : 'opacity');
      var dir = /-(in|up)$/.test(cmd) ? 1 : -1;
      for (var i = 0; i < slotEls.length; i++) viewStep(i, kind, dir, true);
    });
  }

  window.addEventListener('message', function(e){
    if (!e.data || !e.data.__phantomCardMove) return;
    // 只要偵測到任何一格在被手動拖曳，整個循環立刻暫停（維持使用者手動排好的
    // 位置，不會轉幾秒後又把它挪走），要再按一次 CYCLE_KEY 才會恢復轉動——
    // 恢復時會用上面的補間滑回橢圓路徑（角度沿用暫停當下的 globalAngle），
    // 不是接續使用者拖曳出來的位置。
    if (CYCLE) {
      var wasCycling = cycleRunning;
      cycleRunning = false; tweenStartTs = null;
      if (wasCycling && window.cardShell && window.cardShell.reportCycle) window.cardShell.reportCycle(false, 'drag'); // 只有「正在轉」時被拖曳才提示（連續拖曳只會提示第一次）
    }
    for (var i = 0; i < slotEls.length; i++) {
      var f = slotEls[i].querySelector('iframe');
      if (f && f.contentWindow === e.source) {
        var left = (parseFloat(slotEls[i].style.left) || 0) + e.data.dx;
        var top = (parseFloat(slotEls[i].style.top) || 0) + e.data.dy;
        slotEls[i].style.left = left + 'px';
        slotEls[i].style.top = top + 'px';
        if (window.cardShell) window.cardShell.saveSlot(i, left, top);
        break;
      }
    }
  });
})();
</script>
</body>
</html>`;
}

// 把設定的格位（x,y,可選 w,h）＋每格的執行期縮放/透明度合成 buildStageHtml／computeCycleConfig 用的
// 卡片清單：w/h 是「縮放後」的大小，baseW/baseH 是縮放前（stage 頁面調整縮放時要用）。
// yml 裡 cards[i].zoom（GUI 的「縮放 %」÷100）→ 這張卡的預設格位。x,y 是 zoom=1 時的格位左上角，
// 以格位中心縮放，所以左上角要補償半個「縮小/放大的差」，中心點不動（跟執行期滾輪縮放的補償同一個算法）。
function defaultSlotFor(c) {
  const z = clampZoom(c.zoom);
  const bw = c.w || WIN_W;
  const bh = c.h || WIN_H;
  return { x: c.x + (bw * (1 - z)) / 2, y: c.y + (bh * (1 - z)) / 2, zoom: z, opacity: 1 };
}

function effectiveCardsFrom(cards, slots) {
  return cards.map((c, i) => {
    const sl = slots[i];
    const bw = c.w || WIN_W;
    const bh = c.h || WIN_H;
    return Object.assign({}, c, {
      x: sl.x, y: sl.y, zoom: sl.zoom, opacity: sl.opacity,
      defZoom: clampZoom(c.zoom), // 這張卡在 yml 裡設定的預設縮放（重設時回到這個值）
      baseW: bw, baseH: bh, w: Math.round(bw * sl.zoom), h: Math.round(bh * sl.zoom),
    });
  });
}

function createMultiWindow(cards) {
  const savedSlots = loadJson(SLOTS_FILE);
  currentSlots = cards.map((c, i) => {
    const s = savedSlots && savedSlots[i];
    const d = defaultSlotFor(c); // 沒存過就用 yml 設定的位置＋這張卡自己的預設縮放
    return {
      x: s && typeof s.x === 'number' ? s.x : d.x,
      y: s && typeof s.y === 'number' ? s.y : d.y,
      zoom: s && typeof s.zoom === 'number' ? clampZoom(s.zoom) : d.zoom,
      opacity: clampOpacity(s && s.opacity),
    };
  });
  const effectiveCards = effectiveCardsFrom(cards, currentSlots);

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    // 刻意留在工作列，理由跟單卡模式的 createSingleWindow() 完全一樣：這個
    // 視窗沒有標題列、快捷鍵可能因為跟其他掛件搶鍵而失效，留在工作列讓使用者
    // 能靠工作列圖示右鍵「關閉視窗」保底關掉它，不依賴任何全域快捷鍵。
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      backgroundThrottling: false,
      // card-fx 的 WebAudio 音效由全域快捷鍵/系統匣觸發，頁面沒有使用者手勢；預設的
      // autoplay 政策會讓 AudioContext 卡在 suspended 而完全沒聲音。
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // preload 預設只套用到最上層 frame，多卡模式的卡片是跑在 iframe 裡，
      // 沒有這個選項的話 iframe 裡的 window.cardShell 會是 undefined、
      // 右鍵拖曳完全沒反應（卡片自己的 hover 旋轉效果不受影響，因為那是卡片
      // html 自己的 <script>，不需要 preload）。
      nodeIntegrationInSubFrames: true,
    },
  });

  startKeepOnTop();

  // 卡片本身的 CSS 已經有 `@media (prefers-reduced-motion: reduce)`，會關掉
  // 金屬外框的 sheen 動畫、粒子飄浮動畫，連 JS 的閒置自動旋轉迴圈也會跟著停
  // （見卡片 html 裡 reduce 那個變數）——這是卡片原本就設計好的效能開關，只是
  // 平常沒人開「減少動態效果」。多卡模式一次疊 5~10 張都在跑這些動畫＋
  // 模糊/陰影濾鏡，GPU 負擔會疊加到肉眼可見的卡頓，用 CDP 幫這個視窗強制模擬
  // 「使用者開了減少動態效果」，比自己重新刻一套停用動畫的邏輯更不會踩到
  // 卡片以後改版的雷。單卡模式只有一張卡、動畫成本可以接受，不套用這個。
  try {
    win.webContents.debugger.attach();
    win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    }).catch((err) => console.warn(`${LOG_TAG} 減少動態效果模擬設定失敗：`, err));
  } catch (err) {
    console.warn(`${LOG_TAG} debugger attach 失敗，跳過減少動態效果模擬：`, err);
  }

  const stagePath = path.join(app.getPath('userData'), 'stage.generated.html');
  fs.writeFileSync(stagePath, buildStageHtml(effectiveCards, computeCycleConfig(effectiveCards), computeGestureLayout(effectiveCards)));
  win.loadFile(stagePath);

  win.webContents.on('did-finish-load', () => {
    autoFlipOn = false;
    win.webContents.insertCSS(TRANSPARENT_CSS);
  });

  // did-frame-finish-load 對每個 frame（含所有 iframe）都會觸發一次，isMainFrame
  // 為 false 時才是卡片自己的 iframe——用 webFrameMain 直接對那個 frame 注入，
  // 不受同源限制（這是 Electron host 端的能力，不是網頁互相存取），所以卡片
  // 用 file:// 載入也完全不受影響。
  win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame) return;
    frame.executeJavaScript(TRANSPARENT_CSS_JS).catch(() => {});
    frame.executeJavaScript(INJECTED_SCRIPT).catch(() => {});
  });

  win.setIgnoreMouseEvents(clickThrough, { forward: true });
}

// ==================== 重設卡片位置 ====================
// 右鍵拖曳搬動過的位置會存檔、跨重開機記住（見 POSITION_FILE／SLOTS_FILE），
// 但一直沒有「復原成初始設定」的入口，只能自己去 userData 資料夾手動刪檔
// （見 桌面掛件說明.md〈疑難排解〉）。這裡補一個系統匣選單項目做同一件事，
// 不用再開檔案總管找路徑。
// 單卡模式：直接把視窗搬回「螢幕正中央 + defaultOffset」，跟第一次啟動、
// 還沒被拖過時的邏輯完全一樣（見 createSingleWindow()）；setPosition 觸發的
// 'moved' 事件會自動把這個新位置存回 POSITION_FILE，不用另外處理存檔。
// 多卡模式：把每張卡的位置改回 cards[].x/y 這組打包時定案的預設格位，刪掉
// SLOTS_FILE，並整個 reload 這個視窗——F7/F8 的開關狀態、翻面狀態也會一起
// 回到剛啟動的樣子，這是「重設」的合理預期，不特地保留。
function resetCardPositions() {
  if (!win || win.isDestroyed()) return;
  const isMulti = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  if (isMulti) {
    try { fs.unlinkSync(SLOTS_FILE); } catch (e) { /* 本來就沒存過，沒差 */ }
    currentSlots = MULTI_CARDS.map((c) => defaultSlotFor(c)); // 回到 yml 設定的位置與每張卡自己的預設縮放
    const effectiveCards = effectiveCardsFrom(MULTI_CARDS, currentSlots);
    const stagePath = path.join(app.getPath('userData'), 'stage.generated.html');
    fs.writeFileSync(stagePath, buildStageHtml(effectiveCards, computeCycleConfig(effectiveCards), computeGestureLayout(effectiveCards)));
    win.loadFile(stagePath);
  } else {
    setSingleView({ zoom: 1, opacity: 1 }); // 縮放與透明度一併重設（依中心縮回，下面再搬到螢幕正中央）
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    win.setPosition(
      Math.round((sw - WIN_W) / 2) + DEFAULT_OFFSET.x,
      Math.round((sh - WIN_H) / 2) + DEFAULT_OFFSET.y
    );
  }
}

// 多卡模式每張卡是獨立的 iframe 文件，insertCSS() 是 webContents 的方法、對
// iframe 沒用，所以這裡改用純 DOM 操作插入一個 <style> 標籤，效果等同單卡
// 模式的 TRANSPARENT_CSS（insertCSS）——不需要 require('electron')／Node
// 權限，單純的頁面 JS 就能做到，跟卡片本身 contextIsolation:true 的安全設定
// 完全不衝突。CARD_SCALE_CSS 的內容跟單卡模式那份完全一樣（同一個 CARD_SCALE
// 常數），確保兩種模式縮放出來的視覺比例一致。
const TRANSPARENT_CSS_JS = `
(function(){
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  document.body.style.overflow = 'visible';
  var s = document.createElement('style');
  s.textContent = ${JSON.stringify(CARD_SCALE_CSS)};
  document.head.appendChild(s);
})();
`;

// x/y 為 null＝只更新縮放/透明度（例如時鐘循環或手勢正在接管位置時，stage 頁面現在的座標不是
// 使用者排的位置，不能存）；縮放變了就依中心補償 x/y，重開機時卡片中心才不會位移。
ipcMain.on('card-slot-save', (_event, idx, x, y, v) => {
  const s = currentSlots && currentSlots[idx];
  if (!s) return;
  const oldZoom = s.zoom;
  if (v && typeof v === 'object') {
    s.zoom = clampZoom(v.zoom);
    s.opacity = clampOpacity(v.opacity);
  }
  if (typeof x === 'number' && typeof y === 'number') {
    s.x = x;
    s.y = y;
  } else if (s.zoom !== oldZoom) {
    const c = MULTI_CARDS[idx] || {};
    s.x += ((c.w || WIN_W) * (oldZoom - s.zoom)) / 2;
    s.y += ((c.h || WIN_H) * (oldZoom - s.zoom)) / 2;
  }
  scheduleSlotsSave();
});

// ==================== 共用 ====================
function startKeepOnTop() {
  // 建構子的 alwaysOnTop:true 只給預設置頂等級，Windows 不保證會蓋過使用者
  // 點擊的其他一般視窗。用 'screen-saver'（Electron 支援的最高置頂等級）
  // 確保卡片永遠留在最上層。
  win.setAlwaysOnTop(true, 'screen-saver');
  // ⚠️ 同時開兩個（或更多）這個外殼包出來的 exe 時，每個 process 都各自跑
  // 這個計時器，彼此獨立、完全不知道對方存在——setAlwaysOnTop()／moveTop()
  // 不只是「確保置頂」，底層 Windows API 每次呼叫都會把這個視窗重新推到
  // 「screen-saver 這個置頂層級」的最前面。兩個視窗都在搶同一個置頂層級的
  // 最前面，原本 1 秒一次、彼此沒對過時間的計時器幾乎一定會撞在差不多的節奏
  // 上，變成每秒輪流把對方擠到後面再擠回來——這就是「先開的那張卡片會一閃
  // 一閃」的成因，不是渲染或卡片本身的問題，是兩個視窗的置頂計時器互相打架。
  // 這裡刻意拉長基準間隔（原本 1 秒）並加上隨機抖動——這個計時器本來就只是
  // 防禦性的「定期重新確認置頂」（正常情況下 alwaysOnTop 設定不會自己掉），
  // 不需要頻繁到每秒都重新搶一次，拉長＋加抖動讓多個視窗的重新搶佔時間點
  // 錯開，大幅降低撞在一起、視覺上閃爍的機率，重新確認置頂的「自我修復」
  // 能力還在，只是變成每隔幾秒才確認一次，使用者感覺不出差別。
  function scheduleReassert() {
    const jitterMs = Math.floor(Math.random() * 4000); // 0~4 秒隨機抖動
    return setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible() || trayMenuOpen) { keepOnTopTimer = scheduleReassert(); return; }
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
      keepOnTopTimer = scheduleReassert();
    }, 6000 + jitterMs); // 基準 6 秒 + 抖動，平均約每 8 秒重新確認一次
  }
  let keepOnTopTimer = scheduleReassert();
  win.on('closed', () => clearTimeout(keepOnTopTimer));
}

// ==================== 穿透模式下的全域滑鼠追蹤 ====================
// 點擊穿透（setIgnoreMouseEvents）時，視窗收不到（或只收得到不穩定的）滑鼠事件，
// 卡片的 hover 傾斜／全息流光就整個靜止了。這裡在「穿透模式」期間用
// screen.getCursorScreenPoint() 輪詢整台電腦的游標位置（不需要任何輸入鉤子、
// 不讀鍵盤，只讀座標），換算成相對視窗內容區左上角的座標送 'cursor-pos'，由
// INJECTED_SCRIPT 的 applyCursor() 翻譯成卡片原本就在聽的 pointermove/
// pointerleave（見那段的說明）。互動模式下滑鼠事件是真的打進視窗，不需要輪詢，
// 所以只在穿透時才開計時器。游標沒動就不送，閒置時幾乎零成本。
const CURSOR_POLL_MS = 33;
let cursorTimer = null;
let lastCursor = null;

function startCursorTracking() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (lastCursor && lastCursor.x === p.x && lastCursor.y === p.y) return;
    lastCursor = p;
    const b = win.getContentBounds();
    win.webContents.send('cursor-pos', { x: p.x - b.x, y: p.y - b.y });
  }, CURSOR_POLL_MS);
}

function stopCursorTracking() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  lastCursor = null;
  // 切回互動模式：通知卡片「游標離開了」，之後由真正的滑鼠事件接手。
  if (win && !win.isDestroyed()) win.webContents.send('cursor-pos', null);
}

function setClickThrough(value) {
  clickThrough = value;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  if (clickThrough) startCursorTracking(); else stopCursorTracking();
  console.log(`${LOG_TAG} 目前狀態：${clickThrough ? '穿透模式（滑鼠會穿透到桌面）' : '互動模式（滑鼠移到卡片上旋轉、按住右鍵拖曳移動位置）'}`);
  showPill(clickThrough ? `👻 點擊穿透：已開啟\n滑鼠會穿過卡片，${TOGGLE_KEY} 切回互動` : `🖱️ 互動模式：已開啟\n可旋轉、拖曳卡片，${TOGGLE_KEY} 切成穿透`, clickThrough ? '#38bdf8' : '#4ade80');
  updateTrayMenu();
}

function toggleSkeleton() {
  if (win && !win.isDestroyed()) win.webContents.send('skeleton-toggle');
}

// 系統匣選單、全域快捷鍵（F11/resetKey）共用同一個確認流程——即使是按快捷鍵
// 觸發，也維持跳確認視窗，不要讓一個手滑按鍵就無聲清掉手動排過的位置。
function confirmResetCardPositions() {
  if (!win || win.isDestroyed()) return;
  const isMulti = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  const response = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: ['取消', '重設'],
    defaultId: 0,
    cancelId: 0,
    title: '重設卡片位置',
    message: isMulti
      ? `把所有卡片搬回打包時定案的預設格位？這會清掉你手動拖曳排過的位置與各卡的縮放/透明度，且會重新整理視窗（${GESTURE_KEY}/${CYCLE_KEY} 的開關狀態會一起回到剛啟動的樣子）。`
      : '把卡片搬回螢幕正中央的預設位置？這會清掉你手動拖曳過的位置，縮放與透明度也會一併重設。',
  });
  if (response === 1) resetCardPositions();
}

// ==================== 開機自動啟動 ====================
// 寫進 HKCU\...\CurrentVersion\Run（不需要系統管理員權限）。登錄值名稱用 pkg.name
// （每個 build/*.yml 的 extraMetadata.name 都不同），同時裝好幾個掛件 exe 時各自
// 一筆、不會互相覆蓋；未打包（npm start）時加 -dev 後綴，避免開發測試時的
// electron.exe 蓋掉正式 exe 的那一筆。
// ⚠️ portable 版的 process.execPath 是每次啟動時解壓到暫存資料夾的那份，下次
// 開機早就不存在了，必須改記 electron-builder 的 portable 啟動器提供的
// PORTABLE_EXECUTABLE_FILE（使用者實際雙擊的那個 exe）。
// ⚠️ 啟動參數裡的路徑要用正斜線：Electron 把 args 寫進登錄、讀回時會吃掉反斜線。
// ⚠️ 用 getLoginItemSettings().launchItems 依名稱判斷有沒有開，而不是它回傳的
// openAtLogin——後者會拿 path/args 逐字比對，稍有格式差異就誤報 false。
function loginItemOptions() {
  const name = app.isPackaged ? pkg.name : `${pkg.name}-dev`;
  if (app.isPackaged) {
    return { name, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] };
  }
  return { name, path: process.execPath, args: [app.getAppPath().replace(/\\/g, '/')] };
}

function isLaunchAtLoginEnabled() {
  try {
    const o = loginItemOptions();
    const items = app.getLoginItemSettings({ path: o.path, args: o.args }).launchItems || [];
    return items.some((i) => i.name === o.name && i.enabled);
  } catch (e) {
    return false;
  }
}

function saveSettings(patch) {
  try {
    const cur = loadJson(SETTINGS_FILE) || {};
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.assign(cur, patch)));
  } catch (e) {
    console.warn(`${LOG_TAG} 存檔設定失敗：`, e);
  }
}

function setLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings(Object.assign({ openAtLogin: !!enabled }, loginItemOptions()));
  } catch (e) {
    console.warn(`${LOG_TAG} 設定開機自動啟動失敗：`, e);
  }
  saveSettings({ launchAtLogin: !!enabled });
  console.log(`${LOG_TAG} 開機自動啟動：${isLaunchAtLoginEnabled() ? '已開啟' : '已關閉'}`);
  updateTrayMenu();
}

// ==================== 系統匣圖示（保證關得掉） ====================
// 背景：F9/F10 這類全域快捷鍵是整個作業系統共用的資源，同一個按鍵同時只能被
// 一個程式搶到（見 桌面掛件說明.md 的踩雷紀錄）。使用者如果同時開好幾個卡片
// 掛件的 exe，沒有特地在 builder-gui 裡把每個 exe 的 toggleKey/quitKey 改成不
// 同的鍵，後面開的那幾個 exe 快捷鍵會註冊失敗（下面 okToggle/okQuit 是
// false）。這些視窗本身無邊框，沒有原生標題列可以按 X——雖然現在
// skipTaskbar 已經是 false（留在工作列，右鍵可以「關閉視窗」，見
// createSingleWindow()／createMultiWindow() 的說明），系統匣圖示還是留著當第
// 二層保底：工作列項目理論上也可能被使用者不小心設定隱藏、或某些環境的工作
// 列右鍵選單被系統管理原則鎖住，系統匣圖示不依賴任何可能被搶走或關閉的資源，
// 兩個入口一起才真的保證關得掉。
let tray = null;
// 系統匣選單目前是不是開著：startKeepOnTop() 每 6～10 秒會重新搶佔置頂（setAlwaysOnTop＋moveTop），會把掛件視窗
// 拉到「置頂層級的最前面」——正好蓋過使用者正在看的系統匣選單（實測重現：選單開約 17 秒後，卡片畫在選單上面、
// 擋住選單左半邊）。所以選單開著（menu-will-show → menu-will-close）期間暫停重新搶佔；也不重建選單（匯出進度每 10%
// 會重建一次選單，重建會蓋掉使用者正在看的那份），關掉後再補建。60 秒保險：萬一收不到 close 事件，旗標會自己解除。
let trayMenuOpen = false;
let trayMenuRebuildPending = false;
let trayMenuGuardTimer = null;

// ==================== 匯出分享 ====================
let lastExportPath = null;
let exportProgress = null;   // { label, frac }：目前匯出的進度（再按一次快捷鍵時，提示「還沒結束」要帶上進度）
let exportStatusLine = null; // 系統匣選單最上方的「匯出中 43%」那一行；沒在匯出時是 null

function exportCardList() {
  return Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0 ? MULTI_CARDS : [{ file: CARD_FILE }];
}

function cardDisplayName(file) {
  return path.basename(file, '.html').replace(/[_-]?(phantom_card|幻影卡)$/i, '') || path.basename(file);
}

function notify(title, content) {
  console.log(`${LOG_TAG} ${title}：${content}`);
  if (tray && !tray.isDestroyed()) {
    try { tray.displayBalloon({ title, content, iconType: 'info', noSound: true }); } catch (e) { /* 非 Windows 或被系統關掉通知 */ }
  }
}

// 狀態面板（畫面內）：匯出的進度／結果不能只靠系統匣通知——Windows 的通知設定（專注輔助、沒註冊的應用程式…）
// 常常把它整個吞掉，使用者按了快捷鍵看不到任何反應，就以為沒在匯出、或不知道有沒有完成。
// 面板畫在桌面掛件自己的視窗裡（單卡＝卡片頁面、多卡＝stage 頁面），置頂、pointer-events:none 不擋滑鼠，
// 顯示在「被匯出的那張卡」的正中央（多卡用該格位的中心；單卡就是視窗中心＝卡片中心）：
//   進行中（藍）：標題＋進度條＋「錄製 32/75 · 43%」；完成（綠）：存到哪個資料夾；失敗（紅）：原因；提示（黃）。
// spec：字串（＝黃色提示）或 { state, title, sub, frac, note, idx, holdMs }；holdMs=0 表示一直顯示到下次更新。
const STATUS_COLORS = { progress: '#38bdf8', done: '#4ade80', error: '#ff6b6b', info: '#ffd166' };
function showToast(spec, holdMs) {
  if (!win || win.isDestroyed()) return;
  const o = typeof spec === 'string' ? { state: 'info', title: spec, holdMs } : Object.assign({}, spec);
  o.color = STATUS_COLORS[o.state] || STATUS_COLORS.info;
  const js = `(function(o){
    var d = document;
    var now = Date.now();
    // 「提示」類面板（例如「上一個匯出還沒結束」）要停留一下：期間進度更新（每 200ms 一次）不能去蓋掉它，
    // 否則只會閃一下、使用者根本看不到；完成／失敗面板則一律直接顯示。
    if (o.state === 'progress' && now < (window.__shellHoldUntil || 0)) return;
    if (o.state === 'info' && o.holdMs > 0) window.__shellHoldUntil = now + Math.min(o.holdMs, 3000);
    else if (o.state !== 'progress') window.__shellHoldUntil = 0;
    if (!d.getElementById('__shellToastCss')) {
      var st = d.createElement('style');
      st.id = '__shellToastCss';
      st.textContent = '#__shellToast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;width:460px;max-width:90vw;box-sizing:border-box;padding:22px 28px 20px;border-radius:18px;background:rgba(9,13,21,.95);color:#fff;font:600 18px/1.5 "Segoe UI","Microsoft JhengHei",sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.6),0 0 0 2px var(--c),0 0 26px var(--c);pointer-events:none;opacity:0;transition:opacity .25s}'
        + '#__shellToast .__n{font-size:16px;color:#ffd166;white-space:pre-line;margin-bottom:5px}'
        + '#__shellToast .__t{font-size:26px;font-weight:700;letter-spacing:.02em;overflow-wrap:anywhere}'
        + '#__shellToast .__b{height:12px;border-radius:7px;background:rgba(255,255,255,.16);margin:14px 0 10px;overflow:hidden}'
        + '#__shellToast .__b i{display:block;height:100%;width:0;border-radius:7px;background:var(--c);transition:width .2s}'
        + '#__shellToast .__s{font-size:18px;font-weight:500;color:rgba(255,255,255,.88);white-space:pre-line;overflow-wrap:anywhere;margin-top:8px;line-height:1.6}';
      (d.head || d.documentElement).appendChild(st);
    }
    var el = d.getElementById('__shellToast');
    if (!el) {
      el = d.createElement('div');
      el.id = '__shellToast';
      el.innerHTML = '<div class="__n"></div><div class="__t"></div><div class="__b"><i></i></div><div class="__s"></div>';
      (d.body || d.documentElement).appendChild(el);
    }
    el.setAttribute('data-state', o.state);
    el.style.setProperty('--c', o.color);
    var n = el.querySelector('.__n'), t = el.querySelector('.__t'), b = el.querySelector('.__b'), s = el.querySelector('.__s');
    n.textContent = o.note || ''; n.style.display = o.note ? 'block' : 'none';
    t.textContent = o.title || '';
    if (typeof o.frac === 'number') { b.style.display = 'block'; b.firstChild.style.width = Math.max(0, Math.min(100, o.frac * 100)) + '%'; } else { b.style.display = 'none'; }
    s.textContent = o.sub || ''; s.style.display = o.sub ? 'block' : 'none';
    var cx = innerWidth / 2, cy = innerHeight / 2;
    if (o.idx !== null && o.idx !== undefined) {
      var sl = d.querySelectorAll('.card-slot')[o.idx];
      if (sl) { var r = sl.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    }
    var w = el.offsetWidth || 460, h = el.offsetHeight || 200;
    cx = Math.max(w / 2 + 8, Math.min(innerWidth - w / 2 - 8, cx));
    cy = Math.max(h / 2 + 8, Math.min(innerHeight - h / 2 - 8, cy));
    el.style.left = cx + 'px'; el.style.top = cy + 'px';
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(window.__shellToastT);
    if (o.holdMs > 0) window.__shellToastT = setTimeout(function(){ el.style.opacity = '0'; }, o.holdMs);
  })(${JSON.stringify(o)})`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

// 開關類快捷鍵（F8 時鐘循環、F9 互動／穿透）的畫面提示：畫面上方一顆小膠囊，文字淡入（0.28 秒）→ 停留 → 淡出（0.7 秒）。
// 跟匯出用的 showToast 面板是兩個獨立的元素（匯出進度不會被它蓋掉），滑鼠一律穿透。第二行（\n 後面）是操作說明。
function showPill(text, color, holdMs) {
  if (!win || win.isDestroyed()) return;
  const js = `(function(o){
    var d = document;
    if (!d.getElementById('__shellPillCss')) {
      var st = d.createElement('style');
      st.id = '__shellPillCss';
      st.textContent = '#__shellPill{position:fixed;left:50%;top:9%;transform:translate(-50%,-12px);z-index:2147483646;max-width:86vw;box-sizing:border-box;padding:12px 28px;border-radius:26px;background:rgba(9,13,21,.93);border:2px solid var(--c);box-shadow:0 8px 24px rgba(0,0,0,.6);color:#fff;font:700 24px/1.45 "Microsoft JhengHei","Segoe UI",sans-serif;letter-spacing:.03em;text-align:center;white-space:pre-line;overflow-wrap:anywhere;pointer-events:none;opacity:0;transition:opacity .7s ease,transform .7s ease}'
        + '#__shellPill.__on{opacity:1;transform:translate(-50%,0);transition:opacity .28s ease,transform .28s ease}'
        + '#__shellPill .__h{font-size:15px;font-weight:500;color:rgba(255,255,255,.82);display:block}';
      (d.head || d.documentElement).appendChild(st);
    }
    var el = d.getElementById('__shellPill');
    if (!el) { el = d.createElement('div'); el.id = '__shellPill'; (d.body || d.documentElement).appendChild(el); }
    var parts = String(o.text).split('\\n');
    el.textContent = parts[0];
    if (parts[1]) { var h = d.createElement('span'); h.className = '__h'; h.textContent = parts.slice(1).join('\\n'); el.appendChild(h); }
    el.style.setProperty('--c', o.color);
    void el.offsetWidth;
    el.classList.add('__on');
    clearTimeout(window.__shellPillT);
    window.__shellPillT = setTimeout(function(){ el.classList.remove('__on'); }, o.holdMs);
  })(${JSON.stringify({ text, color, holdMs: holdMs || 1800 })})`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

// 時鐘循環實際的開／關由 stage 頁面決定（拖曳卡片會自動暫停），所以由它回報：開始／暫停／拖曳造成的自動暫停。
ipcMain.on('cycle-state', (_event, running, why) => {
  if (why === 'drag') showPill(`⏸ 時鐘式循環：已暫停\n拖曳卡片時自動暫停，${CYCLE_KEY} 繼續`, '#ffd166');
  else if (running) showPill(`🕐 時鐘式循環：已開始${cycleNote()}\n${CYCLE_KEY} 暫停`, '#4ade80');
  else showPill(`⏸ 時鐘式循環：已暫停\n${CYCLE_KEY} 繼續`, '#ffd166');
});

// 手勢辨識（F7）／手部骨架（F6）的實際狀態由舞台頁面回報（攝影機可能開不起來，所以不能只憑「按了鍵」就說已開啟）。
ipcMain.on('toggle-state', (_event, kind, on, why) => {
  if (kind === 'gesture') {
    if (why === 'camera') showPill(`⚠️ 手勢辨識：無法開啟攝影機\n權限被拒或沒有攝影機，${GESTURE_KEY} 重試`, '#ff6b6b', 3200);
    else if (on) showPill(`🖐️ 手勢辨識：已開啟\n布＝散開、拳頭＝收縮、剪刀＝翻面，${GESTURE_KEY} 關閉`, '#4ade80', 2600);
    else showPill(`🖐️ 手勢辨識：已關閉\n${GESTURE_KEY} 開啟`, '#ffd166');
  } else if (kind === 'skeleton') {
    showPill(on ? `🦴 手部骨架：已顯示\n${SKELETON_KEY} 隱藏` : `🦴 手部骨架：已隱藏\n${SKELETON_KEY} 顯示`, on ? '#4ade80' : '#ffd166');
  }
});

// 每秒自動翻面（F4）：卡片自己的 toggleAutoFlip() 不回傳狀態（狀態在卡片 html 的閉包裡，不能改卡片），所以由這裡記錄——
// 卡片頁面重新載入（F11 重設）會回到「關」，兩個 did-finish-load 會把旗標歸零。
let autoFlipOn = false;
function toggleAutoFlipCmd() {
  if (!win || win.isDestroyed()) return;
  if (Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0) {
    win.webContents.send('autoflip-toggle');
  } else {
    win.webContents.executeJavaScript('window.toggleAutoFlip && window.toggleAutoFlip()').catch(() => {});
  }
  autoFlipOn = !autoFlipOn;
  showPill(autoFlipOn ? `🔄 每秒自動翻面：已開啟\n${AUTOFLIP_KEY} 關閉` : `🔄 每秒自動翻面：已關閉\n${AUTOFLIP_KEY} 開啟`, autoFlipOn ? '#4ade80' : '#ffd166');
}

// 時鐘式循環的補充說明：剛好 5 張＝「中央＋四角」，第 1 張不動、其餘四張繞它轉（見 computeCycleConfigCentre()）。
function cycleNote() {
  return Array.isArray(MULTI_CARDS) && MULTI_CARDS.length === 5 ? '（中央不動，四張繞它）' : '';
}

// 系統匣「⌨️ 顯示快捷鍵提示」：在畫面中央列出目前生效的快捷鍵（含匯出分享）10 秒。多卡版面（例如六狗）卡片下方那行
// 操作提示會被下一排卡片蓋住、或超出螢幕，根本看不到，所以另外提供這個隨時叫得出來的提示。
function showShortcutHelp() {
  const multi = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  const lines = [
    `${TOGGLE_KEY}　切換 互動／點擊穿透`,
    ...(CYCLE_MODE ? [`${CYCLE_KEY}　時鐘式循環${cycleNote()}`] : []),
    ...(multi ? [`${GESTURE_KEY}　手勢辨識　${SKELETON_KEY}　手部骨架`] : []),
    `${AUTOFLIP_KEY}　每秒自動翻面`,
    `${SKILL_KEY}　技能演出`,
    `${RARITY_KEY}　切換稀有度`,
    `${MUTE_KEY}　音效靜音`,
    `${EXPORT_KEY}　匯出分享（${EXPORT_FORMAT.toUpperCase()}）${multi ? '＝游標所在的卡' : ''}`,
    ...(multi ? [`${EXPORT_LAYOUT_KEY}　匯出整個版面（所有卡一起）`] : []),
    `${ZOOM_IN_KEY} / ${ZOOM_OUT_KEY}　放大／縮小`,
    `${OPACITY_UP_KEY} / ${OPACITY_DOWN_KEY}　更不透明／更透明`,
    `${RESET_KEY}　重設位置　${QUIT_KEY}　結束`,
    '右鍵拖曳卡片＝移動位置',
    '滾輪＝縮放　Alt＋滾輪＝透明度　中鍵＝重設',
  ];
  showToast({ state: 'info', title: '⌨️ 快捷鍵', sub: lines.join('\n'), holdMs: 10000 });
}

// 依序匯出 indices 指定的卡片（單卡固定 [0]）。同一時間只跑一個。進度／結果顯示在：卡片中央的狀態面板（showToast）、
// 系統匣選單最上方那一行與提示文字、系統通知（可能被 Windows 吞掉，所以不能只靠它）。
async function runExport(format, indices, note) {
  const multi = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  if (cardExporter.isBusy()) {
    const cur = exportProgress ? `${exportProgress.label}　目前 ${Math.round(exportProgress.frac * 100)}%` : '請稍等一下';
    notify('匯出進行中', '上一個匯出還沒結束，請稍等一下。');
    showToast({ state: 'info', title: '⏳ 上一個匯出還沒結束', sub: cur, holdMs: 3000, idx: exportProgress ? exportProgress.idx : null });
    return;
  }
  const cards = exportCardList();
  const fmt = cardExporter.FORMATS[format];
  const baseTip = `${pkg.name}\n${trayLabel()}`;
  const total = indices.length;
  let n = 0;
  for (const idx of indices) {
    n++;
    const card = cards[idx];
    if (!card) continue;
    let label = cardDisplayName(card.file);
    const queue = total > 1 ? `（第 ${n}/${total} 張）` : '';
    const paint = (state, extra) => showToast(Object.assign({ state, note: note || '', idx: multi ? idx : null }, extra));
    let lastAt = 0;
    let lastPct = -10;
    exportProgress = { label, frac: 0, idx: multi ? idx : null };
    exportStatusLine = `📤 匯出中：${label}${queue} 0%`;
    updateTrayMenu();
    notify('開始匯出', `${label} → ${fmt.label}${format === 'png' ? '' : '（約十幾秒，請稍候）'}`);
    paint('progress', { title: `📤 匯出中：${label}${queue}`, sub: fmt.label, frac: 0 });
    try {
      const r = await cardExporter.exportCard({
        file: path.join(__dirname, card.file),
        format,
        outDir: EXPORT_DIR,
        seconds: EXPORT_SECONDS,
        gifScale: GIF_SCALE,
        stars: AMBIENT_STARS,
        onInfo: (info) => { if (info && info.name) label = info.name; }, // 卡片載入後換成中文卡名
        onStatus: (msg, frac) => {
          const f = typeof frac === 'number' ? frac : 0;
          const pct = Math.round(f * 100);
          exportProgress = { label, frac: f, idx: multi ? idx : null };
          if (tray && !tray.isDestroyed()) tray.setToolTip(`${baseTip}\n📤 ${label}：${msg} ${pct}%`);
          const now = Date.now();
          if (now - lastAt > 200) {
            lastAt = now;
            paint('progress', { title: `📤 匯出中：${label}${queue}`, sub: `${msg} · ${pct}%`, frac: f });
          }
          if (pct >= lastPct + 10) { // 系統匣選單只在每 10% 重建一次（重建選單會讀登錄檔，不要太頻繁）
            lastPct = pct;
            exportStatusLine = `📤 匯出中：${label}${queue} ${pct}%`;
            updateTrayMenu();
          }
        },
      });
      lastExportPath = r.path;
      let extra = '';
      if (r.png) { clipboard.writeImage(nativeImage.createFromBuffer(r.png)); extra = '，圖片已複製到剪貼簿'; }
      const size = `${(r.bytes / 1048576).toFixed(1)} MB${extra}`;
      notify('匯出完成', `${path.basename(r.path)}（${size}）\n點這則通知打開所在資料夾`);
      paint('done', { title: `✅ 匯出完成：${label}${queue}`, sub: `${path.basename(r.path)}（${size}）\n已存到 ${path.dirname(r.path)}\n${EXPORT_KEY} 可再次匯出`, frac: 1, holdMs: 9000 });
    } catch (e) {
      notify('匯出失敗', cardExporter.errText(e));
      paint('error', { title: `❌ 匯出失敗：${label}`, sub: cardExporter.errText(e), holdMs: 12000 });
      console.warn(`${LOG_TAG} 匯出失敗：`, e);
    } finally {
      exportProgress = null;
      exportStatusLine = null;
      if (tray && !tray.isDestroyed()) tray.setToolTip(baseTip);
      updateTrayMenu();
    }
  }
}

// 多卡「整個版面」（所有卡一起旋轉）與「時鐘轉圈」（卡片沿橢圓繞一圈）匯出：用桌面上「目前」的格位座標與每張卡的縮放。
// 進度／結果的顯示方式跟 runExport() 一樣（畫面中央狀態面板、系統匣、系統通知）。
async function runExportStage(format, kind) {
  if (!(Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0) || !currentSlots) return;
  if (cardExporter.isBusy()) {
    const cur = exportProgress ? `${exportProgress.label}　目前 ${Math.round(exportProgress.frac * 100)}%` : '請稍等一下';
    notify('匯出進行中', '上一個匯出還沒結束，請稍等一下。');
    showToast({ state: 'info', title: '⏳ 上一個匯出還沒結束', sub: cur, holdMs: 3000, idx: exportProgress ? exportProgress.idx : null });
    return;
  }
  const effective = effectiveCardsFrom(MULTI_CARDS, currentSlots);
  const cycle = kind === 'orbit' ? computeCycleConfig(effective) : null;
  if (kind === 'orbit' && !cycle) {
    notify('時鐘轉圈', '要 3 張以上的多卡版面才能匯出時鐘轉圈。');
    showToast({ state: 'info', title: '時鐘轉圈需要 3 張以上', holdMs: 4000 });
    return;
  }
  const fmt = cardExporter.FORMATS[format];
  const n = effective.length;
  const label = kind === 'orbit' ? `時鐘轉圈（${n} 張）` : `整個版面（${n} 張）`;
  const secs = kind === 'orbit' ? Math.max(1, CYCLE_PERIOD_MS / 1000) : EXPORT_SECONDS;
  const baseTip = `${pkg.name}\n${trayLabel()}`;
  const paint = (state, extra) => showToast(Object.assign({ state, idx: null }, extra));
  let lastAt = 0;
  let lastPct = -10;
  exportProgress = { label, frac: 0, idx: null };
  exportStatusLine = `📤 匯出中：${label} 0%`;
  updateTrayMenu();
  notify('開始匯出', `${label} → ${fmt.label}${format === 'png' ? '' : '（可能要一分鐘左右，請稍候）'}`);
  paint('progress', { title: `📤 匯出中：${label}`, sub: `${fmt.label}${kind === 'orbit' ? `（繞一圈 ${secs} 秒）` : ''}`, frac: 0 });
  try {
    const r = await cardExporter.exportStage({
      slots: effective.map((c) => ({ file: path.join(__dirname, c.file), x: c.x, y: c.y, w: c.w, h: c.h })),
      cycle,
      kind,
      format,
      outDir: EXPORT_DIR,
      seconds: secs,
      gifScale: GIF_SCALE,
      stars: AMBIENT_STARS,
      onStatus: (msg, frac) => {
        const f = typeof frac === 'number' ? frac : 0;
        const pct = Math.round(f * 100);
        exportProgress = { label, frac: f, idx: null };
        if (tray && !tray.isDestroyed()) tray.setToolTip(`${baseTip}\n📤 ${label}：${msg} ${pct}%`);
        const now = Date.now();
        if (now - lastAt > 250) { lastAt = now; paint('progress', { title: `📤 匯出中：${label}`, sub: `${msg} · ${pct}%`, frac: f }); }
        if (pct >= lastPct + 10) { lastPct = pct; exportStatusLine = `📤 匯出中：${label} ${pct}%`; updateTrayMenu(); }
      },
    });
    lastExportPath = r.path;
    let extra = '';
    if (r.png) { clipboard.writeImage(nativeImage.createFromBuffer(r.png)); extra = '，圖片已複製到剪貼簿'; }
    const size = `${(r.bytes / 1048576).toFixed(1)} MB${extra}`;
    notify('匯出完成', `${path.basename(r.path)}（${size}）\n點這則通知打開所在資料夾`);
    paint('done', { title: `✅ 匯出完成：${label}`, sub: `${path.basename(r.path)}（${size}）\n已存到 ${path.dirname(r.path)}\n${kind === 'layout' ? `${EXPORT_LAYOUT_KEY} 可再次匯出整個版面` : '系統匣選單「匯出分享」可再次匯出'}`, frac: 1, holdMs: 9000 });
  } catch (e) {
    notify('匯出失敗', cardExporter.errText(e));
    paint('error', { title: `❌ 匯出失敗：${label}`, sub: cardExporter.errText(e), holdMs: 12000 });
    console.warn(`${LOG_TAG} 匯出失敗：`, e);
  } finally {
    exportProgress = null;
    exportStatusLine = null;
    if (tray && !tray.isDestroyed()) tray.setToolTip(baseTip);
    updateTrayMenu();
  }
}

// 快捷鍵：單卡＝這張卡；多卡＝游標所在的卡片（用 stage 頁面裡每一格的實際位置判斷，不動 stage 程式碼）。
async function exportByHotkey() {
  if (!win || win.isDestroyed()) return;
  if (!(Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0)) { runExport(EXPORT_FORMAT, [0]); return; }
  const p = screen.getCursorScreenPoint();
  const b = win.getContentBounds();
  let hit = null;
  try {
    hit = await win.webContents.executeJavaScript(`(function(x, y){
      var best = -1, bd = 1e18;
      Array.prototype.forEach.call(document.querySelectorAll('.card-slot'), function(el, i){
        var r = el.getBoundingClientRect();
        var inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        var d = (inside ? 0 : 1e9) + Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < bd) { bd = d; best = i; }
      });
      return { idx: best, inside: bd < 1e9 };
    })(${p.x - b.x}, ${p.y - b.y})`);
  } catch (e) { /* stage 頁面沒準備好 */ }
  if (!hit || hit.idx < 0) {
    notify('匯出分享', `找不到可匯出的卡片（掛件還沒準備好？）。可以稍等一下再按 ${EXPORT_KEY}，或用系統匣選單挑卡片。`);
    showToast('📤 找不到可匯出的卡片，請稍等一下再試，或用系統匣選單挑卡片', 5000);
    return;
  }
  // 游標不在任何卡片格位上（例如在螢幕邊緣、別的螢幕）：以前是什麼都不做，使用者看不出反應；現在改匯出離游標最近的一張。
  runExport(EXPORT_FORMAT, [hit.idx], hit.inside ? '' : '（游標不在任何卡片上，改匯出最近的一張）');
}

// 系統匣「📤 匯出分享」子選單：單卡＝三種格式直接點；多卡＝每種格式底下列出各張卡片與「全部」。
function exportMenuItems() {
  const cards = exportCardList();
  const multi = cards.length > 1 || (Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0);
  return Object.keys(cardExporter.FORMATS).map((format) => {
    const label = `${cardExporter.FORMATS[format].label}${format === EXPORT_FORMAT ? `（${EXPORT_KEY}）` : ''}`;
    if (!multi) return { label, click: () => runExport(format, [0]) };
    return {
      label,
      submenu: cards.map((c, i) => ({ label: cardDisplayName(c.file), click: () => runExport(format, [i]) }))
        .concat([
          { type: 'separator' },
          { label: '全部卡片（依序，各存一個檔）', click: () => runExport(format, cards.map((_, i) => i)) },
          { label: `🧩 整個版面（所有卡一起，合成一支）${format === EXPORT_FORMAT ? `（${EXPORT_LAYOUT_KEY}）` : ''}`, click: () => runExportStage(format, 'layout') },
        ].concat(format !== 'png' && CYCLE_MODE ? [{ label: '🕐 時鐘轉圈動畫（卡片繞橢圓一圈）', click: () => runExportStage(format, 'orbit') }] : [])),
    };
  }).concat([
    { type: 'separator' },
    { label: '📂 打開匯出資料夾', click: () => { fs.mkdirSync(EXPORT_DIR, { recursive: true }); shell.openPath(EXPORT_DIR); } },
  ]);
}

// card-fx 指令（'cast' | 'rarity' | 'mute'）：單卡直接對卡片頁面執行；多卡送 IPC 給 stage 頁面轉發。
function sendFx(cmd) {
  if (!win || win.isDestroyed()) return;
  if (Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0) {
    win.webContents.send('fx-cmd', cmd);
  } else {
    win.webContents.executeJavaScript(`window.__phantomCardFxRun && window.__phantomCardFxRun(${JSON.stringify(cmd)})`).catch(() => {});
  }
}

function trayLabel() {
  // 用來在系統匣圖示的提示文字／選單上標明「這是哪一個掛件」，讓使用者同時
  // 開好幾個 exe 時分得清楚系統匣裡一排小圖示各自是誰（Windows 系統匣本身
  // 不會顯示文字，只能靠 hover 提示或選單內容分辨）。
  const isMulti = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  return isMulti ? `多卡：${MULTI_CARDS.map((c) => c.file.replace(/^cards\//, '')).join('、')}` : (CARD_FILE || pkg.name);
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  if (trayMenuOpen) { trayMenuRebuildPending = true; return; } // 選單正開著：等關掉再重建
  const template = [
    { label: `🎴 ${trayLabel()}`, enabled: false },
    { type: 'separator' },
    {
      label: `${clickThrough ? '🖱️ 切換成可互動（目前：點擊穿透）' : '🖱️ 切換成點擊穿透（目前：可互動）'} (${TOGGLE_KEY})`,
      click: () => setClickThrough(!clickThrough),
    },
  ];
  // 匯出進行中：選單最上方多一行進度（沒在匯出時不出現）
  if (exportStatusLine) template.splice(1, 0, { label: exportStatusLine, enabled: false });
  if (CYCLE_MODE) {
    template.push({
      label: `🕐 開始/暫停 時鐘式循環${cycleNote()} (${CYCLE_KEY})`,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('cycle-toggle'); },
    });
  }
  if (Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0) {
    template.push({
      label: `🖐️ 開始/暫停 手勢辨識 (${GESTURE_KEY})`,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('gesture-toggle'); },
    });
    template.push({
      label: `🦴 開啟/關閉 手部骨架視覺效果 (${SKELETON_KEY})`,
      click: toggleSkeleton,
    });
  }
  template.push({
    label: `↩️ 重設卡片位置／縮放／透明度 (${RESET_KEY})`,
    click: confirmResetCardPositions,
  });

  // 系統匣選單分組列出所有快捷鍵功能（每項都標出目前生效的按鍵，改了 package.json/GUI 的鍵會跟著變）。
  // 分組標題是 disabled 的純文字，不可點；縮放與透明度不再收在子選單裡，一眼就看得到。
  template.push(
    { type: 'separator' },
    { label: '── ✨ 卡片特效 ──', enabled: false },
    { label: `⚡ 施放技能演出 (${SKILL_KEY})`, click: () => sendFx('cast') },
    { label: `✨ 切換稀有度 SR→SSR→UR→LR (${RARITY_KEY})`, click: () => sendFx('rarity') },
    { label: `🔇 靜音／取消靜音音效 (${MUTE_KEY})`, click: () => sendFx('mute') },
    // 任何張數的多卡合一、單卡都能用（不像時鐘循環要 3 張以上）——沒支援這個功能
    // 的（自己另外加的）卡片點了也只是沒反應，不用另外判斷卡片種類。
    {
      label: `🔄 開始/暫停 每秒自動翻面循環 (${AUTOFLIP_KEY})`,
      click: toggleAutoFlipCmd,
    },
    { type: 'separator' },
    { label: `── 📤 匯出分享（${EXPORT_KEY}＝匯出 ${EXPORT_FORMAT.toUpperCase()}${Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0 ? `，多卡＝游標所在的卡；${EXPORT_LAYOUT_KEY}＝整個版面` : ''}）──`, enabled: false },
    { label: `📤 匯出分享`, submenu: exportMenuItems() },
    { label: '⌨️ 顯示快捷鍵提示（畫面上 10 秒）', click: showShortcutHelp },
    { type: 'separator' },
    { label: '── 🔍 縮放與透明度（滾輪縮放／Alt＋滾輪透明度／中鍵重設）──', enabled: false },
    { label: `🔍 放大 (${ZOOM_IN_KEY})`, click: () => sendView('zoom-in') },
    { label: `🔎 縮小 (${ZOOM_OUT_KEY})`, click: () => sendView('zoom-out') },
    { label: `☀️ 更不透明 (${OPACITY_UP_KEY})`, click: () => sendView('opacity-up') },
    { label: `🌫️ 更透明 (${OPACITY_DOWN_KEY})`, click: () => sendView('opacity-down') },
    { label: '↺ 重設縮放與透明度', click: () => sendView('reset') },
    { type: 'separator' },
  );
  // 勾選狀態每次重建選單都重新問系統（不是信 settings.json 存的值），使用者如果
  // 從工作管理員／Windows 設定的「啟動」頁面關掉它，這裡也會誠實反映。
  template.push({
    label: '🚀 開機自動啟動',
    type: 'checkbox',
    checked: isLaunchAtLoginEnabled(),
    click: (item) => setLaunchAtLogin(item.checked),
  });
  template.push({ type: 'separator' }, { label: `結束程式 (${QUIT_KEY})`, click: () => app.quit() });
  const menu = Menu.buildFromTemplate(template);
  menu.on('menu-will-show', () => {
    trayMenuOpen = true;
    clearTimeout(trayMenuGuardTimer);
    trayMenuGuardTimer = setTimeout(() => { trayMenuOpen = false; if (trayMenuRebuildPending) { trayMenuRebuildPending = false; updateTrayMenu(); } }, 60000);
  });
  menu.on('menu-will-close', () => {
    trayMenuOpen = false;
    clearTimeout(trayMenuGuardTimer);
    if (trayMenuRebuildPending) { trayMenuRebuildPending = false; setImmediate(updateTrayMenu); }
  });
  tray.setContextMenu(menu);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(`${pkg.name}\n${trayLabel()}`);
  // 左鍵點擊系統匣圖示也切換互動/穿透（跟全域快捷鍵做一樣的事），右鍵才彈
  // 選單（Tray 的預設行為，這裡不用另外處理）——多一個不依賴快捷鍵的入口，
  // 不用每次都特地右鍵展開選單才能切換模式。
  tray.on('click', () => setClickThrough(!clickThrough));
  // 匯出完成的通知：點一下打開資料夾並選取剛匯出的檔案。
  tray.on('balloon-click', () => { if (lastExportPath && fs.existsSync(lastExportPath)) shell.showItemInFolder(lastExportPath); });
  updateTrayMenu();
}

app.whenReady().then(() => {
  // 手勢散開/收縮要讀攝影機（getUserMedia）——Electron 預設會擋掉這類媒體
  // 權限請求，不主動放行的話 stage 頁面會卡在權限請求、或直接被拒絕（做法
  // 照抄 C:\hand-tracker\main.js 同一段）。只放行媒體權限，其他類型維持預設
  // 拒絕；沒有任何多卡合一設定 gestureKey 也沒差，反正沒人會去要求這個權限。
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  const isMulti = Array.isArray(MULTI_CARDS) && MULTI_CARDS.length > 0;
  if (isMulti) {
    createMultiWindow(MULTI_CARDS);
  } else if (CARD_FILE) {
    createSingleWindow();
  } else {
    throw new Error('package.json 必須有 cardFile（單卡）或 cards（多卡）其中一個');
  }

  // 系統匣圖示在快捷鍵註冊「之前」就先建立——不管下面 TOGGLE_KEY/QUIT_KEY
  // 搶不搶得到全域快捷鍵，使用者都保證找得到「結束程式」這個選項，見
  // createTray() 開頭的說明。
  createTray();

  // 開機自動啟動的預設值只在「第一次啟動、settings.json 還沒有使用者的選擇」時
  // 套用一次（見 LAUNCH_AT_LOGIN_DEFAULT 的說明）。
  const savedSettings = loadJson(SETTINGS_FILE) || {};
  if (typeof savedSettings.launchAtLogin !== 'boolean' && LAUNCH_AT_LOGIN_DEFAULT) {
    setLaunchAtLogin(true);
  }

  const okToggle = globalShortcut.register(TOGGLE_KEY, () => setClickThrough(!clickThrough));
  if (!okToggle) {
    console.warn(`${LOG_TAG} ${TOGGLE_KEY} 全域快捷鍵註冊失敗（可能跟其他程式，或跟另一個同時開著的卡片掛件衝突；可在 package.json 的 toggleKey 改一個沒被占用的鍵，或直接用系統匣圖示切換）`);
  }

  const okQuit = globalShortcut.register(QUIT_KEY, () => app.quit());
  if (!okQuit) {
    console.warn(`${LOG_TAG} ${QUIT_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 quitKey 改一個沒被占用的鍵，或直接用系統匣圖示的「結束程式」關閉）`);
  }
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(`${pkg.name}\n${trayLabel()}${okToggle && okQuit ? '' : '\n⚠️ 部分快捷鍵跟其他程式衝突，請改用這個選單操作'}`);
  }

  if (CYCLE_MODE) {
    const okCycle = globalShortcut.register(CYCLE_KEY, () => {
      if (win && !win.isDestroyed()) win.webContents.send('cycle-toggle');
    });
    if (!okCycle) console.warn(`${LOG_TAG} ${CYCLE_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 cycleKey 改一個沒被占用的鍵）`);
  }

  if (isMulti) {
    const okGesture = globalShortcut.register(GESTURE_KEY, () => {
      if (win && !win.isDestroyed()) win.webContents.send('gesture-toggle');
    });
    if (!okGesture) console.warn(`${LOG_TAG} ${GESTURE_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 gestureKey 改一個沒被占用的鍵）`);

    const okSkeleton = globalShortcut.register(SKELETON_KEY, toggleSkeleton);
    if (!okSkeleton) console.warn(`${LOG_TAG} ${SKELETON_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 skeletonKey 改一個沒被占用的鍵）`);
  }

  const okReset = globalShortcut.register(RESET_KEY, confirmResetCardPositions);
  if (!okReset) console.warn(`${LOG_TAG} ${RESET_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 resetKey 改一個沒被占用的鍵，或直接用系統匣圖示的「重設卡片位置」）`);

  // 每秒自動翻面循環：單卡模式沒有 stage 父頁面可以轉發 postMessage，直接對
  // 這個 frame 呼叫 executeJavaScript 呼叫卡片自己掛在 window 上的
  // toggleAutoFlip()（見 cards/{六狗}_phantom_card.html）；多卡模式送 IPC 給
  // stage 頁面，由它自己 broadcastAutoFlipToggle() 轉發進每個 iframe（見
  // buildStageHtml() 裡 onAutoFlipToggle 那段）。跟 toggleKey/quitKey/resetKey
  // 一樣不分模式一律註冊，即使卡片沒有 toggleAutoFlip 也只是沒反應、不會出錯。
  const okAutoFlip = globalShortcut.register(AUTOFLIP_KEY, toggleAutoFlipCmd);
  if (!okAutoFlip) console.warn(`${LOG_TAG} ${AUTOFLIP_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突；可在 package.json 的 autoFlipKey 改一個沒被占用的鍵）`);

  for (const [key, cmd, cfgName] of [
    [ZOOM_IN_KEY, 'zoom-in', 'zoomInKey'], [ZOOM_OUT_KEY, 'zoom-out', 'zoomOutKey'],
    [OPACITY_UP_KEY, 'opacity-up', 'opacityUpKey'], [OPACITY_DOWN_KEY, 'opacity-down', 'opacityDownKey'],
  ]) {
    let ok = false;
    try { ok = globalShortcut.register(key, () => sendView(cmd)); } catch (e) { /* 不合法的按鍵字串 */ }
    if (!ok) console.warn(`${LOG_TAG} ${key} 全域快捷鍵註冊失敗（可能跟其他程式衝突或格式不對；可在 package.json 的 ${cfgName} 改一個沒被占用的鍵，或直接用系統匣選單／滾輪）`);
  }

  {
    let ok = false;
    try { ok = globalShortcut.register(EXPORT_KEY, exportByHotkey); } catch (e) { /* 不合法的按鍵字串 */ }
    if (!ok) console.warn(`${LOG_TAG} ${EXPORT_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突或格式不對；可在 package.json 的 exportKey 改一個沒被占用的鍵，或直接用系統匣選單）`);
  }

  if (isMulti) {
    let ok = false;
    try { ok = globalShortcut.register(EXPORT_LAYOUT_KEY, () => runExportStage(EXPORT_FORMAT, 'layout')); } catch (e) { /* 不合法的按鍵字串 */ }
    if (!ok) console.warn(`${LOG_TAG} ${EXPORT_LAYOUT_KEY} 全域快捷鍵註冊失敗（可能跟其他程式衝突或格式不對；可在 package.json 的 exportLayoutKey 改一個沒被占用的鍵，或直接用系統匣選單）`);
  }

  for (const [key, cmd, cfgName] of [[SKILL_KEY, 'cast', 'skillKey'], [RARITY_KEY, 'rarity', 'rarityKey'], [MUTE_KEY, 'mute', 'muteKey']]) {
    let ok = false;
    try { ok = globalShortcut.register(key, () => sendFx(cmd)); } catch (e) { /* 不合法的按鍵字串 */ }
    if (!ok) console.warn(`${LOG_TAG} ${key} 全域快捷鍵註冊失敗（可能跟其他程式衝突或格式不對；可在 package.json 的 ${cfgName} 改一個沒被占用的鍵，或直接用系統匣選單）`);
  }

  console.log(`${LOG_TAG} 桌面掛件已啟動（${isMulti ? `多卡：${MULTI_CARDS.map((c) => c.file).join('、')}` : CARD_FILE}）`);
  console.log(`${LOG_TAG}   ${TOGGLE_KEY}  切換 互動/點擊穿透 模式`);
  console.log(`${LOG_TAG}   在卡片上按住滑鼠右鍵拖曳移動位置`);
  if (CYCLE_MODE) console.log(`${LOG_TAG}   ${CYCLE_KEY}  開始/暫停 時鐘式循環${cycleNote()}（3 張以上、順時針；拖曳任何一格也會自動暫停）`);
  if (isMulti) {
    console.log(`${LOG_TAG}   ${GESTURE_KEY}  開始/暫停 手勢辨識：布＝散開、拳頭＝收縮、剪刀＝翻面，需要攝影機權限`);
    console.log(`${LOG_TAG}   ${SKELETON_KEY}  開啟/關閉 手部骨架視覺效果`);
  }
  console.log(`${LOG_TAG}   ${RESET_KEY}  重設卡片位置（會先跳確認視窗）`);
  console.log(`${LOG_TAG}   ${AUTOFLIP_KEY}  開始/暫停 每秒自動翻面循環`);
  console.log(`${LOG_TAG}   環境星光（卡面小星星）：${AMBIENT_STARS ? '開' : '關（以前的樣子；builder-gui 打包時可勾選開啟）'}`);
  console.log(`${LOG_TAG}   開機自動啟動：${isLaunchAtLoginEnabled() ? '已開啟' : '未開啟'}（系統匣選單可切換）`);
  console.log(`${LOG_TAG}   滾輪縮放卡片、Alt＋滾輪調透明度、滑鼠中鍵重設（設定會跟位置一起存檔）`);
  console.log(`${LOG_TAG}   ${ZOOM_IN_KEY}／${ZOOM_OUT_KEY}  放大／縮小；${OPACITY_UP_KEY}／${OPACITY_DOWN_KEY}  更不透明／更透明`);
  console.log(`${LOG_TAG}   ${SKILL_KEY}  技能演出（蓄力→爆發，點一下卡片也會觸發）`);
  console.log(`${LOG_TAG}   ${RARITY_KEY}  切換稀有度 SR→SSR→UR→LR`);
  console.log(`${LOG_TAG}   ${MUTE_KEY}  音效靜音／取消靜音`);
  console.log(`${LOG_TAG}   ${EXPORT_KEY}  匯出分享（${cardExporter.FORMATS[EXPORT_FORMAT].label}）→ ${EXPORT_DIR}；系統匣選單可選 PNG／WebM／GIF`);
  if (isMulti) console.log(`${LOG_TAG}   ${EXPORT_LAYOUT_KEY}  匯出整個版面（所有卡一起，${cardExporter.FORMATS[EXPORT_FORMAT].label}）；系統匣選單「匯出分享」另有「時鐘轉圈動畫」`);
  console.log(`${LOG_TAG}   ${QUIT_KEY} 結束程式`);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  if (tray && !tray.isDestroyed()) tray.destroy();
});
