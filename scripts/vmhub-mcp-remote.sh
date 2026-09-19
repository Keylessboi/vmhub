#!/bin/bash
# vmhub-mcp for a workstation whose control plane runs on the Proxmox host.
#
# vmhub-lite binds 127.0.0.1:8787 on the host. This forwards a local port to
# it over SSH (reusing a live forward), then execs the stdio MCP server with
# the transport pointed at the same host. Point an MCP client at this script.
#
#   VMHUB_SSH_CONFIG   ssh_config with a Host entry for the Proxmox host and
#                      the guest subnet (default ~/.config/vmhub/ssh_config)
#   VMHUB_JUMP_HOST    that Host entry (default vmhub-host)
#   VMHUB_LITE_PORT    local forward port (default 18787)
#   VMHUB_MCP_BIN      the compiled server (default ~/.local/bin/vmhub-mcp-server)
set -euo pipefail
export VMHUB_SSH_CONFIG=${VMHUB_SSH_CONFIG:-$HOME/.config/vmhub/ssh_config}
export VMHUB_JUMP_HOST=${VMHUB_JUMP_HOST:-vmhub-host}
PORT=${VMHUB_LITE_PORT:-18787}
BIN=${VMHUB_MCP_BIN:-$HOME/.local/bin/vmhub-mcp-server}
export VMHUB_LITE_URL=http://127.0.0.1:$PORT

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

if ! port_open; then
  # stdout is the MCP channel and stderr belongs to the client: the
  # long-lived forwarder must hold neither, or the client never sees EOF.
  LOG=${XDG_STATE_HOME:-$HOME/.local/state}/vmhub/forward.log
  mkdir -p "$(dirname "$LOG")"
  ssh -F "$VMHUB_SSH_CONFIG" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -f -N \
    -L "127.0.0.1:$PORT:127.0.0.1:8787" "$VMHUB_JUMP_HOST" </dev/null >/dev/null 2>>"$LOG" \
    || echo "vmhub-mcp-remote: could not forward to vmhub-lite on $VMHUB_JUMP_HOST (tools will report lite unreachable)" >&2
  for _ in $(seq 1 50); do port_open && break; sleep 0.1; done
fi
exec "$BIN"
