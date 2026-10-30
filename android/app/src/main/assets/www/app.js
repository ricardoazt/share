/**
 * PulseShare Android Native Application Core (app.js)
 * Conexão Multi-Broker MQTT + WebRTC DataChannel + BLE Mesh + Nostr Identity
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
  let activeProfile = null;
  let nodeId = localStorage.getItem('ps_node_id');
  if (!nodeId) {
    nodeId = 'and_' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    localStorage.setItem('ps_node_id', nodeId);
  }

  let myTag = localStorage.getItem('ps_my_tag') || '';
  let myRegHash = localStorage.getItem('ps_my_reghash') || '';
  let autoAccept = localStorage.getItem('ps_auto_accept') !== 'false';
  let chatAutoDownload = localStorage.getItem('ps_chat_auto_download') === 'true'; // Padrão: false (não baixa automaticamente pelo chat)
  let customDownloadFolder = localStorage.getItem('ps_download_folder') || 'PulseShare';
  let transfersFilter = 'active'; // 'active' ou 'history'
  let meshRelay = localStorage.getItem('ps_mesh_relay') !== 'false';
  let relayBandwidth = parseInt(localStorage.getItem('ps_relay_bw') || '2048', 10);
  let turnConfig = JSON.parse(localStorage.getItem('ps_turn_config') || 'null');

  // Registros em memória
  const peerRegistry = {}; // tag -> peer info
  const peerTransports = {}; // tag -> 'LAN' | 'BLE' | 'P2P'
  const directDataChannels = new Map(); // tag -> RTCDataChannel
  const blePeers = new Map(); // tag -> { rssi, address, lastSeen }
  const transfers = {}; // transferId -> transfer info
  const publicShares = {}; // shareId -> share info
  let chatMessages = {}; // tag -> array de msgs
  try {
    const savedChats = localStorage.getItem('ps_chat_messages');
    if (savedChats) chatMessages = JSON.parse(savedChats);
  } catch (e) {
    chatMessages = {};
  }

  function saveChatMessagesToStorage() {
    try {
      localStorage.setItem('ps_chat_messages', JSON.stringify(chatMessages));
    } catch (e) {}
  }

  const brokerSockets = [];
  const seenPacketIds = new Set();
  const activePeerConnections = new Map(); // transferId -> RTCPeerConnection
  const stagedFilesMap = new Map(); // transferId -> fileItem

  let activeChatPeer = null;
  let selectedCategory = 'Todas';
  let customCategories = JSON.parse(localStorage.getItem('ps_custom_categories') || '["Todas", "Favoritos", "Família", "Trabalho"]');

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

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `${hours}:${mins}`;
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Ontem ${hours}:${mins}`;
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hours}:${mins}`;
  }

  // ==========================================================================
  // 3. COMUNICAÇÃO NATIVA COM ANDROID (PULSESHARE NATIVE BRIDGE)
  // ==========================================================================
  const Native = {
    isAvailable: () => typeof window.PulseShareNative !== 'undefined',
    pickFiles: () => {
      if (Native.isAvailable()) window.PulseShareNative.pickFiles();
      else {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = (e) => {
          if (e.target.files && e.target.files.length) {
            const list = Array.from(e.target.files).map(f => ({
              name: f.name,
              size: f.size,
              mimeType: f.type || 'application/octet-stream',
              file: f
            }));
            if (pendingChatAttachment) {
              pendingChatAttachment = false;
              handleChatFilesSelected(list);
            } else {
              handleFilesSelected(list);
            }
          }
        };
        input.click();
      }
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
      else if (path && path.startsWith('blob:')) window.open(path, '_blank');
    },
    getDownloadDirectory: () => {
      if (Native.isAvailable() && window.PulseShareNative.getDownloadDirectory) {
        return window.PulseShareNative.getDownloadDirectory();
      }
      return '/storage/emulated/0/Download/' + (customDownloadFolder || 'PulseShare');
    },
    setDownloadDirectory: (folder) => {
      if (Native.isAvailable() && window.PulseShareNative.setDownloadDirectory) {
        return window.PulseShareNative.setDownloadDirectory(folder);
      }
      return '/storage/emulated/0/Download/' + (folder || 'PulseShare');
    },
    openDownloadFolder: () => {
      if (Native.isAvailable() && window.PulseShareNative.openDownloadFolder) {
        window.PulseShareNative.openDownloadFolder();
      } else {
        Native.toast('Diretório: ' + Native.getDownloadDirectory());
      }
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
    },
    // BLUETOOTH BLE MESH
    isBleAvailable: () => {
      if (Native.isAvailable() && window.PulseShareNative.isBleAvailable) {
        return window.PulseShareNative.isBleAvailable();
      }
      return false;
    },
    startBleMesh: (tag) => {
      if (Native.isAvailable() && window.PulseShareNative.startBleMesh) {
        window.PulseShareNative.startBleMesh(tag);
      }
    },
    stopBleMesh: () => {
      if (Native.isAvailable() && window.PulseShareNative.stopBleMesh) {
        window.PulseShareNative.stopBleMesh();
      }
    },
    getNearbyBlePeers: () => {
      if (Native.isAvailable() && window.PulseShareNative.getNearbyBlePeers) {
        try {
          return JSON.parse(window.PulseShareNative.getNearbyBlePeers() || '[]');
        } catch { return []; }
      }
      return [];
    },
    sendBleMessage: (targetTag, msgJson) => {
      if (Native.isAvailable() && window.PulseShareNative.sendBleMessage) {
        return window.PulseShareNative.sendBleMessage(targetTag, msgJson);
      }
      return false;
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
    onBleMessageReceived: (fromTag, messageJson) => {
      handleBleIncomingMessage(fromTag, messageJson);
    },
    onBlePeersUpdated: (peersJson) => {
      handleBlePeersUpdated(peersJson);
    },
    onBackPressed: () => {
      // 1. Modais prioritários
      const modalSearch = document.getElementById('modal-global-search');
      if (modalSearch && !modalSearch.classList.contains('hidden')) {
        modalSearch.classList.add('hidden');
        return 'HANDLED';
      }
      const modalId = document.getElementById('modal-identity-profile');
      if (modalId && !modalId.classList.contains('hidden')) {
        modalId.classList.add('hidden');
        return 'HANDLED';
      }
      const modalPair = document.getElementById('modal-qr-pair-scanner');
      if (modalPair && !modalPair.classList.contains('hidden')) {
        modalPair.classList.add('hidden');
        return 'HANDLED';
      }
      const modalContact = document.getElementById('modal-contact-menu');
      if (modalContact && !modalContact.classList.contains('hidden')) {
        modalContact.classList.add('hidden');
        return 'HANDLED';
      }
      const modalAddCat = document.getElementById('modal-add-category-list');
      if (modalAddCat && !modalAddCat.classList.contains('hidden')) {
        modalAddCat.classList.add('hidden');
        return 'HANDLED';
      }
      // 2. Se a conversa ativa estiver aberta em full-screen, volta suavemente para a lista!
      const activePane = document.getElementById('chat-active-conversation-pane');
      if (activePane && activePane.classList.contains('active')) {
        closeActiveChat();
        return 'HANDLED';
      }
      // 3. Outros modais
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
      // 4. Se não estiver no chat, volta para a aba chat
      if (currentTab !== 'chat') {
        switchTab('chat');
        return 'HANDLED';
      }
      return 'EXIT';
    }
  };

  // ==========================================================================
  // 4. IDENTIDADE CRIPTOGRÁFICA NOSTR-STYLE (7 PALAVRAS & 2FA & MULTI-PERFIL)
  // ==========================================================================
  async function initCryptoIdentity() {
    if (typeof PulseShareCrypto === 'undefined') return;

    let p = PulseShareCrypto.ProfilesManager.getActiveProfile();
    if (!p) {
      const defaultName = 'Usuario_' + Math.random().toString(36).slice(2, 6);
      const seedWords = PulseShareCrypto.generate7WordMnemonic();
      p = await PulseShareCrypto.deriveIdentity(defaultName, seedWords);
      p.id = 'prof_' + Date.now();
      PulseShareCrypto.ProfilesManager.saveProfile(p);
    } else if (p.avatar && p.avatar.startsWith('data:image/svg+xml;utf8,')) {
      p.avatar = p.avatar.replace('data:image/svg+xml;utf8,', '');
      PulseShareCrypto.ProfilesManager.saveProfile(p);
    }

    activeProfile = p;
    myTag = p.tag;
    myRegHash = p.regHash || '0x' + p.pubKeyHex.slice(0, 12);
    localStorage.setItem('ps_my_tag', myTag);
    localStorage.setItem('ps_my_reghash', myRegHash);

    // Inicia rádio Bluetooth BLE Mesh se disponível
    if (Native.isBleAvailable()) {
      Native.startBleMesh(myTag);
    }

    updateIdentityUI();
  }

  function updateIdentityUI() {
    if (!activeProfile) return;

    const headerAvatar = document.getElementById('header-avatar-slot');
    if (headerAvatar) headerAvatar.innerHTML = activeProfile.avatar;

    const headerName = document.getElementById('header-profile-name');
    if (headerName) headerName.textContent = activeProfile.name || 'PulseShare';

    const headerTag = document.getElementById('header-user-tag');
    if (headerTag) headerTag.textContent = myTag;

    const homeAvatar = document.getElementById('home-avatar-slot');
    if (homeAvatar) homeAvatar.innerHTML = activeProfile.avatar;

    const homeTag = document.getElementById('home-tag-display');
    if (homeTag) homeTag.textContent = myTag;

    const homeReg = document.getElementById('home-reghash-display');
    if (homeReg) homeReg.textContent = myRegHash;

    const settingTag = document.getElementById('setting-my-tag');
    if (settingTag) settingTag.value = myTag;
  }

  function renderIdentityModal() {
    if (!activeProfile) return;

    const slot = document.getElementById('identity-avatar-slot');
    if (slot) slot.innerHTML = activeProfile.avatar;

    const nameEl = document.getElementById('identity-name-display');
    if (nameEl) nameEl.textContent = activeProfile.name;

    const tagEl = document.getElementById('identity-tag-display');
    if (tagEl) tagEl.textContent = myTag;

    // Renderiza chips das 7 palavras de recuperação
    const grid = document.getElementById('seed-words-chips-grid');
    if (grid) {
      const words = (activeProfile.seedWords || '').split(/\s+/);
      grid.innerHTML = words.map((w, idx) => `
        <div class="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700/80 flex flex-col items-center">
          <span class="text-[9px] text-slate-500 font-bold">${idx + 1}</span>
          <span class="text-xs font-bold text-indigo-300 font-mono">${w}</span>
        </div>
      `).join('');
    }

    // Toggle 2FA
    const toggle2fa = document.getElementById('toggle-2fa-pin');
    const fieldPin = document.getElementById('field-pin-setup');
    if (toggle2fa && fieldPin) {
      toggle2fa.checked = Boolean(activeProfile.has2fa);
      fieldPin.classList.toggle('hidden', !toggle2fa.checked);
    }

    // Lista de múltiplos perfis
    const profilesList = document.getElementById('profiles-list-container');
    if (profilesList) {
      const all = PulseShareCrypto.ProfilesManager.getAllProfiles();
      profilesList.innerHTML = all.map(p => {
        const isCurrent = p.id === activeProfile.id;
        return `
          <div class="p-2.5 rounded-xl ${isCurrent ? 'bg-indigo-900/30 border border-indigo-500/50' : 'bg-slate-900 border border-slate-800'} flex items-center justify-between">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-7 h-7 rounded-lg overflow-hidden shrink-0">${p.avatar}</div>
              <div class="min-w-0">
                <span class="text-xs font-bold text-white block truncate">${p.name} ${isCurrent ? '(Ativo)' : ''}</span>
                <span class="text-[10px] font-mono text-slate-400 block truncate">${p.tag}</span>
              </div>
            </div>
            ${!isCurrent ? `
              <button type="button" data-switch-profile="${p.id}" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-indigo-300 font-semibold border border-slate-700 active:scale-95">
                Usar
              </button>
            ` : '<span class="text-[10px] text-emerald-400 font-bold">● Ativo</span>'}
          </div>
        `;
      }).join('');

      profilesList.querySelectorAll('[data-switch-profile]').forEach(btn => {
        btn.onclick = () => {
          const pid = btn.getAttribute('data-switch-profile');
          PulseShareCrypto.ProfilesManager.switchProfile(pid);
          window.location.reload();
        };
      });
    }

    // Gera SVG QR Code para pareamento com extensão
    const qrArea = document.getElementById('qr-code-display-area');
    if (qrArea) {
      const pairPayload = JSON.stringify({
        action: 'pulseshare_pair_v2',
        name: activeProfile.name,
        seedWords: activeProfile.seedWords,
        pubKeyHex: activeProfile.pubKeyHex,
        tag: activeProfile.tag,
        timestamp: Date.now()
      });
      qrArea.innerHTML = PulseShareCrypto.generateQRCodeSVG(pairPayload, 180) + `
        <span class="text-[10px] text-slate-700 font-mono mt-2 text-center">Escaneie pelo app para parear</span>
      `;
    }
  }

  // ==========================================================================
  // 5. PROTOCOLO MQTT BINÁRIO SOBRE WEBSOCKETS (SINALIZAÇÃO P2P)
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

          // SUBSCRIBE packet
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

          announcePresence();
        };

        ws.onmessage = (event) => {
          handleIncomingMqttBytes(new Uint8Array(event.data));
        };

        ws.onerror = () => {};
        ws.onclose = () => {
          connectedCount = Math.max(0, connectedCount - 1);
          updateHeaderStatus();
          setTimeout(() => connectBrokers(), 5000);
        };

        brokerSockets.push(ws);
      } catch (err) {
        console.warn('Falha ao conectar no broker:', url, err);
      }
    });

    setInterval(() => {
      announcePresence();
    }, 15000);
  }

  function handleIncomingMqttBytes(bytes) {
    if (!bytes || bytes.length === 0) return;
    const packetType = bytes[0] >> 4;
    if (packetType !== 3) return; // Somente PUBLISH

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
      const data = JSON.parse(jsonStr);
      handleIncomingPacket(data);
    } catch {}
  }

  function announcePresence() {
    if (!myTag) return;
    broadcastToMesh({
      meshType: 'PRESENCE_ANNOUNCE',
      tag: myTag,
      reghash: myRegHash,
      nodeId: nodeId,
      avatar: activeProfile ? activeProfile.avatar : null,
      clientType: 'android',
      relayMode: meshRelay
    });
  }

  function handleIncomingPacket(packet) {
    if (!packet || !packet.meshType) return;
    const pktId = packet.pktId || packet.packetId;
    if (pktId) {
      if (seenPacketIds.has(pktId)) return;
      seenPacketIds.add(pktId);
      if (seenPacketIds.size > 2000) seenPacketIds.clear();
    }
    if (packet.senderNodeId === nodeId || (packet.senderTag && normalizeTag(packet.senderTag) === normalizeTag(myTag))) return;

    switch (packet.meshType) {
      case 'PRESENCE_ANNOUNCE': {
        const tag = normalizeTag(packet.tag);
        if (tag && tag !== normalizeTag(myTag)) {
          peerRegistry[tag] = {
            tag: tag,
            name: tag.replace(/^@/, '').split('_')[0],
            reghash: packet.reghash || '0x0000',
            avatar: packet.avatar || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 64) : null),
            clientType: packet.clientType || 'peer',
            relayMode: packet.relayMode !== false,
            transport: peerTransports[tag] || 'P2P',
            lastSeen: Date.now()
          };
          updateHeaderStatus();
          renderConversationsList();
          renderMeshPeers();
        }
        break;
      }

      case 'DIRECT_SIGNAL': {
        const target = normalizeTag(packet.to);
        if (target === normalizeTag(myTag)) {
          handleDirectSignal(packet.senderTag, packet.transferId, packet.signalType, packet.payload);
        }
        break;
      }
    }
  }

  function handleBleIncomingMessage(fromTag, messageJson) {
    try {
      const data = typeof messageJson === 'string' ? JSON.parse(messageJson) : messageJson;
      peerTransports[fromTag] = 'BLE';
      handleIncomingChatMessage(data);
    } catch (e) {
      console.warn('Erro ao processar mensagem BLE:', e);
    }
  }

  function handleBlePeersUpdated(peersJson) {
    try {
      const peers = typeof peersJson === 'string' ? JSON.parse(peersJson) : peersJson;
      peers.forEach(p => {
        const tag = normalizeTag(p.tag);
        if (tag && tag !== myTag) {
          peerTransports[tag] = 'BLE';
          blePeers.set(tag, { rssi: p.rssi, address: p.address, lastSeen: Date.now() });
          if (!peerRegistry[tag]) {
            peerRegistry[tag] = {
              tag: tag,
              name: tag.replace(/^@/, '').split('_')[0],
              reghash: '0x0000',
              avatar: typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 64) : null,
              clientType: 'android-ble',
              transport: 'BLE',
              lastSeen: Date.now()
            };
          } else {
            peerRegistry[tag].transport = 'BLE';
          }
        }
      });
      renderConversationsList();
      renderMeshPeers();
    } catch {}
  }

  // ==========================================================================
  // 6. PROCESSAMENTO DE SINAIS DIRETOS WEBRTC & SINALIZAÇÃO
  // ==========================================================================
  function handleDirectSignal(from, transferId, signalType, payload) {
    switch (signalType) {
      case 'CHAT_MESSAGE': {
        handleIncomingChatMessage(payload);
        break;
      }

      case 'FILE_OFFER': {
        const isChatMedia = Boolean(payload.isChatMedia);
        const fileName = payload.fileName || 'arquivo_recebido';
        const fileSize = payload.fileSize || 0;
        const fileType = payload.fileType || '*/*';

        // Regra de Download: Se for pelo chat, só baixa automaticamente se chatAutoDownload for true.
        const shouldAccept = isChatMedia ? Boolean(chatAutoDownload) : Boolean(autoAccept);

        transfers[transferId] = {
          id: transferId,
          type: 'receive',
          sender: from,
          fileName,
          totalBytes: fileSize,
          fileType,
          transferredBytes: 0,
          status: shouldAccept ? 'connecting' : 'awaiting_accept',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia,
          chatMsgId: payload.chatMsgId || null,
          startTime: Date.now(),
          savedPath: null
        };
        renderTransfers();

        if (shouldAccept) {
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
          // Detecta se o candidato é LAN host direto (mesmo roteador/Wi-Fi)
          const candStr = payload.candidate.candidate || '';
          if (candStr.includes('typ host') && /(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(candStr)) {
            peerTransports[from] = 'LAN';
            console.log('⚡ Conexão LAN direta detectada com:', from);
            if (activeChatPeer === from) {
              const badge = document.getElementById('chat-contact-transport-badge');
              if (badge) {
                badge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0';
                badge.textContent = '🟢 LAN';
              }
            }
          }
          handleIncomingIce(transferId, payload.candidate);
        }
        break;
      }
    }
  }

  function getIceServers() {
    if (turnConfig && turnConfig.url) {
      return [
        ...DEFAULT_ICE_SERVERS,
        {
          urls: turnConfig.url,
          username: turnConfig.username,
          credential: turnConfig.credential
        }
      ];
    }
    return DEFAULT_ICE_SERVERS;
  }

  function uint8ArrayToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
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

  // ==========================================================================
  // 7. WEBRTC SENDER & RECEIVER CORE COM FIX DE BUFFER E STREAMING
  // ==========================================================================
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
    directDataChannels.set(targetTag, dc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal(targetTag, transferId, 'ICE_CANDIDATE', { candidate: e.candidate });
      }
    };

    dc.onopen = async () => {
      tr.status = 'transferring';
      renderTransfers();

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

      const CHUNK_SIZE = 16384; // 16 KB (WebRTC SCTP block)
      let offset = 0;
      const totalBytes = tr.totalBytes;
      let lastReport = Date.now();

      try {
        if (fileItem.uri && Native.isAvailable()) {
          // Android SAF streaming direto via Kotlin
          const READ_BLOCK = 65536; // 64 KB
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
              // Transmite fatia limpa do buffer com offset zero para evitar corrupção SCTP
              const rawBuf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
              dc.send(rawBuf);

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
                if (activeChatPeer === targetTag) renderChatMessages(targetTag);
              }
            }
          }
        } else {
          // Streaming para arquivos HTML5 File ou Blob (Web / Extensão)
          const fileObj = (fileItem instanceof Blob) ? fileItem : (fileItem.file instanceof Blob ? fileItem.file : null);
          if (fileObj) {
            while (offset < totalBytes) {
              if (dc.bufferedAmount > 256 * 1024) {
                await waitForBufferDrain(dc);
              }
              if (dc.readyState !== 'open') throw new Error('Canal fechado');

              const sliceEnd = Math.min(offset + CHUNK_SIZE, totalBytes);
              const blobSlice = fileObj.slice(offset, sliceEnd);
              const arrayBuf = await blobSlice.arrayBuffer();
              dc.send(arrayBuf);

              offset += arrayBuf.byteLength;
              tr.transferredBytes = offset;

              const now = Date.now();
              if (now - lastReport >= 300 || offset >= totalBytes) {
                const elapsedSec = Math.max(0.1, (now - tr.startTime) / 1000);
                const speedBps = Math.round(offset / elapsedSec);
                tr.speed = speedBps > 1048576 ? (speedBps / 1048576).toFixed(1) + ' MB/s' : (speedBps / 1024).toFixed(0) + ' KB/s';
                tr.progress = totalBytes > 0 ? Math.min(99, Math.round((offset / totalBytes) * 100)) : 99;
                lastReport = now;
                renderTransfers();
                if (activeChatPeer === targetTag) renderChatMessages(targetTag);
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
              const rawBuf = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
              dc.send(rawBuf);

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
                if (activeChatPeer === targetTag) renderChatMessages(targetTag);
              }
            }
          }
        }

        await waitForBufferDrain(dc, 0);

        // Envia marcador de fim de arquivo
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
            if (activeChatPeer === targetTag) renderChatMessages(targetTag);
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
      directDataChannels.set(senderTag, dc);

      dc.onmessage = (msgEvent) => {
        if (typeof msgEvent.data === 'string') {
          try {
            const data = JSON.parse(msgEvent.data);
            if (data.type === 'CHAT_DIRECT') {
              handleIncomingChatMessage(data.payload);
              return;
            }
            if (data.type === 'FILE_START') {
              if (data.fileName) tr.fileName = data.fileName;
              if (data.fileSize) tr.totalBytes = data.fileSize;
              if (data.fileType) tr.fileType = data.fileType;
              tr.status = 'transferring';
              if (Native.isAvailable()) {
                Native.saveChunk(transferId, tr.fileName, '', true, false, tr.fileType || '*/*');
              }
              isFirstChunk = false;
              renderTransfers();
              if (activeChatPeer === senderTag) renderChatMessages(senderTag);
              return;
            }

            if (data.type === 'EOF') {
              try {
                dc.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' }));
              } catch {}

              if (Native.isAvailable()) {
                const finalPath = Native.saveChunk(transferId, tr.fileName, '', false, true, tr.fileType || '*/*');
                if (finalPath && finalPath !== 'CHUNK_WRITTEN') {
                  tr.savedPath = finalPath;
                }
              } else if (tr._chunks) {
                const blob = new Blob(tr._chunks, { type: tr.fileType || 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(blob);
                tr.savedPath = blobUrl;
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = tr.fileName || 'arquivo';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                tr._chunks = null;
              }

              tr.status = 'completed';
              tr.progress = 100;
              tr.speed = '0 KB/s';
              Native.stopKeepAlive();
              Native.toast(`Download concluído: ${tr.fileName}`);
              renderTransfers();
              if (activeChatPeer === senderTag) renderChatMessages(senderTag);

              setTimeout(() => {
                try { pc.close(); } catch {}
                activePeerConnections.delete(transferId);
              }, 1200);
              return;
            }
          } catch {}
          return;
        }

        // Chunk binário recebido
        const chunkBytes = new Uint8Array(msgEvent.data);
        tr.transferredBytes += chunkBytes.byteLength;

        if (Native.isAvailable()) {
          const chunkB64 = uint8ArrayToBase64(chunkBytes);
          const res = Native.saveChunk(transferId, tr.fileName, chunkB64, isFirstChunk, false, tr.fileType || '*/*');
          if (res && res !== 'CHUNK_WRITTEN') tr.savedPath = res;
        } else {
          if (!tr._chunks) tr._chunks = [];
          tr._chunks.push(chunkBytes);
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
          if (activeChatPeer === senderTag) renderChatMessages(senderTag);
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
  // 8. CHAT-FIRST UI, CONVERSAS & EDGE-TO-EDGE FULL SCREEN
  // ==========================================================================
  function handleIncomingChatMessage(payload) {
    if (!payload || !payload.senderTag) return;
    const from = normalizeTag(payload.senderTag);
    if (from === normalizeTag(myTag)) return;

    if (!chatMessages[from]) chatMessages[from] = [];
    const msgId = payload.id || ('msg_' + Date.now());

    if (!chatMessages[from].some(m => m.id === msgId)) {
      chatMessages[from].push({
        id: msgId,
        sender: from,
        text: payload.text || '',
        timestamp: payload.timestamp || Date.now(),
        status: 'RECEIVED',
        transferId: payload.transferId || (payload.media ? payload.media.transferId : null),
        media: payload.media || payload.fileMeta || null
      });
      saveChatMessagesToStorage();

      // Se contém anexo
      if (payload.media || payload.fileMeta) {
        const fileMeta = payload.media || payload.fileMeta;
        const mediaTid = payload.transferId || fileMeta.transferId;
        const willAutoDownload = Boolean(chatAutoDownload);

        transfers[mediaTid] = {
          id: mediaTid,
          type: 'receive',
          sender: from,
          fileName: fileMeta.name || fileMeta.fileName || 'arquivo_chat',
          totalBytes: fileMeta.size || fileMeta.fileSize || 0,
          fileType: fileMeta.type || fileMeta.fileType || '*/*',
          transferredBytes: 0,
          status: willAutoDownload ? 'connecting' : 'awaiting_accept',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia: true,
          chatMsgId: msgId,
          startTime: Date.now(),
          savedPath: null
        };
        renderTransfers();

        if (willAutoDownload) {
          sendSignal(from, mediaTid, 'FILE_ACCEPT', {
            isChatMedia: true,
            chatMsgId: msgId,
            roster: Object.values(peerRegistry)
          });
        }
      }

      if (activeChatPeer === from) {
        renderChatMessages(from);
      } else {
        const badge = document.getElementById('badge-chat-unread');
        if (badge) {
          badge.textContent = parseInt(badge.textContent || '0', 10) + 1;
          badge.classList.remove('hidden');
        }
      }

      renderConversationsList();
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
    saveChatMessagesToStorage();

    const payload = {
      id: msgId,
      senderTag: myTag,
      text,
      timestamp: Date.now()
    };

    // 1. Rota Direta LAN WebRTC (se DataChannel estiver aberto)
    const directDc = directDataChannels.get(targetTag);
    if (directDc && directDc.readyState === 'open') {
      try {
        directDc.send(JSON.stringify({ type: 'CHAT_DIRECT', payload }));
        renderChatMessages(targetTag);
        renderConversationsList();
        return;
      } catch (e) {}
    }

    // 2. Rota Bluetooth BLE (se peer estiver no alcance do rádio BLE)
    if (peerTransports[targetTag] === 'BLE' && Native.isBleAvailable()) {
      const bleOk = Native.sendBleMessage(targetTag, JSON.stringify(payload));
      if (bleOk) {
        renderChatMessages(targetTag);
        renderConversationsList();
        return;
      }
    }

    // 3. Fallback: Sinalização P2P na malha global
    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload);

    renderChatMessages(targetTag);
    renderConversationsList();
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
      type: fileItem.mimeType || fileItem.type || '*/*',
      fileType: fileItem.mimeType || fileItem.type || '*/*',
      transferId
    };

    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: Date.now(),
      status: 'SENT',
      transferId,
      media: fileMeta
    });
    saveChatMessagesToStorage();

    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', {
      id: msgId,
      senderTag: myTag,
      text,
      timestamp: Date.now(),
      transferId,
      fileMeta,
      media: fileMeta
    });

    sendSignal(targetTag, transferId, 'FILE_OFFER', {
      isChatMedia: true,
      chatMsgId: msgId,
      fileName: fileItem.name,
      fileSize: fileItem.size,
      fileType: fileItem.mimeType || fileItem.type || '*/*',
      roster: Object.values(peerRegistry)
    });

    renderChatMessages(targetTag);
    renderConversationsList();
  }

  window.downloadChatMedia = function (transferId, fileName) {
    let tr = transfers[transferId];
    if (tr && tr.savedPath) {
      Native.openFile(tr.savedPath);
      return;
    }

    const sender = (tr && tr.sender) || activeChatPeer || '';
    if (!tr) {
      let fileMeta = null;
      for (const peer in chatMessages) {
        const msg = chatMessages[peer].find(m => m.transferId === transferId);
        if (msg && msg.media) {
          fileMeta = msg.media;
          break;
        }
      }
      tr = {
        id: transferId,
        type: 'receive',
        sender: sender,
        fileName: (fileMeta && (fileMeta.fileName || fileMeta.name)) || fileName || 'arquivo_chat',
        totalBytes: (fileMeta && (fileMeta.fileSize || fileMeta.size)) || 0,
        fileType: (fileMeta && (fileMeta.fileType || fileMeta.type)) || '*/*',
        transferredBytes: 0,
        status: 'connecting',
        speed: '0 KB/s',
        progress: 0,
        isChatMedia: true,
        startTime: Date.now(),
        savedPath: null
      };
      transfers[transferId] = tr;
    } else {
      tr.status = 'connecting';
    }

    Native.toast(`Iniciando download de ${tr.fileName}...`);
    renderTransfers();
    if (activeChatPeer) renderChatMessages(activeChatPeer);

    if (sender) {
      sendSignal(sender, transferId, 'FILE_ACCEPT', {
        isChatMedia: true,
        chatMsgId: tr.chatMsgId || null,
        roster: Object.values(peerRegistry)
      });
    }
  };

  // Renderiza a lista de conversas ativas (Apenas contatos interagidos)
  function renderConversationsList() {
    const listEl = document.getElementById('chat-conversations-list');
    if (!listEl) return;

    const contacts = (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};

    // Coleta todos os usuários com quem houve interação
    const interactedPeers = new Set([
      ...Object.keys(chatMessages),
      ...Object.values(transfers).map(t => t.target || t.sender).filter(Boolean),
      ...Object.keys(contacts)
    ]);

    let peerTags = Array.from(interactedPeers).filter(t => t && t !== myTag);

    // Filtra pela categoria selecionada
    if (selectedCategory && selectedCategory !== 'Todas') {
      peerTags = peerTags.filter(t => {
        const c = contacts[t];
        return c && c.lists && c.lists.includes(selectedCategory);
      });
    }

    const countBadge = document.getElementById('chat-conversations-count');
    if (countBadge) countBadge.textContent = peerTags.length;

    if (peerTags.length === 0) {
      listEl.innerHTML = `
        <div class="h-64 flex flex-col items-center justify-center text-center p-6 text-slate-500 space-y-3">
          <div class="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400">
            <svg class="w-6 h-6 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </div>
          <div>
            <h4 class="text-sm font-bold text-slate-300">Nenhuma conversa ${selectedCategory !== 'Todas' ? 'nesta lista' : 'recente'}</h4>
            <p class="text-xs text-slate-500 mt-1 max-w-xs">Encontre novos usuários na rede local ou global usando a Busca Global!</p>
          </div>
          <button id="btn-empty-global-search" type="button" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md shadow-indigo-600/30 active:scale-95 transition-all">
            🔍 Buscar Usuários na Malha
          </button>
        </div>
      `;
      const btnEmptySearch = document.getElementById('btn-empty-global-search');
      if (btnEmptySearch) {
        btnEmptySearch.onclick = () => openGlobalSearchModal();
      }
      return;
    }

    // Ordena conversas pela mensagem mais recente
    peerTags.sort((a, b) => {
      const msgsA = chatMessages[a] || [];
      const msgsB = chatMessages[b] || [];
      const timeA = msgsA.length ? msgsA[msgsA.length - 1].timestamp : 0;
      const timeB = msgsB.length ? msgsB[msgsB.length - 1].timestamp : 0;
      return timeB - timeA;
    });

    listEl.innerHTML = peerTags.map(tag => {
      const contact = contacts[tag];
      const peer = peerRegistry[tag];
      const name = (contact && contact.name) || (peer && peer.name) || tag.replace(/^@/, '').split('_')[0];
      const avatar = (contact && contact.avatar) || (peer && peer.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 56) : '');
      const msgs = chatMessages[tag] || [];
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      const lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
      const transport = peerTransports[tag] || (peer ? peer.transport : 'P2P');

      let transportBadge = '';
      if (transport === 'LAN') {
        transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">🟢 LAN</span>';
      } else if (transport === 'BLE') {
        transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">📶 BLE</span>';
      } else {
        transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-slate-800 text-slate-400 border border-slate-700">🌐 P2P</span>';
      }

      let snippet = 'Toque para conversar com criptografia';
      let checkIcon = '';
      if (lastMsg) {
        if (lastMsg.media) {
          snippet = `📎 ${lastMsg.media.fileName || 'Arquivo'}`;
        } else {
          snippet = lastMsg.text || '';
        }
        if (lastMsg.sender === myTag) {
          checkIcon = '<span class="text-indigo-400 font-bold mr-1">✓✓</span>';
        }
      }

      return `
        <div data-chat-peer="${tag}" class="px-4 py-3 hover:bg-slate-900/60 transition-colors flex items-center justify-between cursor-pointer active:bg-slate-900">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <div class="chat-avatar w-12 h-12 rounded-2xl overflow-hidden shrink-0 border border-slate-800 bg-slate-900 flex items-center justify-center relative">
              ${avatar}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-1">
                <span class="text-sm font-bold text-white truncate">${name}</span>
                <span class="text-[10px] text-slate-500 font-mono shrink-0">${lastTime}</span>
              </div>
              <div class="flex items-center justify-between gap-1 mt-0.5">
                <p class="text-xs text-slate-400 truncate flex items-center">
                  ${checkIcon}<span>${snippet}</span>
                </p>
                <div class="shrink-0 flex items-center gap-1.5">
                  ${transportBadge}
                </div>
              </div>
            </div>
          </div>
          <button type="button" data-open-contact-options="${tag}" class="p-2 ml-1 text-slate-500 hover:text-white rounded-lg active:scale-90">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
            </svg>
          </button>
        </div>
      `;
    }).join('');

    // Eventos de clique nas conversas
    listEl.querySelectorAll('[data-chat-peer]').forEach(row => {
      row.onclick = (e) => {
        if (e.target.closest('[data-open-contact-options]')) return;
        const tag = row.getAttribute('data-chat-peer');
        openActiveChat(tag);
      };
    });

    listEl.querySelectorAll('[data-open-contact-options]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const tag = btn.getAttribute('data-open-contact-options');
        openContactOptionsMenu(tag);
      };
    });
  }

  // Abre a conversa selecionada em FULL-SCREEN Edge-to-Edge
  function openActiveChat(peerTag) {
    activeChatPeer = peerTag;
    const contacts = (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};
    const contact = contacts[peerTag];
    const peer = peerRegistry[peerTag];
    const name = (contact && contact.name) || (peer && peer.name) || peerTag.replace(/^@/, '').split('_')[0];
    const avatar = (contact && contact.avatar) || (peer && peer.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(peerTag, 40) : '');
    const transport = peerTransports[peerTag] || (peer ? peer.transport : 'P2P');

    const avatarSlot = document.getElementById('chat-contact-avatar');
    if (avatarSlot) avatarSlot.innerHTML = avatar;

    const nameEl = document.getElementById('chat-contact-name');
    if (nameEl) nameEl.textContent = name;

    const tagEl = document.getElementById('chat-contact-tag');
    if (tagEl) tagEl.textContent = peerTag;

    const badge = document.getElementById('chat-contact-transport-badge');
    if (badge) {
      if (transport === 'LAN') {
        badge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0';
        badge.textContent = '🟢 LAN';
      } else if (transport === 'BLE') {
        badge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30 shrink-0';
        badge.textContent = '📶 BLE';
      } else {
        badge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700 shrink-0';
        badge.textContent = '🌐 P2P';
      }
    }

    renderChatMessages(peerTag);

    // Oculta a barra de abas inferior e desliza o chat ocupando 100% da área útil
    const bottomNav = document.getElementById('app-bottom-nav');
    if (bottomNav) bottomNav.classList.add('hidden');

    const activePane = document.getElementById('chat-active-conversation-pane');
    if (activePane) activePane.classList.add('active');
  }

  function closeActiveChat() {
    activeChatPeer = null;
    const activePane = document.getElementById('chat-active-conversation-pane');
    if (activePane) activePane.classList.remove('active');

    const bottomNav = document.getElementById('app-bottom-nav');
    if (bottomNav) bottomNav.classList.remove('hidden');

    renderConversationsList();
  }

  function renderChatMessages(peerTag) {
    const container = document.getElementById('chat-messages-container');
    if (!container || !peerTag) return;

    const msgs = chatMessages[peerTag] || [];
    if (msgs.length === 0) {
      container.innerHTML = `
        <div class="h-full flex flex-col items-center justify-center text-center text-slate-500 py-12">
          <div class="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-2">
            <svg class="w-6 h-6 text-indigo-400 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <span class="text-xs font-bold text-slate-300">Conversa Segura de Ponta a Ponta</span>
          <p class="text-[11px] text-slate-500 mt-1 max-w-xs">Mensagens e arquivos transferidos diretamente entre seus dispositivos sem armazenamento em servidores centrais.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = msgs.map(m => {
      const isMe = m.sender === myTag;
      const timeStr = formatTime(m.timestamp);

      let mediaHtml = '';
      if (m.media || m.transferId) {
        const tid = m.transferId || (m.media && m.media.transferId);
        const tr = transfers[tid];
        const fileName = (tr && tr.fileName) || (m.media && (m.media.fileName || m.media.name)) || 'Arquivo';
        const fileSize = (tr && tr.totalBytes) || (m.media && (m.media.fileSize || m.media.size)) || 0;
        const isDownloaded = tr && tr.savedPath;
        const isTransferring = tr && tr.status === 'transferring';

        mediaHtml = `
          <div class="mt-2 p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-lg">📁</span>
                <div class="min-w-0">
                  <span class="text-xs font-bold text-white block truncate">${fileName}</span>
                  <span class="text-[10px] text-slate-400 font-mono">${formatBytes(fileSize)}</span>
                </div>
              </div>
              <div>
                ${isDownloaded ? `
                  <button type="button" onclick="window.downloadChatMedia('${tid}', '${fileName}')" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shadow active:scale-95">
                    Abrir
                  </button>
                ` : isTransferring ? `
                  <span class="text-[10px] font-mono text-indigo-400 font-bold animate-pulse">${tr.progress || 0}%</span>
                ` : `
                  <button type="button" onclick="window.downloadChatMedia('${tid}', '${fileName}')" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold shadow active:scale-95">
                    Baixar
                  </button>
                `}
              </div>
            </div>
            ${isTransferring ? `
              <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${tr.progress || 0}%"></div>
              </div>
            ` : ''}
          </div>
        `;
      }

      return `
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} my-0.5">
          <div class="max-w-[80%] rounded-2xl px-3 py-1.5 shadow-sm ${isMe ? 'bg-indigo-600 text-white rounded-tr-xs' : 'bg-slate-800 border border-slate-700/60 text-slate-100 rounded-tl-xs'}">
            ${m.text ? `<p class="text-[13px] leading-snug break-words select-text">${escapeHtml(m.text)}</p>` : ''}
            ${mediaHtml}
            <div class="flex items-center justify-end gap-1 mt-0.5 text-[10px] ${isMe ? 'text-indigo-200' : 'text-slate-400'} font-medium select-none">
              <span>${timeStr}</span>
              ${isMe ? '<span class="text-sky-300 font-bold ml-0.5">✓✓</span>' : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function handleChatFilesSelected(files) {
    if (!files || !files.length) return;
    chatAttachedFiles = files;
    renderChatAttachmentPreview();
  }

  function renderChatAttachmentPreview() {
    let previewEl = document.getElementById('chat-attachment-preview');
    if (!previewEl) return;

    if (chatAttachedFiles.length === 0) {
      previewEl.classList.add('hidden');
      previewEl.innerHTML = '';
      return;
    }

    previewEl.classList.remove('hidden');
    previewEl.innerHTML = chatAttachedFiles.map((f, idx) => `
      <div class="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs">
        <span class="truncate max-w-[150px]">📎 ${f.name} (${formatBytes(f.size)})</span>
        <button type="button" data-remove-chat-att="${idx}" class="text-rose-400 font-bold ml-1 active:scale-95">✕</button>
      </div>
    `).join('');

    previewEl.querySelectorAll('[data-remove-chat-att]').forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.getAttribute('data-remove-chat-att'), 10);
        chatAttachedFiles.splice(i, 1);
        renderChatAttachmentPreview();
      };
    });
  }

  // ==========================================================================
  // 9. BUSCA GLOBAL DE USUÁRIOS (LAN / BLE / MESH ROSTER)
  // ==========================================================================
  function openGlobalSearchModal() {
    const modal = document.getElementById('modal-global-search');
    if (!modal) return;
    modal.classList.remove('hidden');
    const input = document.getElementById('input-global-search');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 200);
      renderGlobalSearchResults('');
    }
  }

  function renderGlobalSearchResults(query) {
    const resultsContainer = document.getElementById('global-search-results');
    if (!resultsContainer) return;

    const q = query.toLowerCase().trim();
    const contacts = (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};

    // Combina todos os peers conhecidos (Mesh, BLE, Contatos)
    const allPeers = new Map();

    Object.values(peerRegistry).forEach(p => {
      if (p.tag !== myTag) allPeers.set(p.tag, p);
    });

    blePeers.forEach((data, tag) => {
      if (tag !== myTag && !allPeers.has(tag)) {
        allPeers.set(tag, {
          tag,
          name: tag.replace(/^@/, '').split('_')[0],
          transport: 'BLE',
          avatar: typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 56) : ''
        });
      }
    });

    Object.keys(contacts).forEach(tag => {
      if (tag !== myTag && !allPeers.has(tag)) {
        allPeers.set(tag, {
          tag,
          name: contacts[tag].name,
          avatar: contacts[tag].avatar,
          transport: 'P2P'
        });
      }
    });

    let filtered = Array.from(allPeers.values());
    if (q) {
      filtered = filtered.filter(p => (
        (p.tag && p.tag.toLowerCase().includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.reghash && p.reghash.toLowerCase().includes(q))
      ));
    }

    if (filtered.length === 0) {
      resultsContainer.innerHTML = `
        <div class="text-center py-8 text-slate-500 text-xs">
          Nenhum usuário encontrado ${q ? `para "${q}"` : 'na malha no momento'}.
        </div>
      `;
      return;
    }

    resultsContainer.innerHTML = filtered.map(p => {
      const transport = peerTransports[p.tag] || p.transport || 'P2P';
      let transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-slate-800 text-slate-400 border border-slate-700">🌐 P2P</span>';
      if (transport === 'LAN') {
        transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">🟢 LAN</span>';
      } else if (transport === 'BLE') {
        transportBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">📶 BLE</span>';
      }

      return `
        <div data-start-chat-target="${p.tag}" class="p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 transition-colors flex items-center justify-between cursor-pointer active:scale-98">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-slate-800 bg-slate-900">${p.avatar || ''}</div>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">${p.name || p.tag}</span>
              <span class="text-[10px] font-mono text-slate-400 block truncate">${p.tag}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            ${transportBadge}
            <button type="button" class="px-2.5 py-1 rounded-lg bg-indigo-600 text-white text-[10px] font-bold shadow">
              Conversar
            </button>
          </div>
        </div>
      `;
    }).join('');

    resultsContainer.querySelectorAll('[data-start-chat-target]').forEach(el => {
      el.onclick = () => {
        const target = el.getAttribute('data-start-chat-target');
        document.getElementById('modal-global-search').classList.add('hidden');
        openActiveChat(target);
      };
    });
  }

  // ==========================================================================
  // 10. MENU DE OPÇÕES DO CONTATO (SALVAR, LISTAS, EXCLUIR)
  // ==========================================================================
  let activeMenuTargetTag = null;

  function openContactOptionsMenu(targetTag) {
    activeMenuTargetTag = targetTag;
    const modal = document.getElementById('modal-contact-menu');
    if (!modal) return;
    const title = document.getElementById('contact-menu-title');
    if (title) title.textContent = `Opções para ${targetTag}`;
    modal.classList.remove('hidden');
  }

  function handleSaveContactAction() {
    if (!activeMenuTargetTag || typeof PulseShareCrypto === 'undefined') return;
    const peer = peerRegistry[activeMenuTargetTag];
    const name = prompt('Nome para o contato:', (peer && peer.name) || activeMenuTargetTag.replace(/^@/, '').split('_')[0]);
    if (name) {
      PulseShareCrypto.ProfilesManager.saveContact(activeMenuTargetTag, {
        name,
        avatar: peer ? peer.avatar : PulseShareCrypto.generateIdenticonSvg(activeMenuTargetTag, 64)
      });
      Native.toast('Contato salvo com sucesso!');
      renderConversationsList();
      if (activeChatPeer === activeMenuTargetTag) {
        document.getElementById('chat-contact-name').textContent = name;
      }
    }
    document.getElementById('modal-contact-menu').classList.add('hidden');
  }

  function handleAddToListAction() {
    if (!activeMenuTargetTag || typeof PulseShareCrypto === 'undefined') return;
    const chosenList = prompt('Adicionar à lista (ex: Favoritos, Família, Trabalho):', 'Favoritos');
    if (chosenList) {
      PulseShareCrypto.ProfilesManager.addToList(activeMenuTargetTag, chosenList.trim());
      Native.toast(`Contato adicionado a ${chosenList}!`);
      renderConversationsList();
    }
    document.getElementById('modal-contact-menu').classList.add('hidden');
  }

  function handleDeleteChatAction() {
    if (!activeMenuTargetTag) return;
    if (confirm(`Deseja realmente excluir a conversa com ${activeMenuTargetTag}?`)) {
      delete chatMessages[activeMenuTargetTag];
      saveChatMessagesToStorage();
      if (activeChatPeer === activeMenuTargetTag) {
        closeActiveChat();
      }
      renderConversationsList();
      Native.toast('Conversa excluída.');
    }
    document.getElementById('modal-contact-menu').classList.add('hidden');
  }

  // ==========================================================================
  // 11. GERENCIAMENTO DE TRANSFERÊNCIAS & ARQUIVOS
  // ==========================================================================
  function handleFilesSelected(files) {
    if (!files || !files.length) return;
    stagedFiles = files;
    renderStagedFiles();
  }

  function handleAndroidSharedItems(items) {
    if (!items || !items.length) return;
    stagedFiles = items;
    openSendModal('p2p');
    renderStagedFiles();
  }

  function renderStagedFiles() {
    const listEl = document.getElementById('selected-files-list');
    if (!listEl) return;
    listEl.innerHTML = stagedFiles.map((f, idx) => `
      <div class="flex items-center justify-between p-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white">
        <span class="truncate max-w-[200px]">📁 ${f.name} (${formatBytes(f.size)})</span>
        <button type="button" data-remove-staged="${idx}" class="text-rose-400 hover:text-rose-300 font-bold ml-2">✕</button>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-remove-staged]').forEach(btn => {
      btn.onclick = () => {
        const i = parseInt(btn.getAttribute('data-remove-staged'), 10);
        stagedFiles.splice(i, 1);
        renderStagedFiles();
      };
    });
  }

  function renderTransfers() {
    const container = document.getElementById('transfers-list');
    if (!container) return;

    const allTransfers = Object.values(transfers);
    const badge = document.getElementById('badge-transfers-count');
    const activeCount = allTransfers.filter(t => ['connecting', 'transferring', 'awaiting_accept'].includes(t.status)).length;
    if (badge) {
      badge.textContent = activeCount;
      badge.classList.toggle('hidden', activeCount === 0);
    }

    const filtered = allTransfers.filter(t => {
      const isDone = ['completed', 'cancelled', 'failed', 'error'].includes(t.status);
      return transfersFilter === 'active' ? !isDone : isDone;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 text-slate-500 text-xs">
          Nenhuma transferência ${transfersFilter === 'active' ? 'em andamento' : 'no histórico'}.
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(t => {
      const isSend = t.type === 'send';
      const peerTag = isSend ? t.target : t.sender;
      return `
        <div class="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="text-xl">${isSend ? '📤' : '📥'}</span>
              <div class="min-w-0">
                <span class="text-xs font-bold text-white block truncate">${t.fileName}</span>
                <span class="text-[10px] text-slate-400 font-mono">${formatBytes(t.totalBytes)} • ${peerTag || 'desconhecido'}</span>
              </div>
            </div>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${
              t.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
              t.status === 'transferring' ? 'bg-indigo-500/20 text-indigo-400' :
              t.status === 'awaiting_accept' ? 'bg-amber-500/20 text-amber-400' :
              'bg-slate-800 text-slate-400'
            }">${t.status}</span>
          </div>

          <div class="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
            <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${t.progress || 0}%"></div>
          </div>

          <div class="flex items-center justify-between text-[10px] text-slate-400">
            <span>${t.speed || '0 KB/s'}</span>
            <div class="flex gap-2">
              ${t.savedPath ? `
                <button type="button" onclick="window.downloadChatMedia('${t.id}', '${t.fileName}')" class="text-emerald-400 font-bold hover:underline">Abrir Arquivo</button>
              ` : ''}
              ${['connecting', 'transferring', 'awaiting_accept'].includes(t.status) ? `
                <button type="button" onclick="window.cancelTransfer('${t.id}')" class="text-rose-400 font-bold hover:underline">Cancelar</button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================================================
  // 12. NAVEGAÇÃO ENTRE ABAS
  // ==========================================================================
  let currentTab = 'chat'; // CHAT-FIRST POR PADRÃO
  let stagedFiles = [];
  let modalMode = 'p2p';

  function switchTab(tabName) {
    currentTab = tabName;
    ['chat', 'home', 'transfers', 'shares', 'mesh'].forEach((t) => {
      const view = document.getElementById('view-' + t);
      const btn = document.getElementById('nav-' + t);
      if (view && btn) {
        if (t === tabName) {
          view.classList.remove('hidden');
          btn.classList.add('active', 'text-indigo-400');
          btn.classList.remove('text-slate-400');
        } else {
          view.classList.add('hidden');
          btn.classList.remove('active', 'text-indigo-400', 'text-orange-400');
          btn.classList.add('text-slate-400');
        }
      }
    });

    if (tabName === 'chat') {
      renderConversationsList();
    } else if (tabName === 'transfers') {
      renderTransfers();
    } else if (tabName === 'mesh') {
      renderMeshPeers();
    }
  }

  function updateHeaderStatus() {
    const dot = document.getElementById('header-mesh-dot');
    const badge = document.getElementById('header-status-badge');
    const connected = brokerSockets.filter(s => s && s.readyState === WebSocket.OPEN).length;

    if (dot && badge) {
      if (connected > 0) {
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
        badge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
        badge.textContent = `${connected} Brokers Online`;
      } else {
        dot.className = 'w-2 h-2 rounded-full bg-amber-400 pulse-dot';
        badge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700/80';
        badge.textContent = 'Conectando...';
      }
    }
  }

  function renderMeshPeers() {
    const list = document.getElementById('mesh-peers-list');
    if (!list) return;

    const peers = Object.values(peerRegistry);
    if (peers.length === 0) {
      list.innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">Nenhum outro dispositivo detectado na malha.</div>';
      return;
    }

    list.innerHTML = peers.map(p => {
      const transport = peerTransports[p.tag] || p.transport || 'P2P';
      let badge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-slate-800 text-slate-400">🌐 P2P</span>';
      if (transport === 'LAN') badge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-emerald-500/20 text-emerald-400">🟢 LAN</span>';
      if (transport === 'BLE') badge = '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-400">📶 BLE</span>';

      return `
        <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-lg overflow-hidden shrink-0">${p.avatar || ''}</div>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">${p.name || p.tag}</span>
              <span class="text-[10px] font-mono text-slate-400 block truncate">${p.tag}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            ${badge}
            <button type="button" onclick="openActiveChat('${p.tag}')" class="px-2.5 py-1 rounded bg-indigo-600 text-white text-xs font-bold active:scale-95">Conversar</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function openSendModal(mode) {
    modalMode = mode || 'p2p';
    document.getElementById('modal-send').classList.remove('hidden');
    document.getElementById('field-target-user').classList.toggle('hidden', modalMode !== 'p2p');
    document.getElementById('field-link-options').classList.toggle('hidden', modalMode === 'p2p');
  }

  // ==========================================================================
  // 13. INICIALIZAÇÃO DE EVENTOS DO DOM
  // ==========================================================================
  function initEvents() {
    // Abas de navegação
    document.getElementById('nav-chat').onclick = () => switchTab('chat');
    document.getElementById('nav-home').onclick = () => switchTab('home');
    document.getElementById('nav-transfers').onclick = () => switchTab('transfers');
    document.getElementById('nav-shares').onclick = () => switchTab('shares');
    document.getElementById('nav-mesh').onclick = () => switchTab('mesh');

    // Ações Rápidas na Home
    document.getElementById('btn-action-send-p2p').onclick = () => openSendModal('p2p');
    document.getElementById('btn-action-create-link').onclick = () => openSendModal('link');

    // Botões de Busca Global
    document.getElementById('btn-header-search').onclick = () => openGlobalSearchModal();
    document.getElementById('btn-chat-global-search').onclick = () => openGlobalSearchModal();
    document.getElementById('btn-fab-new-chat').onclick = () => openGlobalSearchModal();
    document.getElementById('btn-close-global-search').onclick = () => {
      document.getElementById('modal-global-search').classList.add('hidden');
    };
    document.getElementById('input-global-search').oninput = (e) => {
      renderGlobalSearchResults(e.target.value);
    };

    // Botões de Perfil / Identidade
    document.getElementById('header-profile-btn').onclick = () => {
      renderIdentityModal();
      document.getElementById('modal-identity-profile').classList.remove('hidden');
    };
    document.getElementById('btn-edit-tag').onclick = () => {
      renderIdentityModal();
      document.getElementById('modal-identity-profile').classList.remove('hidden');
    };
    document.getElementById('btn-close-identity-modal').onclick = () => {
      document.getElementById('modal-identity-profile').classList.add('hidden');
    };

    // Copiar 7 palavras
    document.getElementById('btn-copy-seed-words').onclick = () => {
      if (activeProfile && activeProfile.seedWords) {
        Native.copy(activeProfile.seedWords);
        Native.toast('7 Palavras de recuperação copiadas!');
      }
    };

    // Criar Novo Perfil
    document.getElementById('btn-add-new-profile').onclick = async () => {
      const name = prompt('Nome para o novo perfil:');
      if (name && typeof PulseShareCrypto !== 'undefined') {
        const seedWords = PulseShareCrypto.generate7WordMnemonic();
        const newProf = await PulseShareCrypto.deriveIdentity(name.trim(), seedWords);
        newProf.id = 'prof_' + Date.now();
        PulseShareCrypto.ProfilesManager.saveProfile(newProf);
        window.location.reload();
      }
    };

    // Parear Dispositivo (QR Scanner Modal)
    document.getElementById('btn-scan-device-qr').onclick = () => {
      document.getElementById('modal-qr-pair-scanner').classList.remove('hidden');
    };
    document.getElementById('btn-chat-qr-sync').onclick = () => {
      document.getElementById('modal-qr-pair-scanner').classList.remove('hidden');
    };
    document.getElementById('btn-close-qr-scanner-modal').onclick = () => {
      document.getElementById('modal-qr-pair-scanner').classList.add('hidden');
    };

    document.getElementById('btn-confirm-import-pairing').onclick = async () => {
      const text = document.getElementById('input-pairing-payload').value.trim();
      if (!text) return;
      try {
        const data = JSON.parse(text);
        if (data.action === 'pulseshare_pair_v2' && data.seedWords && typeof PulseShareCrypto !== 'undefined') {
          const prof = await PulseShareCrypto.deriveIdentity(data.name || 'Sincronizado', data.seedWords);
          prof.id = 'prof_sync_' + Date.now();
          PulseShareCrypto.ProfilesManager.saveProfile(prof);
          Native.toast('Perfil pareado e sincronizado com sucesso!');
          window.location.reload();
        } else {
          Native.toast('Formato de pareamento inválido.');
        }
      } catch (e) {
        Native.toast('Erro ao processar dados de pareamento.');
      }
    };

    // Conversa ativa: Voltar, Enviar, Anexar
    document.getElementById('btn-chat-back').onclick = () => closeActiveChat();

    document.getElementById('btn-chat-send').onclick = () => {
      const input = document.getElementById('input-chat-text');
      const text = input.value.trim();
      if (!activeChatPeer) return;
      if (!text && chatAttachedFiles.length === 0) return;

      if (chatAttachedFiles.length > 0) {
        chatAttachedFiles.forEach(f => {
          const tid = 'chatmedia_' + Math.random().toString(36).slice(2, 9);
          stagedFilesMap.set(tid, f);
          transfers[tid] = {
            id: tid,
            type: 'send',
            target: activeChatPeer,
            fileName: f.name,
            totalBytes: f.size,
            fileType: f.mimeType || f.type || '*/*',
            transferredBytes: 0,
            status: 'awaiting_accept',
            progress: 0,
            fileItem: f,
            startTime: Date.now()
          };
          sendChatMessageWithMedia(activeChatPeer, text, tid, f);
        });
        chatAttachedFiles = [];
        renderChatAttachmentPreview();
      } else {
        sendChatMessage(activeChatPeer, text);
      }
      input.value = '';
    };

    document.getElementById('input-chat-text').onkeydown = (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btn-chat-send').click();
      }
    };

    document.getElementById('btn-chat-attach').onclick = () => {
      pendingChatAttachment = true;
      Native.pickFiles();
    };

    // Menu do contato
    document.getElementById('btn-chat-contact-menu').onclick = () => {
      if (activeChatPeer) openContactOptionsMenu(activeChatPeer);
    };
    document.getElementById('btn-close-contact-menu').onclick = () => {
      document.getElementById('modal-contact-menu').classList.add('hidden');
    };
    document.getElementById('btn-contact-save').onclick = () => handleSaveContactAction();
    document.getElementById('btn-contact-add-list').onclick = () => handleAddToListAction();
    document.getElementById('btn-contact-delete-chat').onclick = () => handleDeleteChatAction();

    // Categorias de Contatos
    document.querySelectorAll('.category-pill').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.category-pill').forEach(b => {
          b.className = 'category-pill px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-300 hover:text-white shrink-0 transition-all';
        });
        btn.className = 'category-pill active px-3 py-1 rounded-full text-xs font-bold bg-indigo-600 text-white shrink-0 transition-all';
        selectedCategory = btn.getAttribute('data-category');
        renderConversationsList();
      };
    });

    document.getElementById('btn-add-category-list').onclick = () => {
      document.getElementById('modal-add-category-list').classList.remove('hidden');
    };
    document.getElementById('btn-close-add-category').onclick = () => {
      document.getElementById('modal-add-category-list').classList.add('hidden');
    };
    document.getElementById('btn-save-new-category').onclick = () => {
      const input = document.getElementById('input-new-category-name');
      const cat = input.value.trim();
      if (cat && !customCategories.includes(cat)) {
        customCategories.push(cat);
        localStorage.setItem('ps_custom_categories', JSON.stringify(customCategories));

        const bar = document.getElementById('chat-categories-bar');
        const btnAdd = document.getElementById('btn-add-category-list');
        const newBtn = document.createElement('button');
        newBtn.type = 'button';
        newBtn.setAttribute('data-category', cat);
        newBtn.className = 'category-pill px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-300 hover:text-white shrink-0 transition-all';
        newBtn.textContent = cat;
        newBtn.onclick = () => {
          document.querySelectorAll('.category-pill').forEach(b => {
            b.className = 'category-pill px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-300 hover:text-white shrink-0 transition-all';
          });
          newBtn.className = 'category-pill active px-3 py-1 rounded-full text-xs font-bold bg-indigo-600 text-white shrink-0 transition-all';
          selectedCategory = cat;
          renderConversationsList();
        };
        bar.insertBefore(newBtn, btnAdd);
        Native.toast(`Lista ${cat} criada!`);
      }
      document.getElementById('modal-add-category-list').classList.add('hidden');
    };

    // Configurações
    document.getElementById('btn-open-settings').onclick = () => {
      document.getElementById('modal-settings').classList.remove('hidden');
    };
    document.getElementById('btn-close-settings-modal').onclick = () => {
      document.getElementById('modal-settings').classList.add('hidden');
    };

    // Alternar Download Automático no Chat
    const settingChatAuto = document.getElementById('setting-chat-auto-download');
    if (settingChatAuto) {
      settingChatAuto.checked = Boolean(chatAutoDownload);
      settingChatAuto.onchange = () => {
        chatAutoDownload = settingChatAuto.checked;
        localStorage.setItem('ps_chat_auto_download', String(chatAutoDownload));
        Native.toast('Download automático no chat: ' + (chatAutoDownload ? 'Ativado' : 'Desativado'));
      };
    }

    // Salvar Diretório de Download
    const btnSaveDir = document.getElementById('btn-save-download-dir');
    if (btnSaveDir) {
      const inputDir = document.getElementById('setting-download-dir');
      if (inputDir) inputDir.value = customDownloadFolder;
      const elPreview = document.getElementById('label-download-path-preview');
      if (elPreview) elPreview.textContent = 'Destino: ' + Native.getDownloadDirectory();

      btnSaveDir.onclick = () => {
        let folder = inputDir ? inputDir.value.trim() : 'PulseShare';
        if (!folder) folder = 'PulseShare';
        customDownloadFolder = folder;
        localStorage.setItem('ps_download_folder', folder);
        const resolvedPath = Native.setDownloadDirectory(folder);
        if (elPreview) elPreview.textContent = 'Destino: ' + resolvedPath;
        Native.toast('Diretório salvo: ' + folder);
      };
    }

    const btnOpenDir = document.getElementById('btn-open-download-dir');
    if (btnOpenDir) {
      btnOpenDir.onclick = () => Native.openDownloadFolder();
    }

    // Modal Envio de Arquivos
    document.getElementById('btn-close-send-modal').onclick = () => {
      document.getElementById('modal-send').classList.add('hidden');
    };
    document.getElementById('btn-mode-p2p').onclick = () => openSendModal('p2p');
    document.getElementById('btn-mode-link').onclick = () => openSendModal('link');
    document.getElementById('btn-pick-files-native').onclick = () => {
      pendingChatAttachment = false;
      Native.pickFiles();
    };

    document.getElementById('btn-confirm-send').onclick = () => {
      if (stagedFiles.length === 0) {
        Native.toast('Selecione ao menos um arquivo!');
        return;
      }
      if (modalMode === 'p2p') {
        const target = document.getElementById('input-target-user').value.trim();
        if (!target) {
          Native.toast('Informe o @destinatário!');
          return;
        }
        document.getElementById('modal-send').classList.add('hidden');
        openActiveChat(target);
        stagedFiles.forEach(f => {
          const tid = 'p2p_' + Math.random().toString(36).slice(2, 9);
          stagedFilesMap.set(tid, f);
          transfers[tid] = {
            id: tid,
            type: 'send',
            target,
            fileName: f.name,
            totalBytes: f.size,
            fileType: f.mimeType || f.type || '*/*',
            transferredBytes: 0,
            status: 'awaiting_accept',
            progress: 0,
            fileItem: f,
            startTime: Date.now()
          };
          sendChatMessageWithMedia(target, '', tid, f);
        });
        stagedFiles = [];
      } else {
        Native.toast('Link WebRTC gerado com sucesso!');
        document.getElementById('modal-send').classList.add('hidden');
        switchTab('shares');
      }
    };

    // Baixar por link público
    document.getElementById('btn-open-link-go').onclick = () => {
      const url = document.getElementById('input-open-link').value.trim();
      if (!url) return;
      Native.toast('Iniciando conexão P2P com remetente do link...');
      switchTab('transfers');
    };
  }

  // Inicialização do Aplicativo
  window.addEventListener('DOMContentLoaded', async () => {
    await initCryptoIdentity();
    updateHeaderStatus();
    initEvents();
    connectBrokers();
    switchTab('chat'); // Abertura direta no chat por padrão
  });

})();
