#!/usr/bin/env node
/*
 * PulseShare Relay — nó de rede para servidores (modo texto, sem dependências).
 *
 *   pulseshare-relay run       → serviço (systemd chama este)
 *   pulseshare-relay config    → configurador interativo (conta, nome do perfil, limites, TURN)
 *   pulseshare-relay status    → situação do serviço
 *   pulseshare-relay account   → mostra o @usuário, o hash e (com confirmação) as 7 palavras
 *
 * O que o relay faz na rede PulseShare (mesmo protocolo do app, ver CLAUDE.md §3):
 *   • fica online 24 h como uma conta normal (clientType 'server', "🖥️ Servidor relay");
 *   • CAIXA POSTAL: mensagem de chat que não recebeu CHAT_ACK em 25 s (destino
 *     offline) é guardada e reenviada quando a presença do destino aparecer — o
 *     destino mostra "🖥️ via <relay>". ACK/lida para quem está offline também;
 *   • guarda e responde o catálogo de nomes e os registros assinados do administrador;
 *   • TURN opcional (coturn): anuncia credenciais temporárias na presença e os apps
 *     usam o servidor como relay de arquivos quando a conexão direta não abre;
 *   • limites de banda (download/upload), tráfego mensal e conexões.
 *
 * Node.js ≥ 18. Variáveis para testes: PULSESHARE_RELAY_CONFIG, PULSESHARE_RELAY_DATA,
 * PULSESHARE_TOPIC, PULSESHARE_BROKERS (a,b,c).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const tls = require('tls');
const nodeCrypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = nodeCrypto.webcrypto;

const VERSION = '1.0.0';
const CONFIG_PATH = process.env.PULSESHARE_RELAY_CONFIG || '/etc/pulseshare-relay/config.json';
const DATA_DIR = process.env.PULSESHARE_RELAY_DATA || '/var/lib/pulseshare-relay';
const DEFAULT_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const DEFAULT_TOPIC = 'pulseshare/v2/p2p_mesh_global';
const OFFICIAL_TAG = '@pulseshare';
const ADMIN_PUBLIC_KEYS = [
  { x: '8GFJKFuR4sGEIX4FBsMRa8J0yXU2XqGU32seSLx2Fr0', y: '7wXYjRMKZdt5DiGjqAjUGUDO17IAJWwI2uUa_TLKfeU' }
];
const NAME_REGISTRY_TTL = 90 * 24 * 3600 * 1000;
const NAME_REGISTRY_MAX = 20000;
const NAME_SYNC_MAX_ENTRIES = 250;
const ACK_WAIT_MS = 25000;
const PRESENCE_FRESH_MS = 60000;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
function log(...a) { console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a); }
function now() { return Date.now(); }
function rnd(a, b) { return a + Math.random() * (b - a); }
function normalizeTag(t) {
  t = String(t || '').trim().toLowerCase();
  if (!t) return '';
  return t.startsWith('@') ? t : '@' + t;
}
function splitTag(tag) {
  const m = /^@([a-z0-9_]{1,40})_([0-9a-f]{6})$/.exec(normalizeTag(tag));
  if (!m || m[1] === 'link') return null;
  return { name: m[1], suffix: m[2] };
}
function hashSuffix(tag) { const m = /_([0-9a-f]{6})$/.exec(normalizeTag(tag)); return m ? m[1] : ''; }
function cleanSince(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, now()) : 0; }
function cleanProfileName(n) {
  return String(n || '').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function nameRuleError(name) {
  if (!/^[a-z0-9_]{2,24}$/.test(name) || /^link_/.test(name) || /^linkchat/.test(name) || name === 'link') {
    return 'Use de 2 a 24 letras minúsculas, números ou "_" (não pode começar com "link_").';
  }
  if (/^pulse_?share/.test(name)) return 'Nomes começando com "pulseshare" são reservados.';
  return '';
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(file, obj, mode) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: mode || 0o640 });
  fs.renameSync(tmp, file);
}
function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}
function b64urlToBytes(s) {
  try { return new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')); } catch (e) { return null; }
}
function monthKey(t) { const d = new Date(t || now()); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

function loadCrypto() {
  const candidates = [path.join(__dirname, 'pulseshare-crypto-identity.js'), path.join(__dirname, '..', 'pulseshare-crypto-identity.js')];
  for (const f of candidates) {
    if (fs.existsSync(f)) { require(f); return global.PulseShareCrypto; }
  }
  throw new Error('pulseshare-crypto-identity.js não encontrado ao lado do relay');
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
function defaultConfig() {
  return {
    version: 1,
    account: null, // { words, name, tag, pubKeyHex, regHash, createdAt, nameSince, profileName }
    limits: {
      downloadKbps: 0,        // 0 = sem limite
      uploadKbps: 0,
      monthlyTrafficGB: 0,    // 0 = sem limite
      trafficSource: 'relay', // 'relay' (só o tráfego deste serviço) ou 'interface' (placa de rede inteira)
      maxConnections: 100     // usuários atendidos ao mesmo tempo (caixa postal e alocações TURN)
    },
    mailbox: { enabled: true, days: 7, maxMB: 200, perUser: 300 },
    turn: { enabled: false, host: '', port: 3478, secret: '' },
    network: { brokers: DEFAULT_BROKERS.slice(), topic: DEFAULT_TOPIC }
  };
}

function loadConfig() {
  const def = defaultConfig();
  const c = readJson(CONFIG_PATH, null);
  if (!c) return def;
  return {
    ...def, ...c,
    limits: { ...def.limits, ...(c.limits || {}) },
    mailbox: { ...def.mailbox, ...(c.mailbox || {}) },
    turn: { ...def.turn, ...(c.turn || {}) },
    network: { ...def.network, ...(c.network || {}) }
  };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeJsonAtomic(CONFIG_PATH, cfg, 0o640);
  // O serviço roda como "pulseshare": o arquivo (que tem as 7 palavras) fica root:pulseshare 0640
  if (process.getuid && process.getuid() === 0) {
    try { execSync(`chgrp pulseshare ${JSON.stringify(CONFIG_PATH)}`, { stdio: 'ignore' }); } catch (e) {}
  }
}

function brokersOf(cfg) {
  if (process.env.PULSESHARE_BROKERS) return process.env.PULSESHARE_BROKERS.split(',').map((s) => s.trim()).filter(Boolean);
  return (cfg.network && cfg.network.brokers && cfg.network.brokers.length) ? cfg.network.brokers : DEFAULT_BROKERS;
}
function topicOf(cfg) {
  return process.env.PULSESHARE_TOPIC || (cfg.network && cfg.network.topic) || DEFAULT_TOPIC;
}

// ---------------------------------------------------------------------------
// Limitador de banda (balde de fichas)
// ---------------------------------------------------------------------------
class TokenBucket {
  constructor(kbps) { this.set(kbps); }
  set(kbps) {
    this.rate = Math.max(0, Number(kbps) || 0) * 1000 / 8; // bytes/s
    this.cap = Math.max(this.rate * 2, 256 * 1024);
    this.tokens = this.cap;
    this.at = now();
  }
  refill() {
    if (!this.rate) return;
    const t = now();
    this.tokens = Math.min(this.cap, this.tokens + (t - this.at) / 1000 * this.rate);
    this.at = t;
  }
  // Consome n bytes; devolve quantos ms esperar até o saldo voltar a ser positivo
  take(n) {
    if (!this.rate) return 0;
    this.refill();
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil(-this.tokens / this.rate * 1000);
  }
  canSend(n) {
    if (!this.rate) return true;
    this.refill();
    return this.tokens >= Math.min(n, this.cap);
  }
}

// ---------------------------------------------------------------------------
// Cliente WebSocket (RFC 6455) mínimo sobre TLS + MQTT 3.1.1 (QoS 0)
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeRemainingLength(len) {
  const out = [];
  do {
    let d = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) d |= 0x80;
    out.push(d);
  } while (len > 0);
  return Buffer.from(out);
}
function mqttString(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}
function mqttPacket(first, body) {
  return Buffer.concat([Buffer.from([first]), encodeRemainingLength(body.length), body]);
}

class BrokerConnection {
  constructor(url, topic, hooks) {
    this.url = url;
    this.topic = topic;
    this.hooks = hooks; // { onPacket(obj), onState(), downBucket, onBytes(rx, tx) }
    this.sock = null;
    this.ready = false;   // SUBACK recebido
    this.backoff = 5000;
    this.stopped = false;
    this.rx = Buffer.alloc(0);   // bytes WebSocket
    this.msg = [];               // fragmentos da mensagem WebSocket atual
    this.mq = Buffer.alloc(0);   // fluxo MQTT
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.stopped) return;
    let u;
    try { u = new URL(this.url); } catch (e) { log('URL de broker inválida:', this.url); return; }
    const secure = u.protocol === 'wss:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const key = nodeCrypto.randomBytes(16).toString('base64');
    this.expectAccept = nodeCrypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    this.handshaken = false;
    this.rx = Buffer.alloc(0);
    this.msg = [];
    this.mq = Buffer.alloc(0);
    const opts = { host: u.hostname, port, servername: u.hostname, ALPNProtocols: ['http/1.1'] };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(90000);
    const onOpen = () => {
      const req = `GET ${u.pathname || '/'}${u.search || ''} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n` +
        `User-Agent: PulseShareRelay/${VERSION}\r\n\r\n`;
      this.rawWrite(Buffer.from(req));
    };
    sock.once(secure ? 'secureConnect' : 'connect', onOpen);
    sock.on('data', (d) => this.onData(d));
    sock.on('timeout', () => sock.destroy(new Error('sem dados há 90 s')));
    sock.on('error', (e) => { this.lastError = e && e.message; });
    sock.on('close', () => this.onClose());
  }

  rawWrite(buf) {
    if (!this.sock || this.sock.destroyed) return false;
    this.hooks.onBytes(0, buf.length);
    this.sock.write(buf);
    return true;
  }

  onData(d) {
    this.hooks.onBytes(d.length, 0);
    // Limite de download: pausa a leitura do socket até o balde encher de novo
    const wait = this.hooks.downBucket.take(d.length);
    if (wait > 0 && this.sock && !this.sock.isPaused()) {
      this.sock.pause();
      setTimeout(() => { if (this.sock && !this.sock.destroyed) this.sock.resume(); }, Math.min(wait, 5000));
    }
    this.rx = Buffer.concat([this.rx, d]);
    if (!this.handshaken) {
      const end = this.rx.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.rx.slice(0, end).toString('latin1');
      this.rx = this.rx.slice(end + 4);
      const ok = /^HTTP\/1\.1 101/.test(head) && head.toLowerCase().includes(this.expectAccept.toLowerCase());
      if (!ok) { this.lastError = 'handshake recusado: ' + head.split('\r\n')[0]; this.sock.destroy(); return; }
      this.handshaken = true;
      this.sendMqtt(this.connectPacket());
      this.sendMqtt(this.subscribePacket());
      this.pingTimer = setInterval(() => this.sendMqtt(Buffer.from([0xc0, 0x00])), 30000);
    }
    this.parseFrames();
  }

  parseFrames() {
    for (;;) {
      if (this.rx.length < 2) return;
      const b0 = this.rx[0];
      const b1 = this.rx[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.rx.length < 4) return; len = this.rx.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.rx.length < 10) return; len = Number(this.rx.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.rx.length < off + 4) return; mask = this.rx.slice(off, off + 4); off += 4; }
      if (len > 8 * 1024 * 1024) { this.sock.destroy(new Error('quadro grande demais')); return; }
      if (this.rx.length < off + len) return;
      let payload = this.rx.slice(off, off + len);
      if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      this.rx = this.rx.slice(off + len);
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.msg.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.msg);
          this.msg = [];
          this.mq = Buffer.concat([this.mq, whole]);
          this.parseMqtt();
        }
      }
    }
  }

  parseMqtt() {
    for (;;) {
      if (this.mq.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let byte;
      do {
        if (i >= this.mq.length) return;
        byte = this.mq[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
        if (i > 5) { this.sock.destroy(new Error('MQTT inválido')); return; }
      } while (byte & 0x80);
      if (this.mq.length < i + len) return;
      const type = this.mq[0] >> 4;
      const flags = this.mq[0] & 0x0f;
      const body = this.mq.slice(i, i + len);
      this.mq = this.mq.slice(i + len);
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { this.lastError = 'CONNACK recusado ' + body[1]; this.sock.destroy(); return; }
      } else if (type === 9) { // SUBACK
        if (!this.ready) {
          this.ready = true;
          this.backoff = 5000;
          log('conectado ao broker', this.url);
          this.hooks.onState(this, true);
        }
      } else if (type === 3) { // PUBLISH
        const tl = body.readUInt16BE(0);
        let p = 2 + tl;
        if (((flags >> 1) & 3) > 0) p += 2;
        const raw = body.slice(p);
        if (raw.length > 512 * 1024) continue;
        let obj = null;
        try { obj = JSON.parse(raw.toString('utf8')); } catch (e) {}
        if (obj) this.hooks.onPacket(obj, this);
      }
    }
  }

  connectPacket() {
    const clientId = 'ps_relay_' + nodeCrypto.randomBytes(4).toString('hex');
    const vh = Buffer.concat([mqttString('MQTT'), Buffer.from([4, 0x02, 0, 60])]);
    return mqttPacket(0x10, Buffer.concat([vh, mqttString(clientId)]));
  }

  subscribePacket() {
    return mqttPacket(0x82, Buffer.concat([Buffer.from([0, 1]), mqttString(this.topic), Buffer.from([0])]));
  }

  publishPacket(obj) {
    return mqttPacket(0x30, Buffer.concat([mqttString(this.topic), Buffer.from(JSON.stringify(obj), 'utf8')]));
  }

  sendFrame(opcode, payload) {
    const mask = nodeCrypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    return this.rawWrite(Buffer.concat([head, mask, body]));
  }

  sendMqtt(buf) {
    if (!this.handshaken) return false;
    return this.sendFrame(0x2, buf);
  }

  onClose() {
    const was = this.ready;
    this.ready = false;
    this.handshaken = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (was) log('broker desconectado', this.url, this.lastError ? '(' + this.lastError + ')' : '');
    this.hooks.onState(this, false);
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 120000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.sock) this.sock.destroy();
  }
}

// ---------------------------------------------------------------------------
// Malha: conecta aos brokers e publica (com limite de upload)
// ---------------------------------------------------------------------------
class Mesh {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.topic = topicOf(cfg);
    this.nodeId = opts.nodeId || 'node_' + nodeCrypto.randomBytes(6).toString('hex');
    this.tag = opts.tag || '';
    this.onPacket = opts.onPacket || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.upBucket = new TokenBucket(cfg.limits.uploadKbps);
    this.downBucket = new TokenBucket(cfg.limits.downloadKbps);
    this.seen = new Set();
    this.queue = [];
    this.queueBytes = 0;
    this.bytes = { rx: 0, tx: 0 };
    this.conns = brokersOf(cfg).map((url) => new BrokerConnection(url, this.topic, {
      onPacket: (obj) => this.receive(obj),
      onState: (conn, up) => { if (up) this.onReady(conn); },
      downBucket: this.downBucket,
      onBytes: (rx, tx) => { this.bytes.rx += rx; this.bytes.tx += tx; }
    }));
    this.drainTimer = setInterval(() => this.drain(), 200);
  }

  start() { this.conns.forEach((c) => c.connect()); }
  stop() { this.conns.forEach((c) => c.stop()); clearInterval(this.drainTimer); }
  online() { return this.conns.filter((c) => c.ready).length; }

  remember(id) {
    if (!id) return;
    this.seen.add(id);
    if (this.seen.size > 8000) this.seen = new Set(Array.from(this.seen).slice(-4000));
  }

  receive(obj) {
    if (!obj || !obj.meshType) return;
    const id = obj.pktId || obj.packetId;
    if (id) { if (this.seen.has(id)) return; this.remember(id); }
    if (obj.senderNodeId === this.nodeId) return;
    this.onPacket(obj);
  }

  build(obj) {
    const pktId = 'pkt_' + nodeCrypto.randomBytes(8).toString('hex') + now();
    return { ...obj, pktId, packetId: pktId, senderNodeId: this.nodeId, senderTag: this.tag, timestamp: now() };
  }

  broadcast(obj) { const p = this.build(obj); this.publishRaw(p); return p; }

  sendSignal(to, transferId, signalType, payload) {
    return this.broadcast({ meshType: 'DIRECT_SIGNAL', to, transferId, signalType, payload: payload || {} });
  }

  // Publica um pacote pronto (meu ou de outro, na caixa postal). Fila quando passa do limite.
  publishRaw(packet, priority) {
    this.remember(packet.pktId || packet.packetId);
    const size = Buffer.byteLength(JSON.stringify(packet)) + 8;
    if (!this.queue.length && this.upBucket.canSend(size * Math.max(1, this.online()))) return this.sendNow(packet);
    if (this.queueBytes > 4 * 1024 * 1024) {
      // Fila cheia: descarta o mais antigo que não seja prioritário
      const i = this.queue.findIndex((q) => !q.priority);
      if (i < 0) return 0;
      this.queueBytes -= this.queue[i].size;
      this.queue.splice(i, 1);
    }
    const item = { packet, size, priority: Boolean(priority) };
    if (priority) this.queue.unshift(item); else this.queue.push(item);
    this.queueBytes += size;
    return 0;
  }

  sendNow(packet) {
    let n = 0;
    this.conns.forEach((c) => {
      if (!c.ready) return;
      const buf = c.publishPacket(packet);
      this.upBucket.take(buf.length + 8);
      if (c.sendMqtt(buf)) n++;
    });
    return n;
  }

  drain() {
    while (this.queue.length) {
      const it = this.queue[0];
      if (!this.upBucket.canSend(it.size * Math.max(1, this.online()))) return;
      this.queue.shift();
      this.queueBytes -= it.size;
      this.sendNow(it.packet);
    }
  }
}

// ---------------------------------------------------------------------------
// Tráfego mensal (deste serviço ou da placa de rede inteira)
// ---------------------------------------------------------------------------
function defaultInterface() {
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const l of lines) { const p = l.trim().split(/\s+/); if (p[1] === '00000000') return p[0]; }
  } catch (e) {}
  return '';
}
function interfaceBytes(iface) {
  try {
    const rx = Number(fs.readFileSync(`/sys/class/net/${iface}/statistics/rx_bytes`, 'utf8'));
    const tx = Number(fs.readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, 'utf8'));
    return { rx, tx };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// O relay
// ---------------------------------------------------------------------------
class Relay {
  constructor(cfg) {
    this.cfg = cfg;
    this.acct = cfg.account;
    this.tag = normalizeTag(this.acct.tag);
    this.startedAt = now();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.files = {
      registry: path.join(DATA_DIR, 'registry.json'),
      admin: path.join(DATA_DIR, 'admin-records.json'),
      mailbox: path.join(DATA_DIR, 'mailbox.json'),
      traffic: path.join(DATA_DIR, 'traffic.json'),
      status: path.join(DATA_DIR, 'status.json'),
      node: path.join(DATA_DIR, 'node.json')
    };
    const node = readJson(this.files.node, null) || { nodeId: 'node_' + nodeCrypto.randomBytes(6).toString('hex') };
    writeJsonAtomic(this.files.node, node, 0o600);
    this.nodeId = node.nodeId;
    this.registry = readJson(this.files.registry, {}) || {};
    this.adminRecords = (readJson(this.files.admin, []) || []).filter((r) => r && r.b && r.s);
    this.adminBodies = new Map(); // id → body
    this.adminDeleted = new Map();
    this.mailbox = readJson(this.files.mailbox, {}) || {}; // dest → [{key, packet, kind, storedAt, size, tries, lastTry}]
    this.traffic = readJson(this.files.traffic, null) || { month: monthKey(), relayRx: 0, relayTx: 0, ifBase: null, ifAcc: 0 };
    this.presence = new Map();  // tag → { at, clientType }
    this.pending = new Map();   // dest|id → { dest, packet, at }
    this.answeredProbes = new Set();
    this.answeredNameSyncs = new Set();
    this.adminCovered = new Map();
    this.adminSyncAnswered = new Set();
    this.dumpCount = new Map();
    this.greeted = new Map();
    this.stats = { stored: 0, delivered: 0, acked: 0, dropped: 0, bridged: 0 };
    this.paused = false;
    this.lastBytes = { rx: 0, tx: 0 };
    this.dirty = {};
    this.mesh = new Mesh(cfg, {
      nodeId: this.nodeId,
      tag: this.tag,
      onPacket: (p) => this.handle(p),
      onReady: () => this.onBrokerReady()
    });
  }

  async start() {
    this.adminKeys = await Promise.all(ADMIN_PUBLIC_KEYS.map((k) => crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null)));
    this.adminKeys = this.adminKeys.filter(Boolean);
    const recs = this.adminRecords;
    this.adminRecords = [];
    await this.acceptAdminRecords(recs, true);
    this.noteName(splitTag(this.tag).name, splitTag(this.tag).suffix, this.acct.nameSince || this.acct.createdAt, now());
    this.checkTraffic();
    if (!this.paused) this.mesh.start();
    log(`PulseShare Relay ${VERSION} — ${this.tag} (${cleanProfileName(this.acct.profileName) || 'sem nome de perfil'}) — tópico ${this.mesh.topic}`);
    log(`limites: download ${this.cfg.limits.downloadKbps || '∞'} kbit/s, upload ${this.cfg.limits.uploadKbps || '∞'} kbit/s, ` +
      `tráfego ${this.cfg.limits.monthlyTrafficGB || '∞'} GB/mês, conexões ${this.cfg.limits.maxConnections}; ` +
      `caixa postal ${this.cfg.mailbox.enabled ? 'ligada' : 'desligada'}; TURN ${this.turnInfo() ? 'ligado' : 'desligado'}`);
    this.timers = [
      setInterval(() => this.announce(), 15000),
      setInterval(() => this.sweep(), 5000),
      setInterval(() => this.saveDirty(), 10000),
      setInterval(() => this.checkTraffic(), 60000),
      setInterval(() => this.writeStatus(), 10000)
    ];
    this.writeStatus();
    const stop = () => { log('encerrando...'); this.saveAll(); this.mesh.stop(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }

  // ---------- conexão ----------
  onBrokerReady() {
    setTimeout(() => this.announce(), 300);
    if (!this.registeredSent) {
      this.registeredSent = true;
      setTimeout(() => this.mesh.broadcast({ meshType: 'USER_REGISTERED', tag: this.tag, since: this.acct.nameSince || this.acct.createdAt, registeredAt: this.acct.createdAt, nodeId: this.nodeId }), 1200);
      setTimeout(() => this.mesh.broadcast({ meshType: 'NAME_REGISTRY_REQUEST', reqId: 'nsync_' + now() + '_' + nodeCrypto.randomBytes(2).toString('hex'), requesterNodeId: this.nodeId, have: Object.keys(this.registry).length }), 4000);
      setTimeout(() => this.mesh.broadcast({ meshType: 'ADMIN_STATE_REQUEST', reqId: 'astate_' + now() + '_' + nodeCrypto.randomBytes(2).toString('hex'), have: this.adminRecords.map((r) => r.id).slice(0, 400) }), 5000);
    }
  }

  turnInfo() {
    const t = this.cfg.turn;
    if (!t || !t.enabled || !t.host || !t.secret || this.paused) return null;
    // Credenciais temporárias (REST API do coturn): usuário = validade:nome, senha = HMAC-SHA1
    const exp = Math.floor(now() / 1000) + 2 * 3600;
    const username = `${exp}:pulseshare`;
    const credential = nodeCrypto.createHmac('sha1', t.secret).update(username).digest('base64');
    const hp = `${t.host}:${t.port || 3478}`;
    return { urls: [`turn:${hp}?transport=udp`, `turn:${hp}?transport=tcp`], username, credential, exp };
  }

  announce() {
    if (this.paused) return;
    const turn = this.turnInfo();
    this.mesh.broadcast({
      meshType: 'PRESENCE_ANNOUNCE',
      tag: this.tag,
      nameSince: this.acct.nameSince || this.acct.createdAt || 0,
      createdAt: this.acct.createdAt || 0,
      reghash: this.acct.regHash || '',
      nodeId: this.nodeId,
      photoHash: '',
      profileName: cleanProfileName(this.acct.profileName),
      clientType: 'server',
      relayMode: true,
      relay: { v: 1, mailbox: Boolean(this.cfg.mailbox.enabled), turn: Boolean(turn) },
      ...(turn ? { turn } : {})
    });
  }

  // ---------- pacotes ----------
  handle(p) {
    if (this.paused) return;
    const sender = normalizeTag(p.senderTag);
    if (sender === this.tag) return;
    if (p.meshType === 'ADMIN_RECORDS') { this.onAdminRecords(p); return; }
    if (p.meshType === 'ADMIN_STATE_REQUEST') { this.onAdminStateRequest(p); return; }
    if (p.meshType === 'ADMIN_REGISTRY_DUMP') {
      if (p.reqId && p.part === 0) this.dumpCount.set(p.reqId, (this.dumpCount.get(p.reqId) || 0) + 1);
      this.mergeRegistry(p.entries);
      return;
    }
    if (sender && (sender === OFFICIAL_TAG || this.isDeleted(sender))) return;
    switch (p.meshType) {
      case 'PRESENCE_ANNOUNCE': {
        const tag = normalizeTag(p.tag);
        if (!tag || this.isDeleted(tag)) break;
        const s = splitTag(tag);
        if (s) this.noteName(s.name, s.suffix, p.nameSince, now());
        this.presence.set(tag, { at: now(), clientType: String(p.clientType || '') });
        if (this.presence.size > 50000) this.presence.delete(this.presence.keys().next().value);
        this.deliver(tag);
        break;
      }
      case 'PROBE_USER_EXISTS': this.answerProbe(p); break;
      case 'PROBE_USER_EXISTS_REPLY': {
        if (p.probeId) this.answeredProbes.add(p.probeId);
        if (this.answeredProbes.size > 2000) this.answeredProbes.clear();
        const s = splitTag(p.ownerTag || p.tag);
        if (s) this.noteName(s.name, s.suffix, p.since, now());
        break;
      }
      case 'USER_REGISTERED': {
        const nt = splitTag(p.tag);
        const ot = splitTag(p.previousTag);
        if (ot && nt && ot.suffix === nt.suffix && ot.name !== nt.name) {
          const cur = this.registry[ot.name];
          if (cur && cur.s === ot.suffix) { delete this.registry[ot.name]; this.dirty.registry = true; }
        }
        if (nt) this.noteName(nt.name, nt.suffix, p.since || p.registeredAt, now());
        break;
      }
      case 'NAME_REGISTRY_REQUEST': {
        const rid = p.reqId;
        if (!rid || this.answeredNameSyncs.has(rid) || !Object.keys(this.registry).length) break;
        // O servidor é o nó mais estável: responde mais cedo que os apps (0,3–1,5 s)
        setTimeout(() => {
          if (this.answeredNameSyncs.has(rid)) return;
          this.answeredNameSyncs.add(rid);
          this.mesh.broadcast({ meshType: 'NAME_REGISTRY_SYNC', reqId: rid, entries: this.exportRegistry(NAME_SYNC_MAX_ENTRIES) });
        }, rnd(300, 1500));
        break;
      }
      case 'NAME_REGISTRY_SYNC':
        if (p.reqId) { this.answeredNameSyncs.add(p.reqId); if (this.answeredNameSyncs.size > 500) this.answeredNameSyncs.clear(); }
        this.mergeRegistry(p.entries);
        break;
      case 'DIRECT_SIGNAL': this.onDirect(p, sender); break;
    }
  }

  // ---------- catálogo de nomes ----------
  alive(e) { return Boolean(e && now() - (e.seen || 0) < NAME_REGISTRY_TTL); }

  noteName(name, suffix, since, seen) {
    if (!/^[a-z0-9_]{1,40}$/.test(name || '') || name === 'link' || !/^[0-9a-f]{6}$/.test(suffix || '')) return;
    if (this.adminDeleted.has(suffix)) return;
    since = cleanSince(since);
    seen = cleanSince(seen) || now();
    const cur = this.registry[name];
    if (!this.alive(cur)) this.registry[name] = { s: suffix, since: since || seen, seen };
    else if (cur.s === suffix) {
      if (since && since < (cur.since || Infinity)) cur.since = since;
      if (seen > (cur.seen || 0) + 60000) cur.seen = seen; else return;
    } else if (since && since < (cur.since || Infinity)) this.registry[name] = { s: suffix, since, seen };
    else return;
    this.dirty.registry = true;
  }

  exportRegistry(max) {
    return Object.keys(this.registry).filter((n) => this.alive(this.registry[n]))
      .sort((a, b) => (this.registry[b].seen || 0) - (this.registry[a].seen || 0)).slice(0, max)
      .map((n) => [n, this.registry[n].s, this.registry[n].since || 0, this.registry[n].seen || 0]);
  }

  mergeRegistry(entries) {
    if (!Array.isArray(entries)) return;
    entries.slice(0, 400).forEach((e) => { if (Array.isArray(e)) this.noteName(String(e[0] || ''), String(e[1] || ''), e[2], e[3]); });
  }

  nameOfSuffix(suffix) {
    let best = null;
    for (const n of Object.keys(this.registry)) {
      const e = this.registry[n];
      if (e.s === suffix && this.alive(e) && (!best || (e.seen || 0) > best.seen)) best = { name: n, since: e.since, seen: e.seen || 0 };
    }
    return best;
  }

  answerProbe(p) {
    if (!p.probeId) return;
    let name = String(p.name || '').trim().replace(/^@/, '').toLowerCase();
    let suffix = /^[0-9a-f]{6}$/.test(p.suffix || '') ? p.suffix : '';
    if (!name && !suffix) { const s = splitTag(p.tag); if (s) { name = s.name; suffix = s.suffix; } }
    if (!name && !suffix) return;
    const reply = (ownerTag, since, authoritative) => {
      this.answeredProbes.add(p.probeId);
      this.mesh.broadcast({ meshType: 'PROBE_USER_EXISTS_REPLY', probeId: p.probeId, requesterNodeId: p.requesterNodeId, tag: ownerTag, ownerTag, exists: true, since: since || 0, authoritative, ownerNodeId: authoritative ? this.nodeId : undefined });
    };
    const me = splitTag(this.tag);
    if ((name && me.name === name) || (suffix && me.suffix === suffix)) { reply(this.tag, this.acct.nameSince || this.acct.createdAt, true); return; }
    let ownerTag = '';
    let since = 0;
    const e = name ? this.registry[name] : null;
    if (e && this.alive(e)) { ownerTag = `@${name}_${e.s}`; since = e.since; }
    else if (suffix) { const k = this.nameOfSuffix(suffix); if (k) { ownerTag = `@${k.name}_${suffix}`; since = k.since; } }
    if (!ownerTag) return;
    setTimeout(() => { if (!this.answeredProbes.has(p.probeId)) reply(ownerTag, since, false); }, rnd(200, 900));
  }

  // ---------- administração (registros assinados) ----------
  isDeleted(tag) {
    const t = normalizeTag(tag);
    if (!t || t === OFFICIAL_TAG) return false;
    const s = hashSuffix(t);
    return Boolean(s && this.adminDeleted.has(s));
  }

  async verify(rec) {
    if (!rec || typeof rec.b !== 'string' || typeof rec.s !== 'string' || rec.b.length > 8000) return null;
    let body;
    try { body = JSON.parse(rec.b); } catch (e) { return null; }
    if (!body || body.v !== 1 || typeof body.id !== 'string' || !/^adm_[a-z0-9_]{6,48}$/.test(body.id) || !Number.isFinite(body.ts) || typeof body.kind !== 'string') return null;
    const sig = b64urlToBytes(rec.s);
    if (!sig || sig.length !== 64) return null;
    const data = new TextEncoder().encode(rec.b);
    for (const k of this.adminKeys) {
      try { if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, sig, data)) return body; } catch (e) {}
    }
    return null;
  }

  async acceptAdminRecords(list, fromDisk) {
    if (!Array.isArray(list)) return;
    const known = new Set(this.adminRecords.map((r) => r.id));
    let added = 0;
    for (const rec of list.slice(0, fromDisk ? 5000 : 80)) {
      const body = await this.verify(rec);
      if (!body || known.has(body.id)) continue;
      known.add(body.id);
      if (body.kind === 'sync_request') { if (!fromDisk) this.answerAdminSync(body); continue; }
      if (!['broadcast', 'delete_user', 'restore_user'].includes(body.kind)) continue;
      this.adminRecords.push({ id: body.id, b: rec.b, s: rec.s, body });
      added++;
    }
    if (!added) return;
    // Mantém as mensagens oficiais recentes e o registro mais recente por conta
    const bcasts = this.adminRecords.filter((r) => r.body.kind === 'broadcast' && now() - r.body.ts < 180 * 24 * 3600 * 1000)
      .sort((a, b) => b.body.ts - a.body.ts).slice(0, 60);
    const bySfx = new Map();
    this.adminRecords.forEach((r) => {
      if (r.body.kind === 'broadcast') return;
      const s = (/^[0-9a-f]{6}$/.test(r.body.suffix || '') ? r.body.suffix : hashSuffix(r.body.tag));
      const cur = bySfx.get(s);
      if (s && (!cur || r.body.ts > cur.body.ts)) bySfx.set(s, r);
    });
    this.adminRecords = bcasts.concat(Array.from(bySfx.values()));
    this.adminDeleted = new Map();
    bySfx.forEach((r, s) => { if (r.body.kind === 'delete_user') this.adminDeleted.set(s, r.body.ts); });
    // Conta excluída: some da caixa postal e do catálogo
    Object.keys(this.mailbox).forEach((d) => { if (this.isDeleted(d)) { delete this.mailbox[d]; this.dirty.mailbox = true; } });
    Object.keys(this.registry).forEach((n) => { if (this.adminDeleted.has(this.registry[n].s)) { delete this.registry[n]; this.dirty.registry = true; } });
    this.dirty.admin = true;
    if (!fromDisk) log(`registros do administrador: +${added} (total ${this.adminRecords.length})`);
  }

  onAdminRecords(p) {
    if (p.reqId && Array.isArray(p.records)) {
      const set = this.adminCovered.get(p.reqId) || new Set();
      p.records.forEach((r) => { try { set.add(JSON.parse(r.b).id); } catch (e) {} });
      this.adminCovered.set(p.reqId, set);
      if (this.adminCovered.size > 200) this.adminCovered.delete(this.adminCovered.keys().next().value);
    }
    this.acceptAdminRecords(p.records, false);
  }

  onAdminStateRequest(p) {
    const rid = String(p.reqId || '');
    if (!rid || !this.adminRecords.length) return;
    const have = new Set(Array.isArray(p.have) ? p.have.map(String) : []);
    if (this.adminRecords.every((r) => have.has(r.id))) return;
    if (!this.adminCovered.has(rid)) this.adminCovered.set(rid, new Set());
    setTimeout(() => {
      const covered = this.adminCovered.get(rid) || new Set();
      const missing = this.adminRecords.filter((r) => !have.has(r.id) && !covered.has(r.id));
      for (let i = 0; i < missing.length; i += 25) {
        this.mesh.broadcast({ meshType: 'ADMIN_RECORDS', reqId: rid, records: missing.slice(i, i + 25).map((r) => ({ b: r.b, s: r.s })) });
      }
      missing.forEach((r) => covered.add(r.id));
    }, rnd(200, 1000));
  }

  answerAdminSync(body) {
    const rid = String(body.reqId || '');
    if (!rid || this.adminSyncAnswered.has(rid) || Math.abs(now() - body.ts) > 10 * 60 * 1000) return;
    this.adminSyncAnswered.add(rid);
    setTimeout(() => this.mesh.broadcast({
      meshType: 'ADMIN_SYNC_REPLY', reqId: rid, tag: this.tag, since: this.acct.nameSince || this.acct.createdAt || 0,
      createdAt: this.acct.createdAt || 0, nodeId: this.nodeId, clientType: 'server', contacts: 0
    }), rnd(150, 1500));
    setTimeout(() => {
      if ((this.dumpCount.get(rid) || 0) >= 2) return;
      const entries = this.exportRegistry(NAME_REGISTRY_MAX);
      const parts = Math.ceil(entries.length / NAME_SYNC_MAX_ENTRIES);
      for (let i = 0; i < parts; i++) {
        this.mesh.broadcast({ meshType: 'ADMIN_REGISTRY_DUMP', reqId: rid, part: i, parts, entries: entries.slice(i * NAME_SYNC_MAX_ENTRIES, (i + 1) * NAME_SYNC_MAX_ENTRIES) });
      }
      this.dumpCount.set(rid, (this.dumpCount.get(rid) || 0) + 1);
    }, rnd(800, 3000));
  }

  // ---------- caixa postal ----------
  isOnline(tag) { const p = this.presence.get(tag); return Boolean(p && now() - p.at < PRESENCE_FRESH_MS); }

  storable(dest) {
    return dest && dest !== this.tag && splitTag(dest) && !dest.startsWith('@link_') && !dest.startsWith('@linkchat_') && !this.isDeleted(dest);
  }

  onDirect(p, sender) {
    const dest = normalizeTag(p.to);
    const type = p.signalType;
    const pl = p.payload || {};
    if (dest === this.tag) { this.onSignalToMe(sender, p); return; }
    if (!this.cfg.mailbox.enabled || !this.storable(dest) || !sender) return;
    // Visitantes e salas de link não passam pela caixa postal
    if (pl.shareId || sender.startsWith('@link_')) return;
    if (type === 'CHAT_MESSAGE' && pl.id) {
      const key = `${dest}|m|${pl.id}`;
      if (this.hasStored(dest, key)) return; // reenvio do próprio remetente: já guardado
      if (!this.pending.has(key)) this.pending.set(key, { dest, key, packet: p, kind: 'msg', at: now(), ids: [String(pl.id)] });
    } else if (type === 'CHAT_DELETE' && Array.isArray(pl.msgIds) && pl.msgIds.length) {
      const ids = pl.msgIds.slice(0, 100).map(String);
      const key = `${dest}|d|${ids.join(',').slice(0, 300)}`;
      if (!this.hasStored(dest, key) && !this.pending.has(key)) this.pending.set(key, { dest, key, packet: p, kind: 'del', at: now(), ids });
    } else if (type === 'CHAT_ACK' || type === 'CHAT_READ') {
      // O destino respondeu: o que eu guardava para ele (vindo deste remetente) já chegou
      const ids = [pl.msgId, ...(Array.isArray(pl.msgIds) ? pl.msgIds : [])].filter(Boolean).map(String);
      this.clearAcked(sender, dest, ids);
      // Confirmação para quem está offline: guarda (entregue uma vez quando ele aparecer)
      if (!this.isOnline(dest) && ids.length) this.store(dest, { key: `${dest}|a|${p.pktId}`, packet: p, kind: 'ack', ids });
    }
  }

  clearAcked(ackSender, origSender, ids) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    for (const [k, v] of this.pending) {
      if (v.dest === ackSender && v.ids.some((i) => idSet.has(i))) this.pending.delete(k);
    }
    const box = this.mailbox[ackSender];
    if (!box) return;
    const before = box.length;
    this.mailbox[ackSender] = box.filter((it) => !(it.kind !== 'ack' && normalizeTag(it.packet.senderTag) === origSender && it.ids.some((i) => idSet.has(i))));
    const removed = before - this.mailbox[ackSender].length;
    if (removed) { this.stats.acked += removed; this.dirty.mailbox = true; }
    if (!this.mailbox[ackSender].length) delete this.mailbox[ackSender];
  }

  hasStored(dest, key) { return Boolean((this.mailbox[dest] || []).some((it) => it.key === key)); }

  mailboxBytes() {
    let n = 0;
    Object.values(this.mailbox).forEach((box) => box.forEach((it) => { n += it.size || 0; }));
    return n;
  }

  store(dest, item) {
    const mb = this.cfg.mailbox;
    const size = Buffer.byteLength(JSON.stringify(item.packet));
    if (size > 64 * 1024) return;
    if (!this.mailbox[dest] && Object.keys(this.mailbox).length >= Math.max(1, this.cfg.limits.maxConnections)) {
      this.stats.dropped++;
      return; // limite de usuários atendidos
    }
    const box = this.mailbox[dest] || (this.mailbox[dest] = []);
    if (box.some((it) => it.key === item.key)) return;
    box.push({ ...item, size, storedAt: now(), tries: 0, lastTry: 0 });
    while (box.length > Math.max(10, mb.perUser || 300)) { box.shift(); this.stats.dropped++; }
    // Limite total em MB: sai o mais antigo de todos
    const max = Math.max(1, mb.maxMB || 200) * 1024 * 1024;
    let total = this.mailboxBytes();
    while (total > max) {
      let oldest = null;
      for (const d of Object.keys(this.mailbox)) {
        const it = this.mailbox[d][0];
        if (it && (!oldest || it.storedAt < oldest.it.storedAt)) oldest = { d, it };
      }
      if (!oldest) break;
      this.mailbox[oldest.d].shift();
      if (!this.mailbox[oldest.d].length) delete this.mailbox[oldest.d];
      total -= oldest.it.size || 0;
      this.stats.dropped++;
    }
    if (item.kind !== 'ack') { this.stats.stored++; log(`caixa postal: guardada ${item.kind === 'del' ? 'exclusão' : 'mensagem'} de ${item.packet.senderTag} para ${dest}`); }
    this.dirty.mailbox = true;
  }

  // Destino apareceu: reenvia o guardado (com "relayedBy" → o app mostra "🖥️ via <relay>")
  deliver(dest) {
    const box = this.mailbox[dest];
    if (!box || !box.length) return;
    const t = now();
    let sent = 0;
    box.forEach((it) => {
      if (t - (it.lastTry || 0) < 30000) return;
      it.tries = (it.tries || 0) + 1;
      it.lastTry = t;
      const pktId = 'pkt_' + nodeCrypto.randomBytes(8).toString('hex') + t;
      this.mesh.publishRaw({ ...it.packet, pktId, packetId: pktId, relayedBy: this.tag });
      sent++;
    });
    if (!sent) return;
    this.stats.delivered += sent;
    // Confirmações vão uma vez só; mensagens esperam o CHAT_ACK (até 6 tentativas)
    this.mailbox[dest] = box.filter((it) => it.kind !== 'ack' && it.tries < 6);
    if (!this.mailbox[dest].length) delete this.mailbox[dest];
    this.dirty.mailbox = true;
    log(`caixa postal: ${sent} item(ns) reenviado(s) para ${dest}`);
  }

  sweep() {
    const t = now();
    for (const [k, v] of this.pending) {
      if (t - v.at < ACK_WAIT_MS) continue;
      this.pending.delete(k);
      // Sem CHAT_ACK: o destino está offline (ou sem internet) → guarda
      this.store(v.dest, { key: v.key, packet: v.packet, kind: v.kind, ids: v.ids });
    }
    if (this.pending.size > 20000) this.pending.clear();
    const maxAge = Math.max(1, this.cfg.mailbox.days || 7) * 24 * 3600 * 1000;
    Object.keys(this.mailbox).forEach((d) => {
      const box = this.mailbox[d].filter((it) => t - it.storedAt < maxAge);
      if (box.length !== this.mailbox[d].length) this.dirty.mailbox = true;
      if (box.length) this.mailbox[d] = box; else delete this.mailbox[d];
    });
  }

  // Alguém conversou com o servidor: confirma e explica (1x por dia por pessoa)
  onSignalToMe(sender, p) {
    if (!sender || p.signalType !== 'CHAT_MESSAGE') return;
    const pl = p.payload || {};
    if (pl.id) this.mesh.sendSignal(sender, pl.id, 'CHAT_ACK', { msgId: pl.id, senderTag: this.tag, status: 'READ' });
    if (now() - (this.greeted.get(sender) || 0) < 24 * 3600 * 1000) return;
    this.greeted.set(sender, now());
    const id = 'msg_' + now() + '_' + nodeCrypto.randomBytes(3).toString('hex');
    const text = `🖥️ Este é um servidor relay do PulseShare (${cleanProfileName(this.acct.profileName) || this.tag}). ` +
      'Ele guarda mensagens para quem está offline e entrega quando a pessoa volta' +
      (this.turnInfo() ? ', e ajuda a passar arquivos quando a conexão direta não abre' : '') + '. Não há ninguém lendo esta conversa.';
    setTimeout(() => this.mesh.sendSignal(sender, id, 'CHAT_MESSAGE', { id, senderTag: this.tag, text, msgType: 'text', type: 'text', timestamp: now() }), 800);
  }

  // ---------- tráfego mensal ----------
  checkTraffic() {
    const m = monthKey();
    const tr = this.traffic;
    if (tr.month !== m) {
      log('novo mês: contador de tráfego zerado');
      Object.assign(tr, { month: m, relayRx: 0, relayTx: 0, ifBase: null, ifAcc: 0 });
    }
    const b = this.mesh.bytes;
    tr.relayRx += b.rx - this.lastBytes.rx;
    tr.relayTx += b.tx - this.lastBytes.tx;
    this.lastBytes = { rx: b.rx, tx: b.tx };
    const iface = defaultInterface();
    const cur = iface ? interfaceBytes(iface) : null;
    if (cur) {
      const total = cur.rx + cur.tx;
      if (tr.ifBase == null || total < tr.ifBase) tr.ifBase = total; // reinício zera os contadores do kernel
      tr.ifAcc += total - tr.ifBase;
      tr.ifBase = total;
      tr.iface = iface;
    }
    this.dirty.traffic = true;
    const limitGB = Number(this.cfg.limits.monthlyTrafficGB) || 0;
    const used = this.trafficUsed();
    const over = limitGB > 0 && used >= limitGB * 1024 * 1024 * 1024;
    if (over && !this.paused) {
      this.paused = true;
      log(`limite de tráfego mensal atingido (${fmtBytes(used)} de ${limitGB} GB): relay pausado até o próximo mês`);
      this.mesh.stop();
      this.saveAll();
    } else if (!over && this.paused) {
      this.paused = false;
      log('relay retomado');
      this.mesh = new Mesh(this.cfg, { nodeId: this.nodeId, tag: this.tag, onPacket: (p) => this.handle(p), onReady: () => this.onBrokerReady() });
      this.lastBytes = { rx: 0, tx: 0 };
      this.registeredSent = false;
      this.mesh.start();
    }
  }

  trafficUsed() {
    const tr = this.traffic;
    return this.cfg.limits.trafficSource === 'interface' && tr.iface ? tr.ifAcc : tr.relayRx + tr.relayTx;
  }

  // ---------- persistência e status ----------
  saveDirty() {
    try {
      if (this.dirty.registry) {
        let names = Object.keys(this.registry).filter((n) => this.alive(this.registry[n]));
        if (names.length > NAME_REGISTRY_MAX) names = names.sort((a, b) => (this.registry[b].seen || 0) - (this.registry[a].seen || 0)).slice(0, NAME_REGISTRY_MAX);
        const out = {};
        names.forEach((n) => { out[n] = this.registry[n]; });
        this.registry = out;
        writeJsonAtomic(this.files.registry, this.registry);
      }
      if (this.dirty.admin) writeJsonAtomic(this.files.admin, this.adminRecords.map((r) => ({ b: r.b, s: r.s })));
      if (this.dirty.mailbox) writeJsonAtomic(this.files.mailbox, this.mailbox, 0o600);
      if (this.dirty.traffic) writeJsonAtomic(this.files.traffic, this.traffic);
      this.dirty = {};
    } catch (e) { log('erro ao salvar dados:', e.message); }
  }

  saveAll() { this.dirty = { registry: true, admin: true, mailbox: true, traffic: true }; this.saveDirty(); }

  writeStatus() {
    const msgs = Object.values(this.mailbox).reduce((n, b) => n + b.filter((it) => it.kind !== 'ack').length, 0);
    const st = {
      version: VERSION, pid: process.pid, updatedAt: now(), startedAt: this.startedAt,
      tag: this.tag, profileName: cleanProfileName(this.acct.profileName), topic: this.mesh.topic,
      brokers: this.mesh.conns.map((c) => ({ url: c.url, online: c.ready, error: c.ready ? '' : (c.lastError || '') })),
      paused: this.paused,
      session: { rx: this.mesh.bytes.rx, tx: this.mesh.bytes.tx, queue: this.mesh.queue.length },
      month: { key: this.traffic.month, used: this.trafficUsed(), source: this.cfg.limits.trafficSource, limitGB: this.cfg.limits.monthlyTrafficGB },
      limits: this.cfg.limits,
      mailbox: { enabled: this.cfg.mailbox.enabled, users: Object.keys(this.mailbox).length, messages: msgs, bytes: this.mailboxBytes(), pending: this.pending.size, ...this.stats },
      registry: Object.keys(this.registry).length,
      adminRecords: this.adminRecords.length,
      usersOnline: Array.from(this.presence.values()).filter((p) => now() - p.at < PRESENCE_FRESH_MS).length,
      turn: { enabled: Boolean(this.turnInfo()), host: this.cfg.turn.host, port: this.cfg.turn.port }
    };
    try { writeJsonAtomic(this.files.status, st, 0o644); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Consulta de nome na rede (usada pelo configurador)
// ---------------------------------------------------------------------------
function probeNetwork(cfg, name, suffix, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const result = { taken: false, ownerTag: '', knownName: '', knownSince: 0, replies: 0, online: 0 };
    const probeId = 'probe_' + now() + '_' + nodeCrypto.randomBytes(3).toString('hex');
    let sent = false;
    let mesh;
    let wait = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(wait);
      result.online = mesh.online();
      mesh.stop();
      resolve(result);
    };
    mesh = new Mesh(cfg, {
      onPacket: (p) => {
        if (p.meshType !== 'PROBE_USER_EXISTS_REPLY' || p.probeId !== probeId) return;
        result.replies++;
        const o = splitTag(p.ownerTag || p.tag);
        if (!o) return;
        if (suffix && o.suffix === suffix) {
          if (!result.knownName || (name && o.name === name)) { result.knownName = o.name; result.knownSince = cleanSince(p.since); }
        } else if (name && o.name === name) { result.taken = true; result.ownerTag = `@${o.name}_${o.suffix}`; }
      },
      onReady: () => {
        if (sent) return;
        sent = true;
        mesh.broadcast({ meshType: 'PROBE_USER_EXISTS', probeId, tag: name && suffix ? `@${name}_${suffix}` : '', name: name || '', suffix: suffix || '', requesterNodeId: mesh.nodeId });
      }
    });
    const timer = setTimeout(finish, timeoutMs + 6000);
    mesh.start();
    // Depois do envio, espera timeoutMs pelas respostas
    wait = setInterval(() => { if (sent) { clearInterval(wait); clearTimeout(timer); setTimeout(finish, timeoutMs); } }, 100);
  });
}

// ---------------------------------------------------------------------------
// Configurador (modo texto)
// ---------------------------------------------------------------------------
async function configure() {
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(def !== undefined && def !== '' ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a === '' && def !== undefined ? String(def) : a;
  };
  const askNum = async (q, def, min = 0) => {
    for (;;) {
      const v = await ask(q, def);
      const n = Number(String(v).replace(',', '.'));
      if (Number.isFinite(n) && n >= min) return n;
      console.log('  → número inválido');
    }
  };
  const yes = async (q, def) => /^s/i.test(await ask(q + ' (s/n)', def ? 's' : 'n'));
  const PSC = loadCrypto();
  let cfg = loadConfig();
  const original = JSON.stringify(cfg);
  const line = () => console.log('─'.repeat(64));

  const accountSetup = async () => {
    line();
    console.log('CONTA DO SERVIDOR NA REDE PULSESHARE');
    console.log('  1) Criar conta nova (gera 7 palavras)');
    console.log('  2) Entrar com as 7 palavras ou a chave de acesso (ps-…)');
    console.log('  0) Voltar');
    const op = await ask('Opção', cfg.account ? '0' : '1');
    let words = '';
    if (op === '1') words = PSC.generate7WordMnemonic();
    else if (op === '2') {
      const raw = await ask('7 palavras ou chave de acesso');
      if (/^ps-/i.test(raw)) words = await PSC.accessKeyToWords(raw.trim());
      else { const chk = PSC.checkMnemonic(raw); words = chk.words; if (!words && chk.unknown && chk.unknown.length) console.log('  → palavra(s) fora da lista: ' + chk.unknown.join(', ')); }
      if (!words) { console.log('  → palavras/chave inválidas'); return; }
    } else return;
    const probeSfx = (await PSC.deriveIdentity('x', words)).pubKeyHex.slice(0, 6);
    let name = '';
    if (op === '2') {
      console.log('  Consultando a rede pelo nome desta conta...');
      const r = await probeNetwork(cfg, '', probeSfx);
      if (r.knownName) console.log(`  → a rede conhece esta conta como @${r.knownName}`);
      name = (await ask('Nome de usuário', r.knownName || '')).replace(/^@/, '').toLowerCase();
    } else {
      name = (await ask('Nome de usuário (ex.: relay_casa)')).replace(/^@/, '').toLowerCase();
    }
    const err = nameRuleError(name);
    if (err) { console.log('  → ' + err); return; }
    console.log(`  Verificando se "${name}" está livre na rede...`);
    const res = await probeNetwork(cfg, name, probeSfx);
    if (!res.online) { console.log('  → sem conexão com os brokers: não dá para garantir que o nome é único. Tente de novo.'); return; }
    if (res.taken) { console.log(`  → o nome "${name}" já é de outra conta (@${name}). Escolha outro.`); return; }
    const id = await PSC.deriveIdentity(name, words);
    const profileName = cleanProfileName(await ask('Nome do perfil (o que as pessoas veem)', (cfg.account && cfg.account.profileName) || 'Servidor relay'));
    cfg.account = {
      words: id.seedWords, name: id.name, tag: id.tag, pubKeyHex: id.pubKeyHex, regHash: id.regHash,
      createdAt: (cfg.account && cfg.account.pubKeyHex === id.pubKeyHex && cfg.account.createdAt) || id.createdAt,
      nameSince: res.knownName === name && res.knownSince ? res.knownSince : now(),
      profileName
    };
    const key = await PSC.wordsToAccessKey(id.seedWords);
    line();
    console.log('CONTA PRONTA — GUARDE ESTES DADOS EM LUGAR SEGURO:');
    console.log(`  Usuário ....... @${id.name}   (identificador completo: ${id.tag})`);
    console.log(`  Hash .......... ${id.pubKeyHex.slice(0, 6)}   (registro ${id.regHash})`);
    console.log(`  7 palavras .... ${id.seedWords}`);
    if (key) console.log(`  Chave acesso .. ${key}`);
    console.log('  Com as palavras ou a chave você entra nesta conta no app (ou em outro servidor).');
  };

  const turnSetup = async () => {
    line();
    console.log('RELAY TURN (coturn) — passa arquivos entre usuários quando a conexão direta não abre.');
    console.log('Precisa das portas 3478/udp+tcp e 49152-65535/udp liberadas no firewall.');
    const on = await yes('Ligar o TURN?', cfg.turn.enabled);
    cfg.turn.enabled = on;
    if (!on) return;
    let guess = cfg.turn.host;
    if (!guess) { try { guess = execSync('hostname -f', { encoding: 'utf8' }).trim(); } catch (e) { guess = ''; } }
    cfg.turn.host = await ask('Endereço público deste servidor (domínio ou IP)', guess);
    cfg.turn.port = await askNum('Porta', cfg.turn.port || 3478, 1);
    if (!cfg.turn.secret) cfg.turn.secret = nodeCrypto.randomBytes(24).toString('base64url');
  };

  for (;;) {
    const a = cfg.account;
    const L = cfg.limits;
    line();
    console.log(`PulseShare Relay ${VERSION} — configuração (${CONFIG_PATH})`);
    line();
    console.log(`  1) Conta ............... ${a ? `@${a.name}  (hash ${a.pubKeyHex.slice(0, 6)})` : '(nenhuma)'}`);
    console.log(`  2) Nome do perfil ...... ${a ? (cleanProfileName(a.profileName) || '(vazio)') : '-'}`);
    console.log(`  3) Banda de download ... ${L.downloadKbps ? L.downloadKbps + ' kbit/s' : 'sem limite'}`);
    console.log(`  4) Banda de upload ..... ${L.uploadKbps ? L.uploadKbps + ' kbit/s' : 'sem limite'}`);
    console.log(`  5) Tráfego mensal ...... ${L.monthlyTrafficGB ? L.monthlyTrafficGB + ' GB (' + (L.trafficSource === 'interface' ? 'placa de rede inteira' : 'só o relay') + ')' : 'sem limite'}`);
    console.log(`  6) Limite de conexões .. ${L.maxConnections} usuários ao mesmo tempo`);
    console.log(`  7) Caixa postal ........ ${cfg.mailbox.enabled ? `ligada (${cfg.mailbox.days} dias, ${cfg.mailbox.maxMB} MB, ${cfg.mailbox.perUser}/usuário)` : 'desligada'}`);
    console.log(`  8) Relay TURN .......... ${cfg.turn.enabled ? `ligado (${cfg.turn.host}:${cfg.turn.port})` : 'desligado'}`);
    console.log('  9) Ver status do serviço');
    console.log('  0) Salvar e sair');
    console.log('  q) Sair sem salvar');
    const op = (await ask('Opção', '0')).toLowerCase();
    if (op === '1') await accountSetup();
    else if (op === '2') { if (!a) console.log('  → crie a conta primeiro'); else a.profileName = cleanProfileName(await ask('Nome do perfil', a.profileName || '')); }
    else if (op === '3') L.downloadKbps = await askNum('Banda de download em kbit/s (0 = sem limite; 8000 = 8 Mbit/s)', L.downloadKbps);
    else if (op === '4') L.uploadKbps = await askNum('Banda de upload em kbit/s (0 = sem limite)', L.uploadKbps);
    else if (op === '5') {
      L.monthlyTrafficGB = await askNum('Tráfego mensal em GB (0 = sem limite)', L.monthlyTrafficGB);
      if (L.monthlyTrafficGB) L.trafficSource = (await yes('Contar a placa de rede inteira (recomendado com TURN)? Não = só o tráfego do relay', L.trafficSource === 'interface')) ? 'interface' : 'relay';
    } else if (op === '6') L.maxConnections = Math.round(await askNum('Usuários atendidos ao mesmo tempo (caixa postal e TURN)', L.maxConnections, 1));
    else if (op === '7') {
      cfg.mailbox.enabled = await yes('Guardar mensagens para quem está offline?', cfg.mailbox.enabled);
      if (cfg.mailbox.enabled) {
        cfg.mailbox.days = await askNum('Guardar por quantos dias', cfg.mailbox.days, 1);
        cfg.mailbox.maxMB = await askNum('Espaço máximo em MB', cfg.mailbox.maxMB, 1);
        cfg.mailbox.perUser = Math.round(await askNum('Máximo de mensagens por usuário', cfg.mailbox.perUser, 10));
      }
    } else if (op === '8') await turnSetup();
    else if (op === '9') showStatus();
    else if (op === 'q') { rl.close(); console.log('Nada foi alterado.'); return; }
    else if (op === '0') break;
  }
  rl.close();
  if (!cfg.account) { console.log('Sem conta: o serviço não inicia até você criar uma (pulseshare-relay config).'); }
  if (JSON.stringify(cfg) === original) { console.log('Nada mudou.'); return; }
  saveConfig(cfg);
  console.log('Configuração salva.');
  if (process.getuid && process.getuid() === 0) {
    if (cfg.turn.enabled) applyCoturn(cfg);
    else spawnSync('sh', ['-c', 'systemctl is-active --quiet coturn && grep -q "pulseshare-relay" /etc/turnserver.conf 2>/dev/null && systemctl disable --now coturn'], { stdio: 'inherit' });
    if (cfg.account) {
      spawnSync('systemctl', ['enable', '--now', 'pulseshare-relay'], { stdio: 'inherit' });
      spawnSync('systemctl', ['restart', 'pulseshare-relay'], { stdio: 'inherit' });
      console.log('Serviço reiniciado. Veja: pulseshare-relay status');
    }
  } else {
    console.log('(sem root: reinicie o serviço você mesmo — sudo systemctl restart pulseshare-relay)');
  }
}

// Escreve /etc/turnserver.conf com os limites e liga o coturn
function applyCoturn(cfg) {
  const have = spawnSync('sh', ['-c', 'command -v turnserver'], { encoding: 'utf8' }).status === 0;
  if (!have) {
    console.log('Instalando o coturn...');
    const r = spawnSync('sh', ['-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn'], { stdio: 'inherit' });
    if (r.status !== 0) { console.log('Não consegui instalar o coturn (instale manualmente: apt install coturn) e rode a configuração de novo.'); return; }
  }
  const L = cfg.limits;
  const kbps = [L.downloadKbps, L.uploadKbps].filter((v) => Number(v) > 0);
  const capBytes = kbps.length ? Math.floor(Math.min(...kbps) * 1000 / 8) : 0;
  const isIp = net.isIP(cfg.turn.host);
  const conf = [
    '# Gerado por pulseshare-relay config — será sobrescrito ao reconfigurar',
    `listening-port=${cfg.turn.port || 3478}`,
    'fingerprint',
    'use-auth-secret',
    `static-auth-secret=${cfg.turn.secret}`,
    'realm=pulseshare',
    `total-quota=${Math.max(1, L.maxConnections)}`,
    'user-quota=8',
    capBytes ? `bps-capacity=${capBytes}` : '',
    capBytes ? `max-bps=${capBytes}` : '',
    isIp ? `external-ip=${cfg.turn.host}` : '',
    'min-port=49152',
    'max-port=65535',
    'no-multicast-peers',
    'no-cli',
    'no-tlsv1',
    'no-tlsv1_1',
    // Não deixa o TURN alcançar a rede interna do servidor
    'denied-peer-ip=0.0.0.0-0.255.255.255',
    'denied-peer-ip=10.0.0.0-10.255.255.255',
    'denied-peer-ip=100.64.0.0-100.127.255.255',
    'denied-peer-ip=127.0.0.0-127.255.255.255',
    'denied-peer-ip=169.254.0.0-169.254.255.255',
    'denied-peer-ip=172.16.0.0-172.31.255.255',
    'denied-peer-ip=192.168.0.0-192.168.255.255',
    'denied-peer-ip=::1',
    'denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'syslog',
    ''
  ].filter((l) => l !== '').join('\n') + '\n';
  try {
    if (fs.existsSync('/etc/turnserver.conf') && !fs.readFileSync('/etc/turnserver.conf', 'utf8').includes('pulseshare-relay') && !fs.existsSync('/etc/turnserver.conf.orig')) {
      fs.copyFileSync('/etc/turnserver.conf', '/etc/turnserver.conf.orig');
    }
    fs.writeFileSync('/etc/turnserver.conf', conf, { mode: 0o640 });
    try { execSync('chgrp turnserver /etc/turnserver.conf', { stdio: 'ignore' }); } catch (e) {}
    if (fs.existsSync('/etc/default/coturn')) {
      let d = fs.readFileSync('/etc/default/coturn', 'utf8');
      d = /TURNSERVER_ENABLED/.test(d) ? d.replace(/#?\s*TURNSERVER_ENABLED=.*/, 'TURNSERVER_ENABLED=1') : d + '\nTURNSERVER_ENABLED=1\n';
      fs.writeFileSync('/etc/default/coturn', d);
    }
    spawnSync('systemctl', ['enable', 'coturn'], { stdio: 'ignore' });
    spawnSync('systemctl', ['restart', 'coturn'], { stdio: 'inherit' });
    console.log('coturn configurado (/etc/turnserver.conf) e reiniciado.');
  } catch (e) {
    console.log('Falha ao configurar o coturn:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function showStatus() {
  const st = readJson(path.join(DATA_DIR, 'status.json'), null);
  if (!st) { console.log('O serviço ainda não gravou o status (está rodando? sudo systemctl status pulseshare-relay).'); return; }
  const age = Math.round((now() - st.updatedAt) / 1000);
  const up = Math.round((now() - st.startedAt) / 60000);
  console.log(`PulseShare Relay ${st.version} — ${st.tag}${st.profileName ? ' (' + st.profileName + ')' : ''}`);
  console.log(`  Situação ........ ${age > 40 ? 'PARADO? (status de ' + age + ' s atrás)' : st.paused ? 'PAUSADO (limite de tráfego do mês)' : 'rodando'} • ativo há ${up} min • pid ${st.pid}`);
  st.brokers.forEach((b) => console.log(`  Broker .......... ${b.online ? '●' : '○'} ${b.url}${b.error ? '  (' + b.error + ')' : ''}`));
  console.log(`  Usuários online . ${st.usersOnline} (vistos na rede no último minuto)`);
  console.log(`  Tráfego ......... sessão ↓${fmtBytes(st.session.rx)} ↑${fmtBytes(st.session.tx)} • mês ${st.month.key}: ${fmtBytes(st.month.used)}${st.month.limitGB ? ' de ' + st.month.limitGB + ' GB' : ''}`);
  console.log(`  Limites ......... ↓${st.limits.downloadKbps || '∞'} kbit/s ↑${st.limits.uploadKbps || '∞'} kbit/s • ${st.limits.maxConnections} conexões`);
  const mb = st.mailbox;
  console.log(`  Caixa postal .... ${mb.enabled ? `${mb.messages} msg para ${mb.users} usuário(s), ${fmtBytes(mb.bytes)} • guardadas ${mb.stored}, reenviadas ${mb.delivered}, confirmadas ${mb.acked}, descartadas ${mb.dropped}` : 'desligada'}`);
  console.log(`  Catálogo ........ ${st.registry} nomes • ${st.adminRecords} registros do administrador`);
  console.log(`  TURN ............ ${st.turn.enabled ? `ligado em ${st.turn.host}:${st.turn.port}` : 'desligado'}`);
}

async function showAccount() {
  const cfg = loadConfig();
  if (!cfg.account) { console.log('Nenhuma conta configurada. Rode: sudo pulseshare-relay config'); return; }
  const a = cfg.account;
  console.log(`Usuário: @${a.name}   (identificador: ${a.tag})`);
  console.log(`Hash: ${a.pubKeyHex.slice(0, 6)}   registro ${a.regHash}`);
  console.log(`Nome do perfil: ${cleanProfileName(a.profileName) || '(vazio)'}`);
  if (process.argv.includes('--palavras')) {
    const PSC = loadCrypto();
    console.log(`7 palavras: ${a.words}`);
    const key = await PSC.wordsToAccessKey(a.words);
    if (key) console.log(`Chave de acesso: ${key}`);
  } else {
    console.log('(para ver as 7 palavras: sudo pulseshare-relay account --palavras)');
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] || 'help';
  if (cmd === 'run') {
    const cfg = loadConfig();
    if (!cfg.account || !cfg.account.words) {
      log('sem conta configurada — rode: sudo pulseshare-relay config');
      // Espera em vez de sair (o systemd reiniciaria em laço)
      setInterval(() => {
        const c = loadConfig();
        if (c.account && c.account.words) { log('conta configurada: reiniciando'); process.exit(0); }
      }, 15000);
      return;
    }
    loadCrypto();
    await new Relay(cfg).start();
  } else if (cmd === 'config') {
    await configure();
    process.exit(0);
  } else if (cmd === 'status') {
    showStatus();
  } else if (cmd === 'account') {
    await showAccount();
  } else if (cmd === 'version' || cmd === '--version') {
    console.log(VERSION);
  } else {
    console.log(`PulseShare Relay ${VERSION}
Uso: pulseshare-relay <comando>
  config     configurar (conta, nome do perfil, banda, tráfego, conexões, caixa postal, TURN)
  status     situação do serviço
  account    mostra o @usuário e o hash (--palavras mostra as 7 palavras)
  logs       acompanha o registro do serviço (journalctl)
  restart    reinicia o serviço
  run        roda o relay em primeiro plano (o systemd usa este)`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { Mesh, Relay, TokenBucket, loadConfig, defaultConfig };
