# Cutover-Table Cleanup (One-Time)

Operator runbook for `omniswitch-drop-cutover-tables`
(`src/jobs/drop-cutover-tables.ts`). Unlike every other job in this
folder, this is a **one-time operator action, not a recurring
schedule** — there's no CronJob for it, only a one-time `Job`
(`k8s/drop-cutover-tables-job.yaml`).

## What it does and why it exists

When `payments`/`ledger_outbox` were cut over to their partitioned
replacements, the original flat tables were renamed to `payments_old`/
`ledger_outbox_old` and kept — a safety net in case the cutover itself
had a bug, rather than an irreversible drop in the same migration. See
[`../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old`](../../compliance/data-retention.md#cutover-safety-net-tables-payments_old-ledger_outbox_old)
for the full reasoning, including why keeping them *indefinitely*
would actually undermine the retention policy (an ungoverned duplicate
that never ages out is a backdoor around the deletion tier).

This job drops those two tables, but only once
`CUTOVER_OLD_TABLE_RETENTION_DAYS` (default 60) has elapsed since the
cutover ran — tracked in a small `schema_cutover_log` table, not
guessed from a file timestamp or similar.

## Checking status without dropping anything

Running the job when the window hasn't elapsed yet is always safe — it
reports days remaining and exits `0`, not a failure:

```bash
kubectl apply -f k8s/drop-cutover-tables-job.yaml
kubectl logs -n payments job/omniswitch-drop-cutover-tables
```

```
"payments_old" not eligible yet — 12/60 days since cutover (48 day(s) remaining).
"ledger_outbox_old" not eligible yet — 12/60 days since cutover (48 day(s) remaining).
```

**Local/dev** (same output, against whatever DB your shell is
configured against):

```bash
npm run job:drop-cutover-tables
```

## Actually dropping the tables

Once the window has elapsed, re-running the exact same command performs
the drop:

```
Dropped "payments_old" (61 days since cutover, retention window 60 days).
Dropped "ledger_outbox_old" (61 days since cutover, retention window 60 days).
```

Each table is dropped in its own statement, and its
`schema_cutover_log` row is cleared immediately after — a table that's
already been dropped in a prior run (log row already cleared) simply
doesn't appear in a later run's output, rather than erroring.

## Re-running the k8s Job resource

A completed `Job` can't be re-applied under the same name — if you're
checking status again later (before the window elapses) or need to
retry, delete it first:

```bash
kubectl delete job omniswitch-drop-cutover-tables -n payments
kubectl apply -f k8s/drop-cutover-tables-job.yaml
```

## If nothing is tracked

```
No cutover tables tracked (already dropped, or this project never went through a partitioning cutover).
```

This is the expected steady-state after both tables have been dropped
— it's safe to stop applying this `Job` at that point; there's nothing
left for it to do.
