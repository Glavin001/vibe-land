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
#   cf-relay.sh mint <uid> <op> [label]  mint a token; op is publish|subscribe
#   cf-relay.sh revoke <uid> <jti>       revoke one token
#   cf-relay.sh publish <uid> [args...]  run the publisher against the relay
#   cf-relay.sh env <uid>                print .env lines for the /moq page
#   cf-relay.sh delete <uid>             delete a relay
#
# Relay token secrets are returned by the API exactly once, at mint time — they
# cannot be read back later. So `publish` mints a short-lived token, hands it to
# the publisher, and revokes it on exit; nothing is left lying around and the
# secret never reaches your shell history.

set -euo pipefail

API="https://api.cloudflare.com/client/v4"
ENDPOINT="${MOQ_RELAY_ENDPOINT:-https://draft-16.cloudflare.mediaoverquic.com}"
NAMESPACE="${MOQ_NAMESPACE:-vibe-land/demo}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$HERE/../publisher"

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
  local uid="$1" operation="$2" label="$3"
  local body
  body=$(python3 -c '
import json, sys
print(json.dumps({"operations": [sys.argv[1]], "label": sys.argv[2]}))
' "$operation" "$label")

  local minted
  minted=$(cf POST "/accounts/$CF_ACCOUNT_ID/moq/relays/$uid/tokens" "$body" \
    | flatten_tokens | awk -F'\t' 'NR == 1 { print $1 "\t" $5 }')

  if [ -z "$minted" ] || [ "${minted#*$'\t'}" = "" ]; then
    echo "the API returned no secret for the new $operation token" >&2
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

revoke_ephemeral_token() {
  [ -n "$EPHEMERAL_JTI" ] || return 0
  local jti="$EPHEMERAL_JTI"
  EPHEMERAL_JTI=""

  echo "revoking the ephemeral publish token ($jti)" >&2
  cf DELETE "/accounts/$CF_ACCOUNT_ID/moq/relays/$EPHEMERAL_RELAY_UID/tokens/$jti" \
    > /dev/null 2>&1 || echo "warning: could not revoke $jti — revoke it by hand" >&2
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
  local uid="${1:?usage: cf-relay.sh mint <relay-uid> <publish|subscribe> [label]}"
  local operation="${2:?operation must be publish or subscribe}"
  local label="${3:-minted by cf-relay.sh}"

  case "$operation" in
    publish | subscribe) ;;
    *) echo "operation must be publish or subscribe" >&2; return 1 ;;
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
    list | create | tokens | mint | revoke | publish | env | delete)
      require_credentials
      "cmd_$command" "$@"
      ;;
    -h | --help | help) usage 0 ;;
    *) echo "unknown command: $command" >&2; usage 1 ;;
  esac
}

main "$@"
