#!/usr/bin/env bash
# Provisions everything VaultTransitService's approle auth mode needs
# against an already-running dev-mode Vault (docker-compose's `vault`
# service) — the transit engine + hmac-secrets key (normally
# self-bootstrapped by static-token mode's root token, but an approle
# token scoped to just encrypt/decrypt can't do that itself), a policy
# scoped to exactly encrypt/decrypt on that one key, and an AppRole bound
# to it with a realistic, renewable TTL. Idempotent — safe to re-run;
# each step checks before creating.
#
# Requires: the `vault` docker-compose service already up
# (`docker compose up -d vault`), and VAULT_TOKEN set to its root token
# (dev-mode default: omniswitch-dev-root-token).
#
# Prints VAULT_APPROLE_ROLE_ID/VAULT_APPROLE_SECRET_ID at the end — put
# both in .env.local alongside VAULT_AUTH_METHOD=approle to actually use
# this mode. A fresh secret_id can be generated any time by re-running
# just the last step of this script (see bottom).
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-omniswitch-dev-root-token}"
TRANSIT_KEY_NAME="hmac-secrets"
POLICY_NAME="hmac-secrets-transit"
ROLE_NAME="omniswitch-api"
# Matches secret-management.md's stated migration target (short TTL,
# renewable) — not dev-mode Vault's own default (32 days).
TOKEN_TTL="1h"
TOKEN_MAX_TTL="4h"

log() { echo "[bootstrap-approle] $*"; }

vault_get() { curl -sf -H "X-Vault-Token: $VAULT_TOKEN" "$VAULT_ADDR$1"; }
vault_post() { curl -sf -H "X-Vault-Token: $VAULT_TOKEN" -H "Content-Type: application/json" -d "$2" "$VAULT_ADDR$1"; }
json_get() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

log "Checking transit secrets engine..."
if vault_get /v1/sys/mounts | json_get "['data'].get('transit/', None)" | grep -qv '^None$'; then
  log "  already mounted"
else
  vault_post /v1/sys/mounts/transit '{"type":"transit"}' >/dev/null
  log "  mounted"
fi

log "Checking transit key '$TRANSIT_KEY_NAME'..."
if vault_get "/v1/transit/keys/$TRANSIT_KEY_NAME" >/dev/null 2>&1; then
  log "  already exists"
else
  vault_post "/v1/transit/keys/$TRANSIT_KEY_NAME" '{}' >/dev/null
  log "  created"
fi

log "Writing policy '$POLICY_NAME' (encrypt/decrypt on '$TRANSIT_KEY_NAME' only — nothing else)..."
# "update" is the correct capability for both — Vault Transit's
# encrypt/decrypt endpoints are POST-based actions on an existing key, not
# a "read" of stored data or a "create" of a new one. Everything else
# (sys/mounts, transit/keys/* metadata, key rotation) is implicitly denied
# by Vault's default-deny model — not listed here on purpose.
POLICY_HCL=$(cat <<EOF
path "transit/encrypt/$TRANSIT_KEY_NAME" {
  capabilities = ["update"]
}
path "transit/decrypt/$TRANSIT_KEY_NAME" {
  capabilities = ["update"]
}
EOF
)
POLICY_JSON=$(python3 -c "import json,sys; print(json.dumps({'policy': sys.stdin.read()}))" <<< "$POLICY_HCL")
vault_post "/v1/sys/policies/acl/$POLICY_NAME" "$POLICY_JSON" >/dev/null
log "  written"

log "Checking AppRole auth method..."
if vault_get /v1/sys/auth | json_get "['data'].get('approle/', None)" | grep -qv '^None$'; then
  log "  already enabled"
else
  vault_post /v1/sys/auth/approle '{"type":"approle"}' >/dev/null
  log "  enabled"
fi

log "Creating/updating role '$ROLE_NAME' (policy=$POLICY_NAME, ttl=$TOKEN_TTL, max_ttl=$TOKEN_MAX_TTL)..."
vault_post "/v1/auth/approle/role/$ROLE_NAME" \
  "{\"token_policies\":\"$POLICY_NAME\",\"token_ttl\":\"$TOKEN_TTL\",\"token_max_ttl\":\"$TOKEN_MAX_TTL\"}" >/dev/null
log "  done"

ROLE_ID=$(vault_get "/v1/auth/approle/role/$ROLE_NAME/role-id" | json_get "['data']['role_id']")
SECRET_ID=$(vault_post "/v1/auth/approle/role/$ROLE_NAME/secret-id" '{}' | json_get "['data']['secret_id']")

echo ""
log "Done. Add to .env.local:"
echo ""
echo "VAULT_AUTH_METHOD=approle"
echo "VAULT_APPROLE_ROLE_ID=$ROLE_ID"
echo "VAULT_APPROLE_SECRET_ID=$SECRET_ID"
echo ""
log "secret_id above is single-use-tracked but not single-use by default (Vault's own default: unlimited uses until it expires, same TOKEN_MAX_TTL-independent default lease). To mint a fresh one later, re-run just:"
echo "  curl -sf -H \"X-Vault-Token: \$VAULT_TOKEN\" -H 'Content-Type: application/json' -d '{}' \"$VAULT_ADDR/v1/auth/approle/role/$ROLE_NAME/secret-id\""
