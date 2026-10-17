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
`createRefundEntries` — not something this code currently does.

### When entries are written — this matters more than it looks

Ledger entries are written **only at the moment funds are actually
confirmed**, atomically (same DB transaction) with the payment status
transition that confirms them:

- Immediate capture: in `PaymentCheckoutSaga`, inside the `SUCCEEDED` branch
  — after the PSP has actually returned success, rather than when the
  payment intent is first created.
- Manual capture: in `PaymentLifecycleService.capture()`, when the capture
  call to the PSP succeeds — once per capture call, for that call's own
  amount, whether or not it's the one that completes the authorization
  (partial captures are real money moving rather than a placeholder
  awaiting correction later; see `payment-lifecycle.md`'s Capture
  accounting section).
- Async/3DS-confirmed: in `WebhookProcessingService`, when a
  `payment_intent.succeeded`/`AUTHORISATION` webhook confirms a payment that
  was `PROCESSING` or `REQUIRES_ACTION`.
- Manually-resolved ambiguous outcome: in
  `AmbiguousPaymentService.bookSucceeded()`, when an operator resolves a
  payment whose PSP outcome couldn't be determined automatically (see
  [`risk-and-fraud.md`](./risk-and-fraud.md)) to `SUCCEEDED`.

This is intentional, and the result of a bug fix rather than the
original design: entries used
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
`LedgerOutboxPort.markFailed`); nothing retries it automatically. A
separate
5-minute sweep (`detectStaleEvents`) logs an alert for anything that's been
`PENDING` for more than 5 minutes without ever being attempted (which only
happens if the relay crashed mid-batch or genuinely fell behind) — it
doesn't resubmit `FAILED` events on its own. Resetting a `FAILED` event back
to `PENDING` is a deliberate operator action rather than an automatic
one — done via `POST /admin/outbox/:id/retry` (ADMIN/OPERATOR only),
never a manual SQL update against production.

## Merchant statements

A real acquirer/PSP gives each merchant a periodic (usually monthly)
statement — a human-readable summary of volume, fees, chargebacks, and
net settlement for the period, the document a merchant's own
bookkeeper actually reconciles against rather than raw API/webhook data
they'd otherwise have to aggregate themselves. `MerchantStatementService`
packages exactly that, and closer to reporting/aggregation work than new
business logic — every number on a statement already exists somewhere
in the ledger.

`MerchantStatementService.computeBreakdowns()` walks every
`LedgerOutboxPort.findCreatedBetween()` event in the period once and
buckets this merchant's own `MERCHANT`-type entries by currency (a
merchant can accumulate balances in more than one currency within a
single period, same reasoning `PayoutService.runSweepLocked()` already
documents for its own per-currency `Payout` split — so one statement
carries one breakdown per currency it actually saw activity in):

| Field | Source |
|---|---|
| `grossVolume` / `platformFee` / `providerFee` | `PAYMENT_CHARGED`/`BNPL_CAPTURED` events where this merchant is the only `MERCHANT`-type entry (a non-split charge) — `grossVolume` is reconstructed as `MERCHANT` credit + `FEE` + `BNPL_PROVIDER_FEE` from that same event, since the entries alone only ever record the net-of-fee credit |
| `refundedAmount` | `MERCHANT` debits from `PAYMENT_REFUNDED`/`BNPL_REFUNDED` events |
| `chargebackCount` / `chargebackAmount` | `DisputePort.findByMerchantStatusInRange()` — `LOST` disputes *received* in the period, not resolved in it (see that method's own docblock for why) |
| `marketplaceSplitProceeds` | Net of this merchant's `MERCHANT` credits/debits from events with *more than one* `MERCHANT`-type entry — i.e. a split charge |
| `netSettlement` | The literal net balance of **every** `MERCHANT`-type entry for this merchant in the period, regardless of event type or split-ness |

**Why `grossVolume`/`platformFee`/`providerFee` exclude splits.** A split
charge shares one ledger event across multiple merchants (the charging
platform merchant plus each connected recipient) with a single
`PSP_SETTLEMENT`/`BNPL_SETTLEMENT` debit for the whole transaction —
there's no way to attribute one party's "share" of the pre-fee gross
from the entries alone without re-deriving the original split
percentages. Rather than guess, a split-sourced credit/debit is kept out
of that breakdown entirely and reported separately as
`marketplaceSplitProceeds` — a connected merchant's split proceeds are
already covered by its own `Payout` record
([`marketplace-and-payouts.md`](./marketplace-and-payouts.md)); this
statement doesn't re-model that, just surfaces the same number from a
different angle.

**Why `netSettlement` is never derived from the fields above.** It's
computed independently, directly from the ledger, the same way
`PayoutService.runSweepLocked()` already trusts "sum of this merchant's
`MERCHANT`-type entries" as what actually moved. That means it always
reconciles against the real ledger by construction — split proceeds
included — even in the one case (a split charge) where the breakdown
above can't fully attribute every contributing event to one party.

**`refundedAmount` and `chargebackAmount` overlap on purpose.** A lost
dispute books through the exact same `createRefundEntries()` path as an
ordinary refund (see `DisputeService`) — there's no separate ledger
shape for "chargeback reversal." `chargebackAmount`/`chargebackCount`
exist to answer "how many disputes, and for how much" as their own
question; they're not a second deduction on top of `refundedAmount`.

**Generation is idempotent on `(merchantId, periodStart, periodEnd)`,
never overwritten** — `MerchantStatementService.generateForMerchant()`
returns the existing statement if one already exists for that exact
period rather than recomputing. A closed period's ledger history
doesn't change after the fact by the time a statement is generated for
it, so regenerating is expected to produce identical numbers; this
guards against a statement a merchant has already looked at silently
changing underneath them.

A monthly `@Cron` sweep (`runMonthlySweep`, noon on the 1st) generates
last calendar month's statement for every active merchant, skipping any
merchant with zero ledger activity in the period — no empty row. The
same `generateForMerchant()` also backs `POST
/admin/merchants/:id/statements/generate`, which always generates (even
an all-zero one) since that's an explicit operator request rather than a
blanket sweep. A merchant reads their own via `GET /statements`/`GET
/statements/:id`; an operator reads any merchant's via `GET
/admin/merchants/:id/statements`.
