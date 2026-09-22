# Technical Documentation

Implementation detail: how the system is built, deployed, operated, and
verified. For *why* the business is shaped this way, see
[`../business-domain/`](../business-domain/) instead; for a guided
onboarding path through both, see [`../guide/`](../guide/).

## Architecture & design

- [`architecture.md`](./architecture.md) — module map, testing setup,
  and the design decisions behind the module layout
- [`distributed-state.md`](./distributed-state.md) — rate limiting,
  circuit breaker, and scheduled-job state kept consistent across
  replicas
- [`service-boundaries.md`](./service-boundaries.md) — evaluation of
  where the modular monolith could split into services, and why it
  isn't recommended yet
- [`api-versioning-policy.md`](./api-versioning-policy.md) — current
  URI-versioning state and the deprecation policy for when a v2 arrives
- [`sdk/`](./sdk/) — how the first-party Node/TypeScript client
  (`sdk/node`) is built: package layout, HMAC/idempotency/webhook-
  verification implementation, and its two-layer testing strategy

## Data & jobs

- [`database-migrations.md`](./database-migrations.md) — the
  migration workflow, from entity file to running schema
- [`databases/`](./databases/) — schema reference, ERD, physical
  deployment (replication, PgBouncer, partitioning)
- [`jobs.md`](./jobs.md) — the background-job subsystem: archiving,
  deletion, partition maintenance, cutover cleanup
- [`reconciliation.md`](./reconciliation.md) — closing the ledger
  against the PSP's own record of what actually settled

## Compliance & security

- [`security-and-compliance.md`](./security-and-compliance.md) — JWT
  revocation design and an honest PCI DSS scope/gap assessment
- [`compliance-certification-roadmap.md`](./compliance-certification-roadmap.md) —
  the SOC 2 / PCI DSS certification path, not a certification itself
- [`secret-management.md`](./secret-management.md) — Vault-backed
  envelope encryption for the one secret this app mints itself
- For the business/regulatory reasoning behind these, see
  [`../business-domain/compliance-and-security.md`](../business-domain/compliance-and-security.md)

## Operations & reliability

- [`ci-cd.md`](./ci-cd.md) — the two GitHub Actions workflows,
  Dependabot, and known flaky-test classes
- [`incident-response.md`](./incident-response.md) — runbook for the
  alerts defined in `monitoring/alert.rules.yml`
- [`disaster-recovery.md`](./disaster-recovery.md) — multi-region/
  cross-AZ strategy (documented, not verified against real
  infrastructure)
- [`k8s/`](./k8s/) — what's actually in `k8s/` and why it's shaped
  the way it is
- [`deployment/`](./deployment/) — how to actually get `k8s/` running
- [`clouds/`](./clouds/) — the one cloud-provider-specific
  integration point (`BackupStorage`), one file per provider

## Testing

- [`tests/`](./tests/) — load testing, chaos testing, contract
  testing against real Stripe/Adyen sandboxes, and threshold
  calibration, all verified against real infrastructure rather than
  documented as a plan
