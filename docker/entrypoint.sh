#!/usr/bin/env bash
# Container entrypoint for a GPU game server.
#
# Four steps, in this order:
#   1. resolve the address players will actually connect to
#   2. mint the certificate they will pin
#   3. hand both to the game server
#   4. exec it, so the server is PID 1 and signals reach it directly
#
# Step 1 has two modes, and picking the wrong one is the expensive mistake.
#
# On a Vast box, each declared internal port gets a random external port. If
# that mapping is missing the server would come up advertising an address
# nobody can reach, heartbeat happily, and take players who then cannot
# connect -- and ports cannot be added to a running instance. So on Vast, a
# missing mapping exits nonzero to get the box destroyed and another host
# tried, which is the cheaper failure.
#
# Anywhere else -- `docker run --gpus all -p 4433:4433/udp` on your own box --
# there is no mapping to find and none is needed: the published port is the
# container port unless PUBLIC_UDP_PORT says otherwise.
set -euo pipefail

root="${SERVER_ROOT:-/opt/vibe-land}"
internal_udp_port="${WT_BIND_ADDR##*:}"
internal_udp_port="${internal_udp_port:-4433}"

log() { echo "[entrypoint] $*"; }

# --- 1. address discovery -----------------------------------------------------
udp_var="VAST_UDP_PORT_${internal_udp_port}"
external_udp_port="${!udp_var:-}"

# Vast injects a whole family of VAST_* variables, so their presence is what
# distinguishes "the mapping is missing" from "there is no mapping to look for".
# REQUIRE_PORT_MAP=1 forces the strict reading on a host that is not Vast.
on_vast=""
if [[ "${REQUIRE_PORT_MAP:-}" == "1" ]] || compgen -v | grep -q '^VAST_'; then
  on_vast=1
fi

if [[ -z "$external_udp_port" ]]; then
  if [[ -n "$on_vast" ]]; then
    log "FATAL: ${udp_var} is not set."
    log "The instance was created without a UDP mapping for ${internal_udp_port},"
    log "which cannot be added to a running instance. Exiting so this host is replaced."
    env | grep -E '^VAST_(TCP|UDP)_PORT_' | sort || log "(no VAST port variables at all)"
    exit 78 # EX_CONFIG
  fi
  external_udp_port="${PUBLIC_UDP_PORT:-$internal_udp_port}"
  log "standalone mode: no orchestrator port mapping, publishing ${external_udp_port}/udp"
fi

public_ip="${PUBLIC_IPADDR:-}"
if [[ -z "$public_ip" ]]; then
  # Falling back to an external lookup keeps a host with a missing variable
  # usable; on Vast the port mapping above has no such fallback.
  public_ip="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
fi
if [[ -z "$public_ip" && -z "$on_vast" ]]; then
  # Last resort for a box with no route to the outside: the address on the
  # interface that carries the default route. Enough for a LAN or a laptop.
  public_ip="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' || true)"
  [[ -n "$public_ip" ]] && log "no public IP available; advertising the local address ${public_ip}"
fi
if [[ -z "$public_ip" ]]; then
  log "FATAL: could not determine the address to advertise."
  log "Set PUBLIC_IPADDR to the address players will reach this server on."
  exit 78
fi

log "public endpoint: ${public_ip}:${external_udp_port}/udp (container ${internal_udp_port})"

# --- 2. certificate -----------------------------------------------------------
# ECDSA P-256, short-lived, with the public IP as a SAN: the exact shape
# `serverCertificateHashes` requires. Browsers reject RSA there, and reject
# anything valid for more than 14 days. Minted per boot and never baked into the
# image, which would ship an already-expired certificate.
cert_dir="${CERT_DIR:-$root/certs}"
mkdir -p "$cert_dir"
if [[ -z "${WT_CERT_PEM:-}" || -z "${WT_KEY_PEM:-}" ]]; then
  log "minting a self-signed P-256 certificate for IP:${public_ip} (12 days)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$cert_dir/key.pem"
  openssl req -new -x509 -key "$cert_dir/key.pem" -out "$cert_dir/cert.pem" \
    -days 12 -subj "/CN=${public_ip}" \
    -addext "subjectAltName=IP:${public_ip}"
  export WT_CERT_PEM="$cert_dir/cert.pem"
  export WT_KEY_PEM="$cert_dir/key.pem"
else
  log "using the certificate supplied in WT_CERT_PEM/WT_KEY_PEM"
fi
# The server computes and publishes the hash itself from whatever it loads, so
# the value clients pin can never drift from the one actually served.

# --- 3. server + heartbeat configuration --------------------------------------
export WT_PUBLIC_URL="https://${public_ip}:${external_udp_port}"
export HEARTBEAT_PUBLIC_IP="$public_ip"
export HEARTBEAT_UDP_PORT="$external_udp_port"
export MATCHES_PER_BOX="${MATCHES_PER_BOX:-6}"

if [[ -z "${CONTROL_PLANE_URL:-}" ]]; then
  if [[ -n "$on_vast" ]]; then
    log "WARNING: CONTROL_PLANE_URL unset -- heartbeats disabled, this box will not"
    log "be routed players and the fleet will destroy it once its boot window ends."
  else
    log "no CONTROL_PLANE_URL: running unmanaged, clients connect to this server directly."
  fi
fi

# --- 4. hand off --------------------------------------------------------------
log "starting game server"
exec "$root/run.sh" "$@"
