# ADR-0001: Hexagonal architecture (ports & adapters) for the payment module

## Status

Accepted

## Context

`modules/payment` owns everything that moves money — charges, refunds,
disputes, reconciliation, reserves, subscriptions, marketplace payouts.
It has to talk to two categories of things it doesn't control: PSPs
(Stripe, Adyen, and whatever gets added next) and infrastructure
(Postgres via TypeORM, Redis for idempotency/circuit-breaker state, a
mock bank rail). Both categories change for reasons that have nothing
to do with payment business rules — a PSP renames a field in their SDK,
or the persistence layer moves from TypeORM to something else — and
neither should be able to force a change to how a charge is priced,
routed, or booked.

The domain logic itself also needs to be testable without spinning up
Postgres, Redis, or a mocked Stripe SDK for every unit test — `npm
test` runs entirely against `src/**/*.spec.ts` with no real
infrastructure, while `npm run test:e2e` is the deliberately separate
suite that exercises real Postgres/Redis/`mock-psp` (see
[`../technical/architecture.md`](../technical/architecture.md#testing)).
That split only works if domain logic has zero infrastructure imports
to begin with.

## Decision

`domain/` depends on nothing outside itself — no TypeORM decorators, no
PSP SDK types, no NestJS decorators. It defines the business rules:
`PaymentAggregate`, `LedgerOutboxEvent`, `Money`/`Currency`/`BinInfo`
value objects, `SmartRoutingStrategy`.

`ports/outbound/` declares abstract classes — `PaymentRepositoryPort`,
`PSPAdapterPort`, `LedgerOutboxPort`, `CachePort`, `FXRateProviderPort`,
`BankTransferPort`, and one port per other aggregate (`DisputePort`,
`ReserveHoldPort`, `SubscriptionPort`, `PlanPort`, `PayoutPort`,
`DelegationPort`) — the contracts `application/` depends on. A port
never imports or names a concrete adapter.

`adapters/` implements those ports against real infrastructure:
`persistence/` (TypeORM entities, mappers, repositories),
`psp/stripe`/`psp/adyen` (`StripePSPAdapter`, `AdyenPSPAdapter`),
`cache/` (Redis via ioredis), `circuit-breaker/`
(`RedisCircuitBreakerService`), `fx/`, `bank/`. Wiring from port to
adapter (`{ provide: PaymentRepositoryPort, useClass:
PaymentTypeOrmRepository }`) happens exactly once, in
`payment.module.ts` — nothing above the ports layer ever names a
concrete adapter class.

`application/` (`controllers/`, `sagas/`, `services/`, `interceptors/`)
orchestrates: it depends on ports, never on adapters directly.

Dependency direction only ever points inward, toward `domain/` — see
the layering diagram in
[`../technical/architecture.md`](../technical/architecture.md#inside-paymentmodule-the-hexagonal-layering).
That diagram *is* the enforcement mechanism: there's no separate lint
rule forbidding `domain/` from importing TypeORM, the layering itself
makes it structurally awkward to do by accident, and any PR that does
it is a visible layering violation in the diff, not a runtime check
that catches it later.

## Consequences

**What this buys**: `PaymentProcessorFactory` can add a third PSP
adapter without touching `PaymentCheckoutSaga` or any domain logic.
`SmartRoutingStrategy` (pure domain logic, no I/O) is unit-testable
with plain objects and no mocking framework. Swapping TypeORM for a
different ORM would only touch `adapters/persistence/` — every port
signature and everything above it stays the same.

**What this costs**: an extra layer of indirection for anything that
touches persistence or an external call — a new field on a payment
often means touching the aggregate, the port interface, the TypeORM
entity, and the mapper between them, not just one file. For a
reference implementation with a handful of aggregates this is a
deliberate, worthwhile trade; it would need re-evaluating if the
number of aggregates grew by an order of magnitude and the
boilerplate-per-change started to dominate.

**A concrete case this shape prevented, not just a theoretical one**:
`ChargeLedgerParamsResolverService.resolve()` — which computes
fee/FX/reserve/split parameters for a charge — is shared by all three
ledger-booking call sites (`PaymentCheckoutSaga`, immediate capture;
`PaymentLifecycleService.capture()`, manual capture;
`WebhookProcessingService.markSucceeded()`, async/3DS-confirmed) *because*
it sits in `application/services/` depending only on ports, not on
which adapter happens to be booking at that moment. Before it was
extracted, an identical fee-lookup snippet was copy-pasted into all
three sites and drifted (see
[`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md#fee-model))
— the layering made "extract to `application/`, depend on the port"
the obvious fix rather than "extract to wherever's convenient."

## Alternatives considered

- **Transaction-script / fat-service style** (services call TypeORM
  repositories directly, no ports layer): less boilerplate for a small
  number of aggregates, but couples business rules to persistence
  details from day one — the specific bug pattern above (three
  divergent copies of the same fee logic) is *more* likely under this
  shape, not less, since nothing structurally encourages extracting
  shared logic to a dependency-free layer.
- **A generic ORM-agnostic repository interface without the full
  ports/adapters split** (i.e., abstract persistence only, let
  `application/` call PSP SDKs directly): would still leave PSP
  vendor types leaking into orchestration code, defeating the point
  for the PSP side specifically — `PaymentProcessorFactory`'s
  Stripe/Adyen fallback logic depends on both adapters conforming to
  the exact same `PSPAdapterPort` shape.
