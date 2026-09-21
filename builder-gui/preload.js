'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('builderGui', {
  listCards: () => ipcRenderer.invoke('bg-list-cards'),
  listBuilds: () => ipcRenderer.invoke('bg-list-builds'),
  saveBuild: (payload) => ipcRenderer.invoke('bg-save-build', payload),
  deleteBuild: (filename) => ipcRenderer.invoke('bg-delete-build', filename),

  // 一鍵打包：packageBuild() 的 promise 要等 electron-builder 真的跑完才會
  // resolve（可能要幾十秒），過程中的即時輸出另外用 onPackageLog 訂閱。
  packageBuild: (filename) => ipcRenderer.invoke('bg-package-build', filename),
  onPackageLog: (callback) => ipcRenderer.on('bg-package-log', (_event, data) => callback(data)),
  revealFile: (filePath) => ipcRenderer.invoke('bg-reveal-file', filePath),
  // 打包中途取消：main.js 的 cancelPackaging() 只負責把目前那個 electron-builder
  // 子程序砍掉，原本 packageBuild() 那個還沒 resolve 的 promise 會在它自己的
  // 'close' 事件裡分辨出這是被取消的、回傳 { cancelled:true }，不是這裡直接
  // resolve 一個新結果。
  cancelPackage: () => ipcRenderer.invoke('bg-cancel-package'),

  // 座標挑選器（虛擬卡片）：見 main.js openCoordPicker() 開頭的說明。
  openCoordPicker: (payload) => ipcRenderer.invoke('bg-open-picker', payload),
  closePicker: () => ipcRenderer.invoke('bg-close-picker'),
  onPickerMove: (callback) => ipcRenderer.on('bg-picker-move', (_event, data) => callback(data)),
  onPickerClosed: (callback) => ipcRenderer.on('bg-picker-closed', () => callback()),

  // 單卡模式的座標挑選器/預覽需要知道螢幕工作區大小才能換算「相對螢幕正中央
  // 的偏移量」跟「螢幕上的絕對位置」，這個換算只有主行程能拿到 Electron 的
  // screen 模組，見 main.js 的 ipcMain.handle('bg-get-screen-size', ...)。
  getScreenSize: () => ipcRenderer.invoke('bg-get-screen-size'),

  // 圖片一鍵生成卡片：拖進來的 File 物件在 contextIsolation 下拿不到實體路徑，要靠
  // webUtils.getPathForFile()（貼上的圖片沒有路徑，回傳空字串，改傳位元組）。
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  makeCard: (payload) => ipcRenderer.invoke('bg-make-card', payload),
  cancelMakeCard: () => ipcRenderer.invoke('bg-cancel-make-card'),
  onMakeCardLog: (callback) => ipcRenderer.on('bg-make-card-log', (_event, data) => callback(data)),
});
