#!/usr/bin/env bash
# install-linux.sh — bake Ghidra + GhidraMCP into a Linux desktop golden.
#
# Runs as root inside a STAGING clone of the golden (never the template
# itself — see docs/golden-builds.md, "Rebuilding a golden"). Idempotent.
#
# What a clone gets:
#   /opt/ghidra                       Ghidra 12.1.2 (+ GhidraMCP GUI extension)
#   ghidra-mcp-headless.service       GhidraMCP headless REST server, 127.0.0.1:8089
#   ghidra-mcp-bridge.service         MCP bridge, streamable-http on 0.0.0.0:8081/mcp
#   /opt/ghidra-mcp-bridge/bin/bridge-mcp-ghidra   the same bridge for stdio use
#
# Versions are pinned together: a Ghidra extension only loads on the exact
# Ghidra version it was built for (extension.properties `version=`).
set -euo pipefail

GHIDRA_VERSION=12.1.2
GHIDRA_ZIP=ghidra_${GHIDRA_VERSION}_PUBLIC_20260605.zip
GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/$GHIDRA_ZIP
GHIDRA_SHA256=b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d

GHIDRAMCP_VERSION=6.0.0
GHIDRAMCP_BASE=https://github.com/bethington/ghidra-mcp/releases/download/v$GHIDRAMCP_VERSION
GHIDRAMCP_ZIP=GhidraMCP-$GHIDRAMCP_VERSION.zip
GHIDRAMCP_ZIP_SHA256=867731de27d5143632a010943b907a6485dd54d0e19729e2f85ee9f692c99873
GHIDRAMCP_WHL=ghidra_mcp_bridge-$GHIDRAMCP_VERSION-py3-none-any.whl
GHIDRAMCP_WHL_SHA256=71939a890009826664720166d8f786f3a2ea2460f7effcd83c73759ba4241334

DESKTOP_USER=${DESKTOP_USER:-vmuser}
GHIDRA_DIR=/opt/ghidra_${GHIDRA_VERSION}_PUBLIC
BRIDGE_DIR=/opt/ghidra-mcp-bridge
CACHE=/var/cache/ghidra-golden

log() { echo "== $*"; }

fetch() { # url sha256 dest
  if [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet 2>/dev/null; then return; fi
  curl -fsSL --retry 3 -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c --quiet
  mv "$3.part" "$3"
}

id "$DESKTOP_USER" >/dev/null
DESKTOP_HOME=$(getent passwd "$DESKTOP_USER" | cut -d: -f6)

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends openjdk-21-jdk python3 python3-venv unzip curl ca-certificates

mkdir -p "$CACHE"
log "download"
fetch "$GHIDRA_URL" "$GHIDRA_SHA256" "$CACHE/$GHIDRA_ZIP"
fetch "$GHIDRAMCP_BASE/$GHIDRAMCP_ZIP" "$GHIDRAMCP_ZIP_SHA256" "$CACHE/$GHIDRAMCP_ZIP"
fetch "$GHIDRAMCP_BASE/$GHIDRAMCP_WHL" "$GHIDRAMCP_WHL_SHA256" "$CACHE/$GHIDRAMCP_WHL"

log "ghidra $GHIDRA_VERSION -> $GHIDRA_DIR"
if [ ! -x "$GHIDRA_DIR/ghidraRun" ]; then
  unzip -q "$CACHE/$GHIDRA_ZIP" -d /opt
fi
ln -sfn "$GHIDRA_DIR" /opt/ghidra
# Installation-level extensions load for every user without the
# File > Install Extensions dance.
rm -rf "$GHIDRA_DIR/Ghidra/Extensions/GhidraMCP"
unzip -q "$CACHE/$GHIDRAMCP_ZIP" -d "$GHIDRA_DIR/Ghidra/Extensions"
ln -sf /opt/ghidra/ghidraRun /usr/local/bin/ghidra
ln -sf /opt/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless

cat > /usr/share/applications/ghidra.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Ghidra $GHIDRA_VERSION
Exec=/opt/ghidra/ghidraRun
Icon=/opt/ghidra/support/ghidra.ico
Categories=Development;
Terminal=false
EOF

# Skip the first-run user agreement so the GUI opens straight to the
# project window on every clone.
prefs="$DESKTOP_HOME/.config/ghidra/ghidra_${GHIDRA_VERSION}_PUBLIC"
install -d -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$DESKTOP_HOME/.config" "$DESKTOP_HOME/.config/ghidra" "$prefs" "$DESKTOP_HOME/ghidra-projects"
grep -qs '^USER_AGREEMENT=ACCEPT' "$prefs/preferences" || echo 'USER_AGREEMENT=ACCEPT' >> "$prefs/preferences"
chown "$DESKTOP_USER:$DESKTOP_USER" "$prefs/preferences"

log "bridge $GHIDRAMCP_VERSION -> $BRIDGE_DIR"
python3 -m venv "$BRIDGE_DIR"
"$BRIDGE_DIR/bin/pip" install -q --upgrade pip
"$BRIDGE_DIR/bin/pip" install -q --force-reinstall "$CACHE/$GHIDRAMCP_WHL"
ln -sf "$BRIDGE_DIR/bin/bridge-mcp-ghidra" /usr/local/bin/bridge-mcp-ghidra

log "launchers"
# The headless server ships inside the plugin jar; it runs on Ghidra's own
# jars the same way upstream's docker/entrypoint.sh does.
cat > /usr/local/bin/ghidra-mcp-headless <<'EOF'
#!/bin/bash
set -euo pipefail
GHIDRA_HOME=${GHIDRA_HOME:-/opt/ghidra}
CP=$(ls "$GHIDRA_HOME"/Ghidra/Extensions/GhidraMCP/lib/GhidraMCP-*.jar | head -1)
for jar in "$GHIDRA_HOME"/Ghidra/{Framework,Features,Processors}/*/lib/*.jar; do CP+=":$jar"; done
exec java ${JAVA_OPTS:--Xmx2g -XX:+UseG1GC} -Dghidra.home="$GHIDRA_HOME" -Dapplication.name=GhidraMCP \
  -classpath "$CP" com.xebyte.headless.GhidraMCPHeadlessServer "$@"
EOF
# The bridge checks Host headers (DNS-rebinding protection) against the
# addresses it sees at startup; a lease's address can change after boot, so
# allow the whole guest subnet explicitly instead of turning the check off.
cat > /usr/local/bin/ghidra-mcp-bridge-http <<'EOF'
#!/bin/bash
set -euo pipefail
export GHIDRA_MCP_URL=${GHIDRA_MCP_URL:-http://127.0.0.1:8089}
export GHIDRA_MCP_ALLOWED_HOSTS=${GHIDRA_MCP_ALLOWED_HOSTS:-$(seq -s, -f '10.10.10.%g' 1 254)}
exec /opt/ghidra-mcp-bridge/bin/bridge-mcp-ghidra --transport streamable-http --mcp-host 0.0.0.0 --mcp-port "${GHIDRA_MCP_BRIDGE_PORT:-8081}" "$@"
EOF
chmod 755 /usr/local/bin/ghidra-mcp-headless /usr/local/bin/ghidra-mcp-bridge-http

log "services"
cat > /etc/systemd/system/ghidra-mcp-headless.service <<EOF
[Unit]
Description=GhidraMCP headless server (127.0.0.1:8089)
After=network-online.target
Wants=network-online.target

[Service]
User=$DESKTOP_USER
WorkingDirectory=$DESKTOP_HOME/ghidra-projects
# A lab VM: let agents run Ghidra scripts (they already have root via vm_exec).
Environment=GHIDRA_MCP_ALLOW_SCRIPTS=1
ExecStart=/usr/local/bin/ghidra-mcp-headless --bind 127.0.0.1 --port 8089
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/ghidra-mcp-bridge.service <<EOF
[Unit]
Description=GhidraMCP MCP bridge (streamable-http 0.0.0.0:8081/mcp)
After=ghidra-mcp-headless.service
Wants=ghidra-mcp-headless.service

[Service]
User=$DESKTOP_USER
# The bridge only discovers the Ghidra server at startup. Started before the server
# listens it registers 8 meta-tools instead of ~220, so wait for the server first
# ("After=" only waits for the process to start, not for the port).
ExecStartPre=/bin/bash -c 'for i in \$(seq 1 90); do curl -fsS -m 3 http://127.0.0.1:8089/check_connection >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'
ExecStart=/usr/local/bin/ghidra-mcp-bridge-http
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ghidra-mcp-headless.service ghidra-mcp-bridge.service

log "verify"
for _ in $(seq 1 60); do curl -fsS -m 3 http://127.0.0.1:8089/check_connection >/dev/null 2>&1 && break; sleep 2; done
echo "headless: $(curl -fsS -m 5 http://127.0.0.1:8089/check_connection)"
for _ in $(seq 1 30); do curl -s -o /dev/null -m 3 http://127.0.0.1:8081/mcp && break; sleep 1; done
# One MCP handshake through the bridge: initialize, then tools/list.
python3 - <<'EOF'
import json, urllib.request
URL = "http://127.0.0.1:8081/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(body, sid=None):
    h = dict(H, **({"mcp-session-id": sid} if sid else {}))
    r = urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), h), timeout=60)
    text = r.read().decode()
    data = [l[5:] for l in text.splitlines() if l.startswith("data:")] or [text]
    return r.headers.get("mcp-session-id"), (json.loads(data[-1]) if data[-1].strip() else None)
sid, init = call({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "golden-check", "version": "1"}}})
call({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
_, tools = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sid)
n = len(tools["result"]["tools"])
print("bridge:", init["result"]["serverInfo"], "tools:", n)
# 8 means the bridge started before the Ghidra server was up and registered only its meta-tools.
raise SystemExit(0 if n >= 100 else "bridge exposes only %d tools" % n)
EOF
rm -rf "$CACHE"
log "done"
