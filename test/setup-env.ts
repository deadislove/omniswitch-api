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
// Each Jest worker gets its own logical Redis DB, not a shared one —
// `JEST_WORKER_ID` (always set by Jest, 1-indexed) selects it, so
// idempotency locks/circuit-breaker windows/rate-limit buckets/JWT
// revocation sets can't land in the same keyspace *concurrently* across
// workers. `test/jest-e2e.json` currently runs with `maxWorkers: 1`, so
// this isolation is inert today (only worker 1 ever exists) — it's
// verified-correct groundwork for `docs/technical/ci-cd.md`'s
// "Parallelizing e2e workers" section, which documents a real,
// reproducible flakiness class that showed up when `maxWorkers` was
// actually raised and is NOT explained by this Redis isolation being
// wrong (confirmed via targeted diagnostics — see that section). Left in
// place, harmless at maxWorkers:1, ready for whoever picks the
// parallelization work back up. Redis's default `databases` count is 16;
// `+1` keeps DB 0 (local dev) and DB 1 (historically the sole e2e DB, now
// worker 1's) free of collision with worker indices, and a worker count
// above 14 would wrap into local dev's/an earlier worker's DB.
setDefault('REDIS_DB', String(1 + Number(process.env.JEST_WORKER_ID || 1)));
// Configurable (production, app.module.ts, still defaults to 20 — this
// override is test-only) so N concurrent NestJS app instances can be
// bounded against one `max_connections=200` Postgres without a code
// change. 15 at `maxWorkers: 4` caps worst case at 4 * 2 pools * 15 =
// 120 connections, well under 200 — a real fix for real queueing delays
// found under contention (see ci-cd.md's "Parallelizing e2e workers":
// risk-tiering.e2e-spec.ts's 10-sequential-real-charge test was timing
// out even at a 60s budget, consistent with this app instance's own
// small pool queueing internally under concurrent load, not just
// external cross-worker contention).
setDefault('DB_POOL_MAX', '15');

// Test-only secrets — never used outside this process.
setDefault('JWT_SECRET', 'e2e-test-jwt-secret-do-not-use-outside-tests-32chars');
setDefault('HMAC_SECRET', 'e2e-test-hmac-secret-do-not-use-outside-tests-32c');

// The production default (100/min) is IP-scoped, not per-merchant — every
// e2e spec file's charge() calls share one IP-keyed bucket *within a Jest
// worker* (the REDIS_DB isolation above scopes it per worker, not per
// file — see that comment), so a worker's own cumulative charge volume
// across however many spec files it happens to run competes against one
// limit, not one per file. Files like subscriptions/reserve/risk-tiering
// (each legitimately firing 10+ charges to reach a real
// minimum-sample-size threshold) can still push a worker's bucket past
// 100 and 429 whatever unrelated file runs next in that same worker.
// Raised well above what any single worker's realistic file assignment
// would need — this was originally calibrated against the *entire* suite
// sharing one bucket (a stricter constraint than today's per-worker
// one), so it has headroom to spare now, not less. Same reasoning as
// AUTH_LOGIN_RATE_LIMIT below: rate-limiting behavior itself is covered
// by a dedicated, isolated spec, so raising the ambient limit here
// doesn't weaken that coverage.
setDefault('RATE_LIMIT_MAX', '2000');
// Generous headroom for the *other* spec files, which legitimately fire
// several requests per second against one seeded merchant. The dedicated
// rate-limiting spec proves per-merchant isolation via *relative* header
// comparisons (does merchant B's count reset vs. continue merchant A's?)
// rather than depending on this exact number, so raising it here doesn't
// weaken that test.
setDefault('RATE_LIMIT_BURST_MAX', '50');
// POST /payments/charge carries its own hardcoded, route-level
// @Throttle override (see payment.controller.ts) — RATE_LIMIT_MAX above
// does NOT touch it, because both the global IP-scoped guard and
// MerchantThrottlerGuard check the same 'default' throttler name and pick
// up this route-level override instead. Raising RATE_LIMIT_MAX alone
// (the change described in the comment above) does not fix the
// charge()-specific 429s a full suite run produces, since that override
// bypasses RATE_LIMIT_MAX entirely.
// Same reasoning as RATE_LIMIT_MAX: covered by its own isolated behavior,
// not by this ambient ceiling, so raising it doesn't weaken any coverage.
// See docs/technical/load-testing.md, Finding #1: this same hardcoded
// cap is the real ceiling for a single-IP load generator.
setDefault('CHARGE_RATE_LIMIT_MAX', '2000');
// The production default (10/min) is a deliberately aggressive brute-force
// guard on POST /auth/token — a full e2e run legitimately logs in more than
// 10 times. Rate-limiting behavior itself is covered by a dedicated,
// isolated test rather than relying on hitting this ambient limit.
setDefault('AUTH_LOGIN_RATE_LIMIT', '1000');

// GET /health's memory_heap/memory_rss checks default to thresholds
// calibrated against k8s/deployment.yaml's real 512Mi pod memory limit
// (see health.controller.ts) — appropriate for a compiled
// `node dist/main.js` production process, not this test harness. With
// maxWorkers: 1, every e2e spec file's own full NestJS/TypeORM compile
// runs in the same process as ts-jest's TypeScript compiler and Jest's
// own machinery, none of which a real deployment ever carries; heap
// climbs by design across the run and occasionally crossed the
// production-calibrated 512MB threshold, failing whichever spec file
// happened to run last with a 503 on /health
// (api-versioning.e2e-spec.ts, most often). This isn't a real leak —
// see docs/technical/ci-cd.md's heap-flake incident, including two
// same-process fixes (workerIdleMemoryLimit, forced GC) that were tried
// and didn't hold up. Raised here, in the test environment only —
// production's own default stays at 512MB/1GB.
setDefault('HEALTH_CHECK_HEAP_THRESHOLD_BYTES', String(1536 * 1024 * 1024)); // 1.5GB
setDefault('HEALTH_CHECK_RSS_THRESHOLD_BYTES', String(2048 * 1024 * 1024)); // 2GB

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
