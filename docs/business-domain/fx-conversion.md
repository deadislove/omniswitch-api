# FX Conversion & Cross-Currency Settlement

This describes how a merchant can be paid out in a different currency
than they were charged in, how refunds/disputes net cleanly against
that, and the separate, purely-informational presentment-currency
feature. See [`ledger-accounting.md`](./ledger-accounting.md) for the
double-entry model these sections build on, and
[`future-directions.md`](./future-directions.md#cross-border-settlement--tax)
for what's still genuinely missing (VAT/tax handling, a hedging/rate-lock
product).

## FX conversion (merchant settlement currency)

`Money.convertTo()` used to be a value-object-level capability that
nothing in the application layer ever called with a real rate —
`FXRateSnapshot` existed, but no payment was ever actually converted.
Fixed with `FXRateProviderPort` (implemented by `FXRateProviderAdapter`,
which calls `scripts/mock-psp/server.js`'s `/fx/rates` endpoint — a
plausible mock, not a real market-data feed) and
`MerchantEntity.settlementCurrency`: a merchant can now be paid out in a
currency different from whatever currency a given charge was made in.
Null (the default) means "settle in whatever currency was charged" —
every merchant's behavior before this existed, and still the default for
every merchant that doesn't set one explicitly.

**Why this needs two ledger legs, not one extra entry.** A merchant
payout in a different currency than the charge can't just be a third
entry alongside the existing `PSP_SETTLEMENT`/`FEE` entries —
`validateDoubleEntry()` balances debits against credits *per currency*,
and a payout leg in a different currency would leave that currency group
permanently unbalanced. Standard double-entry treatment for a currency
conversion is two separately-balanced legs linked by a clearing account:

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `PSP_SETTLEMENT_ACCOUNT` | PSP_SETTLEMENT | DEBIT | gross amount | charge currency |
| `PLATFORM_FEE_ACCOUNT` | FEE | CREDIT | fee | charge currency |
| `FX_CLEARING_ACCOUNT` | FX_CLEARING | CREDIT | net amount | charge currency |
| `FX_CLEARING_ACCOUNT` | FX_CLEARING | DEBIT | converted net amount | settlement currency |
| `{merchantId}` | MERCHANT | CREDIT | converted net amount | settlement currency |

The first three rows balance exactly like a normal charge always has; the
last two balance on their own. `LedgerOutboxEvent.createChargeEntries()`'s
`settlementConversion` param produces this shape — `validateDoubleEntry()`
itself didn't need to change at all.

**Where this is wired in**: all three ledger-booking call sites
(`PaymentCheckoutSaga`, `PaymentLifecycleService.capture()`,
`WebhookProcessingService.markSucceeded()`) — the same three sites the
[fee model](./fee-model.md) is wired into, via
`ChargeLedgerParamsResolverService`. This used to be an identical private
method copy-pasted into all three (each one's own comment explicitly
flagged it as "kept local for a small helper, not worth a shared
service" — first for two callers, then noted again as a judgment call
once it became three); it was finally extracted when the reserve
mechanism (see [`risk-and-fraud.md`](./risk-and-fraud.md)) added a third
concern to the same lookup. An FX rate lookup failure does **not** fail the
charge or lose the ledger entry — funds have already moved by the time
this runs — it falls back to booking in the original charge currency and
logs an error, the same "degrade to a safe default, alert, don't lose the
entry" posture used everywhere else in this codebase that can't afford to
throw away a confirmed charge's bookkeeping.

Manage a merchant's settlement currency via `POST /admin/merchants`
(`settlementCurrency`, optional, at onboarding) or
`PATCH /admin/merchants/:id/settlement-currency` (send `null` to clear it
back to "settle in whatever currency was charged").

**The "clear it back to null" path needs `null`, not `undefined`**:
setting `merchant.settlementCurrency = undefined` and calling
`repository.save()` does **not** write SQL `NULL` — TypeORM's `save()`
silently omits `undefined` properties from the generated `UPDATE`, so
the *previous* value stays in Postgres despite the API response
reporting the field as cleared; a fresh `repository.findOne()` read
(rather than trusting the API response from the same call) is what
exposes this. Assigning `null` instead surfaces a *second*, entity-level
issue: TypeORM infers a column's SQL type from TypeScript's emitted
`design:type` metadata, and a `string | null` property reflects as bare
`Object`, which fails at `DataSource.initialize()` (`Data type "Object"
... is not supported`) — not a compile-time error, so it's easy to miss.
Fixed by adding an explicit `type: 'varchar'` to both affected columns.
The same `undefined`-instead-of-`null` bug applied to
`MfaService.disableMfa()` (`mfaSecretCiphertext = undefined`): merchants
who had disabled MFA still had their encrypted TOTP secret sitting in
the database despite `mfaEnabled: false` correctly gating login.
Harmless on its own (the value was always ciphertext, and `mfaEnabled`
already gated its use), but real stale-data hygiene a "disable" action
should actually deliver.

This closed the specific, narrow gap DEV_README used to flag ("nothing
calls `convertTo()` with a real provider"); the two remaining pieces —
refunds/lost disputes not netting cleanly, and no presentment-currency
support — are closed below.

## Refunds and lost disputes replay the original charge-time rate

A refund or a lost dispute used to always book against the merchant in
the *charge* currency, regardless of what they were actually paid out
in — for a merchant with an active settlement conversion, that's two
ledger lines (a USD refund debit, a EUR charge credit) that never net
against each other, silently leaving the merchant short-refunded or
over-refunded depending on which way the rate had moved since the charge.

Fixed by having `PaymentAggregate` remember the rate a charge/capture
actually used (`recordSettlementConversion()`, called once — a
partial-capture payment's settlement currency doesn't change between
captures, and even if it did, a refund needs one consistent rate to
replay, not whatever the merchant's settlement currency happens to be
*right now*) and having both `PaymentLifecycleService.refund()` and
`DisputeService`'s `LOST` resolution path (see
[`disputes.md`](./disputes.md)) convert their clawback amount using that
*same* stored rate before booking.
`LedgerOutboxEvent.createRefundEntries()` gained the identical
two-leg-via-`FX_CLEARING` shape `createChargeEntries()` already had, just
with every entry type flipped (reversing a payout, not creating one):

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `PSP_SETTLEMENT_ACCOUNT` | PSP_SETTLEMENT | CREDIT | refund amount | charge currency |
| `FX_CLEARING_ACCOUNT` | FX_CLEARING | DEBIT | refund amount | charge currency |
| `FX_CLEARING_ACCOUNT` | FX_CLEARING | CREDIT | converted refund amount | settlement currency |
| `{merchantId}` | MERCHANT | DEBIT | converted refund amount | settlement currency |

Deliberately the *original* rate, not a fresh lookup — refunding at a
different rate than the money was paid out at would just create a new
mismatch instead of fixing the old one. This is also, functionally, this
system's answer to "who bears FX risk between charge and settlement
time": by locking the rate at charge time and reusing it verbatim for
that payment's entire lifecycle (capture, refund, dispute loss), the
platform absorbs whatever the market does *after* that point — the
merchant always nets to exactly what they were originally quoted, never
less, never more, regardless of where the rate moves before a refund
happens to land.

## Presentment currency

`POST /payments/charge` accepts an optional `presentmentCurrency` —
what the customer's own statement should show, if different from the
currency actually charged/settled. Purely informational: the response
includes a computed `presentmentAmount` (via the same
`FXRateProviderPort` the settlement conversion uses), but nothing about
the charge, capture, or ledger changes — confirmed by asserting every
ledger entry for a presentment-converted charge stays in the real charge
currency. A failed/unsupported presentment lookup never fails the
charge — the response just omits `presentmentAmount`, logged as a
warning, not an error propagated to the caller.

**Deliberately not persisted** — there's no `payments` column recording
what presentment amount/currency was shown for a given charge, so there's
no way to reconstruct "what did we tell this customer they'd be charged"
after the response is gone. A real implementation supporting
customer-facing support/dispute-resolution workflows would need to keep
this, the same way `settlementConversion` is now kept for the
merchant-payout side.

## Cross-border tax record (Phase 1)

An **audit record, not a tax calculation** — this platform doesn't
compute owed tax, file returns, or determine real nexus.
`PaymentAggregate.recordTaxRecord()` records, at the same 4
ledger-booking call sites and under the same condition as
`settlementConversion` above (a merchant's settlement currency differs
from the currency actually charged), a `taxRecord`:

```
{ jurisdiction, jurisdictionBasis: 'card-issuing-country',
  collectedAmountMinorUnits, currencyCode, capturedAt }
```

`jurisdiction` is the cardholder's `BinInfo.country` — the only
jurisdiction-relevant signal already captured at charge time. A real tax
engine would also weigh the merchant's own nexus, the customer's billing
address, and product-category rules, none of which this platform
tracks — `jurisdictionBasis` is pinned to `'card-issuing-country'`
specifically so this simplification is explicit in the data itself, not
just in a comment. `collectedAmountMinorUnits`/`currencyCode` record what
the customer actually paid (the charge amount, in its original
currency) — cross-border tax exposure is a function of what the customer
paid, not what the merchant received after FX conversion.

Recorded once, like `settlementConversion` (a later capture of an
already-cross-border payment doesn't produce a second, possibly
different jurisdiction call). Never produced at all when there's no
`BinInfo` to derive a jurisdiction from — a subscription renewal, for
instance, never carries one (see [`subscriptions.md`](./subscriptions.md)).
See `src/modules/payment/domain/services/tax-record.ts` and
`test/tax-record.e2e-spec.ts`.
