// test_p2p_real_e2e.mjs
// Dispositivo A: Desktop Peer Client (Node.js)
// Dispositivo B: Samsung Galaxy S24 Ultra (@usuario_4386_a7556d)

const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';
const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt'
];

function encodeRemainingLength(len) {
  const bytes = [];
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit = digit | 0x80;
    bytes.push(digit);
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
  const lenBytes = encodeRemainingLength(totalLen);
  const packet = new Uint8Array(1 + lenBytes.length + totalLen);
  packet[0] = 0x30;
  packet.set(lenBytes, 1);
  packet.set(topicBytes, 1 + lenBytes.length);
  packet.set(payloadBytes, 1 + lenBytes.length + topicBytes.length);
  return packet;
}

function decodeMqttPublish(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const packetType = bytes[0] >> 4;
  if (packetType !== 3) return null;

  let idx = 1;
  let multiplier = 1;
  let remainingLength = 0;
  let digit;
  do {
    digit = bytes[idx++];
    remainingLength += (digit & 127) * multiplier;
    multiplier *= 128;
  } while ((digit & 128) !== 0 && idx < bytes.length);

  const topicLen = (bytes[idx] << 8) | bytes[idx + 1];
  idx += 2;
  idx += topicLen;

  const payloadBytes = bytes.subarray(idx);
  try {
    const jsonStr = new TextDecoder().decode(payloadBytes);
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

const myTag = '@dev_desktop_agent';
const myNodeId = 'node_desktop_' + Math.random().toString(36).slice(2, 8);
const targetPhoneTag = '@usuario_4386_a7556d';

const activeSockets = [];

function connectBroker(brokerUrl) {
  return new Promise((resolve) => {
    console.log(`[Broker] Conectando a ${brokerUrl}...`);
    const ws = new WebSocket(brokerUrl, ['mqtt']);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log(`[Broker] WebSocket Aberto em ${brokerUrl}. Enviando MQTT CONNECT...`);
      const clientId = 'desk_' + Math.random().toString(36).slice(2, 8);
      const protoName = encodeUTF8String('MQTT');
      const clientBytes = encodeUTF8String(clientId);
      const varHeader = [...protoName, 4, 0x02, 0, 60];
      const payload = [...clientBytes];
      const totalLen = varHeader.length + payload.length;
      const lenBytes = encodeRemainingLength(totalLen);
      const connPacket = new Uint8Array(1 + lenBytes.length + totalLen);
      connPacket[0] = 0x10;
      connPacket.set(lenBytes, 1);
      connPacket.set(varHeader, 1 + lenBytes.length);
      connPacket.set(payload, 1 + lenBytes.length + varHeader.length);
      ws.send(connPacket);
    };

    ws.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      const packetType = bytes[0] >> 4;

      if (packetType === 2) {
        console.log(`[Broker] CONNACK recebido de ${brokerUrl}! Assinando tópico ${MESH_TOPIC}...`);
        const subTopic = encodeUTF8String(MESH_TOPIC);
        const subLen = 2 + subTopic.length + 1;
        const subLenBytes = encodeRemainingLength(subLen);
        const subPacket = new Uint8Array(1 + subLenBytes.length + subLen);
        subPacket[0] = 0x82;
        subPacket.set(subLenBytes, 1);
        subPacket.set([0, 1], 1 + subLenBytes.length);
        subPacket.set(subTopic, 3 + subLenBytes.length);
        subPacket[subPacket.length - 1] = 0;
        ws.send(subPacket);

        activeSockets.push(ws);
        resolve(ws);
      } else if (packetType === 3) {
        const data = decodeMqttPublish(bytes);
        if (data) {
          handleIncomingPacket(data);
        }
      }
    };

    ws.onerror = (err) => {
      console.warn(`[Broker] Erro em ${brokerUrl}:`, err.message || err);
    };
  });
}

function broadcast(packetObj) {
  const pktId = 'pkt_' + Math.random().toString(36).slice(2) + Date.now();
  const fullPacket = {
    ...packetObj,
    pktId,
    packetId: pktId,
    senderNodeId: myNodeId,
    senderTag: myTag,
    timestamp: Date.now()
  };
  const raw = buildMqttPublishPacket(MESH_TOPIC, fullPacket);
  activeSockets.forEach(ws => {
    try { ws.send(raw); } catch (e) {}
  });
}

function announcePresence() {
  broadcast({
    meshType: 'PRESENCE_ANNOUNCE',
    tag: myTag,
    reghash: '0xdeadbeef1337',
    nodeId: myNodeId,
    avatar: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="24" fill="#6366f1"/><circle cx="64" cy="16" r="12" fill="rgba(255,255,255,0.3)"/><text x="50%" y="54%" font-family="sans-serif" font-weight="900" font-size="36" fill="white" text-anchor="middle" dominant-baseline="middle">D</text></svg>',
    clientType: 'desktop-agent',
    relayMode: true
  });
  console.log(`[Mesh] Presença anunciada como ${myTag}`);
}

function sendChatMessage(text) {
  const msgId = 'msg_' + Date.now();
  broadcast({
    meshType: 'DIRECT_SIGNAL',
    to: targetPhoneTag,
    transferId: msgId,
    signalType: 'CHAT_MESSAGE',
    payload: {
      id: msgId,
      senderTag: myTag,
      text: text,
      timestamp: Date.now()
    }
  });
  console.log(`[Chat] Mensagem enviada para ${targetPhoneTag}: "${text}"`);
}

function handleIncomingPacket(packet) {
  if (packet.senderTag === myTag || packet.senderNodeId === myNodeId) return;

  if (packet.meshType === 'PRESENCE_ANNOUNCE') {
    if (packet.tag === targetPhoneTag) {
      console.log(`[Mesh] Par encontrado online: ${packet.tag} (Node: ${packet.senderNodeId})`);
    }
  } else if (packet.meshType === 'DIRECT_SIGNAL' && packet.to === myTag) {
    console.log(`[Mesh] Sinal direto recebido de ${packet.senderTag} (${packet.signalType}):`, packet.payload);
    if (packet.signalType === 'CHAT_MESSAGE') {
      console.log(`\n🎉🎉🎉 SUCESSO E2E: RESPOSTA RECEBIDA DO DISPOSITIVO B NO DISPOSITIVO A! 🎉🎉🎉`);
      console.log(`De: ${packet.senderTag}`);
      console.log(`Texto: "${packet.payload.text}"`);
      console.log(`Horário: ${new Date(packet.payload.timestamp).toLocaleTimeString()}\n`);
      process.exit(0);
    }
  }
}

async function start() {
  console.log('=== INICIANDO TESTE REAL E2E P2P (Dispositivo A <-> Dispositivo B) ===');
  await Promise.all(BROKERS.map(b => connectBroker(b)));

  // Anuncia presença
  announcePresence();

  // Espera 1s e envia a mensagem de teste
  setTimeout(() => {
    sendChatMessage('Olá Samsung S24 Ultra! Teste E2E de Chat-First funcionando com sucesso!');
  }, 1200);

  // Mantém processo ouvindo resposta por até 40 segundos
  setTimeout(() => {
    console.log('[Timeout] Tempo limite de espera para resposta atingido.');
    process.exit(0);
  }, 40000);
}

start();
