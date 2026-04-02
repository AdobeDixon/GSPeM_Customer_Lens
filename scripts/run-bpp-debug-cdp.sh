#!/usr/bin/env bash
# Run Playwright B/P/P debug against YOUR Chrome profile (tags, customers, filter) via CDP.
#
# If Chrome is already running WITHOUT --remote-debugging-port, a second launch usually
# forwards to that session and CDP never binds. Fix: fully quit Chrome (Cmd+Q), then:
#   bash scripts/run-bpp-debug-cdp.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENDPOINT="${CDP_ENDPOINT:-http://127.0.0.1:9222}"
PORT="${CDP_PORT:-9222}"

if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 "${ENDPOINT}/json/version" 2>/dev/null | grep -q 200; then
  echo "[run-bpp-debug-cdp] CDP already up at ${ENDPOINT}"
else
  echo "[run-bpp-debug-cdp] No listener on port ${PORT}. Starting Chrome with CDP..."
  if [[ "$(uname)" == "Darwin" ]] && [[ -d "/Applications/Google Chrome.app" ]]; then
    # New instance so we don't get 'Opening in existing browser session' without the debug port
    open -na "Google Chrome" --args --remote-debugging-port="${PORT}"
  else
    google-chrome-stable --remote-debugging-port="${PORT}" 2>/dev/null &
    chromium --remote-debugging-port="${PORT}" 2>/dev/null &
  fi
  for i in $(seq 1 20); do
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 "${ENDPOINT}/json/version" 2>/dev/null | grep -q 200; then
      echo "[run-bpp-debug-cdp] CDP ready."
      break
    fi
    sleep 1
    if [[ "$i" -eq 20 ]]; then
      echo "[run-bpp-debug-cdp] ERROR: CDP never came up on ${ENDPOINT}" >&2
      echo "  Quit Chrome completely (Cmd+Q), then run this script again." >&2
      exit 1
    fi
  done
fi

export PLAYWRIGHT_CONNECT_CDP=1
export CDP_ENDPOINT="${ENDPOINT}"
exec npm run playwright:bpp-debug -- "$@"
