#!/usr/bin/env bash
# scripts/unreal/glass-test.sh: VibeCity.Render.Glass on a scene with windows.
#
# The stock city has no glass, so this starts a side server (:6901, WebTransport :6902) on
# house-1story.json and runs the test there with -VibeExpectGlass, saving
# target/unreal-shots/glass/glass.png. The side server is the synthetic (Rapier, physics-free) city:
# glass needs only the manifest drawn, and a second PhysX server on the Mac's GPU starved the
# game's frames (0.08 fps). Waits first until no Unreal game window has been open for 30 s, so it
# runs alone. Needs target/garage-vehicles/release/web-fps-server (any server build will do).
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$R"
quiet=0
for i in $(seq 1 540); do
  if pgrep -f "UnrealEditor.*-game" >/dev/null; then quiet=0; else quiet=$((quiet+5)); fi
  [ $quiet -ge 30 ] && break
  sleep 5
done
[ $quiet -ge 30 ] || { echo "a game window stayed open; gave up"; exit 1; }
scripts/unreal/build-editor.sh > target/unreal-build-glass.log 2>&1 || { echo "build failed"; grep " error" target/unreal-build-glass.log | head -5; exit 1; }
lsof -nP -iTCP:6901 -sTCP:LISTEN >/dev/null && { echo "6901 taken"; exit 1; }
mkdir -p target/glass-side target/unreal-shots/glass target/unreal-tests/citypp-glass
BIND_ADDR=127.0.0.1:6901 WT_BIND_ADDR=0.0.0.0:6902 WT_HOST=127.0.0.1 WEB_BIND_ADDR= VIBE_CITY_SYNTHETIC=1 VIBE_PHYSICS_BACKEND=rapier \
  PHYSX_ROOT=$R/../PhysX/out/install/garage-multihull VIBE_CITY_SCENE=house-1story.json VIBE_CITY_GRID=1 RUST_LOG=info \
  CUMETAL_CACHE_DIR=$R/target/cumetal-cache-vehicles target/garage-vehicles/release/web-fps-server > target/glass-side/server.log 2>&1 &
for i in $(seq 1 30); do curl -s -m2 127.0.0.1:6901/healthz >/dev/null && break; sleep 2; done
L=$R/target/unreal-tests/citypp-glass/Glass.log; rm -f $L
"/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor" $R/unreal/VibeCity/VibeCity.uproject -game -windowed -ResX=1280 -ResY=720 \
  -VibeApi=http://127.0.0.1:6901 -VibeMatch=citypp-glass -VibeExpectGlass -VibeShotDir=$R/target/unreal-shots/glass \
  "-ExecCmds=Automation RunTests VibeCity.Render.Glass; Quit" "-TestExit=Automation Test Queue Empty" -abslog=$L >/dev/null 2>&1 & pid=$!
for i in $(seq 1 100); do kill -0 $pid 2>/dev/null || break; sleep 3; done
kill $pid 2>/dev/null; for i in $(seq 1 20); do kill -0 $pid 2>/dev/null || break; sleep 1; done; kill -9 $pid 2>/dev/null
kill $(lsof -tiTCP:6901 -sTCP:LISTEN) 2>/dev/null
grep -h "glass:\|Hit .* FPS\|Error: " $L | sed 's/.*Controller: //' | head -8
grep -q "Result={Success}" $L && echo "PASS VibeCity.Render.Glass" || echo "FAIL VibeCity.Render.Glass ($L)"
ls -la target/unreal-shots/glass/
