# Webhooks API

Source: `webhook.controller.ts`, `webhook-processing.service.ts`. These
are inbound receivers for asynchronous PSP callbacks — **no JWT**, since
the PSP isn't one of our merchants. Authenticity is a signature check
instead, one per provider.

## `POST /webhooks/stripe`

- **Guard**: `StripeWebhookGuard` — verifies the `Stripe-Signature`
  header against the raw request body.
- **Errors**: `400` missing/invalid signature.

Handled event types:

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | Resolves a `PROCESSING` or `REQUIRES_ACTION` payment to `SUCCEEDED`, books the ledger entry now (this is the *only* ledger-booking point for a webhook-confirmed charge — covers both a resolved 3DS challenge and a delayed/async authorization that never needed one) |
| `payment_intent.payment_failed` | Resolves a `PROCESSING` or `REQUIRES_ACTION` payment to `FAILED` |
| `charge.dispute.created` | Creates a `Dispute` (`NEEDS_RESPONSE`), runs the auto-decision policy — see [`disputes.md`](./disputes.md) |
| `charge.dispute.closed` | Resolves an existing dispute `WON` or `LOST` (by the PSP's own `status` field) — a `LOST` resolution books a ledger clawback |

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

## Testing webhooks locally

The mock PSP server (`scripts/mock-psp/server.js`) doesn't send
webhooks automatically — e2e tests construct a webhook payload directly
and POST it to these endpoints with a correctly-computed signature (see
`test/webhooks.e2e-spec.ts` and `test/utils/signing.ts` for the exact
shape). There's no live "trigger a real PSP callback" flow in this
dev environment.
