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
- **The hard-decline code set is illustrative, not calibrated.** It's a
  small, reasonable-looking set of Stripe/Adyen-style codes, not
  validated against real-world decline-code taxonomies or
  acquirer-specific variations — a real system would likely need this
  configurable per-PSP.
- **A real notification integration.** `subscription.past_due`/
  `subscription.canceled` are genuinely emitted events, but nothing in
  this codebase is actually subscribed to them yet — no email, no
  Slack, no paging. The same stand-in posture as this codebase's other
  "alert on-call in production" gaps.

## Marketplace & Split Payments

See [`marketplace-and-payouts.md`](./marketplace-and-payouts.md#marketplace-splits)
and [`../../DEV_README.md`](../../DEV_README.md#marketplace--split-payments-phase-1---resolved)
for the mechanism.

What's still genuinely missing:
- **Multi-party splits with per-recipient FX.** A split charge can't be
  combined with the platform's own settlement-currency conversion at all
  today, let alone give each connected account its own settlement
  currency.

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
  | Current fixed (HIGH >1%) | 22.7% | 90.2% |
  | Data-derived (HIGH >2.56%, the 95th percentile) | 45.5% | 78.4% |

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
- **No connection to the merchant's own risk tier.** `RiskTieringService`
  already reads dispute *outcomes* to set a merchant's reserve, but the
  relationship is one-way — the dispute policy doesn't read a merchant's
  risk tier back to decide, say, "auto-contest more aggressively for a
  LOW-risk merchant with a strong track record."
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

- **Liability and dispute attribution.** If an agent makes an incorrect
  or unauthorized purchase, who is responsible for resolving it — the
  platform, the merchant that got paid, or whoever operates the agent?
  The dispute model has no concept of a non-human initiator at all, let
  alone how liability should be attributed when one is involved. This is
  a real open question in the industry right now, not something this
  project can resolve unilaterally — the audit trail (which delegation,
  under what policy) is a necessary building block for answering it
  later, not an answer itself.
- **A different risk posture for agent-initiated charges.**
  `PaymentAggregate.calculateRiskScore()` still reasons about amount and
  card origin — signals that make sense for a human, card-present-adjacent
  transaction. An agent transacting autonomously has different risk
  signals entirely (is this purchase consistent with the agent's normal
  velocity, has this exact agent/principal pairing transacted with this
  merchant before); none of that exists today — an agent-initiated charge
  is scored identically to a human-initiated one.
- **Standards alignment.** Stripe's agentic commerce tooling, Google's
  Agent Payments Protocol, and various agent-to-agent authorization
  proposals are all still evolving; `Delegation`/`SpendPolicy` implement
  the underlying business mechanism these standards are converging
  toward, not any one of their specific wire formats.
