#!/usr/bin/env bash
# Gera o instalador .deb do PulseShare para Linux (amd64).
#   cd desktop && ./build-deb.sh        → dist/pulseshare_<versão>_amd64.deb
# Instalar:  sudo apt install ./dist/pulseshare_<versão>_amd64.deb
#
# O pacote leva o Electron (Chromium embutido) em /opt/PulseShare e o MESMO app
# do celular (app.html + app.js + libs da raiz do repositório) em resources/app/www.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VERSION="$(node -p "require('./package.json').devDependencies.electron")"
DIST_ELECTRON="node_modules/electron/dist"

if [ ! -x "$DIST_ELECTRON/electron" ]; then
  echo "» Baixando o Electron $ELECTRON_VERSION..."
  npm install --no-audit --no-fund
  node node_modules/electron/install.js
fi

PKG="dist/pulseshare_${VERSION}_amd64"
OPT="$PKG/opt/PulseShare"
APP="$OPT/resources/app"
rm -rf "$PKG"
mkdir -p "$OPT" "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/etc/apparmor.d" \
  "$PKG/usr/share/doc/pulseshare"

echo "» Copiando o Electron..."
cp -a "$DIST_ELECTRON/." "$OPT/"
mv "$OPT/electron" "$OPT/pulseshare"
rm -f "$OPT/resources/default_app.asar"

echo "» Copiando o app..."
mkdir -p "$APP/www/sounds" "$APP/www/icons"
cp main.js preload.js "$APP/"
node -e "
const p = require('./package.json');
const out = { name: p.name, productName: p.productName, version: p.version, description: p.description,
  main: 'main.js', desktopName: 'pulseshare.desktop', author: p.author, license: p.license };
require('fs').writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
" "$APP/package.json"
for f in app.html app.js qrcode-core.js jsQR.js pulseshare-crypto-identity.js pulseshare-mesh-engine.js \
         pulseshare-media-viewer.js fflate.min.js tailwind.css; do
  cp "$ROOT/$f" "$APP/www/"
done
cp "$ROOT"/sounds/*.wav "$APP/www/sounds/"
cp "$ROOT"/icons/*.png "$ROOT/icons/icon.svg" "$APP/www/icons/"

# Comando no PATH
ln -s ../../opt/PulseShare/pulseshare "$PKG/usr/bin/pulseshare"

# Ícones do sistema
for s in 16 32 48 128 192 512; do
  d="$PKG/usr/share/icons/hicolor/${s}x${s}/apps"
  mkdir -p "$d"
  cp "$ROOT/icons/icon${s}.png" "$d/pulseshare.png"
done
mkdir -p "$PKG/usr/share/icons/hicolor/scalable/apps"
cp "$ROOT/icons/icon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/pulseshare.svg"

# Atalho no menu de aplicativos (+ links pulseshare://)
cat > "$PKG/usr/share/applications/pulseshare.desktop" <<EOF
[Desktop Entry]
Name=PulseShare
GenericName=Mensagens e arquivos P2P
Comment=Mensagens e arquivos direto entre dispositivos, sem servidor
Exec=/opt/PulseShare/pulseshare %U
Icon=pulseshare
Terminal=false
Type=Application
Categories=Network;InstantMessaging;FileTransfer;
Keywords=chat;mensagens;arquivos;p2p;transferência;
MimeType=x-scheme-handler/pulseshare;
StartupWMClass=PulseShare
StartupNotify=true
EOF

# Ubuntu 23.10+ restringe user namespaces: perfil AppArmor (igual ao do VS Code/Chrome)
cat > "$PKG/etc/apparmor.d/pulseshare" <<'EOF'
# Permite ao sandbox do Chromium do PulseShare usar user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile pulseshare /opt/PulseShare/pulseshare flags=(unconfined) {
  userns,

  include if exists <local/pulseshare>
}
EOF

cat > "$PKG/usr/share/doc/pulseshare/copyright" <<EOF
PulseShare — Ricardo André Zampiva Teixeira
Inclui Electron $ELECTRON_VERSION (MIT) e Chromium (licenças em /opt/PulseShare/LICENSES.chromium.html),
qrcode 1.5.4 (MIT), jsQR 1.4.0 (Apache-2.0) e fflate (MIT).
EOF

# Permissões: sandbox setuid do Chromium (alternativa quando não há user namespaces)
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod go-w {} +
chmod 4755 "$OPT/chrome-sandbox"

INSTALLED_KB="$(du -sk --exclude=DEBIAN "$PKG" | cut -f1)"
cat > "$PKG/DEBIAN/control" <<EOF
Package: pulseshare
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Maintainer: Ricardo André Zampiva Teixeira <ricardoazt@gmail.com>
Installed-Size: $INSTALLED_KB
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libnotify4, libxss1, libxtst6, xdg-utils
Recommends: libappindicator3-1 | libayatana-appindicator3-1
Homepage: https://github.com/ricardoazt/share
Description: PulseShare — mensagens e arquivos P2P sem servidor
 O mesmo app PulseShare do celular, no computador: chat, envio de arquivos
 direto entre dispositivos (WebRTC), links públicos de download e
 notificações. Fechando a janela com "Rodar em segundo plano" ligado, ele
 continua na bandeja do sistema recebendo mensagens.
EOF

cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  chown root:root /opt/PulseShare/chrome-sandbox 2>/dev/null || true
  chmod 4755 /opt/PulseShare/chrome-sandbox 2>/dev/null || true
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser --replace --write-cache /etc/apparmor.d/pulseshare >/dev/null 2>&1 || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
EOF

cat > "$PKG/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser --remove /etc/apparmor.d/pulseshare >/dev/null 2>&1 || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"
echo "/etc/apparmor.d/pulseshare" > "$PKG/DEBIAN/conffiles"

echo "» Gerando o .deb..."
dpkg-deb --root-owner-group -Zxz --build "$PKG" "dist/pulseshare_${VERSION}_amd64.deb" >/dev/null
rm -rf "$PKG"
ls -lh "dist/pulseshare_${VERSION}_amd64.deb"
