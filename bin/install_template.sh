#!/usr/bin/env bash
# Install the QQ bridge template into a runtime directory.
# Usage:
#   install_template.sh [target_dir] [--install-deps]
# Default target: ~/workspace/qq-bridge
# Safe defaults: never creates a real credentials.json; existing
# config.json is preserved because the template ships only *.example.
set -euo pipefail

TARGET="${1:-$HOME/workspace/qq-bridge}"
if [[ "${1:-}" != "" && "${1:-}" != --install-deps ]]; then
  shift
else
  TARGET="$HOME/workspace/qq-bridge"
fi
INSTALL_DEPS=0
for arg in "$@"; do
  if [[ "$arg" == "--install-deps" ]]; then INSTALL_DEPS=1; fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$SKILL_DIR/assets/template"

if [[ ! -d "$SRC" ]]; then
  echo "template not found: $SRC" >&2
  exit 2
fi

mkdir -p "$TARGET"
cp -r "$SRC"/. "$TARGET"/
mkdir -p "$TARGET/bridge" "$TARGET/hooks" "$TARGET/ops" "$TARGET/config" \
  "$TARGET/queue/inbound" "$TARGET/queue/outbound" "$TARGET/queue/sent" \
  "$TARGET/queue/failed" "$TARGET/queue/processed" \
  "$TARGET/state" "$TARGET/logs"

if [[ ! -f "$TARGET/config/config.json" && -f "$TARGET/config/config.example.json" ]]; then
  cp "$TARGET/config/config.example.json" "$TARGET/config/config.json"
  echo "created config/config.json from example (non-secret fields only)"
fi

chmod +x "$TARGET/ops/"*.sh "$TARGET/hooks/"*.sh 2>/dev/null || true
for f in "$TARGET/bridge/"*.mjs; do node --check "$f" >/dev/null; done
echo "node --check: all bridge/*.mjs OK"

if [[ "$INSTALL_DEPS" == "1" ]]; then
  (cd "$TARGET" && npm install --no-audit --no-fund)
  (cd "$TARGET" && node --input-type=module -e "import('@tencent-connect/qqbot-nodejs').then(() => console.log('qqbot-nodejs import ok'))")
else
  echo "deps not installed; run npm install in the target dir before starting"
fi

echo "template installed at $TARGET"
echo "next: node bridge/smoke-test.mjs, then node bridge/bind.mjs (owner scans QR), then follow CHECKLIST.md"
