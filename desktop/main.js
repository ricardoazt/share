// PulseShare para desktop (Linux) — Electron
// Roda o MESMO app do celular (www/app.html + app.js) numa janela própria, fora do Chrome.
// Ponte com o app: preload.js → window.PulseShareDesktop (ver Native em app.js).
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, shell, session, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Pacote: resources/app/www (cópia feita pelo build-deb.sh). Desenvolvimento: raiz do repositório.
const WWW = fs.existsSync(path.join(__dirname, 'www', 'app.html')) ? path.join(__dirname, 'www') : path.join(__dirname, '..');
const ICON = path.join(WWW, 'icons', 'icon512.png');
const TRAY_ICON = path.join(WWW, 'icons', 'icon32.png');

app.setName('PulseShare');
// Rota LAN do chat: o Chromium esconde o IP local atrás de um nome .local (mDNS) que
// a WebView do Android nem sempre resolve. Mostrando o IP local, celular e PC na
// mesma rede se conectam direto (o IP só vai para quem já é contato).
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Perfil separado (testes / segunda instância): PULSESHARE_PROFILE=/caminho pulseshare
if (process.env.PULSESHARE_PROFILE) app.setPath('userData', path.resolve(process.env.PULSESHARE_PROFILE));
// Notificações e ícone na barra do GNOME ligados ao .desktop instalado pelo .deb
if (process.platform === 'linux') app.setDesktopName && app.setDesktopName('pulseshare.desktop');

const startHidden = process.argv.includes('--hidden');

// ---------- configurações do desktop (fora do localStorage do app) ----------
const SETTINGS_FILE = path.join(app.getPath('userData'), 'desktop-settings.json');
let settings = { backgroundMode: false, downloadFolder: 'PulseShare' };
try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) {}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {}
}

function cleanFolderName(f) {
  const s = String(f || '').replace(/[\\/:*?"<>|\0]/g, '').replace(/^\.+/, '').trim().slice(0, 60);
  return s || 'PulseShare';
}
function downloadDir() {
  return path.join(app.getPath('downloads'), cleanFolderName(settings.downloadFolder));
}
function insideDownloadDir(p) {
  const rel = path.relative(downloadDir(), path.resolve(String(p || '')));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function uniquePath(dir, name) {
  const safe = path.basename(String(name || 'arquivo')).replace(/[\0/]/g, '_') || 'arquivo';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// ---------- links pulseshare:// e conversa a abrir ----------
let pendingOpenChat = '';
let pendingLinks = [];
function collectArgs(argv) {
  for (const a of argv || []) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('pulseshare://')) pendingLinks.push(a);
    const m = a.match(/^--chat=(@[a-z0-9_]+)$/i);
    if (m) pendingOpenChat = m[1].toLowerCase();
  }
}
collectArgs(process.argv);

// ---------- início automático ao entrar na sessão (modo segundo plano) ----------
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'pulseshare.desktop');
function setAutostart(on) {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      const exe = fs.existsSync('/usr/bin/pulseshare') ? '/usr/bin/pulseshare' : process.execPath;
      fs.writeFileSync(AUTOSTART_FILE, [
        '[Desktop Entry]', 'Type=Application', 'Name=PulseShare',
        'Comment=Recebe mensagens do PulseShare em segundo plano',
        `Exec=${exe} --hidden`, 'Icon=pulseshare', 'Terminal=false',
        'X-GNOME-Autostart-enabled=true', ''
      ].join('\n'));
    } else if (fs.existsSync(AUTOSTART_FILE)) {
      fs.unlinkSync(AUTOSTART_FILE);
    }
  } catch (e) { console.error('autostart:', e.message); }
}

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

function sendToApp(name, data) {
  if (win && !win.isDestroyed()) win.webContents.send('ps-event', name, data);
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(true); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!settings.backgroundMode) {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('PulseShare');
    tray.on('click', showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: unread ? `Abrir PulseShare (${unread} nova${unread > 1 ? 's' : ''})` : 'Abrir PulseShare', click: showWindow },
    { type: 'separator' },
    { label: 'Sair do PulseShare', click: () => { quitting = true; app.quit(); } }
  ]));
}

function setUnread(n) {
  unread = Math.max(0, n);
  try { app.setBadgeCount(unread); } catch (e) {}
  updateTray();
}

function createWindow(forceShow) {
  win = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 360,
    minHeight: 540,
    title: 'PulseShare',
    icon: ICON,
    backgroundColor: '#020617',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Continua recebendo mensagens/arquivos com a janela escondida
      backgroundThrottling: false
    }
  });
  win.removeMenu();
  win.loadFile(path.join(WWW, 'app.html'));
  win.once('ready-to-show', () => { if (forceShow || !startHidden) win.show(); });
  win.on('focus', () => setUnread(0));
  win.on('close', (e) => {
    if (!quitting && settings.backgroundMode) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // Links externos (portal do link público, sites) abrem no navegador padrão
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (/^(blob:|file:)/i.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, backgroundColor: '#020617' } };
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  // Atalhos úteis: F5/Ctrl+R recarrega, Ctrl+Shift+I abre a depuração
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && !input.shift && input.key.toLowerCase() === 'r')) { wc.reload(); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') { wc.toggleDevTools(); e.preventDefault(); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const before = pendingLinks.length;
    const chatBefore = pendingOpenChat;
    collectArgs(argv);
    showWindow();
    if (pendingLinks.length > before) {
      const links = pendingLinks.splice(0);
      sendToApp('open-links', links);
    }
    if (pendingOpenChat && pendingOpenChat !== chatBefore) {
      sendToApp('open-chat', pendingOpenChat);
      pendingOpenChat = '';
    }
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    const allowed = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'mediaKeySystem']);
    ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm)));
    ses.setPermissionCheckHandler((wc, perm) => allowed.has(perm));

    // Downloads vão direto para ~/Downloads/<pasta> (sem caixa de diálogo), como no celular
    ses.on('will-download', (e, item) => {
      const dir = downloadDir();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {}
      const target = uniquePath(dir, item.getFilename());
      item.setSavePath(target);
      item.once('done', (ev, state) => {
        if (state !== 'completed') return;
        // Backup e .txt de recuperação levam as chaves da conta: só o dono lê
        if (/^pulseshare-(backup|recuperacao)-/i.test(path.basename(target))) {
          try { fs.chmodSync(target, 0o600); } catch (err) {}
        }
        sendToApp('download-done', { name: path.basename(target), path: target });
      });
    });

    updateTray();
    createWindow(false);
  });

  app.on('window-all-closed', () => {
    if (!settings.backgroundMode || quitting) app.quit();
  });
  app.on('before-quit', () => { quitting = true; });
}

// ---------- ponte com o app (preload.js) ----------
ipcMain.on('ps-notify', (e, n) => {
  if (!n || !Notification.isSupported()) return;
  const notif = new Notification({
    title: String(n.title || 'PulseShare').slice(0, 120),
    body: String(n.body || '').slice(0, 300),
    icon: ICON,
    silent: true // o som escolhido nas Configurações é tocado pelo próprio app
  });
  notif.on('click', () => {
    showWindow();
    if (n.tag && /^@[a-z0-9_]+$/i.test(n.tag)) sendToApp('open-chat', n.tag);
  });
  notif.show();
  if (!win || !win.isFocused()) setUnread(unread + 1);
});
ipcMain.on('ps-ui-open', () => setUnread(0));
// fromUser = a pessoa mexeu na opção agora. Só então o início automático na
// sessão é criado/removido (ao abrir, o app só informa o estado salvo).
ipcMain.on('ps-set-background', (e, on, fromUser) => {
  settings.backgroundMode = Boolean(on);
  saveSettings();
  if (fromUser) setAutostart(settings.backgroundMode);
  updateTray();
});
ipcMain.on('ps-get-download-dir', (e) => { e.returnValue = downloadDir(); });
ipcMain.on('ps-set-download-dir', (e, folder) => {
  settings.downloadFolder = cleanFolderName(folder);
  saveSettings();
  e.returnValue = downloadDir();
});
ipcMain.on('ps-open-download-dir', () => {
  const dir = downloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  shell.openPath(dir);
});
ipcMain.on('ps-open-path', (e, p) => { if (insideDownloadDir(p)) shell.openPath(path.resolve(p)); });
ipcMain.on('ps-show-in-folder', (e, p) => { if (insideDownloadDir(p)) shell.showItemInFolder(path.resolve(p)); });
ipcMain.on('ps-open-external', (e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });
ipcMain.on('ps-consume-launch', (e) => {
  e.returnValue = { chat: pendingOpenChat, links: pendingLinks.splice(0) };
  pendingOpenChat = '';
});
ipcMain.on('ps-app-info', (e) => {
  e.returnValue = { version: app.getVersion(), backgroundMode: settings.backgroundMode };
});
