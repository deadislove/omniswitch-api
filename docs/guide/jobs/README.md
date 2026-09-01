# Background Jobs

This is the operator's guide to every recurring or one-time job that
runs *outside* the request/response cycle of the API itself —
data-retention (archiving/deletion), partition maintenance, and the
one-time partitioning-cutover cleanup. If you're trying to understand
the compliance/business *policy* these jobs enforce (retention periods,
what "eligible" means), start at
[`../../compliance/data-retention.md`](../../compliance/data-retention.md)
instead — this folder is about *running and operating* them. For the
engineering design behind how they're built (why standalone scripts,
why `CronJob` instead of `@Cron()`, the `BackupStorage` factory
pattern), see [`../../technical/jobs.md`](../../technical/jobs.md).

## The jobs

| Job | Script | k8s resource | Schedule | Guide |
|---|---|---|---|---|
| Archiving | `src/jobs/run-archiving-job.ts` | `k8s/archiving-cronjob.yaml` (CronJob) | Daily, 03:00 | [`data-retention-jobs.md`](./data-retention-jobs.md) |
| Deletion | `src/jobs/run-deletion-job.ts` | `k8s/deletion-cronjob.yaml` (CronJob) | Weekly, Sun 04:00 | [`data-retention-jobs.md`](./data-retention-jobs.md) |
| Partition maintenance | `src/jobs/create-partitions-job.ts` | `k8s/partition-maintenance-cronjob.yaml` (CronJob) | Weekly, Sun 05:00 | [`partition-maintenance.md`](./partition-maintenance.md) |
| Cutover-table cleanup | `src/jobs/drop-cutover-tables.ts` | `k8s/drop-cutover-tables-job.yaml` (Job, one-time) | Manual | [`cutover-tables-cleanup.md`](./cutover-tables-cleanup.md) |

## Rules that apply to every job here

**Never run one of these via `kubectl exec` into a running
`omniswitch-api` Deployment pod.** That pod exists to serve traffic —
it can be rescaled by the HPA (`k8s/hpa.yaml`, up to 20 replicas) or
recycled by a rolling update at any moment, mid-operation, with no
warning to whatever you were running inside it. Every job in this list
instead gets its own dedicated, disposable pod — a `CronJob` for
anything recurring, a one-time `Job` for anything that runs once. This
is a hard requirement in this codebase, not a style preference; see
[`../../technical/jobs.md`](../../technical/jobs.md) for the full
reasoning.

**Every job pod carries `workload-type: batch-job`** (vs.
`workload-type: service` on the API Deployment's own pods), both at the
resource's own `metadata.labels` and its pod template's
`spec.template.metadata.labels`. This lets you select every
maintenance/batch pod at once, independent of which specific job it is:

```bash
kubectl get pods -n payments -l workload-type=batch-job
```

**Every job is a short-lived CLI process that logs one structured JSON
line on completion**, not a long-running server `prom-client` can
scrape mid-run. Grep the pod's logs for the summary rather than looking
for a metrics endpoint:

```bash
kubectl logs -n payments job/<job-name>
```

A failed run logs `"status":"failed"` with an `"error"` field and exits
non-zero — visible either in that log line or via `kubectl get jobs -n
payments` (`FAILED` column).

**Every job is safe to re-run.** Each one's own guide below notes the
specific idempotency mechanism (a repeatable `SELECT` for
archiving/deletion, `CREATE TABLE IF NOT EXISTS` for partition
maintenance, a retention-window check that's a no-op until it elapses
for cutover cleanup) — re-running after a failure, or just to confirm
nothing was missed, is always safe.

**Local/dev**: every job also has an `npm run job:*` script
(`job:archive`, `job:delete`, `job:create-partitions`,
`job:drop-cutover-tables`) that runs it directly against whatever
`DB_MASTER_HOST` etc. your shell has configured — no k8s needed. This
is the same code path the CronJob/Job containers run in production,
just invoked via `ts-node` instead of a compiled image.
