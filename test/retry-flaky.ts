/**
 * One retry for the e2e suite's known, environment-dependent flakiness
 * class — real host CPU contention on a shared dev machine (not a CI
 * runner) causing rare, unreproducible-on-demand failures: an early
 * request racing the HTTP router right after boot (mitigated separately
 * in test/utils/test-app.ts's readiness ping), a raw
 * "Parse Error: Expected HTTP/, RTSP/ or ICE/" connection-level glitch
 * under heavy concurrent load, and a real-wall-clock timing test
 * (latency-based-circuit-breaker.e2e-spec.ts) whose own docblock already
 * accepts it's sensitive to system load by design. All three are tracked
 * pre-existing issues (docs/technical/ci-cd.md's "Parallelizing e2e
 * workers" section; a gitignored watchlist note dated 2026-08-24/26) that
 * neither that investigation nor this one could pin to one deterministic
 * root cause after direct, repeated reproduction attempts.
 *
 * One retry, not more: this masks exactly one transient hiccup per test
 * without hiding a test that's actually broken twice in a row.
 * logErrorsBeforeRetry keeps the original failure visible in output even
 * when the retry passes, so a genuine regression that happens to pass on
 * retry once still leaves a trace instead of disappearing silently.
 */
jest.retryTimes(1, { logErrorsBeforeRetry: true });
