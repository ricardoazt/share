// PulseShare — service worker da extensão
// A extensão roda o MESMO app do celular (app.html/app.js):
//  • clique no ícone → abre (ou foca) a janela do app, com o formato do celular;
//  • com "Rodar em segundo plano" ligado, um documento offscreen (app.html?bg=1)
//    mantém a conexão e recebe mensagens com a janela fechada. Os dois usam um
//    Web Lock ("pulseshare-core"): só um conecta por vez (a janela tem prioridade);
//  • notificações do app viram notificações do sistema (barra/central de notificações).

const OFFSCREEN_URL = 'app.html?bg=1';
let unread = 0;

async function getBackgroundMode() {
  const { backgroundMode } = await chrome.storage.local.get('backgroundMode');
  return backgroundMode !== false;
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  }
  return false;
}

let creating = null;
async function ensureOffscreen() {
  if (!(await getBackgroundMode())) return;
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WEB_RTC', 'LOCAL_STORAGE'],
    justification: 'Manter a conexão P2P (MQTT + WebRTC) para receber mensagens e arquivos com a janela fechada.'
  }).catch((e) => console.warn('[PulseShare] offscreen:', e)).finally(() => { creating = null; });
  return creating;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
  }
}

async function findAppTab() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('app.html') + '*' });
  return tabs.find((t) => !String(t.url).includes('bg=1')) || null;
}

async function openAppWindow(chatTag) {
  const query = chatTag ? `?chat=${encodeURIComponent(chatTag)}` : '';
  const existing = await findAppTab();
  if (existing) {
    if (chatTag) await chrome.tabs.update(existing.id, { url: chrome.runtime.getURL('app.html' + query), active: true });
    else await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true, drawAttention: false });
    return;
  }
  await chrome.windows.create({ url: chrome.runtime.getURL('app.html' + query), type: 'popup', width: 430, height: 880, focused: true });
}

function setBadge(n) {
  unread = Math.max(0, n);
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  chrome.action.setBadgeText({ text: unread ? String(Math.min(unread, 99)) : '' });
}

chrome.action.onClicked.addListener(() => openAppWindow());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'PS_NOTIFY') {
    const id = `ps|${msg.peerTag || ''}|${Date.now()}`;
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: String(msg.title || 'PulseShare').slice(0, 120),
      message: String(msg.body || '').slice(0, 300),
      priority: 2,
      silent: true // o som escolhido nas Configurações é tocado pelo próprio app
    });
    if (msg.kind !== 'test') setBadge(unread + 1);
  } else if (msg.type === 'PS_UI_OPEN') {
    setBadge(0);
  } else if (msg.type === 'PS_SET_BACKGROUND') {
    chrome.storage.local.set({ backgroundMode: Boolean(msg.enabled) }).then(() => {
      if (msg.enabled) ensureOffscreen(); else closeOffscreen();
    });
  }
  sendResponse && sendResponse({ ok: true });
});

chrome.notifications.onClicked.addListener((id) => {
  const tag = String(id).split('|')[1] || '';
  chrome.notifications.clear(id);
  openAppWindow(tag);
});

// Mantém o documento de fundo vivo (o Chrome pode descartá-lo)
chrome.alarms.create('ps-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ps-keepalive') ensureOffscreen(); });
chrome.runtime.onStartup.addListener(() => ensureOffscreen());
chrome.runtime.onInstalled.addListener(() => ensureOffscreen());
ensureOffscreen();
