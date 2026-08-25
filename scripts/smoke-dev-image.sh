#!/usr/bin/env bash
# Prove the toolchain image is usable as a rented dev box.
#
# The runtime image has scripts/smoke-image.sh. This is its counterpart for the
# builder, which is a different product with different failure modes: nobody
# runs a server in it, they SSH in and build. So the assertions are about
# whether a person who logs in can actually get anywhere.
#
#   ./scripts/smoke-dev-image.sh ghcr.io/glavin001/vibe-land-builder:<tag>
#
# No GPU required. Everything here runs on a plain CI runner.
#
# THE CASE THAT EARNS THIS SCRIPT: case 2 starts a real sshd inside the image
# and logs in over it. A box rented with --ssh refused every login because
# sshd's StrictModes will not read an authorized_keys whose modes are wrong, and
# it reports that as a *key* problem:
#
#   Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys
#
# The key was correct and attached. Nothing short of an actual login catches
# that, and it cost an hour of a rented box to find by hand.
set -euo pipefail

IMAGE="${1:?usage: smoke-dev-image.sh <image[:tag]>}"
NAME="vibe-dev-smoke-$$"
REPO_URL="${SMOKE_REPO_URL:-https://github.com/Glavin001/vibe-land}"

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*" >&2; docker logs "$NAME" 2>&1 | tail -30 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# One long-lived container for every case: starting the 19 GB image repeatedly
# is the slowest thing here by an order of magnitude.
docker run -d --name "$NAME" \
  -e VAST_UDP_PORT_4433=51745 -e VAST_TCP_PORT_4443=51918 \
  --entrypoint sleep "$IMAGE" 3600 >/dev/null
# NOT a login shell: /etc/profile.d prints the banner, and prefixing the output
# of every command with it would corrupt every value this script parses. The
# image sets PATH via ENV, so cargo and friends resolve without a login shell.
inc() { docker exec "$NAME" bash -c "$1"; }
# The banner only prints for INTERACTIVE shells (by design -- it would otherwise
# appear in scp, rsync and every non-interactive ssh), so testing it needs -i.
inc_login() { docker exec "$NAME" bash -lic "$1" 2>&1; }

echo "== 1. toolchain =="
inc 'command -v nvcc && command -v clang && command -v cargo' >/dev/null \
  || fail "missing a core toolchain binary"
pass "nvcc, clang and cargo present"

node_major="$(inc 'node --version' | sed 's/^v\([0-9]*\).*/\1/')"
[[ "$node_major" == "22" ]] || fail "node is v$node_major, expected v22 (apt ships 18, which fails deep inside vite)"
pass "node v22"

inc 'command -v wasm-pack' >/dev/null || fail "wasm-pack missing -- the client cannot build"
inc 'rustup target list --installed | grep -qx wasm32-unknown-unknown' \
  || fail "wasm32-unknown-unknown target missing"
pass "wasm-pack and the wasm32 target"

inc 'test -f "$PHYSX_ROOT/bin/linux.x86_64/release/libPhysXGpu_64.so"' \
  || fail "libPhysXGpu_64.so missing"
inc 'test -f "$BLAST_ROOT/source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu"' \
  || fail "the Blast CUDA stress source is missing -- cuda-stress would panic in build.rs"
pass "PhysX and the Blast CUDA stress source"

echo "== 2. ssh, for real =="
# Exactly what Vast does: install sshd, APPEND a key to authorized_keys, start
# it. If the image ships that file with wrong modes, or does not ship it at all
# and the append creates one badly, this login fails -- which is the bug.
inc 'stat -c %a /root/.ssh' | grep -qx 700 || fail "/root/.ssh is not mode 700"
inc 'stat -c %a /root/.ssh/authorized_keys' | grep -qx 600 \
  || fail "/root/.ssh/authorized_keys is not mode 600 -- sshd StrictModes will refuse every login"
pass "/root/.ssh 700, authorized_keys 600"

inc 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq openssh-server >/dev/null' \
  || fail "could not install openssh-server"
inc 'ssh-keygen -q -t ed25519 -N "" -f /tmp/smoke_key' || fail "could not generate a test key"
inc 'cat /tmp/smoke_key.pub >> /root/.ssh/authorized_keys' || fail "could not append the key"
inc 'ssh-keygen -A >/dev/null && mkdir -p /run/sshd && /usr/sbin/sshd -p 2222' \
  || fail "sshd would not start"
out="$(inc 'ssh -i /tmp/smoke_key -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes root@127.0.0.1 "echo SSH_OK" 2>&1' || true)"
grep -q SSH_OK <<<"$out" || fail "ssh login refused:
$out"
pass "a real sshd accepts a key appended the way Vast appends it"

echo "== 3. login discoverability =="
# A box is useless if the person who lands on it cannot find the one command.
inc 'test -s /root/README.md' || fail "/root/README.md missing"
inc 'grep -q "vibe-up" /root/README.md' || fail "README does not mention vibe-up"
banner="$(inc_login 'true' || true)"
grep -q "vibe-land dev box" <<<"$banner" || fail "the login banner did not print:
$banner"
grep -q "vibe-up" <<<"$banner" || fail "the login banner does not name vibe-up"
pass "README and login banner"

echo "== 4. vibe-up argument handling =="
inc 'vibe-up --help | head -1 | grep -q "^One command"' || fail "--help is not clean prose"
inc 'vibe-up --bogus; test $? -eq 2' >/dev/null 2>&1 || fail "an unknown option should exit 2"
inc 'VIBE_DEST=/nonexistent vibe-up --status 2>&1 | grep -q "no checkout"' \
  || fail "--status before cloning should say so, not crash"
pass "--help, unknown option, --status before cloning"

echo "== 5. external port detection =="
# vibe-up reads the port mapping from PID 1, because an SSH login shell does not
# inherit VAST_*. This container's PID 1 carries them, so the mechanism is
# exercised exactly as it is on a real box.
udp="$(inc 'tr "\0" "\n" < /proc/1/environ | sed -n "s/^VAST_UDP_PORT_4433=//p" | head -1')"
[[ "$udp" == "51745" ]] || fail "PID-1 udp port detection returned '$udp', expected 51745"
web="$(inc 'tr "\0" "\n" < /proc/1/environ | sed -n "s/^VAST_TCP_PORT_4443=//p" | head -1')"
[[ "$web" == "51918" ]] || fail "PID-1 web port detection returned '$web', expected 51918"
pass "external ports read from PID 1 (51745 udp, 51918 web)"

echo "== 6. vibe-clone =="
inc "VIBE_REPO_URL=$REPO_URL vibe-clone >/dev/null 2>&1" || fail "vibe-clone failed"
inc 'test -L /root/vibe-land/target' || fail "target/ is not a symlink into the cache"
inc 'readlink /root/vibe-land/target | grep -q /opt/vibe-cache' || fail "target/ does not point at \$VIBE_CACHE"
inc 'test -L "${CARGO_HOME:-/root/.cargo}/registry"' || fail "the cargo registry is not linked into the cache"
pass "clone with target/ and the cargo registry linked into /opt/vibe-cache"

# The cache surviving a re-clone is the whole point of linking rather than
# copying: a box switching branches must not pay a cold build again.
inc 'touch /opt/vibe-cache/target/MARKER && rm -rf /root/vibe-land' || fail "could not stage the re-clone"
inc "VIBE_REPO_URL=$REPO_URL vibe-clone >/dev/null 2>&1" || fail "second vibe-clone failed"
inc 'test -f /root/vibe-land/target/MARKER' || fail "the build cache did not survive a re-clone"
pass "the cache survives deleting and re-cloning the checkout"

echo "== 7. run-city-server.sh remote mode =="
# Five variables that are right on a laptop and wrong on a rented box. Each one
# fails late and looks like a different problem; a stub binary is enough to
# prove the script exports them correctly without needing a GPU.
inc 'mkdir -p /root/vibe-land/target/release && printf "#!/usr/bin/env bash\necho \"starting web fps server\"\nenv | grep -E \"^(BIND_ADDR|WEB_BIND_ADDR|WT_BIND_ADDR|WT_PUBLIC_URL|VIBE_WEB_DIR)=\" | sort\nsleep 1\n" > /root/vibe-land/target/release/web-fps-server && chmod +x /root/vibe-land/target/release/web-fps-server' \
  || fail "could not stage the stub binary"
inc 'cd /root/vibe-land && VIBE_PUBLIC_IP=203.0.113.9 VIBE_UDP_PORT=51745 VIBE_CITY_LOG=/tmp/rc.log ./scripts/run-city-server.sh >/dev/null 2>&1; sleep 2' \
  || fail "remote mode would not start"
env_out="$(inc 'cat /tmp/rc.log')"
for expect in \
  'BIND_ADDR=0.0.0.0:4001' \
  'WEB_BIND_ADDR=0.0.0.0:4443' \
  'WT_BIND_ADDR=0.0.0.0:4433' \
  'WT_PUBLIC_URL=https://203.0.113.9:51745' \
  'VIBE_WEB_DIR=/root/vibe-land/client/dist'
do
  grep -q "$expect" <<<"$env_out" || fail "remote mode did not export $expect
got:
$env_out"
done
pass "all five listener variables exported correctly"

# serverCertificateHashes accepts nothing else: RSA is rejected outright, and so
# is any certificate valid for more than 14 days.
inc 'openssl x509 -in /root/vibe-land/.certs/page-cert.pem -noout -text | grep -q prime256v1' \
  || fail "the minted certificate is not P-256 -- browsers reject RSA for serverCertificateHashes"
inc 'openssl x509 -in /root/vibe-land/.certs/page-cert.pem -noout -text | grep -q "IP Address:203.0.113.9"' \
  || fail "the minted certificate has no IP SAN"
days="$(inc 'openssl x509 -in /root/vibe-land/.certs/page-cert.pem -noout -checkend $((14*86400)) >/dev/null 2>&1 && echo long || echo short')"
[[ "$days" == "short" ]] || fail "the certificate is valid beyond 14 days; browsers reject that"
pass "certificate is P-256, has the IP SAN, and expires inside 14 days"

# Re-minting would change the hash clients pin mid-session.
before="$(inc 'sha256sum /root/vibe-land/.certs/page-cert.pem')"
inc 'cd /root/vibe-land && VIBE_PUBLIC_IP=203.0.113.9 VIBE_UDP_PORT=51745 VIBE_CITY_LOG=/tmp/rc2.log ./scripts/run-city-server.sh >/dev/null 2>&1; sleep 1' || true
after="$(inc 'sha256sum /root/vibe-land/.certs/page-cert.pem')"
[[ "$before" == "$after" ]] || fail "the certificate was re-minted on a second run, changing the pinned hash"
pass "an existing certificate is reused, not re-minted"

inc 'cd /root/vibe-land && VIBE_PUBLIC_IP=203.0.113.9 ./scripts/run-city-server.sh >/dev/null 2>&1; test $? -eq 2' \
  || fail "VIBE_PUBLIC_IP without VIBE_UDP_PORT should exit 2"
pass "a missing external UDP port fails loudly"

echo
echo "dev image OK: $IMAGE"
