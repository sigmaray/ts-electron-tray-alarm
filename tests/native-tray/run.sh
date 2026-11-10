#!/usr/bin/env bash
set -euo pipefail

Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp &
xvfb_pid=$!
cleanup() {
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo >/dev/null

xfce4-panel --disable-wm-check &
panel_pid=$!
cleanup() {
  kill "$panel_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT

sleep 2
npx playwright test tests/e2e/native-tray.spec.ts --grep "native tray menu opens"
