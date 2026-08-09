# Recurring Billing / Subscriptions

This describes what a `Subscription` is, how it produces charges over
time, and the specific, documented ways this implementation simplifies a
real recurring-billing system. Written for someone who needs to reason
about subscription behavior without reading the service code line by
line — see
[`../../DEV_README.md`](../../DEV_README.md#recurring-billing--subscriptions---resolved)
for the technical/architectural side (what code changed, how it was
verified) and
[`future-directions.md`](./future-directions.md#recurring-billing--subscriptions)
for what's still genuinely missing.

## Why this is a separate domain object, not "a payment that repeats"

[`payment-lifecycle.md`](./payment-lifecycle.md) describes a single
charge's lifecycle — created, processed, succeeded or failed, maybe
refunded or disputed. A subscription doesn't fit that shape: it doesn't
*have* a status the way a payment does, it *produces* a new payment every
billing period. Folding "produces charges on a schedule" into
`PaymentAggregate` would mean a payment representing many payments, which
breaks the existing state machine's meaning (what would `SUCCEEDED` even
mean for something that's about to charge again next month?). A
`Subscription` is a scheduler and a policy (what to charge, how often, what
to do when a charge fails) that happens to produce ordinary `Payment`
records — each period's charge is a completely normal payment, subject to
the exact same lifecycle, refund rules, and dispute handling as any other.

## States

```
TRIALING ──────► ACTIVE ──────► PAST_DUE ──────► ACTIVE   (a later charge succeeds)
   │                │               │
   │                │               └───────────► CANCELED (dunning exhausted, or a
   │                │                               hard decline skips PAST_DUE entirely)
   │                │
   │                └──────────────────────────► CANCELED (explicit cancel, or
   │                                               cancelAtPeriodEnd reaching its date)
   │
   └──────────────────────────────────────────► CANCELED (dunning exhausted or a hard
                                                   decline trying to convert the trial to
                                                   a real charge, or an explicit cancel
                                                   during trial)
```

- **`TRIALING`**: created with `trialDays > 0`. No charge has happened yet
  — see "Trials" below for what that does and doesn't verify.
- **`ACTIVE`**: the current period is paid for. Set the moment a charge
  succeeds, whether that's the very first charge (no trial), a trial
  converting to a real charge, or an on-time/late renewal.
- **`PAST_DUE`**: the most recent billing attempt for the current period
  failed with a *retryable* reason, and the subscription hasn't
  exhausted its dunning attempts yet — it will be retried on the next
  sweep tick. A **hard decline** (see "Dunning" below) skips this state
  entirely and goes straight to `CANCELED` on the first attempt.
- **`CANCELED`**: terminal. Reached either by an explicit
  `POST /subscriptions/:id/cancel` call, or by the billing sweep — because
  dunning ran out of retryable attempts, because a hard decline made
  retrying pointless, or because `cancelAtPeriodEnd` was set and the
  period it was waiting for finally ended.

Unlike `PaymentStatus`, there's no explicit transition-validation table —
the aggregate's own methods (`recordSuccessfulCharge`,
`recordFailedCharge`, `finalizeCancellation`, `requestCancellation`) are
the only way to change state, and each already only makes sense from a
specific starting state (e.g. `requestCancellation()` is a no-op if
already `CANCELED`).

## Billing: how a period actually gets charged

`SubscriptionService.runBillingSweep()` runs daily (`@Cron`) and is also
exposed on demand (`POST /admin/subscriptions/run-billing`, same
dual on-demand + scheduled shape as `ReconciliationService`/
`ReserveService`). For every subscription whose `currentPeriodEnd` has
passed, it asks the aggregate what to do (`dueAction()`):

- **`CANCEL`** — `cancelAtPeriodEnd` was set and this period's end is the
  cancellation date. No charge is attempted; the subscription goes
  straight to `CANCELED`. Checking this *before* charging matters: a
  subscription due for period-end cancellation should never trigger one
  more charge just to immediately cancel it.
- **`CHARGE`** — anything else due. The sweep calls
  `PaymentCheckoutSaga.execute()` — the *exact same* saga a normal
  `POST /payments/charge` uses — with the subscription's stored amount,
  currency, and `paymentMethodId`, and no `binInfo` (there's no live card
  entry happening for an off-session renewal; every PSP adapter and the
  smart-routing strategy already treat `binInfo` as optional). This means
  a renewal charge gets the same smart PSP routing, risk scoring, ledger
  booking — including the FX settlement conversion and reserve-withholding
  mechanisms described in
  [`ledger-and-settlement.md`](./ledger-and-settlement.md) — and 3DS
  handling a one-time charge gets, rather than a second, drifting
  implementation of "charge a card."

On success, `recordSuccessfulCharge()` advances the period: the new
`currentPeriodEnd` is the *old* `currentPeriodEnd` plus one interval —
anchored to the schedule, not to whenever the charge actually happened.
This matters for dunning: a subscription that failed on its due date and
finally succeeds three days later on a retry still bills its *next*
period on the original cadence, rather than the retry delay quietly
pushing every future billing date back.

## Dunning: decline-code-aware retry vs. immediate cancellation

On failure, `recordFailedCharge(now, maxAttempts, errorCode?)` first
classifies *why* the charge failed via `classifyDeclineCode(errorCode)`:

- **`HARD_DECLINE`** — `errorCode` is one of a known set of
  non-retryable decline reasons (`HARD_DECLINE_CODES` in
  `subscription.aggregate.ts`: `stolen_card`, `lost_card`, `fraudulent`,
  `pickup_card`, `restricted_card`, `expired_card`). Retrying these is
  actively harmful, not just futile — a real system that keeps
  representing a card reported stolen risks the acquirer flagging the
  merchant account itself. The subscription skips the retry schedule
  entirely and goes straight to `CANCELED` on the very first attempt,
  regardless of `failedAttempts`.
- **`RETRYABLE`** — anything else, including no `errorCode` at all (a
  routing failure that never reached a PSP — e.g. no provider available
  for a currency — has no decline code to classify, and is treated the
  same as a generically retryable decline). This is the existing
  behavior: `failedAttempts` increments and does **not** advance
  `currentPeriodEnd` — so the subscription stays "due" but does *not*
  retry on the very next sweep tick. It sets `nextRetryAt` from a fixed
  backoff schedule (`RETRY_SCHEDULE_DAYS = [1, 3, 7]`, indexed by which
  attempt just failed), and `dueAction()` returns `NONE` for a
  `PAST_DUE` subscription until that time arrives. 1 initial attempt + 3
  retries — spread day 1, day 3, day 7 after each failure — before
  `failedAttempts` reaches `MAX_DUNNING_ATTEMPTS` (4) and the
  subscription is canceled anyway (`dunning_exhausted`, not
  `hard_decline`).

The decline code itself is threaded end-to-end from the PSP response:
`PSPAdapterPort`'s charge result already carries an `errorCode` on a
decline (used elsewhere for observability), `PaymentCheckoutSaga`
surfaces it on `CheckoutSagaResult.errorCode` when a charge attempt
ends in `FAILED`, and `runBillingSweep()` passes it straight into
`recordFailedCharge()`. It's stored on the subscription as
`lastDeclineCode` — visible on `GET /subscriptions/:id` — and cleared
the moment a later charge succeeds (`recordSuccessfulCharge()` resets
it to `undefined`), so it always reflects *only* the most recent
attempt, never a stale reason from a since-resolved failure.

This only applies to a real PSP-returned decline. The routing-exception
path (no PSP available at all, a thrown error rather than a normal
`{ success: false }` response) is unaffected — it still calls
`recordFailedCharge(now, maxAttempts)` with no third argument, which
`classifyDeclineCode(undefined)` treats as `RETRYABLE`, preserving the
exact pre-existing retry behavior for that case.

Both `subscription.past_due` (on every failure that doesn't cancel) and
`subscription.canceled` are emitted as real `EventEmitter2` events from
`SubscriptionService` — not just a log line — the same "closes the
*emission* gap, not the *someone's listening* gap" posture
`DisputeService`'s `dispute.created`/`dispute.resolved` events already
established. Nothing in this codebase actually subscribes to either
yet. Both payloads now carry the decline code where relevant:
`subscription.past_due` always includes `declineCode` (possibly
`undefined`, e.g. for a routing-exception failure), and
`subscription.canceled` includes a `reason` of `'hard_decline'` (with
`declineCode` set) or `'dunning_exhausted'` (with no `declineCode`) so
a listener can tell the two cancellation causes apart without
re-deriving it from `lastDeclineCode`.

This is a real, working dunning policy, but still a simplified one —
worth being explicit about what's still missing:
- **The hard-decline code set is illustrative, not calibrated.**
  `HARD_DECLINE_CODES` is a small, reasonable-looking set of Stripe/Adyen-
  style codes, not validated against real-world decline-code taxonomies
  or acquirer-specific variations (a real system would likely need this
  configurable per-PSP, and to handle codes neither mock PSP currently
  returns, e.g. `do_not_honor`).
- **No real notification integration.** The events exist and are really
  emitted, but nothing is actually subscribed to them — no email, no
  Slack, no paging. The same stand-in posture as every other "alert
  on-call in production" gap already documented elsewhere in this
  codebase (`ReconciliationService`, `LedgerOutboxRelayService`, the
  `Dispute` creation/resolution flow).

## Trials

`trialDays` on creation skips the first *charge* entirely — the
subscription starts `TRIALING` with `currentPeriodEnd` set to
`now + trialDays`, and no `Payment` is created until that period ends
and the sweep attempts the real first charge (which then follows the
exact same success/dunning logic as any renewal). It does **not** skip
validating the payment method, though: before the `Subscription` is even
created, `SubscriptionService.verifyPaymentMethodOrThrow()` calls a real
PSP verification primitive — `PSPAdapterPort.verifyPaymentMethod()` —
that confirms the card is real and chargeable *without* moving any
money, so a trial that's about to convert doesn't discover the card was
invalid only when it finally tries to charge it weeks later. A failed
verification (`SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED`, 422)
means no `Subscription` is created at all — the same "don't persist
something that was never actually able to start" posture the no-trial
path already has for a failed first charge.

The two PSP adapters implement this two different, both realistic, ways
— there's no single universal "$0 auth" API across providers:
- **Stripe**: a real SetupIntent (`POST /v1/setup_intents`,
  `usage: 'off_session'`) — Stripe's actual purpose-built primitive for
  confirming a payment method for a future off-session charge.
- **Adyen**: a zero-value authorization (`amount.value: 0`,
  `shopperInteraction: 'ContAuth'`) — the pattern real Adyen supports for
  validating a stored credential, since Adyen has no separate
  SetupIntent-shaped API the way Stripe does.

Routed through the exact same smart-routing/fallback path a real charge
uses (`AcquirerRoutingService.executeWithSmartRouting()`) — a PSP outage
falls back to the other provider the same way a charge would, but an
actual decline (the PSP genuinely says the card is bad) does not, since
`executeWithFallback()` only retries on a *thrown* error and a declined
verification is a normal `{ success: false }` return value. This also
means a currency neither mock PSP supports fails trial creation
immediately with the same `SUBSCRIPTION_PAYMENT_METHOD_VERIFICATION_FAILED`
error, for the same underlying reason a real charge in that currency
would fail routing.

## Crash-recovery: how a renewal charge avoids double-billing

The billing sweep is not wrapped in one database transaction with the
saga's own internal transaction — `PaymentCheckoutSaga.execute()` manages
its own commit (payment + ledger entries) internally, and changing its
signature to accept an external transaction manager for one caller would
affect every caller. That leaves a real gap: if the process crashes
*after* the saga commits a successful charge but *before* the sweep
advances the subscription's period, what stops the next sweep tick from
charging the same period again?

The fix: each subscription+period is charged under a **deterministic**
payment id — `uuidv5(`${subscriptionId}:${currentPeriodEnd}`)` — reused as
both the `Payment`'s primary key and its idempotency key. Before charging,
the sweep checks whether a payment with that exact id already exists and
is `SUCCEEDED`. If so, this period was already paid (the crash-recovery
case); the sweep just advances the subscription without charging again.
If not, it proceeds to charge normally. A retried *failed* attempt for
the same period reuses the same row via `PaymentAggregate.create()` +
`save()`'s upsert behavior — the same underlying `Payment` record
represents every attempt at a given period's invoice, not a fresh one per
try.

This was verified directly, not just reasoned about: `test/subscriptions.e2e-spec.ts`
fabricates a `Payment` row with the exact deterministic id a due
subscription's period would produce, marks it `SUCCEEDED` with a sentinel
`pspTransactionId`, runs the sweep, and confirms both that the
subscription advanced correctly *and* that the sentinel value survived —
proving the sweep recognized the period as already paid rather than
re-running the charge (which would have overwritten the row and erased
the sentinel).

## Plans and proration

A subscription doesn't have to carry its own amount/interval directly.
`Plan` (`plan.aggregate.ts`) is a small, reusable catalog entry — name,
amount, currency, interval, `intervalCount` — scoped to a merchant via
`POST /plans`. `POST /subscriptions` accepts either a `planId` (pricing
resolved from the plan at creation time) or the original direct
`amount`/`currency`/`interval` fields for a one-off, catalog-less
subscription; supplying neither throws a 422
(`SUBSCRIPTION_MISSING_PRICING`). A subscription created from a plan
stores the plan's terms *by value* at creation time (same reasoning as
`Payment` storing a settlement `Money` rather than a live FX lookup —
see [`ledger-and-settlement.md`](./ledger-and-settlement.md)): later
edits to the `Plan` row don't retroactively change subscriptions already
running under it.

`POST /subscriptions/:id/change-plan` switches an `ACTIVE` subscription
to a different plan, with proration for the remaining part of the
current period:

- The remaining fraction of the current period is
  `(currentPeriodEnd - now) / (currentPeriodEnd - currentPeriodStart)`,
  clamped to `[0, 1]`.
- The subscription is charged
  `(newPlan.amount - oldPlan.amount) * remainingFraction` — the
  extra cost of the new plan for the time left in the period.
- **Upgrades charge immediately; downgrades issue a credit for later.**
  If the new plan's prorated remaining value is less than the old
  plan's, `computeUpgradeProration()` returns `undefined` (no charge),
  and `computeDowngradeCredit()` — its exact mirror — returns the
  unused-portion difference instead. That credit is *not* refunded now;
  `applyDowngradeCredit()` stores it on the subscription
  (`pendingCredit`, accumulating across multiple downgrades), and the
  *next* billing charge subtracts it via `amountDueThisPeriod` before
  ever calling the PSP. `Money` still can't represent a negative amount
  (`Money.subtract()` throws), so the credit can only ever reduce a
  future charge, never push it below zero — a credit that fully covers
  (or exceeds) the next period's price makes that period's charge
  exactly `$0`, which the billing sweep recognizes and skips the PSP
  call for entirely (no `Payment` row is created for a fully-covered
  period), consuming only as much of the credit as that period actually
  used and carrying any remainder forward.
- When a charge is owed, it goes through
  `PaymentCheckoutSaga.execute()` — the same saga every other charge
  in this codebase uses — so a failed proration charge (issuer
  decline, PSP outage) throws a 422 (`PRORATION_CHARGE_FAILED`) and the
  plan change **does not** take effect; the subscription keeps its old
  plan/amount/interval. The plan switch and the proration charge
  succeed or fail together — there's no state where the subscription is
  on the new plan but the proration was never collected.
- Switching to a plan in a different currency throws a 409
  (`PLAN_CURRENCY_MISMATCH`) rather than silently converting — cross
  currency proration would need to decide *which* FX rate applies to a
  charge that's partly "old plan pricing" and partly "new plan
  pricing," which this implementation doesn't attempt.

A `Plan` can be deactivated (`POST /plans/:id/deactivate`) to stop new
subscriptions from being created against it — existing subscriptions
already running under that plan are unaffected, since (as above) they
hold their own copy of the terms rather than a live reference.

## What's still genuinely missing

See [`future-directions.md`](./future-directions.md#recurring-billing--subscriptions)
for the fuller business framing — in short: a real notification
integration subscribed to the `subscription.past_due`/
`subscription.canceled` events this system now actually emits, and a
properly calibrated (rather than illustrative) hard-decline code set.

One more concrete, code-level simplification worth flagging: interval
math for `'month'`/`'year'` uses JavaScript's native
`setUTCMonth()`/`setUTCFullYear()`, which overflows on a day that doesn't
exist in the target month — a subscription anchored on the 31st will
drift forward across any month shorter than 31 days (Jan 31 + 1 month
becomes Mar 3, not Feb 28). Real billing systems clamp to the target
month's last day instead; this implementation doesn't. See
`addBillingInterval()` in `subscription.aggregate.ts`.
