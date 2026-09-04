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

**Moves in both directions.** Every sweep recomputes from the current
90-day window from scratch — a merchant whose chargeback rate climbs
gets escalated; one that cleans up its history tapers back down on its
own, on the next tick. This isn't a one-way ratchet.

**A manual override always wins.** An operator's own
`PATCH /admin/merchants/:id/reserve-policy` call sets a merchant's
reserve directly *and* flips `riskTierAutoManaged` to `false` — the next
sweep leaves that merchant alone until an operator explicitly
re-enables automation via `PATCH /admin/merchants/:id/risk-tier-auto`. A
hand-tuned reserve is never silently overwritten.

**On demand or scheduled.** The sweep runs daily
(`EVERY_DAY_AT_2AM`), or immediately via `POST /admin/risk-tiering/run`
— the same dual on-demand-plus-scheduled shape
`ReconciliationService`/`ReserveService` use elsewhere in this codebase.

**What this deliberately doesn't consider**: MCC code, account tenure,
industry risk category, KYC/verification status, or dispute *reason*
code (a `fraudulent` `LOST` dispute counts identically to a
`product_not_received` one, even though they carry very different risk
signal). A tier change also never retroactively touches reserves already
withheld from earlier charges — only future charges are affected. See
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

## Not modeled

- **No connection between the two signals.** A merchant with a run of
  ambiguous payments isn't automatically considered for risk-tier
  escalation, even though a pattern of failed PSP calls could plausibly
  correlate with other risk. They stay genuinely independent today.
- **No fraud-scoring model of any kind at charge time.**
  `PaymentAggregate.calculateRiskScore()` exists but is a simple
  amount/card-origin heuristic recorded for visibility, not something
  that gates or routes a charge differently — see
  [`payment-lifecycle.md`](./payment-lifecycle.md) for what it actually
  does. Neither risk-tiering nor ambiguous-risk monitoring feeds back
  into it.
