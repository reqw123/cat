// 匯出編碼器頁面（encoder.html）的 preload：只開放「收設定／收畫面／回結果」這幾個動作，
// 頁面本身拿不到 Node/Electron 其他 API（跟 preload.js 同一種最小權限的做法）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardExportEnc', {
  onInit: (cb) => ipcRenderer.on('cx-init', (_e, cfg) => cb(cfg)),
  onFrame: (cb) => ipcRenderer.on('cx-frame', (_e, index, bytes) => cb(index, bytes)),
  onFinish: (cb) => ipcRenderer.on('cx-finish', () => cb()),
  ready: () => ipcRenderer.send('cx-ready'),
  done: (result) => ipcRenderer.send('cx-done', result),
  progress: (n) => ipcRenderer.send('cx-progress', n),
});
