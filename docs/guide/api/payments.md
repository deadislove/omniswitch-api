# Payments API

Source: `src/modules/payment/application/controllers/payment.controller.ts`.
See [`README.md`](./README.md) for auth/HMAC/idempotency conventions used
throughout.

---

## `POST /payments/charge`

Charges a card via smart PSP routing. The one endpoint every other
money-moving feature in this system (subscriptions, proration) reuses
internally — see [`system-design.md`](../system-design.md#3-a-charge-end-to-end)
for the full internal flow.

- **Roles**: `MERCHANT`, `ADMIN`, `AGENT`
- **Guards**: HMAC + Idempotency-Key (both **skipped** for an `AGENT`
  caller — see [`agentic-payments.md`](./agentic-payments.md))
- **Rate limit**: 100/min

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | number | yes | Major currency units (e.g. `99.99`) |
| `currency` | string | yes | ISO-4217, 3 chars |
| `customerId` | string | no | |
| `paymentMethodId` | string | no* | Opaque PSP reference (tokenized client-side). Never a raw card number — rejected if it looks like one. |
| `cardToken` | string | no* | Same shape as `paymentMethodId`, alternate field some PSP.js flows use |
| `orderId` | string | no | Merchant order reference |
| `description` | string | no | |
| `statementDescriptor` | string | no | Max 22 chars |
| `binInfo` | object | no | `{ bin, country, cardBrand, cardType, issuingBank? }` — feeds smart routing (3DS/EU heuristics) |
| `preferredProvider` | `'STRIPE'\|'ADYEN'\|'PAYPAL'\|'CHASE'` | no | Overrides smart routing (only Stripe/Adyen have adapters implemented) |
| `metadata` | object | no | Free-form key-value pairs |
| `category` | string | no | Only enforced for an `AGENT` caller against its delegation's `allowedCategories` — ignored otherwise |
| `captureMethod` | `'automatic'\|'manual'` | no | `'manual'` authorizes without capturing; default `'automatic'` |
| `presentmentCurrency` | string | no | Purely informational display conversion — never changes what's charged |
| `splits` | array | no | `[{ merchantId, amount }]` — marketplace splits, see [`marketplace.md`](./marketplace.md). Requires `captureMethod: 'automatic'`. |

\* At least one of `paymentMethodId`/`cardToken` is expected in practice
(routing/PSP calls need something to charge against).

**Response `201`**

```json
{
  "paymentId": "pay_abc123",
  "status": "SUCCEEDED",
  "pspTransactionId": "pi_stripe_abc123",
  "pspProvider": "STRIPE",
  "actionUrl": null,
  "requiresAction": false,
  "riskScore": 25,
  "usedFallback": false,
  "estimatedFee": { "amount": 2.9, "currency": "USD" },
  "presentmentAmount": null,
  "presentmentCurrency": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`status` is one of `SUCCEEDED`, `REQUIRES_ACTION` (3DS challenge —
`actionUrl` is set, resolved later via webhook), `REQUIRES_CAPTURE`
(manual capture), or `FAILED`.

**Errors**: `400` missing `Idempotency-Key`; `403` an `AGENT`'s
delegation has been revoked; `409` `splits` combined with
`captureMethod: 'manual'`, or a split's settlement-currency conflict;
`422` a raw-card-number-shaped reference, request validation failure,
an invalid split recipient, or (`AGENT` only) a spend-policy violation
(`DELEGATION_PER_TRANSACTION_LIMIT_EXCEEDED`,
`DELEGATION_MONTHLY_LIMIT_EXCEEDED`, `DELEGATION_CATEGORY_NOT_ALLOWED`,
`DELEGATION_CURRENCY_MISMATCH`).

## `GET /payments/:id/status/stream` (SSE)

Server-Sent Events stream of real-time status updates for one payment —
useful for a frontend polling a 3DS challenge's resolution.

- **Roles**: `MERCHANT`, `ADMIN`, `READONLY`
- Emits `payment.status.changed`/`payment.charged`/`payment.failed`/
  `payment.refunded`/`payment.requires_action` events plus a 30-second
  heartbeat; closes automatically on a terminal event.
- **Errors**: `404` payment not found (checked before the stream opens).

## `GET /payments/:id`

Full payment detail, including refund/capture history.

- **Roles**: `MERCHANT`, `ADMIN`, `READONLY`
- **Errors**: `403` belongs to a different merchant; `404` not found.

## `POST /payments/:id/refund`

Full or partial refund of a `SUCCEEDED`/`PARTIALLY_REFUNDED` payment.

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key

**Request body**: `{ amount?: number, reason?: string }` — omit `amount`
for a full refund of the remaining refundable balance.

**Response `200`**: `{ paymentId, status, totalRefunded, remainingRefundable, currency, refunds: [...] }`

**Errors**: `400` missing Idempotency-Key; `403` wrong merchant; `404`
not found; `409` amount exceeds remaining refundable balance, or payment
isn't in a refundable status; `422` PSP declined the refund.

## `POST /payments/:id/capture`

Captures funds previously authorized with `captureMethod: 'manual'`.
Multiple partial captures against the same authorization are allowed as
long as they don't exceed the original amount.

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key

**Request body**: `{ amount?: number }` — omit for a full capture of the
remaining authorized amount.

**Response `200`**: `{ paymentId, status, pspTransactionId, amount, totalCaptured, remainingCapturable, currency, captures: [...] }`

**Errors**: `400` missing Idempotency-Key; `403` wrong merchant; `404`
not found; `409` not `REQUIRES_CAPTURE`/`PARTIALLY_CAPTURED`, or amount
exceeds the remaining authorized amount; `422` PSP declined the capture.

## `POST /payments/:id/cancel`

Cancels a payment before capture. Idempotent — a repeat call against an
already-`CANCELLED` payment still returns `200`.

- **Roles**: `MERCHANT`, `ADMIN`
- **Guards**: HMAC + Idempotency-Key

**Response `200`**: `{ paymentId, status }`

**Errors**: `400` missing Idempotency-Key; `403` wrong merchant; `404`
not found; `409` not in a cancellable status (e.g. already captured);
`422` PSP declined the cancellation.

## `POST /payments/bulk-upload`

`multipart/form-data` CSV upload (field name `file`, max 10MB) for batch
payment processing. Rows are parsed and **queued**, not charged
synchronously — a `201` means parsing succeeded, not that every row's
payment succeeded.

- **Roles**: `MERCHANT`, `ADMIN`
- CSV columns: `amount`, `currency` (defaults `USD`), `order_id`,
  `idempotency_key` (optional, generated if omitted).

**Response `201`**: `{ totalRows, queued, failed, payments: [...], errors: [...] (first 10), batchId, processedAt }`

**Errors**: `400` no file attached.

## `GET /payments/routing/health`

Live PSP routing health — circuit breaker state, success rate, average
latency per provider (the same data `/metrics`'s `omniswitch_psp_*`
gauges expose, here as a JSON snapshot for a human/dashboard rather than
Prometheus).

- **Roles**: `ADMIN`, `OPERATOR`
