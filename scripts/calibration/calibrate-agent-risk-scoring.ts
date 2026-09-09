/**
 * Scores PaymentAggregate.calculateRiskScore()'s agent-context signals
 * (Phase 1 item 7) against generate-synthetic-agent-charges.ts's
 * synthetic population — calling the real production method directly
 * (constructing a minimal real PaymentAggregate), not a reimplementation
 * of its scoring logic, so this can never silently drift from what the
 * codebase actually does.
 *
 * Every synthetic charge uses the same $20 USD amount and no BinInfo —
 * matching test/agent-risk-scoring.e2e-spec.ts's own approach — so the
 * existing amount/SCA bumps are always 0 and the *only* thing varying
 * the score is the two agent-context signals being tested here.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/generate-synthetic-agent-charges.ts
 *   npx ts-node -r tsconfig-paths/register scripts/calibration/calibrate-agent-risk-scoring.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PaymentAggregate } from '../../src/modules/payment/domain/aggregates/payment.aggregate';
import { Money } from '../../src/modules/payment/domain/value-objects/money.vo';
import { SyntheticAgentCharge } from './generate-synthetic-agent-charges';

const dataPath = path.join(__dirname, 'synthetic-agent-charges.json');
if (!fs.existsSync(dataPath)) {
  console.error('synthetic-agent-charges.json not found — run generate-synthetic-agent-charges.ts first.');
  process.exit(1);
}
const { charges } = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as { charges: SyntheticAgentCharge[] };

function scoreCharge(c: SyntheticAgentCharge): number {
  const payment = PaymentAggregate.create({
    id: c.chargeId,
    amount: Money.of(20, 'USD'),
    idempotencyKey: c.chargeId,
    metadata: { merchantId: 'synthetic_merchant' },
    delegationId: 'synthetic_delegation',
    initiatedBy: 'agent',
  });
  return payment.calculateRiskScore({
    isFirstChargeToMerchant: c.isFirstChargeToMerchant,
    percentOfRemainingMonthlyBudget: c.percentOfRemainingMonthlyBudget,
  });
}

interface ScoreResult {
  precision: number;
  recall: number;
  flaggedCount: number;
}

// Flags a charge as "worth a second look" at or above this score —
// tried at a few thresholds below, not hardcoded to one guess.
function scoreAtThreshold(scores: number[], threshold: number): ScoreResult {
  let truePositive = 0,
    flagged = 0,
    actualProblematic = 0;
  for (let i = 0; i < charges.length; i++) {
    const isFlagged = scores[i] >= threshold;
    const isProblematic = charges[i].trueLabel === 'PROBLEMATIC';
    if (isFlagged) flagged++;
    if (isProblematic) actualProblematic++;
    if (isFlagged && isProblematic) truePositive++;
  }
  return {
    precision: flagged > 0 ? truePositive / flagged : NaN,
    recall: actualProblematic > 0 ? truePositive / actualProblematic : NaN,
    flaggedCount: flagged,
  };
}

console.log(`\n=== Agent risk-scoring signal calibration (${charges.length} synthetic agent charges) ===\n`);

const scores = charges.map(scoreCharge);
const problematicCount = charges.filter((c) => c.trueLabel === 'PROBLEMATIC').length;
console.log(`True PROBLEMATIC rate in this population: ${((problematicCount / charges.length) * 100).toFixed(1)}%\n`);

// 15: either signal alone (isFirstChargeToMerchant OR budget>=50%) flags.
// 30: both signals must fire together (the score cap means this is only
// reachable when both bumps apply, since baseline is always 0 here).
for (const threshold of [15, 30]) {
  const result = scoreAtThreshold(scores, threshold);
  console.log(
    `Score >= ${threshold} (${threshold === 15 ? 'either signal alone' : 'both signals required'}): ` +
      `flagged ${result.flaggedCount}/${charges.length}, precision=${(result.precision * 100).toFixed(1)}%, recall=${(result.recall * 100).toFixed(1)}%`,
  );
}

// Baseline for comparison: a "flag every agent charge" or "flag nothing"
// strategy's precision is just the population's own PROBLEMATIC rate —
// any real signal has to beat this to be worth having at all.
console.log(
  `\nBaseline (flag every charge, i.e. no signal at all): precision=${((problematicCount / charges.length) * 100).toFixed(1)}%, recall=100.0%`,
);

const result15 = scoreAtThreshold(scores, 15);
const precisionLift = result15.precision - problematicCount / charges.length;
console.log(
  `\nVerdict: at score>=15, the two agent-context signals lift precision by ${(precisionLift * 100).toFixed(1)} percentage points over flagging nothing/everything, while still catching ${(result15.recall * 100).toFixed(1)}% of genuinely problematic charges on this synthetic population. ` +
    `${precisionLift > 0.1 ? 'A real, measured improvement over having no signal at all' : 'Only a marginal improvement over having no signal at all'} — illustrative only: the *size* of the correlation this population assumes between each signal and genuine anomaly (generate-synthetic-agent-charges.ts's own generative story) is itself an assumption with no real delegation/agent transaction history behind it in this repository.`,
);
