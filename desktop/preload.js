// Ponte segura entre o app (www/app.js) e o processo principal do Electron.
// O app detecta o desktop por window.PulseShareDesktop (IS_DESKTOP).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = {};
ipcRenderer.on('ps-event', (e, name, data) => {
  (listeners[name] || []).forEach((fn) => { try { fn(data); } catch (err) { console.error(err); } });
});

contextBridge.exposeInMainWorld('PulseShareDesktop', {
  platform: process.platform,
  info: () => ipcRenderer.sendSync('ps-app-info'),
  notify: (title, body, tag) => ipcRenderer.send('ps-notify', { title: String(title || ''), body: String(body || ''), tag: String(tag || '') }),
  uiOpened: () => ipcRenderer.send('ps-ui-open'),
  setBackgroundMode: (on, fromUser) => ipcRenderer.send('ps-set-background', Boolean(on), Boolean(fromUser)),
  getDownloadDirectory: () => ipcRenderer.sendSync('ps-get-download-dir'),
  setDownloadDirectory: (folder) => ipcRenderer.sendSync('ps-set-download-dir', String(folder || '')),
  openDownloadFolder: () => ipcRenderer.send('ps-open-download-dir'),
  openPath: (p) => ipcRenderer.send('ps-open-path', String(p || '')),
  showInFolder: (p) => ipcRenderer.send('ps-show-in-folder', String(p || '')),
  openExternal: (url) => ipcRenderer.send('ps-open-external', String(url || '')),
  // { chat: '@tag' | '', links: ['pulseshare://…'] } passados na linha de comando
  consumeLaunch: () => ipcRenderer.sendSync('ps-consume-launch'),
  // Eventos: 'open-chat' (tag), 'open-links' ([url]), 'download-done' ({name, path})
  on: (name, fn) => {
    if (typeof fn !== 'function') return;
    (listeners[name] = listeners[name] || []).push(fn);
  }
});
