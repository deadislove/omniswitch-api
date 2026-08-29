# Business Domain Guide

You've just joined the team and you're staring at a codebase that talks
about acquirers, reserves, dunning, KYC gating, and delegated spend
policies. This document is the fast path to understanding *why* the code
is shaped the way it is — read it before you read the code. It's a guided
tour through the business concepts this system models, in the order
they build on each other, not an exhaustive reference (each section links
to the deeper doc that *is* the exhaustive reference for that topic).

If you only have twenty minutes, read up through "The ledger: how money
actually gets accounted for" — that's the part every other feature in
this system sits on top of.

---

## 1. What this system actually is

OmniSwitch is a **payment gateway** — the layer a business (a
"merchant") integrates with to accept card payments, without talking to
Stripe or Adyen directly itself. Concretely, three parties exist in
every transaction this system models:

- **The platform (this system)** — routes a charge to whichever PSP
  (Payment Service Provider — Stripe or Adyen here) makes sense, books
  the accounting, handles the money-movement edge cases (refunds,
  disputes, retries) so the merchant doesn't have to.
- **The merchant** — a tenant of this gateway (`MerchantEntity`). Not
  the shopper — the business being paid. Every API call is authenticated
  *as* a merchant (or, for agentic payments, as an agent acting on a
  merchant's behalf — see §9).
- **The PSP** — Stripe or Adyen, abstracted behind `PSPAdapterPort` so
  the rest of the system never branches on "which processor." A mock PSP
  server (`scripts/mock-psp/server.js`) stands in for both in
  development — it mimics their real API shapes closely enough that
  swapping in real credentials wouldn't change any application code.

A `Merchant` isn't just an identity — it's a bundle of configuration
that changes how *every* charge for that merchant behaves: its own fee
rate (flat or volume-tiered), its own settlement currency, its own
reserve policy, whether it's a marketplace platform or a connected
sub-merchant. New engineers often assume "the merchant" is basically a
foreign key; in this codebase it's closer to a per-tenant policy object
that `ChargeLedgerParamsResolverService` reads on every single charge.

## 2. A payment's lifecycle

A `Payment` (`PaymentAggregate`) is not just "pending → done." It's an
explicit state machine:

```
PENDING → PROCESSING → SUCCEEDED
                     ↘ REQUIRES_ACTION (3DS challenge) → SUCCEEDED / FAILED
                     ↘ REQUIRES_CAPTURE (manual capture) → PARTIALLY_CAPTURED → SUCCEEDED
                     ↘ FAILED
SUCCEEDED → PARTIALLY_REFUNDED → REFUNDED
SUCCEEDED → DISPUTED → SUCCEEDED (won) / REFUNDED (lost)
```

Every transition is validated (`assertValidTransition` in
`payment-status.vo.ts`) — you cannot, for example, refund a `PENDING`
payment or capture an already-`SUCCEEDED` one. If you're adding a new
terminal state or a new way money can move, this state machine is where
you start, not the controller.

The single most important design fact here: **`PaymentCheckoutSaga` is
the only code path that ever calls a PSP to charge money**, and every
other feature (subscriptions billing a period, a marketplace split, a
proration charge) reuses that exact saga rather than writing its own
"call the PSP" logic. If you're building a new feature that needs to
move money, your first question should be "can I express this as a call
into `PaymentCheckoutSaga.execute()`?" — the answer is almost always
yes, and it's what every existing feature in this codebase does.

Full detail: [`../business-domain/payment-lifecycle.md`](../business-domain/payment-lifecycle.md).

## 3. The ledger: how money actually gets accounted for

This is the part that surprises engineers coming from a "just call
Stripe" mental model: **this system keeps its own double-entry books**,
independent of whatever Stripe/Adyen's own dashboard says. Every charge
books at least two ledger entries (e.g. a `MERCHANT` credit and a `FEE`
debit) that must net to zero — that's what "double-entry" means here,
and it's enforced structurally, not just by convention.

Two things make this non-trivial:

- **The Outbox pattern.** A ledger entry is written to the database in
  the *same transaction* as the payment's status change — never
  speculatively before a PSP is actually confirmed to have charged the
  card, and never separately (which could leave money "charged" in
  Stripe's world but unaccounted in ours if the process crashed between
  the two writes). A background relay (`LedgerOutboxRelayService`, every
  10 seconds) then publishes those entries — the same "commit the fact
  atomically, ship it out asynchronously" shape you'd use with a real
  message broker in production, just backed by Postgres instead of Kafka
  here.
- **`ChargeLedgerParamsResolverService`** is the one place that resolves
  *everything* a charge's ledger entries need — the platform fee rate
  (flat or volume-tiered), an optional FX settlement conversion, an
  optional reserve withholding, optional marketplace splits — from a
  single merchant lookup, shared by every caller that ever books a
  charge (the saga, manual capture, and the async webhook-confirmed
  path). This used to be three separate, silently-drifting copies of the
  same logic; if you're adding a new per-charge financial concern, it
  goes here, once, not in each caller.

Full detail: [`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md)
— this is the single densest doc in this repo (fee model, FX,
reserves, marketplace splits, smart routing, reconciliation) and worth a
full read once you're past the basics.

## 4. Smart PSP routing

A charge doesn't go to "the PSP" — `AcquirerRoutingService` picks one
based on the card's BIN (issuing country/brand), the amount, and each
PSP's live health (a Redis-backed circuit breaker,
`RedisCircuitBreakerService`, tracking success rate/latency per
provider). If the chosen PSP's *call* throws (times out, connection
refused), the saga automatically retries against the other PSP — but if
the PSP responds normally with a decline, that's a real business
outcome, not a technical failure, and it does **not** trigger a
fallback. This distinction (thrown exception vs. a normal declined
response) shows up repeatedly across the codebase — e.g. it's exactly
why decline-code-aware dunning (§6) only classifies *real* PSP decline
codes, not routing exceptions.

Full detail: [`../business-domain/ledger-and-settlement.md#smart-psp-routing`](../business-domain/ledger-and-settlement.md#smart-psp-routing).

## 5. Recurring billing / subscriptions

A `Subscription` is a genuinely different domain object from a payment
— it doesn't *have* a status the way a payment does, it *produces* a new
`Payment` every billing period (`SubscriptionService.runBillingSweep()`,
daily `@Cron` + on-demand). Each period's charge goes through the exact
same `PaymentCheckoutSaga` a one-time charge does — same routing, same
ledger booking, same 3DS handling — so a subscription renewal is never a
second, drifting implementation of "charge a card."

What makes this domain genuinely subtle:

- **Trials verify the payment method before ever starting** — a real
  SetupIntent (Stripe) / zero-value authorization (Adyen), confirming
  the card is chargeable without moving money, so a trial doesn't
  discover a dead card only when it finally tries to convert weeks
  later.
- **Dunning is decline-code-aware.** A retryable decline
  (`insufficient_funds`) gets a day 1/3/7 backoff; a hard decline
  (`stolen_card`, `expired_card`, ...) skips the retry schedule entirely
  and cancels immediately — retrying a stolen-card charge is actively
  harmful, not just futile.
- **Crash-recovery uses a deterministic id, not a distributed
  transaction.** Each subscription+period is charged under
  `uuidv5(subscriptionId:periodEnd)` — if the process crashes after a
  charge succeeds but before the subscription's period advances, the
  next sweep tick recognizes the period was already paid (same
  deterministic id) and advances without charging twice.
- **A `Plan` is a reusable catalog entry**, not a live reference — a
  subscription created from a `Plan` snapshots the amount/interval at
  creation time, so editing a `Plan` later never retroactively repriced
  an existing subscriber.

Full detail: [`../business-domain/subscriptions.md`](../business-domain/subscriptions.md).

## 6. Marketplace & split payments

A `Merchant` can be a `PLATFORM` (the default — every merchant that
predates this feature) or a `CONNECTED` sub-merchant onboarded under a
specific platform. A platform's charge can route part of its net
proceeds directly to one or more connected merchants (`splits` on
`POST /payments/charge`) — each split books its own `MERCHANT` ledger
credit, validated *before* the PSP is ever called (an invalid split
recipient must never leave a charged-but-unbooked payment behind).

Two gates layer on top of a connected merchant's payout, and they're
deliberately orthogonal, mirroring real Stripe Connect's own
`charges_enabled`/`payouts_enabled` split:

- **KYC gates payouts, not charges.** A connected merchant with
  unverified KYC can still receive split credits into its ledger
  balance — `PayoutService` still creates a `Payout` record for it, just
  flagged `kycBlocked`, so the accounting stays correct even before KYC
  clears.
- **A rolling reserve** withholds part of a payout's net amount for a
  hold period before it's transferable, same shape as the per-charge
  merchant reserve (§7) but applied at payout time.

Only once both gates clear does `PayoutService.initiateTransfer()` send
money through a (mocked) bank rail.

Full detail: [`../business-domain/ledger-and-settlement.md#marketplace-splits`](../business-domain/ledger-and-settlement.md#marketplace-splits).

## 7. Merchant risk tiering & reserves

Beyond marketplace payouts, *any* merchant can have a reserve policy
(`reserveBps`/`reserveHoldDays`) — a slice of each charge's net amount
withheld into a `RESERVE` ledger account and released later, either on a
schedule or by an operator's manual override. `RiskTieringService`
recomputes this automatically for auto-managed merchants based on their
trailing lost-dispute rate — a merchant with a rising chargeback rate
gets a bigger reserve without an operator noticing and reacting late; a
manual override (an operator setting the policy by hand) sticks and
isn't silently clobbered by the next automated sweep.

Full detail: [`../business-domain/ledger-and-settlement.md#merchant-risk-tiering--reserves`](../business-domain/ledger-and-settlement.md#merchant-risk-tiering--reserves).

## 8. Disputes & chargebacks

A `Dispute` only ever originates from the PSP via webhook — there's no
API to create one directly, because a real chargeback is initiated by
the cardholder's bank, not by this system. Once one exists, it has its
own lifecycle (`NEEDS_RESPONSE → UNDER_REVIEW → WON/LOST`, though
`UNDER_REVIEW` isn't mandatory — the PSP can hand back a final
`WON`/`LOST` straight from `NEEDS_RESPONSE`, e.g. a withdrawn dispute or
a lapsed response window with no evidence ever submitted), a response
deadline, and — the part worth knowing before you touch it — an
**automatic decision policy**: every new dispute is classified
`ACCEPT`/`CONTEST`/`MANUAL_REVIEW` by amount and reason code, and
`CONTEST` immediately auto-submits templated evidence to the PSP for
real, no operator action. A `LOST` dispute claws funds back through the
exact same ledger path a refund uses.

Full detail: [`../business-domain/payment-lifecycle.md#dispute-accounting`](../business-domain/payment-lifecycle.md#dispute-accounting).

## 9. Cross-border settlement

A merchant can be paid out in a currency different from whatever
currency a charge was made in (`settlementCurrency`) — converted via a
real (mocked) `FXRateProviderPort` at charge time and booked as two
correctly-balanced ledger legs. The detail that catches people off
guard: **a refund or lost dispute replays the *original* charge-time
rate**, not a fresh lookup — otherwise a merchant could be charged back
more or less than they actually received, a real double-entry mismatch
this system specifically closes. `presentmentCurrency` is a separate,
purely-cosmetic concept — what the *customer's* statement shows, never
touching what's actually captured or settled.

Full detail: [`../business-domain/ledger-and-settlement.md#fx-conversion-merchant-settlement-currency`](../business-domain/ledger-and-settlement.md#fx-conversion-merchant-settlement-currency).

## 10. Agentic payments: delegation & spend policy

The newest domain concept here, and the one that breaks the assumption
every other feature makes: that a request is either "a merchant's own
authenticated call" or "not authorized at all." An autonomous agent
acting on a human's behalf needs a *narrower* grant than the merchant's
own full-access credential — a `Delegation` (`POST /delegations`) is
exactly that: a merchant authorizes an agent with its own `SpendPolicy`
(per-transaction limit, rolling monthly limit, optional category
allowlist), and gets back a JWT scoped to `UserRole.AGENT` that's
accepted on exactly one route, `POST /payments/charge` — everywhere else
returns a plain 403.

The spend policy is enforced *before* the checkout saga ever calls a
PSP, via a single atomic `UPDATE ... WHERE` that both checks the limits
and reserves the amount in one step (so two concurrent charges from the
same agent can't jointly blow through the monthly cap) — the same
race-safe pattern this codebase already used for reserve releases and
KYC clearing, just applied to a new kind of limit. Revoking a delegation
reuses the *existing* JWT jti-revocation mechanism verbatim (the same
one `POST /auth/revoke` logout uses) — it takes effect on the agent's
very next request, not after its token naturally expires.

Full detail: [`../business-domain/future-directions.md#agentic-payments`](../business-domain/future-directions.md#agentic-payments).

## 11. What's deliberately not modeled yet

Every capability above has a real, working mechanism — this isn't a list
of half-built features. It's the specific parts that are illustrative,
uncalibrated, or intentionally out of scope: risk-tiering thresholds
that demonstrate the mechanism rather than reflect real fraud data,
dispute auto-decision rules not calibrated against real chargeback
win-rates, no VAT/tax modeling, no hedging product for cross-border FX
risk, no human-approval step for above-threshold agent purchases. See
the top-level [`README.md`](../../README.md#known-limitations)'s
"Known Limitations" section for the full, current list, and
[`future-directions.md`](../business-domain/future-directions.md) for
the business reasoning behind each.

## Where to go next

- Terms you'll see throughout the code but that mean something specific
  *here*: [`../business-domain/glossary.md`](../business-domain/glossary.md).
- How this maps onto actual modules, files, and design patterns:
  [`system-design.md`](./system-design.md).
- The actual HTTP surface for everything described above:
  [`api/README.md`](./api/README.md).
