'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onInit: (callback) => ipcRenderer.on('picker-init', (_event, data) => callback(data)),
  move: (x, y) => ipcRenderer.send('picker-move', { x, y }),
  hover: (isHover) => ipcRenderer.send('picker-hover', isHover),
  close: () => ipcRenderer.send('picker-close'),
});
