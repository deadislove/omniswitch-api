# Architecture

## Module map

```
src/
├── app.module.ts                  # Root module: DB, throttling, scheduling, health
├── tracing.ts                     # OpenTelemetry SDK bootstrap — imported first in main.ts,
│                                   # before anything auto-instrumentation needs to patch
│                                   # (see this file's own docblock for why order matters)
├── main.ts                        # Bootstrap: helmet, CORS, validation, rawBody capture,
│                                   # global 'api' prefix + URI versioning (see main.ts's
│                                   # setGlobalPrefix exclude list for health/metrics)
├── health/                        # Liveness/readiness probes (version-neutral, no /api prefix)
├── observability/                 # metrics.controller.ts — Prometheus /metrics (same, no prefix)
├── database/
│   ├── data-source.ts             # Plain TypeORM DataSource for the CLI (migrations) —
│   │                               # deliberately separate from app.module.ts's
│   │                               # TypeOrmModule.forRootAsync(); every entity must be
│   │                               # registered in BOTH or migration:generate silently
│   │                               # won't see it (a real bug hit twice building this)
│   └── migrations/                # One file per schema change, source of truth (synchronize: false)
├── jobs/                          # Standalone CLI scripts, outside the Nest DI container —
│   │                               # same pattern as database/seed-admin.ts: import AppDataSource
│   │                               # directly, run raw SQL, exit. run-*-job.ts are each a k8s
│   │                               # CronJob's container command, not a @Cron() method (see
│   │                               # distributed-state.md for why @Cron() doesn't fit a
│   │                               # once-per-cluster job at HPA scale).
│   ├── run-archiving-job.ts       # Moves eligible payments/ledger_outbox rows to the `archive`
│   │                               # schema — docs/compliance/data-retention.md
│   ├── run-deletion-job.ts        # Backs up then deletes archived rows past the retention
│   │                               # window — docs/compliance/data-retention.md
│   ├── backup-storage/            # Pluggable BackupStorage adapters run-deletion-job.ts
│   │   │                          # writes to — local disk (default, what CI runs with),
│   │   │                          # S3, GCS, Azure Blob, selected via DELETION_BACKUP_STORAGE.
│   │   │                          # get-backup-storage.ts is a plain factory function, not
│   │   │                          # NestJS DI — run-deletion-job.ts runs outside the Nest
│   │   │                          # container. data-retention.md, "Where the backup goes."
│   │   └── *.spec.ts              # Unit tests — real filesystem for the local adapter,
│   │                               # mocked SDK clients for the three cloud adapters (never
│   │                               # run against a real bucket — no real cloud credentials
│   │                               # anywhere in this project's CI or local dev setup)
│   ├── create-partitions-job.ts   # Keeps upcoming-month partitions pre-created on payments/
│   │                               # ledger_outbox so new rows never fall into DEFAULT —
│   │                               # k8s CronJob, weekly — data-retention.md
│   └── drop-cutover-tables.ts     # One-time operator action (k8s Job, not a CronJob) — drops
│                                   # payments_old/ledger_outbox_old once the cutover
│                                   # verification window elapses — data-retention.md
├── shared/
│   ├── auth/
│   │   ├── auth.module.ts         # JwtModule + PassportModule + JwtStrategy — the leaf
│   │   │                          # module both PaymentModule and MerchantModule import,
│   │   │                          # to avoid a circular dependency between them
│   │   ├── jwt.strategy.ts        # Verifies JWTs, checks revocation on every request
│   │   └── token-revocation.service.ts  # Redis-backed jti + per-merchant revocation
│   ├── guards/                    # JwtAuthGuard, RolesGuard, HmacSignatureGuard,
│   │                               # MerchantThrottlerGuard
│   ├── decorators/                # @Public(), @Roles(), @AllowMfaPending()
│   ├── middleware/                # CorrelationIdMiddleware
│   ├── throttler/                 # RedisThrottlerStorage — shared IP/merchant rate-limit
│   │                               # counters across replicas (see "A note on shared state")
│   ├── vault/                     # VaultTransitService — envelope encryption for
│   │                               # HMAC secrets and TOTP secrets (same Transit key, reused)
│   └── logging/                   # Winston structured logger
├── modules/
│   ├── merchant/                  # Tenant identity: credentials, MFA, admin CRUD, login,
│   │   │                          # connected-account KYC submission
│   │   ├── merchant.entity.ts     # Credentials + platformFeeBps/feeTiers/settlementCurrency/
│   │   │                          # reserveBps+reserveHoldDays+riskTierAutoManaged/MFA/
│   │   │                          # accountType+platformMerchantId (marketplace)/kycStatus/
│   │   │                          # enabledPspProviders (per-merchant PSP entitlement) fields
│   │   ├── merchant.service.ts    # verifyCredentials, createMerchant, rotate*, setActive,
│   │   │                          # update{FeeRate,FeeTiers,SettlementCurrency,ReservePolicy,
│   │   │                          # PayoutReservePolicy,PspEntitlement}, setRiskTierAutoManaged,
│   │   │                          # applyAutoRiskTier, submitKyc, revokeAllSessions,
│   │   │                          # applyAutoAmbiguousRiskFlag, setAmbiguousRiskFlagManual,
│   │   │                          # setAmbiguousRiskAutoManaged
│   │   ├── mfa.service.ts         # TOTP enroll/confirm/verify/disable (PCI DSS Req 8.4.2)
│   │   ├── kyc-provider.port.ts + mock-kyc-provider.adapter.ts  # Connected-account KYC review
│   │   │                          # (real HTTP call to an external verifier — mocked here)
│   │   ├── auth.controller.ts     # POST /auth/token (+ mfa/enroll,confirm,verify,disable), /auth/revoke
│   │   └── merchant-admin.controller.ts  # ADMIN-only onboarding/rotation/revocation/policy/KYC
│   └── payment/                   # Owns anything that moves money — payments, disputes,
│       │                          # reconciliation, reserves, subscriptions, plans, marketplace
│       │                          # payouts, risk tiering, agentic-payment delegations all live
│       │                          # here, not split into their own modules, since they all
│       │                          # depend on PaymentProcessorFactory/LedgerOutboxPort
│       ├── domain/                # Pure business logic, zero external dependencies
│       │   ├── aggregates/        # PaymentAggregate, LedgerOutboxEvent, ReconciliationRun,
│       │   │                      # Dispute, ReserveHold, Subscription, Plan, Payout,
│       │   │                      # PayoutSweepRun, Delegation
│       │   ├── value-objects/     # Money, Currency, BinInfo, PaymentStatus, SpendPolicy
│       │   ├── events/            # Domain events (PaymentCharged, PaymentDisputed, ...)
│       │   └── services/          # SmartRoutingStrategy, DisputePolicy
│       ├── ports/outbound/        # One port per aggregate's persistence contract
│       │                          # (PaymentRepositoryPort, LedgerOutboxPort,
│       │                          # ReconciliationPort, DisputePort, ReserveHoldPort,
│       │                          # SubscriptionPort, PlanPort, PayoutPort, DelegationPort),
│       │                          # plus PSPAdapterPort, CachePort, FXRateProviderPort,
│       │                          # BankTransferPort — interfaces the domain depends on
│       ├── adapters/
│       │   ├── persistence/       # TypeORM entities, mappers, repositories (1:1 with the
│       │   │                      # ports above)
│       │   ├── cache/             # Redis (ioredis) — idempotency locking
│       │   ├── circuit-breaker/   # RedisCircuitBreakerService — per-PSP health, shared
│       │   │                      # across replicas (see "A note on shared state")
│       │   ├── fx/                # FXRateProviderAdapter — calls mock-psp's /fx/rates
│       │   ├── bank/              # MockBankTransferAdapter — calls mock-psp's /bank/transfers
│       │   │                      # for marketplace payout transfer initiation
│       │   └── psp/
│       │       ├── stripe/        # StripePSPAdapter + StripeWebhookGuard
│       │       ├── adyen/         # AdyenPSPAdapter + AdyenWebhookGuard
│       │       └── payment-processor.factory.ts  # Smart-routing-driven PSP selection
│       └── application/
│           ├── controllers/       # PaymentController (also the entry point for an AGENT
│           │                      # token's delegated charge), WebhookController,
│           │                      # SubscriptionController, PlanController,
│           │                      # DelegationController, plus 10 focused admin controllers
│           │                      # (Outbox/Reconciliation/Dispute/Reserve/Subscription/
│           │                      # RiskTiering/MarketplacePayout/LegalHold/AmbiguousPayment/
│           │                      # AmbiguousRisk — LegalHold is
│           │                      # POST/DELETE admin/payments/:id/legal-hold, see
│           │                      # docs/compliance/data-retention.md)
│           ├── sagas/             # PaymentCheckoutSaga (charge, compensating txns) — also
│           │                      # the engine SubscriptionService reuses per billing period
│           ├── services/          # AcquirerRoutingService, PaymentLifecycleService
│           │                      # (refund/capture/cancel), WebhookProcessingService,
│           │                      # ChargeLedgerParamsResolverService (fee/FX/reserve/split
│           │                      # params, one merchant lookup shared by every
│           │                      # ledger-booking call site), DisputeService,
│           │                      # ReconciliationService, OutboxRecoveryService,
│           │                      # ReserveService, SubscriptionService, RiskTieringService,
│           │                      # PlanService, PayoutService, DelegationService (spend-policy
│           │                      # reservation/release, agent JWT issuance/revocation),
│           │                      # LegalHoldService, LedgerOutboxRelayService,
│           │                      # AmbiguousPaymentService, AmbiguousRiskMonitoringService —
│           │                      # several of these are recurring @Cron sweeps, each also
│           │                      # exposed on demand via an admin POST endpoint (see the
│           │                      # pattern table below)
│           ├── interceptors/      # IdempotencyInterceptor
│           └── dto/               # ChargePaymentDto, RefundPaymentDto, SubscriptionDto,
│                                  # PlanDto, DelegationDto, ...
```

## Module dependency graph

Nest's DI graph, straight from each module's `imports: [...]` array — not
an idealized version. `AuthModule` has zero dependencies on the other two
by design (see the section below for why):

```
+--------------------------------------------------------------+
|                          AppModule                           |
|       (root -- also wires DB / Redis / Vault clients,        |
|       ThrottlerGuard, ScheduleModule, TerminusModule)        |
+--------------------------------------------------------------+
                                |
              +---------------------------------+---------------------------------+
              v                                 v                                 v
+--------------------------+      +--------------------------+      +--------------------------+
|     HealthController     |      |      MerchantModule      |      |      PaymentModule       |
|    MetricsController     |      |    (modules/merchant)    |      |    (modules/payment)     |
|  (registered directly,   |      |                          |      |                          |
|     no module import)    |      |                          |      |                          |
+--------------------------+      +--------------------------+      +--------------------------+

+------------------+     +------------------+
|  PaymentModule   | --> |  MerchantModule  |
+------------------+     +------------------+

+------------------+     +------------------+
|  PaymentModule   | --> |    AuthModule    |
|                  |     |  (shared/auth)   |
+------------------+     +------------------+

+------------------+     +------------------+
|  PaymentModule   | --> |   VaultModule    |
|                  |     |  (shared/vault)  |
+------------------+     +------------------+

+------------------+     +------------------+
|  MerchantModule  | --> |    AuthModule    |
|                  |     |  (shared/auth)   |
+------------------+     +------------------+

+------------------+     +------------------+
|  MerchantModule  | --> |   VaultModule    |
|                  |     |  (shared/vault)  |
+------------------+     +------------------+
```

`PaymentModule` importing `MerchantModule` (not the other way around) is
the one edge worth remembering: `HmacSignatureGuard` (lives in
`PaymentModule`'s guard chain) needs `MerchantService` to look up a
merchant's HMAC key. Nothing in `MerchantModule` needs anything from
`PaymentModule`. If a future feature ever seems to need the reverse edge,
that's a sign the shared concern belongs in `AuthModule` (or a new leaf
module) instead of creating a cycle — see the section right below for the
same reasoning spelled out in prose.

### Inside `PaymentModule`: the hexagonal layering

Dependency direction only ever points inward, toward `domain/` — this is
the actual enforcement mechanism behind "domain logic never imports
infrastructure," not just a convention:

```
+------------------------------------------------------------+
|               application/  (orchestration)                |
|                                                            |
|        controllers/   sagas/ (PaymentCheckoutSaga)         |
|  services/ (AcquirerRoutingService, ...)   interceptors/   |
+------------------------------------------------------------+
                               | depends on
                               v
+----------------------------------------------+                      +------------------------------------------+
|     ports/outbound/  (abstract classes)      |                      |  adapters/  (concrete implementations)   |
|                                              |  <== implements ==   |                                          |
|   PaymentRepositoryPort, SubscriptionPort,   |                      |   persistence/ (TypeORM repositories)    |
| DisputePort, PSPAdapterPort, CachePort, ...  |                      | psp/ (StripePSPAdapter, AdyenPSPAdapter) |
|                                              |                      |   cache/, circuit-breaker/, fx/, bank/   |
+----------------------------------------------+                      +------------------------------------------+
                               | depends on
                               v
+----------------------------------------------+
|        domain/  (zero external deps)         |
|                                              |
|        aggregates/ (PaymentAggregate,        |
|          Subscription, Dispute, ...)         |
|    value-objects/ (Money, Currency, ...)     |
|       services/ (SmartRoutingStrategy)       |
+----------------------------------------------+
```

The dotted arrow (`Adapters -.implements.-> Ports`) is deliberately not a
solid dependency arrow — an adapter *implements* a port's interface, the
port itself never imports or knows about any adapter. Concrete wiring
(`{ provide: PaymentRepositoryPort, useClass: PaymentTypeOrmRepository }`)
happens once, in `payment.module.ts`; nothing above the ports layer ever
names a concrete adapter class.

## Why two auth-adjacent modules (`shared/auth` vs `modules/merchant`)

`shared/auth/auth.module.ts` owns the mechanics of JWTs — signing
configuration, the Passport strategy, revocation checks. It has no idea what
a "merchant" is.

`modules/merchant` owns the *business* concept of a tenant: credentials,
onboarding, rotation, deactivation. It imports `AuthModule` to sign/verify
tokens.

`modules/payment` also imports both `AuthModule` (its guards need to verify
tokens) and `MerchantModule` (`HmacSignatureGuard` needs to look up a
merchant's HMAC key). This shape — `AuthModule` as a dependency-free leaf,
`MerchantModule` depending on it, `PaymentModule` depending on both — exists
specifically to avoid a cycle: if `MerchantModule` needed something from
`PaymentModule` (it doesn't) while `PaymentModule` needs `MerchantModule`
(it does, for HMAC lookups), that would be circular. Keep it this way when
adding new cross-cutting auth concerns — put them in `AuthModule`, not
directly in `PaymentModule` or `MerchantModule`.

## Design patterns in use

| Pattern | Where | Why |
|---|---|---|
| Hexagonal (Ports & Adapters) | `payment/ports` vs `payment/adapters` | Domain and application logic depend on interfaces (`PSPAdapterPort`, `PaymentRepositoryPort`), never on TypeORM or a specific PSP's SDK directly |
| Factory | `PaymentProcessorFactory` | Selects Stripe vs. Adyen at runtime based on `SmartRoutingStrategy`'s decision, with automatic fallback if the primary PSP fails |
| Saga (orchestration, not choreography) | `PaymentCheckoutSaga` | Multi-step checkout (create intent → risk check → route → charge → confirm) with explicit compensating actions on failure |
| Transactional Outbox | `LedgerOutboxEvent` + `LedgerOutboxRelayService` | Ledger entries are written atomically with the payment state change that confirms them, then relayed asynchronously by a cron job — see `docs/business-domain/ledger-and-settlement.md` for why *when* they're written matters |
| Repository | `PaymentTypeOrmRepository`, `MerchantService` | Isolates persistence details from application services |
| Recurring sweep + on-demand trigger | `LedgerOutboxRelayService`, `ReconciliationService`, `ReserveService`, `SubscriptionService`, `RiskTieringService`, `PayoutService` (payout batching, reserve release, KYC-block recheck, and transfer initiation are each their own sweep), `AmbiguousPaymentService` (auto-resolution and stale-alert sweeps), `AmbiguousRiskMonitoringService` (auto-clear sweep) | Each pairs a `@Cron` schedule with an admin `POST .../run` endpoint doing the exact same work — an operator (or a test) doesn't have to wait for the schedule, and there's exactly one code path to reason about, not two. Every one of these is also individually resilient to a single item's failure (a per-item `try/catch` inside the sweep loop) — one bad subscription/reserve/merchant/payout doesn't abort the whole batch |
| Atomic conditional update (race-safe state transition) | `ReserveHoldPort.markReserveReleased()`, `PayoutPort.markKycCleared()`/`markTransferInitiated()`, `DelegationPort.tryReserveSpend()` | A single `UPDATE ... WHERE <preconditions>` (returning affected-row count, or a computed `RETURNING`) instead of a read-then-write — so two concurrent callers (an operator's manual action racing a scheduled sweep, or two concurrent agent charges against the same delegation) can't both succeed past a limit or double-apply a transition |
| Deterministic idempotency key | `SubscriptionService.periodPaymentId()` (`uuidv5(subscriptionId:periodEnd)`) | Crash-recovery without a distributed transaction — a background job that can't share a DB transaction with `PaymentCheckoutSaga`'s own internal one instead derives a stable id per unit of work, checks whether that id already succeeded before acting, and gets at-most-once behavior from the payment table's own primary-key uniqueness rather than a 2PC/saga-of-sagas |

**A note on shared state**: this API is designed to run as multiple K8s
replicas (`k8s/hpa.yaml` scales to 20 pods), so anything that needs to be
consistent across requests can't live in a plain instance field — it has to
be in Redis (or Postgres). Two things that got this wrong and were fixed:
rate-limit counters (`RedisThrottlerStorage`, replacing `@nestjs/throttler`'s
default in-process `Map`) and PSP circuit-breaker state
(`RedisCircuitBreakerService`, replacing per-adapter instance fields). If
you add a new piece of cross-request state, ask whether it needs to survive
being served by a different pod on the next request — if yes, it needs a
shared backing store, not a class field.

## Request-processing pipeline

For a mutating payment endpoint (`charge`, `refund`, `capture`, `cancel`),
guards run in this order — the order is load-bearing, not incidental:

```
ThrottlerGuard (global, IP-keyed)
  → JwtAuthGuard            # populates req.user
    → RolesGuard            # needs req.user.roles
      → MerchantThrottlerGuard  # needs req.user.merchantId
        → HmacSignatureGuard    # needs req.rawBody (captured in main.ts, before body-parser
                                 # would otherwise consume the stream) + req.user.merchantId
          → IdempotencyInterceptor  # wraps the handler; needs Idempotency-Key header
```

If you add a new guard that depends on `req.user`, it must be listed *after*
`JwtAuthGuard` in the controller's `@UseGuards(...)` array — Nest runs
guards in array order, and `req.user` doesn't exist until `JwtAuthGuard` has
run.

`HmacSignatureGuard` is itself an example of depending on `req.user`, not
just `req.rawBody`: it short-circuits to `true` for an `AGENT`-role caller
(a `Delegation`'s token — see `docs/business-domain/future-directions.md#agentic-payments`)
without checking any of the `X-Signature`/`X-Timestamp`/`X-Merchant-Id`
headers at all. An agent never holds the merchant's own HMAC secret, so
requiring one would be unsatisfiable, not just inconvenient.

## Testing

`npm test` runs unit tests (`src/**/*.spec.ts`) with everything external
mocked. `npm run test:e2e` runs `test/**/*.e2e-spec.ts` against a **real**
app instance (`Test.createTestingModule` + real Postgres/Redis + the
`mock-psp` service from `docker-compose.yml`), via `supertest` — no mocked
providers. This is deliberate: idempotency, HMAC/webhook signature
verification, ledger booking timing, JWT revocation, and per-merchant rate
limiting are all the kind of behavior that a mocked-dependency unit test
would happily pass while the real integration is broken (and several of
them, in fact, *were* broken and only surfaced through exactly this kind of
real, end-to-end exercise during this project's development — see
`security-and-compliance.md` and the ledger doc for specifics).

To run it locally:

```bash
docker-compose up -d postgres-master postgres-replica pgbouncer-master pgbouncer-replica redis mock-psp vault
npm run test:e2e
```

`test/setup-env.ts` fills in default connection settings that match
`docker-compose.yml`'s service credentials exactly, so no extra
configuration is needed for that workflow. Every default can be overridden
via real environment variables (e.g. in CI, pointing at service containers
on different hosts/ports). Test files run with `maxWorkers: 1` — each spec
file boots its own full `AppModule` instance against the same shared
Postgres/Redis/Redis-backed rate limiter, and running them concurrently
risks cross-file interference on that shared state (e.g. two files'
merchants racing the same IP-scoped rate-limit bucket); sequential
execution trades a bit of wall-clock time for determinism, which matters
more here. This does mean the *whole* e2e run's request volume shares one
60-second rate-limit window, not one per file — see `test/setup-env.ts`'s
`RATE_LIMIT_MAX` comment for a real instance of this biting a spec file
that had nothing to do with rate limiting.

`test/utils/` has the shared plumbing: `test-app.ts` (bootstrap),
`seed.ts` (merchant creation + login through the real `/auth/token`
endpoint, not a hand-minted JWT), `signing.ts` (HMAC/webhook signature
helpers matching exactly what the guards being tested verify).

## Where to look next

- [`security-and-compliance.md`](./security-and-compliance.md) — JWT
  revocation design/trade-offs, PCI DSS scope and gaps
- [`../business-domain/payment-lifecycle.md`](../business-domain/payment-lifecycle.md) —
  the payment state machine and how charge/refund/capture/cancel/webhooks
  move a payment through it
- [`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md) —
  double-entry bookkeeping model, smart routing/fee logic, FX conversion,
  merchant reserves, automatic risk-tier adjustment
- [`../business-domain/subscriptions.md`](../business-domain/subscriptions.md) —
  the subscription state machine, billing/dunning/crash-recovery design,
  and what's deliberately simplified
- [`database-migrations.md`](./database-migrations.md) — the migration
  workflow, and why every entity has to be registered in both
  `app.module.ts` *and* `database/data-source.ts`
- [`databases/`](./databases/) — the ERD, table-by-table schema
  reference, and the physical database architecture (master/replica
  replication, PgBouncer pooling, `payments`/`ledger_outbox`
  partitioning, the `archive` schema)
- [`jobs.md`](./jobs.md) — architecture of the standalone-script jobs
  under `src/jobs/` (archiving, deletion, partition maintenance,
  cutover cleanup): why they run as k8s `CronJob`/`Job` resources
  outside the Nest DI container instead of `@Cron()` methods, and the
  `BackupStorage` factory pattern
- [`clouds/`](./clouds/) — the pluggable AWS S3/GCS/Azure Blob
  `BackupStorage` adapters the deletion job can write to
- [`ci-cd.md`](./ci-cd.md) — what the GitHub Actions workflows actually
  run, the known flaky-test classes on top of the ones described above,
  and two real CI incidents worth reading before touching either
  workflow file or `test/jest-e2e.json`
- [`incident-response.md`](./incident-response.md) — what each Prometheus
  alert in [`monitoring/alert.rules.yml`](../../monitoring/alert.rules.yml)
  means and the admin endpoint/service method that actually addresses it
