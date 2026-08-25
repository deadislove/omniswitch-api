# Documentation

Six kinds of documentation live here, kept separate because they
answer different questions for different readers.

## [`guide/`](./guide/)

**New to this project? Start here.** A structured onboarding path — the
business domain guide, the system design doc, and the full API
reference — meant to be read start to finish, not dipped into. Everything
below (`technical/`, `business-domain/`) is the deeper reference this
guide points into once you're working on a specific area.

Also in this folder: [`guide/jobs/`](./guide/jobs/) — an operator
runbook for the background jobs (archiving, deletion, partition
maintenance, cutover cleanup), separate from the onboarding reading
order above since it's day-2-operations reference, not something a new
engineer needs before their first PR.

## [`technical/`](./technical/)

How the system is built — architecture, module boundaries, security design,
compliance posture. Read this if you're changing code.

- [`architecture.md`](./technical/architecture.md) — module map, design
  patterns, why the module dependency graph is shaped the way it is, and
  the end-to-end testing strategy
- [`security-and-compliance.md`](./technical/security-and-compliance.md) —
  JWT revocation design and trade-offs, PCI DSS scope/gaps, and the
  recommended path if this project ever goes through formal PCI
  certification
- [`distributed-state.md`](./technical/distributed-state.md) — rate
  limiting and circuit breaker design once this runs as multiple replicas
  (including a real debugging story worth reading before touching
  either), plus a documented, still-open gap: `@Cron` jobs run
  per-replica, not once per cluster — read this before adding a new one
- [`infra-verification-status.md`](./technical/infra-verification-status.md) —
  what's actually been proven to work in `docker-compose.yml` (mock-psp,
  Postgres replication, port conflicts) versus what's still an unverified
  assumption — read this before trusting a green e2e run more than it's
  earned
- [`database-migrations.md`](./technical/database-migrations.md) — why
  `synchronize` is now `false` everywhere, the migration workflow, and a
  real bug (invalid MySQL-style SQL in the master's init script) that only
  surfaced once this required a genuinely fresh database
- [`secret-management.md`](./technical/secret-management.md) — why
  `hmac_secret` is now envelope-encrypted via Vault Transit instead of
  plaintext in Postgres, what dev-mode Vault does and doesn't prove, and a
  real bug (no `.dockerignore`) it surfaced along the way
- [`reconciliation.md`](./technical/reconciliation.md) — how this system's
  ledger is diffed against each PSP's own settlement report, and a real
  pre-existing timezone bug (raw `Date` objects silently shifted by the
  host machine's local offset) it surfaced in the query layer
- [`load-testing.md`](./technical/load-testing.md) — a real throughput/
  latency baseline against the actual production Docker image, what it
  means for `k8s/hpa.yaml`'s CPU/memory thresholds, and why a
  single-machine load generator can't measure the charge endpoint's own
  ceiling (a route-level rate limit gets there first)
- [`ci-cd.md`](./technical/ci-cd.md) — what the GitHub Actions workflows
  and Dependabot actually do, the known flaky-test classes, and two real
  CI incidents: a master/replica read race a routine dependency-bump PR
  surfaced, and a heap-flake fix that passed locally three times and then
  broke 61 tests on the actual CI runner
- [`jobs.md`](./technical/jobs.md) — architecture of the background-job
  subsystem (archiving, deletion, partition maintenance, cutover
  cleanup): why they're standalone scripts run as k8s `CronJob`/`Job`
  resources instead of `@Cron()` methods, the `BackupStorage` factory
  pattern, and pod labeling
- [`databases/`](./technical/databases/) — the ERD and table-by-table
  schema reference, the physical database architecture
  (master/replica replication, PgBouncer pooling, table partitioning,
  the `archive` schema), and an index of recurring/one-time database
  maintenance tasks
- [`clouds/`](./technical/clouds/) — the pluggable AWS S3/GCS/Azure
  Blob `BackupStorage` adapters the deletion job can write to:
  configuration, credentials, and what's been (and hasn't been)
  verified against real cloud infrastructure

## [`business-domain/`](./business-domain/)

What the system does, in payments-industry and business terms — independent
of NestJS, TypeORM, or any other implementation detail. Read this if you're
trying to understand *why* a payment behaves the way it does, or you're new
to payments domain concepts generally.

- [`payment-lifecycle.md`](./business-domain/payment-lifecycle.md) — the
  payment state machine, what triggers each transition, idempotency
- [`ledger-and-settlement.md`](./business-domain/ledger-and-settlement.md) —
  double-entry bookkeeping model, the Outbox pattern, smart PSP routing,
  fee model, FX settlement conversion, merchant risk reserves
- [`subscriptions.md`](./business-domain/subscriptions.md) — the
  subscription state machine, how billing/dunning/crash-recovery/plan
  catalog & proration/trial-verification work, and what's still
  simplified (a real notification integration, a calibrated
  hard-decline code set)
- [`glossary.md`](./business-domain/glossary.md) — domain terms as used in
  this codebase specifically
- [`future-directions.md`](./business-domain/future-directions.md) —
  business capabilities written in domain language rather than
  implementation terms: marketplace splits, subscriptions, risk
  tiering/reserves, dispute resolution policy, cross-border settlement,
  and agentic payments (delegation + spend policy) all have a real
  mechanism built now — this covers what's still only partly done in
  each, plus the business framing throughout

## [`compliance/`](./compliance/)

How this project handles data-retention/AML requirements — what gets
archived, what gets deleted, on what schedule, and how to reconfigure
the retention periods for a specific jurisdiction without touching code.

- [`data-retention.md`](./compliance/data-retention.md) — the three-tier
  policy (live → archive → delete), the two `k8s CronJob`s that enforce
  it, the full environment-variable configuration reference, and an
  honest list of what this doesn't cover (this is a reference
  implementation with sensible defaults, not a substitute for
  jurisdiction-specific legal/compliance review)

## [`adr/`](./adr/)

Architecture Decision Records — *why* a specific technical decision was
made (alternatives considered, the trade-off accepted, the real bug it
fixed if there was one), not a description of the current system
(that's `technical/architecture.md`). Written once, at the time of the
decision; a reversed decision gets a new ADR marking the old one
`Superseded`, not a rewrite. See [`adr/README.md`](./adr/README.md)
for the full index and format.
