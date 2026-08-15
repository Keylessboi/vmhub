#!/usr/bin/env bash
# x11-golden-gate — acceptance gate for the repaired x11 golden VM.
#
# Proves the golden (x11-2404-diag, VM 2600) is drivable from the EXACT
# launcher context that the x11 MCP adapter uses:
#
#   set -a; . /etc/vmhub-session.env; set +a
#   su -s /bin/bash vmuser -c "<cmd>"
#
# (mirrors /usr/local/bin/launch-x11-mcp on the VM — the fix for issue #3)
#
# Gates (each must pass):
#   1. doctor all-ok        — at_spi_bus, toolkit_accessibility, x11 backend,
#                             all readiness flags true, blockers empty
#   2. gsettings persisted  — org.gnome.desktop.interface toolkit-accessibility == true
#   3. AT-SPI tree >= 3     — computer-use-linux state node count >= 3
#   4. windows >= 1         — computer-use-linux windows count >= 1
#   5. screenshot x3        — exit 0 each, 1920x1080, source gnome-screenshot
#
# Read-only against the VM (no reboot/stop/start, no config writes).
# Idempotent — safe to re-run; evidence files are overwritten per run.
# No secrets in this file: SSH jump keys are pre-configured.
#
# Usage: scripts/x11-golden-gate.sh [VM_IP]   (default 10.10.10.64)
# Exit 0 = all gates passed. Exit 1 = at least one gate failed (named).
set -u

VM_IP="${1:-10.10.10.64}"
JUMP_HOST="root@192.168.1.220"
EVID_DIR="${EVID_DIR:-/tmp/opencode/T5-gate-evidence}"
MIN_NODES=3
MIN_WINDOWS=1
EXPECT_WIDTH=1920
EXPECT_HEIGHT=1080
EXPECT_SOURCE="gnome-screenshot"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ProxyJump="$JUMP_HOST" -o BatchMode=yes -o ConnectTimeout=15)

mkdir -p "$EVID_DIR"

# ---- color helpers (plain when not a TTY) ----
if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  GREEN=''; RED=''; BOLD=''; NC=''
fi

# ---- summary accumulator: "num|name|status|detail" ----
ROWS=()
row() { ROWS+=("$1|$2|$3|$4"); }

# ---- run a shell snippet in the launcher context (as vmuser) ----
# stdout = command stdout (JSON), exit code = command exit code,
# ssh stderr (host-key warnings etc.) goes to the per-gate stderr log.
run_remote() {
  local snippet="$1" errlog="$2"
  ssh "${SSH_OPTS[@]}" "root@${VM_IP}" \
    "set -a; . /etc/vmhub-session.env; set +a; su -s /bin/bash vmuser -c '${snippet}'" \
    2>"${errlog}"
}

# =====================================================================
echo "x11 golden gate — VM ${VM_IP} (jump ${JUMP_HOST})"
echo "evidence dir: ${EVID_DIR}"
echo "run started: $(date -u -Is)"
echo

# ---------------------------------------------------------------------
# GATE 1 — doctor all-ok (per-item PASS/FAIL)
# ---------------------------------------------------------------------
G1_FAILED=0
G1_JSON="$EVID_DIR/gate1-doctor.json"
run_remote 'computer-use-linux doctor' "$EVID_DIR/gate1-doctor.stderr.log" > "$G1_JSON"
G1_RC=$?

echo "== gate 1/5: doctor all-ok =="
if [ "$G1_RC" -ne 0 ]; then
  echo "    [${RED}FAIL${NC}] doctor command exited $G1_RC (see ${EVID_DIR}/gate1-doctor.stderr.log)"
  G1_FAILED=1
else
  for spec in \
    ".accessibility.at_spi_bus.ok|at_spi_bus ok" \
    ".accessibility.toolkit_accessibility.ok|toolkit_accessibility ok" \
    ".windowing.backends.x11.ok|windowing x11 backend ok" \
    ".readiness.can_register_mcp_tools|readiness.can_register_mcp_tools" \
    ".readiness.can_build_accessibility_tree|readiness.can_build_accessibility_tree" \
    ".readiness.can_query_windows|readiness.can_query_windows" \
    ".readiness.can_send_development_input|readiness.can_send_development_input"
  do
    path="${spec%%|*}"; label="${spec#*|}"
    v="$(jq -r "$path" "$G1_JSON" 2>/dev/null)"
    if [ "$v" = "true" ]; then
      echo "    [${GREEN}PASS${NC}] ${label}"
    else
      echo "    [${RED}FAIL${NC}] ${label} (expected true, got '${v}')"
      G1_FAILED=1
    fi
  done
  nblockers="$(jq -r '.readiness.blockers | length' "$G1_JSON" 2>/dev/null)"
  if [ "${nblockers:-x}" = "0" ]; then
    echo "    [${GREEN}PASS${NC}] readiness.blockers empty (0 blockers)"
  else
    echo "    [${RED}FAIL${NC}] readiness.blockers not empty (${nblockers}):"
    jq -r '.readiness.blockers[]' "$G1_JSON" 2>/dev/null | sed 's/^/        - /'
    G1_FAILED=1
  fi
fi
[ "$G1_FAILED" -eq 0 ] && row "1" "doctor all-ok" "PASS" "at-spi + toolkit + x11 + readiness, 0 blockers" \
                     || row "1" "doctor all-ok" "FAIL" "see per-item output"
echo

# ---------------------------------------------------------------------
# GATE 2 — gsettings persisted (toolkit-accessibility == true)
# ---------------------------------------------------------------------
echo "== gate 2/5: gsettings persisted =="
G2_OUT="$(run_remote 'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; export XDG_RUNTIME_DIR=/run/user/1000; gsettings get org.gnome.desktop.interface toolkit-accessibility' "$EVID_DIR/gate2-gsettings.stderr.log")"
G2_RC=$?
printf '%s\n' "$G2_OUT" > "$EVID_DIR/gate2-gsettings.txt"
G2_VAL="$(printf '%s' "$G2_OUT" | tr -d '[:space:]')"
if [ "$G2_RC" -eq 0 ] && [ "$G2_VAL" = "true" ]; then
  echo "    [${GREEN}PASS${NC}] toolkit-accessibility = true"
  row "2" "gsettings persisted" "PASS" "toolkit-accessibility = true"
else
  echo "    [${RED}FAIL${NC}] toolkit-accessibility expected 'true', got '${G2_VAL}' (rc=$G2_RC)"
  row "2" "gsettings persisted" "FAIL" "got '${G2_VAL}' (rc=$G2_RC)"
fi
echo

# ---------------------------------------------------------------------
# GATE 3 — AT-SPI tree non-empty (>= 3 nodes)
# ---------------------------------------------------------------------
echo "== gate 3/5: at-spi tree nodes >= ${MIN_NODES} =="
G3_JSON="$EVID_DIR/gate3-state.json"
run_remote 'computer-use-linux state' "$EVID_DIR/gate3-state.stderr.log" > "$G3_JSON"
G3_RC=$?
if [ "$G3_RC" -ne 0 ]; then
  echo "    [${RED}FAIL${NC}] computer-use-linux state exited $G3_RC"
  G3_FAILED=1
else
  G3_NODES="$(jq 'length' "$G3_JSON" 2>/dev/null)"
  G3_APPS="$(jq -r '[.[] | select(.role == "application") | .name] | unique | join(", ")' "$G3_JSON" 2>/dev/null)"
  if [ "${G3_NODES:-x}" -ge "$MIN_NODES" ] 2>/dev/null; then
    echo "    [${GREEN}PASS${NC}] ${G3_NODES} nodes (apps: ${G3_APPS:-none})"
    G3_FAILED=0
  else
    echo "    [${RED}FAIL${NC}] expected >= ${MIN_NODES} nodes, got '${G3_NODES:-unparseable}'"
    G3_FAILED=1
  fi
fi
[ "$G3_FAILED" -eq 0 ] && row "3" "at-spi tree non-empty" "PASS" "${G3_NODES} nodes (${G3_APPS:-?})" \
                     || row "3" "at-spi tree non-empty" "FAIL" "nodes=${G3_NODES:-unparseable}"
echo

# ---------------------------------------------------------------------
# GATE 4 — windows >= 1
# ---------------------------------------------------------------------
echo "== gate 4/5: windows >= ${MIN_WINDOWS} =="
G4_JSON="$EVID_DIR/gate4-windows.json"
run_remote 'computer-use-linux windows' "$EVID_DIR/gate4-windows.stderr.log" > "$G4_JSON"
G4_RC=$?
if [ "$G4_RC" -ne 0 ]; then
  echo "    [${RED}FAIL${NC}] computer-use-linux windows exited $G4_RC"
  G4_FAILED=1
else
  G4_COUNT="$(jq '.windows | length' "$G4_JSON" 2>/dev/null)"
  G4_LIST="$(jq -r '[.windows[].app_id] | join(", ")' "$G4_JSON" 2>/dev/null)"
  if [ "${G4_COUNT:-x}" -ge "$MIN_WINDOWS" ] 2>/dev/null; then
    echo "    [${GREEN}PASS${NC}] ${G4_COUNT} windows (${G4_LIST:-?})"
    G4_FAILED=0
  else
    echo "    [${RED}FAIL${NC}] expected >= ${MIN_WINDOWS} window(s), got '${G4_COUNT:-unparseable}'"
    G4_FAILED=1
  fi
fi
[ "$G4_FAILED" -eq 0 ] && row "4" "windows >= 1" "PASS" "${G4_COUNT} windows (${G4_LIST:-?})" \
                     || row "4" "windows >= 1" "FAIL" "count=${G4_COUNT:-unparseable}"
echo

# ---------------------------------------------------------------------
# GATE 5 — screenshot x3 deterministic (exit 0, 1920x1080, gnome-screenshot)
# ---------------------------------------------------------------------
echo "== gate 5/5: screenshot x3 =="
G5_FAILED=0
for i in 1 2 3; do
  SHOT_JSON="$EVID_DIR/gate5-screenshot-${i}.json"
  run_remote 'computer-use-linux screenshot' "$EVID_DIR/gate5-screenshot-${i}.stderr.log" > "$SHOT_JSON"
  SHOT_RC=$?
  W="$(jq -r '.width' "$SHOT_JSON" 2>/dev/null)"
  H="$(jq -r '.height' "$SHOT_JSON" 2>/dev/null)"
  SRC="$(jq -r '.source' "$SHOT_JSON" 2>/dev/null)"
  if [ "$SHOT_RC" -eq 0 ] && [ "$W" = "$EXPECT_WIDTH" ] && [ "$H" = "$EXPECT_HEIGHT" ] && [ "$SRC" = "$EXPECT_SOURCE" ]; then
    echo "    [${GREEN}PASS${NC}] shot ${i}: exit 0, ${W}x${H}, source=${SRC}"
  else
    echo "    [${RED}FAIL${NC}] shot ${i}: rc=${SHOT_RC} width=${W:-?} height=${H:-?} source=${SRC:-?}"
    G5_FAILED=1
  fi
done
[ "$G5_FAILED" -eq 0 ] && row "5" "screenshot x3" "PASS" "3x exit 0, 1920x1080, gnome-screenshot" \
                     || row "5" "screenshot x3" "FAIL" "one or more shots failed"
echo

# ---------------------------------------------------------------------
# SUMMARY TABLE
# ---------------------------------------------------------------------
printf '%s\n' "=================================================="
printf '  %s%-34s%-6s%s %s\n' "$BOLD" "GATE" "STATUS" "$NC" "DETAIL"
printf '%s\n' "--------------------------------------------------"
OVERALL=PASS
for r in "${ROWS[@]}"; do
  IFS='|' read -r num name status detail <<< "$r"
  if [ "$status" = "PASS" ]; then
    printf '  %-2s %-30s %s%-6s%s %s\n' "$num" "$name" "$GREEN" "$status" "$NC" "$detail"
  else
    printf '  %-2s %-30s %s%-6s%s %s\n' "$num" "$name" "$RED" "$status" "$NC" "$detail"
    OVERALL=FAIL
  fi
done
printf '%s\n' "--------------------------------------------------"
if [ "$OVERALL" = "PASS" ]; then
  printf '  %s%-34s%s %s%s%s\n' "$BOLD" "OVERALL" "$NC" "$GREEN" "PASS" "$NC"
else
  FAILED_NAMES="$(printf '%s\n' "${ROWS[@]}" | awk -F'|' '$3=="FAIL" {printf "%s ", $2}')"
  printf '  %s%-34s%s %s%s%s\n' "$BOLD" "OVERALL" "$NC" "$RED" "FAIL" "$NC"
  printf '  failing gate(s): %s\n' "${FAILED_NAMES:-unknown}"
fi
printf '%s\n' "=================================================="
echo "evidence: $(ls "$EVID_DIR" | grep -v '\.stderr\.log$' | tr '\n' ' ')"
echo "finished: $(date -u -Is)"

if [ "$OVERALL" = "PASS" ]; then
  exit 0
else
  exit 1
fi
