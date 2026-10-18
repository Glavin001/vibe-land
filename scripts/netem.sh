#!/usr/bin/env bash
#
# netem.sh — real link-level impairment for netlab runs.
#
# WHY THIS EXISTS: the in-process PacketImpairment delays packets *after* QUIC
# has already delivered them, so it cannot reproduce loss recovery, pacing, or
# congestion-control response. netem impairs the kernel path, so the QUIC stack
# actually sees the loss. Chrome's CDP network throttling does not touch
# WebTransport/QUIC at all, which is why this is a tc script and not a CDP call.
#
# SAFETY: all netlab traffic is loopback, so this only ever touches `dev lo`.
# SSH rides a real interface and is structurally untouched. Within lo, a prio
# qdisc sends everything to an unimpaired band by default and u32 filters divert
# only UDP traffic on the named game ports, so the control plane, Vite HMR and
# any other loopback service keep flowing normally.
#
# Usage:
#   netem.sh apply <profile> [--ports 4052,4002] [--ttl 900]
#   netem.sh clear
#   netem.sh status
#   netem.sh pulse <profile> <ms> [--ports ...]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES_JSON="$ROOT/client/netlab/netemProfiles.json"
STATE_FILE="/run/netlab-netem.active"
DEV=lo
# Band 4 is the impaired one; priomap sends all unmatched traffic to band 1.
IMPAIRED_BAND=4
DEFAULT_PORTS="${NETLAB_PORTS:-4052,4002,4433,4434}"

die() { echo "netem.sh: $*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root (tc requires CAP_NET_ADMIN)"
  # Being root is not enough: containers commonly drop CAP_NET_ADMIN, and tc
  # then fails with a bare "Operation not permitted" that looks like a bug in
  # this script. Check up front and say what is actually missing.
  if ! capsh --decode="$(grep ^CapEff /proc/self/status | awk '{print $2}')" 2>/dev/null \
      | tr ',' '\n' | grep -qi cap_net_admin; then
    die "this container lacks CAP_NET_ADMIN, so tc/netem cannot run.
  Fix: start the container with --cap-add=NET_ADMIN (or --privileged), or run on the host.
  Alternative: use the seeded in-process mode instead, which needs no privileges:
      npm run netlab -- run --scenario <name> --impair <profile> --impair-mode inproc
  It cannot model QUIC loss recovery or congestion control, but it is deterministic."
  fi
}

profile_field() {
  python3 - "$PROFILES_JSON" "$1" "$2" <<'PY'
import json, sys
path, name, field = sys.argv[1], sys.argv[2], sys.argv[3]
profiles = json.load(open(path))["profiles"]
if name not in profiles:
    sys.exit(f"unknown profile '{name}'. Available: {', '.join(sorted(profiles))}")
value = profiles[name].get(field)
if value is None:
    print("")
elif isinstance(value, dict):
    print(json.dumps(value))
else:
    print(value)
PY
}

list_profiles() {
  python3 -c "
import json
p = json.load(open('$PROFILES_JSON'))['profiles']
for name, cfg in p.items():
    print(f'  {name:<12} {cfg}')
"
}

build_netem_args() {
  local profile="$1"
  local delay jitter loss reorder rate limit gemodel
  delay=$(profile_field "$profile" delayMs)
  jitter=$(profile_field "$profile" jitterMs)
  loss=$(profile_field "$profile" lossPct)
  reorder=$(profile_field "$profile" reorderPct)
  rate=$(profile_field "$profile" rateMbit)
  limit=$(profile_field "$profile" limitPkts)
  gemodel=$(profile_field "$profile" gemodelPct)

  local args=()
  # netem needs a delay before it can reorder or hold a queue.
  if [ -n "$delay" ] && [ "$(printf '%.0f' "$delay")" -gt 0 ] 2>/dev/null; then
    args+=(delay "${delay}ms")
    if [ -n "$jitter" ] && [ "$(printf '%.0f' "$jitter")" -gt 0 ] 2>/dev/null; then
      # 25% correlation: consecutive packets on a real link are not independent.
      args+=("${jitter}ms" 25%)
    fi
  fi
  if [ -n "$gemodel" ]; then
    local p r
    p=$(echo "$gemodel" | python3 -c 'import json,sys; print(json.load(sys.stdin)["p"])')
    r=$(echo "$gemodel" | python3 -c 'import json,sys; print(json.load(sys.stdin)["r"])')
    args+=(loss gemodel "${p}%" "${r}%")
  elif [ -n "$loss" ] && [ "$loss" != "0" ]; then
    args+=(loss "${loss}%")
  fi
  if [ -n "$reorder" ] && [ "$reorder" != "0" ]; then
    args+=(reorder "${reorder}%" 50%)
  fi
  if [ -n "$rate" ]; then
    args+=(rate "${rate}mbit")
  fi
  args+=(limit "${limit:-2000}")
  printf '%s\n' "${args[@]}"
}

do_clear() {
  require_root
  tc qdisc del dev "$DEV" root 2>/dev/null || true
  rm -f "$STATE_FILE"
}

do_apply() {
  require_root
  local profile="$1"; shift
  local ports="$DEFAULT_PORTS"
  local ttl=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ports) ports="$2"; shift 2 ;;
      --ttl) ttl="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  local netem_args
  mapfile -t netem_args < <(build_netem_args "$profile")

  # Idempotent: a stale qdisc from a killed run would silently stack up.
  do_clear

  tc qdisc add dev "$DEV" root handle 1: prio bands 4 \
    priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
  tc qdisc add dev "$DEV" parent "1:${IMPAIRED_BAND}" handle 40: netem "${netem_args[@]}"

  local IFS=,
  for port in $ports; do
    [ -n "$port" ] || continue
    # Match both directions: the client's packets carry dport=<game port>,
    # the server's replies carry sport=<game port>. Both traverse lo egress.
    tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
      match ip protocol 17 0xff match ip dport "$port" 0xffff flowid "1:${IMPAIRED_BAND}"
    tc filter add dev "$DEV" parent 1: protocol ip prio 1 u32 \
      match ip protocol 17 0xff match ip sport "$port" 0xffff flowid "1:${IMPAIRED_BAND}"
  done

  echo "profile=$profile ports=$ports pid=$$ applied=$(date -Is)" > "$STATE_FILE"
  echo "netem.sh: applied '$profile' on $DEV udp ports $ports -> ${netem_args[*]}"

  if [ -n "$ttl" ]; then
    # Dead-man switch: if the runner dies without clearing, the impairment
    # still expires instead of quietly poisoning every later measurement.
    if command -v systemd-run >/dev/null 2>&1; then
      systemd-run --quiet --on-active="$ttl" \
        /bin/sh -c "tc qdisc del dev $DEV root 2>/dev/null; rm -f $STATE_FILE" || true
      echo "netem.sh: auto-clear scheduled in ${ttl}s"
    else
      setsid /bin/sh -c "sleep $ttl; tc qdisc del dev $DEV root 2>/dev/null; rm -f $STATE_FILE" \
        >/dev/null 2>&1 &
      echo "netem.sh: auto-clear scheduled in ${ttl}s (background timer)"
    fi
  fi
}

do_status() {
  if [ -f "$STATE_FILE" ]; then
    echo "active: $(cat "$STATE_FILE")"
  else
    echo "active: none"
  fi
  echo "--- qdisc ---"
  tc qdisc show dev "$DEV"
  echo "--- filters ---"
  tc filter show dev "$DEV" parent 1: 2>/dev/null || echo "(none)"
}

do_pulse() {
  local profile="$1"
  local ms="$2"; shift 2
  do_apply "$profile" "$@"
  echo "netem.sh: holding '$profile' for ${ms}ms..."
  sleep "$(python3 -c "print($ms/1000)")"
  do_clear
  echo "netem.sh: pulse complete, link restored"
}

do_dry_run() {
  local profile="$1"
  local ports="${2:-$DEFAULT_PORTS}"
  local netem_args
  mapfile -t netem_args < <(build_netem_args "$profile")
  echo "# commands netem.sh would run for profile '$profile' on ports $ports"
  echo "tc qdisc del dev $DEV root   # idempotent pre-clean"
  echo "tc qdisc add dev $DEV root handle 1: prio bands 4 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1"
  echo "tc qdisc add dev $DEV parent 1:${IMPAIRED_BAND} handle 40: netem ${netem_args[*]}"
  local IFS=,
  for port in $ports; do
    [ -n "$port" ] || continue
    echo "tc filter add dev $DEV parent 1: protocol ip prio 1 u32 match ip protocol 17 0xff match ip dport $port 0xffff flowid 1:${IMPAIRED_BAND}"
    echo "tc filter add dev $DEV parent 1: protocol ip prio 1 u32 match ip protocol 17 0xff match ip sport $port 0xffff flowid 1:${IMPAIRED_BAND}"
  done
}

case "${1:-}" in
  dry-run)
    [ $# -ge 2 ] || die "dry-run requires a profile"
    do_dry_run "$2" "${3:-}" ;;
  apply)
    [ $# -ge 2 ] || die "apply requires a profile. Available:$(echo; list_profiles)"
    shift; do_apply "$@" ;;
  clear) do_clear; echo "netem.sh: cleared" ;;
  status) do_status ;;
  pulse)
    [ $# -ge 3 ] || die "pulse requires <profile> <ms>"
    shift; do_pulse "$@" ;;
  list) list_profiles ;;
  *)
    echo "usage: netem.sh {apply <profile> [--ports p1,p2] [--ttl sec] | clear | status | pulse <profile> <ms> | dry-run <profile> [ports] | list}"
    echo "profiles:"; list_profiles
    exit 1 ;;
esac
