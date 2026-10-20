/**
 * PulseShare — Receptor Web P2P Serverless (receiver.js)
 * Conecta diretamente ao navegador do remetente usando Cloudflare WebRTC STUN +
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
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302'
      ]
    },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

const params = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ''));
const shareId = params.get('share') || '';
const ownerTag = params.get('owner') || '';
let fileName = params.get('name') || 'arquivo_compartilhado';
let fileSize = Number(params.get('size') || 0);
let fileType = params.get('type') || 'application/octet-stream';

const visitorNodeId = crypto.randomUUID();
const visitorTag = `@link_${visitorNodeId.slice(0, 6)}`;
let activeTransferId = `${shareId}_${visitorNodeId.slice(0, 6)}`;

const statusDot = document.getElementById('status-dot');
const shareIdBadge = document.getElementById('share-id-badge');
const fileNameEl = document.getElementById('file-name');
const fileMetaEl = document.getElementById('file-meta');
const transferStatusEl = document.getElementById('transfer-status');
const transferPctEl = document.getElementById('transfer-pct');
const progressBarEl = document.getElementById('progress-bar');
const bytesCounterEl = document.getElementById('bytes-counter');
const speedCounterEl = document.getElementById('speed-counter');
const btnStartDownload = document.getElementById('btn-start-download');

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

shareIdBadge.textContent = shareId ? `#${shareId}` : '#inválido';
fileNameEl.textContent = fileName;
fileMetaEl.textContent = `Remetente: ${ownerTag || 'Par P2P'} • ${formatBytes(fileSize)}`;
bytesCounterEl.textContent = `0 B / ${formatBytes(fileSize)}`;

// ============================================================================
// 1. Cliente Multi-Broker MQTT v3.1.1 over WSS + BroadcastChannel Local
// ============================================================================
const brokerConnections = new Map();
const seenPacketIds = new Set();
let pc = null;
let pendingCandidates = [];
let hasAutoRequested = false;

const localMeshChannel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pulseshare_v2_local_mesh') : null;

if (localMeshChannel) {
  localMeshChannel.onmessage = (e) => {
    if (e.data) handleMeshPacket(e.data);
  };
}

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
  const body = [
    ...encodeUTF8String('MQTT'),
    0x04,
    0x02,
    0x00,
    0x3c,
    ...encodeUTF8String(clientId)
  ];
  return new Uint8Array([0x10, ...encodeRemainingLength(body.length), ...body]);
}

function buildMqttSubscribePacket(topic) {
  const body = [0x00, 0x01, ...encodeUTF8String(topic), 0x00];
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
      if (((firstByte >> 1) & 0x03) > 0) cursor += 2;
      const payloadStr = new TextDecoder().decode(buf.subarray(cursor, packetEnd));
      try {
        messages.push({ mqttEvent: 'PUBLISH', data: JSON.parse(payloadStr) });
      } catch {}
    }
    pos = packetEnd;
  }
  return messages;
}

function broadcastToMesh(packet) {
  const enriched = {
    ...packet,
    packetId: crypto.randomUUID(),
    senderNodeId: visitorNodeId,
    senderTag: visitorTag,
    timestamp: Date.now()
  };

  seenPacketIds.add(enriched.packetId);

  if (localMeshChannel) {
    try {
      localMeshChannel.postMessage(enriched);
    } catch {}
  }

  const rawMqttPacket = buildMqttPublishPacket(MESH_TOPIC, enriched);
  for (const [, conn] of brokerConnections.entries()) {
    if (conn.ready && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      try {
        conn.ws.send(rawMqttPacket);
      } catch {}
    }
  }
}

function sendSignalToOwner(signalType, payload) {
  broadcastToMesh({
    meshType: 'DIRECT_SIGNAL',
    to: ownerTag,
    transferId: activeTransferId,
    signalType,
    payload
  });
}

// ============================================================================
// 2. Recebimento P2P via WebRTC DataChannel (Cloudflare STUN + TURN)
// ============================================================================
async function handleMeshPacket(packet) {
  if (!packet || packet.senderNodeId === visitorNodeId) return;
  if (packet.packetId) {
    if (seenPacketIds.has(packet.packetId)) return;
    seenPacketIds.add(packet.packetId);
  }
  if (packet.meshType !== 'DIRECT_SIGNAL' || packet.to !== visitorTag) return;

  const { signalType, payload } = packet;

  if (signalType === 'WEBRTC_OFFER') {
    await startWebRTCReceiver(payload.sdp);
  } else if (signalType === 'ICE_CANDIDATE' && payload?.candidate) {
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {}
    } else {
      pendingCandidates.push(payload.candidate);
    }
  }
}

function waitForIceGathering(peerConn, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (peerConn.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      peerConn.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, timeoutMs);
    function check() {
      if (peerConn.iceGatheringState === 'complete') {
        clearTimeout(timer);
        peerConn.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    peerConn.addEventListener('icegatheringstatechange', check);
  });
}

async function startWebRTCReceiver(sdpOffer) {
  transferStatusEl.textContent = 'Túnel P2P conectado! Recebendo...';
  if (pc) {
    try {
      pc.close();
    } catch {}
  }
  pc = new RTCPeerConnection(RTC_CONFIG);

  const chunks = [];
  let receivedBytes = 0;
  const startTime = Date.now();
  let lastReport = startTime;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignalToOwner('ICE_CANDIDATE', {
        candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate
      });
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';

    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let ctrl;
        try {
          ctrl = JSON.parse(e.data);
        } catch {
          return;
        }
        if (ctrl.type === 'EOF') {
          try {
            channel.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' }));
          } catch {}

          const blob = new Blob(chunks, { type: fileType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();

          transferStatusEl.textContent = 'Download P2P concluído com sucesso!';
          transferPctEl.textContent = '100%';
          progressBarEl.style.width = '100%';
          bytesCounterEl.textContent = `${formatBytes(fileSize)} / ${formatBytes(fileSize)}`;
          speedCounterEl.textContent = 'Concluído ✓';
          btnStartDownload.textContent = '✓ Baixar Novamente';
          btnStartDownload.disabled = false;
          setTimeout(() => {
            try {
              pc.close();
            } catch {}
          }, 500);
        }
        return;
      }

      chunks.push(new Uint8Array(e.data));
      receivedBytes += e.data.byteLength;

      const now = Date.now();
      if (now - lastReport >= 100 || (fileSize > 0 && receivedBytes >= fileSize)) {
        const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
        const speedBps = Math.round(receivedBytes / elapsedSec);
        const pct = fileSize > 0 ? Math.min(99, Math.round((receivedBytes / fileSize) * 100)) : 99;
        transferPctEl.textContent = `${pct}%`;
        progressBarEl.style.width = `${pct}%`;
        bytesCounterEl.textContent = `${formatBytes(receivedBytes)} / ${formatBytes(fileSize)}`;
        speedCounterEl.textContent = `${formatBytes(speedBps)}/s`;
        lastReport = now;
      }
    };
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));

  while (pendingCandidates.length > 0) {
    const cand = pendingCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch {}
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc, 900);

  sendSignalToOwner('WEBRTC_ANSWER', {
    sdp: {
      type: pc.localDescription.type,
      sdp: pc.localDescription.sdp
    }
  });
}

function requestFileFromOwner() {
  if (!shareId || !ownerTag) {
    transferStatusEl.textContent = 'Link P2P incompleto ou inválido.';
    return;
  }
  activeTransferId = `${shareId}_${Math.floor(1000 + Math.random() * 9000)}`;
  pendingCandidates = [];
  btnStartDownload.disabled = true;
  btnStartDownload.textContent = 'Negociando Túnel P2P Cloudflare...';
  transferStatusEl.textContent = `Solicitando arquivo a ${ownerTag}...`;
  sendSignalToOwner('PUBLIC_LINK_PULL', { shareId });
}

btnStartDownload.addEventListener('click', requestFileFromOwner);

function connectSingleBroker(brokerUrl, index) {
  const existing = brokerConnections.get(brokerUrl);
  if (
    existing &&
    existing.ws &&
    (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let ws;
  try {
    ws = new WebSocket(brokerUrl, 'mqtt');
    ws.binaryType = 'arraybuffer';
  } catch {
    return;
  }

  const connRecord = { ws, ready: false };
  brokerConnections.set(brokerUrl, connRecord);

  ws.onopen = () => {
    const clientId = `ps_web_${visitorNodeId.slice(0, 8)}_${index}`;
    ws.send(buildMqttConnectPacket(clientId));
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const packets = parseMqttIncomingPackets(event.data);
    for (const pkt of packets) {
      if (pkt.mqttEvent === 'CONNACK') {
        connRecord.ready = true;
        statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm';
        ws.send(buildMqttSubscribePacket(MESH_TOPIC));
        if (!hasAutoRequested) {
          hasAutoRequested = true;
          requestFileFromOwner();
        }
      } else if (pkt.mqttEvent === 'PUBLISH' && pkt.data) {
        handleMeshPacket(pkt.data);
      }
    }
  };

  ws.onclose = () => {
    connRecord.ready = false;
    setTimeout(() => connectSingleBroker(brokerUrl, index), 3000);
  };
}

for (let i = 0; i < PUBLIC_WSS_BROKERS.length; i++) {
  connectSingleBroker(PUBLIC_WSS_BROKERS[i], i);
}
// Caso esteja na mesma máquina, solicita imediatamente via BroadcastChannel também
setTimeout(requestFileFromOwner, 250);
