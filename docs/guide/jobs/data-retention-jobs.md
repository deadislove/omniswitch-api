# Data-Retention Jobs (Archiving + Deletion)

Operator runbook for the two jobs that enforce the three-tier
retention policy. For *what* they do and why (eligibility rules,
retention periods, legal hold) see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md)
— this doc only covers running and troubleshooting them.

## Archiving (`omniswitch-archiving`)

Moves eligible `payments`/`ledger_outbox` rows from the live tables
into the `archive` schema, in one transaction per call. Runs daily at
03:00 (`k8s/archiving-cronjob.yaml`).

**Manual run:**

```bash
kubectl create job --from=cronjob/omniswitch-archiving manual-archive-$(date +%s) -n payments
kubectl logs -n payments job/manual-archive-<timestamp> -f
```

**Local/dev:**

```bash
npm run job:archive
```

**Success log line:**

```json
{"job":"archiving","archiveThresholdDays":180,"paymentsEligible":2,"paymentsArchived":2,"ledgerOutboxEligible":3,"ledgerOutboxArchived":3,"durationMs":726,"status":"success"}
```

`paymentsEligible`/`paymentsArchived` (and the `ledgerOutbox*`
equivalents) are normally equal — a lower `*Archived` count than
`*Eligible` means a concurrent process archived some of the same rows
between the count and the insert (harmless — `ON CONFLICT DO NOTHING`
skips them, they'll simply not show up as newly archived on this run).

**If it fails**, the log line has `"status":"failed"` and an `"error"`
field with the underlying Postgres/driver error message — that's
usually enough to diagnose (connection failure, a constraint violation
if the schema drifted from what the job expects). The job made no
partial changes: it fails inside a single transaction, so a failure
here never leaves some rows archived and others not.

## Deletion (`omniswitch-deletion`)

Backs up (see "Where the backup goes" below) then permanently deletes
`archive.payments`/`archive.ledger_outbox` rows past
`DELETION_THRESHOLD_YEARS`. Runs weekly, Sunday 04:00 — after archiving
has had a chance to run first (`k8s/deletion-cronjob.yaml`).

**Manual run:**

```bash
kubectl create job --from=cronjob/omniswitch-deletion manual-deletion-$(date +%s) -n payments
kubectl logs -n payments job/manual-deletion-<timestamp> -f
```

**Local/dev:**

```bash
npm run job:delete
```

**Success log line:**

```json
{"job":"deletion","deletionThresholdYears":8,"backupRequired":true,"paymentsEligible":1,"paymentsDeleted":1,"ledgerOutboxEligible":0,"ledgerOutboxDeleted":0,"backupFile":"/app/backups/deletion-backup-2026-08-22T05-00-00-000Z.json","status":"success"}
```

`backupFile` is the location identifier the configured `BackupStorage`
adapter returned — a filesystem path for `local`, an `s3://`/`gs://`
URI or an HTTPS blob URL for the cloud adapters (see
[`../../technical/clouds/README.md`](../../technical/clouds/README.md)).
`null` means there was nothing eligible to delete this run — not a
failure.

**If it fails**, check `"error"` in the failed log line first. Two
failure modes are worth knowing apart:

- **Backup write failed** (network error, bucket/container
  misconfigured, disk full on the mounted PVC): the job throws before
  attempting any `DELETE` — nothing was removed from `archive.*`. This
  is deliberate (`DELETION_BACKUP_REQUIRED` defaults to `true`) — see
  `../../compliance/data-retention.md`'s configuration reference. Fix
  the backup destination and re-run; the same rows will still be
  eligible.
- **Delete failed after a successful backup**: rarer, but possible
  (connection drop mid-transaction). The backup file already exists
  and is valid — check `backupFile` in the failed run's log (if it got
  that far) or check the destination directly. Re-running is still
  safe; it'll just produce a second backup file for the same
  now-still-eligible rows, which is a harmless duplicate, not a data
  problem.

### Where the backup goes

Selected via `DELETION_BACKUP_STORAGE` (`local` default, or
`s3`/`gcs`/`azure`) — see
[`../../technical/clouds/README.md`](../../technical/clouds/README.md)
for provider-specific setup, credentials, and troubleshooting, and
[`../../compliance/data-retention.md`](../../compliance/data-retention.md#where-the-backup-goes)
for the full config reference and why `local` is the default.

## Configuration

Both jobs read their thresholds from `k8s/configmap.yaml` — see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md#configuration-reference)
for the full table. Changing a threshold is a config change, not a
code change:

```bash
kubectl edit configmap omniswitch-config -n payments   # or: apply an edited k8s/configmap.yaml
```

The change takes effect the next time either `CronJob` fires — no
restart or redeploy needed for the running API, since these jobs are
their own pods that read the ConfigMap fresh on every run. To apply a
threshold change immediately rather than waiting for the schedule, use
the manual-run commands above.

## Legal hold interaction

A payment with `legal_hold = true` is skipped by both jobs regardless
of age, status, or dispute state — see
[`../../compliance/data-retention.md#legal-hold`](../../compliance/data-retention.md#legal-hold)
and the admin endpoints in
[`../api/platform-ops.md#legal-hold-adminpaymentsidlegal-hold`](../api/platform-ops.md#legal-hold-adminpaymentsidlegal-hold).
If a payment you expected to be archived/deleted wasn't, checking
whether it's under an active hold is one of the first things to rule
out.
