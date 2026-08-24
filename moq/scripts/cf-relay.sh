#!/usr/bin/env bash
#
# Provision and drive a Cloudflare MoQ relay.
#
#   export CF_ACCOUNT_ID=...   # Cloudflare dashboard sidebar
#   export CF_API_TOKEN=...    # API token with MoQ edit permission
#
#   cf-relay.sh list                     list relays on the account
#   cf-relay.sh create [name]            create a relay
#   cf-relay.sh tokens <uid>             list a relay's tokens (no secrets)
#   cf-relay.sh mint <uid> <op> [label]  mint; op publish|subscribe|publish+subscribe
#   cf-relay.sh revoke <uid> <jti>       revoke one token
#   cf-relay.sh publish <uid> [args...]  run the publisher against the relay
#   cf-relay.sh env <uid>                print .env lines for the /moq page
#   cf-relay.sh hosted-demo <uid> [args] run publisher + Vite with one shared token
#   cf-relay.sh hosted-bodies <uid> [args] run RBWT publisher + /bodies with one shared token
#   cf-relay.sh benchmark <uid> [args]   run the staged hosted throughput benchmark
#   cf-relay.sh delete <uid>             delete a relay
#
# Relay token secrets are returned by the API exactly once, at mint time — they
# cannot be read back later. So `publish` mints a short-lived token, hands it to
# the publisher, and revokes it on exit; nothing is left lying around and the
# secret never reaches your shell history. `hosted-demo` is a temporary
# workaround for Cloudflare's cross-token scope bug; see moq/README.md.

set -euo pipefail

# Non-interactive shells may find an older system Cargo before rustup's Cargo.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

API="https://api.cloudflare.com/client/v4"
ENDPOINT="${MOQ_RELAY_ENDPOINT:-https://draft-16.cloudflare.mediaoverquic.com}"
NAMESPACE="${MOQ_NAMESPACE:-vibe-land/demo}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$HERE/../publisher"
CLIENT="$HERE/../../client"
BENCHMARK="$HERE/../bench/run-cloudflare.mjs"
BODY_BACKEND="${BODY_BACKEND_DIR:-/root/workspace/webtransport}"
BODY_BENCHMARK="$HERE/../bench/run-bodies.mjs"

usage() {
  sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_credentials() {
  : "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID to your Cloudflare account ID}"
  : "${CF_API_TOKEN:?set CF_API_TOKEN to an API token with MoQ edit permission}"
}

# Call the Cloudflare API, print `result`, and fail loudly on an error envelope.
cf() {
  local method="$1" path="$2" body="${3:-}"
  local response

  if [ -n "$body" ]; then
    response=$(curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body")
  else
    response=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN")
  fi

  printf '%s' "$response" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    sys.stderr.write("Cloudflare API error: ")
    json.dump(payload.get("errors"), sys.stderr, indent=2)
    sys.stderr.write("\n")
    sys.exit(1)
json.dump(payload.get("result"), sys.stdout)
'
}

# Flatten the nested issuers/cloudflare_tokens shape into one token per line.
flatten_tokens() {
  python3 -c '
import json, sys
result = json.load(sys.stdin) or {}
for issuer in result.get("issuers", []):
    for token in issuer.get("cloudflare_tokens", []):
        fields = [
            token.get("jti", ""),
            "+".join(token.get("operations", [])),
            token.get("label", ""),
            token.get("expires", ""),
            token.get("secret", ""),
        ]
        print("\t".join(fields))
'
}

# Mint a token and emit "<jti>\t<secret>". The jti comes straight back from the
# mint response, so a caller that needs to revoke the token later never has to
# go looking for it by label.
mint_token() {
  local uid="$1" operations="$2" label="$3"
  local body
  body=$(python3 -c '
import json, sys
print(json.dumps({"operations": sys.argv[1].split("+"), "label": sys.argv[2]}))
' "$operations" "$label")

  local minted
  minted=$(cf POST "/accounts/$CF_ACCOUNT_ID/moq/relays/$uid/tokens" "$body" \
    | flatten_tokens | awk -F'\t' 'NR == 1 { print $1 "\t" $5 }')

  if [ -z "$minted" ] || [ "${minted#*$'\t'}" = "" ]; then
    echo "the API returned no secret for the new $operations token" >&2
    return 1
  fi
  printf '%s' "$minted"
}

# The secret half of a "<jti>\t<secret>" pair.
secret_of() {
  printf '%s' "${1#*$'\t'}"
}

# The jti half.
jti_of() {
  printf '%s' "${1%%$'\t'*}"
}

# Set by cmd_publish for the EXIT trap. These are deliberately script-scoped:
# when `set -e` aborts from inside a function, bash unwinds that function's
# locals *before* running the EXIT trap, so a handler reading locals sees
# nothing and silently skips its work.
EPHEMERAL_RELAY_UID=""
EPHEMERAL_JTI=""
HOSTED_DEMO_PUBLISHER_PID=""
HOSTED_DEMO_CLIENT_PID=""

revoke_ephemeral_token() {
  [ -n "$EPHEMERAL_JTI" ] || return 0
  local jti="$EPHEMERAL_JTI"
  EPHEMERAL_JTI=""

  echo "revoking the ephemeral relay token ($jti)" >&2
  cf DELETE "/accounts/$CF_ACCOUNT_ID/moq/relays/$EPHEMERAL_RELAY_UID/tokens/$jti" \
    > /dev/null 2>&1 || echo "warning: could not revoke $jti — revoke it by hand" >&2
}

stop_hosted_demo_processes() {
  local pid
  for pid in "$HOSTED_DEMO_PUBLISHER_PID" "$HOSTED_DEMO_CLIENT_PID"; do
    [ -n "$pid" ] || continue
    kill "$pid" > /dev/null 2>&1 || true
  done
  for pid in "$HOSTED_DEMO_PUBLISHER_PID" "$HOSTED_DEMO_CLIENT_PID"; do
    [ -n "$pid" ] || continue
    wait "$pid" > /dev/null 2>&1 || true
  done
  HOSTED_DEMO_PUBLISHER_PID=""
  HOSTED_DEMO_CLIENT_PID=""
}

cleanup_hosted_demo() {
  stop_hosted_demo_processes
  revoke_ephemeral_token
}

hosted_demo_interrupt() {
  exit 130
}

hosted_demo_terminate() {
  exit 143
}

cmd_list() {
  cf GET "/accounts/$CF_ACCOUNT_ID/moq/relays" | python3 -c '
import json, sys
relays = json.load(sys.stdin) or []
if not relays:
    print("no relays on this account")
for relay in relays:
    uid = relay.get("uid", "")
    name = relay.get("name", "")
    created = relay.get("created", "")
    print(f"{uid}  {name:<24} created {created}")
'
}

cmd_create() {
  local name="${1:-vibe-land-demo}"
  local relay
  relay=$(cf POST "/accounts/$CF_ACCOUNT_ID/moq/relays" \
    "$(python3 -c 'import json, sys; print(json.dumps({"name": sys.argv[1]}))' "$name")")

  local uid
  uid=$(printf '%s' "$relay" | python3 -c 'import json, sys; print(json.load(sys.stdin)["uid"])')

  echo "created relay $uid ($name)"
  printf '%s' "$relay" | flatten_tokens | awk -F'\t' '{ printf "  %-18s %-26s expires %s\n", $2, $3, $4 }'

  cat <<EOF

The default tokens' secrets were shown only in that create response, which this
script discards. Mint what you need instead:

  $0 hosted-demo $uid
  $0 publish $uid
  $0 env $uid >> .env
EOF
}

cmd_tokens() {
  local uid="${1:?usage: cf-relay.sh tokens <relay-uid>}"
  cf GET "/accounts/$CF_ACCOUNT_ID/moq/relays/$uid/tokens" \
    | flatten_tokens \
    | awk -F'\t' '{ printf "%s  %-18s %-26s expires %s\n", $1, $2, $3, $4 }'
}

cmd_mint() {
  local uid="${1:?usage: cf-relay.sh mint <relay-uid> <publish|subscribe|publish+subscribe> [label]}"
  local operation="${2:?operation must be publish, subscribe, or publish+subscribe}"
  local label="${3:-minted by cf-relay.sh}"

  case "$operation" in
    publish | subscribe | publish+subscribe) ;;
    *) echo "operation must be publish, subscribe, or publish+subscribe" >&2; return 1 ;;
  esac

  local minted
  minted=$(mint_token "$uid" "$operation" "$label")
  echo "$ENDPOINT/$(secret_of "$minted")"
  echo "jti $(jti_of "$minted") — revoke with: $0 revoke $uid $(jti_of "$minted")" >&2
}

cmd_revoke() {
  local uid="${1:?usage: cf-relay.sh revoke <relay-uid> <jti>}"
  local jti="${2:?usage: cf-relay.sh revoke <relay-uid> <jti>}"
  cf DELETE "/accounts/$CF_ACCOUNT_ID/moq/relays/$uid/tokens/$jti" > /dev/null
  echo "revoked token $jti"
}

cmd_publish() {
  local uid="${1:?usage: cf-relay.sh publish <relay-uid> [publisher args...]}"
  shift || true

  local minted
  minted=$(mint_token "$uid" publish "cf-relay.sh publisher $$")

  local token
  token=$(secret_of "$minted")

  # Revoke however we exit, including Ctrl-C and a publisher crash.
  EPHEMERAL_RELAY_UID="$uid"
  EPHEMERAL_JTI=$(jti_of "$minted")
  trap revoke_ephemeral_token EXIT INT TERM

  echo "publishing $NAMESPACE to $ENDPOINT (relay $uid)" >&2
  ( cd "$PUBLISHER" && cargo run --release -- "$ENDPOINT/$token" --namespace "$NAMESPACE" "$@" )
}

cmd_env() {
  local uid="${1:?usage: cf-relay.sh env <relay-uid>}"
  local token
  token=$(secret_of "$(mint_token "$uid" subscribe "vite build")")

  cat <<EOF
# Subscribe-only on purpose: VITE_ variables are compiled into the browser
# bundle, so a publish token must never appear here.
VITE_MOQ_RELAY_URL=$ENDPOINT
VITE_MOQ_SUBSCRIBE_TOKEN=$token
VITE_MOQ_NAMESPACE=$NAMESPACE
EOF
}

cmd_hosted_demo() {
  local uid="${1:?usage: cf-relay.sh hosted-demo <relay-uid> [publisher args...]}"
  shift || true

  echo "building the publisher and browser assets before minting the shared token" >&2
  ( cd "$PUBLISHER" && cargo build --release )
  ( cd "$CLIENT" && npm run build:wasm )

  local cargo_target_dir
  cargo_target_dir=$(cd "$PUBLISHER" && cargo metadata --format-version 1 --no-deps \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
  local publisher_bin="$cargo_target_dir/release/vibe-moq-publisher"
  [ -x "$publisher_bin" ] || {
    echo "publisher binary was not created at $publisher_bin" >&2
    return 1
  }

  local minted
  minted=$(mint_token "$uid" publish+subscribe "cf-relay.sh hosted demo $$")

  local token
  token=$(secret_of "$minted")

  EPHEMERAL_RELAY_UID="$uid"
  EPHEMERAL_JTI=$(jti_of "$minted")
  trap cleanup_hosted_demo EXIT
  trap hosted_demo_interrupt INT
  trap hosted_demo_terminate TERM
  sleep "${MOQ_TOKEN_PROPAGATION_SECONDS:-10}"

  cat >&2 <<EOF
Cloudflare hosted-relay workaround enabled.
The browser and publisher will share one short-lived publish+subscribe token.
The browser therefore has publish permission until this command exits.
The token will be revoked automatically.

Starting publisher and Vite. Open the Vite URL at /moq and click Connect.
EOF

  (
    cd "$PUBLISHER"
    exec "$publisher_bin" "$ENDPOINT/$token" --namespace "$NAMESPACE" "$@"
  ) &
  HOSTED_DEMO_PUBLISHER_PID=$!

  (
    cd "$CLIENT"
    export VITE_MOQ_RELAY_URL="$ENDPOINT"
    export VITE_MOQ_SUBSCRIBE_TOKEN="$token"
    export VITE_MOQ_NAMESPACE="$NAMESPACE"
    exec "$CLIENT/node_modules/.bin/vite"
  ) &
  HOSTED_DEMO_CLIENT_PID=$!

  local status=0
  wait -n "$HOSTED_DEMO_PUBLISHER_PID" "$HOSTED_DEMO_CLIENT_PID" || status=$?
  return "$status"
}

cmd_hosted_bodies() {
  local uid="${1:?usage: cf-relay.sh hosted-bodies <relay-uid> [bodies-moq args...]}"
  shift || true
  local body_namespace="${MOQ_BODY_NAMESPACE:-vibe-land/bodies}"

  echo "building the RBWT backend and browser assets before minting the shared token" >&2
  ( cd "$BODY_BACKEND" && cargo build --release )
  ( cd "$CLIENT" && npm run build:wasm )

  local cargo_target_dir
  cargo_target_dir=$(cd "$BODY_BACKEND" && cargo metadata --format-version 1 --no-deps \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
  local publisher_bin="$cargo_target_dir/release/wt-echo"
  [ -x "$publisher_bin" ] || {
    echo "RBWT publisher binary was not created at $publisher_bin" >&2
    return 1
  }

  local minted token
  minted=$(mint_token "$uid" publish+subscribe "cf-relay.sh hosted bodies $$")
  token=$(secret_of "$minted")
  EPHEMERAL_RELAY_UID="$uid"
  EPHEMERAL_JTI=$(jti_of "$minted")
  trap cleanup_hosted_demo EXIT
  trap hosted_demo_interrupt INT
  trap hosted_demo_terminate TERM
  sleep "${MOQ_TOKEN_PROPAGATION_SECONDS:-10}"

  cat >&2 <<EOF
Starting the shared RBWT backend through Cloudflare MoQ.
Open http://localhost:5555/bodies?transport=moq&autostart=1
Namespace: $body_namespace
The shared publish+subscribe token is revoked automatically on exit.
EOF

  (
    cd "$BODY_BACKEND"
    exec "$publisher_bin" bodies-moq \
      --url "$ENDPOINT/$token" \
      --namespace "$body_namespace" \
      "$@"
  ) &
  HOSTED_DEMO_PUBLISHER_PID=$!

  (
    cd "$CLIENT"
    export VITE_MOQ_RELAY_URL="$ENDPOINT"
    export VITE_MOQ_SUBSCRIBE_TOKEN="$token"
    export VITE_MOQ_NAMESPACE="$body_namespace"
    export VITE_BODY_DIRECT_URL="${BODY_DIRECT_URL:-}"
    export VITE_BODY_DIRECT_CERT_HASH="${BODY_DIRECT_CERT_HASH:-}"
    exec "$CLIENT/node_modules/.bin/vite" --host 0.0.0.0
  ) &
  HOSTED_DEMO_CLIENT_PID=$!

  if [ -n "${BODY_BENCH_VIEWERS:-}" ]; then
    sleep "${BODY_DEMO_STARTUP_SECONDS:-2}"
    local benchmark_status=0
    MOQ_RELAY_URL="$ENDPOINT/$token" \
      MOQ_NAMESPACE="$body_namespace" \
      BODY_BENCH_TRANSPORT=moq \
      BODY_LAB_URL="${BODY_LAB_URL:-http://127.0.0.1:5555/bodies}" \
      node "$BODY_BENCHMARK" || benchmark_status=$?
    return "$benchmark_status"
  fi

  local status=0
  wait -n "$HOSTED_DEMO_PUBLISHER_PID" "$HOSTED_DEMO_CLIENT_PID" || status=$?
  return "$status"
}

cmd_benchmark() {
  local uid="${1:?usage: cf-relay.sh benchmark <relay-uid> [benchmark args...]}"
  shift || true

  local minted
  minted=$(mint_token "$uid" publish+subscribe "cf-relay.sh benchmark $$")
  local token
  token=$(secret_of "$minted")

  EPHEMERAL_RELAY_UID="$uid"
  EPHEMERAL_JTI=$(jti_of "$minted")
  trap revoke_ephemeral_token EXIT INT TERM
  sleep "${MOQ_TOKEN_PROPAGATION_SECONDS:-10}"

  echo "running staged Cloudflare MoQ benchmark; the shared token is revoked on exit" >&2
  MOQ_RELAY_URL="$ENDPOINT/$token" node "$BENCHMARK" "$@"
}

cmd_delete() {
  local uid="${1:?usage: cf-relay.sh delete <relay-uid>}"
  cf DELETE "/accounts/$CF_ACCOUNT_ID/moq/relays/$uid" > /dev/null
  echo "deleted relay $uid"
}

main() {
  local command="${1:-}"
  [ -n "$command" ] || usage 1
  shift

  case "$command" in
    list | create | tokens | mint | revoke | publish | env | benchmark | delete)
      require_credentials
      "cmd_$command" "$@"
      ;;
    hosted-demo)
      require_credentials
      cmd_hosted_demo "$@"
      ;;
    hosted-bodies)
      require_credentials
      cmd_hosted_bodies "$@"
      ;;
    -h | --help | help) usage 0 ;;
    *) echo "unknown command: $command" >&2; usage 1 ;;
  esac
}

main "$@"
