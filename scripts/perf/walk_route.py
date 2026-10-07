#!/usr/bin/env python3
"""Does the game's player walk a building's route? The production player on the GPU stage.

    scripts/perf/walk_route.py PACK [--meta META] [--rest-ticks 180] [--json OUT]

PACK is a one-structure scene pack with a `route` in its metadata (PACK's
`.meta.json`, or --meta): feet points in the pack's coordinates, e.g. a house's
stair from the ground floor to the upper floor and back
(structures/town-kit/src/veneer-houses.mjs). The structure stands at rest
under the native app's stress settings (qualify_structures.py APP_ENV), then
the server's own player (the production arena and player tick, MoveConfig
default) walks every point in turn on walking input only
(structure_qualification.rs `route_walk`: what fails it is listed there --
a point not reached on the ground, a teleport, a fall of more than one code
riser, headroom under 2032 mm, a bond broken).

Runs through scripts/perf/gpu-run.sh (VIBE_GPU_SHARED=1 shares the GPU: this
is a correctness run). Exit 1 when the walk fails.
"""

import argparse
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qualify_structures import APP_ENV, ROOT, SCENES, build  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pack')
    parser.add_argument('--meta', help="the route's metadata (default: PACK's .meta.json)")
    parser.add_argument('--rest-ticks', type=int, default=180, help='ticks at rest before the walk')
    parser.add_argument('--snap', action='store_true', help='players snap to ground (VIBE_PLAYER_SNAP_TO_GROUND=1, MoveConfig.snap_to_ground)')
    parser.add_argument('--json', help='also write the result here')
    args = parser.parse_args()

    pack = os.path.abspath(args.pack)
    meta = os.path.abspath(args.meta) if args.meta else pack[:-len('.json')] + '.meta.json'
    binary = build()
    env = dict(os.environ, **APP_ENV, VIBE_CITY_SCENE=pack, VIBE_WALK_META=meta, VIBE_CITY_GRID='1',
               VIBE_CITY_VARIED_HEIGHTS='0', VIBE_QUALIFY_REST_TICKS=str(args.rest_ticks),
               VIBE_DESTRUCTION_ASSET_DIR=SCENES, VIBE_CITY_VEHICLES='0',
               CUMETAL_CACHE_DIR=os.path.join(ROOT, 'target', 'cumetal-cache-vehicles'))
    if args.snap:
        env['VIBE_PLAYER_SNAP_TO_GROUND'] = '1'
    result = subprocess.run(
        [os.path.join(ROOT, 'scripts', 'perf', 'gpu-run.sh'), 'walk-route', binary,
         'route_walk', '--ignored', '--nocapture', '--test-threads=1'],
        cwd=os.path.join(ROOT, 'server'), env=env, capture_output=True, text=True)
    text = result.stdout + result.stderr
    walk = re.search(r'route walk: (\{.*\})', text)
    if walk:
        summary = json.loads(walk.group(1))
    else:
        failure = re.search(r"panicked at [^\n]*\n([^\n]*)", text)
        summary = {'passed': False, 'error': failure.group(1) if failure else text[-3000:]}
    summary['pack'] = pack
    if summary['passed']:
        print(f"PASS  {len(summary['reached'])} points in {summary['seconds']:.1f} s; least headroom {summary['leastHeadroom']:.3f} m, "
              f"largest fall {summary['largestFall']:.3f} m, longest airborne {summary['longestAirborneTicks']} ticks")
        for p in summary['reached']:
            print(f"      {p['name']:<24} feet {', '.join(f'{v:.3f}' for v in p['feet'])}  tick {p['tick']}")
    else:
        print(f"FAIL  {summary['error']}")
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(summary, f, indent=1)
    sys.exit(0 if summary['passed'] else 1)


if __name__ == '__main__':
    main()
