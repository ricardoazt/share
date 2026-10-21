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
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 4
};

// Armazenamento em memória para arquivos grandes (evita gargalo de copiar 110MB+ no IndexedDB)
const inMemoryFiles = new Map();

// Sessões WebRTC ativas: transferId -> { pc, channel, pendingCandidates: [], remoteDescSet: false }
const peerSessions = new Map();

// Canal direto de alta velocidade com popup.js para receber referências de File instantaneamente
const fileBridgeChannel = new BroadcastChannel('pulseshare_file_bridge');
fileBridgeChannel.onmessage = async (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'STAGE_FILE_MEMORY' && data.transferId && data.file) {
    inMemoryFiles.set(data.transferId, data.file);
    try {
      const db = await openDatabase();
      const tx = db.transaction(FILE_STORE, 'readwrite');
      tx.objectStore(FILE_STORE).put(data.file, data.transferId);
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
  if (peerSessions.size > 0 && keepAlivePort) {
    try {
      keepAlivePort.postMessage({ type: 'PING', activeCount: peerSessions.size });
    } catch {}
  }
}, 10000);

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

async function getStagedFile(fileKey, fallbackKey) {
  if (inMemoryFiles.has(fileKey)) {
    return inMemoryFiles.get(fileKey);
  }
  if (fallbackKey && inMemoryFiles.has(fallbackKey)) {
    return inMemoryFiles.get(fallbackKey);
  }
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FILE_STORE, 'readonly');
      const req = tx.objectStore(FILE_STORE).get(fileKey);
      req.onsuccess = () => {
        db.close();
        if (req.result) resolve(req.result);
        else if (fallbackKey) {
          openDatabase().then(db2 => {
            const tx2 = db2.transaction(FILE_STORE, 'readonly');
            const req2 = tx2.objectStore(FILE_STORE).get(fallbackKey);
            req2.onsuccess = () => { db2.close(); resolve(req2.result || null); };
            req2.onerror = () => { db2.close(); resolve(null); };
          }).catch(() => resolve(null));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'REVOKE_BLOB_URL' && msg.blobUrl) {
    URL.revokeObjectURL(msg.blobUrl);
    return;
  }

  if (msg.action === 'OFFSCREEN_SIGNAL') {
    handleSignal(msg);
  } else if (msg.action === 'OFFSCREEN_CONTROL') {
    handleControl(msg);
  }
});

function handleControl({ subAction, transferId }) {
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
    await startReceiverWebRTC(transferId, from, payload.sdp, roster, transferMeta);
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
  reportProgress(uiTransferId, { status: 'CONNECTING' });

  const existing = peerSessions.get(signalTransferId);
  const pendingCandidates = existing?.pendingCandidates || [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('pulseshare-file-channel', { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_BUFFER_THRESHOLD;

  const session = {
    pc,
    channel,
    uiTransferId,
    pendingCandidates,
    remoteDescSet: false,
    paused: false,
    cancelled: false
  };
  peerSessions.set(signalTransferId, session);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalViaBackground(targetTag, signalTransferId, 'ICE_CANDIDATE', {
        candidate: e.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      reportProgress(uiTransferId, {
        status: 'ERROR',
        error: 'Falha na rota P2P (NAT/Firewall bloqueou conexão)'
      });
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
          reportProgress(uiTransferId, { status: 'CANCELLED' });
          try { pc.close(); } catch {}
          peerSessions.delete(signalTransferId);
        }
      } catch {}
    }
  };

  channel.onopen = async () => {
    if (Array.isArray(localRoster)) {
      try {
        channel.send(JSON.stringify({ type: 'P2P_ROSTER_SYNC', roster: localRoster }));
      } catch {}
    }

    const file = await getStagedFile(fileKey, fallbackKey);
    if (!file) {
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
              speedBps
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
        progress: 100,
        transferredBytes: totalBytes,
        speedBps: 0
      });

      if (!keepStaged) {
        await deleteStagedFile(fileKey);
      }
    } catch (err) {
      if (err.message === 'Transferência cancelada') {
        reportProgress(uiTransferId, { status: 'CANCELLED' });
      } else {
        reportProgress(uiTransferId, { status: 'ERROR', error: err.message });
      }
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Aguarda coleta inicial de candidatos STUN/TURN para embutir no SDP Offer
  await waitForIceGathering(pc, 1000);

  sendSignalViaBackground(targetTag, signalTransferId, 'WEBRTC_OFFER', {
    sdp: pc.localDescription
  });
}

async function startReceiverWebRTC(transferId, senderTag, sdpOffer, localRoster, transferMeta) {
  const existing = peerSessions.get(transferId);
  const pendingCandidates = existing?.pendingCandidates || [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const chunks = [];
  let receivedBytes = 0;
  const totalBytes = transferMeta?.fileSize || 0;
  const fileName = transferMeta?.fileName || 'arquivo_recebido';
  const fileType = transferMeta?.fileType || 'application/octet-stream';
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

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalViaBackground(senderTag, transferId, 'ICE_CANDIDATE', {
        candidate: e.candidate
      });
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

        if (ctrl.type === 'TRANSFER_CANCELLED') {
          session.cancelled = true;
          reportProgress(transferId, { status: 'CANCELLED' });
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
  await waitForIceGathering(pc, 1000);

  sendSignalViaBackground(senderTag, transferId, 'WEBRTC_ANSWER', {
    sdp: pc.localDescription
  });
}
