# Table Reference

One row per table: what it's for, which schema it lives in, and where
its authoritative column list actually is. Column lists aren't
reproduced here — see [`erd.md`](./erd.md#where-to-find-the-authoritative-column-list)
for why; the entity file (or the migration, for tables with no entity)
is always the current, exact answer, and a hand-copied list here would
drift the first time someone adds a column and forgets this doc.

## `public` schema — live, hot-path tables

| Table | Entity file | Purpose |
|---|---|---|
| `merchants` | `src/modules/merchant/merchant.entity.ts` | Tenant identity: credentials, MFA, fee/reserve policy, marketplace account type, KYC status |
| `payments` | `src/modules/payment/adapters/persistence/entities/payment.entity.ts` | The core payment record — one row per charge attempt, its refunds/captures, PSP response, FX/settlement/split data. **Range-partitioned by `created_at`** — see [`architecture.md`](./architecture.md#partitioning) |
| `ledger_outbox` | `.../entities/ledger-outbox.entity.ts` | Transactional Outbox pattern — double-entry ledger events written atomically with the payment state change that confirms them, relayed asynchronously. **Also partitioned** by `created_at`. See [`../../business-domain/ledger-and-settlement.md`](../../business-domain/ledger-and-settlement.md) |
| `disputes` | `.../entities/dispute.entity.ts` | Chargeback/dispute lifecycle (`NEEDS_RESPONSE` → `UNDER_REVIEW` → `WON`/`LOST`), one row per PSP dispute |
| `reserve_holds` | `.../entities/reserve-hold.entity.ts` | Per-charge risk reserve withholding — released by a sweep or an operator override |
| `subscriptions` | `.../entities/subscription.entity.ts` | Recurring billing state machine: current period, dunning/retry schedule, optional `plan_id` |
| `plans` | `.../entities/plan.entity.ts` | Merchant-scoped reusable price catalog a subscription can reference instead of carrying its own amount |
| `payouts` | `.../entities/payout.entity.ts` | Scheduled marketplace payout to a `CONNECTED` merchant — KYC gating, reserve, transfer status |
| `payout_sweep_runs` | `.../entities/payout-sweep-run.entity.ts` | One row per daily payout-batching sweep — audit record of when a sweep ran and how many merchants it paid |
| `delegations` | `.../entities/delegation.entity.ts` | Agentic-payment credentials: an agent's spend policy, current-month spend counter, token expiry/revocation |
| `reconciliation_runs` | `.../entities/reconciliation-run.entity.ts` | One row per ledger-vs-PSP-settlement diff run, with any mismatches found in a `jsonb` array — see [`../reconciliation.md`](../reconciliation.md) |
| `schema_cutover_log` | `src/database/migrations/1787339024677-CreateSchemaCutoverLog.ts` (no entity — read only by `drop-cutover-tables.ts`) | Tracks when the partitioning cutover ran, per legacy table, so `drop-cutover-tables.ts` can compute the retention window without guessing from a file timestamp |

**Not currently in a tracked entity list above, but present in the
schema**: `payments_old`, `ledger_outbox_old` — the pre-partitioning
flat tables kept as a cutover safety net. See
[`../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old`](../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old)
and [`../../guide/jobs/cutover-tables-cleanup.md`](../../guide/jobs/cutover-tables-cleanup.md).
These have no TypeORM entity at all — the app never queries them; only
`drop-cutover-tables.ts` touches them, via raw SQL.

## `archive` schema — cold storage

Created by `1787334795968-CreateArchiveSchema.ts`. No TypeORM entities
either — `run-archiving-job.ts`/`run-deletion-job.ts`/
`legal-hold.service.ts` are the only code that ever reads or writes
these tables, all via raw SQL through a plain `DataSource`/`AppDataSource`
(see [`../jobs.md`](../jobs.md) for why these don't go through
`PaymentRepositoryPort`/`PaymentAggregate` the way live-table access
does).

| Table | Mirrors | Purpose |
|---|---|---|
| `archive.payments` | `public.payments`, minus partitioning, plus `archived_at` | Cold storage for payments past `ARCHIVE_THRESHOLD_DAYS` — see [`../../compliance/data-retention.md`](../../compliance/data-retention.md) |
| `archive.ledger_outbox` | `public.ledger_outbox`, minus partitioning, plus `archived_at` | Cold storage for the corresponding ledger events |

One real type difference to know about if you're writing raw SQL
against `archive.payments`: its `status` column is a plain `varchar`,
while `public.payments.status` is a real Postgres enum
(`payments_status_enum`). Postgres has no implicit `varchar`→`enum`
cast — `legal-hold.service.ts`'s archive-restore path needs an explicit
`"status"::"payments_status_enum"` cast in its `INSERT ... SELECT`, and
any future code moving a row from `archive.payments` back into
`public.payments` will need the same cast.

## Enum types

| Type | Used by | Values |
|---|---|---|
| `payments_status_enum` | `public.payments.status` only (`archive.payments.status` is `varchar`, see above) | See `PaymentStatus` in `src/modules/payment/domain/value-objects/payment-status.vo.ts` for the authoritative list and the state machine it drives — [`../../business-domain/payment-lifecycle.md`](../../business-domain/payment-lifecycle.md) |

Every other "status"-shaped column in this schema (`disputes.status`,
`ledger_outbox.status`, `subscriptions.status`, `delegations.status`,
`payouts.transfer_status`, `reserve_holds.status`) is a plain `varchar`
with the valid set enforced in application code (the aggregate's own
state-machine methods), not a Postgres `enum` type or `CHECK`
constraint — `payments.status` is the one exception, inherited from
this project's original schema before the wider pattern was
established, kept as-is rather than migrated for consistency's own
sake.
