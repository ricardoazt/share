// Ponte segura entre a página do painel (www/panel.js) e o processo principal.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('PulseSharePanel', {
  info: () => ipcRenderer.invoke('panel-info'),
  sign: (text) => ipcRenderer.invoke('panel-sign', String(text || '')),
  importKey: () => ipcRenderer.invoke('panel-import-key'),
  exportKey: () => ipcRenderer.invoke('panel-export-key'),
  generateKey: () => ipcRenderer.invoke('panel-generate-key'),
  saveCsv: (csv) => ipcRenderer.invoke('panel-save-csv', String(csv || ''))
});
