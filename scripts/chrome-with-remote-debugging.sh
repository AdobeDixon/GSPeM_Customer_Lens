#!/usr/bin/env bash
# Start Google Chrome with CDP so Playwright can attach to YOUR profile (same extension data as daily use).
#
# 1. Quit Chrome completely (Cmd+Q), or this may attach to an existing process without the debug port.
# 2. Run:  bash scripts/chrome-with-remote-debugging.sh
# 3. In another terminal:  PLAYWRIGHT_CONNECT_CDP=1 npm run playwright:bpp-debug
#
# Default debug port is 9222 (override: REMOTE_DEBUG_PORT=9333 ./scripts/chrome-with-remote-debugging.sh)

set -euo pipefail
PORT="${REMOTE_DEBUG_PORT:-9222}"

CHROME=""
if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome-stable &>/dev/null; then
  CHROME="$(command -v google-chrome-stable)"
elif command -v chromium &>/dev/null; then
  CHROME="$(command -v chromium)"
else
  echo "Google Chrome not found. Install Chrome or set CHROME path." >&2
  exit 1
fi

echo "Starting Chrome with --remote-debugging-port=$PORT"
echo "Leave this window open, then run Playwright with PLAYWRIGHT_CONNECT_CDP=1"
exec "$CHROME" --remote-debugging-port="$PORT" "$@"
