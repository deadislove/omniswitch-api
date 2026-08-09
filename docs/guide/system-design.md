# System Design

This is the "how is this actually built" companion to
[`business-domain-guide.md`](./business-domain-guide.md) (the "what does
it do and why" one). Read that first if you haven't — this document
assumes you already know what a `Payment`, `Subscription`, or
`Delegation` *is* and focuses on how the code is organized, how a
request actually flows through it, and what to do (and check) when you
change something.

For the most detailed, code-adjacent version of some of this (module
tree with inline comments, design-pattern table, request pipeline), see
[`../technical/architecture.md`](../technical/architecture.md) — this
document is the narrative walkthrough; that one is the reference you'll
come back to.

---

## 1. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript, Node.js 20 | |
| Framework | NestJS 10 | DI container, decorators, module system |
| Database | PostgreSQL 16 | Master + read replica (`@nestjs/typeorm`'s `replication` config) |
| ORM | TypeORM 0.3 | `synchronize: false` everywhere — migrations are the only source of schema truth |
| Cache / distributed state | Redis (`ioredis`) | Idempotency locks, rate-limit counters, circuit-breaker state, JWT revocation lists |
| Secrets | HashiCorp Vault (Transit engine) | Envelope-encrypts `hmac_secret`/TOTP secrets at rest |
| Auth | `@nestjs/passport` + `passport-jwt`, HS256 | Stateless JWT + a Redis-backed revocation list on top (see §5) |
| Observability | `prom-client` (`/metrics`), Winston (structured JSON logs), `@nestjs/terminus` (`/health`) | |
| PSPs | Stripe SDK (`stripe` npm package) + a hand-rolled Adyen HTTP client | Both talk to a local mock server in dev/test, not the real APIs |
| Testing | Jest (unit, mocked deps) + Jest/supertest (e2e, real Docker infra) | See §7 |

Nothing here is exotic on purpose — this is meant to read like a
production payment service's actual stack, not a showcase of unusual
tech choices.

## 2. Architectural style: Hexagonal (Ports & Adapters) + DDD

The organizing idea: **domain logic never imports infrastructure.** A
`Payment`, `Subscription`, or `Delegation` aggregate is plain TypeScript
— no TypeORM decorators, no HTTP concerns, no knowledge that Postgres or
Stripe exist. Everything the domain needs from the outside world is
expressed as an abstract class ("port"), and a concrete "adapter"
implements it:

```
domain/aggregates/subscription.aggregate.ts     <- pure business logic
        ↑ depends on (via constructor injection)
ports/outbound/subscription.port.ts              <- abstract class, no implementation
        ↑ implemented by
adapters/persistence/repositories/subscription-typeorm.repository.ts   <- TypeORM, knows about Postgres
```

The concrete wiring (`{ provide: SubscriptionPort, useClass:
SubscriptionTypeOrmRepository }`) happens once, in the module file
(`payment.module.ts`). Everything else — services, sagas, controllers —
only ever depends on the abstract port.

**Why this matters day to day**: if you're writing a unit test, you mock
the port, not a database. If you're adding a new PSP, you implement
`PSPAdapterPort` and nothing above it changes. If you're wondering "is
this a business rule or plumbing," ask whether it belongs in `domain/`
(rule) or `adapters/`/`application/services/` (plumbing) — that
distinction is enforced by the folder structure, not just convention.

### The module split

Two Nest modules own almost everything:

- **`modules/merchant/`** — tenant identity: credentials, MFA, admin
  CRUD, login, KYC submission. Owns `MerchantEntity` — the single
  richest row-per-tenant config object in the system (see the business
  guide's §1).
- **`modules/payment/`** — everything that moves money or is downstream
  of a charge: payments, subscriptions, plans, disputes, reserves,
  marketplace payouts, risk tiering, reconciliation, agentic-payment
  delegations. These all live in *one* module rather than being split
  further, because they all depend on the same core primitives
  (`PaymentProcessorFactory`, `LedgerOutboxPort`, `PaymentCheckoutSaga`)
  — splitting them would just mean passing those same dependencies
  across module boundaries for no isolation benefit.

A third, deliberately tiny module (`shared/auth/`) holds JWT
signing/verification and revocation — factored out specifically to avoid
a circular dependency (`MerchantModule` needs to sign tokens,
`PaymentModule`'s guards need to verify them, and `PaymentModule` also
needs `MerchantModule` for HMAC key lookups — `AuthModule` sits
underneath both).

### Inside `modules/payment/`, top to bottom

```
domain/            <- aggregates, value objects, domain events. Zero external deps.
ports/outbound/     <- abstract classes the domain/application layer depends on
adapters/           <- concrete implementations of those ports (TypeORM, Redis, PSP HTTP clients)
application/
  controllers/      <- HTTP layer only: parse request, call a service/saga, shape the response
  sagas/            <- PaymentCheckoutSaga — the only code path that calls a PSP to charge money
  services/          <- orchestration: AcquirerRoutingService, SubscriptionService, DisputeService, ...
  interceptors/      <- IdempotencyInterceptor
  dto/               <- request/response shapes + class-validator rules
```

If you're adding a new feature that needs its own aggregate (the last
one added was `Delegation`, for agentic payments), you'll touch all
three of `domain/aggregates/`, `ports/outbound/`, and
`adapters/persistence/` — plus register the new entity in **three
places** (see §6's migration checklist; forgetting one is the single
most common mistake made building this system).

## 3. A charge, end to end

This is the shape every money-moving feature in this codebase reuses
(subscription billing, proration charges) — worth internalizing once:

```
POST /payments/charge
  → JwtAuthGuard (populates req.user)
    → RolesGuard (checks @Roles() against req.user.roles)
      → MerchantThrottlerGuard (per-merchant rate limit, keyed by req.user.merchantId)
        → HmacSignatureGuard (verifies X-Signature against the raw request body;
                               short-circuits for an AGENT-role caller — see business guide §10)
          → IdempotencyInterceptor (Redis SETNX lock on the Idempotency-Key header)
            → PaymentController.charge()
              → [if AGENT] DelegationService.reserveSpendOrThrow() — atomic spend-policy check+reserve
              → PaymentCheckoutSaga.execute()
                  1. Create Payment intent (PENDING) — no ledger entry yet
                  2. ChargeLedgerParamsResolverService.resolve() — fee/FX/reserve/split params,
                     validated now, before any money moves (an invalid split must fail here,
                     not after a real charge already succeeded)
                  3. Risk score computed (stored for audit; doesn't gate anything)
                  4. AcquirerRoutingService picks a PSP (BIN + amount + live health)
                  5. Adapter calls the PSP — a thrown error retries the other PSP;
                     a normal decline response does not
                  6. On success: Payment marked SUCCEEDED + ledger outbox entry written,
                     atomically, in one DB transaction
              → [if AGENT and the charge failed] DelegationService.releaseReservation()
```

The guard order in step 1 is load-bearing, not incidental — each guard
depends on state the previous one populated (`req.user`, then
`req.user.merchantId`). If you add a new guard that reads `req.user`, it
must go after `JwtAuthGuard` in the `@UseGuards()` array.

## 4. Other core flows worth knowing before you touch them

- **Subscription billing sweep** (`SubscriptionService.runBillingSweep()`,
  daily `@Cron` + `POST /admin/subscriptions/run-billing`): for every
  subscription whose `currentPeriodEnd` has passed, checks a
  deterministic payment id (`uuidv5(subscriptionId:periodEnd)`) for
  crash-recovery, then calls the *same* `PaymentCheckoutSaga` a manual
  charge does.
- **Webhook processing** (`WebhookProcessingService`): Stripe/Adyen
  signature-verified callbacks resolve 3DS challenges, delayed
  authorizations, refund completions, and disputes. This is the
  *only* way a `Dispute` is ever created — there's no API to create one
  directly, matching reality (a chargeback is initiated bank-side).
- **The ledger outbox relay** (`LedgerOutboxRelayService`, every 10
  seconds): picks up to 50 `PENDING` outbox events, "publishes" them (an
  in-process `EventEmitter2` emit here — the seam where a real deployment
  would push to Kafka/SNS instead), and marks them `PUBLISHED`. A publish
  failure sets a *terminal* `FAILED` status (not auto-retried) — an
  operator resets it via `POST /admin/outbox/:id/retry`, deliberately,
  so a systemic downstream outage doesn't retry-storm forever.
- **Marketplace payout sweep** (`PayoutService`, three independent
  `@Cron` sweeps): batches split proceeds into `Payout` records with a
  rolling reserve, separately rechecks KYC-blocked payouts as merchants
  get verified, separately initiates bank transfers for eligible ones.
  Three sweeps, not one, because each concern (batching, KYC, transfer)
  can become eligible at a different time from the others.

## 5. Cross-cutting infrastructure concerns

### Multi-replica state

This API is designed to run as multiple K8s pods (`k8s/hpa.yaml` scales
to 20). **Anything that needs to be consistent across requests can't
live in a plain class field** — it has to be in Redis or Postgres. Two
things got this wrong during development and were fixed: rate-limit
counters (now `RedisThrottlerStorage`, replacing `@nestjs/throttler`'s
default in-process `Map`) and PSP circuit-breaker state (now
`RedisCircuitBreakerService`, replacing per-adapter instance fields).
**If you add new cross-request state, ask whether a different pod
serving the next request needs to see it — if yes, it needs a shared
backing store.** See
[`../technical/distributed-state.md`](../technical/distributed-state.md)
for the debugging story behind this rule, and a real, still-open gap:
`@Cron` jobs currently run *per replica*, not once per cluster.

### JWT authentication + revocation

A JWT is stateless by design (no DB round-trip to verify one) — which
normally means a token is valid until it naturally expires, full stop.
This system adds two Redis-backed revocation lists checked on *every*
authenticated request (`JwtStrategy.validate()`): a single-token list
(`POST /auth/revoke`, logout) and a merchant-wide list (deactivation,
credential rotation, "log out everywhere" — anything issued before a
timestamp is dead). Agentic-payment delegation tokens (`UserRole.AGENT`)
are ordinary JWTs sharing this exact same mechanism — no separate
revocation system was built for them. Trade-off you should know before
relying on this: Redis becomes a hard dependency for *authentication*,
not just idempotency, and the implementation fails **closed** (Redis
down → auth fails, not "assume nothing's revoked"). Full detail:
[`../technical/security-and-compliance.md`](../technical/security-and-compliance.md#jwt-revocation).

### Secrets

`hmac_secret` is envelope-encrypted via Vault's Transit engine — the
database only ever stores ciphertext, and the app holds plaintext
briefly, in memory, only at creation/rotation/verification time. The
`docker-compose.yml` Vault is dev-mode (in-memory, static root token) —
explicitly not production-ready as deployed here; see
[`../technical/secret-management.md`](../technical/secret-management.md)
for the migration path to a real deployment.

### Idempotency

Every mutating payment endpoint requires an `Idempotency-Key` header,
enforced by `IdempotencyInterceptor` via a Redis `SETNX` lock — a
retried request (client timeout, network blip) replays the original
result instead of double-charging. This is unrelated to, and layered
on top of, the deterministic-id crash-recovery mechanism subscriptions
use (§4) — idempotency handles "the same client request arrived twice,"
crash-recovery handles "our own process died mid-operation."

## 6. Making a change safely: the checklist

**Adding a new field to an existing aggregate/entity:**
1. Add the field to the domain aggregate (constructor + a getter;
   business rules about it belong here).
2. Add the column to the corresponding TypeORM entity
   (`adapters/persistence/entities/*.entity.ts`).
3. Update the repository's `save()`/`toDomain()` mapping.
4. Generate a migration: `npx ts-node -r tsconfig-paths/register -r
   ./test/setup-env.ts ./node_modules/typeorm/cli.js -d
   src/database/data-source.ts migration:generate
   src/database/migrations/YourMigrationName` (needs the Docker Postgres
   running). **Read the generated SQL** before applying it — don't trust
   it blindly.
5. Run it (`migration:run`), then re-run `migration:generate` once more
   — "no changes found" confirms zero drift between your entities and
   the actual schema.

**Adding a brand-new aggregate (a new domain concept, like `Delegation`
was):** all of the above, plus — and this is the single most common
mistake made building this codebase — **register the new TypeORM entity
in three places**, not just the owning module:
1. The module's own `TypeOrmModule.forFeature([...])`
   (`payment.module.ts` or `merchant.module.ts`).
2. `app.module.ts`'s `entities: [...]` array (the runtime
   `TypeOrmModule.forRootAsync()` config).
3. `src/database/data-source.ts`'s `entities: [...]` array (the
   *separate* plain `DataSource` the migration CLI uses — it has no
   access to Nest's DI container, so it needs its own list). Miss this
   one and `migration:generate` silently produces an empty migration, as
   if there were no schema change at all.

**Adding a new endpoint that moves money or changes state:**
- Does it need `HmacSignatureGuard` + `IdempotencyInterceptor`? Anything
  that isn't a pure read or a "toggle a policy" admin action should have
  both — look at `PaymentController.charge()`/`:id/refund` for the
  pattern.
- Does the operation need to survive a PSP call failing partway through?
  Resolve/validate everything fallible *before* calling the PSP — there
  is no compensating "undo a completed PSP charge" step anywhere in this
  codebase, so a failure after the charge succeeds is a state you can
  never cleanly walk back from. This is why
  `ChargeLedgerParamsResolverService.resolve()` and
  `DelegationService.reserveSpendOrThrow()` both run *before* the saga's
  PSP call, not after.
- Does two concurrent callers racing the same row matter (a scheduled
  sweep vs. a manual operator action, or two concurrent charges against
  the same spend-limited delegation)? Use an atomic conditional `UPDATE
  ... WHERE <preconditions>` (see `ReserveHoldPort.markReserveReleased()`
  or `DelegationPort.tryReserveSpend()` for the pattern), not a
  read-then-write.

**Before you consider anything done**: write a real e2e test against the
Docker infrastructure (see §7) — this codebase's unit tests mock every
external dependency, so they will not catch a broken migration, a wrong
guard order, or a race condition. Several real bugs in this system's own
history (a duplicated event-emitter registration silently splitting the
app's event bus, a double-booked ledger entry, an `.dockerignore` gap
that shipped an empty `dist/`) were only ever caught by a real,
unmocked e2e run — see [`DEV_README.md`](../../DEV_README.md) for the
specific stories.

## 7. Testing strategy

Two distinct suites, and they test different things on purpose:

- **`npm test`** (`src/**/*.spec.ts`) — unit tests, every external
  dependency mocked. Fast, tests business-logic correctness in
  isolation (does `Money.multiply()` round correctly, does
  `Subscription.recordFailedCharge()` classify a decline code right).
- **`npm run test:e2e`** (`test/**/*.e2e-spec.ts`) — the real app,
  booted against real Postgres/Redis/Vault/a mock PSP server via Docker
  Compose, driven through `supertest`. No mocked providers anywhere.
  This is what actually proves a feature works — idempotency, HMAC
  signature verification, ledger booking timing, JWT revocation, and
  race conditions are exactly the kind of thing a mocked unit test would
  happily pass while the real integration is broken.

To run the e2e suite locally: `docker-compose up -d postgres-master
postgres-replica redis mock-psp vault`, then `npm run test:e2e`.
`maxWorkers: 1` is deliberate — every spec file boots its own full
`AppModule` against the *same* shared Postgres/Redis, and running files
concurrently risks cross-file interference on that shared state (two
files' merchants racing the same rate-limit bucket, for instance).

A handful of tests are **known to be flaky at full-suite scale** (a
heap-threshold health check, an outbox-relay timing race, an occasional
rate-limit burst) — each reconfirmed clean when run in isolation
repeatedly. If you see one of these fail, re-run the specific file in
isolation before assuming you broke something; see
[`../technical/architecture.md#testing`](../technical/architecture.md#testing)
for more.

## 8. Infrastructure map (what's actually running)

`docker-compose.yml` brings up, for local dev/test:

| Service | Role |
|---|---|
| `postgres-master` / `postgres-replica` | Real streaming replication — `TypeOrmModule`'s `replication` config sends writes to master, reads to the replica |
| `redis` | Idempotency locks, rate-limit counters, circuit-breaker state, JWT revocation lists |
| `vault` | Transit engine, envelope-encrypts secrets at rest (dev-mode — see §5) |
| `mock-psp` | A Node HTTP server mimicking Stripe's and Adyen's real API shapes (`/v1/...`, `/adyen/...`) plus side endpoints for FX rates, KYC review, and bank transfers |
| `api` | The app itself, built from the production `Dockerfile` |

`k8s/` has the corresponding production manifests
(`deployment.yaml`/`service.yaml`/`hpa.yaml`/`ingress.yaml`/`configmap.yaml`/`secret.yaml`)
— see
[`../technical/infra-verification-status.md`](../technical/infra-verification-status.md)
for exactly what's been proven to work here versus what's an unverified
assumption before you trust a green e2e run more than it's earned.

## Where to go next

- The actual HTTP surface (every endpoint, request/response shape,
  error codes): [`api/README.md`](./api/README.md).
- Business reasoning behind any of the above:
  [`business-domain-guide.md`](./business-domain-guide.md).
- The full technical reference this document summarizes:
  [`../technical/architecture.md`](../technical/architecture.md).
