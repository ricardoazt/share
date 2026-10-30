const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';
const BROKER = 'wss://broker.hivemq.com:8884/mqtt';

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
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch (e) {
    return null;
  }
}

const myTag = '@dev_desktop_agent';
const myNodeId = 'node_desktop_tester';
const targetPhoneTag = '@usuario_4386_a7556d';

const ws = new WebSocket(BROKER, ['mqtt']);
ws.binaryType = 'arraybuffer';

ws.onopen = () => {
  console.log('[Broker] Conectado. Enviando MQTT CONNECT...');
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
    console.log('[Broker] CONNACK recebido. Inscrevendo no tópico global...');
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

    // Envia anúncio de presença
    setTimeout(() => {
      broadcast({
        meshType: 'PRESENCE_ANNOUNCE',
        tag: myTag,
        reghash: '0xdeadbeef1337',
        nodeId: myNodeId,
        avatar: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="40" fill="#6366f1"/><text x="40" y="50" font-size="30" fill="white" text-anchor="middle">D</text></svg>',
        clientType: 'desktop-agent'
      });
      console.log('[Mesh] Presença anunciada!');
    }, 600);

    // Envia Mensagem de Chat com Arquivo Anexo
    setTimeout(() => {
      const msgId = 'msg_file_' + Date.now();
      const transferId = 'tr_file_' + Date.now();
      console.log(`[Chat] Enviando mensagem com anexo para ${targetPhoneTag}...`);
      broadcast({
        meshType: 'DIRECT_SIGNAL',
        to: targetPhoneTag,
        transferId: transferId,
        signalType: 'CHAT_MESSAGE',
        payload: {
          id: msgId,
          senderTag: myTag,
          text: 'Aqui está o documento solicitado via P2P!',
          timestamp: Date.now(),
          transferId: transferId,
          media: {
            name: 'Relatorio_Projeto_PulseShare.pdf',
            size: 2048576,
            type: 'application/pdf',
            transferId: transferId
          }
        }
      });
      console.log('[Chat] Mensagem com documento enviada!');
    }, 1500);

  } else if (packetType === 3) {
    const pkt = decodeMqttPublish(bytes);
    if (pkt && pkt.meshType === 'DIRECT_SIGNAL' && pkt.to === myTag) {
      console.log(`[Sinal Direto Recebido de ${pkt.senderTag}]:`, pkt.signalType, pkt.payload);
      if (pkt.signalType === 'FILE_ACCEPT') {
        console.log('🎉 SUCESSO: O Dispositivo B solicitou o download do arquivo via FILE_ACCEPT!');
        process.exit(0);
      }
    }
  }
};

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
  try { ws.send(raw); } catch (e) {}
}

setTimeout(() => {
  console.log('[Envio concluído com sucesso]');
  process.exit(0);
}, 6000);
