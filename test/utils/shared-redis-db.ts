import { CachePort } from '../../src/modules/payment/ports/outbound/cache.port';

/**
 * `test/setup-env.ts` gives each Jest worker its own logical Redis DB
 * (`1 + JEST_WORKER_ID`) so idempotency/circuit-breaker/rate-limit state
 * can't collide across concurrently-running files — correct for almost
 * everything, but it defeats the one thing in this codebase that's
 * supposed to be a genuine cross-*instance* mutex regardless of which
 * process holds it: PayoutService.runSweep()'s Redis SETNX lock
 * (`payout-sweep-lock`). In production there is exactly one Redis, so
 * that lock really does serialize concurrent sweep triggers (see its own
 * docblock). Under per-worker DB isolation, two files that both call
 * runSweep() (directly or via POST /admin/marketplace/run-payouts) from
 * different Jest workers each hold the lock in their own private DB —
 * neither ever sees the other's, so both "acquire" it and both process
 * the same ledger_outbox window, producing a genuine duplicate Payout.
 * Confirmed by direct reproduction: 3/3 runs of exactly the 3 files that
 * actually call runSweep() (marketplace-payouts, bank-transfer-rail,
 * reserve-followup-transfer — kyc-review only mentions it in a comment)
 * together at maxWorkers=4 produced 2-3 duplicate Payout rows for the
 * same merchant; 0/5 runs of any of them alone ever did.
 *
 * Making the lock itself cross-worker-visible (share DB 15 across just
 * these files) turned out not to be enough on its own: it stops the
 * *duplicate*, but two of these files' sweeps can now genuinely race for
 * real — whichever wins ends up processing the *other* file's merchant's
 * ledger credit too (both scan the same ledger_outbox table system-wide),
 * so "my own call's connectedMerchantsPaid" and "the sweep loses the lock
 * race twice in a row" become flaky in a new way these tests weren't
 * written to tolerate. The actual fix: make these 3 files' entire test
 * runs mutually exclusive — acquireExclusiveSweepTestSuite() blocks
 * (retrying) until it's the only one of these 3 files running, held for
 * the whole suite via beforeAll/afterAll. Every other e2e file is
 * unaffected and keeps running fully in parallel; only these 3 ever wait
 * on each other, and only for as long as one of them takes to finish.
 */
const SHARED_REDIS_DB = '15';

export function forceSharedRedisDbForSweepLock(): { restore: () => void } {
  const original = process.env.REDIS_DB;
  process.env.REDIS_DB = SHARED_REDIS_DB;
  return {
    restore: () => {
      if (original === undefined) delete process.env.REDIS_DB;
      else process.env.REDIS_DB = original;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SUITE_MUTEX_KEY = 'e2e-sweep-suite-mutex';
// Generous relative to how long any one of these files actually takes
// (15-25s observed) — same "survive a legitimately slow run" reasoning
// as PayoutService's own SWEEP_LOCK_TTL_SECONDS.
const SUITE_MUTEX_TTL_SECONDS = 300;

/**
 * Pass this as the `beforeAll(fn, timeout)` second argument at every
 * `acquireExclusiveSweepTestSuite()` call site — Jest's own default hook
 * timeout (`testTimeout` in jest-e2e.json, 60000ms) is well under
 * `SUITE_MUTEX_TTL_SECONDS`'s own 300s "a legitimately slow run" budget
 * above, so a file that loses the mutex race can time out its *hook*
 * long before the actual holder's TTL would ever expire — a real,
 * reproduced failure once seeding each of these files' many merchants
 * started making an extra real network call (sanctions screening, see
 * `MerchantService.createMerchant()`), pushing a normal run close enough
 * to 60s that losing the race started failing outright instead of just
 * waiting a bit. Exceeds the mutex's own TTL by a comfortable margin
 * rather than merely matching it, since the *acquire* wait and the
 * *held* duration are the same 300s budget from two different files'
 * perspectives.
 */
export const SUITE_MUTEX_ACQUIRE_TIMEOUT_MS = 310_000;

/** Blocks until no other of these 3 files is mid-run, then holds the mutex until released. */
export async function acquireExclusiveSweepTestSuite(cache: CachePort): Promise<() => Promise<void>> {
  while (!(await cache.setNX(SUITE_MUTEX_KEY, new Date().toISOString(), SUITE_MUTEX_TTL_SECONDS))) {
    await sleep(300);
  }
  return () => cache.del(SUITE_MUTEX_KEY);
}
