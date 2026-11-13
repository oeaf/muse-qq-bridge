#!/usr/bin/env bash
# Report QQ bridge daemon status: pid alive? heartbeat fresh? queue depths?
# No secrets are read or printed.
set -u
BASE="${QQ_BRIDGE_ROOT:-$HOME/workspace/qq-bridge}"
PIDFILE="$BASE/state/daemon.pid"
HB="$BASE/state/heartbeat.json"

if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || echo '')"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    echo "process: running pid=$PID"
  else
    echo "process: NOT running (stale pidfile pid=${PID:-?})"
  fi
else
  echo "process: NOT running (no pidfile)"
fi

if [[ -f "$HB" ]]; then
  python3 - "$HB" <<'PY'
import json, sys, time
try:
    hb = json.load(open(sys.argv[1]))
    age = int(time.time()) - int(hb.get("ts", 0))
    print(f"heartbeat: age={age}s connected={hb.get('connected')} dry_run={hb.get('dry_run')}")
except Exception as e:
    print(f"heartbeat: unreadable ({e})")
PY
else
  echo "heartbeat: missing"
fi

for d in inbound outbound sent failed processed; do
  n=$(find "$BASE/queue/$d" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  echo "queue/$d: $n file(s)"
done
if [[ -f "$BASE/config/credentials.json" ]]; then
  echo "credentials: present (values not shown)"
else
  echo "credentials: MISSING (run node bridge/bind.mjs)"
fi
