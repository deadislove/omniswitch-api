# Ledger Accounting

This describes how every money movement gets recorded and balanced — the
double-entry model and the outbox pattern that publishes it reliably. See
[`fee-model.md`](./fee-model.md) for merchant fee-rate calculation,
[`fx-conversion.md`](./fx-conversion.md) for cross-currency settlement,
and [`marketplace-and-payouts.md`](./marketplace-and-payouts.md) for
split/payout accounting — all three compose with the model here rather
than replacing it.

## Double-entry bookkeeping model

Every money movement produces a `LedgerOutboxEvent` with a set of
`LedgerEntry` rows that must balance — total debits equal total credits, per
currency (`LedgerOutboxEvent.validateDoubleEntry()` enforces this in the
constructor; it's not optional bookkeeping hygiene, malformed entries throw
before they can ever be persisted).

### Charge entries (`createChargeEntries`)

For a successful charge of amount `A` with platform fee `F` (see
[`fee-model.md`](./fee-model.md) for how `F` is actually computed):

| Account | Type | Entry | Amount |
|---|---|---|---|
| `{merchantId}` | MERCHANT | CREDIT | `A - F` (net amount) |
| `PLATFORM_FEE_ACCOUNT` | FEE | CREDIT | `F` |
| `PSP_SETTLEMENT_ACCOUNT` | PSP_SETTLEMENT | DEBIT | `A` (gross amount) |

Reading this as a story: the PSP settlement account is debited the full
gross amount (money is *leaving* the PSP settlement pool), and it's split
between what the merchant is credited (net of fee) and what the platform
keeps as fee revenue.

### Refund entries (`createRefundEntries`)

The exact reverse for the refunded amount `R`:

| Account | Type | Entry | Amount |
|---|---|---|---|
| `{merchantId}` | MERCHANT | DEBIT | `R` |
| `PSP_SETTLEMENT_ACCOUNT` | PSP_SETTLEMENT | CREDIT | `R` |

Note refunds don't reverse the platform fee — a refunded charge still cost
the platform whatever fee it paid the PSP (and, in most real fee schedules,
platform fees aren't refunded to the merchant either). If your fee model
should refund the fee proportionally, that's a deliberate change to make in
`createRefundEntries`, not something this code currently does.

### When entries are written — this matters more than it looks

Ledger entries are written **only at the moment funds are actually
confirmed**, atomically (same DB transaction) with the payment status
transition that confirms them:

- Immediate capture: in `PaymentCheckoutSaga`, inside the `SUCCEEDED` branch
  — after the PSP has actually returned success, not when the payment
  intent is first created.
- Manual capture: in `PaymentLifecycleService.capture()`, when the capture
  call to the PSP succeeds — once per capture call, for that call's own
  amount, whether or not it's the one that completes the authorization
  (partial captures are real money moving, not a placeholder to correct
  later; see `payment-lifecycle.md`'s Capture accounting section).
- Async/3DS-confirmed: in `WebhookProcessingService`, when a
  `payment_intent.succeeded`/`AUTHORISATION` webhook confirms a payment that
  was `PROCESSING` or `REQUIRES_ACTION`.

This is intentional and was a bug fix, not the original design: entries used
to be written speculatively at payment-intent creation (`PENDING`), before
any PSP was ever contacted. That double-booked money that was never actually
charged whenever routing or the PSP call failed, and — once manual capture
existed — produced two `PAYMENT_CHARGED` entries for one payment (once at
authorization, once at capture). **If you add a new path that transitions a
payment to `SUCCEEDED`, it needs to book its own ledger entry at that exact
point — don't assume one was already written earlier in the flow.**

## The Outbox pattern and the relay

Writing a ledger entry to Postgres and publishing it somewhere else (an
event bus, a downstream accounting system) can't be a single atomic
operation across two different systems. The Outbox pattern sidesteps this:
write the event to a `PENDING` row in the *same* database transaction as the
state change it represents (so it's guaranteed to exist if and only if the
state change committed), then have a separate process (`LedgerOutboxRelayService`,
a cron job on a 10-second tick) pick up `PENDING` rows and publish them,
marking each `PUBLISHED` only after the publish succeeds.

In this codebase "publish" means emitting on the in-process `EventEmitter2`
bus (`ledger.outbox.published`) — there's no external message broker wired
up. That emit is the integration point where a production deployment would
instead push to Kafka/SNS/a real accounting system's API. The
reliability contract (poll → publish → mark-published-only-on-success →
retry/alert on failure) is what's real here; the transport is a stand-in.

A publish failure marks the event `FAILED` (terminal — see
`LedgerOutboxPort.markFailed`), not retried automatically. A separate
5-minute sweep (`detectStaleEvents`) logs an alert for anything that's been
`PENDING` for more than 5 minutes without ever being attempted (which only
happens if the relay crashed mid-batch or genuinely fell behind) — it
doesn't resubmit `FAILED` events on its own. Resetting a `FAILED` event back
to `PENDING` is a deliberate operator action, not automatic — done via
`POST /admin/outbox/:id/retry` (ADMIN/OPERATOR only), not a manual SQL
update against production.
