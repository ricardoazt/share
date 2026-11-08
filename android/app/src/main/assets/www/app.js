/**
 * PulseShare Android Native Application Core (app.js)
 * Conexão Multi-Broker MQTT + WebRTC DataChannel + BLE Mesh + Nostr Identity
 * 100% Compatível com Extensão Chrome Desktop e P2P Web
 */

(function () {
  // Plataforma: o MESMO app roda no Android (WebView), na extensão do Chrome e na web
  const IS_ANDROID = typeof window.PulseShareNative !== 'undefined';
  const IS_EXTENSION = location.protocol === 'chrome-extension:';
  const IS_BACKGROUND_PAGE = new URLSearchParams(location.search).get('bg') === '1';
  // App de desktop (Electron, pacote .deb): ponte em desktop/preload.js
  const IS_DESKTOP = typeof window.PulseShareDesktop !== 'undefined';
  const Desk = window.PulseShareDesktop || null;
  document.documentElement.classList.toggle('is-android', IS_ANDROID);
  document.documentElement.classList.toggle('is-extension', IS_EXTENSION);
  document.documentElement.classList.toggle('is-desktop', IS_DESKTOP);
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
  // 1b. VÁRIAS CONTAS NO MESMO APARELHO (alternar / adicionar / sair)
  // O app lê conversas, contatos etc. de chaves fixas do localStorage ("ao
  // vivo"). Cada conta tem a sua cópia guardada em ps_acct_<conta>__<chave>; a
  // conta dona das chaves ao vivo fica em ps_live_account_id. Quando a conta
  // ativa muda (troca, nova conta, saída), ANTES de qualquer leitura: guarda as
  // chaves ao vivo na conta anterior e carrega as da conta nova. <conta> vem da
  // chave pública (estável: entrar de novo com a mesma chave recupera os dados).
  // Só a conta ativa fica conectada e recebe mensagens.
  // ==========================================================================
  const ACCOUNT_SCOPED_KEYS = ['ps_chat_messages', 'ps_contacts_catalog_v2', 'ps_custom_categories', 'ps_blocked_tags',
    'ps_previous_tags', 'ps_my_tag', 'ps_my_reghash', 'ps_node_id'];
  const LIVE_ACCOUNT_KEY = 'ps_live_account_id';
  function accountStoreId(profile) {
    return profile && profile.pubKeyHex ? 'k' + profile.pubKeyHex.slice(0, 16) : '';
  }
  function accountStoreKey(acct, key) {
    return `ps_acct_${acct}__${key}`;
  }
  function rawProfiles() {
    try { return JSON.parse(localStorage.getItem('ps_profiles_v2') || '[]') || []; } catch (e) { return []; }
  }
  function rawActiveProfile() {
    const list = rawProfiles();
    const id = localStorage.getItem('ps_active_profile_id_v2');
    return list.find((p) => p.id === id) || list[0] || null;
  }
  function accountHasStash(acct) {
    return ACCOUNT_SCOPED_KEYS.some((k) => localStorage.getItem(accountStoreKey(acct, k)) !== null);
  }
  // Troca as chaves ao vivo para a conta <target> (guardando as da conta atual)
  function swapLiveAccount(target) {
    const live = localStorage.getItem(LIVE_ACCOUNT_KEY);
    if (live === target) return;
    // 1) dados da conta nova para a memória (e libera o espaço que ocupavam)
    const incoming = {};
    ACCOUNT_SCOPED_KEYS.forEach((k) => { incoming[k] = localStorage.getItem(accountStoreKey(target, k)); });
    // 2) guarda os dados ao vivo na conta anterior
    if (live) {
      ACCOUNT_SCOPED_KEYS.forEach((k) => {
        const v = localStorage.getItem(k);
        if (v === null) localStorage.removeItem(accountStoreKey(live, k));
        else localStorage.setItem(accountStoreKey(live, k), v); // pode lançar (cota): aborta antes de mexer no resto
      });
    }
    // 3) carrega a conta nova nas chaves ao vivo
    ACCOUNT_SCOPED_KEYS.forEach((k) => {
      localStorage.removeItem(accountStoreKey(target, k));
      if (incoming[k] === null) localStorage.removeItem(k);
      else localStorage.setItem(k, incoming[k]);
    });
    localStorage.setItem(LIVE_ACCOUNT_KEY, target);
  }
  function syncAccountStorage() {
    try {
      const target = accountStoreId(rawActiveProfile());
      if (!target) return;
      const live = localStorage.getItem(LIVE_ACCOUNT_KEY);
      // 1ª vez com este recurso: os dados atuais são da conta ativa
      if (!live && !accountHasStash(target)) { localStorage.setItem(LIVE_ACCOUNT_KEY, target); return; }
      swapLiveAccount(target);
    } catch (e) {
      console.warn('[PulseShare] falha ao trocar os dados da conta:', e);
    }
  }
  syncAccountStorage();
  const LOADED_ACCOUNT = localStorage.getItem(LIVE_ACCOUNT_KEY) || '';
  // Outra página (ex.: o documento de fundo da extensão) trocou de conta?
  function liveAccountChanged() {
    return Boolean(LOADED_ACCOUNT) && localStorage.getItem(LIVE_ACCOUNT_KEY) !== LOADED_ACCOUNT;
  }

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
  // Notificações / segundo plano (Configurações → 🔔)
  let notifyEnabled = localStorage.getItem('ps_notify_enabled') !== 'false';
  let notifySound = localStorage.getItem('ps_notify_sound') || 'pulso';
  let notifyVibration = localStorage.getItem('ps_notify_vibration') || 'dupla';
  // Padrão: ligado no celular/extensão; no app de desktop só se a pessoa ligar
  // (lá ele também abre o PulseShare sozinho ao entrar no computador)
  let backgroundMode = IS_DESKTOP
    ? localStorage.getItem('ps_background_mode') === 'true'
    : localStorage.getItem('ps_background_mode') !== 'false';
  let coreLost = false; // extensão: outra janela assumiu a conexão

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
    // As chaves ao vivo passaram para outra conta (troca em outra página): não sobrescreve
    if (liveAccountChanged()) return;
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

  // Só [a-z0-9_@]: tags vêm da rede e vão para HTML/atributos (evita injeção)
  function normalizeTag(tag) {
    return tag ? String(tag).toLowerCase().trim().replace(/[^a-z0-9_@]/g, '') : '';
  }

  // --------------------------------------------------------------------------
  // Contatos: só usuários ADICIONADOS aparecem para interação (sem descoberta
  // automática). A presença dos demais continua no peerRegistry só para rotear.
  // --------------------------------------------------------------------------
  function getContacts() {
    return (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};
  }
  function isContact(tag) {
    return Boolean(getContacts()[normalizeTag(tag)]);
  }
  let blockedTags = new Set();
  try { blockedTags = new Set(JSON.parse(localStorage.getItem('ps_blocked_tags') || '[]')); } catch (e) {}
  function isBlocked(tag) { return blockedTags.has(normalizeTag(tag)); }
  function setBlocked(tag, blocked) {
    tag = normalizeTag(tag);
    if (blocked) blockedTags.add(tag); else blockedTags.delete(tag);
    try { localStorage.setItem('ps_blocked_tags', JSON.stringify(Array.from(blockedTags))); } catch (e) {}
  }
  // Tags antigas deste mesmo perfil (após renomear): continuam chegando sinais
  // de quem ainda não soube da troca. Têm o mesmo sufixo de hash → só nós.
  let myPreviousTags = new Set();
  try { myPreviousTags = new Set(JSON.parse(localStorage.getItem('ps_previous_tags') || '[]')); } catch (e) {}
  function isMyTag(tag) {
    const t = normalizeTag(tag);
    return Boolean(t) && (t === normalizeTag(myTag) || myPreviousTags.has(t));
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
  // Aviso rápido na própria página (computador/extensão; no Android é o Toast nativo)
  let webToastTimer = 0;
  function showWebToast(msg) {
    console.log('Toast:', msg);
    if (!document.body || IS_BACKGROUND_PAGE) return;
    let el = document.getElementById('ps-web-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ps-web-toast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:90;max-width:min(92vw,420px);' +
        'padding:10px 14px;border-radius:12px;background:rgba(15,23,42,.96);border:1px solid #334155;color:#e2e8f0;' +
        'font-size:12px;line-height:1.35;box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:none;transition:opacity .2s;word-break:break-word';
      document.body.appendChild(el);
    }
    el.textContent = String(msg);
    el.style.opacity = '1';
    clearTimeout(webToastTimer);
    webToastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  const Native = {
    isAvailable: () => typeof window.PulseShareNative !== 'undefined',
    // accept: tipos MIME separados por vírgula ("image/*,video/*", "audio/*"); vazio = qualquer arquivo
    pickFiles: (accept) => {
      if (Native.isAvailable()) {
        if (accept && window.PulseShareNative.pickFilesOfType) window.PulseShareNative.pickFilesOfType(accept);
        else window.PulseShareNative.pickFiles();
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        if (accept) input.accept = accept;
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
      else if (IS_DESKTOP && path && path.startsWith('/')) Desk.openPath(path);
      else if (path && path.startsWith('blob:')) window.open(path, '_blank');
    },
    getDownloadDirectory: () => {
      if (Native.isAvailable() && window.PulseShareNative.getDownloadDirectory) {
        return window.PulseShareNative.getDownloadDirectory();
      }
      if (IS_DESKTOP) return Desk.getDownloadDirectory();
      return '/storage/emulated/0/Download/' + (customDownloadFolder || 'PulseShare');
    },
    setDownloadDirectory: (folder) => {
      if (Native.isAvailable() && window.PulseShareNative.setDownloadDirectory) {
        return window.PulseShareNative.setDownloadDirectory(folder);
      }
      if (IS_DESKTOP) return Desk.setDownloadDirectory(folder);
      return '/storage/emulated/0/Download/' + (folder || 'PulseShare');
    },
    openDownloadFolder: () => {
      if (Native.isAvailable() && window.PulseShareNative.openDownloadFolder) {
        window.PulseShareNative.openDownloadFolder();
      } else if (IS_DESKTOP) {
        Desk.openDownloadFolder();
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
      else if (IS_DESKTOP) Desk.openExternal(url);
      else window.open(url, '_blank', 'noopener');
    },
    copy: (text) => {
      if (Native.isAvailable()) window.PulseShareNative.copyToClipboard(text);
      else if (navigator.clipboard) navigator.clipboard.writeText(text);
    },
    toast: (msg) => {
      if (Native.isAvailable()) window.PulseShareNative.showToast(msg);
      else showWebToast(msg);
    },
    startKeepAlive: (status) => {
      if (Native.isAvailable()) window.PulseShareNative.startKeepAlive(status);
    },
    stopKeepAlive: () => {
      // Em segundo plano o serviço fica sempre ativo: só volta ao texto padrão
      if (Native.isAvailable()) {
        if (backgroundMode && window.PulseShareNative.startKeepAlive) window.PulseShareNative.startKeepAlive('Recebendo mensagens em segundo plano');
        else window.PulseShareNative.stopKeepAlive();
      }
    },
    // NOTIFICAÇÕES (barra do sistema) + som/vibração escolhidos nas Configurações
    notify: (title, body, peerTag, kind) => {
      if (IS_ANDROID && window.PulseShareNative.notifyMessage) {
        window.PulseShareNative.notifyMessage(title, body, peerTag || '', notifySound, notifyVibration);
        return;
      }
      if (IS_DESKTOP) {
        Desk.notify(title, body, peerTag || '');
      } else if (IS_EXTENSION && window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
        try { chrome.runtime.sendMessage({ type: 'PS_NOTIFY', title, body, peerTag: peerTag || '', kind: kind || 'chat' }); } catch (e) {}
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(title, { body, tag: peerTag || undefined, icon: 'icons/icon128.png' }); } catch (e) {}
      }
      playNotifySound(notifySound);
    },
    previewNotification: () => {
      if (IS_ANDROID && window.PulseShareNative.previewNotification) {
        window.PulseShareNative.previewNotification(notifySound, notifyVibration);
        return;
      }
      playNotifySound(notifySound);
    },
    setBackgroundMode: (on, fromUser) => {
      if (IS_ANDROID && window.PulseShareNative.setBackgroundMode) window.PulseShareNative.setBackgroundMode(Boolean(on));
      if (IS_DESKTOP) Desk.setBackgroundMode(Boolean(on), Boolean(fromUser));
      if (IS_EXTENSION && window.chrome && chrome.runtime) {
        try { chrome.runtime.sendMessage({ type: 'PS_SET_BACKGROUND', enabled: Boolean(on) }); } catch (e) {}
      }
    },
    requestBatteryExemption: () => {
      if (IS_ANDROID && window.PulseShareNative.requestBatteryExemption) window.PulseShareNative.requestBatteryExemption();
    },
    consumePendingOpenChat: () => {
      if (IS_ANDROID && window.PulseShareNative.consumePendingOpenChat) return window.PulseShareNative.consumePendingOpenChat() || '';
      if (IS_DESKTOP && desktopLaunch) { const t = desktopLaunch.chat || ''; desktopLaunch.chat = ''; return t; }
      return '';
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
  // Desktop: conversa/links pedidos na linha de comando (notificação, pulseshare://)
  let desktopLaunch = null;
  try { desktopLaunch = IS_DESKTOP ? Desk.consumeLaunch() : null; } catch (e) { desktopLaunch = null; }

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
    // Toque numa notificação com o app já aberto
    onOpenChat: (tag) => {
      tag = normalizeTag(tag);
      if (tag && activeProfile) { switchTab('chat'); openActiveChat(tag); }
    },
    onBackPressed: () => {
      // Gravação de voz / menu de anexos / localização / perfil do contato
      if (voiceRec) { stopVoiceRecording(false); return 'HANDLED'; }
      const attachMenu = document.getElementById('chat-attach-menu');
      if (attachMenu && !attachMenu.classList.contains('hidden')) { toggleAttachMenu(false); return 'HANDLED'; }
      const modalLoc = document.getElementById('modal-location');
      if (modalLoc && !modalLoc.classList.contains('hidden')) {
        if (window.PulseShareImageViewer && window.PulseShareImageViewer.isOpen()) { window.PulseShareImageViewer.close(); return 'HANDLED'; }
        closeLocationModal(); return 'HANDLED';
      }
      const modalPeer = document.getElementById('modal-peer-profile');
      if (modalPeer && !modalPeer.classList.contains('hidden') && !(window.PulseShareImageViewer && window.PulseShareImageViewer.isOpen())) {
        const cm = document.getElementById('modal-contact-menu');
        if (!cm || cm.classList.contains('hidden')) { closePeerProfile(); return 'HANDLED'; }
      }
      // Editor de foto / leitor de QR
      const modalPhoto = document.getElementById('modal-photo-editor');
      if (modalPhoto && !modalPhoto.classList.contains('hidden')) { closePhotoEditor(); return 'HANDLED'; }
      const modalScan = document.getElementById('modal-qr-pair-scanner');
      if (modalScan && !modalScan.classList.contains('hidden')) { closeQrScanner(); return 'HANDLED'; }
      // 0. Visualizador de imagem em tela cheia
      if (window.PulseShareImageViewer && window.PulseShareImageViewer.isOpen()) {
        window.PulseShareImageViewer.close();
        return 'HANDLED';
      }
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
      const onb = document.getElementById('view-onboarding');
      if (onb && !onb.classList.contains('hidden') && activeProfile) {
        onb.classList.add('hidden');
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
  // Retorna false quando não há conta neste dispositivo (→ tela de entrada)
  async function initCryptoIdentity() {
    if (typeof PulseShareCrypto === 'undefined') return false;

    const p = PulseShareCrypto.ProfilesManager.getActiveProfile();
    if (!p) return false;
    if (p.avatar && p.avatar.startsWith('data:image/svg+xml;utf8,')) {
      p.avatar = p.avatar.replace('data:image/svg+xml;utf8,', '');
      PulseShareCrypto.ProfilesManager.saveProfile(p);
    }

    activeProfile = p;
    myTag = p.tag;
    myRegHash = p.regHash || '0x' + p.pubKeyHex.slice(0, 12);
    localStorage.setItem('ps_my_tag', myTag);
    localStorage.setItem('ps_my_reghash', myRegHash);

    // Meu nome no catálogo da rede (e aviso se outra conta o registrou antes)
    noteTagClaim(myTag, mySince(), Date.now());
    checkMyNameConflict();

    // Inicia rádio Bluetooth BLE Mesh se disponível
    if (Native.isBleAvailable()) {
      Native.startBleMesh(myTag);
    }

    updateIdentityUI();
    return true;
  }

  // Foto (data URL validada) ou identicon SVG gerado localmente
  function profileAvatarHtml(p) {
    if (p && isSafeImageDataUrl(p.photo)) return `<img class="ps-avatar-img" src="${p.photo}" alt="" />`;
    return (p && p.avatar) || '';
  }

  function updateIdentityUI() {
    if (!activeProfile) return;
    const avatarHtml = profileAvatarHtml(activeProfile);

    const homeAvatar = document.getElementById('home-avatar-slot');
    if (homeAvatar) homeAvatar.innerHTML = avatarHtml;

    const homeTag = document.getElementById('home-tag-display');
    if (homeTag) homeTag.textContent = myTag;

    const homeReg = document.getElementById('home-reghash-display');
    if (homeReg) homeReg.textContent = myRegHash;

    // Perfil agora mora nas Configurações (saiu da barra superior)
    const setAvatar = document.getElementById('settings-avatar-slot');
    if (setAvatar) setAvatar.innerHTML = avatarHtml;
    const setName = document.getElementById('settings-profile-name');
    if (setName) setName.textContent = activeProfile.name || 'PulseShare';
    const setTag = document.getElementById('settings-profile-tag');
    if (setTag) setTag.textContent = myTag;

    renderUsernameSettings();
    renderAccountsList();
  }

  // --------------------------------------------------------------------------
  // 4b. ALTERAÇÃO DO NOME DE USUÁRIO (Configurações) COM VERIFICAÇÃO
  //  1) formato válido; 2) prova de posse da identidade (uma das 7 palavras);
  //  3) consulta na malha (PROBE_USER_EXISTS) para garantir que ninguém usa a tag;
  //  4) re-deriva a identidade com as MESMAS palavras → o sufixo _hash6 não muda;
  //  5) avisa a rede (USER_REGISTERED) e os contatos (USER_RENAMED) para migrarem.
  // --------------------------------------------------------------------------
  const pendingUserProbes = new Map(); // probeId -> callback(replyPacket)
  let pendingRename = null;            // { name, wordIndex }

  // --------------------------------------------------------------------------
  // 4c. CATÁLOGO DE NOMES DA REDE — o NOME é único, não só a tag.
  // A tag é @nome_hash6 e o hash6 vem das chaves: duas contas diferentes com o
  // mesmo nome teriam tags diferentes e a checagem pela tag inteira nunca
  // colidia. Regra: cada nome pertence a UMA conta (sufixo). Cada nó guarda um
  // catálogo nome → {s: sufixo, since, seen}, alimentado por PRESENCE_ANNOUNCE
  // (nameSince), USER_REGISTERED, respostas de PROBE_USER_EXISTS (que todos
  // ouvem) e NAME_REGISTRY_REQUEST/SYNC (troca do catálogo ao conectar).
  // Em conflito vence quem registrou o nome primeiro (menor since). Mesmas
  // chaves (mesmo sufixo) em outro aparelho = mesma conta → não é conflito.
  // --------------------------------------------------------------------------
  const NAME_REGISTRY_KEY = 'ps_name_registry_v1';
  const NAME_REGISTRY_MAX = 3000;
  const NAME_REGISTRY_TTL = 90 * 24 * 3600 * 1000; // sem sinal por 90 dias → o nome volta a ficar livre
  const NAME_SYNC_MAX_ENTRIES = 250;
  let nameRegistry = {};
  try { nameRegistry = JSON.parse(localStorage.getItem(NAME_REGISTRY_KEY) || '{}') || {}; } catch (e) { nameRegistry = {}; }
  let nameRegistrySaveTimer = null;
  let myNameConflict = null;            // { ownerTag } quando outra conta registrou o meu nome antes
  const answeredProbes = new Set();     // probeId já respondido por alguém (evita enxurrada)
  const answeredNameSyncs = new Set();  // reqId de sync já atendido
  let nameSyncRequested = false;

  function splitTag(tag) {
    const m = /^@([a-z0-9_]{1,40})_([0-9a-f]{6})$/.exec(normalizeTag(tag));
    if (!m || m[1] === 'link') return null; // visitantes de link (@link_xxxxxx) não têm nome
    return { name: m[1], suffix: m[2] };
  }

  function mySuffix() {
    return activeProfile && activeProfile.pubKeyHex ? activeProfile.pubKeyHex.slice(0, 6) : '';
  }

  function mySince() {
    return (activeProfile && (activeProfile.nameSince || activeProfile.createdAt)) || 0;
  }

  function cleanSince(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, Date.now());
  }

  function nameEntryAlive(e) {
    return Boolean(e && Date.now() - (e.seen || 0) < NAME_REGISTRY_TTL);
  }

  function scheduleNameRegistrySave() {
    if (nameRegistrySaveTimer) return;
    nameRegistrySaveTimer = setTimeout(flushNameRegistry, 1500);
  }

  function flushNameRegistry() {
    if (nameRegistrySaveTimer) clearTimeout(nameRegistrySaveTimer);
    nameRegistrySaveTimer = null;
    {
      let names = Object.keys(nameRegistry).filter((n) => nameEntryAlive(nameRegistry[n]));
      if (names.length > NAME_REGISTRY_MAX) {
        names = names.sort((a, b) => (nameRegistry[b].seen || 0) - (nameRegistry[a].seen || 0)).slice(0, NAME_REGISTRY_MAX);
      }
      const out = {};
      names.forEach((n) => { out[n] = nameRegistry[n]; });
      nameRegistry = out;
      try { localStorage.setItem(NAME_REGISTRY_KEY, JSON.stringify(nameRegistry)); } catch (e) {}
    }
  }
  window.addEventListener('pagehide', () => { if (nameRegistrySaveTimer) flushNameRegistry(); });

  // Registra "a conta <suffix> usa o nome <name> desde <since>". Retorna true se mudou.
  function noteNameClaim(name, suffix, since, seen) {
    if (!/^[a-z0-9_]{1,40}$/.test(name || '') || name === 'link' || !/^[0-9a-f]{6}$/.test(suffix || '')) return false;
    if (adminDeleted.has(suffix)) return false; // conta excluída pelo administrador
    since = cleanSince(since);
    seen = cleanSince(seen) || Date.now();
    const cur = nameRegistry[name];
    let changed = false;
    if (!nameEntryAlive(cur)) {
      nameRegistry[name] = { s: suffix, since: since || seen, seen };
      changed = true;
    } else if (cur.s === suffix) {
      if (since && since < (cur.since || Infinity)) { cur.since = since; changed = true; }
      if (seen > (cur.seen || 0) + 60000) { cur.seen = seen; changed = true; }
    } else if (since && since < (cur.since || Infinity)) {
      // Outra conta registrou este nome antes: ela é a dona
      nameRegistry[name] = { s: suffix, since, seen };
      changed = true;
    }
    if (changed) {
      scheduleNameRegistrySave();
      if (activeProfile && name === (splitTag(myTag) || {}).name) checkMyNameConflict();
      if (myTag) scheduleBareTagMigration();
    }
    return changed;
  }

  function noteTagClaim(tag, since, seen) {
    const p = splitTag(tag);
    return p ? noteNameClaim(p.name, p.suffix, since, seen) : false;
  }

  function releaseNameClaim(name, suffix) {
    const cur = nameRegistry[name];
    if (cur && cur.s === suffix) {
      delete nameRegistry[name];
      scheduleNameRegistrySave();
    }
  }

  function registryOwnerOf(name) {
    const e = nameRegistry[name];
    return nameEntryAlive(e) ? e : null;
  }

  // Nome mais recente conhecido para as chaves <suffix> (login sem digitar o nome)
  function registryNameOfSuffix(suffix) {
    let best = null;
    Object.keys(nameRegistry).forEach((n) => {
      const e = nameRegistry[n];
      if (e.s === suffix && nameEntryAlive(e) && (!best || (e.seen || 0) > best.seen)) best = { name: n, since: e.since, seen: e.seen || 0 };
    });
    return best;
  }

  // Meu nome foi registrado antes por outra conta? (aviso nas Configurações)
  function checkMyNameConflict() {
    const me = splitTag(myTag);
    if (!me || !activeProfile) return;
    const e = registryOwnerOf(me.name);
    // Mesma conta em outro aparelho com registro mais antigo: adota a data
    if (e && e.s === me.suffix && e.since && e.since < mySince()) {
      activeProfile.nameSince = e.since;
      try { PulseShareCrypto.ProfilesManager.saveProfile(activeProfile); } catch (err) {}
    }
    const ownerTag = e && e.s !== me.suffix ? `@${me.name}_${e.s}` : '';
    if (ownerTag === ((myNameConflict && myNameConflict.ownerTag) || '')) return;
    myNameConflict = ownerTag ? { ownerTag } : null;
    renderUsernameSettings();
    if (ownerTag) Native.toast(`O nome "${me.name}" já pertence a ${ownerTag}. Altere o seu nome nas Configurações.`);
  }

  function exportNameRegistry(max) {
    return Object.keys(nameRegistry)
      .filter((n) => nameEntryAlive(nameRegistry[n]))
      .sort((a, b) => (nameRegistry[b].seen || 0) - (nameRegistry[a].seen || 0))
      .slice(0, max)
      .map((n) => [n, nameRegistry[n].s, nameRegistry[n].since || 0, nameRegistry[n].seen || 0]);
  }

  function mergeNameRegistryEntries(entries) {
    if (!Array.isArray(entries)) return;
    entries.slice(0, 400).forEach((e) => {
      if (Array.isArray(e)) noteNameClaim(String(e[0] || ''), String(e[1] || ''), e[2], e[3]);
    });
  }

  // Pede o catálogo aos nós online (uma vez por sessão, ao conectar)
  function requestNameRegistrySync() {
    if (nameSyncRequested || !brokersOnline()) return;
    nameSyncRequested = true;
    broadcastToMesh({ meshType: 'NAME_REGISTRY_REQUEST', reqId: 'nsync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), requesterNodeId: nodeId, have: Object.keys(nameRegistry).length });
  }

  // Responde a uma consulta de nome (dono responde na hora; quem só tem o
  // catálogo espera um pouco e fica quieto se alguém já respondeu)
  function answerNameProbe(packet) {
    let name = cleanUsername(packet.name || '');
    let suffix = /^[0-9a-f]{6}$/.test(packet.suffix || '') ? packet.suffix : '';
    if (!name && !suffix) {
      const p = splitTag(packet.tag);
      if (p) { name = p.name; suffix = p.suffix; }
    }
    if (!name && !suffix) return;
    const reply = (ownerTag, since, authoritative) => {
      answeredProbes.add(packet.probeId);
      broadcastToMesh({
        meshType: 'PROBE_USER_EXISTS_REPLY',
        probeId: packet.probeId,
        requesterNodeId: packet.requesterNodeId,
        tag: ownerTag,
        ownerTag,
        exists: true,
        since: since || 0,
        authoritative,
        ownerNodeId: authoritative ? nodeId : undefined
      });
    };
    const me = splitTag(myTag);
    if (me && ((name && me.name === name) || (suffix && me.suffix === suffix))) {
      reply(myTag, mySince(), true);
      return;
    }
    let ownerTag = '';
    let since = 0;
    const byName = name ? registryOwnerOf(name) : null;
    if (byName) { ownerTag = `@${name}_${byName.s}`; since = byName.since; }
    else if (suffix) {
      const k = registryNameOfSuffix(suffix);
      if (k) { ownerTag = `@${k.name}_${suffix}`; since = k.since; }
    }
    if (!ownerTag) return;
    setTimeout(() => {
      if (!answeredProbes.has(packet.probeId)) reply(ownerTag, since, false);
    }, 250 + Math.random() * 1200);
  }

  // Consulta a rede (e o catálogo local) sobre <name> para as chaves <suffix>.
  // → { taken, ownerTag, knownName, knownSince, replies }
  //   taken: o nome pertence a OUTRA conta; knownName: nome que a rede conhece
  //   para estas chaves (outro aparelho da mesma conta).
  function probeName(name, suffix, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const probeId = 'probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const result = { taken: false, ownerTag: '', knownName: '', knownSince: 0, replies: 0 };
      const consider = (ownerTag, since) => {
        const o = splitTag(ownerTag);
        if (!o) return;
        if (suffix && o.suffix === suffix) {
          if (!result.knownName || (name && o.name === name)) {
            result.knownName = o.name;
            result.knownSince = cleanSince(since) || result.knownSince;
          }
        } else if (name && o.name === name) {
          result.taken = true;
          result.ownerTag = ownerTag;
        }
      };
      if (name) {
        const local = registryOwnerOf(name);
        if (local) consider(`@${name}_${local.s}`, local.since);
      }
      if (suffix && !result.knownName) {
        const k = registryNameOfSuffix(suffix);
        if (k) consider(`@${k.name}_${suffix}`, k.since);
      }
      const finish = () => {
        clearTimeout(timer);
        pendingUserProbes.delete(probeId);
        resolve(result);
      };
      const timer = setTimeout(finish, timeoutMs);
      pendingUserProbes.set(probeId, (pkt) => {
        result.replies++;
        consider(normalizeTag(pkt.ownerTag || pkt.tag), pkt.since);
        if (result.taken && pkt.authoritative) finish();
      });
      broadcastToMesh({
        meshType: 'PROBE_USER_EXISTS',
        probeId,
        tag: name && suffix ? `@${name}_${suffix}` : '',
        name: name || '',
        suffix: suffix || '',
        requesterNodeId: nodeId
      });
    });
  }

  // Conecta aos brokers (também na tela de entrada) e espera ficar online
  async function ensureNetworkForProbe(timeoutMs = 8000) {
    connectBrokers();
    const t0 = Date.now();
    while (!brokersOnline() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 250));
    if (!brokersOnline()) return freshBleNeighbors().length > 0;
    await new Promise((r) => setTimeout(r, 600)); // SUBSCRIBE confirmado antes de perguntar
    requestAdminState(); // contas excluídas pelo administrador (bloqueia o login delas)
    return true;
  }

  // ==========================================================================
  // 4e. ADMINISTRAÇÃO (painel PulseSharePanel)
  // --------------------------------------------------------------------------
  // O painel assina "registros" com a chave ECDSA P-256 do administrador; aqui
  // só fica a chave PÚBLICA (ADMIN_PUBLIC_KEYS). Registro = {b: corpo em JSON
  // (texto exato que foi assinado), s: assinatura base64url r||s (64 bytes)}.
  // corpo = {v:1, kind, id:'adm_…', ts, ...}:
  //   broadcast    {text}         → mensagem na conversa oficial "PulseShare" (@pulseshare)
  //   delete_user  {tag, suffix}  → conta excluída: some das conversas, contatos e
  //                                  do catálogo de nomes, é ignorada; no aparelho
  //                                  dela a conta é removida
  //   restore_user {tag, suffix}  → desfaz a exclusão (vale o registro mais recente)
  //   sync_request {reqId}        → o painel pede o relatório: cada nó responde
  //                                  ADMIN_SYNC_REPLY e até 2 nós mandam o catálogo
  //                                  de nomes (ADMIN_REGISTRY_DUMP)
  // Sem servidor: todo nó guarda os registros (ps_admin_records_v1, do aparelho)
  // e os repassa a quem conecta: ADMIN_STATE_REQUEST {reqId, have:[ids]} →
  // ADMIN_RECORDS {reqId, records} (quem ia responder desconta o que outro já mandou).
  // Mensagens com senderTag @pulseshare que não sejam registros assinados são descartadas.
  // ==========================================================================
  const ADMIN_PUBLIC_KEYS = [
    { x: '8GFJKFuR4sGEIX4FBsMRa8J0yXU2XqGU32seSLx2Fr0', y: '7wXYjRMKZdt5DiGjqAjUGUDO17IAJWwI2uUa_TLKfeU' }
  ];
  const OFFICIAL_TAG = '@pulseshare';
  const ADMIN_RECORDS_KEY = 'ps_admin_records_v1';
  const ADMIN_BROADCAST_KEEP = 60;
  const ADMIN_BROADCAST_MAX_AGE = 180 * 24 * 3600 * 1000;
  const ADMIN_PACKETS = new Set(['ADMIN_RECORDS', 'ADMIN_STATE_REQUEST', 'ADMIN_SYNC_REPLY', 'ADMIN_REGISTRY_DUMP']);
  let adminRecords = []; // [{b, s, body}] já verificados
  try {
    adminRecords = (JSON.parse(localStorage.getItem(ADMIN_RECORDS_KEY) || '[]') || [])
      .map((r) => { try { return { b: r.b, s: r.s, body: JSON.parse(r.b) }; } catch (e) { return null; } })
      .filter((r) => r && r.body && r.body.id);
  } catch (e) { adminRecords = []; }
  let adminDeleted = new Map();            // sufixo → {tag, ts}
  const adminStateCovered = new Map();     // reqId → Set(ids que alguém já mandou)
  const adminSyncAnswered = new Set();     // reqId de sync_request já respondido
  const adminDumpCount = new Map();        // reqId → quantos nós já mandaram o catálogo
  let adminStateRequested = false;
  let adminStateRequestedAt = 0;
  let adminKeysPromise = null;
  rebuildAdminIndex();

  function b64urlToBytes(s) {
    try {
      const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '') +
        '==='.slice((String(s).length + 3) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch (e) { return null; }
  }

  function adminKeys() {
    if (!adminKeysPromise) {
      adminKeysPromise = Promise.all(ADMIN_PUBLIC_KEYS.map((k) =>
        crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true },
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null)
      )).then((list) => list.filter(Boolean));
    }
    return adminKeysPromise;
  }

  function adminRecordId(rec) {
    try { const b = JSON.parse(rec.b); return b && typeof b.id === 'string' ? b.id : ''; } catch (e) { return ''; }
  }

  // Devolve o corpo se a assinatura for do administrador (senão null)
  async function verifyAdminRecord(rec) {
    if (!rec || typeof rec.b !== 'string' || typeof rec.s !== 'string' || rec.b.length > 8000) return null;
    let body;
    try { body = JSON.parse(rec.b); } catch (e) { return null; }
    if (!body || body.v !== 1 || typeof body.id !== 'string' || !/^adm_[a-z0-9_]{6,48}$/.test(body.id) ||
      !Number.isFinite(body.ts) || typeof body.kind !== 'string') return null;
    const sig = b64urlToBytes(rec.s);
    if (!sig || sig.length !== 64) return null;
    const data = new TextEncoder().encode(rec.b);
    for (const key of await adminKeys()) {
      try {
        if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data)) return body;
      } catch (e) {}
    }
    return null;
  }

  function cleanSuffix(s) {
    return /^[0-9a-f]{6}$/.test(String(s || '')) ? String(s) : '';
  }

  function rebuildAdminIndex() {
    const latest = new Map(); // sufixo → corpo do registro mais recente
    adminRecords.forEach((r) => {
      const b = r.body;
      if (b.kind !== 'delete_user' && b.kind !== 'restore_user') return;
      const sfx = cleanSuffix(b.suffix) || hashSuffix(b.tag);
      if (!sfx) return;
      const cur = latest.get(sfx);
      if (!cur || b.ts > cur.ts) latest.set(sfx, b);
    });
    adminDeleted = new Map();
    latest.forEach((b, sfx) => { if (b.kind === 'delete_user') adminDeleted.set(sfx, { tag: normalizeTag(b.tag), ts: b.ts }); });
  }

  // Mantém só o necessário: últimas mensagens oficiais e o registro mais recente por conta
  function pruneAdminRecords() {
    const now = Date.now();
    const bcasts = adminRecords.filter((r) => r.body.kind === 'broadcast' && now - r.body.ts < ADMIN_BROADCAST_MAX_AGE)
      .sort((a, b) => b.body.ts - a.body.ts).slice(0, ADMIN_BROADCAST_KEEP);
    const bySuffix = new Map();
    adminRecords.forEach((r) => {
      if (r.body.kind !== 'delete_user' && r.body.kind !== 'restore_user') return;
      const sfx = cleanSuffix(r.body.suffix) || hashSuffix(r.body.tag);
      const cur = bySuffix.get(sfx);
      if (sfx && (!cur || r.body.ts > cur.body.ts)) bySuffix.set(sfx, r);
    });
    adminRecords = bcasts.concat(Array.from(bySuffix.values()));
  }

  function saveAdminRecords() {
    try { localStorage.setItem(ADMIN_RECORDS_KEY, JSON.stringify(adminRecords.map((r) => ({ b: r.b, s: r.s })))); } catch (e) {}
  }

  // Conta excluída pelo administrador? (pelo sufixo das chaves: vale também após trocar o nome)
  function isAdminDeleted(tag) {
    const t = normalizeTag(tag);
    if (!t || t === OFFICIAL_TAG) return false;
    const sfx = hashSuffix(t);
    if (sfx && adminDeleted.has(sfx)) return true;
    for (const v of adminDeleted.values()) if (v.tag === t) return true;
    return false;
  }

  function isOfficialTag(tag) {
    return normalizeTag(tag) === OFFICIAL_TAG;
  }

  // Recebe registros (da rede ou do armazenamento); aplica os novos
  async function acceptAdminRecords(list) {
    if (!Array.isArray(list)) return;
    const known = new Set(adminRecords.map((r) => r.body.id));
    const fresh = [];
    for (const rec of list.slice(0, 80)) {
      const id = adminRecordId(rec);
      if (!id || known.has(id)) continue;
      const body = await verifyAdminRecord(rec);
      if (!body) continue;
      known.add(id);
      if (body.kind === 'sync_request') { answerAdminSync(body); continue; }
      if (!['broadcast', 'delete_user', 'restore_user'].includes(body.kind)) continue;
      if (body.kind === 'broadcast' && (typeof body.text !== 'string' || !body.text.trim())) continue;
      fresh.push({ b: rec.b, s: rec.s, body });
    }
    if (!fresh.length) return;
    adminRecords = adminRecords.concat(fresh);
    pruneAdminRecords();
    saveAdminRecords();
    rebuildAdminIndex();
    applyAdminState({ notify: true, freshIds: new Set(fresh.map((r) => r.body.id)) });
  }

  // Aplica exclusões e entrega as mensagens oficiais à conta ativa (idempotente)
  function applyAdminState(opts = {}) {
    // Minha conta foi excluída?
    const mine = mySuffix();
    if (mine && adminDeleted.has(mine)) { removeAccountDeletedByAdmin(); return; }
    // Outras contas guardadas neste aparelho com chaves excluídas
    if (typeof PulseShareCrypto !== 'undefined') {
      PulseShareCrypto.ProfilesManager.getAllProfiles().forEach((p) => {
        if (!p.pubKeyHex || !adminDeleted.has(p.pubKeyHex.slice(0, 6)) || (activeProfile && p.id === activeProfile.id)) return;
        const acct = accountStoreId(p);
        ACCOUNT_SCOPED_KEYS.forEach((k) => localStorage.removeItem(accountStoreKey(acct, k)));
        PulseShareCrypto.ProfilesManager.deleteProfile(p.id);
      });
    }
    // Catálogo de nomes: o nome da conta excluída fica livre
    let regChanged = false;
    Object.keys(nameRegistry).forEach((n) => {
      if (adminDeleted.has(nameRegistry[n].s)) { delete nameRegistry[n]; regChanged = true; }
    });
    if (regChanged) scheduleNameRegistrySave();
    if (!myTag) return;
    // Conversas, contatos e presença de contas excluídas
    let chatsChanged = false;
    const contacts = getContacts();
    new Set([...Object.keys(chatMessages), ...Object.keys(contacts), ...Object.keys(peerRegistry)]).forEach((t) => {
      if (!isAdminDeleted(t)) return;
      if (chatMessages[t]) {
        chatMessages[t].forEach((m) => { try { deleteChatMedia(m.transferId || (m.media && m.media.transferId)); } catch (e) {} });
        delete chatMessages[t];
        chatsChanged = true;
      }
      if (contacts[t] && typeof PulseShareCrypto !== 'undefined') PulseShareCrypto.ProfilesManager.removeContact(t);
      delete peerRegistry[t];
      if (activeChatPeer === t) closeActiveChat();
    });
    // Mensagens oficiais (PulseShare)
    const list = chatMessages[OFFICIAL_TAG] || [];
    const have = new Set(list.map((m) => m.id));
    const added = [];
    adminRecords.filter((r) => r.body.kind === 'broadcast' && !have.has(r.body.id)).forEach((r) => {
      const m = { id: r.body.id, sender: OFFICIAL_TAG, text: String(r.body.text).slice(0, 4000), timestamp: r.body.ts, status: 'RECEIVED', official: true };
      list.push(m);
      added.push(m);
    });
    if (added.length) {
      list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      chatMessages[OFFICIAL_TAG] = list;
      chatsChanged = true;
      const toNotify = added.filter((m) => opts.notify && (!opts.freshIds || opts.freshIds.has(m.id)) && Date.now() - m.timestamp < 7 * 24 * 3600 * 1000);
      if (toNotify.length) {
        const last = toNotify[toNotify.length - 1];
        notifyIncoming(OFFICIAL_TAG, last.text, 'chat');
        if (activeChatPeer !== OFFICIAL_TAG) {
          const badge = document.getElementById('badge-chat-unread');
          if (badge) {
            badge.textContent = parseInt(badge.textContent || '0', 10) + toNotify.length;
            badge.classList.remove('hidden');
          }
        }
      }
    }
    if (chatsChanged) {
      saveChatMessagesToStorage();
      if (activeChatPeer === OFFICIAL_TAG) renderChatMessages(OFFICIAL_TAG);
    }
    renderConversationsList();
    renderMeshPeers();
  }

  // A conta ativa foi excluída pelo administrador: remove-a deste aparelho
  function removeAccountDeletedByAdmin() {
    if (!activeProfile || typeof PulseShareCrypto === 'undefined') return;
    const tag = myTag;
    const sfx = mySuffix();
    try {
      ACCOUNT_SCOPED_KEYS.forEach((k) => localStorage.removeItem(k));
      PulseShareCrypto.ProfilesManager.getAllProfiles()
        .filter((p) => p.pubKeyHex && p.pubKeyHex.slice(0, 6) === sfx)
        .forEach((p) => {
          ACCOUNT_SCOPED_KEYS.forEach((k) => localStorage.removeItem(accountStoreKey(accountStoreId(p), k)));
          PulseShareCrypto.ProfilesManager.deleteProfile(p.id);
        });
      localStorage.removeItem(LIVE_ACCOUNT_KEY);
      localStorage.setItem('ps_admin_removed_notice', tag);
    } catch (e) {
      console.warn('[PulseShare] falha ao remover a conta excluída:', e);
    }
    activeProfile = null;
    myTag = '';
    chatMessages = {};
    if (Native.isBleAvailable()) Native.stopBleMesh();
    setTimeout(() => location.reload(), 300);
  }

  // Aviso (na tela de entrada) de que a conta foi excluída
  function showAdminRemovedNotice() {
    const tag = localStorage.getItem('ps_admin_removed_notice');
    if (!tag || IS_BACKGROUND_PAGE) return;
    localStorage.removeItem('ps_admin_removed_notice');
    const msg = `A conta ${normalizeTag(tag)} foi excluída pelo administrador do PulseShare e removida deste aparelho.`;
    onbStatus(msg);
    Native.toast(msg);
  }

  // Pede aos nós online os registros que este aparelho não tem (1x por sessão;
  // force: de novo, no máximo a cada 15 s — ex.: login de conta que estava excluída)
  function requestAdminState(force) {
    if (!brokersOnline()) return false;
    if (adminStateRequested && !(force && Date.now() - adminStateRequestedAt > 15000)) return false;
    adminStateRequested = true;
    adminStateRequestedAt = Date.now();
    broadcastToMesh({
      meshType: 'ADMIN_STATE_REQUEST',
      reqId: 'astate_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      have: adminRecords.map((r) => r.body.id).slice(0, 400)
    });
    return true;
  }

  function handleAdminStateRequest(packet) {
    const rid = String(packet.reqId || '');
    if (!rid || !adminRecords.length) return;
    const have = new Set(Array.isArray(packet.have) ? packet.have.map(String) : []);
    if (adminRecords.every((r) => have.has(r.body.id))) return;
    if (!adminStateCovered.has(rid)) adminStateCovered.set(rid, new Set());
    setTimeout(() => {
      const covered = adminStateCovered.get(rid) || new Set();
      const missing = adminRecords.filter((r) => !have.has(r.body.id) && !covered.has(r.body.id));
      if (!missing.length) return;
      for (let i = 0; i < missing.length; i += 25) {
        broadcastToMesh({ meshType: 'ADMIN_RECORDS', reqId: rid, records: missing.slice(i, i + 25).map((r) => ({ b: r.b, s: r.s })) });
      }
      missing.forEach((r) => covered.add(r.body.id));
    }, 400 + Math.random() * 2600);
    if (adminStateCovered.size > 100) adminStateCovered.delete(adminStateCovered.keys().next().value);
  }

  // O painel pediu o relatório: respondo com a minha conta e (até 2 nós) o catálogo de nomes
  function answerAdminSync(body) {
    const rid = String(body.reqId || '');
    if (!rid || !myTag || adminSyncAnswered.has(rid) || Math.abs(Date.now() - body.ts) > 10 * 60 * 1000) return;
    adminSyncAnswered.add(rid);
    setTimeout(() => {
      broadcastToMesh({
        meshType: 'ADMIN_SYNC_REPLY',
        reqId: rid,
        tag: myTag,
        since: mySince(),
        createdAt: (activeProfile && activeProfile.createdAt) || 0,
        nodeId,
        clientType: IS_ANDROID ? 'android' : IS_DESKTOP ? 'desktop' : IS_EXTENSION ? 'extension-app' : 'web',
        contacts: Object.keys(getContacts()).length
      });
    }, 150 + Math.random() * 2500);
    setTimeout(() => {
      if ((adminDumpCount.get(rid) || 0) >= 2) return;
      const entries = exportNameRegistry(NAME_REGISTRY_MAX);
      if (!entries.length) return;
      const parts = Math.ceil(entries.length / NAME_SYNC_MAX_ENTRIES);
      for (let i = 0; i < parts; i++) {
        broadcastToMesh({ meshType: 'ADMIN_REGISTRY_DUMP', reqId: rid, part: i, parts, entries: entries.slice(i * NAME_SYNC_MAX_ENTRIES, (i + 1) * NAME_SYNC_MAX_ENTRIES) });
      }
      adminDumpCount.set(rid, (adminDumpCount.get(rid) || 0) + 1);
    }, 1500 + Math.random() * 5000);
  }

  // Pacotes da administração (tratados antes de qualquer filtro de remetente)
  function handleAdminPacket(packet) {
    switch (packet.meshType) {
      case 'ADMIN_RECORDS': {
        if (packet.reqId && Array.isArray(packet.records)) {
          const set = adminStateCovered.get(packet.reqId) || new Set();
          packet.records.forEach((r) => { const id = adminRecordId(r); if (id) set.add(id); });
          adminStateCovered.set(packet.reqId, set);
        }
        acceptAdminRecords(packet.records);
        break;
      }
      case 'ADMIN_STATE_REQUEST':
        if (myTag) handleAdminStateRequest(packet);
        break;
      case 'ADMIN_REGISTRY_DUMP':
        if (packet.reqId && packet.part === 0) adminDumpCount.set(packet.reqId, (adminDumpCount.get(packet.reqId) || 0) + 1);
        if (adminDumpCount.size > 50) adminDumpCount.delete(adminDumpCount.keys().next().value);
        mergeNameRegistryEntries(packet.entries);
        break;
    }
  }

  // Avatar da conversa oficial (ícone do PulseShare)
  function officialAvatarHtml() {
    return '<svg viewBox="0 0 128 128" class="w-full h-full" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="psOffG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#F97316"/></linearGradient></defs><rect width="128" height="128" fill="url(#psOffG)"/><path d="M72.38,15.00L78.04,15.00L66.14,52.00L95.10,52.00L53.73,110.30L61.09,68.50L34.50,68.50Z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
  }

  function nameRuleError(name) {
    if (!/^[a-z0-9_]{2,24}$/.test(name) || /^link_/.test(name) || name === 'link') {
      return 'Use de 2 a 24 letras minúsculas, números ou "_" (não pode começar com "link_").';
    }
    // "pulseshare" é o nome do canal oficial (mensagens do administrador)
    if (/^pulse_?share/.test(name)) return 'Nomes começando com "pulseshare" são reservados.';
    return '';
  }

  function cleanUsername(raw) {
    return String(raw || '').trim().replace(/^@/, '').toLowerCase().replace(/\s+/g, '_');
  }

  function setUsernameStatus(text, tone) {
    const el = document.getElementById('setting-username-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.className = 'text-[10px] ' + (tone === 'error' ? 'text-rose-400' : tone === 'ok' ? 'text-emerald-400' : 'text-slate-400') + (text ? '' : ' hidden');
  }

  function renderUsernameSettings() {
    const cur = document.getElementById('setting-current-tag');
    if (cur) cur.textContent = myTag || '@...';
    const suffix = document.getElementById('setting-username-suffix');
    const sfx = activeProfile && activeProfile.pubKeyHex ? activeProfile.pubKeyHex.slice(0, 6) : hashSuffix(myTag);
    if (suffix) suffix.textContent = '_' + (sfx || '000000');
    const input = document.getElementById('setting-username-input');
    if (input && document.activeElement !== input) input.value = activeProfile ? (activeProfile.name || '').toLowerCase() : '';
    if (!pendingRename) {
      const box = document.getElementById('setting-username-verify');
      if (box) box.classList.add('hidden');
    }
    const warn = document.getElementById('setting-username-conflict');
    if (warn) {
      warn.textContent = myNameConflict
        ? `⚠️ Este nome já foi registrado antes por outra conta (${myNameConflict.ownerTag}). Escolha outro nome para não ser confundido.`
        : '';
      warn.classList.toggle('hidden', !myNameConflict);
    }
  }

  function startUsernameChange() {
    if (!activeProfile || typeof PulseShareCrypto === 'undefined') return;
    const input = document.getElementById('setting-username-input');
    const name = cleanUsername(input ? input.value : '');
    const ruleErr = nameRuleError(name);
    if (ruleErr) {
      setUsernameStatus(ruleErr, 'error');
      return;
    }
    const newTag = `@${name}_${activeProfile.pubKeyHex.slice(0, 6)}`;
    if (newTag === normalizeTag(myTag)) {
      setUsernameStatus('Esse já é o seu nome atual.', 'info');
      return;
    }
    // Checagem rápida no catálogo local antes de pedir a palavra
    const known = registryOwnerOf(name);
    if (known && known.s !== mySuffix()) {
      setUsernameStatus(`O nome "${name}" já está em uso por @${name}_${known.s}.`, 'error');
      return;
    }
    const words = (activeProfile.seedWords || '').split(/\s+/).filter(Boolean);
    if (words.length < 7) {
      setUsernameStatus('Perfil sem palavras de recuperação: não é possível verificar a identidade.', 'error');
      return;
    }
    const wordIndex = Math.floor(Math.random() * words.length);
    pendingRename = { name, newTag, wordIndex };
    const label = document.getElementById('setting-username-verify-label');
    if (label) label.textContent = `Alterar para ${newTag}. Para confirmar que é você, digite a palavra nº ${wordIndex + 1} das suas 7 palavras de recuperação:`;
    const box = document.getElementById('setting-username-verify');
    if (box) box.classList.remove('hidden');
    const vInput = document.getElementById('setting-username-verify-input');
    if (vInput) { vInput.value = ''; setTimeout(() => vInput.focus(), 50); }
    setUsernameStatus('', '');
  }

  function cancelUsernameChange() {
    pendingRename = null;
    const box = document.getElementById('setting-username-verify');
    if (box) box.classList.add('hidden');
    setUsernameStatus('', '');
    renderUsernameSettings();
  }

  async function confirmUsernameChange() {
    if (!pendingRename || !activeProfile) return;
    const vInput = document.getElementById('setting-username-verify-input');
    const plain = (w) => String(w || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const typed = plain(vInput ? vInput.value : '');
    const words = (activeProfile.seedWords || '').split(/\s+/);
    if (!typed || typed !== plain(words[pendingRename.wordIndex])) {
      setUsernameStatus('Palavra incorreta. A verificação falhou.', 'error');
      if (vInput) vInput.select();
      return;
    }
    const btn = document.getElementById('btn-username-verify-confirm');
    if (btn) btn.disabled = true;
    const { name, newTag } = pendingRename;
    try {
      // Consulta na rede: alguma OUTRA conta já usa esse nome (com qualquer sufixo)?
      setUsernameStatus('Verificando disponibilidade na rede...', 'info');
      if (!(await ensureNetworkForProbe())) {
        setUsernameStatus('Sem conexão com a rede: não dá para verificar se o nome está livre. Tente de novo quando estiver online.', 'error');
        return;
      }
      const res = await probeName(name, mySuffix());
      const peerTaken = Object.values(peerRegistry).some((p) => {
        const o = splitTag(p.tag);
        return o && o.name === name && o.suffix !== mySuffix();
      });
      if (res.taken || peerTaken) {
        setUsernameStatus(`O nome "${name}" já está em uso${res.ownerTag ? ' por ' + res.ownerTag : ''}. Escolha outro.`, 'error');
        return;
      }
      await applyUsernameChange(name);
      pendingRename = null;
      const box = document.getElementById('setting-username-verify');
      if (box) box.classList.add('hidden');
      setUsernameStatus(`✓ Nome alterado para ${myTag}. Seus contatos foram avisados.`, 'ok');
      Native.toast(`Nome alterado para ${myTag}`);
    } catch (e) {
      setUsernameStatus('Falha ao alterar o nome: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function applyUsernameChange(name) {
    const oldTag = normalizeTag(myTag);
    const derived = await PulseShareCrypto.deriveIdentity(name, activeProfile.seedWords);
    if (derived.pubKeyHex !== activeProfile.pubKeyHex) throw new Error('chaves divergentes');
    const updated = { ...activeProfile, name: derived.name, tag: derived.tag, nameSince: Date.now() };
    PulseShareCrypto.ProfilesManager.saveProfile(updated);
    activeProfile = updated;
    myTag = updated.tag;
    localStorage.setItem('ps_my_tag', myTag);
    if (oldTag && oldTag !== myTag) {
      myPreviousTags.add(oldTag);
      myPreviousTags.delete(normalizeTag(myTag));
      try { localStorage.setItem('ps_previous_tags', JSON.stringify(Array.from(myPreviousTags).slice(-10))); } catch (e) {}
    }

    // Minhas mensagens passam a usar a tag nova (ticks / lado da bolha)
    Object.values(chatMessages).forEach((list) => list.forEach((m) => {
      if (normalizeTag(m.sender) === oldTag) m.sender = myTag;
    }));
    saveChatMessagesToStorage();

    // Rádio Bluetooth anuncia a tag nova
    if (Native.isBleAvailable()) {
      Native.stopBleMesh();
      setTimeout(() => Native.startBleMesh(myTag), 400);
    }

    // Avisa toda a malha e, ponto a ponto, quem conversa com a gente
    // Catálogo de nomes: libera o nome antigo e registra o novo
    const oldParts = splitTag(oldTag);
    if (oldParts && oldParts.suffix === mySuffix()) releaseNameClaim(oldParts.name, oldParts.suffix);
    noteTagClaim(myTag, updated.nameSince, Date.now());
    myNameConflict = null;

    const notice = { tag: myTag, previousTag: oldTag, nodeId, pubKeyHex: activeProfile.pubKeyHex };
    broadcastToMesh({ meshType: 'USER_REGISTERED', ...notice, since: updated.nameSince, registeredAt: Date.now(), regHash: myRegHash });
    const notify = new Set([...Object.keys(getContacts()), ...Object.keys(chatMessages)]);
    notify.forEach((t) => {
      if (t && !isLinkVisitor(t) && !isMyTag(t)) sendSignal(t, 'rename-' + Date.now(), 'USER_RENAMED', notice);
    });
    announcePresence();
    updateIdentityUI();
    renderConversationsList();
  }

  // --------------------------------------------------------------------------
  // 4d. CONTAS NESTE APARELHO (ver 1b: cada conta tem os seus dados guardados)
  // --------------------------------------------------------------------------
  function renderAccountsList() {
    const box = document.getElementById('settings-accounts-list');
    if (!box || typeof PulseShareCrypto === 'undefined') return;
    const all = PulseShareCrypto.ProfilesManager.getAllProfiles();
    box.innerHTML = all.map((p) => {
      const cur = Boolean(activeProfile && p.id === activeProfile.id);
      return `
        <div class="p-2 rounded-lg ${cur ? 'bg-indigo-900/30 border border-indigo-500/50' : 'bg-slate-900 border border-slate-800'} flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-7 h-7 rounded-lg overflow-hidden shrink-0">${profileAvatarHtml(p)}</div>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">${escapeHtml(p.name || '')}</span>
              <span class="text-[10px] font-mono text-slate-400 block truncate">${escapeHtml(p.tag || '')}</span>
            </div>
          </div>
          ${cur
            ? '<span class="text-[10px] text-emerald-400 font-bold shrink-0">● Ativa</span>'
            : `<button type="button" data-switch-account="${escapeHtml(p.id)}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] text-indigo-300 font-bold border border-slate-700 active:scale-95 shrink-0">Usar</button>`}
        </div>`;
    }).join('');
    box.querySelectorAll('[data-switch-account]').forEach((b) => {
      b.onclick = () => switchAccount(b.getAttribute('data-switch-account'));
    });
  }

  // Troca de conta: marca a outra como ativa e recarrega (syncAccountStorage
  // guarda os dados desta conta e carrega os da outra antes de tudo)
  function switchAccount(profileId) {
    if (!profileId || (activeProfile && profileId === activeProfile.id)) return;
    saveChatMessagesToStorage();
    PulseShareCrypto.ProfilesManager.switchProfile(profileId);
    if (Native.isBleAvailable()) Native.stopBleMesh();
    location.reload();
  }

  function openAddAccount() {
    document.getElementById('modal-settings').classList.add('hidden');
    ['onb-access-key', 'onb-access-name', 'onb-words', 'onb-words-name', 'onb-new-name'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    onbStatus('');
    document.getElementById('btn-onb-back').classList.toggle('hidden', !activeProfile);
    showOnboarding();
  }

  function closeAddAccount() {
    if (!activeProfile) return;
    document.getElementById('view-onboarding').classList.add('hidden');
  }

  function logoutAccount() {
    if (!activeProfile || typeof PulseShareCrypto === 'undefined') return;
    const tag = myTag;
    if (!confirm(`Sair de ${tag} neste aparelho?\n\nPara entrar de novo você vai precisar da chave de acesso ou das 7 palavras (em "🔑 Chaves e QR"). Guarde-as antes de sair.`)) return;
    const wipe = confirm(`Apagar também as conversas e os contatos de ${tag} deste aparelho?\n\nOK = apagar\nCancelar = manter guardados (voltam quando você entrar de novo nesta conta)`);
    const acct = accountStoreId(activeProfile);
    try {
      saveChatMessagesToStorage();
      ACCOUNT_SCOPED_KEYS.forEach((k) => {
        const v = localStorage.getItem(k);
        if (!wipe && v !== null) localStorage.setItem(accountStoreKey(acct, k), v);
        else localStorage.removeItem(accountStoreKey(acct, k));
        localStorage.removeItem(k);
      });
      localStorage.removeItem(LIVE_ACCOUNT_KEY);
      // Remove o perfil (e cópias dele com as mesmas chaves)
      PulseShareCrypto.ProfilesManager.getAllProfiles()
        .filter((p) => p.pubKeyHex === activeProfile.pubKeyHex)
        .forEach((p) => PulseShareCrypto.ProfilesManager.deleteProfile(p.id));
    } catch (e) {
      alert('Não foi possível sair da conta: ' + (e && e.message ? e.message : e));
      return;
    }
    if (Native.isBleAvailable()) Native.stopBleMesh();
    location.reload();
  }

  function renderIdentityModal() {
    if (!activeProfile) return;

    const slot = document.getElementById('identity-avatar-slot');
    if (slot) slot.innerHTML = profileAvatarHtml(activeProfile);
    const keyEl = document.getElementById('access-key-display');
    if (keyEl) {
      keyEl.textContent = '…';
      PulseShareCrypto.wordsToAccessKey(activeProfile.seedWords).then((k) => {
        keyEl.textContent = k || 'Indisponível para este perfil (palavras fora da lista)';
      });
    }
    const qrAreaReset = document.getElementById('qr-code-display-area');
    if (qrAreaReset) { qrAreaReset.classList.add('hidden'); qrAreaReset.classList.remove('flex'); qrAreaReset.innerHTML = ''; }

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

  function buildMeshPacket(obj) {
    const pktId = 'pkt_' + Math.random().toString(36).slice(2) + Date.now();
    return {
      ...obj,
      pktId,
      packetId: pktId,
      senderNodeId: nodeId,
      senderTag: myTag,
      timestamp: Date.now()
    };
  }

  function brokersOnline() {
    return brokerSockets.filter((ws) => ws && ws.readyState === WebSocket.OPEN).length;
  }

  // Publica um pacote já montado (próprio ou de terceiros em ponte BLE → internet)
  function publishRawToBrokers(packet) {
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

  function broadcastToMesh(obj) {
    const packet = buildMeshPacket(obj);
    seenPacketIds.add(packet.pktId);
    const sent = publishRawToBrokers(packet);
    // Sem internet: anúncios importantes seguem pelos vizinhos Bluetooth (que fazem a ponte)
    if (!sent && packet.meshType !== 'PRESENCE_ANNOUNCE') floodBle(packet, null, 3);
    return sent;
  }

  // ==========================================================================
  // 5b. ROTEAMENTO INTELIGENTE (Bluetooth direto, Internet/MQTT, malha BLE multi-salto)
  // --------------------------------------------------------------------------
  // Cada sinal ponto a ponto escolhe a rota de menor custo para o destino:
  //   'ble'  → vizinho Bluetooth no alcance (funciona sem internet)
  //   'mqtt' → brokers públicos pela internet
  //   'mesh' → inunda os vizinhos BLE (TTL 3); quem tiver internet faz a ponte
  //            para os brokers e quem enxergar o destino por BLE entrega direto
  // O custo combina disponibilidade, intensidade do sinal (RSSI), latência medida
  // pelos CHAT_ACK (média móvel) e falhas recentes. Mensagens de chat seguem pelas
  // 2 melhores rotas (o destino deduplica por pktId/id) e as retentativas por todas.
  // Arquivos vão por WebRTC, que prefere candidatos "host" → na mesma rede local
  // o tráfego fica na LAN (detectado em detectWebRtcPath); sem conexão direta,
  // cai para o relay pela malha (TUNNEL_RELAY_PULL / MESH_RELAY_CHUNK).
  // ==========================================================================
  const BLE_FRAME_MAX = 3500;        // pacotes maiores não valem a pena por BLE
  const BLE_PEER_FRESH_MS = 30000;
  const MQTT_PEER_FRESH_MS = 45000;
  const LAN_FRESH_MS = 10 * 60 * 1000;
  const CHAT_SIGNALS = new Set(['CHAT_MESSAGE', 'CHAT_ACK', 'CHAT_READ', 'CHAT_REACTION', 'USER_RENAMED']);
  const routeStats = {};             // tag -> { rtt:{via:ms}, fails:{via:n}, lastVia, lastOkVia, lastOkAt, lanAt }
  const pendingRtt = new Map();      // msgId -> { tag, vias, sentAt }
  const relayCounters = { bridgedToInternet: 0, bridgedToBle: 0, floodedBle: 0 };

  function statsFor(tag) {
    tag = normalizeTag(tag);
    if (!routeStats[tag]) routeStats[tag] = { rtt: {}, fails: {}, lastVia: null, lastOkVia: null, lastOkAt: 0, lanAt: 0 };
    return routeStats[tag];
  }

  function isBleNeighbor(tag) {
    const b = blePeers.get(normalizeTag(tag));
    return Boolean(b && Date.now() - (b.lastSeen || 0) < BLE_PEER_FRESH_MS && Native.isBleAvailable());
  }

  function freshBleNeighbors() {
    const now = Date.now();
    return Array.from(blePeers.entries()).filter(([, b]) => now - (b.lastSeen || 0) < BLE_PEER_FRESH_MS).map(([t]) => t);
  }

  function isOnInternet(tag) {
    const p = peerRegistry[normalizeTag(tag)];
    return Boolean(p && p.lastSeenMqtt && Date.now() - p.lastSeenMqtt < MQTT_PEER_FRESH_MS);
  }

  // Rotas candidatas ordenadas pelo menor custo
  function rankRoutes(tag, packetSize, opts = {}) {
    tag = normalizeTag(tag);
    const st = statsFor(tag);
    const online = brokersOnline() > 0;
    const bleFits = packetSize <= BLE_FRAME_MAX && Native.isBleAvailable();
    const routes = [];
    if (bleFits && isBleNeighbor(tag)) {
      const rssi = Number(blePeers.get(tag).rssi) || -85;
      // Sinal forte (≈ -50 dBm) custa pouco; perto de -100 dBm fica caro
      const base = 30 + Math.max(0, -rssi - 50) * 1.2;
      // Sinalização WebRTC precisa de baixa latência: com internet, BLE fica como reserva
      routes.push({ via: 'ble', cost: opts.latencySensitive && online ? base + 120 : base });
    }
    if (online) {
      routes.push({ via: 'mqtt', cost: isOnInternet(tag) ? 40 : (isBleNeighbor(tag) ? 110 : 70) });
    }
    if (bleFits && !isBleNeighbor(tag) && freshBleNeighbors().length > 0) {
      routes.push({ via: 'mesh', cost: online ? (isOnInternet(tag) ? 200 : 95) : 60 });
    }
    routes.forEach((r) => {
      if (st.rtt[r.via]) r.cost += Math.min(st.rtt[r.via] / 40, 80);
      r.cost += (st.fails[r.via] || 0) * 45;
    });
    return routes.sort((a, b) => a.cost - b.cost);
  }

  function sendBleFrame(neighborTag, packet, ttl, hops) {
    try {
      const b = blePeers.get(normalizeTag(neighborTag));
      const nativeTag = (b && b.adv) || neighborTag; // nome como o rádio anunciou
      return Native.sendBleMessage(nativeTag, JSON.stringify({ psf: 1, ttl, h: hops || 0, p: packet }));
    } catch (e) {
      return false;
    }
  }

  function floodBle(packet, exceptTag, ttl, hops) {
    if (!Native.isBleAvailable() || ttl <= 0) return 0;
    let n = 0;
    freshBleNeighbors().forEach((t) => {
      if (t === exceptTag || t === normalizeTag(packet.senderTag)) return;
      if (sendBleFrame(t, packet, ttl, hops || 0) !== false) n++;
    });
    if (n) relayCounters.floodedBle++;
    return n;
  }

  // Envia um pacote ponto a ponto pela(s) melhor(es) rota(s). Retorna as rotas usadas.
  function routePacket(tag, packet, opts = {}) {
    tag = normalizeTag(tag);
    const size = JSON.stringify(packet).length;
    const routes = rankRoutes(tag, size, opts);
    if (!routes.length) return [];
    const howMany = opts.allRoutes ? routes.length : opts.redundant ? Math.min(2, routes.length) : 1;
    const used = [];
    routes.slice(0, howMany).forEach((r) => {
      let ok = false;
      if (r.via === 'mqtt') ok = publishRawToBrokers(packet) > 0;
      else if (r.via === 'ble') ok = sendBleFrame(tag, packet, 3, 0) !== false;
      else if (r.via === 'mesh') ok = floodBle(packet, null, 3, 0) > 0;
      if (ok) used.push(r.via);
    });
    const st = statsFor(tag);
    if (used.length) st.lastVia = used[0];
    return used;
  }

  function sendSignal(to, transferId, signalType, payload, opts = {}) {
    const target = normalizeTag(to);
    const packet = buildMeshPacket({
      meshType: 'DIRECT_SIGNAL',
      to: target,
      transferId: transferId,
      signalType: signalType,
      payload: payload || {}
    });
    seenPacketIds.add(packet.pktId);
    const isChat = CHAT_SIGNALS.has(signalType);
    return routePacket(target, packet, {
      redundant: isChat,
      allRoutes: Boolean(opts.allRoutes),
      latencySensitive: !isChat && signalType !== 'CHAT_TYPING'
    });
  }

  // Latência medida pelo CHAT_ACK: alimenta o custo das rotas
  function trackRttSent(tag, msgId, vias) {
    pendingRtt.set(msgId, { tag: normalizeTag(tag), vias: vias || [], sentAt: Date.now() });
    if (pendingRtt.size > 300) pendingRtt.delete(pendingRtt.keys().next().value);
  }

  function trackRttAck(from, msgId, via) {
    const p = pendingRtt.get(msgId);
    const st = statsFor(from);
    st.lastOkAt = Date.now();
    if (via) {
      st.lastOkVia = via;
      st.fails[via] = 0;
    }
    if (!p) return;
    pendingRtt.delete(msgId);
    if (!via) return;
    const rtt = Date.now() - p.sentAt;
    st.rtt[via] = st.rtt[via] ? Math.round(st.rtt[via] * 0.7 + rtt * 0.3) : rtt;
  }

  function trackRouteFailure(tag, msgId) {
    const p = pendingRtt.get(msgId);
    if (!p) return;
    const st = statsFor(tag);
    p.vias.forEach((v) => { st.fails[v] = Math.min((st.fails[v] || 0) + 1, 4); });
  }

  // Ponte: pacote recebido por Bluetooth
  function handleBleFrame(frame, fromTag) {
    const packet = frame.p;
    if (!packet || !packet.meshType) return;
    const pktId = packet.pktId || packet.packetId;
    if (!pktId || seenPacketIds.has(pktId)) return;
    const hops = Number(frame.h) || 0;
    const sender = normalizeTag(packet.senderTag);
    if (sender && hops === 0 && sender !== normalizeTag(myTag)) {
      let b = blePeers.get(sender);
      if (!b) {
        // Vizinho anunciado com a tag cortada: agora sabemos a tag completa
        const cut = Array.from(blePeers.keys()).find((t) => t.length >= 24 && sender.length > t.length && sender.startsWith(t));
        if (cut) { b = blePeers.get(cut); blePeers.delete(cut); blePeers.set(sender, b); }
      }
      if (b) b.lastSeen = Date.now();
    }

    const target = packet.to ? normalizeTag(packet.to) : '';
    if (!target || isMyTag(target)) {
      handleIncomingPacket(packet, hops === 0 ? 'ble' : 'mesh');
      if (target) return; // era para nós: nada a encaminhar
    } else {
      seenPacketIds.add(pktId);
    }

    const ttl = Number(frame.ttl) || 0;
    if (!meshRelay || ttl <= 0) return;
    if (target && isBleNeighbor(target)) {
      sendBleFrame(target, packet, ttl - 1, hops + 1);
      relayCounters.bridgedToBle++;
      return;
    }
    if (brokersOnline() > 0) {
      publishRawToBrokers(packet);
      relayCounters.bridgedToInternet++;
    } else {
      floodBle(packet, normalizeTag(fromTag), ttl - 1, hops + 1);
    }
  }

  // Ponte: pacote da internet para um vizinho Bluetooth que está sem internet
  function maybeBridgeToBle(packet) {
    if (!meshRelay || !packet || packet.meshType !== 'DIRECT_SIGNAL') return;
    const target = normalizeTag(packet.to);
    if (!target || !isBleNeighbor(target) || isOnInternet(target)) return;
    if (JSON.stringify(packet).length > BLE_FRAME_MAX) return;
    sendBleFrame(target, packet, 1, 1);
    relayCounters.bridgedToBle++;
  }

  // Rótulo/selo da rota atual de um contato
  function currentRouteFor(tag) {
    tag = normalizeTag(tag);
    const st = statsFor(tag);
    if (st.lanAt && Date.now() - st.lanAt < LAN_FRESH_MS) return 'LAN';
    const best = rankRoutes(tag, 400)[0];
    if (!best) return 'OFF';
    if (best.via === 'ble') return 'BLE';
    if (best.via === 'mesh') return 'MESH';
    return isOnInternet(tag) ? 'P2P' : 'P2P?';
  }

  function routeBadgeHtml(tag) {
    const r = currentRouteFor(tag);
    if (r === 'LAN') return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0" title="Mesma rede local (WebRTC direto)">🟢 LAN</span>';
    if (r === 'BLE') return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30 shrink-0" title="Bluetooth direto">📶 BLE</span>';
    if (r === 'MESH') return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shrink-0" title="Via outros usuários (malha Bluetooth)">🔀 Malha</span>';
    if (r === 'OFF') return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-slate-800 text-slate-500 border border-slate-700 shrink-0" title="Sem rota no momento: a mensagem é reenviada quando houver">⚪ Sem rota</span>';
    return `<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-slate-800 ${r === 'P2P' ? 'text-slate-300' : 'text-slate-500'} border border-slate-700 shrink-0" title="${r === 'P2P' ? 'Online pela internet' : 'Internet (contato não visto recentemente)'}">🌐 Internet</span>`;
  }

  // Após o DataChannel abrir: descobre se o caminho WebRTC é LAN (host↔host)
  async function detectWebRtcPath(pc, tag) {
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const st = statsFor(tag);
      if (local && remote && local.candidateType === 'host' && remote.candidateType === 'host') {
        st.lanAt = Date.now();
        peerTransports[normalizeTag(tag)] = 'LAN';
      } else {
        st.lanAt = 0;
        if (peerTransports[normalizeTag(tag)] === 'LAN') delete peerTransports[normalizeTag(tag)];
      }
      if (typeof renderConversationsList === 'function') renderConversationsList();
      if (activeChatPeer === normalizeTag(tag)) refreshActiveChatRouteBadge();
    } catch (e) {}
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
      // Ao conectar, sincroniza o catálogo de nomes com os nós online (1x por sessão)
      if (myTag) setTimeout(requestNameRegistrySync, 4000);
      if (myTag) setTimeout(migrateBareTags, 6000);
      // Registros do administrador que este aparelho ainda não tem (1x por sessão)
      setTimeout(requestAdminState, 5000);
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
    if (coreLost || brokerReconnectTimers[url]) return;
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
          handleIncomingPacket(data, 'mqtt');
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
    noteTagClaim(myTag, mySince(), Date.now());
    broadcastToMesh({
      meshType: 'PRESENCE_ANNOUNCE',
      tag: myTag,
      nameSince: mySince(),
      createdAt: (activeProfile && activeProfile.createdAt) || 0,
      reghash: myRegHash,
      nodeId: nodeId,
      photoHash: (activeProfile && activeProfile.photoHash) || '',
      clientType: IS_ANDROID ? 'android' : IS_DESKTOP ? 'desktop' : IS_EXTENSION ? 'extension-app' : 'web',
      relayMode: meshRelay
    });
  }

  const NAME_ONLY_PACKETS = new Set(['PROBE_USER_EXISTS_REPLY', 'PRESENCE_ANNOUNCE', 'USER_REGISTERED', 'NAME_REGISTRY_SYNC', 'ADMIN_RECORDS']);

  function handleIncomingPacket(packet, via = 'mqtt') {
    if (!packet || !packet.meshType) return;
    const pktId = packet.pktId || packet.packetId;
    if (pktId) {
      if (seenPacketIds.has(pktId)) return;
      seenPacketIds.add(pktId);
      if (seenPacketIds.size > 2000) seenPacketIds.clear();
    }
    if (packet.senderNodeId === nodeId || (packet.senderTag && normalizeTag(packet.senderTag) === normalizeTag(myTag))) return;
    // Tela de entrada (sem conta): só escuta o necessário para verificar nomes
    if (!myTag && !NAME_ONLY_PACKETS.has(packet.meshType)) return;
    // Administração (registros assinados): vale de qualquer remetente
    if (ADMIN_PACKETS.has(packet.meshType)) { handleAdminPacket(packet); return; }

    const senderTag = normalizeTag(packet.senderTag);
    // Ninguém fala como "PulseShare" fora dos registros assinados; contas excluídas são ignoradas
    if (senderTag && (senderTag === OFFICIAL_TAG || isAdminDeleted(senderTag))) return;
    if (packet.meshType === 'PRESENCE_ANNOUNCE' && isAdminDeleted(packet.tag)) return;
    if (via === 'mqtt' && senderTag && peerRegistry[senderTag]) peerRegistry[senderTag].lastSeenMqtt = Date.now();

    switch (packet.meshType) {
      case 'PRESENCE_ANNOUNCE': {
        const tag = normalizeTag(packet.tag);
        if (tag) noteTagClaim(tag, packet.nameSince, Date.now());
        if (!myTag) break;
        if (tag && !isMyTag(tag)) {
          const prev = peerRegistry[tag] || {};
          peerRegistry[tag] = {
            ...prev,
            tag: tag,
            name: displayNameFor(tag),
            nodeId: packet.nodeId || packet.senderNodeId || prev.nodeId,
            reghash: packet.reghash || '0x0000',
            // Nunca usa HTML vindo da rede: identicon local (ou a foto já validada)
            avatar: prev.avatar || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 64) : null),
            clientType: packet.clientType || 'peer',
            createdAt: Number(packet.createdAt) || prev.createdAt || 0,
            nameSince: Number(packet.nameSince) || prev.nameSince || 0,
            relayMode: packet.relayMode !== false,
            transport: peerTransports[tag] || 'P2P',
            lastSeen: Date.now(),
            lastSeenMqtt: via === 'mqtt' ? Date.now() : prev.lastSeenMqtt
          };
          // Destino apareceu: reenvia o que ficou pendente para ele
          if (chatMessages[tag]) flushPendingMessages(tag);
          // Só contatos adicionados são exibidos: evita re-render a cada anúncio de estranhos
          if (isContact(tag)) {
            maybeRequestPeerPhoto(tag, packet.photoHash);
            updateHeaderStatus();
            renderConversationsList();
            renderMeshPeers();
          }
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

      // Alguém quer saber se um nome já existe (criação de conta / troca de nome / login)
      case 'PROBE_USER_EXISTS': {
        if (packet.probeId && packet.requesterNodeId !== nodeId) answerNameProbe(packet);
        break;
      }

      // Todos ouvem as respostas: atualiza o catálogo e cala quem ia responder de novo
      case 'PROBE_USER_EXISTS_REPLY': {
        if (packet.probeId) {
          answeredProbes.add(packet.probeId);
          if (answeredProbes.size > 500) answeredProbes.clear();
        }
        noteTagClaim(packet.ownerTag || packet.tag, packet.since, Date.now());
        const cb = pendingUserProbes.get(packet.probeId);
        if (cb && packet.ownerNodeId !== nodeId) cb(packet);
        break;
      }

      // Registro de nome (conta nova) ou troca de nome de um usuário
      case 'USER_REGISTERED': {
        const nt = splitTag(packet.tag);
        const ot = splitTag(packet.previousTag);
        if (ot && nt && ot.suffix === nt.suffix && ot.name !== nt.name) releaseNameClaim(ot.name, ot.suffix);
        if (nt) noteNameClaim(nt.name, nt.suffix, packet.since || packet.registeredAt, Date.now());
        if (!myTag) break;
        if (packet.previousTag) handleRemoteRename(packet.previousTag, packet.tag, packet.nodeId || packet.senderNodeId, packet.pubKeyHex);
        break;
      }

      // Catálogo de nomes: um nó novo pede, um nó online (o primeiro a sortear) responde
      case 'NAME_REGISTRY_REQUEST': {
        const rid = packet.reqId;
        if (!rid || answeredNameSyncs.has(rid) || !Object.keys(nameRegistry).length) break;
        setTimeout(() => {
          if (answeredNameSyncs.has(rid)) return;
          answeredNameSyncs.add(rid);
          broadcastToMesh({ meshType: 'NAME_REGISTRY_SYNC', reqId: rid, entries: exportNameRegistry(NAME_SYNC_MAX_ENTRIES) });
        }, 800 + Math.random() * 3500);
        break;
      }

      case 'NAME_REGISTRY_SYNC': {
        if (packet.reqId) {
          answeredNameSyncs.add(packet.reqId);
          if (answeredNameSyncs.size > 200) answeredNameSyncs.clear();
        }
        mergeNameRegistryEntries(packet.entries);
        break;
      }

      case 'DIRECT_SIGNAL': {
        const target = normalizeTag(packet.to);
        if (isMyTag(target)) {
          const from = normalizeTag(packet.senderTag);
          if (from && peerRegistry[from]) peerRegistry[from].lastSeen = Date.now();
          handleDirectSignal(from, packet.transferId, packet.signalType, packet.payload || {}, via);
        } else if (via === 'mqtt') {
          // Destino é vizinho Bluetooth sem internet? Fazemos a ponte.
          maybeBridgeToBle(packet);
        }
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Renomeação de outro usuário: só migramos se der para verificar que é a mesma
  // pessoa — mesmo nodeId já conhecido para a tag antiga, ou (tags do app) mesmo
  // sufixo de hash derivado das chaves.
  // --------------------------------------------------------------------------
  function hashSuffix(tag) {
    const m = /_([0-9a-f]{6})$/.exec(normalizeTag(tag));
    return m ? m[1] : '';
  }

  function handleRemoteRename(previousTag, newTag, senderNode, pubKeyHex) {
    const oldT = normalizeTag(previousTag);
    const newT = normalizeTag(newTag);
    if (!oldT || !newT || oldT === newT || isMyTag(newT) || isMyTag(oldT)) return;
    const known = peerRegistry[oldT];
    const sameNode = Boolean(known && known.nodeId && senderNode && known.nodeId === senderNode);
    const sameHash = Boolean(hashSuffix(oldT) && hashSuffix(oldT) === hashSuffix(newT) &&
      (!pubKeyHex || String(pubKeyHex).slice(0, 6) === hashSuffix(newT)));
    if (!sameNode && !sameHash) return;
    const hadChat = Boolean(chatMessages[oldT]);
    const contacts = getContacts();
    const wasContact = Boolean(contacts[oldT]);
    if (!hadChat && !wasContact) {
      if (known) { peerRegistry[newT] = { ...known, tag: newT }; delete peerRegistry[oldT]; }
      return;
    }

    if (hadChat) {
      chatMessages[newT] = (chatMessages[newT] || []).concat(chatMessages[oldT].map((m) => (
        normalizeTag(m.sender) === oldT ? { ...m, sender: newT } : m
      )));
      chatMessages[newT].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      delete chatMessages[oldT];
      saveChatMessagesToStorage();
    }
    if (wasContact && typeof PulseShareCrypto !== 'undefined') {
      const c = contacts[oldT];
      const keepName = c.name && normalizeTag(c.name) !== oldT ? c.name : newT.replace(/^@/, '').split('_')[0];
      PulseShareCrypto.ProfilesManager.saveContact(newT, { ...c, name: keepName });
      PulseShareCrypto.ProfilesManager.removeContact(oldT);
    }
    if (isBlocked(oldT)) { setBlocked(oldT, false); setBlocked(newT, true); }
    if (known) { peerRegistry[newT] = { ...known, tag: newT, lastSeen: Date.now() }; delete peerRegistry[oldT]; }
    if (routeStats[oldT]) { routeStats[newT] = routeStats[oldT]; delete routeStats[oldT]; }
    Object.values(transfers).forEach((t) => {
      if (normalizeTag(t.target) === oldT) t.target = newT;
      if (normalizeTag(t.sender) === oldT) t.sender = newT;
      if (normalizeTag(t.offerFrom) === oldT) t.offerFrom = newT;
    });
    Native.toast(`✏️ ${oldT} agora se chama ${newT}`);
    if (activeChatPeer === oldT) openActiveChat(newT);
    renderConversationsList();
    renderMeshPeers();
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
        ...(local || {}),
        tag,
        nodeId: item.nodeId || (local && local.nodeId),
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
      if (data && data.psf === 1 && data.p) {
        handleBleFrame(data, normalizeTag(fromTag));
        return;
      }
      // Formato antigo: payload de chat cru
      const from = normalizeTag((data && data.senderTag) || fromTag);
      if (from) peerTransports[from] = 'BLE';
      handleIncomingChatMessage(data, 'ble');
    } catch (e) {
      console.warn('Erro ao processar mensagem BLE:', e);
    }
  }

  // O anúncio BLE só carrega 24 bytes da tag: tags maiores chegam cortadas e são
  // resolvidas pelo prefixo entre contatos/peers conhecidos (se houver um único).
  function resolveBleTag(adv) {
    if (!adv || adv.length < 24) return adv;
    const known = new Set([...Object.keys(getContacts()), ...Object.keys(peerRegistry), ...Object.keys(chatMessages)]);
    if (known.has(adv)) return adv;
    const matches = Array.from(known).filter((t) => t.length > adv.length && t.startsWith(adv));
    return matches.length === 1 ? matches[0] : adv;
  }

  function handleBlePeersUpdated(peersJson) {
    try {
      const peers = typeof peersJson === 'string' ? JSON.parse(peersJson) : peersJson;
      let contactSeen = false;
      peers.forEach(p => {
        const adv = normalizeTag(p.tag);
        const tag = resolveBleTag(adv);
        if (tag && !isMyTag(tag) && !(adv.length >= 24 && normalizeTag(myTag).startsWith(adv))) {
          peerTransports[tag] = 'BLE';
          blePeers.set(tag, { rssi: p.rssi, address: p.address, lastSeen: Date.now(), adv });
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
            peerRegistry[tag].lastSeen = Date.now();
          }
          if (isContact(tag)) contactSeen = true;
        }
      });
      // Vizinhos BLE desconhecidos são usados só como nós de rota (não aparecem na UI)
      if (contactSeen) {
        renderConversationsList();
        renderMeshPeers();
      }
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

  function handleDirectSignal(from, transferId, signalType, payload, via) {
    if (window.__psTrace) console.log('[sig]', signalType, from, via, transferId, JSON.stringify(payload).slice(0, 120));
    // Usuários bloqueados (ou excluídos pelo administrador): tudo é ignorado em silêncio
    if (isBlocked(from) || isOfficialTag(from) || isAdminDeleted(from)) return;
    switch (signalType) {
      case 'CHAT_MESSAGE': {
        // O remetente real é sempre quem assinou o pacote (from)
        handleIncomingChatMessage({ ...payload, senderTag: from }, via);
        break;
      }

      case 'AVATAR_REQUEST': {
        handleAvatarRequest(from);
        break;
      }

      case 'AVATAR_RESPONSE': {
        handleAvatarResponse(from, payload);
        break;
      }

      case 'USER_RENAMED': {
        handleRemoteRename(payload.previousTag, payload.tag || from, payload.nodeId, payload.pubKeyHex);
        break;
      }

      case 'CHAT_ACK': {
        const msgId = payload.msgId || transferId;
        trackRttAck(from, msgId, via);
        if (activeChatPeer === from) refreshActiveChatRouteBadge();
        const m = (chatMessages[from] || []).find((x) => x.id === msgId);
        if (m && isMyTag(m.sender) && m.status !== 'READ') {
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

        // Regra de Download: no chat, fotos/vídeos/áudios até 16 MB são aceitos sozinhos só para
        // pré-visualizar (ficam na memória/IndexedDB); demais arquivos só com chatAutoDownload.
        const offerKind = chatMediaKind(payload.fileType || (existing && existing.fileType), payload.fileName || (existing && existing.fileName));
        const offerSize = Number(payload.fileSize || (existing && existing.totalBytes) || 0);
        const autoPreview = isChatMedia && isPreviewKind(offerKind) && offerSize > 0 && offerSize <= CHAT_PREVIEW_AUTO_MAX;
        // Quem não está nos contatos nunca recebe aceite automático
        const trusted = isContact(from) || isLinkVisitor(from);
        const shouldAccept = trusted && (isChatMedia ? Boolean(chatAutoDownload || autoPreview) : Boolean(autoAccept));

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
        // Envio direto (fora do chat): avisa na barra de notificações
        if (!isChatMedia && !existing) {
          notifyIncoming(from, `${payload.fileName || 'arquivo'} (${formatBytes(payload.fileSize || 0)})${shouldAccept ? '' : ' — toque para aceitar'}`, 'file');
        }

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
    const me = myTag ? [{ tag: myTag, nodeId, lastSeen: Date.now(), status: 'online', regHash: myRegHash, clientType: Native.isAvailable() ? 'android' : IS_DESKTOP ? 'desktop' : 'web' }] : [];
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
      if (!opts.isLinkPull) detectWebRtcPath(pc, targetTag);
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
    const kind = chatMediaKind(tr.fileType, tr.fileName);
    // Mídia do chat (foto/vídeo/áudio) fica também na memória para a pré-visualização
    const keepPreview = Boolean(tr.isChatMedia) && isPreviewKind(kind) && (tr.totalBytes || 0) <= CHAT_PREVIEW_KEEP_MAX;
    const inMemory = !Native.isAvailable() || keepPreview;
    // Android: só grava em Download/ se não for pré-visualização pura (ou se o usuário pediu)
    const toDisk = Native.isAvailable() && (!keepPreview || chatAutoDownload || tr.userRequested);
    const flush = (isLast) => {
      let merged = new Uint8Array(pendingBytes);
      let off = 0;
      pending.forEach((c) => { merged.set(c, off); off += c.length; });
      pending = [];
      pendingBytes = 0;
      const res = Native.saveChunk(transferId, tr.fileName, merged.length ? uint8ArrayToBase64(merged) : '', first, isLast, tr.fileType || '*/*');
      first = false;
      return res;
    };
    tr._chunks = inMemory ? [] : null;
    return {
      write(bytes) {
        if (inMemory) tr._chunks.push(bytes);
        if (toDisk) {
          pending.push(bytes);
          pendingBytes += bytes.length;
          if (pendingBytes >= FLUSH_AT) flush(false);
        }
      },
      finish() {
        if (toDisk) {
          const finalPath = flush(true);
          if (finalPath && finalPath !== 'CHUNK_WRITTEN') tr.savedPath = finalPath;
        }
        if (inMemory) {
          const mime = guessMimeFor(kind, tr.fileName, tr.fileType && tr.fileType !== '*/*' ? tr.fileType : '');
          const blob = new Blob(tr._chunks || [], { type: mime });
          tr._chunks = null;
          tr.blob = blob;
          if (keepPreview) setChatMediaBlob(transferId, blob);
          if (!Native.isAvailable()) {
            tr.savedPath = keepPreview ? getChatMediaUrl(transferId) : URL.createObjectURL(blob);
            // Fora do chat (ou com auto-download / pedido do usuário) salva direto no disco do navegador
            if (!tr.isChatMedia || chatAutoDownload || tr.userRequested) {
              const a = document.createElement('a');
              a.href = tr.savedPath;
              a.download = tr.fileName || 'arquivo';
              document.body.appendChild(a);
              a.click();
              a.remove();
            }
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
      dc.addEventListener('open', () => detectWebRtcPath(pc, senderTag));
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
      allowZip: opts.allowZip !== false,
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
      allowZip: share.allowZip !== false,
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
            <button type="button" data-ps-call="psShareAction" data-ps-args="copy|${s.shareId}" class="flex-1 py-1.5 rounded-lg bg-slate-800 text-white text-[10px] font-bold">Copiar link</button>
            <button type="button" data-ps-call="psShareAction" data-ps-args="share|${s.shareId}" class="flex-1 py-1.5 rounded-lg bg-indigo-600 text-white text-[10px] font-bold">Compartilhar</button>
            ${bad ? '' : `<button type="button" data-ps-call="psShareAction" data-ps-args="stop|${s.shareId}" class="py-1.5 px-2.5 rounded-lg bg-rose-600/80 text-white text-[10px] font-bold">Encerrar</button>`}
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
    if (isOfficialTag(tag)) return 'PulseShare';
    if (isLinkVisitor(tag)) return 'Visitante do link ' + tag.slice(6, 10);
    const parts = splitTag(tag);
    return parts ? parts.name : tag.replace(/^@/, '').split('_')[0];
  }

  function updateChatHeaderTyping() {
    const el = document.getElementById('chat-contact-tag');
    if (!el || !activeChatPeer) return;
    const st = peerTypingState[activeChatPeer];
    const typing = st && st.status && st.status !== 'idle' && Date.now() - st.at < 6000;
    el.textContent = typing ? (st.status === 'recording' ? '🎤 gravando áudio...' : 'digitando...') : activeChatPeer;
    if (typing) setTimeout(updateChatHeaderTyping, 6000);
  }

  // --------------------------------------------------------------------------
  // 8a. MÍDIA DO CHAT: pré-visualização de fotos, vídeos e áudios
  //     Recebidas até CHAT_PREVIEW_AUTO_MAX são aceitas sozinhas e ficam só na
  //     memória/IndexedDB (não vão para Download/ até o usuário tocar em Salvar).
  // --------------------------------------------------------------------------
  const CHAT_PREVIEW_AUTO_MAX = 16 * 1024 * 1024; // aceita sozinho para pré-visualizar
  const CHAT_PREVIEW_KEEP_MAX = 64 * 1024 * 1024; // mantém em memória/IndexedDB para pré-visualizar
  const chatMediaUrls = new Map();   // transferId -> blob URL
  const chatMediaLoading = new Set(); // transferIds sendo lidos do IndexedDB
  const chatMediaMissing = new Set(); // transferIds que não estão no IndexedDB
  let chatMediaDbPromise = null;

  function chatMediaDb() {
    if (chatMediaDbPromise) return chatMediaDbPromise;
    chatMediaDbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('PulseShareChatMedia', 1);
        req.onupgradeneeded = () => { req.result.createObjectStore('media'); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return chatMediaDbPromise;
  }

  async function chatMediaDbOp(mode, fn) {
    const db = await chatMediaDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('media', mode);
        const req = fn(tx.objectStore('media'));
        tx.oncomplete = () => resolve(req ? req.result : null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  function chatMediaKind(mime, name) {
    const m = String(mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', '3gp', 'mkv'].includes(ext)) return 'video';
    if (['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'amr'].includes(ext)) return 'audio';
    return 'file';
  }

  function isPreviewKind(kind) { return kind === 'image' || kind === 'video' || kind === 'audio'; }

  function guessMimeFor(kind, name, mime) {
    if (mime && mime !== '*/*' && mime !== 'application/octet-stream') return mime;
    const ext = String(name || '').split('.').pop().toLowerCase();
    const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      heic: 'image/heic', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
      '3gp': 'video/3gpp', mkv: 'video/x-matroska', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
      wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr' };
    return map[ext] || mime || 'application/octet-stream';
  }

  let chatMediaRerenderTimer = null;
  function scheduleChatMediaRerender() {
    if (chatMediaRerenderTimer) return;
    chatMediaRerenderTimer = setTimeout(() => {
      chatMediaRerenderTimer = null;
      if (activeChatPeer) renderChatMessages(activeChatPeer);
    }, 60);
  }

  // Registra o conteúdo de uma mídia do chat (memória + IndexedDB) e atualiza a conversa
  function setChatMediaBlob(transferId, blob) {
    if (!transferId || !blob) return;
    const old = chatMediaUrls.get(transferId);
    if (old) { try { URL.revokeObjectURL(old); } catch {} }
    chatMediaUrls.set(transferId, URL.createObjectURL(blob));
    chatMediaMissing.delete(transferId);
    if (blob.size <= CHAT_PREVIEW_KEEP_MAX) {
      chatMediaDbOp('readwrite', (st) => st.put(blob, transferId));
    }
    scheduleChatMediaRerender();
  }

  // URL da pré-visualização; se não estiver na memória, busca no IndexedDB e re-renderiza
  function getChatMediaUrl(transferId) {
    if (!transferId) return '';
    const url = chatMediaUrls.get(transferId);
    if (url) return url;
    if (!chatMediaLoading.has(transferId) && !chatMediaMissing.has(transferId)) {
      chatMediaLoading.add(transferId);
      chatMediaDbOp('readonly', (st) => st.get(transferId)).then((blob) => {
        chatMediaLoading.delete(transferId);
        if (blob instanceof Blob) {
          chatMediaUrls.set(transferId, URL.createObjectURL(blob));
          scheduleChatMediaRerender();
        } else {
          chatMediaMissing.add(transferId);
        }
      });
    }
    return '';
  }

  function deleteChatMedia(transferId) {
    if (!transferId) return;
    const url = chatMediaUrls.get(transferId);
    if (url) { try { URL.revokeObjectURL(url); } catch {} }
    chatMediaUrls.delete(transferId);
    chatMediaDbOp('readwrite', (st) => st.delete(transferId));
  }

  // Remetente: guarda a própria mídia enviada para mostrar a pré-visualização também do seu lado
  async function captureOutgoingChatMedia(transferId, fileItem) {
    const name = fileItem.name || '';
    const kind = chatMediaKind(fileItem.mimeType || fileItem.type, name);
    const size = fileItem.size || 0;
    if (!isPreviewKind(kind) || !size) return;
    const mime = guessMimeFor(kind, name, fileItem.mimeType || fileItem.type);
    const direct = fileItem instanceof Blob ? fileItem : (fileItem.file instanceof Blob ? fileItem.file : null);
    try {
      if (direct) {
        if (size <= CHAT_PREVIEW_KEEP_MAX) setChatMediaBlob(transferId, direct);
        return;
      }
      // URI do Android / base64: lê em blocos de 1 MB pela ponte (limite menor para não pesar no envio)
      if (size > CHAT_PREVIEW_AUTO_MAX) return;
      const parts = [];
      for (let off = 0; off < size; off += 1024 * 1024) {
        const bytes = await readFileSlice(fileItem, off, Math.min(1024 * 1024, size - off));
        if (!bytes || !bytes.length) break;
        parts.push(bytes.slice ? bytes.slice() : bytes);
      }
      if (parts.length) setChatMediaBlob(transferId, new Blob(parts, { type: mime }));
    } catch (e) {
      console.warn('Pré-visualização da mídia enviada indisponível:', e);
    }
  }

  // Android: grava no Download/ uma mídia que até então só estava na memória (pré-visualização)
  async function saveChatMediaToDisk(tr, blob) {
    if (!Native.isAvailable() || !blob) return '';
    const CH = 512 * 1024;
    let last = '';
    if (blob.size === 0) return Native.saveChunk(tr.id, tr.fileName, '', true, true, tr.fileType || '*/*');
    for (let off = 0, first = true; off < blob.size; off += CH, first = false) {
      const bytes = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
      last = Native.saveChunk(tr.id, tr.fileName, uint8ArrayToBase64(bytes), first, off + CH >= blob.size, tr.fileType || '*/*');
    }
    return last && last !== 'CHUNK_WRITTEN' ? last : '';
  }

  // Abre a foto do chat em tela cheia (encaixada, com zoom por pinça e arraste)
  window.psOpenChatImage = function (transferId) {
    const url = getChatMediaUrl(transferId);
    if (!url || !window.PulseShareImageViewer) return;
    let msg = null, peer = null;
    for (const p in chatMessages) {
      const m = chatMessages[p].find((x) => x.transferId === transferId || (x.media && x.media.transferId === transferId));
      if (m) { msg = m; peer = p; break; }
    }
    const media = (msg && msg.media) || {};
    const name = media.fileName || media.name || 'Imagem';
    const who = msg ? (msg.sender === myTag ? 'Você' : displayNameFor(peer)) : '';
    const meta = [who, msg ? formatTime(msg.timestamp) : '', formatBytes(media.fileSize || media.size || 0)].filter(Boolean).join(' • ');
    window.PulseShareImageViewer.open({
      src: url,
      title: name,
      meta,
      actions: [{ label: Native.isAvailable() ? '⬇ Salvar' : '⬇ Baixar', onClick: () => window.psSaveChatMedia(transferId) }]
    });
  };

  // Salva a mídia do chat no aparelho (ou abre, se já estiver salva)
  window.psSaveChatMedia = async function (transferId) {
    let tr = transfers[transferId];
    if (tr && tr.savedPath && Native.isAvailable()) { Native.openFile(tr.savedPath); return; }
    const url = getChatMediaUrl(transferId);
    if (!url) { window.downloadChatMedia(transferId); return; }
    let name = (tr && tr.fileName) || 'arquivo';
    let mime = (tr && tr.fileType) || '';
    for (const p in chatMessages) {
      const m = chatMessages[p].find((x) => x.transferId === transferId);
      if (m && m.media) { name = m.media.fileName || m.media.name || name; mime = mime || m.media.fileType || m.media.type || ''; break; }
    }
    if (!Native.isAvailable()) {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    try {
      const blob = await (await fetch(url)).blob();
      if (!tr) {
        tr = transfers[transferId] = { id: transferId, type: 'receive', fileName: name, fileType: mime || blob.type || '*/*', totalBytes: blob.size, transferredBytes: blob.size, status: 'completed', progress: 100, isChatMedia: true, startTime: Date.now() };
      }
      const path = await saveChatMediaToDisk(tr, blob);
      if (path) {
        tr.savedPath = path;
        Native.toast(`Salvo em ${Native.getDownloadDirectory()}: ${name}`);
        renderTransfers();
        scheduleChatMediaRerender();
      } else {
        Native.toast('Não foi possível salvar o arquivo.');
      }
    } catch (e) {
      Native.toast('Falha ao salvar: ' + (e && e.message ? e.message : e));
    }
  };

  function handleIncomingChatMessage(payload, via) {
    if (!payload || !payload.senderTag) return;
    const from = normalizeTag(payload.senderTag);
    if (isMyTag(from) || isBlocked(from) || isOfficialTag(from) || isAdminDeleted(from)) return;

    if (!chatMessages[from]) chatMessages[from] = [];
    const msgId = payload.id || ('msg_' + Date.now());

    // Confirma entrega ao remetente (✓✓) — mesmo para duplicatas, pois o ACK anterior pode ter se perdido
    sendSignal(from, msgId, 'CHAT_ACK', { msgId, senderTag: myTag, status: activeChatPeer === from ? 'READ' : 'DELIVERED' });

    if (chatMessages[from].some(m => m.id === msgId)) return;

    const fileMeta = payload.media || payload.fileMeta || null;
    const mediaTid = fileMeta ? (payload.transferId || fileMeta.transferId) : null;
    const incomingVoice = fileMeta && (payload.msgType === 'voice' || payload.type === 'voice' || payload.voiceDuration)
      ? sanitizeVoiceInfo({ duration: payload.voiceDuration, waveform: payload.waveform }) : null;
    const incomingLocation = sanitizeLocation(payload.location);
    chatMessages[from].push({
      id: msgId,
      sender: from,
      text: payload.text || '',
      timestamp: payload.timestamp || Date.now(),
      status: 'RECEIVED',
      transferId: mediaTid,
      media: fileMeta,
      forwarded: Boolean(payload.forwarded || payload.isForwarded),
      ...(incomingVoice ? { voice: incomingVoice } : {}),
      ...(incomingLocation ? { location: incomingLocation } : {})
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

    notifyIncoming(from, incomingLocation ? '📍 Localização' : incomingVoice ? `🎤 Mensagem de voz (${formatDuration(incomingVoice.duration)})`
      : payload.text || (fileMeta ? `📎 ${fileMeta.name || fileMeta.fileName || 'arquivo'}` : ''), 'chat');

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

  // extra.location = { lat, lon, acc } → mensagem de localização. O texto leva o link
  // do mapa para quem tem versão antiga (e o portal) ver algo útil.
  function sendChatMessage(targetTag, text, extra) {
    targetTag = normalizeTag(targetTag);
    if (!targetTag || !text) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const location = extra && extra.location ? sanitizeLocation(extra.location) : null;
    const msgId = 'cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const ts = Date.now();
    chatMessages[targetTag].push({
      id: msgId,
      sender: myTag,
      text,
      timestamp: ts,
      status: 'SENT',
      ...(location ? { location } : {})
    });
    saveChatMessagesToStorage();

    const payload = {
      id: msgId,
      senderTag: myTag,
      text,
      msgType: location ? 'location' : 'text',
      type: location ? 'location' : 'text',
      timestamp: ts
    };
    if (location) payload.location = location;

    // Roteamento inteligente: as 2 melhores rotas (Bluetooth direto, internet ou
    // malha BLE via outros usuários). O destino deduplica pelo id.
    const vias = sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload);
    trackRttSent(targetTag, msgId, vias);
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
        // Sem ACK: penaliza as rotas usadas e tenta por TODAS as disponíveis
        trackRouteFailure(targetTag, msgId);
        const vias = sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload, { allRoutes: true });
        trackRttSent(targetTag, msgId, vias);
        scheduleChatRetry(targetTag, msgId, payload, attempt + 1);
      }
    }, 4000 * attempt);
  }

  // --------------------------------------------------------------------------
  // Mensagens pendentes: não há servidor guardando mensagens, então texto para
  // quem está offline fica em ✓ (SENT). Quando o destino aparece na rede
  // (presença), reenviamos as pendentes dos últimos 7 dias (o destino deduplica
  // pelo id e responde CHAT_ACK → ✓✓).
  // --------------------------------------------------------------------------
  const PENDING_RESEND_MAX_AGE = 7 * 24 * 3600 * 1000;
  const pendingFlushAt = {}; // tag -> último reenvio
  function flushPendingMessages(tag) {
    tag = normalizeTag(tag);
    const list = chatMessages[tag];
    if (!list || !list.length || !myTag) return;
    const now = Date.now();
    if (now - (pendingFlushAt[tag] || 0) < 30000) return;
    const pending = list.filter((m) => m.status === 'SENT' && isMyTag(m.sender) && m.text &&
      !m.transferId && !m.media && now - (m.timestamp || 0) < PENDING_RESEND_MAX_AGE && now - (m.timestamp || 0) > 15000);
    if (!pending.length) return;
    pendingFlushAt[tag] = now;
    pending.slice(-30).forEach((m, i) => setTimeout(() => {
      const payload = { id: m.id, senderTag: myTag, text: m.text, msgType: m.location ? 'location' : 'text', type: m.location ? 'location' : 'text', timestamp: m.timestamp };
      if (m.location) payload.location = m.location;
      if (m.replyTo) payload.replyTo = m.replyTo;
      const vias = sendSignal(tag, m.id, 'CHAT_MESSAGE', payload);
      trackRttSent(tag, m.id, vias);
    }, i * 150));
  }

  // Conversas/contatos criados com "@nome" sem o sufixo _hash6 (busca antiga)
  // nunca chegavam a ninguém: quando o catálogo de nomes conhece o dono, move a
  // conversa para a tag completa e reenvia o que ficou pendente.
  function isBareUserTag(tag) {
    return /^@[a-z0-9_]{2,40}$/.test(tag || '') && !splitTag(tag) && !isLinkVisitor(tag) && !isOfficialTag(tag);
  }
  let bareMigrateTimer = null;
  const bareProbed = new Set();
  function scheduleBareTagMigration() {
    if (bareMigrateTimer) return;
    bareMigrateTimer = setTimeout(() => { bareMigrateTimer = null; migrateBareTags(); }, 1500);
  }
  function migrateBareTags() {
    if (!myTag || typeof PulseShareCrypto === 'undefined') return;
    const contacts = getContacts();
    const bare = new Set([...Object.keys(chatMessages), ...Object.keys(contacts)].filter(isBareUserTag));
    let changed = false;
    bare.forEach((b) => {
      const name = b.slice(1);
      const owner = registryOwnerOf(name);
      if (!owner) {
        // Pergunta à rede uma vez; a resposta entra no catálogo e chama isto de novo
        if (!bareProbed.has(name) && brokersOnline()) { bareProbed.add(name); probeName(name, ''); }
        return;
      }
      const full = `@${name}_${owner.s}`;
      if (isMyTag(full)) return;
      if (chatMessages[b]) {
        chatMessages[full] = (chatMessages[full] || []).concat(chatMessages[b]).sort((x, y) => (x.timestamp || 0) - (y.timestamp || 0));
        delete chatMessages[b];
      }
      if (contacts[b]) {
        const c = contacts[b];
        if (!contacts[full]) PulseShareCrypto.ProfilesManager.saveContact(full, { name: c.name && c.name !== b ? c.name : name, lists: c.lists });
        PulseShareCrypto.ProfilesManager.removeContact(b);
      }
      if (activeChatPeer === b) activeChatPeer = full;
      pendingFlushAt[full] = 0;
      changed = true;
      setTimeout(() => flushPendingMessages(full), 500);
    });
    if (changed) {
      saveChatMessagesToStorage();
      renderConversationsList();
      if (activeChatPeer && document.getElementById('chat-active-conversation-pane').classList.contains('active')) openActiveChat(activeChatPeer);
    }
  }

  function sendChatMessageWithMedia(targetTag, text, transferId, fileItem, extra) {
    targetTag = normalizeTag(targetTag);
    if (!targetTag || !fileItem) return;
    if (!chatMessages[targetTag]) chatMessages[targetTag] = [];

    const msgId = 'cmsg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const mime = fileItem.mimeType || fileItem.type || 'application/octet-stream';
    const voice = extra && extra.voice ? sanitizeVoiceInfo(extra.voice) : null;
    const msgType = voice ? 'voice' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
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
      media: fileMeta,
      ...(voice ? { voice } : {})
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
    // Mesmos campos da extensão antiga (voiceDuration em segundos, waveform 0–100)
    if (voice) { payload.voiceDuration = voice.duration; payload.waveform = voice.waveform; }
    trackRttSent(targetTag, msgId, sendSignal(targetTag, msgId, 'CHAT_MESSAGE', payload));
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
  // extra.voice = { duration, waveform } → mensagem de voz gravada no app
  function queueOutgoingFile(target, fileItem, text, extra) {
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
    sendChatMessageWithMedia(target, text || '', tid, fileItem, extra);
    captureOutgoingChatMedia(tid, fileItem);
  }

  window.downloadChatMedia = function (transferId, fileName) {
    let tr = transfers[transferId];
    // Já está na memória (pré-visualização) mas ainda não no disco: só salva
    if ((!tr || !tr.savedPath || !Native.isAvailable()) && chatMediaUrls.has(transferId) && !(tr && tr.type === 'send')) {
      window.psSaveChatMedia(transferId);
      return;
    }
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
    // Só quem foi adicionado ou com quem já existe conversa (nada de descoberta automática)
    const interactedPeers = new Set([
      ...Object.keys(chatMessages),
      ...Object.keys(contacts)
    ]);

    let peerTags = Array.from(interactedPeers).filter(t => t && !isMyTag(t) && !isBlocked(t) && !isAdminDeleted(t));

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
            <p class="text-xs text-slate-500 mt-1 max-w-xs">Adicione um contato pelo @usuário (toque na lupa no topo) para começar a conversar.</p>
          </div>
          <button id="btn-empty-global-search" type="button" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md shadow-indigo-600/30 active:scale-95 transition-all">
            ➕ Adicionar Contato
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
      const official = isOfficialTag(tag);
      const name = escapeHtml(official ? 'PulseShare' : (contact && contact.name) || (peer && peer.name) || displayNameFor(tag));
      const avatar = official ? officialAvatarHtml() : (contact && contact.avatar) || (peer && peer.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 56) : '');
      const msgs = chatMessages[tag] || [];
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      const lastTime = lastMsg ? formatTime(lastMsg.timestamp) : '';
      const transportBadge = official
        ? '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">✔ Oficial</span>'
        : isContact(tag) || isLinkVisitor(tag)
        ? routeBadgeHtml(tag)
        : '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30">✉️ Pedido</span>';

      let snippet = 'Toque para conversar com criptografia';
      let checkIcon = '';
      if (lastMsg) {
        snippet = messageSummary(lastMsg);
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
                  ${checkIcon}<span>${escapeHtml(snippet)}</span>
                </p>
                <div class="shrink-0 flex items-center gap-1.5">
                  ${transportBadge}
                </div>
              </div>
            </div>
          </div>
          ${official ? '' : `<button type="button" data-open-contact-options="${tag}" class="p-2 ml-1 text-slate-500 hover:text-white rounded-lg active:scale-90">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
            </svg>
          </button>`}
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
    const official = isOfficialTag(peerTag);
    // Confirmação de leitura (✓✓ azul) para quem nos enviou mensagens
    if (!official && (chatMessages[peerTag] || []).some(m => m.sender === peerTag)) {
      sendSignal(peerTag, 'read-' + Date.now(), 'CHAT_READ', { readerTag: myTag });
    }
    // Canal oficial (mensagens do administrador): somente leitura
    ['chat-bottom-input-bar', 'btn-chat-contact-menu', 'chat-contact-transport-badge'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', official);
    });
    const ro = document.getElementById('chat-official-readonly');
    if (ro) ro.classList.toggle('hidden', !official);
    toggleAttachMenu(false);
    updateComposeButtons();
    const contacts = (typeof PulseShareCrypto !== 'undefined') ? PulseShareCrypto.ProfilesManager.getContacts() : {};
    const contact = contacts[peerTag];
    const peer = peerRegistry[peerTag];
    const name = official ? 'PulseShare' : (contact && contact.name) || (peer && peer.name) || displayNameFor(peerTag);
    const avatar = official ? officialAvatarHtml() : (contact && contact.avatar) || (peer && peer.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(peerTag, 40) : '');
    const avatarSlot = document.getElementById('chat-contact-avatar');
    if (avatarSlot) avatarSlot.innerHTML = avatar;

    const nameEl = document.getElementById('chat-contact-name');
    if (nameEl) nameEl.textContent = name;

    const tagEl = document.getElementById('chat-contact-tag');
    if (tagEl) tagEl.textContent = official ? 'Mensagens oficiais' : peerTag;

    refreshActiveChatRouteBadge();
    refreshContactRequestBanner();

    renderChatMessages(peerTag);

    // Oculta a barra de abas inferior e desliza o chat ocupando 100% da área útil
    const bottomNav = document.getElementById('app-bottom-nav');
    if (bottomNav) bottomNav.classList.add('hidden');

    const activePane = document.getElementById('chat-active-conversation-pane');
    if (activePane) activePane.classList.add('active');
  }

  // Selo da rota atual no cabeçalho da conversa
  function refreshActiveChatRouteBadge() {
    const badge = document.getElementById('chat-contact-transport-badge');
    if (!badge || !activeChatPeer || isOfficialTag(activeChatPeer)) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = routeBadgeHtml(activeChatPeer);
    const el = tmp.firstElementChild;
    badge.className = el.className;
    badge.textContent = el.textContent;
    const st = statsFor(activeChatPeer);
    const rttInfo = Object.entries(st.rtt).map(([v, ms]) => `${v}: ${ms} ms`).join(' • ');
    badge.title = el.title + (rttInfo ? ` — latência medida ${rttInfo}` : '');
  }

  // Remetente fora dos contatos: oferece Adicionar / Bloquear
  function refreshContactRequestBanner() {
    const banner = document.getElementById('chat-contact-request-banner');
    if (!banner) return;
    const show = Boolean(activeChatPeer && !isContact(activeChatPeer) && !isLinkVisitor(activeChatPeer) && !isOfficialTag(activeChatPeer));
    banner.classList.toggle('hidden', !show);
  }

  function addContact(tag, name) {
    tag = normalizeTag(tag);
    if (!tag || typeof PulseShareCrypto === 'undefined') return false;
    if (!tag.startsWith('@')) tag = '@' + tag;
    if (isMyTag(tag)) return false;
    const peer = peerRegistry[tag];
    PulseShareCrypto.ProfilesManager.saveContact(tag, {
      name: name || (peer && peer.name) || displayNameFor(tag),
      avatar: (peer && peer.avatar) || PulseShareCrypto.generateIdenticonSvg(tag, 64)
    });
    setBlocked(tag, false);
    renderConversationsList();
    renderMeshPeers();
    if (activeChatPeer === tag) refreshContactRequestBanner();
    return true;
  }

  window.openActiveChat = (tag) => openActiveChat(tag);

  function closeActiveChat() {
    if (voiceRec) stopVoiceRecording(false);
    toggleAttachMenu(false);
    activeChatPeer = null;
    const activePane = document.getElementById('chat-active-conversation-pane');
    if (activePane) activePane.classList.remove('active');

    const bottomNav = document.getElementById('app-bottom-nav');
    if (bottomNav) bottomNav.classList.remove('hidden');

    renderConversationsList();
  }

  // Bolha de mídia: pré-visualização (foto/vídeo/áudio) ou cartão de arquivo com ação
  // ==========================================================================
  // 8b. VOZ, LOCALIZAÇÃO E PERFIL DO CONTATO
  //     - Mensagem de voz: gravada com MediaRecorder (webm/opus) e enviada como
  //       mídia do chat (chatmedia-) com voiceDuration + waveform no CHAT_MESSAGE.
  //     - Localização: CHAT_MESSAGE com location {lat, lon, acc}; o texto leva o
  //       link do mapa para versões antigas e para o portal.
  //     - Perfil: toque na foto/nome no topo da conversa (modal-peer-profile).
  // ==========================================================================
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function sanitizeVoiceInfo(v) {
    if (!v) return null;
    const duration = Math.min(3600, Math.max(0, Number(v.duration) || 0));
    const waveform = Array.isArray(v.waveform)
      ? v.waveform.slice(0, 64).map((x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)))) : [];
    return { duration: Math.round(duration * 10) / 10, waveform };
  }

  function sanitizeLocation(l) {
    if (!l || typeof l !== 'object') return null;
    const lat = Number(l.lat), lon = Number(l.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const acc = Math.max(0, Math.min(100000, Math.round(Number(l.acc) || 0)));
    return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, acc };
  }

  function mapUrlFor(lat, lon) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  }

  function locationLabel(loc) {
    return `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}${loc.acc ? ` • ±${loc.acc >= 1000 ? (loc.acc / 1000).toFixed(1) + ' km' : loc.acc + ' m'}` : ''}`;
  }

  // Resumo de uma mensagem (lista de conversas, busca, notificação)
  function messageSummary(m) {
    if (!m) return '';
    if (m.location) return '📍 Localização';
    if (m.voice) return `🎤 Mensagem de voz (${formatDuration(m.voice.duration)})`;
    if (m.media) {
      const name = m.media.fileName || m.media.name || 'Arquivo';
      const kind = chatMediaKind(m.media.fileType || m.media.type, name);
      if (kind === 'image') return m.text ? `📷 ${m.text}` : '📷 Foto';
      if (kind === 'video') return m.text ? `🎥 ${m.text}` : '🎥 Vídeo';
      if (kind === 'audio') return `🎵 ${name}`;
      return `📎 ${name}`;
    }
    return m.text || '';
  }

  const VOICE_PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 001.52.85l11.2-6.86a1 1 0 000-1.7L9.52 4.29A1 1 0 008 5.14z"/></svg>';
  const VOICE_PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>';

  function voiceBars(m, tid) {
    let wf = (m.voice && m.voice.waveform) || [];
    if (wf.length < 8) {
      // Sem forma de onda (mensagem antiga / outro cliente): barras estáveis a partir do id
      let h = 0;
      const seed = String(tid || m.id || '');
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
      wf = Array.from({ length: 36 }, (_, i) => 25 + Math.abs(Math.sin(h + i * 1.7)) * 60);
    }
    // Reamostra para 36 barras
    const N = 36;
    const bars = [];
    for (let i = 0; i < N; i++) bars.push(wf[Math.floor(i * wf.length / N)] || 0);
    return bars.map((v) => `<i style="height:${Math.max(14, Math.min(100, v))}%"></i>`).join('');
  }

  function renderVoiceHtml(m, isMe, tid, previewUrl, action, progressBar) {
    const dur = (m.voice && m.voice.duration) || 0;
    const safeTid = escapeHtml(String(tid || ''));
    const color = isMe ? 'text-indigo-100' : 'text-slate-300';
    const control = previewUrl
      ? `<button type="button" class="ps-voice-btn" data-voice-play title="Ouvir">${VOICE_PLAY_SVG}</button>`
      : `<div class="shrink-0">${action}</div>`;
    const status = isMe && !/Enviado/.test(action) ? `<span>${action}</span>` : '';
    return `
      <div class="space-y-1">
        <div class="ps-voice ${color}" data-voice-tid="${safeTid}" data-voice-dur="${dur}">
          ${control}
          <div class="ps-voice-wave" data-voice-seek>${voiceBars(m, tid)}</div>
          <div class="ps-voice-meta">
            <span data-voice-time>${formatDuration(dur)}</span>
            ${previewUrl ? '<button type="button" class="ps-voice-speed" data-voice-speed>1x</button>' : '<span>🎤</span>'}
          </div>
          ${previewUrl ? `<audio class="hidden" preload="metadata" src="${previewUrl}" data-voice-audio></audio>` : ''}
        </div>
        ${status ? `<div class="flex justify-end px-1.5">${status}</div>` : ''}
        ${progressBar}
      </div>`;
  }

  function renderLocationHtml(m) {
    const loc = m.location;
    const args = `${loc.lat}|${loc.lon}`;
    return `
      <div class="mt-0.5 space-y-1.5" style="width:min(16rem, 66vw)">
        <button type="button" data-ps-call="psOpenLocation" data-ps-args="${args}" title="Abrir no mapa" class="ps-loc-map block w-full"><span class="ps-loc-pulse"></span><span class="ps-loc-pin">📍</span></button>
        <div class="px-1.5">
          <span class="text-[13px] font-bold block">Localização</span>
          <span class="text-[10px] font-mono opacity-70 block truncate">${escapeHtml(locationLabel(loc))}</span>
        </div>
        <div class="grid grid-cols-2 gap-1.5 px-0.5">
          <button type="button" data-ps-call="psOpenLocation" data-ps-args="${args}" class="py-1.5 rounded-lg bg-slate-950/40 hover:bg-slate-950/60 text-[11px] font-bold active:scale-95">🗺️ Abrir mapa</button>
          <button type="button" data-ps-call="psCopyLocation" data-ps-args="${args}" class="py-1.5 rounded-lg bg-slate-950/40 hover:bg-slate-950/60 text-[11px] font-bold active:scale-95">📋 Copiar</button>
        </div>
      </div>`;
  }

  window.psOpenLocation = function (lat, lon) {
    const l = sanitizeLocation({ lat, lon });
    if (l) Native.openUrl(mapUrlFor(l.lat, l.lon));
  };
  window.psCopyLocation = function (lat, lon) {
    const l = sanitizeLocation({ lat, lon });
    if (!l) return;
    Native.copy(`${l.lat}, ${l.lon} — ${mapUrlFor(l.lat, l.lon)}`);
    Native.toast('Localização copiada');
  };

  // ---------- player das mensagens de voz ----------
  function voiceUiOf(el) { return el && el.closest ? el.closest('.ps-voice') : null; }
  function voiceDurationOf(ui, audio) {
    const d = Number(ui.dataset.voiceDur) || 0;
    if (d > 0) return d;
    return audio && isFinite(audio.duration) ? audio.duration : 0;
  }
  function updateVoiceUi(ui, audio) {
    if (!ui || !audio) return;
    const dur = voiceDurationOf(ui, audio);
    const frac = dur > 0 ? Math.min(1, audio.currentTime / dur) : 0;
    const bars = ui.querySelectorAll('.ps-voice-wave i');
    const lit = Math.round(frac * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < lit));
    const t = ui.querySelector('[data-voice-time]');
    if (t) t.textContent = formatDuration(audio.paused && audio.currentTime === 0 ? dur : audio.currentTime);
    const btn = ui.querySelector('[data-voice-play]');
    const playing = !audio.paused && !audio.ended;
    if (btn && btn._psPlaying !== playing) { btn._psPlaying = playing; btn.innerHTML = playing ? VOICE_PAUSE_SVG : VOICE_PLAY_SVG; }
  }
  function initVoicePlayer() {
    const container = document.getElementById('chat-messages-container');
    if (!container || container._psVoiceInit) return;
    container._psVoiceInit = true;
    ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata'].forEach((ev) => {
      container.addEventListener(ev, (e) => {
        const a = e.target;
        if (!a || !a.hasAttribute || !a.hasAttribute('data-voice-audio')) return;
        if (ev === 'ended') { a.currentTime = 0; }
        if (ev === 'play') {
          // Uma mensagem de voz por vez
          container.querySelectorAll('audio[data-voice-audio]').forEach((o) => { if (o !== a && !o.paused) o.pause(); });
        }
        updateVoiceUi(voiceUiOf(a), a);
      }, true);
    });
    container.addEventListener('click', (e) => {
      const ui = voiceUiOf(e.target);
      if (!ui) return;
      const audio = ui.querySelector('audio[data-voice-audio]');
      if (!audio) return;
      if (e.target.closest('[data-voice-play]')) {
        if (audio.paused) audio.play().catch(() => Native.toast('Não foi possível tocar o áudio'));
        else audio.pause();
      } else if (e.target.closest('[data-voice-speed]')) {
        const speeds = [1, 1.5, 2];
        const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length] || 1;
        audio.playbackRate = next;
        e.target.closest('[data-voice-speed]').textContent = `${next}x`;
      } else if (e.target.closest('[data-voice-seek]')) {
        const wave = e.target.closest('[data-voice-seek]');
        const r = wave.getBoundingClientRect();
        const dur = voiceDurationOf(ui, audio);
        if (dur > 0 && r.width > 0) {
          audio.currentTime = Math.max(0, Math.min(dur - 0.05, ((e.clientX - r.left) / r.width) * dur));
          if (audio.paused) audio.play().catch(() => {});
          updateVoiceUi(ui, audio);
        }
      }
    });
  }

  // ---------- gravação de voz ----------
  let voiceRec = null;
  const VOICE_MAX_SEC = 15 * 60;

  function micErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '🎤 Permissão do microfone negada. Libere o microfone para o PulseShare nas configurações.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '🎤 Nenhum microfone encontrado neste aparelho.';
    if (n === 'NotReadableError') return '🎤 O microfone está sendo usado por outro app.';
    return '🎤 Não foi possível usar o microfone.';
  }

  function setRecordingUi(on) {
    document.getElementById('chat-recording-bar').classList.toggle('hidden', !on);
    document.getElementById('chat-compose-row').classList.toggle('hidden', on);
    document.getElementById('chat-attach-menu').classList.add('hidden');
    if (!on) document.getElementById('voice-rec-wave').innerHTML = '';
  }

  async function startVoiceRecording() {
    if (voiceRec || !activeChatPeer || isOfficialTag(activeChatPeer)) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      Native.toast('Gravação de voz não é suportada aqui.');
      return;
    }
    const target = activeChatPeer;
    const st = { target, starting: true };
    voiceRec = st;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      voiceRec = null;
      Native.toast(micErrorText(e));
      return;
    }
    // Cancelado (fechou a conversa) enquanto pedia o microfone
    if (voiceRec !== st || activeChatPeer !== target) {
      stream.getTracks().forEach((tr) => tr.stop());
      if (voiceRec === st) voiceRec = null;
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    } catch (e) {
      stream.getTracks().forEach((tr) => tr.stop());
      voiceRec = null;
      Native.toast('Gravação de voz não é suportada aqui.');
      return;
    }
    Object.assign(st, { starting: false, stream, rec, mime: (rec.mimeType || mime || 'audio/webm').split(';')[0], chunks: [], levels: [], start: Date.now() });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) st.chunks.push(e.data); };
    // Nível do microfone para a forma de onda
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      st.ctx = new Ctx();
      const src = st.ctx.createMediaStreamSource(stream);
      st.analyser = st.ctx.createAnalyser();
      st.analyser.fftSize = 512;
      src.connect(st.analyser);
      st.buf = new Uint8Array(st.analyser.fftSize);
    } catch (e) { st.analyser = null; }
    const waveEl = document.getElementById('voice-rec-wave');
    const timeEl = document.getElementById('voice-rec-time');
    st.timer = setInterval(() => {
      const sec = (Date.now() - st.start) / 1000;
      timeEl.textContent = formatDuration(Math.floor(sec));
      let level = 8;
      if (st.analyser) {
        st.analyser.getByteTimeDomainData(st.buf);
        let sum = 0;
        for (let i = 0; i < st.buf.length; i++) { const v = (st.buf[i] - 128) / 128; sum += v * v; }
        // Raiz do RMS: voz baixa ainda aparece, voz alta não estoura
        level = Math.min(100, Math.round(Math.sqrt(Math.sqrt(sum / st.buf.length)) * 150));
      }
      st.levels.push(level);
      const bar = document.createElement('span');
      bar.style.height = Math.max(12, level) + '%';
      waveEl.appendChild(bar);
      while (waveEl.childElementCount > 90) waveEl.firstElementChild.remove();
      if (sec >= VOICE_MAX_SEC) stopVoiceRecording(true);
    }, 100);
    rec.start(250);
    setRecordingUi(true);
  }

  function stopVoiceRecording(send) {
    const st = voiceRec;
    voiceRec = null;
    setRecordingUi(false);
    if (!st || st.starting || !st.rec) return;
    clearInterval(st.timer);
    const duration = (Date.now() - st.start) / 1000;
    st.rec.onstop = () => {
      st.stream.getTracks().forEach((tr) => tr.stop());
      try { if (st.ctx) st.ctx.close(); } catch (e) {}
      if (!send) return;
      if (duration < 0.8) { Native.toast('Gravação muito curta. Toque no microfone, fale e toque em enviar.'); return; }
      const blob = new Blob(st.chunks, { type: st.mime });
      if (!blob.size) { Native.toast('A gravação ficou vazia.'); return; }
      // Forma de onda resumida em 48 pontos (vai no CHAT_MESSAGE)
      const lv = st.levels.length ? st.levels : [10];
      const waveform = Array.from({ length: 48 }, (_, i) => {
        const a = Math.floor(i * lv.length / 48), b = Math.max(a + 1, Math.floor((i + 1) * lv.length / 48));
        return Math.max(...lv.slice(a, b));
      });
      const ext = /ogg/.test(st.mime) ? 'ogg' : /mp4/.test(st.mime) ? 'm4a' : 'webm';
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = `voz-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${ext}`;
      const fileItem = { name, size: blob.size, mimeType: st.mime, file: new File([blob], name, { type: st.mime }) };
      queueOutgoingFile(st.target, fileItem, '', { voice: { duration, waveform } });
    };
    try { st.rec.stop(); } catch (e) { st.rec.onstop(); }
  }

  // ---------- anexos ----------
  function toggleAttachMenu(force) {
    const menu = document.getElementById('chat-attach-menu');
    if (!menu) return;
    const show = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show);
  }

  function chooseAttachment(kind) {
    toggleAttachMenu(false);
    if (!activeChatPeer) return;
    if (kind === 'location') { openLocationModal(); return; }
    pendingChatAttachment = true;
    Native.pickFiles(kind === 'media' ? 'image/*,video/*' : kind === 'audio' ? 'audio/*' : '');
  }

  function updateComposeButtons() {
    const input = document.getElementById('input-chat-text');
    const has = Boolean((input && input.value.trim()) || chatAttachedFiles.length);
    document.getElementById('btn-chat-send').classList.toggle('hidden', !has);
    document.getElementById('btn-chat-mic').classList.toggle('hidden', has);
  }

  // ---------- localização ----------
  let locationCurrent = null;
  let locationReqSeq = 0;

  function setLocationStatus(text, ok) {
    const el = document.getElementById('location-status');
    if (el) { el.textContent = text; el.className = `text-xs ${ok ? 'text-emerald-300' : 'text-slate-300'}`; }
    document.getElementById('btn-location-send').disabled = !locationCurrent;
  }

  function geoErrorText(err) {
    if (err && err.code === 1) return 'Permissão de localização negada.';
    if (err && err.code === 3) return 'A localização demorou demais para responder.';
    return IS_DESKTOP ? 'O computador não informou a localização.' : 'Não foi possível obter a localização (o GPS está ligado?).';
  }

  // "lat, lon", link do Google Maps (@lat,lon / q=lat,lon) ou do OpenStreetMap (mlat/mlon)
  function parseLocationInput(raw) {
    const s = decodeURIComponent(String(raw || '').trim());
    let m = /mlat=(-?\d+(?:\.\d+)?).*?mlon=(-?\d+(?:\.\d+)?)/.exec(s);
    if (!m) m = /(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(s.replace(/^.*?(@|q=|query=|ll=)/, ''));
    return m ? sanitizeLocation({ lat: m[1], lon: m[2] }) : null;
  }

  function requestCurrentLocation() {
    const seq = ++locationReqSeq;
    locationCurrent = null;
    setLocationStatus('Obtendo sua localização...');
    if (!navigator.geolocation) {
      setLocationStatus('Este aparelho não informa a localização. Digite as coordenadas abaixo.');
      document.getElementById('location-manual').classList.remove('hidden');
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      if (seq !== locationReqSeq) return;
      locationCurrent = sanitizeLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy });
      if (locationCurrent) setLocationStatus(`Sua localização: ${locationLabel(locationCurrent)}`, true);
    }, (err) => {
      if (seq !== locationReqSeq) return;
      const manual = parseLocationInput(document.getElementById('input-location-manual').value);
      locationCurrent = manual;
      document.getElementById('location-manual').classList.remove('hidden');
      setLocationStatus(manual ? `Localização digitada: ${locationLabel(manual)}` : `${geoErrorText(err)} Digite as coordenadas abaixo.`, Boolean(manual));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  function openLocationModal() {
    if (!activeChatPeer) return;
    document.getElementById('input-location-manual').value = '';
    // No computador o navegador quase nunca sabe a posição: o campo manual já aparece
    document.getElementById('location-manual').classList.toggle('hidden', !IS_DESKTOP);
    document.getElementById('modal-location').classList.remove('hidden');
    requestCurrentLocation();
  }

  function closeLocationModal() {
    locationReqSeq++;
    document.getElementById('modal-location').classList.add('hidden');
  }

  function sendCurrentLocation() {
    const loc = locationCurrent;
    if (!loc || !activeChatPeer) return;
    sendChatMessage(activeChatPeer, `📍 Localização: ${mapUrlFor(loc.lat, loc.lon)}`, { location: loc });
    closeLocationModal();
  }

  // ---------- perfil do contato ----------
  let peerProfileTag = null;

  function timeAgo(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return 'agora há pouco';
    if (d < 3600000) return `há ${Math.floor(d / 60000)} min`;
    if (d < 86400000) return `há ${Math.floor(d / 3600000)} h`;
    if (d < 7 * 86400000) return `há ${Math.floor(d / 86400000)} dia(s)`;
    return `em ${formatDate(ts)}`;
  }
  function formatDate(ts) {
    try { return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
  }
  const CLIENT_LABELS = { android: '📱 Celular Android', desktop: '💻 Computador (Linux)', 'extension-app': '🧩 Extensão do Chrome', web: '🌐 Navegador' };

  function openPeerProfile(tag) {
    tag = normalizeTag(tag);
    if (!tag) return;
    peerProfileTag = tag;
    renderPeerProfile();
    const body = document.getElementById('peer-profile-body');
    if (body) body.scrollTop = 0;
    document.getElementById('modal-peer-profile').classList.remove('hidden');
  }

  function closePeerProfile() {
    peerProfileTag = null;
    document.getElementById('modal-peer-profile').classList.add('hidden');
  }

  function profileRow(label, value) {
    return value ? `
      <div class="flex items-center justify-between gap-3 px-3 py-2.5">
        <span class="text-[11px] text-slate-400 shrink-0">${label}</span>
        <span class="text-xs text-slate-100 font-semibold text-right min-w-0 truncate">${value}</span>
      </div>` : '';
  }

  function profileAction(id, icon, label, extra) {
    return `<button type="button" data-profile-action="${id}" class="flex flex-col items-center gap-1 py-2.5 rounded-2xl bg-slate-900 border border-slate-800 hover:bg-slate-800 active:scale-95 transition-all ${extra || ''}">
      <span class="text-lg leading-none">${icon}</span><span class="text-[10px] font-bold text-slate-300">${label}</span></button>`;
  }

  function renderPeerProfile() {
    const body = document.getElementById('peer-profile-body');
    const tag = peerProfileTag;
    if (!body || !tag) return;
    const official = isOfficialTag(tag);
    const c = getContacts()[tag];
    const p = peerRegistry[tag] || {};
    const name = official ? 'PulseShare' : (c && c.name && c.name !== tag ? c.name : '') || p.name || displayNameFor(tag);
    const now = Date.now();
    const parts = splitTag(tag);
    const reg = parts && nameRegistry[parts.name] && nameRegistry[parts.name].s === parts.suffix ? nameRegistry[parts.name] : null;
    const lastSeen = Math.max(p.lastSeen || 0, (reg && reg.seen) || 0);
    const online = Boolean(p.lastSeen && now - p.lastSeen < 45000);
    const status = official ? '✔ Canal oficial do PulseShare'
      : online ? '<span class="text-emerald-400">● Online agora</span>'
      : lastSeen ? `Visto por último ${timeAgo(lastSeen)}` : 'Ainda não foi visto online';
    const msgs = chatMessages[tag] || [];
    const media = msgs.filter((m) => m.media && !m.voice).reverse();
    const thumbs = media.map((m) => {
      const tid = m.transferId || m.media.transferId;
      const kind = chatMediaKind(m.media.fileType || m.media.type, m.media.fileName || m.media.name);
      const url = (kind === 'image' || kind === 'video') ? getChatMediaUrl(tid) : '';
      return url ? { tid, kind, url } : null;
    }).filter(Boolean).slice(0, 9);
    const docs = media.length - media.filter((m) => ['image', 'video'].includes(chatMediaKind(m.media.fileType || m.media.type, m.media.fileName || m.media.name))).length;
    const voices = msgs.filter((m) => m.voice).length;
    const places = msgs.filter((m) => m.location).length;
    const contact = isContact(tag);
    const blocked = isBlocked(tag);
    const lists = c && Array.isArray(c.lists) ? c.lists.filter((l) => l && l !== 'Todas') : [];

    const rows = official ? [
      profileRow('Tipo', '✔ Mensagens oficiais (somente leitura)'),
      profileRow('Mensagens recebidas', String(msgs.length))
    ] : [
      profileRow('Usuário', `<span class="font-mono">${escapeHtml(tag)}</span>`),
      profileRow('Situação', contact ? '👤 Nos seus contatos' : isLinkVisitor(tag) ? '🔗 Visitante de link' : '✉️ Fora dos contatos'),
      profileRow('Listas', lists.map(escapeHtml).join(', ')),
      profileRow('Aparelho', CLIENT_LABELS[p.clientType] || ''),
      profileRow('Rota atual', online ? routeBadgeHtml(tag) : ''),
      profileRow('Conta criada', p.createdAt ? formatDate(p.createdAt) : ''),
      profileRow('Usa este nome desde', (p.nameSince || (reg && reg.since)) ? formatDate(p.nameSince || reg.since) : ''),
      profileRow('Visto por último', !online && lastSeen ? `${formatDate(lastSeen)} ${formatTime(lastSeen)}` : ''),
      profileRow('Mensagens na conversa', msgs.length ? String(msgs.length) : ''),
      profileRow('Mensagens de voz', voices ? String(voices) : ''),
      profileRow('Localizações', places ? String(places) : ''),
      profileRow('Arquivos e áudios', docs ? String(docs) : '')
    ];

    body.innerHTML = `
      <div class="flex flex-col items-center text-center pt-2 space-y-2">
        <button type="button" id="peer-profile-photo" title="Ver foto em tamanho real" class="w-32 h-32 rounded-full overflow-hidden border-2 border-slate-700 bg-slate-800 shadow-xl active:scale-95 transition-all cursor-zoom-in" style="width:8.5rem;height:8.5rem">${avatarFor(tag, 128)}</button>
        <div class="min-w-0 max-w-full">
          <h2 class="text-xl font-extrabold text-white truncate" style="font-size:1.35rem">${escapeHtml(name)}</h2>
          ${official ? '' : `<button type="button" data-profile-action="copy" class="text-xs font-mono text-slate-400 hover:text-indigo-300 truncate max-w-full">${escapeHtml(tag)} 📋</button>`}
          <p class="text-[11px] text-slate-400 mt-1">${status}</p>
        </div>
      </div>

      ${official ? '' : `
      <div class="grid grid-cols-4 gap-2">
        ${profileAction('chat', '💬', 'Conversar')}
        ${profileAction(contact ? 'rename' : 'add', contact ? '✏️' : '➕', contact ? 'Renomear' : 'Adicionar')}
        ${profileAction('list', '🏷️', 'Lista')}
        ${profileAction('copy', '📋', 'Copiar @')}
      </div>`}

      <div class="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800/60 overflow-hidden">
        ${rows.join('')}
      </div>

      ${thumbs.length ? `
      <div class="space-y-2">
        <div class="flex items-center justify-between px-1">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Fotos e vídeos</span>
          <span class="text-[10px] font-mono text-slate-500">${media.length - docs}</span>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          ${thumbs.map((t) => t.kind === 'image'
            ? `<button type="button" data-ps-call="psOpenChatImage" data-ps-args="${escapeHtml(t.tid)}" class="block rounded-xl overflow-hidden bg-slate-900 border border-slate-800" style="aspect-ratio:1"><img src="${t.url}" alt="" class="w-full h-full object-cover" /></button>`
            : `<button type="button" data-profile-action="video" data-tid="${escapeHtml(t.tid)}" class="relative block rounded-xl overflow-hidden bg-black border border-slate-800" style="aspect-ratio:1"><video src="${t.url}" preload="metadata" muted class="w-full h-full object-cover" style="pointer-events:none"></video><span class="absolute inset-0 flex items-center justify-center text-2xl">▶️</span></button>`).join('')}
        </div>
      </div>` : ''}

      ${official ? '' : `
      <div class="space-y-2 pb-4">
        <button type="button" data-profile-action="block" class="w-full py-2.5 px-3 rounded-xl ${blocked ? 'bg-slate-800 hover:bg-slate-700 text-white' : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30'} text-left text-xs font-bold">${blocked ? '✅ Desbloquear' : '🚫 Bloquear'} ${escapeHtml(name)}</button>
        ${msgs.length ? '<button type="button" data-profile-action="delete" class="w-full py-2.5 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-left text-xs font-bold">🗑️ Excluir conversa</button>' : ''}
      </div>`}`;
  }

  function openPeerProfilePhoto() {
    const tag = peerProfileTag;
    if (!tag || !window.PulseShareImageViewer) return;
    const c = getContacts()[tag];
    let src = c && isSafeImageDataUrl(c.photo) ? c.photo : '';
    if (!src) {
      // Sem foto: mostra o avatar desenhado (identicon / ícone oficial) em tamanho grande
      const svg = isOfficialTag(tag) ? officialAvatarHtml() : (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, 512) : '');
      if (!svg) return;
      let s = svg.replace(/\sclass="[^"]*"/, '');
      if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      if (!/\swidth="/.test(s.slice(0, s.indexOf('>')))) s = s.replace('<svg', '<svg width="512" height="512"');
      src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    }
    window.PulseShareImageViewer.open({ src, title: isOfficialTag(tag) ? 'PulseShare' : displayNameFor(tag), meta: isOfficialTag(tag) ? '' : tag });
  }

  function handlePeerProfileAction(action, el) {
    const tag = peerProfileTag;
    if (!tag) return;
    switch (action) {
      case 'chat':
        closePeerProfile();
        if (activeChatPeer !== tag) { switchTab('chat'); openActiveChat(tag); }
        break;
      case 'copy':
        Native.copy(tag);
        Native.toast(`${tag} copiado`);
        break;
      case 'add':
        if (addContact(tag)) Native.toast(`${tag} adicionado aos contatos`);
        renderPeerProfile();
        break;
      case 'rename':
        activeMenuTargetTag = tag;
        handleSaveContactAction();
        renderPeerProfile();
        break;
      case 'list':
        activeMenuTargetTag = tag;
        handleAddToListAction();
        renderPeerProfile();
        break;
      case 'video': {
        const tid = el && el.getAttribute('data-tid');
        if (tid) { closePeerProfile(); if (activeChatPeer !== tag) openActiveChat(tag); setTimeout(() => scrollToMediaMessage(tid), 350); }
        break;
      }
      case 'block':
        if (isBlocked(tag)) {
          setBlocked(tag, false);
          Native.toast(`${tag} desbloqueado`);
          renderPeerProfile();
        } else if (confirm(`Bloquear ${tag}? Mensagens e arquivos dessa pessoa serão ignorados.`)) {
          setBlocked(tag, true);
          closePeerProfile();
          if (activeChatPeer === tag) closeActiveChat();
          renderConversationsList();
          Native.toast(`${tag} bloqueado`);
        }
        break;
      case 'delete':
        activeMenuTargetTag = tag;
        handleDeleteChatAction();
        if (!chatMessages[tag]) closePeerProfile(); else renderPeerProfile();
        break;
    }
  }

  function scrollToMediaMessage(tid) {
    const msgs = chatMessages[activeChatPeer] || [];
    const m = msgs.find((x) => x.transferId === tid || (x.media && x.media.transferId === tid));
    if (m && typeof scrollToChatMessage === 'function') scrollToChatMessage(m.id);
  }

  function initVoiceLocationProfileEvents() {
    initVoicePlayer();
    document.getElementById('btn-chat-open-profile').onclick = () => { if (activeChatPeer) openPeerProfile(activeChatPeer); };
    document.getElementById('btn-close-peer-profile').onclick = () => closePeerProfile();
    document.getElementById('modal-peer-profile').addEventListener('click', (e) => {
      if (e.target.closest('#peer-profile-photo')) { openPeerProfilePhoto(); return; }
      const a = e.target.closest('[data-profile-action]');
      if (a) handlePeerProfileAction(a.getAttribute('data-profile-action'), a);
    });
    document.getElementById('chat-attach-menu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-attach-kind]');
      if (b) chooseAttachment(b.getAttribute('data-attach-kind'));
    });
    document.getElementById('btn-chat-mic').onclick = () => startVoiceRecording();
    document.getElementById('btn-voice-cancel').onclick = () => stopVoiceRecording(false);
    document.getElementById('btn-voice-send').onclick = () => stopVoiceRecording(true);
    document.getElementById('input-chat-text').addEventListener('input', updateComposeButtons);
    document.getElementById('btn-close-location').onclick = () => closeLocationModal();
    document.getElementById('btn-location-retry').onclick = () => requestCurrentLocation();
    document.getElementById('btn-location-send').onclick = () => sendCurrentLocation();
    document.getElementById('input-location-manual').addEventListener('input', (e) => {
      const l = parseLocationInput(e.target.value);
      if (l) { locationReqSeq++; locationCurrent = l; setLocationStatus(`Localização digitada: ${locationLabel(l)}`, true); }
      else if (e.target.value.trim()) { locationCurrent = null; setLocationStatus('Não reconheci as coordenadas. Use o formato "-29.68, -51.13".'); }
    });
  }

  function renderChatMediaHtml(m, isMe) {
    const tid = m.transferId || (m.media && m.media.transferId);
    const tr = transfers[tid];
    const fileName = (tr && tr.fileName) || (m.media && (m.media.fileName || m.media.name)) || 'Arquivo';
    const fileSize = (tr && tr.totalBytes) || (m.media && (m.media.fileSize || m.media.size)) || 0;
    const mime = (tr && tr.fileType && tr.fileType !== '*/*' ? tr.fileType : '') || (m.media && (m.media.fileType || m.media.type)) || '';
    const kind = chatMediaKind(mime, fileName);
    const previewUrl = isPreviewKind(kind) ? getChatMediaUrl(tid) : '';
    const isDownloaded = Boolean(tr && tr.savedPath);
    const isTransferring = Boolean(tr && ['transferring', 'connecting', 'paused'].includes(tr.status));
    const safeName = escapeHtml(fileName);
    const safeTid = escapeHtml(String(tid || ''));
    const progressBar = isTransferring ? `
      <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style="width: ${tr.progress || 0}%"></div>
      </div>` : '';

    let action;
    if (isMe) {
      const st = tr ? tr.status : 'completed';
      action = isTransferring ? `<span class="text-[10px] font-mono text-indigo-300 font-bold animate-pulse">${tr.progress || 0}%</span>`
        : `<span class="text-[10px] font-bold ${st === 'completed' ? 'text-emerald-300' : st === 'error' || st === 'cancelled' ? 'text-rose-300' : 'text-slate-300'}">${st === 'completed' ? 'Enviado' : st === 'awaiting_accept' ? 'Aguardando' : st === 'error' ? 'Falhou' : st === 'cancelled' ? 'Cancelado' : st}</span>`;
    } else if (isDownloaded && Native.isAvailable()) {
      action = `<button type="button" data-ps-call="downloadChatMedia" data-ps-args="${safeTid}" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shadow active:scale-95">Abrir</button>`;
    } else if (previewUrl || isDownloaded) {
      action = `<button type="button" data-ps-call="psSaveChatMedia" data-ps-args="${safeTid}" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shadow active:scale-95">Salvar</button>`;
    } else if (isTransferring) {
      action = `<span class="text-[10px] font-mono text-indigo-400 font-bold animate-pulse">${tr.status === 'connecting' ? 'conectando' : (tr.progress || 0) + '%'}</span>`;
    } else {
      action = `<button type="button" data-ps-call="downloadChatMedia" data-ps-args="${safeTid}" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold shadow active:scale-95">${tr && tr.status === 'error' ? 'Tentar de novo' : 'Baixar'}</button>`;
    }

    if (m.voice) return renderVoiceHtml(m, isMe, tid, previewUrl, action, progressBar);

    if (previewUrl) {
      let preview = '';
      if (kind === 'image') {
        preview = `<img src="${previewUrl}" alt="${safeName}" data-ps-call="psOpenChatImage" data-ps-args="${safeTid}" class="block rounded-xl cursor-zoom-in" style="max-width:100%;max-height:18rem;min-width:7rem;object-fit:cover;background:#020617" />`;
      } else if (kind === 'video') {
        preview = `<video src="${previewUrl}" controls playsinline preload="metadata" class="block w-full rounded-xl" style="max-height:18rem;background:#000"></video>`;
      } else {
        preview = `<audio src="${previewUrl}" controls preload="metadata" class="block w-full" style="min-width:14rem;height:40px"></audio>`;
      }
      const icon = kind === 'image' ? '📷' : kind === 'video' ? '🎥' : '🎵';
      return `
        <div class="mt-1 space-y-1.5" style="max-width:min(20rem, 72vw)">
          ${preview}
          <div class="flex items-center justify-between gap-2 px-0.5">
            <span class="text-[10px] ${isMe ? 'text-indigo-200' : 'text-slate-400'} truncate min-w-0">${icon} ${safeName} • ${formatBytes(fileSize)}</span>
            <div class="shrink-0">${action}</div>
          </div>
          ${progressBar}
        </div>`;
    }

    const icon = kind === 'image' ? '📷' : kind === 'video' ? '🎥' : kind === 'audio' ? '🎵' : '📁';
    return `
      <div class="mt-2 p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-lg">${icon}</span>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">${safeName}</span>
              <span class="text-[10px] text-slate-400 font-mono">${formatBytes(fileSize)}</span>
            </div>
          </div>
          <div>${action}</div>
        </div>
        ${progressBar}
      </div>`;
  }

  function renderChatMessageHtml(m) {
    const isMe = m.sender === myTag;
    const timeStr = formatTime(m.timestamp);
    const mediaHtml = m.location ? renderLocationHtml(m) : (m.media || m.transferId) ? renderChatMediaHtml(m, isMe) : '';
    const tick = !isMe ? '' : m.status === 'READ' ? '<span class="text-sky-300 font-bold ml-0.5">✓✓</span>'
      : m.status === 'DELIVERED' ? '<span class="text-indigo-200 font-bold ml-0.5">✓✓</span>'
      : '<span class="text-indigo-200 font-bold ml-0.5">✓</span>';
    const reactions = m.reactions ? Object.values(m.reactions).join(' ') : '';
    return `
        <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} my-0.5">
          <div class="max-w-[80%] rounded-2xl ${mediaHtml ? 'px-1.5 pt-1.5 pb-1' : 'px-3 py-1.5'} shadow-sm ${isMe ? 'bg-indigo-600 text-white rounded-tr-xs' : 'bg-slate-800 border border-slate-700/60 text-slate-100 rounded-tl-xs'}">
            ${m.forwarded ? '<span class="text-[9px] italic opacity-70 block px-1.5">↪ Encaminhada</span>' : ''}
            ${mediaHtml}
            ${m.text && !m.location ? `<p class="text-[13px] leading-snug break-words select-text ${mediaHtml ? 'px-1.5 pt-1' : ''}">${escapeHtml(m.text)}</p>` : ''}
            <div class="flex items-center justify-end gap-1 mt-0.5 text-[10px] ${isMe ? 'text-indigo-200' : 'text-slate-400'} font-medium select-none ${mediaHtml ? 'px-1.5' : ''}">
              ${reactions ? `<span class="mr-1">${escapeHtml(reactions)}</span>` : ''}
              <span>${timeStr}</span>
              ${tick}
            </div>
          </div>
        </div>`;
  }

  let lastChatRenderPeer = null;
  let chatStickToBottom = true;

  function renderChatMessages(peerTag) {
    const container = document.getElementById('chat-messages-container');
    if (!container || !peerTag) return;

    const msgs = chatMessages[peerTag] || [];
    if (msgs.length === 0) {
      lastChatRenderPeer = null;
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

    // Atualiza só as mensagens que mudaram: assim um vídeo/áudio tocando não reinicia
    // quando chega progresso de outra transferência.
    const peerChanged = lastChatRenderPeer !== peerTag;
    lastChatRenderPeer = peerTag;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    const existing = new Map();
    Array.from(container.children).forEach((el) => {
      if (el.dataset && el.dataset.mid && !peerChanged) existing.set(el.dataset.mid, el);
      else el.remove();
    });
    let added = false;
    let cursor = container.firstChild;
    msgs.forEach((m) => {
      const html = renderChatMessageHtml(m);
      let el = existing.get(m.id);
      existing.delete(m.id);
      if (!el || el._psHtml !== html) {
        if (el) {
          if (el === cursor) cursor = cursor.nextSibling;
          el.remove();
        } else {
          added = true;
        }
        el = document.createElement('div');
        el.dataset.mid = m.id;
        el.innerHTML = html;
        el._psHtml = html;
      }
      if (el === cursor) cursor = cursor.nextSibling;
      else container.insertBefore(el, cursor);
    });
    existing.forEach((el) => el.remove());

    if (peerChanged || nearBottom || added) {
      chatStickToBottom = true;
      container.scrollTop = container.scrollHeight;
    }
  }

  // Imagens/vídeos que terminam de carregar mudam a altura: mantém a conversa no fim
  function initChatAutoScroll() {
    const container = document.getElementById('chat-messages-container');
    if (!container || container._psScrollInit) return;
    container._psScrollInit = true;
    container.addEventListener('scroll', () => {
      chatStickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    }, { passive: true });
    const stick = () => { if (chatStickToBottom) container.scrollTop = container.scrollHeight; };
    container.addEventListener('load', stick, true);
    container.addEventListener('loadedmetadata', stick, true);
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

    updateComposeButtons();
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
  // ==========================================================================
  // 9. BUSCA UNIVERSAL (lupa do topo): usuários/contatos, conversas, trechos de
  //    mensagens e arquivos (mídia do chat, transferências e links públicos).
  //    Usuários fora dos contatos só aparecem se o @tag completo for digitado,
  //    e só viram contato com o toque explícito em "Adicionar".
  // ==========================================================================
  function openGlobalSearchModal(prefill) {
    const modal = document.getElementById('modal-global-search');
    if (!modal) return;
    modal.classList.remove('hidden');
    const input = document.getElementById('input-global-search');
    if (input) {
      input.value = prefill || '';
      setTimeout(() => input.focus(), 200);
      renderGlobalSearchResults(input.value);
    }
  }

  function closeGlobalSearchModal() {
    const modal = document.getElementById('modal-global-search');
    if (modal) modal.classList.add('hidden');
  }

  function foldText(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Trecho com o termo destacado (texto já escapado)
  function snippetAround(text, q, radius = 38) {
    const raw = String(text || '');
    const idx = foldText(raw).indexOf(q);
    if (idx < 0) return escapeHtml(raw.slice(0, radius * 2));
    const start = Math.max(0, idx - radius);
    const end = Math.min(raw.length, idx + q.length + radius);
    return (start > 0 ? '…' : '') + escapeHtml(raw.slice(start, idx)) +
      '<mark class="bg-amber-500/30 text-amber-200 rounded px-0.5">' + escapeHtml(raw.slice(idx, idx + q.length)) + '</mark>' +
      escapeHtml(raw.slice(idx + q.length, end)) + (end < raw.length ? '…' : '');
  }

  function searchSection(title, count, rowsHtml) {
    if (!count) return '';
    return `
      <div class="space-y-1.5">
        <div class="flex items-center justify-between px-1">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${title}</span>
          <span class="text-[10px] font-mono text-slate-500">${count}</span>
        </div>
        ${rowsHtml}
      </div>`;
  }

  function avatarFor(tag, size) {
    if (isOfficialTag(tag)) return officialAvatarHtml();
    const c = getContacts()[tag];
    const p = peerRegistry[tag];
    return (c && c.avatar) || (p && p.avatar) || (typeof PulseShareCrypto !== 'undefined' ? PulseShareCrypto.generateIdenticonSvg(tag, size || 40) : '');
  }

  // Busca de um nome sem sufixo: pergunta à rede (1x a cada 30 s por nome) e
  // redesenha a busca quando a resposta chegar, se o termo ainda for o mesmo.
  const searchNameLookups = {}; // nome -> { at, found, pending }
  let searchLookupTimer = null;
  function searchLookupName(name, rawQ) {
    const st = searchNameLookups[name];
    if (st && st.pending) return `Procurando "${name}" na rede...`;
    if (st && Date.now() - st.at < 30000) return st.found ? '' : `Nenhum usuário "${name}" foi visto na rede. Confira o nome ou peça o @usuário completo.`;
    if (!brokersOnline()) return 'Sem conexão para procurar esse nome na rede.';
    // Espera parar de digitar para não perguntar "ri", "ric", "rica"...
    clearTimeout(searchLookupTimer);
    searchLookupTimer = setTimeout(() => {
      searchNameLookups[name] = { at: Date.now(), pending: true };
      probeName(name, '').then((res) => {
        searchNameLookups[name] = { at: Date.now(), found: res.taken };
        const input = document.getElementById('input-global-search');
        const modal = document.getElementById('modal-global-search');
        if (input && modal && !modal.classList.contains('hidden') && input.value.trim() === rawQ.trim()) renderGlobalSearchResults(input.value);
      });
    }, 700);
    return `Procurando "${name}" na rede...`;
  }

  function renderGlobalSearchResults(query) {
    const resultsContainer = document.getElementById('global-search-results');
    if (!resultsContainer) return;
    const rawQ = String(query || '').trim();
    const q = foldText(rawQ);
    const contacts = getContacts();
    const LIMIT = 25;

    // Sem termo: atalhos + contatos
    if (!q) {
      const tags = Object.keys(contacts).filter((t) => !isMyTag(t)).slice(0, LIMIT);
      resultsContainer.innerHTML = `
        <p class="text-[11px] text-slate-500 px-1">Digite para buscar em conversas, mensagens, arquivos e contatos. Para adicionar alguém, digite o nome de usuário (ou o <span class="font-mono text-indigo-300">@usuário</span> completo).</p>
        ${searchSection('👤 Contatos', tags.length, tags.map((t) => userRowHtml(t, contacts[t].name, true)).join(''))}`;
      bindSearchResultEvents(resultsContainer);
      return;
    }

    // 1) Usuários: contatos + conversas existentes que casam com nome/tag
    const userTags = new Set();
    Object.keys(contacts).forEach((t) => {
      if (!isMyTag(t) && (foldText(t).includes(q) || foldText(contacts[t].name).includes(q))) userTags.add(t);
    });
    Object.keys(chatMessages).forEach((t) => {
      if (!isMyTag(t) && !isBlocked(t) && (foldText(t).includes(q) || foldText(displayNameFor(t)).includes(q))) userTags.add(t);
    });
    let usersHtml = Array.from(userTags).slice(0, LIMIT).map((t) => userRowHtml(t, (contacts[t] && contacts[t].name) || displayNameFor(t), isContact(t))).join('');
    let usersCount = userTags.size;
    // Usuário digitado (tag completa @nome_hash6 ou só o nome) → oferecer "Adicionar".
    // Só o nome: resolve pelo catálogo de nomes da rede (e pergunta à rede se não souber).
    const typed = rawQ.toLowerCase().replace(/\s+/g, '').replace(/^@/, '');
    let typedTag = '';
    let typedHint = '';
    if (/^[a-z0-9_]{2,40}$/.test(typed) && !typed.startsWith('link_')) {
      if (splitTag('@' + typed)) {
        typedTag = '@' + typed;
      } else {
        const owner = registryOwnerOf(typed);
        if (owner) typedTag = `@${typed}_${owner.s}`;
        else typedHint = searchLookupName(typed, rawQ);
      }
    }
    if (typedTag && !isMyTag(typedTag) && !isContact(typedTag) && !userTags.has(typedTag)) {
      const seen = peerRegistry[typedTag];
      const online = Boolean(seen && Date.now() - (seen.lastSeen || 0) < 60000);
      usersHtml = `
        <div class="p-3 rounded-xl bg-slate-950 border border-dashed border-indigo-500/50 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-9 h-9 rounded-xl overflow-hidden shrink-0 border border-slate-800 bg-slate-900">${avatarFor(typedTag, 40)}</div>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate font-mono">${escapeHtml(typedTag)}</span>
              <span class="text-[10px] ${online ? 'text-emerald-400' : 'text-slate-500'} block">${online ? '● online agora' : 'offline — a mensagem é entregue quando os dois estiverem online'}</span>
            </div>
          </div>
          <button type="button" data-search-add="${escapeHtml(typedTag)}" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold shadow shrink-0">+ Adicionar</button>
        </div>` + usersHtml;
      usersCount++;
    } else if (typedHint && !usersCount) {
      usersHtml = `<p class="text-[11px] text-slate-500 px-1">${escapeHtml(typedHint)}</p>`;
    }

    // 2) Mensagens (trechos) e 3) Arquivos
    const msgRows = [];
    const fileRows = [];
    const fileSeen = new Set();
    let msgCount = 0;
    let fileCount = 0;
    Object.keys(chatMessages).forEach((peer) => {
      if (isBlocked(peer)) return;
      (chatMessages[peer] || []).forEach((m) => {
        if (m.text && foldText(m.text).includes(q)) {
          msgCount++;
          if (msgRows.length < LIMIT) msgRows.push({ peer, m });
        }
        const fname = m.media && (m.media.fileName || m.media.name);
        if (fname && foldText(fname).includes(q)) {
          const tid = m.transferId || m.media.transferId;
          if (tid) fileSeen.add(tid);
          fileCount++;
          if (fileRows.length < LIMIT) fileRows.push({ kind: 'chat', peer, m, name: fname, size: m.media.size || m.media.fileSize, ts: m.timestamp });
        }
      });
    });
    Object.values(transfers).forEach((t) => {
      if (!t.fileName || fileSeen.has(t.id) || !foldText(t.fileName).includes(q)) return;
      fileCount++;
      if (fileRows.length < LIMIT) fileRows.push({ kind: 'transfer', t, name: t.fileName, size: t.totalBytes, ts: t.startTime, peer: t.target || t.sender });
    });
    Object.values(publicShares).forEach((sh) => {
      (sh.files || []).forEach((f) => {
        if (!foldText(f.name).includes(q)) return;
        fileCount++;
        if (fileRows.length < LIMIT) fileRows.push({ kind: 'share', share: sh, name: f.name, size: f.size, ts: sh.createdAt });
      });
    });
    msgRows.sort((a, b) => (b.m.timestamp || 0) - (a.m.timestamp || 0));
    fileRows.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const msgsHtml = msgRows.map(({ peer, m }) => `
      <div data-search-msg="${escapeHtml(peer)}" data-mid="${escapeHtml(m.id)}" class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 cursor-pointer flex items-start gap-2.5">
        <div class="w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-slate-800 bg-slate-900">${avatarFor(peer, 32)}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-bold text-white truncate">${escapeHtml(displayNameFor(peer))}${m.sender === myTag ? ' <span class="text-slate-500 font-normal">(você)</span>' : ''}</span>
            <span class="text-[10px] text-slate-500 font-mono shrink-0">${formatTime(m.timestamp)}</span>
          </div>
          <p class="text-[11px] text-slate-300 break-words">${snippetAround(m.text, q)}</p>
        </div>
      </div>`).join('');

    const filesHtml = fileRows.map((r) => {
      const where = r.kind === 'share' ? '🔗 Link público' : r.kind === 'transfer' ? (r.t.type === 'send' ? '📤 Enviado' : '📥 Recebido') + (r.peer ? ' • ' + escapeHtml(displayNameFor(r.peer)) : '') : '💬 ' + escapeHtml(displayNameFor(r.peer));
      const attrs = r.kind === 'chat' ? `data-search-msg="${escapeHtml(r.peer)}" data-mid="${escapeHtml(r.m.id)}"`
        : r.kind === 'share' ? 'data-search-tab="shares"' : 'data-search-tab="transfers"';
      return `
      <div ${attrs} class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 cursor-pointer flex items-center gap-2.5">
        <div class="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 text-sm">📎</div>
        <div class="min-w-0 flex-1">
          <span class="text-[11px] font-bold text-white block truncate">${snippetAround(r.name, q, 60)}</span>
          <span class="text-[10px] text-slate-500 block truncate">${where}${r.size ? ' • ' + formatBytes(r.size) : ''}${r.ts ? ' • ' + formatTime(r.ts) : ''}</span>
        </div>
      </div>`;
    }).join('');

    const html = searchSection('👤 Usuários', usersCount, usersHtml) +
      searchSection('💬 Mensagens', msgCount, msgsHtml) +
      searchSection('📎 Arquivos', fileCount, filesHtml);
    resultsContainer.innerHTML = html || `<div class="text-center py-8 text-slate-500 text-xs">Nada encontrado para "${escapeHtml(rawQ)}".</div>`;
    bindSearchResultEvents(resultsContainer);
  }

  function userRowHtml(tag, name, contact) {
    const msgs = chatMessages[tag] || [];
    const last = msgs[msgs.length - 1];
    const sub = last ? escapeHtml(messageSummary(last).slice(0, 50)) : escapeHtml(tag);
    return `
      <div data-start-chat-target="${escapeHtml(tag)}" class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-indigo-500 transition-colors flex items-center justify-between gap-2 cursor-pointer">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-xl overflow-hidden shrink-0 border border-slate-800 bg-slate-900">${avatarFor(tag, 40)}</div>
          <div class="min-w-0">
            <span class="text-xs font-bold text-white block truncate">${escapeHtml(name || tag)}</span>
            <span class="text-[10px] text-slate-400 block truncate">${sub}</span>
          </div>
        </div>
        ${isOfficialTag(tag) ? '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shrink-0">✔ Oficial</span>' : contact ? routeBadgeHtml(tag) : `<button type="button" data-search-add="${escapeHtml(tag)}" class="px-2 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-bold shrink-0">+ Adicionar</button>`}
      </div>`;
  }

  function bindSearchResultEvents(root) {
    root.querySelectorAll('[data-search-add]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const tag = btn.getAttribute('data-search-add');
        if (addContact(tag)) {
          Native.toast(`${tag} adicionado aos contatos`);
          closeGlobalSearchModal();
          switchTab('chat');
          openActiveChat(tag);
        }
      };
    });
    root.querySelectorAll('[data-start-chat-target]').forEach((el) => {
      el.onclick = () => {
        closeGlobalSearchModal();
        switchTab('chat');
        openActiveChat(el.getAttribute('data-start-chat-target'));
      };
    });
    root.querySelectorAll('[data-search-msg]').forEach((el) => {
      el.onclick = () => {
        closeGlobalSearchModal();
        switchTab('chat');
        openActiveChat(el.getAttribute('data-search-msg'));
        scrollToChatMessage(el.getAttribute('data-mid'));
      };
    });
    root.querySelectorAll('[data-search-tab]').forEach((el) => {
      el.onclick = () => {
        closeGlobalSearchModal();
        switchTab(el.getAttribute('data-search-tab'));
      };
    });
  }

  // Rola a conversa até a mensagem encontrada e a destaca por instantes
  function scrollToChatMessage(mid) {
    if (!mid) return;
    setTimeout(() => {
      const container = document.getElementById('chat-messages-container');
      if (!container) return;
      const el = Array.from(container.children).find((c) => c.dataset && c.dataset.mid === mid);
      if (!el) return;
      chatStickToBottom = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('search-hit');
      setTimeout(() => el.classList.remove('search-hit'), 2200);
    }, 350);
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
    const current = getContacts()[activeMenuTargetTag];
    const name = prompt('Nome para o contato:', (current && current.name) || (peer && peer.name) || activeMenuTargetTag.replace(/^@/, '').split('_')[0]);
    if (name) {
      addContact(activeMenuTargetTag, name.trim());
      Native.toast('Contato salvo com sucesso!');
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
      (chatMessages[activeMenuTargetTag] || []).forEach((m) => deleteChatMedia(m.transferId || (m.media && m.media.transferId)));
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
    const loginLink = texts.find(t => /^pulseshare:\/\/login\?/i.test(t.trim()));
    if (loginLink) { handleScannedQr(loginLink.trim()); return; }
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
                <button type="button" data-ps-call="acceptTransfer" data-ps-args="${t.id}" class="text-emerald-400 font-bold hover:underline">Aceitar</button>
              ` : ''}
              ${(!isSend && (t.status === 'error' || t.status === 'cancelled')) ? `
                <button type="button" data-ps-call="acceptTransfer" data-ps-args="${t.id}" class="text-indigo-400 font-bold hover:underline">Tentar de novo</button>
              ` : ''}
              ${t.savedPath ? `
                <button type="button" data-ps-call="downloadChatMedia" data-ps-args="${t.id}" class="text-emerald-400 font-bold hover:underline">${Native.isAvailable() ? 'Abrir' : 'Salvar'}</button>
              ` : ''}
              ${isActive ? `
                <button type="button" data-ps-call="cancelTransfer" data-ps-args="${t.id}" class="text-rose-400 font-bold hover:underline">${(!isSend && t.status === 'awaiting_accept') ? 'Recusar' : 'Cancelar'}</button>
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

    const contacts = getContacts();
    const now = Date.now();
    const tags = Object.keys(contacts).filter((t) => !isMyTag(t));
    if (tags.length === 0) {
      list.innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">Nenhum contato adicionado.<br/>Toque em <b>+ Adicionar</b> e informe o @usuário de quem você quer conversar.</div>';
      return;
    }
    const isOnline = (t) => {
      const p = peerRegistry[t];
      return Boolean((p && now - (p.lastSeen || 0) < 45000) || isBleNeighbor(t));
    };
    tags.sort((a, b) => (isOnline(b) - isOnline(a)) || a.localeCompare(b));

    list.innerHTML = tags.map((tag) => {
      const c = contacts[tag];
      const p = peerRegistry[tag];
      const online = isOnline(tag);
      return `
        <div class="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-lg overflow-hidden shrink-0">${c.avatar || (p && p.avatar) || ''}</div>
            <div class="min-w-0">
              <span class="text-xs font-bold text-white block truncate">${escapeHtml(c.name || tag)} <span class="${online ? 'text-emerald-400' : 'text-slate-600'}">●</span></span>
              <span class="text-[10px] font-mono text-slate-400 block truncate">${tag}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            ${routeBadgeHtml(tag)}
            <button type="button" data-mesh-chat="${tag}" class="px-2.5 py-1 rounded bg-indigo-600 text-white text-xs font-bold active:scale-95">Conversar</button>
          </div>
        </div>
      `;
    }).join('') + `
      <div class="pt-2 text-[10px] text-slate-500 text-center">
        Nó de rota: ${meshRelay ? 'ativo' : 'desativado'} • pontes BLE→internet ${relayCounters.bridgedToInternet} • internet→BLE ${relayCounters.bridgedToBle} • vizinhos BLE ${freshBleNeighbors().length}
      </div>`;
    list.querySelectorAll('[data-mesh-chat]').forEach((btn) => {
      btn.onclick = () => { switchTab('chat'); openActiveChat(btn.getAttribute('data-mesh-chat')); };
    });
  }

  function openSendModal(mode) {
    modalMode = mode || 'p2p';
    document.getElementById('modal-send').classList.remove('hidden');
    document.getElementById('field-target-user').classList.toggle('hidden', modalMode !== 'p2p');
    document.getElementById('field-link-options').classList.toggle('hidden', modalMode === 'p2p');
  }

  // ==========================================================================
  // 14. CONTA (entrada/login, chave de acesso, .txt), QR CODE, FOTO DO PERFIL,
  //     NOTIFICAÇÕES E SEGUNDO PLANO
  // ==========================================================================

  // ---------- utilitários ----------
  function isSafeImageDataUrl(u) {
    return typeof u === 'string' && u.length < 120000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u);
  }

  function imgHtml(dataUrl) {
    return isSafeImageDataUrl(dataUrl) ? `<img class="ps-avatar-img" src="${dataUrl}" alt="" />` : '';
  }

  async function shortSha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(buf)).slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  // Salva um arquivo no dispositivo que pediu (Android: Download/<pasta>; PC: download do navegador)
  function saveTextFileOnDevice(fileName, text) {
    if (IS_ANDROID) {
      const path = Native.saveFile(fileName, utf8ToBase64(text), 'text/plain');
      Native.toast(path ? `Arquivo salvo em ${path}` : 'Não foi possível salvar o arquivo.');
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    Native.toast('Arquivo .txt baixado.');
  }

  async function buildRecoveryText(profile) {
    const key = await PulseShareCrypto.wordsToAccessKey(profile.seedWords);
    return [
      'PulseShare — Recuperação de conta',
      '==================================',
      '',
      `Usuário: ${profile.tag}`,
      `Nome: ${profile.name}`,
      `Chave de acesso: ${key || '(indisponível)'}`,
      `7 palavras: ${profile.seedWords}`,
      '',
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      '',
      'Guarde este arquivo em local seguro. Quem tiver a chave de acesso ou as',
      '7 palavras entra na sua conta. Para entrar: abra o PulseShare e use',
      '"Entrar com a chave de acesso", "Usar as 7 palavras" ou "Importar arquivo .txt".',
      ''
    ].join('\n');
  }

  async function exportRecoveryTxt(profile) {
    if (!profile) return;
    const text = await buildRecoveryText(profile);
    saveTextFileOnDevice(`pulseshare-recuperacao-${profile.tag.replace(/^@/, '')}.txt`, text);
  }

  // ---------- backup completo do aparelho (contas, conversas, contatos) ----------
  // Serve para levar tudo de um aparelho para outro (ex.: extensão do Chrome → app
  // de desktop). Contém as chaves das contas: quem tiver o arquivo entra nelas.
  // A mídia do chat (IndexedDB) não vai junto. ps_node_id não vai (é do aparelho).
  const BACKUP_SKIP_KEYS = new Set(['ps_node_id', 'ps_live_account_id', 'ps_legacy_migrated', 'ps_background_mode',
    'ps_download_folder']);

  function buildDeviceBackup() {
    saveChatMessagesToStorage();
    const accounts = {};
    const live = localStorage.getItem(LIVE_ACCOUNT_KEY) || accountStoreId(rawActiveProfile());
    const device = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('ps_')) continue;
      const m = k.match(/^ps_acct_(k[0-9a-f]+)__(.+)$/);
      if (m) {
        if (m[2] === 'ps_node_id') continue;
        (accounts[m[1]] = accounts[m[1]] || {})[m[2]] = localStorage.getItem(k);
      } else if (ACCOUNT_SCOPED_KEYS.includes(k)) {
        if (k === 'ps_node_id' || !live) continue;
        (accounts[live] = accounts[live] || {})[k] = localStorage.getItem(k);
      } else if (!BACKUP_SKIP_KEYS.has(k)) {
        device[k] = localStorage.getItem(k);
      }
    }
    return {
      format: 'pulseshare-backup', v: 1, createdAt: Date.now(),
      from: IS_ANDROID ? 'android' : IS_DESKTOP ? 'desktop' : IS_EXTENSION ? 'extension' : 'web',
      activeProfileId: localStorage.getItem('ps_active_profile_id_v2') || '',
      accounts, device
    };
  }

  async function exportDeviceBackup() {
    if (!confirm('O backup leva TODAS as contas deste aparelho com as chaves de acesso, conversas e contatos.\n\nQuem tiver o arquivo entra nas suas contas: guarde-o em local seguro e apague depois de usar.\n\nContinuar?')) return;
    const data = JSON.stringify(buildDeviceBackup());
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    saveTextFileOnDevice(`pulseshare-backup-${stamp}.json`, data);
  }

  // Junta dois valores JSON sem perder nada do aparelho: listas viram união
  // (mensagens pelo id), objetos juntam as chaves (o que já existe aqui vence).
  function mergeJsonValues(mine, theirs) {
    if (Array.isArray(mine) && Array.isArray(theirs)) {
      const keyOf = (x) => (x && typeof x === 'object' && x.id) ? 'id:' + x.id : 'v:' + JSON.stringify(x);
      const seen = new Set(mine.map(keyOf));
      const out = mine.slice();
      theirs.forEach((x) => { const k = keyOf(x); if (!seen.has(k)) { seen.add(k); out.push(x); } });
      if (out.some((x) => x && typeof x === 'object' && x.timestamp)) {
        out.sort((a, b) => (Number(a && a.timestamp) || 0) - (Number(b && b.timestamp) || 0));
      }
      return out;
    }
    if (mine && theirs && typeof mine === 'object' && typeof theirs === 'object' && !Array.isArray(mine) && !Array.isArray(theirs)) {
      const out = Object.assign({}, mine);
      Object.keys(theirs).forEach((k) => {
        out[k] = Object.prototype.hasOwnProperty.call(mine, k) ? mergeJsonValues(mine[k], theirs[k]) : theirs[k];
      });
      return out;
    }
    return mine === undefined || mine === null ? theirs : mine;
  }

  function mergeStoredValue(key, incoming) {
    if (incoming === null || incoming === undefined) return;
    const cur = localStorage.getItem(key);
    if (cur === null) { localStorage.setItem(key, incoming); return; }
    try {
      localStorage.setItem(key, JSON.stringify(mergeJsonValues(JSON.parse(cur), JSON.parse(incoming))));
    } catch (e) { /* valor simples (texto): fica o deste aparelho */ }
  }

  function importDeviceBackup(text) {
    let b;
    try { b = JSON.parse(text); } catch (e) { b = null; }
    if (!b || b.format !== 'pulseshare-backup' || !b.accounts) throw new Error('Esse arquivo não é um backup do PulseShare.');
    const theirProfiles = (() => { try { return JSON.parse((b.device || {}).ps_profiles_v2 || '[]') || []; } catch (e) { return []; } })();
    if (!theirProfiles.length) throw new Error('O backup não tem nenhuma conta.');
    const names = theirProfiles.map((p) => p.tag || p.name).filter(Boolean).join(', ');
    if (!confirm(`Importar o backup?\n\nContas: ${names}\n\nAs conversas e os contatos são juntados aos deste aparelho (nada daqui é apagado).`)) return false;
    saveChatMessagesToStorage();
    // 1) perfis (chaves) que este aparelho ainda não tem
    const mine = rawProfiles();
    const have = new Set(mine.map((p) => p.pubKeyHex));
    theirProfiles.forEach((p) => { if (p && p.pubKeyHex && !have.has(p.pubKeyHex)) { mine.push(p); have.add(p.pubKeyHex); } });
    localStorage.setItem('ps_profiles_v2', JSON.stringify(mine));
    // 2) dados de cada conta: na conta ao vivo ou guardados (ps_acct_…)
    const live = localStorage.getItem(LIVE_ACCOUNT_KEY) || '';
    Object.keys(b.accounts).forEach((acct) => {
      if (!/^k[0-9a-f]+$/.test(acct)) return;
      const data = b.accounts[acct] || {};
      ACCOUNT_SCOPED_KEYS.forEach((k) => {
        if (k === 'ps_node_id' || !(k in data)) return;
        mergeStoredValue(acct === live ? k : accountStoreKey(acct, k), data[k]);
      });
    });
    // 3) catálogo de nomes e preferências que este aparelho ainda não tem
    const dev = b.device || {};
    Object.keys(dev).forEach((k) => {
      if (!/^ps_[a-z0-9_]+$/.test(k) || k === 'ps_profiles_v2' || k === 'ps_active_profile_id_v2' || BACKUP_SKIP_KEYS.has(k)) return;
      if (k === 'ps_name_registry_v1') mergeStoredValue(k, dev[k]);
      else if (localStorage.getItem(k) === null) localStorage.setItem(k, dev[k]);
    });
    // 4) sem conta ativa aqui: entra na que estava ativa no backup
    if (!activeProfile) {
      const act = theirProfiles.find((p) => p.id === b.activeProfileId) || theirProfiles[0];
      const target = mine.find((p) => p.pubKeyHex === act.pubKeyHex);
      if (target) localStorage.setItem('ps_active_profile_id_v2', target.id);
    }
    return true;
  }

  function pickBackupAndImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      f.text().then((text) => {
        try {
          if (importDeviceBackup(text)) {
            Native.toast('Backup importado. Recarregando...');
            if (Native.isBleAvailable()) Native.stopBleMesh();
            setTimeout(() => location.reload(), 600);
          }
        } catch (e) {
          alert(e && e.message ? e.message : String(e));
        }
      }).catch(() => Native.toast('Não foi possível ler o arquivo.'));
    };
    input.click();
  }

  // Lê chave / palavras / nome de um texto (arquivo .txt, QR Code ou campo colado)
  function parseLoginText(text) {
    const t = String(text || '');
    const out = { key: '', words: '', name: '' };
    const k = /ps-?[0-9a-f]{5}-?[0-9a-f]{5}-?[0-9a-f]{5}-?[0-9a-f]{5}/i.exec(t);
    if (k) out.key = k[0].toLowerCase();
    const w = /7 palavras:\s*([a-zà-ú\s]+)/i.exec(t);
    if (w) out.words = w[1].trim().split(/\s+/).slice(0, 7).join(' ');
    const n = /(?:^|\n)Nome:\s*([^\n]+)/i.exec(t) || /[?&]n=([^&\s]+)/.exec(t);
    if (n) { try { out.name = decodeURIComponent(n[1]).trim(); } catch (e) { out.name = n[1].trim(); } }
    // Formato antigo de pareamento (JSON com seedWords)
    try {
      const j = JSON.parse(t);
      if (j && j.seedWords) { out.words = j.seedWords; out.name = out.name || j.name || ''; }
    } catch (e) {}
    return out;
  }

  // ---------- entrada / login ----------
  function onbStatus(msg, tone) {
    const el = document.getElementById('onb-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'text-center text-[11px] ' + (tone === 'info' ? 'text-slate-300' : 'text-rose-400') + (msg ? '' : ' hidden');
    // Com o teclado aberto o aviso (no fim da tela) ficava fora da vista
    if (msg) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
  }

  function showOnboarding() {
    document.getElementById('view-onboarding').classList.remove('hidden');
  }

  // Cria/ativa o perfil a partir das palavras e reinicia o app já logado.
  // Antes de salvar, consulta a rede: o NOME não pode pertencer a outra conta.
  // opts.isNew = conta recém-criada (exige rede); opts.showKeyFirst = não recarrega;
  // opts.status = função para mostrar o andamento.
  async function loginWithWords(words, name, opts = {}) {
    const status = opts.status || onbStatus;
    const chk = PulseShareCrypto.checkMnemonic ? PulseShareCrypto.checkMnemonic(words) : null;
    if (chk && !chk.words) {
      if (chk.unknown.length) throw new Error(`Palavra${chk.unknown.length > 1 ? 's' : ''} fora da lista do PulseShare: ${chk.unknown.slice(0, 4).join(', ')}. Confira a grafia.`);
      throw new Error(`São 7 palavras — você digitou ${chk.count}.`);
    }
    words = chk ? chk.words : String(words || '').trim().toLowerCase().split(/\s+/).join(' ');
    if (!PulseShareCrypto.isValidMnemonic(words)) throw new Error('As 7 palavras não conferem com a lista do PulseShare.');
    let cleanName = cleanUsername(name || '');
    if (cleanName) {
      const ruleErr = nameRuleError(cleanName);
      if (ruleErr) throw new Error('Nome: ' + ruleErr);
    } else if (opts.isNew) {
      throw new Error('Escolha um nome de usuário.');
    }
    let prof = await PulseShareCrypto.deriveIdentity(cleanName || 'usuario', words);
    const suffix = prof.pubKeyHex.slice(0, 6);
    const deletedErr = 'Esta conta foi excluída pelo administrador do PulseShare.';
    if (adminDeleted.has(suffix)) {
      // Pode ter sido restaurada depois: confere com a rede antes de recusar
      status('Verificando a conta na rede...', 'info');
      if (await ensureNetworkForProbe()) {
        requestAdminState(true);
        await new Promise((r) => setTimeout(r, 3500));
      }
      status('');
      if (adminDeleted.has(suffix)) throw new Error(deletedErr);
    }

    // Conta já salva neste aparelho: só ativa (o nome dela já foi verificado)
    const existing = PulseShareCrypto.ProfilesManager.getAllProfiles().find((p) => p.pubKeyHex === prof.pubKeyHex);
    if (existing && (!cleanName || cleanName === cleanUsername(existing.name))) {
      PulseShareCrypto.ProfilesManager.switchProfile(existing.id);
      if (opts.showKeyFirst) return existing;
      location.reload();
      return existing;
    }

    status(cleanName ? `Verificando se o nome "${cleanName}" está livre na rede...` : 'Procurando o nome desta conta na rede...', 'info');
    const online = await ensureNetworkForProbe();
    if (!online && (opts.isNew || !cleanName)) {
      status('');
      throw new Error(opts.isNew
        ? 'Sem conexão com a rede: não dá para verificar se o nome está livre. Tente de novo quando estiver online.'
        : 'Sem conexão com a rede: digite o seu nome de usuário para entrar.');
    }
    const res = await probeName(cleanName, suffix);
    status('');
    if (adminDeleted.has(suffix)) throw new Error(deletedErr);
    if (!cleanName) {
      if (!res.knownName) throw new Error('Não encontramos o nome desta conta na rede (nenhum aparelho dela online). Digite o seu nome de usuário.');
      cleanName = res.knownName;
      prof = await PulseShareCrypto.deriveIdentity(cleanName, words);
    } else if (res.taken) {
      throw new Error(`O nome "${cleanName}" já está em uso por ${res.ownerTag}. Escolha outro.`);
    }
    prof.nameSince = (res.knownName === cleanName && res.knownSince) || Date.now();

    if (existing) {
      // Mesma conta, nome novo digitado no login: atualiza o perfil salvo
      const updated = { ...existing, name: prof.name, tag: prof.tag, nameSince: prof.nameSince };
      PulseShareCrypto.ProfilesManager.saveProfile(updated);
      PulseShareCrypto.ProfilesManager.switchProfile(existing.id);
    } else {
      prof.id = 'prof_' + Date.now();
      PulseShareCrypto.ProfilesManager.saveProfile(prof);
      PulseShareCrypto.ProfilesManager.switchProfile(prof.id);
    }

    // Avisa a rede do nome registrado (todos atualizam o catálogo)
    noteTagClaim(prof.tag, prof.nameSince, Date.now());
    if (res.knownName !== cleanName) {
      broadcastToMesh({ meshType: 'USER_REGISTERED', tag: prof.tag, nodeId, since: prof.nameSince, registeredAt: Date.now(), regHash: prof.regHash });
    }
    if (opts.showKeyFirst) return prof;
    await new Promise((r) => setTimeout(r, 400)); // deixa o anúncio sair antes de recarregar
    location.reload();
    return prof;
  }

  async function loginWithKey(key, name) {
    const words = await PulseShareCrypto.accessKeyToWords(key);
    if (!words) throw new Error('Chave de acesso inválida (confira os dígitos).');
    return loginWithWords(words, name);
  }

  async function loginFromParsed(parsed) {
    if (parsed.key) return loginWithKey(parsed.key, parsed.name);
    if (parsed.words) return loginWithWords(parsed.words, parsed.name);
    throw new Error('Nenhuma chave de acesso ou 7 palavras encontradas.');
  }

  function pickTextFile(cb) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      f.text().then(cb).catch(() => Native.toast('Não foi possível ler o arquivo.'));
    };
    input.click();
  }

  function initOnboardingEvents() {
    // Um login por vez: a consulta do nome na rede leva alguns segundos e tocar de
    // novo no botão disparava vários logins ao mesmo tempo
    let onbBusy = false;
    const busyButtons = ['onb-btn-login-key', 'onb-btn-login-words', 'onb-btn-create', 'onb-btn-import-txt', 'onb-btn-scan'];
    const run = async (fn, btnId) => {
      if (onbBusy) return;
      onbBusy = true;
      const btn = btnId && document.getElementById(btnId);
      const label = btn ? btn.textContent : '';
      busyButtons.forEach((id) => { const b = document.getElementById(id); if (b) { b.disabled = true; b.classList.add('opacity-60'); } });
      if (btn) btn.textContent = 'Aguarde...';
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // fecha o teclado
      onbStatus('');
      try { await fn(); } catch (e) { onbStatus(e && e.message ? e.message : String(e)); } finally {
        onbBusy = false;
        busyButtons.forEach((id) => { const b = document.getElementById(id); if (b) { b.disabled = false; b.classList.remove('opacity-60'); } });
        if (btn) btn.textContent = label;
      }
    };
    document.getElementById('onb-btn-login-key').onclick = () => run(() => loginWithKey(
      document.getElementById('onb-access-key').value, document.getElementById('onb-access-name').value), 'onb-btn-login-key');
    document.getElementById('onb-btn-words').onclick = () => {
      const box = document.getElementById('onb-words-box');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) {
        try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
        document.getElementById('onb-words').focus();
      }
    };
    document.getElementById('onb-btn-login-words').onclick = () => run(async () => {
      const nameEl = document.getElementById('onb-words-name');
      try {
        await loginWithWords(document.getElementById('onb-words').value,
          nameEl.value || document.getElementById('onb-access-name').value);
      } catch (e) {
        // A rede não conhece o nome desta conta: o campo de nome fica logo abaixo
        if (!nameEl.value && /nome de usu/i.test(String(e && e.message))) setTimeout(() => nameEl.focus(), 50);
        throw e;
      }
    }, 'onb-btn-login-words');
    document.getElementById('onb-btn-import-txt').onclick = () => pickTextFile((text) => run(() => loginFromParsed(parseLoginText(text)), 'onb-btn-import-txt'));
    document.getElementById('onb-btn-scan').onclick = () => openQrScanner();
    document.getElementById('onb-btn-import-backup').onclick = () => pickBackupAndImport();
    const btnCreate = document.getElementById('onb-btn-create');
    btnCreate.onclick = () => run(async () => {
      const name = cleanUsername(document.getElementById('onb-new-name').value);
      const ruleErr = nameRuleError(name);
      if (ruleErr) throw new Error('Nome: ' + ruleErr);
      const words = PulseShareCrypto.generate7WordMnemonic();
      const prof = await loginWithWords(words, name, { showKeyFirst: true, isNew: true });
      const key = await PulseShareCrypto.wordsToAccessKey(words);
      document.getElementById('created-access-key').textContent = key;
      document.getElementById('created-seed-words').textContent = words;
      document.getElementById('view-account-created').classList.remove('hidden');
      document.getElementById('btn-created-export').onclick = () => exportRecoveryTxt(prof);
      document.getElementById('btn-created-continue').onclick = () => location.reload();
    }, 'onb-btn-create');
  }

  // ---------- leitor de QR Code (câmera: só no celular) ----------
  let qrScanStream = null;
  let qrScanRaf = 0;
  let qrScanSession = 0;

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'jsQR.js';
      sc.onload = () => resolve(window.jsQR);
      sc.onerror = reject;
      document.head.appendChild(sc);
    });
  }

  function setQrScanStatus(text) {
    const el = document.getElementById('qr-scan-status');
    if (el) el.textContent = text;
  }

  function qrCameraErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return IS_ANDROID
        ? 'Sem permissão para a câmera. Libere em Configurações do Android → Apps → PulseShare → Permissões → Câmera.'
        : 'Sem permissão para a câmera.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Nenhuma câmera encontrada. Cole a chave de acesso abaixo.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'A câmera está em uso por outro app. Feche-o e tente de novo.';
    return 'Não foi possível abrir a câmera: ' + (e && e.message ? e.message : e);
  }

  async function openQrScanner() {
    const modal = document.getElementById('modal-qr-pair-scanner');
    modal.classList.remove('hidden');
    const camBox = document.getElementById('qr-scan-camera-box');
    if (qrScanStream) return; // já aberta
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (camBox) camBox.classList.add('hidden');
      setQrScanStatus('Este dispositivo não tem câmera disponível. Cole a chave de acesso abaixo.');
      return;
    }
    if (camBox) camBox.classList.remove('hidden');
    const myOpen = ++qrScanSession;
    try {
      setQrScanStatus('Abrindo a câmera...');
      const decode = await loadJsQr();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e1) {
        if (e1 && (e1.name === 'NotAllowedError' || e1.name === 'SecurityError')) throw e1;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // webcam simples
      }
      // Fechou o leitor enquanto a câmera abria
      if (myOpen !== qrScanSession || modal.classList.contains('hidden')) { stream.getTracks().forEach((t) => t.stop()); return; }
      qrScanStream = stream;
      const video = document.getElementById('qr-scan-video');
      const facing = (stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings().facingMode) || '';
      // Webcam frontal (computador): espelha só a imagem, a leitura usa o quadro original
      video.classList.toggle('qr-mirror', !IS_ANDROID && facing !== 'environment');
      video.srcObject = stream;
      await video.play();
      setQrScanStatus('Aponte para o QR Code mostrado no outro dispositivo.');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let last = 0;
      let flip = false;
      const tick = (ts) => {
        if (!qrScanStream || myOpen !== qrScanSession) return;
        qrScanRaf = requestAnimationFrame(tick);
        if (ts - last < 150 || video.readyState < 2 || !video.videoWidth) return;
        last = ts;
        // Recorte central quadrado (onde fica a moldura), reduzido para 600 px
        const side = Math.min(video.videoWidth, video.videoHeight);
        const sx = (video.videoWidth - side) / 2;
        const sy = (video.videoHeight - side) / 2;
        const w = Math.min(600, side);
        canvas.width = w;
        canvas.height = w;
        ctx.drawImage(video, sx, sy, side, side, 0, 0, w, w);
        // Alterna normal/invertido (QR claro em tela escura) sem dobrar o custo de cada quadro
        flip = !flip;
        const res = decode(ctx.getImageData(0, 0, w, w).data, w, w, { inversionAttempts: flip ? 'dontInvert' : 'onlyInvert' });
        if (res && res.data) handleScannedQr(res.data);
      };
      qrScanRaf = requestAnimationFrame(tick);
    } catch (e) {
      if (myOpen !== qrScanSession) return;
      if (e && e.name === 'NotFoundError' && camBox) camBox.classList.add('hidden');
      setQrScanStatus(qrCameraErrorText(e));
    }
  }

  function closeQrScanner() {
    qrScanSession++;
    if (qrScanRaf) cancelAnimationFrame(qrScanRaf);
    qrScanRaf = 0;
    if (qrScanStream) qrScanStream.getTracks().forEach((t) => t.stop());
    qrScanStream = null;
    const video = document.getElementById('qr-scan-video');
    if (video) video.srcObject = null;
    document.getElementById('modal-qr-pair-scanner').classList.add('hidden');
  }

  async function handleScannedQr(text) {
    const parsed = parseLoginText(text);
    if (!parsed.key && !parsed.words) {
      setQrScanStatus('Esse QR Code não é de uma conta PulseShare.');
      return;
    }
    closeQrScanner();
    if (activeProfile) {
      const ok = confirm('Entrar nesta conta neste celular? A conta atual continua salva em "Contas neste aparelho".');
      if (!ok) return;
    }
    try {
      await loginFromParsed(parsed);
    } catch (e) {
      Native.toast(e && e.message ? e.message : 'QR inválido');
      onbStatus(e && e.message ? e.message : '');
    }
  }

  async function showMyLoginQr() {
    const area = document.getElementById('qr-code-display-area');
    if (!area || !activeProfile) return;
    if (!area.classList.contains('hidden')) {
      area.classList.add('hidden');
      area.classList.remove('flex');
      return;
    }
    const key = await PulseShareCrypto.wordsToAccessKey(activeProfile.seedWords);
    if (!key) { Native.toast('Este perfil não tem chave de acesso.'); return; }
    const payload = `pulseshare://login?k=${key}&n=${encodeURIComponent(activeProfile.name || '')}`;
    area.innerHTML = PulseShareCrypto.generateQRCodeSVG(payload, 220) +
      '<span class="text-[10px] text-slate-700 font-semibold mt-2 text-center">⚠️ Dá acesso à sua conta. Mostre só para os seus dispositivos.</span>';
    area.classList.remove('hidden');
    area.classList.add('flex');
  }

  // ---------- editor de foto do perfil ----------
  const photoEd = { img: null, url: '', scale0: 1, zoom: 1, tx: 0, ty: 0, pointers: new Map(), pinch: null };
  const ED_STAGE = 280;
  const ED_CROP = 240;
  const ED_OFF = (ED_STAGE - ED_CROP) / 2;

  function pickPhotoFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (f) openPhotoEditor(f);
    };
    input.click();
  }

  function openPhotoEditor(file) {
    document.getElementById('modal-settings').classList.add('hidden');
    const img = document.getElementById('photo-editor-img');
    if (photoEd.url) URL.revokeObjectURL(photoEd.url);
    photoEd.url = URL.createObjectURL(file);
    img.onload = () => {
      photoEd.img = img;
      photoEd.scale0 = Math.max(ED_CROP / img.naturalWidth, ED_CROP / img.naturalHeight);
      photoEd.zoom = 1;
      const s = photoEd.scale0;
      photoEd.tx = (ED_STAGE - img.naturalWidth * s) / 2;
      photoEd.ty = (ED_STAGE - img.naturalHeight * s) / 2;
      document.getElementById('photo-editor-zoom').value = '1';
      applyPhotoTransform();
    };
    img.src = photoEd.url;
    document.getElementById('modal-photo-editor').classList.remove('hidden');
  }

  function clampPhoto() {
    const img = photoEd.img;
    if (!img) return;
    const s = photoEd.scale0 * photoEd.zoom;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    // A área circular de recorte precisa ficar sempre coberta pela imagem
    photoEd.tx = Math.min(ED_OFF, Math.max(ED_OFF + ED_CROP - w, photoEd.tx));
    photoEd.ty = Math.min(ED_OFF, Math.max(ED_OFF + ED_CROP - h, photoEd.ty));
  }

  function applyPhotoTransform() {
    clampPhoto();
    const s = photoEd.scale0 * photoEd.zoom;
    const img = document.getElementById('photo-editor-img');
    img.style.transform = `translate(${photoEd.tx}px, ${photoEd.ty}px) scale(${s})`;
  }

  // Zoom mantendo fixo o ponto (cx, cy) do palco
  function zoomPhotoAt(newZoom, cx, cy) {
    newZoom = Math.min(4, Math.max(1, newZoom));
    const s1 = photoEd.scale0 * photoEd.zoom;
    const s2 = photoEd.scale0 * newZoom;
    photoEd.tx = cx - (cx - photoEd.tx) * (s2 / s1);
    photoEd.ty = cy - (cy - photoEd.ty) * (s2 / s1);
    photoEd.zoom = newZoom;
    document.getElementById('photo-editor-zoom').value = String(newZoom);
    applyPhotoTransform();
  }

  function initPhotoEditorEvents() {
    const stage = document.getElementById('photo-editor-stage');
    const local = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      photoEd.pointers.set(e.pointerId, local(e));
      if (photoEd.pointers.size === 2) {
        const [a, b] = Array.from(photoEd.pointers.values());
        photoEd.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: photoEd.zoom };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!photoEd.pointers.has(e.pointerId)) return;
      const prev = photoEd.pointers.get(e.pointerId);
      const cur = local(e);
      photoEd.pointers.set(e.pointerId, cur);
      if (photoEd.pointers.size === 2 && photoEd.pinch) {
        const [a, b] = Array.from(photoEd.pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomPhotoAt(photoEd.pinch.zoom * (dist / (photoEd.pinch.dist || 1)), (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (photoEd.pointers.size === 1) {
        photoEd.tx += cur.x - prev.x;
        photoEd.ty += cur.y - prev.y;
        applyPhotoTransform();
      }
    });
    const end = (e) => {
      photoEd.pointers.delete(e.pointerId);
      if (photoEd.pointers.size < 2) photoEd.pinch = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      zoomPhotoAt(photoEd.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.x, p.y);
    }, { passive: false });
    document.getElementById('photo-editor-zoom').oninput = (e) => zoomPhotoAt(parseFloat(e.target.value), ED_STAGE / 2, ED_STAGE / 2);
    document.getElementById('btn-photo-editor-close').onclick = () => closePhotoEditor();
    document.getElementById('btn-photo-editor-pick').onclick = () => pickPhotoFile();
    document.getElementById('btn-photo-editor-remove').onclick = () => saveProfilePhoto('');
    document.getElementById('btn-photo-editor-save').onclick = () => {
      if (!photoEd.img) { pickPhotoFile(); return; }
      const s = photoEd.scale0 * photoEd.zoom;
      const out = document.createElement('canvas');
      out.width = 256;
      out.height = 256;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(photoEd.img, (ED_OFF - photoEd.tx) / s, (ED_OFF - photoEd.ty) / s, ED_CROP / s, ED_CROP / s, 0, 0, 256, 256);
      let data = out.toDataURL('image/jpeg', 0.85);
      if (data.length > 60000) data = out.toDataURL('image/jpeg', 0.65);
      saveProfilePhoto(data);
    };
  }

  function closePhotoEditor() {
    document.getElementById('modal-photo-editor').classList.add('hidden');
    if (photoEd.url) URL.revokeObjectURL(photoEd.url);
    photoEd.url = '';
    photoEd.img = null;
    document.getElementById('photo-editor-img').removeAttribute('src');
  }

  async function saveProfilePhoto(dataUrl) {
    if (!activeProfile) return;
    const updated = { ...activeProfile };
    if (dataUrl && isSafeImageDataUrl(dataUrl)) {
      updated.photo = dataUrl;
      updated.photoHash = await shortSha(dataUrl);
    } else {
      delete updated.photo;
      updated.photoHash = '';
    }
    PulseShareCrypto.ProfilesManager.saveProfile(updated);
    activeProfile = updated;
    closePhotoEditor();
    updateIdentityUI();
    announcePresence(); // contatos pedem a foto nova pelo photoHash
    Native.toast(dataUrl ? 'Foto do perfil atualizada.' : 'Foto removida.');
  }

  // ---------- foto dos contatos (troca sob demanda pelo photoHash) ----------
  const avatarRequestedAt = {};
  const avatarRepliedAt = {};

  function maybeRequestPeerPhoto(tag, photoHash) {
    tag = normalizeTag(tag);
    const contacts = getContacts();
    const c = contacts[tag];
    if (!c) return;
    const known = c.photoHash || '';
    const remote = String(photoHash || '').replace(/[^0-9a-f]/g, '');
    if (known === remote) return;
    if (!remote) {
      // O contato removeu a foto
      PulseShareCrypto.ProfilesManager.saveContact(tag, { ...c, photo: '', photoHash: '', avatar: PulseShareCrypto.generateIdenticonSvg(tag, 64) });
      renderConversationsList();
      return;
    }
    if (Date.now() - (avatarRequestedAt[tag] || 0) < 60000) return;
    avatarRequestedAt[tag] = Date.now();
    sendSignal(tag, 'avatar-' + Date.now(), 'AVATAR_REQUEST', { photoHash: remote });
  }

  function handleAvatarRequest(from) {
    if (!activeProfile || !activeProfile.photo) return;
    if (Date.now() - (avatarRepliedAt[from] || 0) < 20000) return;
    avatarRepliedAt[from] = Date.now();
    sendSignal(from, 'avatar-' + Date.now(), 'AVATAR_RESPONSE', { photoHash: activeProfile.photoHash, image: activeProfile.photo });
  }

  async function handleAvatarResponse(from, payload) {
    if (!isContact(from) || !isSafeImageDataUrl(payload.image)) return;
    const hash = await shortSha(payload.image);
    const c = getContacts()[from];
    PulseShareCrypto.ProfilesManager.saveContact(from, { ...c, photo: payload.image, photoHash: hash, avatar: imgHtml(payload.image) });
    if (peerRegistry[from]) peerRegistry[from].avatar = imgHtml(payload.image);
    renderConversationsList();
    renderMeshPeers();
    if (activeChatPeer === from) {
      const slot = document.getElementById('chat-contact-avatar');
      if (slot) slot.innerHTML = imgHtml(payload.image);
    }
  }

  // ---------- notificações ----------
  const notifyAudioCache = {};
  function playNotifySound(sound) {
    if (!sound || sound === 'nenhum') return;
    const name = sound === 'sistema' ? 'pulso' : sound;
    try {
      const a = notifyAudioCache[name] || (notifyAudioCache[name] = new Audio(`sounds/${name}.wav`));
      a.currentTime = 0;
      a.volume = 1;
      a.play().catch(() => {});
    } catch (e) {}
  }

  // Chamado ao receber mensagem/arquivo. Não avisa se a conversa já está aberta na tela.
  function notifyIncoming(from, text, kind) {
    if (!notifyEnabled || isBlocked(from)) return;
    const viewing = !IS_BACKGROUND_PAGE && !document.hidden && activeChatPeer === from;
    if (viewing) return;
    const title = kind === 'file' ? `📎 Arquivo de ${displayNameFor(from)}` : displayNameFor(from);
    Native.notify(title, text || '📎 arquivo', from, kind);
  }

  function renderNotificationSettings() {
    const en = document.getElementById('setting-notify-enabled');
    if (en) en.checked = notifyEnabled;
    const snd = document.getElementById('setting-notify-sound');
    if (snd) snd.value = notifySound;
    const vib = document.getElementById('setting-notify-vibration');
    if (vib) vib.value = notifyVibration;
    const bg = document.getElementById('setting-background-mode');
    if (bg) bg.checked = backgroundMode;
    const hint = document.getElementById('setting-background-hint');
    if (hint) {
      hint.textContent = IS_ANDROID
        ? 'Mantém uma notificação fixa e continua recebendo com o app fechado.'
        : IS_DESKTOP
          ? 'Fechar a janela deixa o PulseShare na bandeja do sistema, recebendo, e ele abre sozinho ao entrar no computador.'
          : IS_EXTENSION
          ? 'Continua recebendo com a janela fechada (enquanto o Chrome estiver aberto).'
          : 'No navegador, recebe apenas com a página aberta.';
    }
  }

  function initNotificationSettingsEvents() {
    document.getElementById('setting-notify-enabled').onchange = (e) => {
      notifyEnabled = e.target.checked;
      localStorage.setItem('ps_notify_enabled', String(notifyEnabled));
      if (notifyEnabled && !IS_ANDROID && !IS_EXTENSION && !IS_DESKTOP && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    };
    document.getElementById('setting-notify-sound').onchange = (e) => {
      notifySound = e.target.value;
      localStorage.setItem('ps_notify_sound', notifySound);
      Native.previewNotification();
    };
    document.getElementById('setting-notify-vibration').onchange = (e) => {
      notifyVibration = e.target.value;
      localStorage.setItem('ps_notify_vibration', notifyVibration);
      Native.previewNotification();
    };
    document.getElementById('btn-notify-test').onclick = () => {
      Native.previewNotification();
      Native.notify('PulseShare', 'Assim chegam as suas notificações 🔔', '', 'test');
    };
    document.getElementById('setting-background-mode').onchange = (e) => {
      backgroundMode = e.target.checked;
      localStorage.setItem('ps_background_mode', String(backgroundMode));
      Native.setBackgroundMode(backgroundMode, true);
    };
    document.getElementById('btn-battery-exemption').onclick = () => Native.requestBatteryExemption();
  }

  // ---------- extensão: uma única conexão por vez (janela visível ou fundo) ----------
  function showOtherWindowOverlay() {
    coreLost = true;
    brokerSockets.forEach((ws) => { try { ws.close(); } catch (e) {} });
    document.getElementById('view-other-window').classList.remove('hidden');
    document.getElementById('btn-use-here').onclick = () => location.reload();
  }

  // A janela do app "rouba" a conexão do documento de fundo; quando ela fecha,
  // o fundo reassume (recarregando para ler o estado mais novo do localStorage).
  function acquireCoreLock() {
    if (!IS_EXTENSION || !navigator.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      const hold = () => new Promise(() => {});
      if (IS_BACKGROUND_PAGE) {
        navigator.locks.request('pulseshare-core', { ifAvailable: true }, (lock) => {
          if (lock) { resolve(true); return hold(); }
          // A janela está aberta: espera ela fechar e recarrega com o estado novo
          navigator.locks.request('pulseshare-core', () => { location.reload(); return hold(); });
          resolve(false);
          return null;
        }).catch(() => location.reload()); // roubado pela janela
      } else {
        navigator.locks.request('pulseshare-core', { steal: true }, () => {
          // O fundo pode ter gravado mensagens até agora: relê o histórico
          try { chatMessages = JSON.parse(localStorage.getItem('ps_chat_messages') || '{}'); } catch (e) {}
          resolve(true);
          return hold();
        }).catch(() => showOtherWindowOverlay());
      }
    });
  }

  // Histórico da extensão antiga (chrome.storage) → formato do app, uma única vez
  function migrateLegacyExtensionChats() {
    if (!IS_EXTENSION || localStorage.getItem('ps_legacy_migrated') || !window.chrome || !chrome.storage) return;
    chrome.storage.local.get(['chatMessages'], (res) => {
      localStorage.setItem('ps_legacy_migrated', '1');
      const legacy = (res && res.chatMessages) || {};
      let n = 0;
      Object.keys(legacy).forEach((rawTag) => {
        const tag = normalizeTag(rawTag);
        if (!tag || !Array.isArray(legacy[rawTag])) return;
        const list = chatMessages[tag] || (chatMessages[tag] = []);
        legacy[rawTag].forEach((m) => {
          if (!m || !m.id || list.some((x) => x.id === m.id)) return;
          const out = m.direction === 'outgoing';
          list.push({
            id: m.id,
            sender: out ? myTag : tag,
            text: m.text || '',
            timestamp: m.timestamp || Date.now(),
            status: out ? (m.status === 'READ' ? 'READ' : 'DELIVERED') : 'RECEIVED',
            media: m.media || null,
            transferId: m.transferId || null
          });
          n++;
        });
        list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      });
      if (n) {
        saveChatMessagesToStorage();
        renderConversationsList();
      }
    });
  }

  // Abrir uma conversa vinda do toque numa notificação
  // App de desktop: notificação clicada, links pulseshare:// e downloads concluídos
  function initDesktopEvents() {
    if (!IS_DESKTOP) return;
    try { Desk.setDownloadDirectory(customDownloadFolder); } catch (e) {}
    Desk.on('open-chat', (tag) => window.PulseShareNativeCallback.onOpenChat(tag));
    Desk.on('open-links', (links) => handleAndroidSharedItems((links || []).map((l) => ({ type: 'link', content: l }))));
    Desk.on('download-done', (d) => { if (d && d.name) Native.toast(`Salvo em Downloads/${customDownloadFolder || 'PulseShare'}: ${d.name}`); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) Desk.uiOpened(); });
    Desk.uiOpened();
    if (desktopLaunch && desktopLaunch.links && desktopLaunch.links.length) {
      const links = desktopLaunch.links.splice(0);
      setTimeout(() => handleAndroidSharedItems(links.map((l) => ({ type: 'link', content: l }))), 500);
    }
  }

  function openChatFromLaunch() {
    let tag = new URLSearchParams(location.search).get('chat') || Native.consumePendingOpenChat();
    tag = normalizeTag(tag);
    if (tag) setTimeout(() => { switchTab('chat'); openActiveChat(tag); }, 300);
  }

  // ==========================================================================
  // 13. INICIALIZAÇÃO DE EVENTOS DO DOM
  // ==========================================================================
  function initEvents() {
    initChatAutoScroll();
    // Abas de navegação
    document.getElementById('nav-chat').onclick = () => switchTab('chat');
    document.getElementById('nav-home').onclick = () => switchTab('home');
    document.getElementById('nav-transfers').onclick = () => switchTab('transfers');
    document.getElementById('nav-shares').onclick = () => switchTab('shares');
    document.getElementById('nav-mesh').onclick = () => switchTab('mesh');

    // Ações Rápidas na Home
    // (Ação rápida "Enviar para @peer" removida: o envio direto é feito pelo chat)
    document.getElementById('btn-action-create-link').onclick = () => openSendModal('link');

    // Botões de Busca Global
    document.getElementById('btn-header-search').onclick = () => openGlobalSearchModal();
    document.getElementById('btn-fab-new-chat').onclick = () => openGlobalSearchModal('@');
    document.getElementById('btn-mesh-add-contact').onclick = () => openGlobalSearchModal('@');
    document.getElementById('btn-refresh-mesh').onclick = () => { announcePresence(); renderMeshPeers(); };

    // Pedido de mensagem (remetente fora dos contatos)
    document.getElementById('btn-chat-request-add').onclick = () => {
      if (activeChatPeer && addContact(activeChatPeer)) Native.toast(`${activeChatPeer} adicionado aos contatos`);
    };
    document.getElementById('btn-chat-request-block').onclick = () => {
      const tag = activeChatPeer;
      if (!tag || !confirm(`Bloquear ${tag}? Mensagens e arquivos dessa pessoa serão ignorados.`)) return;
      setBlocked(tag, true);
      closeActiveChat();
      Native.toast(`${tag} bloqueado`);
    };
    document.getElementById('btn-close-global-search').onclick = () => {
      document.getElementById('modal-global-search').classList.add('hidden');
    };
    document.getElementById('input-global-search').oninput = (e) => {
      renderGlobalSearchResults(e.target.value);
    };

    // Botões de Perfil / Identidade
    // Perfil (agora dentro das Configurações)
    const openIdentity = () => {
      document.getElementById('modal-settings').classList.add('hidden');
      renderIdentityModal();
      document.getElementById('modal-identity-profile').classList.remove('hidden');
    };
    document.getElementById('btn-settings-open-identity').onclick = openIdentity;
    document.getElementById('btn-settings-avatar').onclick = () => pickPhotoFile();
    document.getElementById('btn-settings-change-photo').onclick = () => pickPhotoFile();
    document.getElementById('btn-copy-access-key').onclick = async () => {
      const k = activeProfile && await PulseShareCrypto.wordsToAccessKey(activeProfile.seedWords);
      if (k) { Native.copy(k); Native.toast('Chave de acesso copiada!'); }
    };
    document.getElementById('btn-export-recovery-txt').onclick = () => exportRecoveryTxt(activeProfile);
    document.getElementById('btn-show-my-qr').onclick = () => showMyLoginQr();
    initOnboardingEvents();
    initPhotoEditorEvents();
    initNotificationSettingsEvents();

    // Botões gerados em HTML dinâmico (sem onclick inline: a CSP da extensão bloqueia)
    const PS_CALLS = ['psShareAction', 'downloadChatMedia', 'psSaveChatMedia', 'psOpenChatImage', 'acceptTransfer', 'psOpenLocation', 'psCopyLocation'];
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ps-call]');
      if (!el) return;
      const fn = el.getAttribute('data-ps-call');
      if (!PS_CALLS.includes(fn) || typeof window[fn] !== 'function') return;
      window[fn](...String(el.getAttribute('data-ps-args') || '').split('|'));
    });
    document.getElementById('btn-edit-tag').onclick = openIdentity;
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

    // Contas neste aparelho: adicionar / sair / voltar da tela de entrada
    document.getElementById('btn-account-add').onclick = () => openAddAccount();
    document.getElementById('btn-account-logout').onclick = () => logoutAccount();
    document.getElementById('btn-backup-export').onclick = () => exportDeviceBackup();
    document.getElementById('btn-backup-import').onclick = () => pickBackupAndImport();
    document.getElementById('btn-onb-back').onclick = () => closeAddAccount();

    // Ler QR Code (câmera só no celular) / colar chave de acesso
    document.getElementById('btn-scan-device-qr').onclick = () => openQrScanner();
    document.getElementById('btn-chat-qr-sync').onclick = () => openQrScanner();
    document.getElementById('btn-close-qr-scanner-modal').onclick = () => closeQrScanner();
    document.getElementById('btn-confirm-import-pairing').onclick = async () => {
      const parsed = parseLoginText(document.getElementById('input-pairing-payload').value);
      if (!parsed.key && !parsed.words) { Native.toast('Cole uma chave de acesso válida (ps-…).'); return; }
      if (activeProfile && !confirm('Entrar nesta conta? A conta atual continua salva em "Contas neste aparelho".')) return;
      try { await loginFromParsed(parsed); } catch (e) { Native.toast(e && e.message ? e.message : 'Chave inválida'); }
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
      updateComposeButtons();
    };

    document.getElementById('input-chat-text').onkeydown = (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btn-chat-send').click();
      }
    };

    // Clipe: menu com Foto e vídeo / Áudio / Documento / Localização
    document.getElementById('btn-chat-attach').onclick = () => toggleAttachMenu();
    initVoiceLocationProfileEvents();

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
      renderUsernameSettings();
      renderNotificationSettings();
      updateIdentityUI();
      document.getElementById('modal-settings').classList.remove('hidden');
    };

    // Nome de usuário (alteração com verificação)
    document.getElementById('btn-username-change').onclick = () => startUsernameChange();
    document.getElementById('setting-username-input').onkeydown = (e) => { if (e.key === 'Enter') startUsernameChange(); };
    document.getElementById('btn-username-verify-confirm').onclick = () => confirmUsernameChange();
    document.getElementById('setting-username-verify-input').onkeydown = (e) => { if (e.key === 'Enter') confirmUsernameChange(); };
    document.getElementById('btn-username-verify-cancel').onclick = () => cancelUsernameChange();
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
        const allowZipEl = document.getElementById('input-link-allow-zip');
        const share = createPublicShare(files, { expiresMin: Math.round(expMs / 60000), allowZip: allowZipEl ? allowZipEl.checked : true });
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
    // Extensão: só uma página (janela ou documento de fundo) conecta por vez
    if (!(await acquireCoreLock())) return;
    const loggedIn = await initCryptoIdentity();
    initEvents();
    initDesktopEvents();
    renderNotificationSettings();
    if (!loggedIn) {
      // Sem conta neste dispositivo: tela de entrada (o fundo da extensão só espera)
      if (!IS_BACKGROUND_PAGE) showOnboarding();
      showAdminRemovedNotice();
      return;
    }
    // Registros do administrador já guardados: exclusões e mensagens oficiais desta conta
    applyAdminState({ notify: false });
    if (!activeProfile) return; // a própria conta foi excluída (recarregando)
    updateHeaderStatus();
    connectBrokers();
    switchTab('chat'); // Abertura direta no chat por padrão
    migrateLegacyExtensionChats();
    if (IS_ANDROID || IS_EXTENSION || IS_DESKTOP) Native.setBackgroundMode(backgroundMode);
    if (IS_EXTENSION && !IS_BACKGROUND_PAGE && window.chrome && chrome.runtime) {
      try { chrome.runtime.sendMessage({ type: 'PS_UI_OPEN' }); } catch (e) {}
    }
    openChatFromLaunch();
  });

})();
