#!/usr/bin/env bash
# Sync skills from this repo into the local opencode skill collection.
#
# The repo is the canonical source. After changing skills/ in this repo, run
# this script so the local copy matches. Idempotent: safe to run any time.
#
# Usage: ./scripts/sync-skills.sh

set -euo pipefail

REPO_SKILLS="$(cd "$(dirname "$0")/.." && pwd)/skills"
DEST="${OPENCODE_SKILLS_DIR:-$HOME/.config/opencode/skills}"

if [ ! -d "$REPO_SKILLS" ]; then
  echo "no skills/ directory in repo; nothing to sync" >&2
  exit 0
fi

mkdir -p "$DEST"

for skill_dir in "$REPO_SKILLS"/*/; do
  name="$(basename "$skill_dir")"
  if [ ! -f "$skill_dir/SKILL.md" ]; then
    echo "skip $name (no SKILL.md)" >&2
    continue
  fi
  mkdir -p "$DEST/$name"
  cp "$skill_dir/SKILL.md" "$DEST/$name/SKILL.md"
  echo "synced $name"
done
