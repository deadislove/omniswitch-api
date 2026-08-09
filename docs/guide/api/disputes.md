# Disputes API

Source: `dispute-admin.controller.ts`. Read
[`business-domain-guide.md`](../business-domain-guide.md#8-disputes--chargebacks)
first.

There is **no endpoint to create a dispute** — a `Dispute` only ever
originates from a PSP webhook (`charge.dispute.created` / Adyen's
`NOTIFICATION_OF_CHARGEBACK`), matching reality: a chargeback is
initiated by the cardholder's bank, not by this system. See
[`webhooks.md`](./webhooks.md).

Every new dispute is auto-classified `ACCEPT`/`CONTEST`/`MANUAL_REVIEW`
by amount and reason code the moment it's created — `CONTEST` already
auto-submitted templated evidence to the PSP by the time you'd see it
via these endpoints.

- **Roles** (all endpoints below): `ADMIN`, `OPERATOR`

## `GET /admin/disputes`

List, optionally filtered by `merchantId` and/or `status`
(`NEEDS_RESPONSE`/`UNDER_REVIEW`/`WON`/`LOST`).

## `GET /admin/disputes/:id`

- **Errors**: `404` not found (`DISPUTE_NOT_FOUND`).

**`DisputeSummaryDto` shape**:

```json
{
  "id": "a1b2c3d4-...",
  "paymentId": "pay_abc123",
  "merchantId": "merchant_acme_corp",
  "pspProvider": "STRIPE",
  "pspDisputeId": "dp_stripe_abc123",
  "amount": 99.99,
  "currency": "USD",
  "reason": "fraudulent",
  "status": "UNDER_REVIEW",
  "respondBy": "2026-01-08T00:00:00.000Z",
  "evidence": "Tracking number 1Z999 shows delivery confirmed...",
  "autoDecision": "CONTEST",
  "evidenceGuidance": "...",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`autoDecision` is advisory for `ACCEPT`/`MANUAL_REVIEW` (there's no PSP
"accept" action to call — an `ACCEPT`ed dispute is simply left
untouched); `CONTEST` means evidence was already, actually submitted.
`evidenceGuidance` is reason-code-specific guidance on what actually
wins this kind of dispute, shown regardless of `autoDecision` — useful
even when overriding a `MANUAL_REVIEW` recommendation by hand.

## `POST /admin/disputes/:id/evidence`

Submit evidence to contest a `NEEDS_RESPONSE` dispute (representment) —
calls the PSP for real.

- **Body**: `{ evidence: string }` (1–5000 chars)
- **Response `200`**: `DisputeSummaryDto`, now `UNDER_REVIEW`
- **Errors**: `404` not found (`DISPUTE_NOT_FOUND`); `409` dispute isn't
  `NEEDS_RESPONSE` (`DISPUTE_NOT_RESPONDABLE` — already
  `CONTEST`-auto-submitted, or already resolved); `422` PSP declined the
  evidence submission (`EVIDENCE_SUBMISSION_FAILED`).

## Resolution

`WON`/`LOST` arrive via webhook, not an API call — see
[`webhooks.md`](./webhooks.md). A `LOST` dispute claws funds back
through the same ledger path a refund uses, and (if the merchant is
auto-managed) feeds `RiskTieringService`'s trailing lost-dispute-rate
calculation — see [`risk-and-reserves.md`](./risk-and-reserves.md).
