#!/usr/bin/env node
/**
 * PulseShare Companion Daemon
 * Responsável por gerenciar túneis Cloudflare Quick Tunnels (trycloudflare.com),
 * hospedar o portal temporário de download e servir arquivos sob demanda com
 * senha opcional, expiração automática e autodestruição no cancelamento.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');

const DAEMON_PORT = 18765;
const CLOUDFLARED_BIN = path.join(__dirname, 'bin', 'cloudflared');
const TEMP_BASE_DIR = path.join(os.tmpdir(), 'pulseshare');

// Garante que o diretório base temporário existe
if (!fs.existsSync(TEMP_BASE_DIR)) {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });
}

// Mapa de túneis ativos: shareId -> TunnelRecord
const activeTunnels = new Map();

// Helper CRC32 para geração de ZIP sem dependências externas
const CRC_TABLE = (() => {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function calcCrc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * Cria um arquivo .ZIP em buffer a partir de uma lista de arquivos no disco
 */
function createZipBuffer(filesList) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of filesList) {
    if (!fs.existsSync(file.diskPath)) continue;
    const fileData = fs.readFileSync(file.diskPath);
    const nameBuf = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(fileData);
    const crc = calcCrc32(fileData);
    const uncompressedSize = fileData.length;
    const compressedSize = compressed.length;

    // Local file header (30 bytes)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8
    lh.writeUInt16LE(8, 8);      // Deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const fileOffset = offset;
    localHeaders.push(lh, nameBuf, compressed);
    offset += 30 + nameBuf.length + compressedSize;

    // Central directory header (46 bytes)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); // UTF-8
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressedSize, 20);
    ch.writeUInt32LE(uncompressedSize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(fileOffset, 42);

    centralHeaders.push(ch, nameBuf);
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirBuf.length;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(filesList.length, 8);
  eocd.writeUInt16LE(filesList.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

/**
 * Retorna o HTML do portal temporário servido pelo túnel Cloudflare
 */
function getPortalHtml(tunnel) {
  const safeTitle = (tunnel.packName || 'Pack de Arquivos').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const totalSizeFormatted = formatBytes(tunnel.totalSize || 0);
  const fileCount = tunnel.files.length;
  const hasPassword = Boolean(tunnel.password);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Download PulseShare (Cloudflare Tunnel)</title>
  <style>
    *, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid #334155; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      max-width: 480px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 20px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 14px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, #f97316, #ea580c);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 900;
      font-size: 16px;
      box-shadow: 0 4px 12px rgba(234, 88, 12, 0.35);
    }
    .brand-title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.01em;
    }
    .brand-sub {
      font-size: 10px;
      color: #94a3b8;
    }
    .tunnel-badge {
      font-size: 10px;
      font-weight: 700;
      font-family: monospace;
      color: #fb923c;
      background: rgba(249, 115, 22, 0.12);
      border: 1px solid rgba(249, 115, 22, 0.3);
      padding: 3px 8px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .dot-live {
      width: 6px;
      height: 6px;
      background: #22c55e;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.9); } }
    
    .pack-info {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pack-name {
      font-size: 16px;
      font-weight: 700;
      color: #f1f5f9;
      word-break: break-word;
    }
    .pack-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 11px;
      color: #94a3b8;
    }
    .timer-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: #f59e0b;
      font-family: monospace;
      font-weight: 600;
    }

    .btn-main {
      width: 100%;
      padding: 12px 16px;
      border-radius: 12px;
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 4px 15px rgba(234, 88, 12, 0.3);
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .btn-main:hover {
      background: linear-gradient(135deg, #fb923c, #f97316);
      transform: translateY(-1px);
    }
    .btn-main:active {
      transform: translateY(0);
    }

    .files-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 280px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .file-card {
      background: #162032;
      border: 1px solid #233149;
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      transition: border-color 0.15s;
    }
    .file-card:hover {
      border-color: #3b82f6;
    }
    .file-details {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }
    .file-icon {
      font-size: 20px;
      flex-shrink: 0;
    }
    .file-texts {
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .file-title {
      font-size: 13px;
      font-weight: 600;
      color: #e2e8f0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-size {
      font-size: 10px;
      color: #64748b;
      font-family: monospace;
    }
    .btn-download-file {
      padding: 6px 12px;
      border-radius: 8px;
      background: #1e293b;
      color: #38bdf8;
      border: 1px solid #334155;
      font-size: 11px;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
      transition: all 0.15s;
      cursor: pointer;
    }
    .btn-download-file:hover {
      background: #0284c7;
      color: #fff;
      border-color: #0284c7;
    }

    .password-lock {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      text-align: center;
    }
    .password-input {
      width: 100%;
      background: #090d16;
      border: 1px solid #475569;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      color: #fff;
      outline: none;
      font-family: monospace;
      text-align: center;
    }
    .password-input:focus {
      border-color: #f97316;
    }
    .password-error {
      color: #f87171;
      font-size: 11px;
      display: none;
    }

    .paused-banner {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fde68a;
      padding: 12px;
      border-radius: 10px;
      font-size: 12px;
      display: none;
      text-align: center;
    }

    .footer {
      border-top: 1px solid #1e293b;
      padding-top: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #64748b;
    }
    .footer a {
      color: #94a3b8;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div>
          <div class="brand-title">PulseShare</div>
          <div class="brand-sub">Túnel Temporário Cloudflare</div>
        </div>
      </div>
      <div class="tunnel-badge">
        <span class="dot-live"></span>
        <span>TRYCLOUDFLARE</span>
      </div>
    </div>

    <!-- Banner se o túnel estiver pausado -->
    <div id="banner-paused" class="paused-banner">
      ⏸ <strong>Envio Pausado</strong><br />
      O remetente pausou temporariamente as transferências deste túnel. Aguarde alguns instantes.
    </div>

    <!-- Tela de Desbloqueio por Senha (se houver senha) -->
    <div id="password-screen" class="password-lock" style="${hasPassword ? '' : 'display:none;'}">
      <div style="font-size:32px;">🔒</div>
      <div style="font-size:14px; font-weight:700; color:#f8fafc;">Este pack está protegido por senha</div>
      <div style="font-size:11px; color:#94a3b8;">Insira a senha fornecida pelo remetente para ter acesso aos arquivos:</div>
      <input type="password" id="input-password" class="password-input" placeholder="Digite a senha..." spellcheck="false" />
      <div id="password-error" class="password-error">Senha incorreta. Tente novamente.</div>
      <button id="btn-unlock" class="btn-main" type="button">Desbloquear Arquivos</button>
    </div>

    <!-- Conteúdo Principal dos Arquivos (Exibido após validação de senha ou se for público) -->
    <div id="content-screen" style="${hasPassword ? 'display:none;' : ''} display:flex; flex-direction:column; gap:14px;">
      <div class="pack-info">
        <div class="pack-name">${safeTitle}</div>
        <div class="pack-meta">
          <span>📁 ${fileCount} ${fileCount === 1 ? 'arquivo' : 'arquivos'}</span>
          <span>•</span>
          <span>💾 ${totalSizeFormatted}</span>
          ${tunnel.expiresAt ? `<span>•</span><span class="timer-badge">⏳ <span id="countdown">Calculando...</span></span>` : ''}
        </div>
      </div>

      <a id="btn-download-all" href="/download-all" class="btn-main">
        <span>⬇ Baixar Todos os Arquivos (.ZIP)</span>
      </a>

      <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#94a3b8; margin-top:2px;">
        Arquivos no Pack (${fileCount})
      </div>

      <div class="files-list">
        ${tunnel.files.map((f, i) => `
          <div class="file-card">
            <div class="file-details">
              <span class="file-icon">${getFileIcon(f.name)}</span>
              <div class="file-texts">
                <span class="file-title" title="${f.name.replace(/"/g, '&quot;')}">${f.name.replace(/</g, '&lt;')}</span>
                <span class="file-size">${formatBytes(f.size)}</span>
              </div>
            </div>
            <a href="/download/${i}" class="btn-download-file" download="${f.name.replace(/"/g, '&quot;')}">
              ⬇ Baixar
            </a>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="footer">
      <span>Conexão criptografada ponta a ponta</span>
      <span>PulseShare Serverless</span>
    </div>
  </div>

  <script>
    const hasPassword = ${hasPassword ? 'true' : 'false'};
    const expiresAt = ${tunnel.expiresAt ? Number(tunnel.expiresAt) : 'null'};

    // Validação de Senha
    if (hasPassword) {
      const btnUnlock = document.getElementById('btn-unlock');
      const inputPassword = document.getElementById('input-password');
      const pwdError = document.getElementById('password-error');
      const pwdScreen = document.getElementById('password-screen');
      const contentScreen = document.getElementById('content-screen');

      async function verifyPassword() {
        const pwd = inputPassword.value;
        try {
          const res = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
          });
          const data = await res.json();
          if (data && data.valid) {
            pwdScreen.style.display = 'none';
            contentScreen.style.display = 'flex';
          } else {
            pwdError.style.display = 'block';
          }
        } catch (e) {
          pwdError.textContent = 'Erro ao verificar senha.';
          pwdError.style.display = 'block';
        }
      }

      btnUnlock.addEventListener('click', verifyPassword);
      inputPassword.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyPassword();
      });
    }

    // Contador regressivo de expiração
    if (expiresAt) {
      const cdEl = document.getElementById('countdown');
      function updateTimer() {
        const now = Date.now();
        const diff = expiresAt - now;
        if (diff <= 0) {
          if (cdEl) cdEl.textContent = 'Expirado';
          document.body.innerHTML = '<div class="wrapper" style="text-align:center;"><div style="font-size:36px;margin-bottom:12px;">⏰</div><h2>Este link temporário expirou</h2><p style="color:#94a3b8;font-size:12px;margin-top:6px;">O túnel Cloudflare e os arquivos foram encerrados pelo remetente.</p></div>';
          return;
        }
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        if (cdEl) cdEl.textContent = m + 'm ' + s + 's';
      }
      setInterval(updateTimer, 1000);
      updateTimer();
    }

    // Checagem periódica de status (Pausa/Cancelamento)
    setInterval(async () => {
      try {
        const res = await fetch('/api/heartbeat');
        if (!res.ok) throw new Error('Offline');
        const data = await res.json();
        const pausedBanner = document.getElementById('banner-paused');
        if (data.paused) {
          pausedBanner.style.display = 'block';
        } else {
          pausedBanner.style.display = 'none';
        }
      } catch (err) {
        // Se a requisição falhar completamente, o túnel foi cancelado/derrubado
        document.body.innerHTML = '<div class="wrapper" style="text-align:center;"><div style="font-size:36px;margin-bottom:12px;">✕</div><h2>Túnel encerrado</h2><p style="color:#94a3b8;font-size:12px;margin-top:6px;">O compartilhamento foi cancelado pelo remetente ou o tempo expirou.</p></div>';
      }
    }, 3000);
  </script>
</body>
</html>`;
}

function getFileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼️';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '📦';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx', 'odt', 'txt', 'md'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['iso', 'img', 'dmg'].includes(ext)) return '💿';
  return '📁';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function guessMimeType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json',
    csv: 'text/csv; charset=utf-8',
    html: 'text/html; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}

let activeFilePickerPromise = null;

/**
 * Abre o seletor nativo de arquivos do sistema operacional via zenity
 * sem depender do DOM volátil do popup do Chrome.
 */
function pickFilesWithNativeDialog() {
  if (activeFilePickerPromise) {
    return activeFilePickerPromise;
  }

  activeFilePickerPromise = new Promise((resolve) => {
    const proc = spawn(
      'zenity',
      [
        '--file-selection',
        '--multiple',
        '--separator=\n',
        '--title=PulseShare — Selecione os arquivos para compartilhar'
      ],
      {
        env: { ...process.env }
      }
    );

    let stdout = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.on('close', (code) => {
      activeFilePickerPromise = null;
      if (code !== 0 || !stdout.trim()) {
        return resolve({ ok: true, cancelled: true, files: [] });
      }

      const paths = stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);

      const files = [];
      for (const filePath of paths) {
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              const name = path.basename(filePath);
              files.push({
                fileId: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                name,
                size: stat.size,
                type: guessMimeType(name),
                diskPath: filePath
              });
            }
          }
        } catch (err) {
          console.error('[PulseShare Daemon] Erro ao ler arquivo selecionado:', filePath, err);
        }
      }

      resolve({
        ok: true,
        cancelled: files.length === 0,
        files
      });
    });

    proc.on('error', (err) => {
      activeFilePickerPromise = null;
      console.error('[PulseShare Daemon] Erro ao iniciar zenity:', err);
      resolve({ ok: false, error: err.message, files: [] });
    });
  });

  return activeFilePickerPromise;
}

/**
 * Encerra e destrói um túnel Cloudflare e remove seus arquivos temporários do disco
 */
function destroyTunnel(shareId) {
  const tunnel = activeTunnels.get(shareId);
  if (!tunnel) return false;

  console.log(`[PulseShare Daemon] Encerrando túnel ${shareId} e destruindo arquivos...`);

  // Cancela timer de expiração
  if (tunnel.expirationTimer) {
    clearTimeout(tunnel.expirationTimer);
  }

  // Mata processo cloudflared
  if (tunnel.process) {
    try {
      tunnel.process.kill('SIGTERM');
      setTimeout(() => {
        try { tunnel.process.kill('SIGKILL'); } catch {}
      }, 1000);
    } catch (e) {
      console.error(`Erro ao matar processo do túnel ${shareId}:`, e);
    }
  }

  // Encerra servidor HTTP efêmero
  if (tunnel.server) {
    try {
      tunnel.server.close();
    } catch {}
  }

  // Remove pasta temporária e arquivos do disco
  const tunnelDir = path.join(TEMP_BASE_DIR, shareId);
  try {
    if (fs.existsSync(tunnelDir)) {
      fs.rmSync(tunnelDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`Erro ao limpar pasta temporária ${tunnelDir}:`, e);
  }

  activeTunnels.delete(shareId);
  console.log(`[PulseShare Daemon] Túnel ${shareId} completamente desfeito.`);
  return true;
}

/**
 * Inicia o servidor HTTP efêmero para um túnel específico
 */
function startEphemeralServer(tunnel) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // CORS básico
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = urlObj.pathname;

      // Heartbeat para checar se o túnel ainda está vivo ou pausado
      if (pathname === '/api/heartbeat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused: Boolean(tunnel.paused) }));
        return;
      }

      // Se estiver pausado pelo remetente
      if (tunnel.paused && pathname.startsWith('/download')) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>Envio temporariamente pausado pelo remetente.</h3><p>Aguarde e recarregue a página em instantes.</p>`);
        return;
      }

      // Verificação de senha
      if (pathname === '/api/verify' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const submittedPassword = (data.password || '').trim();
            const valid = (!tunnel.password) || (submittedPassword === tunnel.password);
            if (valid) {
              res.setHeader('Set-Cookie', `ps_token_${tunnel.shareId}=1; Path=/; SameSite=Lax; HttpOnly`);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ valid }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ valid: false }));
          }
        });
        return;
      }

      // Verificação de autenticação para downloads quando houver senha configurada
      if (tunnel.password && (pathname === '/download-all' || pathname.startsWith('/download/'))) {
        const cookieHeader = req.headers.cookie || '';
        const isAuthorized = cookieHeader.includes(`ps_token_${tunnel.shareId}=1`) || urlObj.searchParams.get('pwd') === tunnel.password;
        if (!isAuthorized) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h3>Acesso protegido por senha.</h3><p>Desbloqueie o pack no portal antes de baixar.</p><a href="/">Voltar ao portal</a>`);
          return;
        }
      }

      // Download de todos os arquivos em formato .ZIP
      if (pathname === '/download-all') {
        console.log(`[PulseShare] Requisição de Download All (ZIP) para o pack "${tunnel.packName}"`);
        tunnel.downloads = (tunnel.downloads || 0) + 1;
        try {
          const zipBuffer = createZipBuffer(tunnel.files);
          const zipFileName = `${tunnel.packName.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(zipFileName)}"`,
            'Content-Length': zipBuffer.length
          });
          res.end(zipBuffer);
        } catch (err) {
          console.error('[PulseShare] Erro ao gerar ZIP:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Erro ao empacotar arquivo ZIP.');
        }
        return;
      }

      // Download de um arquivo individual: /download/:index
      if (pathname.startsWith('/download/')) {
        const indexStr = pathname.split('/')[2];
        const index = parseInt(indexStr, 10);
        const file = tunnel.files[index];

        if (!file || !fs.existsSync(file.diskPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Arquivo não encontrado.');
          return;
        }

        console.log(`[PulseShare] Baixando arquivo ${index}: "${file.name}" (${file.size} bytes)`);
        tunnel.downloads = (tunnel.downloads || 0) + 1;

        const stat = fs.statSync(file.diskPath);
        const range = req.headers.range;

        if (range) {
          // Suporte a HTTP Range para retomar download e progresso nativo
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          const chunksize = (end - start) + 1;
          const stream = fs.createReadStream(file.diskPath, { start, end });

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
          });
          stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
            'Accept-Ranges': 'bytes'
          });
          fs.createReadStream(file.diskPath).pipe(res);
        }
        return;
      }

      // Rota raiz: serve o portal interativo
      if (pathname === '/' || pathname === '/index.html') {
        const html = getPortalHtml(tunnel);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Não encontrado.');
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      tunnel.localPort = port;
      tunnel.server = server;
      console.log(`[PulseShare Daemon] Servidor efêmero para ${tunnel.shareId} ouvindo em 127.0.0.1:${port}`);
      resolve(port);
    });

    server.on('error', reject);
  });
}

/**
 * Cria e inicia o processo do túnel Cloudflare (cloudflared)
 */
function spawnCloudflareTunnel(tunnel) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLOUDFLARED_BIN)) {
      return reject(new Error(`Binário do cloudflared não encontrado em ${CLOUDFLARED_BIN}`));
    }

    console.log(`[PulseShare Daemon] Iniciando túnel Cloudflare para porta local ${tunnel.localPort}...`);

    const proc = spawn(CLOUDFLARED_BIN, [
      'tunnel',
      '--url',
      `http://127.0.0.1:${tunnel.localPort}`
    ]);

    tunnel.process = proc;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout aguardando URL do túnel Cloudflare (15s).'));
      }
    }, 15000);

    function checkOutput(chunk) {
      const text = chunk.toString();
      // Procura URL no formato https://*.trycloudflare.com
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnel.tunnelUrl = match[0];
        console.log(`[PulseShare Daemon] ✓ Túnel ativo com sucesso: ${tunnel.tunnelUrl}`);
        resolve(tunnel.tunnelUrl);
      }
    }

    proc.stdout.on('data', checkOutput);
    proc.stderr.on('data', checkOutput);

    proc.on('close', (code) => {
      console.log(`[PulseShare Daemon] Processo cloudflared (${tunnel.shareId}) encerrou com código ${code}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Processo cloudflared encerrou prematuramente com código ${code}`));
      }
      // Se fechou inesperadamente, limpa o túnel
      if (activeTunnels.has(tunnel.shareId)) {
        destroyTunnel(tunnel.shareId);
      }
    });

    proc.on('error', (err) => {
      console.error(`[PulseShare Daemon] Falha ao executar cloudflared:`, err);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

/**
 * Servidor Principal do Daemon em 127.0.0.1:18765
 */
const daemonServer = http.createServer((req, res) => {
  // CORS universal para a extensão Chrome
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Status / Health check
  if (pathname === '/health' || pathname === '/api/status') {
    const tunnelsList = Array.from(activeTunnels.values()).map(t => ({
      shareId: t.shareId,
      packName: t.packName,
      fileCount: t.files.length,
      totalSize: t.totalSize,
      tunnelUrl: t.tunnelUrl,
      expiresAt: t.expiresAt,
      paused: Boolean(t.paused),
      downloads: t.downloads || 0,
      createdAt: t.createdAt
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: '2.3.0',
      cloudflaredAvailable: fs.existsSync(CLOUDFLARED_BIN),
      activeTunnels: tunnelsList
    }));
    return;
  }

  // 0A. Seletor nativo de arquivos (via zenity no daemon, imune ao fechamento do popup do Chrome)
  if (pathname === '/api/pick-files' && req.method === 'POST') {
    pickFilesWithNativeDialog().then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // 0B. Listagem rápida de arquivos locais (para seleção direta dentro do popup sem fechar)
  if (pathname === '/api/fs/list' && req.method === 'GET') {
    const homeDir = os.homedir();
    const requestedDir = urlObj.searchParams.get('dir') || homeDir;
    const targetDir = path.resolve(requestedDir);

    const shortcuts = [
      { label: '🏠 Início', path: homeDir },
      { label: '⬇ Downloads', path: path.join(homeDir, 'Downloads') },
      { label: '📄 Documentos', path: path.join(homeDir, 'Documentos') },
      { label: '📄 Documents', path: path.join(homeDir, 'Documents') },
      { label: '🖼 Imagens', path: path.join(homeDir, 'Imagens') },
      { label: '🖥 Desktop', path: path.join(homeDir, 'Área de trabalho') },
      { label: '🖥 Desktop', path: path.join(homeDir, 'Desktop') }
    ].filter((s, idx, arr) => fs.existsSync(s.path) && arr.findIndex((x) => x.path === s.path) === idx);

    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const folders = [];
      const files = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // Oculta arquivos ocultos por padrão
        const fullPath = path.join(targetDir, entry.name);
        try {
          if (entry.isDirectory()) {
            folders.push({ name: entry.name, path: fullPath });
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            files.push({
              fileId: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              name: entry.name,
              size: stat.size,
              type: guessMimeType(entry.name),
              diskPath: fullPath,
              mtime: stat.mtimeMs
            });
          }
        } catch {}
      }

      folders.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => b.mtime - a.mtime); // Mais recentes primeiro

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          currentDir: targetDir,
          parentDir: path.dirname(targetDir),
          shortcuts,
          folders,
          files: files.slice(0, 150)
        })
      );
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message, shortcuts }));
    }
    return;
  }

  // 0C. Leitura de arquivo local para envio P2P WebRTC quando selecionado via daemon
  if (pathname === '/api/read-local-file' && req.method === 'GET') {
    const filePath = urlObj.searchParams.get('path');
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Arquivo local não encontrado.' }));
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      const name = path.basename(filePath);
      res.writeHead(200, {
        'Content-Type': guessMimeType(name),
        'Content-Length': stat.size,
        'X-File-Name': encodeURIComponent(name)
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 1. Inicializar sessão de túnel
  if (pathname === '/api/tunnel/session' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const shareId = data.shareId || `cf-${Date.now().toString(36)}`;
        const packDir = path.join(TEMP_BASE_DIR, shareId);

        if (!fs.existsSync(packDir)) {
          fs.mkdirSync(packDir, { recursive: true });
        }

        const expiresInMinutes = Number(data.expiresInMinutes || 30);
        const expiresAt = expiresInMinutes > 0 ? Date.now() + expiresInMinutes * 60 * 1000 : null;

        const tunnelRecord = {
          shareId,
          packName: data.packName || 'Pack de Arquivos',
          password: (data.password || '').trim(),
          expiresInMinutes,
          expiresAt,
          paused: false,
          downloads: 0,
          createdAt: Date.now(),
          files: (data.files || []).map((f, i) => {
            const hasDirectPath = f.diskPath && fs.existsSync(f.diskPath);
            return {
              index: i,
              name: f.name,
              size: f.size,
              type: f.type || guessMimeType(f.name),
              alreadyOnDisk: Boolean(hasDirectPath),
              diskPath: hasDirectPath
                ? f.diskPath
                : path.join(packDir, `${i}_${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
            };
          }),
          totalSize: data.totalSize || 0
        };

        activeTunnels.set(shareId, tunnelRecord);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, shareId, expiresAt }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 2. Upload de arquivo para uma sessão aberta
  if (pathname === '/api/tunnel/upload-file' && req.method === 'POST') {
    const shareId = urlObj.searchParams.get('shareId');
    const fileIndex = parseInt(urlObj.searchParams.get('fileIndex') || '0', 10);
    const tunnel = activeTunnels.get(shareId);

    if (!tunnel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Sessão de túnel não encontrada.' }));
      return;
    }

    const fileMeta = tunnel.files[fileIndex];
    if (!fileMeta) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Metadados do arquivo não encontrados.' }));
      return;
    }

    const writeStream = fs.createWriteStream(fileMeta.diskPath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      console.log(`[PulseShare Daemon] Arquivo salvo: ${fileMeta.name} (${fileMeta.size}B) para sessão ${shareId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fileIndex, name: fileMeta.name }));
    });

    writeStream.on('error', (err) => {
      console.error(`[PulseShare Daemon] Erro gravando arquivo:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // 3. Iniciar o túnel Cloudflare e gerar a URL *.trycloudflare.com
  if (pathname === '/api/tunnel/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const shareId = data.shareId;
        const tunnel = activeTunnels.get(shareId);

        if (!tunnel) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Sessão não encontrada.' }));
          return;
        }

        // Inicia servidor HTTP local efêmero
        await startEphemeralServer(tunnel);

        // Inicia processo cloudflared
        const tunnelUrl = await spawnCloudflareTunnel(tunnel);

        // Configura autodestruição no tempo de expiração
        if (tunnel.expiresAt) {
          const remainingMs = Math.max(1000, tunnel.expiresAt - Date.now());
          tunnel.expirationTimer = setTimeout(() => {
            console.log(`[PulseShare Daemon] Tempo de expiração esgotado para ${shareId}. Destruindo túnel...`);
            destroyTunnel(shareId);
          }, remainingMs);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          shareId,
          tunnelUrl,
          expiresAt: tunnel.expiresAt,
          packName: tunnel.packName,
          files: tunnel.files.map(f => ({ name: f.name, size: f.size }))
        }));
      } catch (err) {
        console.error(`[PulseShare Daemon] Erro ao iniciar túnel:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 4. Pausar túnel
  if (pathname === '/api/tunnel/pause' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const tunnel = activeTunnels.get(data.shareId);
        if (tunnel) {
          tunnel.paused = true;
          console.log(`[PulseShare Daemon] Túnel ${data.shareId} pausado.`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // 5. Retomar túnel
  if (pathname === '/api/tunnel/resume' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const tunnel = activeTunnels.get(data.shareId);
        if (tunnel) {
          tunnel.paused = false;
          console.log(`[PulseShare Daemon] Túnel ${data.shareId} retomado.`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused: false }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // 6. Cancelar / Encerrar túnel (Destrói tudo: mata processo, fecha porta, apaga arquivos)
  if (pathname === '/api/tunnel/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const destroyed = destroyTunnel(data.shareId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, destroyed }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('PulseShare Daemon Endpoint não encontrado.');
});

// Tratamento de encerramento limpo do daemon
function cleanupAll() {
  console.log('[PulseShare Daemon] Encerrando daemon e limpando todos os túneis ativos...');
  for (const shareId of activeTunnels.keys()) {
    destroyTunnel(shareId);
  }
  process.exit(0);
}

process.on('SIGINT', cleanupAll);
process.on('SIGTERM', cleanupAll);

daemonServer.listen(DAEMON_PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`⚡ PulseShare Companion Daemon ativo em 127.0.0.1:${DAEMON_PORT}`);
  console.log(`📁 Cloudflared binário: ${CLOUDFLARED_BIN}`);
  console.log(`=======================================================`);
});
