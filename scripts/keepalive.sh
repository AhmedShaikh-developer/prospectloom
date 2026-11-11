#!/bin/bash
# Keeps the app running on a Mac: if it ever stops (a crash, a dropped connection), it starts again
# within a few seconds, and the Mac is kept awake while it runs (sleep would stop the schedule).
#   npm run forever        start in the background (log: data/server.log)
#   npm run stop           stop it
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
LOG="data/server.log"
PIDFILE="data/keepalive.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PIDFILE")). Log: $LOG"
  exit 0
fi
echo $$ > "$PIDFILE"

child=""
stop() { [ -n "$child" ] && kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; rm -f "$PIDFILE"; echo "[$(date '+%F %T')] stopped by you" >> "$LOG"; exit 0; }
trap stop INT TERM

quick=0
while true; do
  # keep the log small: one old copy, 5 MB each
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi
  echo "[$(date '+%F %T')] starting" >> "$LOG"
  started=$(date +%s)
  caffeinate -i node --disable-warning=ExperimentalWarning src/server.js >> "$LOG" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""
  # a crash right after starting (port taken, broken config) waits longer before the next try
  if [ $(( $(date +%s) - started )) -lt 30 ]; then quick=$((quick + 1)); else quick=0; fi
  delay=5; [ "$quick" -ge 3 ] && delay=60
  echo "[$(date '+%F %T')] stopped (exit $code), starting again in ${delay}s" >> "$LOG"
  sleep "$delay"
done
