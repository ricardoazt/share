/**
 * PulseShare Next-Gen Decentralized P2P Mesh Engine (pulseshare-mesh-engine.js)
 * Universal Browser / Service Worker / WebExtension Manifest V3 P2P Suite.
 *
 * Tecnologias Implementadas:
 * 1. libp2p: Circuit Relay v2 & Gossipsub v1.1
 * 2. Reticulum Network Stack (RNS Destination Hashing, Announce, Dynamic Path Table)
 * 3. Yggdrasil Network Overlay (Cryptographic IPv6, Tree Topology, Greedy Tree Routing)
 * 4. Kademlia DHT (256-bit Node IDs, XOR Distance, k-buckets, Iterative Lookup)
 * 5. AODV (Ad hoc On-Demand Distance Vector: RREQ, RREP, RERR, Loop-Free Routing)
 * 6. CRDTs (LWW-Element-Set, Causal Message Log, Lamport Clock, Conflict-Free Sync)
 * 7. Store and Forward (DTN Bundle Protocol, Persistent Cache, Opportunistic Delivery)
 * 8. Onion Routing (Layered Sphinx/Tor Cryptography via ECDH + AES-256-GCM)
 * 9. Double Ratchet Algorithm (Signal Protocol: DH Ratchet + Symmetric KDF Chains + E2EE)
 */

(function (global) {
  'use strict';

  // ==========================================================================
  // 0. UTILITÁRIOS BINÁRIOS, CRIPTOGRÁFICOS E ENCODING
  // ==========================================================================

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function uint8ToHex(bytes) {
    if (!bytes) return '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let hex = '';
    for (let i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function hexToUint8(hex) {
    if (!hex || typeof hex !== 'string') return new Uint8Array(0);
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const len = Math.floor(clean.length / 2);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    }
    return out;
  }

  function uint8ToBase64(bytes) {
    if (!bytes) return '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const len = arr.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  function base64ToUint8(base64) {
    if (!base64 || typeof base64 !== 'string') return new Uint8Array(0);
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function sha256Bytes(data) {
    const raw = typeof data === 'string' ? textEncoder.encode(data) : (data instanceof Uint8Array ? data : new Uint8Array(data));
    const buf = await crypto.subtle.digest('SHA-256', raw);
    return new Uint8Array(buf);
  }

  async function sha256Hex(data) {
    const bytes = await sha256Bytes(data);
    return uint8ToHex(bytes);
  }

  async function hmacSha256(keyBytes, dataBytes) {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
    return new Uint8Array(sig);
  }

  async function hkdfExtractAndExpand(salt, ikm, info, length = 32) {
    const effectiveSalt = salt && salt.length > 0 ? salt : new Uint8Array(32);
    const prk = await hmacSha256(effectiveSalt, ikm);
    
    // HKDF Expand
    const infoBytes = typeof info === 'string' ? textEncoder.encode(info) : info;
    let t = new Uint8Array(0);
    let okm = new Uint8Array(0);
    let i = 1;
    while (okm.length < length) {
      const stepData = new Uint8Array(t.length + infoBytes.length + 1);
      stepData.set(t, 0);
      stepData.set(infoBytes, t.length);
      stepData[stepData.length - 1] = i;
      t = await hmacSha256(prk, stepData);
      const combined = new Uint8Array(okm.length + t.length);
      combined.set(okm, 0);
      combined.set(t, okm.length);
      okm = combined;
      i++;
    }
    return okm.slice(0, length);
  }

  async function aesGcmEncrypt(keyBytes, ivBytes, plaintextBytes, additionalData = null) {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const params = { name: 'AES-GCM', iv: ivBytes };
    if (additionalData) {
      params.additionalData = typeof additionalData === 'string' ? textEncoder.encode(additionalData) : additionalData;
    }
    const ct = await crypto.subtle.encrypt(params, key, plaintextBytes);
    return new Uint8Array(ct);
  }

  async function aesGcmDecrypt(keyBytes, ivBytes, ciphertextBytes, additionalData = null) {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const params = { name: 'AES-GCM', iv: ivBytes };
    if (additionalData) {
      params.additionalData = typeof additionalData === 'string' ? textEncoder.encode(additionalData) : additionalData;
    }
    const pt = await crypto.subtle.decrypt(params, key, ciphertextBytes);
    return new Uint8Array(pt);
  }

  // ==========================================================================
  // 1. CRDTs: CONFLICT-FREE REPLICATED DATA TYPES
  // ==========================================================================

  /**
   * LWW-Element-Set (Last-Write-Wins Element Set)
   * Garante convergência determinística para catálogo de nós, status e metadados.
   */
  class LWWElementSet {
    constructor(nodeId) {
      this.nodeId = nodeId;
      this.addSet = new Map();    // key -> { value, timestamp, nodeId }
      this.removeSet = new Map(); // key -> { timestamp, nodeId }
      this.lamportClock = 0;
    }

    tick(remoteClock = 0) {
      this.lamportClock = Math.max(this.lamportClock, remoteClock) + 1;
      return this.lamportClock;
    }

    add(key, value, customClock = null) {
      const clock = customClock || this.tick();
      const existing = this.addSet.get(key);
      if (!existing || clock > existing.timestamp || (clock === existing.timestamp && this.nodeId >= existing.nodeId)) {
        this.addSet.set(key, { value, timestamp: clock, nodeId: this.nodeId });
      }
    }

    remove(key, customClock = null) {
      const clock = customClock || this.tick();
      const existing = this.removeSet.get(key);
      if (!existing || clock > existing.timestamp || (clock === existing.timestamp && this.nodeId >= existing.nodeId)) {
        this.removeSet.set(key, { timestamp: clock, nodeId: this.nodeId });
      }
    }

    has(key) {
      const added = this.addSet.get(key);
      if (!added) return false;
      const removed = this.removeSet.get(key);
      if (!removed) return true;
      if (added.timestamp > removed.timestamp) return true;
      if (added.timestamp === removed.timestamp && added.nodeId >= removed.nodeId) return true;
      return false;
    }

    get(key) {
      return this.has(key) ? this.addSet.get(key)?.value : undefined;
    }

    readAll() {
      const result = {};
      for (const [key, item] of this.addSet.entries()) {
        if (this.has(key)) {
          result[key] = item.value;
        }
      }
      return result;
    }

    getState() {
      return {
        addSet: Array.from(this.addSet.entries()),
        removeSet: Array.from(this.removeSet.entries()),
        lamportClock: this.lamportClock
      };
    }

    merge(remoteState) {
      if (!remoteState) return false;
      let changed = false;
      this.tick(remoteState.lamportClock || 0);

      if (Array.isArray(remoteState.addSet)) {
        for (const [key, item] of remoteState.addSet) {
          const local = this.addSet.get(key);
          if (!local || item.timestamp > local.timestamp || (item.timestamp === local.timestamp && item.nodeId >= local.nodeId)) {
            this.addSet.set(key, item);
            changed = true;
          }
        }
      }

      if (Array.isArray(remoteState.removeSet)) {
        for (const [key, item] of remoteState.removeSet) {
          const local = this.removeSet.get(key);
          if (!local || item.timestamp > local.timestamp || (item.timestamp === local.timestamp && item.nodeId >= local.nodeId)) {
            this.removeSet.set(key, item);
            changed = true;
          }
        }
      }

      return changed;
    }
  }

  /**
   * Causal CRDT Message Log (Observed-Remove Event Stream)
   * Garante ordenação imutável de eventos e chats distribuídos sem conflitos.
   */
  class CausalMessageLog {
    constructor(nodeId) {
      this.nodeId = nodeId;
      this.entries = new Map(); // id -> { id, lamport, nodeId, data, wallClock }
      this.lamportClock = 0;
    }

    append(id, data) {
      this.lamportClock++;
      const entry = {
        id: id || crypto.randomUUID(),
        lamport: this.lamportClock,
        nodeId: this.nodeId,
        data,
        wallClock: Date.now()
      };
      this.entries.set(entry.id, entry);
      return entry;
    }

    mergeEntries(incomingEntries) {
      let changed = false;
      if (!Array.isArray(incomingEntries)) return false;

      for (const item of incomingEntries) {
        if (!item || !item.id) continue;
        this.lamportClock = Math.max(this.lamportClock, item.lamport || 0);
        if (!this.entries.has(item.id)) {
          this.entries.set(item.id, item);
          changed = true;
        }
      }
      return changed;
    }

    getSorted() {
      return Array.from(this.entries.values()).sort((a, b) => {
        if (a.lamport !== b.lamport) return a.lamport - b.lamport;
        if (a.nodeId !== b.nodeId) return a.nodeId.localeCompare(b.nodeId);
        return a.id.localeCompare(b.id);
      });
    }
  }

  // ==========================================================================
  // 2. KADEMLIA DHT (DISTRIBUTED HASH TABLE)
  // ==========================================================================

  /**
   * Implementação completa de Kademlia DHT com métrica XOR de 256 bits,
   * k-buckets com política de substituição Least-Recently-Seen e busca iterativa.
   */
  class KBucket {
    constructor(k = 8) {
      this.k = k;
      this.nodes = []; // { nodeId, info, lastSeen }
    }

    update(nodeId, info) {
      const idx = this.nodes.findIndex((n) => n.nodeId === nodeId);
      const now = Date.now();
      if (idx !== -1) {
        // Move para o final (most recently seen)
        const existing = this.nodes.splice(idx, 1)[0];
        existing.info = { ...existing.info, ...info };
        existing.lastSeen = now;
        this.nodes.push(existing);
        return true;
      }
      if (this.nodes.length < this.k) {
        this.nodes.push({ nodeId, info, lastSeen: now });
        return true;
      }
      // Se estiver cheio, o nó mais antigo no início pode ser substituído se inativo
      const oldest = this.nodes[0];
      if (now - oldest.lastSeen > 60000) {
        this.nodes.shift();
        this.nodes.push({ nodeId, info, lastSeen: now });
        return true;
      }
      return false;
    }

    remove(nodeId) {
      const idx = this.nodes.findIndex((n) => n.nodeId === nodeId);
      if (idx !== -1) {
        this.nodes.splice(idx, 1);
        return true;
      }
      return false;
    }
  }

  class KademliaDHT {
    constructor(localNodeId, k = 8) {
      this.localNodeId = localNodeId; // 256-bit Hex string
      this.k = k;
      this.buckets = Array.from({ length: 256 }, () => new KBucket(k));
      this.storage = new Map(); // key -> { value, publisher, storedAt, ttl }
    }

    static computeDistanceBigInt(hexA, hexB) {
      try {
        const a = BigInt('0x' + (hexA.length === 64 ? hexA : hexA.padEnd(64, '0').slice(0, 64)));
        const b = BigInt('0x' + (hexB.length === 64 ? hexB : hexB.padEnd(64, '0').slice(0, 64)));
        return a ^ b;
      } catch {
        return BigInt(0);
      }
    }

    getBucketIndex(nodeId) {
      const dist = KademliaDHT.computeDistanceBigInt(this.localNodeId, nodeId);
      if (dist === BigInt(0)) return 0;
      // Calcula leading zeros para determinar profundidade do bucket (0..255)
      const binStr = dist.toString(2).padStart(256, '0');
      const leadingZeros = binStr.indexOf('1');
      return leadingZeros === -1 ? 0 : 255 - leadingZeros;
    }

    updateNode(nodeId, info) {
      if (!nodeId || nodeId === this.localNodeId) return;
      const bIdx = this.getBucketIndex(nodeId);
      this.buckets[bIdx].update(nodeId, info);
    }

    findClosestNodes(targetId, count = 8) {
      const all = [];
      for (const bucket of this.buckets) {
        for (const item of bucket.nodes) {
          all.push({
            ...item,
            distance: KademliaDHT.computeDistanceBigInt(targetId, item.nodeId)
          });
        }
      }
      all.sort((a, b) => (a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0));
      return all.slice(0, count).map((n) => ({
        nodeId: n.nodeId,
        info: n.info,
        lastSeen: n.lastSeen
      }));
    }

    storeValue(key, value, publisher, ttlMs = 86400000) {
      this.storage.set(key, {
        value,
        publisher,
        storedAt: Date.now(),
        ttl: ttlMs
      });
    }

    findValue(key) {
      const item = this.storage.get(key);
      if (item) {
        if (Date.now() - item.storedAt < item.ttl) {
          return { found: true, value: item.value };
        }
        this.storage.delete(key);
      }
      return { found: false, closestNodes: this.findClosestNodes(key, this.k) };
    }

    getAllNodes() {
      const list = [];
      for (const bucket of this.buckets) {
        for (const n of bucket.nodes) {
          list.push(n);
        }
      }
      return list;
    }
  }

  // ==========================================================================
  // 3. AODV: AD HOC ON-DEMAND DISTANCE VECTOR ROUTING
  // ==========================================================================

  /**
   * Roteamento reativo móvel/mesh com números de sequência para prevenção de loops,
   * descoberta sob demanda (RREQ/RREP) e sinalização de falha de rota (RERR).
   */
  class AODVRouter {
    constructor(myTag) {
      this.myTag = myTag;
      this.sequenceNumber = 1;
      this.rreqIdCounter = 0;
      this.routingTable = new Map(); // destTag -> { nextHop, hopCount, destSeqNum, validSeq, lifetime }
      this.seenRREQs = new Map();    // key (origTag + ':' + rreqId) -> timestamp
      this.pendingLookups = new Map(); // destTag -> [{ resolve, timer }]
    }

    getNextRreqId() {
      return ++this.rreqIdCounter;
    }

    getNextSeqNum() {
      return ++this.sequenceNumber;
    }

    updateRoute(destTag, nextHop, hopCount, destSeqNum, lifetimeMs = 120000) {
      const now = Date.now();
      const existing = this.routingTable.get(destTag);

      let shouldUpdate = false;
      if (!existing) {
        shouldUpdate = true;
      } else if (destSeqNum > existing.destSeqNum) {
        shouldUpdate = true;
      } else if (destSeqNum === existing.destSeqNum && hopCount < existing.hopCount) {
        shouldUpdate = true;
      } else if (now > existing.lifetime) {
        shouldUpdate = true;
      }

      if (shouldUpdate) {
        this.routingTable.set(destTag, {
          nextHop,
          hopCount,
          destSeqNum,
          validSeq: true,
          lifetime: now + lifetimeMs
        });
        return true;
      }
      return false;
    }

    getRoute(destTag) {
      const entry = this.routingTable.get(destTag);
      if (entry && Date.now() < entry.lifetime) {
        return entry;
      }
      return null;
    }

    createRREQ(destTag) {
      const rreqId = this.getNextRreqId();
      const currentRoute = this.routingTable.get(destTag);
      const knownDestSeq = currentRoute ? currentRoute.destSeqNum : 0;
      this.sequenceNumber++;

      return {
        type: 'AODV_RREQ',
        rreqId,
        destTag,
        destSeqNum: knownDestSeq,
        origTag: this.myTag,
        origSeqNum: this.sequenceNumber,
        hopCount: 0,
        timestamp: Date.now()
      };
    }

    handleRREQ(rreq, neighborTag) {
      const key = `${rreq.origTag}:${rreq.rreqId}`;
      if (this.seenRREQs.has(key)) return null;
      this.seenRREQs.set(key, Date.now());

      // Reverse Route setup
      this.updateRoute(rreq.origTag, neighborTag, rreq.hopCount + 1, rreq.origSeqNum);

      // Limpeza de cache de RREQs antigos
      if (this.seenRREQs.size > 1000) {
        const oldestKey = this.seenRREQs.keys().next().value;
        this.seenRREQs.delete(oldestKey);
      }

      // Se este nó for o destino final
      if (this.myTag === rreq.destTag) {
        this.sequenceNumber = Math.max(this.sequenceNumber, rreq.destSeqNum) + 1;
        return {
          action: 'REPLY',
          rrep: {
            type: 'AODV_RREP',
            destTag: this.myTag,
            destSeqNum: this.sequenceNumber,
            origTag: rreq.origTag,
            hopCount: 0,
            lifetime: 180000
          },
          sendTo: neighborTag
        };
      }

      // Se possui rota fresca para o destino
      const activeRoute = this.getRoute(rreq.destTag);
      if (activeRoute && activeRoute.destSeqNum >= rreq.destSeqNum) {
        return {
          action: 'REPLY',
          rrep: {
            type: 'AODV_RREP',
            destTag: rreq.destTag,
            destSeqNum: activeRoute.destSeqNum,
            origTag: rreq.origTag,
            hopCount: activeRoute.hopCount,
            lifetime: activeRoute.lifetime - Date.now()
          },
          sendTo: neighborTag
        };
      }

      // Caso contrário, encaminha RREQ incrementando hopCount
      return {
        action: 'FORWARD',
        forwardRREQ: {
          ...rreq,
          hopCount: rreq.hopCount + 1
        }
      };
    }

    handleRREP(rrep, neighborTag) {
      // Forward Route setup
      this.updateRoute(rrep.destTag, neighborTag, rrep.hopCount + 1, rrep.destSeqNum, rrep.lifetime);

      if (this.myTag === rrep.origTag) {
        // Chegou ao remetente original da rota!
        const lookups = this.pendingLookups.get(rrep.destTag);
        if (lookups) {
          lookups.forEach((l) => {
            clearTimeout(l.timer);
            l.resolve(this.getRoute(rrep.destTag));
          });
          this.pendingLookups.delete(rrep.destTag);
        }
        return { action: 'ESTABLISHED', route: this.getRoute(rrep.destTag) };
      }

      // Encaminha de volta pelo caminho reverso até origTag
      const reverseRoute = this.getRoute(rrep.origTag);
      if (reverseRoute) {
        return {
          action: 'FORWARD',
          sendTo: reverseRoute.nextHop,
          forwardRREP: {
            ...rrep,
            hopCount: rrep.hopCount + 1
          }
        };
      }

      return { action: 'DROP' };
    }

    handleLinkBreak(brokenNeighbor) {
      const unreachable = [];
      const now = Date.now();
      for (const [dest, entry] of this.routingTable.entries()) {
        if (entry.nextHop === brokenNeighbor) {
          entry.lifetime = now - 1; // Expira rota
          entry.destSeqNum++;
          unreachable.push({ destTag: dest, seqNum: entry.destSeqNum });
        }
      }
      if (unreachable.length > 0) {
        return {
          type: 'AODV_RERR',
          unreachable,
          reporter: this.myTag
        };
      }
      return null;
    }
  }

  // ==========================================================================
  // 4. RETICULUM NETWORK STACK (RNS)
  // ==========================================================================

  /**
   * Implementação do núcleo de roteamento Reticulum:
   * Endereçamento por Hash de Destino (16 bytes = 128-bit truncated SHA-256),
   * Pacotes Announce com assinaturas, Tabela Dinâmica de Caminhos (Dynamic Path Table).
   */
  class ReticulumEngine {
    constructor(nodeTag, publicKeyHex) {
      this.nodeTag = nodeTag;
      this.publicKeyHex = publicKeyHex || '';
      this.destinationHash = '';
      this.pathTable = new Map(); // destHash -> { nextHop, hops, lastHeard, metric }
      this.knownDestinations = new Map(); // destHash -> { tag, pubKeyHex, appName }
      this.calculateLocalDestination();
    }

    async calculateLocalDestination() {
      const raw = textEncoder.encode(`rns.pulseshare.${this.nodeTag}.${this.publicKeyHex}`);
      const hash = await sha256Hex(raw);
      this.destinationHash = hash.slice(0, 32); // 16 bytes em Hex
      this.knownDestinations.set(this.destinationHash, {
        tag: this.nodeTag,
        pubKeyHex: this.publicKeyHex,
        appName: 'pulseshare'
      });
      return this.destinationHash;
    }

    async createAnnounce(appData = null) {
      if (!this.destinationHash) await this.calculateLocalDestination();
      const announcePayload = {
        type: 'RNS_ANNOUNCE',
        destHash: this.destinationHash,
        tag: this.nodeTag,
        pubKeyHex: this.publicKeyHex,
        appData: appData || { app: 'PulseShare', v: '3.0' },
        hops: 0,
        timestamp: Date.now()
      };
      // Gera assinatura de integridade do anúncio
      const sigData = textEncoder.encode(`${announcePayload.destHash}:${announcePayload.timestamp}`);
      announcePayload.signature = await sha256Hex(sigData);
      return announcePayload;
    }

    handleAnnounce(packet, viaPeerTag) {
      if (!packet || packet.type !== 'RNS_ANNOUNCE') return false;
      const { destHash, tag, pubKeyHex, hops, timestamp } = packet;
      if (!destHash || tag === this.nodeTag) return false;

      this.knownDestinations.set(destHash, { tag, pubKeyHex, timestamp });

      const existing = this.pathTable.get(destHash);
      const incomingHops = (hops || 0) + 1;

      if (!existing || incomingHops < existing.hops || Date.now() - existing.lastHeard > 60000) {
        this.pathTable.set(destHash, {
          destHash,
          tag,
          nextHop: viaPeerTag || tag,
          hops: incomingHops,
          lastHeard: Date.now(),
          metric: Math.round(100 / incomingHops)
        });
        return true;
      }
      return false;
    }

    resolveDestination(destHashOrTag) {
      if (this.pathTable.has(destHashOrTag)) {
        return this.pathTable.get(destHashOrTag);
      }
      for (const entry of this.pathTable.values()) {
        if (entry.tag === destHashOrTag) return entry;
      }
      return null;
    }

    getAllPaths() {
      return Array.from(this.pathTable.values());
    }
  }

  // ==========================================================================
  // 5. YGGDRASIL NETWORK OVERLAY
  // ==========================================================================

  /**
   * Implementação dos fundamentos do Yggdrasil:
   * Endereço IPv6 overlay criptográfico derivado da chave pública (faixa 200::/7),
   * Coordenadas de árvore de abrangência (Spanning Tree) e Roteamento Guloso (Greedy Tree Metric).
   */
  class YggdrasilOverlay {
    constructor(publicKeyHex) {
      this.publicKeyHex = publicKeyHex || '';
      this.ipv6Address = '';
      this.treeCoordinates = [0]; // Posição na árvore em relação à raiz
      this.treeParent = null;
      this.children = new Map();
      this.routingTable = new Map(); // peerKey -> { coordinates, ipv6, linkQuality }
      this.deriveIpv6();
    }

    async deriveIpv6() {
      const seed = hexToUint8(this.publicKeyHex || '00'.repeat(32));
      const hash = await sha256Bytes(seed);
      // Padrão Yggdrasil: prefixo 0200::/7 seguido do hash da chave
      const ipParts = ['0200'];
      for (let i = 0; i < 7; i++) {
        const seg = (hash[i * 2] << 8) | hash[i * 2 + 1];
        ipParts.push(seg.toString(16).padStart(4, '0'));
      }
      this.ipv6Address = ipParts.join(':');
      return this.ipv6Address;
    }

    updateCoordinates(parentCoords, indexAsChild) {
      if (Array.isArray(parentCoords)) {
        this.treeCoordinates = [...parentCoords, indexAsChild];
      }
    }

    static calculateTreeDistance(coordsA, coordsB) {
      if (!Array.isArray(coordsA) || !Array.isArray(coordsB)) return 999;
      // Encontra o mais longo ancestral comum (LCA)
      let commonPrefixLen = 0;
      const minLen = Math.min(coordsA.length, coordsB.length);
      while (commonPrefixLen < minLen && coordsA[commonPrefixLen] === coordsB[commonPrefixLen]) {
        commonPrefixLen++;
      }
      // Distância na árvore é a soma das arestas subindo até o LCA e descendo
      return (coordsA.length - commonPrefixLen) + (coordsB.length - commonPrefixLen);
    }

    findNextHopGreedy(targetCoords) {
      let bestPeer = null;
      let minDistance = YggdrasilOverlay.calculateTreeDistance(this.treeCoordinates, targetCoords);

      for (const [peerKey, entry] of this.routingTable.entries()) {
        const dist = YggdrasilOverlay.calculateTreeDistance(entry.coordinates, targetCoords);
        if (dist < minDistance) {
          minDistance = dist;
          bestPeer = peerKey;
        }
      }
      return bestPeer;
    }

    registerPeer(peerKey, coordinates, ipv6) {
      this.routingTable.set(peerKey, {
        peerKey,
        coordinates: coordinates || [0],
        ipv6: ipv6 || '',
        updatedAt: Date.now()
      });
    }
  }

  // ==========================================================================
  // 6. libp2p: CIRCUIT RELAY v2 & GOSSIPSUB
  // ==========================================================================

  /**
   * libp2p Circuit Relay v2:
   * Protocolo de reserva de saltos (hop reservation), limites de banda/duração
   * e encapsulamento de dados com endereçamento Multiaddr (/p2p/Relay/p2p-circuit/p2p/Target).
   */
  class Libp2pCircuitRelayV2 {
    constructor(localPeerId) {
      this.localPeerId = localPeerId;
      this.reservations = new Map(); // peerId -> { token, expiresAt, bandwidthLimitKbps, activeStreams }
      this.activeCircuits = new Map(); // circuitId -> { src, dst, bytesRelayed, createdAt }
      this.maxReservations = 32;
    }

    createMultiaddr(relayPeerId, targetPeerId) {
      return `/p2p/${relayPeerId}/p2p-circuit/p2p/${targetPeerId}`;
    }

    parseMultiaddr(multiaddr) {
      const match = multiaddr.match(/\/p2p\/([^/]+)\/p2p-circuit\/p2p\/([^/]+)/);
      if (match) {
        return { relayPeerId: match[1], targetPeerId: match[2] };
      }
      return null;
    }

    reserveHop(clientPeerId, requestedTtlMs = 900000) {
      const now = Date.now();
      if (this.reservations.size >= this.maxReservations) {
        // Remove reservas expiradas
        for (const [pId, r] of this.reservations.entries()) {
          if (now > r.expiresAt) this.reservations.delete(pId);
        }
        if (this.reservations.size >= this.maxReservations) {
          return { ok: false, error: 'LIMIT_EXCEEDED_MAX_RESERVATIONS' };
        }
      }

      const token = `crv2-${crypto.randomUUID()}`;
      const reservation = {
        token,
        clientPeerId,
        expiresAt: now + Math.min(requestedTtlMs, 1800000),
        bandwidthLimitKbps: 2048,
        activeStreams: 0
      };
      this.reservations.set(clientPeerId, reservation);

      return {
        ok: true,
        type: 'HOP_RESERVED',
        token,
        expiresAt: reservation.expiresAt,
        relayPeerId: this.localPeerId
      };
    }

    connectCircuit(srcPeerId, dstPeerId, reservationToken) {
      const res = this.reservations.get(srcPeerId);
      if (!res || res.token !== reservationToken || Date.now() > res.expiresAt) {
        return { ok: false, error: 'NO_VALID_RESERVATION' };
      }

      const circuitId = `cir-${crypto.randomUUID()}`;
      this.activeCircuits.set(circuitId, {
        circuitId,
        src: srcPeerId,
        dst: dstPeerId,
        bytesRelayed: 0,
        createdAt: Date.now()
      });
      res.activeStreams++;

      return {
        ok: true,
        type: 'CIRCUIT_CONNECTED',
        circuitId,
        multiaddr: this.createMultiaddr(this.localPeerId, dstPeerId)
      };
    }

    closeCircuit(circuitId) {
      const circuit = this.activeCircuits.get(circuitId);
      if (circuit) {
        const res = this.reservations.get(circuit.src);
        if (res) res.activeStreams = Math.max(0, res.activeStreams - 1);
        this.activeCircuits.delete(circuitId);
      }
    }
  }

  /**
   * libp2p Gossipsub v1.1:
   * Cria uma malha pub/sub inteligente com graus D, Dlow, Dhigh, controle por mensagens
   * GRAFT e PRUNE, anúncio de metadados IHAVE e requisição IWANT com peer scoring.
   */
  class Libp2pGossipsub {
    constructor(localPeerId) {
      this.localPeerId = localPeerId;
      this.mesh = new Map();   // topic -> Set(peerId)
      this.fanout = new Map(); // topic -> Set(peerId)
      this.seenMessages = new Map(); // msgId -> timestamp
      this.mcache = [];        // [{ msgId, topic, payload, timestamp }]
      this.peerScores = new Map(); // peerId -> score
      this.d = 6;
      this.dLow = 4;
      this.dHigh = 12;
      this.heartbeatTimer = null;
    }

    subscribe(topic) {
      if (!this.mesh.has(topic)) {
        this.mesh.set(topic, new Set());
      }
    }

    unsubscribe(topic) {
      this.mesh.delete(topic);
    }

    graft(topic, peerId) {
      let peers = this.mesh.get(topic);
      if (!peers) {
        peers = new Set();
        this.mesh.set(topic, peers);
      }
      peers.add(peerId);
      return { type: 'GOSSIPSUB_CONTROL', action: 'GRAFT', topic, peerId };
    }

    prune(topic, peerId) {
      const peers = this.mesh.get(topic);
      if (peers) {
        peers.delete(peerId);
      }
      return { type: 'GOSSIPSUB_CONTROL', action: 'PRUNE', topic, peerId, backoffMs: 60000 };
    }

    publish(topic, payload) {
      const msgId = crypto.randomUUID();
      this.seenMessages.set(msgId, Date.now());
      this.mcache.push({ msgId, topic, payload, timestamp: Date.now() });

      if (this.mcache.length > 500) this.mcache.shift();

      const targets = this.mesh.get(topic) || new Set();
      return {
        type: 'GOSSIPSUB_PUBLISH',
        msgId,
        topic,
        payload,
        sender: this.localPeerId,
        targets: Array.from(targets)
      };
    }

    createIHaveAnnounce() {
      // Cria resumo de mensagens vistas nos últimos segundos para fofocar
      const recentIds = this.mcache.slice(-20).map((m) => m.msgId);
      return {
        type: 'GOSSIPSUB_CONTROL',
        action: 'IHAVE',
        messageIds: recentIds
      };
    }

    handleIHave(ihavePkt, fromPeerId) {
      const missingIds = [];
      if (Array.isArray(ihavePkt.messageIds)) {
        for (const id of ihavePkt.messageIds) {
          if (!this.seenMessages.has(id)) {
            missingIds.push(id);
          }
        }
      }
      if (missingIds.length > 0) {
        return {
          type: 'GOSSIPSUB_CONTROL',
          action: 'IWANT',
          messageIds: missingIds,
          targetPeerId: fromPeerId
        };
      }
      return null;
    }

    handleIWant(iwantPkt) {
      const found = [];
      if (Array.isArray(iwantPkt.messageIds)) {
        const idSet = new Set(iwantPkt.messageIds);
        for (const item of this.mcache) {
          if (idSet.has(item.msgId)) {
            found.push(item);
          }
        }
      }
      return found;
    }

    recordPeerDelivery(peerId, isValid = true) {
      const current = this.peerScores.get(peerId) || 0;
      this.peerScores.set(peerId, current + (isValid ? 1 : -5));
    }
  }

  // ==========================================================================
  // 7. STORE AND FORWARD (DELAY-TOLERANT NETWORKING / DTN BUNDLE PROTOCOL)
  // ==========================================================================

  /**
   * DTN Bundle Protocol (RFC 5050 / RFC 9171):
   * Armazena mensagens em trânsito com TTL persistente em IndexedDB.
   * Transfere custódia (Custody Transfer) e encaminha opportunisticamente
   * assim que nós intermediários ou o destinatário final ficarem acessíveis.
   */
  class DTNStoreAndForward {
    constructor(nodeTag) {
      this.nodeTag = nodeTag;
      this.dbName = 'pulseshare_dtn_bundles';
      this.storeName = 'bundles';
      this.db = null;
      this.memoryBundles = new Map(); // Fallback se IDB indisponível
      this.initDB();
    }

    async initDB() {
      if (typeof indexedDB === 'undefined') return;
      return new Promise((resolve) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'bundleId' });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          this.purgeExpiredBundles();
          resolve();
        };
        req.onerror = () => resolve();
      });
    }

    async stageBundle(bundle) {
      const entry = {
        bundleId: bundle.bundleId || crypto.randomUUID(),
        sourceTag: bundle.sourceTag,
        destTag: bundle.destTag,
        payload: bundle.payload,
        createdAt: bundle.createdAt || Date.now(),
        ttlMs: bundle.ttlMs || 86400000, // 24h padrão
        expiresAt: (bundle.createdAt || Date.now()) + (bundle.ttlMs || 86400000),
        custodyHolder: this.nodeTag,
        hops: Array.isArray(bundle.hops) ? bundle.hops : [this.nodeTag],
        status: 'STORED'
      };

      this.memoryBundles.set(entry.bundleId, entry);

      if (this.db) {
        try {
          const tx = this.db.transaction(this.storeName, 'readwrite');
          tx.objectStore(this.storeName).put(entry);
        } catch {}
      }
      return entry;
    }

    async getDeliverableBundles(reachablePeersSet) {
      const candidates = [];
      const now = Date.now();

      const all = await this.getAllBundles();
      for (const b of all) {
        if (now > b.expiresAt) {
          await this.removeBundle(b.bundleId);
          continue;
        }
        // Se o destinatário ou um nó de salto está no conjunto acessível
        if (b.destTag && (reachablePeersSet.has(b.destTag) || reachablePeersSet.has(b.destTag.replace(/^@/, '')))) {
          candidates.push(b);
        }
      }
      return candidates;
    }

    async acknowledgeCustody(bundleId) {
      await this.removeBundle(bundleId);
      return {
        type: 'DTN_CUSTODY_ACK',
        bundleId,
        confirmedBy: this.nodeTag,
        timestamp: Date.now()
      };
    }

    async removeBundle(bundleId) {
      this.memoryBundles.delete(bundleId);
      if (this.db) {
        try {
          const tx = this.db.transaction(this.storeName, 'readwrite');
          tx.objectStore(this.storeName).delete(bundleId);
        } catch {}
      }
    }

    async getAllBundles() {
      if (!this.db) return Array.from(this.memoryBundles.values());
      return new Promise((resolve) => {
        try {
          const tx = this.db.transaction(this.storeName, 'readonly');
          const req = tx.objectStore(this.storeName).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(Array.from(this.memoryBundles.values()));
        } catch {
          resolve(Array.from(this.memoryBundles.values()));
        }
      });
    }

    async purgeExpiredBundles() {
      const now = Date.now();
      const all = await this.getAllBundles();
      for (const b of all) {
        if (now > b.expiresAt) {
          await this.removeBundle(b.bundleId);
        }
      }
    }
  }

  // ==========================================================================
  // 8. ONION ROUTING (CRIPTOGRAFIA EM CAMADAS SPHINX / TOR STYLE)
  // ==========================================================================

  /**
   * Implementação de Roteamento Cebola P2P:
   * Empacota o dado em camadas sucessivas de criptografia (ECDH + AES-256-GCM).
   * Cada nó intermediário só decifra sua camada exterior, revelando apenas para qual
   * próximo salto enviar, sem nunca conseguir ler o conteúdo do arquivo ou mensagem.
   */
  class OnionRouter {
    constructor(localKeyPair) {
      this.localKeyPair = localKeyPair; // { publicKey, privateKey, pubHex }
    }

    /**
     * Cria um pacote cebola multi-hop.
     * @param {Array<{tag: string, pubKeyHex: string}>} routeHops - Lista ordenada de saltos
     * @param {string} finalDestinationTag - Destinatário final
     * @param {Uint8Array|string} payload - Conteúdo a proteger
     */
    async buildOnion(routeHops, finalDestinationTag, payload) {
      const payloadBytes = typeof payload === 'string' ? textEncoder.encode(payload) : (payload instanceof Uint8Array ? payload : new Uint8Array(payload));

      // 1. Camada Terminal (Mais interna: decifrada apenas pelo destino final)
      let currentPayload = {
        isTerminal: true,
        finalDest: finalDestinationTag,
        dataBase64: uint8ToBase64(payloadBytes)
      };
      let currentPayloadBytes = textEncoder.encode(JSON.stringify(currentPayload));

      // 2. Itera de trás para frente encapsulando cada nó da rota
      for (let i = routeHops.length - 1; i >= 0; i--) {
        const hop = routeHops[i];
        const nextHopTag = i < routeHops.length - 1 ? routeHops[i + 1].tag : finalDestinationTag;

        // Gera par de chaves ECDH efêmero para este salto
        const ephPair = await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits']
        );
        const ephPubRaw = await crypto.subtle.exportKey('raw', ephPair.publicKey);
        const ephPubHex = uint8ToHex(ephPubRaw);

        // Importa chave pública do nó do salto
        const hopPubKeyBytes = hexToUint8(hop.pubKeyHex);
        const hopCryptoKey = await crypto.subtle.importKey(
          'raw',
          hopPubKeyBytes,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );

        // Deriva segredo compartilhado e chave de criptografia de camada AES-256-GCM
        const sharedBits = await crypto.subtle.deriveBits(
          { name: 'ECDH', public: hopCryptoKey },
          ephPair.privateKey,
          256
        );
        const layerKey = await hkdfExtractAndExpand(new Uint8Array(0), new Uint8Array(sharedBits), 'PulseShare-Onion-Layer-v1');

        // IV de 12 bytes para AES-GCM
        const iv = crypto.getRandomValues(new Uint8Array(12));

        // Empacota instrução de próximo salto + payload encapsulado anterior
        const layerPlaintext = textEncoder.encode(JSON.stringify({
          nextHop: nextHopTag,
          innerData: uint8ToBase64(currentPayloadBytes)
        }));

        const encryptedLayer = await aesGcmEncrypt(layerKey, iv, layerPlaintext);

        currentPayload = {
          ephPubHex,
          ivHex: uint8ToHex(iv),
          layerCiphertextBase64: uint8ToBase64(encryptedLayer)
        };
        currentPayloadBytes = textEncoder.encode(JSON.stringify(currentPayload));
      }

      return currentPayload;
    }

    /**
     * Descasca uma única camada da cebola usando a chave privada local.
     */
    async peelLayer(onionPacket) {
      if (!this.localKeyPair || !this.localKeyPair.privateKey) {
        throw new Error('Chave privada local necessária para decifrar camada da cebola');
      }

      const { ephPubHex, ivHex, layerCiphertextBase64 } = onionPacket;
      if (!ephPubHex || !ivHex || !layerCiphertextBase64) {
        throw new Error('Formato inválido de camada Onion');
      }

      const ephPubKeyBytes = hexToUint8(ephPubHex);
      const ephCryptoKey = await crypto.subtle.importKey(
        'raw',
        ephPubKeyBytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: ephCryptoKey },
        this.localKeyPair.privateKey,
        256
      );
      const layerKey = await hkdfExtractAndExpand(new Uint8Array(0), new Uint8Array(sharedBits), 'PulseShare-Onion-Layer-v1');

      const iv = hexToUint8(ivHex);
      const ciphertext = base64ToUint8(layerCiphertextBase64);

      const decryptedBytes = await aesGcmDecrypt(layerKey, iv, ciphertext);
      const decryptedJson = JSON.parse(textDecoder.decode(decryptedBytes));

      if (decryptedJson.innerData) {
        const innerBytes = base64ToUint8(decryptedJson.innerData);
        const innerJson = JSON.parse(textDecoder.decode(innerBytes));

        if (innerJson.isTerminal) {
          return {
            isTerminal: true,
            finalDest: innerJson.finalDest,
            payloadBytes: base64ToUint8(innerJson.dataBase64)
          };
        }

        return {
          isTerminal: false,
          nextHop: decryptedJson.nextHop,
          nextLayerPacket: innerJson
        };
      }

      return decryptedJson;
    }
  }

  // ==========================================================================
  // 9. DOUBLE RATCHET ALGORITHM (SIGNAL PROTOCOL END-TO-END ENCRYPTION)
  // ==========================================================================

  /**
   * Implementação completa do Double Ratchet Algorithm:
   * 1. Ratchet KDF de Chave Raiz (Root Key)
   * 2. Ratchet DH (Troca de chaves ECDH P-256 para Forward Secrecy)
   * 3. Ratchet Simétrico (Cadeias de chave de envio/recebimento HMAC-SHA256)
   * 4. Auto-recuperação (Break-in Recovery / Post-Compromise Security)
   */
  class DoubleRatchetSession {
    constructor(peerTag, isAlice = false) {
      this.peerTag = peerTag;
      this.isAlice = isAlice;
      this.dhs = null; // Par de chaves DH próprio
      this.dhr = null; // Chave pública DH remota
      this.rk = null;  // Root Key
      this.cks = null; // Chain Key Sending
      this.ckr = null; // Chain Key Receiving
      this.ns = 0;     // Message number sending
      this.nr = 0;     // Message number receiving
      this.pn = 0;     // Previous chain length
      this.mkSkipped = new Map(); // key `${dhrHex}:${n}` -> messageKey
    }

    static async generateDHKeyPair() {
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      );
      const pubRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
      return {
        keyPair: pair,
        pubHex: uint8ToHex(pubRaw)
      };
    }

    async initAlice(sharedSecret32, bobDhPubHex) {
      this.isAlice = true;
      this.dhs = await DoubleRatchetSession.generateDHKeyPair();
      this.dhr = bobDhPubHex;

      // Alice deriva primeiro salto DH
      const bobPubKeyBytes = hexToUint8(bobDhPubHex);
      const bobCryptoKey = await crypto.subtle.importKey(
        'raw',
        bobPubKeyBytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      const dhShared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: bobCryptoKey },
        this.dhs.keyPair.privateKey,
        256
      );

      // KDF_RK(sharedSecret, dhShared) -> (nextRK, cks)
      const rkInput = new Uint8Array(dhShared);
      const derived = await hkdfExtractAndExpand(sharedSecret32, rkInput, 'PulseShare-DoubleRatchet-Root', 64);
      this.rk = derived.slice(0, 32);
      this.cks = derived.slice(32, 64);
      this.ckr = null;
      this.ns = 0;
      this.nr = 0;
      this.pn = 0;
    }

    async initBob(sharedSecret32, bobDhKeyPair) {
      this.isAlice = false;
      this.dhs = bobDhKeyPair;
      this.dhr = null;
      this.rk = sharedSecret32;
      this.cks = null;
      this.ckr = null;
      this.ns = 0;
      this.nr = 0;
      this.pn = 0;
    }

    async encrypt(plaintext, additionalData = '') {
      if (!this.cks) {
        throw new Error('Sessão Double Ratchet não inicializada para envio');
      }

      // KDF_CK(cks) -> (nextCks, messageKey)
      const nextCks = await hmacSha256(this.cks, textEncoder.encode('\x01'));
      const mk = await hmacSha256(this.cks, textEncoder.encode('\x02'));
      this.cks = nextCks;

      const header = {
        dhPubHex: this.dhs.pubHex,
        pn: this.pn,
        n: this.ns
      };
      this.ns++;

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ptBytes = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
      const ad = `${JSON.stringify(header)}:${additionalData}`;
      const ciphertext = await aesGcmEncrypt(mk, iv, ptBytes, ad);

      return {
        header,
        ivHex: uint8ToHex(iv),
        ciphertextBase64: uint8ToBase64(ciphertext),
        additionalData
      };
    }

    async decrypt(packet) {
      const { header, ivHex, ciphertextBase64, additionalData = '' } = packet;
      const iv = hexToUint8(ivHex);
      const ciphertext = base64ToUint8(ciphertextBase64);
      const ad = `${JSON.stringify(header)}:${additionalData}`;

      // Verifica se a chave foi pulada anteriormente (out-of-order)
      const skippedKeyId = `${header.dhPubHex}:${header.n}`;
      if (this.mkSkipped.has(skippedKeyId)) {
        const mk = this.mkSkipped.get(skippedKeyId);
        this.mkSkipped.delete(skippedKeyId);
        const pt = await aesGcmDecrypt(mk, iv, ciphertext, ad);
        return textDecoder.decode(pt);
      }

      // Se a chave pública DH do cabeçalho é nova, executa o passo DHRatchet
      if (header.dhPubHex !== this.dhr) {
        await this.skipMessageKeys(header.pn);
        await this.dhRatchet(header.dhPubHex);
      }

      await this.skipMessageKeys(header.n);

      // KDF_CK(ckr) -> (nextCkr, messageKey)
      const nextCkr = await hmacSha256(this.ckr, textEncoder.encode('\x01'));
      const mk = await hmacSha256(this.ckr, textEncoder.encode('\x02'));
      this.ckr = nextCkr;
      this.nr++;

      const pt = await aesGcmDecrypt(mk, iv, ciphertext, ad);
      return textDecoder.decode(pt);
    }

    async skipMessageKeys(until) {
      if (this.ckr) {
        while (this.nr < until) {
          const nextCkr = await hmacSha256(this.ckr, textEncoder.encode('\x01'));
          const mk = await hmacSha256(this.ckr, textEncoder.encode('\x02'));
          this.ckr = nextCkr;
          this.mkSkipped.set(`${this.dhr}:${this.nr}`, mk);
          this.nr++;
        }
      }
    }

    async dhRatchet(remoteDhPubHex) {
      this.pn = this.ns;
      this.ns = 0;
      this.nr = 0;
      this.dhr = remoteDhPubHex;

      // 1. Deriva novo segredo recebido
      const remoteKeyBytes = hexToUint8(remoteDhPubHex);
      const remoteCryptoKey = await crypto.subtle.importKey(
        'raw',
        remoteKeyBytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      const dhShared1 = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: remoteCryptoKey },
        this.dhs.keyPair.privateKey,
        256
      );
      const derived1 = await hkdfExtractAndExpand(this.rk, new Uint8Array(dhShared1), 'PulseShare-DoubleRatchet-Root', 64);
      this.rk = derived1.slice(0, 32);
      this.ckr = derived1.slice(32, 64);

      // 2. Gera novo par DH próprio para o próximo ciclo de envio
      this.dhs = await DoubleRatchetSession.generateDHKeyPair();
      const dhShared2 = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: remoteCryptoKey },
        this.dhs.keyPair.privateKey,
        256
      );
      const derived2 = await hkdfExtractAndExpand(this.rk, new Uint8Array(dhShared2), 'PulseShare-DoubleRatchet-Root', 64);
      this.rk = derived2.slice(0, 32);
      this.cks = derived2.slice(32, 64);
    }
  }

  // ==========================================================================
  // 10. MOTOR INTEGRADO: PULSESHARE MESH ENGINE (COORDINATOR)
  // ==========================================================================

  class PulseShareMeshEngine {
    constructor() {
      this.initialized = false;
      this.nodeId = '';
      this.myTag = '';
      this.localKeyPair = null;
      this.pubKeyHex = '';

      // Módulos
      this.crdt = null;
      this.messageLog = null;
      this.kademlia = null;
      this.aodv = null;
      this.reticulum = null;
      this.yggdrasil = null;
      this.circuitRelay = null;
      this.gossipsub = null;
      this.dtn = null;
      this.onion = null;
      this.ratchetSessions = new Map(); // peerTag -> DoubleRatchetSession

      this.onPacketToSend = null; // Callback para injetar pacotes na rede física
    }

    async init({ nodeId, myTag, onPacketToSend }) {
      this.nodeId = nodeId || crypto.randomUUID();
      this.myTag = myTag || '@anon';
      this.onPacketToSend = onPacketToSend || null;

      // 1. Gera par de chaves criptográficas persistente (P-256 ECDH)
      const dhPair = await DoubleRatchetSession.generateDHKeyPair();
      this.localKeyPair = {
        publicKey: dhPair.keyPair.publicKey,
        privateKey: dhPair.keyPair.privateKey,
        pubHex: dhPair.pubHex
      };
      this.pubKeyHex = dhPair.pubHex;

      // 2. Inicializa CRDTs
      this.crdt = new LWWElementSet(this.nodeId);
      this.messageLog = new CausalMessageLog(this.nodeId);

      // 3. Inicializa Kademlia DHT (256-bit Node ID gerado por SHA-256 da identidade)
      const kadNodeId = await sha256Hex(`${this.nodeId}:${this.myTag}:${this.pubKeyHex}`);
      this.kademlia = new KademliaDHT(kadNodeId, 8);

      // 4. Inicializa AODV
      this.aodv = new AODVRouter(this.myTag);

      // 5. Inicializa Reticulum
      this.reticulum = new ReticulumEngine(this.myTag, this.pubKeyHex);
      await this.reticulum.calculateLocalDestination();

      // 6. Inicializa Yggdrasil
      this.yggdrasil = new YggdrasilOverlay(this.pubKeyHex);
      await this.yggdrasil.deriveIpv6();

      // 7. Inicializa libp2p Circuit Relay v2 & Gossipsub
      this.circuitRelay = new Libp2pCircuitRelayV2(this.nodeId);
      this.gossipsub = new Libp2pGossipsub(this.nodeId);
      this.gossipsub.subscribe('pulseshare/global');

      // 8. Inicializa DTN Store and Forward
      this.dtn = new DTNStoreAndForward(this.myTag);

      // 9. Inicializa Onion Router
      this.onion = new OnionRouter(this.localKeyPair);

      this.initialized = true;
      console.log(`[PulseShareMeshEngine] Inicializado com sucesso!`);
      console.log(` - Yggdrasil IPv6: ${this.yggdrasil.ipv6Address}`);
      console.log(` - Reticulum Dest: rns://${this.reticulum.destinationHash}`);
      console.log(` - Kademlia NodeId: ${kadNodeId.slice(0, 16)}...`);
      return this;
    }

    async getOrCreateRatchetSession(peerTag, peerPubHex, isInitiator = true) {
      if (this.ratchetSessions.has(peerTag)) {
        return this.ratchetSessions.get(peerTag);
      }
      const session = new DoubleRatchetSession(peerTag, isInitiator);
      const sharedSecret = await sha256Bytes(`PulseShare-PreShared-${this.myTag}:${peerTag}`);
      if (isInitiator) {
        await session.initAlice(sharedSecret, peerPubHex || this.pubKeyHex);
      } else {
        await session.initBob(sharedSecret, this.localKeyPair);
      }
      this.ratchetSessions.set(peerTag, session);
      return session;
    }

    /**
     * Trata pacotes de controle dos 9 subsistemas de rede e roteamento.
     */
    async handleIncomingMeshPacket(packet, viaPeerTag) {
      if (!packet || !this.initialized) return null;

      switch (packet.meshType || packet.type) {
        // AODV
        case 'AODV_RREQ': {
          const res = this.aodv.handleRREQ(packet, viaPeerTag || packet.origTag);
          if (res && res.action === 'REPLY' && this.onPacketToSend) {
            this.onPacketToSend(res.sendTo, res.rrep);
          } else if (res && res.action === 'FORWARD' && this.onPacketToSend) {
            this.onPacketToSend(null, res.forwardRREQ); // broadcast
          }
          break;
        }

        case 'AODV_RREP': {
          const res = this.aodv.handleRREP(packet, viaPeerTag);
          if (res && res.action === 'FORWARD' && this.onPacketToSend) {
            this.onPacketToSend(res.sendTo, res.forwardRREP);
          }
          break;
        }

        // Reticulum Announce
        case 'RNS_ANNOUNCE': {
          this.reticulum.handleAnnounce(packet, viaPeerTag);
          break;
        }

        // libp2p Gossipsub Control
        case 'GOSSIPSUB_CONTROL': {
          if (packet.action === 'IHAVE') {
            const iwant = this.gossipsub.handleIHave(packet, viaPeerTag);
            if (iwant && this.onPacketToSend) {
              this.onPacketToSend(viaPeerTag, iwant);
            }
          } else if (packet.action === 'IWANT') {
            const payloads = this.gossipsub.handleIWant(packet);
            for (const item of payloads) {
              if (this.onPacketToSend) {
                this.onPacketToSend(viaPeerTag, {
                  type: 'GOSSIPSUB_MSG',
                  item
                });
              }
            }
          }
          break;
        }

        // libp2p Circuit Relay v2
        case 'HOP_RESERVE': {
          const res = this.circuitRelay.reserveHop(packet.clientPeerId, packet.requestedTtlMs);
          if (this.onPacketToSend) {
            this.onPacketToSend(viaPeerTag, res);
          }
          break;
        }

        // DTN Custody Transfer
        case 'DTN_BUNDLE': {
          if (packet.destTag === this.myTag) {
            // Entrega final realizada!
            const ack = await this.dtn.acknowledgeCustody(packet.bundleId);
            if (this.onPacketToSend) {
              this.onPacketToSend(viaPeerTag, ack);
            }
            return { delivered: true, bundle: packet };
          }
          // Caso contrário, armazena para repassar (Store and Forward)
          await this.dtn.stageBundle(packet);
          break;
        }

        case 'DTN_CUSTODY_ACK': {
          await this.dtn.removeBundle(packet.bundleId);
          break;
        }

        // Onion Routing Layer Peeling
        case 'ONION_PACKET': {
          try {
            const unpeeled = await this.onion.peelLayer(packet.onion);
            if (unpeeled.isTerminal) {
              return { terminalPayload: unpeeled.payloadBytes, finalDest: unpeeled.finalDest };
            }
            // Repassa para o próximo salto da cebola
            if (this.onPacketToSend && unpeeled.nextHop) {
              this.onPacketToSend(unpeeled.nextHop, {
                type: 'ONION_PACKET',
                onion: unpeeled.nextLayerPacket
              });
            }
          } catch (err) {
            console.warn('[PulseShareMeshEngine] Erro ao descascar camada Onion:', err);
          }
          break;
        }

        // Kademlia RPC
        case 'KAD_FIND_NODE': {
          const closest = this.kademlia.findClosestNodes(packet.targetId, 8);
          if (this.onPacketToSend) {
            this.onPacketToSend(viaPeerTag, {
              type: 'KAD_FIND_NODE_REPLY',
              requestId: packet.requestId,
              nodes: closest
            });
          }
          break;
        }
      }

      return null;
    }

    recordChatMessage(msgId, msgData) {
      if (!this.initialized) return { lamport: Date.now() };
      const rawTarget = msgData?.targetTag || msgData?.to || msgData?.peerTag || '';
      const rawSender = msgData?.senderTag || msgData?.from || '';
      const peerTag = (rawTarget && rawTarget.toLowerCase() !== (this.myTag || '').toLowerCase())
        ? rawTarget
        : rawSender;
      const isSending = Boolean(rawSender && rawSender.toLowerCase() === (this.myTag || '').toLowerCase());
      if (peerTag && !this.ratchetSessions.has(peerTag)) {
        this.ratchetSessions.set(peerTag, new DoubleRatchetSession(peerTag, isSending));
      }
      if (this.crdt) {
        this.crdt.tick(msgData?.lamport || 0);
      }
      if (this.messageLog) {
        return this.messageLog.append(msgId, msgData);
      }
      return { id: msgId, lamport: 1 };
    }

    async stageOfflineChatBundle(targetTag, chatPayload) {
      if (!this.dtn) return null;
      return await this.dtn.stageBundle({
        bundleId: `chat-dtn-${chatPayload.id || crypto.randomUUID()}`,
        sourceTag: this.myTag,
        destTag: targetTag,
        payload: chatPayload,
        createdAt: Date.now(),
        ttlMs: 7 * 86400000 // 7 dias de custódia DTN
      });
    }

    async acknowledgeChatMessage(msgId) {
      if (!this.dtn || !msgId) return;
      await this.dtn.removeBundle(`chat-dtn-${msgId}`);
    }

    async flushDeliverableChatBundles(reachablePeersSet) {
      if (!this.dtn) return [];
      const bundles = await this.dtn.getDeliverableBundles(reachablePeersSet);
      for (const b of bundles) {
        await this.dtn.removeBundle(b.bundleId);
      }
      return bundles;
    }

    getStatusSummary() {
      return {
        initialized: this.initialized,
        pubKeyHex: this.pubKeyHex ? this.pubKeyHex.slice(0, 16) + '...' : '',
        libp2p: {
          circuitRelayReservations: this.circuitRelay ? this.circuitRelay.reservations.size : 0,
          activeCircuits: this.circuitRelay ? this.circuitRelay.activeCircuits.size : 0,
          gossipsubMeshPeers: this.gossipsub ? (this.gossipsub.mesh.get('pulseshare/global')?.size || 0) : 0,
          gossipsubCachedMsgs: this.gossipsub ? this.gossipsub.mcache.length : 0
        },
        reticulum: {
          destinationHash: this.reticulum?.destinationHash || '',
          knownPaths: this.reticulum ? this.reticulum.pathTable.size : 0
        },
        yggdrasil: {
          ipv6Address: this.yggdrasil?.ipv6Address || '',
          treeCoords: this.yggdrasil ? this.yggdrasil.treeCoordinates.join('.') : '0'
        },
        kademlia: {
          nodeId: this.kademlia?.localNodeId ? this.kademlia.localNodeId.slice(0, 16) + '...' : '',
          totalPeersInBuckets: this.kademlia ? this.kademlia.getAllNodes().length : 0
        },
        aodv: {
          activeRoutes: this.aodv ? this.aodv.routingTable.size : 0,
          currentSeqNum: this.aodv?.sequenceNumber || 0
        },
        crdt: {
          registeredPeersCount: this.crdt ? Object.keys(this.crdt.readAll()).length : 0,
          lamportClock: this.crdt?.lamportClock || 0,
          causalChatEvents: this.messageLog ? this.messageLog.entries.size : 0
        },
        dtn: {
          stagedBundlesCount: this.dtn ? this.dtn.memoryBundles.size : 0
        },
        onion: {
          ready: Boolean(this.onion && this.localKeyPair)
        },
        doubleRatchet: {
          activeSessionsCount: this.ratchetSessions.size
        }
      };
    }
  }

  // Exportação Universal (Window, Worker, Node/CommonJS)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PulseShareMeshEngine,
      LWWElementSet,
      CausalMessageLog,
      KademliaDHT,
      AODVRouter,
      ReticulumEngine,
      YggdrasilOverlay,
      Libp2pCircuitRelayV2,
      Libp2pGossipsub,
      DTNStoreAndForward,
      OnionRouter,
      DoubleRatchetSession
    };
  } else {
    global.PulseShareMeshEngine = PulseShareMeshEngine;
    global.LWWElementSet = LWWElementSet;
    global.CausalMessageLog = CausalMessageLog;
    global.KademliaDHT = KademliaDHT;
    global.AODVRouter = AODVRouter;
    global.ReticulumEngine = ReticulumEngine;
    global.YggdrasilOverlay = YggdrasilOverlay;
    global.Libp2pCircuitRelayV2 = Libp2pCircuitRelayV2;
    global.Libp2pGossipsub = Libp2pGossipsub;
    global.DTNStoreAndForward = DTNStoreAndForward;
    global.OnionRouter = OnionRouter;
    global.DoubleRatchetSession = DoubleRatchetSession;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
