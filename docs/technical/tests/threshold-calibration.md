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
  never fed into the calibration itself.
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
rates, the $8 contest cost) are illustrative assumptions, the same
posture as every other calibration input this codebase has been honest
about — not fitted to any real merchant's actual history, because none
exists in this repository.

## The real path forward

Both scripts are structured so the synthetic-data step is the only part
that needs replacing: swap `generate-synthetic-history.ts`'s output for
a real query — `(merchantId, trailing lost-dispute rate, true future
loss outcome)` for risk tiering; `(amount, reason code, actual contest
outcome)` for disputes, both derivable from `dispute.created`/
`dispute.resolved`, which `DisputeService` already emits — and
`calibrate-thresholds.ts`'s precision/recall/break-even logic runs
unchanged against real numbers instead of synthetic ones.
