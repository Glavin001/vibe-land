#!/usr/bin/env bash
# Repeat the fracture-continuity spec on a freshly reset city and print the
# JSON summary line from each run. The assertion is damage-sensitive -- a
# strided distant chunk is legitimately up to 8 frames stale -- so a single
# run cannot tell a regression from a heavier demolition.
LABEL="$1"; RUNS="${2:-3}"
for i in $(seq 1 "$RUNS"); do
  curl -sk -X POST --max-time 60 "https://127.0.0.1:6006/city-reset/city-default" >/dev/null 2>&1
  sleep 8
  E2E_CITY=1 E2E_CITY_WIRE=3 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
    timeout 600 npx playwright test --config e2e/playwright.config.ts city-fracture-continuity 2>&1 \
    | grep -E "cont-json" | sed "s/^/[$LABEL run$i] /"
done
