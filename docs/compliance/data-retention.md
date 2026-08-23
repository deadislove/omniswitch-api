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
| `DELETION_BACKUP_REQUIRED` | `true` | Whether a successful backup write is a hard precondition for deletion. Should not be set to `false` without a very deliberate reason — this is the control that keeps deletion from being irreversible *everywhere*, not just from the live database |
| `DELETION_BACKUP_STORAGE` | `local` | Which `BackupStorage` adapter to write to — `local`, `s3`, `gcs`, or `azure`. See "Where the backup goes" below |
| `DELETION_BACKUP_PATH` | `./backups` (local) / `/app/backups` (k8s, mounted PVC) | Only used when `DELETION_BACKUP_STORAGE=local` — where the pre-deletion export file is written |
| `CUTOVER_OLD_TABLE_RETENTION_DAYS` | `60` | Age (days, since the partitioning cutover — not an AML setting) before `payments_old`/`ledger_outbox_old` are eligible to be dropped by `npm run job:drop-cutover-tables` |
| `PARTITION_MAINTENANCE_MONTHS_AHEAD` | `2` | How many months ahead of "now" the partition-maintenance job (not an AML setting either) keeps a partition pre-created for, on `payments`/`ledger_outbox` |

**Example — adjusting for a jurisdiction with a 5-year AML minimum
instead of 8**: change `DELETION_THRESHOLD_YEARS: "8"` to
`DELETION_THRESHOLD_YEARS: "5"` in `k8s/configmap.yaml`, then
`kubectl apply -f k8s/configmap.yaml` and let the next scheduled
`CronJob` run pick it up (or trigger one manually — see below). No
image rebuild needed.

## Where the backup goes

The deletion job's pre-delete export goes to one of four pluggable
destinations — `src/jobs/backup-storage/` — selected by
`DELETION_BACKUP_STORAGE`:

| Provider | Value | Required config | Credentials |
|---|---|---|---|
| Local disk (default) | `local` | `DELETION_BACKUP_PATH` | none — just filesystem access |
| AWS S3 | `s3` | `DELETION_BACKUP_S3_BUCKET`, `DELETION_BACKUP_S3_REGION` | AWS SDK's own default credential chain (IAM role, instance profile, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) |
| Google Cloud Storage | `gcs` | `DELETION_BACKUP_GCS_BUCKET` | Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, Workload Identity, or the GCE/GKE metadata service) |
| Azure Blob Storage | `azure` | `DELETION_BACKUP_AZURE_CONNECTION_STRING`, `DELETION_BACKUP_AZURE_CONTAINER` | carried in the connection string itself — put this in `omniswitch-secrets`, not `configmap.yaml`, since it's a credential |

**Why `local` is the default, not just the first option listed**: this
project's GitHub Actions CI never has real cloud credentials available
— see `docs/technical/ci-cd.md`. If cloud storage were the default, CI
would either need real cloud secrets provisioned for a reference/demo
project (a real security and cost liability for something anyone can
clone and run), or a self-hosted stand-in service added to the CI
pipeline (e.g. MinIO) — a new architectural commitment, not a small
config change. `local` needs nothing but the filesystem, matching this
project's existing pattern for every other external dependency in
dev/test (`mock-psp` instead of real PSP sandboxes, dev-mode Vault
instead of a real cluster) — a real, working stand-in, not a mock of
the interface. **A real deployment choosing to enable a cloud provider
is a deliberate, opt-in decision made at deploy time** — this doc
doesn't take a position on which cloud a specific deployment should
use, only that the mechanism exists for whichever one is chosen.

**Not exercised end-to-end by this project's own test suite**: the
`local` adapter has full e2e coverage (`test/legal-hold.e2e-spec.ts`,
`test/data-retention-jobs.e2e-spec.ts` both exercise it against a real
filesystem). The three cloud adapters are unit-tested against mocked
clients (`src/jobs/backup-storage/*.spec.ts` — confirms each adapter
calls its SDK correctly and propagates a failure as a thrown error, the
same "refuse to delete if the backup isn't confirmed" contract the
local adapter has) but have never been run against a real S3 bucket,
GCS bucket, or Azure container, since no real cloud credentials exist
anywhere in this project's CI or local dev setup. A real deployment
enabling one of these for the first time should do its own live test
run (`npm run job:delete` against a real, disposable bucket/container)
before relying on it in production.

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
  and `AMBIGUOUS` (outcome genuinely unresolved — see
  `PaymentAggregate.markAmbiguous()` — must not be archived until
  reconciliation resolves it to SUCCEEDED or FAILED)
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
`DELETION_THRESHOLD_YEARS` **and** has no still-open dispute (same
`NEEDS_RESPONSE`/`UNDER_REVIEW` check as archiving, added 2026-08-22
after review). The dispute check matters here independently of
archiving's own check: a payment can be archived with no open dispute
and then get disputed years later (a long investigation, litigation) —
age alone crossing `DELETION_THRESHOLD_YEARS` must not override an
open dispute that shows up after archiving already happened. Deletion
never looks at the live tables directly.

## Legal hold

A payment's `legal_hold` boolean (added 2026-08-22) overrides both the
archiving and deletion eligibility checks above
— a held payment is excluded regardless of age, status, or dispute
state, same as the dispute check but not tied to a PSP dispute
existing. This is for the case a dispute-status check alone doesn't
cover: litigation, a regulator's investigation, or any other reason a
specific record needs to be preserved that has nothing to do with a
card-network chargeback.

**Deliberately a single boolean, not an audit-trail table.** Recording
who placed a hold, when, and why is a real compliance/legal-process
concern, but tracking that isn't something this codebase does for any
other operator action either (a dispute's `autoDecision`, a merchant's
`isActive` toggle — neither carries an audit trail here) and it's
outside this project's PSP/payment-processing scope. If a real
deployment needs that record-keeping, it's an explicit, separate
addition on top of this flag — see "What this doesn't cover" below.

- **`POST /api/v1/admin/payments/:id/legal-hold`** — places a hold
  (`ADMIN`/`OPERATOR` role required, same as the other admin
  endpoints). If the payment is currently archived, this **restores it
  to the live `payments` table** as part of placing the hold, rather
  than flagging it in place in `archive.payments` — a record under
  active legal/regulatory scrutiny needs to be reachable through the
  normal payment query path (`GET /payments/:id`, admin lookups),
  not left sitting in cold storage. Response includes `location: "live"
  | "restored-from-archive"` so the caller knows which happened.
- **`DELETE /api/v1/admin/payments/:id/legal-hold`** — releases a
  hold. Only ever operates on the live table (a held payment is always
  there — see above). No special "re-archive" step: the payment simply
  becomes archive-eligible again through the normal archiving job, the
  next time it runs, once its age/status/dispute conditions are
  otherwise met.
- `src/modules/payment/application/services/legal-hold.service.ts` /
  `legal-hold-admin.controller.ts` — operates on `payments`/
  `archive.payments` via raw SQL, not through `PaymentRepositoryPort`/
  `PaymentAggregate` — same reasoning as the archiving/deletion jobs:
  this is a retention/ops concern layered on the schema, not a
  payment-lifecycle business rule the domain aggregate needs to model.
- Both `run-archiving-job.ts` and `run-deletion-job.ts` exclude
  `legal_hold = true` rows. The deletion job's check is
  defense-in-depth, not the primary mechanism — under normal operation
  `archive.payments` should never actually contain a `legal_hold = true`
  row, since placing a hold on an archived payment pulls it out
  immediately.

## Cutover safety-net tables (`payments_old`, `ledger_outbox_old`)

Separate from the three-tier policy above — these are pre-partitioning
snapshots, not a retention tier. When `payments`/`ledger_outbox` were
cut over to the partitioned tables
(`1787333739819-BackfillAndSwapPartitionedPaymentsAndLedgerOutbox.ts`),
the original flat tables were renamed to `payments_old`/
`ledger_outbox_old` and kept, rather than dropped immediately, as a
safety net in case the cutover itself had a bug.

**Every row in these tables is a duplicate** of what the same migration
already copied into the live partitioned tables — so keeping them
*indefinitely* doesn't add investigative or compliance value (the same
data is already tracked, and governed by the policy above, through
`payments`/`archive.payments`). It would actually work against the
policy's own integrity: an ungoverned duplicate that never ages out via
the archiving/deletion jobs is a backdoor around the deletion tier, not
an extra safety measure — a record correctly deleted from
`archive.payments` after 8 years would still sit, untouched, in
`payments_old` forever.

- `CUTOVER_OLD_TABLE_RETENTION_DAYS` (default **60**) — a short,
  separate window from the archive/deletion thresholds above. It answers
  "has enough time passed to trust the cutover was correct," not an AML
  question, so it isn't tied to `ARCHIVE_THRESHOLD_DAYS`/
  `DELETION_THRESHOLD_YEARS`.
- The cutover migration itself doesn't record *when* it ran (TypeORM's
  migrations table only stores a version number, not a real
  timestamp) — `1787339024677-CreateSchemaCutoverLog.ts` adds a small
  `schema_cutover_log` table for this specifically.
- `src/jobs/drop-cutover-tables.ts` — a **one-time operator action, not
  a CronJob**. Dropping these tables is a single event in this
  project's history, not a recurring policy action. Reports days
  remaining if the window hasn't elapsed yet (exits 0 either way —
  "not eligible yet" isn't a failure); drops the table and clears its
  `schema_cutover_log` row once it has. Safe to re-run.
  - Local/dev: `npm run job:drop-cutover-tables`.
  - k8s: `kubectl apply -f k8s/drop-cutover-tables-job.yaml` — a
    one-time `Job`, deliberately not run via `kubectl exec` into a
    running `omniswitch-api` Deployment pod (that pod serves traffic
    and can be rescaled/recycled mid-operation by the HPA or a rolling
    update — see that manifest's own comment for the full reasoning,
    same as the archiving/deletion/partition-maintenance CronJobs).

## Partition maintenance

Also not part of the three-tier retention policy, but closely related
and worth documenting here: `1787325352938-CreatePartitionedPaymentsAndLedgerOutbox.ts`
(Stage 1 of partitioning — see `database-scaling.md` Option 2) only
pre-creates partitions for a fixed window relative to *when it ran* (6
months back, 2 forward). Nothing keeps extending that window as real
time moves past it — without a recurring job, new rows eventually start
silently landing in the `DEFAULT` partition instead of a real monthly
one once "now" gets close enough to the edge of that original range.

- `PARTITION_MAINTENANCE_MONTHS_AHEAD` (default **2**) — how many
  months ahead of "now" this job ensures a partition already exists
  for, on both `payments` and `ledger_outbox`.
- `src/jobs/create-partitions-job.ts` — idempotent (`CREATE TABLE IF
  NOT EXISTS ... PARTITION OF`), safe to re-run. Runs as
  `k8s/partition-maintenance-cronjob.yaml`, weekly — same "why a
  CronJob, not `@Cron()`" reasoning as archiving/deletion.
- **Naming gotcha worth knowing if you're reading the schema
  directly**: child partitions are named `payments_partitioned_YYYY_MM`
  / `ledger_outbox_partitioned_YYYY_MM` — *not* `payments_YYYY_MM` —
  even though the parent table is `payments`, not `payments_partitioned`.
  The cutover migration (`1787333739819-...`) renames only the parent
  (`ALTER TABLE payments_partitioned RENAME TO payments`); PostgreSQL
  does not cascade that rename to child partitions. This job matches
  that existing naming rather than introducing a second, inconsistent
  one — verified live: an earlier version of this job used
  `payments_YYYY_MM` and failed immediately with "partition would
  overlap partition \"payments_partitioned_2026_08\"."

## Jurisdictional compliance review checklist

The 180-day archive / 8-year deletion defaults are reasonable, commonly-seen
numbers — not a legal conclusion. Before deploying this into a specific
country, or before the deletion tier is ever turned on in production,
someone with actual compliance/legal authority for that jurisdiction
needs to work through the items below and sign off. This is a checklist
of *what to ask*, not an answer key — the answers are jurisdiction- and
business-model-specific, and this project makes no claim about what
they are.

1. **Confirm the actual AML minimum retention period**, not the
   commonly-cited "5–10 years" range this doc uses as a placeholder.
   The regulator, the specific instrument (payment records vs. KYC
   records vs. suspicious-activity reports), and the business's license
   type can all change the number. Set `DELETION_THRESHOLD_YEARS`
   (`k8s/configmap.yaml`) to whatever that confirmed number is —
   currently `8`.

2. **Check whether tax/audit retention requirements exceed the AML
   minimum.** Financial records are often also subject to a separate
   tax-authority retention rule, which in some jurisdictions runs
   longer than the AML minimum. The binding number is the *longer* of
   the two, not whichever one this doc happened to cite. This is a
   second, independent number to confirm — don't assume AML retention
   alone covers it.

3. **Confirm deletion after the retention period is actually
   *permitted*, and whether it's *required*.** Some regulatory regimes
   treat "delete records after N years" as a compliance-mandated action
   (data-minimization rules), others are silent on it (records may be
   kept indefinitely, deletion is optional), and some may restrict *how*
   deletion can happen (e.g., requiring a specific certified erasure
   method or an audit trail of the deletion event itself, not just of
   what was deleted). This determines whether the deletion tier should
   be enabled at all, not just what `DELETION_THRESHOLD_YEARS` should be.

4. **Reconcile against any data-subject erasure rights the business is
   also subject to** (e.g., GDPR's right to erasure, or an equivalent
   local regime). These usually carve out an exception for records a
   business is legally required to retain (AML being the canonical
   example), but that exception's exact scope and duration is
   jurisdiction-specific and needs its own confirmation — don't assume
   AML retention automatically overrides every erasure request without
   checking.

5. **Confirm 180 days is a safe archive threshold given actual
   chargeback/dispute windows.** This doc's dispute-exclusion check
   (`NEEDS_RESPONSE`/`UNDER_REVIEW`) protects records with an *open*
   dispute regardless of age, but card-network reason codes vary in how
   long a dispute can be *opened* after the original transaction — some
   exceed 180 days. Confirm the card networks/PSPs this deployment
   actually uses, and adjust `ARCHIVE_THRESHOLD_DAYS` if their windows
   run longer (archiving is reversible, so erring conservative here — a
   longer threshold — is the lower-risk direction if unsure).

6. **Confirm the deletion mechanism itself is acceptable to whatever
   regulator/auditor will review it.** The backup destination is
   configurable (local disk, S3, GCS, or Azure — see "Where the backup
   goes" above), but this project doesn't configure bucket-level
   policies (versioning, encryption-at-rest, access logging,
   chain-of-custody for a legal request) for whichever destination is
   chosen — that's the deploying team's own infrastructure decision.
   The cloud adapters also haven't been run against a real bucket by
   this project (see "Where the backup goes" for why) — verify with a
   real test run before depending on one in production. A boolean-only
   legal-hold flag exists (see "Legal hold" above) for blocking
   archiving/deletion on a specific record.

7. **Identify who signs off, and record it.** This doc, and this
   codebase, cannot make this call unilaterally — it was written by
   engineering, not compliance/legal counsel for any specific
   jurisdiction. Whoever does the review above should be named, and the
   date/jurisdiction/values they confirmed should be recorded somewhere
   durable (this doc's own git history at minimum, ideally a real
   compliance record system) before the deletion tier runs against real
   production data.

## What this doesn't cover

Being direct about the gaps, so nobody mistakes this for a certified
compliance system:

- **These specific numbers (180 days, 8 years) are reasonable, commonly-seen
  defaults — not a substitute for real legal/compliance review.** A
  deployment into a specific country needs its own review to confirm
  these values, and the deletion mechanism itself, actually satisfy that
  jurisdiction's AML/tax/audit requirements before the deletion tier is
  ever turned on in production.
- **Cloud backup storage (S3/GCS/Azure) is implemented but never tested
  against a real bucket/container** — see "Where the backup goes"
  above. A real deployment enabling one of these should do its own live
  verification run first, and separately decide its own bucket-level
  versioning/encryption/retention policy — this project's adapters
  write to whatever bucket/container is configured; they don't
  provision or configure that bucket's own policies (that's
  infrastructure-as-code territory, out of scope for an application-
  level job script). The `local` default, if that's what a deployment
  actually ships with, is only as durable/access-controlled as the
  underlying PVC's own storage class and normal k8s RBAC — a
  deployment that stays on `local` in production should treat that as
  its own explicit choice, not an oversight.
- **"Unreconciled settlement" is checked against
  `reconciliation_runs.mismatches`, a loosely-typed JSON array** (see
  `reconciliation.md` for how that gets populated) — this is a real,
  working check, but it depends on reconciliation runs having actually
  executed and correctly flagged every real mismatch. It is not an
  independent, formally-verified guarantee.
- **Legal hold is a single boolean, with no audit trail.** See
  "Legal hold" below for what's actually built — it blocks archiving
  and deletion, but doesn't record who placed it, when, or why. If a
  real deployment needs that record-keeping (a regulator's own
  evidentiary requirements, an internal audit process), it needs to be
  added on top of this flag, likely alongside whatever handles #4's
  gap above (both would want somewhere durable to write records, not
  just a database column).
- **Row-level archiving, not partition-level.** `database-scaling.md`'s
  Option 2 (table partitioning) discusses `DETACH PARTITION` as a
  possible archiving mechanism once partitioning is in place — this
  implementation does `INSERT` + `DELETE` per eligible row instead,
  because eligibility (no open dispute) is per-record, not
  per-partition, and a partition can contain a mix of eligible and
  ineligible rows. Correct over fast, deliberately.
