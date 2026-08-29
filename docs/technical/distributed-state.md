# Distributed State: Rate Limiting, Circuit Breaker & Scheduled Jobs

`k8s/hpa.yaml` scales this API to up to 20 replicas. Anything that needs to
be consistent across requests — a rate-limit counter, a PSP circuit
breaker's failure count — can't live in a plain class field, because the
next request from the same client can land on a different pod with no
memory of the first one. Two pieces of state got this wrong originally and
were fixed during this project; this document covers the design, what it
actually took to get right, and the trade-offs that are still there. A
third, different-shaped version of the same underlying problem —
`@Cron` jobs running per-replica instead of once per cluster — is
documented at the end and is **not** fixed, only worked around
case-by-case; see that section before adding a new scheduled job.

---

## Rate Limiting

### The problem

`@nestjs/throttler`'s default `ThrottlerStorageService` is a plain
in-process `{}` object. With N replicas, a client hitting the API through a
load balancer effectively gets up to N× the documented limit, split across
however many pods it happens to land on, with zero coordination between
them. "100 req/min per merchant" was never actually true once this API ran
as more than one pod.

### Design

`RedisThrottlerStorage` (`src/shared/throttler/redis-throttler-storage.service.ts`)
implements `@nestjs/throttler`'s `ThrottlerStorage` interface
(`increment(key, ttl): Promise<{totalHits, timeToExpire}>`) against Redis
instead of memory, using a Lua script for the increment so that "increment
the counter, and set a TTL only if this is the first hit in a fresh window"
happens as one atomic round-trip:

```lua
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local pttl = redis.call("PTTL", KEYS[1])
return {current, pttl}
```

This is a **fixed-window counter**, not a reproduction of
`ThrottlerStorageService`'s per-hit sliding decay (each in-memory hit
schedules its own independent `setTimeout` to decrement itself exactly `ttl`
after it was recorded — closer to a sliding log). Fixed-window is the
standard trade-off for distributed rate limiting: a client can burst up to
2x the limit right at a window boundary (a few requests at the very end of
one window, a few more right at the start of the next), in exchange for O(1)
storage and a single atomic operation per check, instead of tracking
per-request timestamps. This is deliberate, not an oversight — a
sliding-window-log implementation in Redis is possible (sorted sets, one
member per request) but meaningfully more expensive per check, and the
burst-at-boundary imprecision doesn't matter for what this is actually
protecting against (sustained abuse, not exact-millisecond fairness).

Two independent dimensions share this same storage: the global IP-keyed
guard (`APP_GUARD` in `app.module.ts`) and `MerchantThrottlerGuard`
(per-merchant, applied at the controller level after `JwtAuthGuard` so
`req.user.merchantId` is available — see
[`architecture.md`](./architecture.md#request-processing-pipeline) for guard
ordering). They don't interfere with each other because
`ThrottlerGuard.generateKey()` hashes the tracker value (IP or merchant id)
into the storage key — different tracker, different key, independent count,
even sharing one `ThrottlerStorageService` instance.

### The `@Global()` surprise

The first implementation attempt gave `MerchantThrottlerGuard` its *own*
`ThrottlerModule.forRootAsync()` registration inside `PaymentModule`, with a
deliberately different burst limit (5/sec vs. the global guard's 10/sec) —
the plan was to prove isolation by triggering the stricter limit first. It
didn't work: the merchant-scoped guard kept enforcing the *global* 10/sec
limit regardless of what `PaymentModule`'s registration said.

The cause: `@nestjs/throttler`'s `ThrottlerModule` is decorated `@Global()`.
Every module that calls `forRoot`/`forRootAsync` gets its own set of
providers, but because the module itself is global, Nest's DI resolves the
`THROTTLER_OPTIONS`/`ThrottlerStorage` tokens app-wide to whichever
registration wins the module graph — **not** the one scoped to the module
that declared the guard using it. A second registration doesn't create a
second independent instance; it's silently redundant.

This was found by instrumenting `handleRequest()` with debug logging
(temporarily patched directly into `node_modules`, since the bug was in
resolving *which* registered options a guard was actually using — logging
inside app code couldn't have shown that) and watching both the IP-keyed
and merchant-keyed checks report `limit: 10` and the same internal storage
identity, when only one of them should have. The fix: delete the redundant
registration entirely, keep the one `ThrottlerModule.forRootAsync()` call in
`AppModule`, and let `MerchantThrottlerGuard` share it — which is correct
anyway, since isolation comes from the tracker-keyed storage key, not from
having a separate module registration.

**Lesson for anything else using this pattern**: if a library's module is
`@Global()`, calling its `forRoot`/`forRootAsync` a second time to get
"independent" configuration doesn't do what it looks like it does. Check for
`@Global()` before assuming a second registration is isolated.

### Verification

Proven live with two real, independently-started app processes (not two
requests to one process) sharing one Redis instance: a merchant's
`X-RateLimit-Remaining-burst` header decremented continuously across
requests alternating between "replica A" and "replica B" (`9 → 8 → 7 → 6`,
crossing processes between every step), and a second merchant's very next
request — issued immediately after, from the same source IP, load-balanced
across the same two processes — started at a fresh count rather than
continuing the first merchant's depletion. This is now automated as
`test/rate-limiting.e2e-spec.ts`, using the same relative-comparison
technique (does a fresh identity's counter start over, or continue a busy
one's?) rather than asserting against the exact configured limit — the
production default and the e2e suite's raised limit (see
`test/setup-env.ts` — the login and general-API limits are both
env-configurable specifically so a busy test run doesn't trip its own
brute-force guard) both pass the same assertions.

### Known trade-offs

- Fixed-window burst-at-boundary imprecision (above) — accepted.
- No visibility/alerting on *why* a client is being throttled beyond the
  standard `X-RateLimit-*` response headers and a `429`. A real deployment
  would likely want to log or emit a metric when a merchant is throttled
  repeatedly, since that's either abuse or a legitimate customer who needs a
  higher limit — right now that signal doesn't exist.

---

## Circuit Breaker

### The problem

`StripePSPAdapter`/`AdyenPSPAdapter` used to track their own circuit state
(`failureCount`, `CLOSED`/`OPEN`/`HALF_OPEN`, success/latency metrics) as
plain instance fields. Same issue as rate limiting: each replica made its
own independent judgment about whether a PSP was healthy. One pod could
have tripped the breaker on Stripe after 5 failures while its siblings kept
sending traffic to it, oblivious — the entire point of a circuit breaker
(stop hammering a failing dependency) doesn't hold once there's more than
one process deciding independently.

### Design

`RedisCircuitBreakerService` (`src/modules/payment/adapters/circuit-breaker/redis-circuit-breaker.service.ts`)
stores per-provider state as individual Redis keys (`circuit:{provider}:state`,
`:failureCount`, `:lastFailureTime`, `:successCount`, `:totalRequests`,
`:totalLatencyMs`), reusing the existing `CachePort` abstraction (the same
one `IdempotencyInterceptor` uses) rather than opening a new Redis
connection — this is a distinct concern from payment idempotency caching,
but there's no reason to pay for a second connection when the existing one
already supports the handful of atomic operations needed (`incr`, and
`pipeline` for `incrby`, which `CachePort` doesn't expose as a named method
but does support generically).

Counter increments (`failureCount`, `successCount`, `totalRequests`) use
Redis `INCR`/`INCRBY`, which are atomic per-key — safe under concurrent
requests from multiple replicas without needing a Lua script the way the
throttler's "increment + conditionally set TTL" did. State *transitions*
(`OPEN` → `HALF_OPEN`, `HALF_OPEN` → `CLOSED`) are a plain `GET` then `SET`,
which is technically racy — two replicas could both observe `OPEN` past the
recovery window and both write `HALF_OPEN` — but since both would be writing
the same target value, the race is benign. There's no scenario where this
produces an incorrect final state, only a harmless duplicate write.

### Verification

Proven live the same way as rate limiting: the mock PSP was stopped, five
charge attempts against Stripe were forced to fail from one replica, and a
second replica — checked via `GET /payments/routing/health`, having never
made any of those failing calls itself — reported Stripe's circuit as
`OPEN` too.

### Known trade-offs

- **Metrics are unbounded cumulative counters, not a sliding window.**
  `successCount`/`totalRequests`/`totalLatencyMs` accumulate for as long as
  the Redis keys exist — unlike the old per-process version, they don't
  reset on a deploy/restart. This is arguably *more* correct for a shared
  health view (a health check surviving a deploy is generally good), but it
  means a bad incident from months ago stays baked into the reported success
  rate forever, with no way to see "how is this PSP doing *right now*"
  specifically. A time-windowed implementation (e.g., only counting the
  last 15 minutes) would be more representative of current health; that's
  tracked in [`../../DEV_README.md`](../../DEV_README.md) as a Tier 2 item,
  not implemented here.
- Recovery timing (`RECOVERY_TIME_MS = 30000`) and failure threshold
  (`FAILURE_THRESHOLD = 5`) are hardcoded constants, not per-PSP or
  environment-configurable. Fine for two PSPs with similar reliability
  profiles; would need to become configurable if a third PSP with very
  different failure characteristics were added.

## Scheduled Jobs (`@Cron`)

### The problem

`@nestjs/schedule`'s `@Cron` decorator registers a timer inside whatever
process the module loads in — it has no concept of "the cluster," only
"this process." With `k8s/hpa.yaml` scaling to up to 20 replicas, every
`@Cron`-decorated method in this codebase fires **in every pod**,
independently, at the same wall-clock time. This is the same underlying
class of problem rate limiting and the circuit breaker had (per-process
state where cluster-wide state was actually needed) — but unlike those
two, **it has not been fixed here**, only worked around, unevenly, on a
service-by-service basis.

There are thirteen of these today (fifteen counting the two purely
read-only ones): `LedgerOutboxRelayService.relay()` (every 10s) and its
`detectStaleEvents()` (every 5min, log/alert-only — no state mutation,
so not a duplication concern the way the others below are);
`ReconciliationService` (hourly, not daily); `ReserveService`,
`SubscriptionService`, and `RiskTieringService` (all daily);
`PayoutService`'s four separate sweeps — `runSweep()` (noon),
`releaseEligibleReserves()` (midnight), `recheckKycBlocks()` (1am),
and `initiateEligibleTransfers()` (2am); `AmbiguousPaymentService`'s
`runAutoResolutionSweep()` (every 10min) and `alertOnStale()` (every
5min, log/alert-only, same posture as `detectStaleEvents()` above); and
`AmbiguousRiskMonitoringService.runAutoClearSweep()` (3am). At 20
replicas, the daily/hourly sweeps don't run once a day/hour — they run
up to 20 times, all within roughly the same moment.

### What actually happens per service (not a uniform story)

- **`ReserveService.releaseEligible()` and `SubscriptionService.runBillingSweep()`
  are self-healing**, not by design intent but as a side effect of
  unrelated bugs found and fixed *within* each service (see
  `ledger-and-settlement.md` and `subscriptions.md`). `ReserveService`
  releases via an atomically-conditional `UPDATE ... WHERE status =
  'HELD'`; a second replica racing the same hold loses that race and gets
  a caught `ConflictException`, not a double-release. `SubscriptionService`
  charges under a deterministic per-period payment id and checks whether
  it's already `SUCCEEDED` before charging; a second replica racing the
  same subscription+period either loses a primary-key race inside the
  saga or finds the charge already done and just advances the period.
  Both were built to survive a *process crash* mid-sweep, not multi-replica
  duplication specifically — but the same mechanism happens to cover both.
- **`PayoutService` — mixed mechanisms, all verified race-safe.**
  `releaseEligibleReserves()`/`recheckKycBlocks()`/
  `initiateEligibleTransfers()` each go through an atomically-conditional
  `UPDATE ... WHERE` (`PayoutPort.markReserveReleased()`/
  `markKycCleared()`/`markTransferInitiated()`) — the same
  race-safe-by-construction pattern `ReserveService` uses. `runSweep()`
  (the noon job that creates `Payout` rows from a windowStart/windowEnd
  derived from `findLatestSweepRun()`) used a different mechanism: two
  replicas racing noon previously both read the same "last sweep" window
  and both created a `Payout` for the same ledger credit — confirmed
  live via a real concurrent-call reproduction, not just theorized from
  reading the code. Fixed with a `CachePort.setNX()` distributed lock
  around the whole method (the same primitive `IdempotencyInterceptor`
  already uses for per-request locking, applied here to a batch job
  instead) — a losing caller returns `null` rather than racing the
  winner. Verified live: the same reproduction now produces exactly one
  `Payout`, with a permanent regression test in
  `test/marketplace-payouts.e2e-spec.ts`.

  **Deliberate trade-off, not an oversight**: the lock is the only
  safeguard — there is no DB-level uniqueness constraint backstopping
  it. Adding one properly would need a new `window_start` column on
  `payouts` (today's `sweep_run_id` doesn't work as a uniqueness key
  here, since two racing calls each mint their own fresh
  `sweepRunId`), a backfill migration, and application code to treat a
  unique-violation as an expected, safely-skippable outcome — real
  schema work, not a small addition. Skipped because the lock already
  closes the reproduced race, and Redis being unreachable fails
  `setNX()` loudly (the sweep errors out) rather than silently granting
  every caller the lock — there's no silent-failure mode a backstop
  would specifically catch at today's scale. The lock's own failure
  mode that a DB constraint *would* catch — a legitimately slow sweep
  outliving its lock's TTL and genuinely racing the next scheduled tick
  — is a scale problem (this method sweeps every eligible merchant in
  one sequential pass under one global lock), not a correctness gap in
  the lock itself. If/when that scale is reached, the DB constraint is
  worth building alongside whichever sharding/batching/queue redesign
  actually addresses the sweep's own throughput, not in isolation
  before then.
- **`ReconciliationService` is not self-healing** — a second replica
  running the same window's reconciliation produces a second, duplicate
  `ReconciliationRun` row recording the same (hopefully clean) result.
  Wasteful, and noisy for whoever reviews reconciliation history, but not
  a correctness bug in the underlying ledger data itself.
- **`RiskTieringService.runTieringSweep()` is idempotent in the common
  case** (recomputing the same tier from the same data twice just writes
  the same `reserveBps`/`reserveHoldDays` twice) but not race-free in
  principle — two replicas evaluating the same merchant concurrently
  could theoretically interleave reads/writes if the underlying dispute
  data changed mid-evaluation. Low-impact in practice (tiers only
  meaningfully change over a 90-day window, not within the seconds two
  replicas' sweeps could overlap by).
- **`LedgerOutboxRelayService` was never audited for this specifically**
  — `findPending()` + relay-and-`markPublished()` on a 10-second cycle
  across 20 replicas means the same batch of pending events is likely
  read by multiple pods before any of them finishes publishing. Whether
  that produces a duplicate publish (the in-process `EventEmitter2` emit
  this relay currently does — see `ledger-and-settlement.md` — would fire
  in each replica that read the same event) is a real open question, not
  verified either way.
- **`AmbiguousPaymentService.runAutoResolutionSweep()` reduces but
  doesn't eliminate the race**: each item re-reads the payment on the
  master and skips it if its status is no longer `AMBIGUOUS`
  immediately before acting, which closes the most obvious window, but
  two replicas could still both pass that re-read check for the same
  payment before either one's write lands — not verified either way,
  same open-question posture as `LedgerOutboxRelayService` above.
  `alertOnStale()` is read-only/alert-only, same non-concern as
  `detectStaleEvents()`.
- **`AmbiguousRiskMonitoringService.runAutoClearSweep()` is idempotent**
  — it unconditionally sets a merchant's ambiguous-risk flag to cleared;
  two replicas racing the same merchant both write the same end state,
  not a double-effect the way creating a new row would be.

### Why this hasn't been fixed properly

A real fix needs a cluster-wide "only one replica runs this" primitive —
either a distributed lock (e.g. a Redis `SET NX` the cron handler
acquires before doing any work, released or left to expire after), a
dedicated single-replica `CronJob`/leader-election pattern at the k8s
level, or moving scheduled work out of the API pods entirely into a
separate, single-instance worker deployment. None of that exists yet;
building it properly (choosing a lock TTL that survives a slow run
without either double-firing or deadlocking a legitimately-slow one) is
real design work, not a quick add. Tracked here rather than in
`DEV_README.md` because it's a cross-cutting infrastructure gap affecting
every current and future `@Cron` job uniformly, not a single feature's
loose end.

**If you add a new `@Cron` job**: assume it will run concurrently across
every replica, and design for that from the start — either make the work
naturally idempotent/conflict-safe under concurrent execution (the
pattern `ReserveService`/`SubscriptionService` happen to follow), guard
it with a distributed lock the way `PayoutService.runSweep()` now does,
or explicitly flag in its docblock that it isn't yet safe either way,
the way this section flags `ReconciliationService` and
`LedgerOutboxRelayService`.
