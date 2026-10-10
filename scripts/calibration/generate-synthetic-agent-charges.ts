/**
 * Generates a synthetic population of agent-initiated charges — a
 * stand-in for real delegation/agent transaction history to test
 * PaymentAggregate.calculateRiskScore()'s agent-context signals against
 * (Phase 1 item 7: isFirstChargeToMerchant, percentOfRemainingMonthlyBudget).
 * A genuinely separate domain from generate-synthetic-history.ts's
 * merchant-dispute-history population — an agent/delegation's spend
 * behavior has no relationship to a merchant's own chargeback history, so
 * this is its own generator, not an extension of that one.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/calibration/generate-synthetic-agent-charges.ts
 * Writes scripts/calibration/synthetic-agent-charges.json, consumed by
 * calibrate-agent-risk-scoring.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

// Same Mulberry32 PRNG as generate-synthetic-history.ts, different fixed
// seed — deliberately independent of that generator's own RNG sequence,
// so regenerating one dataset never shifts the other's numbers.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260906);

export interface SyntheticAgentCharge {
  chargeId: string;
  isFirstChargeToMerchant: boolean;
  /** 0-100 — this charge's amount as a percentage of the delegation's remaining monthly budget before this charge. */
  percentOfRemainingMonthlyBudget: number;
  /**
   * Not observable in reality — whether this charge was genuinely
   * anomalous (a compromised delegation credential, a malfunctioning/
   * runaway agent, unauthorized use) vs. an ordinary, legitimate agent
   * purchase. Used only to score the signals below, never fed into the
   * scoring itself.
   */
  trueLabel: 'PROBLEMATIC' | 'NORMAL';
}

const CHARGE_COUNT = 5000;
// A genuinely anomalous agent charge is rare — modeled in the same
// "small tail drives the real signal" shape as trueRiskProfile() in
// generate-synthetic-history.ts, not a coin flip.
const PROBLEMATIC_RATE = 0.03;

/**
 * The generative story this models: a compromised/malfunctioning agent
 * is more likely (not certain — an attacker could just as easily drain
 * an already-known merchant relationship) to hit a merchant this
 * delegation has never charged before, AND more likely to draw a large
 * share of whatever budget is left (extracting value before being
 * caught, or a runaway loop). An ordinary, legitimate agent charge is
 * mostly a repeat purchase (subscriptions, recurring vendors) at a
 * modest fraction of the monthly budget — new-merchant relationships and
 * large single draws both happen for entirely legitimate reasons too,
 * just less often. Illustrative, same posture as every other calibration
 * input this codebase has been honest about — there is no real
 * delegation/agent transaction history in this repository to fit this
 * to.
 */
function generateCharge(id: number): SyntheticAgentCharge {
  const isProblematic = rng() < PROBLEMATIC_RATE;

  let isFirstChargeToMerchant: boolean;
  let percentOfRemainingMonthlyBudget: number;

  if (isProblematic) {
    isFirstChargeToMerchant = rng() < 0.7;
    // Skewed toward consuming most of what's left — 60% chance of
    // landing in the 50-100% range, else uniform across the full range.
    percentOfRemainingMonthlyBudget = rng() < 0.6 ? 50 + rng() * 50 : rng() * 100;
  } else {
    isFirstChargeToMerchant = rng() < 0.15;
    // Skewed low — most legitimate charges are a small fraction of the
    // remaining budget; only a modest tail draws a large share (a
    // genuinely big, legitimate one-off purchase).
    percentOfRemainingMonthlyBudget = rng() < 0.9 ? rng() * 30 : 30 + rng() * 70;
  }

  return {
    chargeId: `synthetic_agent_charge_${id}`,
    isFirstChargeToMerchant,
    percentOfRemainingMonthlyBudget: Math.round(percentOfRemainingMonthlyBudget * 10) / 10,
    trueLabel: isProblematic ? 'PROBLEMATIC' : 'NORMAL',
  };
}

function main(): void {
  const charges: SyntheticAgentCharge[] = [];
  for (let i = 0; i < CHARGE_COUNT; i++) {
    charges.push(generateCharge(i));
  }
  const outPath = path.join(__dirname, 'synthetic-agent-charges.json');
  fs.writeFileSync(outPath, JSON.stringify({ charges }, null, 2));
  const problematicCount = charges.filter((c) => c.trueLabel === 'PROBLEMATIC').length;
  console.log(`Wrote ${charges.length} synthetic agent charges (${problematicCount} PROBLEMATIC) to ${outPath}`);
}

if (require.main === module) {
  main();
}
