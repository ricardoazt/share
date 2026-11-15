#!/usr/bin/env bash
# Gera o PulseShare Relay para servidores Linux:
#   server/dist/pulseshare-relay-<versão>.tar.gz  (instalador + relay + biblioteca de identidade)
#   server/dist/pulseshare-relay-<versão>.sh      (instalador de ARQUIVO ÚNICO: o .tar.gz vai dentro)
#   downloads/pulseshare-relay.sh                 (cópia publicada pelo GitHub Pages)
#
# No servidor (arquivo único):
#   curl -fsSLO https://ricardoazt.github.io/share/downloads/pulseshare-relay.sh
#   sudo bash pulseshare-relay.sh             # instala, cria o serviço e abre o configurador
#   sudo bash pulseshare-relay.sh --uninstall # remove (mantém conta e dados) | --purge apaga tudo
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
VER="$(node "$HERE/pulseshare-relay.js" version)"
OUT="$HERE/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pulseshare-relay" "$OUT" "$ROOT/downloads"
cp "$HERE/install.sh" "$HERE/pulseshare-relay.js" "$HERE/README.md" "$ROOT/pulseshare-crypto-identity.js" "$STAGE/pulseshare-relay/"
chmod 0755 "$STAGE/pulseshare-relay/install.sh"
TAR="$OUT/pulseshare-relay-$VER.tar.gz"
tar -C "$STAGE" --owner=0 --group=0 -czf "$TAR" pulseshare-relay
echo "$TAR"

# Instalador de arquivo único (funciona também com "curl … | sudo bash": aí o configurador
# não abre sozinho, porque não há teclado; rode depois "sudo pulseshare-relay config")
SH="$OUT/pulseshare-relay-$VER.sh"
{
  cat <<EOF
#!/usr/bin/env bash
# PulseShare Relay $VER — instalador de arquivo único (nó da rede PulseShare para servidores Linux)
#
#   sudo bash pulseshare-relay.sh              instala/atualiza, cria o serviço e abre o configurador
#   sudo bash pulseshare-relay.sh --no-config  instala/atualiza sem abrir o configurador
#   sudo bash pulseshare-relay.sh --uninstall  remove o serviço e os programas (mantém conta e dados)
#   sudo bash pulseshare-relay.sh --purge      remove tudo, inclusive a conta
#
# Depois: sudo pulseshare-relay config | pulseshare-relay status | pulseshare-relay logs
set -euo pipefail
if [ "\$(id -u)" -ne 0 ]; then echo "Rode como root: sudo bash \$0 \$*" >&2; exit 1; fi
command -v tar >/dev/null && command -v base64 >/dev/null || { echo "Faltam tar/base64 (coreutils)" >&2; exit 1; }
TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT
base64 -d > "\$TMP/relay.tar.gz" <<'__PULSESHARE_PAYLOAD__'
EOF
  base64 -w 76 "$TAR"
  cat <<'EOF'
__PULSESHARE_PAYLOAD__
tar -xzf "$TMP/relay.tar.gz" -C "$TMP"
bash "$TMP/pulseshare-relay/install.sh" "$@"
EOF
} > "$SH"
chmod 0755 "$SH"
bash -n "$SH"
cp "$SH" "$ROOT/downloads/pulseshare-relay.sh"
echo "$SH"
echo "$ROOT/downloads/pulseshare-relay.sh"
