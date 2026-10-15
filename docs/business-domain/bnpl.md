# Buy Now, Pay Later (BNPL)

A Klarna-style buy-now-pay-later order is a fundamentally different
settlement shape from a card charge, not another payment method branch
inside one — this is its own aggregate, its own port, its own
controller, and its own file here. See
[`ledger-accounting.md`](./ledger-accounting.md) for the underlying
double-entry model this reuses, and
[`compliance-and-security.md#wallet-payment-methods-a-different-authentication-flow-surfaced-as-a-signal`](./compliance-and-security.md#wallet-payment-methods-a-different-authentication-flow-surfaced-as-a-signal)
for the other half of "modern payment methods" this platform models —
wallets, which stayed a signal on the existing card-charge path rather
than a mechanism of their own, unlike BNPL.

## Why BNPL doesn't fit the card-charge shape

A card charge authorizes against the cardholder's own bank, which is on
the hook for the money; the acquirer/PSP is just the pipe. A BNPL
order inverts who's actually lending: Klarna extends credit to the
customer, pays the merchant in full at capture regardless of whether
the customer ever finishes paying Klarna back, and takes on that
credit risk itself. A refund likewise routes back through Klarna, never
a card-network reversal, since no card network was ever involved in
the capture leg either. This platform has no visibility into, and no
involvement in, Klarna's own installment collection from the customer
— that's between Klarna and the customer.

That inversion is why `BnplOrder` is its own aggregate rather than
another `PaymentAggregate` status, `BnplAdapterPort`/`BnplOrderPort`
are their own ports rather than another branch on `PSPAdapterPort`, and
`BnplController`'s endpoints (`POST /bnpl/orders`,
`GET /bnpl/orders/:id`, `POST /bnpl/orders/:id/refund`) live separately
from `PaymentController`'s card-charge endpoints.

## Lifecycle

```
PENDING_AUTHORIZATION -> AUTHORIZED -> CAPTURED -> REFUNDED/PARTIALLY_REFUNDED
                      -> REJECTED
```

- **`PENDING_AUTHORIZATION`**: the order has been created but Klarna
  hasn't yet made its own real-time credit decision.
- **`AUTHORIZED`**: Klarna granted credit — it has decided to extend
  the customer credit for this purchase, but has **not yet paid the
  merchant**. This is a materially different meaning from a card's
  `REQUIRES_CAPTURE`, where the cardholder's bank has already set money
  aside; here nothing has moved yet.
- **`REJECTED`**: Klarna's own credit decision declined the order — the
  only exit from `PENDING_AUTHORIZATION`, modeled the same "the
  provider decides, this platform never does" posture as a card's SCA
  challenge outcome.
- **`CAPTURED`**: the point real Klarna actually pays the merchant —
  ledger entries exist from this point on, independent of whether the
  customer ever finishes their installments.
- **`REFUNDED` / `PARTIALLY_REFUNDED`**: a refund against a captured
  order, routed back through Klarna itself. Transitions to `REFUNDED`
  once the cumulative refunded amount reaches the original order
  amount, `PARTIALLY_REFUNDED` otherwise — same shape as a card
  payment's own partial-refund tracking.

`BnplService.createOrder()` creates and immediately captures an order
in one call — this reference project has no frontend checkout session
to pause on between those two real Klarna steps (see the scope boundary
below), so there's no separate "capture" endpoint a merchant calls
later the way a manual-capture card charge has one. An order that gets
authorized but then fails to capture is left in `AUTHORIZED` rather
than silently discarded or auto-reversed: Klarna granted credit but
this platform never actually got paid, a real, visible state for an
operator to retry or investigate. No ledger entries exist yet in that
case, so there's nothing to reverse.

## Settlement: a separate ledger rail from a card charge

`LedgerOutboxEvent.createBnplCaptureEntries()` books a captured order
to its own `BNPL_SETTLEMENT` account type rather than reusing
`PSP_SETTLEMENT` — money received from Klarna is a different rail from
money received from a card network, even though both eventually credit
the same `MERCHANT` account:

| Account | Type | Entry | Amount |
|---|---|---|---|
| `BNPL_SETTLEMENT_ACCOUNT` | BNPL_SETTLEMENT | DEBIT | full order amount |
| `PLATFORM_FEE_ACCOUNT` | FEE | CREDIT | this platform's own fee |
| `KLARNA_FEE_ACCOUNT` | BNPL_PROVIDER_FEE | CREDIT | Klarna's merchant fee |
| `{merchantId}` | MERCHANT | CREDIT | net amount |

Klarna's own merchant fee (`calculateBnplProviderFee()`,
`domain/services/bnpl-fee.ts`) is booked as its own
`BNPL_PROVIDER_FEE` line item, separate from this platform's own
`platformFeeBps` — real published Klarna merchant fees run roughly
3-6% plus a fixed fee depending on market/plan, well above typical
card interchange, a real tradeoff a merchant accepts for Klarna taking
on the customer's credit risk and paying upfront regardless of
collection outcome. `KLARNA_MERCHANT_FEE_BPS = 399` (3.99%) is a
deliberately simplified, illustrative stand-in in that real
neighborhood, same "round number in the real range" posture
`INSTANT_PAYOUT_FEE_BPS` already uses elsewhere in this codebase — a
real integration would read this off Klarna's own merchant agreement,
not a constant.

A refund (`createBnplRefundEntries()`) credits `BNPL_SETTLEMENT` and
debits the merchant for the refunded amount — it deliberately does
**not** claw back a proportional share of either fee, the same
"the fee was already earned/incurred against work already done" posture
a card refund already takes.

## Scope boundary: what this deliberately doesn't model

- **No customer-facing checkout session.** Real Klarna's actual flow
  starts with a session (`/payments/v1/sessions`) that returns a
  `client_token` for a frontend SDK to collect the customer's own
  authorization against, *before* a backend ever places the order.
  This reference project has no frontend to run that flow through —
  `BnplService.createOrder()` stands in for that already-authorized
  hand-off, the same simplification this codebase already accepts for
  a card's 3DS `actionUrl` redirect.
- **No splits, FX, or reserve holds.** A card charge's
  `createChargeEntries()` supports marketplace splits and
  settlement-currency conversion; a BNPL capture does not. Out of
  scope for this pass, not a limitation this platform is unaware of.
- **One provider, no smart routing.** `BnplAdapterPort` has exactly one
  concrete implementation (`KlarnaBnplAdapter`) — no
  `BANK_TRANSFER_PROVIDER`-style provider pick, since this reference
  project only models one BNPL provider. A second (Affirm, Afterpay)
  would need its own adapter behind this same port.
- **Idempotent on `idempotencyKey`, not on any Klarna-side
  deduplication.** A retried `createOrder()` call returns the
  already-created order from this platform's own persistence rather
  than ever placing a second order against Klarna.

Runnable end to end against `scripts/mock-psp/server.js`'s
`/klarna/...` routes (order placement, capture, refund, including a
`klarnareject`/`klarnacapturefail`/`klarnarefundfail` marker
convention for exercising each failure path) — but, same honest
posture as this codebase's other mocked integrations, no real Klarna
account has ever actually been called with real credentials, and the
exact field names inside each request/response body are illustrative
rather than a byte-exact reproduction of Klarna's published schema.
