# Future Business Directions

The other documents in this folder describe the domain as it exists today:
a single charge, its lifecycle, and how it's settled. This document is
different — it's about business capabilities this system doesn't have at
all yet, written in domain language rather than implementation terms. None
of this is designed in detail; it's a map of where the domain model would
need to grow, and why each direction is a genuinely new concept rather than
an extension of something that already exists.

For the engineering-priority version of "what's missing" (migrations,
observability, secret management, etc.), see
[`../../DEV_README.md`](../../DEV_README.md). This document is scoped to
new *business* capabilities specifically.

---

## Recurring Billing / Subscriptions

A `Subscription` is now its own domain object, genuinely distinct from a
one-time charge: it has a real lifecycle (`TRIALING` → `ACTIVE` ↔
`PAST_DUE` → `CANCELED`), its own billing cadence, and a dunning policy
with a real day 1/3/7 backoff schedule (not a flat retry-every-tick
policy). A subscription can also be created against a reusable `Plan`
(catalog entry — name/amount/currency/interval) instead of carrying its
own pricing directly, and `POST /subscriptions/:id/change-plan` prorates
the remaining part of the current period when switching plans mid-cycle
— charging immediately for an upgrade, or issuing a credit applied
against a future period's charge for a downgrade. Both a `PAST_DUE`
transition and a cancellation now emit real `EventEmitter2` events too.
Trials now verify the payment method for real before ever starting one —
`PSPAdapterPort.verifyPaymentMethod()` (Stripe's real SetupIntent
primitive; a zero-value authorization for Adyen), confirming the card is
chargeable without moving any money — instead of trusting whatever
`paymentMethodId` was supplied and only discovering it was bad weeks
later when the trial converts. Dunning is now decline-code-aware, too:
a hard decline (`stolen_card`, `lost_card`, `fraudulent`, `pickup_card`,
`restricted_card`, `expired_card`) skips the day 1/3/7 retry schedule
and cancels the subscription immediately instead of retrying a charge
that's actively harmful to keep re-attempting, while a retryable
decline (`insufficient_funds` and friends) still gets the existing
backoff — and the emitted events now carry the decline code so a
listener can tell a hard-decline cancellation apart from one where
dunning simply ran out of attempts. See
[`subscriptions.md`](./subscriptions.md) for the full domain writeup and
[`../../DEV_README.md`](../../DEV_README.md#recurring-billing--subscriptions---resolved)
for the technical mechanism. That closes the core gap this section used
to describe — "everything models a single, one-time charge" — along
with the plan-catalog/proration, downgrade-credit, dunning-backoff,
event-emission, trial-verification, and decline-code-awareness gaps
that used to be listed here.

What's still genuinely missing:
- **The hard-decline code set is illustrative, not calibrated.** It's a
  small, reasonable-looking set of Stripe/Adyen-style codes, not
  validated against real-world decline-code taxonomies or
  acquirer-specific variations — a real system would likely need this
  configurable per-PSP.
- **A real notification integration.** `subscription.past_due`/
  `subscription.canceled` are now genuinely emitted events, but nothing
  in this codebase is actually subscribed to them yet — no email, no
  Slack, no paging. The same stand-in posture as this codebase's other
  "alert on-call in production" gaps.

## Marketplace & Split Payments

A `MerchantEntity` can now be a `PLATFORM` (the default, unchanged from
every merchant that existed before this) or a `CONNECTED` account
onboarded under a specific platform, and `POST /payments/charge`'s
`splits` routes part of a charge's net proceeds directly to one or more
connected merchants at charge time — the platform/connected-account
relationship and the charge-time split-rule question this section used to
list as missing. A refund or lost dispute on a split payment now reverses
each recipient proportionally too, rather than only ever debiting the
platform's own account. A connected merchant's split proceeds are now
batched into scheduled `Payout` records with a rolling reserve, instead
of being available the instant they're credited. A connected account now
goes through a real (mocked) KYC review before its payouts can actually
be transferred — gating payouts, not charges, the same
`charges_enabled`/`payouts_enabled` distinction real Stripe Connect
draws — and a `Payout`'s net amount can be sent via a real (mocked) bank
transfer instead of sitting as an accounting record with no rail to move
money. See
[`ledger-and-settlement.md`](./ledger-and-settlement.md#marketplace-splits)
and [`../../DEV_README.md`](../../DEV_README.md#marketplace--split-payments-phase-1---resolved)
for the full mechanism.

What's still genuinely missing:
- **A real KYC review.** The mock decision is synchronous and
  marker-driven (a `legalName` substring), not an actual human/AI
  reviewer working over days the way a real provider (Persona, Onfido,
  Stripe Identity) does.
- **A follow-up transfer for a reserve released after its payout's net
  amount was already sent.** Transfer initiation only ever covers
  `netAmount` — if the reserve is released later, this system has no
  mechanism to send it in a subsequent transfer. See
  [`ledger-and-settlement.md`](./ledger-and-settlement.md#payout-kyc-gating-and-real-transfer-initiation)
  for the fuller reasoning.
- **A real bank/ACH/wire rail.** `BankTransferPort`'s mock resolves
  "sent" synchronously; a real transfer settles over days and would need
  its own webhook-driven confirmation the way dispute resolution/3DS do.
- **Multi-party splits with per-recipient FX.** A split charge can't be
  combined with the platform's own settlement-currency conversion at all
  today, let alone give each connected account its own settlement
  currency.

## Merchant Risk Tiering & Reserves

A merchant can now have a reserve rate and hold period
(`MerchantEntity.reserveBps`/`reserveHoldDays`) — a configurable slice of
each charge's net amount is withheld into a per-merchant reserve and
released later, either automatically once the hold period elapses or by
an operator's manual override. See
[`ledger-and-settlement.md`](./ledger-and-settlement.md#merchant-risk-tiering--reserves)
for the ledger mechanics and
[`../../DEV_README.md`](../../DEV_README.md#merchant-risk-tiering--reserves---resolved)
for the full technical writeup. That closes the mechanical half of this
gap — "there's no way to hold back part of a payout" — the same shape
the FX conversion and dispute-resolution sections above describe closing
for their own gaps.

A basic *risk* half now exists too: `RiskTieringService` recomputes each
auto-managed merchant's trailing lost-dispute rate and adjusts
`reserveBps`/`reserveHoldDays` automatically — both up and down, not just
escalating — with a manual-override escape hatch
(`MerchantEntity.riskTierAutoManaged`) so an operator's hand-tuned reserve
doesn't get silently overwritten. This is the connection to the
dispute-resolution outcomes this section used to flag as missing: a lost
dispute is exactly the signal driving the tier. See
[`../../DEV_README.md`](../../DEV_README.md#merchant-risk-tiering--reserves---resolved)
for the full mechanism.

What's still genuinely missing is a *real* underwriting model — what was
built is explicitly a mechanism demonstration, not a calibrated one:
- **The thresholds are illustrative, not calibrated.** Three round-number
  buckets driven by one trailing-90-day lost-dispute-rate calculation —
  not derived from real fraud/chargeback data, and not something a real
  risk team would sign off on as-is.
- **Missing signals.** A real risk tiering system would also weigh MCC
  code, account tenure, industry risk category, and KYC/verification
  status — none of which this platform tracks in a form this service
  reads today.
- **No dispute *reason*-code awareness.** A `fraudulent` dispute and a
  `product_not_received` dispute carry very different risk signal; this
  service treats every `LOST` dispute identically regardless of why it
  was lost.
- **No retroactive question answered.** A tier change only ever affects
  charges going forward (same posture as a manual `reserve-policy` PATCH)
  — there's no policy for whether a sudden risk change should also affect
  reserves already withheld from earlier charges.

## Dispute Resolution Workflow

A `Dispute` is now its own domain object with a real lifecycle
(`NEEDS_RESPONSE` → `UNDER_REVIEW` → `WON`/`LOST`), a response deadline
(`respondBy`), and a representment path — `POST /admin/disputes/:id/evidence`
actually calls the PSP and only advances the dispute if it accepts the
evidence; `GET /admin/disputes` and `GET /admin/disputes/:id` make the
deadline visible to an operator. See
[`../../DEV_README.md`](../../DEV_README.md#6-disputechargeback-handling-is-webhook-only---resolved)
for the full mechanism, and [`payment-lifecycle.md`](./payment-lifecycle.md)
for how a lost dispute claws funds back through the same ledger path a
refund uses. That closes the "no way to act on a dispute" gap this section
used to describe.

A basic *policy* layer now sits on top of that mechanism too:
`DisputeService.recordDispute()` classifies every new dispute as
`ACCEPT`/`CONTEST`/`MANUAL_REVIEW` (amount threshold first, then a small
reason-code table), automatically submits templated evidence for the
`CONTEST` case, and every dispute now carries reason-code-specific
`evidenceGuidance` for whoever ends up handling it. Creation and
resolution also emit structured `dispute.created`/`dispute.resolved`
events, not just a log line. See
[`../../DEV_README.md`](../../DEV_README.md#dispute-resolution-policy-layer---resolved)
for the full mechanism — including a real, previously-undiscovered bug
(a duplicate `EventEmitterModule.forRoot()` call silently splitting the
app's event bus in two) the new event-emission tests happened to surface.

What's still genuinely missing is a *real*, calibrated version of this —
what was built is explicitly a mechanism demonstration, same posture as
`RiskTieringService`'s reserve tiers:
- **Illustrative, not calibrated, thresholds.** The amount cutoff and
  auto-contestable reason-code table aren't derived from real chargeback
  win-rate data.
- **No connection to the merchant's own risk tier.** `RiskTieringService`
  already reads dispute *outcomes* to set a merchant's reserve, but the
  relationship is one-way — the dispute policy doesn't read a merchant's
  risk tier back to decide, say, "auto-contest more aggressively for a
  LOW-risk merchant with a strong track record."
- **No decline-code-nuanced learning.** The policy is static; a real
  system would adjust its auto-contestable reason-code list over time
  based on which reasons this specific platform's merchants actually win.
- **No real notification integration.** The event hook exists, but
  nothing is actually subscribed to it yet — no email, no Slack, no
  paging. The *merchant* still has no path telling them a dispute needs
  attention, only an operator polling `GET /admin/disputes`.

## Cross-Border Settlement & Tax

`Money.convertTo()` now has real callers on both sides of a charge.
`settlementCurrency` gets a merchant paid out in a currency different
from whatever currency they were charged in, via a real (mocked)
`FXRateProviderPort`; refunds and lost disputes now replay that *same*
charge-time rate rather than booking against the merchant in the charge
currency regardless of what they actually received (they used to — a
real double-entry mismatch this now closes); and `presentmentCurrency`
lets a charge request show a converted display amount without touching
what's actually captured or settled. See
[`ledger-and-settlement.md`](./ledger-and-settlement.md#fx-conversion-merchant-settlement-currency)
and its
[refunds/disputes](./ledger-and-settlement.md#refunds-and-lost-disputes-replay-the-original-charge-time-rate)/
[presentment](./ledger-and-settlement.md#presentment-currency) follow-up
sections for the mechanism, and a real double-entry-bookkeeping/TypeORM
bug found building the first piece.

What genuinely remains:
- **No hedging/rate-lock *product*.** This system quotes at charge time
  and nothing before that — a merchant can't lock in a rate ahead of a
  sale the way real cross-border processors sometimes let them. In the
  narrower sense of "who bears the risk for a *given* payment's own
  lifecycle," this is now answered (the platform does, by locking the
  charge-time rate and reusing it verbatim for that payment's captures/
  refunds/dispute losses) — but that's a mechanical consequence of the
  refund-netting fix above, not a considered hedging policy.
- **VAT/tax handling** varies by jurisdiction and is arguably out of
  scope for this system to compute itself (usually delegated to a
  specialized tax-calculation service), but the domain model would still
  need a place to record what was charged and why.

---

## Agentic Payments

The standards in this space (Stripe's agentic commerce tooling, Google's
Agent Payments Protocol, various agent-to-agent authorization proposals)
are still actively evolving as of this writing, so this deliberately
implements the durable *business* mechanism — delegation and spend
policy as first-class domain concepts — rather than betting on any one
still-moving protocol shape. The technical/architectural side is covered
separately in
[`../../DEV_README.md`](../../DEV_README.md#ai-agents--agentic-payments).

### Why this isn't just "another API caller"

Every payment in this system was previously attributed only to a
`Merchant` — a business entity operating in its own interest, whose
employees are presumed authorized to act for it (RBAC governs *what*
they can do, not whether they're allowed to represent the merchant at
all). An autonomous agent acting on behalf of a human principal breaks
that assumption: the agent isn't the principal, doesn't have the
principal's full authority, and the principal typically wants to grant a
*narrow, revocable, auditable* slice of purchasing power rather than
their full account access — closer to a limited power of attorney than
to an employee/RBAC role. That's the relationship a `Delegation` now
models.

### What's now built

- **Delegation as a first-class credential, distinct from authentication.**
  `POST /delegations` lets a merchant (`UserRole.MERCHANT`/`ADMIN`)
  authorize a named agent with its own spend policy, returning a
  narrowly-scoped JWT (`roles: [AGENT]`) the agent authenticates with —
  a materially different claim from "this is a valid merchant credential."
  That token is accepted on exactly one route, `POST /payments/charge`
  (see `PaymentController.charge()`'s `AGENT` branch) — every other
  endpoint's `@Roles()` simply doesn't list `AGENT`, so an agent token
  gets a plain 403 anywhere else, which is the "narrow" half of "narrow,
  revocable, auditable" made concrete rather than aspirational.
- **Spend policy as a real, enforced business object**, not just a rate
  limit. `SpendPolicy` (per-transaction limit, rolling calendar-month
  limit, optional category allowlist) is checked — and atomically
  reserved against, race-safely, before the checkout saga ever calls a
  PSP — on every agent-initiated charge. A charge that would breach any
  of the three is rejected with a specific 422 error code
  (`DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED`,
  `DELEGATION_MONTHLY_LIMIT_EXCEEDED`, `DELEGATION_CATEGORY_NOT_ALLOWED`)
  before a `Payment` row is even created; a charge that goes on to
  actually fail at the PSP releases its reservation, so a declined
  attempt doesn't permanently eat into the agent's budget.
- **Revocation as ongoing state, not a one-time grant.**
  `POST /delegations/:id/revoke` reuses this codebase's existing JWT
  jti-revocation mechanism verbatim (see
  [`../technical/security-and-compliance.md`](../technical/security-and-compliance.md#jwt-revocation))
  — the same real-time check `POST /auth/revoke` (logout) already relies
  on — so a revoked delegation's still-unexpired token is rejected on
  its very next request, not just once it naturally expires.
- **Attribution on the audit trail.** An agent-initiated charge records
  `delegationId`/`initiatedBy` on the resulting `Payment`'s existing
  metadata bag, so "who/what actually initiated this charge" is
  answerable from the payment record itself, the same "domain events +
  correlation IDs are already the audit trail" posture
  `DEV_README.md`'s agentic-payments section already anticipated —
  extended here rather than inventing a parallel logging path.

### What's still genuinely missing

- **Liability and dispute attribution.** If an agent makes an incorrect
  or unauthorized purchase, who is responsible for resolving it — the
  platform, the merchant that got paid, or whoever operates the agent?
  The dispute model has no concept of a non-human initiator at all, let
  alone how liability should be attributed when one is involved. This is
  a real open question in the industry right now, not something this
  project can resolve unilaterally — the audit trail above (which
  delegation, under what policy) is a necessary building block for
  answering it later, not an answer itself.
- **A different risk posture for agent-initiated charges.**
  `PaymentAggregate.calculateRiskScore()` still reasons about amount and
  card origin — signals that make sense for a human, card-present-adjacent
  transaction. An agent transacting autonomously has different risk
  signals entirely (is this purchase consistent with the agent's normal
  velocity, has this exact agent/principal pairing transacted with this
  merchant before); none of that exists today — an agent-initiated charge
  is scored identically to a human-initiated one.
- **A human-approval step for above-threshold purchases.** The business
  framing this section originally described ("ask me first for anything
  above $200") isn't built — a charge either fits the delegation's
  policy or it's rejected outright; there's no "hold for human approval"
  intermediate state. `Delegation`'s spend-policy check is the natural
  place this would plug in, but it's a genuinely new async flow (the
  charge request would need to pause, not just succeed/fail), not an
  extension of the current synchronous reserve-then-charge path.
- **Per-request agent signing.** `HmacSignatureGuard` exempts an
  `AGENT`-authenticated request from the HMAC requirement entirely (see
  that guard's docblock) — the delegation JWT's own possession is this
  MVP's authenticity proof. A real deployment would likely want a
  per-agent signing key so a stolen JWT alone (bearer token, same as any
  JWT in this codebase) isn't sufficient to charge — HMAC request signing
  already exists in this codebase for merchant calls and could extend to
  agent credentials the same way, but doesn't yet.
- **Standards alignment.** Stripe's agentic commerce tooling, Google's
  Agent Payments Protocol, and various agent-to-agent authorization
  proposals are all still evolving; `Delegation`/`SpendPolicy` implement
  the underlying business mechanism these standards are converging
  toward, not any one of their specific wire formats.
