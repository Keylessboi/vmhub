#!/usr/bin/env bash
# vmhub-golden-refresh — born-current provisioning for golden VMs.
#
# Runs ONCE at clone first-boot. The golden template is a base; this script
# pulls the latest in-VM MCP server code so every NEW VM is current with
# upstream at the moment it boots. Running VMs are never touched mid-lease.
#
# Design (why this, not a frozen golden):
#   A golden that produces stale VMs is a snapshot, not a golden. The
#   template stays immutable (OS + deps + config); freshness lives here.
#
# Idempotent: safe to re-run. Network failure → log and continue (the VM
# still boots with the baked-in version rather than failing).
set -u

LOG=/var/log/vmhub-golden-refresh.log
{
  echo "== $(date -Is) vmhub-golden-refresh"

  # ---- hyprland: pull latest hyprland-mcp source (public repo) ----
  if [ -d /opt/hyprland-mcp/.git ]; then
    git -C /opt/hyprland-mcp fetch --depth 1 origin main 2>&1
    git -C /opt/hyprland-mcp reset --hard origin/main 2>&1
    echo "hyprland-mcp: updated to $(git -C /opt/hyprland-mcp rev-parse --short HEAD)"
  else
    # absent or not a git repo — clone fresh (covers first-provision and
    # upgrades from old goldens where the source dir went missing)
    rm -rf /opt/hyprland-mcp
    git clone --depth 1 https://github.com/Keylessboi/hyprland-mcp.git /opt/hyprland-mcp 2>&1
    echo "hyprland-mcp: cloned $(git -C /opt/hyprland-mcp rev-parse --short HEAD)"
  fi
  if [ -d /opt/hyprland-mcp ]; then
    (cd /opt/hyprland-mcp && /usr/local/bin/bun-baseline install 2>&1 || true)
    chmod -R a+rX /opt/hyprland-mcp
  fi

  # ---- x11: pull pinned computer-use-linux (npm) ----
  if command -v computer-use-linux >/dev/null 2>&1; then
    npm install -g @agent-sh/computer-use-linux@0.4.9 2>&1 || true
    echo "computer-use-linux: pinned 0.4.9"
  fi

  # ---- mark done so subsequent boots skip (freshness at birth, not drift) ----
  touch /var/lib/vmhub-golden-refreshed
  echo "done"
} >> "$LOG" 2>&1
exit 0
