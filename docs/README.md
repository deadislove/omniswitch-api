# Documentation

Five kinds of documentation live here, kept separate because they
answer different questions for different readers.

## [`guide/`](./guide/)

**New to this project? Start here.** A structured onboarding path — the
business domain guide, the system design doc, and the full API
reference — meant to be read start to finish, not dipped into. Everything
below (`technical/`, `business-domain/`) is the deeper reference this
guide points into once you're working on a specific area.

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

## `spec/future/` (local only, not tracked in git)

Internal BA/planning documents — proposals that have **not** (or not
fully) been executed yet: evaluated options, scope of impact, and a
recommended sequence, written *before* the work happens rather than
after. `.gitignore`'d deliberately; this folder never reaches GitHub, so
nothing else in this repo's tracked docs should link to it directly.
Distinct from `technical/`, which only documents what's actually built.

- `database-scaling.md` — options for scaling past this stack's tested
  data volume (PgBouncer, table partitioning, archiving/retention
  policy, Citus), why a distributed-DB + CDC approach in front of
  `master` was rejected, and a recommended execution order. PgBouncer
  (Option 1) is now implemented and load-tested — see
  [`technical/load-testing.md`](./technical/load-testing.md) (Finding
  #3) for results. Table partitioning (Option 2) and the archiving/
  deletion policy (Option 3) are now also fully executed — `payments`/
  `ledger_outbox` are live partitioned tables, and the two retention
  jobs described in [`compliance/data-retention.md`](./compliance/data-retention.md)
  are running; Citus (Option 4) remains proposal-stage.
