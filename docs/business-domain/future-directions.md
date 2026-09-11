# Future Business Directions

The other documents in this folder describe the domain as it exists
today. This document is scoped differently — it lists genuine remaining
gaps in business capabilities that are otherwise already built, written
in domain language rather than implementation terms. What's already been
built for each capability is documented in full elsewhere (linked below,
per section) — this file doesn't repeat it, only what's still missing.
None of the gaps below are designed in detail; this is a map of where the
domain model would still need to grow, and why each direction is a
genuinely new concept rather than a small extension of something that
already exists.

For the engineering-priority version of "what's missing" (migrations,
observability, secret management, etc.), see
[`../../DEV_README.md`](../../DEV_README.md). This document is scoped to
new *business* capabilities specifically.

---

## Recurring Billing / Subscriptions

See [`subscriptions.md`](./subscriptions.md) and
[`../../DEV_README.md`](../../DEV_README.md#recurring-billing--subscriptions---resolved)
for the mechanism.

What's still genuinely missing:
- **The hard-decline code set is illustrative, per-PSP but not
  calibrated (Phase 1).** `HARD_DECLINE_CODES` used to be one shared
  `Set<string>` — but `errorCode` reaching `classifyDeclineCode()` was
  never normalized between PSPs (Stripe's own `decline_code` strings vs
  Adyen's own numeric `refusalReasonCode` strings), so a shared set only
  ever matched Stripe's vocabulary; every real Adyen hard decline
  silently fell through to `RETRYABLE`. Now `Record<PSPProvider,
  Set<string>>`, with `pspProvider` threaded through
  `recordFailedCharge()`/`classifyDeclineCode()` from the saga's own
  result. Each PSP's set is still a small, reasonable-looking one, not
  validated against real-world decline-code taxonomies or every
  acquirer-specific variation — same illustrative-not-calibrated posture
  as the risk-tier thresholds themselves. See
  `subscription.aggregate.spec.ts`.
- **A real notification integration — ✅ resolved (Phase 1).**
  `SubscriptionNotificationListener` now subscribes
  `subscription.past_due`/`subscription.canceled` to a real
  per-merchant email/Slack/webhook delivery
  (`PATCH /admin/merchants/:id/subscription-notification-channel`),
  the same three-channel shape `DisputeNotificationDispatcherService`
  already established for dispute events — the actual HTTP-send/HMAC-
  signing mechanics are shared code
  (`src/modules/payment/adapters/notifications/
  notification-delivery.util.ts`), not copy-pasted per event family,
  but the channel/target fields themselves
  (`subscriptionNotificationChannel`/`subscriptionNotificationTarget`)
  are independent of disputes' own — a merchant can reasonably want
  Slack for disputes and email for billing. See
  `test/subscription-notification.e2e-spec.ts`.

## Marketplace & Split Payments

See [`marketplace-and-payouts.md`](./marketplace-and-payouts.md#marketplace-splits)
and [`../../DEV_README.md`](../../DEV_README.md#marketplace--split-payments-phase-1---resolved)
for the mechanism.

- **Multi-party splits with per-recipient FX — ✅ resolved.** A split
  charge now composes with the platform's own settlement-currency
  conversion, and each connected account can independently have its own
  settlement currency — see
  [`marketplace-and-payouts.md`](./marketplace-and-payouts.md#splits--each-partys-own-settlement-currency-conversion-phase-2).

## Merchant Risk Tiering & Reserves

See [`risk-and-fraud.md`](./risk-and-fraud.md#risk-tiering-chargeback-driven-reserves)
for the full business-policy writeup,
[`ledger-and-settlement.md`](./ledger-and-settlement.md#merchant-risk-tiering--reserves)
for the ledger mechanics, and
[`../../DEV_README.md`](../../DEV_README.md#merchant-risk-tiering--reserves---resolved)
for the technical build history.

What's still genuinely missing is a *real* underwriting model — what was
built is explicitly a mechanism demonstration, not a calibrated one:
- **The thresholds are illustrative production defaults, not calibrated
  against real data — but a real calibration *methodology* has been run,
  against a synthetic stand-in for the real data this repo doesn't have.**
  `scripts/calibration/generate-synthetic-history.ts` generates 2,000
  synthetic merchants from a deliberately realistic, skewed risk mixture
  (85% low-risk, 12% medium, a 3% high-risk tail — not a bell curve,
  matching how real payment-platform risk is actually distributed), each
  with a *known* true risk label plus a settled-charge volume and lost-dispute
  count sampled from that label (log-normal volume, Poisson-sampled
  disputes — real sampling noise, not a clean signal).
  `scripts/calibration/calibrate-thresholds.ts` then does what a real
  calibration pass would: scores `RiskTieringService`'s current fixed
  thresholds (HIGH >1%, MEDIUM >0.5%) against the *known* labels
  (something only checkable here because the labels are synthetic ground
  truth — real production data has no such answer key), derives
  percentile-based thresholds from the data itself, and scores those too.
  Run against the fixed seed both scripts use (reproducible — same
  numbers every run):

  | | precision | recall |
  |---|---|---|
  | Current fixed (HIGH >1%) | 20.1% | 77.8% |
  | Data-derived (HIGH >2.13%, the 95th percentile) | 36.0% | 71.1% |

  No clean winner — the fixed threshold catches more true high-risk
  merchants (higher recall) at the cost of far more false positives
  (lower precision); the derived one is more than twice as precise but
  misses more real risk. That's a genuine precision/recall trade-off a
  real team would need real business context (what does a false positive
  actually cost vs. a false negative?) to resolve — not something either
  number alone settles. The percentile-derived *MEDIUM* threshold came
  out at 0.00%, a real, informative artifact: at this synthetic
  population's volume, the 80th-percentile merchant has *zero* lost
  disputes — percentile-based calibration breaks down on a
  zero-inflated metric like this one without a much larger sample, a
  concrete finding this exercise surfaced that a purely theoretical
  writeup wouldn't have. `RISK_TIER_HIGH_THRESHOLD`/
  `RISK_TIER_MEDIUM_THRESHOLD` (env-configurable, `RiskTieringService`'s
  constructor) stay at their original defaults — this synthetic
  exercise validates the *methodology*, not a number to actually ship;
  the real path forward is running the same two scripts' logic against
  real historical `(merchantId, trailing lost-dispute rate, actual
  future loss outcome)` data once it exists (a real calibration would
  likely end up fitting a model rather than two fixed cutoffs at all —
  this exercise's precision/recall framework is exactly what would score
  that model too). See
  [`../technical/threshold-calibration.md`](../technical/tests/threshold-calibration.md)
  for how to run it.
- **The new-merchant-age escalation (below) is now calibrated against
  the same synthetic population, not just plausibility-argued.** The
  synthetic generator now also assigns each merchant an `accountAgeDays`
  independent of its true risk label, with `settledCharges` capped by
  how much volume that age could plausibly have accumulated — modeling
  the actual claim the age-escalation feature makes: a new account's low
  observed rate is less trustworthy, not necessarily lower-risk. Scored
  against the same fixed seed:

  | | precision | recall |
  |---|---|---|
  | MEDIUM+, without age escalation | 45.5% | 43.1% |
  | MEDIUM+, with age escalation (accountAgeDays < 30) | 40.9% | 45.7% |

  On this synthetic population, escalating new accounts trades 4.6
  points of precision for only 2.6 points of recall — a real,
  measured cost, not a clearly-favorable trade. It does catch some
  genuinely-risky new merchants a pure rate threshold would have missed
  (validating the sample-size argument the feature is based on), but not
  by enough margin on this population to call it an unambiguous win. As
  with the thresholds above, this scores the *methodology* and the
  *feature's own internal logic*, not a claim about whether 30 days is
  the right real-world cutoff — see
  [`threshold-calibration.md`](../technical/tests/threshold-calibration.md#what-else-was-considered-and-what-wasnt-added-here)
  for which other Phase 1 risk signals (MCC categories, dispute
  reason-code weights, agent risk-scoring bumps) were considered for
  this same treatment and why they weren't extended here.
- **Missing signals — ✅ resolved (Phase 1).** `RiskTieringService.evaluateMerchant()`
  now factors in three additional, escalation-only modifiers on top of
  the lost-dispute-rate base signal: a merchant's MCC code (operator-set
  via `PATCH .../mcc-code`, mapped to an `industryRiskCategory` via a
  real, public MCC risk classification table —
  `src/modules/merchant/mcc-risk-lookup.ts`) escalates one tier when
  `HIGH`; account age under `RISK_TIER_NEW_MERCHANT_AGE_DAYS` (default
  30) escalates one tier; and an unverified `kycStatus` forces `HIGH`
  outright for `CONNECTED` merchants specifically (meaningless for
  `PLATFORM` merchants, same scope `kycStatus` itself already had).
  Escalation-only by design — a good MCC or long tenure never *lowers*
  what the dispute-rate signal alone would say, only a bad one raises it.
  See `test/risk-tiering.e2e-spec.ts` for the full escalation matrix.
- **Dispute *reason*-code awareness — ✅ resolved (Phase 1), and now
  calibrated against the same synthetic population, not just
  plausibility-argued.** `RiskTieringService` now weights each `LOST`
  dispute by reason code instead of counting them identically
  (`src/modules/payment/domain/services/dispute-risk-weight.ts`):
  `fraudulent` counts at full weight, `product_not_received`/
  `subscription_canceled` at half, `duplicate` at a quarter — reusing the
  exact reason-code vocabulary `dispute-policy.ts`'s auto-contest table
  already established, not a new taxonomy. Two merchants with the
  identical *count* of `LOST` disputes can now land in different tiers
  depending on why those disputes were lost — see
  `test/risk-tiering.e2e-spec.ts`'s reason-code test. The synthetic
  generator now also breaks each merchant's lost disputes down by reason
  code, using a mix correlated with true risk (a genuinely high-risk
  merchant's disputes skew toward `fraudulent`; a genuinely low-risk
  merchant's skew toward benign `duplicate`/`subscription_canceled`
  mixups) — scored against the same fixed seed, importing
  `getDisputeRiskWeight()` directly from production code (not a copy):

  | | precision | recall |
  |---|---|---|
  | HIGH, raw (unweighted) count | 20.1% | 77.8% |
  | HIGH, weighted by reason code | 34.7% | 73.3% |

  A 14.6-point precision gain for a 4.4-point recall cost on this
  synthetic population — a real, measured case for reason-code
  awareness, not just a plausible-sounding idea. As with every other
  exercise here, the *size* of the reason-code/true-risk correlation
  this models is itself an assumption that would need real data to
  confirm.
- **The retroactive question — ✅ resolved for escalation (Phase 1).**
  A manual `reserve-policy` PATCH still only ever affects future charges.
  But when `RiskTieringService`'s own sweep *escalates* a merchant's tier,
  `ReserveService.topUpHeldReservesForMerchant()` now tops up every
  still-`HELD` (not yet released) reserve to the new, higher rate —
  computed against each hold's own original net amount
  (`ReserveHold.netAmount`, added for this), not re-derived from the
  hold's already-withheld slice. One-way by design: only escalation tops
  up; a de-escalation (the merchant's history improved) never claws back
  a reserve already withheld, and a hold already `RELEASED` before the
  escalation is untouched — its funds already left the reserve account.
  See `test/risk-tiering.e2e-spec.ts`'s top-up test for the full
  escalate → release-one-hold → escalate-further → de-escalate sequence.
- **MCC risk category × hard-decline pattern — ✅ resolved, outside the
  calibration framework by design.** A `HIGH`-`industryRiskCategory`
  merchant's tier escalation (above) is a single static signal; it says
  nothing about a *pattern* of hard-declines over time the way ambiguous-
  risk monitoring does for PSP-reliability incidents.
  `AmlReviewMonitoringService` closes that gap: flags a `HIGH`-industry
  merchant once it crosses `AML_REVIEW_HARD_DECLINE_THRESHOLD`
  hard-declines (see `decline-code-classifier.ts`, generalized from
  subscription-only dunning to cover one-off charges too) in a trailing
  `AML_REVIEW_WINDOW_DAYS` window — purely observational, and (unlike
  every other risk signal here) fires a real notification the moment it
  trips, since a HIGH-industry AML-adjacent signal is compliance-relevant
  enough to page someone rather than wait for an operator to next check
  `GET /admin/merchants`. See
  [`risk-and-fraud.md`](./risk-and-fraud.md#aml-review-observation-high-industry-hard-decline-signal)
  for the full design and `test/aml-review-monitoring.e2e-spec.ts` for
  the threshold/notification/manual-override coverage.

## Dispute Resolution Workflow

See [`disputes.md`](./disputes.md) for the full business-policy writeup,
and
[`../../DEV_README.md`](../../DEV_README.md#6-disputechargeback-handling-is-webhook-only---resolved)
plus
[`../../DEV_README.md`](../../DEV_README.md#dispute-resolution-policy-layer---resolved)
for the technical build history.

What's still genuinely missing is a *real*, calibrated version of this —
what was built is explicitly a mechanism demonstration, same posture as
`RiskTieringService`'s reserve tiers:
- **Illustrative, not calibrated against real data — but, same as the
  risk-tiering thresholds above, an actual calibration pass has been run
  against a synthetic stand-in.**
  `scripts/calibration/generate-synthetic-history.ts` also generates
  5,000 synthetic disputes (log-normal amounts, a per-reason-code contest
  win-rate — `fraudulent` hardest to win at 15%, `duplicate` easiest at
  85%, deliberately differentiated rather than one flat rate, since
  that's the whole point of a reason-aware policy).
  `scripts/calibration/calibrate-thresholds.ts` computes, per $2 amount
  bucket, the expected value of contesting (`win rate × amount − an
  assumed $8 operational cost per contest`) and finds the amount where
  that turns non-negative — the real economic break-even point, not a
  guess. On the fixed-seed synthetic run: **break-even at $16**, against
  the current hardcoded `DEFAULT_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS` of
  **$15** — within a dollar, on this synthetic population. Not a claim
  that $15 is *correct* (the win rates and $8 cost are illustrative
  inputs, same posture as everything else in this section), but a real
  computed answer instead of an unchecked guess. `DISPUTE_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS`
  (`DisputeService`'s constructor) stays env-configurable at its original
  default. The real path forward: once `dispute.created`/`dispute.resolved`
  (already emitted) accumulate real production history, replace this
  script's synthetic `disputes` array with a real query over that history
  — the break-even calculation itself doesn't change, only its input
  does — and add real per-reason-code win rates once enough resolved
  `CONTEST`ed disputes exist to compute them, rather than the single
  cost/reason model used here. See
  [`../technical/threshold-calibration.md`](../technical/tests/threshold-calibration.md)
  for how to run it.
- **Connection to the merchant's own risk tier — ✅ resolved.** The
  relationship used to be one-way (`RiskTieringService` read dispute
  *outcomes* to set a merchant's reserve, but the dispute policy never
  read a tier back). `DisputeService.recordDispute()` now re-evaluates
  the merchant's current tier live and adjusts both the auto-accept
  threshold and the auto-contestable reason set — see
  [`disputes.md`](./disputes.md#the-auto-decision-policy) for the
  resulting table.
- **No decline-code-nuanced learning.** The policy is static; a real
  system would adjust its auto-contestable reason-code list over time
  based on which reasons this specific platform's merchants actually win.

## Cross-Border Settlement & Tax

See [`fx-conversion.md`](./fx-conversion.md#fx-conversion-merchant-settlement-currency)
for the mechanism, and
[`compliance-and-security.md`](./compliance-and-security.md#cross-border-what-compliance-doesnt-cover-here)
for the regulatory-scope framing of the VAT/tax gap below.

What genuinely remains:
- **No hedging/rate-lock *product*.** This system quotes at charge time
  and nothing before that — a merchant can't lock in a rate ahead of a
  sale the way real cross-border processors sometimes let them. In the
  narrower sense of "who bears the risk for a *given* payment's own
  lifecycle," this is now answered (the platform does, by locking the
  charge-time rate and reusing it verbatim for that payment's captures/
  refunds/dispute losses) — but that's a mechanical consequence of a
  refund-netting fix, not a considered hedging policy.
- **VAT/tax handling — ✅ partially resolved (Phase 1).** Real tax
  *calculation* (rates, returns, nexus determination) is still out of
  scope for this system and arguably always will be — but the "the
  domain model would still need a place to record what was charged and
  why" gap this bullet used to flag is closed: `PaymentAggregate` now
  records a `taxRecord` (jurisdiction, derived from the cardholder's
  `BinInfo.country`; the amount actually collected from the customer;
  when) for every cross-border charge, at the same call sites and under
  the same condition as `settlementConversion`. See
  [`fx-conversion.md`](./fx-conversion.md#cross-border-tax-record-phase-1)
  — explicitly an audit record, not a tax-nexus determination.

---

## Agentic Payments

The standards in this space (Stripe's agentic commerce tooling, Google's
Agent Payments Protocol, various agent-to-agent authorization proposals)
are still actively evolving as of this writing, so this deliberately
implements the durable *business* mechanism — delegation and spend
policy as first-class domain concepts — rather than betting on any one
still-moving protocol shape. See
[`../../DEV_README.md`](../../DEV_README.md#ai-agents--agentic-payments)
for the mechanism.

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
to an employee/RBAC role. That's the relationship a `Delegation` models.

### Human-approval hold for above-threshold purchases

The business framing this section originally described — "ask me first
for anything above $200" — is now a real mechanism, not just a policy
number: `SpendPolicy.requireApprovalAboveAmount` sits strictly below
`perTransactionLimit`. A charge under that threshold auto-executes
exactly as before; a charge above it (but still within the hard
per-transaction cap) doesn't reach a PSP at all — it creates a
`ChargeApproval`, reserves the spend against the delegation immediately
(so a flurry of pending requests can't collectively bust the monthly
budget before any of them is decided), and waits. An operator decides
via `POST /charge-approvals/:id/approve` (executes the deferred charge
in that same request — there's no further async step after approval) or
`POST /charge-approvals/:id/deny` (releases the reservation; the PSP is
never called). `perTransactionLimit`/`monthlyLimit`/category violations
are unaffected — those still reject outright, never routed to approval;
this only inserts a hold *inside* the range a charge would otherwise
have auto-executed in.

### What's still genuinely missing

- **Liability and dispute attribution — ✅ data capture resolved
  (Phase 1), the policy question is not.** If an agent makes an
  incorrect or unauthorized purchase, who is responsible for resolving
  it — the platform, the merchant that got paid, or whoever operates the
  agent? That's a real, unresolved industry question this project can't
  answer unilaterally, and still doesn't attempt to. What's now fixed:
  the dispute model previously had **no concept of a non-human initiator
  at all** — `delegationId`/`initiatedBy` used to live in a free-form
  jsonb bag with no query surface; both are now real, indexed
  `PaymentEntity` columns, and `DisputeService.recordDispute()`
  snapshots them onto the `Dispute` record at creation time (so
  `GET /admin/disputes` can actually answer "was this an agent-initiated
  charge" — see [`disputes.md`](./disputes.md)). Deliberately scoped as
  audit-trail plumbing only, not a liability-decision policy engine.

- **A different risk posture for agent-initiated charges — ✅ two
  signals resolved (Phase 1), not a full model.**
  `PaymentAggregate.calculateRiskScore()` still reasons about amount and
  card origin exactly as before for every charge — but now takes an
  optional `agentContext`, populated only for an agent-initiated one
  (never a human charge, which scores identically to before this
  existed): (1) whether this is the delegation's first-ever charge to
  this specific merchant (an agent repeatedly charging a merchant it
  already knows — e.g. a subscription-like recurring purchase — is
  normal, unlike the implicit "high frequency = suspicious" a human
  charge is treated with elsewhere; novelty relative to *this
  delegation's own history* is what's actually risk-relevant, not raw
  velocity); (2) whether this charge alone consumes a large share
  (≥50%) of what's left in the delegation's rolling monthly budget,
  using `Delegation`/`SpendPolicy`'s existing `currentMonthSpent`/
  `monthlyLimit` — no new fields needed. Still not modeled: agent/
  principal-pairing history *across* merchants, or anything resembling a
  real fraud model — these are two concrete, testable heuristics, not a
  scoring system. See `test/agent-risk-scoring.e2e-spec.ts`.
  **A real, non-rare gap — now closed.** The budget-pressure signal (2)
  used to only be computed on `PaymentController.charge()`'s
  immediate-execution path — `ChargeApprovalService.approve()` (the
  human-approval-hold path, `SpendPolicy.requireApprovalAboveAmount`)
  left it permanently absent, which mattered more than a typical missing
  signal would: a `ChargeApproval` only ever exists for a charge *above*
  that threshold, so by construction every charge going through
  `approve()` is one of the delegation's largest — exactly where
  budget-pressure would be most informative. `approve()` now re-derives
  the signal from the delegation's *current* state at approval time
  (`ChargeApprovalService.deriveAgentPercentOfRemainingMonthlyBudget()`)
  instead of needing a frozen creation-time snapshot — arguably a better
  number than the immediate-execution path's own snapshot, since it
  reflects everything the delegation has actually spent in the days
  between creating the approval and an operator deciding it, not a stale
  read. Still legitimately absent in two edge cases (see that method's
  own docblock: the calendar month rolled over between creation and
  approval, or the numbers leave no room for a meaningful percentage) —
  both cases a frozen-snapshot approach could never have handled either.
  `isFirstChargeToMerchant` (1) is unaffected and still applies on this
  path. See `test/charge-approval.e2e-spec.ts` for the regression
  coverage.
  **Now calibrated against a dedicated synthetic population** (a
  genuinely separate domain from the merchant-dispute-history one above,
  so it uses its own generator —
  `scripts/calibration/generate-synthetic-agent-charges.ts`/
  `calibrate-agent-risk-scoring.ts`): 5,000 synthetic agent charges, 3%
  genuinely `PROBLEMATIC` (rare, by construction), scored by calling
  `calculateRiskScore()` directly on a real, minimal `PaymentAggregate`:

  | Threshold | precision | recall |
  |---|---|---|
  | No signal (flag nothing/everything) | 3.2% | 100.0% |
  | Score ≥15 (either signal alone) | 13.2% | 95.0% |
  | Score ≥30 (both signals required) | 65.3% | 61.6% |

  A real, measured 10-point precision lift over having no signal at all
  while still catching 95% of genuinely problematic charges — the two
  heuristics do better than nothing on this synthetic population, not
  just a plausible-sounding idea. Same caveat as everywhere else: the
  *size* of the assumed correlation between each signal and genuine
  anomaly has no real delegation/agent transaction history behind it in
  this repository.
- **Standards alignment.** Stripe's agentic commerce tooling, Google's
  Agent Payments Protocol, and various agent-to-agent authorization
  proposals are all still evolving; `Delegation`/`SpendPolicy` implement
  the underlying business mechanism these standards are converging
  toward, not any one of their specific wire formats.
