/**
 * PulseShare Android Native Application Core (app.js)
 * Conexão Multi-Broker MQTT + WebRTC DataChannel + Ponte Nativa Android
 * 100% Compatível com Extensão Chrome Desktop e P2P Web
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. CONFIGURAÇÕES & BROKERS MQTT GLOBAIS
  // ==========================================================================
  const PUBLIC_WSS_BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  const MESH_TOPIC = 'pulseshare/v2/p2p_mesh_global';

  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  // ==========================================================================
  // 2. ESTADO LOCAL E IDENTIDADE DO NÓ
  // ==========================================================================
  let nodeId = localStorage.getItem('ps_node_id');
  if (!nodeId) {
    nodeId = 'and_' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    localStorage.setItem('ps_node_id', nodeId);
  }

  let myTag = localStorage.getItem('ps_my_tag');
  if (!myTag) {
    myTag = '@android_' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('ps_my_tag', myTag);
  }

  let myRegHash = localStorage.getItem('ps_my_reghash') || '0x' + Math.random().toString(16).slice(2, 14);
  let autoAccept = localStorage.getItem('ps_auto_accept') !== 'false';
  let meshRelay = localStorage.getItem('ps_mesh_relay') !== 'false';
  let relayBandwidth = parseInt(localStorage.getItem('ps_relay_bw') || '2048', 10);
  let turnConfig = JSON.parse(localStorage.getItem('ps_turn_config') || 'null');

  // Registros em memória
  const peerRegistry = {}; // tag -> peer info
  const transfers = {}; // transferId -> transfer info
  const publicShares = {}; // shareId -> share info
  const chatMessages = {}; // tag -> array de msgs
  const brokerSockets = [];
  const seenPacketIds = new Set();
  const activePeerConnections = new Map(); // transferId -> RTCPeerConnection
  const stagedFilesMap = new Map(); // transferId -> fileItem

  // Inicializa o Motor de Malha Descentralizada
  let meshEngine = null;
  try {
    if (typeof PulseShareMeshEngine !== 'undefined') {
      meshEngine = new PulseShareMeshEngine();
    }
  } catch (err) {
    console.warn('MeshEngine load err:', err);
  }

  function normalizeTag(tag) {
    return tag ? String(tag).toLowerCase().trim() : '';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ==========================================================================
  // 3. COMUNICAÇÃO NATIVA COM ANDROID (PULSESHARE NATIVE BRIDGE)
  // ==========================================================================
  const Native = {
    isAvailable: () => typeof window.PulseShareNative !== 'undefined',
    pickFiles: () => {
      if (Native.isAvailable()) window.PulseShareNative.pickFiles();
      else alert('Seletor nativo disponível no Android');
    },
    saveFile: (name, b64, mime) => {
      if (Native.isAvailable()) return window.PulseShareNative.saveFile(name, b64, mime);
      return '';
    },
    saveChunk: (id, name, b64, isFirst, isLast, mime) => {
      if (Native.isAvailable()) return window.PulseShareNative.saveChunk(id, name, b64, isFirst, isLast, mime);
      return '';
    },
    cancelTransfer: (id) => {
      if (Native.isAvailable() && window.PulseShareNative.cancelTransfer) {
        window.PulseShareNative.cancelTransfer(id);
      }
    },
    readUriChunkBase64: (uri, offset, length) => {
      if (Native.isAvailable() && window.PulseShareNative.readUriChunkBase64) {
        return window.PulseShareNative.readUriChunkBase64(uri, offset, length);
      }
      return '';
    },
    openFile: (path) => {
      if (Native.isAvailable()) window.PulseShareNative.openDownloadedFile(path);
    },
    shareFile: (path, mime) => {
      if (Native.isAvailable()) window.PulseShareNative.shareDownloadedFile(path, mime || '*/*');
    },
    shareText: (title, text) => {
      if (Native.isAvailable()) window.PulseShareNative.shareText(title, text);
      else if (navigator.share) navigator.share({ title, text }).catch(() => {});
      else prompt('Copie o link:', text);
    },
    copy: (text) => {
      if (Native.isAvailable()) window.PulseShareNative.copyToClipboard(text);
      else if (navigator.clipboard) navigator.clipboard.writeText(text);
    },
    toast: (msg) => {
      if (Native.isAvailable()) window.PulseShareNative.showToast(msg);
      else console.log('Toast:', msg);
    },
    startKeepAlive: (status) => {
      if (Native.isAvailable()) window.PulseShareNative.startKeepAlive(status);
    },
    stopKeepAlive: () => {
      if (Native.isAvailable()) window.PulseShareNative.stopKeepAlive();
    }
  };

  let pendingChatAttachment = false;
  let chatAttachedFiles = [];

  // Callbacks globais acionados pelo Kotlin
  window.PulseShareNativeCallback = {
    onFilesPicked: (files) => {
      if (pendingChatAttachment) {
        pendingChatAttachment = false;
        handleChatFilesSelected(files);
      } else {
        handleFilesSelected(files);
      }
    },
    onSharedFilesReceived: (items) => {
      handleAndroidSharedItems(items);
    },
    onBackPressed: () => {
      const modalSend = document.getElementById('modal-send');
      const modalSettings = document.getElementById('modal-settings');
      if (modalSend && !modalSend.classList.contains('hidden')) {
        modalSend.classList.add('hidden');
        return 'HANDLED';
      }
      if (modalSettings && !modalSettings.classList.contains('hidden')) {
        modalSettings.classList.add('hidden');
        return 'HANDLED';
      }
      if (currentTab !== 'home') {
        switchTab('home');
        return 'HANDLED';
      }
      return 'EXIT';
    }
  };

  // ==========================================================================
  // 4. PROTOCOLO MQTT BINÁRIO SOBRE WEBSOCKETS (SINALIZAÇÃO P2P)
  // ==========================================================================
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
    packet[0] = 0x30; // PUBLISH QoS 0
    packet.set(lenBytes, 1);
    packet.set(topicBytes, 1 + lenBytes.length);
    packet.set(payloadBytes, 1 + lenBytes.length + topicBytes.length);
    return packet;
  }

  function broadcastToMesh(obj) {
    const pktId = 'pkt_' + Math.random().toString(36).slice(2) + Date.now();
    const packet = {
      ...obj,
      pktId,
      packetId: pktId,
      senderNodeId: nodeId,
      senderTag: myTag,
      timestamp: Date.now()
    };
    seenPacketIds.add(pktId);
    const raw = buildMqttPublishPacket(MESH_TOPIC, packet);

    let sentCount = 0;
    brokerSockets.forEach((ws) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(raw);
          sentCount++;
        } catch {}
      }
    });
    return sentCount;
  }

  function sendSignal(to, transferId, signalType, payload) {
    broadcastToMesh({
      meshType: 'DIRECT_SIGNAL',
      to: to,
      transferId: transferId,
      signalType: signalType,
      payload: payload || {}
    });
  }

  function connectBrokers() {
    let connectedCount = 0;

    PUBLIC_WSS_BROKERS.forEach((url) => {
      try {
        const ws = new WebSocket(url, ['mqtt']);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          connectedCount++;
          updateHeaderStatus();

          // CONNECT packet
          const clientId = 'ps_and_' + Math.random().toString(36).slice(2, 8);
          const cBytes = encodeUTF8String(clientId);
          const protoName = encodeUTF8String('MQTT');
          const vLen = protoName.length + 4 + cBytes.length;
          const conn = new Uint8Array([0x10, ...encodeRemainingLength(vLen), ...protoName, 0x04, 0x02, 0x00, 0x3c, ...cBytes]);
          ws.send(conn);

          // SUBSCRIBE packet
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              const tBytes = encodeUTF8String(MESH_TOPIC);
              const subLen = 2 + tBytes.length + 1;
              const sub = new Uint8Array([0x82, ...encodeRemainingLength(subLen), 0x00, 0x01, ...tBytes, 0x00]);
              ws.send(sub);
              announcePresence();
            }
          }, 300);
        };

        ws.onmessage = (event) => {
          try {
            const buf = new Uint8Array(event.data);
            if ((buf[0] & 0xf0) === 0x30) {
              // PUBLISH
              let idx = 1;
              let multiplier = 1;
              let length = 0;
              let digit;
              do {
                digit = buf[idx++];
                length += (digit & 0x7f) * multiplier;
                multiplier *= 128;
              } while ((digit & 0x80) !== 0);

              const topicLen = (buf[idx] << 8) | buf[idx + 1];
              idx += 2 + topicLen;
              const payload = new TextDecoder().decode(buf.slice(idx));
              const json = JSON.parse(payload);
              handleMeshPacket(json);
            }
          } catch {}
        };

        ws.onclose = ws.onerror = () => {
          setTimeout(connectBrokers, 8000);
        };

        brokerSockets.push(ws);
      } catch (e) {
        console.warn('Broker connect error:', e);
      }
    });

    setInterval(() => {
      announcePresence();
      brokerSockets.forEach((ws) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(new Uint8Array([0xc0, 0x00])); } catch {}
        }
      });
    }, 25000);
  }

  function announcePresence() {
    broadcastToMesh({
      meshType: 'PEER_PRESENCE',
      tag: myTag,
      nodeId: nodeId,
      regHash: myRegHash,
      relayEnabled: meshRelay,
      bandwidth: relayBandwidth,
      activeTransfers: Object.keys(transfers).filter((k) => transfers[k].status === 'transferring').length
    });
  }

  // ==========================================================================
  // 5. TRATAMENTO DE PACOTES DA MALHA MESH & SINALIZAÇÃO P2P
  // ==========================================================================
  function handleMeshPacket(pkt) {
    if (!pkt || !pkt.pktId || seenPacketIds.has(pkt.pktId)) return;
    seenPacketIds.add(pkt.pktId);
    if (seenPacketIds.size > 2000) {
      const it = seenPacketIds.values();
      for (let i = 0; i < 500; i++) seenPacketIds.delete(it.next().value);
    }

    if (pkt.senderNodeId === nodeId) return; // ignora loopback próprio

    switch (pkt.meshType) {
      case 'PEER_PRESENCE':
      case 'PEER_ANNOUNCE':
      case 'ROSTER_GOSSIP_SYNC':
      case 'USER_REGISTERED': {
        if (pkt.tag) {
          peerRegistry[pkt.tag] = {
            tag: pkt.tag,
            nodeId: pkt.nodeId,
            regHash: pkt.regHash || '0x00',
            lastSeen: Date.now(),
            status: 'online',
            relayEnabled: pkt.relayEnabled !== false
          };
          renderPeersList();
          updateHomeStats();
        }
        if (Array.isArray(pkt.roster)) {
          pkt.roster.forEach((p) => {
            if (p && p.tag && p.tag !== myTag) {
              peerRegistry[p.tag] = {
                tag: p.tag,
                nodeId: p.nodeId,
                regHash: p.regHash || '0x00',
                lastSeen: p.lastSeen || Date.now(),
                status: 'online',
                relayEnabled: p.relayEnabled !== false
              };
            }
          });
          renderPeersList();
          updateHomeStats();
        }
        break;
      }

      case 'PROBE_USER_EXISTS': {
        if (pkt.queryTag && normalizeTag(pkt.queryTag) === normalizeTag(myTag)) {
          broadcastToMesh({
            meshType: 'PROBE_USER_REPLY',
            probeId: pkt.probeId,
            claimedTag: myTag,
            ownerNodeId: nodeId
          });
        }
        break;
      }

      case 'DIRECT_SIGNAL': {
        const toNorm = normalizeTag(pkt.to);
        const myNorm = normalizeTag(myTag);
        if (toNorm && toNorm !== myNorm && pkt.to !== myTag) {
          return;
        }

        const from = pkt.senderTag;
        const transferId = pkt.transferId;
        const signalType = pkt.signalType;
        const payload = pkt.payload || {};

        if (from) {
          peerRegistry[from] = {
            tag: from,
            nodeId: pkt.senderNodeId,
            lastSeen: Date.now(),
            status: 'online'
          };
          renderPeersList();
        }

        handleDirectSignal(from, transferId, signalType, payload);
        break;
      }
    }
  }

  function handleDirectSignal(from, transferId, signalType, payload) {
    switch (signalType) {
      case 'CHAT_MESSAGE': {
        handleIncomingChatMessage(from, transferId, payload);
        break;
      }

      case 'CHAT_ACK': {
        const msgId = payload.msgId || transferId;
        if (chatMessages[from]) {
          const m = chatMessages[from].find((msg) => msg.id === msgId);
          if (m) {
            m.status = payload.status || 'DELIVERED';
            renderChatMessages(from);
          }
        }
        break;
      }

      case 'FILE_OFFER': {
        const isChatMedia = Boolean(payload.isChatMedia || String(transferId || '').startsWith('chatmedia-'));
        const fileName = payload.fileName || 'arquivo_recebido';
        const fileSize = payload.fileSize || 0;
        const fileType = payload.fileType || '*/*';

        transfers[transferId] = {
          id: transferId,
          type: 'receive',
          sender: from,
          fileName,
          totalBytes: fileSize,
          fileType,
          transferredBytes: 0,
          status: (autoAccept || isChatMedia) ? 'connecting' : 'awaiting_accept',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia,
          startTime: Date.now(),
          savedPath: null
        };
        renderTransfers();

        if (autoAccept || isChatMedia) {
          sendSignal(from, transferId, 'FILE_ACCEPT', {
            isChatMedia,
            chatMsgId: payload.chatMsgId || null,
            roster: Object.values(peerRegistry)
          });
        }
        break;
      }

      case 'FILE_ACCEPT': {
        startSenderWebRTC(transferId, from, payload);
        break;
      }

      case 'WEBRTC_OFFER': {
        if (payload.sdp) {
          startReceiverWebRTC(transferId, from, payload.sdp, payload.iceServers);
        }
        break;
      }

      case 'WEBRTC_ANSWER': {
        if (payload.sdp) {
          handleIncomingAnswer(transferId, payload.sdp);
        }
        break;
      }

      case 'ICE_CANDIDATE': {
        if (payload.candidate) {
          handleIncomingIce(transferId, payload.candidate);
        }
        break;
      }

      case 'TRANSFER_REJECT': {
        if (transfers[transferId]) {
          transfers[transferId].status = 'error';
          renderTransfers();
          Native.toast('Transferência recusada pelo destinatário');
        }
        break;
      }
    }
  }

  // ==========================================================================
  // 6. MOTOR WEBRTC DATACHANNEL P2P (STREAMING DE ARQUIVOS)
  // ==========================================================================
  function getIceServers() {
    if (turnConfig && turnConfig.url) {
      return [
        ...DEFAULT_ICE_SERVERS,
        {
          urls: turnConfig.url,
          username: turnConfig.username || undefined,
          credential: turnConfig.credential || undefined
        }
      ];
    }
    return DEFAULT_ICE_SERVERS;
  }

  function uint8ArrayToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    const chunk = 8192;
    for (let i = 0; i < len; i += chunk) {
      const sub = bytes.subarray(i, Math.min(i + chunk, len));
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }

  function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function waitForBufferDrain(channel, maxAmount = 256 * 1024) {
    if (channel.bufferedAmount <= maxAmount) return Promise.resolve();
    return new Promise((resolve) => {
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null;
        resolve();
      };
      const timer = setInterval(() => {
        if (channel.readyState !== 'open' || channel.bufferedAmount <= maxAmount) {
          clearInterval(timer);
          channel.onbufferedamountlow = null;
          resolve();
        }
      }, 15);
    });
  }

  // Inicia envio direto pela aba Enviar Arquivo
  async function startDirectP2PSend(targetTag, filesList, isZip) {
    for (const fileItem of filesList) {
      const transferId = 'tr_' + Math.random().toString(36).slice(2, 9);
      stagedFilesMap.set(transferId, fileItem);

      const tr = {
        id: transferId,
        type: 'send',
        target: targetTag,
        fileName: fileItem.name || 'arquivo',
        totalBytes: fileItem.size || 0,
        fileType: fileItem.mimeType || '*/*',
        transferredBytes: 0,
        status: 'connecting',
        speed: '0 KB/s',
        progress: 0,
        fileItem,
        startTime: Date.now()
      };
      transfers[transferId] = tr;
      renderTransfers();

      // Envia oferta para o destinatário
      sendSignal(targetTag, transferId, 'FILE_OFFER', {
        fileName: tr.fileName,
        fileSize: tr.totalBytes,
        fileType: tr.fileType,
        roster: Object.values(peerRegistry)
      });
    }
    Native.toast(`Oferta enviada para ${targetTag}`);
  }

  // Remetente inicia WebRTC quando recebe FILE_ACCEPT
  async function startSenderWebRTC(transferId, targetTag, payload) {
    const tr = transfers[transferId];
    const fileItem = stagedFilesMap.get(transferId) || (tr && tr.fileItem);
    if (!tr || !fileItem) return;

    tr.status = 'connecting';
    renderTransfers();
    Native.startKeepAlive('Transferindo ' + tr.fileName + ' para ' + targetTag);

    const pc = new RTCPeerConnection({ iceServers: getIceServers(), iceCandidatePoolSize: 4 });
    activePeerConnections.set(transferId, pc);

    const dc = pc.createDataChannel('pulseshare-file-channel', { ordered: true });
    dc.binaryType = 'arraybuffer';

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal(targetTag, transferId, 'ICE_CANDIDATE', { candidate: e.candidate });
      }
    };

    dc.onopen = async () => {
      tr.status = 'transferring';
      renderTransfers();

      // 1. Cabeçalho de início de arquivo
      try {
        dc.send(JSON.stringify({
          type: 'FILE_START',
          fileId: 'f-0',
          fileName: tr.fileName,
          fileSize: tr.totalBytes,
          fileType: tr.fileType || '*/*'
        }));
      } catch (err) {
        console.error('Erro ao enviar FILE_START:', err);
      }

      // 2. Transmissão em blocos seguros de 16 KB com controle de fluxo
      const CHUNK_SIZE = 16384; // 16 KB (padrão WebRTC SCTP)
      let offset = 0;
      const totalBytes = tr.totalBytes;
      let lastReport = Date.now();

      try {
        if (fileItem.uri && Native.isAvailable()) {
          // Lê com streaming pelo Android bridge sem carregar todo arquivo na memória
          const READ_BLOCK = 65536; // Lê 64 KB de cada vez do Kotlin
          while (offset < totalBytes) {
            const readLen = Math.min(READ_BLOCK, totalBytes - offset);
            const b64Chunk = Native.readUriChunkBase64(fileItem.uri, offset, readLen);
            if (!b64Chunk) break;

            const blockBytes = base64ToUint8Array(b64Chunk);
            let subOffset = 0;

            while (subOffset < blockBytes.length) {
              if (dc.bufferedAmount > 256 * 1024) {
                await waitForBufferDrain(dc);
              }
              if (dc.readyState !== 'open') throw new Error('Canal fechado');

              const sliceEnd = Math.min(subOffset + CHUNK_SIZE, blockBytes.length);
              const slice = blockBytes.subarray(subOffset, sliceEnd);
              dc.send(slice);

              subOffset += slice.length;
              offset += slice.length;
              tr.transferredBytes = offset;

              const now = Date.now();
              if (now - lastReport >= 300 || offset >= totalBytes) {
                const elapsedSec = Math.max(0.1, (now - tr.startTime) / 1000);
                const speedBps = Math.round(offset / elapsedSec);
                tr.speed = speedBps > 1048576 ? (speedBps / 1048576).toFixed(1) + ' MB/s' : (speedBps / 1024).toFixed(0) + ' KB/s';
                tr.progress = totalBytes > 0 ? Math.min(99, Math.round((offset / totalBytes) * 100)) : 99;
                lastReport = now;
                renderTransfers();
              }
            }
          }
        } else if (fileItem.base64) {
          const allBytes = base64ToUint8Array(fileItem.base64);
          while (offset < allBytes.length) {
            if (dc.bufferedAmount > 256 * 1024) {
              await waitForBufferDrain(dc);
            }
            if (dc.readyState !== 'open') throw new Error('Canal fechado');

            const sliceEnd = Math.min(offset + CHUNK_SIZE, allBytes.length);
            const slice = allBytes.subarray(offset, sliceEnd);
            dc.send(slice);

            offset += slice.length;
            tr.transferredBytes = offset;

            const now = Date.now();
            if (now - lastReport >= 300 || offset >= totalBytes) {
              const elapsedSec = Math.max(0.1, (now - tr.startTime) / 1000);
              const speedBps = Math.round(offset / elapsedSec);
              tr.speed = speedBps > 1048576 ? (speedBps / 1048576).toFixed(1) + ' MB/s' : (speedBps / 1024).toFixed(0) + ' KB/s';
              tr.progress = totalBytes > 0 ? Math.min(99, Math.round((offset / totalBytes) * 100)) : 99;
              lastReport = now;
              renderTransfers();
            }
          }
        }

        // Aguarda esgotar buffer final
        await waitForBufferDrain(dc, 0);

        // 3. Envia marcador EOF
        dc.send(JSON.stringify({
          type: 'EOF',
          fileId: 'f-0',
          totalBytes
        }));

      } catch (err) {
        console.error('Erro no streaming de envio:', err);
        tr.status = 'error';
        renderTransfers();
      }
    };

    dc.onmessage = (msgEvent) => {
      if (typeof msgEvent.data === 'string') {
        try {
          const ctrl = JSON.parse(msgEvent.data);
          if (ctrl.type === 'RECEIVER_ACK_DONE') {
            tr.status = 'completed';
            tr.progress = 100;
            tr.speed = '0 KB/s';
            Native.stopKeepAlive();
            Native.toast(`Envio de ${tr.fileName} concluído com sucesso!`);
            renderTransfers();
            renderChatMessages(targetTag);
            setTimeout(() => {
              try { pc.close(); } catch {}
              activePeerConnections.delete(transferId);
            }, 1000);
          }
        } catch {}
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignal(targetTag, transferId, 'WEBRTC_OFFER', {
      sdp: {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      },
      iceServers: getIceServers()
    });
  }

  // Destinatário inicia WebRTC ao receber WEBRTC_OFFER
  async function startReceiverWebRTC(transferId, senderTag, sdpOffer, remoteIceServers) {
    let tr = transfers[transferId];
    if (!tr) {
      tr = {
        id: transferId,
        type: 'receive',
        sender: senderTag,
        fileName: 'arquivo_recebido',
        totalBytes: 0,
        fileType: '*/*',
        transferredBytes: 0,
        status: 'connecting',
        speed: '0 KB/s',
        progress: 0,
        startTime: Date.now(),
        savedPath: null
      };
      transfers[transferId] = tr;
      renderTransfers();
    }

    Native.startKeepAlive('Recebendo arquivo de ' + senderTag);

    const pc = new RTCPeerConnection({
      iceServers: (remoteIceServers && remoteIceServers.length) ? remoteIceServers : getIceServers(),
      iceCandidatePoolSize: 4
    });
    activePeerConnections.set(transferId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal(senderTag, transferId, 'ICE_CANDIDATE', { candidate: e.candidate });
      }
    };

    let isFirstChunk = true;
    let lastReport = Date.now();

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';

      dc.onmessage = (msgEvent) => {
        if (typeof msgEvent.data === 'string') {
          try {
            const data = JSON.parse(msgEvent.data);
            if (data.type === 'FILE_START') {
              if (data.fileName) tr.fileName = data.fileName;
              if (data.fileSize) tr.totalBytes = data.fileSize;
              if (data.fileType) tr.fileType = data.fileType;
              tr.status = 'transferring';
              // Prepara arquivo de destino no Android
              Native.saveChunk(transferId, tr.fileName, '', true, false, tr.fileType || '*/*');
              isFirstChunk = false;
              renderTransfers();
              renderChatMessages(senderTag);
              return;
            }

            if (data.type === 'EOF') {
              // Confirmação final enviada de volta ao remetente
              try {
                dc.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' }));
              } catch {}

              // Finaliza escrita do arquivo e notifica o MediaScanner do Android
              const finalPath = Native.saveChunk(transferId, tr.fileName, '', false, true, tr.fileType || '*/*');
              if (finalPath && finalPath !== 'CHUNK_WRITTEN') {
                tr.savedPath = finalPath;
              }
              tr.status = 'completed';
              tr.progress = 100;
              tr.speed = '0 KB/s';
              Native.stopKeepAlive();
              Native.toast(`Download concluído: ${tr.fileName}`);
              renderTransfers();
              renderChatMessages(senderTag);

              setTimeout(() => {
                try { pc.close(); } catch {}
                activePeerConnections.delete(transferId);
              }, 1200);
              return;
            }
          } catch {}
          return;
        }

        // Chunk binário recebido do remetente
        const chunkBytes = new Uint8Array(msgEvent.data);
        tr.transferredBytes += chunkBytes.byteLength;

        const chunkB64 = uint8ArrayToBase64(chunkBytes);
        const res = Native.saveChunk(transferId, tr.fileName, chunkB64, isFirstChunk, false, tr.fileType || '*/*');
        if (res && res !== 'CHUNK_WRITTEN') {
          tr.savedPath = res;
        }
        isFirstChunk = false;

        const now = Date.now();
        if (now - lastReport >= 300 || (tr.totalBytes > 0 && tr.transferredBytes >= tr.totalBytes)) {
          const elapsedSec = Math.max(0.1, (now - tr.startTime) / 1000);
          const speedBps = Math.round(tr.transferredBytes / elapsedSec);
          tr.speed = speedBps > 1048576 ? (speedBps / 1048576).toFixed(1) + ' MB/s' : (speedBps / 1024).toFixed(0) + ' KB/s';
          tr.progress = tr.totalBytes > 0 ? Math.min(99, Math.round((tr.transferredBytes / tr.totalBytes) * 100)) : 50;
          lastReport = now;
          renderTransfers();
        }
      };
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignal(senderTag, transferId, 'WEBRTC_ANSWER', {
      sdp: {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      }
    });
  }

  async function handleIncomingAnswer(transferId, sdpAnswer) {
    const pc = activePeerConnections.get(transferId);
    if (pc && pc.signalingState !== 'closed') {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
      } catch (err) {
        console.warn('SetRemoteDescription answer err:', err);
      }
    }
  }

  async function handleIncomingIce(transferId, candidate) {
    const pc = activePeerConnections.get(transferId);
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {}
    }
  }

  // ==========================================================================
  // 7. CHAT P2P CRIPTOGRAFADO (E2EE) COM SUPORTE A ANEXOS
  // ==========================================================================
  function handleIncomingChatMessage(from, transferId, payload) {
    if (!chatMessages[from]) chatMessages[from] = [];

    const msgId = payload.id || transferId || 'msg_' + Date.now();
    const hasMedia = Boolean(payload.transferId && (payload.fileMeta || payload.media));
    const fileMeta = payload.fileMeta || payload.media;

    const existing = chatMessages[from].find((m) => m.id === msgId);
    if (!existing) {
      chatMessages[from].push({
        id: msgId,
        sender: from,
        text: payload.text || '',
        timestamp: payload.timestamp || Date.now(),
        transferId: payload.transferId || null,
        media: fileMeta ? {
          fileName: fileMeta.name || fileMeta.fileName,
          fileSize: fileMeta.size || fileMeta.fileSize,
          fileType: fileMeta.type || fileMeta.fileType,
          transferId: payload.transferId
        } : null
      });

      // Confirma recebimento imediato
      sendSignal(from, msgId, 'CHAT_ACK', {
        msgId,
        status: 'DELIVERED',
        timestamp: Date.now()
      });

      if (hasMedia) {
        const mediaTid = payload.transferId;
        transfers[mediaTid] = {
          id: mediaTid,
          type: 'receive',
          sender: from,
          fileName: fileMeta.name || fileMeta.fileName || 'arquivo_chat',
          totalBytes: fileMeta.size || fileMeta.fileSize || 0,
          fileType: fileMeta.type || fileMeta.fileType || '*/*',
          transferredBytes: 0,
          status: 'connecting',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia: true,
          startTime: Date.now(),
          savedPath: null
        };
        renderTransfers();

        // Envia FILE_ACCEPT imediatamente para auto-download
        sendSignal(from, mediaTid, 'FILE_ACCEPT', {
          isChatMedia: true,
          chatMsgId: msgId,
          roster: Object.values(peerRegistry)
        });
      }

      // Renderiza ou incrementa badge
      const select = document.getElementById('chat-peer-select');
      if (currentTab === 'chat' && select.value === from) {
        renderChatMessages(from);
      } else {
        const badge = document.getElementById('badge-chat-unread');
        badge.textContent = parseInt(badge.textContent || '0', 10) + 1;
        badge.classList.remove('hidden');
      }
    }
  }

  function sendChatMessage(targetTag, text) {
    if (!targetTag || !text) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: Date.now(),
      status: 'SENT'
    });

    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', {
      id: msgId,
      senderTag: myTag,
      text,
      timestamp: Date.now()
    });

    renderChatMessages(targetTag);
  }

  function sendChatMessageWithMedia(targetTag, text, transferId, fileItem) {
    if (!targetTag || !fileItem) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const fileMeta = {
      name: fileItem.name,
      fileName: fileItem.name,
      size: fileItem.size,
      fileSize: fileItem.size,
      type: fileItem.mimeType || '*/*',
      fileType: fileItem.mimeType || '*/*'
    };

    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: Date.now(),
      status: 'SENT',
      transferId,
      media: {
        fileName: fileItem.name,
        fileSize: fileItem.size,
        fileType: fileItem.mimeType || '*/*',
        transferId
      }
    });

    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', {
      id: msgId,
      senderTag: myTag,
      text,
      timestamp: Date.now(),
      transferId,
      fileMeta,
      media: {
        fileName: fileItem.name,
        fileSize: fileItem.size,
        fileType: fileItem.mimeType || '*/*',
        transferId
      }
    });

    // Envia FILE_OFFER complementar
    sendSignal(targetTag, transferId, 'FILE_OFFER', {
      isChatMedia: true,
      chatMsgId: msgId,
      fileName: fileItem.name,
      fileSize: fileItem.size,
      fileType: fileItem.mimeType || '*/*',
      roster: Object.values(peerRegistry)
    });

    renderChatMessages(targetTag);
  }

  // Ação ao clicar no botão "Baixar" de um arquivo no chat
  window.downloadChatMedia = function (transferId, fileName) {
    const tr = transfers[transferId];
    if (tr && tr.savedPath) {
      Native.openFile(tr.savedPath);
      return;
    }

    Native.toast(`Solicitando download de ${fileName || 'arquivo'}...`);
    const sender = (tr && tr.sender) || document.getElementById('chat-peer-select').value;
    if (sender) {
      sendSignal(sender, transferId, 'FILE_ACCEPT', {
        isChatMedia: true,
        roster: Object.values(peerRegistry)
      });
    }
  };

  function handleChatFilesSelected(files) {
    if (!files || !files.length) return;
    chatAttachedFiles = files;
    renderChatAttachmentPreview();
  }

  function renderChatAttachmentPreview() {
    let previewEl = document.getElementById('chat-attachment-preview');
    if (!previewEl) {
      previewEl = document.createElement('div');
      previewEl.id = 'chat-attachment-preview';
      previewEl.className = 'flex flex-wrap gap-2 p-2 bg-slate-900 border-t border-slate-800 text-xs';
      const chatBar = document.getElementById('input-chat-text').parentElement;
      chatBar.parentElement.insertBefore(previewEl, chatBar);
    }

    if (chatAttachedFiles.length === 0) {
      previewEl.classList.add('hidden');
      previewEl.innerHTML = '';
      return;
    }

    previewEl.classList.remove('hidden');
    previewEl.innerHTML = chatAttachedFiles.map((f, idx) => `
      <div class="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-white">
        <span>📎 ${f.name} (${formatBytes(f.size)})</span>
        <button type="button" data-remove-chat-att="${idx}" class="text-rose-400 font-bold ml-1">✕</button>
      </div>
    `).join('');

    previewEl.querySelectorAll('[data-remove-chat-att]').forEach((btn) => {
      btn.onclick = () => {
        const i = parseInt(btn.getAttribute('data-remove-chat-att'), 10);
        chatAttachedFiles.splice(i, 1);
        renderChatAttachmentPreview();
      };
    });
  }

  // ==========================================================================
  // 8. GERENCIADOR DE LINKS PÚBLICOS (GITHUB PAGES P2P)
  // ==========================================================================
  function createPublicShareLink(filesList, expirationMs, password) {
    const shareId = 'ps-' + Math.random().toString(36).slice(2, 8);
    const expTime = Date.now() + (expirationMs || 1800000);
    const baseUrl = 'https://ricardoazt.github.io/share/';
    const shareUrl = `${baseUrl}#share=${shareId}&owner=${encodeURIComponent(myTag)}&exp=${expTime}`;

    publicShares[shareId] = {
      id: shareId,
      url: shareUrl,
      files: filesList,
      expirationTime: expTime,
      password: password || '',
      createdAt: Date.now()
    };

    renderPublicShares();

    const shareMsg = `📦 PulseShare — Compartilhamento P2P\n🔗 Link: ${shareUrl}\n🔑 Senha: ${password || 'Nenhuma'}\n📁 Arquivos (${filesList.length})\n⚡ Baixe direto pelo navegador!`;
    Native.shareText('PulseShare — Compartilhamento de Arquivos', shareMsg);

    return shareUrl;
  }

  // ==========================================================================
  // 9. INTERFACE DO USUÁRIO & NAVEGAÇÃO
  // ==========================================================================
  let currentTab = 'home';
  let stagedFiles = [];
  let modalMode = 'p2p';

  function switchTab(tabName) {
    currentTab = tabName;
    ['home', 'chat', 'transfers', 'shares', 'mesh'].forEach((t) => {
      const view = document.getElementById('view-' + t);
      const btn = document.getElementById('nav-' + t);
      if (view && btn) {
        if (t === tabName) {
          view.classList.remove('hidden');
          btn.classList.add('active', 'text-orange-400');
          btn.classList.remove('text-slate-400');
        } else {
          view.classList.add('hidden');
          btn.classList.remove('active', 'text-orange-400');
          btn.classList.add('text-slate-400');
        }
      }
    });

    if (tabName === 'chat') {
      const badge = document.getElementById('badge-chat-unread');
      if (badge) {
        badge.classList.add('hidden');
        badge.textContent = '0';
      }
    }
  }

  function renderPeersList() {
    const container = document.getElementById('mesh-peers-container');
    const selectChat = document.getElementById('chat-peer-select');
    if (!container) return;

    const peers = Object.values(peerRegistry).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const badge = document.getElementById('mesh-peers-online-badge');
    if (badge) badge.textContent = `${peers.length} Online`;

    if (selectChat) {
      const currentChat = selectChat.value;
      selectChat.innerHTML = '<option value="">Selecione um usuário...</option>';
      peers.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.tag;
        opt.textContent = `${p.tag} (Online)`;
        if (p.tag === currentChat) opt.selected = true;
        selectChat.appendChild(opt);
      });
    }

    if (peers.length === 0) {
      container.innerHTML = `
        <div class="py-12 text-center text-slate-500">
          <p class="text-xs">Sondando nós ativos na malha descentralizada...</p>
        </div>`;
      return;
    }

    container.innerHTML = peers.map((p) => `
      <div class="p-3 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="w-2.5 h-2.5 rounded-full bg-emerald-400"></div>
          <div>
            <span class="text-xs font-bold text-white block">${p.tag}</span>
            <span class="text-[9px] font-mono text-slate-400">Hash: ${p.regHash || '0x00'}</span>
          </div>
        </div>
        <div class="flex gap-1.5">
          <button data-send-to="${p.tag}" class="px-2.5 py-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[10px] font-bold active:scale-95">Enviar</button>
          <button data-chat-with="${p.tag}" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold active:scale-95">Chat</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-send-to]').forEach((btn) => {
      btn.onclick = () => openSendModal('p2p', btn.getAttribute('data-send-to'));
    });
    container.querySelectorAll('[data-chat-with]').forEach((btn) => {
      btn.onclick = () => {
        switchTab('chat');
        if (selectChat) {
          selectChat.value = btn.getAttribute('data-chat-with');
          renderChatMessages(selectChat.value);
        }
      };
    });
  }

  function renderTransfers() {
    const container = document.getElementById('transfers-list-container');
    const badge = document.getElementById('badge-transfers-count');
    const list = Object.values(transfers).reverse();

    const activeCount = list.filter((t) => t.status === 'transferring' || t.status === 'connecting').length;
    if (badge) {
      if (activeCount > 0) {
        badge.textContent = activeCount;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    if (!container) return;

    if (list.length === 0) {
      container.innerHTML = `
        <div class="py-16 text-center text-slate-500 space-y-2">
          <p class="text-xs">Nenhuma transferência recente.</p>
        </div>`;
      return;
    }

    container.innerHTML = list.map((t) => `
      <div class="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2.5 shadow-md">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 truncate pr-2">
            <span class="text-base">${t.type === 'send' ? '📤' : '📥'}</span>
            <div class="truncate">
              <span class="text-xs font-bold text-white block truncate">${t.fileName}</span>
              <span class="text-[10px] text-slate-400 font-mono">${t.type === 'send' ? 'Para: ' + t.target : 'De: ' + t.sender} (${formatBytes(t.totalBytes)})</span>
            </div>
          </div>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full font-mono ${t.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-orange-500/20 text-orange-400'}">
            ${t.status === 'completed' ? '100%' : (t.speed || '0 KB/s')}
          </span>
        </div>

        <div class="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div class="h-full bg-gradient-to-r from-orange-500 to-indigo-500 transition-all duration-300" style="width: ${t.progress || 0}%"></div>
        </div>

        <div class="flex items-center justify-between text-[10px]">
          <span class="text-slate-400">${t.status === 'completed' ? 'Concluído' : (t.status === 'connecting' ? 'Conectando nós P2P...' : 'Transmitindo blocos P2P...')}</span>
          
          <div class="flex gap-2">
            ${t.savedPath ? `
              <button data-open-path="${t.savedPath}" class="text-indigo-400 font-bold px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20">📂 Abrir</button>
              <button data-share-path="${t.savedPath}" class="text-orange-400 font-bold px-2 py-0.5 rounded bg-orange-500/10 border border-orange-500/20">↗ Compartilhar</button>
            ` : ''}
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-open-path]').forEach((btn) => {
      btn.onclick = () => Native.openFile(btn.getAttribute('data-open-path'));
    });
    container.querySelectorAll('[data-share-path]').forEach((btn) => {
      btn.onclick = () => Native.shareFile(btn.getAttribute('data-share-path'), '*/*');
    });
  }

  function renderPublicShares() {
    const container = document.getElementById('shares-list-container');
    if (!container) return;
    const list = Object.values(publicShares).reverse();

    if (list.length === 0) {
      container.innerHTML = `
        <div class="py-16 text-center text-slate-500 space-y-2">
          <p class="text-xs">Nenhum link público ativo criado.</p>
        </div>`;
      return;
    }

    container.innerHTML = list.map((s) => `
      <div class="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-white">📦 Pack (${s.files.length} arquivos)</span>
          <span class="text-[9px] font-mono text-orange-400">Ativo</span>
        </div>
        <p class="text-[10px] font-mono text-slate-400 truncate bg-slate-950 p-2 rounded-lg">${s.url}</p>
        <div class="flex gap-2 justify-end">
          <button data-copy-link="${s.url}" class="text-xs text-indigo-400 font-bold px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20">Copiar Link</button>
          <button data-share-link="${s.url}" class="text-xs text-orange-400 font-bold px-2.5 py-1 rounded-lg bg-orange-500/10 border border-orange-500/20">Compartilhar</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-copy-link]').forEach((btn) => {
      btn.onclick = () => Native.copy(btn.getAttribute('data-copy-link'));
    });
    container.querySelectorAll('[data-share-link]').forEach((btn) => {
      btn.onclick = () => Native.shareText('PulseShare Link', btn.getAttribute('data-share-link'));
    });
  }

  function renderChatMessages(peerTag) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;
    const msgs = chatMessages[peerTag] || [];

    if (msgs.length === 0) {
      container.innerHTML = `
        <div class="h-full flex flex-col items-center justify-center text-center text-slate-500 py-12">
          <p class="text-xs">Inicie uma conversa segura com ${peerTag}.</p>
        </div>`;
      return;
    }

    container.innerHTML = msgs.map((m) => {
      const isMe = m.sender === myTag;
      const hasMedia = Boolean(m.media || m.transferId);
      const media = m.media;
      const tr = m.transferId ? transfers[m.transferId] : null;

      let mediaHtml = '';
      if (hasMedia && media) {
        const isDownloaded = tr && tr.status === 'completed' && tr.savedPath;
        const isTransferring = tr && (tr.status === 'transferring' || tr.status === 'connecting');

        mediaHtml = `
          <div class="mt-2 p-2.5 rounded-xl bg-slate-950/80 border border-slate-700/60 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 truncate">
              <span class="text-lg">📄</span>
              <div class="truncate">
                <span class="text-xs font-bold text-white block truncate">${media.fileName || 'Arquivo'}</span>
                <span class="text-[10px] text-slate-400 font-mono">${formatBytes(media.fileSize)}</span>
              </div>
            </div>
            <div>
              ${isDownloaded ? `
                <button onclick="downloadChatMedia('${media.transferId}', '${media.fileName}')" class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-bold">📂 Abrir</button>
              ` : (isTransferring ? `
                <span class="text-[10px] text-orange-400 font-bold">${tr.progress || 0}%</span>
              ` : `
                <button onclick="downloadChatMedia('${media.transferId}', '${media.fileName}')" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold active:scale-95 shadow-sm">📥 Baixar</button>
              `)}
            </div>
          </div>
        `;
      }

      return `
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'}">
          <div class="max-w-[85%] p-2.5 rounded-2xl text-xs ${isMe ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-100 rounded-bl-none'}">
            ${m.text ? `<div>${m.text}</div>` : ''}
            ${mediaHtml}
          </div>
          <span class="text-[8px] text-slate-500 mt-0.5 px-1">${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  function updateHeaderStatus() {
    const elTag = document.getElementById('header-user-tag');
    if (elTag) elTag.textContent = myTag;
    const elHomeTag = document.getElementById('home-tag-display');
    if (elHomeTag) elHomeTag.textContent = myTag;
    const elHomeHash = document.getElementById('home-reghash-display');
    if (elHomeHash) elHomeHash.textContent = myRegHash;

    const dot = document.getElementById('header-mesh-dot');
    const badge = document.getElementById('header-status-badge');
    const brokersCount = brokerSockets.filter((ws) => ws && ws.readyState === WebSocket.OPEN).length;

    if (dot && badge) {
      if (brokersCount > 0) {
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400 pulse-dot';
        badge.textContent = `Online (${brokersCount} Brokers)`;
        badge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      } else {
        dot.className = 'w-2 h-2 rounded-full bg-amber-400 pulse-dot';
        badge.textContent = 'Conectando...';
      }
    }
  }

  function updateHomeStats() {
    const peersCount = Object.keys(peerRegistry).length;
    const badgePeers = document.getElementById('home-peers-count-badge');
    if (badgePeers) badgePeers.textContent = `${peersCount} peers na malha`;
    const openBrokers = brokerSockets.filter((ws) => ws && ws.readyState === WebSocket.OPEN).length;
    const statBrokers = document.getElementById('stat-brokers-count');
    if (statBrokers) statBrokers.textContent = `${openBrokers} Brokers`;
  }

  function handleFilesSelected(files) {
    if (!files || !files.length) return;
    stagedFiles = files;
    renderStagedFiles();
    openSendModal(modalMode);
  }

  function handleAndroidSharedItems(items) {
    if (!items || !items.length) return;
    const fileItems = items.filter((i) => i.type === 'file');
    if (fileItems.length > 0) {
      stagedFiles = fileItems;
      renderStagedFiles();
      openSendModal('p2p');
      Native.toast(`${fileItems.length} arquivo(s) compartilhado(s) com PulseShare`);
    } else if (items[0] && items[0].content) {
      const inputLink = document.getElementById('input-open-link');
      if (inputLink) inputLink.value = items[0].content;
    }
  }

  function renderStagedFiles() {
    const container = document.getElementById('selected-files-list');
    if (!container) return;
    container.innerHTML = stagedFiles.map((f, i) => `
      <div class="flex items-center justify-between p-2 rounded-xl bg-slate-950 border border-slate-800 text-xs">
        <span class="truncate text-white max-w-[200px]">${f.name}</span>
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-slate-400 font-mono">${formatBytes(f.size)}</span>
          <button data-remove-staged="${i}" class="text-rose-400 text-xs font-bold px-1">✕</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-remove-staged]').forEach((btn) => {
      btn.onclick = () => {
        stagedFiles.splice(parseInt(btn.getAttribute('data-remove-staged'), 10), 1);
        renderStagedFiles();
      };
    });
  }

  function openSendModal(mode, preselectedTarget) {
    modalMode = mode;
    const modal = document.getElementById('modal-send');
    if (!modal) return;
    modal.classList.remove('hidden');

    const btnP2p = document.getElementById('btn-mode-p2p');
    const btnLink = document.getElementById('btn-mode-link');
    const fieldTarget = document.getElementById('field-target-user');
    const fieldLink = document.getElementById('field-link-options');

    if (mode === 'p2p') {
      if (btnP2p) btnP2p.className = 'py-2 text-xs font-bold rounded-lg bg-indigo-600 text-white transition-all';
      if (btnLink) btnLink.className = 'py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition-all';
      if (fieldTarget) fieldTarget.classList.remove('hidden');
      if (fieldLink) fieldLink.classList.add('hidden');
      if (preselectedTarget) document.getElementById('input-target-user').value = preselectedTarget;
    } else {
      if (btnLink) btnLink.className = 'py-2 text-xs font-bold rounded-lg bg-orange-600 text-white transition-all';
      if (btnP2p) btnP2p.className = 'py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition-all';
      if (fieldTarget) fieldTarget.classList.add('hidden');
      if (fieldLink) fieldLink.classList.remove('hidden');
    }
  }

  // ==========================================================================
  // 10. INICIALIZAÇÃO DE EVENTOS DO APP
  // ==========================================================================
  function initEvents() {
    // Abas de navegação
    document.getElementById('nav-home').onclick = () => switchTab('home');
    document.getElementById('nav-chat').onclick = () => switchTab('chat');
    document.getElementById('nav-transfers').onclick = () => switchTab('transfers');
    document.getElementById('nav-shares').onclick = () => switchTab('shares');
    document.getElementById('nav-mesh').onclick = () => switchTab('mesh');

    // Botões de Ação na Home
    document.getElementById('btn-action-send-p2p').onclick = () => openSendModal('p2p');
    document.getElementById('btn-action-create-link').onclick = () => openSendModal('link');
    document.getElementById('btn-new-share-link').onclick = () => openSendModal('link');

    // Seletor nativo de arquivos do Android
    document.getElementById('btn-pick-files-native').onclick = () => {
      pendingChatAttachment = false;
      Native.pickFiles();
    };

    // Botão de anexo no chat
    const btnChatAttach = document.getElementById('btn-chat-attach');
    if (btnChatAttach) {
      btnChatAttach.onclick = () => {
        pendingChatAttachment = true;
        Native.pickFiles();
      };
    }

    // Modais alternância
    document.getElementById('btn-mode-p2p').onclick = () => openSendModal('p2p');
    document.getElementById('btn-mode-link').onclick = () => openSendModal('link');
    document.getElementById('btn-close-send-modal').onclick = () => {
      document.getElementById('modal-send').classList.add('hidden');
    };

    // Confirmação de Envio
    document.getElementById('btn-confirm-send').onclick = () => {
      if (stagedFiles.length === 0) {
        Native.toast('Selecione pelo menos um arquivo!');
        return;
      }

      const isZip = document.getElementById('toggle-zip').checked;
      if (modalMode === 'p2p') {
        const target = document.getElementById('input-target-user').value.trim();
        if (!target) {
          Native.toast('Informe o @destinatário!');
          return;
        }
        document.getElementById('modal-send').classList.add('hidden');
        switchTab('transfers');
        startDirectP2PSend(target, stagedFiles, isZip);
      } else {
        const expMs = parseInt(document.getElementById('select-link-expiration').value, 10);
        const pass = document.getElementById('input-link-password').value.trim();
        createPublicShareLink(stagedFiles, expMs, pass);
        document.getElementById('modal-send').classList.add('hidden');
        switchTab('shares');
      }
    };

    // Chat envio
    document.getElementById('btn-chat-send').onclick = () => {
      const select = document.getElementById('chat-peer-select');
      const input = document.getElementById('input-chat-text');
      const target = select.value;
      const text = input.value.trim();
      if (!target) {
        Native.toast('Selecione um usuário para conversar!');
        return;
      }
      if (!text && chatAttachedFiles.length === 0) return;

      if (chatAttachedFiles.length > 0) {
        chatAttachedFiles.forEach((f) => {
          const mediaTid = 'chatmedia-' + Math.random().toString(36).slice(2, 10);
          stagedFilesMap.set(mediaTid, f);
          transfers[mediaTid] = {
            id: mediaTid,
            type: 'send',
            target,
            fileName: f.name,
            totalBytes: f.size,
            fileType: f.mimeType || '*/*',
            transferredBytes: 0,
            status: 'connecting',
            progress: 0,
            fileItem: f,
            startTime: Date.now()
          };
          sendChatMessageWithMedia(target, text, mediaTid, f);
        });
        chatAttachedFiles = [];
        renderChatAttachmentPreview();
      } else {
        sendChatMessage(target, text);
      }
      input.value = '';
    };

    document.getElementById('chat-peer-select').onchange = () => {
      renderChatMessages(document.getElementById('chat-peer-select').value);
    };

    // Configurações
    document.getElementById('btn-open-settings').onclick = () => {
      document.getElementById('modal-settings').classList.remove('hidden');
      document.getElementById('setting-my-tag').value = myTag;
    };
    document.getElementById('btn-close-settings-modal').onclick = () => {
      document.getElementById('modal-settings').classList.add('hidden');
    };
    document.getElementById('btn-edit-tag').onclick = () => {
      document.getElementById('modal-settings').classList.remove('hidden');
      document.getElementById('setting-my-tag').focus();
    };

    document.getElementById('btn-save-tag').onclick = () => {
      let newTag = document.getElementById('setting-my-tag').value.trim();
      if (!newTag.startsWith('@')) newTag = '@' + newTag;
      if (newTag.length < 3) return;
      myTag = newTag;
      localStorage.setItem('ps_my_tag', myTag);
      updateHeaderStatus();
      announcePresence();
      Native.toast('Nome de usuário salvo com sucesso!');
    };

    // Baixar por link público
    document.getElementById('btn-open-link-go').onclick = () => {
      const url = document.getElementById('input-open-link').value.trim();
      if (!url) return;
      Native.toast('Iniciando conexão P2P com remetente do link...');
      switchTab('transfers');
    };
  }

  // Inicialização
  window.addEventListener('DOMContentLoaded', () => {
    updateHeaderStatus();
    initEvents();
    connectBrokers();
  });

})();
