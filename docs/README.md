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

How the system is built — architecture, data & jobs, compliance &
security, operations & reliability, deployment, and testing
methodology. Read this if you're changing code. See
[`technical/README.md`](./technical/README.md) for the full index.

## [`business-domain/`](./business-domain/)

What the system does, in payments-industry and business terms — independent
of NestJS, TypeORM, or any other implementation detail. Read this if you're
trying to understand *why* a payment behaves the way it does, or you're new
to payments domain concepts generally.

- [`payment-lifecycle.md`](./business-domain/payment-lifecycle.md) — the
  payment state machine, what triggers each transition, idempotency
- [`ledger-and-settlement.md`](./business-domain/ledger-and-settlement.md) —
  smart PSP routing, PSP-cost reconciliation, merchant risk tiering &
  reserves — see also the four topics split into their own files below
- [`ledger-accounting.md`](./business-domain/ledger-accounting.md) —
  the double-entry bookkeeping model and the Outbox pattern that
  publishes it reliably
- [`fee-model.md`](./business-domain/fee-model.md) — platform fee-rate
  calculation and PSP interchange-cost reconciliation
- [`fx-conversion.md`](./business-domain/fx-conversion.md) — cross-currency
  merchant settlement, refund/dispute FX replay, presentment currency
- [`marketplace-and-payouts.md`](./business-domain/marketplace-and-payouts.md) —
  marketplace splits, payout scheduling, connected-account KYC gating
- [`disputes.md`](./business-domain/disputes.md) — the dispute state
  machine, representment, and the auto-decision policy that decides
  whether this platform contests one automatically
- [`risk-and-fraud.md`](./business-domain/risk-and-fraud.md) — the two
  independent risk signals this platform tracks per merchant: reserve-driving
  risk tiering and ambiguous-payment (PSP-reliability) monitoring
- [`compliance-and-security.md`](./business-domain/compliance-and-security.md) —
  why PCI DSS tokenization, AML/KYC payout gating, and agentic-payment
  delegation scope are business decisions, not just engineering choices
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
