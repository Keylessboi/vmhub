#!/usr/bin/env bash
# vmhub-wake — power on the Proxmox host via iLO Redfish API.
# Runs from the desktop (always-on) at 10:00 via cron/systemd timer.
set -euo pipefail

ILO="https://192.168.1.216"
USER="ops"
PW="${PASSWORD:-}"
if [ -z "$PW" ] && [ -f "$HOME/.env" ]; then set -a; . "$HOME/.env"; set +a; PW="${PASSWORD:-}"; fi

# Is the host already up? Nothing to do.
if timeout 3 bash -c "echo > /dev/tcp/192.168.1.220/8006" 2>/dev/null; then
  echo "$(date -Is) host already up" >> /tmp/vmhub-wake.log
  exit 0
fi

# Login to iLO and grab the session token (in the X-Auth-Token header).
TOKEN=$(curl -sk -m 10 -X POST -H "Content-Type: application/json" \
  -d "{\"UserName\":\"$USER\",\"Password\":\"$PW\"}" \
  -D - "${ILO}/redfish/v1/SessionService/Sessions/" -o /dev/null 2>/dev/null \
  | grep -i "^X-Auth-Token:" | awk '{print $2}' | tr -d '\r')

if [ -z "${TOKEN:-}" ]; then
  echo "$(date -Is) ERROR: iLO auth failed" >> /tmp/vmhub-wake.log
  exit 1
fi

# Power on (ResetType "On" — verified working in this session).
HTTP=$(curl -sk -m 15 -X POST -H "X-Auth-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ResetType":"On"}' \
  -o /dev/null -w "%{http_code}" \
  "${ILO}/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/")

echo "$(date -Is) power-on request HTTP $HTTP" >> /tmp/vmhub-wake.log
[ "$HTTP" = "200" ] || exit 1
