# Business Domain

What this system does, in payments-industry and business terms —
independent of NestJS, TypeORM, or any other implementation detail.
Read this if you're trying to understand *why* a payment behaves the
way it does, or you're new to payments domain concepts generally. For
*how* the system is built, see [`../technical/`](../technical/)
instead; for a guided onboarding path through both, see
[`../guide/`](../guide/).

## Merchants

- [`merchants.md`](./merchants.md) — what a `Merchant` is, PLATFORM vs.
  CONNECTED account types, the onboarding pipeline (identity capture,
  sanctions screening, KYC), and the four independent trust signals
  evaluated over a merchant's lifetime

## Core payment flow

- [`payment-lifecycle.md`](./payment-lifecycle.md) — the payment state
  machine, what triggers each transition, idempotency
- [`fee-model.md`](./fee-model.md) — platform fee-rate calculation and
  PSP interchange-cost reconciliation
- [`fx-conversion.md`](./fx-conversion.md) — cross-currency merchant
  settlement, refund/dispute FX replay, presentment currency
- [`ledger-accounting.md`](./ledger-accounting.md) — the double-entry
  bookkeeping model and the Outbox pattern that publishes it reliably
- [`ledger-and-settlement.md`](./ledger-and-settlement.md) — smart PSP
  routing, PSP-cost reconciliation, merchant risk tiering & reserves

## Disputes & risk

- [`disputes.md`](./disputes.md) — the dispute state machine,
  representment, and the auto-decision policy that decides whether
  this platform contests one automatically
- [`risk-and-fraud.md`](./risk-and-fraud.md) — the two independent
  risk signals this platform tracks per merchant: reserve-driving risk
  tiering and ambiguous-payment (PSP-reliability) monitoring

## Marketplace & recurring billing

- [`marketplace-and-payouts.md`](./marketplace-and-payouts.md) —
  marketplace splits, payout scheduling, connected-account KYC gating
- [`subscriptions.md`](./subscriptions.md) — the subscription state
  machine, how billing/dunning/crash-recovery/plan catalog &
  proration/trial-verification work, and what's still simplified

## Compliance & what's next

- [`compliance-and-security.md`](./compliance-and-security.md) — why
  PCI DSS tokenization, AML/KYC payout gating, and agentic-payment
  delegation scope are business decisions, not just engineering choices
- [`future-directions.md`](./future-directions.md) — business
  capabilities written in domain language rather than implementation
  terms: marketplace splits, subscriptions, risk tiering/reserves,
  dispute resolution policy, cross-border settlement, and agentic
  payments all have a real mechanism built now — this covers what's
  still only partly done in each, plus the business framing throughout

## Client SDKs

- [`sdk/`](./sdk/) — why this platform ships a first-party Node/
  TypeScript client rather than relying on API documentation alone

## Reference

- [`glossary.md`](./glossary.md) — domain terms as used in this
  codebase specifically
