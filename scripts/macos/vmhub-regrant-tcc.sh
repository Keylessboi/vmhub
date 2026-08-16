#!/bin/bash
# vmhub-regrant-tcc.sh — re-apply the macOS TCC pre-grants baked into the
# macOS golden (macos-sequoia-15.7.9-1).
#
# Grants Accessibility (kTCCServiceAccessibility), Screen Recording
# (kTCCServiceScreenCapture) and AppleEvents (kTCCServiceAppleEvents) to the
# in-VM automation agent — identified by the stable designated requirement
# `identifier "com.vmhub.agent"` — so rebuilds of the agent binary keep the
# grant.
#
# Runs on the guest as root (sudo). The grants are written to the vmhub
# USER TCC database (~/Library/Application Support/com.apple.TCC/TCC.db),
# which is where user-scope services live on the Data volume. The TCC daemon
# is restarted so the new grants are picked up without a reboot.
#
# Usage: sudo /usr/local/bin/vmhub-regrant-tcc.sh [--user vmhub]
#
# Agent binaries covered (any that exist are signed with identifier
# com.vmhub.agent and share the grant):
#   - /Applications/MacControlMCP.app/Contents/MacOS/MacControlMCP
#   - /usr/local/bin/vmhub-axprobe

set -euo pipefail

AGENT_ID="com.vmhub.agent"
TARGET_USER="${1:-vmhub}"
USER_HOME="/Users/${TARGET_USER}"
TCC_DB="${USER_HOME}/Library/Application Support/com.apple.TCC/TCC.db"

# Candidate agent binaries — the csreq is computed from the first one found.
AGENT_BINS=(
  "/Applications/MacControlMCP.app/Contents/MacOS/MacControlMCP"
  "/usr/local/bin/vmhub-axprobe"
)

# AppleEvents indirect targets (the apps the agent may script via AppleEvents).
AE_TARGETS=(
  "com.apple.systemevents"
  "com.apple.finder"
  "com.apple.Terminal"
  "com.apple.Safari"
)

log() { echo "[vmhub-regrant-tcc] $*"; }
die() { echo "[vmhub-regrant-tcc] ERROR: $*" >&2; exit 1; }

# --- 1. find an agent binary and derive the csreq blob ---------------------
BIN=""
for b in "${AGENT_BINS[@]}"; do
  if [ -x "$b" ]; then BIN="$b"; break; fi
done
[ -n "$BIN" ] || die "no agent binary found (looked in ${AGENT_BINS[*]})"
log "agent binary: $BIN"

REQ_STRING="identifier \"${AGENT_ID}\""
# Encode the designated requirement the way TCC stores it (csreq blob).
CSREQ_TMP=$(mktemp)
if ! printf '%s' "$REQ_STRING" | csreq -r - -b "$CSREQ_TMP" 2>/dev/null; then
  rm -f "$CSREQ_TMP"
  die "csreq encoding failed (is /usr/bin/csreq available?)"
fi
CSREQ_HEX=$(xxd -p "$CSREQ_TMP" | tr -d '\n')
rm -f "$CSREQ_TMP"
[ -n "$CSREQ_HEX" ] || die "empty csreq blob for ${AGENT_ID}"
log "csreq blob: ${CSREQ_HEX:0:24}… (${#CSREQ_HEX} hex chars)"

# Sanity: the running binary's own designated requirement must match.
BIN_REQ=$(codesign -dr - "$BIN" 2>&1 \
  | grep -v '^Executable=' \
  | sed 's/^Designated Requirement:[[:space:]]*//' \
  | grep -v '^[[:space:]]*$' \
  | head -1)
log "binary designated requirement: ${BIN_REQ:-<none>}"
case "$BIN_REQ" in
  *"identifier \"${AGENT_ID}\""*) log "binary identity matches ${AGENT_ID}" ;;
  *) die "binary identity mismatch — re-sign with: codesign -f -s - -i ${AGENT_ID} -r '=identifier \"${AGENT_ID}\"'" ;;
esac

# --- 2. apply grants --------------------------------------------------------
[ -f "$TCC_DB" ] || die "user TCC db not found at ${TCC_DB}"
log "target db: ${TCC_DB}"

NOW=$(date +%s)

grant() { # $1 = service, $2 = indirect identifier (optional)
  local service="$1" indirect="${2:-}"
  if [ -n "$indirect" ]; then
    sqlite3 "$TCC_DB" \
      "INSERT OR REPLACE INTO access
         (service, client, client_type, auth_value, auth_reason, auth_version,
          csreq, indirect_object_identifier_type, indirect_object_identifier,
          flags, last_modified)
       VALUES ('${service}','${AGENT_ID}',0,2,4,1,X'${CSREQ_HEX}',0,'${indirect}',0,${NOW});"
    log "granted ${service} -> ${indirect}"
  else
    sqlite3 "$TCC_DB" \
      "INSERT OR REPLACE INTO access
         (service, client, client_type, auth_value, auth_reason, auth_version,
          csreq, indirect_object_identifier_type, indirect_object_identifier,
          flags, last_modified)
       VALUES ('${service}','${AGENT_ID}',0,2,4,1,X'${CSREQ_HEX}',0,NULL,0,${NOW});"
    log "granted ${service}"
  fi
}

grant "kTCCServiceAccessibility"
grant "kTCCServiceScreenCapture"
for t in "${AE_TARGETS[@]}"; do
  grant "kTCCServiceAppleEvents" "$t"
done

# --- 3. reload TCC so the grants take effect immediately --------------------
log "restarting tccd"
killall tccd 2>/dev/null || true
sleep 2

log "done. Verify with: sudo -u ${TARGET_USER} /usr/local/bin/vmhub-axprobe ax"
