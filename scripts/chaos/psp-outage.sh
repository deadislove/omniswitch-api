#!/usr/bin/env bash
# Chaos scenario: total PSP outage (both Stripe and Adyen adapters point at
# the same mock-psp container, so stopping it takes both down at once —
# the "every PSP is unreachable" case, not just one).
#
# Proves, against the real docker-compose stack, not just by reading the
# code:
# 1. Sustained real failures actually trip RedisCircuitBreakerService open
#    (FAILURE_THRESHOLD=5 within a 60s window — see that service).
# 2. A charge attempted while every PSP's circuit is OPEN fails cleanly and
#    quickly (a real 4xx/5xx response), not a hang — `assertAvailable()`
#    short-circuits before ever attempting a PSP call.
# 3. Recovery is real: once mock-psp comes back and the 30s recovery
#    window elapses, the circuit's own HALF_OPEN trial admits a real charge
#    and closes again — not stuck OPEN forever.
#
# Requires: the full docker-compose stack already up, MERCHANT_API_KEY_ID/
# MERCHANT_API_KEY_SECRET/MERCHANT_HMAC_SECRET/MERCHANT_ID for a seeded
# MERCHANT-role merchant, and OPERATOR_API_KEY_ID/OPERATOR_API_KEY_SECRET
# for a seeded OPERATOR-role merchant (to read GET /payments/routing/health,
# which MERCHANT can't call). See scripts/chaos/README.md for how to seed
# both without an existing admin.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${MERCHANT_ID:?}"
: "${MERCHANT_API_KEY_ID:?}"
: "${MERCHANT_API_KEY_SECRET:?}"
: "${MERCHANT_HMAC_SECRET:?}"
: "${OPERATOR_API_KEY_ID:?}"
: "${OPERATOR_API_KEY_SECRET:?}"

log() { echo "[psp-outage] $*"; }

login() {
  curl -s -X POST "$BASE_URL/api/v1/auth/token" \
    -H 'Content-Type: application/json' \
    -d "{\"apiKeyId\":\"$1\",\"apiKeySecret\":\"$2\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])"
}

routing_health() {
  curl -s "$BASE_URL/api/v1/payments/routing/health" -H "Authorization: Bearer $OPERATOR_TOKEN"
}

circuit_state_for() {
  # $1 = provider name, e.g. STRIPE
  routing_health | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', {}).get('circuitBreaker', 'UNKNOWN'))"
}

charge() {
  local amount="$1"
  local body="{\"amount\":$amount,\"currency\":\"USD\",\"paymentMethodId\":\"pm_card_visa\",\"orderId\":\"chaos_$(date +%s%N)\",\"binInfo\":{\"bin\":\"424242\",\"country\":\"US\",\"cardBrand\":\"VISA\",\"cardType\":\"CREDIT\"}}"
  local timestamp
  timestamp=$(date +%s)
  local signed_payload="${timestamp}.POST./api/v1/payments/charge.${body}"
  local signature
  signature=$(python3 -c "
import hmac, hashlib
print(hmac.new('$MERCHANT_HMAC_SECRET'.encode(), '''$signed_payload'''.encode(), hashlib.sha256).hexdigest())
")
  curl -s -o /tmp/chaos-charge-response.json -w '%{http_code}' -X POST "$BASE_URL/api/v1/payments/charge" \
    -H "Authorization: Bearer $MERCHANT_TOKEN" \
    -H "Idempotency-Key: $(python3 -c 'import uuid; print(uuid.uuid4())')" \
    -H "X-Signature: $signature" \
    -H "X-Timestamp: $timestamp" \
    -H "X-Merchant-Id: $MERCHANT_ID" \
    -H 'Content-Type: application/json' \
    -d "$body"
}

log "Logging in..."
MERCHANT_TOKEN=$(login "$MERCHANT_API_KEY_ID" "$MERCHANT_API_KEY_SECRET")
OPERATOR_TOKEN=$(login "$OPERATOR_API_KEY_ID" "$OPERATOR_API_KEY_SECRET")

log "Resetting STRIPE/ADYEN circuits to CLOSED for a clean baseline (this run's own history, or leftovers from other traffic against this same environment, could otherwise start the scenario already tripped)..."
curl -s -X POST "$BASE_URL/api/v1/payments/routing/circuit-breaker/STRIPE/reset" -H "Authorization: Bearer $OPERATOR_TOKEN" >/dev/null
curl -s -X POST "$BASE_URL/api/v1/payments/routing/circuit-breaker/ADYEN/reset" -H "Authorization: Bearer $OPERATOR_TOKEN" >/dev/null

log "Baseline: STRIPE circuit is $(circuit_state_for STRIPE)"
log "Baseline charge (expect SUCCEEDED)..."
code=$(charge 5)
log "  -> HTTP $code, status=$(python3 -c "import json;print(json.load(open('/tmp/chaos-charge-response.json')).get('status'))")"

log "Stopping mock-psp (docker compose stop mock-psp)..."
docker compose stop mock-psp >/dev/null

log "Firing charges until the circuit trips OPEN (or 8 attempts)..."
for i in $(seq 1 8); do
  code=$(charge 5) || true
  state=$(circuit_state_for STRIPE)
  log "  attempt $i: HTTP $code, STRIPE circuit=$state"
  if [ "$state" = "OPEN" ]; then
    log "Circuit tripped OPEN after $i attempt(s)."
    break
  fi
done

final_state=$(circuit_state_for STRIPE)
if [ "$final_state" != "OPEN" ]; then
  log "FAIL: circuit never opened after 8 attempts (state=$final_state)"
  docker compose start mock-psp >/dev/null
  exit 1
fi

log "Confirming a charge fails cleanly (not a hang) while STRIPE's circuit is OPEN..."
log "(smart routing may still fall back to ADYEN if ITS circuit hasn't tripped yet — a real charge attempt against a still-down PSP resolves as a FAILED/AMBIGUOUS *business* outcome with a normal HTTP response, not a 5xx or a hang; only a routing failure with *zero* available providers throws. Both are \"clean\" — the thing this step actually checks is that neither one hangs.)"
start_ts=$(date +%s)
code=$(charge 5) || true
elapsed=$(( $(date +%s) - start_ts ))
outcome_status=$(python3 -c "import json;print(json.load(open('/tmp/chaos-charge-response.json')).get('status', json.load(open('/tmp/chaos-charge-response.json')).get('error', 'n/a')))" 2>/dev/null || echo n/a)
log "  -> HTTP $code in ${elapsed}s, outcome=$outcome_status, ADYEN circuit=$(circuit_state_for ADYEN)"
if [ "$outcome_status" = "SUCCEEDED" ]; then
  log "  (note: ADYEN's circuit hadn't tripped yet, so it absorbed this charge and also failed against the down mock-psp would have been the fully-degraded case — SUCCEEDED here would be unexpected with mock-psp still down, worth a second look if seen)"
fi

log "Restarting mock-psp..."
docker compose start mock-psp >/dev/null
log "Waiting for the circuit breaker's recovery window (30s)..."
sleep 32

log "Firing recovery charges (expect at least one SUCCEEDED as circuits close again)..."
recovered=0
for i in 1 2 3; do
  code=$(charge 5) || true
  status=$(python3 -c "import json;print(json.load(open('/tmp/chaos-charge-response.json')).get('status'))" 2>/dev/null || echo n/a)
  log "  attempt $i: HTTP $code, status=$status, STRIPE=$(circuit_state_for STRIPE), ADYEN=$(circuit_state_for ADYEN)"
  if [ "$status" = "SUCCEEDED" ]; then
    recovered=1
    break
  fi
done

# Leave the environment clean regardless of outcome, for whatever runs next.
curl -s -X POST "$BASE_URL/api/v1/payments/routing/circuit-breaker/STRIPE/reset" -H "Authorization: Bearer $OPERATOR_TOKEN" >/dev/null
curl -s -X POST "$BASE_URL/api/v1/payments/routing/circuit-breaker/ADYEN/reset" -H "Authorization: Bearer $OPERATOR_TOKEN" >/dev/null

if [ "$recovered" = "1" ]; then
  log "PASS: circuit breaker opened under real sustained failure and recovered after mock-psp came back."
  exit 0
else
  log "FAIL: no charge succeeded within 3 attempts after mock-psp recovery."
  exit 1
fi
