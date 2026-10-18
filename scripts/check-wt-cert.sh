#!/usr/bin/env bash
#
# Is the WebTransport certificate still usable?
#
# WebTransport's serverCertificateHashes pin is strict: Chrome refuses a cert
# outside a 14-day validity window, and refuses it the moment it expires. The
# page keeps loading either way -- it is only "Not Secure" -- so the failure
# presents as "the game will not connect" with a QUIC_TLS_CERTIFICATE_UNKNOWN
# buried in the console, and nothing on the server looks wrong. A cert that
# expires on a 14-day cycle is a scheduled outage unless something watches it.
#
# Exits non-zero when the cert is expired or expires within DAYS_WARN.
set -uo pipefail
CERT="${WT_CERT_PEM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.certs/page-cert.pem}"
DAYS_WARN="${DAYS_WARN:-3}"

if [[ ! -f "$CERT" ]]; then
  echo "MISSING: $CERT" >&2
  exit 2
fi

not_after=$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)
end_epoch=$(date -d "$not_after" +%s)
now_epoch=$(date +%s)
days_left=$(( (end_epoch - now_epoch) / 86400 ))
hash_hex=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')

echo "cert     : $CERT"
echo "notAfter : $not_after"
echo "days左   : $days_left" | sed 's/days左/days left/'
echo "sha256   : $hash_hex"

# The server advertises the hash it actually loaded; a mismatch means it is
# still serving an old cert and needs a restart.
if advertised=$(curl -sf "http://127.0.0.1:4003/session-config?match_id=city-default" 2>/dev/null \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("server_certificate_hash_hex",""))' 2>/dev/null); then
  if [[ -n "$advertised" ]]; then
    if [[ "$advertised" == "$hash_hex" ]]; then
      echo "server   : advertising this cert (match)"
    else
      echo "server   : MISMATCH -- advertising $advertised; restart the server" >&2
      exit 1
    fi
  fi
fi

if (( days_left < 0 )); then
  echo "EXPIRED -- WebTransport will fail with QUIC_TLS_CERTIFICATE_UNKNOWN" >&2
  exit 1
fi
if (( days_left <= DAYS_WARN )); then
  echo "EXPIRING SOON ($days_left days) -- regenerate before it takes the game down" >&2
  exit 1
fi
echo "OK"
