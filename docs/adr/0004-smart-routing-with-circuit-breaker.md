# ADR-0004: Smart PSP routing with a shared circuit breaker, not a static primary/fallback

## Status

Accepted

## Context

This system routes each charge to one of multiple PSPs (Stripe, Adyen).
A static "always try Stripe first, fall back to Adyen on error" rule
ignores information that's actually available at charge time and that
real acquirers care about: BIN country (a European card is better
served by Adyen for PSD2/SCA reasons), currency support, each PSP's
recent success rate and latency, and — critically — whether a PSP is
currently in a bad state at all, not just whether *this specific call*
happens to fail.

The system also runs as multiple Kubernetes replicas (`k8s/hpa.yaml`
scales to 20 pods). Per-process PSP-health state (an in-memory flag on
`StripePSPAdapter`/`AdyenPSPAdapter` saying "this PSP is currently
down") was the original design, and it has an obvious problem in that
topology: each pod would independently learn about — and independently
forget about — a PSP outage, with zero coordination between replicas.
A PSP failing enough to trip one pod's breaker wouldn't protect traffic
being served by the other nineteen.

## Decision

**Filtering, then selection** (`SmartRoutingStrategy`, pure domain
logic, no I/O): filter to PSPs that are available, whose circuit
breaker isn't `OPEN`, that support the transaction's currency and BIN
country if known. If the caller supplied a `preferredProvider` and it
survived that filter, it's selected directly — a true override, not
one more input competing on score, matching the charge DTO's own
Swagger contract ("overrides smart routing"). Only when there's no
preference, or the preferred provider didn't survive the filter, does
this fall through to scoring the remaining candidates roughly 0–100 —
circuit-breaker state dominates (40 pts `CLOSED` / 10 `HALF_OPEN`),
then success rate (0–30), latency (0–15, lower is better), fee (0–15,
lower is better), and two reference-setup-specific nudges (+10 EU card
× Adyen, +5 non-EU card × Stripe) — irrelevant whenever
`preferredProvider` already decided the outcome. Re-scored/re-decided
on every charge — no caching, no sticky routing to a merchant's "usual"
PSP.

**Addendum, 2026-08-24 — per-merchant PSP entitlement**: a filter now
runs *before* the availability/currency/country filter above —
`MerchantEntity.enabledPspProviders` restricts the candidate pool to
PSPs this specific merchant is entitled to use (defaults to every PSP
this system has an adapter for, so no existing merchant's routing
changed on migration day). Unlike the filter above, a `preferredProvider`
that fails *this* check is rejected outright (`422
PREFERRED_PROVIDER_NOT_ENTITLED`), not silently scored against the
remaining candidates — entitlement is a permission boundary an
operator configured on purpose, not a technical constraint like
currency support, so silently rerouting around it would hide a real
integration bug rather than surface it. See
[`../business-domain/ledger-and-settlement.md#smart-psp-routing`](../business-domain/ledger-and-settlement.md#smart-psp-routing)
for the full behavior.

**Fallback**: if the top-scored PSP's actual charge call fails,
`PaymentProcessorFactory.executeWithFallback` retries the
next-highest-scored *currently-available* PSP, in order, until one
succeeds or the list is exhausted — `usedFallback: true` tells the
caller this happened.

**Circuit breaker state lives in Redis**
(`RedisCircuitBreakerService`, via the same `CachePort` idempotency
already uses — no new connection), not on adapter instance fields —
five consecutive failures opens the circuit for 30 seconds, then it
moves to `HALF_OPEN`, and a single success closes it again. Because
this state is shared, not per-process, a circuit tripped by traffic
hitting one replica is visible to every other replica's next routing
decision immediately — verified live: forcing 5 failures against one
replica trips the breaker as seen by a second replica that never made
any of those calls itself. Success-rate/latency metrics feeding the
scoring above are similarly Redis-backed, bucketed into a 15-minute
sliding window (per-minute keys, summed at read time) rather than
accumulating unboundedly — see
[`../technical/distributed-state.md`](../technical/distributed-state.md)
for the bucketing design.

**A second, independent trigger opens the circuit on a slow-call rate**,
not just on thrown exceptions: a PSP call that never errors but takes
longer than 5 seconds (well under the adapters' 30-second hard abort)
counts as "slow," and once at least 5 of the most recent calls are in
that sliding window and half or more of them were slow, the circuit
opens — the same behavior Resilience4j's `SlowCallRateThreshold`
provides. Without this, a PSP that's silently hanging rather than
erroring would be invisible to the breaker until it actually started
throwing, which — at 5 required failures with no help from this signal
— could take up to 5 × 30s = 2.5 minutes to detect. This closes that
gap: a hung PSP now trips the breaker within a handful of slow calls,
not minutes.

**Verified live against real elapsed time, not just simulated timers**
(`test/latency-based-circuit-breaker.e2e-spec.ts`, 2026-08-23):
`mock-psp` was given a `forceslow` marker that delays 6 real seconds
before responding successfully (`scripts/mock-psp/server.js`), so this
test exercises the adapter's actual `fetch()` and the actual elapsed-time
measurement feeding `recordSuccess()` — not `jest.useFakeTimers()` (used
for the unit tests in `redis-circuit-breaker.service.spec.ts`) and not a
socket-destroy trick (used for the ambiguous-outcome timeout tests,
where no response at all is the point). 5 sequential slow-but-successful
STRIPE charges (~6s each, real wall-clock time) opened the circuit —
confirmed both via `GET /payments/routing/health` reporting
`STRIPE.circuitBreaker: "OPEN"`, and observably: a 6th charge that still
requested `preferredProvider: "STRIPE"` routed to `ADYEN` instead,
proving `filterAvailableProviders()` actually excluded STRIPE rather
than just recording a flag nothing reads. Full test run: 35.4s.

## Consequences

**What this buys**: a PSP outage degrades gracefully and consistently
across every replica at once, instead of each pod independently
rediscovering the same outage against production traffic. Routing
decisions use information a static rule can't (live success
rate/latency, not just "did this one call fail"), and the scoring
weights are legible and independently adjustable — the table in
[`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md#smart-psp-routing)
*is* effectively the routing policy, not buried in conditional logic.

**What this costs**: an extra Redis round-trip on the routing hot path
for every charge (reading circuit-breaker state and the 15-minute
metrics window), and a new class of failure mode — if Redis is
unavailable, routing has no shared state to read at all. This system's
posture, consistent with idempotency locking's own Redis dependency, is
that Redis is a required piece of infrastructure for the payment path,
not an optional cache; a deployment that can't guarantee Redis
availability would need to re-evaluate this, not just the routing
piece of it.

**The EU-card/Adyen and non-EU-card/Stripe scoring nudges are
reference-setup-specific, not a general routing law.** They're a
plausible illustration of PSD2/regional-fee dynamics for this
project's two PSPs, not a calibrated result of real fee/approval-rate
data. A real deployment adding a third PSP or operating in different
regions would need to revisit these constants, not assume they
generalize.

**Fallback changes who's liable for a slower response, not just who
processes the charge.** A caller that gets `usedFallback: true` waited
through one full failed attempt against the first PSP before the
second one ever ran — there's no parallel/hedged-request version of
this. For a payments system, retrying sequentially so the failed
attempt is fully resolved (and doesn't risk a duplicate charge landing
at two PSPs at once) was judged worth the added latency over hedging.

## Alternatives considered

- **Static primary/fallback** (always Stripe, retry Adyen only on
  error): simplest to reason about, but ignores BIN-country/latency/
  success-rate signal entirely and treats every failure identically
  regardless of whether the PSP is having a bad five minutes or a bad
  five milliseconds — the exact gap smart routing was built to close.
- **Per-process circuit-breaker state** (the original design): rejected
  after the replica-coordination problem above was identified — see
  [`../technical/distributed-state.md`](../technical/distributed-state.md)
  for the full "note on shared state" reasoning that also applies to
  rate-limit counters (`RedisThrottlerStorage`), which hit the same
  category of bug independently.
- **A dedicated external routing/orchestration service** (e.g. a
  separate microservice making routing decisions over gRPC): would
  decouple routing policy from the payment module's deploy cycle, at
  the cost of a network hop on the charge hot path and a second
  service to operate, version, and keep available. Not justified at
  this codebase's current scope — `SmartRoutingStrategy` staying
  in-process, pure domain logic keeps it trivially unit-testable and
  avoids that operational surface; revisit if routing policy ever
  needs to be shared across multiple independent services rather than
  just this one payment module.
