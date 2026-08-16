#!/usr/bin/env bash
# vmhub deploy — install binaries + systemd units + env files.
# Idempotent: safe to re-run. Run as root on the host that runs vmhub-lite
# and vmhub-reaper (the Proxmox host, or LO's desktop for the mock stage).
#
# Run through Doppler so secrets are injected by reference, never hardcoded:
#   doppler run --project proxmox --config prd -- ./deploy/install.sh
#
# Reboot survival contract (what this script guarantees):
#   1. vmhub-lite  starts on boot          (systemd, Restart=always)
#   2. vmhub-reaper sweeps 60s after boot  (systemd timer OnBootSec=1min)
#   3. reaper works even if lite is down   (independent unit, no After=)
#   4. MCP server is compiled and callable (dist/vmhub-mcp, used by opencode)
#   5. env files are root-owned 0600       (secrets never world-readable)

set -euo pipefail

REPO="${1:-/home/travis/Projects/vmhub}"
BINDIR="/usr/local/bin"
UNITDIR="/etc/systemd/system"
CONFDIR="/etc/vmhub"
DATADIR="/srv/vmhub"

[ -d "$REPO" ] || { echo "repo not found: $REPO"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }

echo "==> build binaries"
cd "$REPO"
bun run build:lite
bun run build:reaper
bun run build

echo "==> install binaries"
install -m 0755 dist/vmhub-lite   "$BINDIR/vmhub-lite"
install -m 0755 dist/vmhub-reaper "$BINDIR/vmhub-reaper"
install -m 0755 dist/vmhub-mcp    "$BINDIR/vmhub-mcp"

echo "==> data + config dirs"
mkdir -p "$DATADIR/leases" "$DATADIR/artifacts"
mkdir -p "$CONFDIR"
chmod 700 "$DATADIR" "$CONFDIR"

echo "==> env files (rendered from Doppler vars by reference, 0600)"
# Run via: doppler run --project proxmox --config prd -- ./deploy/install.sh
# Values come from injected env vars; nothing is hardcoded or echoed.
# Always re-render (idempotent): the registry vars land once Doppler has them.
cat > "$CONFDIR/lite.env" <<EOF
PVE_HOST=${PVE_HOST:-}
PVE_TOKEN=${PVE_TOKEN:-}
VMHUB_NODES=${VMHUB_NODES:-}
VMHUB_NODE_DL360P_BASE_URL=${VMHUB_NODE_DL360P_BASE_URL:-}
VMHUB_NODE_DL360P_TOKEN=${VMHUB_NODE_DL360P_TOKEN:-}
VMHUB_NODE_VOSTRO_BASE_URL=${VMHUB_NODE_VOSTRO_BASE_URL:-}
VMHUB_NODE_VOSTRO_TOKEN=${VMHUB_NODE_VOSTRO_TOKEN:-}
EOF
cat > "$CONFDIR/reaper.env" <<EOF
PVE_HOST=${PVE_HOST:-}
PVE_TOKEN=${PVE_TOKEN:-}
VMHUB_NODES=${VMHUB_NODES:-}
VMHUB_NODE_DL360P_BASE_URL=${VMHUB_NODE_DL360P_BASE_URL:-}
VMHUB_NODE_DL360P_TOKEN=${VMHUB_NODE_DL360P_TOKEN:-}
VMHUB_NODE_VOSTRO_BASE_URL=${VMHUB_NODE_VOSTRO_BASE_URL:-}
VMHUB_NODE_VOSTRO_TOKEN=${VMHUB_NODE_VOSTRO_TOKEN:-}
EOF
chmod 600 "$CONFDIR/lite.env" "$CONFDIR/reaper.env"

echo "==> install systemd units"
install -m 0644 "$REPO/deploy/systemd/vmhub-lite.service"     "$UNITDIR/"
install -m 0644 "$REPO/deploy/systemd/vmhub-reaper.service"   "$UNITDIR/"
install -m 0644 "$REPO/deploy/systemd/vmhub-reaper.timer"     "$UNITDIR/"
install -m 0644 "$REPO/deploy/systemd/vmhub-wake.service"     "$UNITDIR/"
install -m 0644 "$REPO/deploy/systemd/vmhub-wake.timer"       "$UNITDIR/"

echo "==> enable + start (survives reboot)"
systemctl daemon-reload
systemctl enable vmhub-lite.service
systemctl enable vmhub-reaper.timer
systemctl start vmhub-lite.service
systemctl start vmhub-reaper.timer
systemctl restart vmhub-reaper.service   # one sweep now, proves the loop
systemctl enable vmhub-wake.timer        # 10am host wake via iLO (desktop is always on)

echo "==> verify"
systemctl --no-pager status vmhub-lite.service --lines=3 | tail -5
systemctl --no-pager list-timers vmhub-reaper.timer | head -4
echo
echo "deploy complete. Reboot-survival contract is now enforced by systemd."
