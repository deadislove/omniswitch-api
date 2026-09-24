# Webhooks API

Source: `webhook.controller.ts`, `webhook-processing.service.ts`. These
are inbound receivers for asynchronous PSP callbacks — **no JWT**, since
the PSP isn't one of our merchants. Authenticity is a signature check
instead, one per provider.

## `POST /webhooks/stripe`

- **Guard**: `StripeWebhookGuard` — verifies the `Stripe-Signature`
  header against the raw request body.
- **Errors**: `401` missing/invalid signature.

Handled event types:

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | Resolves a `PROCESSING` or `REQUIRES_ACTION` payment to `SUCCEEDED`, books the ledger entry now (this is the *only* ledger-booking point for a webhook-confirmed charge — covers both a resolved 3DS challenge and a delayed/async authorization that never needed one) |
| `payment_intent.payment_failed` | Resolves a `PROCESSING` or `REQUIRES_ACTION` payment to `FAILED` |
| `charge.dispute.created` | Creates a `Dispute` (`NEEDS_RESPONSE`), runs the auto-decision policy — see [`disputes.md`](./disputes.md). Accepted for a payment currently `SUCCEEDED` **or** `PARTIALLY_REFUNDED` (a chargeback on an already-partially-refunded payment is normal — a partial refund for a shipping issue, then the cardholder disputes the rest); any other status is logged and ignored |
| `charge.dispute.closed` | Resolves an existing dispute `WON` or `LOST` (by the PSP's own `status` field) — `WON` restores whichever status the payment was in before the dispute (`SUCCEEDED` or `PARTIALLY_REFUNDED`), `LOST` moves it to `REFUNDED` and books a ledger clawback for the amount still outstanding at dispute time |

Any other event type is logged and ignored (not an error). Both success
and failure handlers are safe against PSP redelivery: a payment already
in the target status is logged as a duplicate and skipped, and a payment
in an unexpected status (neither `PROCESSING` nor `REQUIRES_ACTION`) is
logged and ignored rather than forced — matches Stripe's/Adyen's own
at-least-once delivery guarantee, which assumes the receiver tolerates
redelivery.

## `POST /webhooks/adyen`

- **Guard**: `AdyenWebhookGuard` — verifies Adyen's HMAC signature.
- Deliberately excluded from Swagger docs — Adyen's dashboard test
  button and delivery retries don't send a normal bearer/API-key header.
- **Response**: always `{ "notificationResponse": "[accepted]" }` —
  Adyen requires exactly this body to stop retrying delivery, regardless
  of whether the notification's own processing succeeded internally.

Handled notification event codes (`notificationItems[].NotificationRequestItem`):

| `eventCode` | Effect |
|---|---|
| `AUTHORISATION` | Resolves a `PROCESSING` or `REQUIRES_ACTION` payment to `SUCCEEDED`/`FAILED` (by the notification's own `success` field) |
| `REFUND` | Logged (refund completion confirmation) |
| `NOTIFICATION_OF_CHARGEBACK` | Creates a `Dispute` — this notification's own `pspReference` becomes the dispute's `pspDisputeId`, so a later `CHARGEBACK`/`CHARGEBACK_REVERSED` can resolve the *same* dispute |
| `CHARGEBACK` | Resolves the dispute `LOST` (the actual debit) |
| `CHARGEBACK_REVERSED` | Resolves the dispute `WON` (the bank reversed it) |

## `POST /webhooks/bank-transfer`

- **Guard**: `BankTransferWebhookGuard` — verifies an
  `X-Bank-Transfer-Signature: t=<unix seconds>,v1=<hex digest>` header
  (`HMAC-SHA256(BANK_TRANSFER_WEBHOOK_SECRET, "${t}.${rawBody}")`) —
  same scheme as the Stripe signature check, just a different header and
  secret.
- **Errors**: `401` missing/malformed/invalid signature, timestamp
  outside a 5-minute tolerance window, or `BANK_TRANSFER_WEBHOOK_SECRET`
  not configured.
- **Body**: `{ "id": string, "topic": string, "resourceId": string }` —
  a lightweight event envelope (no settlement detail inline), matching
  the real bank-transfer rail's own callback shape (see
  `AchBankTransferAdapter`/`WireBankTransferAdapter`).

`topic: "customer_transfer_completed"` settles the transfer; any other
topic is treated as a failure, and the handler makes an authenticated
follow-up call back to the transfer rail to fetch the failure reason
before recording it — the envelope itself doesn't carry one. Either
outcome resolves whichever `Payout` (net-amount or reserve) this
`resourceId` belongs to from `PENDING_CONFIRMATION` to `INITIATED` or
`FAILED`.

## `POST /webhooks/kyc`

- **Guard**: `KycWebhookGuard` — verifies an `X-KYC-Signature` header,
  same HMAC scheme as the bank-transfer guard, keyed by
  `KYC_WEBHOOK_SECRET`.
- **Errors**: `401` missing/invalid signature.
- **Body**: a real KYC provider's event envelope —
  `{ "data": { "attributes": { "name": string, "payload": { "data": { "id": string, "attributes": { "status": string } } } } } }`
  — the review decision is nested under `data.attributes.payload.data`,
  not a flat `{applicationId, status}` shape.

Only a decisive event (an `id` present and a status that isn't
`PENDING`) actually updates anything — resolves the merchant's
`kycApplicationId` to `kycStatus: 'VERIFIED'` or `'REJECTED'`. Any other
event (still under review, or one this system doesn't recognize) is
logged and ignored, not an error, matching every other webhook
receiver's redelivery-tolerant posture.

## `POST /webhooks/kyb`

- **Guard**: `KybWebhookGuard` — verifies an
  `X-KYB-Signature: t=<unix seconds>,v1=<hex digest>` header, same
  scheme as the bank-transfer guard, keyed by its own distinct
  `KYB_WEBHOOK_SECRET` — deliberately never shared with `KYC_WEBHOOK_SECRET`,
  so a KYC decision can never resolve a KYB application or vice versa,
  even under a misconfiguration.
- **Errors**: `401` missing/invalid signature.
- **Body**: same nested provider event envelope shape as `/webhooks/kyc`
  — `{ "data": { "attributes": { "name": string, "payload": { "data": { "id": string, "attributes": { "status": string } } } } } }`.

Only a decisive event (an `id` present and a status that isn't
`PENDING`) actually updates anything — resolves the merchant's
`kybApplicationId` to `kybStatus: 'VERIFIED'` or `'REJECTED'` via
`MerchantService.confirmKyb()`. A confirmation for an application that
isn't currently `PENDING_REVIEW` (e.g. PSP redelivery after it's already
resolved) is logged and ignored, not reapplied — same redelivery-tolerant
posture as every other webhook receiver here.

## Admin: inspecting and replaying outbound webhook deliveries

Source: `webhook-delivery-admin.controller.ts`. These are **outbound**
deliveries — every `Webhook*NotificationAdapter` (dispute, subscription,
AML review, sanctions screening) records one row per delivery attempt,
success or failure, via `WebhookDeliveryLogService`. This is a distinct
concern from every endpoint above, which all receive **inbound** PSP/
provider callbacks.

- **Guard**: `JwtAuthGuard` + `RolesGuard`, `ADMIN`/`OPERATOR` only —
  same visibility scope this codebase already uses for `GET
  /admin/disputes`, not a new merchant-self-service pattern.

| Endpoint | Effect |
|---|---|
| `GET /admin/webhook-deliveries?merchantId=...` | Lists delivery attempts for a merchant, newest first. Optional `eventType`/`success` filters, `afterId` keyset cursor, `limit` (default 50, max 200) |
| `GET /admin/webhook-deliveries/:id` | One delivery's full record, including the exact JSON payload sent — `404` if the id doesn't exist |
| `POST /admin/webhook-deliveries/:id/replay` | Re-sends the *exact* stored payload to its exact target URL, re-signed with the merchant's current HMAC secret. Records a **new** row (`replayOfDeliveryId` pointing at the true original, never a chain, even when replaying a replay) rather than mutating the original. `404` if the id doesn't exist; `422 HMAC_SECRET_MISSING` if the merchant has no HMAC secret on file |

Each record includes `success`, `statusCode` (`null` for a network
error/timeout — there was never a response to read a status from),
`errorMessage`, and `latencyMs`, regardless of outcome — a failed
delivery is logged the same as a successful one, not silently dropped.

## Testing webhooks locally

The mock PSP server (`scripts/mock-psp/server.js`) doesn't send
webhooks automatically — e2e tests construct a webhook payload directly
and POST it to these endpoints with a correctly-computed signature (see
`test/webhooks.e2e-spec.ts` and `test/utils/signing.ts` for the exact
shape). There's no live "trigger a real PSP callback" flow in this
dev environment.
