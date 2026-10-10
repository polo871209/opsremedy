#!/usr/bin/env bash
# Mint an Anthropic OAuth token with a browser login and patch it into the token Secret. Runbook: auth.md.
set -euo pipefail

: "${KUBE_CONTEXT:?set KUBE_CONTEXT to the kubectl context of the cluster that runs opsremedy}"
NAMESPACE="${NAMESPACE:-opsremedy}"
SECRET_NAME="${SECRET_NAME:-anthropic-auth}"
kube() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

echo "--> log into the dedicated bot account in a private browser window"
CREDS=$(bun "$(dirname "$0")/../src/utils/anthropic-login.ts")
REFRESH=$(jq -r .refresh <<<"$CREDS")
ACCESS=$(jq -r .access <<<"$CREDS")
EXPIRES=$(jq -r '.expires | tostring' <<<"$CREDS")
unset CREDS

# jq prints "null" for a missing field, and that string would patch in as a token the pod cannot use.
for pair in "refresh:$REFRESH" "access:$ACCESS"; do
  case "${pair#*:}" in
    "" | null) echo "login output has no ${pair%%:*} token; secret untouched"; exit 1 ;;
    sk-ant-*) ;;
    *) echo "login output ${pair%%:*} token has an unexpected prefix; secret untouched"; exit 1 ;;
  esac
done
if [[ ! "$EXPIRES" =~ ^[0-9]{13}$ ]]; then
  echo "login output expiry is not epoch milliseconds: $EXPIRES; secret untouched"; exit 1
fi

kube patch secret "$SECRET_NAME" --type=merge -p \
  "$(jq -n --arg refresh "$REFRESH" --arg access "$ACCESS" --arg expires "$EXPIRES" \
    '{stringData:{ANTHROPIC_REFRESH_TOKEN:$refresh, ANTHROPIC_OAUTH_TOKEN:$access, ANTHROPIC_TOKEN_EXPIRES_AT:$expires}}')"
unset REFRESH ACCESS EXPIRES
echo "--> secret patched. The pod picks it up within about 60 seconds"
kube get secret "$SECRET_NAME" -o json | jq -r '.data | keys[]'
