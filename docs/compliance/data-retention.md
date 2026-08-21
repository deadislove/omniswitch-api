# Data Retention (AML)

## Why this exists

AML (anti-money-laundering) regulation in most jurisdictions requires
payment records to be kept for a minimum period — commonly 5–10 years
depending on the country and regulator — for audit and investigation
purposes. This project didn't originally have a retention *or* deletion
story: `payments`/`ledger_outbox` just grew forever. The design work
behind this is in
[`../spec/future/database-scaling.md`](../spec/future/database-scaling.md)
Option 3 (that file is local-only, `.gitignore`'d — internal planning
history, not published); this doc is the tracked, public-facing
explanation of the mechanism that actually got built from it.

## The three-tier policy

| Tier | What | Trigger | Reversible? |
|---|---|---|---|
| **Live** | Normal hot-path table (`payments`, `ledger_outbox`) | — | — |
| **Archive** | Moved to a separate Postgres schema (`archive.payments`, `archive.ledger_outbox`) — same database, off the hot query path | Record is `ARCHIVE_THRESHOLD_DAYS` old (default **180**) **and** has no open dispute **and** isn't flagged as an unresolved reconciliation mismatch | Yes — the record still exists, just not in the live tables |
| **Delete** | Exported to a backup file, then removed from the database entirely | Record is `DELETION_THRESHOLD_YEARS` old (default **8**, counted from the record's *original* creation date, not when it was archived) | No, from the database — the backup file is the only remaining copy |

Two independent scheduled jobs enforce this — see "How it runs" below.
Neither tier ever touches a record with an open dispute, regardless of
age: an unresolved dispute means the record isn't actually settled yet,
and age alone doesn't change that.

## Configuration reference

All four thresholds are environment variables with safe defaults — none
of them are hardcoded in the job scripts. This is deliberate: this
project is a reference implementation meant to be deployed under
different jurisdictions' rules, and AML minimum retention periods
genuinely differ by country. **Changing these values does not require a
code change** — set them in `k8s/configmap.yaml` (or the equivalent
config mechanism for wherever this is actually deployed) and redeploy.

| Variable | Default | What it controls |
|---|---|---|
| `ARCHIVE_THRESHOLD_DAYS` | `180` | Age (days) before an eligible record moves from live tables to the `archive` schema |
| `DELETION_THRESHOLD_YEARS` | `8` | Age (years, from original `created_at`) before an archived record is backed up and deleted |
| `DELETION_BACKUP_REQUIRED` | `true` | Whether a successful backup file write is a hard precondition for deletion. Should not be set to `false` without a very deliberate reason — this is the control that keeps deletion from being irreversible *everywhere*, not just from the live database |
| `DELETION_BACKUP_PATH` | `./backups` (local) / `/app/backups` (k8s, mounted PVC — see `k8s/deletion-cronjob.yaml`) | Where the pre-deletion export file is written |

**Example — adjusting for a jurisdiction with a 5-year AML minimum
instead of 8**: change `DELETION_THRESHOLD_YEARS: "8"` to
`DELETION_THRESHOLD_YEARS: "5"` in `k8s/configmap.yaml`, then
`kubectl apply -f k8s/configmap.yaml` and let the next scheduled
`CronJob` run pick it up (or trigger one manually — see below). No
image rebuild needed.

## How it runs

Two `k8s/CronJob`s, not `@Cron()` methods on the running API — see
[`../technical/distributed-state.md`](../technical/distributed-state.md)
for why: `@Cron()` runs once *per pod*, and at `k8s/hpa.yaml`'s
`maxReplicas: 20` that would mean up to 20 concurrent runs racing each
other over the same rows. A `CronJob` only ever spins up one pod per
scheduled run, so the coordination problem doesn't exist by
construction.

- **`k8s/archiving-cronjob.yaml`** — daily at 03:00. Runs
  `src/jobs/run-archiving-job.ts` (compiled to
  `dist/jobs/run-archiving-job.js`, same production image as the API,
  different container command).
- **`k8s/deletion-cronjob.yaml`** — weekly, Sunday 04:00. Runs
  `src/jobs/run-deletion-job.ts`. Mounts a `PersistentVolumeClaim` at
  `DELETION_BACKUP_PATH` — a k8s pod's local filesystem disappears when
  the pod does, so without a mounted volume, a "successful" backup
  wouldn't actually survive to be useful.

**Manual run** (operator, e.g. to catch up on a missed schedule, or to
test a threshold change immediately):

```bash
kubectl create job --from=cronjob/omniswitch-archiving manual-archive-$(date +%s) -n payments
kubectl create job --from=cronjob/omniswitch-deletion manual-deletion-$(date +%s) -n payments
```

Both jobs are safe to re-run — the eligibility query is a repeatable
`SELECT`, and once a row is moved/deleted it's no longer eligible on the
next run.

**Local / dev run**, against whatever `DB_MASTER_HOST` etc. your shell
has set (matches the `docker-compose.yml` local stack by default):

```bash
npm run job:archive
npm run job:delete
```

## Observability

Both jobs are short-lived CLI processes, not long-running HTTP servers —
`prom-client` can't scrape them the normal way mid-run. Each run instead
emits one structured, single-line JSON summary to stdout/stderr on
completion:

```json
{"job":"archiving","archiveThresholdDays":180,"paymentsEligible":2,"paymentsArchived":2,"ledgerOutboxEligible":3,"ledgerOutboxArchived":3,"durationMs":726,"status":"success"}
```

Greppable in the CronJob pod's logs (`kubectl logs job/<name> -n payments`)
without needing a Prometheus Pushgateway. A failed run logs
`"status":"failed"` with an `"error"` field and exits non-zero — visible
via `kubectl get jobs -n payments` (`FAILED` column) or
`.status.lastScheduleTime`/`.status.active` on the parent `CronJob`.
Pushing these summaries to a Pushgateway is a reasonable future
enhancement if this ever needs alerting beyond "an operator checks
`kubectl` occasionally" — not built, since no Pushgateway currently runs
anywhere in this stack.

## What "eligible" actually means

**Archiving** — a payment is eligible when *all* of:
- `created_at` is older than `ARCHIVE_THRESHOLD_DAYS`
- `status` is terminal (`SUCCEEDED`, `FAILED`, `CANCELLED`, `REFUNDED`,
  `PARTIALLY_REFUNDED`) — excludes anything still in flight, and
  excludes `DISPUTED` (its own status, deliberately not terminal here)
- no `disputes` row referencing it has status `NEEDS_RESPONSE` or
  `UNDER_REVIEW` (open)
- no `reconciliation_runs.mismatches` entry references it — a flagged
  mismatch means this payment's settlement hasn't been confirmed
  against the PSP's own record

A `ledger_outbox` entry is archived independently, on its own
`created_at`/`ARCHIVE_THRESHOLD_DAYS`, once `status = 'PUBLISHED'` —
`FAILED` entries stay live since they're still actionable through the
outbox dead-letter admin recovery flow
([`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md)).

**Deletion** — any record in `archive.payments`/`archive.ledger_outbox`
(i.e., already archived) whose `created_at` is older than
`DELETION_THRESHOLD_YEARS`. Deletion never looks at the live tables
directly.

## What this doesn't cover

Being direct about the gaps, so nobody mistakes this for a certified
compliance system:

- **These specific numbers (180 days, 8 years) are reasonable, commonly-seen
  defaults — not a substitute for real legal/compliance review.** A
  deployment into a specific country needs its own review to confirm
  these values, and the deletion mechanism itself, actually satisfy that
  jurisdiction's AML/tax/audit requirements before the deletion tier is
  ever turned on in production.
- **The backup file is local-disk JSON, mounted via a PVC.** That's
  enough to survive the CronJob pod's own lifecycle, but it's not
  versioned, encrypted-at-rest beyond whatever the underlying volume
  provides, or access-controlled beyond normal k8s RBAC on the PVC.
  Since this file becomes the *only* remaining copy of a deleted record,
  a real deployment should treat it more seriously — e.g. write to
  versioned, access-controlled object storage with its own retention
  policy, not a plain PVC. Not implemented here.
- **"Unreconciled settlement" is checked against
  `reconciliation_runs.mismatches`, a loosely-typed JSON array** (see
  `reconciliation.md` for how that gets populated) — this is a real,
  working check, but it depends on reconciliation runs having actually
  executed and correctly flagged every real mismatch. It is not an
  independent, formally-verified guarantee.
- **No legal-hold mechanism.** If a specific record needs to be
  preserved past its normal age (litigation, a regulator's specific
  request) independent of the dispute-status check, there's currently
  no flag for that — it would rely on an operator noticing and
  intervening manually before a scheduled run.
- **Row-level archiving, not partition-level.** `database-scaling.md`'s
  Option 2 (table partitioning) discusses `DETACH PARTITION` as a
  possible archiving mechanism once partitioning is in place — this
  implementation does `INSERT` + `DELETE` per eligible row instead,
  because eligibility (no open dispute) is per-record, not
  per-partition, and a partition can contain a mix of eligible and
  ineligible rows. Correct over fast, deliberately.
