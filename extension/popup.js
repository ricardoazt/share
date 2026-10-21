/**
 * PulseShare P2P - Frontend Controller (popup.js)
 * Tudo 100% P2P Sem Servidor:
 * - Diretório P2P sincronizado de @usuarios (Gossip)
 * - Envio/Recebimento P2P direto
 * - Geração de Link Público P2P Serverless (via Cloudflare WebRTC STUN stun.cloudflare.com:3478)
 * - Configurações na engrenagem (chave de abertura automática ao receber)
 */

const DB_NAME = 'PulseShareDB';
const DB_VERSION = 1;
const FILE_STORE = 'staged_files';
const ONLINE_TTL_MS = 45000;

const fileBridgeChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('pulseshare_file_bridge')
    : null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function stageFileInIDB(transferId, file) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put(file, transferId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Passa a referência nativa do File diretamente para o Offscreen Document via
 * BroadcastChannel (Zero-Copy em < 1ms, suportando vídeos de 110MB, 500MB ou múltiplos GBs
 * sem travar o IndexedDB).
 */
async function stageFileZeroCopy(transferId, file) {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'ENSURE_OFFSCREEN' }, () => resolve());
  });

  if (fileBridgeChannel) {
    const acked = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        fileBridgeChannel.removeEventListener('message', onMsg);
        resolve(false);
      }, 600);

      function onMsg(e) {
        if (e.data && e.data.type === 'STAGE_FILE_ACK' && e.data.transferId === transferId) {
          clearTimeout(timer);
          fileBridgeChannel.removeEventListener('message', onMsg);
          resolve(true);
        }
      }

      fileBridgeChannel.addEventListener('message', onMsg);
      fileBridgeChannel.postMessage({
        type: 'STAGE_FILE_MEMORY',
        transferId,
        file
      });
    });

    if (acked) return;
  }

  // Fallback para IndexedDB caso BroadcastChannel não esteja disponível
  await stageFileInIDB(transferId, file);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

function normalizeTag(raw) {
  if (!raw) return '';
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  return cleaned ? `@${cleaned}` : '';
}

/**
 * Gera um mini-portal HTML autocontido que qualquer pessoa (mesmo sem a extensão,
 * no celular ou em outro PC em outra rede) pode abrir no navegador para baixar o arquivo
 * 100% P2P via Cloudflare WebRTC STUN + TURN Relay direto da sua extensão!
 */
function buildStandaloneP2PHtmlPortal(t) {
  const safeTitle = (t.fileName || 'arquivo').replace(/[<>"']/g, '');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Baixar ${safeTitle} — Túnel P2P Cloudflare WebRTC</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif}
body{background:#020617;color:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:400px;background:#0f172a;border:1px solid #1e293b;border-radius:20px;padding:24px;box-shadow:0 20px 40px rgba(0,0,0,.5)}
.badge{display:inline-block;background:rgba(249,115,22,.15);color:#fb923c;border:1px solid rgba(249,115,22,.3);font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:14px}
h1{font-size:16px;word-break:break-all;margin-bottom:6px;color:#f1f5f9}
.meta{font-size:12px;color:#94a3b8;margin-bottom:18px;font-family:monospace}
.bar-wrap{width:100%;height:10px;background:#1e293b;border-radius:999px;overflow:hidden;margin:8px 0}
.bar{height:100%;width:0%;background:linear-gradient(90deg,#f97316,#fbbf24);transition:width .15s}
.row{display:flex;justify-content:space-between;font-size:12px;color:#cbd5e1;font-family:monospace}
.btn{width:100%;margin-top:16px;padding:12px;border:none;border-radius:12px;background:linear-gradient(135deg,#f97316,#d97706);color:#fff;font-weight:700;font-size:14px;cursor:pointer}
</style>
</head>
<body>
<div class="card">
  <span class="badge">☁️ Túnel P2P Direto (Cloudflare WebRTC)</span>
  <h1>${safeTitle}</h1>
  <p class="meta">Remetente: ${t.ownerTag || ''} • ${formatBytes(t.fileSize)}</p>
  <div class="row"><span id="st">Conectando P2P...</span><strong id="pct">0%</strong></div>
  <div class="bar-wrap"><div class="bar" id="bar"></div></div>
  <div class="row"><span id="by">0 B</span><span id="sp">0 B/s</span></div>
  <button class="btn" id="btn">⬇ Baixar Arquivo Direto (P2P)</button>
</div>
<script>
const BROKERS=['wss://broker.emqx.io:8084/mqtt','wss://broker.hivemq.com:8884/mqtt','wss://test.mosquitto.org:8081/mqtt'];
const TOPIC='pulseshare/v2/p2p_mesh_global';
const SHARE_ID=${JSON.stringify(t.shareId)};
const OWNER=${JSON.stringify(t.ownerTag)};
const FILE_NAME=${JSON.stringify(t.fileName)};
const FILE_SIZE=${Number(t.fileSize || 0)};
const FILE_TYPE=${JSON.stringify(t.fileType || 'application/octet-stream')};
const RTC_CFG={iceServers:[
  {urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']},
  {urls:'turn:openrelay.metered.ca:80',username:'openrelayproject',credential:'openrelayproject'},
  {urls:'turn:openrelay.metered.ca:443',username:'openrelayproject',credential:'openrelayproject'},
  {urls:'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject',credential:'openrelayproject'}
]};
const myId=crypto.randomUUID();
const myTag='@link_'+myId.slice(0,6);
let tid=SHARE_ID+'_'+myId.slice(0,6),sockets=[],pc=null,pendingCands=[],seen=new Set();
function fmt(b){if(!b||b<=0)return'0 B';const u=['B','KB','MB','GB'],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),3);return(b/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i];}
function encLen(l){const b=[];do{let e=l%128;l=Math.floor(l/128);if(l>0)e|=128;b.push(e);}while(l>0);return b;}
function encStr(s){const u=new TextEncoder().encode(s);return[(u.length>>8)&255,u.length&255,...u];}
function pub(obj){const pkt={...obj,packetId:crypto.randomUUID(),senderNodeId:myId,senderTag:myTag};const tb=encStr(TOPIC),pb=new TextEncoder().encode(JSON.stringify(pkt));const h=[0x30,...encLen(tb.length+pb.length),...tb];const p=new Uint8Array(h.length+pb.length);p.set(h,0);p.set(pb,h.length);sockets.forEach(s=>{if(s.readyState===1)try{s.send(p);}catch{}});}
function sig(signalType,payload){pub({meshType:'DIRECT_SIGNAL',to:OWNER,transferId:tid,signalType,payload});}
async function onOffer(sdp){
  document.getElementById('st').textContent='Recebendo via WebRTC P2P...';
  if(pc)try{pc.close();}catch{}
  pc=new RTCPeerConnection(RTC_CFG);
  const chunks=[];let rec=0,t0=Date.now(),lr=t0;
  pc.onicecandidate=e=>{if(e.candidate)sig('ICE_CANDIDATE',{candidate:e.candidate.toJSON?e.candidate.toJSON():e.candidate});};
  pc.ondatachannel=ev=>{
    ev.channel.binaryType='arraybuffer';
    ev.channel.onmessage=e=>{
      if(typeof e.data==='string'){const c=JSON.parse(e.data);if(c.type==='EOF'){try{ev.channel.send(JSON.stringify({type:'RECEIVER_ACK_DONE'}));}catch{}const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(chunks,{type:FILE_TYPE}));a.download=FILE_NAME;a.click();document.getElementById('st').textContent='Concluído ✓';document.getElementById('pct').textContent='100%';document.getElementById('bar').style.width='100%';setTimeout(()=>{try{pc.close();}catch{}},500);}return;}
      chunks.push(new Uint8Array(e.data));rec+=e.data.byteLength;const n=Date.now();
      if(n-lr>100||rec>=FILE_SIZE){const p=FILE_SIZE?Math.min(99,Math.round(rec/FILE_SIZE*100)):99;document.getElementById('pct').textContent=p+'%';document.getElementById('bar').style.width=p+'%';document.getElementById('by').textContent=fmt(rec)+' / '+fmt(FILE_SIZE);document.getElementById('sp').textContent=fmt(Math.round(rec/Math.max(.1,(n-t0)/1000)))+'/s';lr=n;}
    };
  };
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  while(pendingCands.length){const c=pendingCands.shift();try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch{}}
  const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
  sig('WEBRTC_ANSWER',{sdp:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
}
function pull(){tid=SHARE_ID+'_'+Math.floor(1000+Math.random()*9000);pendingCands=[];document.getElementById('st').textContent='Solicitando túnel P2P a '+OWNER+'...';sig('PUBLIC_LINK_PULL',{shareId:SHARE_ID});}
document.getElementById('btn').onclick=pull;
let pulled=false;
BROKERS.forEach((url,i)=>{
  const ws=new WebSocket(url,'mqtt');ws.binaryType='arraybuffer';sockets.push(ws);
  ws.onopen=()=>{const b=[...encStr('MQTT'),4,2,0,60,...encStr('ps_'+myId.slice(0,8)+'_'+i)];ws.send(new Uint8Array([0x10,...encLen(b.length),...b]));};
  ws.onmessage=ev=>{
    const u=new Uint8Array(ev.data);let p=0;
    while(p<u.length){const fb=u[p++],pt=fb&240;let m=1,rl=0,eb;do{eb=u[p++];rl+=(eb&127)*m;m*=128;}while(eb&128);const pe=p+rl;
      if(pt===0x20){const sb=[0,1,...encStr(TOPIC),0];ws.send(new Uint8Array([0x82,...encLen(sb.length),...sb]));if(!pulled){pulled=true;pull();}}
      else if(pt===0x30){let c=p;const tl=(u[c]<<8)|u[c+1];c+=2+tl;if(((fb>>1)&3)>0)c+=2;try{const d=JSON.parse(new TextDecoder().decode(u.subarray(c,pe)));if(d.packetId){if(seen.has(d.packetId)){p=pe;continue;}seen.add(d.packetId);}if(d.meshType==='DIRECT_SIGNAL'&&d.to===myTag){if(d.signalType==='WEBRTC_OFFER')onOffer(d.payload.sdp);else if(d.signalType==='ICE_CANDIDATE'&&d.payload?.candidate){if(pc&&pc.remoteDescription&&pc.remoteDescription.type)pc.addIceCandidate(new RTCIceCandidate(d.payload.candidate)).catch(()=>{});else pendingCands.push(d.payload.candidate);}}}catch{}}
      p=pe;
    }
  };
});
</script>
</body>
</html>`;
}

// ============================================================================
// Elementos DOM e Estado da UI
// ============================================================================
const statusDot = document.getElementById('status-dot');
const connectionBadge = document.getElementById('connection-badge');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const btnCloseSettings = document.getElementById('btn-close-settings');
const toggleAutoOpen = document.getElementById('toggle-auto-open');
const toggleAutoAccept = document.getElementById('toggle-auto-accept');
const footerAutoOpen = document.getElementById('footer-auto-open');



const myTagInput = document.getElementById('my-tag-input');
const btnSaveTag = document.getElementById('btn-save-tag');
const targetContainer = document.getElementById('target-container');
const targetTagInput = document.getElementById('target-tag-input');
const peersList = document.getElementById('peers-list');
const rosterCount = document.getElementById('roster-count');
const fileInput = document.getElementById('file-input');
const tunnelFileInput = document.getElementById('tunnel-file-input');
const btnSend = document.getElementById('btn-send');
const btnReceive = document.getElementById('btn-receive');
const btnCloudflareTunnel = document.getElementById('btn-cloudflare-tunnel');
const tunnelStatusSub = document.getElementById('tunnel-status-sub');
const tunnelBadge = document.getElementById('tunnel-badge');
const receiveBadge = document.getElementById('receive-badge');
const receiveTitle = document.getElementById('receive-title');
const receiveSubtitle = document.getElementById('receive-subtitle');
const transfersList = document.getElementById('transfers-list');
const emptyState = document.getElementById('empty-state');
const tabActiveTransfers = document.getElementById('tab-active-transfers');
const tabHistoryTransfers = document.getElementById('tab-history-transfers');
const countActive = document.getElementById('count-active');
const countHistory = document.getElementById('count-history');
const btnClearCompleted = document.getElementById('btn-clear-completed');
const toastAlert = document.getElementById('toast-alert');
const toastMessage = document.getElementById('toast-message');
const toastClose = document.getElementById('toast-close');
const onlineCounter = document.getElementById('online-counter');

// Elementos do Modal de Configuração do Túnel e Pack
const tunnelConfigModal = document.getElementById('tunnel-config-modal');
const modalHeaderTitle = document.getElementById('modal-header-title');
const modalIndicatorDot = document.getElementById('modal-indicator-dot');
const modalViewPack = document.getElementById('modal-view-pack');
const btnModalClose = document.getElementById('btn-modal-close');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');
const btnModalAddMore = document.getElementById('btn-modal-add-more');
const btnModalAddFolder = document.getElementById('btn-modal-add-folder');
const btnModalQuickBrowser = document.getElementById('btn-modal-quick-browser');
const modalQuickBrowserPanel = document.getElementById('modal-quick-browser-panel');
const btnQuickBrowserClose = document.getElementById('btn-quick-browser-close');
const btnQuickBrowserUp = document.getElementById('btn-quick-browser-up');
const btnQuickBrowserAddCurrent = document.getElementById('btn-quick-browser-add-current');
const quickBrowserShortcuts = document.getElementById('quick-browser-shortcuts');
const quickBrowserPath = document.getElementById('quick-browser-path');
const quickBrowserEntries = document.getElementById('quick-browser-entries');
const quickBrowserCount = document.getElementById('quick-browser-count');
const modalFilesList = document.getElementById('modal-files-list');
const modalFilesSummary = document.getElementById('modal-files-summary');
const modalCompressToggle = document.getElementById('modal-compress-toggle');
const modalCompressOptions = document.getElementById('modal-compress-options');
const modalCompressFormat = document.getElementById('modal-compress-format');
const modalCompressLevel = document.getElementById('modal-compress-level');
const modalCompressName = document.getElementById('modal-compress-name');
const modalCompressExtBadge = document.getElementById('modal-compress-ext-badge');
const modalTunnelOptions = document.getElementById('modal-tunnel-options');
const modalExpirationSelect = document.getElementById('modal-expiration-select');
const modalDownloadLimitSelect = document.getElementById('modal-download-limit-select');
const modalPasswordInput = document.getElementById('modal-password-input');
const btnModalGenPassword = document.getElementById('btn-modal-gen-password');
const btnModalClearPassword = document.getElementById('btn-modal-clear-password');

let currentTransfersTab = 'active'; // 'active' | 'history'
const expandedTransferIds = new Set();
let stagedTunnelFiles = [];
let currentModalMode = 'tunnel'; // 'tunnel' | 'p2p'

async function checkDaemonStatus() {
  const badge = document.getElementById('daemon-status-badge');
  try {
    const res = await fetch('http://127.0.0.1:18765/api/status');
    if (res.ok) {
      const data = await res.json();
      if (badge) {
        const count = Array.isArray(data.activeTunnels) ? data.activeTunnels.length : 0;
        badge.textContent = `● Ativo (${count} ativo${count === 1 ? '' : 's'})`;
        badge.className = 'text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      }
      return;
    }
  } catch {}
  if (badge) {
    badge.textContent = '○ Offline (127.0.0.1:18765)';
    badge.className = 'text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30';
  }
}

let currentState = {
  connected: false,
  myTag: '',
  nodeId: '',
  autoAccept: true,
  autoOpenOnReceive: true,
  peerRegistry: {},
  transfers: {}
};

let awaitingFilePicker = false;

async function computeSha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatShareMessage({ shareUrl, password, expiresAt, maxDownloads, files }) {
  let msg = `📦 PulseShare — Compartilhamento de Arquivos\n`;
  msg += `🔗 Link: ${shareUrl}\n`;
  if (password) {
    msg += `🔑 Senha: ${password}\n`;
  }
  if (maxDownloads && Number(maxDownloads) > 0) {
    msg += `🎯 Limite de downloads: ${maxDownloads} download${Number(maxDownloads) === 1 ? ' completo (expira ao concluir)' : 's completos'}\n`;
  }
  if (expiresAt) {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs > 0) {
      const remainingMin = Math.round(remainingMs / 60000);
      const expTime = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      msg += `⏳ Expira em: ~${remainingMin} min (às ${expTime})\n`;
    } else {
      msg += `⏳ Expira em: Expirado\n`;
    }
  } else {
    msg += `⏳ Expira em: Sem limite de tempo\n`;
  }
  if (files && files.length > 0) {
    msg += `📁 Arquivos (${files.length}):\n`;
    for (const f of files) {
      msg += `  • ${f.name} (${formatBytes(f.size)})\n`;
    }
  }
  msg += `\n⚡ Baixe direto pelo navegador, sem precisar instalar nada!`;
  return msg;
}

function showToast(msg) {
  toastMessage.textContent = msg;
  toastAlert.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastAlert.classList.add('hidden');
  }, 5000);
}

toastClose.addEventListener('click', () => {
  toastAlert.classList.add('hidden');
});

function renderConnectionStatus() {
  if (currentState.connected) {
    statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm';
    connectionBadge.textContent = `Online (${currentState.myTag})`;
    connectionBadge.className =
      'text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/90 text-emerald-300 border border-emerald-500/30';
  } else {
    statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
    connectionBadge.textContent = 'Malha Local';
    connectionBadge.className =
      'text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-950/90 text-amber-300 border border-amber-500/30';
  }

  if (document.activeElement !== myTagInput && currentState.myTag) {
    myTagInput.value = currentState.myTag;
  }

  tunnelStatusSub.textContent = 'Túnel direto via Cloudflare WebRTC STUN (100% P2P Sem Servidor)';
  tunnelBadge.textContent = 'P2P LINK';
  tunnelBadge.className =
    'text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-950/40 text-white shrink-0';
}

function renderSettingsSwitches() {
  const autoOpen = currentState.autoOpenOnReceive !== false;
  toggleAutoOpen.setAttribute('aria-checked', String(autoOpen));
  if (autoOpen) {
    toggleAutoOpen.className =
      'w-10 h-5 rounded-full bg-emerald-500 p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer justify-end';
    footerAutoOpen.textContent = 'ON';
    footerAutoOpen.className = 'text-emerald-400';
  } else {
    toggleAutoOpen.className =
      'w-10 h-5 rounded-full bg-slate-700 p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer justify-start';
    footerAutoOpen.textContent = 'OFF';
    footerAutoOpen.className = 'text-slate-500';
  }

  const autoAccept = currentState.autoAccept !== false;
  toggleAutoAccept.setAttribute('aria-checked', String(autoAccept));
  if (autoAccept) {
    toggleAutoAccept.className =
      'w-10 h-5 rounded-full bg-sky-500 p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer justify-end';
  } else {
    toggleAutoAccept.className =
      'w-10 h-5 rounded-full bg-slate-700 p-0.5 flex items-center transition-colors duration-150 shrink-0 cursor-pointer justify-start';
  }
}

function renderPeerDirectory() {
  const now = Date.now();
  const allPeers = Object.values(currentState.peerRegistry || {})
    .filter((p) => p && p.tag)
    .sort((a, b) => {
      if (a.tag === currentState.myTag) return 1;
      if (b.tag === currentState.myTag) return -1;
      const aOnline = now - (a.lastSeen || 0) < ONLINE_TTL_MS && a.status !== 'offline';
      const bOnline = now - (b.lastSeen || 0) < ONLINE_TTL_MS && b.status !== 'offline';
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });

  const remotePeers = allPeers.filter((p) => p.tag !== currentState.myTag);
  const onlinePeersCount = allPeers.filter(
    (p) => now - (p.lastSeen || 0) < ONLINE_TTL_MS && p.status !== 'offline'
  ).length;

  rosterCount.textContent = `${allPeers.length} conhecido(s)`;
  onlineCounter.textContent = `${onlinePeersCount} online na malha`;

  peersList.innerHTML = '';

  if (remotePeers.length === 0) {
    peersList.innerHTML = `
      <span class="text-[10px] text-slate-500 italic">
        Você (${currentState.myTag}) está na lista. Novos @usuarios aparecerão aqui!
      </span>
    `;
    return;
  }

  const selectedTarget = normalizeTag(targetTagInput.value);

  for (const peer of remotePeers) {
    const isOnline = now - (peer.lastSeen || 0) < ONLINE_TTL_MS && peer.status !== 'offline';
    const isSelected = peer.tag === selectedTarget;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-peer-tag', peer.tag);
    btn.title = isOnline
      ? `${peer.tag} está ONLINE — clique para selecionar`
      : `${peer.tag} registrado no diretório P2P`;

    btn.className = isSelected
      ? 'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-400/60 shrink-0 cursor-pointer transition-all'
      : 'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 shrink-0 cursor-pointer transition-all';

    const dotClass = isOnline ? 'w-1.5 h-1.5 rounded-full bg-emerald-400' : 'w-1.5 h-1.5 rounded-full bg-slate-600';

    btn.innerHTML = `
      <span class="${dotClass}"></span>
      <span>${peer.tag}</span>
    `;

    peersList.appendChild(btn);
  }
}

function renderReceiveButton() {
  const transfersArr = Object.values(currentState.transfers || {});
  const pendingIncoming = transfersArr.filter(
    (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
  );

  if (pendingIncoming.length > 0) {
    const first = pendingIncoming[0];
    receiveBadge.textContent = `${pendingIncoming.length} Pendente`;
    receiveBadge.classList.remove('hidden');
    receiveTitle.textContent = 'Aceitar Arquivo';
    receiveSubtitle.textContent = `De ${first.peerTag} (${formatBytes(first.fileSize)})`;
    btnReceive.classList.add('ring-2', 'ring-amber-400');
  } else {
    receiveBadge.classList.add('hidden');
    receiveTitle.textContent = 'Receber';
    if (currentState.autoAccept) {
      receiveSubtitle.textContent = 'Escuta Automática: ON';
      btnReceive.classList.add('ring-2', 'ring-sky-400/70');
      btnReceive.classList.remove('opacity-80', 'ring-amber-400');
    } else {
      receiveSubtitle.textContent = 'Pedir Confirmação';
      btnReceive.classList.remove('ring-2', 'ring-sky-400/70', 'ring-amber-400');
      btnReceive.classList.add('opacity-80');
    }
  }
}

function statusLabel(transfer) {
  const speedText = formatSpeed(transfer.speedBps);
  switch (transfer.status) {
    case 'CONNECTING':
      return 'Negociando canal P2P...';
    case 'PAUSED':
      return 'Transferência pausada';
    case 'CANCELLED':
      return 'Cancelada';
    case 'EXPIRED':
      return 'Túnel expirado';
    case 'TUNNEL_READY': {
      let expInfo = '';
      if (transfer.expiresAt) {
        const remainingSec = Math.max(0, Math.floor((transfer.expiresAt - Date.now()) / 1000));
        if (remainingSec > 0) {
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          expInfo = ` • Expira em ${m}m ${s}s`;
        } else {
          return 'Túnel expirado';
        }
      }
      if (transfer.maxDownloads > 0) {
        const remaining = Math.max(0, transfer.maxDownloads - (transfer.completedPacks || 0));
        if (remaining === 0) return 'Limite de downloads atingido (Concluído)';
        expInfo += ` • ${transfer.completedPacks || 0}/${transfer.maxDownloads} downloads`;
      }
      return transfer.downloads > 0
        ? `Túnel ativo (${transfer.downloads} conexões)${expInfo}`
        : `Túnel aberto (aguardando download)${expInfo}`;
    }
    case 'AWAITING_ACCEPT':
      return transfer.direction === 'incoming'
        ? 'Clique em Receber para aceitar'
        : 'Aguardando destinatário...';
    case 'TRANSFERRING':
      return speedText ? `Transmitindo P2P • ${speedText}` : 'Transferindo dados...';
    case 'COMPLETED':
      return 'Concluída';
    case 'ERROR':
      return transfer.error || 'Falha na transferência';
    default:
      return transfer.status;
  }
}

function isTransferHistory(t, now = Date.now()) {
  if (['COMPLETED', 'EXPIRED', 'CANCELLED', 'ERROR'].includes(t.status)) return true;
  if (t.expiresAt && now >= t.expiresAt) return true;
  if (t.maxDownloads > 0 && (t.completedPacks || 0) >= t.maxDownloads) return true;
  return false;
}

function renderTransfers() {
  const allTransfers = Object.values(currentState.transfers || {}).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  const now = Date.now();
  const activeList = allTransfers.filter((t) => !isTransferHistory(t, now));
  const historyList = allTransfers.filter((t) => isTransferHistory(t, now));

  if (countActive) countActive.textContent = activeList.length;
  if (countHistory) countHistory.textContent = historyList.length;

  const list = currentTransfersTab === 'active' ? activeList : historyList;

  if (list.length === 0) {
    emptyState.classList.remove('hidden');
    const pTitle = emptyState.querySelector('p.font-medium');
    const pSub = emptyState.querySelector('p.text-\\[10px\\]');
    if (pTitle) {
      pTitle.textContent =
        currentTransfersTab === 'active'
          ? 'Nenhuma transferência ativa'
          : 'Nenhum histórico de transferências';
    }
    if (pSub) {
      pSub.innerHTML =
        currentTransfersTab === 'active'
          ? 'Envie via <span class="text-emerald-400 font-mono">@usuario</span> ou gere um <span class="text-orange-400 font-semibold">Link Cloudflare</span>.'
          : 'Transferências concluídas, expiradas ou canceladas aparecerão aqui.';
    }
    Array.from(transfersList.children).forEach((child) => {
      if (child.id !== 'empty-state') child.remove();
    });
    return;
  }

  emptyState.classList.add('hidden');

  Array.from(transfersList.children).forEach((child) => {
    if (child.id !== 'empty-state') child.remove();
  });

  for (const t of list) {
    const isTunnel = t.direction === 'tunnel';
    const isSend = t.direction === 'outgoing';
    const isPaused = t.status === 'PAUSED';
    const isCancelled = t.status === 'CANCELLED';
    const isExpired = t.status === 'EXPIRED' || (t.expiresAt && now >= t.expiresAt);
    const isCompleted = t.status === 'COMPLETED' || (t.maxDownloads > 0 && (t.completedPacks || 0) >= t.maxDownloads);
    const isDone = isCompleted || (!isExpired && !isCancelled && isTunnel && t.status === 'TUNNEL_READY');
    const isError = t.status === 'ERROR';
    const isWaitingAccept = t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT';
    const isExpanded = expandedTransferIds.has(t.id);

    const pct = Math.min(100, Math.max(0, Math.round(t.progress || 0)));
    const totalBytes = t.totalSize || t.fileSize || 0;
    const transferredBytes =
      typeof t.transferredBytes === 'number'
        ? t.transferredBytes
        : Math.round((totalBytes * pct) / 100);

    const card = document.createElement('div');
    card.className =
      'p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col gap-1.5 transition-all';

    const badgeColor = isTunnel
      ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
      : isSend
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : 'bg-sky-500/15 text-sky-300 border-sky-500/30';

    const badgeLabel = isTunnel ? '☁️ P2P LINK' : isSend ? '↑ ENVIO' : '↓ RECEB.';

    const barColor = isError || isCancelled || isExpired
      ? 'bg-rose-500'
      : isPaused
      ? 'bg-amber-400'
      : isTunnel
      ? 'bg-gradient-to-r from-orange-500 to-amber-400'
      : isDone
      ? isSend
        ? 'bg-emerald-400'
        : 'bg-sky-400'
      : isSend
      ? 'bg-gradient-to-r from-emerald-500 to-green-400'
      : 'bg-gradient-to-r from-sky-500 to-blue-400';

    const pctColor = isError || isCancelled || isExpired
      ? 'text-rose-400'
      : isPaused
      ? 'text-amber-300'
      : isTunnel
      ? 'text-orange-300'
      : isSend
      ? 'text-emerald-300'
      : 'text-sky-300';

    // Botões de Pausa e Cancelamento para Envios e Recebimentos ativos
    let controlButtonsHtml = '';
    if (!isDone && !isError && !isCancelled && !isExpired && !isWaitingAccept) {
      if (t.status === 'TRANSFERRING' || t.status === 'CONNECTING') {
        controlButtonsHtml = `
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-action="pause-transfer"
              data-transfer-id="${t.id}"
              title="Pausar transferência"
              class="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ⏸ Pausar
            </button>
            <button
              type="button"
              data-action="cancel-transfer"
              data-transfer-id="${t.id}"
              title="Cancelar transferência"
              class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ✕ Cancelar
            </button>
          </div>
        `;
      } else if (isPaused) {
        controlButtonsHtml = `
          <div class="flex items-center gap-1">
            <button
              type="button"
              data-action="resume-transfer"
              data-transfer-id="${t.id}"
              title="Retomar transferência"
              class="px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border border-emerald-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ▶ Retomar
            </button>
            <button
              type="button"
              data-action="cancel-transfer"
              data-transfer-id="${t.id}"
              title="Cancelar transferência"
              class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold transition-colors cursor-pointer"
            >
              ✕ Cancelar
            </button>
          </div>
        `;
      }
    }

    let postActionsHtml = '';
    if (isDone && !isSend && !isTunnel && typeof t.downloadId === 'number') {
      postActionsHtml = `
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="show-folder"
            data-download-id="${t.downloadId}"
            title="Mostrar na pasta"
            class="p-1 rounded-lg bg-slate-800 hover:bg-sky-500/20 text-sky-300 border border-slate-700 hover:border-sky-500/40 transition-colors cursor-pointer"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </button>
          <button
            type="button"
            data-action="open-file"
            data-download-id="${t.downloadId}"
            title="Abrir arquivo"
            class="p-1 rounded-lg bg-slate-800 hover:bg-emerald-500/20 text-emerald-300 border border-slate-700 hover:border-emerald-500/40 transition-colors cursor-pointer"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </button>
        </div>
      `;
    } else if (isWaitingAccept) {
      postActionsHtml = `
        <div class="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-action="accept-transfer"
            data-transfer-id="${t.id}"
            class="px-2 py-0.5 rounded-md bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[10px] transition-colors cursor-pointer"
          >
            Aceitar
          </button>
          <button
            type="button"
            data-action="reject-transfer"
            data-transfer-id="${t.id}"
            class="px-1.5 py-0.5 rounded-md bg-slate-800 hover:bg-rose-500/30 text-rose-300 text-[10px] transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>
      `;
    }

    // Botão individual para excluir transferência
    const deleteButtonHtml = `
      <button
        type="button"
        data-action="delete-single-transfer"
        data-transfer-id="${t.id}"
        title="Excluir transferência"
        class="p-1 rounded hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 text-[11px] font-bold transition-colors cursor-pointer shrink-0 ml-1"
      >
        ✕
      </button>
    `;

    let tunnelLinkBoxHtml = '';
    if (isTunnel && !isCancelled && !isExpired && !isCompleted) {
      let expBadge = '';
      if (t.expiresAt) {
        const remainingSec = Math.max(0, Math.floor((t.expiresAt - now) / 1000));
        if (remainingSec > 0) {
          const m = Math.floor(remainingSec / 60);
          const s = remainingSec % 60;
          expBadge = `<span class="text-[9px] font-mono text-amber-300">⏳ ${m}m ${s}s</span>`;
        } else {
          expBadge = `<span class="text-[9px] font-mono text-rose-400 font-bold">⏳ Expirado</span>`;
        }
      } else {
        expBadge = `<span class="text-[9px] font-mono text-slate-400">⏳ Sem limite</span>`;
      }

      const pwdBadge = t.hasPassword
        ? `<span class="text-[9px] font-mono text-orange-300">🔑 Senha</span>`
        : `<span class="text-[9px] font-mono text-slate-500">🔓 Público</span>`;

      const limitBadge = t.maxDownloads > 0
        ? `<span class="text-[9px] font-mono text-sky-300">🎯 ${t.completedPacks || 0}/${t.maxDownloads} dl</span>`
        : '';

      const pauseResumeBtn = isPaused
        ? `<button type="button" data-action="resume-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border border-emerald-500/40 text-[9px] font-bold cursor-pointer" title="Retomar túnel">▶ Retomar</button>`
        : `<button type="button" data-action="pause-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 border border-amber-500/40 text-[9px] font-bold cursor-pointer" title="Pausar túnel">⏸ Pausar</button>`;

      const closeTunnelBtn = `<button type="button" data-action="cancel-transfer" data-transfer-id="${t.id}" class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/40 text-[9px] font-bold cursor-pointer" title="Encerrar túnel">✕ Encerrar</button>`;

      tunnelLinkBoxHtml = `
        <div class="mt-1 flex flex-col gap-1 bg-slate-950 border border-orange-500/30 rounded-lg p-1.5">
          <div class="flex items-center justify-between text-[10px]">
            <div class="flex items-center gap-1.5 truncate max-w-[200px]">
              <span class="font-mono text-orange-300 font-bold shrink-0">#${t.shareId}</span>
              ${expBadge}
              ${pwdBadge}
              ${limitBadge}
            </div>
            <div class="flex items-center gap-1 shrink-0">
              ${pauseResumeBtn}
              ${closeTunnelBtn}
            </div>
          </div>
          <div class="flex items-center justify-between gap-1 pt-1 border-t border-slate-800">
            <span class="text-[9px] font-mono text-slate-400 truncate" title="${t.shareUrl || ''}">
              ${t.shareUrl || ''}
            </span>
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                data-action="copy-tunnel-formatted"
                data-transfer-id="${t.id}"
                title="Copiar Link formatado com senha, limite e expiração"
                class="px-2 py-0.5 rounded bg-orange-500/20 hover:bg-orange-500/40 text-orange-300 border border-orange-500/40 text-[10px] font-bold transition-colors cursor-pointer"
              >
                Copiar
              </button>
              <button
                type="button"
                data-action="open-tunnel-url"
                data-url="${t.shareUrl}"
                title="Abrir no navegador"
                class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] transition-colors cursor-pointer"
              >
                ↗
              </button>
            </div>
          </div>
        </div>
      `;
    }

    const displayName = t.packName || t.fileName || 'arquivo';
    const displayFiles = Array.isArray(t.filesProgress) && t.filesProgress.length > 0
      ? t.filesProgress
      : Array.isArray(t.files) && t.files.length > 0
      ? t.files.map((f, i) => ({
          index: i,
          name: f.name,
          size: f.size,
          bytesSent: isCompleted ? f.size : 0,
          progress: isCompleted ? 100 : 0,
          status: isCompleted ? 'DONE' : 'IDLE'
        }))
      : [{
          index: 0,
          name: displayName,
          size: totalBytes,
          bytesSent: transferredBytes,
          progress: pct,
          status: pct === 100 || isCompleted ? 'DONE' : pct > 0 ? 'DOWNLOADING' : 'IDLE'
        }];

    // Seção detalhada / expansível com progresso dos downloads do destinatário
    let expandedDetailsHtml = '';
    if (isExpanded) {
      expandedDetailsHtml = `
        <div class="mt-2 p-2.5 rounded-lg bg-slate-950/90 border border-slate-700/80 flex flex-col gap-2 transition-all">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold text-sky-300 flex items-center gap-1">
              📊 Progresso dos Downloads
            </span>
            <span class="font-mono text-emerald-300 font-bold">
              ${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)} (${pct}%)
            </span>
          </div>

          <!-- Barra de progresso geral do pack -->
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between text-[9px] text-slate-400">
              <span>Progresso geral do pack:</span>
              <span class="font-mono font-semibold text-slate-200">${pct}%</span>
            </div>
            <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden p-0.5">
              <div class="h-full rounded-full bg-gradient-to-r from-sky-500 via-indigo-500 to-emerald-400 transition-all duration-200" style="width: ${pct}%"></div>
            </div>
          </div>

          ${t.maxDownloads > 0 ? `
            <div class="flex items-center justify-between text-[9px] text-slate-300 font-mono bg-slate-900/90 px-2 py-1 rounded border border-slate-800">
              <span>🎯 Limite de downloads:</span>
              <span class="text-sky-300 font-bold">${t.completedPacks || 0} de ${t.maxDownloads} concluído(s)</span>
            </div>
          ` : ''}

          <!-- Progresso individual de cada arquivo no pack -->
          <div class="flex flex-col gap-1.5 pt-1 border-t border-slate-800/80">
            <span class="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
              Arquivos no pack (${displayFiles.length}):
            </span>
            ${displayFiles.map((f) => {
              const fSize = f.size || 0;
              const fPct = typeof f.progress === 'number' ? Math.min(100, Math.max(0, Math.round(f.progress))) : (f.status === 'DONE' ? 100 : 0);
              const fBytes = typeof f.bytesSent === 'number' ? f.bytesSent : (f.status === 'DONE' ? fSize : Math.round((fSize * fPct) / 100));
              const fStatusLabel = f.status === 'DOWNLOADING' ? '⬇ Baixando...' : f.status === 'DONE' ? '✓ Concluído' : 'Aguardando';
              const fStatusColor = f.status === 'DOWNLOADING' ? 'text-amber-300' : f.status === 'DONE' ? 'text-emerald-300' : 'text-slate-500';
              const fBarColor = f.status === 'DONE' ? 'bg-emerald-400' : f.status === 'DOWNLOADING' ? 'bg-amber-400' : 'bg-slate-700';

              return `
                <div class="flex flex-col gap-1 bg-slate-900/90 p-2 rounded-lg border border-slate-800">
                  <div class="flex items-center justify-between text-[10px] gap-2">
                    <span class="truncate text-slate-200 font-medium" title="${f.name}">📄 ${f.name}</span>
                    <span class="font-mono font-bold text-xs ${fPct === 100 ? 'text-emerald-400' : fPct > 0 ? 'text-sky-300' : 'text-slate-500'} shrink-0">${fPct}%</span>
                  </div>
                  <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full rounded-full ${fBarColor} transition-all duration-150" style="width: ${fPct}%"></div>
                  </div>
                  <div class="flex items-center justify-between text-[9px] text-slate-400 font-mono">
                    <span>${formatBytes(fBytes)} de ${formatBytes(fSize)}</span>
                    <span class="${fStatusColor} font-semibold">${fStatusLabel}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0 cursor-pointer" data-action="toggle-expand-transfer" data-transfer-id="${t.id}" title="Clique para ver o progresso detalhado">
          <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border ${badgeColor} shrink-0">
            ${badgeLabel}
          </span>
          <span class="text-xs font-semibold text-slate-100 truncate hover:text-sky-300 transition-colors" title="${displayName}">
            ${displayName}
          </span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${controlButtonsHtml}
          ${postActionsHtml}
          <span class="text-xs font-mono font-bold ${pctColor}">${pct}%</span>
          ${deleteButtonHtml}
        </div>
      </div>

      <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden p-0.5 cursor-pointer" data-action="toggle-expand-transfer" data-transfer-id="${t.id}">
        <div
          class="h-full rounded-full ${barColor} transition-all duration-150"
          style="width: ${pct}%"
        ></div>
      </div>

      <div class="flex items-center justify-between text-[10px] text-slate-400">
        <span class="font-mono text-slate-300">
          ${t.peerTag} • ${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}
        </span>
        <span class="${isError || isCancelled || isExpired ? 'text-rose-400 font-medium' : isDone ? 'text-emerald-400 font-medium' : isPaused ? 'text-amber-400 font-medium' : 'text-slate-300'}">
          ${statusLabel(t)}
        </span>
      </div>

      <!-- Botão para alternar exibição do progresso detalhado -->
      <button
        type="button"
        data-action="toggle-expand-transfer"
        data-transfer-id="${t.id}"
        class="w-full text-left text-[10px] text-sky-400 hover:text-sky-300 flex items-center justify-between pt-0.5 cursor-pointer"
      >
        <span class="font-medium">${isExpanded ? '▴ Ocultar progresso detalhado' : '▾ Ver progresso dos downloads do destinatário'}</span>
        <span class="font-mono text-[9px] text-slate-500">${displayFiles.length} arquivo(s)</span>
      </button>

      ${expandedDetailsHtml}

      ${tunnelLinkBoxHtml}
    `;

    transfersList.appendChild(card);
  }
}

function syncModalWithState() {
  if (Array.isArray(currentState.stagedTunnelFiles)) {
    stagedTunnelFiles = currentState.stagedTunnelFiles;
  }
  renderModalFiles();
  if (currentState.tunnelModalOpen || stagedTunnelFiles.length > 0) {
    tunnelConfigModal.classList.remove('hidden');
  }
}

function renderAll() {
  renderConnectionStatus();
  renderSettingsSwitches();
  renderPeerDirectory();
  renderReceiveButton();
  renderTransfers();
  syncModalWithState();
}

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

btnCloseSettings.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

toggleAutoOpen.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_OPEN_ON_RECEIVE' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});

toggleAutoAccept.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_ACCEPT' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});

function saveMyTag() {
  const formatted = normalizeTag(myTagInput.value);
  if (!formatted || formatted.length < 3) {
    showToast('Informe um @usuario válido (mínimo 2 caracteres).');
    return;
  }
  myTagInput.value = formatted;
  chrome.runtime.sendMessage({ action: 'SET_MY_TAG', tag: formatted }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
}

btnSaveTag.addEventListener('click', saveMyTag);
myTagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveMyTag();
});

peersList.addEventListener('click', (e) => {
  const peerBtn = e.target.closest('button[data-peer-tag]');
  if (!peerBtn) return;
  const tag = peerBtn.getAttribute('data-peer-tag');
  if (tag) {
    targetTagInput.value = tag;
    chrome.storage.local.set({ lastTargetTag: tag });
    renderPeerDirectory();
  }
});

targetTagInput.addEventListener('input', () => {
  chrome.storage.local.set({ lastTargetTag: targetTagInput.value.trim() });
  renderPeerDirectory();
});

function openModalForTunnel() {
  currentModalMode = 'tunnel';
  if (modalHeaderTitle) modalHeaderTitle.textContent = 'Configurar Pack & Envio (Cloudflare Tunnel)';
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-orange-400';
  if (modalTunnelOptions) modalTunnelOptions.classList.remove('hidden');
  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-400 hover:to-amber-500 text-white text-xs font-bold shadow-md border border-orange-400/30 transition-all cursor-pointer';
    btnModalConfirm.textContent = 'Confirmar & Gerar Link';
  }
  closeQuickBrowserView();
  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({ action: 'SET_TUNNEL_MODAL_OPEN', open: true });

  if (stagedTunnelFiles.length === 0) {
    chrome.runtime.sendMessage({
      action: 'DAEMON_PICK_FILES',
      mode: 'tunnel',
      pickType: 'files',
      append: true
    });
  }
}

function openModalForP2P(targetTag) {
  currentModalMode = 'p2p';
  if (modalHeaderTitle) modalHeaderTitle.textContent = `Configurar Envio P2P para ${targetTag}`;
  if (modalIndicatorDot) modalIndicatorDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
  if (modalTunnelOptions) modalTunnelOptions.classList.add('hidden');
  if (btnModalConfirm) {
    btnModalConfirm.className =
      'flex-1 py-1.5 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500 text-white text-xs font-bold shadow-md border border-emerald-400/30 transition-all cursor-pointer';
    btnModalConfirm.textContent = 'Confirmar & Enviar P2P';
  }
  closeQuickBrowserView();
  tunnelConfigModal.classList.remove('hidden');
  chrome.runtime.sendMessage({ action: 'SET_TUNNEL_MODAL_OPEN', open: true });

  if (stagedTunnelFiles.length === 0) {
    chrome.runtime.sendMessage({
      action: 'DAEMON_PICK_FILES',
      mode: 'tunnel',
      pickType: 'files',
      append: true
    });
  }
}

btnSend.addEventListener('click', () => {
  const targetTag = normalizeTag(targetTagInput.value);
  if (!targetTag || targetTag.length < 3) {
    showToast('Digite ou clique em um @destinatario da lista P2P.');
    targetContainer.classList.add('ring-2', 'ring-rose-500');
    targetTagInput.focus();
    setTimeout(() => targetContainer.classList.remove('ring-2', 'ring-rose-500'), 1500);
    return;
  }

  if (targetTag === currentState.myTag) {
    showToast('Escolha um @destinatario diferente do seu próprio ID.');
    return;
  }

  targetTagInput.value = targetTag;
  chrome.storage.local.set({ lastTargetTag: targetTag });

  openModalForP2P(targetTag);
});

btnCloudflareTunnel.addEventListener('click', () => {
  openModalForTunnel();
});

// ============================================================================
// Modal de Configuração do Pack (Arquivos, Pastas, Compactação ZIP/RAR/7Z, etc)
// ============================================================================
function renderModalFiles() {
  modalFilesList.innerHTML = '';
  if (stagedTunnelFiles.length === 0) {
    modalFilesSummary.textContent = 'Itens no Pack (0) • 0 B';
    modalFilesList.innerHTML = `
      <div class="flex flex-col items-center justify-center py-2.5 px-2 text-center gap-1">
        <span class="text-[11px] text-slate-300 font-medium">Nenhum item adicionado ao pack.</span>
        <span class="text-[9px] text-slate-400">Clique em <strong class="text-sky-400">📁 Pastas Rápidas</strong>, <strong class="text-orange-400">+ Arquivo</strong> ou <strong class="text-emerald-400">+ Pasta</strong>.</span>
      </div>
    `;
    return;
  }

  const totalBytes = stagedTunnelFiles.reduce((acc, f) => acc + (f.size || 0), 0);
  modalFilesSummary.textContent = `Itens no Pack (${stagedTunnelFiles.length}) • ${formatBytes(totalBytes)}`;

  stagedTunnelFiles.forEach((file, index) => {
    const isDir = Boolean(file.isDirectory);
    const item = document.createElement('div');
    item.className =
      'flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs';
    item.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-[11px] ${isDir ? 'text-amber-400' : 'text-sky-400'} font-mono">
          ${isDir ? '📂' : '📄'}
        </span>
        <span class="text-[11px] ${isDir ? 'text-amber-200 font-semibold' : 'text-slate-200 font-medium'} truncate max-w-[170px]" title="${file.name}">
          ${file.name}
        </span>
        <span class="text-[10px] text-slate-400 font-mono shrink-0">
          (${isDir && file.fileCount ? `${file.fileCount} itens, ` : ''}${formatBytes(file.size)})
        </span>
      </div>
      <button
        type="button"
        data-remove-index="${index}"
        class="text-slate-500 hover:text-rose-400 font-bold px-1 text-xs cursor-pointer transition-colors"
        title="Remover do pack"
      >
        ✕
      </button>
    `;
    modalFilesList.appendChild(item);
  });
}

modalFilesList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-remove-index]');
  if (!btn) return;
  const idx = Number(btn.getAttribute('data-remove-index'));
  if (!Number.isNaN(idx) && idx >= 0 && idx < stagedTunnelFiles.length) {
    chrome.runtime.sendMessage({ action: 'REMOVE_STAGED_TUNNEL_FILE', index: idx }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        syncModalWithState();
      }
    });
  }
});

btnModalAddMore.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    action: 'DAEMON_PICK_FILES',
    mode: 'tunnel',
    pickType: 'files',
    append: true
  });
});

if (btnModalAddFolder) {
  btnModalAddFolder.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      action: 'DAEMON_PICK_FILES',
      mode: 'tunnel',
      pickType: 'directory',
      append: true
    });
  });
}

// ============================================================================
// Mini Explorador Rápido de Arquivos e Pastas Embutido (Com rolagem interna e margens)
// ============================================================================
let currentQuickBrowserDir = '';
let parentQuickBrowserDir = '';

function openQuickBrowserView() {
  if (modalViewPack) modalViewPack.classList.add('hidden');
  if (modalQuickBrowserPanel) {
    modalQuickBrowserPanel.classList.remove('hidden');
    modalQuickBrowserPanel.classList.add('flex');
  }
  loadQuickBrowserDir(currentQuickBrowserDir);
}

function closeQuickBrowserView() {
  if (modalQuickBrowserPanel) {
    modalQuickBrowserPanel.classList.add('hidden');
    modalQuickBrowserPanel.classList.remove('flex');
  }
  if (modalViewPack) modalViewPack.classList.remove('hidden');
}

async function addDirectoryToPack(dirPath) {
  if (!dirPath) return;
  try {
    showToast('Escaneando pasta...');
    const res = await fetch(`http://127.0.0.1:18765/api/fs/scan-dir?path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();
    if (!data || !data.ok) {
      showToast(data.error || 'Erro ao ler pasta.');
      return;
    }
    const folderObj = {
      fileId: `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: data.name,
      diskPath: data.diskPath,
      size: data.totalSize,
      fileCount: data.fileCount,
      isDirectory: true,
      files: data.files
    };

    chrome.runtime.sendMessage(
      { action: 'ADD_STAGED_TUNNEL_FILES', files: [folderObj] },
      (response) => {
        if (response && response.state) {
          currentState = response.state;
          syncModalWithState();
          loadQuickBrowserDir(currentQuickBrowserDir);
          showToast(`Pasta "${data.name}" (${data.fileCount} itens, ${formatBytes(data.totalSize)}) adicionada!`);
        }
      }
    );
  } catch (err) {
    console.error('Erro ao adicionar pasta:', err);
    showToast('Falha ao adicionar pasta.');
  }
}

async function loadQuickBrowserDir(dir = '') {
  try {
    const url = dir
      ? `http://127.0.0.1:18765/api/fs/list?dir=${encodeURIComponent(dir)}`
      : 'http://127.0.0.1:18765/api/fs/list';
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.ok) return;

    currentQuickBrowserDir = data.currentDir || '';
    parentQuickBrowserDir = data.parentDir || '';
    if (quickBrowserPath) {
      quickBrowserPath.textContent = currentQuickBrowserDir;
      quickBrowserPath.title = currentQuickBrowserDir;
    }

    if (btnQuickBrowserAddCurrent) {
      const folderName = currentQuickBrowserDir.split(/[/\\]/).pop() || currentQuickBrowserDir;
      const span = btnQuickBrowserAddCurrent.querySelector('span');
      if (span) span.textContent = `📂 + Adicionar esta pasta inteira (${folderName})`;
    }

    if (quickBrowserCount) {
      const totalCount = (data.folders || []).length + (data.files || []).length;
      quickBrowserCount.textContent = `(${totalCount} itens)`;
    }

    if (quickBrowserShortcuts && Array.isArray(data.shortcuts)) {
      quickBrowserShortcuts.innerHTML = data.shortcuts
        .map(
          (s) => `
          <button
            type="button"
            data-shortcut-dir="${s.path.replace(/"/g, '&quot;')}"
            class="px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-sky-500/20 text-[9px] text-slate-300 hover:text-sky-300 border border-slate-800 shrink-0 cursor-pointer transition-colors"
          >
            ${s.label}
          </button>
        `
        )
        .join('');
    }

    if (quickBrowserEntries) {
      quickBrowserEntries.innerHTML = '';

      (data.folders || []).forEach((folder) => {
        const isAlreadyAdded = stagedTunnelFiles.some((f) => f.diskPath === folder.path);
        const row = document.createElement('div');
        row.className =
          'w-full flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-900/60 hover:bg-slate-900 border border-slate-800 text-[11px] text-slate-200 transition-colors';
        row.innerHTML = `
          <button
            type="button"
            data-folder-path="${folder.path.replace(/"/g, '&quot;')}"
            class="flex items-center gap-1.5 truncate flex-1 text-left hover:text-sky-300 cursor-pointer"
            title="Abrir pasta ${folder.name}"
          >
            <span class="text-amber-400 font-mono">📂</span>
            <span class="truncate font-medium">${folder.name}</span>
          </button>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-add-folder-path="${folder.path.replace(/"/g, '&quot;')}"
              class="text-[9px] px-2 py-0.5 rounded font-medium cursor-pointer transition-colors ${
                isAlreadyAdded
                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/40 font-bold'
                  : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30'
              }"
              title="Adicionar pasta inteira ao pack"
            >
              ${isAlreadyAdded ? '✓ Na fila' : '+ Pasta'}
            </button>
            <button
              type="button"
              data-folder-path="${folder.path.replace(/"/g, '&quot;')}"
              class="text-[9px] text-slate-400 hover:text-white px-1 py-0.5 cursor-pointer"
            >
              Abrir ➔
            </button>
          </div>
        `;
        quickBrowserEntries.appendChild(row);
      });

      (data.files || []).forEach((file) => {
        const alreadyAdded = stagedTunnelFiles.some((f) => f.diskPath === file.diskPath);
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('data-file-json', JSON.stringify(file));
        row.className = `w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left text-[11px] cursor-pointer transition-colors ${
          alreadyAdded
            ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-500/30'
            : 'bg-slate-900/60 hover:bg-sky-500/10 text-slate-200 border border-slate-800/80'
        }`;
        row.innerHTML = `
          <span class="truncate pr-2">📄 ${file.name}</span>
          <span class="text-[9px] font-mono shrink-0 ${alreadyAdded ? 'text-emerald-400 font-bold' : 'text-sky-400'}">
            ${alreadyAdded ? '✓ No pack' : `+ ${formatBytes(file.size)}`}
          </span>
        `;
        quickBrowserEntries.appendChild(row);
      });

      if ((data.folders || []).length === 0 && (data.files || []).length === 0) {
        quickBrowserEntries.innerHTML =
          '<div class="text-[11px] text-slate-500 italic text-center py-4">Pasta vazia</div>';
      }
    }
  } catch (err) {
    console.error('Erro ao carregar navegador rápido:', err);
  }
}

if (btnModalQuickBrowser) {
  btnModalQuickBrowser.addEventListener('click', openQuickBrowserView);
}

if (btnQuickBrowserClose) {
  btnQuickBrowserClose.addEventListener('click', closeQuickBrowserView);
}

if (btnQuickBrowserUp) {
  btnQuickBrowserUp.addEventListener('click', () => {
    if (parentQuickBrowserDir) {
      loadQuickBrowserDir(parentQuickBrowserDir);
    }
  });
}

if (btnQuickBrowserAddCurrent) {
  btnQuickBrowserAddCurrent.addEventListener('click', () => {
    if (currentQuickBrowserDir) {
      addDirectoryToPack(currentQuickBrowserDir);
    }
  });
}

if (quickBrowserShortcuts) {
  quickBrowserShortcuts.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-shortcut-dir]');
    if (!btn) return;
    loadQuickBrowserDir(btn.getAttribute('data-shortcut-dir'));
  });
}

if (quickBrowserEntries) {
  quickBrowserEntries.addEventListener('click', (e) => {
    const addFolderBtn = e.target.closest('button[data-add-folder-path]');
    if (addFolderBtn) {
      const folderPath = addFolderBtn.getAttribute('data-add-folder-path');
      addDirectoryToPack(folderPath);
      return;
    }

    const folderBtn = e.target.closest('button[data-folder-path]');
    if (folderBtn) {
      loadQuickBrowserDir(folderBtn.getAttribute('data-folder-path'));
      return;
    }

    const fileBtn = e.target.closest('button[data-file-json]');
    if (fileBtn) {
      try {
        const fileObj = JSON.parse(fileBtn.getAttribute('data-file-json'));
        chrome.runtime.sendMessage(
          { action: 'ADD_STAGED_TUNNEL_FILES', files: [fileObj] },
          (res) => {
            if (res && res.state) {
              currentState = res.state;
              syncModalWithState();
              loadQuickBrowserDir(currentQuickBrowserDir);
            }
          }
        );
      } catch {}
    }
  });
}

// Opções de Compactação do Pack
if (modalCompressToggle) {
  modalCompressToggle.addEventListener('change', () => {
    if (modalCompressToggle.checked) {
      modalCompressOptions.classList.remove('hidden');
    } else {
      modalCompressOptions.classList.add('hidden');
    }
  });
}

if (modalCompressFormat) {
  modalCompressFormat.addEventListener('change', () => {
    const ext = '.' + modalCompressFormat.value;
    if (modalCompressExtBadge) modalCompressExtBadge.textContent = ext;
  });
}

btnModalGenPassword.addEventListener('click', () => {
  const randomPass = Math.floor(100000 + Math.random() * 900000).toString();
  modalPasswordInput.value = randomPass;
});

btnModalClearPassword.addEventListener('click', () => {
  modalPasswordInput.value = '';
});

function closeAndResetModal() {
  closeQuickBrowserView();
  tunnelConfigModal.classList.add('hidden');
  stagedTunnelFiles = [];
  if (modalCompressToggle) modalCompressToggle.checked = false;
  if (modalCompressOptions) modalCompressOptions.classList.add('hidden');
  chrome.runtime.sendMessage({ action: 'CLEAR_STAGED_TUNNEL_FILES' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
}

btnModalClose.addEventListener('click', closeAndResetModal);
btnModalCancel.addEventListener('click', closeAndResetModal);

btnModalConfirm.addEventListener('click', async () => {
  if (stagedTunnelFiles.length === 0) {
    showToast('Adicione pelo menos um arquivo ou pasta ao pack.');
    return;
  }

  const isCompressEnabled = Boolean(modalCompressToggle && modalCompressToggle.checked);
  const compressFormat = modalCompressFormat ? modalCompressFormat.value : 'zip';
  const compressLevel = modalCompressLevel ? Number(modalCompressLevel.value) : 5;
  const customCompressName = modalCompressName ? modalCompressName.value.trim() : '';

  btnModalConfirm.disabled = true;
  const originalConfirmText = btnModalConfirm.textContent;

  try {
    let finalFilesMeta = [];
    let finalPackName = '';
    let finalTotalSize = 0;

    // Se compactação estiver ativada, comprime tudo em .zip, .rar ou .7z antes de enviar!
    if (isCompressEnabled) {
      btnModalConfirm.textContent = `Compactando pack em .${compressFormat} (Nível ${compressLevel})...`;
      const compRes = await fetch('http://127.0.0.1:18765/api/pack/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: stagedTunnelFiles,
          format: compressFormat,
          level: compressLevel,
          outputName: customCompressName
        })
      });
      const compData = await compRes.json();
      if (!compData || !compData.ok) {
        throw new Error(compData.error || 'Falha ao compactar arquivos.');
      }

      finalFilesMeta = [
        {
          fileId: `f-0`,
          name: compData.fileName,
          size: compData.size,
          type: compData.type || 'application/octet-stream',
          diskPath: compData.diskPath
        }
      ];
      finalPackName = compData.fileName;
      finalTotalSize = compData.size;
    } else {
      // Sem compactação
      finalFilesMeta = stagedTunnelFiles.map((f, i) => ({
        fileId: f.fileId || `f-${i}`,
        name: f.name,
        size: f.size,
        type: f.type || 'application/octet-stream',
        diskPath: f.diskPath || null,
        isDirectory: Boolean(f.isDirectory)
      }));
      finalTotalSize = stagedTunnelFiles.reduce((acc, f) => acc + (f.size || 0), 0);
      finalPackName =
        stagedTunnelFiles.length === 1
          ? stagedTunnelFiles[0].name
          : `Pack (${stagedTunnelFiles.length} itens)`;
    }

    if (currentModalMode === 'tunnel') {
      const expirationMin = Number(modalExpirationSelect ? modalExpirationSelect.value : 30);
      const expiresAt = expirationMin > 0 ? Date.now() + expirationMin * 60 * 1000 : null;
      const password = (modalPasswordInput ? modalPasswordInput.value : '').trim();
      const maxDownloads = Number(modalDownloadLimitSelect ? modalDownloadLimitSelect.value : 0);

      const shareId = `cf-${Array.from(crypto.getRandomValues(new Uint8Array(3)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;

      btnModalConfirm.textContent = 'Criando sessão no daemon...';
      const sessionRes = await fetch('http://127.0.0.1:18765/api/tunnel/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareId,
          packName: finalPackName,
          expiresInMinutes: expirationMin,
          password,
          maxDownloads,
          totalSize: finalTotalSize,
          files: finalFilesMeta
        })
      });
      if (!sessionRes.ok) {
        throw new Error('Daemon local offline. Verifique se o daemon está rodando em 127.0.0.1:18765');
      }

      // Upload de arquivos sem diskPath (caso haja algum em memória)
      for (let i = 0; i < finalFilesMeta.length; i++) {
        if (!finalFilesMeta[i].diskPath && stagedTunnelFiles[i]) {
          btnModalConfirm.textContent = `Preparando arquivo (${i + 1}/${finalFilesMeta.length})...`;
          const upRes = await fetch(
            `http://127.0.0.1:18765/api/tunnel/upload-file?shareId=${encodeURIComponent(shareId)}&fileIndex=${i}`,
            {
              method: 'POST',
              body: stagedTunnelFiles[i]
            }
          );
          if (!upRes.ok) {
            throw new Error(`Falha no upload do arquivo ${finalFilesMeta[i].name}`);
          }
        }
      }

      btnModalConfirm.textContent = 'Gerando link *.trycloudflare.com...';
      const startRes = await fetch('http://127.0.0.1:18765/api/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareId })
      });
      const startData = await startRes.json();
      if (!startData.ok || !startData.tunnelUrl) {
        throw new Error(startData.error || 'Falha ao obter URL do túnel Cloudflare.');
      }

      const shareUrl = startData.tunnelUrl;
      chrome.runtime.sendMessage(
        {
          action: 'START_CLOUDFLARE_TUNNEL_SHARE',
          shareId,
          packName: finalPackName,
          files: finalFilesMeta,
          totalSize: finalTotalSize,
          shareUrl,
          hasPassword: Boolean(password),
          password,
          maxDownloads,
          expiresAt
        },
        async (res) => {
          if (res && res.error) {
            showToast(res.error);
            return;
          }
          if (res && res.state) {
            currentState = res.state;
            renderAll();
          }

          const formattedMessage = formatShareMessage({
            shareUrl,
            password,
            expiresAt,
            maxDownloads,
            files: finalFilesMeta
          });

          try {
            await navigator.clipboard.writeText(formattedMessage);
            showToast('✓ Link Cloudflare gerado e copiado para a área de transferência!');
          } catch {
            showToast('Túnel aberto! Copie o link na lista abaixo.');
          }
        }
      );
    } else if (currentModalMode === 'p2p') {
      const targetTag = normalizeTag(targetTagInput.value);
      if (!targetTag) {
        throw new Error('Destinatário P2P não especificado.');
      }

      btnModalConfirm.textContent = 'Iniciando transferência P2P...';
      for (const item of finalFilesMeta) {
        if (item.diskPath) {
          const fileRes = await fetch(
            `http://127.0.0.1:18765/api/read-local-file?path=${encodeURIComponent(item.diskPath)}`
          );
          if (fileRes.ok) {
            const blob = await fileRes.blob();
            const fileObj = new File([blob], item.name, { type: item.type || 'application/octet-stream' });
            const transferId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            chrome.runtime.sendMessage({
              action: 'START_SEND_FILE',
              transferId,
              targetTag,
              fileMeta: {
                name: item.name,
                size: item.size,
                type: item.type || 'application/octet-stream'
              }
            });
          }
        }
      }
      showToast(`Transferência enviada para ${targetTag}!`);
    }

    closeAndResetModal();
    checkDaemonStatus();
  } catch (err) {
    console.error('Erro ao confirmar pack:', err);
    showToast(`Erro: ${err.message}`);
  } finally {
    btnModalConfirm.disabled = false;
    btnModalConfirm.textContent = originalConfirmText;
  }
});

if (tabActiveTransfers) {
  tabActiveTransfers.addEventListener('click', () => {
    currentTransfersTab = 'active';
    tabActiveTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer';
    tabHistoryTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
    renderTransfers();
  });
}

if (tabHistoryTransfers) {
  tabHistoryTransfers.addEventListener('click', () => {
    currentTransfersTab = 'history';
    tabHistoryTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30 cursor-pointer';
    tabActiveTransfers.className =
      'px-2 py-0.5 rounded-md text-[10px] font-medium text-slate-400 hover:text-slate-200 cursor-pointer';
    renderTransfers();
  });
}

btnReceive.addEventListener('click', () => {
  const pendingIncoming = Object.values(currentState.transfers || []).find(
    (t) => t.direction === 'incoming' && t.status === 'AWAITING_ACCEPT'
  );

  if (pendingIncoming) {
    chrome.runtime.sendMessage({
      action: 'RESPOND_INCOMING',
      transferId: pendingIncoming.id,
      accept: true
    });
    return;
  }

  chrome.runtime.sendMessage({ action: 'TOGGLE_AUTO_ACCEPT' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});

transfersList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  const expandTarget = e.target.closest('[data-action="toggle-expand-transfer"]');

  if (expandTarget && (!btn || btn.getAttribute('data-action') === 'toggle-expand-transfer')) {
    const tid = expandTarget.getAttribute('data-transfer-id');
    if (tid) {
      if (expandedTransferIds.has(tid)) {
        expandedTransferIds.delete(tid);
      } else {
        expandedTransferIds.add(tid);
      }
      renderTransfers();
      return;
    }
  }

  if (!btn) return;

  const action = btn.getAttribute('data-action');
  const downloadId = Number(btn.getAttribute('data-download-id'));
  const transferId = btn.getAttribute('data-transfer-id');
  const url = btn.getAttribute('data-url');

  if (action === 'delete-single-transfer' && transferId) {
    chrome.runtime.sendMessage({ action: 'DELETE_TRANSFER', transferId }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
    return;
  }

  if (action === 'pause-transfer' && transferId) {
    fetch('http://127.0.0.1:18765/api/tunnel/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId: transferId })
    }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'PAUSE_TRANSFER', transferId }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  } else if (action === 'resume-transfer' && transferId) {
    fetch('http://127.0.0.1:18765/api/tunnel/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId: transferId })
    }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'RESUME_TRANSFER', transferId }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  } else if (action === 'cancel-transfer' && transferId) {
    fetch('http://127.0.0.1:18765/api/tunnel/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareId: transferId })
    }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'CANCEL_TRANSFER', transferId }, (res) => {
      if (res && res.state) {
        currentState = res.state;
        renderAll();
      }
    });
  } else if (action === 'show-folder' && !Number.isNaN(downloadId)) {
    chrome.downloads.show(downloadId);
  } else if (action === 'open-file' && !Number.isNaN(downloadId)) {
    chrome.downloads.open(downloadId);
  } else if (action === 'accept-transfer' && transferId) {
    chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: true });
  } else if (action === 'reject-transfer' && transferId) {
    chrome.runtime.sendMessage({ action: 'RESPOND_INCOMING', transferId, accept: false });
  } else if (action === 'copy-tunnel-formatted' && transferId) {
    const t = currentState.transfers[transferId];
    if (!t) return;
    const formatted = formatShareMessage({
      shareUrl: t.shareUrl,
      password: t.password,
      expiresAt: t.expiresAt,
      maxDownloads: t.maxDownloads,
      files: t.files || [{ name: t.fileName, size: t.fileSize }]
    });
    try {
      await navigator.clipboard.writeText(formatted);
      btn.textContent = 'Copiado ✓';
      setTimeout(() => {
        btn.textContent = 'Copiar';
      }, 1800);
      showToast('Link, senha e expiração copiados!');
    } catch {
      showToast('Não foi possível copiar automaticamente.');
    }
  } else if (action === 'copy-tunnel-url' && url) {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Copiado ✓';
      setTimeout(() => {
        btn.textContent = 'Copiar';
      }, 1800);
    } catch {
      showToast('Não foi possível copiar automaticamente.');
    }
  } else if (action === 'download-p2p-portal' && transferId) {
    const t = currentState.transfers[transferId];
    if (!t) return;
    const htmlContent = buildStandaloneP2PHtmlPortal(t);
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `Baixar_${t.fileName}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } else if (action === 'open-tunnel-url' && url) {
    chrome.tabs.create({ url });
  }
});

btnClearCompleted.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATED') {
    currentState = msg.state;
    renderAll();
  } else if (msg.type === 'TOAST_ERROR') {
    showToast(msg.message);
  }
});

// Atualiza contadores regressivos e barras a cada segundo
setInterval(() => {
  renderTransfers();
}, 1000);

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const stored = await chrome.storage.local.get(['lastTargetTag']);

  if (params.get('target')) {
    targetTagInput.value = params.get('target');
  } else if (stored.lastTargetTag) {
    targetTagInput.value = stored.lastTargetTag;
  }

  checkDaemonStatus();
  setInterval(checkDaemonStatus, 5000);

  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
    if (res && res.state) {
      currentState = res.state;
      renderAll();
    }
  });
});
