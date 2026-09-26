#!/usr/bin/env python3
"""Repeatable GPU vehicle impact diagnostic; fracture qualification fails closed.

Prepare fixtures with client/scripts/verify-vehicle-builds.mjs. By default an
impact with no registered native fracture graph or no broken bonds is a failure.
--contact-only explicitly narrows the gate to physical projectile contact.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--build', type=int, default=0, help='Index in the prepared fixture array')
    parser.add_argument('--part', help='Authored collider part ID to aim at; defaults to chassis origin')
    parser.add_argument('--contact-only', action='store_true')
    args = parser.parse_args()
    if not args.fixtures.is_file() or args.build < 0:
        parser.error('Pass an existing fixture file and a nonnegative build index')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(VIBE_VEHICLE_BUILD_FIXTURES=str(args.fixtures.resolve()),
               VIBE_VEHICLE_IMPACT_REPORT=str(args.report.resolve()),
               VIBE_VEHICLE_IMPACT_BUILD=str(args.build))
    env.pop('VIBE_VEHICLE_IMPACT_PART', None)
    env.pop('VIBE_VEHICLE_REQUIRE_FRACTURE', None)
    if args.part:
        env['VIBE_VEHICLE_IMPACT_PART'] = args.part
    if not args.contact_only:
        env['VIBE_VEHICLE_REQUIRE_FRACTURE'] = '1'
    command = ['cargo', 'test', '-p', 'web-fps-server', '--bin', 'web-fps-server',
               '--features', 'native-destruction', 'garage_targeted_projectile_probe',
               '--', '--ignored', '--nocapture']
    print('Gate: ' + ('contact only; does not qualify destruction' if args.contact_only
                      else 'fracture required'), flush=True)
    return subprocess.run(command, cwd=Path(__file__).resolve().parents[1], env=env).returncode


if __name__ == '__main__':
    sys.exit(main())
