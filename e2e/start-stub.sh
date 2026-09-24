#!/bin/bash
# Start (or restart) the local stub provider from e2e/fake-llm.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidfile="$here/.stub.pid"

if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  kill "$(cat "$pidfile")" 2>/dev/null || true
  sleep 0.3
fi

FAKE_PORT="${FAKE_PORT:-8931}" \
FAKE_DELAY_MS="${FAKE_DELAY_MS:-0}" \
nohup node "$here/fake-llm.mjs" > "$here/.stub.log" 2>&1 &
echo $! > "$pidfile"
sleep 1
cat "$here/.stub.log"
