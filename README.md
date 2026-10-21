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
  - **Copiar Mensagem**: copia o resumo formatado com link, arquivos e senha.
  - **Copiar Link**: copia apenas o link direto.
  - **Abrir no Navegador (↗)**: abre o portal web diretamente no seu próprio navegador para pré-visualização.
  - **Pausar / Retomar**: congela ou retoma o envio do arquivo via canal de dados WebRTC.
  - **Encerrar / Cancelar (✕)**: fecha as conexões, cancela os downloads ativos e descarta os arquivos do cache.
