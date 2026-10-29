# PulseShare — Compartilhamento P2P Serverless & Link WebRTC (Manifest V3)

Extensão Chrome para compartilhamento de arquivos **100% serverless, multiplataforma (Windows, macOS, Linux e ChromeOS)**, sem necessidade de servidores intermediários, daemons locais ou binários nativos.

---

## 🚀 Como Funciona a Arquitetura 100% Serverless

1. **Envio P2P entre Extensões (`@usuario`)**:
   - Sinalização multi-broker MQTT segura sobre WebSockets (`wss://broker.emqx.io`, `wss://broker.hivemq.com`, `wss://test.mosquitto.org`).
   - Conexão direta de navegador para navegador via **WebRTC DataChannel** com STUN (Google, Cloudflare) e TURN (OpenRelay).
   - Streaming em blocos de 16KB com controle de fluxo/backpressure (`bufferedAmountLowThreshold`), garantindo estabilidade para arquivos grandes (+100MB a +1GB).

2. **Link Público WebRTC P2P (GitHub Pages)**:
   - O remetente gera um link público na extensão apontando para o portal servido no GitHub Pages:
     `https://ricardoazt.github.io/share/#share=UUID&owner=@usuario&exp=TIMESTAMP`
   - O destinatário abre o link no navegador (computador, celular ou tablet, qualquer sistema operacional), **sem precisar instalar a extensão**.
   - A página web (`index.html`) se conecta diretamente à extensão do remetente via WebRTC DataChannel utilizando a malha de brokers MQTT públicos do projeto.
   - Todo o tráfego de dados viaja diretamente ponto a ponto, criptografado de ponta a ponta.

---

## 🌐 Rede Mesh P2P Descentralizada (Multi-Hop, Gossip & Roteamento Dinâmico)

O PulseShare implementa uma malha descentralizada (*mesh network*) completa entre todas as extensões ativas, garantindo comunicação resiliente mesmo em condições severas de rede (NAT simétrico, firewalls corporativos ou restrições de provedor):

1. **Registro Descentralizado de Identidade & Validação de Unicidade (Estilo Criptomoedas)**:
   - **Ledger Descentralizado**: Cada nó mantém o catálogo distribuído de identidades registradas na rede P2P sem depender de qualquer servidor central.
   - **Validação Pré-Registro de Duplicidade**:
     - Antes de aceitar um novo `@usuario`, o sistema valida contra o ledger local e emite uma sondagem em tempo real na malha (`PROBE_USER_EXISTS`).
     - Se o usuário já existir registrado por outro nó, o registro é bloqueado imediatamente com o alerta explicativo: *"O usuário @nome já existe na rede descentralizada! Por favor, escolha outro nome."*
   - **Registro com Prova Criptográfica & Propagação Global**:
     - Quando validado que o usuário não existe, o nó gera um hash criptográfico (SHA-256) atestando a identidade (`0x...`) e o timestamp de registro.
     - A transação de registro (`USER_REGISTERED`) é propagada instantaneamente para toda a malha descentralizada (multi-broker MQTT e canais WebRTC DataChannel ativos).
   - **Lista Global de Usuários e Status em Tempo Real**:
     - Todos os nós recebem, validam e mantêm a lista unificada e sincronizada de usuários cadastrados na rede.
     - Aba dedicada **👥 Usuários** na extensão, exibindo todos os participantes conhecidos com seus respectivos status dinâmicos:
       - 🟢 **Online**: Ativo nos últimos 45 segundos (heartbeat ativo na malha).
       - 🟡 **Ausente**: Inativo entre 45 segundos e 3 minutos.
       - ⚪ **Offline / Inativo**: Mais de 3 minutos sem transmissão.
     - Exibição do **Hash de Registro Criptográfico**, data de registro e data/hora da última conexão (`📅 DD/MM/AAAA às HH:MM (há X min)`).
     - Botão direto **Enviar** nos cards de usuários para envio P2P instantâneo.

2. **Envio Direto para Usuário (`@usuario`)**:
   - Envio P2P direto e simplificado: anexe arquivos ou pastas inteiras, escolha opcionalmente se deseja compactar em `.ZIP` e envie diretamente para o destinatário, **sem necessidade de gerar links públicos** e **sem precisar definir tempo de expiração**.
   - O destinatário recebe o aviso e o arquivo é transferido ponto a ponto via WebRTC DataChannel e salvo automaticamente na pasta de Downloads.

3. **Propagação de Status e Presença via Gossip Protocol**:
   - Cada nó transmite seus anúncios de presença e propaga o catálogo consolidado de peers (*roster*) para todos os nós vizinhos.
   - Os metadados de status e nós de rota se difundem exponencialmente por toda a rede em milissegundos sem a necessidade de banco de dados centralizado.

4. **Roteamento Multi-Hop com Seleção da Melhor Rota & Failover**:
   - O remetente tenta inicialmente a conexão direta P2P via WebRTC DataChannel.
   - Se a conexão direta falhar ou demorar mais de 7 segundos (bloqueio de portas UDP, firewall ou NAT simétrico), o PulseShare automaticamente calcula e seleciona o **melhor nó intermediário** para atuar como rota (*relay*):
     - Critérios de escolha: Menor número de rotas concorrentes, maior banda reservada configurada e menor latência de último sinal.
   - Se um nó de rota intermediário falhar ou for desconectado durante a transmissão, o sistema realiza **failover dinâmico** para o próximo nó disponível na malha mesh.
   - Os cards de transferência indicam com clareza o tipo de rota utilizada (`🟢 P2P Direto`, `🔀 Mesh via @relay` ou `🔁 Relay: @origem ➔ @destino`).

5. **Banda Reservada Configurável para Nós de Rota**:
   - No menu de **Configurações** (ícone de engrenagem), cada usuário pode:
     - Ativar ou desativar a permissão para seu computador servir como rota/nó retransmissor da rede mesh.
     - Escolher a **banda máxima reservada** para o tráfego da rede (opções: `256 KB/s`, `512 KB/s`, `1 MB/s`, `2 MB/s`, `5 MB/s`, `10 MB/s` ou `Ilimitada`). O controle de taxa é executado via *token-bucket pacing* em fatias de 16KB.
     - Monitorar em tempo real o **contador de rotas ativas** e o **volume total de bytes retransmitidos** pelo seu nó para ajudar a comunidade.

---

## 🗜 Opções de Compactação (.ZIP)

Tanto o remetente quanto o destinatário têm total controle sobre as opções de compactação client-side (via biblioteca pura JavaScript `fflate` de ultra-alta velocidade):

- **Ao Enviar na Extensão**:
  - O remetente pode optar por compactar todos os arquivos selecionados em um único arquivo `.ZIP` antes de gerar o link ou enviar.
  - Seleção de nível de compressão:
    - **Nível 0**: Store (sem compressão - ultrarrápido).
    - **Nível 1**: Rápida.
    - **Nível 6**: Padrão equilibrado (Recomendado).
    - **Nível 9**: Máxima compressão.
  - Nome personalizado para o arquivo `.zip`.

- **Ao Baixar no Portal Público (`index.html`)**:
  - O destinatário pode escolher baixar arquivos individualmente com um clique no botão **⬇ Baixar**.
  - Ou baixar todos os arquivos empacotados em um arquivo `.ZIP` no botão **⬇ Baixar Todos (.ZIP)**.
  - O destinatário pode selecionar o nível de compressão desejado e o nome do arquivo compactado diretamente na página web.

---

## 🛠 Instalação da Extensão no Google Chrome

Compatível com **Windows, macOS, Linux e ChromeOS**:

1. Clone ou baixe este repositório:
   ```bash
   git clone https://github.com/ricardoazt/share.git
   ```
2. Abra o Google Chrome e acesse:
   `chrome://extensions/`
3. Ative o interruptor **"Modo do desenvolvedor"** no canto superior direito.
4. Clique em **"Carregar sem compactação"** (*Load unpacked*).
5. Selecione a subpasta `extension/` deste repositório.
6. Fixe o ícone do **PulseShare** na barra de ferramentas do Chrome.

---

## 🌐 Configuração do GitHub Pages no Repositório

O portal de download do destinatário (`index.html`) é servido diretamente pelo GitHub Pages do repositório `ricardoazt/share`:

1. No repositório no GitHub, acesse **Settings** > **Pages**.
2. Em **Build and deployment**:
   - **Source**: selecione **GitHub Actions** (o workflow automático `.github/workflows/deploy-pages.yml` já está configurado no projeto para atualizar o site a cada `git push`).
   - Ou alternativamente selecione **Deploy from a branch**: branch `main` e pasta `/ (root)`.
3. A URL pública padrão do portal é:
   `https://ricardoazt.github.io/share/`
4. Na extensão, você também pode personalizar essa URL a qualquer momento no menu de configurações (ícone de engrenagem).

---

## 📋 Como Gerar um Link Público

1. Clique no ícone do **PulseShare** no navegador.
2. Clique no botão laranja **"Gerar Link Público (GitHub Pages WebRTC)"**.
3. Selecione arquivos pelo botão **"+ Arquivos"**, pastas inteiras por **"+ Pasta"** ou simplesmente arraste e solte arquivos e diretórios na área indicada.
4. Opcionalmente ative a **Compactação do Pack em .ZIP** e defina o nível de compressão.
5. Defina o **tempo de expiração** (ex: 30 minutos) e opcionalmente uma **senha de proteção**.
6. Clique em **"Confirmar & Gerar Link"**.
7. A extensão gera o link e copia automaticamente a mensagem formatada para a sua área de transferência:
   ```text
   📦 PulseShare — Compartilhamento de Arquivos P2P
   🔗 Link: https://ricardoazt.github.io/share/#share=ps-xxxx&owner=@usuario&exp=1792550000000
   🔑 Senha: [senha configurada ou 'Nenhuma']
   ⏳ Expira em: ~30 min (às 21:05)
   📁 Arquivos (2):
     • relatorio.pdf (2.4 MB)
     • planilha.xlsx (1.1 MB)

   ⚡ Baixe direto pelo navegador (WebRTC P2P), sem servidor e sem instalar nada!
   ```
8. Envie para qualquer pessoa. Ela poderá baixar os arquivos individualmente ou todos juntos em um arquivo `.ZIP` direto pelo navegador!

---

## 🔍 Gerenciador de Transferências & Visualização Expandida

- O gerenciador de transferências na extensão preenche toda a altura inferior da janela com rolagem suave para acompanhar múltiplas transferências ativas e histórico.
- **Botão de Expandir Janela** (ícone ao lado da engrenagem): abre o gerenciador em uma aba completa do navegador com visão ampla em tela cheia para monitorar grandes volumes de arquivos.
- Controles em tempo real nos cards de transferência:
  - **Copiar Link**: copia apenas o link direto (URL).
  - **Texto Completo**: copia a mensagem formatada completa com link, arquivos e senha.
  - **Abrir no Navegador (↗)**: abre o portal web diretamente no seu próprio navegador para pré-visualização.
  - **Pausar / Retomar**: congela ou retoma o envio do arquivo via canal de dados WebRTC.
  - **Encerrar / Cancelar (✕)**: fecha as conexões, cancela os downloads ativos e descarta os arquivos do cache.

---

## 🛡️ Stack de Tecnologias Avançadas de Rede, Roteamento & Criptografia P2P

O **PulseShare** integra um motor descentralizado completo (`pulseshare-mesh-engine.js`), combinando 9 tecnologias de ponta para comunicação, topologia e segurança ponto a ponto serverless:

### 1. Frameworks de Rede e Roteamento P2P
- **libp2p**:
  - **Circuit Relay v2**: Permite que dispositivos em redes restritivas alcancem destinos utilizando nós voluntários como pontes com reserva de saltos padronizada (`HOP_RESERVE`), quotas de tempo/banda e endereçamento Multiaddr (`/p2p/QmRelay/p2p-circuit/p2p/QmTarget`).
  - **Gossipsub v1.1**: Pub/sub baseado em malha inteligente com controle de graus ($D, D_{low}, D_{high}$), mensagens `GRAFT`/`PRUNE`, fofoca de metadados (`IHAVE`/`IWANT`) e pontuação de nós (*peer scoring*), evitando inundações de tráfego redundante.
- **Reticulum Network Stack (RNS)**:
  - Endereçamento criptográfico por **Destination Hash de 16 bytes** (`rns://...`), gerado via SHA-256 da chave de identidade do nó.
  - Pacotes `ANNOUNCE` assinados digitalmente com curva P-256 e **Dynamic Path Table** que atualiza automaticamente o melhor caminho e métrica de qualidade.
- **Yggdrasil Network Overlay**:
  - Criação de endereço **IPv6 overlay criptográfico** (`0200::...`) derivado da chave pública do dispositivo.
  - Mapeamento da topologia em **árvore de abrangência (Spanning Tree)** com coordenadas hierárquicas e algoritmo de **Roteamento Guloso (Greedy Tree Metric)** para alcançar qualquer nó pela menor distância topológica.

### 2. Algoritmos de Descoberta e Topologia
- **Kademlia DHT (Distributed Hash Table)**:
  - Espaço de endereçamento de **256 bits** por nó com métrica matemática **XOR** ($d(x, y) = x \oplus y$).
  - Organização em **k-buckets** ($k=8$) com ordenação por último sinal e substituição por inatividade.
  - Descoberta iterativa dos nós mais próximos matematicamente a qualquer hash de destino ou recurso.
- **AODV (Ad hoc On-Demand Distance Vector)**:
  - Roteamento reativo que estabelece caminhos sob demanda apenas quando há mensagens a enviar.
  - Mensagens padronizadas `AODV_RREQ` (Route Request), `AODV_RREP` (Route Reply) e `AODV_RERR` (Route Error).
  - Números de sequência crescentes para garantia matemática de rotas livres de loops (*loop-free*).

### 3. Sincronização e Resiliência (Delay-Tolerant Networking)
- **CRDTs (Conflict-free Replicated Data Types)**:
  - **LWW-Element-Set (Last-Write-Wins Set)**: Conjunto replicado sem conflitos com relógios lógicos de Lamport e desempate determinístico por NodeId, garantindo que o catálogo de usuários convirja identicamente em todos os nós, mesmo com pacotes fora de ordem.
  - **Causal Message Log**: Registro ordenado imutável de mensagens e transferências com rastreamento causal.
- **Store and Forward (Delay-Tolerant Networking - DTN / RFC 5050 & RFC 9171)**:
  - Nós intermediários armazenam pacotes e metadados de transferência em cache persistente local (IndexedDB) com TTL configurável.
  - Se a rota for temporariamente interrompida ou o nó de destino estiver offline, os pacotes permanecem sob custódia e são encaminhados opportunisticamente assim que uma rota viável for restabelecida.

### 4. Criptografia para Roteamento Descentralizado
- **Onion Routing (Criptografia em Camadas - Tor / Sphinx style)**:
  - Empacotamento esférico em múltiplas camadas usando pares efêmeros ECDH (P-256) e criptografia simétrica autenticada AES-256-GCM.
  - Cada nó intermediário só decifra a sua própria camada externa, obtendo apenas o próximo salto (`nextHop`) e a camada interna cifrada, sem jamais conseguir ler o conteúdo do arquivo ou identificar a origem e o destino final.
- **Double Ratchet Algorithm (Signal Protocol End-to-End Encryption)**:
  - Criptografia de ponta a ponta intransponível com **Forward Secrecy** (o vazamento de chaves atuais não compromete mensagens passadas) e **Post-Compromise Security / Break-in Recovery** (o sistema se auto-recupera de comprometimentos no próximo salto DH).
  - Cadeia de chaves KDF raiz, cadeia KDF simétrica de envio/recebimento HMAC-SHA-256 e saltos de chave pública ECDH a cada resposta.
