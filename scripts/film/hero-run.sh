#!/usr/bin/env bash
# The hero film (client/native/films/hero-run.mjs) in Vibe Town's hero
# variant (--scene hero): checks, zone runs and takes, each judged.
#
#   scripts/film/hero-run.sh preview            a still per shot (cues not run), seconds
#   scripts/film/hero-run.sh check [ZONE]       a small quick take: 640x360 at 30 fps, its contact sheet
#   scripts/film/hero-run.sh stills [ZONE]      FILM_CHECK: every frame simulated, 2 stills a second
#                                               (faster, but the app's screenshots can fail mid-run)
#   scripts/film/hero-run.sh seeds ZONE N       N checks of a zone, seeds 1..N: how often it passes
#   scripts/film/hero-run.sh take [ZONE]        1080p60 with impact sounds (post.py --sfx)
#   scripts/film/hero-run.sh judge LOG          the verdict from a run's log
#
# ZONE: launch, driveway, cockpit, cafe, gauntlet, tower (hero-run-plan.mjs).
# A zone run parks the truck a run-up before the zone (its slot moved,
# VIBE_CITY_FLEET_SLOTS) and films that zone alone, the run-up trimmed.
# Every run ends with the film's `judge` line: how far the truck got, whether
# it stuck, flipped or lost a wheel, and each parked car's damage.
#
# FILM_SEED, FILM_SIZE, FILM_FPS as for any film; NATIVE_SKIP_SIM=1 to use the
# simulation library already built. Correctness runs share the GPU
# (VIBE_GPU_SHARED=1); takes for timing should not.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAN="$ROOT/client/native/films/hero-run-plan.mjs"
SLOTS="$ROOT/structures/vibe-town/out/vibe-town-hero.slots"
cmd="${1:-check}"; shift || true

judge() {
  python3 - "$1" "$PLAN" <<'EOF'
import json, re, subprocess, sys
log, plan = sys.argv[1], sys.argv[2]
zones = json.loads(subprocess.run(['node', '--input-type=module', '-e',
  f'import {{ ZONES }} from "{plan}"; console.log(JSON.stringify(ZONES))'], capture_output=True, text=True, check=True).stdout)
verdict, events, heroes = None, [], []
for line in open(log, errors='replace'):
    m = re.search(r'judge (\{.*\})\s*$', line)
    if m: verdict = json.loads(m.group(1))
    m = re.search(r'\bevent (\S+) at x (-?[\d.]+)', line)
    if m: events.append((m.group(1), float(m.group(2))))
    m = re.search(r'\bhero (\{.*\})\s*$', line)
    if m: heroes.append(json.loads(m.group(1)))
if not verdict:
    print(f'judge: no verdict in {log} (the take did not finish)'); sys.exit(2)
zone = verdict['zone']
target = next((z for z in zones if z['name'] == zone), zones[-1]) if zone != 'all' else zones[-1]
goal = target.get('stopX', target['toX']) - 2 if zone in ('all', 'tower') else target['toX']
fails = []
if verdict['reached'] < goal: fails.append(f"stopped at x {verdict['reached']} (short of {goal})")
if verdict['stuckS'] > 0.7: fails.append(f"stuck {verdict['stuckS']} s")
if verdict['flipped']: fails.append(f"flipped (up {verdict['minUp']})")
notes = []
if verdict['wheelsLost']: notes.append('lost a wheel')
if verdict['truckBondsBroken']: notes.append(f"truck: {verdict['truckBondsBroken']} bonds broken")
print(f"judge {zone}: {'PASS' if not fails else 'FAIL'}" + (f" -- {'; '.join(fails)}" if fails else '') + (f" ({', '.join(notes)})" if notes else ''))
print(f"  reached x {verdict['reached']}, plan {verdict['planMs']} ms avg, up to {verdict['maxHazards']} hazards, city bonds broken {verdict['cityBroken']}")
print('  events: ' + ', '.join(f'{z}@{x:.0f}' for z, x in events))
for c in verdict['cars']:
    if c.get('error'): continue
    hit = c['off'] or (c['broken'] or 0) or (c['moved'] or 0) > 0.5
    if hit: print(f"  car-{c['car']}: {c['off']}/{c['parts']} parts off, {c['broken']} bonds, moved {c['moved']} m, up {c['up']}")
sys.exit(1 if fails else 0)
EOF
}

# Zone environment: the define, the truck's slot moved to the run-up, the player beside it.
zone_env() {
  local zone="$1"
  [ -f "$SLOTS" ] || VIBE_TOWN_VARIANT=hero node "$ROOT/structures/vibe-town/build-town.mjs" >/dev/null
  export FILM_DEFINES="--define:HERO_ZONE=\"$zone\""
  if [ "$zone" != all ]; then
    VIBE_CITY_FLEET_SLOTS="$(node --input-type=module -e "import { zoneSlots } from '$PLAN'; import { readFileSync } from 'node:fs'; console.log(zoneSlots(readFileSync('$SLOTS', 'utf8'), '$zone'))")"
    export VIBE_CITY_FLEET_SLOTS
    export VIBE_CITY_SPAWN_X="$(node --input-type=module -e "import { zoneOf } from '$PLAN'; console.log(zoneOf('$zone').runup[0] - 4)")" VIBE_CITY_SPAWN_Z=3
  fi
}

run() {
  local zone="$1"; shift
  zone_env "$zone"
  local out; out="$ROOT/target/hero-run-$(date +%H%M%S)-$zone.out"
  echo "hero-run: $zone ($*) -> $out"
  # mystral is killed on its way out (exit 137, reference: mystralnative quirks):
  # a take that reached its cut is done whatever the status says.
  env "$@" VIBE_GPU_SHARED="${VIBE_GPU_SHARED:-1}" "$ROOT/scripts/native-mac.sh" film hero-run --scene hero > "$out" 2>&1 \
    || grep -qE '\[film [0-9.]+s\] cut$' "$out" || { tail -20 "$out"; echo "hero-run: FAILED ($out)" >&2; return 1; }
  local log; log=$(grep -oE '/[^ ]*hero-run-[0-9]+-[0-9]+\.log' "$out" | head -1)
  [ -n "$log" ] || log=$(ls -t "$ROOT"/target/native-video/hero-run-*.log | head -1)
  grep -oE '/[^ ]*hero-run-[0-9-]+-(check\.jpg|final\.mp4|share\.mp4|sheet\.jpg)' "$out" | sort -u | sed 's/^/  /' || true
  judge "$log"
}

case "$cmd" in
  preview) zone_env all; VIBE_GPU_SHARED=1 FILM_PREVIEW=1 "$ROOT/scripts/native-mac.sh" film hero-run --scene hero ;;
  check) run "${1:-all}" FILM_SIZE="${FILM_SIZE:-640x360}" FILM_FPS="${FILM_FPS:-30}" FILM_POST_ARGS="${FILM_POST_ARGS:-}" ;;
  stills) run "${1:-all}" FILM_CHECK=1 FILM_FPS="${FILM_FPS:-30}" ;;
  seeds)
    zone="${1:?zone}"; n="${2:-3}"; pass=0
    for seed in $(seq 1 "$n"); do
      if run "$zone" FILM_SIZE="${FILM_SIZE:-640x360}" FILM_FPS="${FILM_FPS:-30}" FILM_SEED="$seed"; then pass=$((pass + 1)); fi
    done
    echo "hero-run seeds $zone: $pass of $n passed" ;;
  take) run "${1:-all}" FILM_FPS="${FILM_FPS:-60}" FILM_SIZE="${FILM_SIZE:-1920x1080}" FILM_CUT_FPS="${FILM_CUT_FPS:-60}" FILM_POST_ARGS="${FILM_POST_ARGS:---sfx}" ;;
  judge) judge "${1:?log}" ;;
  *) echo "usage: $0 preview | check [ZONE] | stills [ZONE] | seeds ZONE N | take [ZONE] | judge LOG" >&2; exit 2 ;;
esac
