#!/usr/bin/env bash
# vmhub iLO probe — diagnostic sequence for HPE iLO 4 (Redfish).
#
# Loads creds from ~/.env WITHOUT printing them:
#   - ILO_USERNAME (account is 'ops' on this box)
#   - PASSWORD (iLO password)
#
# Rules: never echo the password or the token. The iLO is slow (5-10s
# responses) — every call uses -m 30. Respect login lockout: if the probe
# shows UnauthorizedLoginAttempt, STOP and wait out LoginFailureDelay before
# any further attempt.

set -euo pipefail

ILO_HOST="${ILO_HOST:-192.168.1.216}"
[ -f "${HOME}/.env" ] && set -a && source "${HOME}/.env" && set +a

USER="${ILO_USERNAME:-${USERNAME:-ops}}"
[ -n "${PASSWORD:-}" ] || { echo "PASSWORD missing in ~/.env"; exit 1; }
[ -n "$USER" ] || { echo "no iLO username (set ILO_USERNAME or USERNAME)"; exit 1; }

echo "==> [1/5] ServiceRoot (anonymous — login display, no auth needed)"
curl -k -s -m 30 https://${ILO_HOST}/redfish/v1/ -o /tmp/ilo_root.json -w "   HTTP %{http_code}\n"
grep -q '"@odata.id"' /tmp/ilo_root.json && echo "   ServiceRoot reachable" || echo "   NO ServiceRoot — network/HTTPS problem"

echo "==> [2/5] Session create (the real auth test)"
curl -k -s -m 30 -X POST -H "Content-Type: application/json" \
  -d "{\"UserName\":\"${USER}\",\"Password\":\"${PASSWORD}\"}" \
  https://${ILO_HOST}/redfish/v1/SessionService/Sessions/ \
  -D /tmp/ilo_headers.txt -o /tmp/ilo_session.json -w "   HTTP %{http_code}\n"
TOKEN=$(grep -i x-auth-token /tmp/ilo_headers.txt 2>/dev/null | awk '{print $2}' | tr -d '\r')
if [ -n "$TOKEN" ]; then
  echo "   AUTH OK (token stored /tmp/ilo_token, not printed)"
  printf '%s' "$TOKEN" > /tmp/ilo_token
else
  echo "   NO TOKEN — response:"
  head -c 400 /tmp/ilo_session.json; echo
  case "$(cat /tmp/ilo_session.json 2>/dev/null)" in
    *UnauthorizedLoginAttempt*)
      echo "   => WRONG CREDENTIALS or locked account. STOP PROBING."
      echo "      Wait out LoginFailureDelay. Verify creds via web UI at"
      echo "      https://${ILO_HOST} then re-run. Do NOT hammer — lockout grows."
      exit 1;;
    *LoginAttemptDelayed*)
      echo "   => LOGIN DELAY ACTIVE. Wait and retry later — do not hammer."
      exit 1;;
  esac
  exit 1
fi

echo "==> [3/5] System inventory"
curl -k -s -m 30 -H "X-Auth-Token: $TOKEN" https://${ILO_HOST}/redfish/v1/Systems/1/ \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   model:',d.get('Model')); print('   power:',d.get('PowerState')); print('   ram_giB:',d.get('MemorySummary',{}).get('TotalSystemMemoryGiB')); print('   cpu:',d.get('ProcessorSummary',{}).get('Count'),'x',d.get('ProcessorSummary',{}).get('Model'))"

echo "==> [4/5] Virtual media slots"
curl -k -s -m 30 -H "X-Auth-Token: $TOKEN" https://${ILO_HOST}/redfish/v1/Managers/1/VirtualMedia/ \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print('   ',m['@odata.id']) for m in d.get('Members',[])]"

echo "==> [5/5] Boot override"
curl -k -s -m 30 -H "X-Auth-Token: $TOKEN" https://${ILO_HOST}/redfish/v1/Systems/1/ \
  | python3 -c "import json,sys; d=json.load(sys.stdin); b=d.get('Boot',{}); print('   next:',b.get('BootSourceOverrideTarget'),'| enabled:',b.get('BootSourceOverrideEnabled'))"

echo "==> probe complete. See docs/probe.md for the full matrix."
