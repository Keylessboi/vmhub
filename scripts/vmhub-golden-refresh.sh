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
  elif [ -d /opt/hyprland-mcp ]; then
    # exists but not a git repo — make it one (upgrade from old golden)
    rm -rf /opt/hyprland-mcp
    git clone --depth 1 https://github.com/Keylessboi/hyprland-mcp.git /opt/hyprland-mcp 2>&1
  fi
  if [ -d /opt/hyprland-mcp ]; then
    (cd /opt/hyprland-mcp && /usr/local/bin/bun-baseline install 2>&1 || true)
    chmod -R a+rX /opt/hyprland-mcp
  fi

  # ---- x11: pull latest computer-use-linux (npm) ----
  if command -v computer-use-linux >/dev/null 2>&1; then
    npm update -g @agent-sh/computer-use-linux 2>&1 || true
    echo "computer-use-linux: updated"
  fi

  # ---- mark done so subsequent boots skip (freshness at birth, not drift) ----
  touch /var/lib/vmhub-golden-refreshed
  echo "done"
} >> "$LOG" 2>&1
exit 0
