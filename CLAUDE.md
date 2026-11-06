# PulseShare — Guia de Referência do Projeto (para o Claude)

> Mapa do código para continuar o desenvolvimento sem varrer o repositório inteiro.
> Gerado em 2026-11-01, atualizado em 2026-11-06 (pré-visualização de mídia no chat do app, visualizador de imagem com zoom, opção .zip no link, remoção do "Enviar para" da tela inicial). **Atualize este arquivo quando mudar arquitetura, protocolos ou a estrutura de arquivos.**
> Idioma do projeto: português (UI, comentários, commits). Responder ao usuário em português.

## 1. O que é

Rede social / mensageiro + transferência de arquivos **100% serverless P2P**:
- Sinalização via **MQTT 3.1.1 binário sobre WebSocket** em brokers públicos (todos publicam/assinam um único tópico global).
- Dados via **WebRTC DataChannel** (STUN Google/Cloudflare; TURN opcional configurável).
- Identidade `@nome_hash6` derivada de 7 palavras mnemônicas (estilo Nostr).
- Três clientes que compartilham a mesma malha: **Extensão Chrome MV3**, **App Android (WebView + Kotlin)** e **Portal web de download** (GitHub Pages).

Sem build JS, sem npm, sem framework: JS puro (IIFE / scripts globais), Tailwind pré-compilado em `tailwind.css`, `fflate.min.js` para ZIP.

## 2. Mapa de arquivos

| Caminho | Linhas | Papel |
|---|---|---|
| `app.js` | ~3000 | **Núcleo do app Android/web chat-first** (UI + MQTT + WebRTC + chat + links públicos). Roda na WebView. |
| `app.html` | ~800 | UI do app (chat-first, abas, modais). Carrega crypto → mesh → fflate → app.js. **No Android vira `assets/www/index.html`** |
| `index.html` | ~2500 | **Portal público do link** (`#share=`): abas 📥 Download + 💬 Chat temporário com o dono do link. Script inline |
| `404.html` | | Cópia idêntica de `index.html` (fallback do GitHub Pages) |
| `pulseshare-crypto-identity.js` | ~460 | `window.PulseShareCrypto`: mnemônico, derivação, PIN/2FA, perfis, contatos, identicon, QR |
| `pulseshare-mesh-engine.js` | ~1775 | `PulseShareMeshEngine` + CRDT, Kademlia, AODV, Reticulum, Yggdrasil, libp2p relay/gossipsub, DTN, Onion, Double Ratchet |
| `pulseshare-media-viewer.js` | ~330 | `window.PulseShareImageViewer`: visualizador de imagem com zoom (pinça/roda/duplo toque) e arraste. `open({src,title,meta,actions})` (tela cheia, app) e `attach(stage, src)` + `buildZoomBar` (lightbox da extensão) |
| `fflate.min.js`, `tailwind.css` | — | libs vendorizadas |
| `extension/` | | Extensão Chrome MV3 (ver §5) |
| `android/` | | Projeto Gradle Kotlin (ver §6) |
| `PulseShare.apk` | 3 MB | APK compilado commitado na raiz |
| `test_chat_media_e2e.mjs`, `test_p2p_real_e2e.mjs` | | Scripts Node que simulam um peer via MQTT real (`node arquivo.mjs`) |
| `.github/workflows/deploy-pages.yml` | | Publica **a raiz inteira (`.`)** no GitHub Pages a cada push em `main` |

### ⚠️ Arquivos DUPLICADOS (cópia manual, sem script de sync)
Ao editar um, **copie para os outros** (hoje estão idênticos byte a byte):
- `app.js`, `pulseshare-crypto-identity.js`, `pulseshare-mesh-engine.js`, `pulseshare-media-viewer.js`, `fflate.min.js`, `tailwind.css` → raiz **e** `android/app/src/main/assets/www/`
- `app.html` (raiz) → `android/app/src/main/assets/www/index.html` (**nome diferente!**)
- `index.html` (portal) → `404.html`
- `pulseshare-crypto-identity.js`, `pulseshare-mesh-engine.js`, `pulseshare-media-viewer.js`, `fflate.min.js`, `tailwind.css` → também em `extension/`
  - ⚠️ `extension/tailwind.css` **já diverge** da raiz (tem regras extras do chat da extensão: layout responsivo, progresso de mídia, utilitárias que faltavam). Não copie a raiz por cima; adicione classes novas no fim do arquivo certo (o Tailwind é pré-compilado — classe que não está no CSS simplesmente não funciona).
- portal (`index.html`) ≈ `extension/receiver.html` + `extension/receiver.js` (lógica equivalente, divergem; o receiver da extensão NÃO tem o chat temporário)

Comando de sync sugerido:
```bash
for f in app.js pulseshare-crypto-identity.js pulseshare-mesh-engine.js pulseshare-media-viewer.js fflate.min.js tailwind.css; do cp $f android/app/src/main/assets/www/; done
cp app.html android/app/src/main/assets/www/index.html
cp index.html 404.html
for f in pulseshare-crypto-identity.js pulseshare-mesh-engine.js pulseshare-media-viewer.js fflate.min.js; do cp $f extension/; done  # tailwind.css da extensão diverge
```

## 3. Protocolo de rede (comum a todos os clientes)

- Brokers: `wss://broker.hivemq.com:8884/mqtt`, `wss://broker.emqx.io:8084/mqtt`, `wss://test.mosquitto.org:8081/mqtt` (a extensão `background.js` usa só os 2 primeiros).
- Tópico único: **`pulseshare/v2/p2p_mesh_global`**. Todo mundo recebe tudo; filtragem por `to`.
- Cliente MQTT é implementado à mão (CONNECT/SUBSCRIBE/PUBLISH) em cada arquivo — funções `encodeRemainingLength`, `encodeUTF8String`, `buildMqttPublishPacket`.
- Pacote JSON publicado (envelope adicionado por `broadcastToMesh`):
  `{ meshType, pktId, packetId, senderNodeId, senderTag, timestamp, ...campos }`
  Deduplicação por `pktId` em `seenPacketIds` (limite 2000).

### `meshType`
| meshType | Quem envia | Observação |
|---|---|---|
| `DIRECT_SIGNAL` | todos | `{to, transferId, signalType, payload}` — sinal ponto a ponto |
| `PRESENCE_ANNOUNCE` | **App** (`app.js` a cada 15 s) | `{tag, reghash, nodeId, avatar, clientType:'android', relayMode}` — a extensão também trata (merge no roster) |
| `PEER_ANNOUNCE` / `ROSTER_GOSSIP_SYNC` | **Extensão** | `{roster:[...]}` gossip do catálogo de peers — o app também trata (`mergeRosterIntoRegistry`) |
| `PROBE_USER_EXISTS` / `_REPLY`, `USER_REGISTERED`, `USER_CONFLICT_ALERT` | Extensão | registro/unicidade de `@usuario` |

> Presença é interoperável desde 2026-11-05 (antes app e extensão não se viam). Visitantes do portal usam tag `@link_xxxxxx` e são ignorados nos rosters.

### `signalType` (dentro de `DIRECT_SIGNAL`)
- **Transferência:** `FILE_OFFER` → `FILE_ACCEPT` (receptor) → `WEBRTC_OFFER` (remetente) → `WEBRTC_ANSWER` → `ICE_CANDIDATE`… ; `FILE_REJECT`, `TRANSFER_REJECT`.
- **Chat:** `CHAT_MESSAGE`, `CHAT_ACK` (`{msgId,status:'DELIVERED'|'READ',mediaReady?}`), `CHAT_READ`, `CHAT_TYPING`, `CHAT_REACTION` — implementados na extensão, no app e no portal. Quem recebe `CHAT_MESSAGE` responde `CHAT_ACK`; app/portal reenviam até 3x sem ACK (destino deduplica por `id`).
- **Mídia de chat:** `transferId` sempre com prefixo **`chatmedia-`** (hífen! o offscreen da extensão usa esse prefixo para guardar a mídia em vez de baixar). Fluxo: `CHAT_MESSAGE` (com `transferId`+`fileMeta`+`media`) + `FILE_OFFER {isChatMedia}` → receptor aceita (`FILE_ACCEPT`) → WebRTC. A extensão aceita mídia de chat automaticamente e pode mandar **dois** `FILE_ACCEPT` (um do CHAT_MESSAGE e outro do FILE_OFFER): o remetente deve ignorar o duplicado.
- **Relay mesh:** `MESH_RELAY_REQUEST/ACCEPTED/REJECT/CHUNK/DATA` (extensão). `MESH_RELAY_CHUNK` = `{chunkSeq (1..N), totalChunks, chunkBase64 (12 KB), isEof, totalBytes, fileMeta}` — o app envia (link via `TUNNEL_RELAY_PULL`) e recebe. Regra: **só aceitar dados de transferência que o usuário aceitou** (sem push não solicitado).
- **Link público:** `PACK_INFO_REQUEST` → `PACK_INFO_RESPONSE`, `PACK_FILE_PULL`/`PUBLIC_LINK_PULL` (transferId `${shareId}_${fileId}_NNNN`), `PACK_DOWNLOAD_COMPLETE`, `TUNNEL_RELAY_PULL` (portal cai para relay se o DataChannel não abrir em 9 s). Servido pela extensão **e pelo app** (`publicShares` em `app.js`, só enquanto o app estiver aberto). Senha: `passwordHash = sha256(senha + passwordSalt)` verificado no portal. `PACK_INFO_RESPONSE.allowZip` (ausente = true): portal/receiver têm **um único botão Baixar**; se `allowZip`, ao clicar oferece "Compactado (.zip)" ou "Arquivos separados", senão baixa separado. O remetente escolhe no modal do link (`input-link-allow-zip` no app, `modal-allow-zip` na extensão).

### DataChannel (`pulseshare-file-channel`, ordered)
Mensagens JSON de controle + frames binários de **16 KB**:
`{type:'FILE_START', ...}` → chunks `ArrayBuffer` → `{type:'EOF'}`. `{type:'CHAT_DIRECT', payload}` para chat via canal direto aberto.
Backpressure: `waitForBufferDrain` (`bufferedAmount`).

### Formato de mensagem de chat
Android (mínimo): `{id, senderTag, text, timestamp, transferId?, media?/fileMeta?}` com `media = {name,fileName,size,fileSize,type,fileType,transferId}` (campos duplicados de propósito para compatibilidade com a extensão).
Extensão (rico): adiciona `msgType/type`, `direction`, `forwarded`, `replyTo`, `reactions`, `voiceDuration`, `waveform`, `mediaStatus`, `roster`.

## 4. App Android / Web — `app.js` (IIFE, seções numeradas no código)

| § | Linha ~ | Conteúdo |
|---|---|---|
| 1 | 10 | `PUBLIC_WSS_BROKERS`, `MESH_TOPIC`, `DEFAULT_ICE_SERVERS` |
| 2 | 26 | Estado global: `nodeId`, `myTag`, `peerRegistry`, `peerTransports` (`LAN`/`BLE`/`P2P`), `directDataChannels`, `blePeers`, `transfers`, `publicShares`, `chatMessages`, `activePeerConnections`, helpers `normalizeTag/formatBytes/formatTime` |
| 3 | 112 | Objeto **`Native`** (wrapper de `window.PulseShareNative` com fallback web) e **`window.PulseShareNativeCallback`** (`onFilesPicked`, `onSharedFilesReceived`, `onBleMessageReceived`, `onBlePeersUpdated`, `onBackPressed` → retorna `'HANDLED'`/`'EXIT'`) |
| 4 | 314 | Identidade: `initCryptoIdentity`, `updateIdentityUI`, `renderIdentityModal` |
| 5 | ~453 | MQTT: `broadcastToMesh`, `sendSignal`, `connectSingleBroker`/`connectBrokers` (reconexão por broker + PINGREQ), `handleIncomingMqttBytes(ws, bytes)` (buffer por socket, vários pacotes por frame), `announcePresence`, `handleIncomingPacket`, `mergeRosterIntoRegistry`, BLE |
| 6 | ~800 | `handleDirectSignal` (switch de todos os signalType), `setTransferStatus`/`updateTransferProgress`, `acceptIncomingTransfer`, `readFileSlice` (Blob / URI SAF / base64), helpers |
| 7 | ~1100 | `startSenderWebRTC(tid, target, opts)` (ignora FILE_ACCEPT duplicado), `finishSend`, `createReceiveSink` (Android: `saveChunk` em blocos de 256 KB; web: Blob), `startReceiverWebRTC` (ignora offer não aceita), fila `pendingIce` |
| 7b | ~1500 | Link público do app: `createPublicShare`, `handlePackInfoRequest`, `handlePackFilePull`, `startRelaySend`, `handleRelayChunk`, `renderShares`, `window.psShareAction` |
| 8a | ~1750 | Mídia do chat: `chatMediaKind`, IndexedDB, `setChatMediaBlob`/`getChatMediaUrl`, `captureOutgoingChatMedia`, `saveChatMediaToDisk`, `window.psOpenChatImage/psSaveChatMedia` |
| 8 | ~2000 | Chat: `handleIncomingChatMessage` (envia CHAT_ACK), `sendChatMessage` (BLE + MQTT; **sem** atalho CHAT_DIRECT), `scheduleChatRetry`, `sendChatMessageWithMedia`, `queueOutgoingFile`, `window.downloadChatMedia/cancelTransfer/acceptTransfer`, `renderChatMessages` (ticks ✓/✓✓/azul) |
| 9 | 1734 | Busca global de usuários (`openGlobalSearchModal`, `renderGlobalSearchResults`) |
| 10 | 1840 | Menu do contato (salvar, listas/categorias, excluir conversa) |
| 11 | 1897 | Transferências: `handleFilesSelected`, `handleAndroidSharedItems`, `renderStagedFiles`, `renderTransfers` |
| 12 | 1999 | Abas: `currentTab` (padrão `'chat'`), `switchTab`, `updateHeaderStatus`, `renderMeshPeers`, `openSendModal('p2p'|'link')` |
| 13 | 2092 | `initEvents()` (todos os `onclick` por id) + `DOMContentLoaded` → `initCryptoIdentity → initEvents → connectBrokers → switchTab('chat')` |

**Regras de download:** foto/vídeo/áudio do chat ≤ 16 MB (`CHAT_PREVIEW_AUTO_MAX`) é aceito sozinho **só para pré-visualizar**: fica na memória + IndexedDB `PulseShareChatMedia/media` (chave = transferId, até 64 MB `CHAT_PREVIEW_KEEP_MAX`) e só vai para Download/ ao tocar em Salvar (`psSaveChatMedia`) ou com `ps_chat_auto_download === 'true'`. Demais arquivos do chat só baixam com auto-download ou clique; fora do chat segue `ps_auto_accept` (padrão true). O remetente guarda a própria mídia enviada (`captureOutgoingChatMedia`). `renderChatMessages` atualiza só as bolhas que mudaram (diff por `data-mid`) para vídeo/áudio não reiniciarem; foto abre em `psOpenChatImage` (visualizador com zoom; o botão voltar fecha).

**IDs principais em `app.html`:** views `view-chat|home|transfers|shares|mesh`; nav `nav-*`; chat `chat-list-pane`, `chat-active-conversation-pane` (classe `active` = aberto), `chat-messages-container`, `chat-conversations-list`, `chat-categories-bar`, `input-chat-text`, `btn-chat-send`, `btn-chat-attach`; modais `modal-send`, `modal-settings`, `modal-global-search`, `modal-identity-profile`, `modal-qr-pair-scanner`, `modal-contact-menu`, `modal-add-category-list` (mostrar/ocultar com a classe `hidden`). Ao criar modal novo, adicioná-lo também em `onBackPressed`.

**localStorage (app):** `ps_node_id`, `ps_my_tag`, `ps_my_reghash`, `ps_auto_accept`, `ps_chat_auto_download`, `ps_download_folder`, `ps_mesh_relay`, `ps_relay_bw`, `ps_turn_config`, `ps_chat_messages`, `ps_custom_categories`; crypto: `ps_profiles_v2`, `ps_active_profile_id_v2`, `ps_contacts_catalog_v2`.

**Depuração:** `window.__psDebug()` devolve `{myTag, transfers, peerRegistry, publicShares, chatMessages}`; `window.__psTrace = true` loga cada sinal recebido.

**Observação:** `app.js` instancia `PulseShareMeshEngine` mas **não chama `init()`** — os algoritmos avançados (DTN, ratchet etc.) não estão ativos no Android.

## 5. Extensão Chrome MV3 — `extension/`

Arquitetura: **popup (UI) ↔ service worker (`background.js`, estado + MQTT) ↔ offscreen document (`offscreen.js`, WebRTC)**. Service worker não tem WebRTC, por isso o offscreen.

| Arquivo | Linhas | Papel |
|---|---|---|
| `manifest.json` | | v3.0.0; perms `storage, downloads, notifications, offscreen`; host perms para os brokers |
| `background.js` | ~3440 | Estado `state` (persistido em `chrome.storage.local`), MQTT multi-broker, registro de usuário, gossip, relay multi-hop/failover, roteador de mensagens. Seções: 1 janela persistente (233), 2 link público (414), 3 MQTT (514), 4 malha/gossip/relay (636–1415, `handleMeshPacket` 1209), 5 offscreen/estado (1423, `broadcastState`, `updateTransfer`), 6 negociação (`sendSignal` 1674, `handleIncomingSignal` 1769), 7 roteador `chrome.runtime.onMessage` (2507), 8 init (3289) |
| `offscreen.js` | ~1435 | WebRTC sender/receiver (`startSenderWebRTC` 909, `startReceiverWebRTC` 1242), relay stream, IndexedDB `PulseShareDB/staged_files`, chunk 16 KB / leitura 1 MB |
| `popup.html` / `popup.js` | 1550 / ~6280 | UI completa. Abas `nav-btn-chat|home|transfers|shares|mesh`. Chat completo (voz, emojis, reações, encaminhamento, lightbox) a partir da linha ~4337 |
| `receiver.html/js` | | Receptor de link embutido na extensão (equivalente ao portal `index.html`) |

**Mensagens popup → background (`msg.type`):** `GET_STATE`, `SET_MY_TAG`, `REGISTER_USER`, `START_SEND_FILE`, `START_PUBLIC_LINK_SHARE`, `RESPOND_INCOMING`, `PAUSE/RESUME/CANCEL/DELETE_TRANSFER`, `SEND_CHAT_MESSAGE`, `SEND_CHAT_TYPING`, `SEND_CHAT_REACTION`, `MARK_CHAT_READ`, `DOWNLOAD_CHAT_MEDIA`, `DELETE_CHAT_MESSAGES`, `CLEAR_CHAT_CONVERSATION`, `TOGGLE_*`, `SET_RELAY_BANDWIDTH_LIMIT`, `DELETE_PEER`, `CLEAR_*`, `*_STAGED_TUNNEL_FILE(S)`, `GET_MESH_ENGINE_SUMMARY`, `ENSURE_OFFSCREEN`.
**background ↔ offscreen (`action`):** `OFFSCREEN_SIGNAL`, `OFFSCREEN_CONTROL`, `OFFSCREEN_SET_TURN_CONFIG`, `OFFSCREEN_DOWNLOAD_CHAT_MEDIA`, `OFFSCREEN_RECEIVE_RELAY_CHUNK`, `START_MESH_RELAY_STREAM`, `STAGE_FILE_MEMORY`, `REVOKE_BLOB_URL`, `STATE_UPDATED`.
Arquivos grandes passam do popup ao offscreen por `BroadcastChannel('pulseshare_file_bridge')` + IndexedDB.
Na extensão o `meshEngine.init()` **é** chamado (DTN de chat, CRDT, Kademlia ativos).

**Mídia do chat na extensão (desde 2026-11-05):**
- Receptor só aceita sozinho imagem/áudio/voz/vídeo ≤ 16 MB (`isAutoPreviewChatMedia` em `background.js`, ficam só na memória/IndexedDB para pré-visualizar). Demais arquivos ficam `AWAITING_ACCEPT` com botão **Baixar**.
- Clique em Baixar → `DOWNLOAD_CHAT_MEDIA` → marca `saveToDisk:true`, envia `FILE_ACCEPT` (ou, se o arquivo já é local, pede ao offscreen) → ao concluir `OFFSCREEN_CHAT_MEDIA_READY` → `OFFSCREEN_DOWNLOAD_CHAT_MEDIA` → `chrome.downloads` em `PulseShare/` e grava `downloadId`. A bolha mostra progresso → 📂 (mostrar na pasta) / Abrir; a transferência aparece em Transferências (filtro `isTransferVisibleInList`). O offscreen **não** salva mais mídia de chat em disco por conta própria.
- `FILE_ACCEPT` de mídia de chat sai no máximo 1× a cada 20 s (`acceptChatMediaOnce`); o offscreen não reinicia um WebRTC já aberto ao receber `FILE_ACCEPT`/`WEBRTC_OFFER` duplicado. Fallback para relay após aceite: 15 s (chat) / 8 s (demais).
- `broadcastState()` tem throttle (250 ms) e persistência no storage a cada 1,5 s (`flushBroadcastState` força imediato).
- Popup: `renderActiveChatConversation` compara uma assinatura (`buildChatRenderSignature`) e, se só mudou progresso, atualiza as barras no lugar (`updateChatMediaProgressInPlace`); blob URLs são cacheados (`getChatMediaBlobUrl`) e recarregados do IndexedDB ao reabrir o popup.
- Lightbox de imagem usa `PulseShareImageViewer.attach` (zoom/arraste, teclas Esc/+/−/0).
- Tela inicial: o botão "Enviar para Usuário" (`btn-send`) está oculto (envio direto é pelo chat); a área de arrastar abre o modal de link.
- Layout do chat: abaixo de 760 px de largura (ou no popup) mostra só a lista OU a conversa (classe `chat-mobile-hidden`, botão ← volta e fecha a conversa); acima disso, lado a lado.

Link público gerado: `https://ricardoazt.github.io/share/#share=<id>&owner=@tag&exp=<ts>` (base configurável; `DEFAULT_PORTAL_URL` em `popup.js`).

## 6. Android nativo — `android/` (pacote `com.ricardo.pulseshare`)

- minSdk 24, target/compile 36, Java/Kotlin 17, só AndroidX core/activity/lifecycle. Release assinado com chave **debug**.
- `MainActivity.kt`: WebView carregando `file:///android_asset/www/index.html`, interface JS `PulseShareNative`, permissões (câmera, BLE, localização, notificação), intents `SEND`/`SEND_MULTIPLE`/`VIEW`, back → `PulseShareNativeCallback.onBackPressed()`, `evaluateJs()` para chamar callbacks.
- `PulseShareBridge.kt`: métodos `@JavascriptInterface` — `openUrl` (abre link do portal no navegador), `pickFiles`, `getPendingSharedFiles`, `readFileBase64`, `readUriChunkBase64`, `saveFile`, `saveChunk(id,name,b64,isFirst,isLast,mime)`, `cancelTransfer`, `get/setDownloadDirectory`, `openDownloadFolder`, `openDownloadedFile`, `shareDownloadedFile`, `shareText`, `copyToClipboard`, `showToast`, `showNotification`, `start/stopKeepAlive`, `isBleAvailable`, `start/stopBleMesh`, `getNearbyBlePeers`, `sendBleMessage`.
  **Para nova função nativa:** adicionar aqui + wrapper no objeto `Native` em `app.js` (com fallback web).
- `FileHelper.kt`: grava em `Download/<pasta>` (padrão `PulseShare`), streaming de chunks, MediaScanner, FileProvider.
- `BluetoothMeshHelper.kt`: BLE GATT server + advertising + scan; service UUID `0000fe55-…`, characteristic `0000fe56-…`.
- `PulseShareService.kt`: foreground service (dataSync) com WakeLock/WifiLock. `NotificationHelper.kt`: canais e notificações.
- Build (JDK 21 em `/usr/lib/jvm/java-21-openjdk-amd64` — `~/.local/jdk` não existe mais; SDK em `~/Android/Sdk`): `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk ./gradlew assembleRelease --offline -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease` (o lint não está no cache offline) → `app/build/outputs/apk/release/app-release.apk` (copiar para `PulseShare.apk` na raiz se for publicar).

## 7. Portal público — `index.html` (cópia em `404.html`)

Página standalone (script inline, sem `app.js`) que lê `#share=&owner=&exp=&turn=&turn_u=&turn_p=` do hash/query, conecta aos brokers, envia `PACK_INFO_REQUEST`, trata senha, lista arquivos (árvore de pastas), baixa via WebRTC (`PACK_FILE_PULL`) ou relay (`TUNNEL_RELAY_PULL`) e gera ZIP com fflate.

- Tag do visitante: `@link_<6 hex>` (nova a cada abertura). `handleIncomingPacket` chama primeiro `handleChatPacket(pkt)`; o que não for do chat segue para a área de download.
- **Chat temporário** (fim do script): abas `#tab-btn-download` / `#tab-btn-chat`, painéis `#panel-download` / `#panel-chat`. Só conversa com `ownerTag`. Texto + arquivos nos dois sentidos (upload: `startChatUpload`; download: `acceptChatMedia` → `startChatDownload`). Histórico só em memória (aviso `beforeunload`).
- No dono, a conversa aparece como `@link_…` ("🔗 Visitante do link" no popup / app).

> Histórico: no commit `5e7ddd1` o `index.html` raiz tinha sido trocado pela UI do app, quebrando todos os links públicos. Corrigido: UI do app → `app.html`, portal → `index.html`.

## 8. Problemas conhecidos / dívidas técnicas

1. `app.js` cria `PulseShareMeshEngine` mas não chama `init()` (DTN/ratchet inativos no app).
2. O app não atua como nó relay (`MESH_RELAY_REQUEST`) e não tem pausa/retomada iniciada pelo usuário.
3. Link público do app só funciona com o app aberto (WebView em primeiro plano / keep-alive).
4. `chatMessages` inteiro serializado no localStorage a cada mensagem (limite ~5 MB).
5. Arquivos duplicados sem sync automático (§2); APK binário commitado.
6. Sem testes unitários. E2E manuais com Chrome+puppeteer (ver §10).
7. `extension/receiver.html/js` (receptor interno) não tem o chat temporário do portal.

## 9. Checklist ao fazer alterações

- Mudou JS/HTML compartilhado? → sincronizar cópias (§2).
- Mudou protocolo (meshType/signalType/campos)? → atualizar **app.js, background.js/offscreen.js, index.html (portal) e receiver.js** e a tabela §3 deste arquivo.
- Mudou ponte nativa? → `PulseShareBridge.kt` + `Native` em `app.js`.
- Novo modal no app → registrar em `onBackPressed`.
- Teste rápido de protocolo: `node test_chat_media_e2e.mjs` / `node test_p2p_real_e2e.mjs` (usam brokers públicos reais; o segundo tem um `@tag` de dispositivo fixo no código).
- Commits em português no estilo `feat(escopo): …` / `fix: …`.
- Ao concluir mudanças estruturais, **atualizar este CLAUDE.md**.

## 10. Testes E2E (como foram feitos em 2026-11-05)

Chrome real (`/usr/bin/google-chrome`) via `puppeteer-core` com a extensão carregada (`enableExtensions`, `pipe: true`), servindo uma **cópia** do projeto com o tópico MQTT trocado para um tópico de teste (nunca testar no tópico global real — nós reais do usuário, ex. `@flo_ricardo`, participam como relay). Cenários cobertos: chat texto+mídia ext↔ext, app↔ext, app↔app; envio direto ext→ext; link da extensão e do app → portal (download, ZIP, relay forçado) e chat temporário com arquivos nos dois sentidos. Para comandar o popup: `chrome.runtime.sendMessage({action: ...})` e funções globais do `popup.js` (`openChatConversation`, `addChatStagedAttachment`, `sendChatMessage`, `saveStagedFile`).
