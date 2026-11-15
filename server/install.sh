#!/usr/bin/env bash
# PulseShare Relay — instalador para servidores Linux (Debian/Ubuntu e derivados com systemd)
#
#   sudo ./install.sh              instala/atualiza, cria o serviço e abre o configurador
#   sudo ./install.sh --no-config  instala/atualiza sem abrir o configurador
#   sudo ./install.sh --uninstall  remove o serviço e os programas (mantém /etc e /var/lib)
#   sudo ./install.sh --purge      remove tudo, inclusive a conta e os dados
#
# Depois de instalado:  sudo pulseshare-relay config   (reconfigura a qualquer momento)
#                       pulseshare-relay status | logs | restart
set -euo pipefail

APP_DIR=/opt/pulseshare-relay
CONF_DIR=/etc/pulseshare-relay
DATA_DIR=/var/lib/pulseshare-relay
BIN=/usr/local/bin/pulseshare-relay
UNIT=/etc/systemd/system/pulseshare-relay.service
SVC_USER=pulseshare
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErro:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "rode como root: sudo $0 $*"
command -v systemctl >/dev/null || die "este instalador precisa do systemd"

uninstall() {
  say "Parando e removendo o serviço"
  systemctl disable --now pulseshare-relay 2>/dev/null || true
  rm -f "$UNIT" "$BIN"
  systemctl daemon-reload
  rm -rf "$APP_DIR"
  if [ "${1:-}" = purge ]; then
    say "Apagando a conta e os dados ($CONF_DIR, $DATA_DIR)"
    rm -rf "$CONF_DIR" "$DATA_DIR"
    if grep -qs "pulseshare-relay" /etc/turnserver.conf; then
      systemctl disable --now coturn 2>/dev/null || true
      [ -f /etc/turnserver.conf.orig ] && mv -f /etc/turnserver.conf.orig /etc/turnserver.conf || rm -f /etc/turnserver.conf
    fi
    userdel "$SVC_USER" 2>/dev/null || true
  else
    say "Conta e dados mantidos em $CONF_DIR e $DATA_DIR (use --purge para apagar)"
  fi
  exit 0
}

case "${1:-}" in
  --uninstall) uninstall ;;
  --purge) uninstall purge ;;
esac

# ---------------------------------------------------------------- arquivos ----
SRC_JS="$HERE/pulseshare-relay.js"
CRYPTO_JS="$HERE/pulseshare-crypto-identity.js"
[ -f "$CRYPTO_JS" ] || CRYPTO_JS="$HERE/../pulseshare-crypto-identity.js"
[ -f "$SRC_JS" ] || die "pulseshare-relay.js não está ao lado do instalador"
[ -f "$CRYPTO_JS" ] || die "pulseshare-crypto-identity.js não encontrado (use o pacote .tar.gz completo)"

# ------------------------------------------------------------------ Node.js ----
node_major() { node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  if command -v apt-get >/dev/null; then
    say "Instalando o Node.js (apt)"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null; then
    say "Instalando o Node.js (dnf)"
    dnf install -y -q nodejs
  fi
fi
[ "$(node_major)" -ge 18 ] || die "é preciso Node.js 18 ou mais novo (encontrado: $(node -v 2>/dev/null || echo nenhum)). Veja https://nodejs.org/ ou NodeSource."
NODE_BIN="$(command -v node)"
say "Node.js $(node -v) em $NODE_BIN"

# ----------------------------------------------------------- usuário/pastas ----
if ! id "$SVC_USER" >/dev/null 2>&1; then
  say "Criando o usuário de sistema $SVC_USER"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0644 "$SRC_JS" "$APP_DIR/pulseshare-relay.js"
install -m 0644 "$CRYPTO_JS" "$APP_DIR/pulseshare-crypto-identity.js"
install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
[ -f "$CONF_DIR/config.json" ] && chgrp "$SVC_USER" "$CONF_DIR/config.json" && chmod 0640 "$CONF_DIR/config.json"

cat > "$BIN" <<EOF
#!/bin/sh
# PulseShare Relay — comando de administração
case "\$1" in
  logs) exec journalctl -u pulseshare-relay -f -n 100 ;;
  restart|start|stop) exec systemctl "\$1" pulseshare-relay ;;
  config|account)
    if [ "\$(id -u)" -ne 0 ]; then exec sudo "\$0" "\$@"; fi ;;
esac
exec "$NODE_BIN" "$APP_DIR/pulseshare-relay.js" "\$@"
EOF
chmod 0755 "$BIN"

# ------------------------------------------------------------------ serviço ----
cat > "$UNIT" <<EOF
[Unit]
Description=PulseShare Relay (nó da rede PulseShare)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
ExecStart=$NODE_BIN $APP_DIR/pulseshare-relay.js run
Restart=always
RestartSec=5
Environment=PULSESHARE_RELAY_CONFIG=$CONF_DIR/config.json
Environment=PULSESHARE_RELAY_DATA=$DATA_DIR
# Endurecimento: só escreve na pasta de dados
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR
ReadOnlyPaths=$CONF_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pulseshare-relay >/dev/null 2>&1

say "Instalado: $APP_DIR (comando: pulseshare-relay)"

if [ "${1:-}" != "--no-config" ] && [ -t 0 ]; then
  "$BIN" config
else
  systemctl restart pulseshare-relay
fi

echo
say "Pronto. Comandos úteis:"
echo "   sudo pulseshare-relay config     # conta, nome do perfil, banda, tráfego, conexões, TURN"
echo "   pulseshare-relay status          # situação"
echo "   pulseshare-relay logs            # registro ao vivo"
