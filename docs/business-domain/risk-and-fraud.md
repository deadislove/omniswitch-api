# Risk & Fraud Signals

This describes the two independent risk signals this platform tracks per
merchant — reserve-driving risk tiering (a chargeback-history signal) and
ambiguous-payment risk monitoring (a PSP-reliability signal) — and why
they're separate mechanisms rather than one "risk score." See
[`ledger-and-settlement.md`](./ledger-and-settlement.md#merchant-risk-tiering--reserves)
for the ledger/reserve mechanics and
[`future-directions.md`](./future-directions.md#merchant-risk-tiering--reserves)
for what's still genuinely missing from the tiering model.

## Why two separate signals, not one risk score

It's tempting to fold every "something's off with this merchant" signal
into a single number. This platform deliberately doesn't:

- **Risk tiering** answers "is this merchant's chargeback history bad
  enough that we should hold back more of their money, for longer?" — a
  *financial* question, driving a *financial* consequence (`reserveBps`/
  `reserveHoldDays`).
- **Ambiguous-risk monitoring** answers "have PSP calls for this
  merchant been failing to return a clear answer often enough to worry
  about?" — an *operational reliability* question about this platform's
  own integration health, not necessarily anything the merchant did
  wrong. A merchant with a run of `AMBIGUOUS` payments might be the
  victim of a flaky PSP connection, not a fraud risk.

Conflating these would mean a PSP having a bad day could look
indistinguishable from a merchant actually bleeding chargebacks — two
situations that call for completely different responses (investigate the
PSP integration vs. hold back more money). Keeping them separate means
each can be reasoned about, and acted on, independently.

## Risk tiering (chargeback-driven reserves)

`RiskTieringService` recomputes each auto-managed merchant's trailing
90-day **lost-dispute rate** — `LOST` disputes divided by settled charges
in that window — and maps it to one of three tiers, each with its own
reserve policy:

| Tier | Trigger (lost-dispute rate) | Reserve | Hold period |
|---|---|---|---|
| `LOW` | ≤0.5% | 0 bps | 0 days |
| `MEDIUM` | >0.5% | 500 bps (5%) | 30 days |
| `HIGH` | >1% | 1500 bps (15%) | 90 days |

Both thresholds are env-configurable
(`RISK_TIER_HIGH_THRESHOLD`/`RISK_TIER_MEDIUM_THRESHOLD`) — see
[`future-directions.md`](./future-directions.md#merchant-risk-tiering--reserves)
for the real precision/recall numbers a calibration exercise measured
against a synthetic population, and why the fixed thresholds above are
still what ships.

**Sample-size gated.** Below 10 settled charges in the trailing window, a
merchant's rate is statistical noise (one dispute out of three charges is
a meaningless "33%") — evaluation is skipped entirely and the existing
reserve policy is left untouched rather than reacting to too small a
sample.

**The lost-dispute-rate base signal moves in both directions.** Every
sweep recomputes from the current 90-day window from scratch — a
merchant whose chargeback rate climbs gets escalated; one that cleans up
its history tapers back down on its own, on the next tick. The MCC/
account-age/KYC modifiers layered on top (below) are different:
escalation-only, one step at a time, never lowering what the base signal
alone would say.

**A manual override always wins.** An operator's own
`PATCH /admin/merchants/:id/reserve-policy` call sets a merchant's
reserve directly *and* flips `riskTierAutoManaged` to `false` — the next
sweep leaves that merchant alone until an operator explicitly
re-enables automation via `PATCH /admin/merchants/:id/risk-tier-auto`. A
hand-tuned reserve is never silently overwritten by the sweep. A manual
*escalation* through this endpoint also tops up already-`HELD` reserves
to the new rate, the same way the automated sweep's own escalation does
(see "Escalation now reaches back to already-booked reserves" below) —
an operator's own judgment that risk has increased is, if anything, a
more deliberate signal than an automated one, and there's no reason it
should only reach *future* charges. `MerchantService.updateReservePolicy()`
emits `merchant.reserve_policy.escalated` (only when the new rate is
higher than the previous one) and `ReservePolicyEscalationListener` (in
`PaymentModule`, which `MerchantModule` can't call directly — see that
listener's own docblock for why this crosses module boundaries via an
event, the same seam dispute/subscription notifications already use)
reacts to it.

**On demand or scheduled.** The sweep runs daily
(`EVERY_DAY_AT_2AM`), or immediately via `POST /admin/risk-tiering/run`
— the same dual on-demand-plus-scheduled shape
`ReconciliationService`/`ReserveService` use elsewhere in this codebase.

**MCC code, account age, and KYC status now escalate the tier
(Phase 1)** — each one step up, never down, and only ever on top of
whatever the lost-dispute-rate base signal already computed:
- A `HIGH`-classified MCC (`PATCH .../mcc-code`, looked up via
  `src/modules/merchant/mcc-risk-lookup.ts`'s real, public MCC risk
  table) escalates one tier.
- An account younger than `RISK_TIER_NEW_MERCHANT_AGE_DAYS` (default 30)
  escalates one tier — no track record yet isn't "safe," the
  lost-dispute-rate signal just hasn't caught up.
- An unverified `kycStatus` forces `HIGH` outright, but only for
  `CONNECTED` merchants — `kycStatus` stays `NOT_STARTED` forever for a
  `PLATFORM` merchant by design (see `MerchantEntity`'s own docblock), so
  this check is skipped entirely for those.

**Dispute reason code now feeds the base signal too (Phase 1).** The
lost-dispute-rate calculation itself weights each `LOST` dispute by
reason (`src/modules/payment/domain/services/dispute-risk-weight.ts`)
instead of counting every one identically: `fraudulent` at full weight,
`product_not_received`/`subscription_canceled` at half,
`duplicate` at a quarter — the same reason-code vocabulary
`dispute-policy.ts`'s auto-contest table already uses. Two merchants
with the same raw *count* of `LOST` disputes can land in different
tiers depending on why those disputes were lost.

**Escalation now reaches back to already-booked reserves (Phase 1) —
both when the sweep escalates and when an operator manually escalates
via `PATCH .../reserve-policy`.** Whenever a merchant's effective tier
*escalates* (never on de-escalation, whether that escalation came from
the sweep's own computation or a manual PATCH — see "A manual override
always wins" above for the manual path's event-based wiring),
`ReserveService.topUpHeldReservesForMerchant()` tops up every
still-`HELD` reserve for that merchant to the new rate — a real risk
event shouldn't leave an older, already-in-flight charge under-reserved
just because it was booked before the escalation. A hold already
`RELEASED` by the time the escalation happens is untouched (its funds
already left the reserve account), and a later de-escalation never
reverses a top-up that already happened. See
[`future-directions.md`](./future-directions.md#merchant-risk-tiering--reserves)
for the fuller list, including the real (synthetic-data) calibration
exercise this platform has actually run against these thresholds.

## Ambiguous-risk monitoring (PSP-reliability signal)

A payment lands in `AMBIGUOUS` status when a PSP call gets no definitive
response at all — see
[`payment-lifecycle.md`](./payment-lifecycle.md) for what causes that and
how individual `AMBIGUOUS` payments get resolved.
`AmbiguousRiskMonitoringService` watches for a *pattern* of these across
a merchant, independent of what eventually happens to any single one.

**Two independent triggers**, evaluated right after each payment
transitions to `AMBIGUOUS`:

1. **Volume**: more than a configurable threshold
   (`AMBIGUOUS_RISK_DAILY_THRESHOLD`, default 100) of ambiguous incidents
   in a rolling 24-hour window.
2. **Streak**: the merchant's last N payments
   (`AMBIGUOUS_RISK_CONSECUTIVE_THRESHOLD`, default 5) were *all*
   ambiguous — a stronger, more specific signal than raw volume: a
   high-volume merchant could rack up several incidents during a PSP's
   bad stretch without every single charge being affected, but an
   unbroken streak is harder to explain away that way.

**Purely observational.** Tripping either trigger sets
`MerchantEntity.ambiguousRiskFlagged` — visible to an operator via
`GET /admin/merchants` — but changes nothing about how that merchant's
charges are actually processed. No throttling, no forced review, no
different routing. Whether to add an active-enforcement layer on top is a
deliberately separate, not-yet-made decision — flagging and *acting* on a
flag are kept apart so the signal can be observed and trusted before
anything automated reacts to it.

**Auto-clears itself.** A flag isn't permanent: if no new incident
happens for a configurable window (`AMBIGUOUS_RISK_AUTO_CLEAR_DAYS`,
default 60 days), a daily sweep clears it automatically — checked via the
same dual on-demand (`POST /admin/merchants/ambiguous-risk/run-auto-clear`)
plus scheduled shape risk tiering uses. Same manual-override posture as
risk tiering, too: `PATCH /admin/merchants/:id/ambiguous-risk` sets the
flag by hand and disables automation for that merchant, until
`PATCH /admin/merchants/:id/ambiguous-risk-auto` re-enables it.

## AML review observation (HIGH-industry hard-decline signal)

Every industry classification carries some potential money-laundering
exposure, but a `HIGH`-`industryRiskCategory` merchant (gambling, dating/
escort services, telemarketing, cryptocurrency — see
`mcc-risk-lookup.ts`) racking up hard-declines (stolen/lost/fraudulent-
card-class outcomes, not just any decline — see
`decline-code-classifier.ts`) in a short window is exactly the kind of
cross-referenceable signal that's too hard to fully automate a judgment
from, but easy to surface for a human reviewer. `AmlReviewMonitoringService`
implements that: a warning flag, not an automated block — the actual
judgment of whether a given HIGH-industry merchant poses real AML risk
still requires a human to look, the same posture every other MCC-risk
decision in this codebase already takes (manual onboarding review, not a
programmatic accept/reject).

**Evaluated inline**, right after a charge is marked `FAILED` — same
"evaluate synchronously on the triggering event, no separate detection
sweep" shape ambiguous-risk monitoring uses. Because a subscription's
recurring charge goes through the exact same `PaymentCheckoutSaga` a
one-off charge does, a subscription's hard-declines are covered by this
same single integration point — no separate wiring for recurring vs.
one-off charges.

**Trigger**: `AML_REVIEW_HARD_DECLINE_THRESHOLD` (default 5) hard-decline
events within a trailing `AML_REVIEW_WINDOW_DAYS` window (default 30),
for a `HIGH`-industry merchant only — a `LOW`/`MEDIUM`/`UNKNOWN`-industry
merchant's hard-decline is treated as ordinary card-testing/fraud noise,
not an AML-adjacent signal.

**Purely observational, same as ambiguous-risk monitoring** — sets
`MerchantEntity.amlReviewFlagged`, visible via `GET /admin/merchants`,
but does not throttle, block, or re-route that merchant's charges.
Same manual-override posture too: `PATCH /admin/merchants/:id/aml-review`
sets the flag by hand (reason required, audited) and disables
`amlReviewAutoManaged` until `PATCH /admin/merchants/:id/aml-review-auto`
re-enables it. Unlike ambiguous-risk monitoring, there is **no auto-clear
sweep** — a HIGH-industry merchant's hard-decline history doesn't "age
out" the way a PSP-reliability incident does; the flag stays live until a
human actually clears it.

**Fires a real notification.** Unlike ambiguous-risk monitoring
(deliberately silent), a HIGH-industry merchant crossing this threshold
is compliance-relevant enough to page someone in real time —
`PATCH /admin/merchants/:id/aml-review-notification-channel` configures
EMAIL/Slack/webhook delivery per merchant, reusing the same
`postJsonNotification`/HMAC-signing mechanism dispute and subscription
notifications already use. Sent once per trip, not re-sent on every
subsequent hard-decline while already flagged.

**Scoped deliberately narrow.** This only cross-references decline
behavior against a merchant's already-known industry classification —
it does not attempt to calibrate a numeric threshold the way risk
tiering's reserve tiers do (see `docs/technical/tests/threshold-
calibration.md` for why an MCC risk table is a categorical, not
statistical, judgment), and it does not introduce a second industry-risk
taxonomy alongside `industryRiskCategory`.

## Not modeled

- **No connection between the two signals.** A merchant with a run of
  ambiguous payments isn't automatically considered for risk-tier
  escalation, even though a pattern of failed PSP calls could plausibly
  correlate with other risk. They stay genuinely independent today.
- **No fraud-scoring model of any kind at charge time.**
  `PaymentAggregate.calculateRiskScore()` is a simple amount/card-origin
  heuristic (plus, for an agent-initiated charge only, two agent-context
  signals — see
  [`future-directions.md`](./future-directions.md#agentic-payments))
  recorded for visibility, not something that gates or routes a charge
  differently — see [`payment-lifecycle.md`](./payment-lifecycle.md) for
  what it actually does. Neither risk-tiering nor ambiguous-risk
  monitoring feeds back into it.
