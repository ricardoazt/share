#!/usr/bin/env bash
# Gera o instalador .deb do PulseSharePanel (painel administrativo) para Linux amd64.
#   cd panel && ./build-deb.sh        → dist/pulseshare-panel_<versão>_amd64.deb
# Instalar:  sudo apt install ./dist/pulseshare-panel_<versão>_amd64.deb
#
# O pacote NÃO leva a chave do administrador: ela fica em
# ~/.config/PulseSharePanel/admin-key.pem (importe pelo painel em outro computador).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VERSION="$(node -p "require('./package.json').devDependencies.electron")"
DIST_ELECTRON="node_modules/electron/dist"

# Reaproveita o Electron do app de desktop quando for a mesma versão (evita baixar 100 MB de novo)
if [ ! -x "$DIST_ELECTRON/electron" ]; then
  DESK="$ROOT/desktop/node_modules/electron"
  if [ -x "$DESK/dist/electron" ] && [ "$(node -p "require('$DESK/package.json').version")" = "$ELECTRON_VERSION" ]; then
    DIST_ELECTRON="$DESK/dist"
  else
    echo "» Baixando o Electron $ELECTRON_VERSION..."
    npm install --no-audit --no-fund
    node node_modules/electron/install.js
  fi
fi

PKG="dist/pulseshare-panel_${VERSION}_amd64"
OPT="$PKG/opt/PulseSharePanel"
APP="$OPT/resources/app"
rm -rf "$PKG"
mkdir -p "$OPT" "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/etc/apparmor.d" \
  "$PKG/usr/share/doc/pulseshare-panel"

echo "» Copiando o Electron..."
cp -a "$DIST_ELECTRON/." "$OPT/"
mv "$OPT/electron" "$OPT/pulseshare-panel"
rm -f "$OPT/resources/default_app.asar"

echo "» Copiando o painel..."
mkdir -p "$APP/www/icons"
cp main.js preload.js "$APP/"
cp www/panel.html www/panel.css www/panel.js "$APP/www/"
cp "$ROOT"/icons/*.png "$ROOT/icons/icon.svg" "$APP/www/icons/"
node -e "
const p = require('./package.json');
const out = { name: p.name, productName: p.productName, version: p.version, description: p.description,
  main: 'main.js', desktopName: 'pulseshare-panel.desktop', author: p.author, license: p.license };
require('fs').writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
" "$APP/package.json"

ln -s ../../opt/PulseSharePanel/pulseshare-panel "$PKG/usr/bin/pulseshare-panel"

for s in 16 32 48 128 192 512; do
  d="$PKG/usr/share/icons/hicolor/${s}x${s}/apps"
  mkdir -p "$d"
  cp "$ROOT/icons/icon${s}.png" "$d/pulseshare-panel.png"
done
mkdir -p "$PKG/usr/share/icons/hicolor/scalable/apps"
cp "$ROOT/icons/icon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/pulseshare-panel.svg"

cat > "$PKG/usr/share/applications/pulseshare-panel.desktop" <<DESK
[Desktop Entry]
Name=PulseSharePanel
GenericName=Painel administrativo do PulseShare
Comment=Usuários, mensagens para todos e exclusão de contas na rede PulseShare
Exec=/opt/PulseSharePanel/pulseshare-panel %U
Icon=pulseshare-panel
Terminal=false
Type=Application
Categories=Network;System;
Keywords=pulseshare;admin;painel;usuários;
StartupWMClass=PulseSharePanel
StartupNotify=true
DESK

# Ubuntu 23.10+ restringe user namespaces: perfil AppArmor para o sandbox do Chromium
cat > "$PKG/etc/apparmor.d/pulseshare-panel" <<'AA'
# Permite ao sandbox do Chromium do PulseSharePanel usar user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile pulseshare-panel /opt/PulseSharePanel/pulseshare-panel flags=(unconfined) {
  userns,

  include if exists <local/pulseshare-panel>
}
AA

cat > "$PKG/usr/share/doc/pulseshare-panel/copyright" <<COPY
PulseSharePanel — Ricardo André Zampiva Teixeira
Inclui Electron $ELECTRON_VERSION (MIT) e Chromium (licenças em /opt/PulseSharePanel/LICENSES.chromium.html).
COPY

find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod go-w {} +
chmod 4755 "$OPT/chrome-sandbox"

INSTALLED_KB="$(du -sk --exclude=DEBIAN "$PKG" | cut -f1)"
cat > "$PKG/DEBIAN/control" <<CTRL
Package: pulseshare-panel
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Maintainer: Ricardo André Zampiva Teixeira <ricardoazt@gmail.com>
Installed-Size: $INSTALLED_KB
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxss1, libxtst6, xdg-utils
Homepage: https://github.com/ricardoazt/share
Description: PulseSharePanel — painel administrativo da rede PulseShare
 Lista todos os usuários da rede PulseShare (online/offline, último acesso,
 data de criação da conta), sincroniza com a rede ao abrir e sob demanda,
 envia mensagens para todos (canal oficial "PulseShare") e exclui contas,
 com a ordem propagada para todos os nós. As ações são assinadas com a chave
 do administrador, guardada só no computador do painel.
CTRL

cat > "$PKG/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  chown root:root /opt/PulseSharePanel/chrome-sandbox 2>/dev/null || true
  chmod 4755 /opt/PulseSharePanel/chrome-sandbox 2>/dev/null || true
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser --replace --write-cache /etc/apparmor.d/pulseshare-panel >/dev/null 2>&1 || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
POST

cat > "$PKG/DEBIAN/postrm" <<'POST'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser --remove /etc/apparmor.d/pulseshare-panel >/dev/null 2>&1 || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
POST
chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"
echo "/etc/apparmor.d/pulseshare-panel" > "$PKG/DEBIAN/conffiles"

echo "» Gerando o .deb..."
dpkg-deb --root-owner-group -Zxz --build "$PKG" "dist/pulseshare-panel_${VERSION}_amd64.deb" >/dev/null
rm -rf "$PKG"
ls -lh "dist/pulseshare-panel_${VERSION}_amd64.deb"
