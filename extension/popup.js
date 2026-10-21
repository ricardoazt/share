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

const myTagInput = document.getElementById('my-tag-input');
const btnSaveTag = document.getElementById('btn-save-tag');
const targetContainer = document.getElementById('target-container');
const targetTagInput = document.getElementById('target-tag-input');
const rosterCount = document.getElementById('roster-count');
const peersList = document.getElementById('peers-list');

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

const tabActiveTransfers = document.getElementById('tab-active-transfers');
const tabHistoryTransfers = document.getElementById('tab-history-transfers');
const countActive = document.getElementById('count-active');
const countHistory = document.getElementById('count-history');
const btnClearCompleted = document.getElementById('btn-clear-completed');

const toastAlert = document.getElementById('toast-alert');
const toastMessage = document.getElementById('toast-message');
const toastClose = document.getElementById('toast-close');

const transfersList = document.getElementById('transfers-list');
const emptyState = document.getElementById('empty-state');

const footerAutoOpen = document.getElementById('footer-auto-open');
const onlineCounter = document.getElementById('online-counter');

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
const modalCompressExtBadge = document.getElementById('modal-compress-ext-badge');

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
  tunnelModalOpen: false
};

let stagedTunnelFiles = []; // Array de { fileId, name, size, type, fileObj }
let currentModalMode = 'tunnel'; // 'tunnel' | 'p2p'
let currentTransfersTab = 'active'; // 'active' | 'history'
const expandedTransferIds = new Set();

function showToast(msg) {
  if (!toastAlert || !toastMessage) return;
  toastMessage.textContent = msg;
  toastAlert.classList.remove('hidden');
  setTimeout(() => {
    toastAlert.classList.add('hidden');
  }, 4000);
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

  if (footerAutoOpen) {
    footerAutoOpen.textContent = currentState.autoOpenOnReceive ? 'ON' : 'OFF';
    footerAutoOpen.className = currentState.autoOpenOnReceive ? 'text-emerald-400' : 'text-slate-500';
  }
}

function renderPeerDirectory() {
  const peers = Object.values(currentState.peerRegistry || {});
  const now = Date.now();
  const onlinePeers = peers.filter(
    (p) => p.tag && p.tag !== currentState.myTag && now - (p.lastSeen || 0) < 60000
  );

  rosterCount.textContent = `${onlinePeers.length} na lista`;
  onlineCounter.textContent = `${onlinePeers.length} online`;

  peersList.innerHTML = '';
  if (onlinePeers.length === 0) {
    const span = document.createElement('span');
    span.className = 'text-[10px] text-slate-500 italic';
    span.textContent = 'Nenhum outro @usuario ativo no momento.';
    peersList.appendChild(span);
    return;
  }

  const currentSelected = normalizeTag(targetTagInput.value);

  onlinePeers.forEach((peer) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelected = peer.tag === currentSelected;

    btn.className = `px-2 py-0.5 rounded-full text-[10px] font-mono font-medium transition-all cursor-pointer shrink-0 ${
      isSelected
        ? 'bg-emerald-500 text-slate-950 font-bold shadow-md'
        : 'bg-slate-800/90 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30'
    }`;
    btn.textContent = peer.tag;
    btn.title = `Clique para enviar arquivos para ${peer.tag}`;

    btn.addEventListener('click', () => {
      targetTagInput.value = peer.tag;
      chrome.storage.local.set({ lastTargetTag: peer.tag });
      renderPeerDirectory();
    });

    peersList.appendChild(btn);
  });
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

    let statusText = '';
    if (isExpired) statusText = 'Expirado';
    else if (isCancelled) statusText = 'Cancelado';
    else if (isError) statusText = t.error || 'Erro';
    else if (isPaused) statusText = 'Pausado';
    else if (isWaitingAccept) statusText = 'Aguardando aceite';
    else if (isTunnel) statusText = isDone ? 'Link P2P Pronto' : 'Transmitindo...';
    else if (isDone) statusText = 'Concluído';
    else statusText = 'Transferindo...';

    card.innerHTML = `
      <div class="flex items-center justify-between gap-1.5">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${badgeColor} shrink-0">
            ${badgeLabel}
          </span>
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
    tunnelConfigModal.classList.remove('hidden');
  }
  renderModalFiles();
}

function renderAll() {
  renderConnectionStatus();
  renderSettingsSwitches();
  renderPeerDirectory();
  renderReceiveButton();
  renderTransfers();
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

function saveMyTag() {
  const newTag = normalizeTag(myTagInput.value);
  if (!newTag || newTag.length < 3) {
    showToast('O ID deve ter pelo menos 3 caracteres.');
    return;
  }
  chrome.storage.local.set({ myTag: newTag }, () => {
    chrome.runtime.sendMessage({ action: 'UPDATE_MY_TAG', tag: newTag }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        myTagInput.value = currentState.myTag;
        showToast(`Anunciando ${currentState.myTag} na malha P2P!`);
        renderPeerDirectory();
      }
    });
  });
}

if (btnSaveTag) {
  btnSaveTag.addEventListener('click', saveMyTag);
}

if (myTagInput) {
  myTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveMyTag();
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
  currentModalMode = 'tunnel';
  if (modalHeaderTitle) modalHeaderTitle.textContent = 'Configurar Link Público (WebRTC)';
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-orange-400';
  if (modalTunnelOptions) modalTunnelOptions.classList.remove('hidden');
  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500 text-white text-xs font-bold shadow-md border border-orange-400/30 transition-all cursor-pointer';
    btnModalConfirm.textContent = 'Confirmar & Gerar Link';
  }
  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({ action: 'SET_TUNNEL_MODAL_OPEN', open: true });
  renderModalFiles();
}

function openModalForP2P(targetTag) {
  currentModalMode = 'p2p';
  if (modalHeaderTitle) modalHeaderTitle.textContent = `Configurar Envio P2P para ${targetTag}`;
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
  if (modalTunnelOptions) modalTunnelOptions.classList.add('hidden');
  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white text-xs font-bold shadow-md border border-emerald-400/30 transition-all cursor-pointer';
    btnModalConfirm.textContent = 'Confirmar & Enviar P2P';
  }
  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({ action: 'SET_TUNNEL_MODAL_OPEN', open: true });
  renderModalFiles();
}

if (btnSend) {
  btnSend.addEventListener('click', () => {
    const targetTag = normalizeTag(targetTagInput.value);
    if (!targetTag || targetTag.length < 3) {
      showToast('Digite ou selecione um @destinatario na lista P2P.');
      targetContainer.classList.add('ring-2', 'ring-rose-500');
      targetTagInput.focus();
      setTimeout(() => targetContainer.classList.remove('ring-2', 'ring-rose-500'), 1500);
      return;
    }
    if (targetTag === currentState.myTag) {
      showToast('Escolha um @destinatario diferente do seu próprio ID.');
      return;
    }
    targetTagInput.value = targetTag;
    chrome.storage.local.set({ lastTargetTag: targetTag });
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
  for (const f of filesArray) {
    if (!f) continue;
    const relPath = f.relativePath || f.webkitRelativePath || f.name;
    const normalizedName = relPath.replace(/^\/+/, '');
    const fileId = `f-${stagedTunnelFiles.length}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    
    let fileObj = f;
    if (normalizedName !== f.name) {
      try {
        fileObj = new File([f], normalizedName, { type: f.type, lastModified: f.lastModified });
      } catch {
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
}

if (btnModalAddMore && modalFileInput) {
  btnModalAddMore.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalFileInput.click();
  });
}

if (btnModalAddFolder && modalFolderInput) {
  btnModalAddFolder.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    modalFolderInput.click();
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
    } finally {
      modalFolderInput.value = '';
    }
  });
}

// Suporte a Leitura Recursiva de Diretórios via Drag & Drop
async function getFilesFromDataTransfer(items, dataTransferFiles) {
  const result = [];
  if (!items || items.length === 0) {
    return Array.from(dataTransferFiles || []);
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
        openModalForTunnel();
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
      showToast('Adicione pelo menos um arquivo ao pack.');
      return;
    }

    const isCompressEnabled = Boolean(modalCompressToggle && modalCompressToggle.checked);
    const compressLevel = modalCompressLevel ? Number(modalCompressLevel.value) : 6;
    const customCompressName = modalCompressName ? modalCompressName.value.trim() : '';

    btnModalConfirm.disabled = true;
    const originalConfirmText = btnModalConfirm.textContent;

    try {
      let finalFilesMeta = [];
      let finalPackName = '';
      let finalTotalSize = 0;

      const shareId = `ps-${Array.from(crypto.getRandomValues(new Uint8Array(4)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      if (isCompressEnabled) {
        btnModalConfirm.textContent = `Compactando pack em .ZIP (Nível ${compressLevel})...`;

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

        // Usa zipSync puro sem Web Workers bloqueados por CSP na extensão
        const zippedU8 = fflate.zipSync(zipData, { level: compressLevel });

        const rawBaseName =
          customCompressName ||
          (stagedTunnelFiles.length === 1
            ? stagedTunnelFiles[0].name.replace(/\.[^/.]+$/, '')
            : 'Pack_Compartilhado');

        const zipFileName = rawBaseName.replace(/\.zip$/i, '') + '.zip';
        const zipFile = new File([zippedU8], zipFileName, { type: 'application/zip' });

        // Salva arquivo ZIP no offscreen e IndexedDB
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
        // Sem compactação prévia: salva cada arquivo individualmente
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

      if (currentModalMode === 'tunnel') {
        btnModalConfirm.textContent = 'Gerando link P2P...';
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
      } else if (currentModalMode === 'p2p') {
        const targetTag = normalizeTag(targetTagInput.value);
        if (!targetTag) {
          throw new Error('Destinatário P2P não especificado.');
        }

        btnModalConfirm.textContent = 'Iniciando transferência P2P...';
        for (let i = 0; i < finalFilesMeta.length; i++) {
          const item = finalFilesMeta[i];
          const rawFile = isCompressEnabled ? stagedTunnelFiles[0].fileObj : stagedTunnelFiles[i].fileObj;
          const transferId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          await saveStagedFile(transferId, rawFile);

          chrome.runtime.sendMessage({
            action: 'START_SEND_FILE',
            transferId,
            targetTag,
            fileMeta: {
              name: item.name,
              size: item.size,
              type: item.type || 'application/octet-stream'
            }
          });
        }
        showToast(`Transferência enviada para ${targetTag}!`);
      }

      closeAndResetModal();
    } catch (err) {
      console.error('Erro ao confirmar pack:', err);
      showToast(`Erro: ${err.message}`);
    } finally {
      btnModalConfirm.disabled = false;
      btnModalConfirm.textContent = originalConfirmText;
    }
  });
}

// Abas do Gerenciador de Transferências
if (tabActiveTransfers) {
  tabActiveTransfers.addEventListener('click', () => {
    currentTransfersTab = 'active';
    tabActiveTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer';
    tabHistoryTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
    renderTransfers();
  });
}

if (tabHistoryTransfers) {
  tabHistoryTransfers.addEventListener('click', () => {
    currentTransfersTab = 'history';
    tabHistoryTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer';
    tabActiveTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
    renderTransfers();
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
  if (msg.action === 'STATE_UPDATED' && msg.state) {
    currentState = msg.state;
    renderAll();
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
      if (myTagInput) myTagInput.value = res.myTag;
    }
    if (res.lastTargetTag && targetTagInput) {
      targetTagInput.value = res.lastTargetTag;
    }
  });

  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});
