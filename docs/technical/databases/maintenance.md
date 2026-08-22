# Database Maintenance

An index of every recurring or one-time operational task against this
database, and where each one is actually documented in full — this
page is intentionally short and mostly links out, rather than
duplicating content that already has a canonical home.

## Schema changes

Handled by TypeORM migrations, never `synchronize: true` (disabled
unconditionally, in every environment). Full workflow, the
`data-source.ts`/`app.module.ts` dual-registration gotcha, and a real
bug this process surfaced are in
[`../database-migrations.md`](../database-migrations.md).

## Partition maintenance

`payments`/`ledger_outbox` need a partition pre-created for each
upcoming month on an ongoing basis — see
[`architecture.md#partitioning`](./architecture.md#partitioning) for
why this doesn't happen automatically. Enforced by a weekly CronJob.

- **Design**: [`../jobs.md`](../jobs.md)
- **Day-2 operation**: [`../../guide/jobs/partition-maintenance.md`](../../guide/jobs/partition-maintenance.md)

## Archiving and deletion (AML data retention)

Two scheduled jobs move aging `payments`/`ledger_outbox` rows through
a three-tier policy (live → `archive` schema → backed-up-and-deleted).

- **Policy and eligibility rules**: [`../../compliance/data-retention.md`](../../compliance/data-retention.md)
- **Design**: [`../jobs.md`](../jobs.md)
- **Day-2 operation**: [`../../guide/jobs/data-retention-jobs.md`](../../guide/jobs/data-retention-jobs.md)

## Legal hold

Excludes a specific payment from both jobs above regardless of age or
status, via a single boolean column (`payments.legal_hold`) and an
admin HTTP endpoint — not a recurring job itself, but part of the same
retention story.

- **Design and API**: [`../../compliance/data-retention.md#legal-hold`](../../compliance/data-retention.md#legal-hold)
- **Endpoint reference**: [`../../guide/api/platform-ops.md`](../../guide/api/platform-ops.md#legal-hold-adminpaymentsidlegal-hold)

## Partitioning-cutover cleanup (one-time)

Drops `payments_old`/`ledger_outbox_old` (the pre-partitioning safety
net) once a retention window has elapsed since the cutover. Not a
recurring job — a single event in this project's history, run once and
then largely irrelevant afterward.

- **Design**: [`architecture.md#partitioning`](./architecture.md#partitioning)
  and [`../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old`](../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old)
- **Day-2 operation**: [`../../guide/jobs/cutover-tables-cleanup.md`](../../guide/jobs/cutover-tables-cleanup.md)

## Replication and connection pooling

Not something an operator routinely maintains by hand (streaming
replication is self-sustaining once established; PgBouncer just runs),
but worth knowing the shape of if either ever needs troubleshooting —
see [`architecture.md`](./architecture.md#masterreplica-streaming-replication).
`postgres-replica`'s bootstrap (`pg_basebackup` against the master,
`primary_conninfo` in `postgres.auto.conf`) is defined in
`docker-compose.yml` for local dev; a real deployment's managed
Postgres service (RDS, Cloud SQL, etc.) typically handles this
natively rather than needing the same manual bootstrap.

## What this page doesn't cover

Routine Postgres housekeeping this project relies on the platform for
rather than scripting itself — `VACUUM`/`ANALYZE` (autovacuum is left
at its defaults; no custom tuning has been done or benchmarked for
this schema's write pattern), backup/point-in-time-recovery (out of
scope for an application-level repo — a real deployment's managed
Postgres service or its own infrastructure-as-code owns this), and
extension management (`pg_stat_statements` is enabled by
`scripts/postgres/init-master.sql` for query-performance visibility,
but nothing here automates reviewing it). These are real gaps for a
production deployment to close, not implemented placeholders.
