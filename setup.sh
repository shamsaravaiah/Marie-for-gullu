#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/Desktop Pet"
NODE_DIR="$SUPPORT/node"
APP="$HOME/Applications/Desktop Pet.app"
PLIST="$HOME/Library/LaunchAgents/com.frankfu.desktoppet.plist"

mkdir -p "$SUPPORT" "$HOME/Applications" "$HOME/Library/LaunchAgents"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  case "$(uname -m)" in
    arm64) ARCH=arm64 ;;
    *) ARCH=x64 ;;
  esac
  TAR="$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" | awk -v a="$ARCH" '$2 ~ ("darwin-" a ".tar.gz$") { print $2; exit }')"
  TMP="$(mktemp -d)"
  curl -fL "https://nodejs.org/dist/latest-v22.x/$TAR" -o "$TMP/node.tar.gz"
  tar -xzf "$TMP/node.tar.gz" -C "$TMP"
  rm -rf "$NODE_DIR"
  mv "$TMP"/node-v*-darwin-* "$NODE_DIR"
  rm -rf "$TMP"
fi

export PATH="$NODE_DIR/bin:$PATH"
cd "$ROOT"
npm install
chmod +x "$ROOT/launch.sh"

rm -rf "$APP"
osacompile -o "$APP" <<EOF
do shell script "/bin/bash " & quoted form of "$ROOT/launch.sh"
EOF

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
sips -z 512 512 "$ROOT/build/icon.png" --out "$ICONSET/icon_512x512.png" >/dev/null
cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
touch "$APP"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.frankfu.desktoppet</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/launch.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
