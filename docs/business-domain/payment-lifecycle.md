# Payment Lifecycle

This describes the business states a payment moves through, what triggers
each transition, and which API call or event is responsible. It's written
for someone who needs to reason about payment behavior without reading the
saga/service code line by line.

## States

```
PENDING ──────► PROCESSING ──────► SUCCEEDED ──┬──► REFUNDED
   │                │  │  │            │        └──► PARTIALLY_REFUNDED ──► REFUNDED
   │                │  │  │            │
   │                │  │  │            └──► DISPUTED ──┬──► SUCCEEDED (dispute won)
   │                │  │  │                             └──► REFUNDED (dispute lost)
   │                │  │  │
   │                │  │  └──► AMBIGUOUS ──┬──► SUCCEEDED (automated PSP query, or manual admin action — see note below)
   │                │  │                    └──► FAILED    (automated PSP query, or manual admin action — see note below)
   │                │  │
   │                │  └──► REQUIRES_CAPTURE ──┬──► SUCCEEDED
   │                │                            ├──► PARTIALLY_CAPTURED ──► SUCCEEDED
   │                │                            └──► CANCELLED
   │                │
   │                └──► REQUIRES_ACTION ──┬──► PROCESSING (3DS completed, loops back up)
   │                                        ├──► FAILED
   │                                        └──► CANCELLED
   │
   ├──► FAILED (no PSP was ever contacted — e.g. no PSP available for the currency, or an invalid marketplace split)
   └──► CANCELLED
```

A payment can only move *forward* through this graph — `PaymentStatus.vo.ts`
enforces every transition explicitly (`assertValidTransition`), and
`FAILED`/`CANCELLED`/`REFUNDED` are terminal. There is no path back from
`FAILED` to `PENDING`; a failed charge attempt means creating a *new*
payment (new `paymentId`), not retrying the old one in place.

**`AMBIGUOUS` resolves two ways: automated first, manual as a
fallback.** `PaymentStatus.vo.ts`'s transition table allows
`AMBIGUOUS → SUCCEEDED`/`FAILED`. Nothing resolves it through the
normal charge-confirmation paths: `WebhookProcessingService` looks
payments up by `pspTransactionId` (an ambiguous outcome never received
one — that's the definition of ambiguous, see below), and even where a
webhook did somehow match, its status guard only accepts `PROCESSING`/
`REQUIRES_ACTION`, not `AMBIGUOUS`; `ReconciliationService` skips any
payment without a `pspTransactionId` for the same reason. Instead:

- **Automated PSP-query resolution** —
  `AmbiguousPaymentService.runAutoResolutionSweep()` (`@Cron` every 10
  minutes, plus on-demand via
  `POST /admin/payments/ambiguous/run-auto-resolution`) asks the PSP
  itself what happened, via `PSPAdapterPort.queryOutcome(idempotencyKey)`
  — a read-only lookup, not a resubmitted charge (this system never
  persists the card reference past the original request, so there's
  nothing to resubmit with even if it wanted to). `SUCCEEDED` books the
  same ledger entries a webhook confirmation would; `FAILED` records
  that no charge occurred; if the PSP still has no record either, the
  payment's `ambiguousAutoRetryCount` increments and it's tried again
  next sweep, up to `AMBIGUOUS_AUTO_RESOLUTION_MAX_ATTEMPTS` (default
  5) attempts.
- **Manual escape hatch** — for whatever the automated sweep's retry
  budget doesn't resolve, an operator who has checked the PSP's own
  dashboard/API directly can close it out via
  `AmbiguousPaymentService`/`AmbiguousPaymentAdminController`
  (`GET /admin/payments/ambiguous`, `POST /admin/payments/:id/resolve-ambiguous`
  — see [`../guide/api/platform-ops.md`](../guide/api/platform-ops.md#ambiguous-payment-resolution-adminpaymentsambiguous-adminpaymentsidresolve-ambiguous)).
- **Stale alert** — `AmbiguousPaymentService.alertOnStale()`, every 5
  minutes, logs an error for anything still `AMBIGUOUS` after 15
  minutes (deliberately well before the automated sweep exhausts its
  own retry budget, so a human finds out early rather than only once
  automation has already given up).

## What triggers each transition

| Transition | Triggered by | Notes |
|---|---|---|
| → `PENDING` | `POST /payments/charge` | Payment intent created; nothing has been sent to a PSP yet |
| `PENDING` → `PROCESSING` | Saga, after smart routing picks a PSP | `pspProvider` is set here |
| `PROCESSING` → `REQUIRES_ACTION` | The PSP itself returns `requires_action` from the charge call | `pspTransactionId` is always set here, so a later webhook can resolve it — see the fixed-bug note below |
| `REQUIRES_ACTION` → `PROCESSING` → `SUCCEEDED` | `payment_intent.succeeded` / `AUTHORISATION` webhook, after the client completes the 3DS challenge | `WebhookProcessingService` calls `completeThreeDS()` then `markSucceeded()` |
| `PROCESSING` → `REQUIRES_CAPTURE` | Charge request had `captureMethod: "manual"` and the PSP authorized without capturing | `pspTransactionId` set; funds are authorized/held, not yet captured |
| `REQUIRES_CAPTURE` → `SUCCEEDED` | `POST /payments/:id/capture`, amount = everything remaining | This is the moment the ledger entry is written for this path — see `ledger-and-settlement.md` |
| `REQUIRES_CAPTURE`/`PARTIALLY_CAPTURED` → `PARTIALLY_CAPTURED` | `POST /payments/:id/capture`, amount < everything remaining | A separate ledger entry is booked for *this* capture's amount only, same as any other capture — see Capture accounting below |
| `PARTIALLY_CAPTURED` → `SUCCEEDED` | A further `POST /payments/:id/capture` whose amount completes the authorization | The only transition out of `PARTIALLY_CAPTURED` — cancelling the remainder isn't implemented (see Capture accounting) |
| `REQUIRES_CAPTURE` → `CANCELLED` | `POST /payments/:id/cancel` | Releases the hold; calls the PSP's cancel endpoint if it already knows about the payment. Not available once any capture has happened — see Capture accounting |
| `PENDING` → `FAILED` | Charge-ledger-params validation fails (`INVALID_CHARGE_PARAMS` — e.g. an invalid marketplace split), or smart routing finds no available/entitled PSP for this charge | Fails before any PSP is ever contacted — `payment.startProcessing()` hasn't run yet, so the payment is still `PENDING` when `compensate_markFailed` marks it `FAILED` |
| `PROCESSING`/`REQUIRES_ACTION` → `FAILED` | PSP declines, or all PSPs in the fallback chain fail | Compensating transaction (`compensate_markFailed`) |
| `PROCESSING` → `AMBIGUOUS` | The PSP call got no response at all (not a decline — a timeout/network failure), and the same-provider idempotency-key retry also got no response | `compensate_markAmbiguous`, `errorCode: 'PSP_TIMEOUT_AMBIGUOUS'` — the saga returns normally (200) instead of throwing, specifically so `IdempotencyInterceptor` doesn't wipe its cache and cause a client retry to re-run the whole saga as a brand-new charge. Never falls back to a different PSP after an ambiguous primary failure — that PSP has never seen this idempotency key and would risk a genuine double charge |
| `AMBIGUOUS` → `SUCCEEDED`/`FAILED` | `AmbiguousPaymentService.runAutoResolutionSweep()` (automated, PSP query) or `POST /admin/payments/:id/resolve-ambiguous` (manual) | See the note above the state diagram |
| `SUCCEEDED` → `PARTIALLY_REFUNDED` / `REFUNDED` | `POST /payments/:id/refund` | Amount defaults to the full remaining refundable balance if omitted |
| `SUCCEEDED` → `DISPUTED` | `charge.dispute.created` (Stripe) / `NOTIFICATION_OF_CHARGEBACK` (Adyen) webhook | No corresponding "create a dispute" API — disputes only ever originate from the PSP. Also creates a `Dispute` record — see Dispute accounting below |
| `DISPUTED` → `SUCCEEDED` | `charge.dispute.closed` with `status: 'won'` (Stripe) / `CHARGEBACK_REVERSED` (Adyen) webhook | The PSP/card network's decision, not an operator action — see Dispute accounting |
| `DISPUTED` → `REFUNDED` | `charge.dispute.closed` with `status: 'lost'` (Stripe) / `CHARGEBACK` (Adyen) webhook | Books a ledger entry identical in shape to a normal refund — see Dispute accounting |

### Fixed bug: pre-emptive 3DS used to have no PSP transaction id

The risk engine used to be able to decide a payment needed 3DS *before the
PSP was ever called* (`PaymentCheckoutSaga`'s old Step 2, which ran before
Step 4). That branch called `requiresAction()` with no `pspTransactionId`,
because no charge attempt had actually been made — and it returned a
placeholder `actionUrl` (`https://3ds.omniswitch.io/challenge/...`) that
resolved to nothing. A payment that entered `REQUIRES_ACTION` this way could
never be resolved by any webhook, since `WebhookProcessingService` looks
payments up by `pspTransactionId`: it was stuck permanently.

This is fixed — the risk score is still computed and stored (for audit),
but it no longer gates anything. The PSP is always actually called, and its
own response is the only thing that produces `REQUIRES_ACTION`, matching
how Stripe/Adyen's real SCA engines work. A card's issuing country
(`binCountry`) is forwarded to the PSP as a hint (PSD2 requires a challenge
for European cards), but the PSP's response still decides the outcome — see
`PaymentCheckoutSaga`'s docblock for the full story.
`payment.saga.spec.ts`'s "3DS / SCA Risk Assessment" tests assert the PSP
was actually invoked, specifically so this regression can't come back
silently.

## Refund accounting

A payment can be refunded multiple times, partially, as long as the running
total doesn't exceed the original charge (`PaymentAggregate.refund()`
enforces this, and `PaymentLifecycleService.refund()` checks it again before
ever calling the PSP, so a doomed refund never reaches Stripe/Adyen).
`remainingRefundable` is always `amount - sum(refunds)`.

## Capture accounting

`captureMethod: "manual"` on the charge request authorizes funds without
capturing them (`REQUIRES_CAPTURE`). Multiple partial captures against one
authorization are supported — split shipment/partial fulfillment billing —
as long as their sum doesn't exceed the original authorized amount
(`PaymentAggregate.recordCapture()` enforces this, mirroring how
`refund()` enforces the same invariant against the running refund total;
`PaymentLifecycleService.capture()` checks it again before ever calling the
PSP, so a doomed over-capture never reaches Stripe/Adyen). Each capture —
partial or the one that completes the authorization — books its own ledger
entry for its own increment, not a running total; see
`ledger-and-settlement.md`. `remainingCapturable` is always
`amount - sum(captures)`; omitting `amount` on a capture request captures
exactly that remainder, not the original full amount.

The payment stays `PARTIALLY_CAPTURED` (not `SUCCEEDED`) until the full
authorized amount has been captured, so a later capture call for the rest
is still accepted — this used to be impossible: any capture at all, even
for $1 of a $100 authorization, used to jump straight to `SUCCEEDED` and
permanently close off capturing the other $99.

**Not modeled**: voiding the remaining, uncaptured balance after a partial
capture has already happened. `PARTIALLY_CAPTURED → CANCELLED` isn't a
valid transition (fails with 409, not silently) — only an untouched
`REQUIRES_CAPTURE` authorization can be cancelled outright. Also,
refunding a partially-captured payment isn't possible — `refund()` still
requires `SUCCEEDED`/`PARTIALLY_REFUNDED`, so the captured portion of a
still-open authorization can't be refunded until the rest is captured (or
the whole thing is cancelled, if nothing has been captured yet).

## Dispute accounting

A dispute/chargeback is tracked as its own record (`Dispute`, the
`disputes` table), not just the payment's `DISPUTED` status flip — a
dispute has a lifecycle of its own (`NEEDS_RESPONSE` → `UNDER_REVIEW` →
`WON`/`LOST`, plus a response deadline) that `PaymentAggregate`'s state
machine has no room to represent, and an operator needs to see and act on
it independently of the payment record. `UNDER_REVIEW` isn't mandatory
on the way there, though: `DisputeAggregate.resolve()` is reachable
directly from `NEEDS_RESPONSE` too — the PSP/card network can hand back
a final `WON`/`LOST` decision without the merchant ever having formally
submitted evidence (e.g. the dispute is withdrawn, or the response
window lapses with nothing submitted).

**Creation**: a dispute-created webhook creates the `Dispute` record
(`respondBy` defaults to 7 days out — a documented default, since neither
PSP's webhook actually supplies a real deadline) *and* transitions the
payment to `DISPUTED`, atomically with each other in the sense that both
happen in the same webhook handler, though not in a single DB transaction
(a webhook redelivery is idempotent either way — see `WebhookProcessingService`).

**Auto-decision policy**: at creation, `DisputeService.recordDispute()`
also runs a pure policy function (`dispute-policy.ts`) that classifies the
new dispute as `ACCEPT`, `CONTEST`, or `MANUAL_REVIEW` — amount checked
first (below an illustrative $15, not worth contesting regardless of
reason), then reason code (only `product_not_received`/`duplicate` are
templated for auto-contest today; `fraudulent` and anything unrecognized
default to `MANUAL_REVIEW`). `CONTEST` is the one decision that actually
*acts*: it immediately calls the PSP with a templated evidence string,
moving the dispute straight to `UNDER_REVIEW` before an operator ever sees
it. `ACCEPT`/`MANUAL_REVIEW` are recorded but advisory only — this system
has no PSP "accept/close" action to call, so `ACCEPT` just tells an
operator not to bother. See `docs/business-domain/future-directions.md`
for what a real (calibrated, decline-code-aware) version of this would
still need.

**Representment**: `POST /admin/disputes/:id/evidence` (ADMIN/OPERATOR)
calls the PSP (`PSPAdapterPort.submitDisputeEvidence()`) and only moves the
dispute to `UNDER_REVIEW` if the PSP accepts the submission — a failed PSP
call leaves the dispute in `NEEDS_RESPONSE`, not silently marked as
responded-to. Unaffected by the auto-decision for `ACCEPT`/`MANUAL_REVIEW`
disputes; a `CONTEST`-auto-submitted one is already `UNDER_REVIEW`, so a
second (human) submission is correctly rejected with 409 — same one-shot
constraint a human's own submission already has.

**Resolution** is a PSP/card-network decision, not an operator action — it
arrives via a second webhook. `WON` transitions the payment back to
`SUCCEEDED`. `LOST` transitions it to `REFUNDED` and books a ledger entry:
economically, a lost chargeback claws funds back from the merchant exactly
like a refund does, it's just not merchant-initiated, so
`PaymentAggregate.resolveDispute()` reuses the same `refunds[]`/
`RefundRecord` bookkeeping a normal `refund()` call uses (not a separate
code path) — `totalRefunded`/`remainingRefundable` stay accurate regardless
of *why* the money left.

**Notification**: creation and resolution now emit structured
`dispute.created`/`dispute.resolved` events via `EventEmitter2`, not just
a log line — a real notification integration (email/Slack/paging) has
something to subscribe to, even though nothing does yet. Still a stand-in,
same posture as `ReconciliationService`'s/the outbox relay's alerting
elsewhere in this codebase — but a real *hook* now, not only a log line.

**Not modeled**: partial-amount disputes (a dispute is always assumed to
cover the full charged amount — real-world chargebacks usually are, but
not always).

## Idempotency

Every mutating endpoint (`charge`, `refund`, `capture`, `cancel`) requires
an `Idempotency-Key` header. `IdempotencyInterceptor` uses it to:

1. Acquire a Redis lock (`SETNX`) so two concurrent requests with the same
   key can't both execute the handler.
2. Cache the response for 24 hours, so a retried request with the same key
   gets the original response replayed instead of re-executing.

This key is deliberately *not* the same thing as `paymentId` — the client
generates it, and it's what makes "did my request actually go through?"
retries after a network timeout safe.
