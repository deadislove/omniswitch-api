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
 * 3. New-merchant-age escalation (Phase 1): scores whether escalating a
 *    merchant one tier when `accountAgeDays <
 *    RISK_TIER_NEW_MERCHANT_AGE_DAYS` (30) actually improves precision/
 *    recall against the same synthetic population's true labels, or is
 *    just adding noise.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/generate-synthetic-history.ts
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/calibrate-thresholds.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SyntheticMerchant, SyntheticDispute } from './generate-synthetic-history';
// The real production function, not a copy — so this calibration can
// never silently drift from what RiskTieringService actually uses.
import { getDisputeRiskWeight } from '../../src/modules/payment/domain/services/dispute-risk-weight';

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

// ─── Part 3: New-merchant-age escalation calibration (Phase 1) ──────────

console.log(`\n=== New-merchant-age escalation calibration ===\n`);

const NEW_MERCHANT_AGE_DAYS = 30; // Mirrors RISK_TIER_NEW_MERCHANT_AGE_DAYS's default.

function escalate(tier: 'LOW' | 'MEDIUM' | 'HIGH'): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (tier === 'LOW') return 'MEDIUM';
  if (tier === 'MEDIUM') return 'HIGH';
  return 'HIGH';
}

interface AgeScoreResult extends ScoreResult {
  escalatedCount: number;
}

function scoreWithAgeEscalation(high: number, medium: number, ageThresholdDays: number | null): AgeScoreResult {
  let truePositiveHigh = 0,
    predictedHigh = 0,
    actualHigh = 0;
  let truePositiveMediumPlus = 0,
    predictedMediumPlus = 0,
    actualMediumPlus = 0;
  let escalatedCount = 0;

  for (const m of evaluable) {
    const observedRate = m.lostDisputes / m.settledCharges;
    let predictedTier = tierFor(observedRate, high, medium);
    if (ageThresholdDays !== null && m.accountAgeDays < ageThresholdDays) {
      const before = predictedTier;
      predictedTier = escalate(predictedTier);
      if (predictedTier !== before) escalatedCount++;
    }
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
    escalatedCount,
  };
}

const withoutAgeEscalation = scoreWithAgeEscalation(CURRENT_HIGH_THRESHOLD, CURRENT_MEDIUM_THRESHOLD, null);
const withAgeEscalation = scoreWithAgeEscalation(CURRENT_HIGH_THRESHOLD, CURRENT_MEDIUM_THRESHOLD, NEW_MERCHANT_AGE_DAYS);

console.log(`Without age escalation (current base thresholds only):`);
console.log(
  `  HIGH tier:        precision=${(withoutAgeEscalation.precisionHigh * 100).toFixed(1)}%  recall=${(withoutAgeEscalation.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(withoutAgeEscalation.precisionMediumPlus * 100).toFixed(1)}%  recall=${(withoutAgeEscalation.recallMediumPlus * 100).toFixed(1)}%`,
);
console.log(`\nWith age escalation (accountAgeDays < ${NEW_MERCHANT_AGE_DAYS} escalates one tier):`);
console.log(`  Merchants actually escalated: ${withAgeEscalation.escalatedCount}/${evaluable.length}`);
console.log(
  `  HIGH tier:        precision=${(withAgeEscalation.precisionHigh * 100).toFixed(1)}%  recall=${(withAgeEscalation.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(withAgeEscalation.precisionMediumPlus * 100).toFixed(1)}%  recall=${(withAgeEscalation.recallMediumPlus * 100).toFixed(1)}%`,
);

const recallGain = withAgeEscalation.recallMediumPlus - withoutAgeEscalation.recallMediumPlus;
const precisionCost = withoutAgeEscalation.precisionMediumPlus - withAgeEscalation.precisionMediumPlus;
console.log(
  `\nVerdict: age escalation changes MEDIUM+ recall by ${(recallGain * 100).toFixed(1)}pp and precision by ${(-precisionCost * 100).toFixed(1)}pp on this synthetic population. ` +
    `${recallGain > 0 ? `It catches genuinely-HIGH/MEDIUM merchants that a purely rate-based threshold would have missed while they were still too new to have accumulated enough disputes to show it (exactly the sample-size argument the feature is based on)` : 'It did not measurably improve recall on this synthetic population'}` +
    `${precisionCost > 0.02 ? `, at a real precision cost (more false-positive escalations of genuinely LOW-risk new merchants) worth weighing against the recall gain` : ', with only a small precision cost'} — ` +
    `illustrative only: the real-world relationship between account age and true risk (this synthetic model deliberately keeps them independent) is itself an assumption that would need real data to confirm or refute.`,
);

// ─── Part 4: Dispute reason-code weighting calibration (Phase 1) ────────

console.log(`\n=== Dispute reason-code weighting calibration ===\n`);

const REASON_CODES_SCORED = ['fraudulent', 'product_not_received', 'duplicate', 'subscription_canceled'];

function weightedLostDisputeRate(m: SyntheticMerchant): number {
  let weighted = 0;
  for (const reason of REASON_CODES_SCORED) {
    weighted += (m.lostDisputesByReason[reason] ?? 0) * getDisputeRiskWeight(reason);
  }
  return m.settledCharges > 0 ? weighted / m.settledCharges : 0;
}

function rawLostDisputeRate(m: SyntheticMerchant): number {
  return m.settledCharges > 0 ? m.lostDisputes / m.settledCharges : 0;
}

function scoreByRateFn(rateFn: (m: SyntheticMerchant) => number, high: number, medium: number): ScoreResult {
  let truePositiveHigh = 0,
    predictedHigh = 0,
    actualHigh = 0;
  let truePositiveMediumPlus = 0,
    predictedMediumPlus = 0,
    actualMediumPlus = 0;

  for (const m of evaluable) {
    const predictedTier = tierFor(rateFn(m), high, medium);
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

// Same current fixed thresholds — the question here isn't "what should
// the threshold be" (Part 1 already covers that), it's "does weighting
// each LOST dispute by reason code, instead of counting every one
// identically, produce a better-classified population at the *same*
// threshold."
const rawRateScore = scoreByRateFn(rawLostDisputeRate, CURRENT_HIGH_THRESHOLD, CURRENT_MEDIUM_THRESHOLD);
const weightedRateScore = scoreByRateFn(weightedLostDisputeRate, CURRENT_HIGH_THRESHOLD, CURRENT_MEDIUM_THRESHOLD);

console.log(`Raw (unweighted) lost-dispute rate — every LOST dispute counted identically:`);
console.log(
  `  HIGH tier:        precision=${(rawRateScore.precisionHigh * 100).toFixed(1)}%  recall=${(rawRateScore.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(rawRateScore.precisionMediumPlus * 100).toFixed(1)}%  recall=${(rawRateScore.recallMediumPlus * 100).toFixed(1)}%`,
);
console.log(`\nWeighted lost-dispute rate — using getDisputeRiskWeight() (the real production function):`);
console.log(
  `  HIGH tier:        precision=${(weightedRateScore.precisionHigh * 100).toFixed(1)}%  recall=${(weightedRateScore.recallHigh * 100).toFixed(1)}%`,
);
console.log(
  `  MEDIUM+ tier:      precision=${(weightedRateScore.precisionMediumPlus * 100).toFixed(1)}%  recall=${(weightedRateScore.recallMediumPlus * 100).toFixed(1)}%`,
);

const weightedPrecisionGainHigh = weightedRateScore.precisionHigh - rawRateScore.precisionHigh;
const weightedRecallDeltaHigh = weightedRateScore.recallHigh - rawRateScore.recallHigh;
console.log(
  `\nVerdict: reason-code weighting changes HIGH-tier precision by ${(weightedPrecisionGainHigh * 100).toFixed(1)}pp and recall by ${(weightedRecallDeltaHigh * 100).toFixed(1)}pp on this synthetic population ` +
    `(built so a HIGH-true-risk merchant's disputes skew toward \`fraudulent\` — full weight — and a LOW-true-risk merchant's skew toward \`duplicate\`/\`subscription_canceled\` — quarter/half weight). ` +
    `${weightedPrecisionGainHigh > 0 ? 'Weighting dominates on precision here — a real, measured case for reason-code awareness, not just a plausible-sounding idea' : 'No precision improvement measured on this synthetic population'} — ` +
    `illustrative only: the *size* of the correlation between reason code and true risk (the REASON_MIX_BY_RISK_LABEL split in generate-synthetic-history.ts) is itself an assumption, same as every other input in this exercise.`,
);
