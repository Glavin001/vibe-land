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

# --- 1b. the web UI -----------------------------------------------------------
# Same treatment as the UDP port: Vast remaps it, everywhere else it is itself.
internal_web_port="${WEB_BIND_ADDR##*:}"
internal_web_port="${internal_web_port:-4443}"
web_var="VAST_TCP_PORT_${internal_web_port}"
external_web_port="${!web_var:-${PUBLIC_WEB_PORT:-$internal_web_port}}"

# --- 2. certificate -----------------------------------------------------------
# ECDSA P-256, short-lived, with the public IP as a SAN: the exact shape
# `serverCertificateHashes` requires. Browsers reject RSA there, and reject
# anything valid for more than 14 days. Minted per boot and never baked into the
# image, which would ship an already-expired certificate.
cert_dir="${CERT_DIR:-$root/certs}"
mkdir -p "$cert_dir"
if [[ -n "${WT_CERT_PEM:-}" && -n "${WT_KEY_PEM:-}" ]]; then
  export WT_CERT_PEM_SUPPLIED=1
fi
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

# A bound UDP socket does not mean players can reach it. Some hosts accept the
# port mapping and then never forward the datagrams, and the box looks entirely
# healthy from the outside: it boots, heartbeats, serves /city, and answers
# /healthz with "ok" -- while every player it is handed times out on the QUIC
# handshake. Two hosts did exactly this.
#
# The server watches for that (clients fetched /session-config, no QUIC packet
# ever arrived) and can exit so the box is replaced. That is the right response
# only where something replaces it: on Vast the port mapping cannot be changed
# on a running instance, so a box that cannot serve players is worth nothing
# and the fleet should rent another. On a laptop the same exit would kill the
# server while its owner is still opening a tab.
export UDP_WATCHDOG="${UDP_WATCHDOG:-$([[ -n "$on_vast" ]] && echo fatal || echo warn)}"

# And the same split for the boot-time probe, which catches it ~12s in without
# waiting for anyone to try connecting. Measured before enabling: on a Vast
# host known to carry players, the probe reaches its own public address and
# completes the handshake (attempts=1, handshake=true), so hairpin works there
# and a failed probe means something real. A laptop behind a home router often
# will not hairpin, so it only warns.
export UDP_VERIFY="${UDP_VERIFY:-$([[ -n "$on_vast" ]] && echo fatal || echo warn)}"

if [[ -z "${CONTROL_PLANE_URL:-}" ]]; then
  if [[ -n "$on_vast" ]]; then
    log "WARNING: CONTROL_PLANE_URL unset -- heartbeats disabled, this box will not"
    log "be routed players and the fleet will destroy it once its boot window ends."
  else
    log "no CONTROL_PLANE_URL: running unmanaged, clients connect to this server directly."
  fi
fi

# --- 4. hand off --------------------------------------------------------------
# The address to actually open. WebTransport refuses to start from an insecure
# context, so the page has to come from this HTTPS listener rather than the
# plain-HTTP one on BIND_ADDR -- which stays put for health checks and the fleet.
if [[ -n "${WEB_BIND_ADDR:-}" ]]; then
  log ""
  log "  open:  https://${public_ip}:${external_web_port}/city"
  log ""
  if [[ -z "${WT_CERT_PEM_SUPPLIED:-}" ]]; then
    log "  The certificate is self-signed, so the browser will warn once."
    log "  Accept it and the page loads; WebTransport pins the same certificate"
    log "  by hash, so the game connects regardless. Mount a real certificate"
    log "  via WT_CERT_PEM/WT_KEY_PEM to remove the warning."
    log ""
  fi
fi

log "starting game server"
exec "$root/run.sh" "$@"
