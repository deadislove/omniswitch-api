# Testing

Everything about how this project verifies itself against *real*
infrastructure — a real docker-compose stack, real containers killed
mid-traffic, real Stripe/Adyen sandbox APIs — as opposed to the unit
suite (`src/**/*.spec.ts`, mocked dependencies) or the e2e suite's
day-to-day use (`test/*.e2e-spec.ts`, covered in
[`../architecture.md`](../architecture.md#testing) and
[`../ci-cd.md`](../ci-cd.md)). Start here if you're trying to answer
"how do we know this actually works," not "how do I write a test."

- [`load-testing.md`](./load-testing.md) — real throughput/latency
  baseline against the actual Docker image (Postgres/Redis/mock-psp,
  Artillery as the load generator), and what it took to get a
  meaningful number out of this specific system
- [`chaos-testing.md`](./chaos-testing.md) — real containers stopped
  mid-traffic (PSP, Redis, Postgres primary) to check whether the
  documented resilience mechanisms actually hold up
- [`contract-testing.md`](./contract-testing.md) — verifies the
  Stripe/Adyen adapters against the real sandbox APIs, not
  `mock-psp`, to catch drift a hand-maintained mock can't
- [`threshold-calibration.md`](./threshold-calibration.md) — the
  methodology (and a real run against seeded synthetic data) behind
  `RiskTieringService`'s and `DisputeService`'s threshold values,
  since no real fraud/chargeback history exists yet
- [`infra-verification-status.md`](./infra-verification-status.md) —
  what's actually verified to work in the local docker-compose stack
  versus what's merely assumed, and how to verify each yourself
