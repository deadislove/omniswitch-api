# Merchant PSP-exposure throttling

A third, narrower signal layered on top of the circuit breaker
(`docs/technical/distributed-state.md#circuit-breaker`): instead of
deciding whether a PSP is routable at all, this decides whether *one
merchant's* next charge attempt should get a stricter rate limit,
based on where that merchant's own recent traffic has actually been
landing.

## Why a separate mechanism, not just the circuit breaker

The circuit breaker's `OPEN`/`HALF_OPEN`/`CLOSED` state is shared
platform-wide — correct for deciding whether a given PSP is eligible
to receive a charge at all. It says nothing about which merchants are
actually affected by a PSP being degraded right now. A merchant whose
traffic has been landing on a healthy PSP (including by automatic
fallback) has no reason to be throttled just because some *other* PSP
is struggling, and a platform-wide slowdown would do exactly that:
punish everyone for one provider's problem instead of targeting the
merchants actually exposed to it.

`MerchantPspExposureService`
(`src/modules/payment/adapters/circuit-breaker/`) tracks, per merchant,
which PSP their recent successful charges actually resolved to.
`DegradedPspAwareThrottlerGuard` reads that history to decide whether
*this specific merchant's* next charge attempt should be throttled
harder — a decision the circuit breaker's platform-wide state can't
make on its own, since it doesn't know which merchants are actually
concentrated on the degraded provider versus routed elsewhere by
fallback.

## The three constants, and why those values

Built on the same TTL-refresh-on-write Redis pattern
`RedisCircuitBreakerService` already uses for its own counters — a new
tracking mechanism, not a new storage pattern:

- **`ROUTING_HISTORY_WINDOW_SECONDS = 60`** — matches
  `CHARGE_RATE_LIMIT_TTL`'s own 60-second default (`CHARGE_RATE_LIMIT_TTL`,
  default `60000`ms, in `payment.controller.ts`), so the exposure
  window and the rate-limit window it feeds stay aligned.
- **`ROUTING_HISTORY_MIN_SAMPLES = 3`** — below this many recent
  charges, "concentration" isn't a reliable signal: one charge landing
  on a degraded PSP is 100% concentrated but tells you nothing about
  this merchant's actual traffic pattern.
- **`DEGRADED_CONCENTRATION_THRESHOLD = 0.5`** — matches
  `RedisCircuitBreakerService`'s own `SLOW_CALL_RATE_THRESHOLD`: more
  than half of recent charges landing on a currently-degraded PSP is
  treated as real exposure rather than noise.

## The concentration calculation

`isExposedToDegradedPsp(merchantId, providers)` sums this merchant's
recent per-provider charge counts across the tracked window. If the
total is below `ROUTING_HISTORY_MIN_SAMPLES`, it returns `false`
outright — not enough signal either way. Otherwise, for each provider
with a nonzero count, it checks that provider's current circuit-breaker
state (`RedisCircuitBreakerService.getMetrics()`); counts for providers
in `OPEN` or `HALF_OPEN` are summed as "degraded," and the merchant is
flagged as exposed once `degradedCount / total >= DEGRADED_CONCENTRATION_THRESHOLD`.
A merchant whose charges all landed on a `CLOSED`-state PSP is never
flagged, regardless of what any other PSP is doing.

## The actual throttling consequence

`DegradedPspAwareThrottlerGuard` extends `MerchantThrottlerGuard` and
only applies this check to the `charge` handler specifically — every
other route it also guards (read, refund, capture, cancel,
subscriptions, plans, delegations) doesn't newly attempt to reach a
PSP the way a charge does, so their normal fixed limit is left alone.
When a merchant is flagged exposed, their limit for that request drops
from `CHARGE_RATE_LIMIT_MAX` (env-configurable, default **100/min**) to
`DEGRADED_MERCHANT_CHARGE_RATE_LIMIT_MAX` (env-configurable, default
**20/min**) — deliberately well under normal-conditions throughput,
since the point is to slow this specific merchant's hammering of a
struggling PSP, not to match what they'd normally be allowed.

## Relationship to the circuit breaker, restated

Two independent decisions reusing the same underlying PSP-health
signal: the circuit breaker decides whether a PSP is eligible for
routing at all; this decides rate-limit strictness for whichever
merchants are actually exposed to a PSP it just excluded from (or kept
in) the routing pool. Neither one substitutes for the other.
