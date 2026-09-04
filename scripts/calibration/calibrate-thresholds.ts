/**
 * Runs an actual calibration pass against generate-synthetic-history.ts's
 * output — not a description of how one might do this later. Two
 * independent analyses:
 *
 * 1. Risk tiering: scores RiskTieringService's current hardcoded
 *    thresholds (HIGH >1%, MEDIUM >0.5% — DEFAULT_HIGH_RISK_THRESHOLD/
 *    DEFAULT_MEDIUM_RISK_THRESHOLD in risk-tiering.service.ts) against
 *    the synthetic population's *known* true risk labels (precision/
 *    recall — something only possible here because this is synthetic
 *    data with a ground truth; real production data has no such label to
 *    check against), then derives percentile-based thresholds from the
 *    data itself and scores those the same way, for a real, numeric
 *    comparison — not a guess at which approach is better.
 * 2. Dispute auto-accept: finds the amount below which contesting a
 *    dispute has *negative* expected value given an assumed operational
 *    cost per contest, and compares it to the current hardcoded
 *    DEFAULT_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS (15) in dispute-policy.ts.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/generate-synthetic-history.ts
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/calibrate-thresholds.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SyntheticMerchant, SyntheticDispute } from './generate-synthetic-history';

const dataPath = path.join(__dirname, 'synthetic-history.json');
if (!fs.existsSync(dataPath)) {
  console.error('synthetic-history.json not found — run generate-synthetic-history.ts first.');
  process.exit(1);
}
const { merchants, disputes } = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as {
  merchants: SyntheticMerchant[];
  disputes: SyntheticDispute[];
};

// ─── Part 1: Risk tiering threshold calibration ──────────────────────────

const MIN_SAMPLE_SIZE = 10; // Mirrors RiskTieringService's own constant.
const CURRENT_HIGH_THRESHOLD = 0.01;
const CURRENT_MEDIUM_THRESHOLD = 0.005;

function tierFor(rate: number, high: number, medium: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (rate > high) return 'HIGH';
  if (rate > medium) return 'MEDIUM';
  return 'LOW';
}

// Only merchants RiskTieringService would actually evaluate — same
// MIN_SAMPLE_SIZE gate. Below that, a rate is noise; scoring a threshold
// against noise would just measure luck.
const evaluable = merchants.filter((m) => m.settledCharges >= MIN_SAMPLE_SIZE);
console.log(
  `\n=== Risk tiering calibration (${evaluable.length}/${merchants.length} merchants meet MIN_SAMPLE_SIZE=${MIN_SAMPLE_SIZE}) ===\n`,
);

interface ScoreResult {
  precisionHigh: number;
  recallHigh: number;
  precisionMediumPlus: number;
  recallMediumPlus: number;
}

function scoreThresholds(high: number, medium: number): ScoreResult {
  let truePositiveHigh = 0,
    predictedHigh = 0,
    actualHigh = 0;
  let truePositiveMediumPlus = 0,
    predictedMediumPlus = 0,
    actualMediumPlus = 0;

  for (const m of evaluable) {
    const observedRate = m.lostDisputes / m.settledCharges;
    const predictedTier = tierFor(observedRate, high, medium);
    const isPredictedHigh = predictedTier === 'HIGH';
    const isPredictedMediumPlus = predictedTier === 'HIGH' || predictedTier === 'MEDIUM';
    const isActualHigh = m.trueRiskLabel === 'HIGH';
    const isActualMediumPlus = m.trueRiskLabel === 'HIGH' || m.trueRiskLabel === 'MEDIUM';

    if (isPredictedHigh) predictedHigh++;
    if (isActualHigh) actualHigh++;
    if (isPredictedHigh && isActualHigh) truePositiveHigh++;

    if (isPredictedMediumPlus) predictedMediumPlus++;
    if (isActualMediumPlus) actualMediumPlus++;
    if (isPredictedMediumPlus && isActualMediumPlus) truePositiveMediumPlus++;
  }

  return {
    precisionHigh: predictedHigh > 0 ? truePositiveHigh / predictedHigh : NaN,
    recallHigh: actualHigh > 0 ? truePositiveHigh / actualHigh : NaN,
    precisionMediumPlus: predictedMediumPlus > 0 ? truePositiveMediumPlus / predictedMediumPlus : NaN,
    recallMediumPlus: actualMediumPlus > 0 ? truePositiveMediumPlus / actualMediumPlus : NaN,
  };
}

const currentScore = scoreThresholds(CURRENT_HIGH_THRESHOLD, CURRENT_MEDIUM_THRESHOLD);
console.log('Current hardcoded thresholds (HIGH > 1%, MEDIUM > 0.5%):');
console.log(
  `  HIGH tier:        precision=${(currentScore.precisionHigh * 100).toFixed(1)}%  recall=${(currentScore.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(currentScore.precisionMediumPlus * 100).toFixed(1)}%  recall=${(currentScore.recallMediumPlus * 100).toFixed(1)}%`,
);

// Percentile-based thresholds derived from the data itself: HIGH = 95th
// percentile observed rate, MEDIUM = 80th percentile — i.e. "flag the
// worst 5%/20% of merchants we actually see," rather than an
// absolute-rate cutoff picked without reference to the real population.
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
const observedRates = evaluable.map((m) => m.lostDisputes / m.settledCharges).sort((a, b) => a - b);
const derivedHighThreshold = percentile(observedRates, 0.95);
const derivedMediumThreshold = percentile(observedRates, 0.8);

const derivedScore = scoreThresholds(derivedHighThreshold, derivedMediumThreshold);
console.log(
  `\nData-derived thresholds (HIGH > ${(derivedHighThreshold * 100).toFixed(2)}% [95th pct], MEDIUM > ${(derivedMediumThreshold * 100).toFixed(2)}% [80th pct]):`,
);
console.log(
  `  HIGH tier:        precision=${(derivedScore.precisionHigh * 100).toFixed(1)}%  recall=${(derivedScore.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(derivedScore.precisionMediumPlus * 100).toFixed(1)}%  recall=${(derivedScore.recallMediumPlus * 100).toFixed(1)}%`,
);

console.log(
  `\nVerdict: ${derivedScore.precisionHigh >= currentScore.precisionHigh && derivedScore.recallHigh >= currentScore.recallHigh ? 'data-derived thresholds dominate the current fixed ones on this synthetic population (both higher precision and recall)' : 'no clean dominance either way on this synthetic population — real historical data, not this synthetic stand-in, would be needed before actually changing the production defaults'}.`,
);

// ─── Part 2: Dispute auto-accept threshold calibration ───────────────────

console.log(`\n=== Dispute auto-accept threshold calibration ===\n`);

// Assumed fully-loaded cost of contesting one dispute (operator time to
// prepare evidence, template review, etc.) — illustrative, same posture
// as this repo's other calibration inputs; a real calibration would pull
// this from actual time-tracking data.
const COST_PER_CONTEST_MAJOR_UNITS = 8;

// For each amount bucket, expected value of contesting = P(win) * amount - cost.
// Below the amount where that goes negative, auto-accepting (not
// contesting) is the economically correct default even before reason
// code is considered.
const buckets = Array.from({ length: 40 }, (_, i) => (i + 1) * 2); // $2, $4, ..., $80
let breakEvenAmount: number | null = null;
for (const bucketMax of buckets) {
  const inBucket = disputes.filter((d) => d.amountMajorUnits <= bucketMax && d.amountMajorUnits > bucketMax - 2);
  if (inBucket.length === 0) continue;
  const winRate = inBucket.filter((d) => d.wouldWinIfContested).length / inBucket.length;
  const expectedValue = winRate * bucketMax - COST_PER_CONTEST_MAJOR_UNITS;
  if (expectedValue >= 0 && breakEvenAmount === null) {
    breakEvenAmount = bucketMax;
  }
}

console.log(`Assumed cost per contest: $${COST_PER_CONTEST_MAJOR_UNITS}`);
console.log(
  `Break-even amount (expected contest value turns non-negative): ${breakEvenAmount !== null ? '$' + breakEvenAmount : 'not reached in the $2–$80 range sampled'}`,
);
console.log(`Current hardcoded DEFAULT_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS: $15`);
console.log(
  breakEvenAmount !== null
    ? `Verdict: the synthetic data's break-even point is ${breakEvenAmount === 15 ? 'exactly' : breakEvenAmount < 15 ? 'below' : 'above'} the current $15 default (by $${Math.abs((breakEvenAmount ?? 0) - 15)}) — on this synthetic population, not a claim about the real number, which needs real per-reason-code contest-outcome data this repo doesn't have.`
    : 'Verdict: no break-even reached in the sampled range — the current $15 default auto-accepts well below any amount where contesting starts making sense on this synthetic population.',
);
