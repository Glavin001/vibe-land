#!/usr/bin/env python3
"""Build and verify the native Vehicle2 fracture foundation, without deployment.

Uses an already configured isolated PhysX build. This does not qualify full
garage assets, CUDA on another host, or performance. GPU tests run sequentially.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


TESTS = {
    "physx_native_constraint_fracture", "physx_native_constraint_loads",
    "physx_native_vehicle_constraints", "physx_native_vehicle_loads", "physx_native_vehicle_mass",
    "physx_native_feature_reference", "physx_native_chunk_torque",
    "physx_native_chunk_loads", "physx_native_multihull",
    "physx_native_parallel_bonds", "physx_native_post_correction",
    "physx_native_post_correction_pgs",
}
TARGETS = ["native_constraint_fracture_test", "native_constraint_loads_test",
           "native_vehicle_constraints_test", "native_vehicle_loads_test", "native_vehicle_mass_test",
           "native_feature_reference_test", "native_standard_scene_test"]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--physx-root", type=Path, required=True)
    parser.add_argument("--build-root", type=Path, required=True,
                        help="Isolated root containing physx/ and package/ CMake builds")
    parser.add_argument("--output", type=Path, required=True,
                        help="New evidence directory; never overwrites an existing run")
    args = parser.parse_args()
    root, build, output = args.physx_root.resolve(), args.build_root.resolve(), args.output.resolve()
    for folder in (build / "physx", build / "package"):
        if not (folder / "CMakeCache.txt").is_file():
            parser.error(f"Missing configured CMake build: {folder}")
    if not (root / "physx/include/PxDestructionScene.h").is_file():
        parser.error("--physx-root is not a PhysX source checkout")
    if output.exists():
        parser.error("--output must be a new directory")
    output.mkdir(parents=True)
    report = {"schema": 1, "status": "running", "commands": [],
              "scope": "native Vehicle2 constraint fracture foundation",
              "garageVehicleQualified": False, "performanceQualified": False,
              "remoteCudaQualified": False, "physxRoot": str(root), "buildRoot": str(build)}
    report_path = output / "report.json"

    def save():
        report_path.write_text(json.dumps(report, indent=2) + "\n")

    def run(name, command):
        print(name, flush=True)
        row = {"name": name, "command": command, "log": name + ".log"}
        report["commands"].append(row)
        save()
        with (output / row["log"]).open("w") as log:
            result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        row["exitCode"] = result.returncode
        save()
        if result.returncode:
            raise RuntimeError(f"{name} failed; see {output / row['log']}")

    try:
        run("build-engine", ["cmake", "--build", str(build / "physx"),
                             "--target", "PhysX", "PhysXGpu", "-j4"])
        run("build-tests", ["cmake", "--build", str(build / "package"),
                            "--target", *TARGETS, "-j4"])
        expression = "^(" + "|".join(sorted(TESTS)) + ")$"
        command = ["ctest", "--test-dir", str(build / "package"), "-R", expression]
        listing = subprocess.check_output([*command, "--show-only=json-v1"], text=True)
        (output / "test-inventory.json").write_text(listing)
        found = {test["name"] for test in json.loads(listing)["tests"]}
        if found != TESTS:
            raise RuntimeError(f"Test inventory mismatch: missing={sorted(TESTS-found)}, unexpected={sorted(found-TESTS)}")
        artifacts = [build / "package/reference" / target for target in TARGETS]
        libraries = list((build / "artifacts/bin").glob("**/libPhysXDestructionGpuRuntime_64.*"))
        libraries += list((build / "artifacts/bin").glob("**/libPhysXGpuActivity_64.*"))
        if not libraries:
            raise RuntimeError("No isolated GPU runtime libraries found")
        artifacts += libraries
        report["artifacts"] = {str(path): digest(path) for path in artifacts}
        header = (root / "physx/include/PxDestructionScene.h").read_text()
        report["publicAbi"] = int(re.search(r"#define PX_DESTRUCTION_SCENE_VERSION (\d+)", header)[1])
        report["sourceCommit"] = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        report["sourceStatus"] = subprocess.check_output(["git", "-C", str(root), "status", "--short"], text=True).splitlines()
        diff = subprocess.check_output(["git", "-C", str(root), "diff", "--binary", "HEAD"])
        report["trackedSourceDiffSha256"] = hashlib.sha256(diff).hexdigest()
        run("native-tests", [*command, "--no-tests=error", "-V", "-j1"])
        if any(digest(Path(path)) != value for path, value in report["artifacts"].items()):
            raise RuntimeError("Native artifacts changed during verification")
        report["passedTests"] = sorted(found)
        report["status"] = "passed"
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        report["status"] = "failed"
        report["error"] = str(error)
        print(error, file=sys.stderr)
    finally:
        save()
    print(report_path)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
