# Threshold Calibration (Risk Tiering & Dispute Auto-Accept)

`RiskTieringService`'s reserve-tier thresholds and `DisputeService`'s
auto-accept amount cutoff are illustrative, not calibrated against real
fraud/chargeback history — this repository has none. Rather than leaving
that as a documentation-only gap, `scripts/calibration/` runs an actual
calibration *methodology* against a synthetic, deliberately-realistic
stand-in dataset, generated with a fixed seed so results are reproducible.
See [`../business-domain/future-directions.md`](../../business-domain/future-directions.md#merchant-risk-tiering--reserves)
for the actual numbers this produced and what they mean; this document
covers the mechanism and how to run it yourself.

## Running it

```bash
npm run calibration:generate   # writes scripts/calibration/synthetic-history.json
npm run calibration:run        # reads it, prints the calibration report
```

`generate-synthetic-history.ts` uses a seeded PRNG (Mulberry32, seed
`20260901`) — the same seed always produces the same synthetic dataset,
so `calibration:run`'s output is reproducible across machines and over
time, not a different answer on every run. The generated JSON file is
gitignored (deterministically regenerated, no reason to commit it).

## What the synthetic data models, and why

- **Risk tiering**: 2,000 synthetic merchants, each assigned a *true*
  risk label (85% LOW, 12% MEDIUM, 3% HIGH — a skewed mixture, not a
  bell curve, matching how real payment-platform risk actually
  distributes: most merchants are fine, a small tail drives most real
  loss) and a true underlying lost-dispute rate drawn from that label's
  range. Each merchant's *observed* settled-charge volume (log-normal —
  most merchants are small, a few are large) and lost-dispute count
  (Poisson-sampled from volume × true rate — real sampling noise, so a
  low-volume merchant with a genuinely elevated true rate can still show
  zero observed disputes purely by chance) are what the calibration
  script actually sees; the true label is kept aside as an answer key,
  never fed into the calibration itself. Each merchant also gets an
  `accountAgeDays` (log-normal, median ~200 days) generated **independent**
  of its true risk label — a brand-new account and a long-established one
  can carry the same underlying risk — but `settledCharges` is capped by
  how much volume that age could plausibly have accumulated (at most
  ~1.5 charges/day since opening), so a genuinely new account has a real
  chance of showing an artificially low observed rate purely because it
  hasn't had time to reveal its true one yet. This is what
  `RISK_TIER_NEW_MERCHANT_AGE_DAYS`'s escalation (Phase 1) is testing
  against, below. Each merchant's `lostDisputes` count is also broken
  down by reason code (`lostDisputesByReason`), using a mix that
  **is** correlated with the true risk label — a genuinely high-risk
  merchant's disputes skew toward `fraudulent`; a genuinely low-risk
  merchant's occasional lost dispute skews toward benign
  `duplicate`/`subscription_canceled` mixups. This is the entire premise
  `dispute-risk-weight.ts`'s weights are based on, and is what the
  reason-code weighting calibration below tests.
- **Dispute auto-accept**: 5,000 synthetic disputes with log-normal
  amounts and a per-reason-code contest win rate (`fraudulent`: 15%,
  `duplicate`: 85% — deliberately different per reason, not one flat
  rate, since that differentiation is the entire point of a
  reason-aware policy).

## What the calibration script actually computes

- **Risk tiering**: scores the current fixed thresholds (HIGH >1%,
  MEDIUM >0.5%) against the synthetic population's known true labels —
  precision (of merchants flagged HIGH, how many really are) and recall
  (of merchants that really are HIGH, how many got flagged) — something
  only checkable here because the labels are synthetic ground truth;
  real production data has no such answer key to score against. Then
  derives percentile-based thresholds (95th/80th percentile of the
  *observed* rate distribution) and scores those the same way, for a
  real numeric comparison.
- **Dispute auto-accept**: for each $2 amount bucket, computes expected
  contest value (`observed win rate × amount − an assumed $8
  operational cost per contest`) and finds the amount where that turns
  non-negative — the economically-justified break-even point, computed
  from data rather than picked by feel.
- **New-merchant-age escalation (Phase 1)**: scores the same synthetic
  population's precision/recall with vs. without escalating a merchant
  one tier when `accountAgeDays < 30`
  (`RISK_TIER_NEW_MERCHANT_AGE_DAYS`'s default) — a direct test of
  whether the escalation actually catches merchants a purely rate-based
  threshold would miss (see `future-directions.md` for the numeric
  result), not just a plausibility argument.
- **Dispute reason-code weighting (Phase 1)**: scores the same
  population's HIGH/MEDIUM+ precision/recall using the *raw* (unweighted)
  lost-dispute rate vs. a rate weighted by
  `getDisputeRiskWeight()` — imported directly from
  `src/modules/payment/domain/services/dispute-risk-weight.ts`, the real
  production function, not a copy, so this calibration can't silently
  drift from what the codebase actually does. See `future-directions.md`
  for the numeric result.

## What this does and doesn't prove

**Does**: prove the calibration *methodology* — the precision/recall
scoring, the percentile derivation, the break-even calculation — runs
correctly and produces real, reproducible, internally-consistent
numbers, including a genuine, non-obvious finding (percentile-based risk
thresholds break down at a 0% MEDIUM cutoff on this population — a
zero-inflation artifact real historical data would very plausibly share,
not something a purely theoretical writeup would have surfaced).

**Doesn't**: tell you what the real production thresholds should be. The
input distributions (the 85/12/3 risk mixture, the per-reason-code win
rates, the $8 contest cost, the age/volume independence assumption, the
reason-code-mix-by-true-risk-label split) are illustrative assumptions,
the same posture as every other calibration input this codebase has been
honest about — not fitted to any real merchant's actual history, because
none exists in this repository.

## What else was considered, and what wasn't added here

A Phase 1 review pass ([`future-directions.md`](../../business-domain/future-directions.md))
catalogued every other "illustrative, not calibrated" number in the
risk-scoring surface and asked whether each one fits this same
precision/recall/break-even framework. The new-merchant-age and
dispute-reason-code items above turned out to fit directly — both are
now real calibration exercises, not just plausibility arguments. The
agent risk-scoring bumps needed a genuinely new, separate synthetic
generator (see below) rather than an extension of this one, and now have
one. The remaining two don't fit at all, for each one's own reason —
documented gaps, not oversights:

- **MCC risk-category table**
  (`src/modules/merchant/mcc-risk-lookup.ts`) — a categorical
  industry classification (gambling = HIGH, groceries = LOW), not a
  numeric threshold. There's no "95th percentile" version of "is this
  MCC code inherently risky" to derive from synthetic data; a real
  calibration would need actual chargeback-rate-by-MCC data, not a
  statistical technique applied to a stand-in population. **Verified,
  2026** — every one of the 19 codes checked against real MCC reference
  sources for both the code-to-category mapping and the risk tier; all
  confirmed accurate (several, like gambling/dating-services/inbound-
  telemarketing, are explicitly labeled `HIGH RISK` in real
  acquirer-facing guidance, not just this codebase's own judgment call).
  See `mcc-risk-lookup.ts`'s own docblock for the full note.
- **Stripe/Adyen hard-decline code sets**
  (`decline-code-classifier.ts`'s `HARD_DECLINE_CODES`) — this is a
  documentation-accuracy question (does this code list match what each
  PSP's real decline-code taxonomy actually documents?), not a
  statistical one — synthetic data can't validate "is `'25'` really
  Adyen's Restricted Card code," only that PSP's own real API
  documentation can. **Verified, 2026** — every code in both sets was
  checked against Stripe's and Adyen's own currently-published
  documentation; all were confirmed accurate, and two additional,
  equally unambiguous Adyen codes (`'26'` Revocation Of Auth, `'50'`
  Token Revoked) were added as a direct result. See
  `decline-code-classifier.ts`'s own docblock for the full citation.
## Agent risk-scoring calibration (Phase 1, a separate generator)

`PaymentAggregate.calculateRiskScore()`'s `agentContext` signals
(Phase 1 item 7 — `isFirstChargeToMerchant`, `percentOfRemainingMonthlyBudget`)
have no relationship to the merchant-dispute-history population above at
all — delegation/agent spend behavior is a genuinely different domain,
so this uses its own generator and scorer:

```bash
npm run calibration:agent:generate   # writes synthetic-agent-charges.json
npm run calibration:agent:run
```

`generate-synthetic-agent-charges.ts` (fixed seed `20260906`, independent
of the merchant generator's own seed) generates 5,000 synthetic
agent-initiated charges, each with a true `PROBLEMATIC`/`NORMAL` label
(3% problematic — a genuinely anomalous charge, modeled as rare, the
same "small tail carries the real signal" shape as the merchant
population's own risk mixture). A `PROBLEMATIC` charge is *more likely*
(not certain) to be the delegation's first charge to that merchant and
to draw a large share of the remaining monthly budget — the same
premise the two real signals are built on; a `NORMAL` charge is mostly a
repeat, modest-fraction purchase.

`calibrate-agent-risk-scoring.ts` calls
`PaymentAggregate.calculateRiskScore()` directly on a real, minimal
`PaymentAggregate` (constructed with a fixed $20 USD amount and no
`BinInfo`, so the existing amount/SCA bumps are always 0 and only the
two agent-context signals vary the score) — not a reimplementation of
the scoring logic, so this can't silently drift from what the codebase
actually does. Scores at two thresholds and against a "flag nothing" baseline:

| Threshold | Flagged | precision | recall |
|---|---|---|---|
| Baseline (no signal) | 5000/5000 | 3.2% | 100.0% |
| Score ≥15 (either signal alone) | 1143/5000 | 13.2% | 95.0% |
| Score ≥30 (both signals required) | 150/5000 | 65.3% | 61.6% |

At the lower threshold, the two signals lift precision 10 points over
having no signal at all while still catching 95% of genuinely
problematic charges on this synthetic population — a real, measured
case that the feature does better than nothing, not just a
plausible-sounding idea. As with every other exercise here: illustrative
only — the *size* of the correlation this population assumes between
each signal and genuine anomaly is itself an assumption, and there is no
real delegation/agent transaction history in this repository to fit it
to instead.

## The real path forward

Both scripts are structured so the synthetic-data step is the only part
that needs replacing: swap `generate-synthetic-history.ts`'s output for
a real query — `(merchantId, trailing lost-dispute rate, true future
loss outcome)` for risk tiering; `(amount, reason code, actual contest
outcome)` for disputes, both derivable from `dispute.created`/
`dispute.resolved`, which `DisputeService` already emits — and
`calibrate-thresholds.ts`'s precision/recall/break-even logic runs
unchanged against real numbers instead of synthetic ones.
