/**
 * E2E environment defaults.
 *
 * These match docker-compose.yml's service credentials exactly, so the
 * documented local workflow just works:
 *
 *   docker-compose up -d postgres-master postgres-replica redis mock-psp vault
 *   npm run test:e2e
 *
 * Every value here is `??=`'d, not force-set — CI (or anyone testing
 * against a different stack) can override any of these via real
 * environment variables without editing this file.
 */
function setDefault(key: string, value: string): void {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

setDefault('NODE_ENV', 'test');

setDefault('DB_MASTER_HOST', 'localhost');
setDefault('DB_MASTER_PORT', '15432');
setDefault('DB_REPLICA_HOST', 'localhost');
setDefault('DB_REPLICA_PORT', '5433');
setDefault('DB_USERNAME', 'omniswitch');
setDefault('DB_PASSWORD', 'omniswitch_secret');
setDefault('DB_NAME', 'omniswitch_payments');
setDefault('DB_SSL', 'false');

setDefault('REDIS_HOST', 'localhost');
setDefault('REDIS_PORT', '16379');
setDefault('REDIS_PASSWORD', 'redis_secret');
setDefault('REDIS_DB', '1'); // separate logical DB from local dev's REDIS_DB=0

// Test-only secrets — never used outside this process.
setDefault('JWT_SECRET', 'e2e-test-jwt-secret-do-not-use-outside-tests-32chars');
setDefault('HMAC_SECRET', 'e2e-test-hmac-secret-do-not-use-outside-tests-32c');

// The production default (100/min) is IP-scoped, not per-merchant — every
// e2e spec file's charge() calls in a single `npm run test:e2e` run share
// one IP-keyed bucket (the whole suite finishes in well under 60s), so the
// full suite's cumulative charge volume competes against one limit, not
// one per file. Adding the subscriptions/reserve/risk-tiering specs (each
// legitimately firing 10+ charges to reach a real minimum-sample-size
// threshold) pushed the suite past 100 and started 429-ing unrelated
// *later* files — confirmed live: test/webhooks.e2e-spec.ts's dispute
// tests, which don't touch rate limiting at all, started failing with 429
// once those specs were added. Same reasoning as AUTH_LOGIN_RATE_LIMIT
// below: rate-limiting behavior itself is covered by a dedicated, isolated
// spec, so raising the ambient limit here doesn't weaken that coverage.
setDefault('RATE_LIMIT_MAX', '2000');
// Generous headroom for the *other* spec files, which legitimately fire
// several requests per second against one seeded merchant. The dedicated
// rate-limiting spec proves per-merchant isolation via *relative* header
// comparisons (does merchant B's count reset vs. continue merchant A's?)
// rather than depending on this exact number, so raising it here doesn't
// weaken that test.
setDefault('RATE_LIMIT_BURST_MAX', '50');
// The production default (10/min) is a deliberately aggressive brute-force
// guard on POST /auth/token — a full e2e run legitimately logs in more than
// 10 times. Rate-limiting behavior itself is covered by a dedicated,
// isolated test rather than relying on hitting this ambient limit.
setDefault('AUTH_LOGIN_RATE_LIMIT', '1000');

// docker-compose's mock-psp service, exposed on the host at :4000.
setDefault('STRIPE_SECRET_KEY', 'sk_test_e2e_placeholder');
setDefault('STRIPE_BASE_URL', 'http://localhost:4000/v1');
setDefault('STRIPE_WEBHOOK_SECRET', 'whsec_e2e_test_placeholder');
setDefault('ADYEN_API_KEY', 'adyen_e2e_test_placeholder');
setDefault('ADYEN_MERCHANT_ACCOUNT', 'TestMerchant');
setDefault('ADYEN_BASE_URL', 'http://localhost:4000/adyen');
setDefault('ADYEN_HMAC_KEY', '00112233445566778899aabbccddeeff00112233445566778899aabbccddee');
setDefault('FX_RATE_PROVIDER_URL', 'http://localhost:4000/fx');
setDefault('KYC_PROVIDER_URL', 'http://localhost:4000/kyc');
setDefault('BANK_TRANSFER_PROVIDER_URL', 'http://localhost:4000/bank');

setDefault('CORS_ORIGINS', 'http://localhost:3000');
setDefault('APP_VERSION', 'e2e-test');

// docker-compose's vault service (dev mode), exposed on the host at :8200.
setDefault('VAULT_ADDR', 'http://localhost:8200');
setDefault('VAULT_TOKEN', 'omniswitch-dev-root-token');
