#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

INBOX="$HOME/workspace/qq-bridge/queue/inbound"

# Poll the local QQ bridge inbox only. No secrets, no network calls.
if [[ ! -d "$INBOX" ]]; then
  log "inbox_missing" "{\"path\":\"queue/inbound\"}"
  silent "qq inbox directory not present yet" "{}"
  exit 0
fi

# Collect inbound json files (oldest first). Avoid state writes: worker
# removes each inbound file after processing, so file presence is the
# detection signal and a failed worker run will be retried next poll.
shopt -s nullglob
files=("$INBOX"/*.json)
if [[ ${#files[@]} -eq 0 ]]; then
  silent "no new qq messages" "{}"
  exit 0
fi

first="${files[0]}"
count="${#files[@]}"
first_name="$(basename "$first")"

# Build a small JSON payload without embedding message bodies; the worker
# reads the inbound files itself.
payload="$(python3 - "$first_name" "$count" <<'PY'
import json, sys
print(json.dumps({"first_file": sys.argv[1], "count": int(sys.argv[2])}, ensure_ascii=False))
PY
)"

log "inbox_detected" "$payload"
wake "new QQ message(s) waiting in bridge inbox" "$payload"
