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

const activeSessionFiles = new Map();

if (fileBridgeChannel) {
  fileBridgeChannel.onmessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'STAGE_FILE_MEMORY' && data.transferId && data.file) {
      activeSessionFiles.set(data.transferId, data.file);
      if (String(data.transferId).startsWith('chatmedia-') && typeof renderChatView === 'function') {
        renderChatView();
      }
    } else if (data.type === 'REQUEST_FILE_MEMORY' && data.transferId) {
      const cached = activeSessionFiles.get(data.transferId);
      if (cached) {
        try {
          fileBridgeChannel.postMessage({
            type: 'STAGE_FILE_MEMORY',
            transferId: data.transferId,
            file: cached
          });
        } catch {}
      }
    } else if (data.type === 'DELETE_FILE_MEMORY' && data.transferId) {
      activeSessionFiles.delete(data.transferId);
    } else if (data.type === 'DELETE_PACK_MEMORY' && data.shareId) {
      activeSessionFiles.delete(data.shareId);
      for (const key of activeSessionFiles.keys()) {
        if (typeof key === 'string' && key.startsWith(`${data.shareId}:`)) {
          activeSessionFiles.delete(key);
        }
      }
    }
  };
}

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
  activeSessionFiles.set(fileKey, fileBlob);
  try {
    await chrome.runtime.sendMessage({ action: 'ENSURE_OFFSCREEN' });
  } catch {}
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
  activeSessionFiles.delete(fileKey);
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
const settingTurnUrl = document.getElementById('setting-turn-url');
const settingTurnUsername = document.getElementById('setting-turn-username');
const settingTurnCredential = document.getElementById('setting-turn-credential');
const btnClearTurn = document.getElementById('btn-clear-turn');
const daemonStatusBadge = document.getElementById('daemon-status-badge');

const toggleMeshRelay = document.getElementById('toggle-mesh-relay');
const selectRelayBandwidth = document.getElementById('select-relay-bandwidth');
const relayBandwidthBadge = document.getElementById('relay-bandwidth-badge');
const activeRelayedRoutesCount = document.getElementById('active-relayed-routes-count');
const totalRelayedBytesDisplay = document.getElementById('total-relayed-bytes-display');

const techLibp2pStat = document.getElementById('tech-libp2p-stat');
const techRnsStat = document.getElementById('tech-rns-stat');
const techYggStat = document.getElementById('tech-ygg-stat');
const techKadStat = document.getElementById('tech-kad-stat');
const techAodvStat = document.getElementById('tech-aodv-stat');
const techCrdtStat = document.getElementById('tech-crdt-stat');
const techDtnStat = document.getElementById('tech-dtn-stat');
const techSecStat = document.getElementById('tech-sec-stat');

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
const navBtnChat = document.getElementById('nav-btn-chat');
const navBtnTransfers = document.getElementById('nav-btn-transfers');
const navBtnShares = document.getElementById('nav-btn-shares');
const navBtnMesh = document.getElementById('nav-btn-mesh');

const navBadgeChat = document.getElementById('nav-badge-chat');
const navBadgeTransfers = document.getElementById('nav-badge-transfers');
const navBadgeShares = document.getElementById('nav-badge-shares');
const navBadgeMesh = document.getElementById('nav-badge-mesh');

const viewHome = document.getElementById('view-home');
const viewChat = document.getElementById('view-chat');
const viewTransfers = document.getElementById('view-transfers');
const viewShares = document.getElementById('view-shares');
const viewMesh = document.getElementById('view-mesh');

const sharesList = document.getElementById('shares-list');
const emptySharesState = document.getElementById('empty-shares-state');
const countShares = document.getElementById('count-shares');
const btnNewShareLink = document.getElementById('btn-new-share-link');
const homeDropZone = document.getElementById('home-drop-zone');

let currentMainTab = 'chat'; // 'chat' | 'home' | 'transfers' | 'shares' | 'mesh' (Chat-First)

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

// Componentes da Confirmação Manual de Transferências
const homePendingBanner = document.getElementById('home-pending-banner');
const homePendingTitle = document.getElementById('home-pending-title');
const homePendingSubtitle = document.getElementById('home-pending-subtitle');
const btnHomeReviewPending = document.getElementById('btn-home-review-pending');

const pendingApprovalPanel = document.getElementById('pending-approval-panel');
const checkSelectAllPending = document.getElementById('check-select-all-pending');
const pendingSelectedBadge = document.getElementById('pending-selected-badge');
const btnRejectSelected = document.getElementById('btn-reject-selected');
const btnAcceptSelected = document.getElementById('btn-accept-selected');
const pendingPanelInfo = document.getElementById('pending-panel-info');
const pendingPanelSize = document.getElementById('pending-panel-size');
const pendingTreeContainer = document.getElementById('pending-tree-container');

// Estado das seleções e pastas expandidas na confirmação manual
const selectedPendingIds = new Set();
const seenPendingIds = new Set();
const expandedFolders = new Set();
const folderExpansionInitialized = new Set();
const currentPendingFolderMap = new Map();

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
let pendingModalClose = false; // true entre o clique em Fechar/Cancelar e a confirmação do background
let currentTransfersTab = 'active'; // 'active' | 'history'
const expandedTransferIds = new Set();
const expandedTransferFiles = new Set();
const modalTreeExpandedFolders = new Set();
const cardTreeExpandedFolders = new Set();

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

function renderTechSuiteStats() {
  const sum = currentState.meshEngineSummary;
  const peersCount = Object.keys(currentState.peerRegistry || {}).length;

  if (techLibp2pStat) {
    if (sum?.libp2p) {
      techLibp2pStat.textContent = `${sum.libp2p.circuitRelayReservations} reservas • ${sum.libp2p.gossipsubMeshPeers} na malha (${sum.libp2p.gossipsubCachedMsgs} msgs)`;
    } else {
      techLibp2pStat.textContent = `Hop Reservation v2 • Gossipsub ativo`;
    }
  }

  if (techRnsStat) {
    if (sum?.reticulum?.destinationHash) {
      techRnsStat.textContent = `rns://${sum.reticulum.destinationHash.slice(0, 14)}... • ${sum.reticulum.knownPaths} caminhos`;
    } else {
      techRnsStat.textContent = `Destino: rns://${(currentState.myTag || '@peer').replace('@', '')}.mesh`;
    }
  }

  if (techYggStat) {
    if (sum?.yggdrasil?.ipv6Address) {
      techYggStat.textContent = `${sum.yggdrasil.ipv6Address.slice(0, 19)}... • árvore ${sum.yggdrasil.treeCoords}`;
    } else {
      techYggStat.textContent = `0200::yggdrasil • raiz [0]`;
    }
  }

  if (techKadStat) {
    if (sum?.kademlia) {
      techKadStat.textContent = `ID: ${sum.kademlia.nodeId} • ${sum.kademlia.totalPeersInBuckets} nós`;
    } else {
      techKadStat.textContent = `Métrica XOR 256-bit • ${peersCount} nós`;
    }
  }

  if (techAodvStat) {
    if (sum?.aodv) {
      techAodvStat.textContent = `${sum.aodv.activeRoutes} rotas ativas • seq #${sum.aodv.currentSeqNum}`;
    } else {
      techAodvStat.textContent = `RREQ / RREP sob demanda • sem loops`;
    }
  }

  if (techCrdtStat) {
    if (sum?.crdt) {
      techCrdtStat.textContent = `Lamport #${sum.crdt.lamportClock} • ${sum.crdt.registeredPeersCount} unificados`;
    } else {
      techCrdtStat.textContent = `LWW-Element-Set • convergência 100%`;
    }
  }

  if (techDtnStat) {
    if (sum?.dtn) {
      techDtnStat.textContent = `${sum.dtn.stagedBundlesCount} pacotes em custódia (RFC 5050)`;
    } else {
      techDtnStat.textContent = `Custódia resiliente • IndexedDB`;
    }
  }

  if (techSecStat) {
    if (sum?.onion && sum?.doubleRatchet) {
      techSecStat.textContent = `Onion: Ativo • Ratchets: ${sum.doubleRatchet.activeSessionsCount} (Forward Secrecy)`;
    } else {
      techSecStat.textContent = `Sphinx/Tor + Signal Protocol E2EE`;
    }
  }
}

function renderMeshUsersTab() {
  renderTechSuiteStats();
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

      const btnChatPeer = document.createElement('button');
      btnChatPeer.type = 'button';
      btnChatPeer.className =
        'px-2.5 py-1 rounded-lg bg-indigo-600/80 hover:bg-indigo-500 active:scale-95 text-white text-[10px] font-bold shadow-md transition-all cursor-pointer flex items-center gap-1';
      btnChatPeer.innerHTML = `<span>💬</span><span>Conversar</span>`;
      btnChatPeer.title = `Abrir conversa P2P com ${peer.tag}`;
      btnChatPeer.addEventListener('click', () => {
        openChatConversation(peer.tag);
      });
      actionsWrap.appendChild(btnChatPeer);

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
    { name: 'chat', btn: navBtnChat, view: viewChat },
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
  } else if (tabName === 'chat') {
    if (!activeChatPeerTag) {
      const paneSide = document.getElementById('chat-sidebar-pane');
      const paneConv = document.getElementById('chat-conversation-pane');
      if (paneSide && paneConv) {
        paneSide.classList.remove('chat-mobile-hidden');
        paneConv.classList.add('chat-mobile-hidden');
      }
    }
    if (typeof renderChatView === 'function') renderChatView();
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
  } else if (tabName === 'chat') {
    switchMainTab('chat');
  } else {
    switchMainTab('transfers');
    switchTransfersSubTab(tabName === 'history' ? 'history' : 'active');
  }
}

function renderReceiveButton() {
  const pendingIncoming = Object.values(currentState.transfers || []).filter(
    (t) =>
      t.direction === 'incoming' &&
      t.status === 'AWAITING_ACCEPT' &&
      !t.isChatMedia &&
      !String(t.id || '').startsWith('chatmedia-')
  );

  if (pendingIncoming.length > 0) {
    receiveBadge.classList.remove('hidden');
    receiveBadge.textContent = `${pendingIncoming.length} Pendente${pendingIncoming.length > 1 ? 's' : ''}`;
    receiveTitle.textContent = 'Aceitar Arquivo';
    receiveSubtitle.textContent = `${pendingIncoming.length} aguardando aceite`;

    // Atualiza banner na tela inicial
    if (homePendingBanner) {
      homePendingBanner.classList.remove('hidden');
      if (homePendingTitle) {
        homePendingTitle.textContent = pendingIncoming.length === 1
          ? `1 transferência pendente de ${pendingIncoming[0].peerTag || 'par'}`
          : `${pendingIncoming.length} transferências pendentes de ${pendingIncoming[0].peerTag || 'par'}`;
      }
      if (homePendingSubtitle) {
        const totalPendingBytes = pendingIncoming.reduce((acc, t) => acc + (t.fileSize || 0), 0);
        homePendingSubtitle.textContent = `${formatBytes(totalPendingBytes)} • Clique para selecionar e aceitar em massa`;
      }
    }
  } else {
    receiveBadge.classList.add('hidden');
    receiveTitle.textContent = 'Receber';
    receiveSubtitle.textContent = currentState.autoAccept ? 'Escuta Automática: ON' : 'Confirmação Manual';

    if (homePendingBanner) {
      homePendingBanner.classList.add('hidden');
    }
  }
}

// ============================================================================
// Confirmação Manual & Árvore Expansível de Diretórios Pendentes
// ============================================================================

function getFileExtensionIcon(fileName = '') {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '🖼️';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '📦';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📈';
  if (['js', 'ts', 'html', 'css', 'json', 'py', 'dart', 'go', 'rs', 'c', 'cpp', 'java'].includes(ext)) return '💻';
  return '📄';
}

function getMasterSelectionState(allPendingTransfers) {
  if (!allPendingTransfers || allPendingTransfers.length === 0) {
    return { checked: false, indeterminate: false };
  }
  let selectedCount = 0;
  for (const t of allPendingTransfers) {
    if (selectedPendingIds.has(t.id)) selectedCount++;
  }
  if (selectedCount === allPendingTransfers.length) {
    return { checked: true, indeterminate: false };
  }
  if (selectedCount === 0) {
    return { checked: false, indeterminate: false };
  }
  return { checked: false, indeterminate: true };
}

function getFolderSelectionState(folderNode) {
  if (!folderNode.transferIds || folderNode.transferIds.size === 0) {
    return { checked: false, indeterminate: false };
  }
  let selectedCount = 0;
  for (const tid of folderNode.transferIds) {
    if (selectedPendingIds.has(tid)) selectedCount++;
  }
  if (selectedCount === folderNode.transferIds.size) {
    return { checked: true, indeterminate: false };
  }
  if (selectedCount === 0) {
    return { checked: false, indeterminate: false };
  }
  return { checked: false, indeterminate: true };
}

function buildPendingTree(pendingTransfers) {
  const root = {
    type: 'root',
    folders: new Map(),
    files: []
  };

  for (const t of pendingTransfers) {
    const rawPath = (t.fileName || 'arquivo').replace(/^\/+/, '');
    const parts = rawPath.split('/').filter(Boolean);

    if (parts.length <= 1) {
      root.files.push({
        type: 'file',
        name: parts[0] || t.fileName,
        fullPath: rawPath,
        transfer: t
      });
    } else {
      let currentFolder = root;
      let accumulatedPath = '';

      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${folderName}` : folderName;

        if (!currentFolder.folders.has(folderName)) {
          currentFolder.folders.set(folderName, {
            type: 'folder',
            name: folderName,
            fullPath: accumulatedPath,
            folders: new Map(),
            files: [],
            transferIds: new Set(),
            totalSize: 0
          });
        }
        const node = currentFolder.folders.get(folderName);
        node.transferIds.add(t.id);
        node.totalSize += (t.fileSize || 0);
        currentFolder = node;
      }

      const fileName = parts[parts.length - 1];
      currentFolder.files.push({
        type: 'file',
        name: fileName,
        fullPath: rawPath,
        transfer: t
      });
    }
  }

  return root;
}

function renderFolderTree(folderNode, parentContainer, depth = 0) {
  const sortedFolders = Array.from(folderNode.folders.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const sortedFiles = [...folderNode.files].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  for (const subfolder of sortedFolders) {
    currentPendingFolderMap.set(subfolder.fullPath, subfolder);

    if (!folderExpansionInitialized.has(subfolder.fullPath)) {
      folderExpansionInitialized.add(subfolder.fullPath);
      expandedFolders.add(subfolder.fullPath);
    }

    const isExpanded = expandedFolders.has(subfolder.fullPath);
    const selState = getFolderSelectionState(subfolder);

    const folderEl = document.createElement('div');
    folderEl.className = 'folder-node rounded-lg bg-slate-950/70 border border-slate-800/80 overflow-hidden text-left mb-1';

    const headerEl = document.createElement('div');
    headerEl.className = 'folder-header flex items-center justify-between px-2 py-1.5 hover:bg-slate-800/40 transition-colors cursor-pointer select-none';
    headerEl.setAttribute('data-folder-path', subfolder.fullPath);

    headerEl.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <button
          type="button"
          class="btn-toggle-folder p-0.5 text-slate-400 hover:text-white transition-transform cursor-pointer shrink-0"
          data-folder-path="${escapeHtml(subfolder.fullPath)}"
          title="${isExpanded ? 'Recolher pasta' : 'Expandir pasta'}"
        >
          <svg class="w-3.5 h-3.5 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
        <input
          type="checkbox"
          class="folder-checkbox w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-sky-500/50 cursor-pointer shrink-0"
          data-folder-path="${escapeHtml(subfolder.fullPath)}"
          title="Selecionar todos os arquivos desta pasta"
        />
        <span class="text-xs shrink-0">${isExpanded ? '📂' : '📁'}</span>
        <span class="text-[11px] font-bold text-slate-200 truncate" title="${escapeHtml(subfolder.fullPath)}">
          ${escapeHtml(subfolder.name)}/
        </span>
        <span class="text-[9px] font-mono text-slate-500 shrink-0">
          (${subfolder.transferIds.size} • ${formatBytes(subfolder.totalSize)})
        </span>
      </div>
      <div class="flex items-center gap-1 shrink-0 ml-1">
        <button
          type="button"
          class="btn-reject-folder p-1 rounded hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 text-xs transition-colors cursor-pointer"
          title="Recusar pasta inteira (${subfolder.transferIds.size} arquivos)"
          data-folder-path="${escapeHtml(subfolder.fullPath)}"
        >
          ✕
        </button>
      </div>
    `;

    const cb = headerEl.querySelector('.folder-checkbox');
    if (cb) {
      cb.checked = selState.checked;
      cb.indeterminate = selState.indeterminate;
    }

    const childrenEl = document.createElement('div');
    childrenEl.className = `folder-children ${isExpanded ? '' : 'hidden'} pl-4 pr-1 py-1 space-y-1 border-t border-slate-800/50 bg-slate-950/40`;

    renderFolderTree(subfolder, childrenEl, depth + 1);

    folderEl.appendChild(headerEl);
    folderEl.appendChild(childrenEl);
    parentContainer.appendChild(folderEl);
  }

  for (const fileItem of sortedFiles) {
    const t = fileItem.transfer;
    const isSelected = selectedPendingIds.has(t.id);
    const fileEl = document.createElement('div');
    fileEl.className = 'file-node flex items-center justify-between px-2 py-1 rounded bg-slate-900/60 hover:bg-slate-800/50 border border-slate-800/50 transition-colors text-left';
    fileEl.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <input
          type="checkbox"
          class="file-checkbox w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-sky-500/50 cursor-pointer shrink-0"
          data-transfer-id="${escapeHtml(t.id)}"
          ${isSelected ? 'checked' : ''}
          title="Selecionar para aceitar ou recusar"
        />
        <span class="text-xs shrink-0">${getFileExtensionIcon(fileItem.name)}</span>
        <span class="text-[11px] font-medium text-slate-300 truncate" title="${escapeHtml(fileItem.fullPath)}">
          ${escapeHtml(fileItem.name)}
        </span>
        <span class="text-[9px] font-mono text-slate-500 shrink-0">
          (${formatBytes(t.fileSize || 0)})
        </span>
      </div>
      <div class="flex items-center gap-1 shrink-0 ml-1">
        <button
          type="button"
          data-action="accept-single-pending"
          data-transfer-id="${escapeHtml(t.id)}"
          title="Aceitar este arquivo"
          class="px-2 py-0.5 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[9px] transition-colors cursor-pointer"
        >
          Aceitar
        </button>
        <button
          type="button"
          data-action="reject-single-pending"
          data-transfer-id="${escapeHtml(t.id)}"
          title="Recusar este arquivo"
          class="p-1 rounded bg-slate-800 hover:bg-rose-500/30 text-rose-300 text-[10px] transition-colors cursor-pointer"
        >
          ✕
        </button>
      </div>
    `;
    parentContainer.appendChild(fileEl);
  }
}

function renderPendingApprovalPanel(pendingTransfers) {
  if (!pendingApprovalPanel) return;

  const list = pendingTransfers || Object.values(currentState.transfers || []).filter(
    (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
  );

  if (list.length === 0) {
    pendingApprovalPanel.classList.add('hidden');
    selectedPendingIds.clear();
    seenPendingIds.clear();
    folderExpansionInitialized.clear();
    currentPendingFolderMap.clear();
    return;
  }

  pendingApprovalPanel.classList.remove('hidden');

  // Prune IDs que não estão mais na lista de pendentes
  const currentPendingIdSet = new Set(list.map((t) => t.id));
  for (const id of selectedPendingIds) {
    if (!currentPendingIdSet.has(id)) selectedPendingIds.delete(id);
  }
  for (const id of seenPendingIds) {
    if (!currentPendingIdSet.has(id)) seenPendingIds.delete(id);
  }

  // Novos arquivos que chegam entram pré-selecionados por conveniência
  for (const t of list) {
    if (!seenPendingIds.has(t.id)) {
      seenPendingIds.add(t.id);
      selectedPendingIds.add(t.id);
    }
  }

  // Atualiza Sub-barra informativa
  const totalPendingBytes = list.reduce((acc, t) => acc + (t.fileSize || 0), 0);
  const senderTags = Array.from(new Set(list.map((t) => t.peerTag).filter(Boolean)));
  const senderStr = senderTags.length > 0 ? `De ${senderTags.join(', ')}` : 'De usuário remoto';
  if (pendingPanelInfo) {
    pendingPanelInfo.textContent = `${senderStr} • ${list.length} item(ns)`;
    pendingPanelInfo.title = `${senderStr} • ${list.length} item(ns) aguardando confirmação`;
  }
  if (pendingPanelSize) {
    pendingPanelSize.textContent = formatBytes(totalPendingBytes);
  }

  // Atualiza Checkbox Mestre (Topo)
  const masterState = getMasterSelectionState(list);
  if (checkSelectAllPending) {
    checkSelectAllPending.checked = masterState.checked;
    checkSelectAllPending.indeterminate = masterState.indeterminate;
  }
  if (pendingSelectedBadge) {
    pendingSelectedBadge.textContent = `${selectedPendingIds.size}/${list.length}`;
  }

  // Atualiza Botões de Ação em Massa
  const hasSelection = selectedPendingIds.size > 0;
  if (btnAcceptSelected) {
    btnAcceptSelected.disabled = !hasSelection;
    const span = btnAcceptSelected.querySelector('span');
    if (span) {
      span.textContent = hasSelection
        ? `Aceitar em massa (${selectedPendingIds.size})`
        : 'Aceitar em massa';
    }
  }
  if (btnRejectSelected) {
    btnRejectSelected.disabled = !hasSelection;
    const span = btnRejectSelected.querySelector('span');
    if (span) {
      span.textContent = hasSelection
        ? `Recusar (${selectedPendingIds.size})`
        : 'Recusar';
    }
  }

  if (!pendingTreeContainer) return;
  pendingTreeContainer.innerHTML = '';
  currentPendingFolderMap.clear();

  const treeRoot = buildPendingTree(list);

  // Renderiza subpastas recursivamente
  renderFolderTree(treeRoot, pendingTreeContainer, 0);

  // Renderiza arquivos raiz (fora de qualquer pasta)
  const sortedRootFiles = [...treeRoot.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const fileItem of sortedRootFiles) {
    const t = fileItem.transfer;
    const isSelected = selectedPendingIds.has(t.id);
    const fileEl = document.createElement('div');
    fileEl.className = 'file-node flex items-center justify-between px-2 py-1 rounded bg-slate-900/60 hover:bg-slate-800/50 border border-slate-800/50 transition-colors text-left';
    fileEl.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <input
          type="checkbox"
          class="file-checkbox w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-sky-500/50 cursor-pointer shrink-0"
          data-transfer-id="${escapeHtml(t.id)}"
          ${isSelected ? 'checked' : ''}
          title="Selecionar para aceitar ou recusar"
        />
        <span class="text-xs shrink-0">${getFileExtensionIcon(fileItem.name)}</span>
        <span class="text-[11px] font-medium text-slate-300 truncate" title="${escapeHtml(fileItem.fullPath)}">
          ${escapeHtml(fileItem.name)}
        </span>
        <span class="text-[9px] font-mono text-slate-500 shrink-0">
          (${formatBytes(t.fileSize || 0)})
        </span>
      </div>
      <div class="flex items-center gap-1 shrink-0 ml-1">
        <button
          type="button"
          data-action="accept-single-pending"
          data-transfer-id="${escapeHtml(t.id)}"
          title="Aceitar este arquivo"
          class="px-2 py-0.5 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[9px] transition-colors cursor-pointer"
        >
          Aceitar
        </button>
        <button
          type="button"
          data-action="reject-single-pending"
          data-transfer-id="${escapeHtml(t.id)}"
          title="Recusar este arquivo"
          class="p-1 rounded bg-slate-800 hover:bg-rose-500/30 text-rose-300 text-[10px] transition-colors cursor-pointer"
        >
          ✕
        </button>
      </div>
    `;
    pendingTreeContainer.appendChild(fileEl);
  }
}

function isTransferHistory(t, now = Date.now()) {
  if (t.status === 'COMPLETED' || t.status === 'CANCELLED' || t.status === 'ERROR' || t.status === 'EXPIRED') {
    return true;
  }
  if (t.direction === 'tunnel' && t.expiresAt && now >= t.expiresAt) {
    return true;
  }
  return false;
}

function buildDirectoryTree(files) {
  const root = {
    name: '',
    fullPath: '',
    folders: new Map(),
    files: [],
    totalSize: 0,
    totalTransferred: 0,
    fileCount: 0
  };

  if (!Array.isArray(files)) return root;

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    if (!f) continue;
    const rawPath = (f.name || f.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = rawPath.split('/').filter(Boolean);
    const size = f.size || f.fileSize || 0;
    const transferred = typeof f.transferredBytes === 'number'
      ? f.transferredBytes
      : (typeof f.progress === 'number' ? Math.round((size * f.progress) / 100) : 0);

    root.totalSize += size;
    root.totalTransferred += transferred;
    root.fileCount++;

    if (parts.length <= 1) {
      root.files.push({
        ...f,
        index: idx,
        basename: parts[0] || f.name || 'arquivo',
        fullPath: rawPath
      });
      continue;
    }

    let curr = root;
    let accumulatedPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      if (!curr.folders.has(part)) {
        curr.folders.set(part, {
          name: part,
          fullPath: accumulatedPath,
          folders: new Map(),
          files: [],
          totalSize: 0,
          totalTransferred: 0,
          fileCount: 0
        });
      }
      curr = curr.folders.get(part);
      curr.totalSize += size;
      curr.totalTransferred += transferred;
      curr.fileCount++;
    }

    const basename = parts[parts.length - 1];
    curr.files.push({
      ...f,
      index: idx,
      basename,
      fullPath: rawPath
    });
  }

  return root;
}

function renderCardFilesTreeHtml(files, transferId) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const tree = buildDirectoryTree(files);

  function renderBranch(node, depth = 0) {
    let html = '';

    const sortedFolders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of sortedFolders) {
      const folderKey = `${transferId}:${folder.fullPath}`;
      const isExpanded = !cardTreeExpandedFolders.has(folderKey + ':collapsed');
      const folderPct = folder.totalSize > 0
        ? Math.min(100, Math.round((folder.totalTransferred / folder.totalSize) * 100))
        : 100;
      const isComplete = folderPct >= 100;
      const folderBarColor = isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-orange-500 to-amber-500';

      html += `
        <div class="rounded-lg bg-slate-950/80 border border-slate-800/80 overflow-hidden mb-1 shadow-sm text-left">
          <div
            class="flex items-center justify-between px-2 py-1.5 bg-slate-900/60 hover:bg-slate-800/40 cursor-pointer select-none text-[10px]"
            data-action="toggle-card-folder"
            data-folder-key="${escapeHtml(folderKey)}"
          >
            <div class="flex items-center gap-1.5 min-w-0 flex-1">
              <span class="text-slate-400 text-[9px] font-mono">${isExpanded ? '▼' : '▶'}</span>
              <span>${isExpanded ? '📂' : '📁'}</span>
              <span class="font-bold text-slate-200 truncate" title="${escapeHtml(folder.fullPath)}">${escapeHtml(folder.name)}/</span>
              <span class="text-[9px] font-mono text-slate-400 shrink-0">(${folder.fileCount} arq • ${formatBytes(folder.totalSize)})</span>
            </div>
            <span class="text-[9px] font-mono font-bold ${isComplete ? 'text-emerald-400' : 'text-orange-400'} shrink-0 ml-1">
              ${folderPct}%
            </span>
          </div>

          <div class="w-full bg-slate-800 h-0.5 overflow-hidden">
            <div class="${folderBarColor} h-0.5" style="width: ${folderPct}%"></div>
          </div>

          <div class="${isExpanded ? '' : 'hidden'} pl-3 pr-1 py-1 space-y-1 border-t border-slate-800/50 bg-slate-950/40">
            ${renderBranch(folder, depth + 1)}
          </div>
        </div>
      `;
    }

    const sortedFiles = [...node.files].sort((a, b) => (a.basename || a.name).localeCompare(b.basename || b.name));
    for (const f of sortedFiles) {
      const fSize = f.size || f.fileSize || 0;
      const fTransferred = typeof f.transferredBytes === 'number'
        ? f.transferredBytes
        : (typeof f.progress === 'number' ? Math.round((fSize * f.progress) / 100) : 0);
      const fPct = fSize > 0
        ? Math.min(100, Math.round((fTransferred / fSize) * 100))
        : (f.status === 'COMPLETED' ? 100 : 0);
      const isComplete = fPct >= 100 || f.status === 'COMPLETED';
      const fBarColor = isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-orange-500 to-amber-500';
      const fSpeed = f.speedBps && !isComplete ? ` • ${formatSpeed(f.speedBps)}` : '';
      const fStatus = isComplete
        ? '✓ Concluído'
        : (f.status === 'TRANSFERRING' ? 'Transmitindo...' : (f.status === 'PAUSED' ? 'Pausado' : 'Pendente'));

      html += `
        <div class="px-2 py-1 rounded bg-slate-900/90 border border-slate-800/60 flex flex-col gap-0.5 text-[10px] text-left">
          <div class="flex items-center justify-between gap-1.5">
            <div class="flex items-center gap-1.5 min-w-0 flex-1">
              <span class="text-xs shrink-0">${getFileExtensionIcon(f.name)}</span>
              <span class="font-medium text-slate-200 truncate" title="${escapeHtml(f.fullPath || f.name)}">
                ${escapeHtml(f.basename || f.name)}
              </span>
            </div>
            <span class="font-mono text-[9px] font-bold ${isComplete ? 'text-emerald-400' : 'text-orange-400'} shrink-0">
              ${fPct}%
            </span>
          </div>

          <!-- Barra de Progresso Individual do Arquivo -->
          <div class="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
            <div class="${fBarColor} h-1 transition-all duration-150" style="width: ${fPct}%"></div>
          </div>

          <div class="flex items-center justify-between text-[9px] font-mono text-slate-400">
            <span class="${isComplete ? 'text-emerald-400/90' : 'text-slate-400'}">${fStatus}${fSpeed}</span>
            <span>${formatBytes(fTransferred)} / ${formatBytes(fSize)}</span>
          </div>
        </div>
      `;
    }

    return html;
  }

  return `<div class="flex flex-col gap-1 max-h-56 overflow-y-auto pr-0.5 text-slate-300 mt-1">${renderBranch(tree, 0)}</div>`;
}

function renderTransfers() {
  const allTransfers = Object.values(currentState.transfers || {})
    .filter((t) => !t.isChatMedia && !String(t.id || '').startsWith('chatmedia-'))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const now = Date.now();
  const pendingIncoming = allTransfers.filter(
    (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
  );
  const activeList = allTransfers.filter(
    (t) => !isTransferHistory(t, now) && t.status !== 'AWAITING_ACCEPT'
  );
  const historyList = allTransfers.filter((t) => isTransferHistory(t, now));

  if (countActive) countActive.textContent = activeList.length + pendingIncoming.length;
  if (countHistory) countHistory.textContent = historyList.length;

  // Atualiza painel dedicado de confirmação manual
  renderPendingApprovalPanel(pendingIncoming);

  const list = currentTransfersTab === 'active' ? activeList : historyList;

  if (list.length === 0) {
    emptyState.classList.remove('hidden');
    const pTitle = emptyState.querySelector('p.font-medium');
    const pSub = emptyState.querySelector('p.text-\\[10px\\]');
    if (pTitle) {
      pTitle.textContent =
        currentTransfersTab === 'active'
          ? (pendingIncoming.length > 0 ? 'Aguardando confirmação acima' : 'Nenhuma transferência ativa')
          : 'Nenhum histórico de transferências';
    }
    if (pSub) {
      pSub.innerHTML =
        currentTransfersTab === 'active'
          ? (pendingIncoming.length > 0
              ? 'Selecione os arquivos ou pastas no painel acima e clique em <span class="text-sky-400 font-bold">Aceitar</span>.'
              : 'Envie para <span class="text-emerald-400 font-mono">@usuario</span> ou gere um <span class="text-orange-400 font-semibold">Link Público</span>.')
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
                data-action="copy-tunnel-link"
                data-url="${t.shareUrl}"
                data-transfer-id="${t.id}"
                title="Copiar apenas o link direto"
                class="px-2 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500/40 text-orange-300 border border-orange-500/40 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap"
              >
                <span>🔗 Copiar Link</span>
              </button>
              <button
                type="button"
                data-action="copy-tunnel-formatted"
                data-transfer-id="${t.id}"
                title="Copiar texto completo (link + senha + arquivos)"
                class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-[10px] font-medium transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap"
              >
                <span>📋 Texto Completo</span>
              </button>
              <button
                type="button"
                data-action="open-tunnel-url"
                data-url="${t.shareUrl}"
                title="Abrir link no navegador"
                class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] transition-colors cursor-pointer shrink-0"
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

      ${
        Array.isArray(t.files) && t.files.length > 1
          ? `
            <div class="mt-1 pt-1 border-t border-slate-800/70">
              <button
                type="button"
                data-action="toggle-card-files"
                data-transfer-id="${t.id}"
                class="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200 py-0.5 cursor-pointer"
              >
                <span class="flex items-center gap-1 font-semibold">
                  <span>📂 Arquivos no Pacote (${t.files.length})</span>
                  <span class="text-slate-500 font-mono">• ${formatBytes(totalBytes)}</span>
                </span>
                <span class="text-[9px] font-mono text-orange-400 font-bold">
                  ${expandedTransferFiles.has(t.id) ? 'Ocultar ▲' : 'Ver Arquivos ▼'}
                </span>
              </button>
              ${expandedTransferFiles.has(t.id) ? renderCardFilesTreeHtml(t.files, t.id) : ''}
            </div>
          `
          : ''
      }

      ${tunnelLinkBoxHtml}
    `;

    transfersList.appendChild(card);
  }
}

function updateNavBadges() {
  const allTransfers = Object.values(currentState.transfers || {}).filter(
    (t) => !t.isChatMedia && !String(t.id || '').startsWith('chatmedia-')
  );
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

  const unreadChatCount = Object.values(currentState.chatUnreadCounts || {}).reduce(
    (acc, val) => acc + (Number(val) || 0),
    0
  );
  if (navBadgeChat) {
    if (unreadChatCount > 0) {
      navBadgeChat.textContent = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
      navBadgeChat.classList.remove('hidden');
    } else {
      navBadgeChat.classList.add('hidden');
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

      ${
        Array.isArray(t.files) && t.files.length > 1
          ? `
            <div class="pt-1 border-t border-slate-800/70">
              <button
                type="button"
                data-action="toggle-card-files"
                data-transfer-id="${t.id}"
                class="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200 py-0.5 cursor-pointer"
              >
                <span class="flex items-center gap-1 font-semibold">
                  <span>📂 Arquivos no Pacote (${t.files.length})</span>
                  <span class="text-slate-500 font-mono">• ${formatBytes(totalSize)}</span>
                </span>
                <span class="text-[9px] font-mono text-orange-400 font-bold">
                  ${expandedTransferFiles.has(t.id) ? 'Ocultar ▲' : 'Ver Arquivos ▼'}
                </span>
              </button>
              ${expandedTransferFiles.has(t.id) ? renderCardFilesTreeHtml(t.files, t.id) : ''}
            </div>
          `
          : ''
      }

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
            data-action="copy-tunnel-link"
            data-url="${t.shareUrl}"
            data-transfer-id="${t.id}"
            title="Copiar apenas o link direto"
            class="px-2.5 py-1 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/30 text-[10px] font-bold transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap"
          >
            <span>🔗 Copiar Link</span>
          </button>
          <button
            type="button"
            data-action="copy-tunnel-formatted"
            data-transfer-id="${t.id}"
            title="Copiar texto completo (link + arquivos + senha)"
            class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-[10px] font-medium transition-colors cursor-pointer flex items-center gap-1 whitespace-nowrap"
          >
            <span>📋 Texto Completo</span>
          </button>
          <button
            type="button"
            data-action="open-tunnel-url"
            data-url="${t.shareUrl}"
            title="Abrir no navegador"
            class="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors cursor-pointer shrink-0"
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
  // Enquanto um fechamento local está pendente (aguardando o background confirmar o
  // CLEAR_STAGED_TUNNEL_FILES), ignora broadcasts antigos que ainda dizem "modal aberto"
  // e não repopula a lista de arquivos que acabou de ser limpa.
  if (pendingModalClose) {
    if (tunnelConfigModal) tunnelConfigModal.classList.add('hidden');
    return;
  }

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
    // Só reabre se estiver oculto. Reaplicar a UI a cada broadcast sobrescrevia o
    // texto digitado/estado do botão de envio e, ao reenviar SET_TUNNEL_MODAL_OPEN,
    // gerava um loop infinito popup <-> background.
    if (tunnelConfigModal.classList.contains('hidden')) {
      if (currentState.modalMode === 'tunnel') {
        openModalForTunnel({ fromSync: true });
      } else {
        openModalForP2P(currentState.modalTargetTag || (targetTagInput ? targetTagInput.value : ''), {
          fromSync: true
        });
      }
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
  if (currentMainTab === 'chat' && typeof renderChatView === 'function') {
    renderChatView();
  }
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

// Conectar Dispositivo (QR Code Pairing)
const btnConnectDeviceQr = document.getElementById('btn-connect-device-qr');
const modalConnectDevice = document.getElementById('modal-connect-device');
const btnCloseConnectDevice = document.getElementById('btn-close-connect-device');
const qrContainer = document.getElementById('connect-device-qr-container');
const inputPairingCodeCopy = document.getElementById('input-pairing-code-copy');
const btnCopyPairingCode = document.getElementById('btn-copy-pairing-code');

if (btnConnectDeviceQr && modalConnectDevice) {
  btnConnectDeviceQr.addEventListener('click', async () => {
    settingsPanel?.classList.add('hidden');
    modalConnectDevice.classList.remove('hidden');

    let currentTag = myTag || localStorage.getItem('ps_my_tag') || '@web_desktop';
    let currentSeed = localStorage.getItem('ps_seed_words');
    if (!currentSeed && typeof PulseShareCrypto !== 'undefined') {
      currentSeed = PulseShareCrypto.generate7WordMnemonic();
      localStorage.setItem('ps_seed_words', currentSeed);
    }

    const payload = JSON.stringify({
      action: 'pulseshare_pair_v2',
      name: currentTag.replace(/^@/, '').split('_')[0],
      seedWords: currentSeed || 'abacate abismo abrigo acacia acento acesso acorde',
      tag: currentTag,
      timestamp: Date.now()
    });

    if (qrContainer && typeof PulseShareCrypto !== 'undefined') {
      qrContainer.innerHTML = PulseShareCrypto.generateQRCodeSVG(payload, 200);
    }
    if (inputPairingCodeCopy) {
      inputPairingCodeCopy.value = payload;
    }
  });
}

if (btnCloseConnectDevice && modalConnectDevice) {
  btnCloseConnectDevice.addEventListener('click', () => {
    modalConnectDevice.classList.add('hidden');
  });
}

if (btnCopyPairingCode && inputPairingCodeCopy) {
  btnCopyPairingCode.addEventListener('click', () => {
    navigator.clipboard.writeText(inputPairingCodeCopy.value);
    showNotificationToast('Código de pareamento copiado!');
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

if (settingTurnUrl && settingTurnUsername && settingTurnCredential) {
  chrome.storage.local.get(['turnConfig'], (res) => {
    if (res && res.turnConfig) {
      settingTurnUrl.value = res.turnConfig.url || '';
      settingTurnUsername.value = res.turnConfig.username || '';
      settingTurnCredential.value = res.turnConfig.credential || '';
    }
  });

  const saveTurnConfig = () => {
    const url = (settingTurnUrl.value || '').trim();
    const username = (settingTurnUsername.value || '').trim();
    const credential = (settingTurnCredential.value || '').trim();
    chrome.storage.local.set({ turnConfig: { url, username, credential } }, () => {
      showToast('Configurações TURN/Relay salvas!');
    });
  };

  settingTurnUrl.addEventListener('change', saveTurnConfig);
  settingTurnUsername.addEventListener('change', saveTurnConfig);
  settingTurnCredential.addEventListener('change', saveTurnConfig);

  if (btnClearTurn) {
    btnClearTurn.addEventListener('click', () => {
      settingTurnUrl.value = '';
      settingTurnUsername.value = '';
      settingTurnCredential.value = '';
      chrome.storage.local.remove(['turnConfig'], () => {
        showToast('Configurações de TURN removidas.');
      });
    });
  }
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
// `fromSync: true` = apenas reflete o estado vindo do background (sem reenviar
// SET_TUNNEL_MODAL_OPEN, evitando loop popup <-> background).
function openModalForTunnel({ fromSync = false } = {}) {
  if (!currentState.myTag && !fromSync) {
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
  pendingModalClose = false;
  if (!fromSync) {
    chrome.runtime.sendMessage({
      action: 'SET_TUNNEL_MODAL_OPEN',
      open: true,
      mode: 'tunnel'
    });
  }
  renderModalFiles();
}

function openModalForP2P(targetTag = '', { fromSync = false } = {}) {
  if (!currentState.myTag && !fromSync) {
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
  pendingModalClose = false;
  if (!fromSync) {
    chrome.runtime.sendMessage({
      action: 'SET_TUNNEL_MODAL_OPEN',
      open: true,
      mode: 'p2p',
      targetTag: target
    });
  }
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

  const tree = buildDirectoryTree(stagedTunnelFiles);

  function renderModalTreeNode(node, container, depth = 0) {
    const sortedFolders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of sortedFolders) {
      if (!modalTreeExpandedFolders.has(folder.fullPath + ':initialized')) {
        modalTreeExpandedFolders.add(folder.fullPath + ':initialized');
        modalTreeExpandedFolders.add(folder.fullPath);
      }
      const isExpanded = modalTreeExpandedFolders.has(folder.fullPath);

      const folderEl = document.createElement('div');
      folderEl.className = 'folder-node rounded-lg bg-slate-950/80 border border-slate-800/80 overflow-hidden text-left mb-1 shadow-sm';

      const headerEl = document.createElement('div');
      headerEl.className = 'flex items-center justify-between px-2 py-1.5 hover:bg-slate-800/40 transition-colors cursor-pointer select-none';
      headerEl.setAttribute('data-action', 'toggle-modal-folder');
      headerEl.setAttribute('data-folder-path', folder.fullPath);

      headerEl.innerHTML = `
        <div class="flex items-center gap-1.5 min-w-0 flex-1">
          <span class="text-slate-400 text-[9px] font-mono shrink-0">${isExpanded ? '▼' : '▶'}</span>
          <span class="text-xs shrink-0">${isExpanded ? '📂' : '📁'}</span>
          <span class="text-[11px] font-bold text-slate-200 truncate" title="${escapeHtml(folder.fullPath)}">
            ${escapeHtml(folder.name)}/
          </span>
          <span class="text-[9px] font-mono text-slate-400 shrink-0">
            (${folder.fileCount} arq • ${formatBytes(folder.totalSize)})
          </span>
        </div>
        <div class="flex items-center gap-1 shrink-0 ml-1">
          <button
            type="button"
            data-action="remove-modal-folder"
            data-folder-path="${escapeHtml(folder.fullPath)}"
            class="text-slate-500 hover:text-rose-400 font-bold px-1.5 py-0.5 rounded hover:bg-rose-500/20 text-xs cursor-pointer transition-colors"
            title="Remover pasta inteira (${folder.fileCount} arquivos)"
          >
            ✕
          </button>
        </div>
      `;

      const childrenEl = document.createElement('div');
      childrenEl.className = `folder-children ${isExpanded ? '' : 'hidden'} pl-3 pr-1 py-1 space-y-1 border-t border-slate-800/60 bg-slate-950/40`;

      renderModalTreeNode(folder, childrenEl, depth + 1);

      folderEl.appendChild(headerEl);
      folderEl.appendChild(childrenEl);
      container.appendChild(folderEl);
    }

    const sortedFiles = [...node.files].sort((a, b) => (a.basename || a.name).localeCompare(b.basename || b.name));
    for (const f of sortedFiles) {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs shadow-sm hover:border-slate-700 transition-colors text-left';
      item.innerHTML = `
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="text-xs shrink-0">${getFileExtensionIcon(f.name)}</span>
          <span class="text-[11px] text-slate-200 font-medium truncate max-w-[220px]" title="${escapeHtml(f.fullPath || f.name)}">
            ${escapeHtml(f.basename || f.name)}
          </span>
          <span class="text-[10px] text-slate-400 font-mono shrink-0">
            (${formatBytes(f.size)})
          </span>
        </div>
        <button
          type="button"
          data-action="remove-modal-file"
          data-file-id="${escapeHtml(f.fileId)}"
          class="text-slate-500 hover:text-rose-400 font-bold px-1 text-xs cursor-pointer transition-colors"
          title="Remover do pack"
        >
          ✕
        </button>
      `;
      container.appendChild(item);
    }
  }

  renderModalTreeNode(tree, modalFilesList, 0);
}

if (modalFilesList) {
  modalFilesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');

    if (action === 'toggle-modal-folder') {
      const folderPath = btn.getAttribute('data-folder-path');
      if (folderPath) {
        if (modalTreeExpandedFolders.has(folderPath)) {
          modalTreeExpandedFolders.delete(folderPath);
        } else {
          modalTreeExpandedFolders.add(folderPath);
        }
        renderModalFiles();
      }
      return;
    }

    if (action === 'remove-modal-folder') {
      e.stopPropagation();
      const folderPath = btn.getAttribute('data-folder-path');
      if (folderPath) {
        const removed = [];
        stagedTunnelFiles = stagedTunnelFiles.filter((f) => {
          const raw = (f.name || f.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
          if (raw === folderPath || raw.startsWith(folderPath + '/')) {
            removed.push(f);
            return false;
          }
          return true;
        });
        removed.forEach((f) => f.fileId && deleteStagedFile(f.fileId));
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
        showToast(`✓ Pasta removida (${removed.length} arquivos).`);
      }
      return;
    }

    if (action === 'remove-modal-file') {
      e.stopPropagation();
      const fileId = btn.getAttribute('data-file-id');
      const idx = stagedTunnelFiles.findIndex((f) => f.fileId === fileId);
      if (idx !== -1) {
        const removed = stagedTunnelFiles.splice(idx, 1)[0];
        if (removed && removed.fileId) {
          deleteStagedFile(removed.fileId);
        }
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
      }
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
    if (normalizedName.includes('/')) {
      const topDir = normalizedName.split('/')[0];
      modalTreeExpandedFolders.add(topDir);
    }
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
  pendingModalClose = true;
  tunnelConfigModal.classList.add('hidden');
  stagedTunnelFiles = [];
  // Atualiza o estado local imediatamente para que nenhum render reabra o modal.
  currentState.tunnelModalOpen = false;
  currentState.stagedTunnelFiles = [];
  if (modalCompressToggle) modalCompressToggle.checked = false;
  if (modalCompressOptions) modalCompressOptions.classList.add('hidden');

  const finishClose = () => {
    pendingModalClose = false;
  };
  // Failsafe: se o service worker não responder, libera o bloqueio mesmo assim.
  const failsafe = setTimeout(finishClose, 3000);

  try {
    chrome.runtime.sendMessage({ action: 'CLEAR_STAGED_TUNNEL_FILES' }, (res) => {
      void chrome.runtime.lastError; // evita "Unchecked runtime.lastError"
      clearTimeout(failsafe);
      finishClose();
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  } catch (err) {
    clearTimeout(failsafe);
    finishClose();
    console.warn('Falha ao limpar pack no background:', err);
  }
}

if (btnModalClose) btnModalClose.addEventListener('click', closeAndResetModal);
if (btnModalCancel) btnModalCancel.addEventListener('click', closeAndResetModal);

// Clique no fundo escuro (backdrop) fecha o modal
if (tunnelConfigModal) {
  tunnelConfigModal.addEventListener('click', (e) => {
    if (e.target === tunnelConfigModal && !(btnModalConfirm && btnModalConfirm.disabled)) {
      closeAndResetModal();
    }
  });
}

// Esc fecha o modal (desde que não esteja no meio de um envio)
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    tunnelConfigModal &&
    !tunnelConfigModal.classList.contains('hidden') &&
    !(btnModalConfirm && btnModalConfirm.disabled)
  ) {
    closeAndResetModal();
  }
});

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

        const isBatch = filesToSend.length > 1;
        const batchId = isBatch
          ? `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          : null;
        const firstSlash = filesToSend[0]?.name?.indexOf('/');
        const defaultBatchName = firstSlash > 0
          ? filesToSend[0].name.slice(0, firstSlash)
          : (isBatch ? `Lote (${filesToSend.length} itens)` : '');

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
              type: item.type,
              ...(batchId ? {
                batchId,
                batchName: defaultBatchName,
                batchCount: filesToSend.length
              } : {})
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

// Navegação Principal em Abas (Início, Chat P2P, Transferências, Compartilhamentos, Rede Mesh)
if (navBtnHome) {
  navBtnHome.addEventListener('click', () => switchMainTab('home'));
}

if (navBtnChat) {
  navBtnChat.addEventListener('click', () => switchMainTab('chat'));
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

if (btnHomeReviewPending) {
  btnHomeReviewPending.addEventListener('click', () => {
    switchMainTab('transfers');
    switchTransfersSubTab('active');
  });
}

if (checkSelectAllPending) {
  checkSelectAllPending.addEventListener('change', () => {
    const pendingIncoming = Object.values(currentState.transfers || []).filter(
      (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
    );
    const masterState = getMasterSelectionState(pendingIncoming);
    if (masterState.checked) {
      selectedPendingIds.clear();
    } else {
      pendingIncoming.forEach((t) => selectedPendingIds.add(t.id));
    }
    renderPendingApprovalPanel(pendingIncoming);
  });
}

if (btnAcceptSelected) {
  btnAcceptSelected.addEventListener('click', () => {
    if (selectedPendingIds.size === 0) {
      showToast('Selecione pelo menos uma transferência para aceitar.');
      return;
    }
    const toAccept = Array.from(selectedPendingIds);
    chrome.runtime.sendMessage(
      {
        action: 'RESPOND_INCOMING',
        transferIds: toAccept,
        accept: true
      },
      (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      }
    );
    toAccept.forEach((id) => selectedPendingIds.delete(id));
    showToast(`✓ ${toAccept.length} transferência(s) aceita(s)!`);
  });
}

if (btnRejectSelected) {
  btnRejectSelected.addEventListener('click', () => {
    if (selectedPendingIds.size === 0) {
      showToast('Selecione pelo menos uma transferência para cancelar.');
      return;
    }
    const toReject = Array.from(selectedPendingIds);
    chrome.runtime.sendMessage(
      {
        action: 'RESPOND_INCOMING',
        transferIds: toReject,
        accept: false
      },
      (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderAll();
        }
      }
    );
    toReject.forEach((id) => selectedPendingIds.delete(id));
    showToast(`✕ ${toReject.length} transferência(s) cancelada(s).`);
  });
}

if (pendingTreeContainer) {
  pendingTreeContainer.addEventListener('change', (e) => {
    const target = e.target;
    if (target.classList.contains('folder-checkbox')) {
      const folderPath = target.getAttribute('data-folder-path');
      const folder = currentPendingFolderMap.get(folderPath);
      if (folder) {
        const shouldCheck = target.checked;
        for (const tid of folder.transferIds) {
          if (shouldCheck) {
            selectedPendingIds.add(tid);
          } else {
            selectedPendingIds.delete(tid);
          }
        }
        renderPendingApprovalPanel();
      }
    } else if (target.classList.contains('file-checkbox')) {
      const transferId = target.getAttribute('data-transfer-id');
      if (transferId) {
        if (target.checked) {
          selectedPendingIds.add(transferId);
        } else {
          selectedPendingIds.delete(transferId);
        }
        renderPendingApprovalPanel();
      }
    }
  });

  pendingTreeContainer.addEventListener('click', (e) => {
    const btnRejectFolder = e.target.closest('.btn-reject-folder');
    if (btnRejectFolder) {
      e.stopPropagation();
      const folderPath = btnRejectFolder.getAttribute('data-folder-path');
      const folder = currentPendingFolderMap.get(folderPath);
      if (folder) {
        const toReject = Array.from(folder.transferIds);
        chrome.runtime.sendMessage(
          {
            action: 'RESPOND_INCOMING',
            transferIds: toReject,
            accept: false
          },
          (res) => {
            if (res && res.state) {
              currentState = res.state;
              renderAll();
            }
          }
        );
        toReject.forEach((id) => selectedPendingIds.delete(id));
        showToast(`✕ Pasta "${folder.name}" cancelada.`);
      }
      return;
    }

    const btnToggle = e.target.closest('.btn-toggle-folder');
    if (btnToggle) {
      e.stopPropagation();
      const folderPath = btnToggle.getAttribute('data-folder-path');
      if (folderPath) {
        if (expandedFolders.has(folderPath)) {
          expandedFolders.delete(folderPath);
        } else {
          expandedFolders.add(folderPath);
        }
        renderPendingApprovalPanel();
      }
      return;
    }

    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader && !e.target.closest('input, button')) {
      const folderPath = folderHeader.getAttribute('data-folder-path');
      if (folderPath) {
        if (expandedFolders.has(folderPath)) {
          expandedFolders.delete(folderPath);
        } else {
          expandedFolders.add(folderPath);
        }
        renderPendingApprovalPanel();
      }
      return;
    }

    const btnAcceptSingle = e.target.closest('[data-action="accept-single-pending"]');
    if (btnAcceptSingle) {
      e.stopPropagation();
      const transferId = btnAcceptSingle.getAttribute('data-transfer-id');
      if (transferId) {
        chrome.runtime.sendMessage(
          { action: 'RESPOND_INCOMING', transferId, accept: true },
          (res) => {
            if (res && res.state) {
              currentState = res.state;
              renderAll();
            }
          }
        );
        selectedPendingIds.delete(transferId);
      }
      return;
    }

    const btnRejectSingle = e.target.closest('[data-action="reject-single-pending"]');
    if (btnRejectSingle) {
      e.stopPropagation();
      const transferId = btnRejectSingle.getAttribute('data-transfer-id');
      if (transferId) {
        chrome.runtime.sendMessage(
          { action: 'RESPOND_INCOMING', transferId, accept: false },
          (res) => {
            if (res && res.state) {
              currentState = res.state;
              renderAll();
            }
          }
        );
        selectedPendingIds.delete(transferId);
      }
      return;
    }
  });
}

if (btnReceive) {
  btnReceive.addEventListener('click', () => {
    const pendingIncoming = Object.values(currentState.transfers || []).filter(
      (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
    );

    if (pendingIncoming.length > 0) {
      switchMainTab('transfers');
      switchTransfersSubTab('active');
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
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const downloadId = Number(btn.getAttribute('data-download-id'));
    const transferId = btn.getAttribute('data-transfer-id');
    const url = btn.getAttribute('data-url');

    if (action === 'toggle-card-files' && transferId) {
      if (expandedTransferFiles.has(transferId)) {
        expandedTransferFiles.delete(transferId);
      } else {
        expandedTransferFiles.add(transferId);
      }
      renderAll();
      return;
    }

    if (action === 'toggle-card-folder') {
      const folderKey = btn.getAttribute('data-folder-key');
      if (folderKey) {
        const collapseKey = folderKey + ':collapsed';
        if (cardTreeExpandedFolders.has(collapseKey)) {
          cardTreeExpandedFolders.delete(collapseKey);
        } else {
          cardTreeExpandedFolders.add(collapseKey);
        }
        renderAll();
      }
      return;
    }

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
      selectedPendingIds.delete(transferId);
      chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: true });
    } else if (action === 'reject-transfer' && transferId) {
      selectedPendingIds.delete(transferId);
      chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: false });
    } else if (action === 'copy-tunnel-link') {
      const targetUrl = url || (transferId && currentState.transfers[transferId]?.shareUrl);
      if (!targetUrl) return;
      try {
        await navigator.clipboard.writeText(targetUrl);
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<span>Copiado ✓</span>';
        setTimeout(() => {
          btn.innerHTML = originalHtml;
        }, 1800);
        showToast('✓ Link copiado para a área de transferência!');
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
        showToast('✓ Texto completo copiado com link, arquivos e senha!');
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
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const transferId = btn.getAttribute('data-transfer-id');
    const url = btn.getAttribute('data-url');
    const textToCopy = btn.getAttribute('data-text');

    if (action === 'toggle-card-files' && transferId) {
      if (expandedTransferFiles.has(transferId)) {
        expandedTransferFiles.delete(transferId);
      } else {
        expandedTransferFiles.add(transferId);
      }
      renderAll();
      return;
    }

    if (action === 'toggle-card-folder') {
      const folderKey = btn.getAttribute('data-folder-key');
      if (folderKey) {
        const collapseKey = folderKey + ':collapsed';
        if (cardTreeExpandedFolders.has(collapseKey)) {
          cardTreeExpandedFolders.delete(collapseKey);
        } else {
          cardTreeExpandedFolders.add(collapseKey);
        }
        renderAll();
      }
      return;
    }

    if (action === 'copy-text' && textToCopy) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        showToast('✓ Senha copiada para a área de transferência!');
      } catch {
        showToast('Não foi possível copiar automaticamente.');
      }
    } else if (action === 'copy-tunnel-link') {
      const targetUrl = url || (transferId && currentState.transfers[transferId]?.shareUrl);
      if (!targetUrl) return;
      try {
        await navigator.clipboard.writeText(targetUrl);
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<span>Copiado ✓</span>';
        setTimeout(() => {
          btn.innerHTML = originalHtml;
        }, 1800);
        showToast('✓ Link copiado para a área de transferência!');
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
        showToast('✓ Texto completo copiado com link, arquivos e senha!');
      } catch {
        showToast('Não foi possível copiar automaticamente.');
      }
    } else if (action === 'open-tunnel-url' && url) {
      chrome.tabs.create({ url });
    } else if (action === 'delete-single-transfer' && transferId) {
      chrome.runtime.sendMessage({ action: 'DELETE_TRANSFER', transferId }, (res) => {
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

// ============================================================================
// CHAT P2P: SISTEMA DE MENSAGENS, MÍDIA, VOZ, EMOJIS & ENCAMINHAMENTO
// ============================================================================

const chatSidebarPane = document.getElementById('chat-sidebar-pane');
const chatConversationPane = document.getElementById('chat-conversation-pane');
const chatPeerSearchInput = document.getElementById('chat-peer-search-input');
const chatConversationsList = document.getElementById('chat-conversations-list');
const btnChatStartNew = document.getElementById('btn-chat-start-new');
const chatSidebarOnlineBadge = document.getElementById('chat-sidebar-online-badge');

const chatEmptyPlaceholder = document.getElementById('chat-empty-placeholder');
const chatActiveContainer = document.getElementById('chat-active-container');
const btnChatBackList = document.getElementById('btn-chat-back-list');
const chatHeaderAvatar = document.getElementById('chat-header-avatar');
const chatHeaderDot = document.getElementById('chat-header-dot');
const chatHeaderTag = document.getElementById('chat-header-tag');
const chatHeaderStatus = document.getElementById('chat-header-status');
const btnChatToggleSelect = document.getElementById('btn-chat-toggle-select');
const btnChatHeaderAttach = document.getElementById('btn-chat-header-attach');
const btnChatClear = document.getElementById('btn-chat-clear');

const chatSelectionBar = document.getElementById('chat-selection-bar');
const btnChatSelectAll = document.getElementById('btn-chat-select-all');
const chatSelectedCount = document.getElementById('chat-selected-count');
const btnChatForwardSelected = document.getElementById('btn-chat-forward-selected');
const btnChatDeleteSelected = document.getElementById('btn-chat-delete-selected');
const btnChatCancelSelect = document.getElementById('btn-chat-cancel-select');

const chatMessagesList = document.getElementById('chat-messages-list');
const chatAttachmentPreview = document.getElementById('chat-attachment-preview');
const chatAttachmentChips = document.getElementById('chat-attachment-chips');
const btnChatClearAttachments = document.getElementById('btn-chat-clear-attachments');

const chatEmojiPicker = document.getElementById('chat-emoji-picker');
const chatEmojiTabs = document.getElementById('chat-emoji-tabs');
const chatEmojiGrid = document.getElementById('chat-emoji-grid');
const btnCloseEmojiPicker = document.getElementById('btn-close-emoji-picker');

const chatComposerBar = document.getElementById('chat-composer-bar');
const btnChatEmoji = document.getElementById('btn-chat-emoji');
const btnChatAttach = document.getElementById('btn-chat-attach');
const chatTextInput = document.getElementById('chat-text-input');
const btnChatRecordVoice = document.getElementById('btn-chat-record-voice');
const btnChatSend = document.getElementById('btn-chat-send');

const chatVoiceRecordingBar = document.getElementById('chat-voice-recording-bar');
const chatRecordTimer = document.getElementById('chat-record-timer');
const chatRecordWaveform = document.getElementById('chat-record-waveform');
const btnChatCancelVoice = document.getElementById('btn-chat-cancel-voice');
const btnChatSendVoice = document.getElementById('btn-chat-send-voice');

const chatForwardModal = document.getElementById('chat-forward-modal');
const chatForwardSummary = document.getElementById('chat-forward-summary');
const btnChatForwardClose = document.getElementById('btn-chat-forward-close');
const btnChatForwardCancel = document.getElementById('btn-chat-forward-cancel');
const btnChatForwardConfirm = document.getElementById('btn-chat-forward-confirm');
const chatForwardSearch = document.getElementById('chat-forward-search');
const btnChatForwardAddTag = document.getElementById('btn-chat-forward-add-tag');
const chatForwardPeersList = document.getElementById('chat-forward-peers-list');
const chatForwardNote = document.getElementById('chat-forward-note');
const chatForwardTargetCount = document.getElementById('chat-forward-target-count');

const chatMediaLightbox = document.getElementById('chat-media-lightbox');
const lightboxMediaTitle = document.getElementById('lightbox-media-title');
const lightboxMediaMeta = document.getElementById('lightbox-media-meta');
const lightboxMediaStage = document.getElementById('lightbox-media-stage');
const btnLightboxForward = document.getElementById('btn-lightbox-forward');
const btnLightboxDownload = document.getElementById('btn-lightbox-download');
const btnLightboxClose = document.getElementById('btn-lightbox-close');

// Estado interno do chat
let activeChatPeerTag = null;
let chatSelectionMode = false;
const chatSelectedMsgIds = new Set();
let chatStagedAttachments = [];
let activeChatAudioPlayer = null;
let activeVoiceRecorder = null;
let chatForwardSelectedMsgIds = [];
const chatForwardSelectedPeerTags = new Set();
let activeLightboxItem = null;
let currentEmojiCategory = 'recent';
let typingDebounceTimer = null;

// Emojis Categorizados
const EMOJIS_BY_CATEGORY = {
  recent: ['❤️', '😂', '👍', '🔥', '🎉', '😍', '👏', '🙏', '✨', '🚀', '💯', '😊', '🥰', '😘', '😎', '🤩', '💡', '✅'],
  faces: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🥲', '🥹', '☺️', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😮‍💨', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🫣', '🤗', '🫡', '🤔', '🤫', '🫢', '🤐', '😐', '😑', '😶', '🫥', '😶‍🌫️', '😬', '😮', '😯', '😲', '🥱', '😴', '🤤', '😪', '😵', '😵‍💫', '🫨', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'],
  gestures: ['👍', '👎', '👏', '🙌', '👐', '🤲', '🤝', '🤜', '🤛', '✊', '👊', '🖐️', '✋', '🤚', '👋', '🤙', '🫰', '✌️', '🤞', '🤟', '🤘', '👌', '🤏', '👈', '👉', '👆', '👇', '☝️', '✍️', '🤳', '💪', '🙏', '🦶', '🦵', '👂', '👃', '👀', '👁️', '🧠', '🫀', '🫁', '🦴'],
  hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☯️', '☸️', '⭐', '🌟', '✨', '⚡', '🔥', '💥', '💫', '🌈', '☀️', '🌙', '☁️', '❄️'],
  nature: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦅', '🦆', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🪲', '🪳', '🦟', '🐢', '🐍', '🐙', '🦑', '🦐', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🦈', '🐊', '🍕', '🍔', '🍟', '🌭', '🍿', '🧂', '🥓', '🥚', '🍳', '🧇', '🥞', '🧈', '🍞', '🥐', '🥨', '🥯', '☕', '🍵', '🧃', '🥤', '🍺', '🍻', '🍷', '🥂'],
  objects: ['🚀', '🛸', '🛰️', '✈️', '🚗', '🚕', '🚙', '🏎️', '🛵', '🏍️', '🚲', '🛴', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '📱', '☎️', '📞', '📟', '📠', '🔋', '🔌', '🖲️', '💽', '💾', '💿', '📀', '💡', '🔦', '🕯️', '🪔', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🔒', '🔓', '🔑', '🗝️', '📦', '📫', '📬', '🏷️', '📌', '📍', '📎', '📁', '📂', '📄', '📃', '📑', '📊', '📈', '📉', '📜']
};

function formatChatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return timeStr;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Ontem, ${timeStr}`;
  }
  return `${date.getDate()}/${date.getMonth() + 1} ${timeStr}`;
}

function isOnlyEmojis(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const emojiRegex = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}){1,3}$/u;
  return emojiRegex.test(trimmed);
}

// Input de arquivos oculto para anexos no chat
const chatHiddenFileInput = document.createElement('input');
chatHiddenFileInput.type = 'file';
chatHiddenFileInput.multiple = true;
chatHiddenFileInput.className = 'hidden';
chatHiddenFileInput.style.display = 'none';
document.body.appendChild(chatHiddenFileInput);

chatHiddenFileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    Array.from(e.target.files).forEach(addChatStagedAttachment);
  }
  chatHiddenFileInput.value = '';
});

if (btnChatAttach) {
  btnChatAttach.addEventListener('click', () => {
    chatHiddenFileInput.click();
  });
}
if (btnChatHeaderAttach) {
  btnChatHeaderAttach.addEventListener('click', () => {
    chatHiddenFileInput.click();
  });
}

function addChatStagedAttachment(file) {
  if (!file) return;
  const fileId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let type = 'file';
  if (file.type.startsWith('image/')) type = 'image';
  else if (file.type.startsWith('video/')) type = 'video';
  else if (file.type.startsWith('audio/')) type = 'audio';

  let previewUrl = null;
  if (type === 'image') {
    previewUrl = URL.createObjectURL(file);
  }

  chatStagedAttachments.push({
    fileId,
    name: file.name,
    size: file.size,
    type,
    fileObj: file,
    previewUrl
  });

  renderChatAttachmentPreview();
}

function removeChatStagedAttachment(fileId) {
  const idx = chatStagedAttachments.findIndex((a) => a.fileId === fileId);
  if (idx !== -1) {
    const item = chatStagedAttachments[idx];
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    chatStagedAttachments.splice(idx, 1);
  }
  renderChatAttachmentPreview();
}

function clearAllChatAttachments() {
  chatStagedAttachments.forEach((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
  chatStagedAttachments = [];
  renderChatAttachmentPreview();
}

function renderChatAttachmentPreview() {
  if (!chatAttachmentPreview || !chatAttachmentChips) return;
  if (chatStagedAttachments.length === 0) {
    chatAttachmentPreview.classList.add('hidden');
    chatAttachmentChips.innerHTML = '';
    return;
  }

  chatAttachmentPreview.classList.remove('hidden');
  chatAttachmentChips.innerHTML = '';

  chatStagedAttachments.forEach((att) => {
    const chip = document.createElement('div');
    chip.className = 'flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs shrink-0 max-w-[200px] shadow-sm';

    let iconHtml = '📄';
    if (att.type === 'image' && att.previewUrl) {
      iconHtml = `<img src="${att.previewUrl}" class="w-5 h-5 rounded object-cover shrink-0" />`;
    } else if (att.type === 'video') {
      iconHtml = '🎥';
    } else if (att.type === 'audio') {
      iconHtml = '🎵';
    }

    chip.innerHTML = `
      <div class="shrink-0">${iconHtml}</div>
      <div class="flex flex-col min-w-0">
        <span class="text-[11px] font-medium text-slate-200 truncate" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
        <span class="text-[9px] font-mono text-slate-400">${formatBytes(att.size)}</span>
      </div>
      <button type="button" class="btn-remove-att text-slate-400 hover:text-rose-400 text-xs ml-1 font-bold cursor-pointer" title="Remover">✕</button>
    `;

    chip.querySelector('.btn-remove-att').addEventListener('click', (e) => {
      e.stopPropagation();
      removeChatStagedAttachment(att.fileId);
    });

    chatAttachmentChips.appendChild(chip);
  });
}

if (btnChatClearAttachments) {
  btnChatClearAttachments.addEventListener('click', clearAllChatAttachments);
}

// Drag and drop direto no chat
if (chatMessagesList) {
  chatMessagesList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMessagesList.classList.add('ring-2', 'ring-emerald-500/50');
  });

  chatMessagesList.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMessagesList.classList.remove('ring-2', 'ring-emerald-500/50');
  });

  chatMessagesList.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatMessagesList.classList.remove('ring-2', 'ring-emerald-500/50');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach(addChatStagedAttachment);
    }
  });
}

// Navegação e abertura de conversas
function openChatConversation(peerTag) {
  if (!peerTag) return;
  const normalized = normalizeTag(peerTag);
  activeChatPeerTag = normalized;
  exitChatSelectionMode();

  if (currentMainTab !== 'chat') {
    switchMainTab('chat');
  }

  // Em telas menores, alterna a visualização do painel
  if (chatSidebarPane && chatConversationPane) {
    chatSidebarPane.classList.add('chat-mobile-hidden');
    chatConversationPane.classList.remove('chat-mobile-hidden');
  }

  // Marca mensagens como lidas
  chrome.runtime.sendMessage({ action: 'MARK_CHAT_READ', peerTag: normalized });
  if (currentState.chatUnreadCounts) {
    currentState.chatUnreadCounts[normalized] = 0;
  }
  updateNavBadges();

  renderChatView();

  if (chatTextInput) {
    chatTextInput.focus();
  }
}

if (btnChatBackList) {
  btnChatBackList.addEventListener('click', () => {
    if (chatSidebarPane && chatConversationPane) {
      chatSidebarPane.classList.remove('chat-mobile-hidden');
      chatConversationPane.classList.add('chat-mobile-hidden');
    }
  });
}

// Iniciar nova conversa ou filtrar pelo input
if (btnChatStartNew && chatPeerSearchInput) {
  btnChatStartNew.addEventListener('click', () => {
    const raw = chatPeerSearchInput.value.trim();
    if (!raw) return;
    const tag = normalizeTag(raw);
    openChatConversation(tag);
    chatPeerSearchInput.value = '';
    renderChatConversationsList();
  });

  chatPeerSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnChatStartNew.click();
    }
  });

  chatPeerSearchInput.addEventListener('input', () => {
    renderChatConversationsList();
  });
}

// Renderização geral da aba de Chat
function renderChatView() {
  const chatMyTagDisplay = document.getElementById('chat-my-tag-display');
  if (chatMyTagDisplay) {
    chatMyTagDisplay.textContent = currentState.myTag || '@anônimo';
  }

  const btnChatEditMyTag = document.getElementById('btn-chat-edit-my-tag');
  if (btnChatEditMyTag && !btnChatEditMyTag._hasBound) {
    btnChatEditMyTag._hasBound = true;
    btnChatEditMyTag.addEventListener('click', () => {
      switchMainTab('home');
      if (myTagInput) {
        myTagInput.focus();
        myTagInput.select();
      }
    });
  }

  renderChatConversationsList();
  renderActiveChatConversation();
}

function renderChatConversationsList() {
  if (!chatConversationsList) return;
  chatConversationsList.innerHTML = '';

  const filter = (chatPeerSearchInput?.value || '').trim().toLowerCase().replace(/^@/, '');
  const allMessages = currentState.chatMessages || {};
  const unreadCounts = currentState.chatUnreadCounts || {};
  const peerRegistry = currentState.peerRegistry || {};
  const typingState = currentState.peerTypingState || {};
  const now = Date.now();

  const contacts = (typeof PulseShareCrypto !== 'undefined' && PulseShareCrypto.ProfilesManager) ? PulseShareCrypto.ProfilesManager.getContacts() : {};
  const transfers = currentState.transfers || [];
  const conversationPeers = new Set();
  Object.keys(allMessages).forEach((tag) => {
    if (tag && tag !== currentState.myTag) conversationPeers.add(normalizeTag(tag));
  });
  transfers.forEach((t) => {
    const peerTag = t.senderTag || t.targetTag || t.sender || t.target;
    if (peerTag && peerTag !== currentState.myTag) conversationPeers.add(normalizeTag(peerTag));
  });
  Object.keys(contacts).forEach((tag) => {
    if (tag && tag !== currentState.myTag) conversationPeers.add(normalizeTag(tag));
  });

  const sortedList = Array.from(conversationPeers)
    .filter((tag) => {
      if (!filter) return true;
      return tag.toLowerCase().includes(filter);
    })
    .map((tag) => {
      const msgs = allMessages[tag] || [];
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      const peerData = peerRegistry[tag] || null;
      const isOnline = peerData && (peerData.status === 'online' || now - (peerData.lastSeen || 0) < 45000);
      const unread = Number(unreadCounts[tag]) || 0;
      const isTyping = Boolean(typingState[tag] && typingState[tag].status !== 'idle' && (now - (typingState[tag].updatedAt || 0) < 5000));
      const typingType = typingState[tag]?.typingType || typingState[tag]?.status || 'typing';
      return {
        tag,
        lastMsg,
        timestamp: lastMsg?.timestamp || (peerData?.lastSeen || 0),
        isOnline,
        unread,
        isTyping,
        typingType
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp);

  if (sortedList.length === 0) {
    chatConversationsList.innerHTML = `
      <div class="text-center py-8 px-4 text-slate-500 text-xs italic">
        Nenhuma conversa iniciada.<br/>Digite um <span class="text-emerald-400 font-mono">@usuario</span> acima ou selecione um nó na aba Usuários P2P.
      </div>
    `;
    return;
  }

  sortedList.forEach((conv) => {
    const isSelected = activeChatPeerTag === conv.tag;
    const initial = conv.tag.charAt(1).toUpperCase() || '@';

    let snippet = 'Nenhuma mensagem ainda';
    if (conv.isTyping) {
      snippet = conv.typingType === 'recording'
        ? '<span class="text-rose-400 animate-pulse font-medium">🎤 gravando áudio...</span>'
        : '<span class="text-emerald-400 animate-pulse font-medium">digitando...</span>';
    } else if (conv.lastMsg) {
      const m = conv.lastMsg;
      const prefix = m.senderTag === currentState.myTag ? 'Você: ' : '';
      if (m.type === 'image') snippet = `${prefix}📷 Foto`;
      else if (m.type === 'video') snippet = `${prefix}🎥 Vídeo`;
      else if (m.type === 'voice') snippet = `${prefix}🎤 Mensagem de voz`;
      else if (m.type === 'audio') snippet = `${prefix}🎵 Áudio`;
      else if (m.type === 'file') snippet = `${prefix}📁 ${escapeHtml(m.media?.fileName || 'Arquivo')}`;
      else snippet = `${prefix}${escapeHtml(m.text || '')}`;
    }

    const timeStr = conv.lastMsg ? formatChatTime(conv.lastMsg.timestamp) : '';

    const itemEl = document.createElement('div');
    itemEl.className = `px-3 py-2.5 flex items-center gap-2.5 border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors ${
      isSelected ? 'bg-slate-800/70 border-l-2 border-l-emerald-500' : ''
    }`;

    itemEl.innerHTML = `
      <div class="relative shrink-0">
        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-slate-700 to-slate-900 border border-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400 font-mono shadow-sm">
          ${escapeHtml(initial)}
        </div>
        <span class="w-2.5 h-2.5 rounded-full border-2 border-slate-950 absolute -bottom-0.5 -right-0.5 ${
          conv.isOnline ? 'bg-emerald-400' : 'bg-slate-600'
        }"></span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-1">
          <span class="text-xs font-bold font-mono text-slate-100 truncate">${escapeHtml(conv.tag)}</span>
          <span class="text-[9px] font-mono text-slate-500 shrink-0">${timeStr}</span>
        </div>
        <div class="flex items-center justify-between gap-1 mt-0.5">
          <span class="text-[11px] text-slate-400 truncate leading-tight">${snippet}</span>
          ${
            conv.unread > 0
              ? `<span class="px-1.5 py-0.2 rounded-full bg-emerald-500 text-slate-950 text-[9px] font-bold font-mono shrink-0 shadow-sm">${conv.unread}</span>`
              : ''
          }
        </div>
      </div>
    `;

    itemEl.addEventListener('click', () => {
      openChatConversation(conv.tag);
    });

    chatConversationsList.appendChild(itemEl);
  });
}

function renderActiveChatConversation() {
  if (!activeChatPeerTag) {
    if (chatEmptyPlaceholder) chatEmptyPlaceholder.classList.remove('hidden');
    if (chatActiveContainer) chatActiveContainer.classList.add('hidden');
    return;
  }

  if (chatEmptyPlaceholder) chatEmptyPlaceholder.classList.add('hidden');
  if (chatActiveContainer) chatActiveContainer.classList.remove('hidden');

  // Cabeçalho da conversa
  if (chatHeaderTag) chatHeaderTag.textContent = activeChatPeerTag;
  if (chatHeaderAvatar) {
    chatHeaderAvatar.textContent = activeChatPeerTag.charAt(1).toUpperCase() || '@';
  }

  const now = Date.now();
  const peerData = currentState.peerRegistry ? currentState.peerRegistry[activeChatPeerTag] : null;
  const isOnline = Boolean(peerData && (peerData.status === 'online' || now - (peerData.lastSeen || 0) < 45000));
  const typingInfo = currentState.peerTypingState ? currentState.peerTypingState[activeChatPeerTag] : null;
  const isTyping = Boolean(typingInfo && typingInfo.status !== 'idle' && (now - (typingInfo.updatedAt || 0) < 5000));

  if (chatHeaderDot) {
    chatHeaderDot.className = `w-2.5 h-2.5 rounded-full border-2 border-slate-900 absolute -bottom-0.5 -right-0.5 ${
      isOnline ? 'bg-emerald-400' : 'bg-slate-600'
    }`;
  }

  if (chatHeaderStatus) {
    if (isTyping) {
      chatHeaderStatus.className = 'text-[10px] text-emerald-400 truncate leading-tight animate-pulse font-medium';
      chatHeaderStatus.textContent = (typingInfo.status === 'recording' || typingInfo.typingType === 'recording') ? '🎤 gravando áudio...' : 'digitando...';
    } else if (isOnline) {
      chatHeaderStatus.className = 'text-[10px] text-emerald-400 truncate leading-tight';
      chatHeaderStatus.textContent = 'online • WebRTC + Mesh P2P';
    } else {
      chatHeaderStatus.className = 'text-[10px] text-slate-500 truncate leading-tight';
      chatHeaderStatus.textContent = 'offline • Fila DTN Store & Forward';
    }
  }

  // Barra de seleção de mensagens
  if (chatSelectionBar) {
    if (chatSelectionMode) {
      chatSelectionBar.classList.remove('hidden');
      if (chatSelectedCount) {
        chatSelectedCount.textContent = `${chatSelectedMsgIds.size} selecionada(s)`;
      }
    } else {
      chatSelectionBar.classList.add('hidden');
    }
  }

  // Lista de mensagens
  if (!chatMessagesList) return;
  chatMessagesList.innerHTML = '';

  const normActiveTag = normalizeTag(activeChatPeerTag);
  const messages = (currentState.chatMessages && (currentState.chatMessages[normActiveTag] || currentState.chatMessages[activeChatPeerTag])) || [];


  if (messages.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'h-full flex flex-col items-center justify-center text-center p-6 text-slate-500 text-xs';
    emptyEl.innerHTML = `
      <div class="text-3xl mb-2">💬</div>
      <p class="font-semibold text-slate-300">Nenhuma mensagem trocada ainda com ${escapeHtml(activeChatPeerTag)}</p>
      <p class="text-[10px] text-slate-500 mt-1">
        Envie uma mensagem de texto, emoticons, arquivos, fotos, vídeos ou grave sua voz pelo microfone.
      </p>
    `;
    chatMessagesList.appendChild(emptyEl);
    return;
  }

  const isAtBottom = chatMessagesList.scrollHeight - chatMessagesList.scrollTop - chatMessagesList.clientHeight < 100;

  messages.forEach((msg) => {
    const isOut = msg.direction === 'outgoing' || (currentState.myTag && (msg.senderTag === currentState.myTag || msg.from === currentState.myTag));
    const isSelected = chatSelectedMsgIds.has(msg.id);
    const msgType = msg.type || msg.msgType || 'text';
    const isForwarded = Boolean(msg.isForwarded || msg.forwarded);
    const media = msg.media || (msg.transferId && (msg.fileMeta || msg.fileName) ? { ...(msg.fileMeta || {}), fileName: msg.fileName || msg.fileMeta?.name || msg.fileMeta?.fileName, fileSize: msg.fileSize || msg.fileMeta?.size || msg.fileMeta?.fileSize, fileType: msg.fileType || msg.fileMeta?.type || msg.fileMeta?.fileType, transferId: msg.transferId, duration: msg.voiceDuration, waveform: msg.waveform } : null);

    const rowEl = document.createElement('div');
    rowEl.className = `flex items-end gap-1.5 my-1 ${isOut ? 'justify-end' : 'justify-start'}`;

    if (chatSelectionMode) {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chat-msg-checkbox w-4 h-4 rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-sky-500/50 cursor-pointer mb-2 shrink-0';
      chk.checked = isSelected;
      chk.addEventListener('change', () => {
        toggleSelectMessage(msg.id);
      });
      if (isOut) {
        rowEl.insertBefore(chk, rowEl.firstChild);
      } else {
        rowEl.appendChild(chk);
      }
    }

    const bubbleEl = document.createElement('div');
    bubbleEl.className = `chat-bubble ${isOut ? 'outgoing' : 'incoming'} group relative`;
    bubbleEl.dataset.msgId = msg.id;

    let bodyHtml = '';

    // Encaminhado
    if (isForwarded) {
      bodyHtml += `
        <div class="text-[9px] text-slate-400 italic flex items-center gap-1 mb-1 font-sans">
          <span>↪</span>
          <span>Encaminhada</span>
        </div>
      `;
    }

    // Mídia: Imagem
    if (msgType === 'image' && media) {
      const blob = activeSessionFiles.get(media.transferId);
      const blobUrl = blob ? URL.createObjectURL(blob) : '';
      bodyHtml += `
        <div class="chat-media-frame cursor-pointer" data-action="open-lightbox" data-msg-id="${escapeHtml(msg.id)}">
          ${
            blobUrl
              ? `<img src="${blobUrl}" class="chat-media-img hover:opacity-95 transition-opacity" alt="${escapeHtml(media.fileName || 'Imagem')}" />`
              : `<div class="p-4 text-center text-slate-400 text-xs italic bg-slate-900/60 rounded-xl">📷 ${escapeHtml(media.fileName || 'Carregando imagem...')}</div>`
          }
        </div>
      `;
    }

    // Mídia: Vídeo
    if (msgType === 'video' && media) {
      const blob = activeSessionFiles.get(media.transferId);
      const blobUrl = blob ? URL.createObjectURL(blob) : '';
      bodyHtml += `
        <div class="chat-media-frame">
          ${
            blobUrl
              ? `<video src="${blobUrl}" controls class="chat-media-video" preload="metadata"></video>`
              : `<div class="p-4 text-center text-slate-400 text-xs italic bg-slate-900/60 rounded-xl">🎥 ${escapeHtml(media.fileName || 'Carregando vídeo...')}</div>`
          }
        </div>
      `;
    }

    // Mídia: Mensagem de Voz (WhatsApp style player)
    if (msgType === 'voice' && media) {
      const blob = activeSessionFiles.get(media.transferId);
      const blobUrl = blob ? URL.createObjectURL(blob) : '';
      const durSec = media.duration || 0;
      const durStr = `${String(Math.floor(durSec / 60)).padStart(2, '0')}:${String(durSec % 60).padStart(2, '0')}`;
      const waveformBars = Array.isArray(media.waveform) && media.waveform.length > 0
        ? media.waveform
        : [0.3, 0.6, 0.9, 0.5, 0.8, 0.4, 0.7, 0.3, 0.5, 0.8, 0.6, 0.3];

      let barsHtml = '';
      waveformBars.forEach((val) => {
        const h = Math.max(3, Math.min(20, Math.round(val * 20)));
        barsHtml += `<div class="chat-waveform-bar" style="height: ${h}px;"></div>`;
      });

      bodyHtml += `
        <div class="chat-voice-player" data-transfer-id="${escapeHtml(media.transferId)}">
          <button type="button" class="btn-voice-play w-7 h-7 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center shrink-0 cursor-pointer shadow">
            ▶
          </button>
          <div class="chat-waveform-bars flex-1 mx-1.5 cursor-pointer" data-action="seek-audio">
            ${barsHtml}
          </div>
          <span class="voice-duration text-[10px] font-mono text-slate-300 shrink-0">${durStr}</span>
          <button type="button" class="chat-voice-speed-btn" data-action="toggle-speed" title="Velocidade de reprodução">
            1x
          </button>
        </div>
      `;
    }

    // Mídia: Arquivo de Áudio
    if (msgType === 'audio' && media) {
      const blob = activeSessionFiles.get(media.transferId);
      const blobUrl = blob ? URL.createObjectURL(blob) : '';
      bodyHtml += `
        <div class="p-1 flex flex-col gap-1">
          <div class="flex items-center gap-1.5 text-xs font-medium text-slate-200">
            <span>🎵</span>
            <span class="truncate">${escapeHtml(media.fileName || 'Áudio')}</span>
          </div>
          ${
            blobUrl
              ? `<audio src="${blobUrl}" controls class="w-full h-8" preload="metadata"></audio>`
              : `<span class="text-[10px] text-slate-400 italic">Carregando áudio...</span>`
          }
        </div>
      `;
    }

    // Mídia: Arquivo Genérico
    if (msgType === 'file' && media) {
      const icon = getFileExtensionIcon(media.fileName || '');
      bodyHtml += `
        <div class="chat-file-card flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-700/50 gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-base shrink-0">${icon}</span>
            <div class="flex flex-col min-w-0">
              <span class="text-xs font-semibold text-slate-100 truncate" title="${escapeHtml(media.fileName)}">${escapeHtml(media.fileName)}</span>
              <span class="text-[9px] font-mono text-slate-400">${formatBytes(media.fileSize || 0)}</span>
            </div>
          </div>
          <button
            type="button"
            class="px-2 py-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[10px] shrink-0 cursor-pointer shadow transition-colors"
            data-action="download-file"
            data-transfer-id="${escapeHtml(media.transferId)}"
            data-file-name="${escapeHtml(media.fileName)}"
          >
            Baixar
          </button>
        </div>
      `;
    }

    // Texto
    if (msg.text) {
      if (isOnlyEmojis(msg.text)) {
        bodyHtml += `<div class="chat-emoji-jumbo py-1">${escapeHtml(msg.text)}</div>`;
      } else {
        bodyHtml += `<div class="text-xs break-words whitespace-pre-wrap leading-relaxed select-text">${escapeHtml(msg.text)}</div>`;
      }
    }

    // Reações
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      let reactsHtml = '<div class="flex flex-wrap gap-1 mt-1">';
      Object.entries(msg.reactions).forEach(([emoji, bySet]) => {
        const count = Array.isArray(bySet) ? bySet.length : 1;
        reactsHtml += `
          <button type="button" class="px-1.5 py-0.2 rounded-full bg-slate-800 border border-slate-700 text-[10px] flex items-center gap-1 cursor-pointer hover:bg-slate-700" data-action="toggle-reaction" data-emoji="${escapeHtml(emoji)}" data-msg-id="${escapeHtml(msg.id)}">
            <span>${escapeHtml(emoji)}</span>
            ${count > 1 ? `<span class="text-[9px] font-mono text-slate-300">${count}</span>` : ''}
          </button>
        `;
      });
      reactsHtml += '</div>';
      bodyHtml += reactsHtml;
    }

    // Rodapé da bolha: hora e status (ticks)
    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let tickHtml = '';
    if (isOut) {
      const st = String(msg.status || '').toLowerCase();
      if (st === 'sending') {
        tickHtml = '<span class="text-slate-400 font-mono text-[9px]" title="Enviando...">🕒</span>';
      } else if (st === 'sent') {
        tickHtml = '<span class="text-slate-400 font-mono text-[10px]" title="Enviada para a malha">✓</span>';
      } else if (st === 'delivered') {
        tickHtml = '<span class="text-slate-400 font-mono text-[10px]" title="Entregue no nó destino">✓✓</span>';
      } else if (st === 'read') {
        tickHtml = '<span class="text-emerald-400 font-mono text-[10px] font-bold" title="Lida pelo destinatário">✓✓</span>';
      }
    }

    bodyHtml += `
      <div class="flex items-center justify-end gap-1 mt-0.5 text-[9px] text-slate-400 font-mono select-none">
        <span>${timeStr}</span>
        ${tickHtml}
      </div>
    `;

    // Botões de ação rápida no hover
    bodyHtml += `
      <div class="opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 right-1 flex items-center gap-1 bg-slate-900/90 border border-slate-700/80 rounded-lg p-0.5 shadow-md">
        <button type="button" class="p-1 hover:bg-slate-800 rounded text-[10px] cursor-pointer" data-action="quick-react" data-msg-id="${escapeHtml(msg.id)}" title="Reagir">😊</button>
        <button type="button" class="p-1 hover:bg-slate-800 rounded text-[10px] cursor-pointer" data-action="forward-single" data-msg-id="${escapeHtml(msg.id)}" title="Encaminhar">↪</button>
        <button type="button" class="p-1 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 rounded text-[10px] cursor-pointer" data-action="delete-single" data-msg-id="${escapeHtml(msg.id)}" title="Excluir">🗑️</button>
      </div>
    `;

    bubbleEl.innerHTML = bodyHtml;

    // Conectar eventos dentro da bolha
    attachBubbleEvents(bubbleEl, msg);

    rowEl.appendChild(bubbleEl);
    chatMessagesList.appendChild(rowEl);
  });

  if (isAtBottom) {
    chatMessagesList.scrollTop = chatMessagesList.scrollHeight;
  }
}

function attachBubbleEvents(bubbleEl, msg) {
  // Lightbox para imagens
  const lightboxTrigger = bubbleEl.querySelector('[data-action="open-lightbox"]');
  if (lightboxTrigger) {
    lightboxTrigger.addEventListener('click', () => {
      openMediaLightbox(msg.id);
    });
  }

  // Download de arquivo
  const downloadBtn = bubbleEl.querySelector('[data-action="download-file"]');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const transferId = downloadBtn.dataset.transferId;
      const fileName = downloadBtn.dataset.fileName;
      downloadChatMedia(transferId, fileName);
    });
  }

  // Player de Voz WhatsApp
  const voicePlayer = bubbleEl.querySelector('.chat-voice-player');
  if (voicePlayer && msg.media) {
    const playBtn = voicePlayer.querySelector('.btn-voice-play');
    const waveformContainer = voicePlayer.querySelector('.chat-waveform-bars');
    const timeDisplay = voicePlayer.querySelector('.voice-duration');
    const speedBtn = voicePlayer.querySelector('.chat-voice-speed-btn');

    const blob = activeSessionFiles.get(msg.media.transferId);
    const blobUrl = blob ? URL.createObjectURL(blob) : '';

    if (playBtn && blobUrl) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAudioPlayback(msg.id, blobUrl, waveformContainer, timeDisplay, playBtn, speedBtn);
      });
    }

    if (speedBtn) {
      speedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleAudioPlaybackSpeed(speedBtn);
      });
    }
  }

  // Ações rápidas
  const quickReactBtn = bubbleEl.querySelector('[data-action="quick-react"]');
  if (quickReactBtn) {
    quickReactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Reação rápida com coração ou curtir
      sendChatReaction(msg.id, '❤️');
    });
  }

  const forwardBtn = bubbleEl.querySelector('[data-action="forward-single"]');
  if (forwardBtn) {
    forwardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openForwardModal([msg.id]);
    });
  }

  const deleteBtn = bubbleEl.querySelector('[data-action="delete-single"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSingleChatMessage(msg.id);
    });
  }

  const reactToggles = bubbleEl.querySelectorAll('[data-action="toggle-reaction"]');
  reactToggles.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      sendChatReaction(msg.id, emoji);
    });
  });
}

function downloadChatMedia(transferId, fileName) {
  if (!transferId) return;
  const blob = activeSessionFiles.get(transferId);
  if (blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'arquivo-p2p';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    showToast(`Baixando ${fileName || 'arquivo'}...`, 'info');
  } else {
    showToast(`Solicitando download de ${fileName || 'arquivo'}...`, 'info');
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_CHAT_MEDIA', transferId, fileName });
  }
}

// Player de Áudio e Voz
function stopActiveAudioPlayer() {
  if (!activeChatAudioPlayer) return;
  try {
    if (activeChatAudioPlayer.audioEl) {
      activeChatAudioPlayer.audioEl.pause();
    }
    if (activeChatAudioPlayer.btnPlay) {
      activeChatAudioPlayer.btnPlay.textContent = '▶';
    }
  } catch (err) {}
  activeChatAudioPlayer = null;
}

function toggleAudioPlayback(msgId, blobUrl, waveformContainer, timeDisplay, btnPlay, speedBtn) {
  if (activeChatAudioPlayer && activeChatAudioPlayer.msgId === msgId) {
    if (activeChatAudioPlayer.audioEl.paused) {
      activeChatAudioPlayer.audioEl.play().catch(console.error);
      btnPlay.textContent = '⏸';
    } else {
      activeChatAudioPlayer.audioEl.pause();
      btnPlay.textContent = '▶';
    }
    return;
  }

  stopActiveAudioPlayer();

  const audio = new Audio(blobUrl);
  activeChatAudioPlayer = {
    audioEl: audio,
    msgId,
    btnPlay,
    waveformContainer,
    timeDisplay,
    speedBtn,
    currentSpeed: 1
  };

  btnPlay.textContent = '⏸';

  audio.ontimeupdate = () => {
    if (!audio.duration) return;
    const progress = audio.currentTime / audio.duration;
    const curM = String(Math.floor(audio.currentTime / 60)).padStart(2, '0');
    const curS = String(Math.floor(audio.currentTime % 60)).padStart(2, '0');
    if (timeDisplay) timeDisplay.textContent = `${curM}:${curS}`;

    if (waveformContainer) {
      const bars = waveformContainer.querySelectorAll('.chat-waveform-bar');
      const activeBarIdx = Math.floor(progress * bars.length);
      bars.forEach((bar, idx) => {
        if (idx <= activeBarIdx) {
          bar.classList.add('bg-emerald-400');
          bar.classList.remove('bg-slate-600', 'bg-slate-400');
        } else {
          bar.classList.remove('bg-emerald-400');
          bar.classList.add('bg-slate-600');
        }
      });
    }
  };

  audio.onended = () => {
    btnPlay.textContent = '▶';
    if (timeDisplay && audio.duration) {
      const durM = String(Math.floor(audio.duration / 60)).padStart(2, '0');
      const durS = String(Math.floor(audio.duration % 60)).padStart(2, '0');
      timeDisplay.textContent = `${durM}:${durS}`;
    }
    if (waveformContainer) {
      const bars = waveformContainer.querySelectorAll('.chat-waveform-bar');
      bars.forEach((bar) => {
        bar.classList.remove('bg-emerald-400');
        bar.classList.add('bg-slate-600');
      });
    }
    stopActiveAudioPlayer();
  };

  audio.play().catch((err) => {
    console.error('Erro ao reproduzir áudio:', err);
    btnPlay.textContent = '▶';
    stopActiveAudioPlayer();
  });
}

function cycleAudioPlaybackSpeed(speedBtn) {
  if (!activeChatAudioPlayer || !activeChatAudioPlayer.audioEl) return;
  const speeds = [1, 1.5, 2];
  let nextIdx = (speeds.indexOf(activeChatAudioPlayer.currentSpeed) + 1) % speeds.length;
  activeChatAudioPlayer.currentSpeed = speeds[nextIdx];
  activeChatAudioPlayer.audioEl.playbackRate = activeChatAudioPlayer.currentSpeed;
  speedBtn.textContent = `${activeChatAudioPlayer.currentSpeed}x`;
}

// Gravação de voz com microfone
async function startVoiceRecording() {
  if (activeVoiceRecorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    sourceNode.connect(analyser);

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    }

    const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const audioChunks = [];
    const waveformSamples = [];

    activeVoiceRecorder = {
      mediaRecorder,
      audioStream: stream,
      audioContext,
      analyser,
      audioChunks,
      waveformSamples,
      startTime: Date.now(),
      timerInterval: null,
      animFrame: null
    };

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.start(100);

    if (chatComposerBar) chatComposerBar.classList.add('hidden');
    if (chatVoiceRecordingBar) chatVoiceRecordingBar.classList.remove('hidden');

    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - activeVoiceRecorder.startTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      if (chatRecordTimer) chatRecordTimer.textContent = `${m}:${s}`;
    };
    updateTimer();
    activeVoiceRecorder.timerInterval = setInterval(updateTimer, 500);

    if (chatRecordWaveform) {
      chatRecordWaveform.innerHTML = '';
      for (let i = 0; i < 24; i++) {
        const bar = document.createElement('div');
        bar.className = 'chat-waveform-bar';
        bar.style.height = '4px';
        chatRecordWaveform.appendChild(bar);
      }
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastSampleTime = 0;

    const animateBars = () => {
      if (!activeVoiceRecorder) return;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const norm = Math.min(1, Math.max(0.1, avg / 128));

      const now = Date.now();
      if (now - lastSampleTime >= 120 && waveformSamples.length < 40) {
        waveformSamples.push(Math.round(norm * 100) / 100);
        lastSampleTime = now;
      }

      if (chatRecordWaveform) {
        const bars = chatRecordWaveform.children;
        for (let i = 0; i < bars.length; i++) {
          const idx = (i * 2) % dataArray.length;
          const val = dataArray[idx] || 0;
          const barHeight = Math.max(3, Math.min(22, (val / 255) * 22));
          bars[i].style.height = `${barHeight}px`;
        }
      }

      activeVoiceRecorder.animFrame = requestAnimationFrame(animateBars);
    };
    activeVoiceRecorder.animFrame = requestAnimationFrame(animateBars);

    sendTypingStatus('recording');
  } catch (err) {
    console.error('Falha ao acessar microfone:', err);
    showToast('Não foi possível acessar o microfone para gravar voz. Verifique as permissões.', 'error');
    cleanupVoiceRecorder();
  }
}

function cleanupVoiceRecorder() {
  if (!activeVoiceRecorder) return;
  if (activeVoiceRecorder.timerInterval) clearInterval(activeVoiceRecorder.timerInterval);
  if (activeVoiceRecorder.animFrame) cancelAnimationFrame(activeVoiceRecorder.animFrame);
  if (activeVoiceRecorder.audioStream) {
    activeVoiceRecorder.audioStream.getTracks().forEach((t) => t.stop());
  }
  if (activeVoiceRecorder.audioContext && activeVoiceRecorder.audioContext.state !== 'closed') {
    activeVoiceRecorder.audioContext.close().catch(() => {});
  }
  activeVoiceRecorder = null;
  if (chatVoiceRecordingBar) chatVoiceRecordingBar.classList.add('hidden');
  if (chatComposerBar) chatComposerBar.classList.remove('hidden');
  if (chatRecordTimer) chatRecordTimer.textContent = '00:00';
  sendTypingStatus(false);
}

function cancelVoiceRecording() {
  if (activeVoiceRecorder && activeVoiceRecorder.mediaRecorder && activeVoiceRecorder.mediaRecorder.state !== 'inactive') {
    activeVoiceRecorder.mediaRecorder.stop();
  }
  cleanupVoiceRecorder();
}

function stopAndSendVoiceRecording() {
  if (!activeVoiceRecorder || !activeChatPeerTag) {
    cancelVoiceRecording();
    return;
  }
  const recorder = activeVoiceRecorder;
  const durationSec = Math.max(1, Math.round((Date.now() - recorder.startTime) / 1000));
  const samples = recorder.waveformSamples.length > 0 ? recorder.waveformSamples : [0.3, 0.6, 0.9, 0.5, 0.8, 0.4, 0.7, 0.3];

  recorder.mediaRecorder.onstop = async () => {
    try {
      const mime = recorder.mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(recorder.audioChunks, { type: mime });
      const fileName = `voz-${Date.now()}.webm`;
      const transferId = `chatmedia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      activeSessionFiles.set(transferId, audioBlob);
      saveStagedFile(transferId, audioBlob);
      if (fileBridgeChannel) {
        fileBridgeChannel.postMessage({
          type: 'STAGE_FILE_MEMORY',
          action: 'STAGE_FILE_MEMORY',
          transferId,
          fileName,
          fileSize: audioBlob.size,
          fileType: mime,
          file: audioBlob,
          blob: audioBlob
        });
      }

      const mediaPayload = {
        transferId,
        fileName,
        fileSize: audioBlob.size,
        fileType: mime,
        duration: durationSec,
        waveform: samples
      };

      const normPeer = normalizeTag(activeChatPeerTag);
      const tempVoiceId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const optVoiceMsg = {
        id: tempVoiceId,
        from: currentState.myTag,
        to: normPeer,
        senderTag: currentState.myTag,
        peerTag: normPeer,
        direction: 'outgoing',
        type: 'voice',
        msgType: 'voice',
        text: '',
        media: mediaPayload,
        timestamp: Date.now(),
        status: 'sending'
      };

      if (!currentState.chatMessages) currentState.chatMessages = {};
      if (!Array.isArray(currentState.chatMessages[normPeer])) {
        currentState.chatMessages[normPeer] = [];
      }
      currentState.chatMessages[normPeer].push(optVoiceMsg);
      renderActiveChatConversation();

      chrome.runtime.sendMessage({
        action: 'SEND_CHAT_MESSAGE',
        targetTag: normPeer,
        peerTag: normPeer,
        text: '',
        type: 'voice',
        media: mediaPayload,
        message: {
          id: tempVoiceId,
          text: '',
          msgType: 'voice',
          transferId,
          voiceDuration: durationSec,
          waveform: samples,
          fileMeta: {
            name: fileName,
            size: audioBlob.size,
            type: mime
          }
        }
      }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderChatView();
        }
      });
    } catch (err) {
      console.error('Erro ao enviar mensagem de voz:', err);
      showToast('Erro ao processar mensagem de voz.', 'error');
    } finally {
      cleanupVoiceRecorder();
    }
  };

  recorder.mediaRecorder.stop();
}

if (btnChatRecordVoice) {
  btnChatRecordVoice.addEventListener('click', startVoiceRecording);
}
if (btnChatCancelVoice) {
  btnChatCancelVoice.addEventListener('click', cancelVoiceRecording);
}
if (btnChatSendVoice) {
  btnChatSendVoice.addEventListener('click', stopAndSendVoiceRecording);
}

// Envio de Mensagem de Texto e Anexos
async function sendChatMessage() {
  if (!activeChatPeerTag) return;
  const normPeer = normalizeTag(activeChatPeerTag);
  const text = (chatTextInput?.value || '').trim();
  const attachments = [...chatStagedAttachments];

  if (!text && attachments.length === 0) return;

  // Enviar texto se houver
  if (text) {
    if (chatTextInput) chatTextInput.value = '';
    sendTypingStatus(false);

    const tempId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optMsg = {
      id: tempId,
      from: currentState.myTag,
      to: normPeer,
      senderTag: currentState.myTag,
      peerTag: normPeer,
      direction: 'outgoing',
      type: 'text',
      msgType: 'text',
      text,
      timestamp: Date.now(),
      status: 'sending'
    };

    if (!currentState.chatMessages) currentState.chatMessages = {};
    if (!Array.isArray(currentState.chatMessages[normPeer])) {
      currentState.chatMessages[normPeer] = [];
    }
    currentState.chatMessages[normPeer].push(optMsg);
    renderActiveChatConversation();

    chrome.runtime.sendMessage({
      action: 'SEND_CHAT_MESSAGE',
      targetTag: normPeer,
      peerTag: normPeer,
      text,
      type: 'text',
      message: {
        id: tempId,
        text,
        msgType: 'text'
      }
    }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderChatView();
      } else if (res && res.message) {
        const list = currentState.chatMessages[normPeer];
        const idx = list ? list.findIndex((m) => m.id === tempId) : -1;
        if (idx !== -1) {
          list[idx] = res.message;
          renderActiveChatConversation();
        }
      }
    });
  }

  // Enviar anexos se houver
  if (attachments.length > 0) {
    clearAllChatAttachments();
    for (const att of attachments) {
      const transferId = `chatmedia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeSessionFiles.set(transferId, att.fileObj);
      saveStagedFile(transferId, att.fileObj);

      if (fileBridgeChannel) {
        fileBridgeChannel.postMessage({
          type: 'STAGE_FILE_MEMORY',
          action: 'STAGE_FILE_MEMORY',
          transferId,
          fileName: att.name,
          fileSize: att.size,
          fileType: att.fileObj.type,
          file: att.fileObj,
          blob: att.fileObj
        });
      }

      const mediaPayload = {
        transferId,
        fileName: att.name,
        fileSize: att.size,
        fileType: att.fileObj.type
      };

      const tempId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const optMsg = {
        id: tempId,
        from: currentState.myTag,
        to: normPeer,
        senderTag: currentState.myTag,
        peerTag: normPeer,
        direction: 'outgoing',
        type: att.type,
        msgType: att.type,
        text: '',
        media: mediaPayload,
        timestamp: Date.now(),
        status: 'sending'
      };

      if (!currentState.chatMessages) currentState.chatMessages = {};
      if (!Array.isArray(currentState.chatMessages[normPeer])) {
        currentState.chatMessages[normPeer] = [];
      }
      currentState.chatMessages[normPeer].push(optMsg);
      renderActiveChatConversation();

      chrome.runtime.sendMessage({
        action: 'SEND_CHAT_MESSAGE',
        targetTag: normPeer,
        peerTag: normPeer,
        text: '',
        type: att.type,
        media: mediaPayload,
        message: {
          id: tempId,
          text: '',
          msgType: att.type,
          transferId,
          fileMeta: {
            name: att.name,
            size: att.size,
            type: att.fileObj.type
          }
        }
      }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderChatView();
        }
      });
    }
  }
}

if (btnChatSend) {
  btnChatSend.addEventListener('click', sendChatMessage);
}

if (chatTextInput) {
  chatTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatTextInput.addEventListener('input', () => {
    sendTypingStatus('typing');
  });
}

function sendTypingStatus(type) {
  if (!activeChatPeerTag) return;
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);

  if (type) {
    chrome.runtime.sendMessage({
      action: 'SEND_CHAT_TYPING',
      peerTag: activeChatPeerTag,
      isTyping: true,
      typingType: type === 'recording' ? 'recording' : 'typing'
    });

    typingDebounceTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        action: 'SEND_CHAT_TYPING',
        peerTag: activeChatPeerTag,
        isTyping: false
      });
    }, 2500);
  } else {
    chrome.runtime.sendMessage({
      action: 'SEND_CHAT_TYPING',
      peerTag: activeChatPeerTag,
      isTyping: false
    });
  }
}

// Reações em mensagens
function sendChatReaction(messageId, emoji) {
  if (!activeChatPeerTag || !messageId || !emoji) return;
  chrome.runtime.sendMessage({
    action: 'SEND_CHAT_REACTION',
    peerTag: activeChatPeerTag,
    messageId,
    emoji
  }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderChatView();
    }
  });
}

// Seletor de Emoticons Categorizado
function renderEmojiPicker(category = 'recent') {
  if (!chatEmojiGrid) return;
  currentEmojiCategory = category;
  chatEmojiGrid.innerHTML = '';

  const emojis = EMOJIS_BY_CATEGORY[category] || EMOJIS_BY_CATEGORY.recent;

  emojis.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-7 h-7 rounded hover:bg-slate-800 text-base flex items-center justify-center cursor-pointer transition-colors';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      if (chatTextInput) {
        chatTextInput.value += emoji;
        chatTextInput.focus();
      }
    });
    chatEmojiGrid.appendChild(btn);
  });

  if (chatEmojiTabs) {
    const tabBtns = chatEmojiTabs.querySelectorAll('.emoji-cat-btn');
    tabBtns.forEach((tab) => {
      if (tab.dataset.emojiCat === category) {
        tab.className = 'emoji-cat-btn px-1.5 py-0.5 rounded text-xs bg-slate-800 text-white cursor-pointer';
      } else {
        tab.className = 'emoji-cat-btn px-1.5 py-0.5 rounded text-xs hover:bg-slate-800/60 cursor-pointer text-slate-400';
      }
    });
  }
}

if (btnChatEmoji) {
  btnChatEmoji.addEventListener('click', () => {
    if (!chatEmojiPicker) return;
    const isHidden = chatEmojiPicker.classList.contains('hidden');
    if (isHidden) {
      renderEmojiPicker(currentEmojiCategory);
      chatEmojiPicker.classList.remove('hidden');
    } else {
      chatEmojiPicker.classList.add('hidden');
    }
  });
}

if (btnCloseEmojiPicker) {
  btnCloseEmojiPicker.addEventListener('click', () => {
    if (chatEmojiPicker) chatEmojiPicker.classList.add('hidden');
  });
}

if (chatEmojiTabs) {
  chatEmojiTabs.addEventListener('click', (e) => {
    const target = e.target.closest('.emoji-cat-btn');
    if (target && target.dataset.emojiCat) {
      renderEmojiPicker(target.dataset.emojiCat);
    }
  });
}

// Modo de Seleção Múltipla & Encaminhamento
function enterChatSelectionMode() {
  chatSelectionMode = true;
  chatSelectedMsgIds.clear();
  renderActiveChatConversation();
}

function exitChatSelectionMode() {
  chatSelectionMode = false;
  chatSelectedMsgIds.clear();
  renderActiveChatConversation();
}

function toggleSelectMessage(msgId) {
  if (chatSelectedMsgIds.has(msgId)) {
    chatSelectedMsgIds.delete(msgId);
  } else {
    chatSelectedMsgIds.add(msgId);
  }
  if (chatSelectedCount) {
    chatSelectedCount.textContent = `${chatSelectedMsgIds.size} selecionada(s)`;
  }
  renderActiveChatConversation();
}

if (btnChatToggleSelect) {
  btnChatToggleSelect.addEventListener('click', () => {
    if (chatSelectionMode) {
      exitChatSelectionMode();
    } else {
      enterChatSelectionMode();
    }
  });
}

if (btnChatCancelSelect) {
  btnChatCancelSelect.addEventListener('click', exitChatSelectionMode);
}

if (btnChatSelectAll) {
  btnChatSelectAll.addEventListener('click', () => {
    const messages = (currentState.chatMessages && currentState.chatMessages[activeChatPeerTag]) || [];
    if (chatSelectedMsgIds.size === messages.length) {
      chatSelectedMsgIds.clear();
    } else {
      messages.forEach((m) => chatSelectedMsgIds.add(m.id));
    }
    renderActiveChatConversation();
  });
}

if (btnChatForwardSelected) {
  btnChatForwardSelected.addEventListener('click', () => {
    if (chatSelectedMsgIds.size === 0) {
      showToast('Selecione pelo menos uma mensagem para encaminhar.', 'warning');
      return;
    }
    openForwardModal(Array.from(chatSelectedMsgIds));
  });
}

if (btnChatDeleteSelected) {
  btnChatDeleteSelected.addEventListener('click', () => {
    if (chatSelectedMsgIds.size === 0) return;
    deleteSelectedChatMessages();
  });
}

function deleteSingleChatMessage(msgId) {
  if (!activeChatPeerTag || !msgId) return;
  chrome.runtime.sendMessage({
    action: 'DELETE_CHAT_MESSAGES',
    peerTag: activeChatPeerTag,
    messageIds: [msgId]
  }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderChatView();
    }
  });
}

function deleteSelectedChatMessages() {
  if (!activeChatPeerTag || chatSelectedMsgIds.size === 0) return;
  chrome.runtime.sendMessage({
    action: 'DELETE_CHAT_MESSAGES',
    peerTag: activeChatPeerTag,
    messageIds: Array.from(chatSelectedMsgIds)
  }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      exitChatSelectionMode();
    }
  });
}

// Limpar conversa inteira
if (btnChatClear) {
  btnChatClear.addEventListener('click', () => {
    if (!activeChatPeerTag) return;
    const confirmClear = confirm(`Deseja limpar todo o histórico de conversa com ${activeChatPeerTag}?`);
    if (confirmClear) {
      chrome.runtime.sendMessage({
        action: 'CLEAR_CHAT_CONVERSATION',
        peerTag: activeChatPeerTag
      }, (res) => {
        if (res && res.state) {
          currentState = res.state;
          renderChatView();
        }
      });
    }
  });
}

// Modal de Encaminhamento P2P
function openForwardModal(messageIds) {
  chatForwardSelectedMsgIds = Array.isArray(messageIds) ? messageIds : [messageIds];
  if (chatForwardSelectedMsgIds.length === 0) return;

  chatForwardSelectedPeerTags.clear();
  if (chatForwardSummary) {
    chatForwardSummary.textContent = `${chatForwardSelectedMsgIds.length} mensagem(ns) selecionada(s)`;
  }
  if (chatForwardNote) chatForwardNote.value = '';
  if (chatForwardSearch) chatForwardSearch.value = '';

  renderForwardPeersList();

  if (chatForwardModal) chatForwardModal.classList.remove('hidden');
}

function renderForwardPeersList() {
  if (!chatForwardPeersList) return;
  chatForwardPeersList.innerHTML = '';

  const filter = (chatForwardSearch?.value || '').trim().toLowerCase().replace(/^@/, '');
  const peers = Object.values(currentState.peerRegistry || {});
  const now = Date.now();

  const allTags = new Set();
  peers.forEach((p) => {
    if (p.tag && p.tag !== currentState.myTag) allTags.add(normalizeTag(p.tag));
  });
  Object.keys(currentState.chatMessages || {}).forEach((t) => {
    if (t && t !== currentState.myTag) allTags.add(normalizeTag(t));
  });

  const sortedTags = Array.from(allTags).filter((tag) => {
    if (!filter) return true;
    return tag.toLowerCase().includes(filter);
  }).sort();

  if (sortedTags.length === 0) {
    chatForwardPeersList.innerHTML = `
      <div class="text-center py-6 text-slate-500 text-xs italic">
        Nenhum nó encontrado na rede. Digite o @usuario acima para incluir.
      </div>
    `;
    updateForwardTargetCount();
    return;
  }

  sortedTags.forEach((peerTag) => {
    const peerData = currentState.peerRegistry ? currentState.peerRegistry[peerTag] : null;
    const isOnline = peerData && (peerData.status === 'online' || now - (peerData.lastSeen || 0) < 45000);
    const isChecked = chatForwardSelectedPeerTags.has(peerTag);

    const itemEl = document.createElement('label');
    itemEl.className = 'flex items-center justify-between p-2 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 cursor-pointer transition-colors';
    itemEl.innerHTML = `
      <div class="flex items-center gap-2 min-w-0">
        <input
          type="checkbox"
          class="forward-peer-checkbox w-4 h-4 rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-emerald-500/50 cursor-pointer"
          data-peer-tag="${escapeHtml(peerTag)}"
          ${isChecked ? 'checked' : ''}
        />
        <div class="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold font-mono text-emerald-400 shrink-0">
          ${escapeHtml(peerTag.charAt(1).toUpperCase() || '@')}
        </div>
        <div class="flex flex-col min-w-0">
          <span class="text-xs font-bold font-mono text-slate-200 truncate">${escapeHtml(peerTag)}</span>
          <span class="text-[9px] ${isOnline ? 'text-emerald-400' : 'text-slate-500'}">
            ${isOnline ? '● Online na malha P2P' : '○ Offline (Fila DTN Store & Forward)'}
          </span>
        </div>
      </div>
      <span class="text-[9px] font-mono text-slate-500 shrink-0">P2P</span>
    `;

    const checkbox = itemEl.querySelector('.forward-peer-checkbox');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        chatForwardSelectedPeerTags.add(peerTag);
      } else {
        chatForwardSelectedPeerTags.delete(peerTag);
      }
      updateForwardTargetCount();
    });

    chatForwardPeersList.appendChild(itemEl);
  });

  updateForwardTargetCount();
}

function updateForwardTargetCount() {
  if (chatForwardTargetCount) {
    chatForwardTargetCount.textContent = `${chatForwardSelectedPeerTags.size} destinatário(s) selecionado(s)`;
  }
}

if (chatForwardSearch) {
  chatForwardSearch.addEventListener('input', renderForwardPeersList);
}

if (btnChatForwardAddTag && chatForwardSearch) {
  btnChatForwardAddTag.addEventListener('click', () => {
    const raw = chatForwardSearch.value.trim();
    if (!raw) return;
    const tag = normalizeTag(raw);
    chatForwardSelectedPeerTags.add(tag);
    chatForwardSearch.value = '';
    renderForwardPeersList();
  });
}

if (btnChatForwardClose) {
  btnChatForwardClose.addEventListener('click', () => {
    if (chatForwardModal) chatForwardModal.classList.add('hidden');
  });
}
if (btnChatForwardCancel) {
  btnChatForwardCancel.addEventListener('click', () => {
    if (chatForwardModal) chatForwardModal.classList.add('hidden');
  });
}

if (btnChatForwardConfirm) {
  btnChatForwardConfirm.addEventListener('click', executeForwardMessages);
}

async function executeForwardMessages() {
  if (chatForwardSelectedPeerTags.size === 0 || chatForwardSelectedMsgIds.length === 0) {
    showToast('Selecione pelo menos um @usuario de destino para encaminhar.', 'warning');
    return;
  }

  const allMessagesMap = new Map();
  Object.values(currentState.chatMessages || {}).forEach((list) => {
    if (Array.isArray(list)) {
      list.forEach((m) => allMessagesMap.set(m.id, m));
    }
  });

  const msgsToForward = chatForwardSelectedMsgIds
    .map((id) => allMessagesMap.get(id))
    .filter(Boolean);

  if (msgsToForward.length === 0) {
    showToast('Nenhuma mensagem encontrada para encaminhar.', 'error');
    return;
  }

  const note = (chatForwardNote?.value || '').trim();
  const targetPeers = Array.from(chatForwardSelectedPeerTags);

  for (const targetPeer of targetPeers) {
    if (note) {
      chrome.runtime.sendMessage({
        action: 'SEND_CHAT_MESSAGE',
        peerTag: targetPeer,
        text: `↪ [Comentário de Encaminhamento]: ${note}`,
        type: 'text'
      });
    }

    for (const msg of msgsToForward) {
      const msgType = msg.type || msg.msgType || 'text';
      if (msgType === 'text') {
        chrome.runtime.sendMessage({
          action: 'SEND_CHAT_MESSAGE',
          targetTag: targetPeer,
          peerTag: targetPeer,
          text: msg.text,
          type: 'text',
          isForwarded: true,
          message: {
            text: msg.text,
            msgType: 'text',
            forwarded: true
          }
        });
      } else if (msg.media && msg.media.transferId) {
        const originalBlob = activeSessionFiles.get(msg.media.transferId);
        const newTransferId = `chatmedia-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (originalBlob) {
          activeSessionFiles.set(newTransferId, originalBlob);
          saveStagedFile(newTransferId, originalBlob);
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({
              type: 'STAGE_FILE_MEMORY',
              action: 'STAGE_FILE_MEMORY',
              transferId: newTransferId,
              fileName: msg.media.fileName,
              fileSize: originalBlob.size,
              fileType: msg.media.fileType || originalBlob.type,
              file: originalBlob,
              blob: originalBlob
            });
          }
        }

        const newMedia = {
          ...msg.media,
          transferId: newTransferId
        };

        chrome.runtime.sendMessage({
          action: 'SEND_CHAT_MESSAGE',
          targetTag: targetPeer,
          peerTag: targetPeer,
          text: msg.text || '',
          type: msgType,
          media: newMedia,
          isForwarded: true,
          message: {
            text: msg.text || '',
            msgType,
            transferId: newTransferId,
            forwarded: true,
            fileMeta: {
              name: msg.media.fileName,
              size: msg.media.fileSize,
              type: msg.media.fileType
            }
          }
        });
      }
    }
  }

  if (chatForwardModal) chatForwardModal.classList.add('hidden');
  exitChatSelectionMode();
  showToast(`Mensagem(ns) encaminhada(s) com sucesso para ${targetPeers.length} nó(s) da rede P2P!`, 'success');
}

// Modal Lightbox para Imagens e Vídeos
function openMediaLightbox(msgId) {
  let foundMsg = null;
  Object.values(currentState.chatMessages || {}).forEach((list) => {
    if (Array.isArray(list)) {
      const m = list.find((item) => item.id === msgId);
      if (m) foundMsg = m;
    }
  });

  if (!foundMsg || !foundMsg.media) return;

  activeLightboxItem = foundMsg;
  const media = foundMsg.media;
  const blob = activeSessionFiles.get(media.transferId);
  const blobUrl = blob ? URL.createObjectURL(blob) : null;

  if (lightboxMediaTitle) lightboxMediaTitle.textContent = media.fileName || 'Mídia do Chat';
  if (lightboxMediaMeta) {
    const timeStr = formatChatTime(foundMsg.timestamp);
    lightboxMediaMeta.textContent = `${foundMsg.senderTag} • ${timeStr} • ${formatBytes(media.fileSize || 0)}`;
  }

  if (lightboxMediaStage) {
    lightboxMediaStage.innerHTML = '';
    if (foundMsg.type === 'image' && blobUrl) {
      const img = document.createElement('img');
      img.src = blobUrl;
      img.className = 'max-w-full max-h-[75vh] object-contain rounded-xl shadow-2xl';
      lightboxMediaStage.appendChild(img);
    } else if (foundMsg.type === 'video' && blobUrl) {
      const video = document.createElement('video');
      video.src = blobUrl;
      video.controls = true;
      video.autoplay = true;
      video.className = 'max-w-full max-h-[75vh] rounded-xl shadow-2xl';
      lightboxMediaStage.appendChild(video);
    } else {
      lightboxMediaStage.innerHTML = `
        <div class="text-slate-400 text-xs italic">
          Mídia sendo transferida ou não disponível na memória local.
        </div>
      `;
    }
  }

  if (chatMediaLightbox) chatMediaLightbox.classList.remove('hidden');
}

function closeMediaLightbox() {
  if (lightboxMediaStage) {
    const video = lightboxMediaStage.querySelector('video');
    if (video) video.pause();
    lightboxMediaStage.innerHTML = '';
  }
  activeLightboxItem = null;
  if (chatMediaLightbox) chatMediaLightbox.classList.add('hidden');
}

if (btnLightboxClose) {
  btnLightboxClose.addEventListener('click', closeMediaLightbox);
}

if (btnLightboxDownload) {
  btnLightboxDownload.addEventListener('click', () => {
    if (activeLightboxItem && activeLightboxItem.media) {
      downloadChatMedia(activeLightboxItem.media.transferId, activeLightboxItem.media.fileName);
    }
  });
}

if (btnLightboxForward) {
  btnLightboxForward.addEventListener('click', () => {
    if (activeLightboxItem) {
      const msgId = activeLightboxItem.id;
      closeMediaLightbox();
      openForwardModal([msgId]);
    }
  });
}

// Escuta atualizações de estado do background
chrome.runtime.onMessage.addListener((msg) => {
  if ((msg.action === 'STATE_UPDATED' || msg.type === 'STATE_UPDATED') && msg.state) {
    currentState = msg.state;
    renderAll();

    if (currentMainTab === 'chat' && activeChatPeerTag && document.visibilityState !== 'hidden') {
      const normTag = normalizeTag(activeChatPeerTag);
      const unreadCount = Number(currentState.chatUnreadCounts?.[normTag]) || 0;
      const thread = currentState.chatMessages?.[normTag] || [];
      const hasUnreadIncoming = unreadCount > 0 || thread.some(m => m.direction === 'incoming' && m.status !== 'READ');
      if (hasUnreadIncoming) {
        chrome.runtime.sendMessage({ action: 'MARK_CHAT_READ', peerTag: normTag });
      }
    }
  } else if (msg.type === 'USER_REGISTRATION_CONFLICT') {
    showToast(msg.error || `O usuário ${msg.tag} já existe na rede descentralizada!`, 'error');
    if (myTagInput) myTagInput.focus();
  } else if (msg.type === 'CHAT_MEDIA_READY' || msg.type === 'CHAT_MESSAGE_DELIVERED') {
    if (currentMainTab === 'chat') {
      renderChatView();
    }
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

      // Verifica parâmetro de URL ?chat=@usuario para abrir direto a conversa
      const urlParams = new URLSearchParams(window.location.search);
      const targetChat = urlParams.get('chat');
      if (targetChat) {
        switchMainTab('chat');
        openChatConversation(targetChat);
      }
    }
  });
});

