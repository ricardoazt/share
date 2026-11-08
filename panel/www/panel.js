// PulseSharePanel — painel administrativo da rede PulseShare.
// Conecta aos mesmos brokers MQTT do app (tópico global), monta a lista de
// usuários a partir da presença, do catálogo de nomes e das respostas à
// sincronização, e publica registros ASSINADOS pelo administrador (a assinatura
// é feita no processo principal, ver main.js):
//   broadcast    → mensagem na conversa oficial "PulseShare" de todos os usuários
//   delete_user  → exclui a conta em todos os nós (propaga entre os aparelhos)
//   restore_user → desfaz a exclusão
//   sync_request → pede a cada aparelho online o relatório (ADMIN_SYNC_REPLY)
// Protocolo descrito no CLAUDE.md (§3) e em app.js (§4e).
'use strict';

(() => {
  const API = window.PulseSharePanel;
  const DEFAULT_BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  // Mesma chave pública embutida no app.js (ADMIN_PUBLIC_KEYS)
  const APP_ADMIN_PUBLIC_KEYS = [
    { x: '8GFJKFuR4sGEIX4FBsMRa8J0yXU2XqGU32seSLx2Fr0', y: '7wXYjRMKZdt5DiGjqAjUGUDO17IAJWwI2uUa_TLKfeU' }
  ];
  const PANEL_TAG = '@ps_panel';
  const ONLINE_MS = 45 * 1000;
  const SYNC_WINDOW_MS = 10 * 1000;
  const DAY = 24 * 3600 * 1000;
  const DB_KEY = 'psp_db_v1';
  const BROADCAST_KEEP = 60;               // mesmos limites que o app guarda
  const BROADCAST_MAX_AGE = 180 * DAY;

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ dados
  let info = { hasKey: false, topic: 'pulseshare/v2/p2p_mesh_global', brokers: null, keyFile: '' };
  let TOPIC = info.topic;
  let BROKERS = DEFAULT_BROKERS;

  function loadDb() {
    try {
      const d = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      if (d && d.users) return { users: d.users, records: Array.isArray(d.records) ? d.records : [], lastSyncAt: d.lastSyncAt || 0, nodeId: d.nodeId || '' };
    } catch (e) {}
    return { users: {}, records: [], lastSyncAt: 0, nodeId: '' };
  }
  let db = loadDb();
  if (!db.nodeId) db.nodeId = 'panel_' + randHex(12);
  // Registros com o corpo já lido
  let records = db.records.map((r) => { try { return { b: r.b, s: r.s, body: JSON.parse(r.b) }; } catch (e) { return null; } }).filter(Boolean);
  let deletedBySuffix = new Map(); // sufixo → corpo do delete_user vigente

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      db.records = records.map((r) => ({ b: r.b, s: r.s }));
      try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { toast('Não foi possível salvar os dados locais do painel.', 'error'); }
    }, 600);
  }
  window.addEventListener('beforeunload', () => {
    db.records = records.map((r) => ({ b: r.b, s: r.s }));
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {}
  });

  const live = new Map();      // sufixo → último sinal ao vivo (presença / resposta) nesta sessão
  const seenPkts = new Set();
  let sync = null;             // sincronização em andamento
  let firstSyncDone = false;

  // ------------------------------------------------------------------ utilitários
  function randHex(n) {
    const a = new Uint8Array(Math.ceil(n / 2));
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function normalizeTag(tag) {
    return tag ? String(tag).toLowerCase().trim().replace(/[^a-z0-9_@]/g, '') : '';
  }
  function splitTag(tag) {
    const m = /^@([a-z0-9_]{1,40})_([0-9a-f]{6})$/.exec(normalizeTag(tag));
    if (!m || m[1] === 'link') return null;
    return { name: m[1], suffix: m[2] };
  }
  // Datas vindas da rede: só valores plausíveis (2020 … agora + 1 dia)
  function cleanTs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1577836800000 || n > Date.now() + DAY) return 0;
    return Math.min(n, Date.now());
  }
  const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function fmtDate(ts) { return ts ? dateFmt.format(new Date(ts)) : '—'; }
  function fmtRel(ts) {
    if (!ts) return 'nunca visto';
    const d = Date.now() - ts;
    if (d < 60 * 1000) return 'agora mesmo';
    if (d < 3600 * 1000) return `há ${Math.floor(d / 60000)} min`;
    if (d < DAY) return `há ${Math.floor(d / 3600000)} h`;
    const days = Math.floor(d / DAY);
    if (days < 31) return `há ${days} dia${days > 1 ? 's' : ''}`;
    const months = Math.floor(days / 30);
    if (months < 12) return `há ${months} ${months > 1 ? 'meses' : 'mês'}`;
    const years = Math.floor(days / 365);
    return `há ${years} ano${years > 1 ? 's' : ''}`;
  }
  function clientLabel(c) {
    return { android: 'Android', desktop: 'Desktop (Linux)', 'extension-app': 'Extensão Chrome', web: 'Navegador' }[c] || (c ? c : '—');
  }
  function avatarClass(sfx) { return 'av-' + (parseInt(sfx.slice(0, 2), 16) % 8); }

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 8000 : 5000);
  }

  function confirmModal(title, html, okLabel, danger) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-body').innerHTML = html;
      const ok = $('modal-ok');
      ok.textContent = okLabel || 'Confirmar';
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      $('modal').classList.remove('hidden');
      const done = (v) => {
        $('modal').classList.add('hidden');
        ok.onclick = null;
        $('modal-cancel').onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      ok.onclick = () => done(true);
      $('modal-cancel').onclick = () => done(false);
      ok.focus();
    });
  }

  // ------------------------------------------------------------------ usuários
  // Uma conta = um sufixo (_hash6, vem das chaves). O nome pode mudar.
  function upsertUser(suffix, name, o = {}) {
    if (!/^[0-9a-f]{6}$/.test(suffix || '') || !/^[a-z0-9_]{1,40}$/.test(name || '')) return null;
    const now = Date.now();
    let u = db.users[suffix];
    const isNew = !u;
    if (!u) {
      u = db.users[suffix] = { suffix, name, tag: `@${name}_${suffix}`, nameAt: 0, createdAt: 0, lastSeen: 0, firstSeen: now, clientType: '', nodeIds: [], contacts: null };
    }
    // Nome atual = o observado mais recentemente
    const nameAt = cleanTs(o.nameAt) || 0;
    if (name !== u.name && nameAt >= (u.nameAt || 0)) {
      u.name = name;
      u.tag = `@${name}_${suffix}`;
    }
    if (nameAt > (u.nameAt || 0) && name === u.name) u.nameAt = nameAt;
    // Criação da conta: a data mais antiga que algum aparelho informar
    [o.createdAt, o.since].forEach((v) => {
      const t = cleanTs(v);
      if (t && (!u.createdAt || t < u.createdAt)) u.createdAt = t;
    });
    const seen = cleanTs(o.lastSeen);
    if (seen > (u.lastSeen || 0)) u.lastSeen = seen;
    if (o.clientType && typeof o.clientType === 'string') u.clientType = o.clientType.slice(0, 20);
    if (o.nodeId && typeof o.nodeId === 'string' && !u.nodeIds.includes(o.nodeId)) {
      u.nodeIds.push(o.nodeId.slice(0, 80));
      if (u.nodeIds.length > 6) u.nodeIds.shift();
    }
    if (Number.isFinite(o.contacts)) u.contacts = o.contacts;
    if (o.live) live.set(suffix, now);
    if (isNew) {
      if (sync) sync.newUsers++;
      else if (firstSyncDone && o.live) {
        toast(`🆕 Novo usuário: ${u.tag} — conta criada em ${fmtDate(u.createdAt || now)}`, 'new');
      }
    }
    scheduleRender();
    save();
    return u;
  }

  function mergeRegistryEntries(entries) {
    if (!Array.isArray(entries)) return;
    entries.slice(0, 400).forEach((e) => {
      if (!Array.isArray(e)) return;
      const seen = cleanTs(e[3]);
      upsertUser(String(e[1] || ''), String(e[0] || ''), { since: e[2], lastSeen: seen, nameAt: seen });
    });
  }

  function isOnline(u) { return Date.now() - (live.get(u.suffix) || 0) < ONLINE_MS; }
  function isDeleted(u) { return deletedBySuffix.has(u.suffix); }

  // ------------------------------------------------------------------ registros do administrador
  function rebuildRecords() {
    const latest = new Map();
    records.forEach((r) => {
      const b = r.body;
      if (b.kind !== 'delete_user' && b.kind !== 'restore_user') return;
      const sfx = /^[0-9a-f]{6}$/.test(b.suffix || '') ? b.suffix : ((splitTag(b.tag) || {}).suffix || '');
      if (!sfx) return;
      const cur = latest.get(sfx);
      if (!cur || b.ts > cur.ts) latest.set(sfx, b);
    });
    deletedBySuffix = new Map();
    latest.forEach((b, sfx) => { if (b.kind === 'delete_user') deletedBySuffix.set(sfx, b); });
  }

  // O que os aparelhos guardam (e o painel repassa): últimas mensagens + registro vigente por conta
  function liveRecordSet() {
    const now = Date.now();
    const bc = records.filter((r) => r.body.kind === 'broadcast' && now - r.body.ts < BROADCAST_MAX_AGE)
      .sort((a, b) => b.body.ts - a.body.ts).slice(0, BROADCAST_KEEP);
    const bySfx = new Map();
    records.forEach((r) => {
      if (r.body.kind !== 'delete_user' && r.body.kind !== 'restore_user') return;
      const cur = bySfx.get(r.body.suffix);
      if (!cur || r.body.ts > cur.body.ts) bySfx.set(r.body.suffix, r);
    });
    return bc.concat(Array.from(bySfx.values()));
  }

  async function makeRecord(kind, extra) {
    if (!info.hasKey) throw new Error('Sem a chave do administrador neste computador.');
    const body = { v: 1, kind, id: 'adm_' + Date.now().toString(36) + '_' + randHex(10), ts: Date.now(), ...extra };
    const b = JSON.stringify(body);
    const s = await API.sign(b);
    return { b, s, body };
  }

  function addRecord(rec) {
    if (records.some((r) => r.body.id === rec.body.id)) return false;
    records.push(rec);
    rebuildRecords();
    save();
    scheduleRender();
    return true;
  }

  function publishRecords(list, reqId) {
    for (let i = 0; i < list.length; i += 25) {
      const pkt = { meshType: 'ADMIN_RECORDS', records: list.slice(i, i + 25).map((r) => ({ b: r.b, s: r.s })) };
      if (reqId) pkt.reqId = reqId;
      publish(pkt);
    }
  }

  // Chaves aceitas para registros vindos da rede (recupera o histórico após reinstalar)
  let verifyKeysPromise = null;
  function verifyKeys() {
    if (!verifyKeysPromise) {
      const list = APP_ADMIN_PUBLIC_KEYS.slice();
      if (info.publicKey) list.push(info.publicKey);
      verifyKeysPromise = Promise.all(list.map((k) => crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null))).then((l) => l.filter(Boolean));
    }
    return verifyKeysPromise;
  }
  function b64urlToBytes(s) {
    try {
      const str = String(s).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(str + '==='.slice((str.length + 3) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch (e) { return null; }
  }
  async function acceptNetworkRecords(list) {
    if (!Array.isArray(list)) return;
    const known = new Set(records.map((r) => r.body.id));
    for (const rec of list.slice(0, 80)) {
      if (!rec || typeof rec.b !== 'string' || typeof rec.s !== 'string' || rec.b.length > 8000) continue;
      let body;
      try { body = JSON.parse(rec.b); } catch (e) { continue; }
      if (!body || body.v !== 1 || known.has(body.id) || !['broadcast', 'delete_user', 'restore_user'].includes(body.kind)) continue;
      const sig = b64urlToBytes(rec.s);
      if (!sig || sig.length !== 64) continue;
      let ok = false;
      for (const k of await verifyKeys()) {
        try { if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, new TextEncoder().encode(rec.b))) { ok = true; break; } } catch (e) {}
      }
      if (!ok) continue;
      known.add(body.id);
      addRecord({ b: rec.b, s: rec.s, body });
    }
  }

  // ------------------------------------------------------------------ MQTT (mesmo cliente do app)
  const sockets = new Map();
  const reconnectTimers = {};

  function encodeRemainingLength(len) {
    const out = [];
    do {
      let d = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) d |= 0x80;
      out.push(d);
    } while (len > 0);
    return out;
  }
  function encodeUTF8String(str) {
    const u = new TextEncoder().encode(str);
    return [(u.length >> 8) & 0xff, u.length & 0xff, ...u];
  }
  function buildPublish(obj) {
    const topic = encodeUTF8String(TOPIC);
    const payload = new TextEncoder().encode(JSON.stringify(obj));
    const total = topic.length + payload.length;
    const len = encodeRemainingLength(total);
    const pkt = new Uint8Array(1 + len.length + total);
    pkt[0] = 0x30;
    pkt.set(len, 1);
    pkt.set(topic, 1 + len.length);
    pkt.set(payload, 1 + len.length + topic.length);
    return pkt;
  }
  function openCount() {
    let n = 0;
    sockets.forEach((ws) => { if (ws.readyState === WebSocket.OPEN && ws._psSubscribed) n++; });
    return n;
  }

  function publish(obj) {
    const pktId = 'pkt_' + randHex(12) + Date.now();
    const pkt = { ...obj, pktId, packetId: pktId, senderNodeId: db.nodeId, senderTag: PANEL_TAG, timestamp: Date.now() };
    seenPkts.add(pktId);
    const raw = buildPublish(pkt);
    let sent = 0;
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(raw); sent++; } catch (e) {} }
    });
    return sent;
  }

  function connect(url) {
    const old = sockets.get(url);
    if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(url, ['mqtt']); } catch (e) { scheduleReconnect(url); return; }
    ws.binaryType = 'arraybuffer';
    ws._rx = new Uint8Array(0);
    sockets.set(url, ws);
    let ping = null;
    ws.onopen = () => {
      const clientId = encodeUTF8String('ps_panel_' + randHex(6));
      const vh = [...encodeUTF8String('MQTT'), 4, 0x02, 0, 60];
      const total = vh.length + clientId.length;
      const len = encodeRemainingLength(total);
      const conn = new Uint8Array(1 + len.length + total);
      conn[0] = 0x10; conn.set(len, 1); conn.set(vh, 1 + len.length); conn.set(clientId, 1 + len.length + vh.length);
      ws.send(conn);
      const topic = encodeUTF8String(TOPIC);
      const subLen = 2 + topic.length + 1;
      const sl = encodeRemainingLength(subLen);
      const sub = new Uint8Array(1 + sl.length + subLen);
      sub[0] = 0x82; sub.set(sl, 1); sub.set([0, 1], 1 + sl.length); sub.set(topic, 3 + sl.length); sub[sub.length - 1] = 0;
      ws.send(sub);
      ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(new Uint8Array([0xc0, 0])); } catch (e) {} } }, 30000);
    };
    ws.onmessage = (ev) => onBytes(ws, new Uint8Array(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      ws._psSubscribed = false;
      renderConn();
      scheduleReconnect(url);
    };
  }
  function scheduleReconnect(url) {
    if (reconnectTimers[url]) return;
    reconnectTimers[url] = setTimeout(() => { delete reconnectTimers[url]; connect(url); }, 5000);
  }

  function onBytes(ws, bytes) {
    let buf = ws._rx.length ? concat(ws._rx, bytes) : bytes;
    while (buf.length >= 2) {
      let idx = 1, mult = 1, len = 0, done = false;
      do {
        if (idx >= buf.length) break;
        const d = buf[idx++];
        len += (d & 127) * mult;
        mult *= 128;
        if ((d & 128) === 0) done = true;
      } while (!done && idx < 5);
      if (!done) break;
      const end = idx + len;
      if (end > buf.length) break;
      const type = buf[0] >> 4;
      if (type === 9) { // SUBACK: já recebemos o tópico
        if (!ws._psSubscribed) { ws._psSubscribed = true; renderConn(); onBrokerReady(); }
      } else if (type === 3) {
        const qos = (buf[0] >> 1) & 3;
        let p = idx;
        const tl = (buf[p] << 8) | buf[p + 1];
        p += 2 + tl;
        if (qos > 0) p += 2;
        try { onPacket(JSON.parse(new TextDecoder().decode(buf.subarray(p, end)))); } catch (e) {}
      }
      buf = buf.subarray(end);
    }
    ws._rx = buf.length ? buf.slice() : new Uint8Array(0);
  }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

  let readyTimer = null;
  function onBrokerReady() {
    // Ao abrir o painel: sincroniza assim que o primeiro broker estiver pronto
    if (firstSyncDone || sync || readyTimer) return;
    readyTimer = setTimeout(() => { readyTimer = null; if (!firstSyncDone && !sync) syncNow(); }, 800);
  }

  // ------------------------------------------------------------------ pacotes da rede
  function onPacket(p) {
    if (!p || typeof p.meshType !== 'string') return;
    const id = p.pktId || p.packetId;
    if (id) {
      if (seenPkts.has(id)) return;
      seenPkts.add(id);
      if (seenPkts.size > 5000) seenPkts.clear();
    }
    if (p.senderNodeId === db.nodeId) return;
    const now = Date.now();
    switch (p.meshType) {
      case 'PRESENCE_ANNOUNCE': {
        const t = splitTag(p.tag);
        if (t) upsertUser(t.suffix, t.name, { since: p.nameSince, createdAt: p.createdAt, lastSeen: now, nameAt: now, clientType: p.clientType, nodeId: p.nodeId || p.senderNodeId, live: true });
        break;
      }
      case 'USER_REGISTERED': {
        const t = splitTag(p.tag);
        if (t) upsertUser(t.suffix, t.name, { since: p.since || p.registeredAt, lastSeen: now, nameAt: now, nodeId: p.nodeId || p.senderNodeId, live: true });
        break;
      }
      case 'PROBE_USER_EXISTS_REPLY': {
        const t = splitTag(p.ownerTag || p.tag);
        if (t) upsertUser(t.suffix, t.name, { since: p.since });
        break;
      }
      case 'NAME_REGISTRY_SYNC':
        mergeRegistryEntries(p.entries);
        break;
      case 'ADMIN_REGISTRY_DUMP':
        if (sync && p.reqId === sync.reqId && p.part === 0) sync.dumps++;
        mergeRegistryEntries(p.entries);
        break;
      case 'ADMIN_SYNC_REPLY': {
        const t = splitTag(p.tag);
        if (!t) break;
        upsertUser(t.suffix, t.name, { since: p.since, createdAt: p.createdAt, lastSeen: now, nameAt: now, clientType: p.clientType, nodeId: p.nodeId || p.senderNodeId, contacts: p.contacts, live: true });
        if (sync && p.reqId === sync.reqId) { sync.replies.add(p.nodeId || p.senderNodeId); renderSyncStatus(); }
        break;
      }
      case 'ADMIN_STATE_REQUEST': {
        // Um aparelho conectou e quer os registros que não tem: o painel responde primeiro
        const have = new Set(Array.isArray(p.have) ? p.have.map(String) : []);
        const missing = liveRecordSet().filter((r) => !have.has(r.body.id));
        if (missing.length && p.reqId) setTimeout(() => publishRecords(missing, String(p.reqId)), 100 + Math.random() * 200);
        break;
      }
      case 'ADMIN_RECORDS':
        acceptNetworkRecords(p.records);
        break;
    }
  }

  // ------------------------------------------------------------------ sincronização
  async function syncNow(manual) {
    if (sync) return;
    if (!openCount()) {
      if (manual) toast('Sem conexão com os brokers. Tentando reconectar…', 'error');
      BROKERS.forEach(connect);
      return;
    }
    const reqId = 'psync_' + Date.now().toString(36) + '_' + randHex(6);
    sync = { reqId, startedAt: Date.now(), replies: new Set(), dumps: 0, newUsers: 0, usersBefore: Object.keys(db.users).length };
    $('btn-sync').disabled = true;
    renderSyncStatus();
    // 1) relatório de cada aparelho online (pedido assinado: só o administrador provoca a resposta em massa)
    if (info.hasKey) {
      try {
        const rec = await makeRecord('sync_request', { reqId });
        publishRecords([rec]);
      } catch (e) { toast('Falha ao assinar o pedido de sincronização: ' + e.message, 'error'); }
    }
    // 2) catálogo de nomes (funciona até com apps de versões antigas)
    publish({ meshType: 'NAME_REGISTRY_REQUEST', reqId: 'nsync_' + Date.now() + '_' + randHex(4), requesterNodeId: db.nodeId, have: Object.keys(db.users).length });
    // 3) registros do administrador que o painel não tenha (ex.: reinstalado)
    publish({ meshType: 'ADMIN_STATE_REQUEST', reqId: 'astate_' + Date.now() + '_' + randHex(4), have: records.map((r) => r.body.id).slice(0, 400) });
    // 4) reforça os registros vigentes para quem está online e perdeu algum
    publishRecords(liveRecordSet());
    setTimeout(finishSync, SYNC_WINDOW_MS);
  }

  function finishSync() {
    if (!sync) return;
    const s = sync;
    sync = null;
    firstSyncDone = true;
    db.lastSyncAt = Date.now();
    save();
    $('btn-sync').disabled = false;
    const parts = [`${s.replies.size} aparelho${s.replies.size === 1 ? '' : 's'} ${s.replies.size === 1 ? 'respondeu' : 'responderam'}`];
    if (!s.usersBefore) parts.push(`${Object.keys(db.users).length} contas encontradas`);
    else if (s.newUsers) parts.push(`${s.newUsers} conta${s.newUsers === 1 ? '' : 's'} nova${s.newUsers === 1 ? '' : 's'} na lista`);
    toast('✔ Sincronizado: ' + parts.join(', ') + '.', 'ok');
    renderAll();
  }

  // ------------------------------------------------------------------ ações
  function canAct() {
    if (!info.hasKey) { toast('Sem a chave do administrador neste computador.', 'error'); return false; }
    if (!openCount()) { toast('Sem conexão com a rede: aguarde reconectar para enviar.', 'error'); return false; }
    return true;
  }

  async function sendBroadcast() {
    const text = $('bc-text').value.trim();
    if (!text) { toast('Escreva a mensagem.', 'error'); return; }
    if (!canAct()) return;
    const n = Object.values(db.users).filter((u) => !isDeleted(u)).length;
    const ok = await confirmModal('Enviar para todos?',
      `<p>A mensagem vai aparecer como <b>PulseShare</b> na lista de conversas de todos os usuários${n ? ` (${n} conhecidos)` : ''}.</p>
       <p class="muted small">Quem está online recebe na hora; quem está offline recebe ao abrir o app.</p>
       <div class="preview"><p class="chat-row-text">${esc(text)}</p></div>`, 'Enviar');
    if (!ok) return;
    try {
      const rec = await makeRecord('broadcast', { text });
      addRecord(rec);
      publishRecords([rec]);
      $('bc-text').value = '';
      updateBroadcastPreview();
      toast('📣 Mensagem enviada para a rede.', 'ok');
    } catch (e) {
      toast('Não foi possível enviar: ' + e.message, 'error');
    }
  }

  async function deleteUser(sfx) {
    const u = db.users[sfx];
    if (!u || !canAct()) return;
    const ok = await confirmModal(`Excluir ${u.tag}?`,
      `<p>A exclusão é enviada a <b>todos os nós da rede</b>:</p>
       <ul class="small">
         <li>a conversa e o contato somem de todos os aparelhos;</li>
         <li>o nome <b>${esc(u.name)}</b> volta a ficar livre;</li>
         <li>a conta é removida do(s) aparelho(s) do usuário e não consegue mais entrar com as mesmas chaves.</li>
       </ul>
       <p class="muted small">Aparelhos offline recebem a exclusão quando conectarem. Dá para desfazer em "Restaurar".</p>`, 'Excluir conta', true);
    if (!ok) return;
    try {
      const rec = await makeRecord('delete_user', { tag: u.tag, suffix: u.suffix, name: u.name });
      addRecord(rec);
      publishRecords([rec]);
      live.delete(sfx);
      toast(`🗑 ${u.tag} excluído. A ordem foi propagada para a rede.`, 'ok');
    } catch (e) {
      toast('Não foi possível excluir: ' + e.message, 'error');
    }
  }

  async function restoreUser(sfx) {
    const u = db.users[sfx];
    if (!u || !canAct()) return;
    const ok = await confirmModal(`Restaurar ${u.tag}?`,
      '<p>A conta volta a poder entrar e conversar. Conversas apagadas nos aparelhos não voltam.</p>', 'Restaurar');
    if (!ok) return;
    try {
      const rec = await makeRecord('restore_user', { tag: u.tag, suffix: u.suffix, name: u.name });
      addRecord(rec);
      publishRecords([rec]);
      toast(`↩ ${u.tag} restaurado.`, 'ok');
    } catch (e) {
      toast('Não foi possível restaurar: ' + e.message, 'error');
    }
  }

  function exportCsv() {
    const rows = filteredUsers();
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const iso = (t) => (t ? new Date(t).toISOString() : '');
    const lines = [['nome', 'tag', 'status', 'ultimo_acesso', 'conta_criada', 'plataforma', 'ids_de_aparelho_vistos'].join(',')];
    rows.forEach((u) => lines.push([q(u.name), q(u.tag), q(isDeleted(u) ? 'excluido' : isOnline(u) ? 'online' : 'offline'),
      q(iso(u.lastSeen)), q(iso(u.createdAt)), q(clientLabel(u.clientType)), u.nodeIds.length].join(',')));
    API.saveCsv(lines.join('\r\n') + '\r\n').then((r) => { if (r && r.path) toast('CSV salvo em ' + r.path, 'ok'); })
      .catch((e) => toast('Falha ao salvar: ' + e.message, 'error'));
  }

  // ------------------------------------------------------------------ renderização
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderAll(); }, 250);
  }

  function filteredUsers() {
    const q = $('f-search').value.trim().toLowerCase().replace(/^@/, '');
    const st = $('f-status').value;
    const seenF = $('f-seen').value;
    const sort = $('f-sort').value;
    const now = Date.now();
    const list = Object.values(db.users).filter((u) => {
      const del = isDeleted(u);
      if (st === 'deleted' && !del) return false;
      if (st !== 'deleted' && st !== 'all' && del) return false;
      if (st === 'online' && !isOnline(u)) return false;
      if (st === 'offline' && isOnline(u)) return false;
      if (q && !u.name.includes(q) && !u.tag.includes(q)) return false;
      const age = u.lastSeen ? now - u.lastSeen : Infinity;
      if (seenF === '1h' && age > 3600 * 1000) return false;
      if (seenF === '24h' && age > DAY) return false;
      if (seenF === '7d' && age > 7 * DAY) return false;
      if (seenF === '30d' && age > 30 * DAY) return false;
      if (seenF === 'gt30' && age <= 30 * DAY) return false;
      return true;
    });
    const seenKey = (u) => (isOnline(u) ? now : u.lastSeen || 0);
    const cmp = {
      'seen-desc': (a, b) => seenKey(b) - seenKey(a),
      'seen-asc': (a, b) => seenKey(a) - seenKey(b),
      'created-desc': (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      'created-asc': (a, b) => (a.createdAt || Infinity) - (b.createdAt || Infinity),
      'name-asc': (a, b) => a.name.localeCompare(b.name)
    }[sort] || ((a, b) => seenKey(b) - seenKey(a));
    return list.sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
  }

  function renderMetrics() {
    const now = Date.now();
    const all = Object.values(db.users);
    const active = all.filter((u) => !isDeleted(u));
    $('m-total').textContent = active.length;
    $('m-online').textContent = active.filter(isOnline).length;
    $('m-24h').textContent = active.filter((u) => isOnline(u) || now - (u.lastSeen || 0) < DAY).length;
    $('m-7d').textContent = active.filter((u) => isOnline(u) || now - (u.lastSeen || 0) < 7 * DAY).length;
    $('m-new').textContent = active.filter((u) => u.createdAt && now - u.createdAt < 7 * DAY).length;
    $('m-deleted').textContent = all.length - active.length;
  }

  const MAX_ROWS = 1000;
  function renderUsers() {
    const rows = filteredUsers();
    const now = Date.now();
    const body = $('users-body');
    body.innerHTML = rows.slice(0, MAX_ROWS).map((u) => {
      const del = isDeleted(u);
      const on = !del && isOnline(u);
      const status = del ? '<span class="status status-deleted"><i></i>Excluído</span>'
        : on ? '<span class="status status-online"><i></i>Online</span>'
        : '<span class="status status-offline"><i></i>Offline</span>';
      const isNewAcct = u.createdAt && now - u.createdAt < 7 * DAY;
      const fresh = !del && now - (u.firstSeen || 0) < 10 * 60 * 1000 && firstSyncDone && isNewAcct;
      const seenTxt = on ? 'agora (online)' : fmtRel(u.lastSeen);
      const delInfo = del ? `<small>excluído em ${esc(fmtDate(deletedBySuffix.get(u.suffix).ts))}</small>` : '';
      const action = del
        ? `<button class="btn btn-small btn-ok" type="button" data-act="restore" data-sfx="${esc(u.suffix)}">↩ Restaurar</button>`
        : `<button class="btn btn-small btn-danger" type="button" data-act="delete" data-sfx="${esc(u.suffix)}">🗑 Excluir</button>`;
      return `<tr class="${del ? 'is-deleted' : ''}${fresh ? ' is-fresh' : ''}">
        <td><div class="user"><span class="avatar ${avatarClass(u.suffix)}">${esc(u.name.slice(0, 1))}</span>
          <div><b>${esc(u.name)}</b><code>${esc(u.tag)}</code></div></div></td>
        <td>${status}${delInfo}</td>
        <td title="${esc(fmtDate(u.lastSeen))}">${esc(seenTxt)}<small>${on ? '' : esc(fmtDate(u.lastSeen))}</small></td>
        <td>${esc(u.createdAt ? fmtDate(u.createdAt) : 'desconhecida')}${isNewAcct ? ' <span class="badge badge-new">NOVO</span>' : ''}<small>${u.createdAt ? esc(fmtRel(u.createdAt)) : ''}</small></td>
        <td>${esc(clientLabel(u.clientType))}</td>
        <td class="right">${action}</td>
      </tr>`;
    }).join('');
    const total = Object.keys(db.users).length;
    const empty = $('users-empty');
    if (!rows.length) {
      empty.classList.remove('hidden');
      empty.textContent = total ? 'Nenhum usuário com estes filtros.' : (sync ? 'Sincronizando com a rede…' : 'Nenhum usuário conhecido ainda. Clique em "Sincronizar agora".');
    } else {
      empty.classList.add('hidden');
    }
    $('users-footer').textContent = `Mostrando ${Math.min(rows.length, MAX_ROWS)} de ${rows.length} filtrados (${total} contas conhecidas no total).` +
      (rows.length > MAX_ROWS ? ' Use a busca ou os filtros para ver os demais (o CSV leva todos).' : '');
    // Seta de ordenação no cabeçalho
    const sort = $('f-sort').value;
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      const k = th.getAttribute('data-sort');
      const a = th.querySelector('.arrow');
      if (a) a.remove();
      if (sort.startsWith(k)) {
        const s = document.createElement('span');
        s.className = 'arrow';
        s.textContent = sort.endsWith('desc') ? '↓' : '↑';
        th.appendChild(s);
      }
    });
  }

  function renderConn() {
    const n = openCount();
    const pill = $('conn-pill');
    pill.className = 'pill ' + (n ? 'pill-ok' : 'pill-off');
    pill.querySelector('b').textContent = n ? `Conectado (${n}/${BROKERS.length} brokers)` : 'Sem conexão — reconectando…';
  }

  function renderSyncStatus() {
    const el = $('sync-status');
    if (sync) {
      el.textContent = `Sincronizando… ${sync.replies.size} aparelho${sync.replies.size === 1 ? '' : 's'} ${sync.replies.size === 1 ? 'respondeu' : 'responderam'}`;
    } else {
      el.textContent = db.lastSyncAt ? `Última sincronização: ${fmtDate(db.lastSyncAt)} (${fmtRel(db.lastSyncAt)})` : 'Ainda não sincronizado';
    }
  }

  function recordLabel(b) {
    if (b.kind === 'broadcast') return '📣 Mensagem para todos';
    if (b.kind === 'delete_user') return `🗑 Exclusão de ${b.tag}`;
    if (b.kind === 'restore_user') return `↩ Restauração de ${b.tag}`;
    return b.kind;
  }

  function renderHistory() {
    const sorted = records.slice().sort((a, b) => b.body.ts - a.body.ts);
    const bcs = sorted.filter((r) => r.body.kind === 'broadcast');
    $('bc-history').innerHTML = bcs.length
      ? bcs.map((r) => `<li><div class="meta"><span>${esc(fmtDate(r.body.ts))}</span><span>${esc(fmtRel(r.body.ts))}</span></div><p>${esc(r.body.text)}</p></li>`).join('')
      : '<li class="muted">Nenhuma mensagem enviada ainda.</li>';
    $('history-list').innerHTML = sorted.length
      ? sorted.map((r) => `<li><div class="row-between"><b>${esc(recordLabel(r.body))}</b><span class="muted small">${esc(fmtDate(r.body.ts))}</span></div>
          ${r.body.kind === 'broadcast' ? `<p>${esc(r.body.text)}</p>` : ''}<div class="meta"><code>${esc(r.body.id)}</code></div></li>`).join('')
      : '<li class="muted">Nenhuma ação registrada.</li>';
  }

  function renderKey() {
    $('readonly-banner').classList.toggle('hidden', info.hasKey);
    $('btn-bc-send').disabled = !info.hasKey;
    $('btn-key-export').classList.toggle('hidden', !info.hasKey);
    $('btn-key-generate').classList.toggle('hidden', info.hasKey);
    $('key-file').textContent = info.keyFile || '';
    const st = $('key-status');
    if (!info.hasKey) {
      st.innerHTML = `<p class="key-bad">✖ Nenhuma chave neste computador.</p>
        <p class="muted small">Importe a chave do administrador (arquivo .pem guardado). "Gerar chave nova" só serve se a chave antiga foi perdida: os apps só aceitam a chave nova depois de atualizados com a chave pública dela (ADMIN_PUBLIC_KEYS no app.js).</p>`;
    } else {
      const matches = APP_ADMIN_PUBLIC_KEYS.some((k) => k.x === info.publicKey.x && k.y === info.publicKey.y);
      st.innerHTML = `<p class="key-ok">✔ Chave do administrador carregada.</p>
        <dl class="kv"><dt>Impressão digital</dt><dd><code>${esc(info.fingerprint)}</code></dd>
        <dt>Chave pública</dt><dd><code>${esc(JSON.stringify(info.publicKey))}</code></dd></dl>
        <p class="${matches ? 'key-ok' : 'key-warn'} small">${matches
          ? '✔ É a chave que os apps PulseShare desta versão reconhecem.'
          : '⚠ Os apps desta versão não conhecem esta chave: acrescente a chave pública acima em ADMIN_PUBLIC_KEYS (app.js) e publique os apps de novo.'}</p>`;
    }
    $('net-topic').textContent = TOPIC;
    $('net-brokers').textContent = BROKERS.join(', ');
    $('net-node').textContent = db.nodeId;
    $('net-db').textContent = `${Object.keys(db.users).length} contas, ${records.length} registros`;
  }

  function renderAll() {
    renderConn();
    renderSyncStatus();
    renderMetrics();
    renderUsers();
    renderHistory();
    renderKey();
  }

  function updateBroadcastPreview() {
    const t = $('bc-text').value;
    $('bc-count').textContent = `${t.length} / 2000`;
    $('bc-preview').textContent = t.trim() || 'Sua mensagem aparece aqui.';
  }

  // ------------------------------------------------------------------ eventos
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === name));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
    try { localStorage.setItem('psp_tab', name); } catch (e) {}
  }

  function initEvents() {
    document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchTab(b.getAttribute('data-tab')); });
    document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => switchTab(b.getAttribute('data-goto')); });
    $('btn-sync').onclick = () => syncNow(true);
    ['f-search', 'f-status', 'f-seen', 'f-sort'].forEach((id) => {
      $(id).addEventListener(id === 'f-search' ? 'input' : 'change', renderUsers);
    });
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const k = th.getAttribute('data-sort');
        const cur = $('f-sort').value;
        $('f-sort').value = k === 'name' ? 'name-asc' : cur === `${k}-desc` ? `${k}-asc` : `${k}-desc`;
        renderUsers();
      };
    });
    $('users-body').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const sfx = b.getAttribute('data-sfx');
      if (b.getAttribute('data-act') === 'delete') deleteUser(sfx);
      else restoreUser(sfx);
    });
    $('btn-csv').onclick = exportCsv;
    $('bc-text').addEventListener('input', updateBroadcastPreview);
    $('btn-bc-send').onclick = sendBroadcast;
    $('btn-key-export').onclick = () => API.exportKey().then((r) => { if (r && r.path) toast('Cópia da chave salva em ' + r.path, 'ok'); })
      .catch((e) => toast(e.message, 'error'));
    $('btn-key-import').onclick = () => API.importKey().then((r) => {
      if (r && r.canceled) return;
      applyInfo(r);
      toast('Chave importada.', 'ok');
    }).catch((e) => toast('Chave inválida: ' + e.message, 'error'));
    $('btn-key-generate').onclick = async () => {
      const ok = await confirmModal('Gerar chave nova?',
        '<p>Os apps PulseShare <b>não</b> aceitam esta chave até serem atualizados com a chave pública dela. Use só se a chave antiga foi perdida.</p>', 'Gerar', true);
      if (!ok) return;
      API.generateKey().then((r) => { applyInfo(r); toast('Chave gerada. Guarde uma cópia!', 'ok'); }).catch((e) => toast(e.message, 'error'));
    };
    $('btn-db-clear').onclick = async () => {
      const ok = await confirmModal('Apagar dados locais?', '<p>A lista de usuários e o histórico deste computador serão apagados. A rede não muda; a próxima sincronização refaz a lista.</p>', 'Apagar', true);
      if (!ok) return;
      db = { users: {}, records: [], lastSyncAt: 0, nodeId: db.nodeId };
      records = [];
      rebuildRecords();
      live.clear();
      save();
      renderAll();
      syncNow(true);
    };
  }

  function applyInfo(i) {
    if (!i) return;
    info = i;
    TOPIC = i.topic || TOPIC;
    BROKERS = Array.isArray(i.brokers) && i.brokers.length ? i.brokers : DEFAULT_BROKERS;
    verifyKeysPromise = null;
    renderAll();
  }

  async function start() {
    try { applyInfo(await API.info()); } catch (e) { toast('Falha ao ler a configuração: ' + e.message, 'error'); }
    rebuildRecords();
    initEvents();
    try { const t = localStorage.getItem('psp_tab'); if (t && $('tab-' + t)) switchTab(t); } catch (e) {}
    updateBroadcastPreview();
    renderAll();
    BROKERS.forEach(connect);
    // Atualiza "online" e os tempos relativos
    setInterval(() => { renderMetrics(); renderUsers(); renderSyncStatus(); }, 5000);
  }

  // Depuração (DevTools: Ctrl+Shift+I)
  window.__pspDebug = () => ({ db, records, live: Object.fromEntries(live), sync, info, open: openCount() });

  start();
})();
