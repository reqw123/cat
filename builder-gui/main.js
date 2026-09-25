'use strict';
// html 白名單管理 GUI 的 Electron 外殼——獨立小工具，跟 C:\cat 根目錄的
// main.js（卡片桌面掛件本體）完全分開，只負責讀寫 build/*.yml，不會被打包進
// 任何一個卡片 exe（electron-builder.yml 的 files 白名單沒有列 builder-gui/，
// 見 CONTEXT）。
//
// 背景：C:\cat 每個 build/*.yml 要同時維護兩份「哪些卡片會被用到」的資訊——
// files（打包白名單）跟 extraMetadata.cardFile／cards（實際載入哪個 html）——
// 兩份手動維護很容易忘記同步（見 桌面掛件說明.md 的踩雷紀錄）。這支工具讓
// 使用者只勾選「這個 build 要用哪些卡片」一次，兩份資訊由這裡自動算出來、
// 保證一致，不用再手動對照兩個地方。
//
// 執行：npm run builder-gui（見 package.json）
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const yaml = require('js-yaml');

const ROOT_DIR = path.join(__dirname, '..');
const CARDS_DIR = path.join(ROOT_DIR, 'cards');
const BUILD_DIR = path.join(ROOT_DIR, 'build');
const BACKUP_DIR = path.join(BUILD_DIR, '.bak');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
// electron-builder 的 CLI 進入點——直接指到它自己的 cli.js，用系統的 node 執行
// （不是這個視窗自己的 electron.exe）。實際測過另一種寫法：拿 process.execPath
// （這個視窗的 electron.exe）搭配 ELECTRON_RUN_AS_NODE=1 當一般 Node 執行檔跑，
// 結果 electron-builder 的 CLI（yargs）偵測到 process.versions.electron 存在，
// 誤判成「在 Electron 環境下執行、argv 少一層」，把 cli.js 自己的路徑當成一個
// 不明的命令列參數，直接失敗（`Unknown argument: ...cli.js`）——這不是這裡的
// 程式碼寫錯，是 electron-builder CLI 本身對 ELECTRON_RUN_AS_NODE 這種用法沒有
// 處理好。改用系統 node（PATH 裡的 `node`）完全比照使用者原本手動執行
// `npx electron-builder --config build/xxx.yml` 的路徑，實測跑成功（見
// 桌面掛件說明.md／對話紀錄）；這個專案本來就需要 npm/node 才能 `npm install`，
// 依賴系統有 node 不是新增的門檻。
const ELECTRON_BUILDER_CLI = path.join(ROOT_DIR, 'node_modules', 'electron-builder', 'cli.js');
const NODE_BIN = process.platform === 'win32' ? 'node.exe' : 'node';

function listCardFiles() {
  try {
    return fs.readdirSync(CARDS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.html'))
      .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
      .map((f) => {
        const stat = fs.statSync(path.join(CARDS_DIR, f));
        return { file: f, sizeBytes: stat.size };
      });
  } catch (err) {
    console.error('[builder-gui] 讀取 cards/ 資料夾失敗：', err.message);
    return [];
  }
}

// 從 "cards/xxx.html" 這種相對路徑取出檔名本身，GUI 內部一律用純檔名（不帶
// cards/ 前綴）當作勾選清單的 value，寫檔時才補回前綴——這樣如果哪天卡片
// 資料夾改名，只要改這裡跟 save 那段組路徑的地方，UI 邏輯不用跟著動。
function basenameOf(cardPath) {
  if (typeof cardPath !== 'string') return null;
  return cardPath.replace(/^cards\//, '');
}

// 讀單一 build/*.yml，整理成 GUI 用得到的形狀。壞掉的 yml（手動編輯打錯字）
// 回傳 error 欄位，GUI 那筆卡片顯示「解析失敗」，不會擋到其他設定正常顯示。
function parseBuildFile(filename) {
  const full = path.join(BUILD_DIR, filename);
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(full, 'utf8')) || {};
  } catch (err) {
    return { filename, error: `YAML 解析失敗：${err.message}` };
  }
  const meta = doc.extraMetadata || {};
  const cards = Array.isArray(meta.cards) ? meta.cards : null;
  // 牌組模式（deck）：一個卡片大小的視窗，翻回正面時換成清單裡的下一張（見 C:\cat\main.js 的 DECK／buildDeckHtml()）。
  const deck = Array.isArray(meta.deck) ? meta.deck : null;
  const mode = cards && cards.length ? 'multi' : (deck && deck.length ? 'deck' : 'single');
  const selected = mode === 'multi'
    ? cards.map((c) => ({ file: basenameOf(c.file), x: c.x, y: c.y, zoom: c.zoom })).filter((c) => c.file)
    : mode === 'deck'
      ? deck.map((f) => ({ file: basenameOf(f) })).filter((c) => c.file)
      : (meta.cardFile ? [{ file: basenameOf(meta.cardFile) }] : []);
  // 單卡模式的「第一次啟動、還沒被拖過時」預設位置——跟多卡模式的 cards[].x/y
  // 是不同性質的座標（那個是共用視窗裡的絕對像素位置；這個是相對螢幕正中央的
  // 偏移量，見 C:\cat\main.js 的 DEFAULT_OFFSET／createSingleWindow()），只有
  // 單卡模式才有意義，沒設過就是 {x:0,y:0}（螢幕正中央）。
  const defaultOffset = ((mode === 'single' || mode === 'deck') && meta.defaultOffset
    && typeof meta.defaultOffset.x === 'number' && typeof meta.defaultOffset.y === 'number')
    ? { x: meta.defaultOffset.x, y: meta.defaultOffset.y }
    : { x: 0, y: 0 };
  // 時鐘式循環的轉一圈秒數——只有多卡模式有意義（見 C:\cat\main.js 的
  // CYCLE_PERIOD_MS／computeCycleConfig()，3 格以上才真的會啟用），沒設過
  // 就是該檔案沒寫這欄，main.js 自己會 fallback 到預設值 10。
  const cyclePeriodSeconds = (mode === 'multi' && typeof meta.cyclePeriodSeconds === 'number' && meta.cyclePeriodSeconds > 0)
    ? meta.cyclePeriodSeconds
    : 10;
  // 手勢散開（布）／收縮（拳頭）的過渡秒數——任何張數的多卡合一都適用（不像
  // cyclePeriodSeconds 要 3 格以上才生效），見 C:\cat\main.js 的
  // GESTURE_TRANSITION_MS／computeGestureLayout()。
  const gestureTransitionSeconds = (mode === 'multi' && typeof meta.gestureTransitionSeconds === 'number' && meta.gestureTransitionSeconds > 0)
    ? meta.gestureTransitionSeconds
    : 3;
  // 手部骨架視覺效果（復刻 C:\hand-tracker 的發光骨架）預設開啟，跟
  // C:\cat\main.js 的 GESTURE_SHOW_SKELETON 預設值一致；只有明確寫 false 才會
  // 關掉。
  const gestureShowSkeleton = mode === 'multi' && meta.gestureShowSkeleton === false ? false : true;
  // 卡片整體等比例縮放倍率——單卡、多卡都適用（不像 cyclePeriodSeconds 只有
  // 多卡才有意義），見 C:\cat\main.js 的 CARD_SCALE。沒設過就是預設 1（100%，
  // 跟現有卡片設計原始大小一致）。
  const cardScale = typeof meta.cardScale === 'number' && meta.cardScale > 0 ? meta.cardScale : 1;
  // 牌組的自動翻頁（見 C:\cat\main.js 的 DECK_AUTO_FLIP／DECK_INTERVAL_S）：預設開啟、每 2 秒翻一次，間隔以 0.5 秒為單位。
  const deckAutoFlip = meta.deckAutoFlip !== false;
  const deckShowcase = meta.deckShowcase !== false; // 牌組展示效果（光暈、牌堆、繞邊光、換卡閃光…），預設開
  // 跟 saveBuild()／index.html 的 deckIntervalValue()／桌面掛件的 DECK_INTERVAL_S 同一個規則：0.5 秒為單位、0.5～60
  const deckIntervalSeconds = Number(meta.deckIntervalSeconds) > 0 ? Math.min(60, Math.max(0.5, Math.round(Number(meta.deckIntervalSeconds) * 2) / 2)) : 2;
  return {
    filename,
    productName: doc.productName || null,
    mode,
    selected, // [{file, x?, y?}]
    toggleKey: meta.toggleKey || null,
    quitKey: meta.quitKey || null,
    // resetKey 跟 toggleKey／quitKey 一樣兩種模式都會用到（main.js 不分模式一律
    // 註冊重設卡片位置的快捷鍵）。
    resetKey: meta.resetKey || null,
    // autoFlipKey 跟 toggleKey／quitKey／resetKey 同一種慣例：單卡、多卡都會被
    // main.js 註冊（見 AUTOFLIP_KEY），不像 cycleKey/gestureKey/skeletonKey
    // 限定多卡模式。
    autoFlipKey: meta.autoFlipKey || null,
    // 卡片特效快捷鍵（card-fx：技能演出／稀有度／靜音）：單卡、多卡都會被 main.js 註冊。
    skillKey: meta.skillKey || null,
    rarityKey: meta.rarityKey || null,
    muteKey: meta.muteKey || null,
    // 縮放／透明度快捷鍵（滾輪不用設定）：單卡、多卡都會被 main.js 註冊。
    zoomInKey: meta.zoomInKey || null,
    zoomOutKey: meta.zoomOutKey || null,
    opacityUpKey: meta.opacityUpKey || null,
    opacityDownKey: meta.opacityDownKey || null,
    // 匯出分享（card-export）：快捷鍵＋預設格式（png／webm／gif），單卡、多卡都適用。
    exportKey: meta.exportKey || null,
    exportFormat: meta.exportFormat || null,
    gifScale: Number(meta.gifScale) > 0 ? Number(meta.gifScale) : null, // GIF 尺寸倍率（預設 1.5 不寫）
    exportLayoutKey: meta.exportLayoutKey || null, // 多卡：匯出「整個版面」的快捷鍵
    // cycleKey／gestureKey／skeletonKey 只有多卡模式有意義（見 C:\cat\main.js 的
    // CYCLE_MODE／isMulti 判斷才會註冊這些快捷鍵）。
    cycleKey: mode === 'multi' ? (meta.cycleKey || null) : null,
    gestureKey: mode === 'multi' ? (meta.gestureKey || null) : null,
    skeletonKey: mode === 'multi' ? (meta.skeletonKey || null) : null,
    defaultOffset,
    cyclePeriodSeconds,
    gestureTransitionSeconds,
    gestureShowSkeleton,
    cardScale,
    deckAutoFlip,
    deckIntervalSeconds,
    deckShowcase,
    // 開機自動啟動的預設值（見 C:\cat\main.js 的 LAUNCH_AT_LOGIN_DEFAULT）：單卡、多卡都適用，
    // 只有明確寫 true 才算勾選。
    launchAtLogin: meta.launchAtLogin === true,
    // 環境星光（卡面小星星）：預設關，勾選才寫出來（見 C:\cat\main.js 的 AMBIENT_STARS）。
    ambientStars: meta.ambientStars === true,
  };
}

function listBuilds() {
  let names;
  try {
    names = fs.readdirSync(BUILD_DIR).filter((f) => f.toLowerCase().endsWith('.yml'));
  } catch (err) {
    console.error('[builder-gui] 讀取 build/ 資料夾失敗：', err.message);
    return [];
  }
  return names.sort((a, b) => a.localeCompare(b)).map(parseBuildFile);
}

// productName 本身（yml 的 productName: 欄位、最後打包出來 exe 的檔名）完全
// 可以是中文——那只是 electron-builder 的顯示/檔名用欄位，不受任何命名規則
// 限制。但 build/*.yml 的檔名跟 extraMetadata.name（會被合併進封裝後的
// package.json 的 "name" 欄位）就不能是中文了：npm 套件命名規則只認小寫
// 英數字/連字號，塞中文進去很容易在打包過程中被某個工具擋下來。所以這裡分
// 兩段——先試著從 productName 抽出英數字元當 slug（例如「Gojo 五条悟」還是
// 抽得出 gojo），真的完全沒有任何英數字元（純中文）時，改用 productName 算出
// 的雜湊值當代號，保證檔名/內部識別碼永遠是安全的英數字串，同一個中文名稱
// 每次算出來的代號也都一樣，不會每次存檔就換一個檔名。
function slugify(name) {
  const ascii = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  const str = String(name);
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return 'card-' + hash.toString(36);
}

// 把 "  - { file: cards/a.html, x: -89, y: -153 }" 這種 flow style 的單行格式
// 手刻出來（不用 yaml.dump()）：這個專案裡所有手寫的 build/*.yml 都是這種寫法
// （一眼就看得出座標，不用展開成多行 block style），維持同一種風格，不要因為
// 換了產生方式就讓 GUI 存出來的檔案跟手寫的長得不一樣。
function renderYaml({ productName, files, cardFile, cards, deck, deckAutoFlip, deckIntervalSeconds, deckShowcase, toggleKey, quitKey, resetKey, autoFlipKey, skillKey, rarityKey, muteKey, zoomInKey, zoomOutKey, opacityUpKey, opacityDownKey, exportKey, exportFormat, gifScale, exportLayoutKey, cycleKey, gestureKey, skeletonKey, defaultOffset, cyclePeriodSeconds, gestureTransitionSeconds, gestureShowSkeleton, cardScale, launchAtLogin, ambientStars, extraName }) {
  const lines = [];
  lines.push('# ⚠️ 這份設定檔是用 html 白名單管理 GUI（builder-gui/）產生/更新的，不是');
  lines.push('# 手寫的——只保留 extends/productName/files/extraMetadata 這幾個 GUI 有');
  lines.push('# 掌控的欄位，原本手寫的詳細說明註解不會留在這個檔案裡（舊版本存在');
  lines.push('# build/.bak/ 底下，可以回頭比對/復原）。想寫詳細註解可以直接手動編輯這個');
  lines.push('# 檔案，之後只要不再透過 GUI 存檔覆蓋它，你寫的內容就會一直留著。');
  lines.push('extends: electron-builder.yml');
  lines.push(`productName: ${JSON.stringify(productName)}`);
  lines.push('# 白名單：跟下面 cardFile／cards 用到的檔案保證一致，由 GUI 一起算出來，');
  lines.push('# 不用再手動對照兩邊（見 electron-builder.yml 開頭「files 是聯集不是取代」');
  lines.push('# 的說明）。');
  lines.push('files:');
  for (const f of files) lines.push(`  - ${f}`);
  lines.push('extraMetadata:');
  lines.push(`  name: ${JSON.stringify(extraName)}`);
  if (cardFile) {
    lines.push(`  cardFile: ${cardFile}`);
    // 只有真的偏移過（不是螢幕正中央）才寫進去，跟既有手寫設定檔的習慣一致
    // （jimmy-phantom.yml 沒有 defaultOffset，就是 main.js 預設的 {x:0,y:0}／
    // 螢幕正中央；gojo-phantom.yml 手動偏移 340,0 才特別寫出來），不必要地把
    // 每份單卡設定都印一行 {x:0,y:0} 沒有意義。
    if (defaultOffset && (defaultOffset.x !== 0 || defaultOffset.y !== 0)) {
      lines.push(`  defaultOffset: { x: ${defaultOffset.x}, y: ${defaultOffset.y} }`);
    }
  } else if (deck) {
    // 牌組模式：清單順序＝出現順序（照順序循環），視窗位置跟單卡一樣用 defaultOffset。
    lines.push('  cardFile: null');
    lines.push('  deck:');
    for (const f of deck) lines.push(`    - ${f}`);
    // 跟預設值（自動翻頁開、每 2 秒）一樣就不寫，同其他欄位的慣例。
    if (deckAutoFlip === false) lines.push('  deckAutoFlip: false');
    if (deckShowcase === false) lines.push('  deckShowcase: false');
    if (Number.isFinite(deckIntervalSeconds) && deckIntervalSeconds !== 2) lines.push(`  deckIntervalSeconds: ${deckIntervalSeconds}`);
    if (defaultOffset && (defaultOffset.x !== 0 || defaultOffset.y !== 0)) {
      lines.push(`  defaultOffset: { x: ${defaultOffset.x}, y: ${defaultOffset.y} }`);
    }
  } else {
    lines.push('  cardFile: null');
    lines.push('  cards:');
    // zoom＝這張卡自己的縮放倍率（相對整體 cardScale，1＝一樣大）：只有不是 1 才寫出來（同其他「跟預設值一樣就不寫」的欄位）
    for (const c of cards) lines.push(`    - { file: ${c.file}, x: ${c.x}, y: ${c.y}${c.zoom && c.zoom !== 1 ? `, zoom: ${c.zoom}` : ''} }`);
    // 只有跟 main.js 的預設值（10 秒/圈）不一樣才寫出來，理由同上面 defaultOffset
    // 那段——不必要地把每份多卡設定都印一行預設值沒有意義。這欄 3 格以上
    // 時桌面掛件才會真的用到（見 main.js CYCLE_MODE），格數不對也不擋存檔，
    // 使用者可能是先設好轉速、之後才會排到 3 格以上。
    if (Number.isFinite(cyclePeriodSeconds) && cyclePeriodSeconds > 0 && cyclePeriodSeconds !== 10) {
      lines.push(`  cyclePeriodSeconds: ${cyclePeriodSeconds}`);
    }
    // 手勢散開/收縮的過渡秒數，跟 cyclePeriodSeconds 同一種「跟預設值一樣就不寫」
    // 的省話慣例——這欄任何張數的多卡合一都適用（main.js 的 GESTURE_KEY 沒有
    // 格數限制）。
    if (Number.isFinite(gestureTransitionSeconds) && gestureTransitionSeconds > 0 && gestureTransitionSeconds !== 3) {
      lines.push(`  gestureTransitionSeconds: ${gestureTransitionSeconds}`);
    }
    // cycleKey／gestureKey 只有多卡模式才會被 main.js 註冊（見 CYCLE_MODE／
    // isMulti），只有使用者自己改過（不是空字串）才寫出來，維持跟 toggleKey
    // 同一種「留空用預設值」的慣例。
    if (cycleKey) lines.push(`  cycleKey: ${cycleKey}`);
    if (gestureKey) lines.push(`  gestureKey: ${gestureKey}`);
    if (skeletonKey) lines.push(`  skeletonKey: ${skeletonKey}`);
    // 手部骨架視覺效果預設開啟（跟 main.js 的 GESTURE_SHOW_SKELETON 預設值一致），
    // 只有使用者明確關掉才寫這行，維持「跟預設值一樣就不寫」的慣例。
    if (gestureShowSkeleton === false) lines.push('  gestureShowSkeleton: false');
  }
  // 卡片整體等比例縮放倍率：單卡、多卡都適用，寫在 cardFile／cards 的
  // if/else 區塊「外面」——跟 toggleKey/quitKey 同一層，理由也一樣。只有跟
  // main.js 的預設值 1（100%，現有卡片設計原始大小）不一樣才寫出來。
  if (Number.isFinite(cardScale) && cardScale > 0 && cardScale !== 1) {
    lines.push(`  cardScale: ${cardScale}`);
  }
  if (toggleKey) lines.push(`  toggleKey: ${toggleKey}`);
  if (quitKey) lines.push(`  quitKey: ${quitKey}`);
  if (resetKey) lines.push(`  resetKey: ${resetKey}`);
  if (autoFlipKey) lines.push(`  autoFlipKey: ${autoFlipKey}`);
  if (skillKey) lines.push(`  skillKey: ${JSON.stringify(skillKey)}`);
  if (rarityKey) lines.push(`  rarityKey: ${JSON.stringify(rarityKey)}`);
  if (muteKey) lines.push(`  muteKey: ${JSON.stringify(muteKey)}`);
  if (zoomInKey) lines.push(`  zoomInKey: ${JSON.stringify(zoomInKey)}`);
  if (zoomOutKey) lines.push(`  zoomOutKey: ${JSON.stringify(zoomOutKey)}`);
  if (opacityUpKey) lines.push(`  opacityUpKey: ${JSON.stringify(opacityUpKey)}`);
  if (opacityDownKey) lines.push(`  opacityDownKey: ${JSON.stringify(opacityDownKey)}`);
  if (exportKey) lines.push(`  exportKey: ${JSON.stringify(exportKey)}`);
  if (exportFormat) lines.push(`  exportFormat: ${exportFormat}`);
  if (gifScale) lines.push(`  gifScale: ${gifScale}`);
  if (exportLayoutKey) lines.push(`  exportLayoutKey: ${JSON.stringify(exportLayoutKey)}`);
  // 預設不開，只有勾選才寫出來（跟其他「跟預設值一樣就不寫」的欄位同一種慣例）。
  if (launchAtLogin === true) lines.push('  launchAtLogin: true');
  // 預設不開，只有勾選才寫出來（跟其他「跟預設值一樣就不寫」的欄位同一種慣例）。
  if (ambientStars === true) lines.push('  ambientStars: true');
  lines.push('');
  return lines.join('\n');
}

// 存檔前備份舊檔（這個專案沒有 git，覆蓋掉手寫註解就真的救不回來了，見
// renderYaml() 開頭那段警告文字）。檔名帶時間戳記，同一份設定改好幾次也不會
// 互相蓋掉舊備份。
function backupExisting(filename) {
  const full = path.join(BUILD_DIR, filename);
  if (!fs.existsSync(full)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `${filename}.${stamp}.bak.yml`);
  fs.copyFileSync(full, backupPath);
}

// payload:
//   { originalFilename?: string,  // 編輯現有設定時帶這個，決定備份+覆蓋哪個檔案
//     productName: string,
//     mode: 'single' | 'multi',
//     selectedFiles?: string[],   // 單卡模式：剛好一個純檔名（不帶 cards/ 前綴）
//     slots?: Array<{file: string, x: number, y: number}>,  // 多卡模式：一格
//                                 // 一筆，順序＝畫面上排的順序、也是最後寫進
//                                 // cards[] 的順序——這是「哪一格放哪張卡」的
//                                 // 唯一資料來源，renderer 的格位編輯器
//                                 // （slots[]，見 index.html）已經把使用者的
//                                 // 選擇/座標決定好了，這裡只驗證型別、不重新
//                                 // 計算/重新排列，同一個檔名可以出現在好幾格
//     defaultOffset?: {x: number, y: number},  // 單卡模式才有意義：第一次啟動、
//                                 // 還沒被拖過時，相對螢幕正中央的偏移量（見
//                                 // C:\cat\main.js 的 DEFAULT_OFFSET）——這是
//                                 // 「決定單卡模式的座標」這個需求的資料來源，
//                                 // 不傳或兩個值都是 0 就是螢幕正中央
//     toggleKey?: string }
function saveBuild(payload) {
  const { originalFilename, productName, mode, selectedFiles, deckFiles, deckAutoFlip, deckIntervalSeconds, deckShowcase, slots, toggleKey, quitKey, resetKey, autoFlipKey, skillKey, rarityKey, muteKey, zoomInKey, zoomOutKey, opacityUpKey, opacityDownKey, exportKey, exportFormat, gifScale, exportLayoutKey, cycleKey, gestureKey, skeletonKey, defaultOffset, cyclePeriodSeconds, gestureTransitionSeconds, gestureShowSkeleton, cardScale, launchAtLogin, ambientStars } = payload;

  const trimmedName = typeof productName === 'string' ? productName.trim() : '';
  if (!trimmedName) return { ok: false, error: 'productName 不能是空的' };

  const knownCards = new Set(listCardFiles().map((c) => c.file));

  let whitelistFiles; // 白名單用的純檔名（去重）
  let cardFile = null;
  let cardsOut = null;
  let deckOut = null;
  let deckAutoOut = true;
  let deckShowcaseOut = true;
  let deckIntervalOut = 2;
  let offsetOut = null;
  let cyclePeriodOut = null;
  let gestureTransitionOut = null;
  let cycleKeyOut = null;
  let gestureKeyOut = null;
  let skeletonKeyOut = null;
  let gestureShowSkeletonOut = true;

  if (mode === 'single') {
    const raw = Array.isArray(selectedFiles) ? selectedFiles.filter((f) => knownCards.has(f)) : [];
    if (!raw.length) return { ok: false, error: '至少要選一張卡片' };
    if (raw.length > 1) return { ok: false, error: '單卡模式只能選一張卡片，多張請切換成多卡模式' };
    whitelistFiles = [raw[0]];
    cardFile = `cards/${raw[0]}`;
    const ox = defaultOffset && Number.isFinite(defaultOffset.x) ? Math.round(defaultOffset.x) : 0;
    const oy = defaultOffset && Number.isFinite(defaultOffset.y) ? Math.round(defaultOffset.y) : 0;
    offsetOut = { x: ox, y: oy };
  } else if (mode === 'deck') {
    // 牌組：保留使用者排的順序，同一張卡只算一次（使用者選的是「哪幾張＋順序」，不是次數）。
    const raw = [...new Set((Array.isArray(deckFiles) ? deckFiles : []).filter((f) => knownCards.has(f)))];
    if (!raw.length) return { ok: false, error: '牌組至少要放一張卡片' };
    whitelistFiles = raw;
    deckOut = raw.map((f) => `cards/${f}`);
    deckAutoOut = deckAutoFlip !== false;
    deckShowcaseOut = deckShowcase !== false;
    // 翻頁間隔：以 0.5 秒為單位，0.5～60 秒；沒填／非法值＝預設 2 秒
    const iv = Number(deckIntervalSeconds);
    deckIntervalOut = Number.isFinite(iv) && iv > 0 ? Math.min(60, Math.max(0.5, Math.round(iv * 2) / 2)) : 2;
    const ox = defaultOffset && Number.isFinite(defaultOffset.x) ? Math.round(defaultOffset.x) : 0;
    const oy = defaultOffset && Number.isFinite(defaultOffset.y) ? Math.round(defaultOffset.y) : 0;
    offsetOut = { x: ox, y: oy };
  } else if (mode === 'multi') {
    const validSlots = (Array.isArray(slots) ? slots : []).filter(
      (s) => s && knownCards.has(s.file) && Number.isFinite(s.x) && Number.isFinite(s.y)
    );
    if (!validSlots.length) return { ok: false, error: '至少要有一個格位（按「➕ 新增格位」）' };
    whitelistFiles = [...new Set(validSlots.map((s) => s.file))];
    cardsOut = validSlots.map((s) => ({
      file: `cards/${s.file}`, x: Math.round(s.x), y: Math.round(s.y),
      // 縮放倍率限制在 0.25～2.5（跟桌面掛件的執行期縮放範圍一致），取到小數兩位；沒填／非法值＝1
      zoom: Number.isFinite(s.zoom) && s.zoom > 0 ? Math.round(Math.max(0.25, Math.min(2.5, s.zoom)) * 100) / 100 : 1,
    }));
    // 沒填、填 0 或非法值都當作「沿用預設值」，不寫進 yml（見 renderYaml() 的
    // 預設值比對）。
    cyclePeriodOut = Number.isFinite(cyclePeriodSeconds) && cyclePeriodSeconds > 0
      ? Math.round(cyclePeriodSeconds * 10) / 10
      : 10;
    gestureTransitionOut = Number.isFinite(gestureTransitionSeconds) && gestureTransitionSeconds > 0
      ? Math.round(gestureTransitionSeconds * 100) / 100
      : 3;
    cycleKeyOut = typeof cycleKey === 'string' && cycleKey.trim() ? cycleKey.trim() : null;
    gestureKeyOut = typeof gestureKey === 'string' && gestureKey.trim() ? gestureKey.trim() : null;
    skeletonKeyOut = typeof skeletonKey === 'string' && skeletonKey.trim() ? skeletonKey.trim() : null;
    gestureShowSkeletonOut = gestureShowSkeleton !== false;
  } else {
    return { ok: false, error: `不明的模式：${mode}` };
  }

  // 卡片整體等比例縮放倍率：單卡、多卡都適用，不像上面 cyclePeriodSeconds 等
  // 欄位只在 mode==='multi' 分支裡才算，這裡放在 if/else 外面統一處理。沒填、
  // 填 0 或非法值都當作「沿用預設 1（100%）」。
  const cardScaleOut = Number.isFinite(cardScale) && cardScale > 0
    ? Math.round(cardScale * 100) / 100
    : 1;

  // slugify() 現在一定會回傳非空字串（純中文 productName 也有雜湊代號可用，
  // 見該函式開頭的說明），不會再有「取不出檔名」這種情況。
  const slug = slugify(trimmedName);
  const filename = originalFilename || `${slug}.yml`;

  // 新建（不是編輯既有檔案）時，檔名不能撞到別的既有設定——不然會不小心覆蓋
  // 一份完全無關的手寫設定檔。編輯既有檔案時 originalFilename === filename，
  // 這個檢查本來就會放行。
  if (filename !== originalFilename && fs.existsSync(path.join(BUILD_DIR, filename))) {
    return { ok: false, error: `build/${filename} 已經存在，換一個 productName，或改用「編輯」那份既有設定` };
  }

  const yamlText = renderYaml({
    productName: trimmedName,
    files: whitelistFiles.map((f) => `cards/${f}`),
    cardFile,
    cards: cardsOut,
    deck: deckOut,
    deckAutoFlip: deckAutoOut,
    deckShowcase: deckShowcaseOut,
    deckIntervalSeconds: deckIntervalOut,
    toggleKey: typeof toggleKey === 'string' && toggleKey.trim() ? toggleKey.trim() : null,
    quitKey: typeof quitKey === 'string' && quitKey.trim() ? quitKey.trim() : null,
    resetKey: typeof resetKey === 'string' && resetKey.trim() ? resetKey.trim() : null,
    autoFlipKey: typeof autoFlipKey === 'string' && autoFlipKey.trim() ? autoFlipKey.trim() : null,
    skillKey: typeof skillKey === 'string' && skillKey.trim() ? skillKey.trim() : null,
    rarityKey: typeof rarityKey === 'string' && rarityKey.trim() ? rarityKey.trim() : null,
    muteKey: typeof muteKey === 'string' && muteKey.trim() ? muteKey.trim() : null,
    zoomInKey: typeof zoomInKey === 'string' && zoomInKey.trim() ? zoomInKey.trim() : null,
    zoomOutKey: typeof zoomOutKey === 'string' && zoomOutKey.trim() ? zoomOutKey.trim() : null,
    opacityUpKey: typeof opacityUpKey === 'string' && opacityUpKey.trim() ? opacityUpKey.trim() : null,
    opacityDownKey: typeof opacityDownKey === 'string' && opacityDownKey.trim() ? opacityDownKey.trim() : null,
    exportKey: typeof exportKey === 'string' && exportKey.trim() ? exportKey.trim() : null,
    exportLayoutKey: typeof exportLayoutKey === 'string' && exportLayoutKey.trim() ? exportLayoutKey.trim() : null,
    // 只接受 webm／gif／png；預設 webm 不寫出來（跟其他「同預設值就不寫」的欄位同一種慣例）
    exportFormat: ['gif', 'png'].includes(String(exportFormat || '').toLowerCase()) ? String(exportFormat).toLowerCase() : null,
    // GIF 尺寸倍率：只接受 0.8／1／1.5／2；預設 1.5 不寫出來
    gifScale: [0.8, 1, 2].includes(Number(gifScale)) ? Number(gifScale) : null,
    cycleKey: cycleKeyOut,
    gestureKey: gestureKeyOut,
    skeletonKey: skeletonKeyOut,
    defaultOffset: offsetOut,
    cyclePeriodSeconds: cyclePeriodOut,
    gestureTransitionSeconds: gestureTransitionOut,
    gestureShowSkeleton: gestureShowSkeletonOut,
    cardScale: cardScaleOut,
    launchAtLogin: launchAtLogin === true,
    ambientStars: ambientStars === true,
    extraName: `${slug}-desktop`,
  });

  try {
    if (originalFilename) backupExisting(originalFilename);
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUILD_DIR, filename), yamlText, 'utf8');
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 720,
    title: '🎴 html 白名單管理',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    win = null;
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  });
}

// ==================== 座標挑選器（虛擬卡片） ====================
// 人眼很難光看數字就想像出「x=671, y=-153 到底在螢幕的哪裡」，這個小工具開一個
// 蓋滿整個螢幕、透明背景的視窗，裡面畫一個跟真正卡片格子一樣大（560×820，見
// C:\cat\main.js 的 WIN_W/WIN_H）的虛擬卡片方框，可以直接用滑鼠右鍵拖曳（跟
// 真正掛件的操作手感一致），拖曳中即時把座標送回設定視窗的 x/y 欄位，讓使用者
// 用「眼睛看著螢幕擺」取代「憑空猜數字」。
//
// 這個視窗跟真正的多卡合一舞台視窗用同一個座標系統：兩者都固定在螢幕
// (0,0)、大小都是 screen.getPrimaryDisplay().workAreaSize，所以虛擬卡片方框的
// CSS left/top 座標可以直接對應到 cards[].x/y，不用另外換算。
//
// 層級：挑選器視窗（虛擬卡片）要蓋過使用者桌面上其他應用程式的視窗，不然
// 使用者根本看不到虛擬卡片、沒辦法對著桌面實際內容擺位置——用
// alwaysOnTop(true,'screen-saver')（Electron 支援的最高置頂等級，跟
// C:\cat\main.js 桌面掛件本體同一招）確保這點。但這樣一來，挑選器視窗會被拉到
// 跟「一般視窗」不同的更高 z-order 層級，單純的 win.moveTop() 沒辦法再把設定
// 視窗（html 白名單管理主視窗）壓到它上面——所以挑選器開著的期間，也把設定
// 視窗一起升到同一個 alwaysOnTop 等級（screen-saver），這樣兩者都在最上層那個
// 層級裡，moveTop() 才能在「同層級內」把設定視窗排到挑選器前面，讓使用者
// 一邊拖著虛擬卡片、一邊還看得到設定視窗（含下面「📐 座標定義與預覽」那個
// 面板即時更新的畫面）——不是靠 focusable:false 硬凹，這樣才穩定。
// ⚠️ 這裡以前是完全不敢動設定視窗的 alwaysOnTop，因為踩過 Electron/Chromium
// 已知的雷：BrowserWindow 設 alwaysOnTop 之後，那個視窗裡原生 <select> 下拉
// 選單的彈出清單會整個不會顯示——但 index.html 的下拉選單後來已經整個換成
// 自己刻的 .custom-select（純 DOM/CSS，不用原生 <select>，見 index.html
// renderSlotEditor() 的說明），不會再踩到這個雷，才能放心讓設定視窗也
// alwaysOnTop。挑選器關閉時（pickerWin 的 'closed' 事件）要把設定視窗的
// alwaysOnTop 還原掉，不然使用者沒在挑座標的時候，這個視窗也會一直蓋在其他
// 應用程式上面，變成擾人的行為。
//
// 沒有拖到虛擬卡片本身的滑鼠事件要讓它整個穿透下去（不擋住底下桌面/其他視窗）
// ——用跟主程式卡片外殼同一種 setIgnoreMouseEvents({forward:true}) 技巧，只是這裡
// 是用滑鼠是否移到方框範圍內即時切換（picker.html 自己算命中測試、透過
// picker-preload.js 送 IPC 通知這裡切換），不是用全域快捷鍵切換整個視窗。
let pickerWin = null;
let pickerTargetIndex = null;

function openCoordPicker(payload) {
  const { index, x, y, file, w, h } = payload || {};
  // index 平常是格位陣列的數字索引（多卡模式），但單卡模式的座標挑選器沒有
  // 「第幾格」這種概念，用字串 'single' 當標記——這裡只是原樣存起來，之後
  // picker-move 事件會照樣把它送回 renderer，renderer 自己判斷是數字（多卡
  // 格位）還是 'single'（單卡開機位置），main.js 完全不用理解這個值的意義。
  pickerTargetIndex = index !== undefined && index !== null ? index : null;
  const initData = {
    index: pickerTargetIndex,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    file: typeof file === 'string' ? file : '',
    w: Number.isFinite(w) ? w : 560,
    h: Number.isFinite(h) ? h : 820,
  };

  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.webContents.send('picker-init', initData);
    if (win && !win.isDestroyed()) win.moveTop();
    return { ok: true };
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  pickerWin = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // 不搶焦點，滑鼠點它／拖它不會把鍵盤焦點從設定視窗搶走
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'picker-preload.js'),
    },
  });
  // 挑選器要蓋過桌面上其他應用程式，見上面的說明。設定視窗一起升到同一個
  // 頂層等級，moveTop() 才能在這個共用頂層裡把設定視窗排到挑選器前面。
  pickerWin.setAlwaysOnTop(true, 'screen-saver');
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');

  pickerWin.setIgnoreMouseEvents(true, { forward: true }); // 預設整個穿透，滑鼠移到方框上才切換成可互動
  pickerWin.loadFile(path.join(__dirname, 'picker.html'));
  pickerWin.webContents.on('did-finish-load', () => {
    pickerWin.webContents.send('picker-init', initData);
    // 新視窗預設會插進它所在 z-order 層級的最上層，喬一次讓設定視窗蓋回上面
    // （見上面說明，兩者現在同一個 alwaysOnTop 頂層等級，moveTop() 才排得動；
    // 之後 focusable:false 會讓這個順序一直維持，不用每次互動都重喬）。
    if (win && !win.isDestroyed()) win.moveTop();
  });
  pickerWin.on('closed', () => {
    pickerWin = null;
    pickerTargetIndex = null;
    // 挑選器關掉了，設定視窗不需要再蓋過其他應用程式，還原成一般視窗層級，
    // 不然使用者沒在挑座標時，這個視窗也會一直擋在其他程式前面很擾人。
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
    if (win && !win.isDestroyed()) win.webContents.send('bg-picker-closed');
  });

  return { ok: true };
}

ipcMain.handle('bg-open-picker', (_e, payload) => openCoordPicker(payload));
ipcMain.on('picker-hover', (_e, hover) => {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.setIgnoreMouseEvents(!hover, { forward: true });
});
ipcMain.on('picker-move', (_e, pos) => {
  if (win && !win.isDestroyed() && pickerTargetIndex !== null) {
    win.webContents.send('bg-picker-move', { index: pickerTargetIndex, x: Math.round(pos.x), y: Math.round(pos.y) });
  }
});
ipcMain.on('picker-close', () => {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
});
// 讓設定視窗自己（不是挑選器視窗）也能主動關掉挑選器——例如使用者切換去編輯
// 另一份設定、或切回單卡模式時，原本挑選器指到的那一格已經不存在意義了。
ipcMain.handle('bg-close-picker', () => {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  return { ok: true };
});

// 一鍵打包：直接呼叫 electron-builder，等同手動下
// `npx electron-builder --config build/<filename>`，只是不用開終端機自己打指令。
// 同一時間只允許一個打包工作在跑——electron-builder 共用同一個 dist/ 輸出資料夾
// 跟同一份全域快取（下載過的 winCodeSign/7za 等工具），兩個同時跑容易互相踩到，
// 不值得為了「兩個 build 同時打包」這種少見情境增加複雜度，使用者等前一個包完
// 再按下一個就好。
let packagingFilename = null;
let packagingChild = null; // 目前正在跑的 electron-builder 子程序，取消打包（cancelPackaging()）要用它的 pid
let packagingCancelled = false; // 使用者主動取消 vs. electron-builder 自己失敗，close 事件要分開回報

function sendPackageLog(filename, text) {
  if (win && !win.isDestroyed()) win.webContents.send('bg-package-log', { filename, text });
}

function packageBuild(filename) {
  return new Promise((resolve) => {
    if (packagingFilename) {
      resolve({ ok: false, error: `目前正在打包「${packagingFilename}」，請等它完成再試一次` });
      return;
    }
    const full = path.join(BUILD_DIR, filename);
    if (!fs.existsSync(full)) {
      resolve({ ok: false, error: `找不到 build/${filename}` });
      return;
    }
    packagingFilename = filename;
    packagingCancelled = false;

    let child;
    try {
      // 用系統的 node 執行 electron-builder 的 cli.js，見上面 ELECTRON_BUILDER_CLI
      // 開頭那段說明——這裡不能用這個視窗自己的 electron.exe，實測會被
      // electron-builder CLI 誤判成參數解析失敗。
      child = spawn(NODE_BIN, [ELECTRON_BUILDER_CLI, '--config', path.join('build', filename)], {
        cwd: ROOT_DIR,
      });
      packagingChild = child;
    } catch (err) {
      packagingFilename = null;
      resolve({ ok: false, error: `啟動 electron-builder 失敗（找不到系統的 node？）：${err.message}` });
      return;
    }

    let stderrTail = '';
    child.stdout.on('data', (chunk) => sendPackageLog(filename, chunk.toString()));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000); // 失敗時附在錯誤訊息裡，只留最後一截，避免訊息炸開
      sendPackageLog(filename, text);
    });
    child.on('error', (err) => {
      packagingFilename = null;
      packagingChild = null;
      resolve({ ok: false, error: `啟動 electron-builder 失敗：${err.message}` });
    });
    child.on('close', (code) => {
      packagingFilename = null;
      packagingChild = null;
      const wasCancelled = packagingCancelled;
      packagingCancelled = false;
      if (wasCancelled) {
        // cancelPackaging() 已經把打包中途砍掉，這裡不是真正的「打包失敗」，
        // 用 cancelled 欄位讓 renderer 分開顯示，不要跟一般錯誤混在一起。
        resolve({ ok: false, cancelled: true, error: '使用者取消了打包' });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, error: `electron-builder 結束代碼 ${code}${stderrTail ? '\n\n' + stderrTail : ''}` });
        return;
      }
      // 打包成功後的 exe 路徑：跟 electron-builder.yml 的
      // portable.artifactName: "${productName}.exe" 算法一致，這裡直接讀該
      // build 檔的 productName 組出來，給「開啟所在資料夾」按鈕用。
      let exePath = null;
      try {
        const doc = yaml.load(fs.readFileSync(full, 'utf8')) || {};
        if (doc.productName) exePath = path.join(DIST_DIR, `${doc.productName}.exe`);
      } catch { /* 讀不到就不給路徑，不影響「打包成功」這個結果本身 */ }
      resolve({ ok: true, exePath });
    });
  });
}

// 打包中途取消：electron-builder 的 CLI 進程本身還會再往下 spawn 好幾層子
// 程序（實際做壓縮/打包的工具、可能的簽章工具等）——這份專案這次工作階段已經
// 實際踩過好幾次「只殺掉最外層那個 spawn() 出來的程序，底下的子程序沒有一起
// 死掉、殘留在背景繼續跑」的問題（Windows 沒有 POSIX 那種以 process group 為
// 單位整批收掉子程序的機制，Node 的 child.kill() 預設只送信號給那一個
// process），得靠系統的 `taskkill /T /F` 才能把整棵程序樹一次砍乾淨，跟這次
// 工作階段手動清殘留程序用的是同一招。取消後 electron-builder 一定會用非零
// 結束碼觸發上面 packageBuild() 的 'close' 事件，真正把 packagingFilename 清
// 掉、回報結果給 renderer 的邏輯都在那裡，這裡只負責「砍」，不用自己另外去
// resolve 任何 promise。
function cancelPackaging() {
  if (!packagingChild || !packagingFilename) {
    return { ok: false, error: '目前沒有正在打包的工作可以取消' };
  }
  packagingCancelled = true;
  try {
    spawn('taskkill', ['/PID', String(packagingChild.pid), '/T', '/F']);
  } catch (err) {
    packagingCancelled = false;
    return { ok: false, error: `取消失敗：${err.message}` };
  }
  return { ok: true };
}

// 刪除一份設定檔。跟存檔同一個安全網：刪之前先備份到 build/.bak/（見
// backupExisting()），C:\cat 沒有 git，這是唯一救得回來的方式——「確定要刪除」
// 這種確認對話框是 renderer 端的 window.confirm() 負責問，這裡只管實際刪檔，
// 不重複做一次確認。
// ==================== ▶️ 預覽（不打包，等同 npm start） ====================
// 用這個 GUI 自己的 electron.exe 直接跑 C:\cat（桌面掛件本體），把 build/*.yml 的 extraMetadata 寫成 JSON、
// 用環境變數 CARD_SHELL_CONFIG 疊在 package.json 上（等同打包時合併進封裝的 package.json，見 C:\cat\main.js 開頭）。
// 每次預覽都用一個清空的 userData（--user-data-dir）：不會被上次預覽存下的位置／縮放蓋掉 GUI 裡剛調好的設定，
// 也不會碰到打包好的 exe 或 npm start 的存檔。LAUNCH_AT_LOGIN=false：預覽絕不改開機自啟的登錄值。
// 同一時間只跑一個預覽，再按一次（或換一份設定）會先關掉舊的；GUI 關閉時也一起關掉。
let previewChild = null;
let previewFilename = null;

function sendPreviewState(extra) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('bg-preview-state', Object.assign({ running: !!previewChild, filename: previewFilename }, extra || {}));
  }
}

function stopPreview() {
  const child = previewChild;
  if (!child) return;
  previewChild = null;
  // Electron 有 GPU／渲染等子行程，Windows 上用 taskkill /T 整棵關掉（只殺主行程時子行程會多留一下、佔著 userData）
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(child.pid);
  } catch (e) { /* 已經自己結束了 */ }
}

function startPreview(filename) {
  const full = path.join(BUILD_DIR, filename);
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(full, 'utf8')) || {};
  } catch (err) {
    return { ok: false, error: `讀不到 build/${filename}：${err.message}` };
  }
  const meta = Object.assign({}, doc.extraMetadata || {});
  stopPreview();

  // 固定用專屬資料夾（不跟著 GUI 的 userData 走——GUI 用 `electron builder-gui/main.js` 啟動時 userData 是
  // Electron 共用的預設資料夾），每次預覽前清空 userdata。
  const previewRoot = path.join(app.getPath('appData'), 'phantom-card-preview');
  const configPath = path.join(previewRoot, 'config.json');
  // 每次都用新的 userdata 資料夾：剛關掉的上一個預覽可能還佔著舊資料夾（子行程晚一點才結束），
  // 直接清空會被拒絕存取。舊的盡量刪，刪不掉（還在用）就留到下次再刪。
  const userDataDir = path.join(previewRoot, `userdata-${Date.now()}`);
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(meta), 'utf8');
  } catch (err) {
    return { ok: false, error: `準備預覽資料夾失敗：${err.message}` };
  }
  for (const d of fs.readdirSync(previewRoot)) {
    const full = path.join(previewRoot, d);
    if (d.startsWith('userdata') && full !== userDataDir) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { /* 還在用，下次再刪 */ }
    }
  }

  const env = Object.assign({}, process.env, { CARD_SHELL_CONFIG: configPath, LAUNCH_AT_LOGIN: 'false' });
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CARD_FILE', 'CARDS_JSON', 'DECK_JSON']) delete env[k];
  let child;
  try {
    child = spawn(process.execPath, [ROOT_DIR, `--user-data-dir=${userDataDir}`], { cwd: ROOT_DIR, env });
  } catch (err) {
    return { ok: false, error: `啟動預覽失敗：${err.message}` };
  }
  previewChild = child;
  previewFilename = filename;
  let tail = '';
  const onData = (chunk) => { tail = (tail + chunk.toString()).slice(-3000); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const startedAt = Date.now();
  child.on('exit', (code) => {
    if (previewChild !== child) return; // 被新的預覽取代，不用回報
    previewChild = null;
    // 幾秒內就非正常結束＝多半是設定有問題（例如找不到卡片），把輸出最後一截帶給畫面
    const crashed = code !== 0 && code !== null && Date.now() - startedAt < 8000;
    sendPreviewState(crashed ? { error: `預覽程式結束（代碼 ${code}）：\n${tail.slice(-800)}` } : {});
  });
  sendPreviewState();
  return { ok: true };
}

ipcMain.handle('bg-start-preview', (_e, filename) => startPreview(filename));
ipcMain.handle('bg-stop-preview', () => { stopPreview(); sendPreviewState(); return { ok: true }; });
app.on('will-quit', stopPreview);

function deleteBuild(filename) {
  if (packagingFilename === filename) {
    return { ok: false, error: `「${filename}」正在打包中，請等打包完成再刪除` };
  }
  const full = path.join(BUILD_DIR, filename);
  if (!fs.existsSync(full)) return { ok: false, error: `找不到 build/${filename}` };
  try {
    backupExisting(filename);
    fs.unlinkSync(full);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 單卡模式的座標挑選器/預覽要換算「相對螢幕正中央的偏移量」跟「螢幕上的
// 絕對位置」，換算公式要跟 C:\cat\main.js 的 createSingleWindow() 完全一致
// （用 workAreaSize，不是 size——工作區已經扣掉工作列，跟實際視窗置中時用的
// 是同一個基準，否則挑選器選出來的座標會跟卡片實際顯示的位置對不起來）。
ipcMain.handle('bg-get-screen-size', () => screen.getPrimaryDisplay().workAreaSize);

ipcMain.handle('bg-list-cards', () => listCardFiles());
ipcMain.handle('bg-list-builds', () => listBuilds());
ipcMain.handle('bg-save-build', (_e, payload) => saveBuild(payload));
ipcMain.handle('bg-package-build', (_e, filename) => packageBuild(filename));
ipcMain.handle('bg-cancel-package', () => cancelPackaging());
ipcMain.handle('bg-delete-build', (_e, filename) => deleteBuild(filename));
ipcMain.handle('bg-reveal-file', (_e, filePath) => {
  if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

// ==================== 圖片一鍵生成卡片 ====================
// 「🪄 圖片一鍵生成卡片」：把使用者拖進來的圖片交給 C:\cat\card-maker\make_card.py
// （去背 → 抽主色 → 推導配色/全息色階 → 填模板 → 輸出 cards/<名稱>_phantom_card.html）。
// 這裡只負責：找 Python、把欄位寫成 params.json（不用命令列傳中文，避開 Windows 編碼/
// 引號問題）、啟動子程序、把它 stdout 上 `@@{json}` 的進度行轉給視窗。產出直接寫進
// cards/，跟手做的卡片一樣會被 listCardFiles() 掃到、可以拿去打包。
const os = require('os');
const MAKE_CARD_SCRIPT = path.join(ROOT_DIR, 'card-maker', 'make_card.py');
let makeCardProc = null;

// 找一個裝有 rembg 的 Python：環境變數 CARD_PYTHON > 常見的 anaconda/miniconda 位置 >
// 系統 PATH 的 python。（rembg 很肥，使用者的專案本來就是靠 anaconda 那份。）
function findPython() {
  const home = os.homedir();
  const candidates = [
    process.env.CARD_PYTHON,
    path.join(home, 'anaconda3', 'python.exe'),
    path.join(home, 'miniconda3', 'python.exe'),
    'C:/ProgramData/anaconda3/python.exe',
    'C:/ProgramData/miniconda3/python.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* 換下一個 */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function makeCard(payload, sender) {
  return new Promise((resolve) => {
    if (makeCardProc) return resolve({ ok: false, code: 'busy', error: '上一張還在生成中，請等它完成（或先取消）。' });
    if (!fs.existsSync(MAKE_CARD_SCRIPT)) {
      return resolve({ ok: false, code: 'no_script', error: `找不到 ${MAKE_CARD_SCRIPT}` });
    }
    const p = payload || {};
    let tmpDir = null;
    let imagePath = typeof p.imagePath === 'string' && p.imagePath ? p.imagePath : '';
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-maker-'));
      if (imagePath) {
        if (!fs.statSync(imagePath).isFile()) throw new Error('不是檔案');
      } else if (p.imageData) {
        // 貼上的圖片沒有實體路徑：把位元組寫成暫存檔再交給 Python。
        const ext = (/\.(png|jpe?g|webp|bmp|gif)$/i.exec(str(p.imageName, 200)) || ['.png'])[0].toLowerCase();
        imagePath = path.join(tmpDir, 'input' + ext);
        fs.writeFileSync(imagePath, Buffer.from(p.imageData));
      } else {
        throw new Error('沒有收到圖片');
      }
      const params = {
        image: imagePath,
        name: str(p.name, 40), eyebrow: str(p.eyebrow, 60),
        skill_name: str(p.skillName, 30), skill_en: str(p.skillEn, 50), skill_desc: str(p.skillDesc, 200),
        element: str(p.element, 30), glyph: str(p.glyph, 2), rarity: str(p.rarity, 4),
        model: str(p.model, 30), holo: str(p.holo, 30),
        out_dir: CARDS_DIR, overwrite: p.overwrite === true,
      };
      fs.writeFileSync(path.join(tmpDir, 'params.json'), JSON.stringify(params), 'utf8');
    } catch (err) {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      return resolve({ ok: false, code: 'bad_input', error: `讀取圖片失敗：${err.message}` });
    }

    const python = findPython();
    const send = (evt) => { try { if (!sender.isDestroyed()) sender.send('bg-make-card-log', evt); } catch (e) { /* 視窗已關 */ } };
    let result = null;
    let tail = [];
    let buf = '';
    let cancelled = false;
    const cleanup = () => { makeCardProc = null; fs.rmSync(tmpDir, { recursive: true, force: true }); };

    const handleLine = (line) => {
      if (!line.trim()) return;
      if (line.startsWith('@@')) {
        try {
          const evt = JSON.parse(line.slice(2));
          if (evt.event === 'done') result = { ok: true, ...evt };
          else if (evt.event === 'error') result = { ok: false, code: evt.code, error: evt.message };
          else send(evt);
        } catch (e) { /* 壞掉的進度行直接忽略 */ }
      } else {
        tail.push(line); if (tail.length > 40) tail.shift();
        send({ event: 'log', text: line.slice(0, 300) });
      }
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    };

    const proc = spawn(python, ['-X', 'utf8', MAKE_CARD_SCRIPT, '--params', path.join(tmpDir, 'params.json')], {
      cwd: path.dirname(MAKE_CARD_SCRIPT),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    makeCardProc = proc;
    proc.cancel = () => { cancelled = true; try { proc.kill(); } catch (e) { /* 已結束 */ } };
    const timer = setTimeout(() => proc.cancel(), 15 * 60 * 1000); // 第一次下載模型可能很久，但不該無限等
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer); cleanup();
      resolve({ ok: false, code: 'no_python', error: `無法啟動 Python（${python}）：${err.message}。可用環境變數 CARD_PYTHON 指定裝有 rembg 的 python.exe。` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (buf) handleLine(buf);
      cleanup();
      if (cancelled) return resolve({ ok: false, code: 'cancelled', error: '已取消。' });
      if (result) return resolve(result);
      resolve({ ok: false, code: 'crashed', error: `生成程序異常結束（結束碼 ${code}）。\n${tail.slice(-8).join('\n')}` });
    });
  });
}

ipcMain.handle('bg-make-card', (e, payload) => makeCard(payload, e.sender));
ipcMain.handle('bg-cancel-make-card', () => { if (makeCardProc) makeCardProc.cancel(); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
