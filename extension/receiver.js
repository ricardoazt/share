/**
 * PulseShare — Receptor Web P2P Serverless (receiver.js)
 * Conecta diretamente ao navegador do remetente usando WebRTC STUN +
 * Servidores TURN públicos (para atravessar CGNAT/Redes Diferentes) +
 * Malha Serverless Multi-Broker MQTT-over-WSS / BroadcastChannel.
 */

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];
const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';

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

// Lê parâmetros tanto do Hash quanto da Query String
const hashStr = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
const searchStr = window.location.search ? window.location.search.replace(/^\?/, '') : '';
const hashParams = new URLSearchParams(hashStr);
const searchParams = new URLSearchParams(searchStr);

const shareId = hashParams.get('share') || searchParams.get('share') || '';
const rawOwner = hashParams.get('owner') || searchParams.get('owner') || '';
const ownerTag = rawOwner ? decodeURIComponent(rawOwner) : '';
const expParam = hashParams.get('exp') || searchParams.get('exp') || '';

const visitorNodeId = crypto.randomUUID();
const visitorTag = `@link_${visitorNodeId.slice(0, 6)}`;

// Elementos DOM
const statusDot = document.getElementById('status-dot');
const statusHeader = document.getElementById('status-header');
const shareBadge = document.getElementById('share-badge');
const alertCard = document.getElementById('alert-card');
const alertText = document.getElementById('alert-text');
const passwordSection = document.getElementById('password-section');
const passwordInput = document.getElementById('password-input');
const btnUnlock = document.getElementById('btn-unlock');
const passwordError = document.getElementById('password-error');
const packContent = document.getElementById('pack-content');
const packTitle = document.getElementById('pack-title');
const packSender = document.getElementById('pack-sender');
const packSummary = document.getElementById('pack-summary');
const tunnelStatusText = document.getElementById('tunnel-status-text');
const expBadge = document.getElementById('exp-badge');

const toggleZipMode = document.getElementById('toggle-zip-mode');
const zipOptionsPanel = document.getElementById('zip-options-panel');
const zipLevelSelect = document.getElementById('zip-level');
const zipFilenameInput = document.getElementById('zip-filename');
const btnDownloadAll = document.getElementById('btn-download-all');
const btnDownloadAllText = document.getElementById('btn-download-all-text');
const filesList = document.getElementById('files-list');

shareBadge.textContent = shareId ? `#${shareId}` : '#inválido';

let packData = null;
let unlocked = false;
let countdownTimer = null;
let brokerSockets = [];
const seenPacketIds = new Set();

// Map de downloads ativos: fileId -> { pc, channel, paused, cancelled, chunks, receivedBytes, totalBytes }
const activeDownloads = new Map();

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function getFileIcon(fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
  if (['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return '🎵';
  if (['pdf'].includes(ext)) return '📄';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
  if (['doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['js', 'ts', 'py', 'html', 'css', 'json'].includes(ext)) return '💻';
  return '📁';
}

async function computeSha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// MQTT Signaling Client sobre WebSocket
// ============================================================================
function encodeRemainingLength(len) {
  const bytes = [];
  do {
    let encoded = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) encoded |= 128;
    bytes.push(encoded);
  } while (len > 0);
  return bytes;
}

function encodeUTF8String(str) {
  const utf8 = new TextEncoder().encode(str);
  return [(utf8.length >> 8) & 0xff, utf8.length & 0xff, ...utf8];
}

function buildMqttPublishPacket(topic, jsonObj) {
  const topicBytes = encodeUTF8String(topic);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(jsonObj));
  const totalLen = topicBytes.length + payloadBytes.length;
  const header = [0x30, ...encodeRemainingLength(totalLen), ...topicBytes];
  const packet = new Uint8Array(header.length + payloadBytes.length);
  packet.set(header, 0);
  packet.set(payloadBytes, header.length);
  return packet;
}

function broadcastSignal(signalType, payload, toTag = ownerTag, transferId = shareId) {
  const pkt = {
    meshType: 'DIRECT_SIGNAL',
    to: toTag,
    transferId,
    signalType,
    payload,
    packetId: crypto.randomUUID(),
    senderNodeId: visitorNodeId,
    senderTag: visitorTag,
    timestamp: Date.now()
  };
  seenPacketIds.add(pkt.packetId);
  const raw = buildMqttPublishPacket(MESH_TOPIC, pkt);
  brokerSockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(raw); } catch {}
    }
  });
  if (localChannel) {
    try { localChannel.postMessage(pkt); } catch {}
  }
}

const localChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('pulseshare_v2_local_mesh')
  : null;
if (localChannel) {
  localChannel.onmessage = (e) => {
    if (e.data) handleIncomingPacket(e.data);
  };
}

function connectBrokers() {
  if (!shareId || !ownerTag) {
    showAlert('Link de compartilhamento incompleto. Parâmetros share ou owner ausentes no link.');
    return;
  }

  PUBLIC_WSS_BROKERS.forEach((url, idx) => {
    let ws;
    try {
      ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      brokerSockets.push(ws);
    } catch {
      return;
    }

    ws.onopen = () => {
      const clientId = `ps_web_${visitorNodeId.slice(0, 6)}_${idx}`;
      const connectBody = [
        ...encodeUTF8String('MQTT'),
        0x04,
        0x02,
        0x00,
        0x3c,
        ...encodeUTF8String(clientId)
      ];
      ws.send(new Uint8Array([0x10, ...encodeRemainingLength(connectBody.length), ...connectBody]));
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const u = new Uint8Array(ev.data);
      let p = 0;
      while (p < u.length) {
        const fb = u[p++];
        const pt = fb & 0xf0;
        let m = 1, rl = 0, eb;
        do {
          eb = u[p++];
          rl += (eb & 127) * m;
          m *= 128;
        } while (eb & 128);
        const pe = p + rl;

        if (pt === 0x20) {
          // CONNACK: Inscreve no tópico global
          const subBody = [0x00, 0x01, ...encodeUTF8String(MESH_TOPIC), 0x00];
          ws.send(new Uint8Array([0x82, ...encodeRemainingLength(subBody.length), ...subBody]));
          statusDot.className = 'dot green';
          statusHeader.textContent = 'Conectado à Malha P2P (3 brokers)';
          requestPackInfo();
        } else if (pt === 0x30) {
          // PUBLISH
          let c = p;
          const tl = (u[c] << 8) | u[c + 1];
          c += 2 + tl;
          if (((fb >> 1) & 0x03) > 0) c += 2;
          try {
            const str = new TextDecoder().decode(u.subarray(c, pe));
            const pkt = JSON.parse(str);
            handleIncomingPacket(pkt);
          } catch {}
        }
        p = pe;
      }
    };

    ws.onclose = () => {
      setTimeout(connectBrokers, 4000);
    };
  });
}

function showAlert(msg) {
  alertText.textContent = msg;
  alertCard.classList.remove('hidden');
}

function hideAlert() {
  alertCard.classList.add('hidden');
}

function requestPackInfo() {
  if (packData) return;
  statusHeader.textContent = `Aguardando remetente (${ownerTag})...`;
  broadcastSignal('PACK_INFO_REQUEST', { shareId });
}

// ============================================================================
// Manipulação de Pacotes Recebidos
// ============================================================================
function handleIncomingPacket(pkt) {
  if (!pkt || pkt.senderNodeId === visitorNodeId) return;
  if (pkt.packetId) {
    if (seenPacketIds.has(pkt.packetId)) return;
    seenPacketIds.add(pkt.packetId);
  }
  if (pkt.meshType !== 'DIRECT_SIGNAL' || pkt.to !== visitorTag) return;

  const { signalType, payload, transferId } = pkt;

  if (signalType === 'PACK_INFO_RESPONSE') {
    onPackInfoResponse(payload);
    return;
  }

  if (signalType === 'FILE_REJECT') {
    const fileId = payload?.fileId;
    if (fileId && activeDownloads.has(fileId)) {
      const dl = activeDownloads.get(fileId);
      updateFileUI(fileId, { status: 'Erro: ' + (payload.error || 'Rejeitado pelo remetente') });
      dl.pc.close();
      activeDownloads.delete(fileId);
    }
    return;
  }

  if (signalType === 'WEBRTC_OFFER') {
    handleWebRtcOffer(transferId, payload.sdp);
    return;
  }

  if (signalType === 'ICE_CANDIDATE' && payload?.candidate) {
    const dl = findDownloadByTransferId(transferId);
    if (dl && dl.pc && dl.pc.remoteDescription) {
      dl.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
    } else if (dl) {
      dl.pendingCandidates = dl.pendingCandidates || [];
      dl.pendingCandidates.push(payload.candidate);
    }
  }
}

function findDownloadByTransferId(transferId) {
  for (const dl of activeDownloads.values()) {
    if (dl.transferId === transferId) return dl;
  }
  return null;
}

function onPackInfoResponse(payload) {
  if (!payload.ok) {
    if (payload.error === 'EXPIRED') {
      showAlert('⏳ Este link temporário expirou. O tempo limite definido pelo remetente foi atingido.');
    } else if (payload.error === 'CANCELLED') {
      showAlert('✕ O remetente encerrou este compartilhamento.');
    } else if (payload.error === 'PAUSED') {
      showAlert('⏸ O remetente pausou o link temporariamente. Aguarde a retomada.');
    } else {
      showAlert(payload.message || 'Compartilhamento não encontrado ou remetente offline.');
    }
    statusDot.className = 'dot red';
    statusHeader.textContent = 'Link Indisponível';
    return;
  }

  packData = payload;
  statusDot.className = 'dot green';
  statusHeader.textContent = '🟢 Remetente Online (P2P Pronto)';
  hideAlert();

  if (packData.hasPassword && !unlocked) {
    passwordSection.classList.remove('hidden');
    packContent.classList.add('hidden');
  } else {
    showPackUI();
  }
}

// ============================================================================
// Validação de Senha
// ============================================================================
btnUnlock.addEventListener('click', async () => {
  const pwd = (passwordInput.value || '').trim();
  if (!pwd) {
    passwordError.textContent = 'Digite a senha.';
    passwordError.classList.remove('hidden');
    return;
  }

  if (packData.passwordSalt && packData.passwordHash) {
    const computed = await computeSha256(pwd + packData.passwordSalt);
    if (computed === packData.passwordHash) {
      unlocked = true;
      passwordSection.classList.add('hidden');
      passwordError.classList.add('hidden');
      showPackUI();
    } else {
      passwordError.textContent = 'Senha incorreta. Verifique e tente novamente.';
      passwordError.classList.remove('hidden');
    }
  } else {
    unlocked = true;
    passwordSection.classList.add('hidden');
    showPackUI();
  }
});

passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnUnlock.click();
});

// ============================================================================
// Renderização do Pack e Opções de Compactação
// ============================================================================
function showPackUI() {
  packContent.classList.remove('hidden');
  packTitle.textContent = packData.packName || 'Pacote de Arquivos';
  packSender.textContent = `Remetente: ${packData.ownerTag || ownerTag}`;
  const totalSize = packData.totalSize || (packData.files || []).reduce((acc, f) => acc + (f.size || 0), 0);
  packSummary.textContent = `${(packData.files || []).length} arquivo(s) • ${formatBytes(totalSize)}`;

  if (zipFilenameInput && !zipFilenameInput.value) {
    const defaultZip = (packData.packName || 'Pacote_Compartilhado').replace(/\.zip$/i, '') + '.zip';
    zipFilenameInput.value = defaultZip;
  }

  updateExpirationCountdown();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(updateExpirationCountdown, 1000);

  renderFilesList();
}

function updateExpirationCountdown() {
  if (!packData || !packData.expiresAt) {
    expBadge.textContent = '⏳ Sem limite';
    return;
  }
  const remainingSec = Math.max(0, Math.floor((packData.expiresAt - Date.now()) / 1000));
  if (remainingSec <= 0) {
    expBadge.textContent = '⏳ Expirado';
    expBadge.style.color = '#fb7185';
    showAlert('⏳ O tempo limite deste link acabou. Novos downloads não podem ser iniciados.');
    btnDownloadAll.disabled = true;
    return;
  }
  const min = Math.floor(remainingSec / 60);
  const sec = remainingSec % 60;
  expBadge.textContent = `⏳ Expira em: ${min}m ${sec < 10 ? '0' : ''}${sec}s`;
}

if (toggleZipMode) {
  toggleZipMode.addEventListener('change', () => {
    if (toggleZipMode.checked) {
      zipOptionsPanel.classList.remove('hidden');
      btnDownloadAllText.textContent = '⬇ Baixar Todos (.ZIP)';
    } else {
      zipOptionsPanel.classList.add('hidden');
      btnDownloadAllText.textContent = '⬇ Baixar Todos os Arquivos';
    }
  });
}

function renderFilesList() {
  filesList.innerHTML = '';
  const files = packData.files || [];

  files.forEach((file) => {
    const card = document.createElement('div');
    card.className = 'file-item';
    card.id = `card-${file.fileId}`;

    card.innerHTML = `
      <div class="file-row">
        <div class="file-name-wrap">
          <span class="file-icon">${getFileIcon(file.name)}</span>
          <div style="display: flex; flex-direction: column; min-width: 0;">
            <span class="file-name" title="${file.name}">${file.name}</span>
            <span class="file-size">${formatBytes(file.size)}</span>
          </div>
        </div>
        <button
          id="btn-dl-${file.fileId}"
          type="button"
          class="file-btn"
          data-file-id="${file.fileId}"
        >
          ⬇ Baixar
        </button>
      </div>

      <div id="prog-${file.fileId}" class="prog-section hidden">
        <div class="prog-bar-bg">
          <div id="bar-${file.fileId}" class="prog-bar-fill"></div>
        </div>
        <div class="prog-info">
          <span id="st-${file.fileId}">Conectando túnel P2P...</span>
          <span id="pct-${file.fileId}">0%</span>
        </div>
        <div class="prog-info">
          <span id="bytes-${file.fileId}">0 B / ${formatBytes(file.size)}</span>
          <span id="spd-${file.fileId}">0 B/s</span>
        </div>
        <div class="prog-controls">
          <button id="btn-pause-${file.fileId}" type="button" class="ctrl-btn btn-pause" data-file-id="${file.fileId}">
            ⏸ Pausar
          </button>
          <button id="btn-cancel-${file.fileId}" type="button" class="ctrl-btn btn-cancel" data-file-id="${file.fileId}">
            ✕ Cancelar
          </button>
        </div>
      </div>
    `;
    filesList.appendChild(card);
  });
}

// ============================================================================
// Download de Arquivos e Compactação em .ZIP (fflate)
// ============================================================================
filesList.addEventListener('click', (e) => {
  const dlBtn = e.target.closest('button[data-file-id]');
  if (!dlBtn) return;
  const fileId = dlBtn.getAttribute('data-file-id');

  if (dlBtn.id.startsWith('btn-dl-')) {
    startFileDownload(fileId);
  } else if (dlBtn.id.startsWith('btn-pause-')) {
    togglePauseDownload(fileId);
  } else if (dlBtn.id.startsWith('btn-cancel-')) {
    cancelDownload(fileId);
  }
});

btnDownloadAll.addEventListener('click', async () => {
  const files = packData.files || [];
  if (files.length === 0) return;

  const isZipMode = Boolean(toggleZipMode && toggleZipMode.checked);
  const compressLevel = zipLevelSelect ? Number(zipLevelSelect.value) : 6;
  const customZipName = zipFilenameInput ? zipFilenameInput.value.trim() : '';

  btnDownloadAll.disabled = true;

  if (isZipMode) {
    btnDownloadAllText.textContent = 'Baixando arquivos para compactação...';
    const zipEntries = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      btnDownloadAllText.textContent = `Baixando ${i + 1}/${files.length}: ${file.name}...`;

      const fileBytes = await new Promise((resolve, reject) => {
        startFileDownload(file.fileId, (bytes) => {
          resolve(bytes);
        }, true);
      });

      if (fileBytes) {
        zipEntries[file.name] = [new Uint8Array(fileBytes), { level: compressLevel }];
      }
    }

    btnDownloadAllText.textContent = `Compactando em .ZIP (Nível ${compressLevel})...`;

    try {
      if (typeof fflate === 'undefined' || !fflate.zip) {
        throw new Error('Biblioteca de compressão fflate não encontrada.');
      }

      const zippedU8 = await new Promise((resolve, reject) => {
        fflate.zip(zipEntries, { level: compressLevel }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const defaultName = (packData.packName || 'Pacote_Compartilhado').replace(/\.zip$/i, '') + '.zip';
      const finalZipName = (customZipName || defaultName).replace(/\.zip$/i, '') + '.zip';

      const blob = new Blob([zippedU8], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = finalZipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      btnDownloadAllText.textContent = '✓ ZIP Baixado com Sucesso!';
    } catch (err) {
      console.error('Erro ao gerar ZIP:', err);
      showAlert(`Falha ao compactar ZIP: ${err.message}`);
      btnDownloadAllText.textContent = 'Erro ao compactar ZIP';
    }
  } else {
    btnDownloadAllText.textContent = 'Baixando arquivos em fila...';
    for (const file of files) {
      if (!activeDownloads.has(file.fileId)) {
        await new Promise((resolve) => {
          startFileDownload(file.fileId, () => resolve());
        });
      }
    }
    btnDownloadAllText.textContent = '✓ Todos os downloads finalizados';
  }

  setTimeout(() => {
    btnDownloadAll.disabled = false;
    btnDownloadAllText.textContent = isZipMode ? '⬇ Baixar Todos (.ZIP)' : '⬇ Baixar Todos os Arquivos';
  }, 3000);
});

function startFileDownload(fileId, onCompleteCallback, returnBufferOnly = false) {
  const file = (packData.files || []).find((f) => f.fileId === fileId);
  if (!file) return;

  const progSection = document.getElementById(`prog-${fileId}`);
  const btnDl = document.getElementById(`btn-dl-${fileId}`);
  if (progSection) progSection.classList.remove('hidden');
  if (btnDl) {
    btnDl.disabled = true;
    btnDl.textContent = 'Baixando...';
  }

  const transferId = `${shareId}_${fileId}_${Math.floor(1000 + Math.random() * 9000)}`;

  const downloadRecord = {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    transferId,
    pc: null,
    channel: null,
    chunks: [],
    receivedBytes: 0,
    startTime: Date.now(),
    lastReport: Date.now(),
    paused: false,
    cancelled: false,
    pendingCandidates: [],
    returnBufferOnly,
    onComplete: onCompleteCallback
  };

  activeDownloads.set(fileId, downloadRecord);
  broadcastSignal('PACK_FILE_PULL', { shareId, fileId }, ownerTag, transferId);
}

async function handleWebRtcOffer(transferId, sdpOffer) {
  const dl = findDownloadByTransferId(transferId);
  if (!dl) return;

  if (dl.pc) {
    try { dl.pc.close(); } catch {}
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  dl.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      broadcastSignal(
        'ICE_CANDIDATE',
        { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate },
        ownerTag,
        transferId
      );
    }
  };

  pc.ondatachannel = (ev) => {
    const channel = ev.channel;
    dl.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onmessage = (e) => {
      if (dl.cancelled) return;

      if (typeof e.data === 'string') {
        try {
          const ctrl = JSON.parse(e.data);
          if (ctrl.type === 'TRANSFER_PAUSED') {
            dl.paused = true;
            updateFileUI(dl.fileId, { status: 'Pausado pelo remetente' });
            return;
          }
          if (ctrl.type === 'TRANSFER_RESUMED') {
            dl.paused = false;
            updateFileUI(dl.fileId, { status: 'Recebendo dados...' });
            return;
          }
          if (ctrl.type === 'TRANSFER_CANCELLED') {
            dl.cancelled = true;
            updateFileUI(dl.fileId, { status: 'Cancelado pelo remetente' });
            try { pc.close(); } catch {}
            activeDownloads.delete(dl.fileId);
            return;
          }
          if (ctrl.type === 'EOF') {
            try { channel.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' })); } catch {}
            finishDownload(dl);
          }
        } catch {}
        return;
      }

      dl.chunks.push(new Uint8Array(e.data));
      dl.receivedBytes += e.data.byteLength;

      const now = Date.now();
      if (now - dl.lastReport >= 100 || (dl.fileSize > 0 && dl.receivedBytes >= dl.fileSize)) {
        const elapsed = Math.max(0.1, (now - startTime) / 1000);
        const speedBps = Math.round(dl.receivedBytes / elapsed);
        const pct = dl.fileSize > 0 ? Math.min(99, Math.round((dl.receivedBytes / dl.fileSize) * 100)) : 99;
        updateFileUI(dl.fileId, {
          status: dl.paused ? 'Pausado' : 'Recebendo dados...',
          pct,
          speedBps,
          receivedBytes: dl.receivedBytes,
          totalBytes: dl.fileSize
        });
        dl.lastReport = now;
      }
    };
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

  while (dl.pendingCandidates && dl.pendingCandidates.length > 0) {
    const c = dl.pendingCandidates.shift();
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  broadcastSignal('WEBRTC_ANSWER', { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, ownerTag, transferId);
}

function togglePauseDownload(fileId) {
  const dl = activeDownloads.get(fileId);
  if (!dl) return;

  const btnPause = document.getElementById(`btn-pause-${fileId}`);
  if (!dl.paused) {
    dl.paused = true;
    if (btnPause) {
      btnPause.textContent = '▶ Retomar';
      btnPause.className = 'ctrl-btn btn-resume';
    }
    updateFileUI(fileId, { status: 'Pausado' });
    try { dl.channel?.send(JSON.stringify({ type: 'REQUEST_PAUSE' })); } catch {}
  } else {
    dl.paused = false;
    if (btnPause) {
      btnPause.textContent = '⏸ Pausar';
      btnPause.className = 'ctrl-btn btn-pause';
    }
    updateFileUI(fileId, { status: 'Recebendo...' });
    try { dl.channel?.send(JSON.stringify({ type: 'REQUEST_RESUME' })); } catch {}
  }
}

function cancelDownload(fileId) {
  const dl = activeDownloads.get(fileId);
  if (!dl) return;

  dl.cancelled = true;
  try { dl.channel?.send(JSON.stringify({ type: 'REQUEST_CANCEL' })); } catch {}
  try { dl.pc?.close(); } catch {}

  updateFileUI(fileId, { status: 'Download cancelado' });
  activeDownloads.delete(fileId);

  const btnDl = document.getElementById(`btn-dl-${fileId}`);
  if (btnDl) {
    btnDl.disabled = false;
    btnDl.textContent = '⬇ Tentar Novamente';
  }
}

function finishDownload(dl) {
  let combinedBuffer = null;
  let totalLen = 0;
  for (const ch of dl.chunks) totalLen += ch.byteLength;
  combinedBuffer = new Uint8Array(totalLen);
  let offset = 0;
  for (const ch of dl.chunks) {
    combinedBuffer.set(ch, offset);
    offset += ch.byteLength;
  }
  dl.chunks.length = 0;

  if (!dl.returnBufferOnly) {
    const blob = new Blob([combinedBuffer], { type: dl.fileType });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = dl.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }

  updateFileUI(dl.fileId, {
    status: 'Download concluído com sucesso!',
    pct: 100,
    receivedBytes: dl.fileSize,
    totalBytes: dl.fileSize,
    speedBps: 0
  });

  const btnDl = document.getElementById(`btn-dl-${dl.fileId}`);
  if (btnDl) {
    btnDl.textContent = '✓ Salvo';
    btnDl.disabled = false;
  }

  setTimeout(() => {
    try { dl.pc?.close(); } catch {}
    activeDownloads.delete(dl.fileId);
    if (typeof dl.onComplete === 'function') {
      dl.onComplete(combinedBuffer);
    }
  }, 500);
}

function updateFileUI(fileId, { status, pct, speedBps, receivedBytes, totalBytes }) {
  const stEl = document.getElementById(`st-${fileId}`);
  const pctEl = document.getElementById(`pct-${fileId}`);
  const barEl = document.getElementById(`bar-${fileId}`);
  const bytesEl = document.getElementById(`bytes-${fileId}`);
  const spdEl = document.getElementById(`spd-${fileId}`);

  if (status && stEl) stEl.textContent = status;
  if (typeof pct === 'number') {
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (barEl) barEl.style.width = `${pct}%`;
  }
  if (typeof receivedBytes === 'number' && typeof totalBytes === 'number' && bytesEl) {
    bytesEl.textContent = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
  }
  if (typeof speedBps === 'number' && spdEl) {
    spdEl.textContent = `${formatBytes(speedBps)}/s`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  connectBrokers();
});
