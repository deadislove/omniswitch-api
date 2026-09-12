# Service Boundaries: Evaluating a Ledger / Routing / Risk Split

**Status: evaluation only — no code changed.** This documents *where*
today's modular monolith could split into independently-deployed
services, what each would own, and why it isn't recommended yet — not a
plan being executed. The point of doing this now, before it's forced by
scale, is that the boundaries below are cheap to keep clean inside one
codebase and expensive to retrofit once several services depend on each
other over a network.

## Why now, and why not further

`docs/technical/architecture.md` already documents Hexagonal boundaries
enforced by DI wiring (`payment.module.ts` is the only file that knows
concrete adapter classes; `domain/` imports nothing from `adapters/`).
That's a *logical* boundary — real, but still one process, one Postgres
database, one deploy. This document is about the next step up:
*physical* separation into services with their own deploys, their own
data, and a real network between them. Nothing here is urgent — see
"Recommendation" — but the boundaries are worth naming precisely while
the system is still small enough that getting them right costs a
docblock, not a migration.

## The central coupling fact

`PaymentCheckoutSaga` — the orchestrator every `POST /payments/charge`
call runs through — directly depends on `PaymentRepositoryPort`,
`LedgerOutboxPort`, `AcquirerRoutingService`,
`ChargeLedgerParamsResolverService`, `ReserveService`,
`AmbiguousRiskMonitoringService`, and `AmlReviewMonitoringService` in a
single constructor (plus `DataSource` and `EventEmitter2`, its
transaction/event-emission plumbing rather than another boundary's
service). The domain-service list is one or two things each from the
three candidate boundaries below —
Ledger, Routing, and Risk are already synchronously entangled in the hot
path of every charge, inside one in-process saga, inside one Postgres
transaction. Any split has to answer what happens to that saga: either
it becomes a distributed saga across services (network calls per step,
real partial-failure/compensation handling, no more "it's all one
transaction" safety net), or the boundary has to move to not cut through
it.

The `payments` table itself has the same shape at the schema level:
`risk_score` (Risk), `psp_provider`/`psp_transaction_id`/`three_ds_result`
(Routing), and the row's own existence/status (Ledger's source of truth
for "did this charge happen") all live in one table today. `ledger_outbox`
is already a separate table, consumed asynchronously by
`LedgerOutboxRelayService` — the one piece of today's schema that
already looks like a service boundary, not a monolith table.

## What each boundary would own

### Ledger

**Owns**: the payment record's existence and lifecycle status, ledger
entries (`ledger_outbox` → eventual double-entry booking), reconciliation
(`ReconciliationService`, `PspCostReconciliationService`), reserves
(`ReserveService`), payouts (`PayoutService`), fee resolution
(`ChargeLedgerParamsResolverService`). This is the money-truth boundary —
whatever it says happened is what happened, financially.

**Already closest to separable**: the outbox pattern
(`LedgerOutboxRelayService`) is *already* an async consumer of a
Postgres table, not a synchronous in-process call — the same shape a
real service boundary would take (a queue/table another service polls),
just not yet a different process. Reconciliation and payouts are also
already scheduled sweeps (`@Cron`), not synchronous request-path code.

### Routing

**Owns**: PSP selection (`SmartRoutingStrategy`, `AcquirerRoutingService`),
the PSP adapters themselves (`StripePSPAdapter`/`AdyenPSPAdapter`), the
circuit breaker (`RedisCircuitBreakerService`), the fee-schedule estimate
now that it's configurable (`PspFeeScheduleService`), webhook ingestion
(`WebhookProcessingService` — a PSP calling back in is routing's
concern, symmetric with routing calling a PSP out).

**Hardest to separate**: this is the one boundary that's *synchronously*
in the hot path by nature — a charge cannot complete without a real PSP
round-trip, so extracting Routing into its own service means every
charge crosses a real network hop to get there, not an optional one. The
circuit breaker and bulkhead already exist because a *PSP* being slow
shouldn't take down the whole app; a Routing *service* being slow would
be a second, new failure mode on top of that, not a replacement for it.

### Risk

**Owns**: risk tiering (`RiskTieringService`), dispute policy
(`DisputeService`, `dispute-policy.ts`), ambiguous-payment
monitoring/resolution (`AmbiguousPaymentService`,
`AmbiguousRiskMonitoringService`), AML-review monitoring
(`AmlReviewMonitoringService`), legal holds (`LegalHoldService`).

**Easiest to separate**: `RiskTieringService`'s own sweep already reads
*settled* charge history after the fact (a daily `@Cron`, plus an
on-demand admin trigger) — it doesn't need to be in the synchronous
charge path at all today. `AmbiguousRiskMonitoringService` is invoked
from the saga, but only to *flag* a risk condition, not to gate whether
the charge proceeds — that call could become async (an emitted event
Risk consumes later) with the least behavioral change of anything listed
here.

### A fourth boundary this list doesn't name: Billing

`SubscriptionService`/`PlanService`/`DelegationService` don't map cleanly
onto Ledger/Routing/Risk — recurring billing, plan catalog management,
and agentic-payment delegation are their own concern, closer to "a
scheduled decision about *when* to initiate a charge" than to how a
charge is processed once initiated. Worth naming now so a future service
split doesn't try to force-fit it into one of the three above.

## What real separation would require

Beyond moving files: each service needs its own datastore (or at minimum
its own schema — sharing one Postgres instance is a reasonable first
step, sharing one *schema* across service boundaries isn't, since it
lets one service's migration silently break another's queries). The
in-process DI calls above become either synchronous network calls
(gRPC/REST — Routing's PSP round-trip, which is already synchronous by
nature, is the one call in this list where that's not a new cost) or
async events (Risk's flagging call, Ledger's outbox consumption — both
already look async internally, so this is closer to "point the existing
async mechanism at a network boundary" than a redesign). The
Saga's compensating-transaction logic (`PaymentCheckoutSaga`'s own
rollback path) would need to become a real distributed saga — the
hardest single piece of this, since today's version gets "all financial
side effects land or none do" for free from one Postgres transaction,
and a distributed version has to earn that property back explicitly.

## Recommendation

**Not now.** This is a POC/reference-scale system — nothing about
today's traffic justifies the operational cost of running, deploying,
and monitoring three-plus services instead of one, and the
`PaymentCheckoutSaga` coupling fact above means the *hardest* part of a
real split (turning one Postgres transaction into a distributed saga)
would be pure cost with no throughput/scaling benefit at this scale. The
useful thing to do today is keep the module-internal organization
already mostly aligned with these boundaries (`application/services/`
file naming already reads this way) so that *if* real scale ever
justifies extraction, the seams are exactly where this document says
they are — Risk first (already the most asynchronous), Ledger second
(already outbox-shaped), Routing last (inherently synchronous, no way
around a real network hop once separated).
