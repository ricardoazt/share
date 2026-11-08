// PulseSharePanel — painel administrativo da rede PulseShare (Electron, Linux)
// A chave PRIVADA do administrador fica só aqui no processo principal
// (<userData>/admin-key.pem, permissão 0600). A página (www/panel.js) pede
// assinaturas por IPC; os apps conferem com a chave pública embutida no app.js
// (ADMIN_PUBLIC_KEYS).
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const WWW = path.join(__dirname, 'www');
const ICON = path.join(WWW, 'icons', 'icon512.png');
const DEFAULT_TOPIC = 'pulseshare/v2/p2p_mesh_global';

app.setName('PulseSharePanel');
// Perfil separado (testes): PULSESHARE_PANEL_PROFILE=/pasta pulseshare-panel
if (process.env.PULSESHARE_PANEL_PROFILE) app.setPath('userData', path.resolve(process.env.PULSESHARE_PANEL_PROFILE));
if (process.platform === 'linux' && app.setDesktopName) app.setDesktopName('pulseshare-panel.desktop');

// ---------- chave do administrador ----------
const KEY_FILE = () => path.join(app.getPath('userData'), 'admin-key.pem');
let adminKey = null;

function parseKey(pem) {
  const key = crypto.createPrivateKey(String(pem));
  const d = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== 'ec' || d.namedCurve !== 'prime256v1') throw new Error('A chave precisa ser ECDSA P-256.');
  return key;
}

function loadKey() {
  adminKey = null;
  try { adminKey = parseKey(fs.readFileSync(KEY_FILE(), 'utf8')); } catch (e) { adminKey = null; }
}

function writeKey(key) {
  fs.mkdirSync(path.dirname(KEY_FILE()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE(), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(KEY_FILE(), 0o600);
  adminKey = key;
}

function keyInfo() {
  const info = {
    hasKey: Boolean(adminKey),
    publicKey: null,
    fingerprint: '',
    topic: process.env.PULSESHARE_TOPIC || DEFAULT_TOPIC,
    brokers: process.env.PULSESHARE_BROKERS ? process.env.PULSESHARE_BROKERS.split(',').map((s) => s.trim()).filter(Boolean) : null,
    version: app.getVersion(),
    keyFile: KEY_FILE()
  };
  if (adminKey) {
    const jwk = crypto.createPublicKey(adminKey).export({ format: 'jwk' });
    info.publicKey = { x: jwk.x, y: jwk.y };
    info.fingerprint = crypto.createHash('sha256').update(jwk.x + '.' + jwk.y).digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1:');
  }
  return info;
}

// ---------- janela ----------
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: 'PulseSharePanel',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });
  win.removeMenu();
  win.loadFile(path.join(WWW, 'panel.html'));
  // Links externos no navegador padrão; nada de navegar para fora do painel
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // O painel não precisa de câmera, microfone, notificações etc.
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    loadKey();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- IPC ----------
ipcMain.handle('panel-info', () => keyInfo());

ipcMain.handle('panel-sign', (e, text) => {
  if (!adminKey) throw new Error('Sem chave de administrador neste computador.');
  text = String(text || '');
  if (!text || text.length > 8000) throw new Error('Registro inválido.');
  let body;
  try { body = JSON.parse(text); } catch (err) { throw new Error('Registro inválido.'); }
  if (!body || body.v !== 1 || !/^adm_[a-z0-9_]{6,48}$/.test(String(body.id || ''))) throw new Error('Registro inválido.');
  const sig = crypto.sign('sha256', Buffer.from(text, 'utf8'), { key: adminKey, dsaEncoding: 'ieee-p1363' });
  return sig.toString('base64url');
});

ipcMain.handle('panel-import-key', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importar chave do administrador',
    properties: ['openFile'],
    filters: [{ name: 'Chave PEM', extensions: ['pem', 'key', 'txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true, ...keyInfo() };
  const key = parseKey(fs.readFileSync(r.filePaths[0], 'utf8'));
  writeKey(key);
  return keyInfo();
});

ipcMain.handle('panel-export-key', async () => {
  if (!adminKey) throw new Error('Sem chave para exportar.');
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar cópia da chave do administrador',
    defaultPath: path.join(app.getPath('documents'), 'pulseshare-admin-key.pem'),
    filters: [{ name: 'Chave PEM', extensions: ['pem'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, adminKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(r.filePath, 0o600);
  return { path: r.filePath };
});

// Só quando não há chave: os apps precisam ser atualizados com a chave pública nova
ipcMain.handle('panel-generate-key', () => {
  if (adminKey) throw new Error('Já existe uma chave neste computador.');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeKey(privateKey);
  return keyInfo();
});

ipcMain.handle('panel-save-csv', async (e, csv) => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await dialog.showSaveDialog(win, {
    title: 'Exportar usuários',
    defaultPath: path.join(app.getPath('downloads'), `pulseshare-usuarios-${stamp}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, '﻿' + String(csv || ''));
  return { path: r.filePath };
});
