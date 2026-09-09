/**
 * Generates a synthetic merchant transaction/dispute history — a stand-in
 * for the real historical data RiskTieringService's/DisputeService's
 * thresholds would actually be calibrated against, which this repository
 * doesn't have (no production history exists). Not random noise: a
 * deliberately realistic generative model (see comments below), with a
 * fixed seed so a calibration run against this data is reproducible, not
 * a different answer every time.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/calibration/generate-synthetic-history.ts
 * Writes scripts/calibration/synthetic-history.json, consumed by
 * calibrate-thresholds.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

// Mulberry32 — a small, fast, seeded PRNG. Deterministic (same seed same
// output every run) is the point: Math.random() would make this dataset,
// and therefore any calibration run against it, non-reproducible.
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

const rng = mulberry32(20260901);

function randomNormal(): number {
  // Box-Muller — turns two uniform randoms into one standard-normal one.
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randomLogNormal(mu: number, sigma: number): number {
  return Math.exp(mu + sigma * randomNormal());
}

// Poisson via Knuth's algorithm — fine for the lambda range here (< ~500).
function randomPoisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

export interface SyntheticMerchant {
  merchantId: string;
  /** Not observable in reality — the *true* underlying risk this merchant would carry with infinite data. Used only to score calibration quality below, never fed to the calibration itself. */
  trueRiskLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  trueLostDisputeRate: number;
  settledCharges: number;
  lostDisputes: number;
  /** Days since account creation — a younger account has had less *time* to accumulate the settledCharges it has, independent of its true risk label (a brand-new HIGH-risk merchant and a long-established HIGH-risk merchant have the same true rate; the new one has just had fewer chances for that rate to show up in the observed count yet). Used to test RISK_TIER_NEW_MERCHANT_AGE_DAYS below. */
  accountAgeDays: number;
  /** How `lostDisputes` breaks down by reason code — unlike accountAgeDays (deliberately independent of true risk), this *is* correlated with trueRiskLabel: a genuinely bad-actor merchant's lost disputes skew toward `fraudulent`; a genuinely fine merchant's occasional lost dispute is more likely a benign `duplicate`/`subscription_canceled` mixup. Used to test dispute-risk-weight.ts's DISPUTE_RISK_WEIGHTS below — the reason this codebase weights `fraudulent` at full weight and `duplicate` at a quarter is exactly this correlation. */
  lostDisputesByReason: Record<string, number>;
}

const MERCHANT_COUNT = 2000;

/**
 * Real payment-platform risk distributions are heavily skewed, not a bell
 * curve centered on "medium risk" — the large majority of merchants are
 * genuinely low-risk, a minority are marginal, and a small tail drives
 * most actual loss. Modeled as a 3-component mixture instead of one
 * distribution for exactly that reason: fitting one distribution to model
 * "most merchants are fine, a few are a real problem" produces a poor fit
 * either way (either it's too lenient on the tail or too suspicious of
 * ordinary merchants).
 */
function trueRiskProfile(u: number): { label: SyntheticMerchant['trueRiskLabel']; rate: number } {
  if (u < 0.85) {
    // Low risk: true rate uniform in [0.01%, 0.3%].
    return { label: 'LOW', rate: 0.0001 + rng() * 0.0029 };
  }
  if (u < 0.97) {
    // Medium risk: [0.3%, 1.5%].
    return { label: 'MEDIUM', rate: 0.003 + rng() * 0.012 };
  }
  // High risk (the tail): [1.5%, 8%].
  return { label: 'HIGH', rate: 0.015 + rng() * 0.065 };
}

// Reason-code strings match dispute-risk-weight.ts's DISPUTE_RISK_WEIGHTS
// keys exactly, for direct correspondence — this is a separate reason-code
// *mix* model (by merchant true-risk label) from generateDisputes()'s own
// REASON_CODES/WIN_RATE_BY_REASON below, which models a different question
// (contest win rate for the auto-accept calibration) against an
// independent 5,000-dispute population, not per-merchant.
const MERCHANT_DISPUTE_REASON_CODES = ['fraudulent', 'product_not_received', 'duplicate', 'subscription_canceled'];

/**
 * Reason-code mix among a merchant's lost disputes, by true risk label —
 * a genuinely high-risk (bad-actor) merchant's disputes skew toward
 * `fraudulent`; a genuinely low-risk merchant's occasional lost dispute
 * is more likely a benign `duplicate`/`subscription_canceled` mixup, not
 * evidence of real misconduct. This correlation is *the entire premise*
 * dispute-risk-weight.ts's weights are based on (fraudulent at full
 * weight, duplicate at a quarter) — illustrative, same posture as
 * trueRiskProfile() above, not fitted to real reason-code-by-merchant-risk
 * data, which this repo doesn't have.
 */
const REASON_MIX_BY_RISK_LABEL: Record<SyntheticMerchant['trueRiskLabel'], number[]> = {
  // [fraudulent, product_not_received, duplicate, subscription_canceled]
  HIGH: [0.5, 0.2, 0.2, 0.1],
  MEDIUM: [0.25, 0.3, 0.25, 0.2],
  LOW: [0.1, 0.25, 0.4, 0.25],
};

function distributeLostDisputesByReason(
  count: number,
  label: SyntheticMerchant['trueRiskLabel'],
): Record<string, number> {
  const mix = REASON_MIX_BY_RISK_LABEL[label];
  const result: Record<string, number> = { fraudulent: 0, product_not_received: 0, duplicate: 0, subscription_canceled: 0 };
  for (let i = 0; i < count; i++) {
    const u = rng();
    let cumulative = 0;
    for (let j = 0; j < MERCHANT_DISPUTE_REASON_CODES.length; j++) {
      cumulative += mix[j];
      if (u < cumulative) {
        result[MERCHANT_DISPUTE_REASON_CODES[j]]++;
        break;
      }
    }
  }
  return result;
}

function generateMerchants(): SyntheticMerchant[] {
  const merchants: SyntheticMerchant[] = [];
  for (let i = 0; i < MERCHANT_COUNT; i++) {
    const { label, rate } = trueRiskProfile(rng());
    // Account age independent of true risk label — a brand-new account
    // and a long-established one can carry the same underlying risk; age
    // only affects how much observed history exists yet. Log-normal,
    // median ~200 days, with a genuine long tail down toward very new
    // accounts (not truncated away) since those are exactly the
    // population RISK_TIER_NEW_MERCHANT_AGE_DAYS targets.
    const accountAgeDays = Math.max(1, Math.round(randomLogNormal(Math.log(200), 1.0)));
    // Settled-charge volume over a trailing 90-day window: log-normal,
    // median ~40 charges — most merchants are small, a few are large,
    // matching RiskTieringService's own MIN_SAMPLE_SIZE=10 concern that
    // plenty of real merchants sit right at the edge of having enough
    // sample to evaluate at all. Capped by accountAgeDays' own implied
    // ceiling (an account can't have a 90-day trailing volume built up
    // faster than ~1.5 charges/day sustained since it opened) — this is
    // what makes a very new account's observed rate genuinely less
    // reliable, not just nominally so.
    const uncappedCharges = Math.max(0, Math.round(randomLogNormal(Math.log(40), 1.1)));
    const ageImpliedCap = Math.round(Math.min(90, accountAgeDays) * 1.5);
    const settledCharges = Math.min(uncappedCharges, ageImpliedCap);
    // Binomial(settledCharges, rate) approximated via Poisson(settledCharges * rate)
    // — a fine approximation at this rate*n range, and it's what a real
    // dispute-arrival process looks like anyway (events arriving
    // independently at a small per-charge probability).
    const lostDisputes = settledCharges > 0 ? Math.min(settledCharges, randomPoisson(settledCharges * rate)) : 0;
    const lostDisputesByReason = distributeLostDisputesByReason(lostDisputes, label);

    merchants.push({
      merchantId: `synthetic_merchant_${i}`,
      trueRiskLabel: label,
      trueLostDisputeRate: rate,
      settledCharges,
      lostDisputes,
      accountAgeDays,
      lostDisputesByReason,
    });
  }
  return merchants;
}

export interface SyntheticDispute {
  disputeId: string;
  amountMajorUnits: number;
  reasonCode: string;
  /** Whether contesting this dispute (had it been contested) would have actually won. */
  wouldWinIfContested: boolean;
}

const DISPUTE_COUNT = 5000;
const REASON_CODES = ['fraudulent', 'product_not_received', 'duplicate', 'subscription_canceled', 'other'];
// Real per-reason-code contest win rates this simulates — fraud claims are
// genuinely hard to win without strong evidence; duplicate/subscription
// claims are comparatively easy to disprove with records. Illustrative
// numbers (this repo has no real chargeback win-rate data either), but a
// deliberately *differentiated* set, not one flat rate — the whole point
// of a reason-code-aware policy is that these differ.
const WIN_RATE_BY_REASON: Record<string, number> = {
  fraudulent: 0.15,
  product_not_received: 0.55,
  duplicate: 0.85,
  subscription_canceled: 0.4,
  other: 0.3,
};

function generateDisputes(): SyntheticDispute[] {
  const disputes: SyntheticDispute[] = [];
  for (let i = 0; i < DISPUTE_COUNT; i++) {
    // Dispute amounts: log-normal, median ~$35 — most disputes are
    // ordinary consumer purchases, a long tail of larger ones.
    const amountMajorUnits = Math.round(randomLogNormal(Math.log(35), 0.9) * 100) / 100;
    const reasonCode = REASON_CODES[Math.floor(rng() * REASON_CODES.length)];
    const wouldWinIfContested = rng() < WIN_RATE_BY_REASON[reasonCode];
    disputes.push({ disputeId: `synthetic_dispute_${i}`, amountMajorUnits, reasonCode, wouldWinIfContested });
  }
  return disputes;
}

function main(): void {
  const merchants = generateMerchants();
  const disputes = generateDisputes();
  const outPath = path.join(__dirname, 'synthetic-history.json');
  fs.writeFileSync(outPath, JSON.stringify({ merchants, disputes }, null, 2));
  console.log(`Wrote ${merchants.length} synthetic merchants and ${disputes.length} synthetic disputes to ${outPath}`);
}

if (require.main === module) {
  main();
}
