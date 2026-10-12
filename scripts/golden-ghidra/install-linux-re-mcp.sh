#!/usr/bin/env bash
# install-linux-re-mcp.sh - expose the x11 RE image's tools as MCP servers (streamable-http, one port each).
#
# Runs as root inside a STAGING clone, after install-linux.sh (Ghidra) and install-linux-re-tools.sh.
# Idempotent. The services run as root: gdb and frida attach to arbitrary processes, dumpcap needs raw
# sockets, and an agent already has root through vm_exec, so a lower-privileged service would add nothing.
#
#   8081  ghidra       GhidraMCP bridge                    (install-linux.sh)
#   8082  radare2      r2mcp, native HTTP
#   8083  gdb          gdb-mcp (stdio) behind mcp-proxy
#   8084  frida        frida-mcp (stdio) behind mcp-proxy
#   8085  wireshark    wireshark-mcp, native HTTP (own venv: it needs mcp 2.x, the rest need <2)
#   8086  re-toolbox   strace/ltrace/valgrind/binwalk/yara/upx/qemu-user/angr/mitmproxy  (mcp/re-toolbox)
#   8087  bt-emu       virtual Bluetooth devices                                          (mcp/bt-emu)
#
# MCP endpoint is http://<vm-ip>:<port>/mcp on every port.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
MCPV=/opt/mcp-venv           # gdb-mcp, frida-mcp, mcp-proxy  (mcp<2)
WSV=/opt/mcp-wireshark-venv  # wireshark-mcp                   (mcp>=2.1)
log() { echo "== $*"; }

command -v r2 >/dev/null || { echo "run install-linux-re-tools.sh first"; exit 1; }

log "venvs"
python3 -m venv "$MCPV";  "$MCPV/bin/pip"  install -q --upgrade pip
"$MCPV/bin/pip"  install -q 'mcp<2' gdb-mcp frida-mcp mcp-proxy
python3 -m venv "$WSV";   "$WSV/bin/pip"   install -q --upgrade pip
"$WSV/bin/pip"   install -q wireshark-mcp

log "r2mcp (needs radare2-dev headers to build)"
R2DEV=/var/cache/radare2-dev_6.2.4_amd64.deb
if ! pkg-config --exists r_core 2>/dev/null; then
  curl -fsSL --retry 3 -o "$R2DEV" https://github.com/radareorg/radare2/releases/download/6.2.4/radare2-dev_6.2.4_amd64.deb
  echo "cec4832762c4d0a029f78e724ce6a0d83cf8f04fe8ae5f69b50486983c08e347  $R2DEV" | sha256sum -c --quiet
  apt-get -o DPkg::Lock::Timeout=900 install -y -q "$R2DEV"; rm -f "$R2DEV"
fi
r2pm -U >/dev/null 2>&1 || true
r2pm -ci r2mcp >/tmp/r2mcp-build.log 2>&1 || { tail -15 /tmp/r2mcp-build.log; exit 1; }
R2MCP="$(r2pm -H R2PM_BINDIR | head -1)/r2mcp"
[ -x "$R2MCP" ] || { echo "r2mcp binary not found at $R2MCP after build"; exit 1; }
ln -sf "$R2MCP" /usr/local/bin/r2mcp
rm -f /tmp/r2mcp-build.log

log "virtual Bluetooth: hci_vhci (bt-emu's 'vhci' backend; the default 'local-link' backend needs nothing)"
if modprobe hci_vhci 2>/dev/null; then
  echo hci_vhci > /etc/modules-load.d/hci_vhci.conf
  echo "  hci_vhci loaded; /dev/vhci: $(ls /dev/vhci 2>&1)"
else
  echo "  note: hci_vhci is not available in this kernel; bt-emu will only offer the local-link backend"
fi

log "sample dir"
mkdir -p /opt/re-samples && chmod 1777 /opt/re-samples

unit() { # name description exec
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network.target

[Service]
User=root
WorkingDirectory=/root
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=$3
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

log "services"
unit mcp-r2        "radare2 MCP (r2mcp, 0.0.0.0:8082)"   "/usr/local/bin/r2mcp -H 0.0.0.0:8082 -X 8:1800 -L"
unit mcp-gdb       "GDB MCP via mcp-proxy (0.0.0.0:8083)"   "$MCPV/bin/mcp-proxy --host 0.0.0.0 --port 8083 $MCPV/bin/gdb-mcp"
unit mcp-frida     "Frida MCP via mcp-proxy (0.0.0.0:8084)" "$MCPV/bin/mcp-proxy --host 0.0.0.0 --port 8084 $MCPV/bin/frida-mcp"
unit mcp-wireshark "Wireshark MCP (0.0.0.0:8085)"            "$WSV/bin/wireshark-mcp serve --transport streamable-http --host 0.0.0.0 --port 8085 --allow-insecure-http"

# re-toolbox and bt-emu ship as packages beside this script (built by their own tests).
for pkg in re-toolbox bt-emu; do
  if [ -d "$SRC/mcp/$pkg" ]; then
    "$MCPV/bin/pip" install -q "$SRC/mcp/$pkg"
  fi
done
[ -d "$SRC/mcp/re-toolbox" ] && unit mcp-re-toolbox "re-toolbox MCP (0.0.0.0:8086)" "$MCPV/bin/python -m re_toolbox_mcp --host 0.0.0.0 --port 8086"
[ -d "$SRC/mcp/bt-emu" ]     && unit mcp-bt-emu     "bt-emu MCP (0.0.0.0:8087)"     "$MCPV/bin/python -m bt_emu_mcp --host 0.0.0.0 --port 8087"
sed -i "s|^Environment=PATH=.*|&\nEnvironment=RE_PYTHON=/opt/re-venv/bin/python|" /etc/systemd/system/mcp-re-toolbox.service 2>/dev/null || true

systemctl daemon-reload
for s in mcp-r2 mcp-gdb mcp-frida mcp-wireshark mcp-re-toolbox mcp-bt-emu; do
  [ -f "/etc/systemd/system/$s.service" ] && { systemctl enable "$s.service"; systemctl restart "$s.service"; }
done

log "verify"
fail=0
probe() { # name port
  python3 - "$1" "$2" <<'PY' || fail=1
import json, sys, time, urllib.request
name, port = sys.argv[1], sys.argv[2]
URL = f"http://127.0.0.1:{port}/mcp"
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(body, sid=None):
    h = dict(H, **({"mcp-session-id": sid} if sid else {}))
    r = urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), h), timeout=60)
    text = r.read().decode()
    data = [l[5:] for l in text.splitlines() if l.startswith("data:")] or [text]
    return r.headers.get("mcp-session-id"), (json.loads(data[-1]) if data[-1].strip() else None)
err = None
for _ in range(45):
    try:
        sid, init = call({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}})
        call({"jsonrpc":"2.0","method":"notifications/initialized"}, sid)
        _, t = call({"jsonrpc":"2.0","id":2,"method":"tools/list"}, sid)
        n = len(t["result"]["tools"])
        print(f"  {'ok  ' if n else 'EMPTY'} {name:11s} :{port}  tools={n}")
        sys.exit(0 if n else 1)
    except SystemExit:
        raise
    except Exception as e:
        err = e; time.sleep(2)
print(f"  FAIL {name:11s} :{port}  {err}")
sys.exit(1)
PY
}
probe ghidra 8081; probe radare2 8082; probe gdb 8083; probe frida 8084; probe wireshark 8085
[ -f /etc/systemd/system/mcp-re-toolbox.service ] && probe re-toolbox 8086
[ -f /etc/systemd/system/mcp-bt-emu.service ]     && probe bt-emu 8087
[ "$fail" = 0 ] || { echo "some MCP servers are not answering"; exit 1; }
log "done"
