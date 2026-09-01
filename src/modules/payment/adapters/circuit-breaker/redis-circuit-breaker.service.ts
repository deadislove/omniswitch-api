import { Injectable } from '@nestjs/common';
import { CachePort } from '../../ports/outbound/cache.port';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitMetrics {
  state: CircuitState;
  successCount: number;
  totalRequests: number;
  avgLatencyMs: number;
}

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIME_MS = 30000;
// How many calls are admitted as trial probes per HALF_OPEN episode —
// matches Resilience4j's typical permittedNumberOfCallsInHalfOpenState
// default of a small, fixed budget rather than letting every concurrent
// caller through. See assertAvailable()'s docblock.
const HALF_OPEN_TRIAL_CALLS = 1;

// A call that never throws but is consistently slow is otherwise invisible
// to the breaker: recordFailure() below is only ever reached via a thrown
// exception, and the adapters' hard timeout is 30s, so a PSP that's
// silently hanging (not erroring, just never responding) would need up to
// FAILURE_THRESHOLD consecutive full 30s timeouts (2.5 minutes) before the
// existing failure-count path notices anything is wrong. This tracks the
// recent-call slow rate independently of that path and opens the circuit
// directly once enough of the last few calls were slow — without waiting
// for any of them to actually fail — the same "slow call rate" trip
// Resilience4j's SlowCallRateThreshold config implements.
// 5s is well under the adapters' 30s hard abort, so this fires on real
// degradation, not on ordinary latency variance.
const SLOW_CALL_THRESHOLD_MS = 5000;
// Below this many recent calls, the rate isn't a reliable signal yet — one
// slow call out of one is 100% "slow" but tells us nothing.
const SLOW_CALL_MIN_CALLS = 5;
// Matches Resilience4j's typical default posture: roughly half of recent
// calls running slow is treated as a real degradation, not noise.
const SLOW_CALL_RATE_THRESHOLD = 0.5;
// How long a run of failures stays "live" for the OPEN-trip decision.
// failureCount's TTL is refreshed on every recordFailure() call (below), so
// it behaves as a sliding activity window: failures with no gap longer than
// this between them keep accumulating toward FAILURE_THRESHOLD, but the
// counter expires — and the count restarts from zero — once failures stop
// happening for this long. Without this, failureCount only ever reset via
// HALF_OPEN -> CLOSED recovery, so failures scattered arbitrarily far apart
// in time (a handful today, a couple more next month) counted toward the
// same threshold as five failures in one burst.
const FAILURE_WINDOW_SECONDS = 60;

// Reported health metrics (successCount/totalRequests/avgLatencyMs) are a
// sliding window made of fixed 1-minute buckets — same fixed-window-counter
// trade-off already used for rate limiting (see
// docs/technical/distributed-state.md): a true sliding log (one Redis
// member per request, e.g. a sorted set) would be more precise but costs a
// write per request instead of one INCR into whichever minute is current.
// For "is this PSP healthy right now," minute-granularity is more than
// enough.
const METRICS_BUCKET_SECONDS = 60;
const METRICS_WINDOW_MINUTES = 15;
const METRICS_BUCKET_TTL_SECONDS = (METRICS_WINDOW_MINUTES + 5) * 60;

/**
 * Redis-Backed Circuit Breaker
 *
 * StripePSPAdapter/AdyenPSPAdapter used to keep circuit breaker state
 * (failure count, OPEN/HALF_OPEN/CLOSED, success/latency metrics) in plain
 * instance fields. That's per-process — with multiple replicas, each pod
 * independently decides whether a PSP is healthy, so one pod can keep
 * hammering a PSP its siblings have already tripped the breaker on, and the
 * "success rate" shown by GET /payments/routing/health only reflects
 * whichever pod answered that specific request. This moves the state into
 * Redis (via the existing CachePort, no new connection) so every replica
 * shares one view per PSP provider.
 *
 * Reported metrics (successCount/totalRequests/avgLatencyMs, via
 * getMetrics()) cover a rolling METRICS_WINDOW_MINUTES-minute window, not
 * all-time — they used to be plain cumulative counters that never reset for
 * as long as the Redis keys lived, meaning a bad incident from months ago
 * stayed baked into the reported success rate forever. Fixed by bucketing
 * writes into per-minute keys (each with its own short TTL) and summing the
 * last METRICS_WINDOW_MINUTES of them at read time.
 *
 * Two independent triggers can open the circuit: recordFailure() reaching
 * FAILURE_THRESHOLD (a hard error was thrown), or recordSuccess() seeing
 * enough recent calls exceed SLOW_CALL_THRESHOLD_MS even though none of
 * them actually failed (see SLOW_CALL_THRESHOLD_MS above) — a hanging-but-
 * not-yet-erroring PSP trips the breaker on the second path long before it
 * could ever accumulate FAILURE_THRESHOLD real failures.
 */
@Injectable()
export class RedisCircuitBreakerService {
  constructor(private readonly cache: CachePort) {}

  private key(provider: string, field: string): string {
    return `circuit:${provider}:${field}`;
  }

  private currentEpochMinute(): number {
    return Math.floor(Date.now() / (METRICS_BUCKET_SECONDS * 1000));
  }

  private bucketKey(provider: string, field: 'success' | 'total' | 'latencyMs', epochMinute: number): string {
    return `circuit:${provider}:bucket:${epochMinute}:${field}`;
  }

  private async incrBucket(bucketKey: string, by = 1): Promise<void> {
    // TTL is refreshed on every write to that bucket, which is harmless
    // here (unlike the rate limiter, over-extending this TTL doesn't change
    // the window's meaning — each bucket's *key name* is what pins it to a
    // specific minute, not its expiry).
    await this.cache.pipeline([
      ['incrby', bucketKey, by],
      ['expire', bucketKey, METRICS_BUCKET_TTL_SECONDS],
    ]);
  }

  /** Read-only — true if a currently-OPEN state's RECOVERY_TIME_MS has elapsed. */
  private async hasRecoveryWindowElapsed(provider: string): Promise<boolean> {
    const lastFailureTime = await this.cache.get<number>(this.key(provider, 'lastFailureTime'));
    return Boolean(lastFailureTime && Date.now() - lastFailureTime > RECOVERY_TIME_MS);
  }

  /**
   * What this provider's circuit state actually is right now, without
   * persisting anything or consuming a HALF_OPEN trial slot — a stored
   * `OPEN` whose recovery window has already elapsed reads as `HALF_OPEN`.
   *
   * Exists for read-only callers: getMetrics()/isAvailable(), and
   * therefore SmartRoutingStrategy.filterAvailableProviders() (every
   * *new*-charge routing decision reads a PSP's health this way).
   * Without this, a stored `OPEN` never self-corrects for that path: the
   * only thing that ever performs the real OPEN -> HALF_OPEN transition
   * is assertAvailable() below, and that method is only ever called from
   * inside a PSP adapter's own charge()/refund()/capture()/cancel() —
   * i.e. only once a PSP has *already* been selected. A brand-new charge
   * routed via smart routing never reaches that adapter at all once it's
   * filtered out as OPEN, so — before this method existed — a PSP that
   * tripped OPEN could stay permanently excluded from all future
   * new-charge routing, indefinitely past its recovery window, unless
   * some unrelated call (a refund/capture against an *existing* payment,
   * which bypasses routing and targets a known PSP directly) happened to
   * call assertAvailable() on it first.
   */
  private async computeEffectiveState(provider: string): Promise<CircuitState> {
    const state = (await this.cache.get<CircuitState>(this.key(provider, 'state'))) ?? 'CLOSED';
    if (state === 'OPEN' && (await this.hasRecoveryWindowElapsed(provider))) {
      return 'HALF_OPEN';
    }
    return state;
  }

  /**
   * Throws if the circuit is OPEN and the recovery window hasn't elapsed
   * yet, or if it's HALF_OPEN and the HALF_OPEN_TRIAL_CALLS budget for
   * this recovery episode is already spent.
   *
   * HALF_OPEN only ever gates a small, fixed number of trial calls, not
   * every caller — once the state flips, every replica's concurrent
   * traffic would otherwise pass through simultaneously (the exact
   * opposite of what HALF_OPEN exists to do: send a struggling PSP a
   * small probe, not a resumed full burst right as it starts recovering).
   * The trial budget is a shared Redis INCR, so it's enforced across
   * every replica the same way the rest of this breaker's state is.
   *
   * Deliberately duplicates (rather than calls) the recovery-window
   * check computeEffectiveState() above also does — this method, unlike
   * that one, must actually persist the OPEN -> HALF_OPEN transition and
   * go on to consume a trial slot, which a read-only caller must never do.
   */
  async assertAvailable(provider: string): Promise<void> {
    const state = (await this.cache.get<CircuitState>(this.key(provider, 'state'))) ?? 'CLOSED';

    if (state === 'CLOSED') return;

    if (state === 'OPEN') {
      if (!(await this.hasRecoveryWindowElapsed(provider))) {
        throw new Error(`${provider} circuit breaker is OPEN. Service unavailable.`);
      }
      // Recovery window elapsed. Benign race if multiple replicas hit this
      // at once — same target value — they all fall through to the trial
      // budget check below together, which is itself race-safe (atomic INCR).
      await this.cache.set(this.key(provider, 'state'), 'HALF_OPEN');
    }

    // state is HALF_OPEN here, either already was or was just set above.
    const trialKey = this.key(provider, 'halfOpenTrialCount');
    const trialNumber = await this.cache.incr(trialKey);
    if (trialNumber === 1) {
      // Only the caller that actually claims trial #1 sets the TTL — an
      // expire() from a later, over-budget caller would extend this
      // window every time it's hit, letting a busy PSP's rejected traffic
      // indefinitely postpone the trial counter's own expiry.
      await this.cache.expire(trialKey, Math.ceil(RECOVERY_TIME_MS / 1000));
    }
    if (trialNumber > HALF_OPEN_TRIAL_CALLS) {
      throw new Error(`${provider} circuit breaker is OPEN. Service unavailable.`);
    }
  }

  async recordSuccess(provider: string, latencyMs: number): Promise<void> {
    const epoch = this.currentEpochMinute();
    await Promise.all([
      this.incrBucket(this.bucketKey(provider, 'success', epoch)),
      this.incrBucket(this.bucketKey(provider, 'total', epoch)),
      this.incrBucket(this.bucketKey(provider, 'latencyMs', epoch), latencyMs),
    ]);

    const state = await this.cache.get<CircuitState>(this.key(provider, 'state'));
    if (state === 'HALF_OPEN') {
      await this.cache.set(this.key(provider, 'state'), 'CLOSED');
      await this.cache.set(this.key(provider, 'failureCount'), 0);
      await this.cache.set(this.key(provider, 'recentCallCount'), 0);
      await this.cache.set(this.key(provider, 'slowCallCount'), 0);
      // Clear the trial budget explicitly rather than letting its TTL
      // expire naturally — a leftover count from this episode must not
      // bleed into the next OPEN -> HALF_OPEN cycle and immediately
      // reject that cycle's own first trial call.
      await this.cache.del(this.key(provider, 'halfOpenTrialCount'));
      return;
    }

    await this.recordSlowCallSample(provider, latencyMs);
  }

  /** See SLOW_CALL_THRESHOLD_MS above for why this exists. */
  private async recordSlowCallSample(provider: string, latencyMs: number): Promise<void> {
    const isSlow = latencyMs > SLOW_CALL_THRESHOLD_MS;
    const recentCallKey = this.key(provider, 'recentCallCount');
    const slowCallKey = this.key(provider, 'slowCallCount');

    const [recentCallCount] = await Promise.all([
      this.cache.incr(recentCallKey),
      // Sliding window, same TTL-refresh-on-every-write pattern as
      // recordFailure()'s failureCount — see FAILURE_WINDOW_SECONDS above.
      this.cache.expire(recentCallKey, FAILURE_WINDOW_SECONDS),
      isSlow ? this.cache.incr(slowCallKey) : Promise.resolve(0),
      isSlow ? this.cache.expire(slowCallKey, FAILURE_WINDOW_SECONDS) : Promise.resolve(),
    ]);

    // Evaluated on every call once the sample size is met, not only when
    // *this* call was slow — otherwise a slow burst that happens to be
    // followed by one fast call would skip the check entirely, even if
    // the accumulated rate is already well past the threshold.
    if (recentCallCount < SLOW_CALL_MIN_CALLS) return;

    const slowCallCount = (await this.cache.get<number>(slowCallKey)) ?? 0;
    if (slowCallCount / recentCallCount >= SLOW_CALL_RATE_THRESHOLD) {
      await Promise.all([
        this.cache.set(this.key(provider, 'state'), 'OPEN'),
        this.cache.set(this.key(provider, 'lastFailureTime'), Date.now()),
      ]);
    }
  }

  async recordFailure(provider: string): Promise<void> {
    const epoch = this.currentEpochMinute();
    const failureCountKey = this.key(provider, 'failureCount');
    // Read before this failure is recorded — used below to tell "this was
    // a HALF_OPEN trial call" apart from "this is one more failure toward
    // the normal CLOSED-state threshold."
    const stateBeforeThisFailure = await this.cache.get<CircuitState>(this.key(provider, 'state'));
    const [failureCount] = await Promise.all([
      this.cache.incr(failureCountKey),
      // Refreshed on every failure, not just the first — see
      // FAILURE_WINDOW_SECONDS above. incr() and expire() aren't atomic
      // together, so a failure landing between them could keep the
      // previous call's TTL a moment longer than intended; harmless here
      // (worst case the window resets very slightly early), unlike the
      // rate limiter's fixed-window counter where re-extending on every
      // hit would change the limit's actual meaning.
      this.cache.expire(failureCountKey, FAILURE_WINDOW_SECONDS),
      this.incrBucket(this.bucketKey(provider, 'total', epoch)),
      this.cache.set(this.key(provider, 'lastFailureTime'), Date.now()),
    ]);

    // A failed HALF_OPEN trial call re-opens the circuit immediately —
    // waiting for failureCount to reach FAILURE_THRESHOLD again would let
    // a PSP that's still down absorb up to FAILURE_THRESHOLD more real
    // requests before the breaker reacts, exactly the burst HALF_OPEN's
    // single-trial-call budget (assertAvailable()) exists to prevent.
    if (stateBeforeThisFailure === 'HALF_OPEN' || failureCount >= FAILURE_THRESHOLD) {
      await this.cache.set(this.key(provider, 'state'), 'OPEN');
      // See recordSuccess()'s matching comment — a stale trial count must
      // not survive into the next recovery attempt.
      await this.cache.del(this.key(provider, 'halfOpenTrialCount'));
    }
  }

  async getMetrics(provider: string): Promise<CircuitMetrics> {
    const state = await this.computeEffectiveState(provider);

    const currentEpoch = this.currentEpochMinute();
    const commands: Array<[string, ...unknown[]]> = [];
    for (let i = 0; i < METRICS_WINDOW_MINUTES; i++) {
      const epoch = currentEpoch - i;
      commands.push(['get', this.bucketKey(provider, 'success', epoch)]);
      commands.push(['get', this.bucketKey(provider, 'total', epoch)]);
      commands.push(['get', this.bucketKey(provider, 'latencyMs', epoch)]);
    }
    const results = await this.cache.pipeline(commands);

    let successCount = 0;
    let totalRequests = 0;
    let totalLatencyMs = 0;
    for (let i = 0; i < METRICS_WINDOW_MINUTES; i++) {
      successCount += Number(results[i * 3]) || 0;
      totalRequests += Number(results[i * 3 + 1]) || 0;
      totalLatencyMs += Number(results[i * 3 + 2]) || 0;
    }

    return {
      state,
      successCount,
      totalRequests,
      avgLatencyMs: totalRequests > 0 ? totalLatencyMs / totalRequests : 0,
    };
  }

  async isAvailable(provider: string): Promise<boolean> {
    const state = await this.computeEffectiveState(provider);
    return state !== 'OPEN';
  }

  /**
   * Operator escape hatch: force a provider's circuit back to CLOSED,
   * bypassing the normal recovery flow entirely. For when the automated
   * recovery isn't behaving as expected (or an operator has independently
   * confirmed the PSP is healthy again and doesn't want to wait out the
   * trial-call dance) and there's otherwise no way to intervene short of
   * reaching into Redis directly. Clears the failure/slow-call counters
   * too, the same full reset a successful HALF_OPEN trial already
   * performs in recordSuccess() — a half-reset (state only) would leave a
   * stale failureCount that could immediately re-trip the circuit on the
   * very next failure, before FAILURE_THRESHOLD genuinely accumulated
   * again. Deliberately leaves the historical successCount/totalRequests/
   * totalLatencyMs metric buckets alone — those are reporting history,
   * not part of the OPEN/CLOSED decision, and an operator resetting a
   * stuck breaker has no reason to also erase what already happened.
   */
  async resetCircuit(provider: string): Promise<void> {
    await Promise.all([
      this.cache.set(this.key(provider, 'state'), 'CLOSED'),
      this.cache.set(this.key(provider, 'failureCount'), 0),
      this.cache.set(this.key(provider, 'recentCallCount'), 0),
      this.cache.set(this.key(provider, 'slowCallCount'), 0),
      this.cache.del(this.key(provider, 'halfOpenTrialCount')),
      this.cache.del(this.key(provider, 'lastFailureTime')),
    ]);
  }
}
