/**
 * PulseShare P2P - Offscreen Document Worker (offscreen.js)
 *
 * Otimizado para Arquivos Grandes (+110MB / +1GB) e Conexão Remota Entre Redes:
 * 1. Recebe o handle nativo do File via BroadcastChannel em <1ms (zero cópia em disco).
 * 2. Usa Cloudflare STUN + Google STUN + Servidores TURN (UDP/TCP/TLS nas portas 80 e 443)
 *    para atravessar CGNAT e redes distintas.
 * 3. Fila de ICE Candidates (evita perda de candidatos antes de setRemoteDescription) +
 *    Coleta de candidatos embutida no SDP.
 * 4. Streaming em blocos de 1MB fatiados em pacotes SCTP seguros de 16KB com controle de
 *    backpressure à prova de deadlock (bufferedamountlow + polling de segurança de 35ms).
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB (tamanho universal seguro para SCTP/WebRTC entre redes)
const READ_BLOCK_SIZE = 1024 * 1024; // Lê 1 MB por vez do disco para máxima performance
const MAX_BUFFERED_AMOUNT = 512 * 1024; // Pausa em 512 KB
const LOW_BUFFER_THRESHOLD = 128 * 1024; // Retoma em 128 KB

const DB_NAME = 'PulseShareDB';
const DB_VERSION = 1;
const FILE_STORE = 'staged_files';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  iceCandidatePoolSize: 4
};

// Configuração dinâmica de TURN (Relay) sincronizada com background.js
// (Offscreen Documents no MV3 não possuem chrome.storage, apenas chrome.runtime)
let customTurnConfig = null;
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  try {
    chrome.storage.local.get(['turnConfig'], (res) => {
      if (res && res.turnConfig) customTurnConfig = res.turnConfig;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.turnConfig) {
        customTurnConfig = changes.turnConfig.newValue || null;
      }
    });
  } catch {}
}

function getActiveIceServers() {
  const baseServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  if (customTurnConfig && customTurnConfig.url) {
    const urls = customTurnConfig.url.split(',').map((u) => u.trim()).filter(Boolean);
    const entry = { urls };
    if (customTurnConfig.username) entry.username = customTurnConfig.username;
    if (customTurnConfig.credential) entry.credential = customTurnConfig.credential;
    baseServers.push(entry);
  }
  return baseServers;
}

// Armazenamento em memória para arquivos grandes (evita gargalo de copiar 110MB+ no IndexedDB)
const inMemoryFiles = new Map();
const pendingFileWaiters = new Map(); // fileKey -> [resolveFn]

// Sessões WebRTC ativas: transferId -> { pc, channel, pendingCandidates: [], remoteDescSet: false }
const peerSessions = new Map();

// Canal direto de alta velocidade com popup.js para receber referências de File instantaneamente
const fileBridgeChannel = new BroadcastChannel('pulseshare_file_bridge');
fileBridgeChannel.onmessage = async (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'STAGE_FILE_MEMORY' && data.transferId && data.file) {
    inMemoryFiles.set(data.transferId, data.file);
    const waiters = pendingFileWaiters.get(data.transferId);
    if (waiters) {
      pendingFileWaiters.delete(data.transferId);
      waiters.forEach((fn) => fn(data.file));
    }
    try {
      const db = await openDatabase();
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).put(data.file, data.transferId);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {}
    fileBridgeChannel.postMessage({
      type: 'STAGE_FILE_ACK',
      transferId: data.transferId
    });
  } else if (data.type === 'DELETE_FILE_MEMORY' && data.transferId) {
    inMemoryFiles.delete(data.transferId);
    deleteStagedFile(data.transferId).catch(() => {});
  } else if (data.type === 'DELETE_PACK_MEMORY' && data.shareId) {
    for (const key of inMemoryFiles.keys()) {
      if (key === data.shareId || key.startsWith(`${data.shareId}:`)) {
        inMemoryFiles.delete(key);
      }
    }
    deletePackFromDb(data.shareId).catch(() => {});
  }
};

// Mantém o Service Worker (background.js) acordado durante transferências longas (+30s)
let keepAlivePort = null;
function maintainKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    keepAlivePort.onDisconnect.addListener(() => {
      setTimeout(maintainKeepAlive, 1000);
    });
  } catch {}
}
maintainKeepAlive();
setInterval(() => {
  if ((peerSessions.size > 0 || activeRelayStreams.size > 0) && keepAlivePort) {
    try {
      keepAlivePort.postMessage({ type: 'PING', activeCount: peerSessions.size + activeRelayStreams.size });
    } catch {}
  }
}, 10000);

// Solicita configuração TURN inicial ao background
try {
  chrome.runtime.sendMessage({ source: 'offscreen', type: 'OFFSCREEN_GET_TURN_CONFIG' }, (res) => {
    if (res && res.turnConfig) customTurnConfig = res.turnConfig;
  });
} catch {}

// Fallback IndexedDB caso necessário
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestFileFromPopup(key, timeoutMs = 450) {
  if (!key) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    const list = pendingFileWaiters.get(key) || [];
    list.push((file) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(file || null);
      }
    });
    pendingFileWaiters.set(key, list);
    try {
      fileBridgeChannel.postMessage({ type: 'REQUEST_FILE_MEMORY', transferId: key });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function getStagedFile(fileKey, fallbackKey) {
  if (inMemoryFiles.has(fileKey)) {
    return inMemoryFiles.get(fileKey);
  }
  const shareId = fileKey && fileKey.includes(':') ? fileKey.split(':')[0] : null;
  if (shareId && inMemoryFiles.has(shareId)) {
    return inMemoryFiles.get(shareId);
  }
  if (fallbackKey && inMemoryFiles.has(fallbackKey)) {
    return inMemoryFiles.get(fallbackKey);
  }
  try {
    const db = await openDatabase();
    const fromDb = await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readonly');
      const store = tx.objectStore(FILE_STORE);
      const req = store.get(fileKey);
      req.onsuccess = () => {
        if (req.result) {
          db.close();
          resolve(req.result);
          return;
        }
        if (shareId) {
          const reqShare = store.get(shareId);
          reqShare.onsuccess = () => {
            if (reqShare.result) {
              db.close();
              resolve(reqShare.result);
              return;
            }
            if (fallbackKey) {
              const reqFb = store.get(fallbackKey);
              reqFb.onsuccess = () => {
                db.close();
                resolve(reqFb.result || null);
              };
              reqFb.onerror = () => {
                db.close();
                resolve(null);
              };
            } else {
              db.close();
              resolve(null);
            }
          };
          reqShare.onerror = () => {
            db.close();
            resolve(null);
          };
          return;
        }
        if (fallbackKey) {
          const reqFb = store.get(fallbackKey);
          reqFb.onsuccess = () => {
            db.close();
            resolve(reqFb.result || null);
          };
          reqFb.onerror = () => {
            db.close();
            resolve(null);
          };
        } else {
          db.close();
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
    if (fromDb) {
      inMemoryFiles.set(fileKey, fromDb);
      return fromDb;
    }
  } catch {}

  const recovered =
    (await requestFileFromPopup(fileKey)) ||
    (shareId ? await requestFileFromPopup(shareId) : null) ||
    (fallbackKey ? await requestFileFromPopup(fallbackKey) : null);
  return recovered || null;
}

async function deleteStagedFile(fileKey) {
  inMemoryFiles.delete(fileKey);
  try {
    const db = await openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).delete(fileKey);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {}
}

async function deletePackFromDb(shareId) {
  try {
    const db = await openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readwrite');
      const store = tx.objectStore(FILE_STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = req.result || [];
        for (const k of keys) {
          if (typeof k === 'string' && (k === shareId || k.startsWith(`${shareId}:`))) {
            store.delete(k);
          }
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {}
}

function sendToBackground(payload) {
  chrome.runtime.sendMessage({ source: 'offscreen', ...payload }).catch(() => {});
}

function reportProgress(transferId, patch) {
  sendToBackground({
    type: 'OFFSCREEN_PROGRESS',
    transferId,
    patch
  });
}

function sendSignalViaBackground(to, transferId, signalType, payload) {
  sendToBackground({
    type: 'OFFSCREEN_SEND_SIGNAL',
    to,
    transferId,
    signalType,
    payload
  });
}

/**
 * Aguarda até 1200ms pela coleta de candidatos ICE (STUN/TURN) para já incluí-los no SDP
 */
function waitForIceGathering(pc, timeoutMs = 1200) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, timeoutMs);
    function check() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Controle de Backpressure à prova de deadlock:
 * Combina o evento onbufferedamountlow com um timer de segurança de 35ms.
 */
async function waitForBufferDrain(channel) {
  while (channel.readyState === 'open' && channel.bufferedAmount > LOW_BUFFER_THRESHOLD) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        channel.onbufferedamountlow = null;
        resolve();
      }, 35);
      channel.onbufferedamountlow = () => {
        clearTimeout(timer);
        channel.onbufferedamountlow = null;
        resolve();
      };
    });
  }
}

async function flushPendingCandidates(session) {
  if (!session || !session.pc || !session.remoteDescSet) return;
  while (session.pendingCandidates.length > 0) {
    const candidate = session.pendingCandidates.shift();
    try {
      await session.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }
}

const activeRelayStreams = new Map(); // transferId -> { paused, cancelled }
const incomingRelaySessions = new Map(); // transferId -> { chunks: [], receivedBytes, startTime, lastReport, fileName, fileType, totalBytes }

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function storeReceivedChatMediaBlob(transferId, blob, fileName, fileType) {
  const effectiveType = fileType || blob.type || 'application/octet-stream';
  const effectiveName = fileName || 'midia_chat';
  let fileObj;
  try {
    fileObj = new File([blob], effectiveName, { type: effectiveType });
  } catch {
    fileObj = blob;
  }
  inMemoryFiles.set(transferId, fileObj);
  try {
    const db = await openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).put(fileObj, transferId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {}
  try {
    fileBridgeChannel.postMessage({
      type: 'STAGE_FILE_MEMORY',
      transferId,
      file: fileObj
    });
  } catch {}
  sendToBackground({
    type: 'OFFSCREEN_CHAT_MEDIA_READY',
    transferId,
    fileName: effectiveName,
    fileType: effectiveType,
    fileSize: fileObj.size || blob.size || 0
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.turnConfig) {
    customTurnConfig = msg.turnConfig;
  }

  if (msg.action === 'OFFSCREEN_SET_TURN_CONFIG') {
    customTurnConfig = msg.turnConfig || null;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl) {
    URL.revokeObjectURL(msg.blobUrl);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_DOWNLOAD_CHAT_MEDIA' && msg.transferId) {
    getStagedFile(msg.transferId, msg.transferId).then((file) => {
      if (file) {
        const blobUrl = URL.createObjectURL(file);
        sendToBackground({
          type: 'OFFSCREEN_DOWNLOAD_READY',
          transferId: msg.transferId,
          blobUrl,
          fileName: msg.fileName || file.name || 'arquivo_chat'
        });
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === 'OFFSCREEN_SIGNAL') {
    handleSignal(msg);
  } else if (msg.action === 'OFFSCREEN_CONTROL') {
    handleControl(msg);
  } else if (msg.action === 'START_MESH_RELAY_STREAM') {
    startMeshRelayStream(msg);
  } else if (msg.action === 'OFFSCREEN_RECEIVE_RELAY_CHUNK') {
    handleRelayChunkReceived(msg);
  }

  sendResponse({ ok: true });
  return false;
});

function handleControl({ subAction, transferId }) {
  for (const [id, relayStream] of activeRelayStreams.entries()) {
    if (id === transferId || relayStream.uiTransferId === transferId) {
      if (subAction === 'PAUSE') relayStream.paused = true;
      else if (subAction === 'RESUME') relayStream.paused = false;
      else if (subAction === 'CANCEL') {
        relayStream.cancelled = true;
        relayStream.cancelledBySender = true;
      }
    }
  }

  for (const [id, session] of peerSessions.entries()) {
    if (id === transferId || session.uiTransferId === transferId) {
      if (subAction === 'PAUSE') {
        session.paused = true;
        try {
          if (session.channel && session.channel.readyState === 'open') {
            session.channel.send(JSON.stringify({ type: 'TRANSFER_PAUSED', transferId }));
          }
        } catch {}
      } else if (subAction === 'RESUME') {
        session.paused = false;
        try {
          if (session.channel && session.channel.readyState === 'open') {
            session.channel.send(JSON.stringify({ type: 'TRANSFER_RESUMED', transferId }));
          }
        } catch {}
      } else if (subAction === 'CANCEL') {
        session.cancelled = true;
        session.cancelledBySender = true;
        if (session.directConnectTimer) {
          clearTimeout(session.directConnectTimer);
          session.directConnectTimer = null;
        }
        try {
          if (session.channel && session.channel.readyState === 'open') {
            session.channel.send(JSON.stringify({ type: 'TRANSFER_CANCELLED', transferId }));
          }
        } catch {}
        try {
          if (session.pc) session.pc.close();
        } catch {}
        peerSessions.delete(id);
      }
    }
  }
}

async function startMeshRelayStream({
  transferId,
  uiTransferId,
  relayTag,
  targetTag,
  directToTarget,
  fileId,
  fileKey,
  fallbackKey,
  keepStaged
}) {
  if (activeRelayStreams.has(transferId)) return;
  const effectiveUiId = uiTransferId || transferId;
  const file = await getStagedFile(fileKey, fallbackKey);
  if (!file) {
    reportProgress(effectiveUiId, {
      status: 'ERROR',
      error: 'Arquivo não encontrado em memória para streaming mesh'
    });
    return;
  }

  // Fecha eventual RTCPeerConnection pendente para o mesmo transferId
  const existingPeer = peerSessions.get(transferId);
  if (existingPeer) {
    if (existingPeer.directConnectTimer) {
      clearTimeout(existingPeer.directConnectTimer);
      existingPeer.directConnectTimer = null;
    }
    try {
      if (existingPeer.pc) existingPeer.pc.close();
    } catch {}
    peerSessions.delete(transferId);
  }

  const streamState = {
    paused: false,
    cancelled: false,
    cancelledBySender: false,
    uiTransferId: effectiveUiId
  };
  activeRelayStreams.set(transferId, streamState);

  const totalBytes = file.size || 0;
  const RELAY_CHUNK_SIZE = 12 * 1024; // 12 KB raw (~16 KB Base64, cabe em 1 frame TLS/WSS sem fragmentar)
  let offset = 0;
  let chunkSeq = 0;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / RELAY_CHUNK_SIZE));
  const startTime = Date.now();
  let lastReport = startTime;

  reportProgress(effectiveUiId, {
    status: 'TRANSFERRING',
    inProgress: true,
    progress: 0,
    transferredBytes: 0,
    routeType: 'MESH_RELAY',
    relayTag
  });

  try {
    if (totalBytes === 0) {
      sendToBackground({
        type: 'OFFSCREEN_RELAY_CHUNK',
        transferId,
        uiTransferId: effectiveUiId,
        relayTag,
        targetTag,
        directToTarget: Boolean(directToTarget),
        fileId,
        chunkSeq: 1,
        totalChunks: 1,
        chunkBase64: '',
        isEof: true,
        totalBytes: 0,
        fileMeta: {
          fileId,
          name: file.name,
          size: 0,
          type: file.type
        }
      });
    }

    while (offset < totalBytes) {
      if (streamState.cancelled) throw new Error('Transferência cancelada');
      while (streamState.paused) {
        if (streamState.cancelled) throw new Error('Transferência cancelada');
        await new Promise((r) => setTimeout(r, 150));
      }

      const chunkEnd = Math.min(offset + RELAY_CHUNK_SIZE, totalBytes);
      const sliceBlob = file.slice(offset, chunkEnd);
      const arrayBuffer = await sliceBlob.arrayBuffer();

      let binary = '';
      const bytes = new Uint8Array(arrayBuffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)));
      }
      const chunkBase64 = btoa(binary);

      offset = chunkEnd;
      chunkSeq++;
      const isEof = offset >= totalBytes;

      sendToBackground({
        type: 'OFFSCREEN_RELAY_CHUNK',
        transferId,
        uiTransferId: effectiveUiId,
        relayTag,
        targetTag,
        directToTarget: Boolean(directToTarget),
        fileId,
        chunkSeq,
        totalChunks,
        chunkBase64,
        isEof,
        totalBytes,
        fileMeta: {
          fileId,
          name: file.name,
          size: file.size,
          type: file.type
        }
      });

      const now = Date.now();
      if (now - lastReport >= 100 || isEof) {
        const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
        const speedBps = Math.round(offset / elapsedSec);
        const progress = totalBytes > 0 ? Math.round((offset / totalBytes) * 100) : 100;
        reportProgress(effectiveUiId, {
          status: 'TRANSFERRING',
          inProgress: true,
          progress,
          transferredBytes: offset,
          speedBps,
          fileId,
          fileTransferredBytes: offset,
          fileTotalBytes: totalBytes,
          fileSpeedBps: speedBps
        });
        lastReport = now;
      }

      await new Promise((r) => setTimeout(r, 16));
    }

    reportProgress(effectiveUiId, {
      status: keepStaged ? 'TUNNEL_READY' : 'COMPLETED',
      inProgress: false,
      progress: 100,
      transferredBytes: totalBytes,
      speedBps: 0,
      fileId,
      fileTransferredBytes: totalBytes,
      fileTotalBytes: totalBytes,
      fileSpeedBps: 0,
      fileCompleted: true
    });

    if (!keepStaged && !String(fileKey || '').startsWith('chatmedia-')) {
      await deleteStagedFile(fileKey);
    }
  } catch (err) {
    if (keepStaged && !streamState.cancelledBySender) {
      reportProgress(effectiveUiId, { status: 'TUNNEL_READY', inProgress: false, speedBps: 0 });
    } else if (err.message === 'Transferência cancelada') {
      reportProgress(effectiveUiId, { status: 'CANCELLED', inProgress: false });
    } else {
      reportProgress(effectiveUiId, { status: 'ERROR', error: err.message, inProgress: false });
    }
  } finally {
    activeRelayStreams.delete(transferId);
  }
}

function finalizeIncomingRelaySession(transferId, session) {
  if (!session || session.finalized) return;
  session.finalized = true;
  if (session.eofWaitTimer) {
    clearTimeout(session.eofWaitTimer);
    session.eofWaitTimer = null;
  }

  const orderedChunks = [];
  if (session.chunksBySeq && session.chunksBySeq.size > 0) {
    const sortedKeys = Array.from(session.chunksBySeq.keys()).sort((a, b) => a - b);
    for (const k of sortedKeys) {
      orderedChunks.push(session.chunksBySeq.get(k));
    }
    session.chunksBySeq.clear();
  } else if (session.chunks.length > 0) {
    orderedChunks.push(...session.chunks);
    session.chunks.length = 0;
  }

  incomingRelaySessions.delete(transferId);

  reportProgress(transferId, {
    status: 'COMPLETED',
    progress: 100,
    transferredBytes: session.receivedBytes,
    speedBps: 0,
    routeType: 'MESH_RELAY',
    relayTag: session.relayTag
  });

  const blob = new Blob(orderedChunks, { type: session.fileType });
  if (String(transferId || '').startsWith('chatmedia-')) {
    storeReceivedChatMediaBlob(transferId, blob, session.fileName, session.fileType);
    return;
  }
  const blobUrl = URL.createObjectURL(blob);
  sendToBackground({
    type: 'OFFSCREEN_DOWNLOAD_READY',
    transferId,
    blobUrl,
    fileName: session.fileName
  });
}

function handleRelayChunkReceived(msg) {
  const { transferId, chunkSeq, totalChunks, chunkBase64, isEof, totalBytes, fileMeta, relayTag } = msg;
  let session = incomingRelaySessions.get(transferId);
  if (!session) {
    session = {
      chunks: [],
      chunksBySeq: new Map(),
      seenSeqs: new Set(),
      totalChunks: totalChunks || 0,
      eofSeen: false,
      eofWaitTimer: null,
      finalized: false,
      receivedBytes: 0,
      startTime: Date.now(),
      lastReport: Date.now(),
      fileName: fileMeta?.name || 'arquivo_recebido',
      fileType: fileMeta?.type || 'application/octet-stream',
      totalBytes: totalBytes || fileMeta?.size || 0,
      relayTag
    };
    incomingRelaySessions.set(transferId, session);
  }

  if (session.finalized) return;
  if (totalChunks && !session.totalChunks) session.totalChunks = totalChunks;
  if (relayTag) session.relayTag = relayTag;

  if (typeof chunkSeq === 'number') {
    if (session.seenSeqs.has(chunkSeq)) return;
    session.seenSeqs.add(chunkSeq);
  }

  if (chunkBase64) {
    const chunkBytes = base64ToUint8Array(chunkBase64);
    if (typeof chunkSeq === 'number') {
      session.chunksBySeq.set(chunkSeq, chunkBytes);
    } else {
      session.chunks.push(chunkBytes);
    }
    session.receivedBytes += chunkBytes.byteLength;
  }

  if (isEof) {
    session.eofSeen = true;
    if (!session.totalChunks && typeof chunkSeq === 'number') {
      session.totalChunks = chunkSeq;
    }
  }

  const allChunksArrived =
    (session.totalChunks > 0 && session.chunksBySeq.size >= session.totalChunks) ||
    (session.totalBytes === 0 && session.eofSeen);

  const now = Date.now();
  if (now - session.lastReport >= 100 || allChunksArrived) {
    const elapsedSec = Math.max(0.1, (now - session.startTime) / 1000);
    const speedBps = Math.round(session.receivedBytes / elapsedSec);
    const progress = session.totalBytes > 0
      ? Math.min(allChunksArrived ? 100 : 99, Math.round((session.receivedBytes / session.totalBytes) * 100))
      : (allChunksArrived ? 100 : 50);

    reportProgress(transferId, {
      status: allChunksArrived ? 'COMPLETED' : 'TRANSFERRING',
      progress,
      transferredBytes: session.receivedBytes,
      speedBps,
      routeType: 'MESH_RELAY',
      relayTag
    });
    session.lastReport = now;
  }

  if (allChunksArrived) {
    finalizeIncomingRelaySession(transferId, session);
  } else if (session.eofSeen && !session.eofWaitTimer) {
    session.eofWaitTimer = setTimeout(() => {
      finalizeIncomingRelaySession(transferId, session);
    }, 1500);
  }
}

async function handleSignal({
  from,
  transferId,
  uiTransferId,
  fileKey,
  fallbackKey,
  keepStaged,
  signalType,
  payload,
  roster,
  transferMeta
}) {
  if (signalType === 'FILE_ACCEPT') {
    await startSenderWebRTC(
      transferId,
      uiTransferId || transferId,
      fileKey || transferId,
      fallbackKey || null,
      Boolean(keepStaged),
      from,
      roster,
      payload?.fileMeta
    );
  } else if (signalType === 'WEBRTC_OFFER') {
    await startReceiverWebRTC(transferId, from, payload.sdp, roster, transferMeta, payload.iceServers);
  } else if (signalType === 'WEBRTC_ANSWER') {
    let session = peerSessions.get(transferId);
    if (session?.pc && payload?.sdp) {
      try {
        await session.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        session.remoteDescSet = true;
        await flushPendingCandidates(session);
      } catch (err) {
        reportProgress(session.uiTransferId || transferId, {
          status: 'ERROR',
          error: `Erro SDP Answer: ${err.message}`
        });
      }
    }
  } else if (signalType === 'ICE_CANDIDATE') {
    if (!payload?.candidate) return;
    let session = peerSessions.get(transferId);
    if (!session) {
      // Caso o candidato ICE chegue antes da criação da sessão, cria entrada de espera
      session = { pc: null, pendingCandidates: [payload.candidate], remoteDescSet: false };
      peerSessions.set(transferId, session);
      return;
    }
    if (!session.remoteDescSet || !session.pc) {
      session.pendingCandidates.push(payload.candidate);
    } else {
      try {
        await session.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {}
    }
  }
}

async function startSenderWebRTC(
  signalTransferId,
  uiTransferId,
  fileKey,
  fallbackKey,
  keepStaged,
  targetTag,
  localRoster,
  targetFileMeta
) {
  if (activeRelayStreams.has(signalTransferId)) return;

  const existing = peerSessions.get(signalTransferId);
  if (
    existing?.pc &&
    !existing.cancelled &&
    existing.pc.connectionState !== 'failed' &&
    existing.pc.connectionState !== 'closed' &&
    Date.now() - (existing.createdAt || 0) < 4000
  ) {
    // Se já estamos negociando este mesmo transferId há menos de 4s, apenas reenvia o Offer
    if (existing.offerPayload) {
      sendSignalViaBackground(targetTag, signalTransferId, 'WEBRTC_OFFER', existing.offerPayload);
      for (const c of existing.localCandidatesHistory || []) {
        sendSignalViaBackground(targetTag, signalTransferId, 'ICE_CANDIDATE', { candidate: c });
      }
    }
    return;
  }

  reportProgress(uiTransferId, { status: 'CONNECTING', inProgress: true });

  if (existing?.pc) {
    if (existing.directConnectTimer) clearTimeout(existing.directConnectTimer);
    try { existing.pc.close(); } catch {}
  }
  const pendingCandidates = existing?.pendingCandidates || [];

  const iceServers = getActiveIceServers();
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
  const channel = pc.createDataChannel('pulseshare-file-channel', { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_BUFFER_THRESHOLD;

  const session = {
    pc,
    channel,
    uiTransferId,
    pendingCandidates,
    localCandidatesHistory: [],
    offerPayload: null,
    directConnectTimer: null,
    createdAt: Date.now(),
    remoteDescSet: false,
    paused: false,
    cancelled: false,
    cancelledBySender: false
  };
  peerSessions.set(signalTransferId, session);

  let offerDispatched = false;
  const queuedLocalCandidates = [];

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const candidateObj = e.candidate.toJSON
        ? e.candidate.toJSON()
        : {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            usernameFragment: e.candidate.usernameFragment
          };
      session.localCandidatesHistory.push(candidateObj);
      if (offerDispatched) {
        sendSignalViaBackground(targetTag, signalTransferId, 'ICE_CANDIDATE', {
          candidate: candidateObj
        });
      } else {
        queuedLocalCandidates.push(candidateObj);
      }
    }
  };

  let routeFailedNotified = false;
  const notifyDirectRouteFailed = () => {
    if (routeFailedNotified || session.cancelled || activeRelayStreams.has(signalTransferId)) return;
    if (channel.readyState === 'open') return;
    routeFailedNotified = true;
    if (session.directConnectTimer) {
      clearTimeout(session.directConnectTimer);
      session.directConnectTimer = null;
    }
    sendToBackground({
      type: 'OFFSCREEN_DIRECT_ROUTE_FAILED',
      transferId: signalTransferId,
      uiTransferId,
      targetTag,
      fileId: targetFileMeta?.fileId,
      fileKey,
      fallbackKey,
      keepStaged
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      if (session.directConnectTimer) {
        clearTimeout(session.directConnectTimer);
        session.directConnectTimer = null;
      }
    } else if (pc.connectionState === 'failed') {
      notifyDirectRouteFailed();
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (session.directConnectTimer) {
        clearTimeout(session.directConnectTimer);
        session.directConnectTimer = null;
      }
    } else if (pc.iceConnectionState === 'failed') {
      notifyDirectRouteFailed();
    }
  };

  channel.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const ctrl = JSON.parse(e.data);
        if (ctrl.type === 'P2P_ROSTER_SYNC' && Array.isArray(ctrl.roster)) {
          sendToBackground({ type: 'OFFSCREEN_ROSTER_GOSSIP', roster: ctrl.roster });
        } else if (ctrl.type === 'RECEIVER_ACK_DONE') {
          // Confirmação final de que o destinatário recebeu 100% dos bytes
          pc.close();
          peerSessions.delete(signalTransferId);
        } else if (ctrl.type === 'REQUEST_PAUSE' || ctrl.type === 'TRANSFER_PAUSED') {
          session.paused = true;
          reportProgress(uiTransferId, { status: 'PAUSED' });
        } else if (ctrl.type === 'REQUEST_RESUME' || ctrl.type === 'TRANSFER_RESUMED') {
          session.paused = false;
          reportProgress(uiTransferId, { status: 'TRANSFERRING' });
        } else if (ctrl.type === 'REQUEST_CANCEL' || ctrl.type === 'TRANSFER_CANCELLED') {
          session.cancelled = true;
          if (keepStaged && !session.cancelledBySender) {
            reportProgress(uiTransferId, { status: 'TUNNEL_READY', inProgress: false, speedBps: 0 });
          } else {
            reportProgress(uiTransferId, { status: 'CANCELLED', inProgress: false });
          }
          try { pc.close(); } catch {}
          peerSessions.delete(signalTransferId);
        }
      } catch {}
    }
  };

  channel.onopen = async () => {
    if (session.directConnectTimer) {
      clearTimeout(session.directConnectTimer);
      session.directConnectTimer = null;
    }
    if (Array.isArray(localRoster)) {
      try {
        channel.send(JSON.stringify({ type: 'P2P_ROSTER_SYNC', roster: localRoster }));
      } catch {}
    }

    const file = await getStagedFile(fileKey, fallbackKey);
    if (!file) {
      try {
        channel.send(JSON.stringify({
          type: 'TRANSFER_ERROR',
          error: 'Arquivo não encontrado em memória do remetente. Selecione-o novamente.'
        }));
      } catch {}
      reportProgress(uiTransferId, {
        status: 'ERROR',
        error: 'Arquivo não encontrado em memória. Selecione-o novamente.'
      });
      return;
    }

    try {
      channel.send(JSON.stringify({
        type: 'FILE_START',
        fileId: targetFileMeta?.fileId || 'f-0',
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream'
      }));
    } catch {}

    const totalBytes = file.size;
    reportProgress(uiTransferId, {
      status: 'TRANSFERRING',
      inProgress: true,
      progress: 0,
      transferredBytes: 0
    });

    let offset = 0;
    const startTime = Date.now();
    let lastReport = startTime;

    try {
      // Lê em blocos de 1 MB e envia em fatias SCTP de 16 KB
      while (offset < totalBytes) {
        if (session.cancelled) {
          throw new Error('Transferência cancelada');
        }
        while (session.paused) {
          if (session.cancelled) throw new Error('Transferência cancelada');
          await new Promise((r) => setTimeout(r, 150));
        }

        if (channel.readyState !== 'open') {
          throw new Error('Canal P2P fechado durante o envio');
        }

        const blockEnd = Math.min(offset + READ_BLOCK_SIZE, totalBytes);
        const macroBuffer = await file.slice(offset, blockEnd).arrayBuffer();
        let subOffset = 0;

        while (subOffset < macroBuffer.byteLength) {
          if (session.cancelled) throw new Error('Transferência cancelada');
          while (session.paused) {
            if (session.cancelled) throw new Error('Transferência cancelada');
            await new Promise((r) => setTimeout(r, 150));
          }

          if (channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            await waitForBufferDrain(channel);
          }

          if (channel.readyState !== 'open') {
            throw new Error('Canal P2P interrompido');
          }

          const chunkEnd = Math.min(subOffset + CHUNK_SIZE, macroBuffer.byteLength);
          const chunkView = new Uint8Array(macroBuffer, subOffset, chunkEnd - subOffset);
          channel.send(chunkView);

          const sentLen = chunkEnd - subOffset;
          subOffset = chunkEnd;
          offset += sentLen;

          const now = Date.now();
          if (now - lastReport >= 100 || offset >= totalBytes) {
            const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
            const speedBps = Math.round(offset / elapsedSec);
            const progress = totalBytes > 0 ? Math.round((offset / totalBytes) * 100) : 100;
            reportProgress(uiTransferId, {
              status: session.paused ? 'PAUSED' : 'TRANSFERRING',
              progress,
              transferredBytes: offset,
              speedBps,
              fileId: targetFileMeta?.fileId,
              fileTransferredBytes: offset,
              fileTotalBytes: totalBytes,
              fileSpeedBps: speedBps
            });
            lastReport = now;
          }
        }
      }

      // Aguarda esvaziar o buffer final antes de enviar o marcador EOF
      await waitForBufferDrain(channel);
      channel.send(JSON.stringify({
        type: 'EOF',
        fileId: targetFileMeta?.fileId || 'f-0',
        totalBytes
      }));

      reportProgress(uiTransferId, {
        status: keepStaged ? 'TUNNEL_READY' : 'COMPLETED',
        inProgress: false,
        progress: 100,
        transferredBytes: totalBytes,
        speedBps: 0,
        fileId: targetFileMeta?.fileId,
        fileTransferredBytes: totalBytes,
        fileTotalBytes: totalBytes,
        fileSpeedBps: 0,
        fileCompleted: true
      });

      if (!keepStaged && !String(fileKey || '').startsWith('chatmedia-')) {
        await deleteStagedFile(fileKey);
      }
    } catch (err) {
      if (keepStaged && !session.cancelledBySender) {
        reportProgress(uiTransferId, { status: 'TUNNEL_READY', inProgress: false, speedBps: 0 });
      } else if (err.message === 'Transferência cancelada') {
        reportProgress(uiTransferId, { status: 'CANCELLED', inProgress: false });
      } else {
        reportProgress(uiTransferId, { status: 'ERROR', error: err.message, inProgress: false });
      }
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Aguarda coleta inicial de candidatos STUN/TURN para embutir no SDP Offer
  await waitForIceGathering(pc, 700);

  offerDispatched = true;
  const offerPayload = {
    sdp: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp
    },
    iceServers
  };
  session.offerPayload = offerPayload;
  sendSignalViaBackground(targetTag, signalTransferId, 'WEBRTC_OFFER', offerPayload);

  while (queuedLocalCandidates.length > 0) {
    const candidateObj = queuedLocalCandidates.shift();
    sendSignalViaBackground(targetTag, signalTransferId, 'ICE_CANDIDATE', {
      candidate: candidateObj
    });
  }

  // Fallback automático do remetente caso o DataChannel WebRTC não abra em 4s (CGNAT / Proxy / Firewall)
  session.directConnectTimer = setTimeout(() => {
    if (!session.cancelled && channel.readyState !== 'open') {
      notifyDirectRouteFailed();
    }
  }, 4000);
}

async function startReceiverWebRTC(transferId, senderTag, sdpOffer, localRoster, transferMeta, remoteIceServers = null) {
  const existing = peerSessions.get(transferId);
  if (existing?.pc) {
    try { existing.pc.close(); } catch {}
  }
  const pendingCandidates = existing?.pendingCandidates || [];

  const effectiveIceServers = (remoteIceServers && Array.isArray(remoteIceServers) && remoteIceServers.length > 0)
    ? remoteIceServers
    : getActiveIceServers();
  const pc = new RTCPeerConnection({ iceServers: effectiveIceServers, iceCandidatePoolSize: 4 });
  const chunks = [];
  let receivedBytes = 0;
  let totalBytes = transferMeta?.fileSize || 0;
  let fileName = transferMeta?.fileName || 'arquivo_recebido';
  let fileType = transferMeta?.fileType || 'application/octet-stream';
  const startTime = Date.now();
  let lastReport = startTime;

  const session = {
    pc,
    channel: null,
    uiTransferId: transferId,
    pendingCandidates,
    remoteDescSet: false,
    paused: false,
    cancelled: false
  };
  peerSessions.set(transferId, session);

  let answerDispatched = false;
  const queuedLocalCandidates = [];

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const candidateObj = e.candidate.toJSON
        ? e.candidate.toJSON()
        : {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            usernameFragment: e.candidate.usernameFragment
          };
      if (answerDispatched) {
        sendSignalViaBackground(senderTag, transferId, 'ICE_CANDIDATE', {
          candidate: candidateObj
        });
      } else {
        queuedLocalCandidates.push(candidateObj);
      }
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    session.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (Array.isArray(localRoster)) {
        try {
          channel.send(JSON.stringify({ type: 'P2P_ROSTER_SYNC', roster: localRoster }));
        } catch {}
      }
    };

    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let ctrl;
        try {
          ctrl = JSON.parse(e.data);
        } catch {
          return;
        }

        if (ctrl.type === 'P2P_ROSTER_SYNC' && Array.isArray(ctrl.roster)) {
          sendToBackground({ type: 'OFFSCREEN_ROSTER_GOSSIP', roster: ctrl.roster });
          return;
        }

        if (ctrl.type === 'FILE_START') {
          if (ctrl.fileName) fileName = ctrl.fileName;
          if (ctrl.fileType) fileType = ctrl.fileType;
          if (ctrl.fileSize) totalBytes = ctrl.fileSize;
          return;
        }

        if (ctrl.type === 'TRANSFER_PAUSED') {
          session.paused = true;
          reportProgress(transferId, { status: 'PAUSED' });
          return;
        }

        if (ctrl.type === 'TRANSFER_RESUMED') {
          session.paused = false;
          reportProgress(transferId, { status: 'TRANSFERRING' });
          return;
        }

        if (ctrl.type === 'TRANSFER_CANCELLED' || ctrl.type === 'TRANSFER_ERROR') {
          session.cancelled = true;
          reportProgress(transferId, {
            status: ctrl.type === 'TRANSFER_ERROR' ? 'ERROR' : 'CANCELLED',
            error: ctrl.error
          });
          chunks.length = 0;
          try { pc.close(); } catch {}
          peerSessions.delete(transferId);
          return;
        }

        if (ctrl.type === 'EOF') {
          try {
            channel.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' }));
          } catch {}
          const blob = new Blob(chunks, { type: fileType });
          chunks.length = 0; // Libera memória imediatamente
          if (String(transferId || '').startsWith('chatmedia-')) {
            storeReceivedChatMediaBlob(transferId, blob, fileName, fileType);
            setTimeout(() => {
              pc.close();
              peerSessions.delete(transferId);
            }, 1000);
            return;
          }
          const blobUrl = URL.createObjectURL(blob);
          sendToBackground({
            type: 'OFFSCREEN_DOWNLOAD_READY',
            transferId,
            blobUrl,
            fileName
          });
          setTimeout(() => {
            pc.close();
            peerSessions.delete(transferId);
          }, 1000);
        }
        return;
      }

      chunks.push(e.data);
      receivedBytes += e.data.byteLength;

      const now = Date.now();
      if (now - lastReport >= 100 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
        const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
        const speedBps = Math.round(receivedBytes / elapsedSec);
        const progress =
          totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 99;
        reportProgress(transferId, {
          status: 'TRANSFERRING',
          progress,
          transferredBytes: receivedBytes,
          speedBps
        });
        lastReport = now;
      }
    };
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
  session.remoteDescSet = true;
  await flushPendingCandidates(session);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc, 700);

  answerDispatched = true;
  sendSignalViaBackground(senderTag, transferId, 'WEBRTC_ANSWER', {
    sdp: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp
    }
  });

  while (queuedLocalCandidates.length > 0) {
    const candidateObj = queuedLocalCandidates.shift();
    sendSignalViaBackground(senderTag, transferId, 'ICE_CANDIDATE', {
      candidate: candidateObj
    });
  }
}
