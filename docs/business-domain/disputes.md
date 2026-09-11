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

**Amount is checked first, against a threshold that now depends on the
charging merchant's own risk tier.** Base threshold is illustrative
default $15 (`DISPUTE_AUTO_ACCEPT_THRESHOLD_MAJOR_UNITS`); below it, the
recommendation is `ACCEPT` regardless of reason — an economically cheap
dispute usually isn't worth contesting no matter why it was filed, the
same call a human operator would make first. `DisputeService.recordDispute()`
now re-evaluates the merchant's current tier (via `RiskTieringService.
evaluateMerchant()`, live, not a persisted value — see
[`risk-and-fraud.md`](./risk-and-fraud.md)) right before applying this
threshold:

| Merchant risk tier | Effective threshold | Why |
|---|---|---|
| `LOW` | base × 0.5 (`DISPUTE_LOW_RISK_THRESHOLD_MULTIPLIER`) | Fewer disputes auto-accepted outright — worth contesting more aggressively for a merchant with a strong track record. |
| `MEDIUM` / no evaluable tier | base, unchanged | Same behavior as before this existed. |
| `HIGH` | base × 2 (`DISPUTE_HIGH_RISK_THRESHOLD_MULTIPLIER`) | More small disputes auto-accepted outright — not spending contest effort on a merchant already flagged higher-risk. |

A merchant under a manual `reserve-policy` override
(`riskTierAutoManaged = false`) has no evaluable tier for this purpose
either — `RiskTieringService.evaluateMerchant()` returns no tier for a
manually-overridden merchant (same invariant that keeps the nightly sweep
from touching one), so the dispute policy falls back to the base
threshold, same as an unclassified merchant. See
[`future-directions.md`](./future-directions.md#dispute-resolution-workflow)
for the real break-even calculation
[`../technical/threshold-calibration.md`](../technical/tests/threshold-calibration.md)
ran against synthetic data to check the base default against.

**Reason code decides the rest — and a `LOW`-tier merchant gets one more
contestable reason than everyone else:**

| Reason code | Auto-decision | Why |
|---|---|---|
| `product_not_received` | `CONTEST` (templated) | Shipment/delivery records are the kind of evidence a template can point at generically. |
| `duplicate` | `CONTEST` (templated) | "These are two distinct transactions" is checkable from records alone. |
| `subscription_canceled` | `CONTEST` (templated) for `LOW`-tier merchants; `MANUAL_REVIEW` otherwise | Needs the actual cancellation-policy/timestamp comparison — templatable in principle, but only extended to merchants with a strong-enough track record to trust the template's default framing. |
| `fraudulent` | `MANUAL_REVIEW`, at every tier | Deliberately **never** auto-contested regardless of risk tier — a card-not-present fraud claim needs real evidence (AVS/CVV match, 3DS proof, account history) and often turns on liability-shift rules a generic template can't speak to. This is an evidentiary limitation, not a risk-tier judgment call, so tier never changes it. |
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
a `MANUAL_REVIEW` recommendation isn't starting from nothing. The
`GET /admin/disputes` response also carries `merchantRiskTierAtDecision`
— an audit-only snapshot of what tier was actually in effect at the
moment this decision was made, not a live join, so a later tier change
never rewrites the historical record of what this dispute's decision was
actually based on.

**Deliberately simple, illustrative thresholds — not calibrated against
real chargeback win-rate data.** The merchant's own dispute history now
*does* feed in, via risk tier (a change from before) — the card network
involved and jurisdiction-specific evidence requirements still don't,
which remain out of scope for this platform's dispute policy today.

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

Both `dispute.created` and `dispute.resolved` are structured events, and
`DisputeNotificationListener` (an `@OnEvent` subscriber) now actually
delivers them to the merchant — the first real subscriber either event
ever had. Delivery channel is per-merchant
(`MerchantEntity.disputeNotificationChannel`, defaulting to `WEBHOOK` —
the only channel that needs no merchant-side setup beyond a URL) via
`DisputeNotificationDispatcherService`, one of three adapters:

- **`WEBHOOK`** (default) — POSTs to `disputeNotificationTarget`, signed
  with the merchant's own `hmacSecretCiphertext` (the same key that
  signs their *inbound* requests via `HmacSignatureGuard`) so they can
  verify it genuinely came from this platform without a second
  credential — `X-OmniSwitch-Signature`, same HMAC scheme
  `StripeWebhookGuard` verifies incoming PSP webhooks with, just
  outbound.
- **`SLACK`** — POSTs Slack's own `{text}` shape straight to a Slack
  Incoming Webhook URL; no separate credential needed, since the URL's
  secrecy already is the access control.
- **`EMAIL`** — genuinely needs a real transactional-email provider
  integration (unlike webhook/Slack, a plain HTTP POST isn't itself a
  working email mechanism) — `EMAIL_PROVIDER_URL` points at one, mocked
  by `scripts/mock-psp/server.js`'s `/v1/email/send` in dev/test.

A merchant with no `disputeNotificationTarget` configured (every
merchant created before this existed) is skipped silently, not sent to
an empty destination — see
`PATCH /admin/merchants/:id/dispute-notification-channel` to configure
one. A delivery failure is logged, never allowed to break dispute
processing itself.

The actual HTTP-POST/HMAC-signing mechanics behind all three adapters
live in shared code
(`src/modules/payment/adapters/notifications/notification-delivery.util.ts`),
not copy-pasted per event family — `SubscriptionNotificationListener`
(see [`subscriptions.md`](./subscriptions.md)) reuses the exact same
delivery functions for `subscription.past_due`/`subscription.canceled`,
via its own independent `subscriptionNotificationChannel`/
`subscriptionNotificationTarget` fields.

## Agent/dispute attribution (Phase 1)

Every `Dispute` now snapshots `delegationId`/`initiatedBy` from the
underlying `Payment` at `DisputeService.recordDispute()` time — read via
`PaymentRepositoryPort.findByIdOnMaster()`, not the ambient
replica-routed connection, since a dispute can (in tests, and in
principle in production) arrive moments after the very charge that
created the payment record, which can lose the race against the
replica's ~1s streaming lag. `initiatedBy` is `'human'` for the vast
majority of charges and `'agent'` only for one made through a
`Delegation` (see [`future-directions.md`](./future-directions.md#agentic-payments));
`delegationId` is `null` whenever `initiatedBy` is `'human'`. Both are
exposed on `GET /admin/disputes`/`GET /admin/disputes/:id`.

**Data capture only.** This doesn't decide who's liable when an
agent-initiated charge is disputed — the platform, the merchant, or
whoever operates the agent — that's a genuinely unresolved industry
question. It makes "was this an agent-initiated charge" an actually
queryable fact instead of invisible, which is what any real
liability-attribution policy would need as a starting point.

## Not modeled

Partial-amount disputes — a dispute is always assumed to cover the full
charged amount. Real-world chargebacks usually are, but not always.
