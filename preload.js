// contextIsolation:true 時，渲染頁面（卡片本身的 html）拿不到 Node/Electron
// API，只能用這裡透過 contextBridge 開放出去的東西。只暴露「移動位置」這幾個
// 動作，不整個開放 ipcRenderer，避免卡片頁面（含它載入的 Google Fonts 等外部
// 資源）萬一被動了手腳也頂多只能亂喬卡片位置，碰不到檔案系統或其他 API。
//
// preload 會套用到這個 webContents 底下所有 frame（含 iframe），單卡模式裡
// 卡片本身就是最上層 frame，多卡模式裡卡片是被嵌進 stage 頁面的 iframe——
// moveBy() 用 window.top === window.self 判斷自己是哪一種，卡片的拖曳腳本
// （main.js 的 INJECTED_SCRIPT）完全不用知道現在在哪種模式下執行。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardShell', {
  moveBy: (dx, dy) => {
    if (window.top === window.self) {
      ipcRenderer.send('card-move-by', dx, dy);
    } else {
      window.parent.postMessage({ __phantomCardMove: true, dx, dy }, '*');
    }
  },
  // 只給多卡模式的 stage 頁面（最上層 frame）用：某個卡片格位挪動後，把新位置
  // 存進 main.js 那邊的 card-slots.json。
  // view（可選）＝{zoom, opacity}；x/y 傳 null 表示只更新縮放/透明度。
  saveSlot: (idx, x, y, view) => ipcRenderer.send('card-slot-save', idx, x, y, view),

  // 縮放／透明度（滾輪、中鍵）：kind＝'zoom'｜'opacity'｜'reset'，dir＝+1／-1。跟 moveBy 一樣依自己是
  // 最上層視窗（單卡）還是 iframe（多卡）決定送 IPC 給 main.js，或 postMessage 給 stage 頁面。
  viewBy: (kind, dir, big) => {
    if (window.top === window.self) {
      ipcRenderer.send('view-by', kind, dir, !!big);
    } else {
      window.parent.postMessage({ __phantomCardViewBy: { kind, dir, big: !!big } }, '*');
    }
  },
  // 快捷鍵／系統匣指令（只有多卡的 stage 頁面用；單卡 main.js 直接處理）。
  onViewCommand: (callback) => ipcRenderer.on('view-cmd', (_event, cmd) => callback(cmd)),

  // 時鐘式循環的開關通知：main.js 按下 CYCLE_KEY 全域快捷鍵時會送
  // 'cycle-toggle' 給 stage 頁面，callback 自己決定開/關（同一個事件切換），
  // 只有 3 張以上的多卡合一才會用到，見 main.js buildStageHtml()。
  onCycleToggle: (callback) => ipcRenderer.on('cycle-toggle', callback),
  // 循環實際變成開／關之後回報給 main.js（why＝'drag' 表示是拖曳卡片造成的自動暫停），main.js 據此在畫面上顯示「已開始／已暫停」。
  reportCycle: (running, why) => ipcRenderer.send('cycle-state', !!running, why || ''),
  // 手勢辨識（kind='gesture'，why='camera' 表示攝影機開不起來）／手部骨架（kind='skeleton'）實際變成開／關之後回報，main.js 顯示畫面提示。
  reportToggle: (kind, on, why) => ipcRenderer.send('toggle-state', String(kind), !!on, why || ''),

  // 手勢散開/收縮的開關通知：main.js 按下 GESTURE_KEY 全域快捷鍵時會送
  // 'gesture-toggle' 給 stage 頁面（同一個鍵開/關切換）——開啟才會真的去要
  // 攝影機權限、啟動 MediaPipe 偵測，關閉時停用攝影機並讓卡片飄回原始座標，
  // 見 main.js buildStageHtml()。任何張數的多卡合一都用得到，不像時鐘循環
  // 要 3 張以上。
  onGestureToggle: (callback) => ipcRenderer.on('gesture-toggle', callback),

  // 手部骨架視覺效果（發光骨架疊圖）的開關通知：系統匣選單點「手部骨架視覺
  // 效果」時會送 'skeleton-toggle'（同一個項目開/關切換），只是要不要「畫出
  // 來」，完全不影響手勢辨識本身的準確度或速度，見 main.js buildStageHtml()
  // 裡 SHOW_SKELETON 那段說明。
  onSkeletonToggle: (callback) => ipcRenderer.on('skeleton-toggle', callback),

  // 每秒自動翻面循環的開關通知：main.js 按下 AUTOFLIP_KEY 全域快捷鍵（或點系統
  // 匣選單同一項）時會送 'autoflip-toggle' 給 stage 頁面，callback 自己決定把
  // 這個開關訊息轉發給每張卡片的 iframe（見 main.js buildStageHtml() 的
  // broadcastAutoFlipToggle()）。只有多卡模式的 stage 頁面會用到——單卡模式
  // main.js 直接對卡片本身的 frame 呼叫 executeJavaScript，不會走這條 IPC。
  onAutoFlipToggle: (callback) => ipcRenderer.on('autoflip-toggle', callback),

  // card-fx 指令（'cast' 技能演出 / 'rarity' 切換稀有度 / 'mute' 靜音）：只有多卡模式的 stage
  // 頁面會用到，收到後由它 postMessage 轉發進每張卡片的 iframe（單卡模式 main.js 直接
  // 對卡片頁面 executeJavaScript）。
  onFxCommand: (callback) => ipcRenderer.on('fx-cmd', (_event, cmd) => callback(cmd)),

  // 點擊穿透模式下的全域滑鼠追蹤：穿透時視窗本身收不到滑鼠事件，main.js 改用
  // screen.getCursorScreenPoint() 輪詢游標位置，換算成「相對這個視窗內容區左上角」
  // 的座標送 'cursor-pos'（滑鼠離開穿透模式的追蹤範圍時送 null）。單卡模式由
  // main.js 的 INJECTED_SCRIPT 直接接這個事件；多卡模式由 stage 頁面接住後，
  // 依每個 iframe 的位置換算成 iframe 內座標再 postMessage 給各卡片。
  // callback 只收到純資料 {x, y} 或 null，不會把 IPC event 物件暴露給頁面。
  onCursor: (callback) => ipcRenderer.on('cursor-pos', (_event, point) => callback(point)),

  // 牌組模式：舞台頁每次換卡回報目前是第幾張，main.js 據此決定「匯出分享」匯出哪一張。
  reportDeck: (idx) => ipcRenderer.send('deck-current', Number(idx)),
});
