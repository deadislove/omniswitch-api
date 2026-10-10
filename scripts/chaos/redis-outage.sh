#!/usr/bin/env bash
# Chaos scenario: Redis outage.
#
# security-and-compliance.md's JWT Revocation section documents a specific
# trade-off by design: "Redis becomes a hard dependency for authentication,
# not just idempotency... fails closed (Redis unreachable -> the
# revocation check throws -> auth fails) rather than open." This script
# proves that against the real stack rather than trusting the doc: a
# request with a genuinely valid, unexpired JWT must still be REJECTED
# while Redis is down, not silently let through.
#
# Requires: the full docker-compose stack already up, MERCHANT_API_KEY_ID/
# MERCHANT_API_KEY_SECRET for a seeded MERCHANT-role merchant.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MERCHANT_API_KEY_ID:?}"
: "${MERCHANT_API_KEY_SECRET:?}"

log() { echo "[redis-outage] $*"; }

login() {
  curl -s -X POST "$BASE_URL/api/v1/auth/token" \
    -H 'Content-Type: application/json' \
    -d "{\"apiKeyId\":\"$1\",\"apiKeySecret\":\"$2\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])"
}

whoami_check() {
  # Any authenticated GET works — this just needs JwtStrategy.validate()
  # (and therefore its Redis revocation check) to run. 404 (not 401) on a
  # random UUID is the "authenticated, no such payment" signal used
  # elsewhere in this codebase's own e2e suite.
  curl -s -o /tmp/chaos-redis-response.json -w '%{http_code}' \
    "$BASE_URL/api/v1/payments/00000000-0000-4000-8000-000000000000" \
    -H "Authorization: Bearer $TOKEN"
}

log "Logging in (this itself needs Redis for idempotency/rate-limit state, done before the outage)..."
TOKEN=$(login "$MERCHANT_API_KEY_ID" "$MERCHANT_API_KEY_SECRET")

log "Baseline: authenticated request with Redis up..."
code=$(whoami_check)
log "  -> HTTP $code (expect 404 = authenticated, no such payment)"
if [ "$code" != "404" ]; then
  log "FAIL: baseline request didn't even authenticate cleanly (HTTP $code) — aborting before touching Redis."
  exit 1
fi

log "Stopping redis (docker compose stop redis)..."
docker compose stop redis >/dev/null

log "Retrying the SAME still-valid, unexpired JWT while Redis is down..."
code=$(whoami_check)
body=$(cat /tmp/chaos-redis-response.json)
log "  -> HTTP $code, body=$body"

docker compose start redis >/dev/null
log "Redis restarted. Waiting for it to report healthy..."
for i in $(seq 1 15); do
  if docker compose ps redis 2>/dev/null | grep -q healthy; then
    break
  fi
  sleep 1
done

log "Confirming the same token authenticates again now that Redis is back..."
recovery_code=$(whoami_check)
log "  -> HTTP $recovery_code (expect 404 again)"

if [ "$code" = "404" ]; then
  log "FAIL: a valid JWT was still accepted with Redis down — this is fail-OPEN, not the documented fail-closed behavior. Real security regression, not just a doc mismatch."
  exit 1
fi
if [ "$recovery_code" != "404" ]; then
  log "FAIL: auth did not recover after Redis came back (HTTP $recovery_code)."
  exit 1
fi

log "PASS: auth fails closed while Redis is down (HTTP $code, not a silent pass-through) and recovers once Redis is back."
exit 0
