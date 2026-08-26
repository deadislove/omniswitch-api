# Jobs Subsystem — Architecture

`src/jobs/` holds every piece of work that runs outside the API's
request/response cycle: archiving, deletion, partition maintenance, and
the one-time cutover-table cleanup. This doc covers *how* they're built
and why they're shaped the way they are. For the compliance/business
policy they enforce, see
[`../compliance/data-retention.md`](../compliance/data-retention.md).
For day-2 operation (running them, reading their logs, troubleshooting),
see [`../guide/jobs/`](../guide/jobs/).

## Standalone scripts, not `@Cron()` methods

Every job in `src/jobs/` is a plain script with a `main()` guarded by
`if (require.main === module)` — not a `@Cron()`-decorated method on a
running `NestJS` service. Two independent reasons converge on this
shape:

**Nest DI isn't needed, and pulling it in would cost more than it
buys.** These scripts need raw DB access and nothing else — no HTTP
layer, no guards, no controllers. `src/database/seed-admin.ts`
established this pattern first (bootstrap a plain `AppDataSource`, run
SQL, exit); every job script reuses it:

```ts
import 'dotenv/config';
import { AppDataSource } from '../database/data-source';
// ... run the job's SQL via AppDataSource, then AppDataSource.destroy()
```

**`@Cron()` doesn't fit a once-per-cluster job at this app's actual
replica count.** `k8s/hpa.yaml` scales the API to up to 20 pods. A
`@Cron()` method runs once *per pod* — at 20 replicas, that's 20
concurrent archiving runs racing each other over the same rows, with no
coordination between them. See
[`distributed-state.md`](./distributed-state.md) for the full
distributed-state discussion (rate limiting and circuit-breaker state
hit the same class of problem and were fixed by moving to Redis; this
is a *different* shape of the same underlying issue — concurrency
across replicas — and the fix here is different too).

The actual fix: run each job as its own **k8s `CronJob`** (or a
one-time `Job` for `drop-cutover-tables.ts`), never as `@Cron()` on the
API's own Deployment. A `CronJob` spins up exactly one pod per scheduled
run — the coordination problem doesn't need solving (a lock, a leader
election), because it doesn't exist by construction. This was a
deliberate choice over a `@Cron()` + Redis-lock design specifically
because it makes the problem moot rather than adding a mechanism to
manage it.

**Corollary: never run one of these via `kubectl exec` into a running
`omniswitch-api` Deployment pod either.** That pod's job is serving
traffic; it can be rescaled by the HPA or recycled by a rolling update
mid-operation, with zero warning to whatever ad hoc command you ran
inside it. Every job here gets its own dedicated, disposable pod
instead — see each job's own `k8s/*.yaml` manifest comment for this
same reasoning restated at the point of use.

## Pod labeling: `workload-type`

Every job's k8s resource (CronJob or Job) carries
`workload-type: batch-job`, at both `metadata.labels` and the pod
template's `spec.template.metadata.labels`. The API's own
`k8s/deployment.yaml` carries `workload-type: service` instead — purely
descriptive, not part of any `selector.matchLabels` (a Deployment's
selector is immutable after creation, so this is layered on top, not
load-bearing for scheduling). This exists so an operator can select
every maintenance/batch pod across the whole `payments` namespace in
one query, independent of which specific job it is:

```bash
kubectl get pods -n payments -l workload-type=batch-job
```

## Common shape every job script follows

1. `import 'dotenv/config'` + `import { AppDataSource } from '../database/data-source'`
2. An exported function containing the actual logic (`archivePayments()`,
   `runDeletion()`, `ensureUpcomingPartitions()`, `dropCutoverTables()`)
   — returns a typed summary object, never just logs and exits. This is
   what makes the function independently unit/e2e-testable (see
   "Testing" below) without spawning a subprocess.
3. A `main()` that calls `AppDataSource.initialize()`, calls the
   exported function, logs one structured JSON line
   (`{"job": "...", ...summary}`) to `stdout` on success or `stderr` on
   failure, and always `AppDataSource.destroy()`s in a `finally`.
4. `if (require.main === module) { main().catch(() => process.exit(1)); }`
   — guards `main()` from running when a test file imports the exported
   function directly. Without this, importing `archivePayments` from a
   spec file would also trigger a real run against whatever DB the test
   process happens to be configured against.

**Why a structured JSON log line instead of a metrics endpoint:** these
are short-lived CLI processes, not long-running HTTP servers —
`prom-client` can't scrape them the normal way mid-run (there's no
"mid-run" to scrape; they finish in well under a second at this
project's data volume). A single-line JSON summary is greppable
straight from `kubectl logs job/<name>` without needing a Prometheus
Pushgateway. See [`../compliance/data-retention.md`](./../compliance/data-retention.md#observability)
for the specific fields each job emits.

## The `BackupStorage` factory: DI pattern doesn't apply here

`src/jobs/backup-storage/get-backup-storage.ts` selects which
`BackupStorage` adapter (`local`/`s3`/`gcs`/`azure`) `run-deletion-job.ts`
writes its pre-deletion export to, based on `DELETION_BACKUP_STORAGE`.

This is a **plain factory function** (`export function
getBackupStorage(): BackupStorage { switch (...) { ... } }`), not a
NestJS-injected provider the way `PaymentProcessorFactory` selects
between Stripe and Adyen adapters. The distinction matters and is
deliberate, not an inconsistency to "fix" later:

- `PaymentProcessorFactory` lives inside `PaymentModule`, resolved
  through Nest's DI container at request time — the running API always
  has a module context to register providers into.
- `run-deletion-job.ts` is one of the standalone scripts described
  above — it deliberately runs **outside** the Nest DI container
  entirely (no `NestFactory.create()`, no module graph). There is no
  provider registry for `getBackupStorage()` to participate in, so a
  `useFactory`/`useClass` provider binding isn't an option — a plain
  function called directly (`getBackupStorage().write(...)`) is the
  actual mechanism available in this context, not a simplification of
  one.

If a future job ever needs multi-provider selection *and* runs inside
the Nest DI container (e.g., something exposed through an admin HTTP
endpoint rather than a CronJob), that one should use the
`PaymentProcessorFactory`-style DI pattern instead — the plain-function
factory here is specifically because this caller has no container to
inject into, not a general preference for one pattern over the other.

See [`../technical/clouds/README.md`](./clouds/README.md) for the
three cloud adapters this factory selects between, and
[`../compliance/data-retention.md`](../compliance/data-retention.md#where-the-backup-goes)
for why `local` is the default (GitHub Actions CI has no real cloud
credentials — defaulting to the option that needs none keeps CI green
without provisioning cloud secrets for a reference project).

## Testing

Two layers, matching the rest of this codebase's testing split
(see [`architecture.md`](./architecture.md#testing)):

- **Unit tests** (`src/jobs/backup-storage/*.spec.ts`) — the three
  cloud adapters against manually `jest.mock()`-ed SDK clients
  (`@aws-sdk/client-s3`, `@google-cloud/storage`,
  `@azure/storage-blob`), plus `get-backup-storage.spec.ts` for the
  factory's selection/error logic. No new test-only dependency was
  added (no `aws-sdk-client-mock` or similar) — a manual `jest.mock()`
  was enough for the shape of calls being verified.
- **E2E tests** (`test/*.e2e-spec.ts`) — call the job's exported
  function directly (`ensureUpcomingPartitions()`,
  `archivePayments()`, etc.) against a real Postgres instance, the same
  way `test/legal-hold.e2e-spec.ts` and
  `test/partition-maintenance-job.e2e-spec.ts` do. This is what proves
  the actual SQL is correct (partition naming collisions, the
  varchar→enum cast on archive-restore, row-count backfill checks) —
  a mocked-DB unit test would happily pass while the real SQL is wrong.
  `LocalDiskBackupStorage` gets the same real-infrastructure treatment
  (a real filesystem via `mkdtempSync`), consistent with this project's
  general preference for a real stand-in over a mocked interface
  wherever one is practical to stand up (`mock-psp` instead of a
  Stripe/Adyen sandbox is the same idea applied elsewhere).

**Never exercised against real cloud infrastructure**: the three cloud
`BackupStorage` adapters have no live-bucket test anywhere in this
project — no real AWS/GCP/Azure credentials exist in CI or local dev.
This is a real, documented gap, not an oversight — see
[`clouds/README.md`](./clouds/README.md#what-this-doesnt-cover).

## Job inventory

| Script | k8s resource | DI container? | Testing |
|---|---|---|---|
| `run-archiving-job.ts` | CronJob, daily | No | e2e (`test/data-retention-jobs.e2e-spec.ts`) |
| `run-deletion-job.ts` | CronJob, weekly | No | e2e + unit (`backup-storage/*.spec.ts`) |
| `create-partitions-job.ts` | CronJob, weekly | No | e2e (`test/partition-maintenance-job.e2e-spec.ts`) |
| `drop-cutover-tables.ts` | Job, one-time | No | e2e (`test/data-retention-jobs.e2e-spec.ts`'s `drop-cutover-tables` block, against a synthetic dummy table — destructive, so never run against the real seeded `payments_old`/`ledger_outbox_old` tables) |
| `legal-hold.service.ts` | HTTP endpoint (`LegalHoldAdminController`) | **Yes** — `@Injectable()`, registered in `payment.module.ts` | e2e (`test/legal-hold.e2e-spec.ts`) |

`legal-hold.service.ts` is listed here because it's part of the same
data-retention story (it's what a legal hold blocks the other jobs
from touching), but it's the one exception to "standalone script
outside DI" — it's invoked synchronously from an HTTP request, so it's
a normal injectable Nest service, not a CronJob target.
