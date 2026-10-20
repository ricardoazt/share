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

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];
const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';

const state = {
  connected: false,
  nodeId: '',
  myTag: '',
  autoAccept: true,
  autoOpenOnReceive: true,
  tunnelReady: true,
  peerRegistry: {},
  transfers: {}
};

const publicP2PShares = new Map();
const brokerSockets = new Map(); // url -> WebSocket
const seenPacketIds = new Set();

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

async function ensureExtensionPopupOpen(queryParams = '?window=1') {
  const alreadyOpen = await isExtensionPopupOpen();
  if (alreadyOpen && popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  try {
    const url = chrome.runtime.getURL(`popup.html${queryParams}`);
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: 376,
      height: 620,
      focused: true
    });
    if (win && typeof win.id === 'number') {
      popupWindowId = win.id;
    }
  } catch {}
}

// Ao clicar no ícone da extensão no Chrome, abre a janela compacta persistente
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    ensureExtensionPopupOpen('?window=1');
  });
}

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    if (winId === popupWindowId) {
      popupWindowId = null;
    }
  });
}

// ============================================================================
// 2. Link Público P2P Serverless (Cloudflare WebRTC STUN + TURN)
// ============================================================================
async function startServerlessP2PLinkShare(transferId, fileMeta) {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const shareId = `cf-${randomHex}`;

  const query = new URLSearchParams({
    share: shareId,
    owner: state.myTag,
    name: fileMeta.name,
    size: String(fileMeta.size),
    type: fileMeta.type || 'application/octet-stream'
  }).toString();

  const shareUrl = `${chrome.runtime.getURL('receiver.html')}?${query}`;

  publicP2PShares.set(shareId, {
    shareId,
    transferId,
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type || 'application/octet-stream'
  });

  state.transfers[transferId] = {
    id: transferId,
    direction: 'tunnel',
    peerTag: 'Túnel P2P',
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type || 'application/octet-stream',
    progress: 100,
    transferredBytes: fileMeta.size,
    speedBps: 0,
    downloads: 0,
    shareId,
    shareUrl,
    ownerTag: state.myTag,
    status: 'TUNNEL_READY',
    updatedAt: Date.now()
  };

  broadcastState();
  await ensureExtensionPopupOpen('?window=1');
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

function parseMqttIncomingPackets(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const messages = [];
  let pos = 0;

  while (pos < buf.length) {
    const firstByte = buf[pos++];
    const packetType = firstByte & 0xf0;

    let multiplier = 1;
    let remainingLen = 0;
    let encodedByte;
    do {
      if (pos >= buf.length) return messages;
      encodedByte = buf[pos++];
      remainingLen += (encodedByte & 127) * multiplier;
      multiplier *= 128;
    } while ((encodedByte & 128) !== 0);

    const packetEnd = pos + remainingLen;
    if (packetEnd > buf.length) break;

    if (packetType === 0x20) {
      messages.push({ mqttEvent: 'CONNACK' });
    } else if (packetType === 0x30) {
      let cursor = pos;
      const topicLen = (buf[cursor] << 8) | buf[cursor + 1];
      cursor += 2 + topicLen;
      const qos = (firstByte >> 1) & 0x03;
      if (qos > 0) cursor += 2;
      const payloadStr = new TextDecoder().decode(buf.subarray(cursor, packetEnd));
      try {
        messages.push({ mqttEvent: 'PUBLISH', data: JSON.parse(payloadStr) });
      } catch {}
    }

    pos = packetEnd;
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
    brokerSockets.set(brokerUrl, ws);
  } catch {
    setTimeout(() => connectSingleBroker(brokerUrl), 4000);
    return;
  }

  ws.onopen = () => {
    const clientId = `ps_${state.nodeId.slice(0, 8)}_${Math.floor(1000 + Math.random() * 8999)}`;
    ws.send(buildMqttConnectPacket(clientId));
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const packets = parseMqttIncomingPackets(event.data);

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
      broadcastToMesh({
        meshType: 'ROSTER_GOSSIP_SYNC',
        roster: Object.values(state.peerRegistry)
      });
      broadcastState();
    }, 18000);
  }
}

function touchSelfInRegistry(previousTag = null) {
  if (!state.myTag) return;
  const now = Date.now();

  if (previousTag && previousTag !== state.myTag && state.peerRegistry[previousTag]?.nodeId === state.nodeId) {
    delete state.peerRegistry[previousTag];
  }

  const existing = state.peerRegistry[state.myTag];
  state.peerRegistry[state.myTag] = {
    tag: state.myTag,
    nodeId: state.nodeId,
    joinedAt: existing?.joinedAt || now,
    lastSeen: now,
    status: 'online'
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

  for (const item of incomingRoster) {
    if (!item || typeof item.tag !== 'string' || !item.tag.startsWith('@') || item.tag.startsWith('@link_')) {
      continue;
    }

    if (item.nodeId) {
      for (const [tagKey, entry] of Object.entries(state.peerRegistry)) {
        if (entry.nodeId === item.nodeId && tagKey !== item.tag && (item.lastSeen || 0) > (entry.lastSeen || 0)) {
          delete state.peerRegistry[tagKey];
          changed = true;
        }
      }
    }

    const local = state.peerRegistry[item.tag];
    if (!local) {
      state.peerRegistry[item.tag] = {
        tag: item.tag,
        nodeId: item.nodeId || '',
        joinedAt: item.joinedAt || Date.now(),
        lastSeen: item.lastSeen || Date.now(),
        status: item.status || 'online'
      };
      changed = true;
    } else if ((item.lastSeen || 0) > (local.lastSeen || 0)) {
      state.peerRegistry[item.tag] = {
        ...local,
        nodeId: item.nodeId || local.nodeId,
        lastSeen: item.lastSeen,
        status: item.status || 'online'
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

async function handleMeshPacket(packet) {
  if (!packet || packet.senderNodeId === state.nodeId) return;

  // Deduplica pacotes recebidos por múltiplos brokers simultaneamente
  if (packet.pktId) {
    if (seenPacketIds.has(packet.pktId)) return;
    seenPacketIds.add(packet.pktId);
    if (seenPacketIds.size > 2000) {
      const first = seenPacketIds.values().next().value;
      seenPacketIds.delete(first);
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

    case 'DIRECT_SIGNAL': {
      if (packet.to !== state.myTag) return;

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
function broadcastState() {
  chrome.storage.local.set({
    transfers: state.transfers,
    peerRegistry: state.peerRegistry
  });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state }).catch(() => {});
}

function updateTransfer(transferId, patch) {
  const existing = state.transfers[transferId];
  if (!existing) return;
  state.transfers[transferId] = {
    ...existing,
    ...patch,
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

async function startOutgoingTransfer(transferId, targetTag, fileMeta) {
  state.transfers[transferId] = {
    id: transferId,
    direction: 'outgoing',
    peerTag: targetTag,
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type,
    progress: 0,
    transferredBytes: 0,
    speedBps: 0,
    status: 'AWAITING_ACCEPT',
    updatedAt: Date.now()
  };
  broadcastState();

  await ensureExtensionPopupOpen(`?window=1&target=${encodeURIComponent(targetTag)}`);

  sendSignal(targetTag, transferId, 'FILE_OFFER', {
    fileName: fileMeta.name,
    fileSize: fileMeta.size,
    fileType: fileMeta.type,
    roster: Object.values(state.peerRegistry)
  });
}

async function handleIncomingSignal(msg) {
  const { from, transferId, signalType, payload } = msg;

  if (payload?.roster) {
    mergeRemoteRoster(payload.roster);
  }

  if (signalType === 'PUBLIC_LINK_PULL') {
    const shareId = payload?.shareId;
    let shareRecord = publicP2PShares.get(shareId);

    if (!shareRecord) {
      const found = Object.values(state.transfers).find((t) => t.shareId === shareId);
      if (found) {
        shareRecord = {
          shareId,
          transferId: found.id,
          fileName: found.fileName,
          fileSize: found.fileSize,
          fileType: found.fileType
        };
        publicP2PShares.set(shareId, shareRecord);
      }
    }

    if (!shareRecord) return;

    const parentTransfer = state.transfers[shareRecord.transferId];
    if (parentTransfer) {
      updateTransfer(shareRecord.transferId, {
        downloads: (parentTransfer.downloads || 0) + 1,
        status: 'TRANSFERRING',
        progress: 0,
        transferredBytes: 0
      });
    }

    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'OFFSCREEN_SIGNAL',
      from,
      transferId,
      uiTransferId: shareRecord.transferId,
      fileKey: shareRecord.transferId,
      keepStaged: true,
      signalType: 'FILE_ACCEPT',
      payload: {},
      roster: Object.values(state.peerRegistry)
    });
    return;
  }

  if (signalType === 'FILE_OFFER') {
    state.transfers[transferId] = {
      id: transferId,
      direction: 'incoming',
      peerTag: from,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      fileType: payload.fileType,
      progress: 0,
      transferredBytes: 0,
      speedBps: 0,
      status: state.autoAccept ? 'CONNECTING' : 'AWAITING_ACCEPT',
      updatedAt: Date.now()
    };
    broadcastState();

    // Prepara o Offscreen Document imediatamente antes do SDP Offer chegar
    await ensureOffscreenDocument();

    if (state.autoOpenOnReceive !== false) {
      await ensureExtensionPopupOpen('?window=1');
    }

    if (state.autoAccept) {
      sendSignal(from, transferId, 'FILE_ACCEPT', {
        roster: Object.values(state.peerRegistry)
      });
    }
    return;
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
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'OFFSCREEN_SIGNAL',
    from,
    transferId,
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
    if (msg.type === 'OFFSCREEN_SEND_SIGNAL') {
      sendSignal(msg.to, msg.transferId, msg.signalType, msg.payload);
    } else if (msg.type === 'OFFSCREEN_PROGRESS') {
      updateTransfer(msg.transferId, msg.patch);
    } else if (msg.type === 'OFFSCREEN_ROSTER_GOSSIP' && Array.isArray(msg.roster)) {
      mergeRemoteRoster(msg.roster);
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
      sendResponse({ state });
      return true;

    case 'ENSURE_OFFSCREEN':
      ensureOffscreenDocument().then(() => sendResponse({ ok: true }));
      return true;

    case 'SET_MY_TAG': {
      const previousTag = state.myTag;
      state.myTag = msg.tag;
      chrome.storage.local.set({ myTag: state.myTag });
      announcePresenceToMesh(previousTag);
      sendResponse({ state });
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

    case 'START_CLOUDFLARE_TUNNEL_SHARE':
      startServerlessP2PLinkShare(msg.transferId, msg.fileMeta);
      sendResponse({ ok: true });
      return true;

    case 'RESPOND_INCOMING': {
      const transfer = state.transfers[msg.transferId];
      if (!transfer) {
        sendResponse({ ok: false });
        return true;
      }
      if (msg.accept) {
        updateTransfer(msg.transferId, { status: 'CONNECTING' });
        ensureOffscreenDocument().then(() => {
          sendSignal(transfer.peerTag, msg.transferId, 'FILE_ACCEPT', {
            roster: Object.values(state.peerRegistry)
          });
        });
      } else {
        sendSignal(transfer.peerTag, msg.transferId, 'TRANSFER_REJECT', {});
        delete state.transfers[msg.transferId];
        broadcastState();
      }
      sendResponse({ state });
      return true;
    }

    case 'CLEAR_COMPLETED': {
      for (const [id, t] of Object.entries(state.transfers)) {
        if (t.status === 'COMPLETED' || t.status === 'ERROR' || t.status === 'TUNNEL_READY') {
          if (t.shareId) publicP2PShares.delete(t.shareId);
          delete state.transfers[id];
          if (fileBridgeChannel) {
            fileBridgeChannel.postMessage({ type: 'DELETE_FILE_MEMORY', transferId: id });
          }
        }
      }
      broadcastState();
      sendResponse({ state });
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
    'peerRegistry',
    'transfers'
  ]);

  if (stored.nodeId) {
    state.nodeId = stored.nodeId;
  } else {
    state.nodeId = crypto.randomUUID();
    await chrome.storage.local.set({ nodeId: state.nodeId });
  }

  if (stored.myTag) {
    state.myTag = stored.myTag;
  } else {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    state.myTag = `@user_${randomSuffix}`;
    await chrome.storage.local.set({ myTag: state.myTag });
  }

  if (typeof stored.autoAccept === 'boolean') {
    state.autoAccept = stored.autoAccept;
  }

  if (typeof stored.autoOpenOnReceive === 'boolean') {
    state.autoOpenOnReceive = stored.autoOpenOnReceive;
  }

  if (stored.peerRegistry && typeof stored.peerRegistry === 'object') {
    state.peerRegistry = stored.peerRegistry;
  }

  if (stored.transfers && typeof stored.transfers === 'object') {
    state.transfers = stored.transfers;
  }

  await ensureOffscreenDocument();
  touchSelfInRegistry();
  connectPublicMesh();
  announcePresenceToMesh();
}

initializeServiceWorker();
