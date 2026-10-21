# PulseShare — Compartilhamento P2P & Túnel Cloudflare Temporário (Manifest V3)

Extensão Chrome para compartilhamento de arquivos com duas modalidades:
1. **P2P Direto**: Envio direto para outro usuário na malha via `@usuario` (WebRTC DataChannel 100% serverless).
2. **Link Público Cloudflare Tunnel (`*.trycloudflare.com`)**: Gera sob demanda um portal temporário que funciona em qualquer navegador (desktop ou mobile), sem necessidade de instalar a extensão para quem baixa.

---

## Principais Funcionalidades

### 1. Extensão Chrome com Dropdown Fixo
- A extensão funciona no modo padrão `default_popup: "popup.html"`: abre um menu suspenso diretamente abaixo do ícone na barra de ferramentas do Chrome.
- Mantém transferências e conexões ativas em segundo plano através do service worker `background.js` e do daemon local.

### 2. Túnel Cloudflare Temporário (`trycloudflare.com`) Sob Demanda
- Ao clicar em **"Gerar Link Público (Cloudflare Tunnel)"**, o remetente adiciona arquivos (arquivo individual ou pack de arquivos).
- **Tempo de Expiração**: Configure 10 min, 30 min, 1h, 2h, 6h, 12h, 24h ou sem limite. O túnel fica aberto exclusivamente durante esse tempo.
- **Senha de Proteção (Opcional)**: Defina uma senha de acesso para proteger o download.
- **Link Real Independente**: Gera uma URL genuína do tipo `https://*.trycloudflare.com`. Quem recebe acessa direto pelo navegador, sem depender de GitHub Pages nem da extensão instalada.

### 3. Autodestruição do Túnel e Portal ("Se desfaz")
- Ao clicar em **"✕ Encerrar / Cancelar"** na extensão ou quando o **tempo de expiração** é atingido:
  - O processo `cloudflared` é finalizado imediatamente.
  - A porta local é fechada.
  - Os arquivos temporários são deletados do disco.
  - O link público `trycloudflare.com` deixa de existir imediatamente (erro 502/530 no Cloudflare).

### 4. Portal do Destinatário
- O link do túnel leva a uma página web limpa e moderna:
  - Se houver senha: tela de bloqueio exigindo a senha definida pelo remetente.
  - Exibe o resumo do pacote: nome do pack, quantidade de arquivos, tamanho total e cronômetro regressivo de expiração.
  - Botão **"⬇ Baixar Todos os Arquivos (.ZIP)"**: baixa todo o pacote compactado em um único `.zip`.
  - Lista de arquivos individuais com botão **"⬇ Baixar"** para cada arquivo, permitindo escolher baixar apenas um ou outro.
  - Indicador de pausa em tempo real: se o remetente pausar o túnel, o portal avisa o visitante.

### 5. Botões de Pausa e Cancelamento
- Na lista de transferências da extensão:
  - **⏸ Pausar / ▶ Retomar**: Pausa ou retoma o atendimento às requisições do túnel.
  - **✕ Encerrar / Cancelar**: Destrói o túnel e os arquivos imediatamente.

### 6. Cópia Formatada com Senha e Expiração
- Ao gerar o link ou clicar no botão **"Copiar"**, a mensagem copiada para a área de transferência já inclui todas as informações:
  ```text
  📦 PulseShare — Compartilhamento de Arquivos
  🔗 Link: https://connecting-derived-sees-admissions.trycloudflare.com
  🔑 Senha: [senha configurada ou 'Nenhuma']
  ⏳ Expira em: ~30 min (às 21:05)
  📁 Arquivos (2):
    • relatorio.pdf (2.4 MB)
    • fotos.zip (18.1 MB)
  ```

---

## Arquitetura & Componentes

- **`bin/cloudflared`**: Binário oficial do Cloudflare Tunnel (Quick Tunnels).
- **`daemon.js`**: Daemon complementar local em Node.js (ouvindo em `127.0.0.1:18765`). Gerencia a execução de túneis `cloudflared`, serve o portal temporário e os arquivos com suporte a streaming, HTTP range e empacotamento ZIP sem dependências externas.
- **`pulseshare-daemon.service`**: Unidade `systemd --user` que mantém o daemon rodando silenciosamente em segundo plano no Linux.
- **`extension/`**: Código da extensão Chrome (Manifest V3):
  - `manifest.json`: Configurado com `default_popup` e permissões para `127.0.0.1`.
  - `popup.html` & `popup.js`: Interface fixa com modal de expiração/senha, gerenciador de transferências e botões de controle.
  - `background.js`: Service worker que sincroniza túneis e transferências P2P.

---

## Como Usar

### 1. Iniciar ou Verificar o Daemon
O daemon já está configurado via `systemd --user`:
```bash
systemctl --user status pulseshare-daemon.service
```
Se precisar reiniciar manualmente:
```bash
systemctl --user restart pulseshare-daemon.service
```

### 2. Carregar a Extensão no Chrome
1. Abra `chrome://extensions/` no Google Chrome.
2. Ative o **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactação** (*Load unpacked*) e aponte para a pasta `extension/`.
4. Fixe a extensão na barra de ferramentas.

### 3. Enviar Arquivos
1. Clique no ícone da extensão (abre o menu suspenso abaixo do ícone).
2. Clique no botão laranja: **"Gerar Link Público (Cloudflare Tunnel)"**.
3. Selecione os arquivos desejados.
4. Defina o **tempo de expiração** (ex: 30 minutos) e opcionalmente uma **senha**.
5. Clique em **"Confirmar & Gerar Link"**.
6. O link `*.trycloudflare.com` é gerado em poucos segundos e a mensagem formatada é automaticamente copiada para a sua área de transferência!
