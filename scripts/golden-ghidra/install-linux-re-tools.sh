#!/usr/bin/env bash
# install-linux-re-tools.sh - reverse-engineering and analysis toolset for the x11 golden.
#
# Runs as root inside a STAGING clone (never the template itself - see docs/golden-builds.md).
# Idempotent. Layered on top of install-linux.sh (Ghidra + GhidraMCP).
#
#   debug + trace    gdb (+ pwndbg), strace, ltrace, valgrind, build-essential
#   static analysis  radare2, binwalk, upx, yara, capstone, python libs (lief, pwntools, angr)
#   instrumentation  frida + frida-tools, qemu-user (run foreign-architecture binaries)
#   capture          wireshark/tshark, tcpdump, mitmproxy
#
# Python packages go in one venv (/opt/re-venv, on PATH via /usr/local/bin links): Debian 13 marks the
# system Python externally managed, and angr/pwntools pin their own dependency trees.
set -euo pipefail

DESKTOP_USER=${DESKTOP_USER:-vmuser}
VENV=/opt/re-venv
R2_VERSION=6.2.4
R2_SHA256=7019eedc0e0e87d1f53d6b8f5fc62b898567679c5efdce7fbfc557c9e7655e90
log() { echo "== $*"; }

id "$DESKTOP_USER" >/dev/null
DESKTOP_HOME=$(getent passwd "$DESKTOP_USER" | cut -d: -f6)
export DEBIAN_FRONTEND=noninteractive

log "apt packages"
apt-get update -q
# wireshark asks whether non-root users may capture; answer in advance.
echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections
apt-get install -y -q --no-install-recommends \
  build-essential git curl ca-certificates python3 python3-venv python3-dev pkg-config \
  gdb gdbserver strace ltrace valgrind \
  binwalk upx-ucl yara \
  qemu-user-static binfmt-support \
  tshark wireshark tcpdump \
  file xxd bsdextrautils binutils elfutils patchelf

log "radare2 $R2_VERSION (Debian 13 has no radare2 package; official release .deb, sha256-pinned)"
R2_DEB=/var/cache/radare2_${R2_VERSION}_amd64.deb
if [ ! -f "$R2_DEB" ] || ! echo "$R2_SHA256  $R2_DEB" | sha256sum -c --quiet 2>/dev/null; then
  curl -fsSL --retry 3 -o "$R2_DEB.part" "https://github.com/radareorg/radare2/releases/download/$R2_VERSION/radare2_${R2_VERSION}_amd64.deb"
  echo "$R2_SHA256  $R2_DEB.part" | sha256sum -c --quiet
  mv "$R2_DEB.part" "$R2_DEB"
fi
apt-get install -y -q "$R2_DEB"
rm -f "$R2_DEB"

log "python venv: $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip wheel
# bitstring 5 dropped ConstBitStream, which angr's pyvex imports: keep it below 5.
# uv is what pwndbg's setup.sh uses to build its own environment.
"$VENV/bin/pip" install -q 'bitstring<5' uv capstone keystone-engine unicorn lief pwntools frida frida-tools mitmproxy angr
for t in uv frida frida-ps frida-trace frida-discover mitmproxy mitmdump mitmweb; do
  [ -x "$VENV/bin/$t" ] && ln -sf "$VENV/bin/$t" "/usr/local/bin/$t"
done
ln -sf "$VENV/bin/python" /usr/local/bin/re-python

log "pwndbg (gdb plugin) for $DESKTOP_USER"
if [ ! -d /opt/pwndbg ]; then
  git clone -q --depth 1 https://github.com/pwndbg/pwndbg /opt/pwndbg
fi
# Its setup.sh runs `sudo apt install`, which a passwordless desktop user cannot do, so run it as
# root (it builds /opt/pwndbg/.venv with uv), then point each user's ~/.gdbinit at it.
(cd /opt/pwndbg && PATH=/usr/local/bin:$PATH ./setup.sh) >/tmp/pwndbg-setup.log 2>&1 || { tail -15 /tmp/pwndbg-setup.log; echo "pwndbg setup failed (non-fatal)"; }
# pwndbg re-syncs its venv at startup when uv.lock differs; the venv is root-owned, so for the
# desktop user that update fails and gdb errors out. Turn it off before the plugin loads.
# Only the desktop user's gdb autoloads pwndbg. It changes the prompt to "pwndbg>", which gdb-mcp
# (run as root by the MCP service) does not recognise, so every MCP command would time out.
sed -i '/pwndbg\/gdbinit.py/d; /PWNDBG_NO_AUTOUPDATE/d' /root/.gdbinit 2>/dev/null || true
sed -i '/pwndbg\/gdbinit.py/d; /PWNDBG_NO_AUTOUPDATE/d' "$DESKTOP_HOME/.gdbinit" 2>/dev/null || true
printf 'python import os; os.environ["PWNDBG_NO_AUTOUPDATE"] = "1"\nsource /opt/pwndbg/gdbinit.py\n' >> "$DESKTOP_HOME/.gdbinit"
# For everyone else (root, MCP sessions that pass prompt="pwndbg>"): an explicit launcher.
cat > /usr/local/bin/gdb-pwndbg <<'EOW'
#!/bin/sh
exec gdb -q -iex 'python import os; os.environ["PWNDBG_NO_AUTOUPDATE"] = "1"' -x /opt/pwndbg/gdbinit.py "$@"
EOW
chmod 755 /usr/local/bin/gdb-pwndbg
chown "$DESKTOP_USER":"$DESKTOP_USER" "$DESKTOP_HOME/.gdbinit"

log "capture permissions"
usermod -aG wireshark "$DESKTOP_USER" 2>/dev/null || true

log "verify"
fail=0
check() { if command -v "$1" >/dev/null 2>&1; then printf '  ok   %-10s %s\n' "$1" "$($1 $2 2>&1 | head -1 | cut -c1-70)"; else echo "  MISSING $1"; fail=1; fi; }
check gdb --version; check strace -V; check ltrace --version; check valgrind --version
check r2 -v; check binwalk --help; check upx -V; check yara --version
check tshark --version; check tcpdump --version
check frida --version; check mitmdump --version; check qemu-aarch64-static --version
"$VENV/bin/python" -c "import capstone, lief, pwn, angr; print('  ok   python libs: capstone', capstone.__version__, 'lief', lief.__version__, 'angr', angr.__version__)" 2>&1 | tail -1 || fail=1
[ "$fail" = 0 ] || { echo "some tools are missing"; exit 1; }
rm -f /tmp/pwndbg-setup.log
log "done"
