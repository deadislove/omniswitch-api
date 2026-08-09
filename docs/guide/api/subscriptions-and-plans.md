# Subscriptions & Plans API

Source: `subscription.controller.ts`, `subscription-admin.controller.ts`,
`plan.controller.ts`. Read
[`business-domain-guide.md`](../business-domain-guide.md#5-recurring-billing--subscriptions)
first for the state machine and billing/dunning mechanics.

---

## Subscriptions

### `POST /subscriptions`

Creates a subscription — either from a reusable `Plan` or with direct
pricing. Charges the first period **immediately** unless `trialDays` is
set (in which case the payment method is still verified up front — see
the business guide — but no money moves until the trial ends).

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `planId` | UUID | one of `planId` or (`amount`+`currency`+`interval`) | Pricing/interval derived from the plan; other pricing fields below are ignored if set |
| `amount` | number | see above | Major currency units |
| `currency` | string | see above | ISO-4217 |
| `customerId` | string | yes | |
| `interval` | `'day'\|'week'\|'month'\|'year'` | see above | |
| `intervalCount` | int | no | Default 1 (e.g. 3 + `month` = quarterly) |
| `paymentMethodId` | string | yes | Off-session charging reference — a raw card token alone isn't accepted since every renewal reuses this |
| `trialDays` | int | no | 0/omitted charges immediately |
| `orderId` | string | no | |
| `description` | string | no | |

**Response `201`**: `SubscriptionResponseDto` (see below).

**Errors**: `422` neither `planId` nor direct pricing supplied
(`SUBSCRIPTION_MISSING_PRICING`), or the first charge/payment-method
verification failed — no subscription is created in that case.

### `GET /subscriptions/:id`

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`
- **Errors**: `403` wrong merchant; `404` not found.

### `GET /subscriptions`

List, optionally filtered by `merchantId` (ADMIN/OPERATOR/READONLY
only — a `MERCHANT` is always scoped to its own), `customerId`, `status`
(`TRIALING`/`ACTIVE`/`PAST_DUE`/`CANCELED`).

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`

**`SubscriptionResponseDto` shape**:

```json
{
  "id": "a1b2c3d4-...",
  "planId": "a1b2c3d4-...",
  "merchantId": "merchant_acme_corp",
  "customerId": "cust_xyz789",
  "amount": 29.99,
  "currency": "USD",
  "interval": "month",
  "intervalCount": 1,
  "status": "ACTIVE",
  "currentPeriodStart": "2026-01-01T00:00:00.000Z",
  "currentPeriodEnd": "2026-02-01T00:00:00.000Z",
  "cancelAtPeriodEnd": false,
  "failedAttempts": 0,
  "nextRetryAt": null,
  "lastDeclineCode": null,
  "pendingCredit": null,
  "orderId": "order_abc123",
  "description": null,
  "canceledAt": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`lastDeclineCode` is set from the most recent failed billing attempt
(cleared on the next success) — a hard-decline value there means the
subscription skipped the retry schedule and canceled immediately. See
the business guide's dunning section.

### `POST /subscriptions/:id/cancel`

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key
- **Body**: `{ atPeriodEnd?: boolean }` — `true` keeps billing through the
  current period and stops at its end; `false`/omitted cancels
  immediately.
- **Errors**: `403` wrong merchant; `404` not found.

### `POST /subscriptions/:id/change-plan`

Switches an `ACTIVE` subscription to a different plan, prorating the
remaining part of the current period. Upgrades charge the difference
immediately (through the normal checkout saga — a decline means the
plan does **not** change); downgrades issue a credit consumed against a
future period's charge instead of a refund now.

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key
- **Body**: `{ planId: string (UUID) }` — must belong to the same
  merchant, be active, and be the same currency as the subscription's
  current amount.

**Response `200`**: `{ subscription: SubscriptionResponseDto, prorationCharged?: number, creditIssued?: number }`
(mutually exclusive; both absent for a lateral move with no price
change).

**Errors**: `403` subscription/plan belongs to a different merchant;
`404` not found; `409` subscription isn't `ACTIVE`, or the target plan is
a different currency; `422` the proration charge was owed and the PSP
declined it — plan unchanged.

### `POST /admin/subscriptions/run-billing`

Runs the billing sweep on demand instead of waiting for the daily
schedule — same code path either way.

- **Roles**: `ADMIN`, `OPERATOR`
- **Response `200`**: `{ charged: number, canceled: number, failed: number }`

---

## Plans

A merchant-scoped, reusable subscription template. Immutable once
created — `deactivate()` is the only mutation (stops new subscriptions
from using it; existing subscribers, who snapshotted the terms, are
unaffected).

### `POST /plans`

- **Roles**: `MERCHANT`, `ADMIN`
- No HMAC/idempotency — creating a plan never moves money by itself.
- **Body**: `{ name, amount, currency, interval, intervalCount? }`

### `GET /plans/:id`

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`
- **Errors**: `403` wrong merchant; `404` not found.

### `GET /plans`

Optionally filtered by `merchantId` (non-`MERCHANT` roles only) and
`isActive` (defaults `true`).

- **Roles**: `MERCHANT`, `ADMIN`, `OPERATOR`, `READONLY`

### `POST /plans/:id/deactivate`

- **Roles**: `MERCHANT`, `ADMIN`
- **Errors**: `403` wrong merchant; `404` not found.

**`PlanResponseDto` shape**: `{ id, merchantId, name, amount, currency, interval, intervalCount, isActive, createdAt, updatedAt }`
