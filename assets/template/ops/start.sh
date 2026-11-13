#!/usr/bin/env bash
# Idempotent QQ bridge starter.
# - If the daemon (pid from state/daemon.pid) is already alive, do nothing.
# - Otherwise launch it detached with nohup; it reads credentials from
#   config/credentials.json itself (0600, local file mode).
# Used by humans, the health hook, and post-reboot recovery alike.
set -u
BASE="${QQ_BRIDGE_ROOT:-$HOME/workspace/qq-bridge}"
LOG="$BASE/logs/daemon_stdout.log"
mkdir -p "$BASE/logs" "$BASE/state" "$BASE/queue/inbound" "$BASE/queue/outbound" \
  "$BASE/queue/sent" "$BASE/queue/failed" "$BASE/queue/processed"

PIDFILE="$BASE/state/daemon.pid"
if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || echo '')"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    echo "already_running pid=$PID"
    exit 0
  fi
fi

if [[ ! -f "$BASE/config/credentials.json" ]]; then
  echo "missing_credentials_file: run node bridge/bind.mjs first"
  exit 2
fi

cd "$BASE"
nohup node bridge/qq-daemon.mjs >>"$LOG" 2>&1 &
echo "started pid=$!"
