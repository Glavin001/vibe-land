#!/bin/bash
# Do two PhysX revisions compile every existing GPU kernel to the same code?
#   scripts/ops/kernel-identity.sh REV_A REV_B [--build DIR] [--tu REGEX] [--all]
#                                  [--cumetalc-a PATH --cumetalc-b PATH] [--keep]
# Per translation unit: each kernel's MSL (with its callees) and each function's
# AIR, normalized, at both revisions. Exit 1 if a common kernel differs. The
# cheap proof that a flags-off change leaves the shipping kernels bit-identical
# (identical AIR = identical pipelines). CPU only. See kernel_identity.py.
exec python3 -B "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kernel_identity.py" "$@"
