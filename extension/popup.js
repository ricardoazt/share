/**
 * PulseShare P2P - Popup Interface & Client Logic (popup.js)
 *
 * 100% Serverless, Multiplataforma (Windows, macOS, Linux, ChromeOS)
 * - Eliminação total de daemons locais e binários nativos.
 * - Suporte nativo a seleção de arquivos (<input type="file">), pastas (<input webkitdirectory>)
 *   e Drag & Drop direto.
 * - Armazenamento de arquivos no IndexedDB e offscreen document para persistência.
 * - Compactação em .ZIP via fflate em JavaScript puro.
 * - Integração direta com Portal Público WebRTC (GitHub Pages).
 */

const DEFAULT_PORTAL_URL = 'https://ricardoazt.github.io/share/';
const DB_NAME = 'PulseShareDB';
const DB_VERSION = 1;
const FILE_STORE = 'staged_files';

const fileBridgeChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('pulseshare_file_bridge')
    : null;

let dbInstance = null;

function openDatabase() {
  if (dbInstance) {
    try {
      dbInstance.transaction(FILE_STORE, 'readonly');
      return Promise.resolve(dbInstance);
    } catch {
      dbInstance = null;
    }
  }
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('IndexedDB open timeout'));
      }
    }, 3000);

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE);
      }
    };
    request.onsuccess = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        dbInstance = request.result;
        dbInstance.onversionchange = () => {
          try { dbInstance.close(); } catch {}
          dbInstance = null;
        };
        resolve(dbInstance);
      }
    };
    request.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(request.error);
      }
    };
    request.onblocked = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error('IndexedDB blocked'));
      }
    };
  });
}

async function saveStagedFile(fileKey, fileBlob) {
  if (!fileBlob) return;
  if (fileBridgeChannel) {
    try {
      fileBridgeChannel.postMessage({
        type: 'STAGE_FILE_MEMORY',
        transferId: fileKey,
        file: fileBlob
      });
    } catch (e) {
      console.warn('fileBridgeChannel postMessage warning:', e);
    }
  }
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).put(fileBlob, fileKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  } catch (err) {
    console.warn('Erro ao salvar no IndexedDB:', err);
  }
}

async function deleteStagedFile(fileKey) {
  if (fileBridgeChannel) {
    try {
      fileBridgeChannel.postMessage({
        type: 'DELETE_FILE_MEMORY',
        transferId: fileKey
      });
    } catch {}
  }
  try {
    const db = await openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).delete(fileKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {}
}

async function getStagedFile(fileKey) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readonly');
      const req = tx.objectStore(FILE_STORE).get(fileKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function normalizeTag(raw) {
  let tag = (raw || '').trim().toLowerCase();
  if (!tag) return '';
  if (!tag.startsWith('@')) tag = `@${tag}`;
  return tag.replace(/[^a-z0-9_@]/g, '');
}

async function computeSha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatShareMessage({ shareUrl, password, expiresAt, maxDownloads, files }) {
  let msg = `📦 PulseShare — Compartilhamento de Arquivos P2P\n`;
  msg += `🔗 Link: ${shareUrl}\n`;
  msg += `🔑 Senha: ${password || 'Nenhuma'}\n`;
  if (expiresAt) {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs > 0) {
      const remainingMin = Math.round(remainingMs / 60000);
      const expTime = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      msg += `⏳ Expira em: ~${remainingMin} min (às ${expTime})\n`;
    } else {
      msg += `⏳ Expira em: Expirado\n`;
    }
  } else {
    msg += `⏳ Expira em: Sem limite de tempo\n`;
  }
  if (files && files.length > 0) {
    msg += `📁 Arquivos (${files.length}):\n`;
    for (const f of files) {
      msg += `  • ${f.name} (${formatBytes(f.size)})\n`;
    }
  }
  msg += `\n⚡ Baixe direto pelo navegador (WebRTC P2P), sem servidor e sem instalar nada!`;
  return msg;
}

// ============================================================================
// Referências de Elementos do DOM
// ============================================================================
const statusDot = document.getElementById('status-dot');
const connectionBadge = document.getElementById('connection-badge');
const btnExpandWindow = document.getElementById('btn-expand-window');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const btnCloseSettings = document.getElementById('btn-close-settings');
const toggleAutoOpen = document.getElementById('toggle-auto-open');
const toggleAutoAccept = document.getElementById('toggle-auto-accept');
const settingPortalUrl = document.getElementById('setting-portal-url');
const btnResetPortalUrl = document.getElementById('btn-reset-portal-url');
const daemonStatusBadge = document.getElementById('daemon-status-badge');

const toggleMeshRelay = document.getElementById('toggle-mesh-relay');
const selectRelayBandwidth = document.getElementById('select-relay-bandwidth');
const relayBandwidthBadge = document.getElementById('relay-bandwidth-badge');
const activeRelayedRoutesCount = document.getElementById('active-relayed-routes-count');
const totalRelayedBytesDisplay = document.getElementById('total-relayed-bytes-display');

const myTagInput = document.getElementById('my-tag-input');
const btnSaveTag = document.getElementById('btn-save-tag');
const btnSaveTagText = document.getElementById('btn-save-tag-text');
const registrationStatusBadge = document.getElementById('registration-status-badge');
const registeredUserInfo = document.getElementById('registered-user-info');
const registeredHashDisplay = document.getElementById('registered-hash-display');
const targetContainer = document.getElementById('target-container');
const targetTagInput = document.getElementById('target-tag-input');
const rosterCount = document.getElementById('roster-count');
const peersList = document.getElementById('peers-list');
const btnViewAllUsers = document.getElementById('btn-view-all-users');

const fileInput = document.getElementById('file-input');
const tunnelFileInput = document.getElementById('tunnel-file-input');
const btnSend = document.getElementById('btn-send');
const btnReceive = document.getElementById('btn-receive');
const receiveBadge = document.getElementById('receive-badge');
const receiveTitle = document.getElementById('receive-title');
const receiveSubtitle = document.getElementById('receive-subtitle');

const btnCloudflareTunnel = document.getElementById('btn-cloudflare-tunnel');
const tunnelStatusSub = document.getElementById('tunnel-status-sub');
const tunnelBadge = document.getElementById('tunnel-badge');

// Navegação Principal em Abas (Ocupa a Janela Inteira)
const navBtnHome = document.getElementById('nav-btn-home');
const navBtnTransfers = document.getElementById('nav-btn-transfers');
const navBtnShares = document.getElementById('nav-btn-shares');
const navBtnMesh = document.getElementById('nav-btn-mesh');

const navBadgeTransfers = document.getElementById('nav-badge-transfers');
const navBadgeShares = document.getElementById('nav-badge-shares');
const navBadgeMesh = document.getElementById('nav-badge-mesh');

const viewHome = document.getElementById('view-home');
const viewTransfers = document.getElementById('view-transfers');
const viewShares = document.getElementById('view-shares');
const viewMesh = document.getElementById('view-mesh');

const sharesList = document.getElementById('shares-list');
const emptySharesState = document.getElementById('empty-shares-state');
const countShares = document.getElementById('count-shares');
const btnNewShareLink = document.getElementById('btn-new-share-link');
const homeDropZone = document.getElementById('home-drop-zone');

let currentMainTab = 'home'; // 'home' | 'transfers' | 'shares' | 'mesh'

const tabActiveTransfers = document.getElementById('tab-active-transfers');
const tabUsersMesh = document.getElementById('tab-users-mesh');
const tabUsersBadge = document.getElementById('tab-users-badge');
const tabHistoryTransfers = document.getElementById('tab-history-transfers');
const countActive = document.getElementById('count-active');
const countHistory = document.getElementById('count-history');
const btnClearCompleted = document.getElementById('btn-clear-completed');

const toastAlert = document.getElementById('toast-alert');
const toastMessage = document.getElementById('toast-message');
const toastClose = document.getElementById('toast-close');

const transfersView = document.getElementById('transfers-view');
const transfersList = document.getElementById('transfers-list');
const emptyState = document.getElementById('empty-state');

const usersMeshView = document.getElementById('users-mesh-view');
const usersSearchInput = document.getElementById('users-search-input');
const usersMeshSummary = document.getElementById('users-mesh-summary');
const meshUsersList = document.getElementById('mesh-users-list');
const btnClearInactiveUsers = document.getElementById('btn-clear-inactive-users');
const countInactiveUsers = document.getElementById('count-inactive-users');

const footerAutoOpen = document.getElementById('footer-auto-open');
const onlineCounter = document.getElementById('online-counter');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBandwidth(kbps) {
  if (!kbps || kbps <= 0) return 'Ilimitada';
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(kbps % 1024 === 0 ? 0 : 1)} MB/s`;
  return `${kbps} KB/s`;
}

function formatLastConnection(timestamp) {
  if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
    return 'Data desconhecida';
  }
  const date = new Date(timestamp);
  const now = Date.now();
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  let relative = '';
  if (diffSec < 45) {
    relative = 'agora mesmo';
  } else if (diffMin < 60) {
    relative = `há ${diffMin} min`;
  } else if (diffHours < 24) {
    relative = `há ${diffHours}h`;
  } else if (diffDays === 1) {
    relative = 'ontem';
  } else {
    relative = `há ${diffDays} dias`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = date.getFullYear();
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());

  return `${d}/${m}/${y} às ${hh}:${mm} (${relative})`;
}

function formatDate(timestamp) {
  if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) return 'Data desconhecida';
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Modal Elements
const tunnelConfigModal = document.getElementById('tunnel-config-modal');
const modalIndicatorDot = document.getElementById('modal-indicator-dot');
const modalHeaderTitle = document.getElementById('modal-header-title');
const btnModalClose = document.getElementById('btn-modal-close');
const modalFileInput = document.getElementById('modal-file-input');
const modalFolderInput = document.getElementById('modal-folder-input');
const modalViewPack = document.getElementById('modal-view-pack');
const modalFilesSummary = document.getElementById('modal-files-summary');
const btnModalAddMore = document.getElementById('btn-modal-add-more');
const btnModalAddFolder = document.getElementById('btn-modal-add-folder');
const modalDropZone = document.getElementById('modal-drop-zone');
const modalFilesList = document.getElementById('modal-files-list');

const modalCompressToggle = document.getElementById('modal-compress-toggle');
const modalCompressOptions = document.getElementById('modal-compress-options');
const modalCompressFormat = document.getElementById('modal-compress-format');
const modalCompressLevel = document.getElementById('modal-compress-level');
const modalCompressName = document.getElementById('modal-compress-name');
const modalP2pTargetSection = document.getElementById('modal-p2p-target-section');
const modalTargetTagInput = document.getElementById('modal-target-tag-input');
const modalTargetTagSelect = document.getElementById('modal-target-tag-select');
const modalP2pTargetBadge = document.getElementById('modal-p2p-target-badge');

const modalTunnelOptions = document.getElementById('modal-tunnel-options');
const modalExpirationSelect = document.getElementById('modal-expiration-select');
const modalDownloadLimitSelect = document.getElementById('modal-download-limit-select');
const modalPasswordInput = document.getElementById('modal-password-input');
const btnModalGenPassword = document.getElementById('btn-modal-gen-password');
const btnModalClearPassword = document.getElementById('btn-modal-clear-password');

const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');

let currentState = {
  connected: false,
  nodeId: '',
  myTag: '',
  autoAccept: true,
  autoOpenOnReceive: true,
  peerRegistry: {},
  transfers: {},
  stagedTunnelFiles: [],
  tunnelModalOpen: false,
  modalMode: 'p2p',
  modalTargetTag: ''
};

let stagedTunnelFiles = []; // Array de { fileId, name, size, type, fileObj }
let currentModalMode = 'p2p'; // 'p2p' | 'tunnel'
let currentTransfersTab = 'active'; // 'active' | 'history'
const expandedTransferIds = new Set();

function showToast(msg, type = 'info') {
  if (!toastAlert || !toastMessage) return;
  toastMessage.textContent = msg;

  toastAlert.className = 'mb-1 px-3 py-1.5 rounded-lg text-[11px] flex items-center justify-between shrink-0 transition-all shadow-md ';

  if (type === 'error') {
    toastAlert.className += 'bg-rose-950/95 border border-rose-500/50 text-rose-200';
  } else if (type === 'success') {
    toastAlert.className += 'bg-emerald-950/95 border border-emerald-500/50 text-emerald-200';
  } else if (type === 'warning') {
    toastAlert.className += 'bg-amber-950/95 border border-amber-500/50 text-amber-200';
  } else {
    toastAlert.className += 'bg-indigo-950/95 border border-indigo-500/50 text-indigo-200';
  }

  toastAlert.classList.remove('hidden');

  if (toastAlert._timer) clearTimeout(toastAlert._timer);
  toastAlert._timer = setTimeout(() => {
    toastAlert.classList.add('hidden');
  }, 5000);
}

if (toastClose) {
  toastClose.addEventListener('click', () => {
    toastAlert.classList.add('hidden');
  });
}

function renderConnectionStatus() {
  if (currentState.connected) {
    statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    statusDot.title = 'Conectado à Malha P2P (3 brokers)';
    connectionBadge.textContent = 'Malha P2P (3 brokers)';
    connectionBadge.className =
      'text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
  } else {
    statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
    statusDot.title = 'Conectando aos brokers MQTT públicos...';
    connectionBadge.textContent = 'Sincronizando...';
    connectionBadge.className =
      'text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700';
  }

  if (daemonStatusBadge) {
    daemonStatusBadge.textContent = currentState.connected ? '● 3 Brokers WSS' : '○ Conectando...';
    daemonStatusBadge.className = currentState.connected
      ? 'text-[9px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
      : 'text-[9px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30';
  }
}

function renderSettingsSwitches() {
  if (toggleAutoOpen) {
    const isAutoOpen = Boolean(currentState.autoOpenOnReceive);
    toggleAutoOpen.setAttribute('aria-checked', String(isAutoOpen));
    toggleAutoOpen.className = `w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer ${
      isAutoOpen ? 'bg-emerald-500 justify-end' : 'bg-slate-700 justify-start'
    }`;
  }

  if (toggleAutoAccept) {
    const isAutoAccept = Boolean(currentState.autoAccept);
    toggleAutoAccept.setAttribute('aria-checked', String(isAutoAccept));
    toggleAutoAccept.className = `w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer ${
      isAutoAccept ? 'bg-sky-500 justify-end' : 'bg-slate-700 justify-start'
    }`;
  }

  if (toggleMeshRelay) {
    const isRelay = currentState.meshRelayEnabled !== false;
    toggleMeshRelay.setAttribute('aria-checked', String(isRelay));
    toggleMeshRelay.className = `w-10 h-5 rounded-full p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer ${
      isRelay ? 'bg-indigo-500 justify-end' : 'bg-slate-700 justify-start'
    }`;
  }

  if (selectRelayBandwidth) {
    selectRelayBandwidth.value = String(currentState.relayBandwidthLimitKbps ?? 2048);
  }

  if (relayBandwidthBadge) {
    relayBandwidthBadge.textContent = formatBandwidth(currentState.relayBandwidthLimitKbps ?? 2048);
  }

  if (activeRelayedRoutesCount) {
    activeRelayedRoutesCount.textContent = `${currentState.activeRelayedRoutes || 0} ativas`;
  }

  if (totalRelayedBytesDisplay) {
    totalRelayedBytesDisplay.textContent = formatBytes(currentState.relayedBytesTotal || 0);
  }

  if (footerAutoOpen) {
    footerAutoOpen.textContent = currentState.autoOpenOnReceive ? 'ON' : 'OFF';
    footerAutoOpen.className = currentState.autoOpenOnReceive ? 'text-emerald-400' : 'text-slate-500';
  }
}

function renderPeerDirectory() {
  const peers = Object.values(currentState.peerRegistry || {});
  const now = Date.now();
  const onlinePeers = peers.filter(
    (p) => p.tag && p.tag !== currentState.myTag && (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
  );

  if (rosterCount) rosterCount.textContent = `${onlinePeers.length} online`;
  if (onlineCounter) onlineCounter.textContent = `${onlinePeers.length} online`;
  if (tabUsersBadge) tabUsersBadge.textContent = String(onlinePeers.length);

  if (peersList) {
    peersList.innerHTML = '';
    if (onlinePeers.length === 0) {
      const span = document.createElement('span');
      span.className = 'text-[10px] text-slate-500 italic';
      span.textContent = 'Nenhum outro @usuario ativo no momento.';
      peersList.appendChild(span);
    } else {
      const currentSelected = normalizeTag(targetTagInput ? targetTagInput.value : '');

      onlinePeers.forEach((peer) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isSelected = peer.tag === currentSelected;

        btn.className = `px-2 py-0.5 rounded-full text-[10px] font-mono font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1 ${
          isSelected
            ? 'bg-emerald-500 text-slate-950 font-bold shadow-md'
            : 'bg-slate-800/90 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30'
        }`;

        const dot = document.createElement('span');
        dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0';
        btn.appendChild(dot);

        const txt = document.createElement('span');
        txt.textContent = peer.tag;
        btn.appendChild(txt);

        if (peer.relayEnabled) {
          const relayIcon = document.createElement('span');
          relayIcon.className = 'text-[9px] text-indigo-300';
          relayIcon.textContent = '⚡';
          relayIcon.title = `Nó de Rota (${formatBandwidth(peer.relayBandwidthLimitKbps)})`;
          btn.appendChild(relayIcon);
        }

        btn.title = `Clique para selecionar ${peer.tag}`;
        btn.addEventListener('click', () => {
          if (targetTagInput) targetTagInput.value = peer.tag;
          chrome.storage.local.set({ lastTargetTag: peer.tag });
          renderPeerDirectory();
        });

        peersList.appendChild(btn);
      });
    }
  }

  renderMeshUsersTab();

  if (currentModalMode === 'p2p' && tunnelConfigModal && !tunnelConfigModal.classList.contains('hidden')) {
    const curTag = modalTargetTagInput ? modalTargetTagInput.value.trim() : '';
    populateModalPeerSelect(curTag ? (curTag.startsWith('@') ? curTag : `@${curTag}`) : '');
  }
}

function populateModalPeerSelect(selectedTag = '') {
  if (!modalTargetTagSelect) return;
  modalTargetTagSelect.innerHTML = '<option value="">-- Escolher da rede --</option>';
  const now = Date.now();
  const peers = Object.values(currentState.peerRegistry || {}).filter(
    (p) => p.tag && p.tag !== currentState.myTag
  );

  peers.sort((a, b) => {
    const isOnlineA = a.status === 'online' || now - (a.lastSeen || 0) < 45000;
    const isOnlineB = b.status === 'online' || now - (b.lastSeen || 0) < 45000;
    if (isOnlineA && !isOnlineB) return -1;
    if (!isOnlineA && isOnlineB) return 1;
    return (a.tag || '').localeCompare(b.tag || '');
  });

  const normalizedSelected = normalizeTag(selectedTag);

  peers.forEach((peer) => {
    const isOnline = peer.status === 'online' || now - (peer.lastSeen || 0) < 45000;
    const isAway = !isOnline && now - (peer.lastSeen || 0) < 180000;
    const statusText = isOnline ? 'Online' : isAway ? 'Ausente' : 'Offline';
    const statusIcon = isOnline ? '🟢' : isAway ? '🟡' : '⚪';
    const opt = document.createElement('option');
    opt.value = peer.tag;
    opt.textContent = `${statusIcon} ${peer.tag} (${statusText})`;
    if (normalizedSelected && normalizeTag(peer.tag) === normalizedSelected) {
      opt.selected = true;
    }
    modalTargetTagSelect.appendChild(opt);
  });
}

function renderMeshUsersTab() {
  if (!meshUsersList) return;

  const now = Date.now();
  const searchFilter = (usersSearchInput ? usersSearchInput.value.trim().toLowerCase() : '');
  const allPeers = Object.values(currentState.peerRegistry || {});

  const sortedPeers = allPeers.slice().sort((a, b) => {
    if (a.tag === currentState.myTag) return -1;
    if (b.tag === currentState.myTag) return 1;

    const isOnlineA = a.status === 'online' || now - (a.lastSeen || 0) < 45000;
    const isOnlineB = b.status === 'online' || now - (b.lastSeen || 0) < 45000;
    if (isOnlineA && !isOnlineB) return -1;
    if (!isOnlineA && isOnlineB) return 1;

    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  const filteredPeers = sortedPeers.filter((p) => {
    if (!p.tag) return false;
    if (searchFilter && !p.tag.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  const onlineCount = allPeers.filter(
    (p) => p.tag !== currentState.myTag && (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
  ).length;

  const inactivePeers = allPeers.filter(
    (p) => p.tag && p.tag !== currentState.myTag && !(p.status === 'online' || now - (p.lastSeen || 0) < 45000)
  );

  if (usersMeshSummary) {
    usersMeshSummary.textContent = `${onlineCount} online • ${allPeers.length} na malha`;
  }

  if (btnClearInactiveUsers) {
    if (inactivePeers.length > 0) {
      btnClearInactiveUsers.classList.remove('hidden');
      if (countInactiveUsers) countInactiveUsers.textContent = String(inactivePeers.length);
    } else {
      btnClearInactiveUsers.classList.add('hidden');
    }
  }

  meshUsersList.innerHTML = '';

  if (filteredPeers.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className =
      'p-4 rounded-xl bg-slate-900/40 border border-slate-800 text-center flex flex-col items-center justify-center';
    emptyDiv.innerHTML = `
      <p class="text-xs text-slate-400 font-medium">Nenhum usuário encontrado na malha</p>
      <p class="text-[10px] text-slate-500 mt-1">
        ${searchFilter ? 'Tente outro termo de busca.' : 'Aguardando sincronização de nós na malha global...'}
      </p>
    `;
    meshUsersList.appendChild(emptyDiv);
    return;
  }

  for (const peer of filteredPeers) {
    const isSelf = peer.tag === currentState.myTag;
    const isOnline = isSelf || peer.status === 'online' || now - (peer.lastSeen || 0) < 45000;
    const isAway = !isOnline && now - (peer.lastSeen || 0) < 180000;

    const statusDotClass = isOnline
      ? 'bg-emerald-400'
      : isAway
      ? 'bg-amber-400'
      : 'bg-slate-500';

    const statusText = isSelf
      ? 'Você (Este Nó Local)'
      : isOnline
      ? '🟢 Online agora'
      : isAway
      ? '🟡 Ausente'
      : '⚪ Offline / Inativo';

    const lastSeenFormatted = formatLastConnection(peer.lastSeen || peer.joinedAt);

    const card = document.createElement('div');
    card.className =
      `p-2.5 rounded-xl border flex items-center justify-between gap-2.5 transition-all shadow-sm ${
        isSelf
          ? 'bg-indigo-950/20 border-indigo-500/30'
          : isOnline
          ? 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
          : 'bg-slate-950/60 border-slate-800/60 opacity-80'
      }`;

    const leftWrap = document.createElement('div');
    leftWrap.className = 'flex items-center gap-2.5 min-w-0 flex-1';

    const avatar = document.createElement('div');
    avatar.className =
      'relative w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-indigo-300 shrink-0';
    avatar.textContent = (peer.tag.replace(/^@/, '')[0] || 'U').toUpperCase();

    const dot = document.createElement('span');
    dot.className = `absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${statusDotClass}`;
    avatar.appendChild(dot);
    leftWrap.appendChild(avatar);

    const details = document.createElement('div');
    details.className = 'flex flex-col min-w-0 flex-1';

    const tagRow = document.createElement('div');
    tagRow.className = 'flex items-center gap-1.5 flex-wrap';

    const tagSpan = document.createElement('span');
    tagSpan.className = 'text-xs font-mono font-bold text-slate-100 truncate';
    tagSpan.textContent = peer.tag;
    tagRow.appendChild(tagSpan);

    if (isSelf) {
      const selfBadge = document.createElement('span');
      selfBadge.className = 'text-[9px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold';
      selfBadge.textContent = 'VOCÊ';
      tagRow.appendChild(selfBadge);
    }

    if (peer.relayEnabled) {
      const relayBadge = document.createElement('span');
      relayBadge.className = 'text-[9px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      relayBadge.textContent = `⚡ Rota (${formatBandwidth(peer.relayBandwidthLimitKbps)})`;
      relayBadge.title = 'Este nó aceita intermediar transferências para outros usuários';
      tagRow.appendChild(relayBadge);
    }

    details.appendChild(tagRow);

    const subText = document.createElement('div');
    subText.className = 'flex flex-col text-[10px] mt-0.5 leading-tight gap-0.5';

    const statusLine = document.createElement('span');
    statusLine.className = isSelf
      ? 'text-indigo-300 font-medium'
      : isOnline
      ? 'text-emerald-400 font-medium'
      : isAway
      ? 'text-amber-400 font-medium'
      : 'text-slate-400';
    statusLine.textContent = statusText;
    subText.appendChild(statusLine);

    const dateLine = document.createElement('span');
    dateLine.className = 'text-[9.5px] text-slate-400 flex items-center gap-1';
    dateLine.innerHTML = `<span class="text-slate-500">Última conexão:</span> <span class="font-mono text-slate-300">${lastSeenFormatted}</span>`;
    subText.appendChild(dateLine);

    if (peer.regHash) {
      const hashLine = document.createElement('span');
      hashLine.className = 'text-[9px] font-mono text-slate-400 flex items-center gap-1';
      hashLine.innerHTML = `<span class="text-slate-500">Hash de Registro:</span> <span class="text-indigo-300 font-medium">${peer.regHash}</span>`;
      subText.appendChild(hashLine);
    }

    if (peer.registeredAt) {
      const regLine = document.createElement('span');
      regLine.className = 'text-[9px] text-slate-400 flex items-center gap-1';
      regLine.innerHTML = `<span class="text-slate-500">Registrado em:</span> <span class="font-mono text-slate-300">${formatDate(peer.registeredAt)}</span>`;
      subText.appendChild(regLine);
    }

    details.appendChild(subText);
    leftWrap.appendChild(details);
    card.appendChild(leftWrap);

    if (!isSelf) {
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'flex items-center gap-1.5 shrink-0';

      // Se o usuário não está online (está inativo/offline/ausente), exibe botão para excluir da rede
      if (!isOnline) {
        const btnDeletePeer = document.createElement('button');
        btnDeletePeer.type = 'button';
        btnDeletePeer.className =
          'px-2 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/25 active:scale-95 text-rose-300 border border-rose-500/30 text-[10px] font-medium transition-all cursor-pointer flex items-center gap-1';
        btnDeletePeer.title = `Excluir usuário inativo ${peer.tag} da rede`;
        btnDeletePeer.innerHTML = `
          <svg class="w-3 h-3 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span>Excluir</span>
        `;
        btnDeletePeer.addEventListener('click', (e) => {
          e.stopPropagation();
          chrome.runtime.sendMessage({ action: 'DELETE_PEER', tag: peer.tag }, (res) => {
            if (res && res.state) {
              currentState = res.state;
              renderAll();
              showToast(`Usuário ${peer.tag} foi excluído da rede.`);
            }
          });
        });
        actionsWrap.appendChild(btnDeletePeer);
      }

      const btnSendToPeer = document.createElement('button');
      btnSendToPeer.type = 'button';
      btnSendToPeer.className = isOnline
        ? 'px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-[10px] font-bold shadow-md transition-all cursor-pointer flex items-center gap-1'
        : 'px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-300 border border-slate-700 text-[10px] font-medium transition-all cursor-pointer flex items-center gap-1';
      btnSendToPeer.innerHTML = `
        <svg class="w-3 h-3 ${isOnline ? 'text-white' : 'text-slate-400'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
        </svg>
        <span>Enviar</span>
      `;
      btnSendToPeer.title = `Enviar arquivos para ${peer.tag}`;
      btnSendToPeer.addEventListener('click', () => {
        if (targetTagInput) targetTagInput.value = peer.tag;
        chrome.storage.local.set({ lastTargetTag: peer.tag });
        openModalForP2P(peer.tag);
      });
      actionsWrap.appendChild(btnSendToPeer);

      card.appendChild(actionsWrap);
    }

    meshUsersList.appendChild(card);
  }
}

function switchMainTab(tabName) {
  currentMainTab = tabName;

  const tabs = [
    { name: 'home', btn: navBtnHome, view: viewHome },
    { name: 'transfers', btn: navBtnTransfers, view: viewTransfers },
    { name: 'shares', btn: navBtnShares, view: viewShares },
    { name: 'mesh', btn: navBtnMesh, view: viewMesh }
  ];

  for (const t of tabs) {
    const isActive = t.name === tabName;
    if (t.btn) {
      if (isActive) {
        t.btn.className =
          'nav-tab active py-2.5 px-1 flex flex-col items-center justify-center gap-1 text-[11px] font-bold text-indigo-400 border-b-2 border-indigo-500 bg-slate-800/50 transition-all cursor-pointer relative';
        const svg = t.btn.querySelector('svg');
        if (svg) {
          svg.classList.remove('text-slate-400');
          svg.classList.add('text-indigo-400');
        }
      } else {
        t.btn.className =
          'nav-tab py-2.5 px-1 flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-200 border-b-2 border-transparent transition-all cursor-pointer relative';
        const svg = t.btn.querySelector('svg');
        if (svg) {
          svg.classList.remove('text-indigo-400');
          svg.classList.add('text-slate-400');
        }
      }
    }
    if (t.view) {
      if (isActive) {
        t.view.classList.remove('hidden');
      } else {
        t.view.classList.add('hidden');
      }
    }
  }

  if (tabName === 'home') {
    renderRegistrationCard();
    renderPeerDirectory();
  } else if (tabName === 'transfers') {
    renderTransfers();
  } else if (tabName === 'shares') {
    renderShares();
  } else if (tabName === 'mesh') {
    renderMeshUsersTab();
  }
  updateNavBadges();
}

function switchTransfersSubTab(tabName) {
  currentTransfersTab = tabName;

  if (tabActiveTransfers) {
    tabActiveTransfers.className =
      tabName === 'active'
        ? 'px-2.5 py-1 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer'
        : 'px-2.5 py-1 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
  }

  if (tabHistoryTransfers) {
    tabHistoryTransfers.className =
      tabName === 'history'
        ? 'px-2.5 py-1 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer'
        : 'px-2.5 py-1 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
  }

  renderTransfers();
}

function switchTab(tabName) {
  if (tabName === 'users') {
    switchMainTab('mesh');
  } else {
    switchMainTab('transfers');
    switchTransfersSubTab(tabName === 'history' ? 'history' : 'active');
  }
}

function renderReceiveButton() {
  const pendingIncoming = Object.values(currentState.transfers || []).filter(
    (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
  );

  if (pendingIncoming.length > 0) {
    receiveBadge.classList.remove('hidden');
    receiveBadge.textContent = `${pendingIncoming.length} Pendente${pendingIncoming.length > 1 ? 's' : ''}`;
    receiveTitle.textContent = 'Aceitar Arquivo';
    receiveSubtitle.textContent = pendingIncoming[0].fileName || 'Clique para baixar';
  } else {
    receiveBadge.classList.add('hidden');
    receiveTitle.textContent = 'Receber';
    receiveSubtitle.textContent = currentState.autoAccept ? 'Escuta Automática: ON' : 'Confirmação Manual';
  }
}

function isTransferHistory(t, now = Date.now()) {
  if (t.status === 'COMPLETED' || t.status === 'CANCELLED' || t.status === 'ERROR') {
    return true;
  }
  if (t.direction === 'tunnel' && t.expiresAt && now >= t.expiresAt) {
    return true;
  }
  return false;
}

function renderTransfers() {
  const allTransfers = Object.values(currentState.transfers || {}).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  const now = Date.now();
  const activeList = allTransfers.filter((t) => !isTransferHistory(t, now));
  const historyList = allTransfers.filter((t) => isTransferHistory(t, now));

  if (countActive) countActive.textContent = activeList.length;
  if (countHistory) countHistory.textContent = historyList.length;

  const list = currentTransfersTab === 'active' ? activeList : historyList;

  if (list.length === 0) {
    emptyState.classList.remove('hidden');
    const pTitle = emptyState.querySelector('p.font-medium');
    const pSub = emptyState.querySelector('p.text-\\[10px\\]');
    if (pTitle) {
      pTitle.textContent =
        currentTransfersTab === 'active'
          ? 'Nenhuma transferência ativa'
          : 'Nenhum histórico de transferências';
    }
    if (pSub) {
      pSub.innerHTML =
        currentTransfersTab === 'active'
          ? 'Envie para <span class="text-emerald-400 font-mono">@usuario</span> ou gere um <span class="text-orange-400 font-semibold">Link Público</span>.'
          : 'Transferências concluídas, expiradas ou canceladas aparecerão aqui.';
    }
    Array.from(transfersList.children).forEach((child) => {
      if (child.id !== 'empty-state') child.remove();
    });
    return;
  }

  emptyState.classList.add('hidden');
  Array.from(transfersList.children).forEach((child) => {
    if (child.id !== 'empty-state') child.remove();
  });

  for (const t of list) {
    const isTunnel = t.direction === 'tunnel';
    const isSend = t.direction === 'outgoing';
    const isPaused = t.status === 'PAUSED';
    const isCancelled = t.status === 'CANCELLED';
    const isExpired = t.status === 'EXPIRED' || (t.expiresAt && now >= t.expiresAt);
    const isCompleted = t.status === 'COMPLETED';
    const isDone = isCompleted || (!isExpired && !isCancelled && isTunnel && t.status === 'TUNNEL_READY');
    const isError = t.status === 'ERROR';
    const isWaitingAccept = t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT';
    const isExpanded = expandedTransferIds.has(t.id);

    const pct = Math.min(100, Math.max(0, Math.round(t.progress || 0)));
    const totalBytes = t.totalSize || t.fileSize || 0;
    const transferredBytes =
      typeof t.transferredBytes === 'number'
        ? t.transferredBytes
        : Math.round((totalBytes * pct) / 100);

    const card = document.createElement('div');
    card.className =
      'p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col gap-1.5 transition-all shadow-sm';

    const badgeColor = isTunnel
      ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
      : isSend
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : 'bg-sky-500/15 text-sky-300 border-sky-500/30';

    const badgeLabel = isTunnel ? '☁️ LINK WEBRTC' : isSend ? '↑ ENVIO' : '↓ RECEB.';

    const barColor = isError || isCancelled || isExpired
      ? 'bg-rose-500'
      : isPaused
      ? 'bg-amber-400'
      : isTunnel
      ? 'bg-gradient-to-r from-orange-500 to-amber-400'
      : isDone
      ? isSend ? 'bg-emerald-400' : 'bg-sky-400'
      : isSend
      ? 'bg-gradient-to-r from-emerald-500 to-green-400'
      : 'bg-gradient-to-r from-sky-500 to-blue-400';

    const pctColor = isError || isCancelled || isExpired
      ? 'text-rose-400'
      : isPaused
      ? 'text-amber-300'
      : isTunnel
      ? 'text-orange-300'
      : isSend
      ? 'text-emerald-300'
      : 'text-sky-300';

    let controlButtonsHtml = '';
    if (!isDone && !isError && !isCancelled && !isExpired && !isWaitingAccept) {
      if (t.status === 'TRANSFERRING' || t.status === 'CONNECTING') {
        controlButtonsHtml = `
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-action="pause-transfer"
              data-transfer-id="${t.id}"
              title="Pausar transferência"
              class="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ⏸ Pausar
            </button>
            <button
              type="button"
              data-action="cancel-transfer"
              data-transfer-id="${t.id}"
              title="Cancelar transferência"
              class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ✕ Cancelar
            </button>
          </div>
        `;
      } else if (isPaused) {
        controlButtonsHtml = `
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-action="resume-transfer"
              data-transfer-id="${t.id}"
              title="Retomar transferência"
              class="px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border border-emerald-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ▶ Retomar
            </button>
            <button
              type="button"
              data-action="cancel-transfer"
              data-transfer-id="${t.id}"
              title="Cancelar transferência"
              class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ✕ Cancelar
            </button>
          </div>
        `;
      }
    }

    let postActionsHtml = '';
    if (isDone && !isSend && !isTunnel && typeof t.downloadId === 'number') {
      postActionsHtml = `
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="show-folder"
            data-download-id="${t.downloadId}"
            title="Mostrar na pasta"
            class="p-1 rounded-lg bg-slate-800 hover:bg-sky-500/20 text-sky-300 border border-slate-700 hover:border-sky-500/40 transition-colors cursor-pointer"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </button>
          <button
            type="button"
            data-action="open-file"
            data-download-id="${t.downloadId}"
            title="Abrir arquivo"
            class="p-1 rounded-lg bg-slate-800 hover:bg-emerald-500/20 text-emerald-300 border border-slate-700 hover:border-emerald-500/40 transition-colors cursor-pointer"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 0021 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </button>
        </div>
      `;
    } else if (isWaitingAccept) {
      postActionsHtml = `
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="accept-transfer"
            data-transfer-id="${t.id}"
            class="px-2 py-0.5 rounded-md bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[10px] transition-colors cursor-pointer"
          >
            Aceitar
          </button>
          <button
            type="button"
            data-action="reject-transfer"
            data-transfer-id="${t.id}"
            class="px-1.5 py-0.5 rounded-md bg-slate-800 hover:bg-rose-500/30 text-rose-300 text-[10px] transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>
      `;
    }

    const deleteButtonHtml = `
      <button
        type="button"
        data-action="delete-single-transfer"
        data-transfer-id="${t.id}"
        title="Excluir transferência"
        class="p-1 rounded hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 text-[11px] font-bold transition-colors cursor-pointer shrink-0 ml-1"
      >
        ✕
      </button>
    `;

    let tunnelLinkBoxHtml = '';
    if (isTunnel && !isCancelled && !isExpired && !isCompleted) {
      let expBadge = '';
      if (t.expiresAt) {
        const remainingSec = Math.max(0, Math.floor((t.expiresAt - now) / 1000));
        if (remainingSec > 0) {
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          expBadge = `<span class="text-[9px] font-mono text-amber-300">⏳ ${m}m ${s}s</span>`;
        } else {
          expBadge = `<span class="text-[9px] font-mono text-rose-400 font-bold">⏳ Expirado</span>`;
        }
      } else {
        expBadge = `<span class="text-[9px] font-mono text-slate-400">⏳ Sem limite</span>`;
      }

      const pwdBadge = t.hasPassword
        ? `<span class="text-[9px] font-mono text-orange-300">🔑 Senha</span>`
        : `<span class="text-[9px] font-mono text-slate-500">🔓 Livre</span>`;

      const dlCounter = typeof t.downloads === 'number'
        ? `<span class="text-[9px] font-mono text-sky-300">⬇ ${t.downloads} dl</span>`
        : '';

      const pauseResumeBtn = isPaused
        ? `<button type="button" data-action="resume-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border border-emerald-500/40 text-[9px] font-bold cursor-pointer" title="Retomar link">▶ Retomar</button>`
        : `<button type="button" data-action="pause-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/40 text-[9px] font-bold cursor-pointer" title="Pausar link">⏸ Pausar</button>`;

      const closeTunnelBtn = `<button type="button" data-action="cancel-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold cursor-pointer" title="Encerrar link">✕ Encerrar</button>`;

      tunnelLinkBoxHtml = `
        <div class="mt-1 flex flex-col gap-1 bg-slate-950 border border-orange-500/30 rounded-lg p-1.5">
          <div class="flex items-center justify-between text-[10px]">
            <div class="flex items-center gap-1.5 truncate max-w-[220px]">
              <span class="font-mono text-orange-300 font-bold shrink-0">#${t.shareId}</span>
              ${expBadge}
              ${pwdBadge}
              ${dlCounter}
            </div>
            <div class="flex items-center gap-1 shrink-0">
              ${pauseResumeBtn}
              ${closeTunnelBtn}
            </div>
          </div>
          <div class="flex items-center justify-between gap-1 pt-1 border-t border-slate-800">
            <span class="text-[9px] font-mono text-slate-400 truncate flex-1" title="${t.shareUrl || ''}">
              ${t.shareUrl || ''}
            </span>
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                data-action="copy-tunnel-formatted"
                data-transfer-id="${t.id}"
                title="Copiar mensagem formatada com link, senha e arquivos"
                class="px-2 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500/40 text-orange-300 border border-orange-500/40 text-[10px] font-bold transition-colors cursor-pointer"
              >
                Copiar
              </button>
              <button
                type="button"
                data-action="open-tunnel-url"
                data-url="${t.shareUrl}"
                title="Abrir link no navegador"
                class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] transition-colors cursor-pointer"
              >
                ↗
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const displayName = t.packName || t.fileName || 'arquivo';

    let speedText = '';
    if (!isDone && !isError && !isPaused && !isCancelled && !isExpired && t.speedBps > 0) {
      speedText = ` • ${formatSpeed(t.speedBps)}`;
    }

    let routeBadgeHtml = '';
    if (isTunnel) {
      routeBadgeHtml = `<span class="text-[9px] font-mono px-1.5 py-0.2 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 shrink-0">Link WebRTC</span>`;
    } else if (t.direction === 'relay' || t.isRelayingForOthers) {
      routeBadgeHtml = `<span class="text-[9px] font-mono px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-bold shrink-0">🔁 Relay: ${t.fromPeer || 'origem'} ➔ ${t.toPeer || 'destino'}</span>`;
    } else if (t.routeType === 'MESH_RELAY' || t.relayTag) {
      routeBadgeHtml = `<span class="text-[9px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold shrink-0">🔀 Mesh (${t.relayTag})</span>`;
    } else {
      routeBadgeHtml = `<span class="text-[9px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">⚡ P2P Direto</span>`;
    }

    let statusText = '';
    if (isExpired) statusText = 'Expirado';
    else if (isCancelled) statusText = 'Cancelado';
    else if (isError) statusText = t.error || 'Erro';
    else if (isPaused) statusText = 'Pausado';
    else if (isWaitingAccept) statusText = 'Aguardando aceite';
    else if (isTunnel) statusText = isDone ? 'Link P2P Pronto' : 'Transmitindo...';
    else if (isDone) statusText = 'Concluído';
    else statusText = t.routeDescription || 'Transferindo...';

    card.innerHTML = `
      <div class="flex items-center justify-between gap-1.5">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${badgeColor} shrink-0">
            ${badgeLabel}
          </span>
          ${routeBadgeHtml}
          <span class="text-xs font-bold text-slate-100 truncate" title="${displayName}">
            ${displayName}
          </span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${controlButtonsHtml}
          ${postActionsHtml}
          ${deleteButtonHtml}
        </div>
      </div>

      <!-- Barra de Progresso -->
      <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
        <div class="${barColor} h-1.5 transition-all duration-200" style="width: ${pct}%"></div>
      </div>

      <div class="flex items-center justify-between text-[10px] font-mono text-slate-400">
        <span class="truncate max-w-[200px]">
          ${statusText}${speedText}
        </span>
        <span class="${pctColor} font-bold">
          ${pct}% (${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)})
        </span>
      </div>

      ${tunnelLinkBoxHtml}
    `;

    transfersList.appendChild(card);
  }
}

function updateNavBadges() {
  const allTransfers = Object.values(currentState.transfers || {});
  const now = Date.now();

  const activeCount = allTransfers.filter(
    (t) => t.status === 'TRANSFERRING' || t.status === 'CONNECTING' || (!isTransferHistory(t, now) && t.direction !== 'tunnel')
  ).length;

  if (navBadgeTransfers) {
    if (activeCount > 0) {
      navBadgeTransfers.textContent = String(activeCount);
      navBadgeTransfers.classList.remove('hidden');
    } else {
      navBadgeTransfers.classList.add('hidden');
    }
  }

  const activeLinks = allTransfers.filter(
    (t) => (t.direction === 'tunnel' || Boolean(t.shareId)) && t.status !== 'CANCELLED' && (!t.expiresAt || now < t.expiresAt)
  );

  if (navBadgeShares) {
    if (activeLinks.length > 0) {
      navBadgeShares.textContent = String(activeLinks.length);
      navBadgeShares.classList.remove('hidden');
    } else {
      navBadgeShares.classList.add('hidden');
    }
  }

  const peers = Object.values(currentState.peerRegistry || {}).filter(
    (p) => p.tag && p.tag !== currentState.myTag && (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
  );

  if (navBadgeMesh) {
    if (peers.length > 0) {
      navBadgeMesh.textContent = String(peers.length);
      navBadgeMesh.classList.remove('hidden');
    } else {
      navBadgeMesh.classList.add('hidden');
    }
  }
}

function renderShares() {
  if (!sharesList) return;

  const allTransfers = Object.values(currentState.transfers || {}).sort(
    (a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0)
  );

  const now = Date.now();
  const shareLinks = allTransfers.filter((t) => t.direction === 'tunnel' || Boolean(t.shareId));

  if (countShares) countShares.textContent = String(shareLinks.length);

  if (shareLinks.length === 0) {
    if (emptySharesState) emptySharesState.classList.remove('hidden');
    Array.from(sharesList.children).forEach((child) => {
      if (child.id !== 'empty-shares-state') child.remove();
    });
    return;
  }

  if (emptySharesState) emptySharesState.classList.add('hidden');
  Array.from(sharesList.children).forEach((child) => {
    if (child.id !== 'empty-shares-state') child.remove();
  });

  for (const t of shareLinks) {
    const isCancelled = t.status === 'CANCELLED';
    const isExpired = t.status === 'EXPIRED' || (t.expiresAt && now >= t.expiresAt);
    const isPermanent = !t.expiresAt;

    // Destinatário já iniciou a transferência e está em progresso
    const isInProgress = !isCancelled && !isExpired && (
      t.inProgress === true ||
      t.status === 'TRANSFERRING' ||
      t.status === 'CONNECTING'
    );

    const completedDownloads = Number(t.completedDownloads || t.completedPacks || 0);
    const totalDownloads = Number(t.downloads || 0);

    const card = document.createElement('div');
    card.className =
      `p-3 rounded-xl bg-slate-900 border ${
        isInProgress
          ? 'border-emerald-500/60 shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500/30'
          : isExpired || isCancelled
          ? 'border-slate-800/80 opacity-75'
          : 'border-slate-800'
      } flex flex-col gap-2 transition-all`;

    // Badges de tipo / expiração
    let typeBadgeHtml = '';
    if (isCancelled) {
      typeBadgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">Cancelado</span>`;
    } else if (isExpired) {
      typeBadgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">Expirado</span>`;
    } else if (isPermanent) {
      typeBadgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center gap-1 font-mono">♾️ Link Permanente</span>`;
    } else {
      const remainingSec = Math.max(0, Math.floor((t.expiresAt - now) / 1000));
      const m = Math.floor(remainingSec / 60);
      const s = remainingSec % 60;
      typeBadgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono">⏳ Expira em ${m}m ${s}s</span>`;
    }

    // Seção de Progresso em Tempo Real / Notificação de Início do Destinatário
    let inProgressSectionHtml = '';
    if (isInProgress) {
      const pct = Math.min(100, Math.max(0, Math.round(t.progress || 0)));
      const speed = t.speedBps ? formatSpeed(t.speedBps) : 'iniciando conexão...';
      const transferred = formatBytes(t.transferredBytes || 0);
      const total = formatBytes(t.totalSize || t.fileSize || 0);

      inProgressSectionHtml = `
        <div class="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 flex flex-col gap-1.5 shadow-sm">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold text-emerald-300 flex items-center gap-1.5 animate-pulse">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>Destinatário iniciou a transferência!</span>
            </span>
            <span class="text-emerald-400 font-mono font-bold">${pct}% • ${speed}</span>
          </div>
          <div class="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
            <div class="bg-gradient-to-r from-emerald-500 to-green-400 h-1.5 transition-all duration-150" style="width: ${pct}%"></div>
          </div>
          <div class="flex items-center justify-between text-[9px] font-mono text-emerald-300/80">
            <span>Enviando dados via WebRTC P2P</span>
            <span>${transferred} / ${total}</span>
          </div>
        </div>
      `;
    } else if (!isExpired && !isCancelled) {
      if (completedDownloads > 0) {
        inProgressSectionHtml = `
          <div class="flex items-center justify-between text-[10px] px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400">
            <span class="flex items-center gap-1.5 text-emerald-400 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              <span>Pronto para novos downloads</span>
            </span>
            <span class="text-slate-400 font-mono">${isPermanent ? 'Ativo permanentemente' : 'Aguardando'}</span>
          </div>
        `;
      } else {
        inProgressSectionHtml = `
          <div class="flex items-center justify-between text-[10px] px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400">
            <span class="flex items-center gap-1.5 text-amber-400 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              <span>Aguardando destinatário acessar o link</span>
            </span>
            <span class="text-slate-500 font-mono">Pendente</span>
          </div>
        `;
      }
    }

    // Se for um link permanente, DEVE MOSTRAR o número de downloads já concluídos associados àquele link!
    let downloadsCountHtml = '';
    if (isPermanent) {
      downloadsCountHtml = `
        <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-indigo-950/40 border border-indigo-500/30 text-xs">
          <span class="text-indigo-200 font-semibold flex items-center gap-1.5">
            <svg class="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <span>Downloads concluídos:</span>
          </span>
          <span class="font-mono font-bold text-emerald-400 text-sm bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">${completedDownloads}</span>
        </div>
      `;
    } else {
      downloadsCountHtml = `
        <div class="flex items-center justify-between text-[10px] text-slate-400 px-1">
          <span>Downloads concluídos: <strong class="text-emerald-400 font-mono">${completedDownloads}</strong>${
            t.maxDownloads ? ` / ${t.maxDownloads} máx` : ''
          }</span>
          ${totalDownloads > completedDownloads ? `<span class="text-[9px] text-slate-500 font-mono">(${totalDownloads} tentativas)</span>` : ''}
        </div>
      `;
    }

    // Senha se houver
    let passwordHtml = '';
    if (t.hasPassword && t.password) {
      passwordHtml = `
        <div class="flex items-center justify-between text-[10px] px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
          <span class="text-slate-400">🔑 Senha de proteção:</span>
          <div class="flex items-center gap-1.5 font-mono">
            <span class="font-bold text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">${escapeHtml(t.password)}</span>
            <button
              type="button"
              data-action="copy-text"
              data-text="${escapeHtml(t.password)}"
              class="text-slate-400 hover:text-white px-1 cursor-pointer"
              title="Copiar senha"
            >📋</button>
          </div>
        </div>
      `;
    }

    const displayName = t.packName || t.fileName || 'Pack Compartilhado';
    const totalSize = t.totalSize || t.fileSize || 0;
    const filesCount = Array.isArray(t.files) ? t.files.length : 1;

    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
            ${typeBadgeHtml}
            <span class="text-[10px] font-mono text-orange-400 font-bold">#${t.shareId}</span>
          </div>
          <span class="text-xs font-bold text-white truncate" title="${displayName}">
            ${displayName}
          </span>
          <span class="text-[10px] text-slate-400">
            ${filesCount} arquivo${filesCount > 1 ? 's' : ''} • ${formatBytes(totalSize)}
          </span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="delete-single-transfer"
            data-transfer-id="${t.id}"
            title="Encerrar e excluir este compartilhamento"
            class="p-1 rounded-lg hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 text-xs font-bold transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>
      </div>

      ${inProgressSectionHtml}

      ${downloadsCountHtml}

      ${passwordHtml}

      <!-- URL e Botões de Compartilhar -->
      <div class="flex items-center justify-between gap-1.5 pt-1.5 border-t border-slate-800/80">
        <span class="text-[9px] font-mono text-slate-400 truncate flex-1" title="${t.shareUrl || ''}">
          ${t.shareUrl || ''}
        </span>
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="copy-tunnel-formatted"
            data-transfer-id="${t.id}"
            title="Copiar mensagem formatada completa (link + arquivos + senha)"
            class="px-2.5 py-1 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/30 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1"
          >
            <span>📋 Copiar Link</span>
          </button>
          <button
            type="button"
            data-action="open-tunnel-url"
            data-url="${t.shareUrl}"
            title="Abrir no navegador"
            class="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors cursor-pointer"
          >
            ↗
          </button>
        </div>
      </div>
    `;

    sharesList.appendChild(card);
  }
}

function syncModalWithState() {
  if (Array.isArray(currentState.stagedTunnelFiles)) {
    if (stagedTunnelFiles.length === 0 && currentState.stagedTunnelFiles.length > 0) {
      for (const f of currentState.stagedTunnelFiles) {
        stagedTunnelFiles.push({
          fileId: f.fileId || `f-${stagedTunnelFiles.length}`,
          name: f.name,
          size: f.size,
          type: f.type || 'application/octet-stream',
          fileObj: null
        });
      }
    }
  }

  if (currentState.tunnelModalOpen && tunnelConfigModal) {
    if (currentState.modalMode === 'tunnel') {
      openModalForTunnel();
    } else {
      openModalForP2P(currentState.modalTargetTag || (targetTagInput ? targetTagInput.value : ''));
    }
  } else if (tunnelConfigModal) {
    tunnelConfigModal.classList.add('hidden');
  }
  renderModalFiles();
}

function renderRegistrationCard() {
  const isRegistered = Boolean(currentState.myTag && currentState.myTag.startsWith('@'));
  const myEntry = currentState.peerRegistry ? currentState.peerRegistry[currentState.myTag] : null;

  if (myTagInput && document.activeElement !== myTagInput) {
    myTagInput.value = isRegistered ? currentState.myTag.replace(/^@/, '') : '';
  }

  if (registrationStatusBadge) {
    if (isRegistered) {
      registrationStatusBadge.textContent = '🟢 Registrado';
      registrationStatusBadge.className =
        'text-[9px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium';
    } else {
      registrationStatusBadge.textContent = 'Não registrado';
      registrationStatusBadge.className =
        'text-[9px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
    }
  }

  if (registeredUserInfo) {
    if (isRegistered && myEntry) {
      registeredUserInfo.classList.remove('hidden');
      if (registeredHashDisplay) {
        registeredHashDisplay.textContent =
          myEntry.regHash || ('0x' + (myEntry.nodeId || currentState.nodeId || '').replace(/[^a-f0-9]/gi, '').slice(0, 16));
      }
    } else {
      registeredUserInfo.classList.add('hidden');
    }
  }

  if (btnSaveTagText && (!btnSaveTag || !btnSaveTag.disabled)) {
    btnSaveTagText.textContent = isRegistered ? 'Alterar' : 'Registrar';
  }
}

function renderAll() {
  renderConnectionStatus();
  renderRegistrationCard();
  renderSettingsSwitches();
  renderPeerDirectory();
  renderReceiveButton();
  renderTransfers();
  renderShares();
  renderMeshUsersTab();
  updateNavBadges();
  syncModalWithState();
}

// ============================================================================
// Ações de Interface e Eventos
// ============================================================================

// Expandir para Nova Aba (Visualização Completa do Gerenciador)
if (btnExpandWindow) {
  btnExpandWindow.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
  });
}

// Configurações Dropdown
if (btnSettings && settingsPanel) {
  btnSettings.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });
}

if (btnCloseSettings && settingsPanel) {
  btnCloseSettings.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });
}

if (toggleAutoOpen) {
  toggleAutoOpen.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_OPEN_ON_RECEIVE' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderSettingsSwitches();
      }
    });
  });
}

if (toggleAutoAccept) {
  toggleAutoAccept.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_ACCEPT' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderSettingsSwitches();
      }
    });
  });
}

if (settingPortalUrl) {
  chrome.storage.local.get(['portalUrl'], (res) => {
    settingPortalUrl.value = res.portalUrl || DEFAULT_PORTAL_URL;
  });

  settingPortalUrl.addEventListener('change', () => {
    const val = (settingPortalUrl.value || '').trim() || DEFAULT_PORTAL_URL;
    chrome.storage.local.set({ portalUrl: val });
    showToast('URL do Portal Público atualizada!');
  });
}

if (btnResetPortalUrl && settingPortalUrl) {
  btnResetPortalUrl.addEventListener('click', () => {
    settingPortalUrl.value = DEFAULT_PORTAL_URL;
    chrome.storage.local.set({ portalUrl: DEFAULT_PORTAL_URL });
    showToast('URL restaurada para o padrão!');
  });
}

function registerUser() {
  const rawValue = myTagInput ? myTagInput.value : '';
  const newTag = normalizeTag(rawValue);

  if (!newTag || newTag.length < 3) {
    showToast('O nome de usuário deve ter pelo menos 3 caracteres.', 'error');
    if (myTagInput) myTagInput.focus();
    return;
  }

  if (!/^@[a-zA-Z0-9_]{2,30}$/.test(newTag)) {
    showToast('Use apenas letras, números e sublinhado (ex: @usuario).', 'error');
    if (myTagInput) myTagInput.focus();
    return;
  }

  // Se já está registrado com este exato nome
  if (currentState.myTag && normalizeTag(currentState.myTag) === newTag) {
    showToast(`Você já está registrado na rede como ${newTag}.`, 'info');
    return;
  }

  // Validação rápida no catálogo local antes de enviar à rede
  const localConflict = Object.values(currentState.peerRegistry || {}).find(
    (p) => p.tag && normalizeTag(p.tag) === newTag && p.tag !== currentState.myTag
  );
  if (localConflict) {
    showToast(`O usuário ${newTag} já existe na rede descentralizada! Escolha outro nome.`, 'error');
    if (myTagInput) myTagInput.focus();
    return;
  }

  // Estado de carregamento no botão
  if (btnSaveTag) btnSaveTag.disabled = true;
  if (btnSaveTagText) btnSaveTagText.textContent = 'Validando...';
  showToast('Validando disponibilidade na rede descentralizada...', 'info');

  chrome.runtime.sendMessage({ action: 'REGISTER_USER', tag: newTag }, (res) => {
    if (btnSaveTag) btnSaveTag.disabled = false;
    if (btnSaveTagText) btnSaveTagText.textContent = currentState.myTag ? 'Alterar' : 'Registrar';

    if (!res || !res.ok) {
      const errMsg = (res && res.error) || `O usuário ${newTag} já existe na rede descentralizada!`;
      showToast(errMsg, 'error');
      if (myTagInput) myTagInput.focus();
      return;
    }

    if (res.state) {
      currentState = res.state;
    }
    currentState.myTag = res.tag;
    if (myTagInput) myTagInput.value = res.tag.replace(/^@/, '');

    showToast(`Usuário ${res.tag} validado e registrado com sucesso na rede!`, 'success');
    renderAll();
  });
}

if (btnSaveTag) {
  btnSaveTag.addEventListener('click', registerUser);
}

if (myTagInput) {
  myTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') registerUser();
  });
}

if (targetTagInput) {
  targetTagInput.addEventListener('input', () => {
    chrome.storage.local.set({ lastTargetTag: targetTagInput.value.trim() });
    renderPeerDirectory();
  });
}

// Modal de Configuração do Pack
function openModalForTunnel() {
  if (!currentState.myTag) {
    showToast('Registre um nome de usuário antes de gerar links públicos na rede descentralizada.', 'warning');
    if (myTagInput) myTagInput.focus();
    return;
  }
  currentModalMode = 'tunnel';
  if (modalHeaderTitle) modalHeaderTitle.textContent = 'Gerar Link Público (GitHub Pages WebRTC)';
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-orange-400';

  if (modalP2pTargetSection) {
    modalP2pTargetSection.classList.add('hidden');
  }

  if (btnModalAddMore) {
    btnModalAddMore.className =
      'text-orange-300 hover:text-white bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/30 px-2.5 py-1 rounded-lg text-[10px] font-bold cursor-pointer transition-colors';
  }

  if (modalTunnelOptions) modalTunnelOptions.classList.remove('hidden');

  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500 text-white text-xs font-bold shadow-md border border-orange-400/30 transition-all cursor-pointer flex items-center justify-center gap-1.5';
    btnModalConfirm.innerHTML = `
      <svg class="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
      </svg>
      <span>Confirmar & Gerar Link</span>
    `;
  }
  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({
    action: 'SET_TUNNEL_MODAL_OPEN',
    open: true,
    mode: 'tunnel'
  });
  renderModalFiles();
}

function openModalForP2P(targetTag = '') {
  if (!currentState.myTag) {
    showToast('Registre um nome de usuário antes de enviar arquivos na rede descentralizada.', 'warning');
    if (myTagInput) myTagInput.focus();
    return;
  }
  currentModalMode = 'p2p';

  let target = targetTag || (targetTagInput ? targetTagInput.value.trim() : '');
  if (!target) {
    const now = Date.now();
    const onlinePeers = Object.values(currentState.peerRegistry || {}).filter(
      (p) => p.tag && p.tag !== currentState.myTag && (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
    );
    if (onlinePeers.length === 1) {
      target = onlinePeers[0].tag;
    }
  }

  if (target) {
    target = target.startsWith('@') ? target : `@${target}`;
    if (targetTagInput) targetTagInput.value = target;
    chrome.storage.local.set({ lastTargetTag: target });
  }

  if (modalHeaderTitle) {
    modalHeaderTitle.textContent = target
      ? `Enviar para ${target} (P2P Direto)`
      : 'Enviar para Usuário (P2P Direto)';
  }
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';

  if (modalP2pTargetSection) {
    modalP2pTargetSection.classList.remove('hidden');
  }
  if (modalTargetTagInput) {
    modalTargetTagInput.value = target ? target.replace(/^@+/, '') : '';
  }
  populateModalPeerSelect(target);

  if (btnModalAddMore) {
    btnModalAddMore.className =
      'text-emerald-300 hover:text-white bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 px-2.5 py-1 rounded-lg text-[10px] font-bold cursor-pointer transition-colors';
  }

  // Opções do link público (Tempo de expiração, limite e senha): TOTALMENTE OCULTAS
  if (modalTunnelOptions) {
    modalTunnelOptions.classList.add('hidden');
  }

  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white text-xs font-bold shadow-md border border-emerald-400/30 transition-all cursor-pointer flex items-center justify-center gap-1.5';
    btnModalConfirm.innerHTML = `
      <svg class="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
      </svg>
      <span>${target ? `Enviar para ${target}` : 'Enviar Arquivos'}</span>
    `;
  }

  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({
    action: 'SET_TUNNEL_MODAL_OPEN',
    open: true,
    mode: 'p2p',
    targetTag: target
  });
  renderModalFiles();
}

if (modalTargetTagInput) {
  modalTargetTagInput.addEventListener('input', () => {
    const raw = modalTargetTagInput.value.trim();
    const tag = raw ? (raw.startsWith('@') ? raw : `@${raw}`) : '';
    if (targetTagInput) targetTagInput.value = tag;
    chrome.storage.local.set({ lastTargetTag: tag });

    if (currentModalMode === 'p2p' && btnModalConfirm) {
      const btnSpan = btnModalConfirm.querySelector('span');
      if (btnSpan) btnSpan.textContent = tag ? `Enviar para ${tag}` : 'Enviar Arquivos';
      if (modalHeaderTitle) {
        modalHeaderTitle.textContent = tag
          ? `Enviar para ${tag} (P2P Direto)`
          : 'Enviar para Usuário (P2P Direto)';
      }
    }
  });
}

if (modalTargetTagSelect) {
  modalTargetTagSelect.addEventListener('change', () => {
    const chosenTag = modalTargetTagSelect.value;
    if (chosenTag) {
      if (modalTargetTagInput) modalTargetTagInput.value = chosenTag.replace(/^@+/, '');
      if (targetTagInput) targetTagInput.value = chosenTag;
      chrome.storage.local.set({ lastTargetTag: chosenTag });

      if (currentModalMode === 'p2p' && btnModalConfirm) {
        const btnSpan = btnModalConfirm.querySelector('span');
        if (btnSpan) btnSpan.textContent = `Enviar para ${chosenTag}`;
        if (modalHeaderTitle) modalHeaderTitle.textContent = `Enviar para ${chosenTag} (P2P Direto)`;
      }
    }
  });
}

if (btnSend) {
  btnSend.addEventListener('click', () => {
    let targetTag = normalizeTag(targetTagInput ? targetTagInput.value : '');
    if (!targetTag || targetTag.length < 3) {
      const now = Date.now();
      const onlinePeers = Object.values(currentState.peerRegistry || {}).filter(
        (p) => p.tag && p.tag !== currentState.myTag && (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
      );
      if (onlinePeers.length === 1) {
        targetTag = onlinePeers[0].tag;
        if (targetTagInput) targetTagInput.value = targetTag;
        chrome.storage.local.set({ lastTargetTag: targetTag });
      }
    }
    openModalForP2P(targetTag);
  });
}

if (btnCloudflareTunnel) {
  btnCloudflareTunnel.addEventListener('click', () => {
    openModalForTunnel();
  });
}

function renderModalFiles() {
  if (!modalFilesList) return;
  modalFilesList.innerHTML = '';
  if (stagedTunnelFiles.length === 0) {
    if (modalFilesSummary) modalFilesSummary.textContent = 'Itens no Pack (0) • 0 B';
    modalFilesList.innerHTML = `
      <div class="flex flex-col items-center justify-center py-5 px-3 text-center gap-1.5 text-slate-400">
        <svg class="w-7 h-7 text-slate-600 mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
        </svg>
        <span class="text-xs font-semibold text-slate-300">Arraste arquivos ou pastas para cá</span>
        <span class="text-[10px] text-slate-500">ou use os botões <strong class="text-orange-400">+ Arquivos</strong> e <strong class="text-emerald-400">+ Pasta</strong> acima</span>
      </div>
    `;
    return;
  }

  const totalBytes = stagedTunnelFiles.reduce((acc, f) => acc + (f.size || 0), 0);
  if (modalFilesSummary) {
    modalFilesSummary.textContent = `Itens no Pack (${stagedTunnelFiles.length}) • ${formatBytes(totalBytes)}`;
  }

  stagedTunnelFiles.forEach((file, index) => {
    const isFolderItem = Boolean(file.name && file.name.includes('/'));
    const item = document.createElement('div');
    item.className =
      'flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs shadow-sm';
    item.innerHTML = `
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xs ${isFolderItem ? 'text-emerald-400' : 'text-sky-400'} font-mono shrink-0">${isFolderItem ? '📁' : '📄'}</span>
        <span class="text-[11px] text-slate-200 font-medium truncate max-w-[220px]" title="${file.name}">
          ${file.name}
        </span>
        <span class="text-[10px] text-slate-400 font-mono shrink-0">
          (${formatBytes(file.size)})
        </span>
      </div>
      <button
        type="button"
        data-remove-index="${index}"
        class="text-slate-500 hover:text-rose-400 font-bold px-1 text-xs cursor-pointer transition-colors"
        title="Remover do pack"
      >
        ✕
      </button>
    `;
    modalFilesList.appendChild(item);
  });
}

if (modalFilesList) {
  modalFilesList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-remove-index]');
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-remove-index'));
    if (!Number.isNaN(idx) && idx >= 0 && idx < stagedTunnelFiles.length) {
      const removed = stagedTunnelFiles.splice(idx, 1)[0];
      if (removed && removed.fileId) {
        deleteStagedFile(removed.fileId);
      }
      renderModalFiles();
      try {
        chrome.runtime.sendMessage({ action: 'REMOVE_STAGED_TUNNEL_FILE', index: idx }).catch(() => {});
      } catch {}
    }
  });
}

// Manipulação Imediata de Arquivos e Pastas Selecionados
function handleSelectedFiles(files) {
  if (!files || files.length === 0) return;
  const filesArray = Array.from(files);
  let addedCount = 0;
  for (const f of filesArray) {
    if (!f) continue;
    const relPath = f.relativePath || f.webkitRelativePath || f.name;
    const normalizedName = relPath.replace(/^\/+/, '');
    const fileId = `f-${stagedTunnelFiles.length}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    
    let fileObj = f;
    if (normalizedName !== f.name) {
      try {
        fileObj = new File([f], normalizedName, { type: f.type, lastModified: f.lastModified });
        fileObj.relativePath = normalizedName;
      } catch {
        f.relativePath = normalizedName;
        fileObj = f;
      }
    }

    stagedTunnelFiles.push({
      fileId,
      name: normalizedName,
      size: f.size || 0,
      type: f.type || 'application/octet-stream',
      fileObj
    });
    addedCount++;
    // Persiste imediatamente em memória (offscreen) e IndexedDB de forma não-bloqueante
    saveStagedFile(fileId, fileObj).catch((err) => {
      console.warn('saveStagedFile background warning:', err);
    });
  }

  // Atualização SÍNCRONA da UI (<1ms)
  renderModalFiles();

  try {
    chrome.runtime.sendMessage({
      action: 'ADD_STAGED_TUNNEL_FILES',
      files: stagedTunnelFiles.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        size: f.size,
        type: f.type
      }))
    }).catch(() => {});
  } catch {}

  if (addedCount > 0) {
    showToast(`✓ ${addedCount} arquivo(s) adicionado(s) com sucesso!`);
  }
}

// Leitura Recursiva de Diretórios via FileSystemDirectoryHandle (File System Access API)
async function getFilesFromDirectoryHandle(dirHandle, path = '') {
  const files = [];
  try {
    for await (const entry of dirHandle.values()) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        try {
          const file = await entry.getFile();
          if (file) {
            let namedFile = file;
            try {
              namedFile = new File([file], entryPath, { type: file.type, lastModified: file.lastModified });
              namedFile.relativePath = entryPath;
            } catch {
              file.relativePath = entryPath;
              namedFile = file;
            }
            files.push(namedFile);
          }
        } catch (e) {
          console.warn(`Erro ao ler arquivo ${entry.name}:`, e);
        }
      } else if (entry.kind === 'directory') {
        const subFiles = await getFilesFromDirectoryHandle(entry, entryPath);
        files.push(...subFiles);
      }
    }
  } catch (err) {
    console.error('Erro ao iterar diretório:', err);
  }
  return files;
}

// Diálogo nativo de seleção de pasta (Modern API + Fallback)
async function pickFolder() {
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const dirHandle = await window.showDirectoryPicker();
      if (!dirHandle) return;
      const files = await getFilesFromDirectoryHandle(dirHandle, dirHandle.name);
      if (files && files.length > 0) {
        handleSelectedFiles(files);
        return;
      } else {
        showToast('Nenhum arquivo encontrado na pasta selecionada.');
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // Cancelado pelo usuário
      console.warn('showDirectoryPicker não suportado ou negado, fallback para input:', err);
    }
  }

  // Fallback: input file com webkitdirectory + directory + mozdirectory + multiple
  if (modalFolderInput) {
    modalFolderInput.click();
  }
}

if (btnModalAddMore && modalFileInput) {
  btnModalAddMore.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalFileInput.click();
  });
}

if (btnModalAddFolder) {
  btnModalAddFolder.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await pickFolder();
  });
}

if (modalFileInput) {
  modalFileInput.addEventListener('change', (e) => {
    try {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        handleSelectedFiles(files);
      }
    } catch (err) {
      console.error('Erro ao ler arquivos:', err);
    } finally {
      modalFileInput.value = '';
    }
  });
}

if (modalFolderInput) {
  modalFolderInput.addEventListener('change', (e) => {
    try {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        handleSelectedFiles(files);
      } else {
        showToast('Nenhum arquivo encontrado na pasta selecionada.');
      }
    } catch (err) {
      console.error('Erro ao ler pasta:', err);
      showToast('Erro ao ler pasta selecionada.');
    } finally {
      modalFolderInput.value = '';
    }
  });
}

// Suporte a Leitura Recursiva de Diretórios via Drag & Drop (FileSystemHandle + webkitGetAsEntry)
async function getFilesFromDataTransfer(items, dataTransferFiles) {
  const result = [];
  if (!items || items.length === 0) {
    return Array.from(dataTransferFiles || []);
  }

  // Tenta FileSystemHandle primeiro (modern Chromium no Linux/ChromeOS/Windows)
  try {
    const handles = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].getAsFileSystemHandle) {
        const handle = await items[i].getAsFileSystemHandle();
        if (handle) handles.push(handle);
      }
    }
    if (handles.length > 0) {
      for (const h of handles) {
        if (h.kind === 'file') {
          const file = await h.getFile();
          if (file) result.push(file);
        } else if (h.kind === 'directory') {
          const dirFiles = await getFilesFromDirectoryHandle(h, h.name);
          result.push(...dirFiles);
        }
      }
      if (result.length > 0) {
        return result;
      }
    }
  } catch (e) {
    console.warn('Erro ao processar via getAsFileSystemHandle:', e);
  }

  const queue = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind && item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) {
      queue.push(entry);
    } else {
      const f = item.getAsFile ? item.getAsFile() : null;
      if (f) result.push(f);
    }
  }

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;

    if (entry.isFile) {
      try {
        const file = await new Promise((res) => {
          entry.file(
            (f) => res(f),
            () => res(null)
          );
        });
        if (file) {
          let finalFile = file;
          if (entry.fullPath && entry.fullPath.startsWith('/')) {
            const rel = entry.fullPath.slice(1);
            try {
              finalFile = new File([file], rel, { type: file.type, lastModified: file.lastModified });
              finalFile.relativePath = rel;
            } catch {
              file.relativePath = rel;
              finalFile = file;
            }
          }
          result.push(finalFile);
        }
      } catch {}
    } else if (entry.isDirectory) {
      try {
        const dirReader = entry.createReader();
        const readEntriesBatch = () =>
          new Promise((res) => {
            dirReader.readEntries(
              (entries) => res(entries || []),
              () => res([])
            );
          });

        let batch;
        do {
          batch = await readEntriesBatch();
          if (batch && batch.length > 0) {
            queue.push(...batch);
          }
        } while (batch && batch.length > 0);
      } catch (err) {
        console.warn('Erro ao ler entradas do diretório:', err);
      }
    }
  }

  if (result.length === 0 && dataTransferFiles && dataTransferFiles.length > 0) {
    return Array.from(dataTransferFiles);
  }
  return result;
}

// Drag & Drop no DropZone específico do Modal
if (modalDropZone) {
  modalDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDropZone.classList.add('border-orange-500', 'bg-orange-500/10');
  });

  modalDropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDropZone.classList.remove('border-orange-500', 'bg-orange-500/10');
  });

  modalDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalDropZone.classList.remove('border-orange-500', 'bg-orange-500/10');
    try {
      const files = await getFilesFromDataTransfer(e.dataTransfer?.items, e.dataTransfer?.files);
      if (files && files.length > 0) {
        handleSelectedFiles(files);
      }
    } catch (err) {
      console.error('Erro ao processar drop no modal:', err);
    }
  });
}

// Suporte Global de Drag & Drop em toda a janela do Popup
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (modalDropZone) {
    modalDropZone.classList.add('border-orange-500', 'bg-orange-500/10');
  }
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (!e.relatedTarget && modalDropZone) {
    modalDropZone.classList.remove('border-orange-500', 'bg-orange-500/10');
  }
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (modalDropZone) {
    modalDropZone.classList.remove('border-orange-500', 'bg-orange-500/10');
  }
  try {
    const files = await getFilesFromDataTransfer(e.dataTransfer?.items, e.dataTransfer?.files);
    if (files && files.length > 0) {
      if (tunnelConfigModal && tunnelConfigModal.classList.contains('hidden')) {
        const curTarget = normalizeTag(targetTagInput ? targetTagInput.value : '');
        if (currentModalMode === 'tunnel') {
          openModalForTunnel();
        } else {
          openModalForP2P(curTarget);
        }
      }
      handleSelectedFiles(files);
    }
  } catch (err) {
    console.error('Erro no drag & drop global:', err);
  }
});

// Opções de Compactação do Pack
if (modalCompressToggle) {
  modalCompressToggle.addEventListener('change', () => {
    if (modalCompressToggle.checked) {
      modalCompressOptions.classList.remove('hidden');
    } else {
      modalCompressOptions.classList.add('hidden');
    }
  });
}

if (btnModalGenPassword && modalPasswordInput) {
  btnModalGenPassword.addEventListener('click', () => {
    const randomPass = Math.floor(100000 + Math.random() * 900000).toString();
    modalPasswordInput.value = randomPass;
  });
}

if (btnModalClearPassword && modalPasswordInput) {
  btnModalClearPassword.addEventListener('click', () => {
    modalPasswordInput.value = '';
  });
}

function closeAndResetModal() {
  tunnelConfigModal.classList.add('hidden');
  stagedTunnelFiles = [];
  if (modalCompressToggle) modalCompressToggle.checked = false;
  if (modalCompressOptions) modalCompressOptions.classList.add('hidden');
  chrome.runtime.sendMessage({ action: 'CLEAR_STAGED_TUNNEL_FILES' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
}

if (btnModalClose) btnModalClose.addEventListener('click', closeAndResetModal);
if (btnModalCancel) btnModalCancel.addEventListener('click', closeAndResetModal);

if (btnModalConfirm) {
  btnModalConfirm.addEventListener('click', async () => {
    if (stagedTunnelFiles.length === 0) {
      showToast('Adicione pelo menos um arquivo ou pasta.');
      return;
    }

    const isCompressEnabled = Boolean(modalCompressToggle && modalCompressToggle.checked);
    const compressLevel = modalCompressLevel ? Number(modalCompressLevel.value) : 6;
    const customCompressName = modalCompressName ? modalCompressName.value.trim() : '';

    btnModalConfirm.disabled = true;
    const originalConfirmHTML = btnModalConfirm.innerHTML;

    try {
      // ======================================================================
      // MODO P2P: Envio Direto para Usuário (SEM gerar link público!)
      // ======================================================================
      if (currentModalMode === 'p2p') {
        const modalTagVal = modalTargetTagInput ? modalTargetTagInput.value.trim() : '';
        const rawTag = modalTagVal
          ? (modalTagVal.startsWith('@') ? modalTagVal : `@${modalTagVal}`)
          : (targetTagInput ? targetTagInput.value.trim() : '');
        const targetTag = normalizeTag(rawTag);

        if (!targetTag || targetTag.length < 3) {
          showToast('Informe ou selecione o @destinatário para enviar.');
          if (modalTargetTagInput) modalTargetTagInput.focus();
          btnModalConfirm.disabled = false;
          return;
        }

        if (targetTag === currentState.myTag) {
          showToast('Escolha um @destinatário diferente do seu próprio ID.');
          btnModalConfirm.disabled = false;
          return;
        }

        if (targetTagInput) targetTagInput.value = targetTag;
        chrome.storage.local.set({ lastTargetTag: targetTag });

        let filesToSend = [];

        if (isCompressEnabled) {
          btnModalConfirm.innerHTML = `<span>Compactando pack em .ZIP (Nível ${compressLevel})...</span>`;

          if (typeof fflate === 'undefined' || !fflate.zipSync) {
            throw new Error('Biblioteca de compressão fflate não carregada.');
          }

          const zipData = {};
          for (const f of stagedTunnelFiles) {
            let rawFile = f.fileObj;
            if (!rawFile || !(rawFile instanceof Blob)) {
              rawFile = await getStagedFile(f.fileId);
            }
            if (!rawFile) {
              throw new Error(`Arquivo "${f.name}" não encontrado na memória/cache.`);
            }
            const ab = await rawFile.arrayBuffer();
            zipData[f.name] = [new Uint8Array(ab), { level: compressLevel }];
          }

          const zippedU8 = fflate.zipSync(zipData, { level: compressLevel });
          const rawBaseName =
            customCompressName ||
            (stagedTunnelFiles.length === 1
              ? stagedTunnelFiles[0].name.replace(/\.[^/.]+$/, '')
              : 'Arquivos_Compartilhados');

          const zipFileName = rawBaseName.replace(/\.zip$/i, '') + '.zip';
          const zipFile = new File([zippedU8], zipFileName, { type: 'application/zip' });

          filesToSend = [{ file: zipFile, name: zipFileName, size: zipFile.size, type: 'application/zip' }];
        } else {
          for (let i = 0; i < stagedTunnelFiles.length; i++) {
            const f = stagedTunnelFiles[i];
            let rawFile = f.fileObj;
            if (!rawFile || !(rawFile instanceof Blob)) {
              rawFile = await getStagedFile(f.fileId);
            }
            if (!rawFile) {
              throw new Error(`Arquivo "${f.name}" não encontrado na memória/cache.`);
            }
            filesToSend.push({
              file: rawFile,
              name: f.name,
              size: f.size,
              type: f.type || 'application/octet-stream'
            });
          }
        }

        btnModalConfirm.innerHTML = `<span>Iniciando envio P2P para ${targetTag}...</span>`;

        for (const item of filesToSend) {
          const transferId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          await saveStagedFile(transferId, item.file);

          chrome.runtime.sendMessage({
            action: 'START_SEND_FILE',
            transferId,
            targetTag,
            fileMeta: {
              name: item.name,
              size: item.size,
              type: item.type
            }
          });
        }

        showToast(`✓ Enviando ${filesToSend.length} item(ns) para ${targetTag} via P2P!`);
        switchTab('active');
        closeAndResetModal();
        return;
      }

      // ======================================================================
      // MODO TUNNEL: Geração de Link Público (GitHub Pages WebRTC)
      // ======================================================================
      let finalFilesMeta = [];
      let finalPackName = '';
      let finalTotalSize = 0;
      let createdZipFile = null;

      const shareId = `ps-${Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      if (isCompressEnabled) {
        btnModalConfirm.innerHTML = `<span>Compactando pack em .ZIP (Nível ${compressLevel})...</span>`;

        if (typeof fflate === 'undefined' || !fflate.zipSync) {
          throw new Error('Biblioteca de compressão fflate não carregada.');
        }

        const zipData = {};
        for (const f of stagedTunnelFiles) {
          let rawFile = f.fileObj;
          if (!rawFile || !(rawFile instanceof Blob)) {
            rawFile = await getStagedFile(f.fileId);
          }
          if (!rawFile) {
            throw new Error(`Arquivo "${f.name}" não encontrado na memória/cache.`);
          }
          const ab = await rawFile.arrayBuffer();
          zipData[f.name] = [new Uint8Array(ab), { level: compressLevel }];
        }

        const zippedU8 = fflate.zipSync(zipData, { level: compressLevel });

        const rawBaseName =
          customCompressName ||
          (stagedTunnelFiles.length === 1
            ? stagedTunnelFiles[0].name.replace(/\.[^/.]+$/, '')
            : 'Pack_Compartilhado');

        const zipFileName = rawBaseName.replace(/\.zip$/i, '') + '.zip';
        const zipFile = new File([zippedU8], zipFileName, { type: 'application/zip' });
        createdZipFile = zipFile;

        await saveStagedFile(`${shareId}:f-0`, zipFile);
        await saveStagedFile(shareId, zipFile);

        finalFilesMeta = [
          {
            fileId: 'f-0',
            name: zipFileName,
            size: zipFile.size,
            type: 'application/zip'
          }
        ];
        finalPackName = zipFileName;
        finalTotalSize = zipFile.size;
      } else {
        finalFilesMeta = [];
        for (let i = 0; i < stagedTunnelFiles.length; i++) {
          const f = stagedTunnelFiles[i];
          const fileId = `f-${i}`;
          let rawFile = f.fileObj;
          if (!rawFile || !(rawFile instanceof Blob)) {
            rawFile = await getStagedFile(f.fileId);
          }
          if (!rawFile) {
            throw new Error(`Arquivo "${f.name}" não encontrado na memória/cache.`);
          }
          await saveStagedFile(`${shareId}:${fileId}`, rawFile);
          if (stagedTunnelFiles.length === 1) {
            await saveStagedFile(shareId, rawFile);
          }
          finalFilesMeta.push({
            fileId,
            name: f.name,
            size: f.size,
            type: f.type || 'application/octet-stream'
          });
        }
        finalTotalSize = stagedTunnelFiles.reduce((acc, f) => acc + (f.size || 0), 0);
        finalPackName =
          stagedTunnelFiles.length === 1
            ? stagedTunnelFiles[0].name
            : `Pack (${stagedTunnelFiles.length} arquivos)`;
      }

      btnModalConfirm.innerHTML = `<span>Gerando link P2P...</span>`;
      const expirationMin = Number(modalExpirationSelect ? modalExpirationSelect.value : 30);
      const expiresAt = expirationMin > 0 ? Date.now() + expirationMin * 60 * 1000 : null;
      const password = (modalPasswordInput ? modalPasswordInput.value : '').trim();
      const maxDownloads = Number(modalDownloadLimitSelect ? modalDownloadLimitSelect.value : 0);

      let passwordSalt = '';
      let passwordHash = '';
      if (password) {
        passwordSalt = crypto.randomUUID().slice(0, 8);
        passwordHash = await computeSha256(password + passwordSalt);
      }

      const stored = await chrome.storage.local.get(['portalUrl']);
      const basePortalUrl = (stored.portalUrl || DEFAULT_PORTAL_URL).trim().replace(/\/+$/, '') + '/';
      const shareUrl = `${basePortalUrl}#share=${shareId}&owner=${encodeURIComponent(currentState.myTag)}${
        expiresAt ? `&exp=${expiresAt}` : ''
      }`;

      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: 'START_PUBLIC_LINK_SHARE',
            shareId,
            packName: finalPackName,
            files: finalFilesMeta,
            totalSize: finalTotalSize,
            shareUrl,
            hasPassword: Boolean(password),
            password,
            passwordSalt,
            passwordHash,
            maxDownloads,
            expiresAt
          },
          async (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (res && res.error) {
              reject(new Error(res.error));
              return;
            }
            if (res && res.state) {
              currentState = res.state;
              renderAll();
            }

            const formattedMessage = formatShareMessage({
              shareUrl,
              password,
              expiresAt,
              maxDownloads,
              files: finalFilesMeta
            });

            try {
              await navigator.clipboard.writeText(formattedMessage);
              showToast('✓ Link P2P gerado e copiado para a área de transferência!');
            } catch {
              showToast('✓ Link gerado! Copie na lista abaixo.');
            }
            resolve();
          }
        );
      });

      closeAndResetModal();
      switchMainTab('transfers');
      switchTransfersSubTab('active');
    } catch (err) {
      console.error('Erro ao confirmar envio:', err);
      showToast(`Erro: ${err.message}`);
    } finally {
      btnModalConfirm.disabled = false;
      btnModalConfirm.innerHTML = originalConfirmHTML;
    }
  });
}

// Navegação Principal em Abas (Início, Transferências, Compartilhamentos, Rede Mesh)
if (navBtnHome) {
  navBtnHome.addEventListener('click', () => switchMainTab('home'));
}

if (navBtnTransfers) {
  navBtnTransfers.addEventListener('click', () => switchMainTab('transfers'));
}

if (navBtnShares) {
  navBtnShares.addEventListener('click', () => switchMainTab('shares'));
}

if (navBtnMesh) {
  navBtnMesh.addEventListener('click', () => switchMainTab('mesh'));
}

if (btnNewShareLink) {
  btnNewShareLink.addEventListener('click', () => openModalForTunnel());
}

if (tabActiveTransfers) {
  tabActiveTransfers.addEventListener('click', () => switchTransfersSubTab('active'));
}

if (tabHistoryTransfers) {
  tabHistoryTransfers.addEventListener('click', () => switchTransfersSubTab('history'));
}

if (btnViewAllUsers) {
  btnViewAllUsers.addEventListener('click', () => switchMainTab('mesh'));
}

if (usersSearchInput) {
  usersSearchInput.addEventListener('input', () => renderMeshUsersTab());
}

if (toggleMeshRelay) {
  toggleMeshRelay.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'TOGGLE_MESH_RELAY' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  });
}

if (selectRelayBandwidth) {
  selectRelayBandwidth.addEventListener('change', () => {
    const limit = Number(selectRelayBandwidth.value);
    chrome.runtime.sendMessage({ action: 'SET_RELAY_BANDWIDTH_LIMIT', limit, limitKbps: limit }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
        showToast(`Limite da malha ajustado para ${formatBandwidth(limit)}.`);
      }
    });
  });
}

if (btnClearInactiveUsers) {
  btnClearInactiveUsers.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_INACTIVE_PEERS' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
        const count = res.count || 0;
        showToast(count > 0 ? `${count} usuários inativos foram excluídos da rede.` : 'Nenhum usuário inativo para excluir.');
      }
    });
  });
}

if (btnReceive) {
  btnReceive.addEventListener('click', () => {
    const pendingIncoming = Object.values(currentState.transfers || []).find(
      (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
    );

    if (pendingIncoming) {
      chrome.runtime.sendMessage({
        action: 'RESPOND_INCOMING',
        transferId: pendingIncoming.id,
        accept: true
      });
      return;
    }

    chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_ACCEPT' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  });
}

// Ações nos Cards da Lista de Transferências
if (transfersList) {
  transfersList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const downloadId = Number(btn.getAttribute('data-download-id'));
    const transferId = btn.getAttribute('data-transfer-id');
    const url = btn.getAttribute('data-url');

    if (action === 'delete-single-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'DELETE_TRANSFER', transferId }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      });
      return;
    }

    if (action === 'pause-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'PAUSE_TRANSFER', transferId }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      });
    } else if (action === 'resume-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'RESUME_TRANSFER', transferId }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      });
    } else if (action === 'cancel-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'CANCEL_TRANSFER', transferId }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      });
    } else if (action === 'show-folder' && !Number.isNaN(downloadId)) {
      chrome.downloads.show(downloadId);
    } else if (action === 'open-file' && !Number.isNaN(downloadId)) {
      chrome.downloads.open(downloadId);
    } else if (action === 'accept-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: true });
    } else if (action === 'reject-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: false });
    } else if (action === 'copy-tunnel-formatted' && transferId) {
      const t = currentState.transfers[transferId];
      if (!t) return;
      const formatted = formatShareMessage({
        shareUrl: t.shareUrl,
        password: t.password,
        expiresAt: t.expiresAt,
        maxDownloads: t.maxDownloads,
        files: t.files || [{ name: t.fileName, size: t.fileSize }]
      });
      try {
        await navigator.clipboard.writeText(formatted);
        btn.textContent = 'Copiado ✓';
        setTimeout(() => {
          btn.textContent = 'Copiar';
        }, 1800);
        showToast('Link, senha e resumo copiados!');
      } catch {
        showToast('Não foi possível copiar automaticamente.');
      }
    } else if (action === 'open-tunnel-url' && url) {
      chrome.tabs.create({ url });
    }
  });
}

if (sharesList) {
  sharesList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const transferId = btn.getAttribute('data-transfer-id');
    const url = btn.getAttribute('data-url');
    const textToCopy = btn.getAttribute('data-text');

    if (action === 'copy-text' && textToCopy) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        showToast('✓ Senha copiada para a área de transferência!');
      } catch {
        showToast('Não foi possível copiar automaticamente.');
      }
    } else if (action === 'copy-tunnel-formatted' && transferId) {
      const t = currentState.transfers[transferId];
      if (!t) return;
      const formatted = formatShareMessage({
        shareUrl: t.shareUrl,
        password: t.password,
        expiresAt: t.expiresAt,
        maxDownloads: t.maxDownloads,
        files: t.files || [{ name: t.fileName, size: t.fileSize }]
      });
      try {
        await navigator.clipboard.writeText(formatted);
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<span>Copiado ✓</span>';
        setTimeout(() => {
          btn.innerHTML = originalHtml;
        }, 1800);
        showToast('✓ Link, senha e resumo copiados!');
      } catch {
        showToast('Não foi possível copiar automaticamente.');
      }
    } else if (action === 'open-tunnel-url' && url) {
      chrome.tabs.create({ url });
    } else if (action === 'delete-single-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'CANCEL_TRANSFER', transferId }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      });
    } else if (action === 'pause-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'PAUSE_TRANSFER', transferId });
    } else if (action === 'resume-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'RESUME_TRANSFER', transferId });
    }
  });
}

if (homeDropZone) {
  homeDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    homeDropZone.classList.add('border-emerald-500', 'bg-emerald-500/10');
  });

  homeDropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    homeDropZone.classList.remove('border-emerald-500', 'bg-emerald-500/10');
  });

  homeDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    homeDropZone.classList.remove('border-emerald-500', 'bg-emerald-500/10');
    try {
      const files = await getFilesFromDataTransfer(e.dataTransfer?.items, e.dataTransfer?.files);
      if (files && files.length > 0) {
        handleSelectedFiles(files);
        openModalForP2P(targetTagInput ? targetTagInput.value : '');
      }
    } catch (err) {
      console.error('Erro no drop da tela inicial:', err);
    }
  });

  homeDropZone.addEventListener('click', () => {
    openModalForP2P(targetTagInput ? targetTagInput.value : '');
  });
}

if (btnClearCompleted) {
  btnClearCompleted.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  });
}

// Escuta atualizações de estado do background
chrome.runtime.onMessage.addListener((msg) => {
  if ((msg.action === 'STATE_UPDATED' || msg.type === 'STATE_UPDATED') && msg.state) {
    currentState = msg.state;
    renderAll();
  } else if (msg.type === 'USER_REGISTRATION_CONFLICT') {
    showToast(msg.error || `O usuário ${msg.tag} já existe na rede descentralizada!`, 'error');
    if (myTagInput) myTagInput.focus();
  }
});

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  if (window.location.search.includes('tab=1') || window.location.search.includes('window=1')) {
    document.body.classList.add('expanded-view');
  }

  chrome.storage.local.get(['myTag', 'lastTargetTag'], (res) => {
    if (res.myTag) {
      currentState.myTag = res.myTag;
      if (myTagInput) myTagInput.value = res.myTag.replace(/^@/, '');
    }
    if (res.lastTargetTag && targetTagInput) {
      targetTagInput.value = res.lastTargetTag;
    }
    renderRegistrationCard();
  });

  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});
