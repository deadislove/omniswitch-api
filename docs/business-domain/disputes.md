# Dispute Resolution

This describes what a `Dispute` is, how it's created and resolved, and
the policy that decides whether this platform contests one automatically.
Written for someone who needs to reason about dispute behavior without
reading the service code line by line — see
[`payment-lifecycle.md`](./payment-lifecycle.md#dispute-accounting) for
the ledger/accounting mechanics (what booking happens when a dispute is
lost) and
[`future-directions.md`](./future-directions.md#dispute-resolution-workflow)
for what's still genuinely missing.

## Why this is a separate domain object, not a payment status

A chargeback reported by a PSP could, in principle, just flip a payment's
status to `DISPUTED` and stop there. That loses real information a
dispute actually carries: its own lifecycle (has evidence been
submitted? is the PSP still reviewing it? did the merchant win or lose?),
a response deadline that's meaningfully different from anything a
`Payment` tracks, and — once it resolves — a specific economic
consequence (money clawed back, or not) distinct from a merchant-initiated
refund. `Dispute` exists so an operator has something to look at and act
on that isn't just "this payment's status changed."

## States

```
NEEDS_RESPONSE ──────► UNDER_REVIEW ──────► WON
       │                    │
       │                    └─────────────► LOST
       │
       └───────────────────────────────────► WON / LOST
              (resolved directly — withdrawn, or the
               response window lapsed with nothing submitted)
```

- **`NEEDS_RESPONSE`**: the starting state, set the moment a PSP reports a
  new dispute. `respondBy` defaults to 7 days out — a documented default,
  since neither PSP's webhook actually supplies a real deadline.
- **`UNDER_REVIEW`**: evidence has been submitted — either an operator's
  own submission via `POST /admin/disputes/:id/evidence`, or an automatic
  one the auto-decision policy already sent (see below). The PSP/card
  network is now the one deciding, not this platform.
- **`WON`** / **`LOST`**: terminal, reached only by the PSP/card network's
  own decision arriving via webhook — never something this platform or a
  merchant decides directly. Reachable straight from `NEEDS_RESPONSE`
  too: a dispute can resolve without the merchant ever formally
  submitting evidence (withdrawn, or the response window simply lapsed).

## The auto-decision policy

Every new dispute gets classified once, at creation, into `ACCEPT`,
`CONTEST`, or `MANUAL_REVIEW` — so routine disputes don't all sit at
`NEEDS_RESPONSE` waiting on an operator to make an obvious call by hand.

**Amount is checked first.** Below a threshold (illustrative default
$15, `DISPUTE_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS`), the recommendation is
`ACCEPT` regardless of reason — an economically cheap dispute usually
isn't worth contesting no matter why it was filed, the same call a human
operator would make first. See
[`future-directions.md`](./future-directions.md#dispute-resolution-workflow)
for the real break-even calculation
[`../technical/threshold-calibration.md`](../technical/tests/threshold-calibration.md)
ran against synthetic data to check this default against.

**Reason code decides the rest.** Only two reason codes are templated for
automatic contest today:

| Reason code | Auto-decision | Why |
|---|---|---|
| `product_not_received` | `CONTEST` (templated) | Shipment/delivery records are the kind of evidence a template can point at generically. |
| `duplicate` | `CONTEST` (templated) | "These are two distinct transactions" is checkable from records alone. |
| `fraudulent` | `MANUAL_REVIEW` | Deliberately **not** auto-contested even though it's likely the most common real-world reason — a card-not-present fraud claim needs real evidence (AVS/CVV match, 3DS proof, account history) and often turns on liability-shift rules a generic template can't speak to. Automating a templated response here would be more likely to waste the response window than win it. |
| `subscription_canceled` | `MANUAL_REVIEW` | No template — needs the actual cancellation-policy/timestamp comparison, not generic language. |
| anything unrecognized | `MANUAL_REVIEW` | Default when this platform hasn't classified a reason code. |

`CONTEST` is the one recommendation that actually *acts*: it immediately
calls the PSP with the templated evidence string, moving the dispute
straight to `UNDER_REVIEW` before an operator ever sees it —
representment happens automatically, not just a recommendation logged for
later. `ACCEPT`/`MANUAL_REVIEW` are advisory only; this platform has no
PSP "accept/close" action to call, so `ACCEPT` just tells an operator not
to bother. Every dispute — regardless of which way the auto-decision
went — also carries `evidenceGuidance`, reason-code-specific guidance on
what evidence would actually be needed to win, so an operator overriding
a `MANUAL_REVIEW` recommendation isn't starting from nothing.

**Deliberately simple, illustrative thresholds — not calibrated against
real chargeback win-rate data.** Same posture as merchant risk tiering
(see [`risk-and-fraud.md`](./risk-and-fraud.md)): a real policy would
also weigh the merchant's own dispute history, the card network involved,
and jurisdiction-specific evidence requirements, none of which this
platform's dispute policy considers today.

## Representment

`POST /admin/disputes/:id/evidence` (ADMIN/OPERATOR) calls the PSP and
only moves the dispute to `UNDER_REVIEW` if the PSP actually accepts the
submission — a failed PSP call leaves the dispute at `NEEDS_RESPONSE`,
not silently marked as responded-to. A dispute the auto-decision policy
already moved to `UNDER_REVIEW` (a `CONTEST` case) correctly rejects a
second, human submission with `409` — the same one-shot constraint a
human's own submission has against itself.

## Resolution

Arrives via a second webhook — a PSP/card-network decision, never
something this platform or the merchant decides directly.

- **`WON`**: the payment returns to whichever status it was in *before*
  the dispute (`SUCCEEDED`, or `PARTIALLY_REFUNDED` if a refund predated
  the dispute) — never unconditionally reset to `SUCCEEDED`, which would
  silently erase an earlier refund.
- **`LOST`**: the payment moves to `REFUNDED` and the *remaining*
  refundable balance at dispute-creation time is clawed back — not
  necessarily the full original charge amount, if a refund already
  happened before the dispute started. See
  [`payment-lifecycle.md`](./payment-lifecycle.md#dispute-accounting) for
  the ledger mechanics this reuses (a lost dispute books like a refund,
  because economically it is one — just not merchant-initiated).

Both `dispute.created` and `dispute.resolved` are structured events, so a
real notification integration has something to subscribe to — nothing
does yet; see [`future-directions.md`](./future-directions.md#dispute-resolution-workflow).

## Not modeled

Partial-amount disputes — a dispute is always assumed to cover the full
charged amount. Real-world chargebacks usually are, but not always.
