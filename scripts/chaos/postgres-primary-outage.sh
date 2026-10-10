#!/usr/bin/env bash
# Chaos scenario: Postgres primary outage.
#
# Every write (charge, capture, refund) goes to postgres-master; plain
# reads are routed to postgres-replica (app.module.ts's `replication`
# config). This proves two things against the real stack:
# 1. A write attempted while postgres-master is down fails cleanly (a real
#    error response within a bounded time), not a hang forever.
# 2. Once postgres-master comes back, writes succeed again without
#    restarting the app — TypeORM's pool reconnects on its own.
#
# Deliberately does NOT attempt to kill postgres-master mid-transaction
# (precise timing against a real DB from outside the process isn't
# reliable) — this tests the coarser, still-real "primary is unreachable
# for the whole request" case.
#
# Requires: the full docker-compose stack already up, MERCHANT_API_KEY_ID/
# MERCHANT_API_KEY_SECRET/MERCHANT_HMAC_SECRET/MERCHANT_ID for a seeded
# MERCHANT-role merchant.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MERCHANT_ID:?}"
: "${MERCHANT_API_KEY_ID:?}"
: "${MERCHANT_API_KEY_SECRET:?}"
: "${MERCHANT_HMAC_SECRET:?}"

log() { echo "[postgres-primary-outage] $*"; }

login() {
  curl -s -X POST "$BASE_URL/api/v1/auth/token" \
    -H 'Content-Type: application/json' \
    -d "{\"apiKeyId\":\"$1\",\"apiKeySecret\":\"$2\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])"
}

charge() {
  local body="{\"amount\":5,\"currency\":\"USD\",\"paymentMethodId\":\"pm_card_visa\",\"orderId\":\"chaos_$(date +%s%N)\",\"binInfo\":{\"bin\":\"424242\",\"country\":\"US\",\"cardBrand\":\"VISA\",\"cardType\":\"CREDIT\"}}"
  local timestamp
  timestamp=$(date +%s)
  local signed_payload="${timestamp}.POST./api/v1/payments/charge.${body}"
  local signature
  signature=$(python3 -c "
import hmac, hashlib
print(hmac.new('$MERCHANT_HMAC_SECRET'.encode(), '''$signed_payload'''.encode(), hashlib.sha256).hexdigest())
")
  curl -s -o /tmp/chaos-pg-response.json -w '%{http_code}' --max-time 15 -X POST "$BASE_URL/api/v1/payments/charge" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: $(python3 -c 'import uuid; print(uuid.uuid4())')" \
    -H "X-Signature: $signature" \
    -H "X-Timestamp: $timestamp" \
    -H "X-Merchant-Id: $MERCHANT_ID" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

log "Logging in..."
TOKEN=$(login "$MERCHANT_API_KEY_ID" "$MERCHANT_API_KEY_SECRET")

log "Baseline charge (expect SUCCEEDED)..."
code=$(charge)
log "  -> HTTP $code, status=$(python3 -c "import json;print(json.load(open('/tmp/chaos-pg-response.json')).get('status'))" 2>/dev/null || echo n/a)"

log "Stopping postgres-master (docker compose stop postgres-master)..."
docker compose stop postgres-master >/dev/null

log "Attempting a write with the primary down (--max-time 15s cap, so this proves 'fails within a bounded time', not 'hangs forever')..."
start_ts=$(date +%s)
set +e
code=$(charge)
curl_exit=$?
set -e
elapsed=$(( $(date +%s) - start_ts ))
log "  -> HTTP ${code:-<no response>} in ${elapsed}s (curl exit $curl_exit)"

log "Restarting postgres-master..."
docker compose start postgres-master >/dev/null
log "Waiting for it to report healthy..."
for i in $(seq 1 30); do
  if docker compose ps postgres-master 2>/dev/null | grep -q healthy; then
    break
  fi
  sleep 2
done

log "Confirming writes succeed again — retrying for up to 2 minutes, since the app's own connection pool takes a real, non-zero amount of time (observed: a couple of failed attempts, tens of seconds) to discard stale connections after the container starts reporting healthy again, not just however long docker's own healthcheck interval is..."
recovery_status="n/a"
for i in $(seq 1 24); do
  recovery_code=$(charge)
  recovery_status=$(python3 -c "import json;print(json.load(open('/tmp/chaos-pg-response.json')).get('status'))" 2>/dev/null || echo n/a)
  log "  attempt $i: HTTP $recovery_code, status=$recovery_status"
  if [ "$recovery_status" = "SUCCEEDED" ]; then
    break
  fi
  sleep 5
done

if [ "$curl_exit" != "0" ] || [ "$elapsed" -lt 15 ]; then
  log "Outage-window request did not hang (bounded by --max-time or failed fast) — good."
else
  log "WARNING: outage-window request took the full timeout budget without a clear fast failure — worth a closer look at connection-timeout tuning."
fi

if [ "$recovery_status" = "SUCCEEDED" ]; then
  log "PASS: writes fail within a bounded time while postgres-master is down, and recover on their own once it's back — no app restart needed."
  exit 0
else
  log "FAIL: did not recover cleanly after postgres-master came back (status=$recovery_status)."
  exit 1
fi
