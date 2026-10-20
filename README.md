# PulseShare P2P — Extensão Chrome Serverless (Manifest V3)

Transferência de arquivos **100% Peer-to-Peer (WebRTC DataChannel)** sem servidor próprio, com **Diretório Distribuído P2P de `@usuarios` (Protocolo Gossip / CRDT)**.

## Como funciona a Lista Distribuída de `@usuarios` (Sem Servidor)

1. **Armazenamento Interno (`peerRegistry`)**:
   - Cada instância da extensão mantém internamente o mapa completo de todos os `@usuarios` conhecidos na rede (persistido em `chrome.storage.local`).
2. **Propagação P2P Automática (Gossip Protocol)**:
   - Quando um novo `@usuario` entra na rede ou altera sua tag, a extensão emite um pacote `PEER_ANNOUNCE` contendo sua identidade e os pares que já conhece.
   - Todos os nós ativos recebem o anúncio, fazem o *merge* (CRDT *Last-Write-Wins* por timestamp `lastSeen`) em sua lista interna e respondem com `ROSTER_GOSSIP_SYNC` contendo o catálogo completo atualizado.
   - Além disso, sempre que dois pares abrem um túnel `RTCDataChannel` direto, eles sincronizam suas listas internas (`P2P_ROSTER_SYNC`) diretamente dentro do canal P2P.
3. **Transporte Serverless Híbrido**:
   - **Global**: Cliente binário MQTT v3.1.1 sobre WebSocket nativo (`Uint8Array`, zero bibliotecas externas) conectado automaticamente a brokers públicos globais (`wss://broker.emqx.io:8084/mqtt`, `wss://broker.hivemq.com:8884/mqtt`).
   - **Local**: `BroadcastChannel` para sincronização em `0ms` entre abas/janelas na mesma máquina até mesmo offline.

## Estrutura do Projeto

- [`extension/manifest.json`](file:///data/Ricardo/dev/Projetos/share/extension/manifest.json): Configuração **Manifest V3**.
- [`extension/popup.html`](file:///data/Ricardo/dev/Projetos/share/extension/popup.html) & [`extension/popup.js`](file:///data/Ricardo/dev/Projetos/share/extension/popup.js): Interface compacta com barra de **Diretório P2P Sincronizado** (clique em qualquer `@usuario` para selecionar), **Quadrado Verde (Envio)**, **Quadrado Azul (Recebimento)** e **Gerenciador de Transferências**.
- [`extension/background.js`](file:///data/Ricardo/dev/Projetos/share/extension/background.js) & [`extension/offscreen.js`](file:///data/Ricardo/dev/Projetos/share/extension/offscreen.js): Motor de Gossip P2P, WebRTC DataChannel (`64 KB` chunks com backpressure) e integração com `chrome.downloads`.

## Como Usar (Zero Configuração)

1. Abra `chrome://extensions/` no Google Chrome.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (*Load unpacked*) e selecione a pasta `/data/Ricardo/dev/Projetos/share/extension`.
4. Pronto! Não há nenhum servidor para instalar ou rodar. Todos os `@usuarios` que abrirem a extensão aparecerão automaticamente na barra **Diretório P2P Sincronizado**.
