#!/usr/bin/env bash
#
# vmhub-deploy — build all three binaries from THIS checkout and install them.
#
# Deployment drift is a documented failure mode for this project: the MCP
# binary opencode launched, the checkout it was built from, and the installed
# lite/reaper services had all diverged by days, so fixes that were committed
# and green in CI never reached the running agent. This script exists so the
# three artifacts are always built from one tree, in one step.
#
#   ./scripts/vmhub-deploy.sh            build + install everything (needs sudo)
#   ./scripts/vmhub-deploy.sh --mcp-only build + install just the MCP binary
#   ./scripts/vmhub-deploy.sh --check    report drift, change nothing
#
# The MCP binary lands in ./dist and is user-owned; lite and the reaper install
# to /usr/local/bin and need root. Point your MCP client at the dist path this
# script prints — never at a second checkout.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MCP_OUT="$REPO_ROOT/dist/vmhub-mcp"
LITE_OUT="$REPO_ROOT/dist/vmhub-lite"
REAPER_OUT="$REPO_ROOT/dist/vmhub-reaper"

mode="all"
case "${1:-}" in
  --mcp-only) mode="mcp" ;;
  --check) mode="check" ;;
  --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

if [[ "$mode" == "check" ]]; then
  echo "checkout : $REPO_ROOT ($branch @ $commit)"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    echo "           WARNING: working tree is dirty — built binaries will not match $commit"
  fi
  for f in "$MCP_OUT" /usr/local/bin/vmhub-lite /usr/local/bin/vmhub-reaper; do
    if [[ -e "$f" ]]; then
      printf 'binary   : %-32s %s\n' "$f" "$(date -r "$f" '+%Y-%m-%d %H:%M')"
    else
      printf 'binary   : %-32s MISSING\n' "$f"
    fi
  done
  # Any source file newer than a built binary means that binary is stale.
  drift=0
  if [[ ! -e "$MCP_OUT" ]]; then
    echo "DRIFT: $MCP_OUT has never been built from this checkout"
    drift=1
  else
    stale="$(find src adapters -type f -newer "$MCP_OUT" 2>/dev/null | head -5)"
    if [[ -n "$stale" ]]; then
      echo "DRIFT: source is newer than $MCP_OUT:"
      echo "$stale" | sed 's/^/  /'
      drift=1
    fi
  fi
  for f in /usr/local/bin/vmhub-lite /usr/local/bin/vmhub-reaper; do
    if [[ ! -e "$f" ]]; then
      echo "DRIFT: $f is not installed"
      drift=1
    elif [[ -n "$(find src adapters -type f -newer "$f" 2>/dev/null | head -1)" ]]; then
      echo "DRIFT: source is newer than $f — run ./scripts/vmhub-deploy.sh"
      drift=1
    fi
  done
  [[ $drift -eq 0 ]] && echo "OK: no drift detected"
  exit $drift
fi

echo "==> building from $branch @ $commit"
bun build src/mcp/index.ts --compile --outfile "$MCP_OUT"
echo "installed: $MCP_OUT"

if [[ "$mode" == "mcp" ]]; then
  echo
  echo "Point your MCP client at: $MCP_OUT"
  exit 0
fi

bun build src/lite/server.ts --compile --outfile "$LITE_OUT"
bun build src/reaper/index.ts --compile --outfile "$REAPER_OUT"

echo "==> installing lite + reaper to /usr/local/bin (sudo)"
# Keep one rollback copy of whatever is currently installed.
for name in vmhub-lite vmhub-reaper; do
  if [[ -e "/usr/local/bin/$name" ]]; then
    sudo cp -a "/usr/local/bin/$name" "/usr/local/bin/$name.bak"
  fi
done
sudo install -m 0755 "$LITE_OUT" /usr/local/bin/vmhub-lite
sudo install -m 0755 "$REAPER_OUT" /usr/local/bin/vmhub-reaper

echo "==> restarting vmhub-lite"
sudo systemctl restart vmhub-lite.service
sleep 2
systemctl is-active --quiet vmhub-lite.service && echo "vmhub-lite: active" || {
  echo "vmhub-lite FAILED to start — rolling back" >&2
  sudo install -m 0755 /usr/local/bin/vmhub-lite.bak /usr/local/bin/vmhub-lite
  sudo systemctl restart vmhub-lite.service
  exit 1
}

echo
echo "Deployed $branch @ $commit."
echo "Point your MCP client at: $MCP_OUT"
echo "Dry-run the reaper before trusting it:  sudo vmhub-reaper --dry-run"
