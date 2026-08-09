# API Reference

This is the written reference for every HTTP endpoint this system
exposes. It's grounded directly in the controller source — if something
here and the code ever disagree, the code is right and this doc is
stale; please fix it. For **interactive** exploration (try a request,
see live schemas), run the app and open `/api/docs` (Swagger UI) —
this written version exists because a new engineer often wants to read
the whole surface linearly before poking at it interactively, and
because it can explain *why* an endpoint behaves a certain way in a way
generated Swagger descriptions can't always carry.

Read [`business-domain-guide.md`](../business-domain-guide.md) first if
you haven't — every endpoint here assumes you already know what a
`Payment`, `Subscription`, or `Delegation` is.

## Base URL and versioning

Every endpoint below is served under `/api/v1` (e.g.
`POST /api/v1/payments/charge`) — Nest's URI versioning generates that
prefix, nothing hardcodes it. **Two exceptions**, deliberately
unversioned and unprefixed, because they're external contracts owned by
infrastructure (Kubernetes probes, Prometheus), not this API's own
surface: `GET /health`, `GET /health/live`, `GET /health/ready`, and
`GET /metrics`.

## Authentication

Almost everything requires a JWT bearer token:

```
Authorization: Bearer <token>
```

Obtain one via `POST /api/v1/auth/token` (API Key ID + Secret →
JWT, 1 hour lifetime) — see [`merchants-and-auth.md`](./merchants-and-auth.md).
Two kinds of principal can hold a token:

- **A merchant's own credential** — full access to everything that
  merchant's `roles` permit (see below).
- **An agent's delegation credential** (`POST /api/v1/delegations`) — a
  JWT scoped to exactly one role, `AGENT`, accepted on exactly one
  route, `POST /api/v1/payments/charge`. Every other endpoint rejects it
  with 403. See [`agentic-payments.md`](./agentic-payments.md).

A few endpoints are genuinely public (`@Public()`): `POST /auth/token`
itself (you don't have a token yet), the health/metrics endpoints, and
the webhook receivers (`POST /webhooks/stripe`/`adyen` — the PSP isn't
one of our merchants; those are authenticated by signature instead, not
JWT).

## Roles

| Role | Typical use |
|---|---|
| `MERCHANT` | A merchant's own integration — can act on its own resources only |
| `ADMIN` | Platform operator — full access, including merchant onboarding/policy |
| `OPERATOR` | Platform operator with access to admin *operations* (disputes, reserves, reconciliation, outbox recovery) but not merchant onboarding/credential management |
| `READONLY` | Read-only access to payments/subscriptions/plans |
| `AGENT` | An autonomous agent's delegation credential — see above |

Every endpoint below lists which role(s) it accepts. A `MERCHANT` caller
is always implicitly scoped to their own resources regardless of any
`merchantId` supplied elsewhere — asking for another merchant's resource
returns 403, not the resource. `ADMIN`/`OPERATOR`/`READONLY` can act
across merchants.

## HMAC request signing

Endpoints that move money or change committed state require three
additional headers, on top of the JWT:

```
X-Signature: <hex HMAC-SHA256>
X-Timestamp: <unix timestamp, seconds>
X-Merchant-Id: <merchant's business-facing id>
```

The signature is computed over `{timestamp}.{method}.{path}.{rawBody}`
using the merchant's own HMAC secret (rotatable via
`POST /admin/merchants/:id/rotate-hmac-secret`). A request whose
timestamp drifts more than 5 minutes, or whose signature doesn't match,
is rejected with 401. **An `AGENT`-authenticated request is exempt from
this entirely** — an agent never holds the merchant's own HMAC secret;
the delegation JWT's own possession is its authenticity proof instead.
See [`system-design.md`](../system-design.md#5-cross-cutting-infrastructure-concerns)
for why.

Each endpoint below notes whether it requires HMAC signing.

## Idempotency

Every endpoint that requires HMAC signing also requires:

```
Idempotency-Key: <client-generated UUID v4>
```

A retried request with the same key replays the original result rather
than executing twice (Redis-backed lock, `IdempotencyInterceptor`).
Generate a fresh UUID per *logical* operation, not per HTTP attempt — if
you retry after a timeout, reuse the same key.

## Error format

Every non-2xx response is JSON shaped like:

```json
{
  "statusCode": 422,
  "error": "Charge of $50.00 USD exceeds this delegation's per-transaction limit of $30.00 USD",
  "code": "DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED"
}
```

`code` is a stable, machine-readable identifier — safe to branch on in
client code. `error` is a human-readable message and may change wording
over time; don't parse it. Validation errors (`class-validator` failures
on a request body) come back as 422 with a `message` array instead of a
single `error` string.

## Rate limiting

Two independent limits apply to every request: a global, IP-keyed limit
(catches unauthenticated abuse) and a per-merchant limit keyed by
`req.user.merchantId` (stops one compromised/misbehaving credential from
being amplified across source IPs) — both Redis-backed, shared across
every replica. A `POST /auth/token` login attempt has its own, stricter
limit (credential-guessing target). Exceeding either returns 429.

## Domain area index

| Doc | Covers |
|---|---|
| [`payments.md`](./payments.md) | Charging, refunds, captures, cancellation, real-time status, bulk upload |
| [`subscriptions-and-plans.md`](./subscriptions-and-plans.md) | Recurring billing, plan catalog, proration |
| [`marketplace.md`](./marketplace.md) | Splits (via the charge endpoint's `splits`), connected-account payouts, KYC |
| [`disputes.md`](./disputes.md) | Chargeback lifecycle, representment |
| [`risk-and-reserves.md`](./risk-and-reserves.md) | Reserve holds, automatic risk tiering |
| [`agentic-payments.md`](./agentic-payments.md) | Delegations and spend policy for autonomous agents |
| [`merchants-and-auth.md`](./merchants-and-auth.md) | Login, MFA, merchant onboarding and policy configuration |
| [`webhooks.md`](./webhooks.md) | Inbound PSP callbacks (Stripe, Adyen) |
| [`platform-ops.md`](./platform-ops.md) | Outbox recovery, reconciliation, health, metrics |
