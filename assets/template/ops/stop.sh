#!/usr/bin/env bash
# Stop the QQ bridge daemon via its pidfile (SIGTERM = graceful:
# pending merged inbound messages are flushed before exit).
set -u
BASE="${QQ_BRIDGE_ROOT:-$HOME/workspace/qq-bridge}"
PIDFILE="$BASE/state/daemon.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "not_running (no pidfile)"
  exit 0
fi
PID="$(cat "$PIDFILE" 2>/dev/null || echo '')"
if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 1 20); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "still alive after SIGTERM, pid=$PID (not forcing)"
    exit 1
  fi
  echo "stopped pid=$PID"
else
  echo "not_running (stale pidfile)"
  rm -f "$PIDFILE"
fi
