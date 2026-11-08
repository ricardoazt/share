# PulseShare — Guia de Referência do Projeto (para o Claude)

> Mapa do código para continuar o desenvolvimento sem varrer o repositório inteiro.
> Gerado em 2026-11-01, atualizado em 2026-11-07 (5ª rodada: várias contas no aparelho, busca por nome, reenvio de mensagens pendentes; 4ª rodada: ícone do PulseShare em todo lugar — app Android, notificações, favicons; 3ª rodada: catálogo de nomes — o nome é único na rede; 2ª rodada: **a extensão passou a rodar o mesmo app do celular**, tela de entrada com chave de acesso/QR/.txt, QR real, foto de perfil com editor, notificações com som/vibração e segundo plano). **Atualize este arquivo quando mudar arquitetura, protocolos ou a estrutura de arquivos.**
> Idioma do projeto: português (UI, comentários, commits). Responder ao usuário em português.

## 1. O que é

Rede social / mensageiro + transferência de arquivos **100% serverless P2P**:
- Sinalização via **MQTT 3.1.1 binário sobre WebSocket** em brokers públicos (todos publicam/assinam um único tópico global).
- Dados via **WebRTC DataChannel** (STUN Google/Cloudflare; TURN opcional configurável).
- Identidade `@nome_hash6` derivada de 7 palavras mnemônicas (estilo Nostr).
- **Um único app** (`app.html` + `app.js`) roda em três lugares com a mesma aparência e funções: **App Android** (WebView + Kotlin), **Extensão Chrome MV3** (janela + documento de fundo) e navegador. Diferenças só onde a plataforma exige (câmera/leitor de QR, Bluetooth, vibração, pasta de downloads: só Android → classe `android-only`). Além dele, o **Portal web de download** (GitHub Pages) para links públicos.

Sem build JS, sem npm, sem framework: JS puro (IIFE / scripts globais), Tailwind pré-compilado em `tailwind.css`, `fflate.min.js` para ZIP, `qrcode-core.js` (gerador de QR, núcleo do pacote `qrcode` 1.5.4 MIT empacotado → `window.PulseShareQR`) e `jsQR.js` (leitor de QR 1.4.0 Apache-2.0, carregado sob demanda só ao abrir a câmera).

## 2. Mapa de arquivos

| Caminho | Linhas | Papel |
|---|---|---|
| `app.js` | ~4500 | **O app** (UI + MQTT + WebRTC + chat + links públicos + conta + notificações). Roda na WebView do Android, na extensão e no navegador. Flags `IS_ANDROID`, `IS_EXTENSION`, `IS_BACKGROUND_PAGE` (`?bg=1`) |
| `app.html` | ~1000 | UI do app (chat-first, abas, modais, tela de entrada, editor de foto). Carrega qrcode-core → crypto → mesh → fflate → media-viewer → app.js. **No Android vira `assets/www/index.html`**; na extensão é `extension/app.html`. **Sem `onclick` inline** (CSP da extensão): botões gerados usam `data-ps-call`/`data-ps-args` |
| `index.html` | ~2500 | **Portal público do link** (`#share=`): abas 📥 Download + 💬 Chat temporário com o dono do link. Script inline |
| `404.html` | | Cópia idêntica de `index.html` (fallback do GitHub Pages) |
| `pulseshare-crypto-identity.js` | ~470 | `window.PulseShareCrypto`: mnemônico, derivação, PIN/2FA, perfis, contatos, identicon, `generateQRCodeSVG` (QR real via `PulseShareQR`), **chave de acesso** `wordsToAccessKey`/`accessKeyToWords`, `isValidMnemonic` |
| `qrcode-core.js`, `jsQR.js` | — | gerador e leitor de QR vendorizados |
| `sounds/*.wav` | — | 5 sons de notificação sintetizados (pulso, sino, bipe, marimba, alerta); cópias em `extension/sounds/`, `assets/www/sounds/` e `android/.../res/raw/ps_*.wav` |
| `icons/` | — | **Ícone do PulseShare** (raio branco em degradê índigo→laranja). Tudo sai de `icons/gen_icons.py` (`python3 icons/gen_icons.py`, Pillow): `icon.svg`, `icon{16,32,48,128,192,512}.png`, cópia em `extension/icons/`, e no Android `drawable/ic_launcher_{background,foreground}.xml` (ícone adaptativo/temático), `drawable/ic_stat_pulseshare.xml` (ícone pequeno das notificações) e `mipmap-*/ic_launcher{,_round}.webp`. Para mudar o ícone, edite o script e rode de novo. `app.html` (favicon, logo do cabeçalho e da tela de entrada) e o portal `index.html` (favicon) trazem o SVG embutido (data URI / `<svg>` inline), então mudar o desenho exige atualizar esses trechos também |
| `pulseshare-mesh-engine.js` | ~1775 | `PulseShareMeshEngine` + CRDT, Kademlia, AODV, Reticulum, Yggdrasil, libp2p relay/gossipsub, DTN, Onion, Double Ratchet |
| `pulseshare-media-viewer.js` | ~330 | `window.PulseShareImageViewer`: visualizador de imagem com zoom (pinça/roda/duplo toque) e arraste. `open({src,title,meta,actions})` |
| `fflate.min.js`, `tailwind.css` | — | libs vendorizadas |
| `extension/` | | Extensão Chrome MV3 (ver §5) |
| `android/` | | Projeto Gradle Kotlin (ver §6) |
| `PulseShare.apk` | 3 MB | APK compilado commitado na raiz |
| `test_chat_media_e2e.mjs`, `test_p2p_real_e2e.mjs` | | Scripts Node que simulam um peer via MQTT real (`node arquivo.mjs`) |
| `.github/workflows/deploy-pages.yml` | | Publica **a raiz inteira (`.`)** no GitHub Pages a cada push em `main` |

### ⚠️ Arquivos DUPLICADOS (cópia manual, sem script de sync)
Ao editar um, **copie para os outros** (hoje estão idênticos byte a byte):
- `app.js`, `qrcode-core.js`, `jsQR.js`, `pulseshare-crypto-identity.js`, `pulseshare-mesh-engine.js`, `pulseshare-media-viewer.js`, `fflate.min.js`, `tailwind.css`, `sounds/` → raiz, `android/app/src/main/assets/www/` **e** `extension/`
- `app.html` (raiz) → `android/app/src/main/assets/www/index.html` (**nome diferente!**) e `extension/app.html`
- `index.html` (portal) → `404.html`
- `sounds/*.wav` → também `android/app/src/main/res/raw/ps_<nome>.wav`; `icons/` → `extension/icons/` (feito pelo `icons/gen_icons.py`)
- `tailwind.css` é **pré-compilado**: classe que não está nele não funciona. Utilitárias novas vão no fim do arquivo (há blocos "adicionadas manualmente").

Comando de sync:
```bash
for d in android/app/src/main/assets/www extension; do for f in app.js qrcode-core.js jsQR.js pulseshare-crypto-identity.js pulseshare-mesh-engine.js pulseshare-media-viewer.js fflate.min.js tailwind.css; do cp $f $d/; done; mkdir -p $d/sounds; cp sounds/*.wav $d/sounds/; done
cp app.html android/app/src/main/assets/www/index.html; cp app.html extension/app.html
cp index.html 404.html; cp icons/*.png icons/icon.svg extension/icons/
```

## 3. Protocolo de rede (comum a todos os clientes)

- Brokers: `wss://broker.hivemq.com:8884/mqtt`, `wss://broker.emqx.io:8084/mqtt`, `wss://test.mosquitto.org:8081/mqtt` .
- Tópico único: **`pulseshare/v2/p2p_mesh_global`**. Todo mundo recebe tudo; filtragem por `to`.
- Cliente MQTT é implementado à mão (CONNECT/SUBSCRIBE/PUBLISH) em cada arquivo — funções `encodeRemainingLength`, `encodeUTF8String`, `buildMqttPublishPacket`.
- Pacote JSON publicado (envelope adicionado por `broadcastToMesh`):
  `{ meshType, pktId, packetId, senderNodeId, senderTag, timestamp, ...campos }`
  Deduplicação por `pktId` em `seenPacketIds` (limite 2000).

### `meshType`
| meshType | Quem envia | Observação |
|---|---|---|
| `DIRECT_SIGNAL` | todos | `{to, transferId, signalType, payload}` — sinal ponto a ponto |
| `PRESENCE_ANNOUNCE` | **App** (`app.js` a cada 15 s) | `{tag, nameSince, reghash, nodeId, photoHash, clientType:'android'\|'extension-app'\|'web', relayMode}`. O campo `avatar` (HTML) **não é mais enviado nem aceito** da rede: identicon é gerado localmente (antes era injeção de HTML) |
| `PEER_ANNOUNCE` / `ROSTER_GOSSIP_SYNC` | **Extensão** | `{roster:[...]}` gossip do catálogo de peers — o app também trata (`mergeRosterIntoRegistry`) |
| `PROBE_USER_EXISTS` / `_REPLY` | App | **unicidade do NOME** (não da tag: o `_hash6` muda por conta). Pergunta `{probeId, name, suffix, tag, requesterNodeId}`; responde `{probeId, ownerTag, since, authoritative}` o dono (na hora) ou quem tem o nome no catálogo (atraso aleatório 0,25–1,45 s, fica quieto se alguém já respondeu). Mesmo sufixo = mesma conta (outro aparelho) → não é conflito; serve para o login sem nome descobrir o nome da conta |
| `USER_REGISTERED` | App | `{tag, previousTag?, since, registeredAt, nodeId}` — conta nova, login com nome novo ou **troca de nome** (com `previousTag`: libera o nome antigo no catálogo; quem recebe migra conversa/contato só se verificar: mesmo `nodeId` já conhecido para a tag antiga, ou mesmo sufixo `_hash6` + `pubKeyHex`) |
| `NAME_REGISTRY_REQUEST` / `NAME_REGISTRY_SYNC` | App | sincroniza o catálogo de nomes: pedido 4 s após conectar (1x por sessão); um nó responde (atraso 0,8–4,3 s, cancela se outro respondeu) com `entries: [[nome, sufixo, since, seen], …]` (até 250) e todos mesclam |

> Presença é interoperável desde 2026-11-05 (antes app e extensão não se viam). Visitantes do portal usam tag `@link_xxxxxx` e são ignorados nos rosters.

### `signalType` (dentro de `DIRECT_SIGNAL`)
- **Transferência:** `FILE_OFFER` → `FILE_ACCEPT` (receptor) → `WEBRTC_OFFER` (remetente) → `WEBRTC_ANSWER` → `ICE_CANDIDATE`… ; `FILE_REJECT`, `TRANSFER_REJECT`.
- **Foto do perfil:** `AVATAR_REQUEST {photoHash}` → `AVATAR_RESPONSE {photoHash, image}` (data URL JPEG 256×256, validada por `isSafeImageDataUrl`, ≤ 120 KB). Só contatos pedem (quando o `photoHash` da presença difere do salvo), no máximo 1×/min; resposta no máximo 1× a cada 20 s por pedinte.
- **Troca de nome:** `USER_RENAMED {tag, previousTag, nodeId, pubKeyHex?}` enviado ponto a ponto a contatos/conversas após renomear (complementa o broadcast `USER_REGISTERED`). Mesma verificação acima.
- **Chat:** `CHAT_MESSAGE`, `CHAT_ACK` (`{msgId,status:'DELIVERED'|'READ',mediaReady?}`), `CHAT_READ`, `CHAT_TYPING`, `CHAT_REACTION` — implementados na extensão, no app e no portal. Quem recebe `CHAT_MESSAGE` responde `CHAT_ACK` (também para repetidas); app/portal reenviam até 3x sem ACK (destino deduplica por `id`). **Sem servidor que guarde mensagens:** texto que ficou em ✓ (`SENT`) é reenviado pelo app quando chega a `PRESENCE_ANNOUNCE` do destino (`flushPendingMessages`, até 7 dias, 1x a cada 30 s por contato) — só funciona se o remetente estiver online quando o destino aparecer; mídia não é reenviada.
- **Mídia de chat:** `transferId` sempre com prefixo **`chatmedia-`** (hífen! o offscreen da extensão usa esse prefixo para guardar a mídia em vez de baixar). Fluxo: `CHAT_MESSAGE` (com `transferId`+`fileMeta`+`media`) + `FILE_OFFER {isChatMedia}` → receptor aceita (`FILE_ACCEPT`) → WebRTC. A extensão aceita mídia de chat automaticamente e pode mandar **dois** `FILE_ACCEPT` (um do CHAT_MESSAGE e outro do FILE_OFFER): o remetente deve ignorar o duplicado.
- **Relay mesh:** `MESH_RELAY_REQUEST/ACCEPTED/REJECT/CHUNK/DATA` (extensão). `MESH_RELAY_CHUNK` = `{chunkSeq (1..N), totalChunks, chunkBase64 (12 KB), isEof, totalBytes, fileMeta}` — o app envia (link via `TUNNEL_RELAY_PULL`) e recebe. Regra: **só aceitar dados de transferência que o usuário aceitou** (sem push não solicitado).
- **Link público:** `PACK_INFO_REQUEST` → `PACK_INFO_RESPONSE`, `PACK_FILE_PULL`/`PUBLIC_LINK_PULL` (transferId `${shareId}_${fileId}_NNNN`), `PACK_DOWNLOAD_COMPLETE`, `TUNNEL_RELAY_PULL` (portal cai para relay se o DataChannel não abrir em 9 s). Servido pelo app (Android, extensão ou navegador) (`publicShares` em `app.js`, só enquanto o app estiver aberto). Senha: `passwordHash = sha256(senha + passwordSalt)` verificado no portal. `PACK_INFO_RESPONSE.allowZip` (ausente = true): o portal tem **um único botão Baixar**; se `allowZip`, ao clicar oferece "Compactado (.zip)" ou "Arquivos separados", senão baixa separado. O remetente escolhe no modal do link (`input-link-allow-zip`).

### Quadro Bluetooth (app Android ↔ app Android)
`Native.sendBleMessage(tagAnunciada, JSON)` com `{psf:1, ttl, h (saltos), p: <pacote da malha completo>}`. No Kotlin cada mensagem vira fragmentos `PSF|<id>|<i>|<n>|<bytes>` (MTU negociado até 517) remontados no GATT server; mensagens sem o prefixo (versões antigas) são entregues cruas. O anúncio BLE carrega só **24 bytes** da tag (sem lista de UUID; o scan filtra por service data): tags maiores são resolvidas pelo prefixo em `resolveBleTag` (app.js).

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
| 1b | ~30 | **Várias contas no aparelho**: as chaves de `ACCOUNT_SCOPED_KEYS` (conversas, contatos, listas, bloqueados, tags antigas, `ps_my_tag`, `ps_my_reghash`, `ps_node_id`) são "ao vivo" da conta em `ps_live_account_id`; as das outras contas ficam em `ps_acct_<k+16 hex da pubKey>__<chave>`. `syncAccountStorage()` roda **antes de qualquer leitura** e troca os dados se a conta ativa mudou (`swapLiveAccount`). `saveChatMessagesToStorage` não grava se outra página trocou a conta (`liveAccountChanged`). Só a conta ativa conecta/recebe |
| 2 | 26 | Estado global: `nodeId`, `myTag`, `peerRegistry`, `peerTransports` (`LAN`/`BLE`/`P2P`), `directDataChannels`, `blePeers`, `transfers`, `publicShares`, `chatMessages`, `activePeerConnections`, helpers `normalizeTag/formatBytes/formatTime` |
| 3 | 112 | Objeto **`Native`** (wrapper de `window.PulseShareNative` com fallback web) e **`window.PulseShareNativeCallback`** (`onFilesPicked`, `onSharedFilesReceived`, `onBleMessageReceived`, `onBlePeersUpdated`, `onBackPressed` → retorna `'HANDLED'`/`'EXIT'`) |
| 4 | 314 | Identidade: `initCryptoIdentity`, `updateIdentityUI`, `renderIdentityModal` |
| 4c | ~480 | **Catálogo de nomes** (`nameRegistry`, localStorage `ps_name_registry_v1`: nome → `{s: sufixo, since, seen}`, TTL 90 dias sem sinal, até 3000): `noteNameClaim` (em conflito vence o menor `since` = `profile.nameSince \|\| createdAt`), `releaseNameClaim`, `probeName(name, suffix)` → `{taken, ownerTag, knownName}`, `answerNameProbe`, `requestNameRegistrySync`, `ensureNetworkForProbe` (conecta aos brokers também na tela de entrada; sem conta só trata `NAME_ONLY_PACKETS`), `checkMyNameConflict` (aviso `setting-username-conflict` quando outra conta registrou meu nome antes). **Criar conta, novo perfil, login com nome novo e troca de nome exigem rede e consulta** (`loginWithWords` com `isNew`); login sem nome usa o nome que a rede conhece para as chaves |
| 4d | ~700 | **Contas** (Configurações → 👥 Contas neste aparelho, `settings-accounts-list`): `renderAccountsList`, `switchAccount` (marca ativa + recarrega), `openAddAccount` (tela de entrada com `btn-onb-back`; voltar do Android também fecha), `logoutAccount` (2 confirmações: sair; apagar ou guardar os dados — guardados voltam ao entrar de novo com a mesma chave) |
| 4b | ~460 | **Troca de nome** (Configurações → 👤 Nome de Usuário): `startUsernameChange` → verificação pedindo 1 das 7 palavras → `probeName` (3 s, qualquer sufixo) → `applyUsernameChange` (re-deriva com as mesmas palavras: sufixo `_hash6` fixo, migra `sender` das minhas mensagens, reinicia BLE, `USER_REGISTERED` + `USER_RENAMED`). Tags antigas ficam em `myPreviousTags` (`isMyTag`) para sinais/links antigos ainda chegarem |
| 5 | ~560 | MQTT: `buildMeshPacket`, `publishRawToBrokers`, `broadcastToMesh`, `sendSignal(to,tid,type,payload,{allRoutes})`, `connectSingleBroker`/`connectBrokers` (reconexão por broker + PINGREQ), `handleIncomingMqttBytes(ws, bytes)` (buffer por socket, vários pacotes por frame), `announcePresence`, `handleIncomingPacket(packet, via)` (`via` = `mqtt`/`ble`/`mesh`; trata `PROBE_USER_EXISTS`, `USER_REGISTERED`→`handleRemoteRename`), `mergeRosterIntoRegistry`, BLE (`handleBleIncomingMessage`, `resolveBleTag`) |
| 5b | ~570 | **Roteamento inteligente**: `rankRoutes(tag)` ordena `ble` (vizinho Bluetooth, custo por RSSI), `mqtt` (internet, mais barato se o destino tem presença MQTT recente) e `mesh` (inunda vizinhos BLE com TTL 3; quem tem internet faz ponte) + latência medida por `CHAT_ACK` (`trackRttSent/Ack`, média móvel) + falhas (`trackRouteFailure`). Chat vai pelas 2 melhores rotas, retentativas por todas; sinalização WebRTC prefere internet. Pontes: `handleBleFrame` (BLE→internet/BLE) e `maybeBridgeToBle` (internet→vizinho BLE sem internet). `detectWebRtcPath` marca LAN quando o par ICE é host↔host. Selo na UI: `routeBadgeHtml` (🟢 LAN / 📶 BLE / 🔀 Malha / 🌐 Internet) |
| 6 | ~800 | `handleDirectSignal` (switch de todos os signalType), `setTransferStatus`/`updateTransferProgress`, `acceptIncomingTransfer`, `readFileSlice` (Blob / URI SAF / base64), helpers |
| 7 | ~1100 | `startSenderWebRTC(tid, target, opts)` (ignora FILE_ACCEPT duplicado), `finishSend`, `createReceiveSink` (Android: `saveChunk` em blocos de 256 KB; web: Blob), `startReceiverWebRTC` (ignora offer não aceita), fila `pendingIce` |
| 7b | ~1500 | Link público do app: `createPublicShare`, `handlePackInfoRequest`, `handlePackFilePull`, `startRelaySend`, `handleRelayChunk`, `renderShares`, `window.psShareAction` |
| 8a | ~1750 | Mídia do chat: `chatMediaKind`, IndexedDB, `setChatMediaBlob`/`getChatMediaUrl`, `captureOutgoingChatMedia`, `saveChatMediaToDisk`, `window.psOpenChatImage/psSaveChatMedia` |
| 8 | ~2000 | Chat: `handleIncomingChatMessage` (envia CHAT_ACK), `sendChatMessage` (BLE + MQTT; **sem** atalho CHAT_DIRECT), `scheduleChatRetry`, `sendChatMessageWithMedia`, `queueOutgoingFile`, `window.downloadChatMedia/cancelTransfer/acceptTransfer`, `renderChatMessages` (ticks ✓/✓✓/azul) |
| 14 | ~3900 | **Conta, QR, foto, notificações** (antes do §13): `showOnboarding` / `initOnboardingEvents` (tela `view-onboarding`: chave de acesso, 7 palavras, importar .txt, ler QR [só Android], criar conta → `view-account-created` mostra chave+palavras), `loginWithWords/Key/FromParsed`, `parseLoginText` (aceita .txt exportado, `pulseshare://login?k=…&n=…` e o JSON antigo de pareamento), `exportRecoveryTxt` (`saveTextFileOnDevice`: Android → Download/, PC → download), `showMyLoginQr` (QR de login, ⚠️ dá acesso à conta), leitor `openQrScanner`/`closeQrScanner` (getUserMedia + jsQR), editor de foto (`openPhotoEditor`, pinça/arraste/roda, saída 256 px JPEG em `profile.photo`/`photoHash`), fotos de contatos (`maybeRequestPeerPhoto`, `handleAvatarResponse`), `notifyIncoming` (não avisa se a conversa está aberta e visível), `playNotifySound` (`sounds/<som>.wav` na web/extensão), configurações 🔔 (`ps_notify_enabled`, `ps_notify_sound`, `ps_notify_vibration`, `ps_background_mode`), `acquireCoreLock` (extensão), `migrateLegacyExtensionChats` (chat da extensão antiga em `chrome.storage` → app, uma vez), `openChatFromLaunch` (`?chat=` ou toque na notificação do Android) |
| 9 | ~3300 | **Busca universal** (lupa do topo ou botão flutuante `btn-fab-new-chat`, `modal-global-search`): `renderGlobalSearchResults` agrupa 👤 Usuários (contatos/conversas; @tag completo **ou só o nome** → resolve pelo catálogo de nomes / `searchLookupName` pergunta à rede 700 ms após parar de digitar → "+ Adicionar" com a tag completa; nunca oferece tag sem sufixo), 💬 Mensagens (trecho com destaque, sem acento) e 📎 Arquivos (mídia do chat, transferências, links). Clique numa mensagem abre a conversa e rola até ela (`scrollToChatMessage`) |
| 10 | 1840 | Menu do contato (salvar, listas/categorias, excluir conversa) |
| 11 | 1897 | Transferências: `handleFilesSelected`, `handleAndroidSharedItems`, `renderStagedFiles`, `renderTransfers` |
| 12 | 1999 | Abas: `currentTab` (padrão `'chat'`), `switchTab`, `updateHeaderStatus`, `renderMeshPeers`, `openSendModal('p2p'|'link')` |
| 13 | ~4400 | `initEvents()` (todos os `onclick` por id + delegação `data-ps-call` com lista permitida `PS_CALLS`) + `DOMContentLoaded` → `acquireCoreLock` → `initCryptoIdentity` (false = sem conta → tela de entrada) → `initEvents` → `connectBrokers` → `switchTab('chat')` → `Native.setBackgroundMode` → `openChatFromLaunch` |

**Tags sem sufixo:** a busca antiga criava conversas com `@nome` (sem `_hash6`) que nunca chegavam a ninguém; `migrateBareTags` move conversa/contato para a tag completa quando o catálogo conhece o dono e reenvia o pendente.

**Contatos (sem descoberta automática):** a UI só mostra contatos adicionados (`getContacts`/`isContact`/`addContact`, catálogo `ps_contacts_catalog_v2`) e conversas existentes; a presença dos demais fica no `peerRegistry` só para rotear. Mensagem de quem não é contato aparece como "✉️ Pedido" com banner Adicionar/Bloquear (`chat-contact-request-banner`, `ps_blocked_tags`). Não-contatos **nunca** recebem aceite automático de arquivo (exceto visitantes `@link_`). A aba "Usuários" (`view-mesh`) lista só contatos com o selo da rota.

**Regras de download:** foto/vídeo/áudio do chat ≤ 16 MB (`CHAT_PREVIEW_AUTO_MAX`) é aceito sozinho **só para pré-visualizar**: fica na memória + IndexedDB `PulseShareChatMedia/media` (chave = transferId, até 64 MB `CHAT_PREVIEW_KEEP_MAX`) e só vai para Download/ ao tocar em Salvar (`psSaveChatMedia`) ou com `ps_chat_auto_download === 'true'`. Demais arquivos do chat só baixam com auto-download ou clique; fora do chat segue `ps_auto_accept` (padrão true). O remetente guarda a própria mídia enviada (`captureOutgoingChatMedia`). `renderChatMessages` atualiza só as bolhas que mudaram (diff por `data-mid`) para vídeo/áudio não reiniciarem; foto abre em `psOpenChatImage` (visualizador com zoom; o botão voltar fecha).

**Perfil:** saiu da barra superior (o cabeçalho tem só "PulseShare", status, lupa e engrenagem). Fica no topo das **Configurações** (`settings-avatar-slot`, `btn-settings-open-identity` → modal de chaves com chave de acesso, 7 palavras, exportar .txt, QR; `btn-settings-change-photo` → editor). A conta não é mais criada sozinha: sem perfil ativo aparece a tela de entrada.

**IDs principais em `app.html`:** views `view-chat|home|transfers|shares|mesh`; nav `nav-*`; chat `chat-list-pane`, `chat-active-conversation-pane` (classe `active` = aberto), `chat-messages-container`, `chat-conversations-list`, `chat-categories-bar`, `input-chat-text`, `btn-chat-send`, `btn-chat-attach`; modais `modal-send`, `modal-settings`, `modal-global-search`, `modal-identity-profile`, `modal-qr-pair-scanner`, `modal-contact-menu`, `modal-add-category-list`, `modal-photo-editor`, `view-onboarding` (com `btn-onb-back` ao adicionar conta), `view-account-created`, `view-other-window` (mostrar/ocultar com a classe `hidden`). Ao criar modal novo, adicioná-lo também em `onBackPressed`.

**localStorage (app):** por conta (ver 1b): `ps_node_id`, `ps_my_tag`, `ps_my_reghash`, `ps_previous_tags`, `ps_blocked_tags`, `ps_chat_messages`, `ps_custom_categories`, `ps_contacts_catalog_v2`; do aparelho: `ps_live_account_id`, `ps_acct_*`, `ps_name_registry_v1`, `ps_my_tag`, `ps_previous_tags`, `ps_blocked_tags`, `ps_notify_enabled`, `ps_notify_sound`, `ps_notify_vibration`, `ps_background_mode`, `ps_legacy_migrated`, `ps_my_reghash`, `ps_auto_accept`, `ps_chat_auto_download`, `ps_download_folder`, `ps_mesh_relay`, `ps_relay_bw`, `ps_turn_config`, `ps_chat_messages`, `ps_custom_categories`; crypto: `ps_profiles_v2`, `ps_active_profile_id_v2`, `ps_contacts_catalog_v2`.

**Depuração:** `window.__psDebug()` devolve `{myTag, transfers, peerRegistry, publicShares, chatMessages}`; `window.__psTrace = true` loga cada sinal recebido.

**Observação:** `app.js` instancia `PulseShareMeshEngine` mas **não chama `init()`** — os algoritmos avançados (DTN, ratchet etc.) não estão ativos no Android.

## 5. Extensão Chrome MV3 — `extension/` (desde 2026-11-07: **o mesmo app do celular**)

A extensão não tem mais UI própria: roda `extension/app.html` + `app.js` (cópias idênticas da raiz).

| Arquivo | Papel |
|---|---|
| `manifest.json` | v4.0.0; perms `storage, notifications, offscreen, alarms`; host perms dos brokers; ação **sem popup** |
| `sw.js` | Service worker (~120 linhas): clique no ícone → `openAppWindow` (janela tipo popup 430×880 com `app.html`, ou foca a existente); documento offscreen `app.html?bg=1` (reasons `WEB_RTC`, `LOCAL_STORAGE`) quando `backgroundMode` (chrome.storage) está ligado, recriado por `chrome.alarms` a cada 1 min; mensagens do app: `PS_NOTIFY` → `chrome.notifications` (silenciosa: o som é tocado pelo app) + contador no ícone, `PS_UI_OPEN` → zera contador, `PS_SET_BACKGROUND` → cria/fecha offscreen; clique na notificação → abre a janela em `app.html?chat=@tag` |
| `app.html`, `app.js`, libs, `sounds/`, `icons/` | cópias da raiz |

**Uma conexão por vez** (`acquireCoreLock` em app.js, Web Lock `pulseshare-core`): a janela pega o lock com `steal` (e relê `ps_chat_messages`); o documento de fundo que perde o lock recarrega e fica esperando; quando a janela fecha, o fundo recebe o lock, recarrega (para ler o estado novo) e conecta. Uma segunda janela toma o controle e a anterior mostra "Aberto em outra janela / Usar aqui" (`view-other-window`).

A extensão antiga (popup.js/background.js/offscreen.js/receiver.*, ~10 mil linhas) foi removida em 2026-11-07; está no histórico do git (commit `d05585e`). O histórico de chat dela é migrado uma vez por `migrateLegacyExtensionChats`; os contatos já ficavam no mesmo localStorage da origem da extensão. Perdeu-se: relay multi-hop da extensão, receptor interno de link (links abrem o portal) e links públicos que sobrevivem ao fechar a janela (os arquivos do link ficam só na memória da página que criou).

## 6. Android nativo — `android/` (pacote `com.ricardo.pulseshare`)

- minSdk 24, target/compile 36, Java/Kotlin 17, só AndroidX core/activity/lifecycle. Release assinado com chave **debug** (`~/.android/debug.keystore`, SHA-256 `fe:e5:98:d8…`). A chave antiga (`aa:df:b9:3e…`) foi perdida em 2026-11-07: aparelho com APK antigo precisa desinstalar (fazer backup do localStorage antes pela depuração da WebView: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + CDP, e restaurar depois).
- `MainActivity.kt`: edge-to-edge — o padding do container soma o **teclado** (`WindowInsetsCompat.Type.ime()`), pois com target 35+ o `adjustResize` não encolhe a WebView (antes o teclado cobria a barra do chat e a busca). WebView carregando `file:///android_asset/www/index.html`, interface JS `PulseShareNative`, permissões (câmera, BLE, localização, notificação), intents `SEND`/`SEND_MULTIPLE`/`VIEW`, back → `PulseShareNativeCallback.onBackPressed()`, `evaluateJs()` para chamar callbacks.
- `PulseShareBridge.kt`: métodos `@JavascriptInterface` — `notifyMessage(title, body, peerTag, sound, vibration)`, `previewNotification(sound, vibration)`, `setBackgroundMode(bool)`, `requestBatteryExemption`, `consumePendingOpenChat`, `openUrl` (abre link do portal no navegador), `pickFiles`, `getPendingSharedFiles`, `readFileBase64`, `readUriChunkBase64`, `saveFile`, `saveChunk(id,name,b64,isFirst,isLast,mime)`, `cancelTransfer`, `get/setDownloadDirectory`, `openDownloadFolder`, `openDownloadedFile`, `shareDownloadedFile`, `shareText`, `copyToClipboard`, `showToast`, `showNotification`, `start/stopKeepAlive`, `isBleAvailable`, `start/stopBleMesh`, `getNearbyBlePeers`, `sendBleMessage`.
  **Para nova função nativa:** adicionar aqui + wrapper no objeto `Native` em `app.js` (com fallback web).
- `FileHelper.kt`: grava em `Download/<pasta>` (padrão `PulseShare`), streaming de chunks, MediaScanner, FileProvider.
- `BluetoothMeshHelper.kt`: BLE GATT server + advertising + scan; service UUID `0000fe55-…`, characteristic `0000fe56-…`. Envio com fila por destino (`drainQueue`: uma conexão GATT por vez, `requestMtu(517)`, até 8 mensagens por conexão, fragmentos `PSF|…`), servidor remonta fragmentos e escritas longas (`onExecuteWrite`). Anúncio sem lista de UUID (24 bytes de tag).
- `PulseShareService.kt`: foreground service **`remoteMessaging|dataSync`** (Android 14+; sem o limite de 6 h do dataSync). Modo "rodar em segundo plano" (`setBackgroundMode`, SharedPreferences `pulseshare_prefs/background_mode`): notificação fixa "PulseShare ativo" + WakeLock sem prazo; sem ele, o serviço só sobe durante transferências (WakeLock 1 h). `stopKeepAlive` do JS não derruba o serviço quando o modo está ligado. A WebView não é pausada em segundo plano (MainActivity não chama `onPause`/`pauseTimers`).
- `NotificationHelper.kt`: todas as notificações usam `setSmallIcon(R.drawable.ic_stat_pulseshare)` + `setColor(BRAND_COLOR)` (#4F46E5). `showMessage` usa um **canal por combinação som+vibração** (`ps_msg_<som>_<vibração>`; os canais antigos `ps_msg_*` são apagados ao trocar, porque o Android não deixa mudar o som de um canal). Sons: `res/raw/ps_<som>.wav`, `sistema` (padrão do aparelho) ou `nenhum`. Vibrações: `dupla`, `curta`, `longa`, `tripla`, `batida`, `nenhuma`. Um aviso por contato (id fixo por tag); toque abre `MainActivity` com `EXTRA_OPEN_CHAT` → `PulseShareNativeCallback.onOpenChat(tag)`. `preview` toca o som (MediaPlayer) e vibra na hora.
- Build (JDK 17 em `~/.local/jdk` — em 2026-11-07 `/usr/lib/jvm` não existia; SDK em `~/Android/Sdk`): `JAVA_HOME=~/.local/jdk ANDROID_HOME=~/Android/Sdk ./gradlew assembleRelease --offline -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease` (o lint não está no cache offline) → `app/build/outputs/apk/release/app-release.apk` (copiar para `PulseShare.apk` na raiz se for publicar).

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
7. Links públicos e relay multi-hop: a extensão nova serve links só enquanto a janela/página que criou o link estiver aberta, e nenhum cliente atua mais como relay `MESH_RELAY_*`.
8. O PIN/2FA do modal de identidade não tem ação ligada.
9. Rota BLE testada só com ponte nativa simulada (falta teste em 2 aparelhos reais). Arquivos não passam por BLE (só sinalização/chat ≤ 3,5 KB por quadro).
10. Unicidade do nome é por consenso fraco: `since` é declarado pelo próprio nó (sem assinatura real — `pubKeyHex` é hash da chave privada, não chave pública), então um nó malicioso pode alegar data antiga. Contas duplicadas criadas antes do catálogo (2026-11-07) só recebem aviso, não são renomeadas. Troca de nome num aparelho não é aplicada nos outros aparelhos da mesma conta.
11. Várias contas: só a ativa fica conectada (as outras não recebem nada até virar ativa; o remetente reenvia o pendente quando ela aparece). Mensagens offline dependem do remetente estar online quando o destino voltar.
12. Após trocar o nome, o **chat temporário** de links públicos antigos não funciona (o portal compara `senderTag` com o `owner` do link); o download continua (tags antigas aceitas via `isMyTag`). Na extensão, a tag antiga fica livre para outros.

## 9. Checklist ao fazer alterações

- Mudou JS/HTML compartilhado? → sincronizar cópias (§2).
- Mudou protocolo (meshType/signalType/campos)? → atualizar **app.js (e suas cópias) e index.html (portal)** e a tabela §3 deste arquivo.
- Mudou ponte nativa? → `PulseShareBridge.kt` + `Native` em `app.js` (com fallback web/extensão).
- Botão em HTML gerado? → `data-ps-call="fn" data-ps-args="a|b"` e incluir `fn` em `PS_CALLS` (nada de `onclick` inline: a extensão bloqueia).
- Recurso só de celular (câmera, BLE, vibração)? → classe `android-only` (e `desktop-only` para o inverso).
- Novo modal no app → registrar em `onBackPressed`.
- Teste rápido de protocolo: `node test_chat_media_e2e.mjs` / `node test_p2p_real_e2e.mjs` (usam brokers públicos reais; o segundo tem um `@tag` de dispositivo fixo no código).
- Commits em português no estilo `feat(escopo): …` / `fix: …`.
- Ao concluir mudanças estruturais, **atualizar este CLAUDE.md**.

## 10. Testes E2E (como foram feitos em 2026-11-05)

Chrome real (`/usr/bin/google-chrome`) via `puppeteer-core` com a extensão carregada (`enableExtensions`, `pipe: true`), servindo uma **cópia** do projeto com o tópico MQTT trocado para um tópico de teste (nunca testar no tópico global real — nós reais do usuário, ex. `@flo_ricardo`, participam como relay). Cenários cobertos: chat texto+mídia ext↔ext, app↔ext, app↔app; envio direto ext→ext; link da extensão e do app → portal (download, ZIP, relay forçado) e chat temporário com arquivos nos dois sentidos. (Esses cenários eram da extensão antiga.) Na extensão nova, abra `chrome-extension://<id>/app.html` e use as mesmas funções globais do app (`openActiveChat`, `__psDebug`); o documento de fundo é o alvo `app.html?bg=1` e o service worker é `sw.js` (`chrome.notifications.getAll`, `chrome.action.getBadgeText`). No celular: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + puppeteer `connect({browserURL:'http://localhost:9333'})`.
