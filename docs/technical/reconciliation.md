# Reconciliation

## What this closes

Nothing previously compared this system's ledger against the PSP's own
record of what actually settled. Every other safety mechanism in this
codebase — the outbox pattern, double-entry validation, idempotency — only
protects the *internal* consistency of this system's own writes. None of
them can catch a bug where this system's ledger and the PSP's books
silently disagree (a missed webhook, a bug in how a status transition maps
to a ledger entry, a charge that succeeded at the PSP but the response
never made it back here). Reconciliation is an external check: it treats
the PSP's settlement report as ground truth and diffs this system's records
against it.

## Design

`ReconciliationService.reconcile(pspProvider, since, until)`
(`src/modules/payment/application/services/reconciliation.service.ts`):

1. Fetches, in parallel:
   - Our own records: `PaymentRepositoryPort.findByProviderAndDateRange()`
     — payments in a "money actually moved" status (`SUCCEEDED`,
     `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`) for that provider and
     window. A later refund or dispute doesn't retroactively mean the
     original charge shouldn't still match a PSP settlement record.
   - The PSP's own records: `PSPAdapterPort.fetchSettlementTransactions()`
     — Stripe's balance transactions API, Adyen's settlement report API (in
     this reference project, `scripts/mock-psp/server.js`'s
     `GET /v1/balance_transactions` and `GET /adyen/settlement-report`).
2. Matches by `pspTransactionId` and produces three mismatch shapes, not
   just a single "doesn't match" bucket — each implies a different root
   cause and a different response:
   - **`MISSING_AT_PSP`** — we have a charge on the books; the PSP has no
     matching settlement record in this window. The dangerous direction:
     money we believe we collected but may not have.
   - **`AMOUNT_MISMATCH`** — both sides agree a transaction happened, but
     not on how much.
   - **`UNKNOWN_AT_PSP`** — the PSP settled something we have no record of
     at all. Could mean a missed webhook, or a charge that bypassed this
     system entirely.
3. Persists every run (`ReconciliationRun` / `reconciliation_runs` table),
   clean or not — a clean run is itself evidence, not just a non-event.
4. Logs an error per mismatch (same posture as
   `LedgerOutboxRelayService.detectStaleEvents()` — see
   [`ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md));
   in production this is where paging on-call/finance would be wired in.

Runs automatically every hour (`@Cron(CronExpression.EVERY_HOUR)`) for each
of `STRIPE`/`ADYEN` independently — one provider's PSP being unreachable
doesn't block the other from being checked. Also available on demand via
`ReconciliationAdminController` (`GET /api/v1/admin/reconciliation/runs`,
`POST /api/v1/admin/reconciliation/run`; ADMIN/OPERATOR only).

## `Date` objects silently shift by the host machine's timezone

This isn't a bug in the reconciliation feature itself — it's a bug in
this codebase's query layer that reconciliation depends on precisely
enough to expose.

**Symptom**: reconciling a payment charged seconds earlier against a "last
hour" window returned zero of our own payments — `transactionsChecked`
counted only the PSP's side. On a machine in UTC, the same code worked.

**Root cause**: `PaymentEntity.createdAt` (and `LedgerOutboxEntity.createdAt`)
are `timestamp without time zone` columns — TypeORM's `@CreateDateColumn()`
default. When a TypeORM `QueryBuilder` binds a raw JS `Date` object as a
parameter (`.andWhere('p.createdAt >= :fromDate', { fromDate })`), the
`pg` (node-postgres) driver serializes that `Date` using **the Node
process's local machine timezone offset**, not UTC, whenever the target
column is untyped/naive. On a UTC+8 development machine, that silently
shifted every date-range comparison by 8 hours — a payment charged a moment
ago fell outside a query for "the last hour," because the bound parameter
was quietly compared as if it were 8 hours further in the future than it
actually was.

Ruling out replication lag (the natural first suspect given this
project's master/replica setup): the row exists on both the Postgres
master and replica via direct `psql` queries. The same zero-result
behavior reproduces in an isolated script with no NestJS/TypeORM DI
involved, connecting directly to the master with no replication config
at all — and switching that script's bound parameters to `.toISOString()`
strings instead of raw `Date` objects returns the expected row.

**Fix**: bind `.toISOString()` strings instead of raw `Date` objects for
every timestamp comparison against these columns. An ISO string is always
UTC and unambiguous; it sidesteps the driver's local-timezone serialization
path entirely rather than fighting it. Applied in
`src/modules/payment/adapters/persistence/repositories/payment-typeorm.repository.ts`
at three call sites:

- `PaymentTypeOrmRepository.findByMerchantId()` — the `fromDate`/`toDate`
  filter on `GET /payments` (pre-existing code, not introduced by this
  round).
- `PaymentTypeOrmRepository.findByProviderAndDateRange()` — the new query
  this reconciliation feature added; this is what surfaced the bug.
- `LedgerOutboxTypeOrmRepository.findStale()` — the cutoff query behind
  `LedgerOutboxRelayService.detectStaleEvents()`'s dead-letter alerting
  sweep (also pre-existing).

**Implication worth calling out explicitly**: `findStale()` is the query
that decides whether a stuck `PENDING` outbox event ever gets flagged. On
any development or production host running outside UTC, this comparison
was silently shifted the same way — meaning that alert was very likely a
silent no-op for as long as this bug existed, on any such host. This
codebase's own e2e tests never caught it because Jest/the e2e Postgres
containers in CI-style environments commonly run in UTC, where the bug is
invisible; it only reproduces on a non-UTC host. Worth treating as a
standing rule for this codebase: **never bind a raw `Date` object as a
TypeORM query parameter against a `timestamp without time zone` column —
always `.toISOString()` it first**, or migrate the column to
`timestamptz` (not done here, to keep this fix scoped to the actual bug
rather than a broader schema migration).

## Verification

- Cleared `payments`, `ledger_outbox`, and `reconciliation_runs`, and
  restarted `mock-psp` (its in-memory settlement records don't survive a
  restart, unlike the app's own Postgres-backed state) for a clean slate.
- Made a real charge through the running app, then triggered an on-demand
  `POST /api/v1/admin/reconciliation/run` for `STRIPE` covering the last
  hour: `transactionsChecked: 2` (our payment + the matching PSP settlement
  transaction), `status: "CLEAN"`, `mismatchCount: 0` — confirming the fix,
  since the same test before the fix produced a false `UNKNOWN_AT_PSP`
  mismatch (our payment wasn't found by the date-range query, but the PSP's
  side still returned the transaction, so it looked orphaned).
- Full regression after the fix: `npm test` (18/18) and `npm run test:e2e`
  (36/36) both pass — the fix touched shared query code
  (`findByMerchantId`, `findStale`), not just the new reconciliation path.
- `scripts/mock-psp/server.js` was extended with in-memory settlement
  tracking and two new read endpoints
  (`GET /v1/balance_transactions`, `GET /adyen/settlement-report`),
  smoke-tested directly with `curl` (immediate charge, manual capture +
  capture, listing) before wiring the real adapters to it.
- `ReconciliationService` has permanent automated coverage at both
  levels: `reconciliation.service.spec.ts` (unit, mocked ports — all
  three mismatch shapes, the partial-capture settlement-summing behavior,
  `runScheduled()`'s per-provider error isolation) and
  `test/reconciliation.e2e-spec.ts` (e2e, against real seeded data with
  all three mismatch shapes deliberately introduced in one run).

## What this doesn't cover

- **No automated remediation.** A mismatch is logged and persisted; nothing
  automatically corrects the ledger or retries anything. That's
  deliberate — a mismatch means the two systems disagree about what
  happened, which is exactly the situation where an automated "fix" could
  make things worse. Investigation and correction stay a human action.
- **No alerting integration.** The `logger.error()` calls are the
  integration point where a production deployment would page on-call or
  emit a metric an alert is wired to — nothing is actually wired up in
  this reference project, same posture as everywhere else `logger.error`
  is used as a stand-in for real alerting (see `ledger-and-settlement.md`'s
  outbox section, `distributed-state.md`).
- **Matching is by `pspTransactionId` only.** A charge that succeeded at
  the PSP but whose `pspTransactionId` was never persisted here (e.g. a
  crash between the PSP call succeeding and the DB write committing) would
  show up as `UNKNOWN_AT_PSP` rather than being linked back to a specific
  payment attempt — there's no fallback matching by amount/time/order ID.
