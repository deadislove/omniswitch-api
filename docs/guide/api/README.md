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
is rejected with 401. **An `AGENT`-authenticated request still signs,
just not with the merchant's secret** — an agent never holds that
secret, so it signs with its own delegation-issued `agentSigningKey`
instead (returned once at `POST /delegations` time — see
[`agentic-payments.md`](./agentic-payments.md)); it also omits
`X-Merchant-Id`, since the delegation JWT's `delegationId` claim
already identifies which signing key to verify against.
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

## Endpoints

Every real route this system exposes — 98 in total, grouped by domain
area. This table is generated by reading the controllers directly (every
`@Get`/`@Post`/`@Patch`/`@Delete`/`@Sse` decorator), not maintained by
hand separately — if it and the code ever disagree, the code is right.
Each section links to the doc with the full request/response schemas,
error codes, and the reasoning behind that area's endpoint design — this
table is the index, not the full reference.

**Auth key**: `Public` = no token; `JWT` = any authenticated role; a
role list means only those roles; `+HMAC` means the three
`X-Signature`/`X-Timestamp`/`X-Merchant-Id` headers are also required
(an `AGENT` token signs with its delegation's own signing key instead,
and omits `X-Merchant-Id` — see
["HMAC request signing"](#hmac-request-signing)).

### Auth ([`merchants-and-auth.md`](./merchants-and-auth.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/auth/token` | Exchange an API Key ID + Secret for a JWT (or a short-lived pending token if MFA is enabled) | Public |
| `POST` | `/api/v1/auth/revoke` | Revoke the current token (logout) — takes effect immediately | JWT |
| `POST` | `/api/v1/auth/mfa/enroll` | Start MFA enrollment (generates a TOTP secret, not yet enforced) | JWT |
| `POST` | `/api/v1/auth/mfa/confirm` | Confirm enrollment with a TOTP code — enables MFA, returns one-time backup codes | JWT |
| `POST` | `/api/v1/auth/mfa/verify` | Trade a pending MFA token for a full one | JWT (mfaPending) |
| `POST` | `/api/v1/auth/mfa/disable` | Disable MFA — requires a valid TOTP/backup code | JWT |

### Merchants (admin) ([`merchants-and-auth.md`](./merchants-and-auth.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/merchants` | List merchants (no secrets) | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants` | Onboard a new merchant — returns the API key secret once | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/rotate-api-key` | Rotate a merchant's API key secret | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/rotate-hmac-secret` | Rotate a merchant's HMAC signing key | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/status` | Activate/deactivate a merchant (deactivating revokes all sessions) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/fee-rate` | Change a merchant's platform fee rate (bps) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/fee-tiers` | Set/clear a merchant's volume-based fee schedule | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/settlement-currency` | Change a merchant's settlement currency | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/mcc-code` | Set a merchant's Merchant Category Code (drives industryRiskCategory) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/reserve-policy` | Change a merchant's reserve rate/hold period (disables auto risk-tiering) | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/payout-reserve-policy` | Change a connected merchant's marketplace payout rolling-reserve policy | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/risk-tier-auto` | Enable/disable automatic risk-tier reserve management | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/psp-entitlement` | Set which PSPs this merchant's charges may route through | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/kyc/submit` | Submit/re-submit a connected merchant's KYC application | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/kyb/submit` | Submit/re-submit a connected merchant's KYB (business) application — independent of kycStatus, not wired into any payout gate | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/dispute-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's dispute notifications go out on | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/subscription-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's subscription.past_due/subscription.canceled notifications go out on | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/aml-review-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's aml_review.flagged notification goes out on | JWT (ADMIN) |
| `POST` | `/api/v1/admin/merchants/:id/sanctions/rescreen` | Re-screen a merchant's sanctions/watchlist status on demand | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/sanctions-review` | Record a human determination (CLEARED/CONFIRMED) on a sanctions POTENTIAL_MATCH/HIT | JWT (ADMIN) |
| `PATCH` | `/api/v1/admin/merchants/:id/sanctions-notification-channel` | Change which channel (EMAIL/SLACK/WEBHOOK) a merchant's sanctions-screening notifications go out on | JWT (ADMIN) |
| `POST` | `/api/v1/admin/sanctions/run` | Run the sanctions/watchlist re-screening sweep now instead of waiting for the weekly schedule | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/merchants/:id/revoke-sessions` | Invalidate every token currently issued to this merchant | JWT (ADMIN) |

### Payments ([`payments.md`](./payments.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/payments/charge` | Charge a payment with smart PSP routing — also usable by an AGENT token, checked against its delegation's spend policy | JWT/AGENT + HMAC (AGENT signs with its delegation's own signing key) |
| `GET` | `/api/v1/payments/:id` | Get payment details by id | JWT |
| `GET` | `/api/v1/payments/:id/status/stream` | SSE stream for real-time payment status updates | JWT |
| `POST` | `/api/v1/payments/:id/refund` | Refund a payment (full or partial) | JWT + HMAC |
| `POST` | `/api/v1/payments/:id/capture` | Capture a previously authorized (`REQUIRES_CAPTURE`) payment | JWT + HMAC |
| `POST` | `/api/v1/payments/:id/cancel` | Cancel a payment before capture | JWT + HMAC |
| `POST` | `/api/v1/payments/bulk-upload` | Bulk invoice upload (CSV, `multipart/form-data`) for batch processing | JWT |
| `GET` | `/api/v1/payments/routing/health` | PSP routing/circuit-breaker health status | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/payments/routing/circuit-breaker/:provider/reset` | Force a PSP's circuit breaker back to CLOSED | JWT (ADMIN/OPERATOR) |

### Ambiguous payments (risk & recovery) ([`risk-and-reserves.md`](./risk-and-reserves.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/payments/ambiguous` | List `AMBIGUOUS` payments (a PSP call that got no response at all) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/ambiguous/run-auto-resolution` | Trigger the automated PSP-query resolution sweep on demand | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/:id/resolve-ambiguous` | Manually resolve an `AMBIGUOUS` payment after checking the PSP directly | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/payments/:id/legal-hold` | Place a legal hold — excludes a payment from archiving/deletion | JWT (ADMIN/OPERATOR) |
| `DELETE` | `/api/v1/admin/payments/:id/legal-hold` | Release a legal hold | JWT (ADMIN/OPERATOR) |

### Subscriptions & Plans ([`subscriptions-and-plans.md`](./subscriptions-and-plans.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/subscriptions` | Create a subscription (from a `Plan` or a direct amount/interval) — charges the first period immediately unless `trialDays` is set | JWT + HMAC |
| `GET` | `/api/v1/subscriptions/:id` | Get a subscription by id | JWT |
| `GET` | `/api/v1/subscriptions` | List subscriptions (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/subscriptions/:id/cancel` | Cancel a subscription — immediately, or at period end | JWT + HMAC |
| `POST` | `/api/v1/subscriptions/:id/change-plan` | Switch to a different plan — prorates the difference immediately (upgrade) or issues a credit (downgrade) | JWT + HMAC |
| `POST` | `/api/v1/admin/subscriptions/run-billing` | Run the billing sweep now instead of waiting for the daily schedule | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/plans` | Create a reusable subscription plan | JWT |
| `GET` | `/api/v1/plans/:id` | Get a plan by id | JWT |
| `GET` | `/api/v1/plans` | List plans (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/plans/:id/deactivate` | Deactivate a plan — existing subscribers are unaffected | JWT |

### Agentic Payments ([`agentic-payments.md`](./agentic-payments.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/delegations` | Authorize a new agent within a spend policy — returns the agent's JWT once | JWT (MERCHANT/ADMIN) |
| `GET` | `/api/v1/delegations/:id` | Get a delegation by id | JWT |
| `GET` | `/api/v1/delegations` | List delegations (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/delegations/:id/revoke` | Revoke a delegation — the agent's JWT is rejected on its very next request | JWT (MERCHANT/ADMIN) |
| `GET` | `/api/v1/charge-approvals/:id` | Get a charge approval by id (a charge held pending human approval — `requireApprovalAboveAmount`) | JWT |
| `GET` | `/api/v1/charge-approvals` | List charge approvals (a MERCHANT sees only their own) | JWT |
| `POST` | `/api/v1/charge-approvals/:id/approve` | Approve a pending charge approval — executes the deferred charge in the same request | JWT (MERCHANT/ADMIN) |
| `POST` | `/api/v1/charge-approvals/:id/deny` | Deny a pending charge approval — releases the reserved spend, the PSP is never called | JWT (MERCHANT/ADMIN) |

### Disputes ([`disputes.md`](./disputes.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/disputes` | List disputes, filterable by merchant/status | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/disputes/:id` | Get a single dispute by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/disputes/:id/evidence` | Submit evidence to contest a dispute (representment) — calls the PSP | JWT (ADMIN/OPERATOR) |

### Risk & Reserves ([`risk-and-reserves.md`](./risk-and-reserves.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/reserves` | List reserve holds, filterable by merchant/status | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/reserves/:id` | Get a single reserve hold by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reserves/:id/release` | Manually release a hold, bypassing `releaseEligibleAt` | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reserves/release-eligible` | Run the reserve-release sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/risk-tiering/run` | Run the risk-tiering sweep now instead of waiting for the daily schedule | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/ambiguous-risk` | Manually flag/clear a merchant's ambiguous-risk status (reason required, audited) | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/ambiguous-risk-auto` | Re-enable automatic ambiguous-risk flag/auto-clear for a merchant | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/merchants/ambiguous-risk/run-auto-clear` | Run the ambiguous-risk auto-clear sweep now | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/aml-review` | Manually flag/clear a HIGH-industry merchant's AML-review status (reason required, audited) | JWT (ADMIN/OPERATOR) |
| `PATCH` | `/api/v1/admin/merchants/:id/aml-review-auto` | Re-enable automatic AML-review flagging for a merchant | JWT (ADMIN/OPERATOR) |

### Marketplace & Payouts ([`marketplace.md`](./marketplace.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/marketplace/payouts` | List payouts, filterable by connected merchant | JWT (ADMIN/OPERATOR) |
| `GET` | `/api/v1/admin/marketplace/payouts/:id` | Get a single payout by id | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/run-payouts` | Run the payout sweep now — batches unswept connected-merchant balances into `Payout`s | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/release-reserve` | Manually release a payout's rolling reserve | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/release-eligible-reserves` | Run the payout reserve-release sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/recheck-kyc-blocks` | Clear every KYC-blocked payout whose recipient is now `VERIFIED` | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/initiate-transfer` | Initiate a bank transfer for a payout's net amount (mock/ACH/wire, via `BANK_TRANSFER_PROVIDER`) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/initiate-eligible-transfers` | Run the transfer-initiation sweep now | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/payouts/:id/initiate-reserve-transfer` | Initiate a follow-up bank transfer for a payout's *released* reserve, independent of its net-amount transfer | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/marketplace/initiate-eligible-reserve-transfers` | Run the reserve-transfer-initiation sweep now | JWT (ADMIN/OPERATOR) |

### Reconciliation ([`platform-ops.md`](./platform-ops.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/reconciliation/runs` | List recent reconciliation runs | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/reconciliation/run` | Trigger an on-demand reconciliation run (defaults to the last hour) | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/psp-cost-reconciliation/run` | Compare estimated vs. actual-invoiced PSP processing fees for a window | JWT (ADMIN/OPERATOR) |

### Ledger Outbox ([`platform-ops.md`](./platform-ops.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/api/v1/admin/outbox/failed` | List dead-lettered (`FAILED`) ledger outbox events | JWT (ADMIN/OPERATOR) |
| `POST` | `/api/v1/admin/outbox/:id/retry` | Reset a `FAILED` event back to `PENDING` for the relay to retry | JWT (ADMIN/OPERATOR) |

### Webhooks ([`webhooks.md`](./webhooks.md))

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/v1/webhooks/stripe` | Stripe webhook receiver | Signature (`Stripe-Signature`) |
| `POST` | `/api/v1/webhooks/adyen` | Adyen webhook receiver | Signature (HMAC in payload) |
| `POST` | `/api/v1/webhooks/bank-transfer` | ACH/wire rail settlement confirmation | Signature (`X-Bank-Transfer-Signature`) |
| `POST` | `/api/v1/webhooks/kyc` | KYC provider review-decision callback | Signature (`X-KYC-Signature`) |
| `POST` | `/api/v1/webhooks/kyb` | KYB provider review-decision callback (distinct secret from KYC's) | Signature (`X-KYB-Signature`) |

### Observability

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/health` | Comprehensive health check (readiness probe) | Public |
| `GET` | `/health/live` | Liveness probe | Public |
| `GET` | `/health/ready` | Readiness probe | Public |
| `GET` | `/metrics` | Prometheus metrics | Public |

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
| [`platform-ops.md`](./platform-ops.md) | Outbox recovery, reconciliation, legal hold, health, metrics |
