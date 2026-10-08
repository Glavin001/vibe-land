#!/usr/bin/env python3
"""Per-kernel codegen identity between two PhysX revisions (or two CuMetal compilers).

    scripts/ops/kernel-identity.sh REV_A REV_B [--build DIR] [--tu REGEX] [--all]
                                   [--cumetalc-a PATH] [--cumetalc-b PATH] [--keep]

For every CuMetal translation unit of a configured PhysX build (its Makefile
cumetalc commands), compile REV_A and REV_B to MSL and then to AIR with the
production Metal flags, and compare each function:

- MSL: every kernel together with its whole callee closure, value numbering
  normalized (CuMetal numbers values module-wide), callees replaced by the hash
  of their own canonical form (clone suffix numbers then do not matter).
- AIR (`xcrun metal -S -emit-llvm`): every function body, metadata and
  attribute-group numbers and CuMetal clone suffixes normalized.

A kernel that exists at both revisions and differs in either is reported. Exit
1 if any differs, 0 if every common kernel is identical (new or removed kernels
are listed, not failures). Identical AIR means identical pipelines: Metal
compiles each pipeline from its function's AIR alone.

With --cumetalc-a/--cumetalc-b (and REV_A == REV_B) it compares two compilers on
one source revision instead: which kernels a compiler change touches.

The build (default: the shared garage-hifi build root) supplies the compile
commands and generated headers; each revision is checked out in a temporary
detached worktree of that build's checkout. CPU only; no GPU, no SDK change.
"""
import argparse
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_BUILD = "/Users/glavin/Development/PhysX/.claude/worktrees/hifi/out/build/garage-hifi"
METAL_FLAGS = ["-fno-strict-aliasing", "-fno-fast-math", "-ffp-contract=fast"]  # air_emitter math_flags (CuMetal default)
DEFAULT_TU = r"/(gpudestruction|extensions/stressgpu)/"


def compile_commands(build: Path):
    """(source, cumetalc, args, cwd) for every cumetalc object rule in the build's Makefiles."""
    seen = {}
    for make in build.rglob("build.make"):
        for line in make.read_text(errors="replace").splitlines():
            if "cumetalc " not in line or " -c " not in line or ".cu" not in line:
                continue
            cmd = line.strip()
            cwd = None
            m = re.match(r"cd (\S+) && (.*)", cmd)
            if m:
                cwd, cmd = m.group(1), m.group(2)
            parts = shlex.split(cmd)
            if not parts or not parts[0].endswith("cumetalc"):
                continue
            src = next((p for p in parts[1:] if p.endswith(".cu")), None)
            if src and src not in seen:
                seen[src] = (src, parts[0], parts[1:], cwd)
    return list(seen.values())


def rebase(p, root_old, root_new):
    """Point a source path at the other revision's tree; build outputs (out/) stay."""
    if root_old not in p or (root_old + "/out/") in p:
        return p
    return p.replace(root_old, root_new)


def emit(cumetalc, args, root_old, root_new, out_msl, cwd):
    a = []
    skip = False
    for i, p in enumerate(args):
        if skip:
            skip = False
            continue
        if p == "-c":
            continue
        if p == "-o":
            skip = True
            continue
        a.append(rebase(p, root_old, root_new))
    cmd = [cumetalc, *a, "--emit=msl", "--overwrite", "-o", str(out_msl)]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0 or not out_msl.exists():
        return (r.stdout + r.stderr)[-2000:]
    return None


def to_air(msl: Path, air: Path):
    r = subprocess.run(["xcrun", "metal", *METAL_FLAGS, "-S", "-emit-llvm", str(msl), "-o", str(air)],
                       capture_output=True, text=True)
    return None if r.returncode == 0 else r.stderr[-2000:]


FUNC = re.compile(r"^(?:\[\[[^\n]*\]\]\n)?(kernel )?[A-Za-z_][\w:<>* ]*?\s(\w+)\(\n(.*?)^\}\n", re.S | re.M)


def msl_closures(path: Path):
    src = path.read_text()
    fs, kernels = {}, set()
    for m in FUNC.finditer(src):
        fs[m.group(2)] = m.group(0)
        if m.group(1):
            kernels.add(m.group(2))
    sys.setrecursionlimit(100000)
    memo = {}

    def canon(n):
        if n in memo:
            return memo[n]
        body = fs[n].split("(", 1)[1]
        body = re.sub(r"\b(\w+)\(", lambda m: ("F" + canon(m.group(1))[:16] + "(")
                      if (m.group(1) in fs and m.group(1) != n) else m.group(0), body)
        ids = {}
        body = re.sub(r"\bv\d+", lambda m: ids.setdefault(m.group(0), "v%d" % len(ids)), body)
        memo[n] = hashlib.sha256(body.encode()).hexdigest()
        return memo[n]

    return {k: canon(k) for k in kernels}


DEFINE = re.compile(r'^define [^\n]*@"?([\w.$]+)"?\(.*?^\}\n', re.S | re.M)


def air_norm_name(n):
    return re.sub(r"_Z\d+_ZN", "_ZN", re.sub(r"__cm_([a-z_]+?)_\d+", r"__cm_\1_N", n))


def air_functions(path: Path):
    out = {}
    for m in DEFINE.finditer(path.read_text()):
        body = re.sub(r"!\d+", "!M", m.group(0))
        body = re.sub(r"#\d+", "#A", body)
        body = air_norm_name(body)
        out.setdefault(air_norm_name(m.group(1)), []).append(hashlib.sha256(body.encode()).hexdigest())
    return {k: sorted(v) for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("rev_a")
    ap.add_argument("rev_b")
    ap.add_argument("--build", default=os.environ.get("KERNEL_IDENTITY_BUILD", DEFAULT_BUILD))
    ap.add_argument("--tu", default=None, help="regex on the source path (default: gpudestruction and stressgpu)")
    ap.add_argument("--all", action="store_true", help="every CuMetal translation unit of the build (--tu still filters)")
    ap.add_argument("--cumetalc-a", default=None, help="compiler for REV_A (default: the build's)")
    ap.add_argument("--cumetalc-b", default=None, help="compiler for REV_B (default: the build's)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--keep", action="store_true", help="keep the work directory")
    args = ap.parse_args()

    build = Path(args.build).resolve()
    checkout = build.parent.parent.parent  # <checkout>/out/build/<name>
    if not (checkout / ".git").exists():
        sys.exit(f"kernel-identity: {build} is not <checkout>/out/build/<name>")
    cmds = compile_commands(build)
    pattern = args.tu or (None if args.all else DEFAULT_TU)
    if pattern:
        cmds = [c for c in cmds if re.search(pattern, c[0])]
    if not cmds:
        sys.exit("kernel-identity: no matching cumetalc translation units in " + str(build))

    work = Path(tempfile.mkdtemp(prefix="kernel-identity-"))
    trees = {}
    try:
        for side, rev in (("a", args.rev_a), ("b", args.rev_b)):
            sha = subprocess.run(["git", "-C", str(checkout), "rev-parse", "--verify", rev + "^{commit}"],
                                 capture_output=True, text=True)
            if sha.returncode != 0:
                sys.exit(f"kernel-identity: unknown revision {rev}")
            tree = work / f"src-{side}"
            subprocess.run(["git", "-C", str(checkout), "worktree", "add", "--detach", "-q", str(tree), sha.stdout.strip()],
                           check=True)
            trees[side] = tree
        compilers = {"a": args.cumetalc_a, "b": args.cumetalc_b}

        def job(cmd):
            src, cumetalc, cargs, cwd = cmd
            name = Path(src).stem + "-" + hashlib.sha1(src.encode()).hexdigest()[:8]
            res = {"tu": src.replace(str(checkout) + "/", "")}
            for side in ("a", "b"):
                msl, air = work / f"{name}.{side}.metal", work / f"{name}.{side}.ll"
                err = emit(compilers[side] or cumetalc, cargs, str(checkout), str(trees[side]), msl, cwd)
                if err:
                    res["error"] = f"{side}: cumetalc failed: {err}"
                    return res
                err = to_air(msl, air)
                if err:
                    res["error"] = f"{side}: metal failed: {err}"
                    return res
                res[side] = (msl_closures(msl), air_functions(air))
            (ka, fa), (kb, fb) = res["a"], res["b"]
            res["kernels"] = len(set(ka) & set(kb))
            res["msl_diff"] = sorted(k for k in set(ka) & set(kb) if ka[k] != kb[k])
            res["air_diff"] = sorted(f for f in set(fa) & set(fb) if fa[f] != fb[f])
            res["added"] = sorted(set(kb) - set(ka))
            res["removed"] = sorted(set(ka) - set(kb))
            del res["a"], res["b"]
            return res

        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            results = list(pool.map(job, cmds))
    finally:
        for tree in trees.values():
            subprocess.run(["git", "-C", str(checkout), "worktree", "remove", "--force", str(tree)],
                           capture_output=True)
        if args.keep:
            print(f"kept {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    failed = errors = 0
    for r in sorted(results, key=lambda r: r["tu"]):
        if "error" in r:
            errors += 1
            lines = [l for l in r["error"].strip().splitlines() if l.strip()]
            side, _, _ = r["error"].partition(":")
            detail = next((l for l in lines if "failed:" in l and "device compilation failed" not in l), lines[-1] if lines else "")
            print(f"ERROR {r['tu']} (revision {side.strip().upper()}): {detail.strip()[:300]}")
            continue
        changed = bool(r["msl_diff"] or r["air_diff"])
        failed += changed
        print(f"{'DIFF ' if changed else 'same '} {r['tu']}: {r['kernels']} common kernels, "
              f"{len(r['msl_diff'])} differ in MSL, {len(r['air_diff'])} functions differ in AIR"
              + (f"; added {len(r['added'])}" if r["added"] else "") + (f"; removed {len(r['removed'])}" if r["removed"] else ""))
        for k in r["msl_diff"][:20]:
            print(f"    msl  {k}")
        for f in r["air_diff"][:20]:
            print(f"    air  {f}")
    print(f"kernel-identity: {len(results)} translation units, {failed} with differing kernels, {errors} errors")
    sys.exit(1 if failed or errors else 0)


if __name__ == "__main__":
    main()
