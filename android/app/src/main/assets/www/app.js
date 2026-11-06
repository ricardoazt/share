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
    openUrl: (url) => {
      if (Native.isAvailable() && window.PulseShareNative.openUrl) window.PulseShareNative.openUrl(url);
      else window.open(url, '_blank', 'noopener');
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

  let presenceTimer = null;
  const brokerReconnectTimers = {};

  // Conecta (ou reconecta) UM broker. Antes, o onclose de qualquer socket chamava
  // connectBrokers() inteiro, reabrindo todos os brokers e empilhando setIntervals.
  function connectSingleBroker(url) {
    const existing = brokerSockets.find((w) => w && w._psUrl === url);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    let ws;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch (err) {
      console.warn('Falha ao conectar no broker:', url, err);
      scheduleBrokerReconnect(url);
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws._psUrl = url;
    ws._rxBuffer = new Uint8Array(0);
    if (existing) brokerSockets.splice(brokerSockets.indexOf(existing), 1, ws);
    else brokerSockets.push(ws);

    let pingTimer = null;

    ws.onopen = () => {
      updateHeaderStatus();

      // CONNECT packet (clean session, keep-alive 60s)
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

      // PINGREQ periódico para o broker não derrubar a sessão por keep-alive
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(new Uint8Array([0xc0, 0x00])); } catch {}
        }
      }, 30000);

      setTimeout(announcePresence, 300);
    };

    ws.onmessage = (event) => {
      handleIncomingMqttBytes(ws, new Uint8Array(event.data));
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      updateHeaderStatus();
      scheduleBrokerReconnect(url);
    };
  }

  function scheduleBrokerReconnect(url) {
    if (brokerReconnectTimers[url]) return;
    brokerReconnectTimers[url] = setTimeout(() => {
      delete brokerReconnectTimers[url];
      connectSingleBroker(url);
    }, 5000);
  }

  function connectBrokers() {
    PUBLIC_WSS_BROKERS.forEach((url) => connectSingleBroker(url));
    if (!presenceTimer) {
      presenceTimer = setInterval(() => {
        announcePresence();
      }, 15000);
    }
  }

  // Um frame WebSocket pode conter vários pacotes MQTT, ou só parte de um.
  // Acumula bytes por socket e extrai pacotes completos.
  function handleIncomingMqttBytes(ws, bytes) {
    if (!bytes || bytes.length === 0) return;
    let buf = ws._rxBuffer && ws._rxBuffer.length ? concatBytes(ws._rxBuffer, bytes) : bytes;

    while (buf.length >= 2) {
      let idx = 1;
      let multiplier = 1;
      let remainingLength = 0;
      let digit;
      let complete = false;
      do {
        if (idx >= buf.length) break;
        digit = buf[idx++];
        remainingLength += (digit & 127) * multiplier;
        multiplier *= 128;
        if ((digit & 128) === 0) complete = true;
      } while (!complete && idx < 5);
      if (!complete) break; // cabeçalho incompleto

      const packetEnd = idx + remainingLength;
      if (packetEnd > buf.length) break; // aguarda o restante do pacote

      const packetType = buf[0] >> 4;
      if (packetType === 3) {
        const qos = (buf[0] >> 1) & 0x03;
        let p = idx;
        const topicLen = (buf[p] << 8) | buf[p + 1];
        p += 2 + topicLen;
        if (qos > 0) p += 2;
        try {
          const data = JSON.parse(new TextDecoder().decode(buf.subarray(p, packetEnd)));
          handleIncomingPacket(data);
        } catch {}
      }
      buf = buf.subarray(packetEnd);
    }
    ws._rxBuffer = buf.length ? buf.slice() : new Uint8Array(0);
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
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

      // Presença da Extensão Chrome (gossip do catálogo de peers)
      case 'PEER_ANNOUNCE':
      case 'ROSTER_GOSSIP_SYNC': {
        if (mergeRosterIntoRegistry(packet.roster)) {
          updateHeaderStatus();
          renderConversationsList();
          renderMeshPeers();
        }
        break;
      }

      case 'DIRECT_SIGNAL': {
        const target = normalizeTag(packet.to);
        if (target === normalizeTag(myTag)) {
          const from = normalizeTag(packet.senderTag);
          if (from && peerRegistry[from]) peerRegistry[from].lastSeen = Date.now();
          handleDirectSignal(from, packet.transferId, packet.signalType, packet.payload || {});
        }
        break;
      }
    }
  }

  function mergeRosterIntoRegistry(roster) {
    if (!Array.isArray(roster)) return false;
    const now = Date.now();
    const me = normalizeTag(myTag);
    let changed = false;
    roster.forEach((item) => {
      if (!item || typeof item.tag !== 'string') return;
      const tag = normalizeTag(item.tag);
      if (!tag.startsWith('@') || tag.startsWith('@link_') || tag === me) return;
      const lastSeen = Math.min(now, Number(item.lastSeen) || 0);
      if (now - lastSeen > 180000) return; // ignora entradas antigas (> 3 min)
      const local = peerRegistry[tag];
      if (local && (local.lastSeen || 0) >= lastSeen) return;
      peerRegistry[tag] = {
        tag,
        name: (local && local.name) || tag.replace(/^@/, '').split('_')[0],
        reghash: item.regHash || item.reghash || (local && local.reghash) || '0x0000',
        avatar: (local && local.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 64) : null),
        clientType: item.clientType || (local && local.clientType) || 'extension',
        relayMode: item.relayEnabled !== false,
        transport: peerTransports[tag] || 'P2P',
        lastSeen
      };
      changed = true;
    });
    return changed;
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
  // Candidatos ICE que chegam antes da RTCPeerConnection / remoteDescription
  const pendingIce = new Map(); // transferId -> [candidate]
  // Recepção de arquivos via relay pela malha MQTT (fallback quando o WebRTC não conecta)
  const relayIncoming = new Map(); // transferId -> { chunks: Map, total, received }

  function setTransferStatus(tr, status, extra) {
    if (!tr) return;
    tr.status = status;
    if (extra) Object.assign(tr, extra);
    if (['completed', 'cancelled', 'error'].includes(status)) {
      tr.speed = '0 KB/s';
      tr.finishedAt = Date.now();
    }
    renderTransfers();
    const peer = tr.type === 'send' ? tr.target : tr.sender;
    if (activeChatPeer && peer === activeChatPeer) renderChatMessages(activeChatPeer);
    if (tr.shareId) renderShares();
  }

  function updateTransferProgress(tr, bytes, total) {
    const now = Date.now();
    tr.transferredBytes = bytes;
    if (total) tr.totalBytes = total;
    if (tr._lastUi && now - tr._lastUi < 300 && bytes < (tr.totalBytes || Infinity)) return;
    tr._lastUi = now;
    const elapsedSec = Math.max(0.1, (now - (tr.startTime || now)) / 1000);
    const speedBps = Math.round(bytes / elapsedSec);
    tr.speed = speedBps > 1048576 ? (speedBps / 1048576).toFixed(1) + ' MB/s' : (speedBps / 1024).toFixed(0) + ' KB/s';
    tr.progress = tr.totalBytes > 0 ? Math.min(99, Math.round((bytes / tr.totalBytes) * 100)) : 50;
    renderTransfers();
    const peer = tr.type === 'send' ? tr.target : tr.sender;
    if (activeChatPeer && peer === activeChatPeer) renderChatMessages(activeChatPeer);
    if (tr.shareId) renderShares();
  }

  function handleDirectSignal(from, transferId, signalType, payload) {
    if (window.__psTrace) console.log('[sig]', signalType, from, transferId, JSON.stringify(payload).slice(0, 120));
    switch (signalType) {
      case 'CHAT_MESSAGE': {
        // O remetente real é sempre quem assinou o pacote (from)
        handleIncomingChatMessage({ ...payload, senderTag: from });
        break;
      }

      case 'CHAT_ACK': {
        const msgId = payload.msgId || transferId;
        const m = (chatMessages[from] || []).find((x) => x.id === msgId);
        if (m && m.sender === myTag && m.status !== 'READ') {
          m.status = payload.status === 'READ' ? 'READ' : 'DELIVERED';
          saveChatMessagesToStorage();
          if (activeChatPeer === from) renderChatMessages(from);
        }
        break;
      }

      case 'CHAT_READ': {
        let changed = false;
        (chatMessages[from] || []).forEach((m) => {
          if (m.sender === myTag && m.status !== 'READ') {
            m.status = 'READ';
            changed = true;
          }
        });
        if (changed) {
          saveChatMessagesToStorage();
          if (activeChatPeer === from) renderChatMessages(from);
        }
        break;
      }

      case 'CHAT_TYPING': {
        peerTypingState[from] = { status: payload.status || 'idle', at: Date.now() };
        if (activeChatPeer === from) updateChatHeaderTyping();
        break;
      }

      case 'CHAT_REACTION': {
        const msgId = payload.msgId || transferId;
        const m = (chatMessages[from] || []).find((x) => x.id === msgId);
        if (m) {
          if (!m.reactions) m.reactions = {};
          if (payload.emoji) m.reactions[from] = payload.emoji;
          else delete m.reactions[from];
          saveChatMessagesToStorage();
          if (activeChatPeer === from) renderChatMessages(from);
        }
        break;
      }

      case 'FILE_OFFER': {
        const isChatMedia = Boolean(payload.isChatMedia || String(transferId || '').startsWith('chatmedia'));
        const existing = transfers[transferId];
        if (existing && !['awaiting_accept', 'error', 'cancelled'].includes(existing.status)) break; // oferta repetida

        // Regra de Download: Se for pelo chat, só baixa automaticamente se chatAutoDownload for true.
        const shouldAccept = isChatMedia ? Boolean(chatAutoDownload) : Boolean(autoAccept);

        transfers[transferId] = Object.assign(existing || {}, {
          id: transferId,
          type: 'receive',
          sender: normalizeTag(payload.senderTag && payload.routedVia ? payload.senderTag : from),
          offerFrom: from,
          routedVia: payload.routedVia || null,
          fileName: payload.fileName || (existing && existing.fileName) || 'arquivo_recebido',
          totalBytes: payload.fileSize || (existing && existing.totalBytes) || 0,
          fileType: payload.fileType || (existing && existing.fileType) || '*/*',
          transferredBytes: 0,
          status: shouldAccept ? 'connecting' : 'awaiting_accept',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia,
          chatMsgId: payload.chatMsgId || (existing && existing.chatMsgId) || null,
          startTime: Date.now(),
          savedPath: (existing && existing.savedPath) || null
        });
        renderTransfers();
        if (activeChatPeer === from) renderChatMessages(from);

        if (shouldAccept) acceptIncomingTransfer(transferId);
        break;
      }

      case 'FILE_ACCEPT': {
        startSenderWebRTC(transferId, from);
        break;
      }

      case 'FILE_REJECT':
      case 'TRANSFER_REJECT': {
        const tr = transfers[transferId];
        if (tr && !['completed'].includes(tr.status)) {
          setTransferStatus(tr, 'error', { error: payload.error || 'Recusado pelo destinatário' });
        }
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

      // ---- Link público (portal web) servido por este app ----
      case 'PACK_INFO_REQUEST': {
        handlePackInfoRequest(from, transferId, payload);
        break;
      }

      case 'PACK_FILE_PULL':
      case 'PUBLIC_LINK_PULL':
      case 'TUNNEL_RELAY_PULL': {
        handlePackFilePull(from, transferId, payload, signalType === 'TUNNEL_RELAY_PULL');
        break;
      }

      case 'PACK_DOWNLOAD_COMPLETE': {
        const share = publicShares[payload.shareId];
        if (share) {
          share.downloads = (share.downloads || 0) + 1;
          renderShares();
        }
        break;
      }

      case 'MESH_RELAY_CHUNK': {
        handleRelayChunk(from, transferId, payload);
        break;
      }
    }
  }

  function acceptIncomingTransfer(transferId) {
    const tr = transfers[transferId];
    if (!tr) return;
    tr.status = 'connecting';
    tr.startTime = Date.now();
    renderTransfers();
    if (tr.routedVia) {
      // Oferta chegou via nó relay da malha: o aceite volta para o relay
      sendSignal(tr.routedVia, transferId, 'FILE_ACCEPT', {
        isRelayed: true,
        isChatMedia: Boolean(tr.isChatMedia),
        senderTag: tr.sender,
        targetTag: myTag,
        roster: myRosterSnapshot()
      });
    } else {
      sendSignal(tr.offerFrom || tr.sender, transferId, 'FILE_ACCEPT', {
        isChatMedia: Boolean(tr.isChatMedia),
        chatMsgId: tr.chatMsgId || null,
        roster: myRosterSnapshot()
      });
    }
    // Se o remetente não responder em 25s, marca erro para permitir nova tentativa
    setTimeout(() => {
      const cur = transfers[transferId];
      if (cur && cur.status === 'connecting' && !cur.transferredBytes) {
        setTransferStatus(cur, 'error', { error: 'Remetente não respondeu' });
      }
    }, 25000);
  }

  function myRosterSnapshot() {
    const me = myTag ? [{ tag: myTag, nodeId, lastSeen: Date.now(), status: 'online', regHash: myRegHash, clientType: Native.isAvailable() ? 'android' : 'web' }] : [];
    return me.concat(Object.values(peerRegistry).slice(0, 50).map((p) => ({ tag: p.tag, lastSeen: p.lastSeen, status: 'online', regHash: p.reghash })));
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
    for (let i = 0; i < len; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)));
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
      const timer = setInterval(() => {
        if (channel.readyState !== 'open' || channel.bufferedAmount <= maxAmount) {
          clearInterval(timer);
          resolve();
        }
      }, 15);
    });
  }

  function waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, timeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function candidateToJSON(c) {
    if (!c) return null;
    if (typeof c.toJSON === 'function') return c.toJSON();
    return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment };
  }

  // Leitura genérica de um trecho de arquivo (File/Blob web, URI SAF Android ou base64)
  async function readFileSlice(fileItem, offset, length) {
    const blob = fileItem instanceof Blob ? fileItem : (fileItem && fileItem.file instanceof Blob ? fileItem.file : null);
    if (blob) return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    if (fileItem && fileItem.uri && Native.isAvailable()) {
      const b64 = Native.readUriChunkBase64(fileItem.uri, offset, length);
      return b64 ? base64ToUint8Array(b64) : new Uint8Array(0);
    }
    if (fileItem && fileItem.base64) {
      if (!fileItem._bytes) fileItem._bytes = base64ToUint8Array(fileItem.base64);
      return fileItem._bytes.subarray(offset, offset + length);
    }
    return new Uint8Array(0);
  }

  // ==========================================================================
  // 7. WEBRTC SENDER & RECEIVER CORE COM FIX DE BUFFER E STREAMING
  // ==========================================================================
  async function startSenderWebRTC(transferId, targetTag, opts = {}) {
    const tr = transfers[transferId];
    const fileItem = opts.fileItem || stagedFilesMap.get(transferId) || (tr && tr.fileItem);
    if (!tr || !fileItem) {
      sendSignal(targetTag, transferId, 'FILE_REJECT', { error: 'Arquivo não está mais disponível no remetente.' });
      if (tr) setTransferStatus(tr, 'error', { error: 'Arquivo não encontrado. Selecione-o novamente.' });
      return;
    }

    // FILE_ACCEPT duplicado (a extensão aceita pelo CHAT_MESSAGE e pelo FILE_OFFER): ignora
    const existing = activePeerConnections.get(transferId);
    if (existing && existing._psRole === 'send' && !['failed', 'closed'].includes(existing.connectionState)) return;
    if (tr.relayActive || tr.status === 'completed') return;
    if (existing) { try { existing.close(); } catch {} }

    tr.status = 'connecting';
    tr.route = 'P2P';
    tr.startTime = Date.now();
    tr.paused = false;
    tr.cancelled = false;
    renderTransfers();
    Native.startKeepAlive('Transferindo ' + tr.fileName + ' para ' + targetTag);

    const pc = new RTCPeerConnection({ iceServers: getIceServers(), iceCandidatePoolSize: 4 });
    pc._psRole = 'send';
    activePeerConnections.set(transferId, pc);

    const dc = pc.createDataChannel('pulseshare-file-channel', { ordered: true });
    dc.binaryType = 'arraybuffer';

    let offerSent = false;
    const queuedCandidates = [];
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = candidateToJSON(e.candidate);
      if (offerSent) sendSignal(targetTag, transferId, 'ICE_CANDIDATE', { candidate: c });
      else queuedCandidates.push(c);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && tr.status !== 'completed' && !tr.relayActive) {
        // Link público: o portal cai para o túnel via malha (TUNNEL_RELAY_PULL)
        if (!opts.isLinkPull) setTransferStatus(tr, 'error', { error: 'Falha na conexão P2P' });
      }
    };

    dc.onopen = async () => {
      if (tr.relayActive) { try { pc.close(); } catch {} return; }
      setTransferStatus(tr, 'transferring');
      try {
        dc.send(JSON.stringify({
          type: 'FILE_START',
          fileId: opts.fileId || 'f-0',
          fileName: tr.fileName,
          fileSize: tr.totalBytes,
          fileType: tr.fileType || 'application/octet-stream'
        }));

        const CHUNK_SIZE = 16384; // 16 KB (WebRTC SCTP block)
        const READ_BLOCK = 256 * 1024;
        const totalBytes = tr.totalBytes;
        let offset = 0;

        while (offset < totalBytes) {
          const block = await readFileSlice(fileItem, offset, Math.min(READ_BLOCK, totalBytes - offset));
          if (!block.length) throw new Error('Falha ao ler o arquivo');
          let sub = 0;
          while (sub < block.length) {
            if (tr.cancelled) throw new Error('Transferência cancelada');
            while (tr.paused && !tr.cancelled) await new Promise((r) => setTimeout(r, 150));
            if (dc.bufferedAmount > 512 * 1024) await waitForBufferDrain(dc, 128 * 1024);
            if (dc.readyState !== 'open') throw new Error('Canal fechado');
            const end = Math.min(sub + CHUNK_SIZE, block.length);
            const slice = block.subarray(sub, end);
            // Fatia limpa com offset zero (evita corrupção SCTP)
            dc.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
            sub = end;
            offset += slice.length;
            updateTransferProgress(tr, offset);
          }
        }

        await waitForBufferDrain(dc, 0);
        dc.send(JSON.stringify({ type: 'EOF', fileId: opts.fileId || 'f-0', totalBytes }));
        tr._eofSent = true;
        // Se o receptor não confirmar, conclui mesmo assim
        setTimeout(() => {
          if (tr.status === 'transferring') finishSend(tr, pc, transferId, targetTag);
        }, 8000);
      } catch (err) {
        if (tr.cancelled || err.message === 'Transferência cancelada') {
          try { dc.send(JSON.stringify({ type: 'TRANSFER_CANCELLED' })); } catch {}
          setTransferStatus(tr, 'cancelled');
        } else {
          console.error('Erro no streaming de envio:', err);
          try { dc.send(JSON.stringify({ type: 'TRANSFER_ERROR', error: err.message })); } catch {}
          setTransferStatus(tr, 'error', { error: err.message });
        }
        Native.stopKeepAlive();
      }
    };

    dc.onmessage = (msgEvent) => {
      if (typeof msgEvent.data !== 'string') return;
      try {
        const ctrl = JSON.parse(msgEvent.data);
        if (ctrl.type === 'RECEIVER_ACK_DONE') {
          finishSend(tr, pc, transferId, targetTag);
        } else if (ctrl.type === 'P2P_ROSTER_SYNC') {
          mergeRosterIntoRegistry(ctrl.roster);
        } else if (ctrl.type === 'REQUEST_PAUSE') {
          tr.paused = true;
          setTransferStatus(tr, 'paused');
        } else if (ctrl.type === 'REQUEST_RESUME') {
          tr.paused = false;
          setTransferStatus(tr, 'transferring');
        } else if (ctrl.type === 'REQUEST_CANCEL') {
          tr.cancelled = true;
        }
      } catch {}
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Embute os candidatos STUN já coletados no SDP (menos dependência do trickle via MQTT)
    await waitForIceGathering(pc, 700);
    offerSent = true;
    sendSignal(targetTag, transferId, 'WEBRTC_OFFER', {
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      iceServers: getIceServers()
    });
    while (queuedCandidates.length) {
      sendSignal(targetTag, transferId, 'ICE_CANDIDATE', { candidate: queuedCandidates.shift() });
    }
  }

  function finishSend(tr, pc, transferId, targetTag) {
    if (tr.status === 'completed') return;
    tr.progress = 100;
    tr.transferredBytes = tr.totalBytes;
    setTransferStatus(tr, 'completed');
    Native.stopKeepAlive();
    if (!tr.shareId) Native.toast(`Envio de ${tr.fileName} concluído!`);
    if (tr.shareId && publicShares[tr.shareId]) {
      publicShares[tr.shareId].bytesServed = (publicShares[tr.shareId].bytesServed || 0) + (tr.totalBytes || 0);
      renderShares();
    }
    setTimeout(() => {
      try { pc && pc.close(); } catch {}
      if (activePeerConnections.get(transferId) === pc) activePeerConnections.delete(transferId);
    }, 1000);
  }

  // Salvamento de arquivo recebido: Android grava em streaming no disco; web monta Blob
  function createReceiveSink(transferId, tr) {
    let pending = [];
    let pendingBytes = 0;
    let first = true;
    const FLUSH_AT = 256 * 1024; // agrupa chunks para reduzir chamadas à ponte JS->Kotlin
    const flush = (isLast) => {
      if (!Native.isAvailable()) return '';
      let merged = new Uint8Array(pendingBytes);
      let off = 0;
      pending.forEach((c) => { merged.set(c, off); off += c.length; });
      pending = [];
      pendingBytes = 0;
      const res = Native.saveChunk(transferId, tr.fileName, merged.length ? uint8ArrayToBase64(merged) : '', first, isLast, tr.fileType || '*/*');
      first = false;
      return res;
    };
    return {
      write(bytes) {
        if (Native.isAvailable()) {
          pending.push(bytes);
          pendingBytes += bytes.length;
          if (pendingBytes >= FLUSH_AT) flush(false);
        } else {
          if (!tr._chunks) tr._chunks = [];
          tr._chunks.push(bytes);
        }
      },
      finish() {
        if (Native.isAvailable()) {
          const finalPath = flush(true);
          if (finalPath && finalPath !== 'CHUNK_WRITTEN') tr.savedPath = finalPath;
        } else {
          const blob = new Blob(tr._chunks || [], { type: tr.fileType && tr.fileType !== '*/*' ? tr.fileType : 'application/octet-stream' });
          tr._chunks = null;
          tr.savedPath = URL.createObjectURL(blob);
          tr.blob = blob;
          // Fora do chat (ou com auto-download) salva direto no disco do navegador
          if (!tr.isChatMedia || chatAutoDownload || tr.userRequested) {
            const a = document.createElement('a');
            a.href = tr.savedPath;
            a.download = tr.fileName || 'arquivo';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        }
      },
      abort() {
        pending = [];
        tr._chunks = null;
        Native.cancelTransfer(transferId);
      }
    };
  }

  function completeReceive(tr, senderTag) {
    tr.progress = 100;
    tr.transferredBytes = tr.totalBytes || tr.transferredBytes;
    setTransferStatus(tr, 'completed');
    Native.stopKeepAlive();
    Native.toast(`Download concluído: ${tr.fileName}`);
    if (tr.isChatMedia && tr.chatMsgId) {
      sendSignal(senderTag, tr.chatMsgId, 'CHAT_ACK', { msgId: tr.chatMsgId, senderTag: myTag, status: 'DELIVERED', mediaReady: true });
    }
  }

  async function startReceiverWebRTC(transferId, senderTag, sdpOffer, remoteIceServers) {
    const tr = transfers[transferId];
    // Offer sem oferta/aceite prévio (transferência desconhecida) é ignorada
    if (!tr || tr.type !== 'receive') return;
    if (tr.status === 'completed' || tr.status === 'cancelled') return;
    // Nunca recebe um arquivo que o usuário ainda não aceitou (mídia de chat com download manual)
    if (tr.status === 'awaiting_accept') return;

    // Uma nova offer para o mesmo transferId substitui a conexão anterior
    const old = activePeerConnections.get(transferId);
    if (old) { try { old.close(); } catch {} }

    Native.startKeepAlive('Recebendo arquivo de ' + senderTag);

    const pc = new RTCPeerConnection({
      iceServers: (remoteIceServers && remoteIceServers.length) ? remoteIceServers : getIceServers(),
      iceCandidatePoolSize: 4
    });
    pc._psRole = 'recv';
    activePeerConnections.set(transferId, pc);

    let answerSent = false;
    const queuedCandidates = [];
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = candidateToJSON(e.candidate);
      if (answerSent) sendSignal(senderTag, transferId, 'ICE_CANDIDATE', { candidate: c });
      else queuedCandidates.push(c);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !['completed', 'cancelled'].includes(tr.status)) {
        setTransferStatus(tr, 'error', { error: 'Falha na conexão P2P' });
        Native.stopKeepAlive();
      }
    };

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      tr._dc = dc;
      tr.startTime = Date.now();
      let sink = null;
      let received = 0;

      dc.onmessage = (msgEvent) => {
        if (typeof msgEvent.data === 'string') {
          let data;
          try { data = JSON.parse(msgEvent.data); } catch { return; }
          if (data.type === 'P2P_ROSTER_SYNC') {
            mergeRosterIntoRegistry(data.roster);
            return;
          }
          if (data.type === 'FILE_START') {
            if (data.fileName) tr.fileName = data.fileName;
            if (data.fileSize) tr.totalBytes = data.fileSize;
            if (data.fileType) tr.fileType = data.fileType;
            received = 0;
            sink = createReceiveSink(transferId, tr);
            setTransferStatus(tr, 'transferring');
            return;
          }
          if (data.type === 'TRANSFER_PAUSED') { setTransferStatus(tr, 'paused'); return; }
          if (data.type === 'TRANSFER_RESUMED') { setTransferStatus(tr, 'transferring'); return; }
          if (data.type === 'TRANSFER_CANCELLED' || data.type === 'TRANSFER_ERROR') {
            if (sink) sink.abort();
            setTransferStatus(tr, data.type === 'TRANSFER_ERROR' ? 'error' : 'cancelled', { error: data.error || '' });
            Native.stopKeepAlive();
            try { pc.close(); } catch {}
            return;
          }
          if (data.type === 'EOF') {
            try { dc.send(JSON.stringify({ type: 'RECEIVER_ACK_DONE' })); } catch {}
            if (!sink) sink = createReceiveSink(transferId, tr);
            sink.finish();
            completeReceive(tr, senderTag);
            setTimeout(() => {
              try { pc.close(); } catch {}
              if (activePeerConnections.get(transferId) === pc) activePeerConnections.delete(transferId);
            }, 1200);
          }
          return;
        }

        // Chunk binário recebido
        if (tr.status === 'cancelled') return;
        if (!sink) sink = createReceiveSink(transferId, tr);
        const chunkBytes = new Uint8Array(msgEvent.data);
        sink.write(chunkBytes);
        received += chunkBytes.byteLength;
        updateTransferProgress(tr, received);
      };
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdpOffer));
      pc._remoteSet = true;
      await flushPendingIce(transferId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc, 600);
      sendSignal(senderTag, transferId, 'WEBRTC_ANSWER', {
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
      });
      answerSent = true;
      while (queuedCandidates.length) {
        sendSignal(senderTag, transferId, 'ICE_CANDIDATE', { candidate: queuedCandidates.shift() });
      }
    } catch (err) {
      console.warn('Erro na negociação WebRTC (receptor):', err);
      setTransferStatus(tr, 'error', { error: 'Falha na negociação WebRTC' });
    }
  }

  async function flushPendingIce(transferId, pc) {
    const list = pendingIce.get(transferId) || [];
    pendingIce.delete(transferId);
    for (const c of list) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }

  async function handleIncomingAnswer(transferId, sdpAnswer) {
    const pc = activePeerConnections.get(transferId);
    if (pc && pc.signalingState === 'have-local-offer') {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdpAnswer));
        pc._remoteSet = true;
        await flushPendingIce(transferId, pc);
      } catch (err) {
        console.warn('SetRemoteDescription answer err:', err);
      }
    }
  }

  async function handleIncomingIce(transferId, candidate) {
    const pc = activePeerConnections.get(transferId);
    if (!pc || !pc._remoteSet) {
      // Candidato chegou antes da offer/answer: guarda para aplicar depois
      if (!pendingIce.has(transferId)) pendingIce.set(transferId, []);
      pendingIce.get(transferId).push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }

  // ==========================================================================
  // 7b. LINK PÚBLICO SERVIDO PELO APP (portal GitHub Pages ↔ app)
  // ==========================================================================
  const DEFAULT_PORTAL_URL = 'https://ricardoazt.github.io/share/';

  function createPublicShare(files, opts = {}) {
    const shareId = 'ps-' + Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const list = files.map((f, i) => ({
      fileId: 'f-' + i,
      name: f.name,
      size: f.size || 0,
      type: f.mimeType || f.type || 'application/octet-stream',
      item: f
    }));
    const expiresAt = opts.expiresMin > 0 ? Date.now() + opts.expiresMin * 60000 : null;
    const portal = (localStorage.getItem('ps_portal_url') || DEFAULT_PORTAL_URL).trim().replace(/\/+$/, '') + '/';
    const shareUrl = `${portal}#share=${shareId}&owner=${encodeURIComponent(myTag)}${expiresAt ? `&exp=${expiresAt}` : ''}`;
    publicShares[shareId] = {
      shareId,
      files: list,
      packName: list.length === 1 ? list[0].name : `Pack (${list.length} arquivos)`,
      totalSize: list.reduce((acc, f) => acc + f.size, 0),
      expiresAt,
      createdAt: Date.now(),
      shareUrl,
      downloads: 0,
      status: 'active'
    };
    renderShares();
    return publicShares[shareId];
  }

  function shareUnavailableReason(share) {
    if (!share) return { error: 'NOT_FOUND', message: 'Link não encontrado ou encerrado.' };
    if (share.status === 'cancelled') return { error: 'CANCELLED', message: 'O compartilhamento foi cancelado pelo remetente.' };
    if (share.expiresAt && Date.now() >= share.expiresAt) return { error: 'EXPIRED', message: 'Este link expirou.' };
    return null;
  }

  function handlePackInfoRequest(from, transferId, payload) {
    const share = publicShares[payload.shareId];
    const bad = shareUnavailableReason(share);
    if (bad) {
      // Só responde NOT_FOUND se o link for deste app (evita ruído entre dispositivos)
      if (share) sendSignal(from, transferId || payload.shareId, 'PACK_INFO_RESPONSE', { ok: false, ...bad });
      return;
    }
    sendSignal(from, transferId || share.shareId, 'PACK_INFO_RESPONSE', {
      ok: true,
      shareId: share.shareId,
      packName: share.packName,
      totalSize: share.totalSize,
      files: share.files.map(({ fileId, name, size, type }) => ({ fileId, name, size, type })),
      hasPassword: Boolean(share.passwordHash),
      passwordSalt: share.passwordSalt || '',
      passwordHash: share.passwordHash || '',
      expiresAt: share.expiresAt,
      ownerTag: myTag
    });
  }

  function handlePackFilePull(from, transferId, payload, viaRelay) {
    const share = publicShares[payload.shareId];
    const fileId = payload.fileId || 'f-0';
    const bad = shareUnavailableReason(share);
    if (bad) {
      if (share) sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: bad.message });
      return;
    }
    const file = share.files.find((f) => f.fileId === fileId);
    if (!file) {
      sendSignal(from, transferId, 'FILE_REJECT', { fileId, error: 'Arquivo não encontrado no link' });
      return;
    }
    let tr = transfers[transferId];
    if (!tr) {
      tr = transfers[transferId] = {
        id: transferId,
        type: 'send',
        target: from,
        targetLabel: 'Visitante do link',
        shareId: share.shareId,
        fileName: file.name,
        totalBytes: file.size,
        fileType: file.type,
        transferredBytes: 0,
        status: 'connecting',
        progress: 0,
        speed: '0 KB/s',
        fileItem: file.item,
        startTime: Date.now()
      };
      renderTransfers();
    }
    if (viaRelay) startRelaySend(transferId, from, file);
    else startSenderWebRTC(transferId, from, { fileItem: file.item, fileId, isLinkPull: true });
  }

  // Envio do arquivo em blocos base64 pela malha MQTT (portal em CGNAT/firewall)
  async function startRelaySend(transferId, targetTag, file) {
    const tr = transfers[transferId];
    if (!tr || tr.relayActive || tr.status === 'completed') return;
    tr.relayActive = true;
    tr.route = 'RELAY';
    const pc = activePeerConnections.get(transferId);
    if (pc) { try { pc.close(); } catch {} activePeerConnections.delete(transferId); }
    tr.startTime = Date.now();
    setTransferStatus(tr, 'transferring');

    const RELAY_CHUNK = 12 * 1024;
    const total = file.size || 0;
    const totalChunks = Math.max(1, Math.ceil(total / RELAY_CHUNK));
    const fileMeta = { fileId: file.fileId, name: file.name, size: total, type: file.type };
    let offset = 0;
    let seq = 0;
    try {
      do {
        if (tr.cancelled) throw new Error('Transferência cancelada');
        const bytes = total ? await readFileSlice(file.item, offset, Math.min(RELAY_CHUNK, total - offset)) : new Uint8Array(0);
        if (total && !bytes.length) throw new Error('Falha ao ler o arquivo');
        offset += bytes.length;
        seq++;
        sendSignal(targetTag, transferId, 'MESH_RELAY_CHUNK', {
          from: myTag,
          transferId,
          relayTag: myTag,
          fileId: file.fileId,
          chunkSeq: seq,
          totalChunks,
          chunkBase64: bytes.length ? uint8ArrayToBase64(bytes) : '',
          isEof: offset >= total,
          totalBytes: total,
          fileMeta
        });
        updateTransferProgress(tr, offset);
        await new Promise((r) => setTimeout(r, 20));
      } while (offset < total);
      finishSend(tr, null, transferId, targetTag);
    } catch (err) {
      setTransferStatus(tr, tr.cancelled ? 'cancelled' : 'error', { error: err.message });
    }
  }

  // Recebe um arquivo enviado em blocos pela malha (remetente atrás de CGNAT)
  function handleRelayChunk(from, transferId, payload) {
    const tr = transfers[transferId];
    // Só aceita dados de uma transferência que ESTE dispositivo aceitou (sem push não solicitado)
    if (!tr || tr.type !== 'receive' || !['connecting', 'transferring'].includes(tr.status)) return;
    if (payload.fileMeta && payload.fileMeta.name && tr.fileName === 'arquivo_recebido') tr.fileName = payload.fileMeta.name;
    tr.route = 'RELAY';
    let st = relayIncoming.get(transferId);
    if (!st) {
      st = { chunks: new Map(), received: 0, total: payload.totalChunks || 0 };
      relayIncoming.set(transferId, st);
      tr.status = 'transferring';
    }
    if (payload.totalChunks) st.total = Math.max(st.total, payload.totalChunks);
    if (typeof payload.chunkSeq === 'number' && !st.chunks.has(payload.chunkSeq)) {
      const bytes = payload.chunkBase64 ? base64ToUint8Array(payload.chunkBase64) : new Uint8Array(0);
      st.chunks.set(payload.chunkSeq, bytes);
      st.received += bytes.length;
      updateTransferProgress(tr, st.received, payload.totalBytes);
    }
    if (st.total && st.chunks.size >= st.total) {
      relayIncoming.delete(transferId);
      const sink = createReceiveSink(transferId, tr);
      for (let s = 1; s <= st.total; s++) sink.write(st.chunks.get(s) || new Uint8Array(0));
      sink.finish();
      completeReceive(tr, from);
    }
  }

  function renderShares() {
    const list = document.getElementById('shares-list');
    if (!list) return;
    const shares = Object.values(publicShares).sort((a, b) => b.createdAt - a.createdAt);
    if (!shares.length) {
      list.innerHTML = '<div class="text-center py-10 text-slate-500 text-xs">Nenhum link público ativo. Use "Criar Link" na aba Início.</div>';
      return;
    }
    list.innerHTML = shares.map((s) => {
      const bad = shareUnavailableReason(s);
      const active = Object.values(transfers).filter((t) => t.shareId === s.shareId && ['connecting', 'transferring'].includes(t.status)).length;
      const expTxt = s.expiresAt ? `Expira ${formatTime(s.expiresAt)}` : 'Sem expiração';
      return `
        <div class="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">🔗 ${escapeHtml(s.packName)}</span>
              <span class="text-[10px] text-slate-400 font-mono">${formatBytes(s.totalSize)} • ${s.files.length} arquivo(s) • ${expTxt}</span>
            </div>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${bad ? 'bg-slate-800 text-slate-400' : 'bg-emerald-500/20 text-emerald-400'}">${bad ? 'encerrado' : (active ? `${active} baixando` : 'ativo')}</span>
          </div>
          <div class="text-[10px] text-slate-500">Downloads concluídos: <b class="text-slate-300">${s.downloads || 0}</b> • O app precisa ficar aberto para o link funcionar.</div>
          <div class="flex gap-2">
            <button type="button" onclick="window.psShareAction('copy','${s.shareId}')" class="flex-1 py-1.5 rounded-lg bg-slate-800 text-white text-[10px] font-bold">Copiar link</button>
            <button type="button" onclick="window.psShareAction('share','${s.shareId}')" class="flex-1 py-1.5 rounded-lg bg-indigo-600 text-white text-[10px] font-bold">Compartilhar</button>
            ${bad ? '' : `<button type="button" onclick="window.psShareAction('stop','${s.shareId}')" class="py-1.5 px-2.5 rounded-lg bg-rose-600/80 text-white text-[10px] font-bold">Encerrar</button>`}
          </div>
        </div>`;
    }).join('');
  }

  window.psShareAction = function (action, shareId) {
    const s = publicShares[shareId];
    if (!s) return;
    if (action === 'copy') {
      Native.copy(s.shareUrl);
      Native.toast('Link copiado!');
    } else if (action === 'share') {
      Native.shareText('PulseShare', formatShareMessage(s));
    } else if (action === 'stop') {
      s.status = 'cancelled';
      Object.values(transfers).forEach((t) => {
        if (t.shareId === shareId && ['connecting', 'transferring'].includes(t.status)) t.cancelled = true;
      });
      renderShares();
    }
  };

  function formatShareMessage(s) {
    const files = s.files.map((f) => `  • ${f.name} (${formatBytes(f.size)})`).join('\n');
    const exp = (s.password ? `\n🔑 Senha: ${s.password}` : '') + (s.expiresAt ? `\n⏳ Expira às ${formatTime(s.expiresAt)}` : '');
    return `📦 PulseShare — Compartilhamento de Arquivos P2P\n🔗 Link: ${s.shareUrl}${exp}\n📁 Arquivos (${s.files.length}):\n${files}\n\n⚡ Baixe direto pelo navegador (WebRTC P2P), sem instalar nada!`;
  }

  // ==========================================================================
  // 8. CHAT-FIRST UI, CONVERSAS & EDGE-TO-EDGE FULL SCREEN
  // ==========================================================================
  const peerTypingState = {}; // tag -> { status, at }

  function isLinkVisitor(tag) {
    return String(tag || '').startsWith('@link_');
  }

  function displayNameFor(tag) {
    if (isLinkVisitor(tag)) return 'Visitante do link ' + tag.slice(6, 10);
    return tag.replace(/^@/, '').split('_')[0];
  }

  function updateChatHeaderTyping() {
    const el = document.getElementById('chat-contact-tag');
    if (!el || !activeChatPeer) return;
    const st = peerTypingState[activeChatPeer];
    const typing = st && st.status && st.status !== 'idle' && Date.now() - st.at < 6000;
    el.textContent = typing ? (st.status === 'recording' ? '🎤 gravando áudio...' : 'digitando...') : activeChatPeer;
    if (typing) setTimeout(updateChatHeaderTyping, 6000);
  }

  function handleIncomingChatMessage(payload) {
    if (!payload || !payload.senderTag) return;
    const from = normalizeTag(payload.senderTag);
    if (from === normalizeTag(myTag)) return;

    if (!chatMessages[from]) chatMessages[from] = [];
    const msgId = payload.id || ('msg_' + Date.now());

    // Confirma entrega ao remetente (✓✓) — mesmo para duplicatas, pois o ACK anterior pode ter se perdido
    sendSignal(from, msgId, 'CHAT_ACK', { msgId, senderTag: myTag, status: activeChatPeer === from ? 'READ' : 'DELIVERED' });

    if (chatMessages[from].some(m => m.id === msgId)) return;

    const fileMeta = payload.media || payload.fileMeta || null;
    const mediaTid = fileMeta ? (payload.transferId || fileMeta.transferId) : null;
    chatMessages[from].push({
      id: msgId,
      sender: from,
      text: payload.text || '',
      timestamp: payload.timestamp || Date.now(),
      status: 'RECEIVED',
      transferId: mediaTid,
      media: fileMeta,
      forwarded: Boolean(payload.forwarded || payload.isForwarded)
    });
    chatMessages[from].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    saveChatMessagesToStorage();

    // Mídia anexada: registra em Transferências (aguardando aceite ou já conectando)
    if (mediaTid) {
      const existing = transfers[mediaTid];
      if (!existing) {
        transfers[mediaTid] = {
          id: mediaTid,
          type: 'receive',
          sender: from,
          offerFrom: from,
          fileName: fileMeta.name || fileMeta.fileName || 'arquivo_chat',
          totalBytes: fileMeta.size || fileMeta.fileSize || 0,
          fileType: fileMeta.type || fileMeta.fileType || '*/*',
          transferredBytes: 0,
          status: 'awaiting_accept',
          speed: '0 KB/s',
          progress: 0,
          isChatMedia: true,
          chatMsgId: msgId,
          startTime: Date.now(),
          savedPath: null
        };
      } else if (!existing.chatMsgId) {
        existing.chatMsgId = msgId;
      }
      renderTransfers();
    }

    if (activeChatPeer === from) {
      renderChatMessages(from);
    } else {
      const badge = document.getElementById('badge-chat-unread');
      if (badge) {
        badge.textContent = parseInt(badge.textContent || '0', 10) + 1;
        badge.classList.remove('hidden');
      }
      if (document.hidden || currentTab !== 'chat') {
        Native.toast(`💬 ${displayNameFor(from)}: ${payload.text ? payload.text.slice(0, 60) : '📎 arquivo'}`);
      }
    }

    renderConversationsList();
  }

  function sendChatMessage(targetTag, text) {
    targetTag = normalizeTag(targetTag);
    if (!targetTag || !text) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const msgId = 'cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const ts = Date.now();
    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: ts,
      status: 'SENT'
    });
    saveChatMessagesToStorage();

    const payload = {
      id: msgId,
      senderTag: myTag,
      text,
      msgType: 'text',
      type: 'text',
      timestamp: ts
    };

    // Rota Bluetooth BLE (se peer estiver no alcance do rádio BLE) + malha MQTT.
    // (O antigo atalho pelo DataChannel de arquivo foi removido: a extensão ignora
    //  mensagens CHAT_DIRECT e a conversa sumia após qualquer transferência.)
    if (peerTransports[targetTag] === 'BLE' && Native.isBleAvailable()) {
      Native.sendBleMessage(targetTag, JSON.stringify(payload));
    }
    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload);
    scheduleChatRetry(targetTag, msgId, payload);

    renderChatMessages(targetTag);
    renderConversationsList();
  }

  // Reenvia mensagens sem ACK (perda em broker público); o destino deduplica pelo id
  function scheduleChatRetry(targetTag, msgId, payload, attempt = 1) {
    if (attempt > 3) return;
    setTimeout(() => {
      const m = (chatMessages[targetTag] || []).find((x) => x.id === msgId);
      if (m && m.status === 'SENT') {
        sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload);
        scheduleChatRetry(targetTag, msgId, payload, attempt + 1);
      }
    }, 4000 * attempt);
  }

  function sendChatMessageWithMedia(targetTag, text, transferId, fileItem) {
    targetTag = normalizeTag(targetTag);
    if (!targetTag || !fileItem) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const msgId = 'cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const mime = fileItem.mimeType || fileItem.type || 'application/octet-stream';
    const msgType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
    const fileMeta = {
      name: fileItem.name,
      fileName: fileItem.name,
      size: fileItem.size,
      fileSize: fileItem.size,
      type: mime,
      fileType: mime,
      transferId
    };
    const ts = Date.now();

    if (transfers[transferId]) transfers[transferId].chatMsgId = msgId;

    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: ts,
      status: 'SENT',
      transferId,
      media: fileMeta
    });
    saveChatMessagesToStorage();

    const payload = {
      id: msgId,
      senderTag: myTag,
      text,
      msgType,
      type: msgType,
      timestamp: ts,
      transferId,
      fileMeta,
      media: fileMeta
    };
    sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload);
    scheduleChatRetry(targetTag, msgId, payload);

    sendSignal(targetTag, transferId, 'FILE_OFFER', {
      isChatMedia: true,
      chatMsgId: msgId,
      fileName: fileItem.name,
      fileSize: fileItem.size,
      fileType: mime,
      roster: myRosterSnapshot()
    });

    renderTransfers();
    renderChatMessages(targetTag);
    renderConversationsList();
  }

  // Registra um arquivo a enviar (chat ou envio direto) e dispara a oferta
  function queueOutgoingFile(target, fileItem, text) {
    const tid = 'chatmedia-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    stagedFilesMap.set(tid, fileItem);
    transfers[tid] = {
      id: tid,
      type: 'send',
      target: normalizeTag(target),
      fileName: fileItem.name,
      totalBytes: fileItem.size,
      fileType: fileItem.mimeType || fileItem.type || '*/*',
      transferredBytes: 0,
      status: 'awaiting_accept',
      progress: 0,
      speed: '0 KB/s',
      fileItem,
      isChatMedia: true,
      startTime: Date.now()
    };
    sendChatMessageWithMedia(target, text || '', tid, fileItem);
  }

  window.downloadChatMedia = function (transferId, fileName) {
    let tr = transfers[transferId];
    if (tr && tr.savedPath) {
      if (tr.type === 'receive' && !Native.isAvailable() && tr.blob) {
        // Web: salva o arquivo já recebido no disco
        const a = document.createElement('a');
        a.href = tr.savedPath;
        a.download = tr.fileName || fileName || 'arquivo';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      Native.openFile(tr.savedPath);
      return;
    }
    if (tr && tr.type === 'send') return;

    if (!tr) {
      let fileMeta = null;
      let sender = activeChatPeer || '';
      let chatMsgId = null;
      for (const peer in chatMessages) {
        const msg = chatMessages[peer].find(m => m.transferId === transferId);
        if (msg && msg.media) {
          fileMeta = msg.media;
          sender = peer;
          chatMsgId = msg.id;
          break;
        }
      }
      tr = {
        id: transferId,
        type: 'receive',
        sender,
        offerFrom: sender,
        fileName: (fileMeta && (fileMeta.fileName || fileMeta.name)) || fileName || 'arquivo_chat',
        totalBytes: (fileMeta && (fileMeta.fileSize || fileMeta.size)) || 0,
        fileType: (fileMeta && (fileMeta.fileType || fileMeta.type)) || '*/*',
        transferredBytes: 0,
        status: 'awaiting_accept',
        speed: '0 KB/s',
        progress: 0,
        isChatMedia: true,
        chatMsgId,
        startTime: Date.now(),
        savedPath: null
      };
      transfers[transferId] = tr;
    }
    if (['connecting', 'transferring'].includes(tr.status)) return;

    tr.userRequested = true;
    Native.toast(`Iniciando download de ${tr.fileName}...`);
    acceptIncomingTransfer(transferId);
    if (activeChatPeer) renderChatMessages(activeChatPeer);
  };

  window.cancelTransfer = function (transferId) {
    const tr = transfers[transferId];
    if (!tr) return;
    tr.cancelled = true;
    const pc = activePeerConnections.get(transferId);
    if (tr.type === 'receive') {
      try { tr._dc && tr._dc.send(JSON.stringify({ type: 'REQUEST_CANCEL' })); } catch {}
      if (tr.status === 'awaiting_accept') sendSignal(tr.offerFrom || tr.sender, transferId, 'TRANSFER_REJECT', {});
      Native.cancelTransfer(transferId);
    }
    if (pc) { setTimeout(() => { try { pc.close(); } catch {} }, 300); activePeerConnections.delete(transferId); }
    setTransferStatus(tr, 'cancelled');
    Native.stopKeepAlive();
  };

  window.acceptTransfer = function (transferId) {
    const tr = transfers[transferId];
    if (tr) { tr.userRequested = true; acceptIncomingTransfer(transferId); }
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
      const name = (contact && contact.name) || (peer && peer.name) || displayNameFor(tag);
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
    peerTag = normalizeTag(peerTag);
    if (!peerTag) return;
    if (!peerTag.startsWith('@')) peerTag = '@' + peerTag;
    activeChatPeer = peerTag;
    // Confirmação de leitura (✓✓ azul) para quem nos enviou mensagens
    if ((chatMessages[peerTag] || []).some(m => m.sender === peerTag)) {
      sendSignal(peerTag, 'read-' + Date.now(), 'CHAT_READ', { readerTag: myTag });
    }
    const contacts = (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};
    const contact = contacts[peerTag];
    const peer = peerRegistry[peerTag];
    const name = (contact && contact.name) || (peer && peer.name) || displayNameFor(peerTag);
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

  window.openActiveChat = (tag) => openActiveChat(tag);

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
        const isTransferring = tr && ['transferring', 'connecting', 'paused'].includes(tr.status);
        const safeName = escapeHtml(fileName);
        const isMine = m.sender === myTag;
        let action;
        if (isMine) {
          const st = tr ? tr.status : 'completed';
          action = isTransferring ? `<span class="text-[10px] font-mono text-indigo-300 font-bold animate-pulse">${tr.progress || 0}%</span>`
            : `<span class="text-[10px] font-bold ${st === 'completed' ? 'text-emerald-300' : st === 'error' || st === 'cancelled' ? 'text-rose-300' : 'text-slate-300'}">${st === 'completed' ? 'Enviado' : st === 'awaiting_accept' ? 'Aguardando' : st === 'error' ? 'Falhou' : st === 'cancelled' ? 'Cancelado' : st}</span>`;
        } else if (isDownloaded) {
          action = `<button type="button" onclick="window.downloadChatMedia('${tid}')" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shadow active:scale-95">${Native.isAvailable() ? 'Abrir' : 'Salvar'}</button>`;
        } else if (isTransferring) {
          action = `<span class="text-[10px] font-mono text-indigo-400 font-bold animate-pulse">${tr.status === 'connecting' ? 'conectando' : (tr.progress || 0) + '%'}</span>`;
        } else {
          action = `<button type="button" onclick="window.downloadChatMedia('${tid}')" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold shadow active:scale-95">${tr && tr.status === 'error' ? 'Tentar de novo' : 'Baixar'}</button>`;
        }
        const mime = (tr && tr.fileType) || (m.media && (m.media.fileType || m.media.type)) || '';
        const preview = (isDownloaded && !Native.isAvailable() && /^image\//.test(mime)) ? `<img src="${tr.savedPath}" class="max-h-48 rounded-lg" alt="">` : '';

        mediaHtml = `
          <div class="mt-2 p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
            ${preview}
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-lg">📁</span>
                <div class="min-w-0">
                  <span class="text-xs font-bold text-white block truncate">${safeName}</span>
                  <span class="text-[10px] text-slate-400 font-mono">${formatBytes(fileSize)}</span>
                </div>
              </div>
              <div>${action}</div>
            </div>
            ${isTransferring ? `
              <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${tr.progress || 0}%"></div>
              </div>
            ` : ''}
          </div>
        `;
      }

      const tick = !isMe ? '' : m.status === 'READ' ? '<span class="text-sky-300 font-bold ml-0.5">✓✓</span>'
        : m.status === 'DELIVERED' ? '<span class="text-indigo-200 font-bold ml-0.5">✓✓</span>'
        : '<span class="text-indigo-200 font-bold ml-0.5">✓</span>';
      const reactions = m.reactions ? Object.values(m.reactions).join(' ') : '';

      return `
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} my-0.5">
          <div class="max-w-[80%] rounded-2xl px-3 py-1.5 shadow-sm ${isMe ? 'bg-indigo-600 text-white rounded-tr-xs' : 'bg-slate-800 border border-slate-700/60 text-slate-100 rounded-tl-xs'}">
            ${m.forwarded ? '<span class="text-[9px] italic opacity-70 block">↪ Encaminhada</span>' : ''}
            ${m.text ? `<p class="text-[13px] leading-snug break-words select-text">${escapeHtml(m.text)}</p>` : ''}
            ${mediaHtml}
            <div class="flex items-center justify-end gap-1 mt-0.5 text-[10px] ${isMe ? 'text-indigo-200' : 'text-slate-400'} font-medium select-none">
              ${reactions ? `<span class="mr-1">${escapeHtml(reactions)}</span>` : ''}
              <span>${timeStr}</span>
              ${tick}
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

    // Permite iniciar conversa com um @usuario digitado, mesmo que ainda não visto na malha
    const typedTag = q && /^@?[a-z0-9_]{3,}$/.test(q) ? (q.startsWith('@') ? q : '@' + q) : '';
    if (typedTag && typedTag !== normalizeTag(myTag) && !filtered.some(p => p.tag === typedTag)) {
      filtered.push({ tag: typedTag, name: 'Conversar com ' + typedTag, transport: 'P2P', avatar: typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(typedTag, 56) : '' });
    }

    if (filtered.length === 0) {
      resultsContainer.innerHTML = `
        <div class="text-center py-8 text-slate-500 text-xs">
          Nenhum usuário encontrado ${q ? `para "${escapeHtml(q)}"` : 'na malha no momento'}.
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
    // Itens de texto/link não são arquivos (antes iam para a lista de envio e quebravam o envio)
    const files = items.filter(it => !it.type || it.type === 'file');
    const texts = items.filter(it => it.type === 'text' || it.type === 'link').map(it => String(it.content || ''));
    const shareLink = texts.map(t => (t.match(/https?:\/\/\S*[#?&]share=\S+/) || [])[0]).find(Boolean);
    if (shareLink) {
      const input = document.getElementById('input-open-link');
      if (input) input.value = shareLink;
      switchTab('home');
      Native.toast('Link PulseShare recebido. Toque em "Baixar" para abrir.');
    }
    if (files.length) {
      stagedFiles = files;
      openSendModal('p2p');
      renderStagedFiles();
    }
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
    const activeCount = allTransfers.filter(t => ['connecting', 'transferring', 'awaiting_accept', 'paused'].includes(t.status)).length;
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

    const STATUS_LABEL = {
      awaiting_accept: 'aguardando', connecting: 'conectando', transferring: 'transferindo',
      paused: 'pausado', completed: 'concluído', cancelled: 'cancelado', error: 'erro', failed: 'erro'
    };
    filtered.sort((x, y) => (y.startTime || 0) - (x.startTime || 0));
    container.innerHTML = filtered.map(t => {
      const isSend = t.type === 'send';
      const peerTag = isSend ? t.target : t.sender;
      const peerLabel = t.shareId ? `🔗 Link • ${isLinkVisitor(peerTag) ? displayNameFor(peerTag) : (peerTag || '')}` : (peerTag || 'desconhecido');
      const origin = t.shareId ? 'Link público' : (t.isChatMedia ? 'Chat' : 'Envio direto');
      const route = t.route === 'RELAY' ? ' • 🔀 via malha' : '';
      const safeName = escapeHtml(t.fileName || 'arquivo');
      const isActive = ['connecting', 'transferring', 'awaiting_accept', 'paused'].includes(t.status);
      return `
        <div class="p-3.5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div class="flex items-start justify-between">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="text-xl">${isSend ? '📤' : '📥'}</span>
              <div class="min-w-0">
                <span class="text-xs font-bold text-white block truncate">${safeName}</span>
                <span class="text-[10px] text-slate-400 font-mono block truncate">${formatBytes(t.totalBytes)} • ${escapeHtml(peerLabel)}</span>
                <span class="text-[9px] text-slate-500 block">${origin}${route}${t.error ? ' • ' + escapeHtml(t.error) : ''}</span>
              </div>
            </div>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
              t.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
              t.status === 'transferring' ? 'bg-indigo-500/20 text-indigo-400' :
              t.status === 'awaiting_accept' ? 'bg-amber-500/20 text-amber-400' :
              (t.status === 'error' || t.status === 'cancelled') ? 'bg-rose-500/20 text-rose-400' :
              'bg-slate-800 text-slate-400'
            }">${STATUS_LABEL[t.status] || t.status}</span>
          </div>

          <div class="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
            <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${t.progress || 0}%"></div>
          </div>

          <div class="flex items-center justify-between text-[10px] text-slate-400">
            <span>${t.progress || 0}% • ${t.speed || '0 KB/s'}</span>
            <div class="flex gap-3">
              ${(!isSend && t.status === 'awaiting_accept') ? `
                <button type="button" onclick="window.acceptTransfer('${t.id}')" class="text-emerald-400 font-bold hover:underline">Aceitar</button>
              ` : ''}
              ${(!isSend && (t.status === 'error' || t.status === 'cancelled')) ? `
                <button type="button" onclick="window.acceptTransfer('${t.id}')" class="text-indigo-400 font-bold hover:underline">Tentar de novo</button>
              ` : ''}
              ${t.savedPath ? `
                <button type="button" onclick="window.downloadChatMedia('${t.id}')" class="text-emerald-400 font-bold hover:underline">${Native.isAvailable() ? 'Abrir' : 'Salvar'}</button>
              ` : ''}
              ${isActive ? `
                <button type="button" onclick="window.cancelTransfer('${t.id}')" class="text-rose-400 font-bold hover:underline">${(!isSend && t.status === 'awaiting_accept') ? 'Recusar' : 'Cancelar'}</button>
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
        if (text) sendChatMessage(activeChatPeer, text);
        chatAttachedFiles.forEach(f => queueOutgoingFile(activeChatPeer, f, ''));
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

    document.getElementById('btn-confirm-send').onclick = async () => {
      if (stagedFiles.length === 0) {
        Native.toast('Selecione ao menos um arquivo!');
        return;
      }
      const files = stagedFiles.filter(f => !f.type || f.type === 'file' || f.size !== undefined);
      if (modalMode === 'p2p') {
        const target = normalizeTag(document.getElementById('input-target-user').value.trim().replace(/^([^@])/, '@$1'));
        if (!target || target === '@') {
          Native.toast('Informe o @destinatário!');
          return;
        }
        document.getElementById('modal-send').classList.add('hidden');
        openActiveChat(target);
        files.forEach(f => queueOutgoingFile(target, f, ''));
        stagedFiles = [];
        renderStagedFiles();
        switchTab('transfers');
      } else {
        const expMs = parseInt((document.getElementById('select-link-expiration') || {}).value || '1800000', 10);
        const password = ((document.getElementById('input-link-password') || {}).value || '').trim();
        const share = createPublicShare(files, { expiresMin: Math.round(expMs / 60000) });
        if (password) {
          share.passwordSalt = Math.random().toString(36).slice(2, 10);
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + share.passwordSalt));
          share.passwordHash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
          share.password = password;
        }
        stagedFiles = [];
        renderStagedFiles();
        document.getElementById('modal-send').classList.add('hidden');
        Native.copy(formatShareMessage(share));
        Native.toast('Link gerado e copiado! Mantenha o app aberto enquanto baixam.');
        switchTab('shares');
      }
    };

    // Filtro Ativas / Histórico e limpeza (antes os botões não tinham ação)
    const tabActive = document.getElementById('tab-transfers-active');
    const tabHistory = document.getElementById('tab-transfers-history');
    const setFilter = (f) => {
      transfersFilter = f;
      const on = 'text-xs font-bold text-orange-400 border-b-2 border-orange-500 pb-1 px-1';
      const off = 'text-xs font-medium text-slate-400 hover:text-white pb-1 px-1';
      if (tabActive) tabActive.className = f === 'active' ? on : off;
      if (tabHistory) tabHistory.className = f === 'history' ? on : off;
      renderTransfers();
    };
    if (tabActive) tabActive.onclick = () => setFilter('active');
    if (tabHistory) tabHistory.onclick = () => setFilter('history');
    const btnClear = document.getElementById('btn-clear-completed-transfers');
    if (btnClear) btnClear.onclick = () => {
      Object.keys(transfers).forEach((id) => {
        if (['completed', 'cancelled', 'error', 'failed'].includes(transfers[id].status)) delete transfers[id];
      });
      renderTransfers();
    };

    // Indicador "digitando..." para o contato
    let typingTimer = null;
    document.getElementById('input-chat-text').addEventListener('input', () => {
      if (!activeChatPeer || typingTimer) return;
      sendSignal(activeChatPeer, 'typing-' + Date.now(), 'CHAT_TYPING', { status: 'typing' });
      typingTimer = setTimeout(() => {
        typingTimer = null;
        if (activeChatPeer) sendSignal(activeChatPeer, 'typing-' + Date.now(), 'CHAT_TYPING', { status: 'idle' });
      }, 3000);
    });

    const btnNewShare = document.getElementById('btn-new-share-link');
    if (btnNewShare) btnNewShare.onclick = () => openSendModal('link');

    // Baixar por link público: abre o portal de download (área de download + chat temporário)
    document.getElementById('btn-open-link-go').onclick = () => {
      const url = document.getElementById('input-open-link').value.trim();
      if (!url) return;
      if (!/#share=|[?&]share=/.test(url)) {
        Native.toast('Link inválido: cole um link PulseShare (contém #share=).');
        return;
      }
      Native.openUrl(url);
    };
  }

  // Inspeção para depuração/testes E2E (somente leitura)
  window.__psDebug = () => ({ myTag, transfers, peerRegistry, publicShares, chatMessages });

  // Inicialização do Aplicativo
  window.addEventListener('DOMContentLoaded', async () => {
    await initCryptoIdentity();
    updateHeaderStatus();
    initEvents();
    connectBrokers();
    switchTab('chat'); // Abertura direta no chat por padrão
  });

})();
