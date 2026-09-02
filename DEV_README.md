# Dev Roadmap

This is the internal, developer-facing companion to `README.md` — what's
actually left before this stops being "a very solid reference architecture"
and starts being "a payment gateway you'd trust with real money," plus
where this could go if AI-agent-initiated payments become a real target.
`README.md` and `docs/` describe what exists and how it works; this file is
about what doesn't exist yet, in priority order, and why.

Cross-reference: [`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md)
already covers the PCI DSS gap list and JWT revocation trade-offs in detail
— not repeated here.

---

## Tier 1 — would block calling this "production-grade"

These aren't nice-to-haves; each one is a way this system currently loses
money, loses data, or can't be operated safely at real scale.

### 1. Database migrations — ✅ resolved
`synchronize` is now `false` unconditionally (was: enabled outside
production, meaning prod alone had no schema-management story and dev/test
could silently diverge from it). Real migrations
(`src/database/migrations/`) now own the schema in every environment, run
automatically by the Docker image's startup command and by the e2e suite's
`pretest:e2e` hook. Full writeup, including a real bug this work surfaced in
`scripts/postgres/init-master.sql`, in
[`docs/technical/database-migrations.md`](docs/technical/database-migrations.md).
Still open: a policy for backward-compatible migrations (old and new app
versions both running during a rolling deploy need the schema to work for
both) hasn't been written down anywhere — worth doing before the first
migration that renames or drops a column.

### 2. Real 3DS / SCA integration — ✅ resolved
`PaymentCheckoutSaga`'s risk-based 3DS branch used to return a placeholder
`https://3ds.omniswitch.io/challenge/...` URL without ever calling a real
PSP, so a payment that entered `REQUIRES_ACTION` this way had no
`pspTransactionId` and could never be resolved by any webhook — a genuine
correctness bug (a payment could get permanently stuck), not just a missing
feature. Fixed by removing the pre-emptive branch entirely: the PSP is now
always actually called, and only *its* response can produce
`REQUIRES_ACTION`, matching how Stripe/Adyen's real SCA engines behave. A
card's issuing country is now forwarded to the PSP as a hint
(`PSPChargeRequest.binCountry`) — informing, not deciding, the PSP's own
challenge decision. `scripts/mock-psp/server.js` was extended to simulate
this realistically (European `binCountry` triggers a challenge, not just the
existing `FORCE_3DS` test marker). Full writeup in
[`docs/business-domain/payment-lifecycle.md`](docs/business-domain/payment-lifecycle.md#fixed-bug-pre-emptive-3ds-used-to-have-no-psp-transaction-id).
Regression-tested in `payment.saga.spec.ts` (asserts the PSP was actually
invoked, not just that the result looked right) and covered by the existing
`test/webhooks.e2e-spec.ts` 3DS flow.

### 3. Reconciliation — ✅ resolved
Nothing used to compare this system's ledger against the PSP's own
settlement reports — without this, a bug in the outbox/ledger logic (like
the double-booking one found and fixed during this project) could silently
misstate the books indefinitely. `ReconciliationService` now runs hourly
per PSP (`@Cron`), diffing our own charged-status payments against Stripe's
balance transactions / Adyen's settlement report for the same window, and
flags three distinct mismatch shapes (`MISSING_AT_PSP`, `AMOUNT_MISMATCH`,
`UNKNOWN_AT_PSP`) rather than a single undifferentiated "doesn't match."
Every run — clean or not — is persisted (`reconciliation_runs`) and
queryable via `ReconciliationAdminController`
(`GET /admin/reconciliation/runs`, `POST /admin/reconciliation/run` for an
on-demand check; ADMIN/OPERATOR only). `scripts/mock-psp/server.js` was
extended with in-memory settlement tracking and Stripe/Adyen-shaped
settlement-report endpoints so this could be verified against something
that behaves like a real PSP, not a hand-rolled stub. Full design in
[`docs/technical/reconciliation.md`](docs/technical/reconciliation.md).

**Verifying this surfaced a real, significant bug unrelated to
reconciliation itself**: TypeORM/`pg` silently serializes a raw `Date`
object bound as a query parameter using the *host machine's local timezone
offset*, not UTC, when the target column is `timestamp without time zone`
(this project's `@CreateDateColumn()` default) — shifting every date-range
comparison by that offset on any non-UTC machine. This affected two
**pre-existing** query sites, not just the new reconciliation query:
`PaymentTypeOrmRepository.findByMerchantId()`'s date filter, and —
significantly — `LedgerOutboxTypeOrmRepository.findStale()`, the cutoff
query behind the outbox dead-letter alerting sweep
(`LedgerOutboxRelayService.detectStaleEvents()`), which was very likely a
silent no-op on any non-UTC host for as long as this bug existed. Fixed by
binding `.toISOString()` strings instead of raw `Date` objects at all three
sites. Full story, including how this was root-caused (ruled out
replication lag first, then reproduced in isolation outside the app),
in `reconciliation.md`.

### 4. Secret management (KMS/Vault) — partially resolved
`hmac_secret` used to be plaintext in Postgres. **Now envelope-encrypted**
via Vault's Transit engine (`VaultTransitService`,
`src/shared/vault/vault-transit.service.ts`) — `merchants` now stores
`hmac_secret_ciphertext`, never plaintext; the app only ever holds
plaintext briefly, in memory, at creation/rotation/verification time. Fails
closed if Vault is unreachable (verified live — see
[`docs/technical/secret-management.md`](docs/technical/secret-management.md)
for the full design, verification, and — importantly — what this doesn't
cover).

Verifying this surfaced two real, unrelated infra bugs, both fixed: **no
`.dockerignore` existed at all**, so `docker build` copied a stale
`dist/`/`tsconfig.tsbuildinfo` into the image and silently produced a
`dist/` with zero `.js` files; and the `vault` service's healthcheck used
`localhost` instead of `127.0.0.1`, reporting `(unhealthy)` for a Vault
that was actually up (same IPv6-vs-IPv4 `localhost` issue as elsewhere in
this project). Full story in `secret-management.md`.

**Still open**: `JWT_SECRET`/`HMAC_SECRET`/DB credentials are still plain
environment variables, manually base64'd into `k8s/secret.yaml` — needs
External Secrets Operator or Sealed Secrets (already noted in README) for
K8s-level secrets specifically; that's a different problem (delivering
config to a container) from what this round solved (protecting a secret
this app generates and stores in its own database). Also still open:
`docker-compose.yml`'s `vault` service is dev-mode only (in-memory
storage, a static root token) — not production-ready as-is, and explicitly
documented as such.

Neither gap has executable, verified code closing it — there's no real
cloud account/Vault cluster/Sealed Secrets controller in this repo's
Docker Compose setup to test either against, unlike everything else
marked ✅ resolved in this document. What exists instead is a concrete,
honestly-labeled example and a written migration path:
[`k8s/external-secrets-example.yaml`](k8s/external-secrets-example.yaml)
(a `SecretStore`/`ExternalSecret` pair syncing into the exact same
`omniswitch-secrets` object `deployment.yaml` already references, so
adopting it needs zero deployment-manifest changes) and
[`docs/technical/secret-management.md`](docs/technical/secret-management.md#migration-path-for-k8s-level-secrets-and-production-vault)'s
"Migration path" section, covering both the K8s-secrets question and the
separate dev-mode-Vault-to-production steps (persistent storage backend,
AppRole/K8s auth instead of a static root token).

### 5. Observability gaps — partially resolved
`k8s/deployment.yaml` had carried `prometheus.io/scrape: "true"` /
`port: "3000"` / `path: "/metrics"` annotations since early scaffolding,
describing an integration that was never built — the same "annotation
promises something that doesn't exist" pattern as the merchant-bootstrap
and outbox-recovery gaps above. **`/metrics` now exists**
(`src/observability/metrics.controller.ts`, `prom-client`): default
Node.js/process metrics, plus PSP circuit breaker state/success
rate/latency (`omniswitch_psp_*`, sourced from `PaymentProcessorFactory`)
and ledger outbox backlog (`omniswitch_ledger_outbox_{pending,failed}_total`)
— all pull-computed at scrape time from existing state, not
manually-incremented counters that could drift from it. Verified live: a
real charge and a simulated dead-lettered outbox event both showed up in a
re-scrape within the same process, not just at startup.

**Payment-volume counters are now covered too**: `omniswitch_payments_total`
(labeled `status`/`provider`) closes the one gap this section originally
called out as needing "instrumenting `PaymentCheckoutSaga` at each
terminal outcome" — implemented instead as a fourth pull-computed gauge
(`PaymentRepositoryPort.countByStatusAndProvider()`, a `GROUP BY status,
pspProvider` query against the `payments` table), deliberately *not* an
in-process `prom-client` Counter incremented from the saga. An in-process
counter would reintroduce exactly the shared-state mistake this codebase
already fixed twice elsewhere (`RedisThrottlerStorage` replacing an
in-process rate-limit `Map`, `RedisCircuitBreakerService` replacing
per-adapter instance fields) — it resets on every pod restart and can't
agree across replicas without its own Redis-backed counter, while the
`payments` table is already the single authoritative source of this
count regardless of which replica scrapes it. Verified with a real
charge and a real PSP decline (`test/observability.e2e-spec.ts`): the
gauge reflects both `SUCCEEDED` and `FAILED` immediately, and increments
by exactly one per additional charge on the same (status, provider) pair.

**Both later addressed, to different degrees of completeness**:

- Distributed tracing: `src/tracing.ts` bootstraps an OpenTelemetry SDK
  (auto-instrumentation for HTTP/`pg`/`ioredis`/`fetch`-via-`undici` —
  the last one matters specifically because `StripePSPAdapter`/
  `AdyenPSPAdapter` call out via the global `fetch()`, not Node's older
  `http`/`https` modules that most instrumentation guides assume), plus
  manual `saga.route`/`saga.charge` spans in
  `payment-checkout.saga.ts` for the cross-step causality auto-
  instrumentation alone wouldn't group meaningfully. Exported via OTLP to
  `docker-compose.yml`'s new `jaeger` service. Deliberately did *not*
  touch `StripePSPAdapter`/`AdyenPSPAdapter`'s own charge/refund/capture/
  cancel methods to add spans there too — undici auto-instrumentation
  already covers the actual `fetch()` call nested correctly under
  `saga.charge`, and manually restructuring four methods' existing
  circuit-breaker try/catch logic per adapter for a marginal naming
  improvement wasn't worth the risk on this specific code path. Not yet
  run against a real charge end-to-end (no Docker daemon in the session
  that wrote this) — verify a trace actually shows up at `:16686` before
  trusting this.
- Centralized logging: [`k8s/log-shipping-example.yaml`](k8s/log-shipping-example.yaml)
  is a Fluent Bit DaemonSet, illustrative only (same posture as
  `k8s/external-secrets-example.yaml` — no real SIEM/Loki/Elasticsearch
  cluster in this repo to verify against). It closes the *centralization*
  half of the Req 10.5 gap; *tamper-evidence* is a property of whatever
  backend it's pointed at, not something this manifest can provide on its
  own — see that file's header and `security-and-compliance.md`.

---

## Tier 2 — real gaps, lower blast radius

### 6. Dispute/chargeback handling is webhook-only — ✅ resolved
`WebhookProcessingService` used to transition a payment to `DISPUTED` on a
PSP webhook and stop there — no API to act on it afterward, no
representment, no dispute-list endpoint, no visible deadline. Fixed with a
new `Dispute` domain concept (`domain/aggregates/dispute.aggregate.ts`),
tracked as its own record (`disputes` table) rather than folded into
`PaymentAggregate`, since a dispute has a lifecycle of its own
(`NEEDS_RESPONSE` → `UNDER_REVIEW` → `WON`/`LOST`, plus a response
deadline) that the payment's state machine has no room to represent.

- **Creation**: `charge.dispute.created` (Stripe) / `NOTIFICATION_OF_CHARGEBACK`
  (Adyen) now creates a `Dispute` record — `respondBy` defaults to 7 days
  out (a documented default; neither PSP's webhook actually supplies a
  deadline, and the mock doesn't either) — alongside the existing
  `PaymentAggregate.markDisputed()` status flip. Idempotent on redelivery,
  keyed by the PSP's own dispute id (`pspDisputeId`), same posture as every
  other webhook handler in this file.
- **Representment**: `POST /admin/disputes/:id/evidence` (ADMIN/OPERATOR)
  now actually calls the PSP (`PSPAdapterPort.submitDisputeEvidence()`,
  newly added to the port — Stripe: `POST /disputes/:id` with
  `evidence[...]` + `submit=true`; Adyen: a defense-document endpoint) and
  only moves the dispute to `UNDER_REVIEW` if the PSP accepts it. Listing
  (`GET /admin/disputes`, filterable by merchant/status) and detail
  (`GET /admin/disputes/:id`) make the response deadline actually visible
  to an operator — the specific gap DEV_README used to call out.
- **Resolution**: the PSP/card network's final decision arrives by a
  *second* webhook, not an operator action — Stripe's `charge.dispute.closed`
  (`status: 'won'|'lost'`), Adyen's `CHARGEBACK` (final debit, LOST) /
  `CHARGEBACK_REVERSED` (WON). `WON` returns the payment to `SUCCEEDED`;
  `LOST` moves it to `REFUNDED` and books a ledger entry via the same
  `createRefundEntries` shape a normal refund uses — a lost chargeback
  claws funds back from the merchant exactly like a refund does, it's just
  not merchant-initiated. `PaymentAggregate.resolveDispute()` records this
  through the existing `refunds[]`/`RefundRecord` mechanism (not a separate
  code path), so `totalRefunded`/`remainingRefundable` stay accurate
  regardless of *why* money left.
- **Notification hook**: still just `logger.warn()`/`logger.error()` at
  creation and resolution — same stand-in posture as
  `ReconciliationService`/`LedgerOutboxRelayService`'s alerting elsewhere in
  this codebase (see those for the "wire to real paging in production"
  caveat). What changed is that the deadline is now a real, queryable field
  or an operator to see, not something that only ever existed as a string
  inside `PaymentDisputedEvent`.

Verified end to end (`test/webhooks.e2e-spec.ts`, 6 new tests, real HTTP
calls into `mock-psp` — not mocked interfaces): a dispute-created webhook
creates exactly one `Dispute` record even when redelivered twice; evidence
submission moves it to `UNDER_REVIEW` and rejects a second submission with
409; a `won` resolution returns the payment to `SUCCEEDED`; a `lost`
resolution moves it to `REFUNDED` and books exactly one additional ledger
entry; and the full Adyen chargeback chain
(`NOTIFICATION_OF_CHARGEBACK` → `CHARGEBACK_REVERSED`) resolves correctly
end to end, including that the dispute's own `pspDisputeId` (not the
original payment's transaction id) is what a resolution webhook has to
match against.

**Found and fixed while touching this area**: `WebhookProcessingService.markSucceeded()`
(the async/3DS-webhook-confirmed charge path) had its own hardcoded
`0.015` platform fee — missed when #8's per-merchant `platformFeeBps` was
wired into the saga and manual-capture paths, since this call site books a
ledger entry too but wasn't part of that pass. Now reads the merchant's
configured rate like the other two sites.

### 7. Partial-capture accounting — ✅ resolved
`POST /:id/capture` used to transition straight to `SUCCEEDED` on *any*
capture call, partial or full — the first capture, however small, silently
and permanently closed off ever capturing the rest of the authorization.
Not just a missing feature: a merchant doing split-shipment billing (charge
what's shipped, not the full order up front) would authorize $100, capture
$30 for the first shipment, and have no way to ever collect the remaining
$70 through this API again.

Fixed with a new `PARTIALLY_CAPTURED` status
(`PaymentAggregate.recordCapture()`, mirroring the existing
`refund()`/`RefundRecord` pattern with a symmetric `CaptureRecord[]`):
capturing less than the remaining authorized amount now moves the payment
to `PARTIALLY_CAPTURED` instead of `SUCCEEDED`, and a further capture call
is accepted from that state — only reaching `SUCCEEDED` once the sum of all
captures equals the original authorized amount. Over-capturing (the sum of
captures exceeding the authorization) is rejected with 409
`CAPTURE_EXCEEDS_AUTHORIZATION` before ever calling the PSP. Omitting
`amount` on a capture call now captures whatever's left, not the full
original amount (which would have over-captured on any call after the
first). `GET /:id` and the capture response now expose `captures`,
`totalCaptured`, `remainingCapturable` — the same shape already used for
refunds.

**Verifying this surfaced a second, real bug it would otherwise have
shipped with**: `ReconciliationService` (#3, above) matched PSP settlement
transactions to payments with a `Map` keyed by `pspTransactionId` — correct
for one-settlement-per-authorization, but multiple partial captures against
one authorization produce multiple settlement records sharing that same
id, and the `Map` silently kept only the last one. A payment captured in
three partial calls (30 + 45 + 25 = 100) would have reconciled against just
the last capture's amount (25), reporting a false `AMOUNT_MISMATCH` on
every genuinely correct multi-capture payment. Fixed by summing settlement
amounts per `pspTransactionId` instead of a 1:1 map
(`reconciliation.service.ts`); `scripts/mock-psp/server.js` was also fixed
to stop deleting its currency-lookup entry after the first capture, which
broke every capture after the first for a given authorization. Verified
live: charged $100 manual-capture, captured 30 + 45 + 25 through three
separate calls (`PARTIALLY_CAPTURED` after the first two, `SUCCEEDED` after
the third), then ran an on-demand reconciliation — `transactionsChecked: 4`
(1 payment + 3 settlement records), `status: CLEAN`, `mismatchCount: 0`.
Regression-tested in `test/payments.e2e-spec.ts` (multi-partial-capture
happy path, over-capture rejection) — full suite (38/38 e2e, 18/18 unit)
still passes.

**Still open**: cancelling a `PARTIALLY_CAPTURED` payment (voiding the
remaining, uncaptured balance after some has already been captured) isn't
implemented — `PARTIALLY_CAPTURED -> CANCELLED` is deliberately not a valid
transition, so it fails loudly (409) rather than silently. Also, refunds
still require the payment to be fully `SUCCEEDED` first; you can't refund
an already-captured partial amount while the rest of the authorization is
still open.

### 8. Fee model — partially resolved
Platform fee used to be hardcoded at 1.5%, identically, with no way to
charge one merchant a different rate than another. Fixed with a
per-merchant `platformFeeBps` column on `MerchantEntity` (basis points —
150 = 1.5%, avoiding the "is 1.5 already a fraction or a percent"
ambiguity a float field would invite at every call site that reads it),
defaulting to 150 so every existing merchant sees no behavior change. Every
ledger-booking call site now looks the rate up via
`MerchantService.findByMerchantId()` instead of a literal `0.015` —
initially just `PaymentCheckoutSaga` and `PaymentLifecycleService.capture()`;
a third site, `WebhookProcessingService.markSucceeded()` (the async/3DS
webhook-confirmed charge path), was missed in this round and only found
and fixed while building #6 below — see that entry. Admin-editable via
`PATCH /admin/merchants/:id/fee-rate` (ADMIN only) and settable at
onboarding via an optional `platformFeeBps` on `POST /admin/merchants`.
Verified end to end: a merchant seeded with 500bps (5%) charges $100 and
the ledger's `FEE` entry books exactly $5.00, not the default $1.50
(`test/ledger-and-outbox.e2e-spec.ts`); the admin endpoint is RBAC-tested
(ADMIN can change it, a merchant caller gets 403) and range-validated
(0–10,000bps; out-of-range is rejected with 422, not clamped).

**Tiered/volume-based pricing is now real too**: `MerchantEntity.feeTiers`
— an optional, ascending `{ minVolumeMinorUnits, bps }[]` schedule,
settable via `PATCH /admin/merchants/:id/fee-tiers` (an empty array
clears it back to the flat `platformFeeBps` rate) — supersedes the flat
rate once this merchant's trailing *current-calendar-month* `SUCCEEDED`
volume, in the same currency as the charge being priced, reaches a
tier's threshold. Implemented as one addition to the already-shared
`ChargeLedgerParamsResolverService.resolve()` (a new
`PaymentRepositoryPort.sumSucceededVolumeSince()` query), so it
automatically applies to all three ledger-booking call sites at once —
no repeat of the "third call site missed" bug above, since there's only
one fee-resolution code path left to instrument. Deliberately priced off
volume *before* the charge being priced (not including it) — the specific
charge that crosses a threshold still bills at the old rate, the next one
gets the new rate — and deliberately per-currency rather than one
blended figure, for the same "no retroactive FX on historical charges"
reason refunds/lost disputes replay their original rate (see
`ledger-and-settlement.md`). Verified end to end
(`test/ledger-and-outbox.e2e-spec.ts`): a charge below the lowest
threshold still uses the flat rate; three charges that cross a
threshold mid-sequence bill at the old rate right up through the one
that crosses it, then the new rate on the next; a EUR charge doesn't
benefit from USD volume crossing the same numeric threshold; clearing
tiers reverts to the flat rate; and non-ascending/duplicate thresholds
are rejected 422 rather than silently sorted.

**Still open**: this platform fee — flat or tiered — is still not
reconciled against actual PSP interchange cost.
`SmartRoutingStrategy.calculateFee()` separately *estimates* PSP fees for
routing/display purposes (`estimatedFee` in charge responses), and that
number remains completely disconnected from what's actually booked to the
ledger via `platformFeeBps`/`feeTiers`. If the platform fee is meant to
be "PSP cost plus margin," that calculation still doesn't exist — making
the platform-side rate configurable (and now volume-tiered) didn't
connect it to real PSP cost data, which this project has no source for
in the first place (the mock PSP doesn't simulate interchange costs).

### 9. Circuit breaker / health metrics are unbounded cumulative counters — ✅ resolved
`successCount`/`totalRequests`/`totalLatencyMs` used to accumulate for as
long as the Redis keys lived, not a sliding window — a bad incident from
months ago would stay baked into the reported success rate forever. Fixed
by bucketing `recordSuccess`/`recordFailure` writes into per-minute Redis
keys (`circuit:{provider}:bucket:{epochMinute}:{success|total|latencyMs}`)
and having `getMetrics()` sum the last 15 one-minute buckets instead of one
all-time counter — same fixed-window trade-off already used for rate
limiting (see `docs/technical/distributed-state.md`), applied here for
consistency rather than reaching for a sorted-set sliding log.
`failureCount` (the OPEN-trip trigger) was deliberately left as-is — it
already resets on `HALF_OPEN` → `CLOSED` recovery, a separate,
already-correct mechanism this item was never actually about.

Verified live: a fresh in-window bucket and a fake 20-minutes-old
out-of-window bucket (with deliberately bad numbers — `total: 9999`) were
written directly into Redis; `/metrics` reflected only the in-window data
(if the old bucket had counted, the reported success rate would have
collapsed to ~0%; it stayed at the correct value instead). A real charge
was also made through the running app to confirm `recordSuccess` writes to
the *current* bucket correctly, not just that manually-injected data reads
back. Verifying this also surfaced a real, unrelated infrastructure bug —
see [`docs/technical/infra-verification-status.md`](docs/technical/infra-verification-status.md)
for the Redis port collision it led to finding and fixing.

### 10. Outbox dead-letter recovery is manual — ✅ resolved
A `FAILED` ledger outbox event (see `LedgerOutboxPort.markFailed`) doesn't
auto-retry — by design, to avoid silently retrying forever — but there used
to be no operator-facing way to inspect or reset one back to `PENDING`
short of a manual SQL update. Same category of gap as #12's merchant
bootstrap. Fixed with `OutboxAdminController`
(`GET /admin/outbox/failed`, `POST /admin/outbox/:id/retry`, ADMIN/OPERATOR
roles) backed by `OutboxRecoveryService` — the retry is an atomic
conditional update (only succeeds if the event is currently `FAILED`, so two
operators retrying the same event can't race each other), and it's purely a
delivery-status reset, not a correction of the underlying ledger entries
(those stay immutable once double-entry-validated). Verified end to end in
`test/ledger-and-outbox.e2e-spec.ts`: a real dead-lettered event is listed,
a non-admin is rejected with 403, retry resets it to `PENDING`, a second
retry on the now-non-`FAILED` event is rejected with 409, and the relay's
next tick actually publishes it — not just a status flip.

### 11. No load testing baseline — ✅ resolved
Nothing in this repo used to establish what "normal" throughput/latency
looks like, so there was no way to tell if a future change regressed
performance, and no evidence for the K8s HPA thresholds (`k8s/hpa.yaml`'s
70% CPU / 80% memory targets were reasonable-looking defaults, not
measured). Fixed with real Artillery-driven load tests
(`scripts/load-test/`) against the actual production Docker image,
resource-capped to match `k8s/deployment.yaml`'s limits (1 CPU / 512Mi) so
`docker stats` readings are directly comparable to what one pod is capped
at in the cluster manifest.

**Read-path capacity** (the clean result): 16,900/16,900 requests
succeeded — zero failures — sustained at up to 150 req/s, p50=3ms,
p95=7.9ms, p99=25.8ms. CPU steady-state ran ~140% of the deployment's
250m *request* (peak ~250%) — meaning HPA's 70% CPU target would trigger
scale-out well before a single pod gets anywhere near this throughput.
Memory stayed at ~43–50% of the 256Mi request even at peak — nowhere near
the 80% memory trigger. **Conclusion**: for read-heavy traffic, CPU is a
genuinely conservative, early HPA trigger relative to per-pod throughput;
memory would essentially never be the thing that actually triggers a
scale-out. This is real, previously-nonexistent evidence for a question
this file has been flagging since Tier 2 was first written.

**A real, non-obvious finding surfaced getting there**: a single-machine
load generator hitting the charge endpoint can't measure this app's own
processing ceiling at all — `PaymentController.charge()` carries a
hardcoded, route-level `@Throttle({ limit: 100, ttl: 60000 })` that both
the global IP-scoped guard and `MerchantThrottlerGuard` pick up (they
check the same throttler name), and since a single-machine test is
structurally always one source IP, that guard's IP-scoped copy binds
regardless of how many distinct merchant identities the traffic is spread
across — confirmed by seeding 1, then 20, then 200 merchants and getting
the *same* ~400 successful charges each time. Not a bug — this is
precisely the anti-abuse behavior a single IP firing many charges across
many merchant identities should trigger — but it means a real charge-path
capacity number needs a distributed load generator (many source IPs), out
of scope here. Full story, including how each rate-limiting layer was
isolated, in
[`docs/technical/load-testing.md`](docs/technical/load-testing.md).

### 12. No merchant bootstrap path — ✅ resolved
`POST /admin/merchants` requires an existing ADMIN JWT, which meant there
was no way to create the *first* merchant on a brand-new deployment without
already having admin credentials (previously worked around with a raw SQL
insert while verifying the Docker image — see
[`docs/technical/infra-verification-status.md`](docs/technical/infra-verification-status.md)).
Fixed with `npm run seed:admin` (`src/database/seed-admin.ts`) — an
explicit, idempotent CLI command (not wired into automatic container
startup the way migrations are, since issuing a credential is a
meaningfully different kind of action than an idempotent schema change; see
the script's own comments for why). Verified end to end: run against a
genuinely fresh, migrated database, it printed a real credential; that
credential logged in and successfully onboarded a second merchant through
`POST /admin/merchants` — the exact loop that was previously broken.

---

## Tier 3 — worth doing, not urgent

### MFA (TOTP) for merchant login — ✅ resolved
PCI DSS Req 8.4.2 (multi-factor authentication) used to be "not implemented
anywhere" — login was API Key ID + Secret → JWT, full stop. Fixed with
opt-in TOTP: `POST /auth/mfa/enroll` generates a secret (not yet
enforced), `POST /auth/mfa/confirm` proves the merchant captured it
correctly and turns enforcement on, returning 10 one-time backup codes.
Once enabled, `POST /auth/token` stops returning a directly-usable
token for that merchant — it returns a short-lived (5 min), restricted
one (`mfaPending: true` in the JWT) that `JwtAuthGuard` rejects on every
route except the new `POST /auth/mfa/verify`, which trades a valid
TOTP/backup code for a normal, full JWT. `POST /auth/mfa/disable`
requires a valid code too, so a stolen JWT alone can't silently turn MFA
back off.

The TOTP secret is envelope-encrypted via the same `VaultTransitService`
`hmac_secret_ciphertext` already uses (see
[`secret-management.md`](docs/technical/secret-management.md)) — reusing
that key rather than adding a second one, since Vault Transit encryption
doesn't care what plaintext it's given. Backup codes are bcrypt-hashed,
same posture as `apiKeySecretHash`, and single-use — consumed (removed
from storage) the moment one succeeds, not just checked.

**Opt-in for MERCHANT/OPERATOR/READONLY, mandatory for ADMIN**: this
closes the "not implemented anywhere" half of the PCI gap — the
capability genuinely exists and works — and a later pass closed the
other half: `RolesGuard` now rejects any request from an ADMIN-role
caller whose merchant doesn't have `mfaEnabled`, on every
`@Roles(...)`-gated route (`POST /auth/mfa/enroll`/`confirm` stay
reachable regardless, since neither carries `@Roles()`, so an
ADMIN merchant always has a way to enroll rather than being locked out
with no path back in). See
[`docs/technical/security-and-compliance.md`](docs/technical/security-and-compliance.md)
for what this still doesn't cover.

**A real dependency issue found along the way**: `otplib`'s current major
version (v13) rebuilt its crypto internals on `@noble`/`@scure`, which
ship ESM-only — `@scure/base`'s `export const` at the top of the file
broke Jest's CommonJS transform outright (`SyntaxError: Unexpected token
'export'`), failing every e2e suite, not just the new MFA one. Downgraded
to `otplib@12` (the last version with the classic `authenticator`
singleton API and CJS-native dependencies) rather than fighting Jest's
transform config for one package — noted here since "upgrade otplib" is
an obvious-looking dependency bump that would silently reintroduce this.

Verified end to end in `test/mfa.e2e-spec.ts` (7 tests, real TOTP codes
generated the same way an authenticator app would, real Vault
encrypt/decrypt, real Postgres/Redis): wrong code at confirm leaves MFA
off; a correct code enables it and returns real backup codes; login for
an MFA-enabled merchant returns a restricted token; that token is
rejected on an ordinary protected route (`POST /auth/revoke`) with
`MFA_VERIFICATION_REQUIRED`, not silently accepted; a wrong code at
`/auth/mfa/verify` is rejected; a correct one issues a full, working
token; a backup code works exactly once and is rejected on reuse;
disabling MFA rejects a wrong code and requires the real one. Full e2e
suite (53/53) still passes — `JwtAuthGuard`'s change is on the hot path
for every authenticated request in the app, not just MFA-specific routes.

### API versioning cleanup — ✅ resolved
`VersioningType.URI` was enabled in `main.ts`, but every controller
hand-wrote `'api/v1/...'` as its own literal `@Controller()` path string —
the versioning config was decorative, not functional. A real `v2` would
have meant hand-writing `'api/v2/...'` on a new controller with zero help
(or safety) from Nest's versioning system, and nothing would have stopped
someone from typing `'api/v1/...'` on it by mistake.

Fixed by making Nest actually own the prefix/version segments instead of
hand-typed text: `app.setGlobalPrefix('api', {...})` +
`app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`
in `main.ts` (and mirrored in `test/utils/test-app.ts`, which boots the
app the same way for e2e tests). Every controller now declares just its
own resource path (`@Controller('payments')`, not
`@Controller('api/v1/payments')`) — a hypothetical `v2` controller could
now write `@Controller({ path: 'payments', version: '2' })` and Nest would
route it correctly, with the *default* version still applying everywhere
else with zero changes needed.

`HealthController` and `MetricsController` are marked
`@Controller({ version: VERSION_NEUTRAL })` and excluded from the global
`'api'` prefix — `k8s/deployment.yaml`'s probe paths (`/health/live`,
`/health/ready`) and the Prometheus scrape annotation's path (`/metrics`)
are fixed external contracts, not part of this API's own versioned
surface, and would have broken (silently, until the next deploy) had they
picked up `/api/v1/` like everything else.

The resulting URLs are byte-identical to before this change — that was
the point: this is a pure internal-mechanism fix, not a behavior change.
Verified two ways: the entire pre-existing e2e suite (which only ever
calls the resulting `/api/v1/...` URLs) passes unchanged, which by itself
doesn't prove much (it would pass whether Nest generated the prefix or it
was still hardcoded); the real verification was manual, against the
actual built app — confirming `/health`, `/health/live`, `/health/ready`,
`/metrics` all resolve unprefixed while `/api/health`, `/api/v1/health`,
and `/api/metrics` correctly 404 (proving they're genuinely excluded, not
just coincidentally reachable twice), and that a real route 404s without
the `/api/v1` prefix it used to get for free as hardcoded text. New
`test/api-versioning.e2e-spec.ts` (6 tests) turns that manual check into
permanent regression coverage — exactly what this gap's writeup asked
for ("`test/*.e2e-spec.ts` should be extended to cover this if/when it's
fixed"). Full suite: 59/59.

### FX conversion (merchant settlement currency) — ✅ resolved
`Money.convertTo()` used to accept a rate and record a snapshot, but
nothing in the application layer ever called it with a real FX rate
provider — multi-currency settlement wasn't actually wired up end to end.
Fixed with a real (mocked, but real-HTTP) `FXRateProviderPort` — `scripts/mock-psp/server.js`'s
new `/fx/rates` endpoint — and `MerchantEntity.settlementCurrency`: a
merchant can now be paid out in a currency different from whatever
currency a given charge was made in. All three ledger-booking call sites
(`PaymentCheckoutSaga`, `PaymentLifecycleService.capture()`,
`WebhookProcessingService.markSucceeded()`) now convert the merchant's
payout leg when a settlement currency is set and differs from the charge
currency; a failed FX lookup falls back to booking in the original
currency (logged as an error) rather than losing the ledger entry for an
already-confirmed charge. Manage it via `POST /admin/merchants`
(`settlementCurrency`, optional) or `PATCH
/admin/merchants/:id/settlement-currency`. Full design — including why
converting the merchant's payout leg needs two separately-currency-balanced
ledger legs linked by a new `FX_CLEARING` account type, not just a third
entry — in
[`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#fx-conversion-merchant-settlement-currency).

**Two real bugs found verifying the "clear a setting back to null" path**
(both fixed):
1. `merchant.settlementCurrency = undefined` followed by `repository.save()`
   does **not** write SQL `NULL` — TypeORM's `save()` silently omits
   `undefined` properties from the generated `UPDATE`, so the *previous*
   value stayed in Postgres despite the API reporting the field as
   cleared. Caught only because the e2e test asserted against a fresh
   `repository.findOne()` read, not the API response from the same call
   that had just "cleared" it. The identical bug existed in
   `MfaService.disableMfa()` from the MFA round
   (`mfaSecretCiphertext = undefined`) — found and fixed at the same time;
   merchants who'd disabled MFA still had their encrypted TOTP secret
   sitting in the database despite `mfaEnabled: false` correctly gating
   login. Harmless on its own, but real stale-data hygiene "disable"
   should have delivered and didn't.
2. Fixing bug #1 by assigning `null` instead of `undefined` surfaced a
   *second* issue: TypeORM infers a column's SQL type from TypeScript's
   emitted `design:type` reflection metadata, and a `string | null`
   property reflects as bare `Object` — which fails at
   `DataSource.initialize()` with `Data type "Object" ... is not
   supported`, not at compile time, and (in this case) manifested as what
   looked like a hung test process rather than a clear error, which cost
   real time to root-cause. Fixed by adding an explicit `type: 'varchar'`
   to both affected columns (`settlementCurrency`, `mfaSecretCiphertext`).
   Worth remembering for any future nullable string column on this entity.

Verified end to end in `test/fx-conversion.e2e-spec.ts` (7 tests, real
HTTP calls to the mock FX endpoint, real Postgres): a merchant with no
settlement currency keeps booking in the charge currency (default
unchanged); same-currency settlement is a no-op (no `FX_CLEARING` legs);
a genuinely different settlement currency produces both correctly-balanced
ledger legs with the exact expected converted amount, through both the
immediate-charge and manual-capture call sites independently; the admin
create/PATCH/clear flow works and a non-admin is rejected. Full suite
(`npm test` 18/18, `npm run test:e2e` 66/66) still passes.

### OpenAPI/Swagger completeness pass — ✅ resolved
`@nestjs/swagger` was wired up (`/api/docs`) and most request DTOs already
carried `@ApiProperty`, but an audit (`grep -c "@ApiResponse"` across every
controller) turned up **zero** `@ApiResponse` decorators anywhere in the
codebase — every endpoint's success and error response shapes were whatever
Swagger could infer from the handler's return type (usually nothing useful,
since most handlers weren't annotated with an explicit return type either).
A few request DTOs had no `@ApiProperty` at all: `SubmitEvidenceDto` and
`ListDisputesQuery` in the dispute admin controller, `RunReconciliationDto`
in the reconciliation admin controller.

Closed across all 9 controllers: every endpoint now has an explicit
`Promise<ResponseDtoType>` return type and `@ApiResponse({ status, type })`
for its success case, plus `@ApiResponse({ status, description })` for the
non-2xx cases the handler actually throws (404 not found, 409 conflict on a
state-dependent action, 422 PSP-declined, etc.) — not an exhaustive
enumeration of every guard's possible 401/403. Response DTOs were added
where missing (`PaymentDetailResponseDto`, `RefundPaymentResponseDto`,
`CapturePaymentResponseDto`, `CancelPaymentResponseDto`,
`BulkUploadResponseDto` and friends in the payment module;
`MerchantSummaryDto`, `MerchantCreatedResponseDto`,
`RotateApiKeyResponseDto`, `RotateHmacSecretResponseDto`,
`RevokeSessionsResponseDto` for merchant admin; `DisputeSummaryDto`,
`ReconciliationRunSummaryDto`/`ReconciliationMismatchDto`,
`OutboxEventSummaryDto`/`RetryResponseDto` for the smaller admin
controllers; `RevokeTokenResponseDto`/`DisableMfaResponseDto` for the two
auth endpoints that previously returned an untyped inline object). The
health and webhook controllers got a lighter touch — `@ApiResponse`
descriptions without new DTO classes, since Terminus's `HealthCheckResult`
is already a well-known external shape and the k8s-probe/PSP-callback
endpoints aren't really "the API" a client integrates against.

Unlike the previous few rounds this one didn't surface a functional bug —
it was a documentation completeness gap, not a behavioral one. The one
thing worth flagging for later: while auditing `AuthController`'s actual
thrown exceptions to get `@ApiResponse` status codes right, `MfaService`
turned out to throw `409 Conflict` for "wrong state" cases (already
enrolled, no enrollment in progress, MFA not enabled) and `401
Unauthorized` for "wrong code" cases — worth keeping in mind if any of
those call sites change, since a mismatched `@ApiResponse` is worse than
none (it actively misleads an API consumer).

Verified via `npx tsc --noEmit` after every file (all clean), full
`npm test` (18/18) and `npm run test:e2e` (66/66, real Postgres
master/replica, Redis, Vault, mock-psp), and `nest build`. No API
behavior changed — this is decorator-only — so no new e2e spec was
added; correctness was confirmed by the existing suites still passing
unchanged plus manual inspection of `/api/docs-json` for the new schemas.

### Merchant risk tiering & reserves — ✅ resolved
Every merchant used to be treated identically — same fee, same payout
timing, no concept of a risk-based hold. Real processors differentiate: a
higher-risk merchant (new, high chargeback rate, high-risk MCC) typically
has a slice of each charge held back in a rolling reserve for a period
before release, specifically to cover potential future chargebacks. Fixed
with `MerchantEntity.reserveBps`/`reserveHoldDays` (directly configurable
per merchant, same idiom as `platformFeeBps` — not a `riskTier` enum
mapped to a fixed rate table this codebase has no real risk model to
drive) and a new `ReserveHold` domain object tracking each individual
withheld amount's own lifecycle (`HELD` -> `RELEASED`), separate from the
ledger event that created it.

- **Booking**: all three ledger-booking call sites now go through a new
  `ChargeLedgerParamsResolverService` — one merchant lookup feeding the
  platform fee, the optional FX settlement conversion, and now the
  optional reserve hold, extracted out of what had been an identical
  private method copy-pasted into `PaymentCheckoutSaga`,
  `PaymentLifecycleService`, and `WebhookProcessingService` (the third
  copy's own comment already flagged this as a judgment call that
  wouldn't hold past three callers — reserve logic was the trigger).
  `LedgerOutboxEvent.createChargeEntries()` withholds `reserveBps` of the
  *charge-currency* net amount into a per-merchant `RESERVE` ledger entry
  (`{merchantId}_RESERVE`) — carved out before any settlement-currency
  conversion, so it composes with FX conversion without a clearing account
  (the RESERVE entry is just a fourth entry in the same charge-currency
  group, which still balances).
- **Release**: `ReserveService` releases a hold either via a daily
  `@Cron` sweep (every `HELD` hold whose `releaseEligibleAt` has passed)
  or an operator's manual override (`POST
  /admin/reserves/:id/release`, bypasses the eligibility check — e.g. a
  merchant that's since proven low-risk). Both paths book the offsetting
  `LedgerOutboxEvent.createReserveReleaseEntries()` entry (`RESERVE` debit,
  `MERCHANT` credit) atomically with the hold's status flip, in one DB
  transaction — release is always in the currency the hold was withheld
  in, deliberately not re-converted to the merchant's current settlement
  currency (see `ReserveService`'s docblock for why re-running FX at an
  arbitrary later date would mislead more than help). Managed via `PATCH
  /admin/merchants/:id/reserve-policy` and listed/inspected via `GET
  /admin/reserves`.

**A real race condition found verifying the manual-release endpoint**:
`ReserveService.release()` originally re-fetched the hold via
`reserveHoldPort.findById()` after committing the release transaction, to
return its now-current state. That re-fetch reliably came back still
`HELD` — this app's `DataSource` routes plain reads to a Postgres replica
(`app.module.ts`'s `replication` config; see
[`infra-verification-status.md`](docs/technical/infra-verification-status.md)'s
measured ~1s replication lag), and the re-fetch, running microseconds
after the transaction committed to master, lost that race every time.
Fixed by returning the already-mutated in-memory `ReserveHold` aggregate
instead of re-querying — the same "don't re-fetch after your own write"
posture `DisputeService.submitEvidence()`/`MerchantService`'s update
methods already use, which is exactly why this bug was confined to the
one place that didn't follow it.

Verified end to end in `test/reserve.e2e-spec.ts` (9 tests, real Postgres
master/replica): a merchant with no reserve policy books no `RESERVE`
entry and no `ReserveHold` record (unchanged default behavior); a
configured reserve withholds the exact expected minor-unit amount and
records a `HELD` hold with the right `releaseEligibleAt`; a reserve
composed with settlement-currency conversion withholds in the charge
currency while the FX/`MERCHANT` legs correctly use the net-of-reserve
amount; a manual release books the offsetting entry and flips status to
`RELEASED`, confirmed via a fresh, separately-timed DB read (this is what
caught the replica-lag bug above); releasing an already-released hold is
rejected with 409, not double-booked; the release-eligible sweep releases
an elapsed hold and correctly leaves an ineligible one alone; admin
listing/filtering and the non-admin 403 both work. Full suite (`npm test`
18/18, `npm run test:e2e` 75/75) still passes.

**Known remaining gap**: release doesn't re-run FX conversion even if the
merchant now has a settlement currency configured — see
`ReserveService`'s docblock and
[`future-directions.md`](docs/business-domain/future-directions.md#merchant-risk-tiering--reserves)
for why, and how this relates to the same open question already flagged
for refunds/lost disputes under Cross-Border Settlement above.

**Follow-up (same round): the actual risk model.** The paragraph above
used to end here, flagging that this pass built the mechanism a risk
policy would drive, but not the policy itself — no automatic tier
transitions as a merchant's risk profile changes over time. That's now
closed too: `RiskTieringService` recomputes each auto-managed merchant's
trailing 90-day lost-dispute rate (`countByMerchantSince()`, a new
`DisputePort` method — deliberately a true count, not `findMany()`'s
admin-listing `limit`-capped one) and adjusts `reserveBps`/
`reserveHoldDays` to one of three deliberately simple, illustrative
tiers — this is a mechanism demonstration, not a calibrated underwriting
model; see `RiskTieringService`'s docblock for the exact thresholds and
why they're round numbers, not derived from real fraud data.

- **Bidirectional, not just escalation.** Every sweep tick recomputes the
  tier from scratch off the current trailing window — a merchant whose
  dispute rate improves tapers back down automatically, not just up.
- **A manual override sticks.** `MerchantEntity.riskTierAutoManaged`
  (default `true`) gates the sweep; an operator's
  `PATCH .../reserve-policy` call sets it to `false` as a side effect, so
  a hand-tuned reserve doesn't get silently overwritten by the next sweep
  tick — same "manual input pauses automation" posture a thermostat or
  autoscaler uses. `PATCH .../risk-tier-auto` re-enables it.
- **A minimum sample size guards against noise.** Below 10 settled
  charges in the trailing window, a merchant is skipped entirely — one
  dispute out of 3 charges is a 33% "rate" that means nothing.
- **On-demand + scheduled**, same dual shape as `ReconciliationService`/
  `ReserveService`: `POST /admin/risk-tiering/run` alongside the daily
  `@Cron` sweep.

**Two real bugs found building this, both about what actually counts as
"settled volume"**:
1. The denominator was originally just `SUCCEEDED` payments — but a lost
   dispute moves a payment's status to `REFUNDED` (see the Dispute
   resolution flow), which silently *removed* exactly the transactions
   this service most needs to count from its own denominator. A merchant
   with 10 charges and 1 lost dispute would undercount to 9 `SUCCEEDED`
   payments, fall below `MIN_SAMPLE_SIZE`, and never get evaluated at
   all — caught by an e2e test that expected escalation and got a
   skip instead. Fixed by counting the same `chargedStatuses` set
   (`SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`)
   `PaymentTypeOrmRepository.findByProviderAndDateRange()` already uses
   for the identical reason.
2. `PaymentRepositoryPort.count()`'s `FindPaymentsFilter` has advertised
   `fromDate`/`toDate` fields since the interface was written, but the
   concrete implementation's query builder never actually added the
   corresponding `andWhere()` clauses — silently ignored, returning a
   merchant's *entire* history instead of the requested window. Nothing
   called `count()` with a date range before this service, so it never
   produced a visibly wrong result in production — but it would have the
   moment anything did. Fixed alongside the first bug, mirroring
   `findByMerchantId()`'s already-correct handling (including binding
   `.toISOString()`, not a raw `Date`, for the naive-`TIMESTAMP`
   `created_at` column — see `reconciliation.md`'s writeup of the same
   timezone-shift bug class). The new `countByMerchantSince()` on
   `DisputePort` uses the identical `.toISOString()` pattern for the same
   reason.

Verified end to end in `test/risk-tiering.e2e-spec.ts` (5 tests, real
Postgres, real Stripe-webhook-driven dispute resolution): a merchant
below the minimum sample size is skipped, reserve untouched; a merchant
with a 10% trailing lost-dispute rate (1 of 10 settled charges) is
escalated to the `HIGH` tier; a manual reserve-policy change disables
auto-management and the sweep leaves it alone even with a high dispute
rate, until `risk-tier-auto` re-enables it; a merchant's reserve is
proven to taper back down to `LOW` once its one lost dispute is pushed
(via a direct DB write) outside the 90-day trailing window — proving the
adjustment genuinely runs in both directions, not just escalation; and
the non-admin 403. Full suite (`npm test` 18/18, `npm run test:e2e`
90/90) still passes.

**A test-infrastructure adjustment, not a product bug**: adding this
suite (plus the subscriptions and reserve-hold suites from the same
round) pushed the full e2e run's cumulative `POST /payments/charge`
volume within one IP-scoped 60-second rate-limit window high enough to
start 429-ing *unrelated* later spec files — the whole suite finishes in
well under 60s, so every file's charge calls share one bucket, not one
per file. Fixed by raising `test/setup-env.ts`'s `RATE_LIMIT_MAX`
default, same reasoning already applied to `AUTH_LOGIN_RATE_LIMIT` there
("a full e2e run legitimately does more of this than any single
production client would in 60s").

**A newly-observed, non-reproducible-in-isolation flake, logged
here for the same reason the other two are**: roughly 1 in 3 full
`npm run test:e2e` runs now shows a single spurious 401 on an
otherwise-valid, freshly-issued admin JWT, at a different admin
endpoint/spec file each time — never in isolation, and with no
corresponding warning/error logged anywhere (`JwtAuthGuard`'s own
failure log never fires, `TokenRevocationService`'s Redis client never
logs an error). Investigated but not root-caused: this suite now boots
11 separate NestJS application instances sequentially in one Jest
process (`maxWorkers: 1`), one per spec file, and the timing/pattern
points at that scale — not at anything in this round's business logic,
which is proven correct via the direct-DB-read assertions throughout
this suite and passes 100% reliably in isolation. Filed here as a known
flake in the same class as the pre-existing heap-threshold
(`api-versioning.e2e-spec.ts`) and outbox-relay-timing
(`ledger-and-outbox.e2e-spec.ts`) ones — a full-suite-scale test
infrastructure fragility, not something to chase down inside a feature
round.

### Recurring billing / subscriptions — ✅ resolved
Everything in this codebase used to model a single, one-time charge.
Fixed with a new `Subscription` aggregate — genuinely distinct from
`PaymentAggregate`, since a subscription *produces* charges over time
rather than being one — with its own lifecycle (`TRIALING` -> `ACTIVE`
&harr; `PAST_DUE` -> `CANCELED`), billing cadence
(`interval`/`intervalCount`, e.g. every 2 weeks), and a simple, documented
dunning policy. Full domain writeup, including the state machine and the
billing/dunning design in detail, lives in
[`docs/business-domain/subscriptions.md`](docs/business-domain/subscriptions.md);
this entry covers the technical/architectural side.

- **No separate Plan/catalog concept.** A subscription carries its own
  `amount`/`currency`/`interval` directly — the same way
  `POST /payments/charge` takes an amount directly rather than referencing
  a stored SKU. A reusable plan catalog for a multi-product merchant is a
  real gap, not attempted here (see `future-directions.md`).
- **Billing reuses `PaymentCheckoutSaga.execute()` wholesale**, once per
  period, rather than re-implementing charging. A recurring charge gets
  the same smart routing, risk scoring, ledger booking (including the FX
  and reserve mechanisms above), and 3DS-response handling a one-time
  charge gets, not a parallel, drifting copy of that logic. `binInfo` is
  omitted for a renewal (no live card entry happens off-session) — already
  optional everywhere it's read.
- **Crash-recovery / double-charge protection without a distributed
  transaction.** `SubscriptionService.runBillingSweep()` isn't wrapped in
  one DB transaction with the saga's own internal one (splicing a second
  aggregate's write into the saga would mean changing its signature for
  every caller). Instead each subscription+period gets a *deterministic*
  payment id (`uuidv5(subscriptionId:periodEnd)`), reused as both the
  `Payment`'s primary key and its idempotency key. Before charging, the
  sweep checks whether that exact id already exists and is `SUCCEEDED` —
  if the process crashed between the saga committing the charge and the
  subscription advancing, the next tick recognizes the period as already
  paid and just advances it, instead of charging again.
- **Dunning is deliberately simplified**: a fixed `MAX_DUNNING_ATTEMPTS =
  3`, retried every sweep tick with no backoff — not a real
  multi-week smart-retry schedule (Stripe's, for comparison, spaces
  retries out and factors in card-network-specific decline codes). The
  new period always anchors to the *schedule* (old `currentPeriodEnd` +
  one interval), not to whenever a charge actually succeeded, so a
  multi-attempt dunning retry doesn't drift the subscription's billing
  date forward.
- **Trial periods skip charging entirely** rather than a real
  SetupIntent-style card validation call — the stored `paymentMethodId`
  is trusted the same way a normal charge already trusts one. A
  deliberate simplification, not a real "verify the card without
  charging it" primitive.

Endpoints: `POST /subscriptions` (charges the first period immediately
unless `trialDays` is set — a first charge that fails means no
subscription is created at all, mirroring how a declined one-time charge
never creates anything durable), `GET /subscriptions`/`GET
/subscriptions/:id` (merchant-scoped, same ownership model as
`PaymentController`), `POST /subscriptions/:id/cancel` (immediate or
`atPeriodEnd`), and `POST /admin/subscriptions/run-billing` (on-demand
trigger for the daily sweep — same dual on-demand + scheduled shape as
`ReconciliationService`/`ReserveService`).

Verified end to end in `test/subscriptions.e2e-spec.ts` (10 tests, real
Postgres, real saga execution through mock-psp): a no-trial subscription
charges immediately; a trial subscription charges nothing until it
elapses; a failing first charge creates no subscription; the billing
sweep renews a due subscription and the new period is proven to anchor to
the *schedule* (old period end + interval), not to `now`; the
crash-recovery path is proven directly — a payment row is fabricated with
the exact deterministic id a due subscription's period would produce,
already `SUCCEEDED` with a sentinel `pspTransactionId`, and the sweep is
shown to advance the subscription *without* overwriting that sentinel
(which a real re-charge would have, since `PaymentAggregate.create()` +
`save()` would rewrite the row); a subscription is walked through all 3
dunning attempts to cancellation; `cancelAtPeriodEnd` is shown to skip the
final charge entirely, not renew-then-immediately-cancel; and ownership
scoping (403 cross-merchant, list scoping) is covered. Full suite
(`npm test` 18/18, `npm run test:e2e` 85/85) still passes.

**Known simplifications, all documented above and in
`subscriptions.md`**: no plan/catalog concept, no real card-validation
primitive for trials, a fixed (not smart/scheduled) dunning retry policy,
and `'month'`/`'year'` interval math uses JS's native date arithmetic,
which overflows short months (Jan 31 + 1 month becomes Mar 3, not Feb
28) rather than clamping like real billing systems do.

### Dispute resolution policy layer — ✅ resolved
Representment and deadline visibility already existed (Tier 3 item 6,
above); every dispute still sat at `NEEDS_RESPONSE` until an operator
manually looked at it, regardless of amount or how winnable it actually
was. Fixed with a pure policy function (`domain/services/dispute-policy.ts`)
that `DisputeService.recordDispute()` runs at creation time, classifying
every new dispute as `ACCEPT`, `CONTEST`, or `MANUAL_REVIEW` — amount
checked first (below an illustrative $15 threshold, not worth contesting
regardless of reason), then reason code against a small, deliberately
conservative table (`product_not_received`/`duplicate` are auto-contested
with a template; `fraudulent` and anything unrecognized default to
`MANUAL_REVIEW` — a templated response to a fraud claim would more likely
waste the response window than win it). `CONTEST` is the one decision
that actually *acts*: it calls the real PSP evidence-submission endpoint
immediately, moving the dispute to `UNDER_REVIEW` before an operator ever
sees it. `ACCEPT`/`MANUAL_REVIEW` are recorded (`Dispute.autoDecision`,
immutable — an operator's later manual action doesn't retroactively
change what the policy originally recommended) but advisory only — this
system has no PSP "accept/close" action to call. Every dispute now also
carries `evidenceGuidance`, reason-code-specific hints on what evidence
actually wins (`fraudulent` needs AVS/CVV/3DS proof; `product_not_received`
needs delivery confirmation; etc.) — shown regardless of the auto-decision,
since an operator overriding a `MANUAL_REVIEW` recommendation still needs
to know what to submit.

**Notification** moved from a bare `logger.warn()` to a structured
`EventEmitter2` event (`dispute.created`/`dispute.resolved`) — a real
notification integration (email/Slack/paging) has something to subscribe
to now, even though nothing does yet. Same stand-in posture as
`ReconciliationService`'s/the outbox relay's alerting elsewhere in this
codebase, but a real extension point, not only a log line.

**A significant, previously-undiscovered bug found verifying the new
event emission**: an e2e test registered a listener via
`app.get(EventEmitter2)` and never received `dispute.created`, even
though `DisputeService` was confirmed to be calling `eventEmitter.emit()`.
Root cause: **`EventEmitterModule.forRoot()` was called twice** — once in
`app.module.ts` (the real, intended registration) and, independently,
again in `payment.module.ts`. Unlike `@nestjs/throttler`'s `ThrottlerModule`
(already documented in `payment.module.ts` as safe to call twice — it
collapses to one shared global instance), `@nestjs/event-emitter`'s
`forRoot()` does `provide: EventEmitter2, useValue: new EventEmitter2(...)`
on *every* call — a second `forRoot()` doesn't harmlessly resolve to the
global one, it constructs a genuinely separate instance and registers it
as *another* global provider, silently splitting the app's event bus in
two. Every service instantiated within `PaymentModule`'s own dependency
graph (which is most of them) had been emitting into a *different*
`EventEmitter2` instance than anything resolving the token from
`AppModule`'s side this entire time — this predates the dispute policy
work; it was only ever surfaced now because this was the first test to
listen for a domain event via `app.get(EventEmitter2)` from outside
`PaymentModule`'s own providers. Fixed by deleting `payment.module.ts`'s
redundant `EventEmitterModule.forRoot()` call entirely; `app.module.ts`'s
`@Global()` registration already covers the whole app.

Verified end to end in `test/dispute-policy.e2e-spec.ts` (6 tests, real
Postgres, real Stripe-webhook-driven dispute creation and resolution): a
low-value dispute is `ACCEPT`ed and left completely untouched; a
high-value `product_not_received` dispute is auto-`CONTEST`ed — real PSP
evidence submission, `UNDER_REVIEW`, and a second (human) submission
correctly rejected with 409; a high-value `fraudulent` dispute is left
`MANUAL_REVIEW` and an operator can still act on it normally, with
`autoDecision` proven immutable after the manual override;
`evidenceGuidance` is reason-code-specific; and both `dispute.created`/
`dispute.resolved` are proven to actually fire with the right payload —
which is what caught the `EventEmitterModule` bug above. One pre-existing
test in `webhooks.e2e-spec.ts` needed a one-line fix: it used
`reason: 'product_not_received'` to test *manual* evidence submission,
which the new auto-contest policy now intercepts before the test ever
gets there — changed to `'unrecognized'`, a reason deliberately outside
the auto-contestable table. Full suite (`npm test` 18/18, `npm run
test:e2e` 96/96) still passes.

**Known simplifications**: the amount threshold and reason-code table are
illustrative, not calibrated against real chargeback win-rate data (same
posture as `RiskTieringService`'s tiers); no decline-code-nuanced
learning from past outcomes; no per-merchant history weighting; and
`ACCEPT` doesn't retroactively do anything to the dispute (there's no PSP
action to call), it's purely informational for operator triage. See
[`future-directions.md`](docs/business-domain/future-directions.md#dispute-resolution-workflow)
for the fuller framing.

### Cross-border settlement remainder — ✅ resolved
FX conversion for a merchant's settlement leg was already real (Tier 3
above); two narrower pieces of the same gap remained open. Both closed
now:

- **Refunds/lost disputes now net cleanly.** They used to always book
  against the merchant in the *charge* currency regardless of what they
  were actually paid out in — for a merchant with an active settlement
  conversion, a refund debit in USD and the original charge credit in EUR
  are two ledger lines that never cancel out. Fixed by having
  `PaymentAggregate.recordSettlementConversion()` remember the rate a
  charge/capture actually used (once — never overwritten by a later
  capture of the same payment), and having both
  `PaymentLifecycleService.refund()` and `DisputeService`'s `LOST`
  resolution path convert their clawback amount using that *same* stored
  rate. `LedgerOutboxEvent.createRefundEntries()` gained the identical
  two-leg `FX_CLEARING` shape `createChargeEntries()` already had, with
  every entry type flipped. Full design, including why this also
  functions as this system's answer to "who bears FX risk between charge
  and settlement time" (the platform does, by locking the rate at charge
  time and never re-quoting it for that payment's lifecycle), in
  [`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#refunds-and-lost-disputes-replay-the-original-charge-time-rate).
- **Presentment currency.** `POST /payments/charge` accepts an optional
  `presentmentCurrency` and returns a computed `presentmentAmount` for
  display — purely informational, doesn't touch what's actually
  charged/settled/booked. Deliberately not persisted (see the ledger doc
  for why that's a real, acknowledged gap for support/audit purposes). A
  failed presentment lookup never fails the charge, just omits the field.

Verified end to end in `test/cross-border-settlement.e2e-spec.ts` (6
tests, real Postgres, real Stripe-webhook-driven dispute resolution): a
full refund of a settlement-converted payment is proven to book the
`FX_CLEARING`/`MERCHANT` legs in the settlement currency at the *exact*
original rate (asserted down to the minor unit); a merchant with no
settlement currency configured is unaffected (no `FX_CLEARING` legs,
unchanged default behavior); a lost dispute for a settlement-converted
payment claws back correctly in the settlement currency; a
presentment-currency charge returns the converted display amount while
every ledger entry stays in the real charge currency; an unsupported
presentment currency doesn't fail the charge; and a presentment currency
equal to the charge currency is correctly treated as a no-op. Full suite
(`npm test` 18/18, `npm run test:e2e` 102/102) still passes.

**Known simplifications**: VAT/tax handling isn't touched at all, and
there's still no hedging/rate-lock *product* for a merchant who wants a
guaranteed rate before a charge even happens — this system quotes at
charge time and nothing before that.

### Subscription plan catalog & proration — ✅ resolved
Recurring billing (Tier 3 above) shipped with each subscription carrying
its own amount/currency/interval directly — there was no reusable "plan"
concept, and no way to change a running subscription's price mid-cycle.
Both are closed now:

- **`Plan` aggregate** (`plan.aggregate.ts`) — a merchant-scoped catalog
  entry: name, amount, currency, interval, `intervalCount`. New
  `PlanController` at `POST /plans`, `GET /plans/:id`, `GET /plans`
  (merchant-scoped list), `POST /plans/:id/deactivate`. No
  `HmacSignatureGuard`/`IdempotencyInterceptor` on this controller —
  creating/editing a catalog entry doesn't move money, unlike every
  other mutating endpoint in this codebase.
- **`POST /subscriptions` accepts a `planId`** as an alternative to the
  original direct `amount`/`currency`/`interval` fields — pricing is
  resolved from the plan at creation time and stored on the subscription
  *by value*, so later edits to the `Plan` row don't retroactively
  change subscriptions already running under it. Supplying neither a
  `planId` nor direct pricing throws a 422 (`SUBSCRIPTION_MISSING_PRICING`).
- **`POST /subscriptions/:id/change-plan`** switches an `ACTIVE`
  subscription to a different plan, prorating the remaining part of the
  current period: `(newPlan.amount - oldPlan.amount) * remainingFraction`.
  Upgrades charge the difference through the normal
  `PaymentCheckoutSaga.execute()` path (same saga every other charge
  uses); if that charge fails, the plan change doesn't take effect
  (422 `PRORATION_CHARGE_FAILED`) — the switch and the charge succeed or
  fail together. Downgrades charge nothing and take effect immediately
  (no credit — `Money` can't represent a negative amount, so crediting a
  downgrade would need a real invoice-credit primitive this codebase
  doesn't have). Cross-currency plan changes are rejected with a 409
  (`PLAN_CURRENCY_MISMATCH`) rather than silently converting. Full design
  in [`docs/business-domain/subscriptions.md`](docs/business-domain/subscriptions.md#plans-and-proration).

Two real bugs found during implementation, before either reached a
running test:
- **TDZ risk in `subscription.dto.ts`**: a new `ChangePlanResponseDto`
  was initially declared *before* `SubscriptionResponseDto` in the same
  file, with a property typed as `SubscriptionResponseDto`. TS emits
  `__metadata("design:type", SubscriptionResponseDto)` for Swagger's
  reflection-based schema generation, which references the class as a
  runtime *value* at decorator-evaluation time — and class declarations
  are `let`-scoped (TDZ), not hoisted for value access the way function
  declarations are. Declared in the wrong order, this throws a
  `ReferenceError` at module load, not at request time. Fixed by
  reordering the class declarations.
- **`PlanService.deactivate()` would have incorrectly blocked ADMIN**:
  the first version took `(id, merchantId)` and threw `ForbiddenException`
  if `plan.merchantId !== merchantId` — but the controller was always
  passing the *acting user's own* `merchantId`, regardless of role, so an
  ADMIN deactivating a plan belonging to a different merchant would be
  wrongly rejected. Fixed by moving the check out of the service (now
  just `deactivate(id)`) and into the controller via the same
  role-aware `getOrThrow()` + `assertOwnership()` two-step
  `SubscriptionController.cancel()` already uses.

Verified against real infrastructure: `test/plans.e2e-spec.ts` (10
tests, real Postgres) — plan CRUD; subscription pricing resolved from a
plan; the original direct-pricing path still works unchanged; a 422 for
a subscription created with neither; exact proration math (a
`setPeriodToMidpoint()` helper writes `currentPeriodStart`/`currentPeriodEnd`
directly to force a deterministic 50%-remaining period rather than
relying on real elapsed wall-clock time, avoiding sub-cent rounding
flakiness — the same "push the period into a known position" trick
`test/subscriptions.e2e-spec.ts` already uses); a downgrade charges
nothing; a cross-currency change-plan returns 409; a change-plan on a
non-`ACTIVE` subscription returns 409; a deactivated plan blocks new
subscriptions but leaves existing ones on it unaffected; cross-merchant
ownership returns 403 for both plans and change-plan. Full suite
(`npm test` 18/18, `npm run test:e2e` 112/112) passes; two known,
pre-existing full-suite-scale flakes (`api-versioning.e2e-spec.ts`'s
heap threshold, `ledger-and-outbox.e2e-spec.ts`'s outbox-relay timing —
both already documented above) each reconfirmed clean in isolation, and
neither is connected to this round's code.

**Known simplifications**: no downgrade credits (see above); a `Plan` has
no versioning — editing isn't supported at all (only create/deactivate),
so "raise the price for a tier" means creating a new `Plan` and migrating
subscribers to it one `change-plan` call at a time, not an in-place edit.

### Marketplace & split payments (phase 1) — ✅ resolved
Every charge used to be attributed to exactly one merchant, a flat peer
with no relationship to any other merchant. Phase 1 of a marketplace
model is real now — a platform merchant charging a customer and routing
part of the proceeds directly to its own sellers:

- **`MerchantEntity.accountType`** (`PLATFORM` | `CONNECTED`, default
  `PLATFORM` — every existing merchant is unaffected) plus
  `platformMerchantId`, set only on a `CONNECTED` account, naming the
  parent platform's `merchantId`. `POST /admin/merchants` validates the
  relationship at creation: a `CONNECTED` account requires an existing
  `platformMerchantId` that is itself a `PLATFORM` account — one level
  deep only, a `CONNECTED` merchant can't have connected accounts of its
  own (`PLATFORM_MERCHANT_ID_REQUIRED`/`PLATFORM_MERCHANT_NOT_FOUND`/`PLATFORM_MERCHANT_INVALID`,
  all 409/404 as appropriate).
- **`POST /payments/charge` accepts `splits`** — `[{ merchantId, amount }]`
  routing part of the charge's net (post-fee, post-reserve) payout
  directly to one or more `CONNECTED` merchants of the charging platform.
  Each split becomes its own `MERCHANT` ledger credit keyed by the
  recipient's own merchantId; whatever's left still credits the platform
  — a split doesn't have to add up to the full payout. Full ledger
  mechanics, including the double-entry shape, in
  [`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#marketplace-splits).
- Rejected up front (before the PSP is ever called, see the real bug
  below): an unknown/non-connected/wrong-platform recipient
  (`SPLIT_RECIPIENT_INVALID`, 422), a split total exceeding the net
  payout (`SPLIT_EXCEEDS_NET_AMOUNT`, 422), `captureMethod: "manual"`
  together with `splits` (`SPLIT_REQUIRES_AUTOMATIC_CAPTURE`, 409, since
  `PaymentLifecycleService.capture()` doesn't accept splits and would
  silently drop them), and a platform merchant with an active
  settlement-currency conversion (`SPLIT_WITH_SETTLEMENT_CONVERSION_UNSUPPORTED`,
  409 — deciding which FX rate applies to a partly-platform,
  partly-connected-account charge is a real design question this phase
  doesn't attempt).

**A real bug found and fixed during implementation, not just during
testing**: `ChargeLedgerParamsResolverService.resolve()` — which now
validates `splits` — used to only ever be called *after* a successful PSP
charge, in `PaymentCheckoutSaga`'s `SUCCEEDED` branch, because until
splits existed it could never throw (its one other failure mode, an FX
lookup failure, was already handled by silently falling back). Wiring
split validation into the same method meant it could now throw for the
first time — and discovering an invalid split *after* the customer's card
was actually charged would leave a real charge with no ledger entry and
no way to undo it; the saga has no compensating "reverse a completed PSP
charge" step. Fixed by hoisting the `resolve()` call to right after the
payment intent is created — before routing or charging — reusing that
same result later instead of re-resolving, so an invalid split now fails
the request before money ever moves, the same posture a routing failure
already had.

Verified against real infrastructure in `test/marketplace-splits.e2e-spec.ts`
(13 tests, real Postgres): a split charge's ledger entries booked and
inspected directly from the database (not just the API response) — the
connected merchant's credit, the platform's remainder credit, and that
the two plus the platform fee sum back to the original PSP settlement
debit; a split that exactly exhausts the payout leaves no separate
platform credit; a split total exceeding the net payout is rejected with
422 and confirmed to leave the payment `FAILED` with zero ledger rows
written; a split to a merchant that isn't a connected account (a
stranger, or a connected account of a *different* platform) is rejected
with 422; `captureMethod: "manual"` with splits is rejected with 409
before any `Payment` row is even created; a platform with an active
settlement-currency conversion is rejected with 409; a charge with no
`splits` behaves exactly as before (single `MERCHANT` credit, unchanged);
and the full admin onboarding validation matrix (missing/unknown/invalid
platform, one-level-deep enforcement). Full suite (`npm test` 18/18,
`npm run test:e2e` 125/125) passes; the same two known, pre-existing
full-suite-scale flakes (`api-versioning.e2e-spec.ts`'s heap threshold,
`ledger-and-outbox.e2e-spec.ts`'s outbox-relay timing) each reconfirmed
clean in isolation, neither connected to this round's code.

**Known simplifications** (see
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#marketplace--split-payments)
for the fuller business framing): no connected-account KYC/onboarding
review — creating one is the same instant admin call as any merchant; no
independent payout scheduling/rolling reserve — a split's credit lands on
the connected account's ledger balance immediately, same as a direct
charge; and a split can't be combined with the platform's own
settlement-currency conversion, let alone give each connected account its
own.

### Marketplace splits: refund & dispute-loss reversal — ✅ resolved
The previous round's most notable open gap: a refund or lost dispute on a
split payment used to debit only the *platform's* own account for the
full amount, never touching the connected merchants who'd actually
received a share of the original charge — not a ledger-corrupting bug
(double-entry still balanced), but not what a real marketplace would want
either. Closed now:

- **`PaymentAggregate.recordSplits()`** remembers the *original*
  charge-time `splits` — recorded once, immutable, same posture as
  `recordSettlementConversion()` — persisted on a new `payments.splits`
  jsonb column.
- **`LedgerOutboxEvent.createRefundEntries()`** gained `splits`/
  `originalChargeAmount` params: each connected merchant is now debited
  `split.amount × (refundAmount / originalChargeAmount)` (integer minor
  units, floor division), and the platform absorbs the remainder — the
  same "remainder goes to the platform" shape the charge-time split
  itself uses, reversed. A full refund reproduces each split's *exact*
  original amount with zero rounding drift; a partial refund can never
  claw back more than the refund amount in total. Both
  `PaymentLifecycleService.refund()` and `DisputeService`'s `LOST`
  resolution path now pass this through. Full math and the (pre-existing,
  unrelated to splits) "a refund never gives back the platform fee"
  reasoning in
  [`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#reversing-a-split-on-refund-or-dispute-loss).

**A real bug found during implementation, not just during testing**:
`splits` used to only be recorded on the `Payment` aggregate inside
`PaymentCheckoutSaga`'s immediate-`SUCCEEDED` branch. A charge that
instead came back `REQUIRES_ACTION` (a 3DS challenge) skips that branch
entirely — the charge is only confirmed later, when
`WebhookProcessingService.markSucceeded()` processes the PSP's webhook,
by which point it only has the persisted `Payment` row to work with, not
the original request. A split charge that happened to need a 3DS
challenge would silently lose its split the instant the challenge
completed — the ledger entry would book as an ordinary, unsplit charge,
with no error anywhere. Fixed by recording `splits` on the payment intent
immediately after `ChargeLedgerParamsResolverService.resolve()` validates
them — *before* the PSP is ever called — regardless of how the charge
eventually resolves, so the same payment row `WebhookProcessingService`
re-fetches already carries them. This was found by deliberately writing a
test for the interaction (a split charge forced through 3DS via the same
`FORCE_3DS` mock-PSP marker `webhooks.e2e-spec.ts` already uses), not by
accident — the general lesson from this session's earlier duplicate-`EventEmitterModule`
bug (any state recorded only in a request's "everything succeeded
immediately" branch is suspect once a codebase has more than one way for
a charge to eventually succeed) applied here too.

Verified against real infrastructure in `test/marketplace-split-refunds.e2e-spec.ts`
(4 tests, real Postgres): a full refund reproduces the exact original
split amounts; a partial refund ($33.33 split, 10% refund) produces the
exact floor-divided $3.33/$6.67 split with the two summing back to
exactly $10.00; a lost dispute (via real Stripe webhook signature
verification, `charge.dispute.created` → `charge.dispute.closed` with
`status: "lost"`) claws back proportionally identically to a refund; and
the 3DS-then-webhook regression case above, confirming zero ledger
entries exist immediately after the `REQUIRES_ACTION` response and the
correct split entries exist once the webhook resolves it. Full suite
(`npm test` 18/18, `npm run test:e2e` 129/129) passes; the same known,
pre-existing `api-versioning.e2e-spec.ts` heap-threshold flake
reconfirmed clean in isolation, unconnected to this round's code.

**Known simplifications**: refunds/dispute-loss reversal still don't give
back the platform fee (pre-existing behavior, unrelated to splits — see
above); connected-account KYC/onboarding review remains open (see
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#marketplace--split-payments)).

### Marketplace payout scheduling — ✅ resolved
A connected merchant's split proceeds used to be available the instant
they were credited — the same as a direct charge, with no batching or
rolling reserve, unlike a real marketplace processor. Closed now:

- **`PayoutService.runSweep()`** (daily `@Cron` plus
  `POST /admin/marketplace/run-payouts` on demand, same dual shape as
  `ReconciliationService`/`ReserveService`) reads every ledger event
  created since the previous sweep's window end — tracked by its own
  `PayoutSweepRun` cursor record, always written so the window advances
  monotonically even when a run finds nothing — sums each account's net
  `MERCHANT`-entry balance, and creates a `Payout` for every `CONNECTED`
  merchant with a positive balance: `grossAmount` (swept credit),
  `reserveAmount` (`grossAmount × MerchantEntity.payoutReserveBps`,
  withheld), `netAmount` (the immediately-disbursable remainder). A
  `PLATFORM` merchant's own charge proceeds are never swept.
- **`PayoutService.releaseEligibleReserves()`** (daily `@Cron` plus
  `POST /admin/marketplace/release-eligible-reserves` on demand) releases
  a payout's withheld reserve once `payoutReserveHoldDays` has elapsed;
  `POST /admin/marketplace/payouts/:id/release-reserve` is an operator's
  manual override.
- New `PATCH /admin/merchants/:id/payout-reserve-policy` sets a
  connected merchant's `payoutReserveBps`/`payoutReserveHoldDays` — new
  fields, deliberately distinct from `reserveBps`/`reserveHoldDays`
  (which apply at *charge* time to whichever merchant is doing the
  charging): a merchant that both charges directly and receives splits
  could reasonably want different rates for those two genuinely different
  money flows.
- **Deliberately moves no ledger money.** Unlike the charge-time reserve
  (a real `RESERVE`-account ledger entry), `Payout` is a pure scheduling
  overlay on a balance the split mechanism already books correctly — this
  system has no payout/bank-transfer rail to represent "money physically
  sent" vs. "still on the books," so there's nothing for a ledger entry
  to move. Full design and the "ledger balance vs. available balance"
  reasoning in
  [`docs/business-domain/ledger-and-settlement.md`](docs/business-domain/ledger-and-settlement.md#payout-scheduling-for-connected-accounts).

New tables: `payouts`, `payout_sweep_runs`; new `merchants` columns
`payout_reserve_bps`/`payout_reserve_hold_days`. New port method
`LedgerOutboxPort.findCreatedBetween()` — the first time anything queries
outbox events by creation window rather than by status.

Verified against real infrastructure in `test/marketplace-payouts.e2e-spec.ts`
(7 tests, real Postgres): a sweep withholds the exact configured
rolling-reserve percentage with correct gross/reserve/net math; a
merchant with no rolling reserve gets a `reserveStatus: 'NONE'` payout
with no `releaseEligibleAt`; running the sweep twice with no new activity
creates no duplicate `Payout` and a subsequent new charge produces
exactly one more (cursor correctness, no double-counting); a `PLATFORM`
merchant's own proceeds are never swept; the reserve-release sweep
releases an eligible reserve (`holdDays: 0`) and leaves an ineligible one
(`holdDays: 90`) alone; a manual force-release works before eligibility
and a repeat attempt is rejected with 409; and the new PATCH endpoint's
rate takes effect on the next sweep. Full suite (`npm test` 18/18,
`npm run test:e2e` 136/136) passes; the same three known, pre-existing
full-suite-scale flakes (`api-versioning.e2e-spec.ts`'s heap threshold,
and — this run — `fx-conversion.e2e-spec.ts`/`ledger-and-outbox.e2e-spec.ts`
each hitting a stray login 401/404, the same "different endpoint each
run" class already documented above) each reconfirmed clean in isolation,
none connected to this round's code.

**Known simplifications**: no connected-account KYC/onboarding review
(same as last round); no real payout/bank-transfer initiation — a
`Payout` is a scheduling/accounting record, not an instruction to move
real money anywhere; and the very first sweep a long-running deployment
ever runs would scan its entire ledger history once (the cursor has
nothing to start from) — acceptable for a reference system, a production
one would want to seed it at deployment time. See
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#marketplace--split-payments)
for the fuller framing.

### Subscription dunning & credit cleanup — ✅ resolved
Three gaps `future-directions.md` had explicitly flagged in the
Recurring Billing section — every one a real, working mechanism to
begin with, just a simplified one. All three closed together:

- **Downgrade credits.** `Subscription.computeDowngradeCredit()` — the
  exact mirror of the existing `computeUpgradeProration()` — returns
  the unused-portion value when switching to a cheaper plan mid-period.
  `applyDowngradeCredit()` stores it (`pendingCredit`, accumulating
  across repeat downgrades before any of it is used), and
  `amountDueThisPeriod` subtracts it from the *next* billing charge
  before the PSP is ever called — never refunded immediately, since
  `Money` can't represent a negative amount and this system has no
  account-credit primitive to hand one back with. A credit that fully
  covers (or exceeds) the next period's price makes that charge exactly
  `$0`, which the billing sweep recognizes and skips the PSP call for
  entirely — no `Payment` row at all for a fully-covered period.
- **A real dunning backoff schedule.** Failed charges used to retry on
  the very next daily sweep tick, every time — 3 attempts compressed
  into 2-3 days regardless of the schedule. `recordFailedCharge()` now
  sets `nextRetryAt` from a fixed `RETRY_SCHEDULE_DAYS = [1, 3, 7]`
  backoff, and `dueAction()` returns `NONE` for a `PAST_DUE`
  subscription until that time arrives — 1 initial attempt + 3 retries
  spread across about a week (`MAX_DUNNING_ATTEMPTS` raised 3 → 4 to
  match) before giving up.
- **Real event emission.** `SubscriptionService` now injects
  `EventEmitter2` and actually emits `subscription.past_due` (every
  failure that doesn't cancel) and `subscription.canceled` (dunning
  exhausted, `cancelAtPeriodEnd` reached, or an explicit
  merchant-requested immediate cancel) — not just a `logger.warn()`
  line. Nothing subscribes to either yet; this closes "the event isn't
  even emitted", the same posture the dispute-policy round's
  `dispute.created`/`dispute.resolved` events already established, not
  "someone acts on it" (still open, see below).

**A real bug found during implementation, not just during testing**:
the first version of `consumeCredit()` left a fully-consumed credit as
a *zero* `Money` object rather than `undefined`. A zero `Money` still
round-trips through Postgres as a real, non-null `"0"` value — so a
subsequent `GET /subscriptions/:id` reported `pendingCredit: 0` instead
of omitting the field entirely, caught by an e2e assertion expecting
`toBeUndefined()` after a credit was fully consumed by a renewal
charge. The exact same `undefined`-vs-a-real-falsy-value class of bug
`MerchantService.updateSettlementCurrency()`'s docblock already
documents for `null` vs. `undefined` on `save()`, just showing up on
the read side instead. Fixed by normalizing a fully-consumed credit
back to `undefined` in `consumeCredit()`.

Verified against real infrastructure: extended `test/subscriptions.e2e-spec.ts`
(now includes a retry-gate test confirming a second sweep run does
*not* retry before `nextRetryAt` — the actual behavior this round
fixed — and an event-emission test asserting exactly 3
`subscription.past_due` events and 1 `subscription.canceled` event with
`reason: 'dunning_exhausted'` across a full 4-attempt dunning cycle,
listened for via `app.get(EventEmitter2)`) and `test/plans.e2e-spec.ts`
(a downgrade now asserts `creditIssued`/`pendingCredit` are set
correctly, plus a new test proving a `$10` credit against a `$20`
renewal charges exactly `$10` and leaves `pendingCredit` fully
consumed). Full suite (`npm test` 18/18, `npm run test:e2e` 139/139)
passes; the same known, pre-existing `api-versioning.e2e-spec.ts`
heap-threshold flake reconfirmed clean in isolation and on an immediate
full-suite re-run, unconnected to this round's code (a `dispute-policy.e2e-spec.ts`
429-rate-limit flake also appeared once and did not reproduce on
either an isolated run or a full-suite re-run — the same "different
symptom at a different endpoint each run" full-suite-scale flakiness
class already documented above, now also covering an occasional
rate-limit burst rather than only login 401/404s).

**Known simplifications**: no decline-code-aware dunning (every failure
retries identically regardless of why it failed); no real notification
integration subscribed to the new events. See
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#recurring-billing--subscriptions)
for the fuller framing.

### Trial payment method verification — ✅ resolved
The last of the three Recurring Billing gaps: trials used to skip
charging *and* skip validating the payment method entirely, trusting
whatever `paymentMethodId` was supplied — a bad or already-revoked card
was only discovered weeks later, when the trial tried to convert to a
real charge. Closed with a genuinely new PSP adapter capability, not
just application-layer logic:

- **`PSPAdapterPort.verifyPaymentMethod()`** — a new abstract method
  alongside `charge()`/`capture()`/`refund()`/`cancel()`, confirming a
  stored payment method is real and chargeable *without* moving any
  money. Implemented two different, both realistic ways, since there's
  no single universal "$0 auth" API across providers: **Stripe** uses a
  real SetupIntent (`POST /v1/setup_intents`, `usage: 'off_session'`) —
  Stripe's actual purpose-built primitive for this; **Adyen** uses a
  zero-value authorization (`amount.value: 0`, `shopperInteraction:
  'ContAuth'`), the pattern real Adyen supports for validating a stored
  credential (Adyen has no separate SetupIntent-shaped API the way
  Stripe does).
- **`SubscriptionService.verifyPaymentMethodOrThrow()`** calls this
  before a trial's `Subscription` is even created, routed through the
  exact same `AcquirerRoutingService.executeWithSmartRouting()` path a
  real charge uses — a PSP outage falls back to the other provider the
  same way a charge would, but an actual decline does not (a declined
  verification is a normal `{ success: false }` return, not a thrown
  error, and `executeWithFallback()` only retries on the latter). A
  failed verification throws 422
  (`SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED`) and no
  `Subscription` is persisted — same "don't create something that was
  never able to start" posture the no-trial path already has for a
  failed first charge.
- **`scripts/mock-psp/server.js`** gained two new endpoints —
  `POST /v1/setup_intents` and `POST /adyen/payments/verify` — neither
  of which ever pushes a settlement row (no money moves). Both share a
  new decline-marker convention: a `paymentMethodId`/`storedPaymentMethodId`
  containing "invalid" (case-insensitive) fails verification, the same
  "magic substring" pattern `FORCE_3DS` already established for forcing
  3DS in this mock — there being no real card-number-based decline
  simulation anywhere in this mock server.

Full design and the exact request/response shapes in
[`docs/business-domain/subscriptions.md`](docs/business-domain/subscriptions.md#trials).

Verified against real infrastructure: extended `test/subscriptions.e2e-spec.ts`
with a new "Trial payment method verification" describe block (a
`pm_card_invalid` payment method is rejected with 422 and creates
*nothing* — no `Subscription`, no `Payment`; a currency neither mock PSP
supports fails the same way a real charge would fail routing) and fixed
three existing dunning tests that used to rely on trial creation
skipping PSP interaction *entirely* (creating a trial directly in KRW,
which the mock PSPs don't support, to guarantee the eventual renewal
would fail) — they now create with a real, verifiable currency (USD)
and flip the subscription to KRW via a direct DB write *after*
creation, since verification only runs once, at creation time, not on
every billing attempt. `curl`-verified both new mock-psp endpoints
directly (valid/invalid payment method, both providers) before running
the suite. Full suite (`npm test` 18/18, `npm run test:e2e` 141/141)
passes; the same known, pre-existing `api-versioning.e2e-spec.ts`
heap-threshold and `ledger-and-outbox.e2e-spec.ts` outbox-relay-timing
flakes, plus an occasional `dispute-policy.e2e-spec.ts` rate-limit
burst, each reconfirmed clean in isolation across multiple runs,
unconnected to this round's code.

**Known simplifications**: verification is a pure gate — nothing about
the fact that a card was verified is persisted anywhere on the
`Subscription` (no `pspVerificationId` stored), matching how a real
charge's own verification isn't a separate persisted record either
until money actually moves; and this is a synchronous, one-time check
at trial creation, not an ongoing "is this card still valid" monitor for
a trial that runs for weeks.

### Marketplace KYC & real payout initiation — ✅ resolved
The last two Marketplace & Split Payments gaps: creating a `CONNECTED`
merchant used to be the same instant, unconditional admin call as any
other merchant, with no verification before it could receive payouts;
and `Payout` was purely a scheduling/accounting record with no rail to
actually move money. Both closed:

- **`MerchantEntity.kycStatus`** (`NOT_STARTED` | `VERIFIED` |
  `REJECTED`) — set via new `POST /admin/merchants/:id/kyc/submit`
  (`{ legalName, taxId }`), which calls a new `KYCProviderPort` (a real
  HTTP call to an external verification service — a mock one here, same
  "single external HTTP call" shape as `FXRateProviderPort`). Gates
  **payouts, not charges** — a `CONNECTED` merchant with `NOT_STARTED`
  KYC can still be a split recipient and accumulate real ledger credit;
  `ChargeLedgerParamsResolverService.resolve()`'s split validation
  doesn't read `kycStatus` at all. This deliberately mirrors real Stripe
  Connect's `charges_enabled`/`payouts_enabled` distinction. Deliberately
  a synchronous three-state decision, not a `PENDING` state sitting in
  the database for days — a real KYC review is genuinely async, often
  over days.
- **`Payout.kycBlocked`** — set at `runSweep()` time from the recipient's
  current `kycStatus`. A `Payout` for a non-`VERIFIED` merchant is still
  created (exact same gross/reserve/net math, so the sweep's cursor
  still safely accounts for that money), just flagged un-transferable.
  New `POST /admin/marketplace/recheck-kyc-blocks` (daily `@Cron`, or
  on demand) re-checks every blocked `Payout` against the recipient's
  *current* status and clears the block once `VERIFIED` — including a
  `Payout` created before KYC was ever submitted.
- **`Payout.transferStatus`** (`NOT_INITIATED` | `INITIATED` |
  `FAILED`) — a new `BankTransferPort` (mocked) actually sends
  `netAmount` to the merchant. `POST /admin/marketplace/payouts/:id/initiate-transfer`
  (single payout) and `POST /admin/marketplace/initiate-eligible-transfers`
  (daily `@Cron`/on-demand sweep, catches per-payout) both refuse a
  `kycBlocked` payout (409) and refuse double-initiating the same
  payout's transfer (409, race-safe via `PayoutPort.markTransferInitiated()`'s
  conditional update — the same posture `markReserveReleased()` already
  has, since this is money genuinely leaving the platform). Deliberately
  scoped to `netAmount` only, never a later-released reserve — see the
  ledger doc for why that's a real, documented gap rather than something
  silently handled wrong.

New mock-psp endpoints: `POST /kyc/verify` (decline marker: `legalName`
containing "reject") and `POST /bank/transfers` (decline marker:
`merchantId` containing "transferfail") — neither ever touches
settlement records, since no real charge money moves through either.

Verified against real infrastructure: `curl`-tested both new mock
endpoints directly (approve/reject KYC, sent/failed transfer) before
running the suite. Extended `test/marketplace-payouts.e2e-spec.ts` with
7 new tests (14 total in that file): a fresh `CONNECTED` merchant
defaults to `NOT_STARTED` and its payouts are created `kycBlocked` with
otherwise-unchanged gross/reserve/net math; a rejected KYC submission
leaves payouts blocked; a verified merchant's payout transfer succeeds
(real `transferId` recorded) and a second initiation attempt on the same
payout is rejected with 409; initiating a transfer for a KYC-blocked
payout is rejected with 409 before the bank is ever called; the recheck
sweep clears a payout created *before* KYC was submitted once the
merchant becomes `VERIFIED`; a bank decline is recorded `FAILED` with a
422 response and doesn't block a later retry; and the transfer sweep
initiates every eligible payout while correctly skipping KYC-blocked
ones. Full suite (`npm test` 18/18, `npm run test:e2e` 148/148) passes;
the same known, pre-existing `api-versioning.e2e-spec.ts` heap-threshold
flake reconfirmed clean in isolation, unconnected to this round's code.

**Known simplifications**: no real KYC review (synchronous, marker-driven
mock, not an actual reviewer); no follow-up transfer for a reserve
released after its payout's net amount was already sent; and a mocked,
synchronously-resolving bank rail — a real one settles over days and
would need its own webhook-driven confirmation. See
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#marketplace--split-payments)
for the fuller framing.

### Dunning decline-codes — ✅ resolved
The last Recurring Billing / Subscriptions gap: every failed billing
attempt was retried identically on the same day 1/3/7 backoff schedule
regardless of *why* the charge failed — a real system needs to treat
"insufficient funds" (worth retrying) very differently from "card
reported stolen" (retrying is actively harmful). Closed:

- **`classifyDeclineCode(errorCode)`** (`subscription.aggregate.ts`)
  classifies a PSP decline code as `HARD_DECLINE` (`stolen_card`,
  `lost_card`, `fraudulent`, `pickup_card`, `restricted_card`,
  `expired_card` — `HARD_DECLINE_CODES`) or `RETRYABLE` (everything
  else, including no code at all). `recordFailedCharge(now, maxAttempts,
  errorCode?)` gained the third param: a hard decline cancels the
  subscription immediately on the first attempt, skipping `PAST_DUE`
  and the retry schedule entirely; a retryable decline keeps the
  existing day 1/3/7 backoff behavior exactly as before.
- **The decline code flows end-to-end**, not just at the classification
  site: `CheckoutSagaResult` gained `errorCode` (only set on a `FAILED`
  status), `PaymentCheckoutSaga.execute()` surfaces the PSP's own
  decline code on it, and `SubscriptionService.runBillingSweep()` passes
  it into `recordFailedCharge()`. It's persisted as
  `Subscription.lastDeclineCode` (new nullable column,
  `last_decline_code`), returned on `GET /subscriptions/:id`, and
  cleared back to `undefined` the moment a later charge succeeds — so it
  always reflects only the most recent attempt.
- **Event payloads carry the decline code.** `subscription.past_due` now
  includes `declineCode`; `subscription.canceled` now includes `reason:
  'hard_decline' | 'dunning_exhausted' | 'period_end_reached' |
  'merchant_requested'` (previously just `dunning_exhausted` vs. the
  other two) plus `declineCode` when the reason is `hard_decline` — so a
  listener can distinguish "this subscription's card is actually bad"
  from "dunning simply ran out of attempts" without re-deriving it.
- This deliberately does **not** touch the routing-exception path (no
  PSP available for a currency — a *thrown* error, not a PSP response):
  that branch still calls `recordFailedCharge(now, maxAttempts)` with no
  `errorCode`, which `classifyDeclineCode(undefined)` treats as
  `RETRYABLE`, preserving every pre-existing KRW-routing-failure dunning
  test's behavior unchanged.

New mock-psp decline-code markers (payment method id substrings, both
Stripe and Adyen routes): `insufficientfunds`, `stolencard`, `lostcard`,
`frauddecline`, `pickupcard`, `restrictedcard`, `expiredcard`,
`carddeclined` — distinct from the existing `"invalid"` substring marker
used for SetupIntent/zero-value-auth *verification* declines, since a
card can pass trial verification and still decline at actual charge
time, same as reality.

Verified against real infrastructure: `curl`-tested all four new
mock-psp decline-code paths directly (Stripe insufficient_funds,
Stripe stolen_card, Stripe's existing `pm_card_visa` unaffected, Adyen
expired_card) before running the suite. Added 4 new tests to
`test/subscriptions.e2e-spec.ts` (152 total across the e2e suite): a
retryable decline records the code and still uses the day 1/3/7
schedule; a hard decline cancels immediately on the first attempt with
no `PAST_DUE`; a hard decline emits `subscription.canceled` with
`reason: 'hard_decline'` rather than `'dunning_exhausted'`; and
`lastDeclineCode` clears once a subsequent charge succeeds. Full suite
(`npm test` 18/18, `npm run test:e2e` 152/152) passes; the two known,
pre-existing full-suite-scale flakes this run (`api-versioning.e2e-spec.ts`
heap threshold, `reserve.e2e-spec.ts` — a new symptom of the same class,
a timing-sensitive 404) both reconfirmed clean in isolation, unconnected
to this round's code.

**Known simplifications**: the hard-decline code set is illustrative —
a small, reasonable-looking set of Stripe/Adyen-style codes, not
validated against real-world decline-code taxonomies or
acquirer-specific variations; a real system would likely need this
configurable per-PSP. See
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#recurring-billing--subscriptions)
for the fuller framing.

### Agentic payments (delegation + spend policy) — ✅ resolved
Previously a pure direction writeup with no implementation — every
payment was attributed only to a `Merchant`, with no way for a human to
grant an autonomous agent a narrower, revocable slice of purchasing
power. Now a real, enforced mechanism:

- **`Delegation` aggregate** (`delegation.aggregate.ts`) — a merchant
  authorizes a named agent with a `SpendPolicy` (per-transaction limit,
  rolling calendar-month limit, optional category allowlist) via
  `POST /delegations`, which returns a narrowly-scoped JWT
  (`roles: [UserRole.AGENT]`, carrying `delegationId`) the agent
  authenticates with — a materially different claim from "this is a
  valid merchant credential," and structurally similar to how
  `POST /auth/token` already issues the merchant's own JWT, just scoped
  down. `UserRole.AGENT` is accepted on exactly one route,
  `POST /payments/charge` (see `PaymentController.charge()`) — every
  other endpoint's `@Roles()` doesn't list it, so an agent token gets a
  plain 403 anywhere else.
- **Spend policy enforcement is a real, atomic reservation, not a
  soft check.** `DelegationService.reserveSpendOrThrow()` runs before
  the checkout saga ever calls a PSP (same "validate/reserve before
  money moves, there's no undo for a completed charge" principle
  `ChargeLedgerParamsResolverService.resolve()` already established),
  giving a precise 422 (`DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED` /
  `DELEGATION_MONTHLY_LIMIT_EXCEEDED` / `DELEGATION_CATEGORY_NOT_ALLOWED`
  / `DELEGATION_CURRENCY_MISMATCH`) with no `Payment` row ever created
  on a violation. The actual race-safe gate is
  `DelegationPort.tryReserveSpend()` — a single row-locked
  `UPDATE ... WHERE` (the same atomic-conditional-update pattern this
  codebase already uses for `markReserveReleased()`/`markKycCleared()`/
  `markTransferInitiated()`) that rolls the monthly spend bucket over to
  the current calendar month if needed *and* checks both limits *and*
  reserves the amount, all in one statement — verified directly against
  Postgres via `psql` before writing any e2e test: confirmed the
  reservation correctly accumulates (3000→6000→9000), correctly rejects
  a 4th reservation that would cross a 10000 monthly cap (0 rows,
  balance unchanged), correctly rejects a single reservation exceeding
  the per-transaction cap even though the monthly cap alone would allow
  it, and correctly resets the bucket on a simulated month rollover
  instead of accumulating into the new month's spend.
- **A declined charge releases its reservation.** `PaymentController.charge()`
  calls `DelegationService.releaseReservation()` if the saga throws or
  returns `FAILED`, but deliberately *not* on `SUCCEEDED`/
  `REQUIRES_CAPTURE`/`REQUIRES_ACTION` — money might still move for
  those. A definite decline doesn't permanently eat into the agent's
  budget.
- **Revocation reuses the existing JWT jti-revocation mechanism
  verbatim** — `POST /delegations/:id/revoke` calls the same
  `TokenRevocationService.revokeToken()` `POST /auth/revoke` (logout)
  already relies on, so a revoked delegation's still-unexpired token is
  rejected on its very next request (401 `TOKEN_REVOKED`), not just once
  it naturally expires. No second revocation mechanism was invented for
  agent tokens specifically.
- **Attribution on the audit trail.** An agent-initiated charge stores
  `{ delegationId, initiatedBy: 'agent' }` on `Payment`'s existing
  `payment_metadata` jsonb bag (`PaymentMetadata.metadata` — already
  there, previously never populated by any caller) via a new
  `CheckoutSagaInput.initiatorMetadata` field — no schema change, and
  every other caller of the saga is unaffected since the field is
  optional and simply omitted.
- **No HMAC signature required for an agent call.** `HmacSignatureGuard`
  now exempts an `AGENT`-authenticated request (checked via
  `request.user.roles`, populated by `JwtAuthGuard` which runs first) —
  handing an agent the merchant's own HMAC secret would defeat the point
  of a narrow, separately-revocable credential. The delegation JWT's own
  possession (plus its real-time revocation check) is this MVP's
  authenticity proof for an agent request instead.

Verified against real infrastructure: sanity-tested the atomic
`tryReserveSpend()` SQL directly against Postgres via `psql` (see
above) before writing any application code around it. New
`test/agentic-payments.e2e-spec.ts` (9 tests): delegation creation +
an in-policy charge succeeds with no HMAC headers and records
attribution on a fresh DB read; per-transaction/monthly/category/currency
violations are each rejected with their specific code and (for the
per-transaction case) create no `Payment` at all; cumulative charges
correctly reject only the one that would cross the monthly cap without
disturbing the already-reserved spend; revoking takes effect
immediately (401 on the very next request) and a second revoke attempt
is rejected 409; a PSP decline (`carddeclined` mock-psp marker) releases
its reservation, proven by a follow-up charge that would otherwise have
exceeded the monthly cap still succeeding; an agent token is rejected
403 on `GET /subscriptions`, `GET /delegations`, and `POST /plans`; and
merchant ownership isolation on the delegation admin endpoints. Full
suite (`npm test` 18/18, `npm run test:e2e` 161/161) passes; a
transient run hit the already-documented full-suite-scale rate-limit
burst flake across `webhooks.e2e-spec.ts`/`dispute-policy.e2e-spec.ts`
(429s), reconfirmed clean both in isolation and on a repeat full-suite
run, unconnected to this round's code — the same class of flakiness
already documented, just a different pair of suites catching it than
in a prior round.

**Known simplifications**: no human-approval step for above-threshold
purchases (a charge either fits the policy or is rejected outright —
no "hold for human review" intermediate state); no agent-specific risk
scoring (`calculateRiskScore()` treats an agent-initiated charge
identically to a human one); no per-request agent signing (the JWT
itself is this MVP's authenticity proof, a bearer token same as any JWT
here); and this implements the durable underlying mechanism rather than
any one of Stripe's/Google's/etc. still-evolving wire protocols. See
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#agentic-payments)
for the fuller framing.

---

## Future Business-Domain Expansion

Everything above this line (Tiers 1–3) is about closing gaps in
capabilities that already exist. This section is different: **new business
directions beyond a single one-time charge** — each bullet below now has
a real mechanism built (Tier 3 above), but started from nothing this
system originally modeled at all. The domain-language version of each
direction — written independent of implementation, readable without
touching code — lives in
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md).
This section summarizes each and gives the *technical* entry point for
starting it; that file gives the *business* reasoning in full.

- **Recurring billing / subscriptions (core mechanism, plan catalog,
  proration, downgrade credits, dunning backoff, event emission, trial
  verification, and decline-code-aware dunning all done)** — the
  `Subscription` aggregate, billing sweep, a reusable `Plan` catalog,
  mid-cycle plan-change proration (upgrade charge or downgrade credit),
  a real day 1/3/7 dunning backoff that now skips straight to
  cancellation on a hard decline instead of retrying one, real
  `subscription.past_due`/`subscription.canceled` event emission
  (carrying the decline code), and a real
  SetupIntent/zero-value-authorization payment method verification
  before a trial ever starts are now real, Tier 3 above. What's still
  missing: a real notification integration actually subscribed to the
  events this system now emits, and a properly calibrated (rather than
  illustrative) hard-decline code set.
- **Marketplace & split payments (charge-time splits, refund/dispute-loss
  reversal, payout scheduling, KYC gating, and real transfer initiation —
  all done)** — the platform/connected-account relationship, charge-time
  split rules, proportional refund/dispute-loss reversal, batched payout
  scheduling with a rolling reserve, a real (mocked) KYC review gating
  payouts (not charges), and real (mocked) bank-transfer initiation are
  now real, Tier 3 above. What's still missing: a real KYC review (the
  mock decision is synchronous and marker-driven, not an actual
  reviewer); a follow-up transfer for a reserve released after its
  payout's net amount was already sent; and a real bank/ACH/wire rail
  (the mock resolves "sent" synchronously, a real one settles over days).
- **Merchant risk tiering & reserves (mechanism and a basic auto-policy
  done, real underwriting still open)** — the reserve-hold mechanism and
  a working `RiskTieringService` (trailing lost-dispute rate ->
  `reserveBps`/`reserveHoldDays`, both directions, with a manual-override
  escape hatch) are now real, Tier 3 above. What's still missing is a
  *real* risk model: the three tiers built here are deliberately simple,
  round thresholds illustrating the mechanism, not something calibrated
  against real fraud/chargeback data. A production system would also
  weigh MCC code, account tenure, and dispute *reason* codes (fraud vs.
  "product not as described" carry very different signal) rather than a
  single lost-dispute-rate number, and would probably use a continuous
  function instead of 3 buckets.
- **Dispute resolution policy layer (mechanism done, real calibration
  still open)** — auto-accept/contest by amount and reason code,
  reason-code-specific evidence guidance, and a structured
  `dispute.created`/`dispute.resolved` notification hook are now real,
  Tier 3 above. What's still missing: the thresholds/reason table are
  illustrative, not calibrated against real chargeback win-rate data. The
  connection between this and `RiskTieringService` is one-way —
  `RiskTieringService` already reads dispute *outcomes* (lost-dispute
  rate) to set a merchant's reserve, but the dispute policy doesn't read
  a merchant's risk tier back to inform auto-accept/contest decisions.
  Also missing: decline-code-nuanced learning from past outcomes, and no
  actual email/Slack/paging integration subscribed to the new event hook
  yet.
- **Cross-border settlement & tax (VAT/tax and a real hedging product
  remain open)** — the settlement-conversion mechanism, refunds/lost
  disputes netting cleanly against it, and presentment currency are all
  done, Tier 3 above. What's still open: jurisdiction-specific tax
  handling isn't modeled at all, and there's no hedging/rate-lock
  *product* for a merchant who wants a guaranteed rate before a charge
  even happens — this system quotes at charge time and nothing before
  that. "Who bears FX risk" is now answered in the narrow sense that
  matters for a given payment's own lifecycle (the platform, by locking
  the charge-time rate and reusing it for that payment's refunds/disputes
  — see Tier 3 above) but not in the broader sense of a merchant wanting
  to lock in a rate *before* committing to a sale.
- **Agentic payments (delegation + spend-policy enforcement done, human-
  approval/agent-specific risk scoring still open)** — a merchant can now
  authorize an autonomous agent via a real, atomically-enforced
  `Delegation`/`SpendPolicy` (per-transaction limit, rolling monthly
  limit, category allowlist), scoped to exactly one route
  (`POST /payments/charge`) and revocable in real time via the existing
  JWT jti-revocation mechanism, Tier 3 above. What's still missing: no
  "hold for human approval" above a threshold (a charge either fits the
  policy or is rejected outright); no agent-specific risk scoring
  (`calculateRiskScore()` treats an agent charge like a human one); and
  no per-request agent signing (the delegation JWT's own possession is
  this MVP's authenticity proof).

### AI agents / agentic payments

The core mechanism — `Delegation`/`SpendPolicy`, scoped and revocable
agent credentials, atomic spend-policy enforcement before a PSP is ever
called — is now real; see "Agentic payments (delegation + spend policy)
— ✅ resolved" above for what was built and how it was verified, and
[`docs/business-domain/future-directions.md`](docs/business-domain/future-directions.md#agentic-payments)
for the business framing. What follows is the technical detail on the
genuinely remaining gaps, deliberately left open because they're new
design surface, not oversights:

- **Pre-authorized intents with a human-approval step.** The business
  framing this section originally called for ("ask me first for
  anything above $200") isn't built — `reserveSpendOrThrow()` either
  admits a charge or rejects it outright; there's no "hold pending human
  review" intermediate state. That's a genuinely new async flow (the
  charge request would need to pause, not just succeed/fail synchronously)
  closer to Stripe's SetupIntent/mandate model than an extension of the
  current reserve-then-charge path.
- **Risk scoring for non-human initiators.** `PaymentAggregate.calculateRiskScore()`
  still reasons about amount and card origin only — an agent-initiated
  charge is scored identically to a human one. A real model would weigh
  velocity within the agent's own spend policy and whether this
  agent/principal pairing has transacted with this merchant before.
- **Per-request agent signing.** `HmacSignatureGuard` exempts an
  `AGENT`-authenticated request from the HMAC requirement entirely
  (see that guard's docblock) rather than requiring a per-agent signing
  key — the delegation JWT's own bearer-token possession is this MVP's
  authenticity proof. Extending HMAC-style request signing to
  per-agent keys (rather than the merchant's own secret, which an agent
  should never hold) is real, scoped follow-up work, not a gap in the
  underlying mechanism.
- **Standards alignment.** Stripe's agentic commerce tooling, Google's
  Agent Payments Protocol, and various agent-to-agent authorization
  proposals are all still evolving; `Delegation`/`SpendPolicy` implement
  the durable business mechanism these are converging toward, not any
  one specific wire format — a real integration with an external
  standard would likely translate onto this domain model rather than
  replace it.

---
