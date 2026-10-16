#!/bin/bash
# The native app must never hang the desktop. Runs a scene in the app's window
# (default Vibe Town in the high profile: the largest, and the one that hung)
# for SOAK_S seconds (default 120: every hang seen came 52-68 s after launch),
# and fails when WindowServer stops answering:
#   - the WindowServer guard (scripts/ops/ws-guard.sh) fires: no answer to a
#     window-list request within 2 s, far inside macOS's 40 s watchdog;
#   - any probe round trip over SOAK_WS_LIMIT_MS (2000);
#   - a new WindowServer watchdog report appears in /Library/Logs/DiagnosticReports.
# Also reports the app's GPU memory and allocation count over the run.
#   scripts/verify/native-soak.sh [--scene town] [--profile high|runtime] [OUTDIR]
# Takes the screen and the GPU: run it alone (nothing else on the GPU).
# Parsed whole before it runs ({ ...; exit; }).
{
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
scene=town; profile=high; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scene) scene=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    *) out=$1; shift ;;
  esac
done
out=${out:-$ROOT/target/verify/native-soak-$scene-$profile}
mkdir -p "$out"; : > "$out/samples.txt"
SOAK_S=${SOAK_S:-120}; LIMIT_MS=${SOAK_WS_LIMIT_MS:-2000}
if pgrep -x mystral >/dev/null; then echo "native-soak: the app is already running; run alone" >&2; exit 2; fi
reports_before=$(ls /Library/Logs/DiagnosticReports 2>/dev/null | grep -c '^WindowServer.*watchdog')
cd "$ROOT"
(
  source "scripts/fidelity/$profile.env"
  exec scripts/ops/ws-guard.sh scripts/native-mac.sh run --scene "$scene"
) > "$out/app.log" 2>&1 &
guard=$!
pid=""
for _ in $(seq 1 900); do pid=$(pgrep -x mystral | head -1); [ -n "$pid" ] && break; kill -0 "$guard" 2>/dev/null || break; sleep 1; done
if [ -z "$pid" ]; then echo "native-soak: the app never started (see $out/app.log)"; exit 1; fi
fail=""
start=$SECONDS
while [ $((SECONDS - start)) -lt "$SOAK_S" ]; do
  kill -0 "$pid" 2>/dev/null || { fail="the app exited at $((SECONDS - start)) s"; break; }
  ms=$(perl -e 'alarm 3; exec @ARGV' scripts/ops/ws-probe/ws_probe 2>/dev/null || echo timeout)
  gpu=$(footprint -p "$pid" 2>/dev/null | grep -E 'IOAccelerator \(graphics\)$' | awk '{print $1$2" in "$(NF-2)" allocations"}' | head -1)
  echo "t=$((SECONDS - start)) ws_ms=$ms gpu=${gpu:-?}" >> "$out/samples.txt"
  if [ "$ms" = timeout ] || awk -v m="$ms" -v l="$LIMIT_MS" 'BEGIN{exit !(m>l)}'; then fail="WindowServer answered in $ms ms at $((SECONDS - start)) s"; break; fi
  sleep 1
done
pkill -KILL -x mystral 2>/dev/null; wait "$guard" 2>/dev/null; guard_status=$?
grep -q '\[ws-guard\]' "$out/app.log" && fail="${fail:+$fail; }$(grep '\[ws-guard\]' "$out/app.log" | head -1)"
reports_after=$(ls /Library/Logs/DiagnosticReports 2>/dev/null | grep -c '^WindowServer.*watchdog')
[ "$reports_after" -gt "$reports_before" ] && fail="${fail:+$fail; }a new WindowServer watchdog report"
worst=$(awk -F'ws_ms=' '{split($2,a," "); if (a[1]+0 > m) m = a[1]+0} END{print m}' "$out/samples.txt")
echo "native-soak $scene ($profile): $((SECONDS - start)) s; WindowServer worst $worst ms; GPU $(tail -1 "$out/samples.txt" | sed 's/.*gpu=//')"
if [ -n "$fail" ]; then echo "native-soak: FAIL: $fail"; exit 1; fi
echo "native-soak: PASS (the desktop answered throughout)"
exit 0
}
