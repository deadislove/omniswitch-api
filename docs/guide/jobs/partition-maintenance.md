# Partition Maintenance

Operator runbook for `omniswitch-partition-maintenance`
(`src/jobs/create-partitions-job.ts`). For the underlying design (why
`payments`/`ledger_outbox` are partitioned, why this job needs to
exist at all) see
[`../../technical/databases/architecture.md`](../../technical/databases/architecture.md#partitioning)
and
[`../../compliance/data-retention.md#partition-maintenance`](../../compliance/data-retention.md#partition-maintenance).

## What it does

`payments` and `ledger_outbox` are Postgres range-partitioned by
`created_at`, one partition per calendar month. The migration that
first set this up only pre-created partitions for a fixed window
relative to when *it* ran (6 months back, 2 forward) — nothing
automatically keeps extending that window as real time moves past it.
This job does that extension: on every run, it ensures a partition
already exists for the current month through
`PARTITION_MAINTENANCE_MONTHS_AHEAD` months ahead (default 2), on both
tables.

Runs weekly, Sunday 05:00 — after archiving (03:00) and deletion
(04:00) (`k8s/partition-maintenance-cronjob.yaml`).

## Why you should care if this stops running

If a scheduled month's partition is never created, new rows for that
month don't fail to insert — Postgres falls back to the `DEFAULT`
partition, silently. There's no error, no rejection, just a slow loss
of the reason partitioning exists in the first place (query pruning,
bounded per-partition index size — see
[`../../technical/databases/architecture.md`](../../technical/databases/architecture.md)).
This is the main thing to watch for if this CronJob has been failing
or missed: check whether `payments_partitioned_default` /
`ledger_outbox_partitioned_default` has been accumulating rows it
shouldn't have.

```sql
SELECT count(*) FROM payments_partitioned_default;
SELECT count(*) FROM ledger_outbox_partitioned_default;
```

Either being non-zero for a recent date means this job fell behind —
run it manually (below), then investigate why the schedule missed.

## Manual run

```bash
kubectl create job --from=cronjob/omniswitch-partition-maintenance manual-partition-maint-$(date +%s) -n payments
kubectl logs -n payments job/manual-partition-maint-<timestamp> -f
```

**Local/dev:**

```bash
npm run job:create-partitions
```

## Success log line

```json
{"job":"partition-maintenance","monthsAhead":2,"partitionsChecked":6,"partitionsCreated":[],"durationMs":42,"status":"success"}
```

`partitionsChecked` is always `2 × (monthsAhead + 1)` (current month
through `monthsAhead` ahead, on both tables) — a fixed number every
run. `partitionsCreated` is the list of tables this specific run
actually had to create; an **empty array is the expected steady-state
result**, not a sign something's wrong — it means every partition in
range already existed. Only the first run after a gap (or the very
first run after this CronJob was deployed) should show entries here.

## Naming, if you're ever reading the schema directly

Child partitions are named `payments_partitioned_YYYY_MM` /
`ledger_outbox_partitioned_YYYY_MM` — **not** `payments_YYYY_MM` — even
though the parent tables are `payments`/`ledger_outbox`, not
`payments_partitioned`. This job matches that existing naming
convention deliberately; see
[`../../technical/databases/architecture.md`](../../technical/databases/architecture.md#partitioning)
for why (the partitioning cutover migration renamed only the parent
table, and Postgres doesn't cascade a parent rename to its child
partitions).

## Failure modes

This job runs a handful of lightweight DDL statements
(`CREATE TABLE IF NOT EXISTS ... PARTITION OF`), not a data-volume
operation — `activeDeadlineSeconds: 600` in the CronJob spec reflects
that. A failure here is almost always a connection issue or a
permissions problem (the DB role running migrations/jobs needs
`CREATE` on the parent tables), not a data problem. It's always safe
to just re-run — `IF NOT EXISTS` means a partial prior run left
nothing to clean up.
