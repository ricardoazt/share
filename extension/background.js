/**
 * PulseShare P2P - Multi-Broker Serverless Mesh, Gossip & Large File Worker (background.js)
 *
 * Correções Críticas para Conexão Remota e Arquivos Grandes (+110MB / +1GB):
 * 1. Conexão simultânea em paralelo aos brokers WSS públicos (EMQX + HiveMQ + Mosquitto /mqtt)
 *    com deduplicação de pacotes por UUID (`pktId`), garantindo entrega entre redes distintas.
 * 2. Janela persistente via `chrome.action.onClicked` e `ensureExtensionPopupOpen`, impedindo que
 *    o explorador de arquivos do SO feche o popup e invalide referências de arquivos de +110MB.
 * 3. Keep-Alive Port (`chrome.runtime.onConnect`) para impedir que o Service Worker hiberne
 *    após 30 segundos durante transferências de vídeos grandes.
 */

importScripts('pulseshare-mesh-engine.js');

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];
const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';

const meshEngine = new PulseShareMeshEngine();

const state = {
  connected: false,
  nodeId: '',
  myTag: '',
  autoAccept: true,
  autoOpenOnReceive: true,
  tunnelReady: true,
  stagedTunnelFiles: [],
  tunnelModalOpen: false,
  modalMode: 'p2p',
  modalTargetTag: '',
  peerRegistry: {},
  deletedTags: {},
  transfers: {},
  meshRelayEnabled: true,
  relayBandwidthLimitKbps: 2048,
  relayedBytesTotal: 0,
  activeRelayedRoutes: 0,
  meshEngineSummary: null,
  turnConfig: null
};

const publicP2PShares = new Map();
const brokerSockets = new Map(); // url -> WebSocket
const seenPacketIds = new Set();
const activeRelaySessions = new Map(); // transferId -> session
const routeFallbackTimers = new Map(); // transferId -> timer
const pendingProbes = new Map(); // probeId -> resolveFn

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.turnConfig) {
      state.turnConfig = changes.turnConfig.newValue || null;
      safeSendMessage({
        target: 'offscreen',
        action: 'OFFSCREEN_SET_TURN_CONFIG',
        turnConfig: state.turnConfig
      });
    }
  });
}

function normalizeTag(raw) {
  let tag = (raw || '').trim().toLowerCase();
  if (!tag) return '';
  if (!tag.startsWith('@')) tag = `@${tag}`;
  return tag.replace(/[^a-z0-9_@]/g, '');
}

async function generateRegistrationHash(tag, nodeId, timestamp) {
  try {
    const raw = `PULSESHARE_ID:${normalizeTag(tag)}:${nodeId}:${timestamp}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return '0x' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    return '0x' + Math.random().toString(16).slice(2, 10);
  }
}

function probeUserAvailability(tag, timeoutMs = 750) {
  return new Promise((resolve) => {
    const probeId = crypto.randomUUID();
    let isResolved = false;

    const timer = setTimeout(() => {
      pendingProbes.delete(probeId);
      if (!isResolved) {
        isResolved = true;
        resolve(false);
      }
    }, timeoutMs);

    pendingProbes.set(probeId, (exists) => {
      clearTimeout(timer);
      pendingProbes.delete(probeId);
      if (!isResolved) {
        isResolved = true;
        resolve(Boolean(exists));
      }
    });

    broadcastToMesh({
      meshType: 'PROBE_USER_EXISTS',
      probeId,
      tag: normalizeTag(tag),
      requesterNodeId: state.nodeId
    });
  });
}

async function handleRegisterUser(tagInput) {
  const requestedTag = normalizeTag(tagInput);

  if (!requestedTag || requestedTag.length < 3 || !/^@[a-z0-9_]{2,30}$/i.test(requestedTag)) {
    return {
      ok: false,
      error: 'O nome de usuário deve conter de 2 a 30 caracteres alfanuméricos ou sublinhado (ex: @usuario).'
    };
  }

  // Se já for o próprio usuário registrado no mesmo nó
  if (
    requestedTag.toLowerCase() === (state.myTag || '').toLowerCase() &&
    state.peerRegistry[state.myTag]?.nodeId === state.nodeId
  ) {
    return { ok: true, tag: state.myTag, state, alreadyRegistered: true };
  }

  // Validação local: verifica se o usuário já existe na lista descentralizada de outro nó
  const localConflict = Object.values(state.peerRegistry).find(
    (p) => p.tag && normalizeTag(p.tag).toLowerCase() === requestedTag.toLowerCase() && p.nodeId !== state.nodeId
  );
  if (localConflict) {
    return {
      ok: false,
      error: `O usuário ${requestedTag} já existe na rede descentralizada! Por favor, escolha outro nome.`
    };
  }

  // Validação na malha: consulta ativa aos nós online da rede descentralizada
  const meshConflict = await probeUserAvailability(requestedTag, 750);
  if (meshConflict) {
    return {
      ok: false,
      error: `O usuário ${requestedTag} já existe na rede descentralizada! Por favor, escolha outro nome.`
    };
  }

  // Validado e livre de conflitos! Registra na rede descentralizada
  const previousTag = state.myTag;
  const now = Date.now();
  const regHash = await generateRegistrationHash(requestedTag, state.nodeId, now);

  state.myTag = requestedTag;
  await chrome.storage.local.set({ myTag: state.myTag });

  if (previousTag && previousTag !== requestedTag && state.peerRegistry[previousTag]?.nodeId === state.nodeId) {
    delete state.peerRegistry[previousTag];
  }

  state.peerRegistry[requestedTag] = {
    tag: requestedTag,
    nodeId: state.nodeId,
    registeredAt: now,
    regHash,
    joinedAt: now,
    lastSeen: now,
    status: 'online',
    relayEnabled: state.meshRelayEnabled !== false,
    relayBandwidthLimitKbps: typeof state.relayBandwidthLimitKbps === 'number' ? state.relayBandwidthLimitKbps : 2048,
    activeRoutes: Number(state.activeRelayedRoutes || 0)
  };

  await chrome.storage.local.set({ peerRegistry: state.peerRegistry });

  if (meshEngine.initialized) {
    meshEngine.myTag = requestedTag;
    if (meshEngine.reticulum) meshEngine.reticulum.nodeTag = requestedTag;
    if (meshEngine.aodv) meshEngine.aodv.myTag = requestedTag;
  }

  // Propagação descentralizada para toda a rede (MQTT + WebRTC DataChannels)
  broadcastToMesh({
    meshType: 'USER_REGISTERED',
    tag: requestedTag,
    nodeId: state.nodeId,
    registeredAt: now,
    regHash,
    previousTag,
    roster: Object.values(state.peerRegistry)
  });

  broadcastState();
  return { ok: true, tag: requestedTag, registeredAt: now, regHash, state };
}

let pingInterval = null;
let gossipDebounceTimer = null;
let popupWindowId = null;

const localMeshChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pulseshare_v2_local_mesh') : null;

const fileBridgeChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pulseshare_file_bridge') : null;

if (localMeshChannel) {
  localMeshChannel.onmessage = (e) => {
    if (e.data) handleMeshPacket(e.data);
  };
}

// Mantém o Service Worker acordado enquanto o Offscreen Document estiver transmitindo
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen-keepalive') {
    port.onMessage.addListener(() => {});
  }
});

// ============================================================================
// 1. Controle de Janela Persistente da Extensão (Nunca fecha no File Picker)
// ============================================================================
async function isExtensionPopupOpen() {
  if (popupWindowId !== null) {
    try {
      const win = await chrome.windows.get(popupWindowId);
      if (win) return true;
    } catch {
      popupWindowId = null;
    }
  }

  if ('getContexts' in chrome.runtime) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['POPUP', 'TAB']
      });
      if (contexts.some((c) => c.documentUrl && c.documentUrl.includes('popup.html'))) {
        return true;
      }
    } catch {}
  }

  return false;
}

function updateBadgeForStagedFiles() {
  try {
    const count = Array.isArray(state.stagedTunnelFiles) ? state.stagedTunnelFiles.length : 0;
    if (count > 0 && state.tunnelModalOpen) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#f97316' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

async function openOrFocusAppWindow(queryString = '') {
  if (popupWindowId !== null) {
    try {
      const win = await chrome.windows.get(popupWindowId);
      if (win) {
        await chrome.windows.update(popupWindowId, { focused: true });
        return;
      }
    } catch {
      popupWindowId = null;
    }
  }

  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.includes('popup.html'));
    if (existing && existing.windowId) {
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.tabs.update(existing.id, { active: true });
      popupWindowId = existing.windowId;
      return;
    }
  } catch {}

  try {
    const url = chrome.runtime.getURL(`popup.html${queryString ? queryString : '?window=1'}`);
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: 500,
      height: 720,
      focused: true
    });
    popupWindowId = win.id;
  } catch (err) {
    console.error('Erro ao abrir janela persistente da extensão:', err);
  }
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    openOrFocusAppWindow();
  });
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    if (winId === popupWindowId) {
      popupWindowId = null;
    }
  });
}

async function ensureExtensionPopupOpen(queryString = '') {
  await openOrFocusAppWindow(queryString);
}

// Monitor periódico de expiração e limites de downloads de túneis temporários
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, t] of Object.entries(state.transfers)) {
    if (t.direction === 'tunnel') {
      const maxDl = Number(t.maxDownloads || 0);
      const dlCount = Number(t.completedDownloads || t.completedPacks || 0);
      const isLimitReached = maxDl > 0 && dlCount >= maxDl;
      const isExpired = t.expiresAt && now >= t.expiresAt;

      if (t.status === 'TUNNEL_READY' || t.status === 'PAUSED' || t.status === 'TRANSFERRING') {
        if (isLimitReached) {
          t.status = 'COMPLETED';
          t.inProgress = false;
          t.updatedAt = now;
          if (t.shareId) {
            publicP2PShares.delete(t.shareId);
            broadcastToMesh({
              meshType: 'DIRECT_SIGNAL',
              signalType: 'PACK_INFO_RESPONSE',
              transferId: t.shareId,
              payload: {
                ok: false,
                error: 'DOWNLOAD_LIMIT_REACHED',
                message: 'O limite de downloads deste link foi atingido.'
              }
            });
          }
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId: t.shareId || id });
          }
          ensureOffscreenDocument().then(() => {
            safeSendMessage({
              target: 'offscreen',
              action: 'OFFSCREEN_CONTROL',
              subAction: 'CANCEL',
              transferId: id
            });
          });
          changed = true;
        } else if (isExpired) {
          t.status = 'EXPIRED';
          t.inProgress = false;
          t.updatedAt = now;
          if (t.shareId) {
            publicP2PShares.delete(t.shareId);
            broadcastToMesh({
              meshType: 'DIRECT_SIGNAL',
              signalType: 'PACK_INFO_RESPONSE',
              transferId: t.shareId,
              payload: {
                ok: false,
                error: 'EXPIRED',
                message: 'Este túnel temporário expirou.'
              }
            });
          }
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId: t.shareId || id });
          }
          ensureOffscreenDocument().then(() => {
            safeSendMessage({
              target: 'offscreen',
              action: 'OFFSCREEN_CONTROL',
              subAction: 'CANCEL',
              transferId: id
            });
          });
          changed = true;
        }
      }
    }
  }
  if (changed) {
    broadcastState();
  }
}, 1000);

const DEFAULT_PORTAL_URL = 'https://ricardoazt.github.io/share/';

// ============================================================================
// 2. Link Público P2P Serverless (GitHub Pages WebRTC STUN + TURN)
// ============================================================================
async function startServerlessP2PLinkShare(params) {
  const shareId =
    params.shareId ||
    `ps-${Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

  const files =
    Array.isArray(params.files) && params.files.length > 0
      ? params.files
      : [
          {
            fileId: 'f-0',
            name: params.fileMeta?.name || 'arquivo',
            size: params.fileMeta?.size || 0,
            type: params.fileMeta?.type || 'application/octet-stream'
          }
        ];

  const totalSize =
    params.totalSize || files.reduce((acc, f) => acc + (f.size || 0), 0);
  const packName =
    params.packName || (files.length === 1 ? files[0].name : `Pack (${files.length} arquivos)`);
  const expiresAt = params.expiresAt ? Number(params.expiresAt) : null;
  const hasPassword = Boolean(params.hasPassword);
  const password = params.password || '';
  const passwordSalt = params.passwordSalt || '';
  const passwordHash = params.passwordHash || '';

  const stored = await chrome.storage.local.get(['portalUrl']);
  const basePortalUrl = (stored.portalUrl || DEFAULT_PORTAL_URL).trim().replace(/\/+$/, '') + '/';
  const shareUrl = `${basePortalUrl}#share=${shareId}&owner=${encodeURIComponent(state.myTag)}${expiresAt ? `&exp=${expiresAt}` : ''}`;

  const shareRecord = {
    shareId,
    transferId: shareId,
    packName,
    fileName: packName,
    files,
    totalSize,
    fileSize: totalSize,
    fileType: 'application/octet-stream',
    hasPassword,
    passwordSalt,
    passwordHash,
    expiresAt,
    createdAt: Date.now()
  };

  publicP2PShares.set(shareId, shareRecord);

  state.transfers[shareId] = {
    id: shareId,
    direction: 'tunnel',
    peerTag: 'Link Público WebRTC',
    packName,
    fileName: packName,
    files,
    totalSize,
    fileSize: totalSize,
    fileType: 'application/octet-stream',
    progress: 0,
    transferredBytes: 0,
    totalBytesSent: 0,
    speedBps: 0,
    downloads: 0,
    maxDownloads: Number(params.maxDownloads || 0),
    completedDownloads: 0,
    completedPacks: 0,
    inProgress: false,
    filesProgress: (files || []).map((f, i) => ({
      index: i,
      fileId: f.fileId || `f-${i}`,
      name: f.name,
      size: f.size,
      bytesSent: 0,
      progress: 0,
      status: 'IDLE'
    })),
    shareId,
    shareUrl,
    ownerTag: state.myTag,
    status: 'TUNNEL_READY',
    hasPassword,
    password, // Armazenada localmente para remetente copiar formatado
    passwordSalt,
    passwordHash,
    expiresAt,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await ensureOffscreenDocument();
  broadcastState();
  return { ok: true, shareId, shareUrl };
}

// ============================================================================
// 3. Codificador/Decodificador Binário MQTT v3.1.1 sobre WebSocket (Multi-Broker)
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

function buildMqttConnectPacket(clientId) {
  const protocolName = encodeUTF8String('MQTT');
  const protocolLevel = [0x04];
  const connectFlags = [0x02];
  const keepAlive = [0x00, 0x3c];
  const payload = encodeUTF8String(clientId);
  const body = [...protocolName, ...protocolLevel, ...connectFlags, ...keepAlive, ...payload];
  return new Uint8Array([0x10, ...encodeRemainingLength(body.length), ...body]);
}

function buildMqttSubscribePacket(topic) {
  const packetId = [0x00, 0x01];
  const topicFilter = [...encodeUTF8String(topic), 0x00];
  const body = [...packetId, ...topicFilter];
  return new Uint8Array([0x82, ...encodeRemainingLength(body.length), ...body]);
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

function parseMqttIncomingPackets(arrayBuffer, ws = null) {
  const incoming = new Uint8Array(arrayBuffer);
  let buf;
  if (ws && ws._rxBuffer && ws._rxBuffer.length > 0) {
    buf = new Uint8Array(ws._rxBuffer.length + incoming.length);
    buf.set(ws._rxBuffer, 0);
    buf.set(incoming, ws._rxBuffer.length);
  } else {
    buf = incoming;
  }

  const messages = [];
  let pos = 0;

  while (pos < buf.length) {
    const packetStart = pos;
    const firstByte = buf[pos++];
    const packetType = firstByte & 0xf0;

    let multiplier = 1;
    let remainingLen = 0;
    let encodedByte;
    let incompleteHeader = false;
    do {
      if (pos >= buf.length) {
        incompleteHeader = true;
        break;
      }
      encodedByte = buf[pos++];
      remainingLen += (encodedByte & 127) * multiplier;
      multiplier *= 128;
    } while ((encodedByte & 128) !== 0);

    if (incompleteHeader) {
      pos = packetStart;
      break;
    }

    const packetEnd = pos + remainingLen;
    if (packetEnd > buf.length) {
      pos = packetStart;
      break;
    }

    if (packetType === 0x20) {
      messages.push({ mqttEvent: 'CONNACK' });
    } else if (packetType === 0x30) {
      let cursor = pos;
      const topicLen = (buf[cursor] << 8) | buf[cursor + 1];
      cursor += 2 + topicLen;
      const qos = (firstByte >> 1) & 0x03;
      if (qos > 0) cursor += 2;
      if (cursor <= packetEnd) {
        const payloadStr = new TextDecoder().decode(buf.subarray(cursor, packetEnd));
        try {
          messages.push({ mqttEvent: 'PUBLISH', data: JSON.parse(payloadStr) });
        } catch {}
      }
    }

    pos = packetEnd;
  }

  if (ws) {
    if (pos < buf.length) {
      // Limite de segurança de 2MB para evitar acúmulo indefinido em caso de frame corrompido
      ws._rxBuffer = buf.length - pos <= 2 * 1024 * 1024 ? buf.slice(pos) : new Uint8Array(0);
    } else {
      ws._rxBuffer = new Uint8Array(0);
    }
  }

  return messages;
}

// ============================================================================
// 4. Malha Serverless Multi-Broker em Paralelo + Protocolo Gossip de @usuarios
// ============================================================================
function broadcastToMesh(packet) {
  const pktId = crypto.randomUUID();
  seenPacketIds.add(pktId);

  const enriched = {
    ...packet,
    pktId,
    senderNodeId: state.nodeId,
    senderTag: state.myTag,
    timestamp: Date.now()
  };

  if (localMeshChannel) {
    try {
      localMeshChannel.postMessage(enriched);
    } catch {}
  }

  const mqttFrame = buildMqttPublishPacket(MESH_TOPIC, enriched);
  for (const ws of brokerSockets.values()) {
    if (ws && ws.readyState === WebSocket.OPEN && ws._mqttConnected) {
      try {
        ws.send(mqttFrame);
      } catch {}
    }
  }
}

function updateConnectionFlag() {
  let anyOpen = false;
  for (const ws of brokerSockets.values()) {
    if (ws && ws.readyState === WebSocket.OPEN && ws._mqttConnected) {
      anyOpen = true;
      break;
    }
  }
  if (state.connected !== anyOpen) {
    state.connected = anyOpen;
    broadcastState();
  }
}

function connectSingleBroker(brokerUrl) {
  const existing = brokerSockets.get(brokerUrl);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let ws;
  try {
    ws = new WebSocket(brokerUrl, 'mqtt');
    ws.binaryType = 'arraybuffer';
    ws._mqttConnected = false;
    ws._rxBuffer = new Uint8Array(0);
    brokerSockets.set(brokerUrl, ws);
  } catch {
    setTimeout(() => connectSingleBroker(brokerUrl), 4000);
    return;
  }

  ws.onopen = () => {
    ws._rxBuffer = new Uint8Array(0);
    const clientId = `ps_${state.nodeId.slice(0, 8)}_${Math.floor(1000 + Math.random() * 8999)}`;
    ws.send(buildMqttConnectPacket(clientId));
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const packets = parseMqttIncomingPackets(event.data, ws);

    for (const pkt of packets) {
      if (pkt.mqttEvent === 'CONNACK') {
        ws._mqttConnected = true;
        ws.send(buildMqttSubscribePacket(MESH_TOPIC));
        updateConnectionFlag();
        announcePresenceToMesh();
      } else if (pkt.mqttEvent === 'PUBLISH' && pkt.data) {
        handleMeshPacket(pkt.data);
      }
    }
  };

  ws.onclose = () => {
    ws._mqttConnected = false;
    ws._rxBuffer = new Uint8Array(0);
    brokerSockets.delete(brokerUrl);
    updateConnectionFlag();
    setTimeout(() => connectSingleBroker(brokerUrl), 3500);
  };

  ws.onerror = () => {
    ws._mqttConnected = false;
  };
}

function connectPublicMesh() {
  for (const brokerUrl of PUBLIC_WSS_BROKERS) {
    connectSingleBroker(brokerUrl);
  }

  if (!pingInterval) {
    pingInterval = setInterval(() => {
      for (const ws of brokerSockets.values()) {
        if (ws && ws.readyState === WebSocket.OPEN && ws._mqttConnected) {
          try {
            ws.send(new Uint8Array([0xc0, 0x00]));
          } catch {}
        }
      }
      touchSelfInRegistry();
      refreshPeerStatuses();
      broadcastToMesh({
        meshType: 'ROSTER_GOSSIP_SYNC',
        roster: Object.values(state.peerRegistry)
      });
      broadcastState();
    }, 15000);
  }
}

function refreshPeerStatuses() {
  const now = Date.now();
  let changed = false;
  for (const [tag, peer] of Object.entries(state.peerRegistry)) {
    if (tag === state.myTag) {
      peer.status = 'online';
      peer.lastSeen = now;
      continue;
    }
    const diff = now - (peer.lastSeen || 0);
    const newStatus = diff < 45000 ? 'online' : (diff < 180000 ? 'away' : 'offline');
    if (peer.status !== newStatus) {
      peer.status = newStatus;
      changed = true;
    }
  }
  if (changed) {
    chrome.storage.local.set({ peerRegistry: state.peerRegistry });
    broadcastState();
  }
}

function touchSelfInRegistry(previousTag = null) {
  if (!state.myTag) return;
  const now = Date.now();

  if (previousTag && previousTag !== state.myTag && state.peerRegistry[previousTag]?.nodeId === state.nodeId) {
    delete state.peerRegistry[previousTag];
  }

  const existing = state.peerRegistry[state.myTag];
  const registeredAt = existing?.registeredAt || existing?.joinedAt || now;
  const regHash = existing?.regHash || ('0x' + (existing?.nodeId || state.nodeId).replace(/[^a-f0-9]/gi, '').slice(0, 16));

  state.peerRegistry[state.myTag] = {
    tag: state.myTag,
    nodeId: state.nodeId,
    registeredAt,
    regHash,
    joinedAt: registeredAt,
    lastSeen: now,
    status: 'online',
    relayEnabled: state.meshRelayEnabled !== false,
    relayBandwidthLimitKbps: typeof state.relayBandwidthLimitKbps === 'number' ? state.relayBandwidthLimitKbps : 2048,
    activeRoutes: Number(state.activeRelayedRoutes || 0)
  };

  chrome.storage.local.set({ peerRegistry: state.peerRegistry });
}

function mergeRemoteRoster(incomingRoster, removedTag = null, originNodeId = null) {
  let changed = false;

  if (removedTag && state.peerRegistry[removedTag] && state.peerRegistry[removedTag].nodeId === originNodeId) {
    delete state.peerRegistry[removedTag];
    changed = true;
  }

  if (!Array.isArray(incomingRoster)) return changed;
  const now = Date.now();

  for (const item of incomingRoster) {
    if (!item || typeof item.tag !== 'string' || !item.tag.startsWith('@') || item.tag.startsWith('@link_')) {
      continue;
    }

    const diff = now - (item.lastSeen || 0);

    // Se o usuário foi excluído localmente, previne re-adição a menos que volte a ficar online com nova atividade
    if (state.deletedTags && state.deletedTags[item.tag]) {
      const deletedAt = state.deletedTags[item.tag];
      const isOnline = diff < 45000;
      if (!isOnline || (item.lastSeen || 0) <= deletedAt + 5000) {
        continue;
      }
      delete state.deletedTags[item.tag];
      chrome.storage.local.set({ deletedTags: state.deletedTags });
    }

    if (item.nodeId && item.nodeId !== state.nodeId) {
      for (const [tagKey, entry] of Object.entries(state.peerRegistry)) {
        if (entry.nodeId === item.nodeId && tagKey !== item.tag && (item.lastSeen || 0) > (entry.lastSeen || 0)) {
          delete state.peerRegistry[tagKey];
          changed = true;
        }
      }
    }

    if (item.tag === state.myTag && item.nodeId && item.nodeId !== state.nodeId) {
      const myEntry = state.peerRegistry[state.myTag];
      const myRegAt = myEntry?.registeredAt || myEntry?.joinedAt || 0;
      const remoteRegAt = item.registeredAt || item.joinedAt || 0;
      if (remoteRegAt < myRegAt && remoteRegAt > 0) {
        safeSendMessage({
          type: 'USER_REGISTRATION_CONFLICT',
          tag: state.myTag,
          error: `O usuário ${state.myTag} já existe na rede descentralizada e pertence a outro nó!`
        }).catch(() => {});
      }
      continue;
    }

    const local = state.peerRegistry[item.tag];
    const computedStatus = diff < 45000 ? 'online' : (diff < 180000 ? 'away' : 'offline');
    const registeredAt = item.registeredAt || item.joinedAt || now;
    const regHash = item.regHash || '';

    if (!local) {
      state.peerRegistry[item.tag] = {
        tag: item.tag,
        nodeId: item.nodeId || '',
        registeredAt,
        regHash,
        joinedAt: registeredAt,
        lastSeen: item.lastSeen || now,
        status: computedStatus,
        relayEnabled: typeof item.relayEnabled === 'boolean' ? item.relayEnabled : true,
        relayBandwidthLimitKbps: typeof item.relayBandwidthLimitKbps === 'number' ? item.relayBandwidthLimitKbps : 2048,
        activeRoutes: Number(item.activeRoutes || 0)
      };
      changed = true;
    } else if ((item.lastSeen || 0) > (local.lastSeen || 0)) {
      state.peerRegistry[item.tag] = {
        ...local,
        nodeId: item.nodeId || local.nodeId,
        registeredAt: local.registeredAt || registeredAt,
        regHash: local.regHash || regHash,
        lastSeen: item.lastSeen,
        status: computedStatus,
        relayEnabled: typeof item.relayEnabled === 'boolean' ? item.relayEnabled : local.relayEnabled,
        relayBandwidthLimitKbps: typeof item.relayBandwidthLimitKbps === 'number' ? item.relayBandwidthLimitKbps : (typeof local.relayBandwidthLimitKbps === 'number' ? local.relayBandwidthLimitKbps : 2048),
        activeRoutes: Number(item.activeRoutes ?? local.activeRoutes ?? 0)
      };
      changed = true;
    }
  }

  if (changed) {
    chrome.storage.local.set({ peerRegistry: state.peerRegistry });
    broadcastState();
  }

  return changed;
}

function announcePresenceToMesh(previousTag = null) {
  touchSelfInRegistry(previousTag);
  broadcastState();

  broadcastToMesh({
    meshType: 'PEER_ANNOUNCE',
    previousTag,
    roster: Object.values(state.peerRegistry)
  });
}

function scheduleGossipRosterBroadcast() {
  clearTimeout(gossipDebounceTimer);
  gossipDebounceTimer = setTimeout(() => {
    touchSelfInRegistry();
    broadcastToMesh({
      meshType: 'ROSTER_GOSSIP_SYNC',
      roster: Object.values(state.peerRegistry)
    });
  }, 150);
}

function findBestRelayNode(senderTag, targetTag, triedRelays = new Set()) {
  const now = Date.now();
  const candidates = Object.values(state.peerRegistry).filter((p) => {
    return (
      p.tag &&
      p.tag !== senderTag &&
      p.tag !== targetTag &&
      !triedRelays.has(p.tag) &&
      p.relayEnabled !== false &&
      (p.status === 'online' || now - (p.lastSeen || 0) < 45000)
    );
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const routesA = a.activeRoutes || 0;
    const routesB = b.activeRoutes || 0;
    if (routesA !== routesB) return routesA - routesB;

    const bwA = typeof a.relayBandwidthLimitKbps === 'number' ? a.relayBandwidthLimitKbps : 2048;
    const bwB = typeof b.relayBandwidthLimitKbps === 'number' ? b.relayBandwidthLimitKbps : 2048;
    const effBwA = bwA === 0 ? Infinity : bwA;
    const effBwB = bwB === 0 ? Infinity : bwB;
    if (effBwA !== effBwB) return effBwB - effBwA;

    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return candidates[0];
}

function setupDirectRouteFallback(transferId, targetTag, fileMeta) {
  if (routeFallbackTimers.has(transferId)) {
    clearTimeout(routeFallbackTimers.get(transferId));
  }
  const timer = setTimeout(() => {
    routeFallbackTimers.delete(transferId);
    const t = state.transfers[transferId];
    if (t && (t.status === 'CONNECTING' || t.status === 'AWAITING_ACCEPT') && t.routeType === 'DIRECT') {
      tryFailoverToMeshRelay(transferId, targetTag, fileMeta);
    }
  }, 7000);
  routeFallbackTimers.set(transferId, timer);
}

async function tryFailoverToMeshRelay(transferId, targetTag, fileMeta, triedRelaysSet = null) {
  const t = state.transfers[transferId];
  if (!t || t.status === 'COMPLETED' || t.status === 'CANCELLED') return;

  const normMeta = {
    name: fileMeta?.name || fileMeta?.fileName || t.fileName || 'arquivo',
    size: fileMeta?.size ?? fileMeta?.fileSize ?? t.fileSize ?? 0,
    type: fileMeta?.type || fileMeta?.fileType || t.fileType || 'application/octet-stream',
    ...pickBatchMeta(fileMeta || t)
  };

  const tried = triedRelaysSet || new Set(t.triedRelays || []);
  const bestRelay = findBestRelayNode(state.myTag, targetTag, tried);

  if (!bestRelay) {
    if (t.status === 'CONNECTING' || t.status === 'TRANSFERRING') {
      updateTransfer(transferId, {
        routeType: 'MESH_RELAY',
        relayTag: targetTag,
        routeDescription: 'Transmitindo via túnel mesh (fallback CGNAT/Firewall)...',
        status: 'TRANSFERRING'
      });
      await ensureOffscreenDocument();
      safeSendMessage({
        target: 'offscreen',
        action: 'START_MESH_RELAY_STREAM',
        transferId,
        relayTag: targetTag,
        targetTag,
        directToTarget: true,
        fileKey: transferId,
        fallbackKey: transferId
      });
      return;
    }
    sendSignal(targetTag, transferId, 'FILE_OFFER', {
      fileName: normMeta.name,
      fileSize: normMeta.size,
      fileType: normMeta.type,
      ...pickBatchMeta(normMeta),
      roster: Object.values(state.peerRegistry)
    });
    updateTransfer(transferId, {
      routeDescription: 'Aguardando aceitação do destinatário na malha P2P...'
    });
    return;
  }

  tried.add(bestRelay.tag);
  t.triedRelays = Array.from(tried);

  updateTransfer(transferId, {
    routeType: 'MESH_RELAY',
    relayTag: bestRelay.tag,
    routeDescription: `Roteando via malha mesh (Nó ${bestRelay.tag})...`,
    status: 'CONNECTING'
  });

  sendSignal(bestRelay.tag, transferId, 'MESH_RELAY_REQUEST', {
    targetTag,
    senderTag: state.myTag,
    fileMeta: normMeta,
    triedRelays: Array.from(tried)
  });

  if (routeFallbackTimers.has(transferId)) {
    clearTimeout(routeFallbackTimers.get(transferId));
  }
  const relayTimeout = setTimeout(() => {
    routeFallbackTimers.delete(transferId);
    const curr = state.transfers[transferId];
    if (curr && curr.status === 'CONNECTING' && curr.routeType === 'MESH_RELAY' && curr.relayTag === bestRelay.tag) {
      tryFailoverToMeshRelay(transferId, targetTag, normMeta, tried);
    }
  }, 6000);
  routeFallbackTimers.set(transferId, relayTimeout);
}

function processRelayQueue(session) {
  if (!session || session.processing || session.queue.length === 0) return;
  session.processing = true;

  const chunkItem = session.queue.shift();
  const rawBytes = Math.round((chunkItem.chunkBase64?.length || 0) * 0.75);
  session.bytesForwarded = (session.bytesForwarded || 0) + rawBytes;
  state.relayedBytesTotal = (state.relayedBytesTotal || 0) + rawBytes;
  chrome.storage.local.set({ relayedBytesTotal: state.relayedBytesTotal });

  const relayCard = state.transfers[`relay_${session.transferId}`];
  if (relayCard) {
    relayCard.transferredBytes = session.bytesForwarded;
    relayCard.progress = chunkItem.totalBytes > 0 ? Math.min(100, Math.round((session.bytesForwarded / chunkItem.totalBytes) * 100)) : 50;
    relayCard.updatedAt = Date.now();
  }

  sendSignal(session.targetTag, session.transferId, 'MESH_RELAY_CHUNK', {
    from: session.senderTag,
    transferId: session.transferId,
    relayTag: state.myTag,
    chunkSeq: chunkItem.chunkSeq,
    totalChunks: chunkItem.totalChunks,
    chunkBase64: chunkItem.chunkBase64,
    isEof: chunkItem.isEof,
    totalBytes: chunkItem.totalBytes,
    fileMeta: session.fileMeta
  });

  if (chunkItem.isEof) {
    setTimeout(() => {
      activeRelaySessions.delete(session.transferId);
      state.activeRelayedRoutes = activeRelaySessions.size;
      if (relayCard) {
        relayCard.status = 'COMPLETED';
        relayCard.progress = 100;
      }
      broadcastState();
    }, 1000);
    session.processing = false;
    return;
  }

  let delayMs = 15;
  if (session.bwLimit > 0) {
    delayMs = Math.max(15, Math.round((rawBytes / (session.bwLimit * 1024)) * 1000));
  } else {
    delayMs = 0;
  }

  setTimeout(() => {
    session.processing = false;
    processRelayQueue(session);
  }, delayMs);
}

async function handleMeshPacket(packet) {
  if (!packet || packet.senderNodeId === state.nodeId) return;

  // Deduplica pacotes recebidos por múltiplos brokers simultaneamente
  const pktId = packet.pktId || packet.packetId;
  if (pktId) {
    if (seenPacketIds.has(pktId)) return;
    seenPacketIds.add(pktId);
    if (seenPacketIds.size > 2000) {
      const first = seenPacketIds.values().next().value;
      seenPacketIds.delete(first);
    }
  }

  // Alimenta o motor descentralizado P2P (Kademlia, AODV, Reticulum, Yggdrasil, CRDT, DTN, libp2p)
  if (meshEngine.initialized) {
    meshEngine.handleIncomingMeshPacket(packet, packet.senderTag);
    if (packet.senderNodeId && packet.senderTag) {
      meshEngine.kademlia.updateNode(packet.senderNodeId, { tag: packet.senderTag, lastSeen: Date.now() });
      meshEngine.crdt.add(packet.senderTag, { tag: packet.senderTag, nodeId: packet.senderNodeId, lastSeen: Date.now() });
    }
  }

  switch (packet.meshType) {
    case 'PEER_ANNOUNCE': {
      mergeRemoteRoster(packet.roster, packet.previousTag, packet.senderNodeId);
      scheduleGossipRosterBroadcast();
      break;
    }

    case 'ROSTER_GOSSIP_SYNC': {
      mergeRemoteRoster(packet.roster);
      break;
    }

    case 'PROBE_USER_EXISTS': {
      if (packet.tag && packet.requesterNodeId !== state.nodeId) {
        const checkTag = normalizeTag(packet.tag);
        const myNorm = normalizeTag(state.myTag);

        let exists = false;
        let ownerNodeId = '';

        if (myNorm && myNorm === checkTag) {
          exists = true;
          ownerNodeId = state.nodeId;
        } else {
          const found = Object.values(state.peerRegistry).find(
            (p) => p.tag && normalizeTag(p.tag) === checkTag && p.nodeId !== packet.requesterNodeId
          );
          if (found) {
            exists = true;
            ownerNodeId = found.nodeId;
          }
        }

        if (exists) {
          broadcastToMesh({
            meshType: 'PROBE_USER_EXISTS_REPLY',
            probeId: packet.probeId,
            tag: packet.tag,
            ownerNodeId,
            exists: true
          });
        }
      }
      break;
    }

    case 'PROBE_USER_EXISTS_REPLY': {
      if (packet.probeId && pendingProbes.has(packet.probeId)) {
        const resolveFn = pendingProbes.get(packet.probeId);
        if (resolveFn) resolveFn(Boolean(packet.exists));
      }
      break;
    }

    case 'USER_REGISTERED': {
      if (!packet.tag || typeof packet.tag !== 'string') break;
      const incomingTag = normalizeTag(packet.tag);
      const incomingNodeId = packet.nodeId;
      const incomingRegAt = packet.registeredAt || Date.now();
      const incomingRegHash = packet.regHash || '';

      // Conflito com meu próprio tag em outro nó
      if (incomingTag === normalizeTag(state.myTag) && incomingNodeId && incomingNodeId !== state.nodeId) {
        const myEntry = state.peerRegistry[state.myTag];
        const myRegAt = myEntry?.registeredAt || myEntry?.joinedAt || 0;

        if (incomingRegAt < myRegAt && incomingRegAt > 0) {
          safeSendMessage({
            type: 'USER_REGISTRATION_CONFLICT',
            tag: incomingTag,
            error: `O usuário ${incomingTag} já existe na rede descentralizada (pertence a outro nó).`
          }).catch(() => {});
        } else {
          broadcastToMesh({
            meshType: 'USER_CONFLICT_ALERT',
            tag: state.myTag,
            ownerNodeId: state.nodeId,
            registeredAt: myRegAt,
            regHash: myEntry?.regHash || ''
          });
        }
      }

      // Adiciona o usuário na lista descentralizada de todos os nós
      if (incomingNodeId && incomingNodeId !== state.nodeId) {
        state.peerRegistry[incomingTag] = {
          tag: incomingTag,
          nodeId: incomingNodeId,
          registeredAt: incomingRegAt,
          regHash: incomingRegHash,
          joinedAt: incomingRegAt,
          lastSeen: Date.now(),
          status: 'online',
          relayEnabled: packet.relayEnabled !== false,
          relayBandwidthLimitKbps: typeof packet.relayBandwidthLimitKbps === 'number' ? packet.relayBandwidthLimitKbps : 2048,
          activeRoutes: 0
        };

        if (packet.previousTag && packet.previousTag !== incomingTag && state.peerRegistry[packet.previousTag]?.nodeId === incomingNodeId) {
          delete state.peerRegistry[packet.previousTag];
        }

        chrome.storage.local.set({ peerRegistry: state.peerRegistry });
        broadcastState();
      }

      if (Array.isArray(packet.roster)) {
        mergeRemoteRoster(packet.roster);
      }
      break;
    }

    case 'USER_CONFLICT_ALERT': {
      if (!packet.tag) break;
      const alertTag = normalizeTag(packet.tag);
      if (alertTag === normalizeTag(state.myTag) && packet.ownerNodeId !== state.nodeId) {
        safeSendMessage({
          type: 'USER_REGISTRATION_CONFLICT',
          tag: alertTag,
          error: `O usuário ${alertTag} já existe na rede descentralizada e pertence a outro nó!`
        }).catch(() => {});
      }
      break;
    }

    case 'DIRECT_SIGNAL': {
      const toNorm = packet.to ? normalizeTag(packet.to) : '';
      const myNorm = state.myTag ? normalizeTag(state.myTag) : '';
      const shareId = packet.payload?.shareId;
      const isMyShare = Boolean(
        (shareId &&
          (publicP2PShares.has(shareId) ||
            state.transfers[shareId] ||
            Object.values(state.transfers).some((t) => t.shareId === shareId))) ||
          (typeof packet.transferId === 'string' &&
            Array.from(publicP2PShares.keys()).some((sid) => packet.transferId.startsWith(sid)))
      );

      if (packet.to !== state.myTag && (!toNorm || toNorm !== myNorm) && !isMyShare) return;

      if (packet.senderTag && !packet.senderTag.startsWith('@link_')) {
        mergeRemoteRoster([
          {
            tag: packet.senderTag,
            nodeId: packet.senderNodeId,
            lastSeen: Date.now(),
            status: 'online'
          }
        ]);
      }

      await handleIncomingSignal({
        from: packet.senderTag,
        transferId: packet.transferId,
        signalType: packet.signalType,
        payload: packet.payload
      });
      break;
    }
  }
}

// ============================================================================
// 5. Gerenciamento do Offscreen Document e Sincronização de Estado
// ============================================================================

// Envia mensagem sem gerar "Uncaught (in promise) Error: Could not establish
// connection. Receiving end does not exist." quando o popup está fechado ou o
// offscreen document ainda não está pronto.
function safeSendMessage(message, retries = 6) {
  try {
    return chrome.runtime
      .sendMessage(message)
      .then((res) => {
        if (message?.target === 'offscreen' && (!res || !res.ok) && retries > 0) {
          return new Promise((resolve) => {
            setTimeout(async () => {
              await ensureOffscreenDocument();
              resolve(safeSendMessage(message, retries - 1));
            }, 150);
          });
        }
        return res;
      })
      .catch((err) => {
        if (message?.target === 'offscreen' && retries > 0) {
          return new Promise((resolve) => {
            setTimeout(async () => {
              await ensureOffscreenDocument();
              resolve(safeSendMessage(message, retries - 1));
            }, 150);
          });
        }
        console.warn('[PulseShare] Mensagem sem destinatário:', message?.action || message?.type, err?.message || err);
      });
  } catch (err) {
    console.warn('[PulseShare] Falha ao enviar mensagem:', err?.message || err);
    return Promise.resolve();
  }
}

function broadcastState() {
  if (meshEngine.initialized) {
    state.meshEngineSummary = meshEngine.getStatusSummary();
  }
  chrome.storage.local.set({
    transfers: state.transfers,
    peerRegistry: state.peerRegistry,
    deletedTags: state.deletedTags || {},
    meshEngineSummary: state.meshEngineSummary
  });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATED', action: 'STATE_UPDATED', state }).catch(() => {});
}

function updateTransfer(transferId, patch) {
  const existing = state.transfers[transferId];
  if (!existing) return;

  const mergedPatch = { ...patch };

  // Se houver lista de arquivos na remessa e o patch trouxer progresso de um arquivo específico
  if (Array.isArray(existing.files) && existing.files.length > 0 && patch.fileId) {
    const updatedFiles = existing.files.map((f) => {
      if (f.fileId === patch.fileId) {
        const fileTransferred = typeof patch.fileTransferredBytes === 'number'
          ? patch.fileTransferredBytes
          : (typeof patch.transferredBytes === 'number' ? patch.transferredBytes : (f.transferredBytes || 0));
        const fileSize = f.size || patch.fileTotalBytes || 0;
        const filePct = fileSize > 0
          ? Math.min(100, Math.round((fileTransferred / fileSize) * 100))
          : (patch.fileCompleted ? 100 : 0);
        return {
          ...f,
          transferredBytes: fileTransferred,
          progress: filePct,
          speedBps: patch.fileSpeedBps ?? patch.speedBps ?? 0,
          status: (patch.fileCompleted || filePct >= 100)
            ? 'COMPLETED'
            : (patch.status === 'PAUSED' ? 'PAUSED' : 'TRANSFERRING')
        };
      }
      return f;
    });

    mergedPatch.files = updatedFiles;

    // Calcula progresso GERAL somando todos os arquivos da remessa
    const totalPackBytes = existing.totalSize || existing.fileSize || updatedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
    const totalPackTransferred = updatedFiles.reduce((acc, f) => acc + (f.transferredBytes || 0), 0);
    const overallPct = totalPackBytes > 0
      ? Math.min(100, Math.round((totalPackTransferred / totalPackBytes) * 100))
      : 0;

    const allFilesCompleted = updatedFiles.every((f) => (f.progress || 0) >= 100 || f.status === 'COMPLETED');

    mergedPatch.transferredBytes = totalPackTransferred;
    mergedPatch.progress = overallPct;
    mergedPatch.speedBps = patch.speedBps || patch.fileSpeedBps || 0;

    if (allFilesCompleted) {
      if (existing.inProgress) {
        // Contabiliza 1 download quando concluir o download de todo envio da remessa!
        mergedPatch.downloads = (existing.downloads || 0) + 1;
        mergedPatch.completedDownloads = (existing.completedDownloads || 0) + 1;
      }
      const maxDl = Number(existing.maxDownloads || 0);
      const currentDownloads = mergedPatch.completedDownloads !== undefined ? mergedPatch.completedDownloads : (existing.completedDownloads || 0);
      const isLimitReached = maxDl > 0 && currentDownloads >= maxDl;

      mergedPatch.status = (existing.direction === 'tunnel' && !isLimitReached) ? 'TUNNEL_READY' : 'COMPLETED';
      mergedPatch.inProgress = false;
      mergedPatch.progress = 100;
      mergedPatch.transferredBytes = totalPackBytes;

      if (isLimitReached && existing.shareId) {
        publicP2PShares.delete(existing.shareId);
        if (fileBridgeChannel) {
          fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId: existing.shareId });
        }
        ensureOffscreenDocument().then(() => {
          safeSendMessage({
            target: 'offscreen',
            action: 'OFFSCREEN_CONTROL',
            subAction: 'CANCEL',
            transferId: existing.id
          });
        });
        broadcastToMesh({
          meshType: 'DIRECT_SIGNAL',
          signalType: 'PACK_INFO_RESPONSE',
          transferId: existing.shareId,
          payload: {
            ok: false,
            error: 'DOWNLOAD_LIMIT_REACHED',
            message: 'O limite de downloads deste link foi atingido.'
          }
        });
      }
    } else {
      mergedPatch.status = patch.status === 'PAUSED' ? 'PAUSED' : 'TRANSFERRING';
      mergedPatch.inProgress = true;
    }
  } else if (existing.direction === 'tunnel') {
    if (patch.inProgress === true || patch.status === 'TRANSFERRING' || patch.status === 'CONNECTING') {
      mergedPatch.inProgress = true;
    }
    // Quando a transferência de um link de arquivo único for concluída
    if (patch.fileCompleted || patch.progress === 100 || (existing.inProgress && (patch.status === 'TUNNEL_READY' || patch.status === 'COMPLETED'))) {
      if (existing.inProgress && patch.completedDownloads === undefined) {
        mergedPatch.downloads = (existing.downloads || 0) + 1;
        mergedPatch.completedDownloads = (existing.completedDownloads || 0) + 1;
        mergedPatch.inProgress = false;
      }
      const maxDl = Number(existing.maxDownloads || 0);
      const currentDownloads = mergedPatch.completedDownloads !== undefined
        ? mergedPatch.completedDownloads
        : (existing.completedDownloads || 0);
      if (maxDl > 0 && currentDownloads >= maxDl) {
        mergedPatch.status = 'COMPLETED';
        if (existing.shareId) {
          publicP2PShares.delete(existing.shareId);
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId: existing.shareId });
          }
          ensureOffscreenDocument().then(() => {
            safeSendMessage({
              target: 'offscreen',
              action: 'OFFSCREEN_CONTROL',
              subAction: 'CANCEL',
              transferId: existing.id
            });
          });
          broadcastToMesh({
            meshType: 'DIRECT_SIGNAL',
            signalType: 'PACK_INFO_RESPONSE',
            transferId: existing.shareId,
            payload: {
              ok: false,
              error: 'DOWNLOAD_LIMIT_REACHED',
              message: 'O limite de downloads deste link foi atingido.'
            }
          });
        }
      }
    }
    if (patch.status === 'CANCELLED' || patch.status === 'ERROR' || patch.status === 'EXPIRED') {
      mergedPatch.inProgress = false;
    }
  }

  state.transfers[transferId] = {
    ...existing,
    ...mergedPatch,
    updatedAt: Date.now()
  };
  broadcastState();
}

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return true;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return true;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['WEB_RTC', 'BLOBS'],
      justification: 'Manter WebRTC DataChannel P2P e referências de arquivos grandes (+110MB) em segundo plano.'
    })
    .catch(() => {})
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
  return true;
}

// ============================================================================
// 6. Negociação de Transferência P2P e Abertura Automática da Extensão
// ============================================================================
function sendSignal(to, transferId, signalType, payload) {
  broadcastToMesh({
    meshType: 'DIRECT_SIGNAL',
    to,
    transferId,
    signalType,
    payload
  });
  return true;
}

// Metadados de lote (envio de vários arquivos/pastas de uma só vez). Permitem que o
// destinatário agrupe as ofertas pendentes em árvore e aceite/recuse em massa.
function pickBatchMeta(source) {
  if (!source || !source.batchId) return {};
  return {
    batchId: String(source.batchId),
    batchName: source.batchName ? String(source.batchName) : '',
    batchCount: Number(source.batchCount) || 0
  };
}

async function startOutgoingTransfer(transferId, targetTag, fileMeta) {
  const batchMeta = pickBatchMeta(fileMeta);
  state.transfers[transferId] = {
    id: transferId,
    direction: 'outgoing',
    peerTag: targetTag,
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type,
    ...batchMeta,
    progress: 0,
    transferredBytes: 0,
    speedBps: 0,
    status: 'AWAITING_ACCEPT',
    routeType: 'DIRECT',
    triedRelays: [],
    updatedAt: Date.now()
  };
  broadcastState();

  await ensureExtensionPopupOpen(`?window=1&target=${encodeURIComponent(targetTag)}`);

  sendSignal(targetTag, transferId, 'FILE_OFFER', {
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type,
    ...batchMeta,
    roster: Object.values(state.peerRegistry)
  });

  setupDirectRouteFallback(transferId, targetTag, fileMeta);
}

async function handleIncomingSignal(msg) {
  const { from, transferId, signalType, payload } = msg;

  if (payload?.roster) {
    mergeRemoteRoster(payload.roster);
  }

  if (signalType === 'PACK_INFO_REQUEST') {
    const shareId = payload?.shareId;
    const transfer =
      state.transfers[shareId] ||
      Object.values(state.transfers).find((t) => t.shareId === shareId);

    if (!transfer) {
      sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
        ok: false,
        error: 'NOT_FOUND',
        message: 'Túnel não encontrado ou encerrado.'
      });
      return;
    }

    if (
      transfer.status === 'EXPIRED' ||
      (transfer.expiresAt && Date.now() >= transfer.expiresAt)
    ) {
      sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
        ok: false,
        error: 'EXPIRED',
        message: 'Este túnel temporário expirou.'
      });
      return;
    }

    if (
      transfer.status === 'COMPLETED' ||
      (transfer.maxDownloads > 0 && (transfer.completedDownloads || 0) >= transfer.maxDownloads)
    ) {
      sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
        ok: false,
        error: 'DOWNLOAD_LIMIT_REACHED',
        message: 'O limite de downloads deste link foi atingido.'
      });
      return;
    }

    if (transfer.status === 'PAUSED') {
      sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
        ok: false,
        error: 'PAUSED',
        message: 'O remetente pausou este túnel temporariamente.'
      });
      return;
    }

    if (transfer.status === 'CANCELLED') {
      sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
        ok: false,
        error: 'CANCELLED',
        message: 'O compartilhamento foi cancelado pelo remetente.'
      });
      return;
    }

    sendSignal(from, transferId || shareId, 'PACK_INFO_RESPONSE', {
      ok: true,
      shareId: transfer.shareId,
      packName: transfer.packName,
      totalSize: transfer.totalSize,
      files: transfer.files,
      hasPassword: transfer.hasPassword,
      passwordSalt: transfer.passwordSalt,
      passwordHash: transfer.passwordHash,
      expiresAt: transfer.expiresAt,
      ownerTag: state.myTag
    });
    return;
  }

  if (signalType === 'PACK_DOWNLOAD_COMPLETE') {
    const shareId = payload?.shareId;
    let shareRecord = publicP2PShares.get(shareId);
    if (!shareRecord) {
      const found = Object.values(state.transfers).find((t) => t.shareId === shareId);
      if (found) shareRecord = { transferId: found.id };
    }
    if (shareRecord) {
      const parentTransfer = state.transfers[shareRecord.transferId];
      if (parentTransfer) {
        const shouldIncrement = Boolean(parentTransfer.inProgress) || (parentTransfer.completedDownloads || 0) === 0;
        const newCompleted = shouldIncrement
          ? (parentTransfer.completedDownloads || 0) + 1
          : (parentTransfer.completedDownloads || 0);
        const newDownloads = shouldIncrement
          ? (parentTransfer.downloads || 0) + 1
          : (parentTransfer.downloads || 0);
        const maxDl = Number(parentTransfer.maxDownloads || 0);
        const isLimitReached = maxDl > 0 && newCompleted >= maxDl;

        updateTransfer(shareRecord.transferId, {
          downloads: newDownloads,
          completedDownloads: newCompleted,
          inProgress: false,
          progress: 100,
          status: isLimitReached ? 'COMPLETED' : 'TUNNEL_READY',
          transferredBytes: parentTransfer.totalSize || parentTransfer.fileSize || parentTransfer.transferredBytes
        });

        if (isLimitReached) {
          publicP2PShares.delete(shareId);
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId });
          }
          ensureOffscreenDocument().then(() => {
            safeSendMessage({
              target: 'offscreen',
              action: 'OFFSCREEN_CONTROL',
              subAction: 'CANCEL',
              transferId: parentTransfer.id
            });
          });
          broadcastToMesh({
            meshType: 'DIRECT_SIGNAL',
            signalType: 'PACK_INFO_RESPONSE',
            transferId: shareId,
            payload: {
              ok: false,
              error: 'DOWNLOAD_LIMIT_REACHED',
              message: 'O limite de downloads deste link foi atingido.'
            }
          });
        }
      }
    }
    return;
  }

  if (
    signalType === 'PACK_FILE_PULL' ||
    signalType === 'PUBLIC_LINK_PULL' ||
    signalType === 'TUNNEL_RELAY_PULL'
  ) {
    const shareId = payload?.shareId;
    const fileId = payload?.fileId || 'f-0';
    let shareRecord = publicP2PShares.get(shareId);

    if (!shareRecord) {
      const found = Object.values(state.transfers).find((t) => t.shareId === shareId);
      if (found) {
        shareRecord = {
          shareId,
          transferId: found.id,
          fileName: found.fileName,
          fileSize: found.fileSize,
          fileType: found.fileType,
          files: found.files,
          passwordHash: found.passwordHash,
          expiresAt: found.expiresAt
        };
        publicP2PShares.set(shareId, shareRecord);
      }
    }

    if (!shareRecord) {
      sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Túnel não encontrado' });
      return;
    }

    const parentTransfer = state.transfers[shareRecord.transferId];
    if (parentTransfer) {
      if (
        parentTransfer.status === 'EXPIRED' ||
        (parentTransfer.expiresAt && Date.now() >= parentTransfer.expiresAt)
      ) {
        sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Túnel expirado' });
        return;
      }
      if (
        parentTransfer.status === 'COMPLETED' ||
        (parentTransfer.maxDownloads > 0 && (parentTransfer.completedDownloads || 0) >= parentTransfer.maxDownloads)
      ) {
        sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Limite de downloads atingido' });
        return;
      }
      if (parentTransfer.status === 'PAUSED') {
        sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Túnel pausado pelo remetente' });
        return;
      }
      if (parentTransfer.status === 'CANCELLED') {
        sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Túnel cancelado pelo remetente' });
        return;
      }

      const resetFiles = (!parentTransfer.inProgress && (parentTransfer.progress === 100))
        ? (parentTransfer.files || []).map((f) => ({ ...f, transferredBytes: 0, progress: 0, status: 'PENDING' }))
        : parentTransfer.files;

      updateTransfer(shareRecord.transferId, {
        inProgress: true,
        status: 'TRANSFERRING',
        files: resetFiles,
        progress: (!parentTransfer.inProgress && parentTransfer.progress === 100) ? 0 : parentTransfer.progress,
        transferredBytes: (!parentTransfer.inProgress && parentTransfer.progress === 100) ? 0 : parentTransfer.transferredBytes
      });
    }

    const targetFile =
      (parentTransfer?.files || shareRecord.files || []).find((f) => f.fileId === fileId) || {
        fileId,
        name: shareRecord.fileName,
        size: shareRecord.fileSize,
        type: shareRecord.fileType
      };

    await ensureOffscreenDocument();
    if (signalType === 'TUNNEL_RELAY_PULL') {
      safeSendMessage({
        target: 'offscreen',
        action: 'START_MESH_RELAY_STREAM',
        transferId,
        uiTransferId: shareRecord.transferId,
        relayTag: from,
        targetTag: from,
        directToTarget: true,
        fileId,
        fileKey: `${shareId}:${fileId}`,
        fallbackKey: shareRecord.transferId,
        keepStaged: true
      });
      return;
    }

    safeSendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_SIGNAL',
      from,
      transferId,
      uiTransferId: shareRecord.transferId,
      fileKey: `${shareId}:${fileId}`,
      fallbackKey: shareRecord.transferId,
      keepStaged: true,
      turnConfig: state.turnConfig,
      signalType: 'FILE_ACCEPT',
      payload: {
        fileMeta: targetFile
      },
      roster: Object.values(state.peerRegistry)
    });
    return;
  }

  if (signalType === 'MESH_RELAY_REQUEST') {
    if (state.meshRelayEnabled === false) {
      sendSignal(from, transferId, 'MESH_RELAY_REJECT', {
        reason: 'RELAY_DISABLED',
        targetTag: payload.targetTag,
        fileMeta: payload.fileMeta,
        triedRelays: payload.triedRelays
      });
      return;
    }

    const session = {
      transferId,
      senderTag: payload.senderTag,
      targetTag: payload.targetTag,
      fileMeta: payload.fileMeta,
      bwLimit: typeof state.relayBandwidthLimitKbps === 'number' ? state.relayBandwidthLimitKbps : 2048,
      queue: [],
      processing: false,
      bytesForwarded: 0,
      createdAt: Date.now()
    };
    activeRelaySessions.set(transferId, session);
    state.activeRelayedRoutes = activeRelaySessions.size;

    state.transfers[`relay_${transferId}`] = {
      id: `relay_${transferId}`,
      direction: 'relay',
      routeType: 'RELAY_NODE',
      peerTag: `${payload.senderTag} ➔ ${payload.targetTag}`,
      senderTag: payload.senderTag,
      targetTag: payload.targetTag,
      fileName: payload.fileMeta?.name || 'arquivo',
      fileSize: payload.fileMeta?.size || 0,
      fileType: payload.fileMeta?.type || 'application/octet-stream',
      progress: 0,
      transferredBytes: 0,
      speedBps: 0,
      status: 'TRANSFERRING',
      updatedAt: Date.now()
    };
    broadcastState();

    sendSignal(from, transferId, 'MESH_RELAY_ACCEPTED', {
      targetTag: payload.targetTag,
      relayTag: state.myTag,
      fileMeta: payload.fileMeta
    });

    sendSignal(payload.targetTag, transferId, 'FILE_OFFER', {
      routedVia: state.myTag,
      senderTag: payload.senderTag,
      fileName: payload.fileMeta?.name,
      fileSize: payload.fileMeta?.size,
      fileType: payload.fileMeta?.type,
      ...pickBatchMeta(payload.fileMeta),
      roster: Object.values(state.peerRegistry)
    });
    return;
  }

  if (signalType === 'MESH_RELAY_ACCEPTED') {
    if (routeFallbackTimers.has(transferId)) {
      clearTimeout(routeFallbackTimers.get(transferId));
      routeFallbackTimers.delete(transferId);
    }
    updateTransfer(transferId, {
      routeType: 'MESH_RELAY',
      relayTag: from,
      routeDescription: `Roteando via nó mesh ${from}`,
      status: 'TRANSFERRING'
    });
    await ensureOffscreenDocument();
    safeSendMessage({
      target: 'offscreen',
      action: 'START_MESH_RELAY_STREAM',
      transferId,
      relayTag: from,
      targetTag: payload.targetTag,
      fileKey: transferId,
      fallbackKey: transferId
    });
    return;
  }

  if (signalType === 'MESH_RELAY_REJECT') {
    tryFailoverToMeshRelay(
      transferId,
      payload.targetTag,
      payload.fileMeta,
      new Set(payload.triedRelays || [])
    );
    return;
  }

  if (signalType === 'MESH_RELAY_DATA') {
    const session = activeRelaySessions.get(transferId);
    if (session) {
      session.queue.push(payload);
      processRelayQueue(session);
    }
    return;
  }

  if (signalType === 'MESH_RELAY_CHUNK') {
    await ensureOffscreenDocument();
    safeSendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_RECEIVE_RELAY_CHUNK',
      transferId,
      from: payload.from,
      relayTag: payload.relayTag,
      chunkSeq: payload.chunkSeq,
      totalChunks: payload.totalChunks,
      chunkBase64: payload.chunkBase64,
      isEof: payload.isEof,
      totalBytes: payload.totalBytes,
      fileMeta: payload.fileMeta
    });
    return;
  }

  if (signalType === 'FILE_OFFER') {
    const isRelayed = Boolean(payload.routedVia);
    const peerDisplayTag = isRelayed ? payload.senderTag : from;
    // Uma oferta repetida (ex.: failover para relay) não deve perder o agrupamento do lote
    const previousOffer = state.transfers[transferId];
    const batchMeta = payload.batchId ? pickBatchMeta(payload) : pickBatchMeta(previousOffer);

    state.transfers[transferId] = {
      id: transferId,
      direction: 'incoming',
      peerTag: peerDisplayTag,
      routeType: isRelayed ? 'MESH_RELAY' : 'DIRECT',
      relayTag: payload.routedVia || null,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      fileType: payload.fileType,
      ...batchMeta,
      progress: 0,
      transferredBytes: 0,
      speedBps: 0,
      status: state.autoAccept ? 'CONNECTING' : 'AWAITING_ACCEPT',
      updatedAt: Date.now()
    };
    broadcastState();

    await ensureOffscreenDocument();

    if (state.autoOpenOnReceive !== false) {
      await ensureExtensionPopupOpen('?window=1');
    }

    if (state.autoAccept) {
      if (isRelayed) {
        sendSignal(payload.routedVia, transferId, 'FILE_ACCEPT', {
          isRelayed: true,
          senderTag: payload.senderTag,
          targetTag: state.myTag,
          roster: Object.values(state.peerRegistry)
        });
      } else {
        sendSignal(from, transferId, 'FILE_ACCEPT', {
          roster: Object.values(state.peerRegistry)
        });
      }
    }
    return;
  }

  if (signalType === 'FILE_ACCEPT') {
    if (routeFallbackTimers.has(transferId)) {
      clearTimeout(routeFallbackTimers.get(transferId));
      routeFallbackTimers.delete(transferId);
    }

    if (payload?.isRelayed) {
      // Se este nó é o relé intermediário, repassa o accept para o remetente original
      if (payload.senderTag && payload.senderTag !== state.myTag) {
        sendSignal(payload.senderTag, transferId, 'FILE_ACCEPT', {
          isRelayed: true,
          relayTag: state.myTag,
          targetTag: from,
          roster: Object.values(state.peerRegistry)
        });
        return;
      }
      // Se este nó é o remetente original recebendo confirmação via mesh
      updateTransfer(transferId, {
        status: 'TRANSFERRING',
        routeType: 'MESH_RELAY',
        relayTag: payload.relayTag || from
      });
      await ensureOffscreenDocument();
      safeSendMessage({
        target: 'offscreen',
        action: 'START_MESH_RELAY_STREAM',
        transferId,
        relayTag: payload.relayTag || from,
        targetTag: from,
        fileKey: transferId,
        fallbackKey: transferId
      });
      return;
    }

    const handshakeFallback = setTimeout(() => {
      routeFallbackTimers.delete(transferId);
      const curr = state.transfers[transferId];
      if (
        curr &&
        curr.routeType === 'DIRECT' &&
        (curr.status === 'CONNECTING' || curr.status === 'AWAITING_ACCEPT') &&
        (curr.transferredBytes || 0) === 0
      ) {
        tryFailoverToMeshRelay(transferId, from || curr.peerTag, curr);
      }
    }, 5000);
    routeFallbackTimers.set(transferId, handshakeFallback);
  }

  if (signalType === 'TRANSFER_REJECT') {
    updateTransfer(transferId, {
      status: 'ERROR',
      error: 'Recusado pelo destinatário'
    });
    if (fileBridgeChannel) {
      fileBridgeChannel.postMessage({ type: 'DELETE_FILE_MEMORY', transferId });
    }
    return;
  }

  await ensureOffscreenDocument();
  safeSendMessage({
    target: 'offscreen',
    action: 'OFFSCREEN_SIGNAL',
    from,
    transferId,
    turnConfig: state.turnConfig,
    signalType,
    payload,
    roster: Object.values(state.peerRegistry),
    transferMeta: state.transfers[transferId]
  });
}

function triggerChromeDownload(transferId, url, fileName) {
  const safeName = (fileName || 'arquivo_recebido').replace(/[\\/:*?"<>|]/g, '_');

  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename: `PulseShare/${safeName}`,
        conflictAction: 'uniquify',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== 'number') {
          updateTransfer(transferId, {
            status: 'ERROR',
            error: chrome.runtime.lastError?.message || 'Erro ao salvar download'
          });
          resolve(null);
          return;
        }

        const t = state.transfers[transferId];
        updateTransfer(transferId, {
          status: 'COMPLETED',
          progress: 100,
          transferredBytes: t?.fileSize || 0,
          speedBps: 0,
          downloadId
        });
        resolve(downloadId);
      }
    );
  });
}

// ============================================================================
// 7. Roteador de Mensagens (Popup <-> Service Worker <-> Offscreen)
// ============================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.source === 'offscreen') {
    if (msg.type === 'OFFSCREEN_GET_TURN_CONFIG') {
      sendResponse({ ok: true, turnConfig: state.turnConfig });
      return true;
    } else if (msg.type === 'OFFSCREEN_SEND_SIGNAL') {
      sendSignal(msg.to, msg.transferId, msg.signalType, msg.payload);
    } else if (msg.type === 'OFFSCREEN_PROGRESS') {
      updateTransfer(msg.transferId, msg.patch);
    } else if (msg.type === 'OFFSCREEN_ROSTER_GOSSIP' && Array.isArray(msg.roster)) {
      mergeRemoteRoster(msg.roster);
    } else if (msg.type === 'OFFSCREEN_DIRECT_ROUTE_FAILED') {
      const t = state.transfers[msg.transferId];
      if (t && t.routeType === 'DIRECT') {
        tryFailoverToMeshRelay(msg.transferId, msg.targetTag || t.peerTag, t);
      } else if (msg.uiTransferId && msg.uiTransferId !== msg.transferId && msg.targetTag) {
        const parentT = state.transfers[msg.uiTransferId];
        if (parentT && parentT.direction === 'tunnel') {
          const shareId = parentT.shareId || '';
          const matchFile = (parentT.files || []).find((f) => msg.transferId.includes(`_${f.fileId}_`));
          const fileId = matchFile ? matchFile.fileId : 'f-0';
          safeSendMessage({
            target: 'offscreen',
            action: 'START_MESH_RELAY_STREAM',
            transferId: msg.transferId,
            uiTransferId: msg.uiTransferId,
            relayTag: msg.targetTag,
            targetTag: msg.targetTag,
            directToTarget: true,
            fileId,
            fileKey: `${shareId}:${fileId}`,
            fallbackKey: msg.uiTransferId,
            keepStaged: true
          });
        }
      }
    } else if (msg.type === 'OFFSCREEN_RELAY_CHUNK') {
      if (msg.directToTarget || msg.relayTag === msg.targetTag) {
        sendSignal(msg.targetTag || msg.relayTag, msg.transferId, 'MESH_RELAY_CHUNK', {
          from: state.myTag,
          transferId: msg.transferId,
          relayTag: state.myTag,
          fileId: msg.fileId,
          chunkSeq: msg.chunkSeq,
          totalChunks: msg.totalChunks,
          chunkBase64: msg.chunkBase64,
          isEof: msg.isEof,
          totalBytes: msg.totalBytes,
          fileMeta: msg.fileMeta
        });
      } else {
        sendSignal(msg.relayTag, msg.transferId, 'MESH_RELAY_DATA', {
          chunkSeq: msg.chunkSeq,
          totalChunks: msg.totalChunks,
          chunkBase64: msg.chunkBase64,
          isEof: msg.isEof,
          totalBytes: msg.totalBytes
        });
      }
      if (!msg.uiTransferId) {
        const rawBytes = Math.round((msg.chunkBase64?.length || 0) * 0.75);
        const t = state.transfers[msg.transferId];
        if (t) {
          t.transferredBytes = (t.transferredBytes || 0) + rawBytes;
          t.progress = msg.totalBytes > 0 ? Math.min(100, Math.round((t.transferredBytes / msg.totalBytes) * 100)) : 50;
          t.updatedAt = Date.now();
          broadcastState();
        }
      }
    } else if (msg.type === 'OFFSCREEN_DOWNLOAD_READY') {
      triggerChromeDownload(msg.transferId, msg.blobUrl, msg.fileName).then(() => {
        setTimeout(() => {
          chrome.runtime
            .sendMessage({ target: 'offscreen', action: 'REVOKE_BLOB_URL', blobUrl: msg.blobUrl })
            .catch(() => {});
        }, 120000);
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  switch (msg.action) {
    case 'GET_STATE':
      ensureOffscreenDocument();
      connectPublicMesh();
      announcePresenceToMesh();
      if (meshEngine.initialized) {
        state.meshEngineSummary = meshEngine.getStatusSummary();
      }
      sendResponse({ state });
      return true;

    case 'GET_MESH_ENGINE_SUMMARY':
      sendResponse({ summary: meshEngine.initialized ? meshEngine.getStatusSummary() : null });
      return true;

    case 'ENSURE_OFFSCREEN':
      ensureOffscreenDocument().then(() => sendResponse({ ok: true }));
      return true;

    case 'REGISTER_USER':
    case 'UPDATE_MY_TAG':
    case 'SET_MY_TAG': {
      handleRegisterUser(msg.tag).then((result) => {
        sendResponse(result);
      });
      return true;
    }

    case 'TOGGLE_AUTO_ACCEPT':
      state.autoAccept = !state.autoAccept;
      chrome.storage.local.set({ autoAccept: state.autoAccept });
      broadcastState();
      sendResponse({ state });
      return true;

    case 'TOGGLE_AUTO_OPEN_ON_RECEIVE':
      state.autoOpenOnReceive = !state.autoOpenOnReceive;
      chrome.storage.local.set({ autoOpenOnReceive: state.autoOpenOnReceive });
      broadcastState();
      sendResponse({ state });
      return true;

    case 'START_SEND_FILE':
      startOutgoingTransfer(msg.transferId, msg.targetTag, msg.fileMeta);
      sendResponse({ ok: true });
      return true;

    case 'ADD_STAGED_TUNNEL_FILES': {
      const incoming = Array.isArray(msg.files) ? msg.files : [];
      if (!Array.isArray(state.stagedTunnelFiles)) state.stagedTunnelFiles = [];
      const existingPaths = new Set(state.stagedTunnelFiles.map((f) => f.diskPath || f.fileId).filter(Boolean));
      for (const f of incoming) {
        const id = f.diskPath || f.fileId;
        if (!id || !existingPaths.has(id)) {
          state.stagedTunnelFiles.push(f);
        }
      }
      state.tunnelModalOpen = true;
      chrome.storage.local.set({
        stagedTunnelFiles: state.stagedTunnelFiles,
        tunnelModalOpen: state.tunnelModalOpen
      });
      updateBadgeForStagedFiles();
      broadcastState();
      sendResponse({ ok: true, state });
      return true;
    }

    case 'REMOVE_STAGED_TUNNEL_FILE': {
      if (Array.isArray(state.stagedTunnelFiles) && typeof msg.index === 'number') {
        state.stagedTunnelFiles.splice(msg.index, 1);
      }
      chrome.storage.local.set({
        stagedTunnelFiles: state.stagedTunnelFiles,
        tunnelModalOpen: state.tunnelModalOpen
      });
      updateBadgeForStagedFiles();
      broadcastState();
      sendResponse({ ok: true, state });
      return true;
    }

    case 'CLEAR_STAGED_TUNNEL_FILES': {
      state.stagedTunnelFiles = [];
      state.tunnelModalOpen = false;
      state.modalMode = 'p2p';
      state.modalTargetTag = '';
      chrome.storage.local.set({
        stagedTunnelFiles: [],
        tunnelModalOpen: false,
        modalMode: 'p2p',
        modalTargetTag: ''
      });
      updateBadgeForStagedFiles();
      broadcastState();
      sendResponse({ ok: true, state });
      return true;
    }

    case 'SET_TUNNEL_MODAL_OPEN': {
      state.tunnelModalOpen = Boolean(msg.open);
      if (msg.mode) state.modalMode = msg.mode;
      if (typeof msg.targetTag === 'string') state.modalTargetTag = msg.targetTag;
      chrome.storage.local.set({
        tunnelModalOpen: state.tunnelModalOpen,
        modalMode: state.modalMode,
        modalTargetTag: state.modalTargetTag
      });
      updateBadgeForStagedFiles();
      broadcastState();
      sendResponse({ ok: true, state });
      return true;
    }

    case 'START_CLOUDFLARE_TUNNEL_SHARE':
    case 'START_PUBLIC_LINK_SHARE':
      state.stagedTunnelFiles = [];
      state.tunnelModalOpen = false;
      chrome.storage.local.set({
        stagedTunnelFiles: [],
        tunnelModalOpen: false
      });
      updateBadgeForStagedFiles();
      startServerlessP2PLinkShare(msg);
      sendResponse({ ok: true, state });
      return true;

    case 'PAUSE_TRANSFER': {
      const t = state.transfers[msg.transferId];
      if (t) {
        t.status = 'PAUSED';
        t.updatedAt = Date.now();
        broadcastState();
        ensureOffscreenDocument().then(() => {
          safeSendMessage({
            target: 'offscreen',
            action: 'OFFSCREEN_CONTROL',
            subAction: 'PAUSE',
            transferId: msg.transferId
          });
        });
      }
      sendResponse({ state });
      return true;
    }

    case 'RESUME_TRANSFER': {
      const t = state.transfers[msg.transferId];
      if (t) {
        t.status = t.direction === 'tunnel' ? 'TUNNEL_READY' : 'TRANSFERRING';
        t.updatedAt = Date.now();
        broadcastState();
        ensureOffscreenDocument().then(() => {
          safeSendMessage({
            target: 'offscreen',
            action: 'OFFSCREEN_CONTROL',
            subAction: 'RESUME',
            transferId: msg.transferId
          });
        });
      }
      sendResponse({ state });
      return true;
    }

    case 'CANCEL_TRANSFER': {
      const t = state.transfers[msg.transferId];
      if (t) {
        t.status = 'CANCELLED';
        t.inProgress = false;
        t.updatedAt = Date.now();
        if (t.shareId) {
          publicP2PShares.delete(t.shareId);
          broadcastToMesh({
            meshType: 'DIRECT_SIGNAL',
            signalType: 'PACK_INFO_RESPONSE',
            transferId: t.shareId,
            payload: {
              ok: false,
              error: 'CANCELLED',
              message: 'O compartilhamento foi encerrado pelo remetente.'
            }
          });
        }
        broadcastState();
        ensureOffscreenDocument().then(() => {
          safeSendMessage({
            target: 'offscreen',
            action: 'OFFSCREEN_CONTROL',
            subAction: 'CANCEL',
            transferId: msg.transferId
          });
        });
        if (fileBridgeChannel) {
          fileBridgeChannel.postMessage({
            type: 'DELETE_PACK_MEMORY',
            shareId: t.shareId || msg.transferId
          });
        }
      }
      sendResponse({ state });
      return true;
    }

    case 'TOGGLE_MESH_RELAY':
      state.meshRelayEnabled = !state.meshRelayEnabled;
      chrome.storage.local.set({ meshRelayEnabled: state.meshRelayEnabled });
      touchSelfInRegistry();
      scheduleGossipRosterBroadcast();
      broadcastState();
      sendResponse({ state });
      return true;

    case 'SET_RELAY_BANDWIDTH_LIMIT': {
      const rawLimit = msg.limitKbps !== undefined ? msg.limitKbps : msg.limit;
      state.relayBandwidthLimitKbps = typeof rawLimit === 'number' && !isNaN(rawLimit) ? rawLimit : 2048;
      chrome.storage.local.set({ relayBandwidthLimitKbps: state.relayBandwidthLimitKbps });
      touchSelfInRegistry();
      scheduleGossipRosterBroadcast();
      broadcastState();
      sendResponse({ state });
      return true;
    }

    case 'DELETE_PEER': {
      const tag = msg.tag;
      if (tag && tag !== state.myTag && state.peerRegistry[tag]) {
        delete state.peerRegistry[tag];
        state.deletedTags = state.deletedTags || {};
        state.deletedTags[tag] = Date.now();
        chrome.storage.local.set({
          peerRegistry: state.peerRegistry,
          deletedTags: state.deletedTags
        });
        broadcastState();
        scheduleGossipRosterBroadcast();
      }
      sendResponse({ state });
      return true;
    }

    case 'CLEAR_INACTIVE_PEERS': {
      const now = Date.now();
      let count = 0;
      state.deletedTags = state.deletedTags || {};
      for (const [tag, peer] of Object.entries(state.peerRegistry)) {
        if (tag === state.myTag) continue;
        const diff = now - (peer.lastSeen || 0);
        const isOnline = peer.status === 'online' || diff < 45000;
        if (!isOnline) {
          delete state.peerRegistry[tag];
          state.deletedTags[tag] = now;
          count++;
        }
      }
      if (count > 0) {
        chrome.storage.local.set({
          peerRegistry: state.peerRegistry,
          deletedTags: state.deletedTags
        });
        broadcastState();
        scheduleGossipRosterBroadcast();
      }
      sendResponse({ state, count });
      return true;
    }

    case 'RESPOND_INCOMING': {
      const ids = Array.isArray(msg.transferIds)
        ? msg.transferIds
        : (msg.transferId ? [msg.transferId] : []);

      if (ids.length === 0) {
        sendResponse({ ok: false, error: 'NO_TRANSFER_IDS' });
        return true;
      }

      const toAccept = [];
      const toReject = [];

      for (const id of ids) {
        const transfer = state.transfers[id];
        if (!transfer || transfer.status !== 'AWAITING_ACCEPT') continue;

        if (msg.accept) {
          updateTransfer(id, { status: 'CONNECTING' });
          toAccept.push({ id, transfer });
        } else {
          toReject.push({ id, transfer });
          delete state.transfers[id];
        }
      }

      if (toAccept.length > 0) {
        ensureOffscreenDocument().then(() => {
          for (const item of toAccept) {
            const transfer = item.transfer;
            const transferId = item.id;
            if (transfer.routeType === 'MESH_RELAY' && transfer.relayTag) {
              sendSignal(transfer.relayTag, transferId, 'FILE_ACCEPT', {
                isRelayed: true,
                senderTag: transfer.peerTag,
                targetTag: state.myTag,
                roster: Object.values(state.peerRegistry)
              });
            } else {
              sendSignal(transfer.peerTag, transferId, 'FILE_ACCEPT', {
                roster: Object.values(state.peerRegistry)
              });
            }
          }
        });
      }

      if (toReject.length > 0) {
        for (const item of toReject) {
          const transfer = item.transfer;
          const transferId = item.id;
          if (transfer.routeType === 'MESH_RELAY' && transfer.relayTag) {
            sendSignal(transfer.relayTag, transferId, 'TRANSFER_REJECT', {
              isRelayed: true,
              senderTag: transfer.peerTag
            });
          } else {
            sendSignal(transfer.peerTag, transferId, 'TRANSFER_REJECT', {});
          }
        }
      }

      broadcastState();
      sendResponse({ state, count: toAccept.length + toReject.length });
      return true;
    }

    case 'DELETE_TRANSFER': {
      const transferId = msg.transferId;
      const t = state.transfers[transferId];
      if (t) {
        if (t.shareId) {
          publicP2PShares.delete(t.shareId);
          broadcastToMesh({
            meshType: 'DIRECT_SIGNAL',
            signalType: 'PACK_INFO_RESPONSE',
            transferId: t.shareId,
            payload: {
              ok: false,
              error: 'CANCELLED',
              message: 'O compartilhamento foi encerrado pelo remetente.'
            }
          });
        }
        ensureOffscreenDocument().then(() => {
          safeSendMessage({
            target: 'offscreen',
            action: 'OFFSCREEN_CONTROL',
            subAction: 'CANCEL',
            transferId
          });
        });
        if (fileBridgeChannel) {
          fileBridgeChannel.postMessage({
            type: 'DELETE_PACK_MEMORY',
            shareId: t.shareId || transferId
          });
          fileBridgeChannel.postMessage({
            type: 'DELETE_FILE_MEMORY',
            transferId
          });
        }
        delete state.transfers[transferId];
        broadcastState();
      }
      sendResponse({ ok: true, state });
      return true;
    }

    case 'CLEAR_HISTORY':
    case 'CLEAR_COMPLETED': {
      const historyStatuses = ['COMPLETED', 'EXPIRED', 'CANCELLED', 'ERROR'];
      for (const [id, t] of Object.entries(state.transfers)) {
        if (historyStatuses.includes(t.status)) {
          if (t.shareId) publicP2PShares.delete(t.shareId);
          delete state.transfers[id];
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_FILE_MEMORY', transferId: id });
            fileBridgeChannel.postMessage({ type: 'DELETE_PACK_MEMORY', shareId: t.shareId || id });
          }
        }
      }
      broadcastState();
      sendResponse({ ok: true, state });
      return true;
    }
  }
});

// ============================================================================
// 8. Inicialização do Service Worker
// ============================================================================
async function initializeServiceWorker() {
  const stored = await chrome.storage.local.get([
    'nodeId',
    'myTag',
    'autoAccept',
    'autoOpenOnReceive',
    'stagedTunnelFiles',
    'tunnelModalOpen',
    'modalMode',
    'modalTargetTag',
    'peerRegistry',
    'deletedTags',
    'transfers',
    'meshRelayEnabled',
    'relayBandwidthLimitKbps',
    'relayedBytesTotal',
    'turnConfig'
  ]);

  if (stored.turnConfig) {
    state.turnConfig = stored.turnConfig;
  }

  if (Array.isArray(stored.stagedTunnelFiles)) {
    state.stagedTunnelFiles = stored.stagedTunnelFiles;
  }

  if (typeof stored.tunnelModalOpen === 'boolean') {
    state.tunnelModalOpen = stored.tunnelModalOpen;
  }
  if (stored.modalMode) {
    state.modalMode = stored.modalMode;
  }
  if (typeof stored.modalTargetTag === 'string') {
    state.modalTargetTag = stored.modalTargetTag;
  }
  updateBadgeForStagedFiles();

  if (stored.nodeId) {
    state.nodeId = stored.nodeId;
  } else {
    state.nodeId = crypto.randomUUID();
    await chrome.storage.local.set({ nodeId: state.nodeId });
  }

  if (stored.myTag) {
    state.myTag = stored.myTag;
  } else {
    state.myTag = '';
  }

  if (typeof stored.autoAccept === 'boolean') {
    state.autoAccept = stored.autoAccept;
  }

  if (typeof stored.autoOpenOnReceive === 'boolean') {
    state.autoOpenOnReceive = stored.autoOpenOnReceive;
  }

  if (typeof stored.meshRelayEnabled === 'boolean') {
    state.meshRelayEnabled = stored.meshRelayEnabled;
  }

  if (typeof stored.relayBandwidthLimitKbps === 'number') {
    state.relayBandwidthLimitKbps = stored.relayBandwidthLimitKbps;
  }

  if (typeof stored.relayedBytesTotal === 'number') {
    state.relayedBytesTotal = stored.relayedBytesTotal;
  }

  if (stored.peerRegistry && typeof stored.peerRegistry === 'object') {
    state.peerRegistry = stored.peerRegistry;
  }

  if (stored.deletedTags && typeof stored.deletedTags === 'object') {
    state.deletedTags = stored.deletedTags;
  }

  if (stored.transfers && typeof stored.transfers === 'object') {
    state.transfers = stored.transfers;
    for (const [id, t] of Object.entries(state.transfers)) {
      if (t && t.direction === 'tunnel' && t.shareId) {
        if (t.status === 'TRANSFERRING') {
          t.status = 'TUNNEL_READY';
          t.inProgress = false;
          t.progress = 0;
          t.transferredBytes = 0;
          t.speedBps = 0;
        }
        if (t.status === 'TUNNEL_READY' || t.status === 'PAUSED') {
          publicP2PShares.set(t.shareId, {
            shareId: t.shareId,
            transferId: id,
            packName: t.packName || t.fileName,
            fileName: t.fileName,
            files: t.files,
            totalSize: t.totalSize || t.fileSize,
            fileSize: t.fileSize,
            fileType: t.fileType || 'application/octet-stream',
            hasPassword: t.hasPassword,
            passwordSalt: t.passwordSalt,
            passwordHash: t.passwordHash,
            expiresAt: t.expiresAt
          });
        }
      }
    }
  }

  // Inicializa o motor descentralizado completo (9 subsistemas)
  try {
    await meshEngine.init({
      nodeId: state.nodeId,
      myTag: state.myTag,
      onPacketToSend: (targetTag, pkt) => {
        if (targetTag) {
          sendSignal(targetTag, pkt.transferId || crypto.randomUUID(), pkt.type, pkt);
        } else {
          broadcastToMesh(pkt);
        }
      }
    });
    state.meshEngineSummary = meshEngine.getStatusSummary();
  } catch (err) {
    console.warn('[PulseShare] Falha ao inicializar meshEngine:', err);
  }

  await ensureOffscreenDocument();
  if (state.turnConfig) {
    safeSendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_SET_TURN_CONFIG',
      turnConfig: state.turnConfig
    });
  }
  touchSelfInRegistry();
  connectPublicMesh();
  announcePresenceToMesh();
}

initializeServiceWorker();
