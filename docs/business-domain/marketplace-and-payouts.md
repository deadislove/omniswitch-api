# Marketplace Splits & Payouts

This describes how a platform merchant routes part of a charge to
connected merchants, how that gets swept into scheduled payouts, and how
KYC gates whether a payout can actually move real money. See
[`ledger-accounting.md`](./ledger-accounting.md) for the underlying
double-entry model, and
[`future-directions.md`](./future-directions.md#marketplace--split-payments)
for what's still genuinely missing.

## Marketplace splits

A `MerchantEntity` can now be a `PLATFORM` (the default — every merchant
that existed before this is one, unchanged) or a `CONNECTED` account
onboarded under a specific platform (`platformMerchantId`). This is the
first "not a flat peer" relationship between merchants this system
models.

`POST /payments/charge` accepts an optional `splits` array — a platform
merchant routing part of a charge's net proceeds directly to one or more
of its own connected merchants, the same shape Stripe Connect/Adyen for
Platforms call a "destination charge with an application fee." Each split
becomes its own `MERCHANT` credit in the charge's ledger entries, keyed by
the recipient's own `merchantId`:

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `{connectedMerchantId}` | MERCHANT | CREDIT | split amount | charge currency |
| `{platformMerchantId}` | MERCHANT | CREDIT | payout amount − Σ splits | charge currency |

A split doesn't have to add up to the full payout — whatever's left after
every split still goes to the charging (platform) merchant. The platform
credit is only omitted entirely when the splits exhaust the payout amount
exactly (see `LedgerOutboxEvent.createChargeEntries()`'s `splits` param).
There's no new account type for this — a connected merchant's split
credit lands on the same `MERCHANT`-type ledger row a direct charge to
that merchant would produce, so `GET /admin/reserves` and every other
merchant-scoped ledger query already work against it unmodified.

**Validated before the PSP is ever called, not after.** Every split
recipient must be an active `CONNECTED` merchant whose
`platformMerchantId` matches the charging merchant
(`SPLIT_RECIPIENT_INVALID`, 422), and the split total can't exceed the
net (post-fee, post-reserve) payout amount (`SPLIT_EXCEEDS_NET_AMOUNT`,
422). `ChargeLedgerParamsResolverService.resolve()` — which does this
validation — used to only ever run *after* a successful PSP charge (see
its callers in `PaymentCheckoutSaga`/`PaymentLifecycleService`), because
until splits existed it could never fail (an FX lookup failure there was
already handled by silently falling back, not throwing). Adding a
validation path that *can* throw meant it had to move earlier —
`PaymentCheckoutSaga.execute()` now resolves and validates these
parameters right after the payment intent is created, before routing or
charging, and reuses that same result after a successful charge instead
of re-resolving. Discovering an invalid split only after the customer's
card was actually charged would leave a real charge with no ledger entry
and no way to undo it — the saga has no compensating "reverse a completed
PSP charge" step, unlike the pre-charge failure paths it already has.

**Deliberately not supported** in this first phase:
- **Manual capture.** A split charge requires `captureMethod: "automatic"`
  (`SPLIT_REQUIRES_AUTOMATIC_CAPTURE`, 409) — `PaymentLifecycleService.capture()`
  doesn't accept `splits`, so a split requested on a manual-capture charge
  would silently be dropped at capture time rather than routed to the
  connected merchant. Rejecting it up front is more honest than silently
  losing the split.
- **No connected-account KYC/onboarding review** before the account can
  start *receiving* splits — see "Connected-account KYC" below for what
  KYC actually gates instead.

### Splits × each party's own settlement-currency conversion (Phase 2)

A split and a settlement-currency conversion now compose — each split
recipient can have their own `settlementCurrency`, independent of the
charging (platform) merchant's own, and both can be active on the same
charge with different rates:

| Account | Entry | Amount | Currency |
|---|---|---|---|
| `{connectedMerchantId}` | CREDIT | split amount, converted at *that recipient's* rate if they have a `settlementCurrency` | recipient's settlement currency, or charge currency if unset |
| `{platformMerchantId}` | CREDIT | (payout amount − Σ splits), converted at the *platform's own* rate if it has a `settlementCurrency` | platform's settlement currency, or charge currency if unset |

The platform's own conversion applies to what's left over **after** all
splits are carved out (the remainder), not the full payout — see
`ChargeLedgerParamsResolverService.resolve()`. Each conversion is resolved
and can fail independently: an FX lookup failure for one recipient falls
back to booking that recipient in the charge currency without affecting
any other recipient's conversion or the platform's own. Refunds and lost-
dispute clawbacks replay each side's *original* charge-time rate (not a
fresh lookup) — see `LedgerOutboxEvent.createRefundEntries()`.

### Reversing a split on refund or dispute loss

`PaymentAggregate.recordSplits()` remembers the *original* charge-time
`splits` (recorded once, immutable — same posture as
`recordSettlementConversion()`, see [`fx-conversion.md`](./fx-conversion.md)),
so `PaymentLifecycleService.refund()` and a lost dispute's clawback
(`DisputeService.resolveByPspDisputeId()`, see [`disputes.md`](./disputes.md))
both reverse each recipient's share **proportionally**, instead of only
ever debiting the charging (platform) merchant's own account regardless
of how the charge was split:

- Each connected merchant's debit is
  `split.amount × (refundAmount / originalChargeAmount)`, computed in
  integer minor units (floor division), not floating-point fractions.
- The platform absorbs whatever's left —
  `refundAmount − Σ(connected debits)` — the same "remainder goes to the
  platform" shape the original charge-time split used, just reversed. This
  also absorbs any rounding: a full refund (`refundAmount ==
  originalChargeAmount`) reproduces each split's *exact* original amount
  with zero drift, and a partial refund can never claw back more than
  `refundAmount` in total no matter how many recipients there are, since
  the sum of independently-floored shares is always ≤ the real-valued
  total.
- A full refund therefore debits the connected merchant its exact
  original split amount, and debits the platform `originalChargeAmount −
  Σ splits` — **not** the platform's actual net-of-fee remainder from
  charge time. This matches existing (pre-split) refund behavior exactly:
  a refund has never given back the platform fee, splits or not (see
  `createRefundEntries()`'s docblock) — a refunded merchant's account has
  always been debited the raw refund amount, never a fee-adjusted one.

**A real bug found building this, not just during testing**: `splits`
used to only be recorded on the `Payment` aggregate inside
`PaymentCheckoutSaga`'s `SUCCEEDED` branch — the *immediate*-capture path.
A charge that instead came back `REQUIRES_ACTION` (a 3DS challenge) skips
that branch entirely; the charge is only actually confirmed later, when
`WebhookProcessingService.markSucceeded()` processes the PSP's webhook —
by which point it only has the persisted `Payment` row to work with, not
the original request. Recording `splits` only in the immediate-success
branch meant a split charge that happened to need a 3DS challenge would
silently lose its split the moment the challenge completed — the ledger
entry would book as an ordinary, unsplit charge. Fixed by recording
`splits` on the payment intent immediately after `ChargeLedgerParamsResolverService.resolve()`
validates them, *before* the PSP is ever called, regardless of how the
charge eventually resolves — the same payment-intent row
`WebhookProcessingService` re-fetches already carries them by the time the
webhook arrives. Verified directly: `test/marketplace-split-refunds.e2e-spec.ts`
forces a 3DS challenge on a split charge (the same `FORCE_3DS` mock-PSP
marker `webhooks.e2e-spec.ts` uses) and confirms the split still books
correctly once the webhook resolves it.

### Payout scheduling for connected accounts

A split's `MERCHANT` credit lands on the connected merchant's ledger
balance the instant the charge succeeds — the same as a direct charge.
`PayoutService` batches that balance into scheduled `Payout` records
instead, withholding a rolling reserve
(`MerchantEntity.payoutReserveBps`/`payoutReserveHoldDays`, set via
`PATCH /admin/merchants/:id/payout-reserve-policy`) the way a real
marketplace processor (Stripe Connect, Adyen for Platforms) does — the
same dual on-demand + scheduled shape as `ReconciliationService`/
`ReserveService`:

- **`POST /admin/marketplace/run-payouts`** (daily `@Cron`, or on demand)
  reads every `LedgerOutboxEvent` created since the *previous* sweep's
  window end — tracked by its own `PayoutSweepRun` cursor record, written
  on every invocation regardless of outcome so the window always advances
  monotonically even when nothing was found — sums each account's net
  `MERCHANT`-entry balance (credits positive, debits from a refund/lost
  dispute reversal negative), and for every **`CONNECTED`** merchant with
  a positive balance, creates one `Payout`: `grossAmount` (the swept net
  credit), `reserveAmount` (`grossAmount × payoutReserveBps`, withheld),
  `netAmount` (the remainder, immediately disbursable). A `PLATFORM`
  merchant's own charge proceeds are never turned into a `Payout` — this
  mechanism only applies to money a split routed to a connected account.
- **`POST /admin/marketplace/release-eligible-reserves`** (daily `@Cron`,
  or on demand) releases every `Payout`'s reserve whose
  `releaseEligibleAt` (`now + payoutReserveHoldDays` at sweep time) has
  passed; `POST /admin/marketplace/payouts/:id/release-reserve` is an
  operator's manual override, same `force` semantics as
  `ReserveService.release()`.

**The `netAmount`/`reserveAmount` split itself does not move any ledger
money.** Unlike the charge-time reserve (`ReserveHold`, see
[`risk-and-fraud.md`](./risk-and-fraud.md), which withholds via a real
`RESERVE`-account ledger entry), that split is a pure scheduling overlay:
the split's `MERCHANT` credit already correctly represents what the
connected merchant is owed, and stays untouched throughout. It just
tracks, separately, how much of that balance has been confirmed
disbursable in a given sweep versus held back as a rolling reserve — the
same distinction a bank's "ledger balance" and "available balance" draw.
*Actually sending* `netAmount` somewhere real is a separate action — see
"Payout KYC gating and real transfer initiation" below.

A `Payout`'s window can only start from `windowStart = new Date(0)` the
very first time `runSweep()` ever executes, so a very long-running
deployment's first sweep would scan its entire ledger history once —
acceptable for a reference system, a production one would want to seed
the cursor at deployment time instead.

### Connected-account KYC

Creating a `CONNECTED` merchant used to be the same instant,
unconditional `POST /admin/merchants` call as any other merchant — no
identity/business verification at all before an account could start
receiving payouts, which a real marketplace can't skip (payment
processors have real regulatory obligations here — see
[`compliance-and-security.md`](./compliance-and-security.md#amlkyc-why-payouts-are-gated-and-charges-arent)
for the business framing). `MerchantEntity.kycStatus`
(`NOT_STARTED` | `PENDING_REVIEW` | `VERIFIED` | `REJECTED`) now gates
that, via `POST /admin/merchants/:id/kyc/submit` (`{ legalName, taxId }`)
calling `KYCProviderPort.verify()` — a real HTTP call to an external
verification service, not a database flag an operator flips by hand.

**KYC gates payouts, not charges** — a `CONNECTED` merchant with
`kycStatus: 'NOT_STARTED'` can still be a split recipient and accumulate
real `MERCHANT` ledger credit exactly as before; nothing in
`ChargeLedgerParamsResolverService.resolve()`'s split validation reads
`kycStatus` at all. This deliberately mirrors real Stripe Connect's
`charges_enabled`/`payouts_enabled` distinction — a connected account's
two capabilities are independent, and conflating them (blocking a
platform from routing money to a seller just because that seller hasn't
finished onboarding yet) would be a real, unnecessary restriction this
system has no reason to impose. What KYC *does* gate is described next.

**Two interchangeable providers, one real async review.**
`KYCProviderPort` has two implementations — `MockKYCProviderAdapter`
(synchronous, local dev/test default) and `PersonaKycProviderAdapter` (a
real, async-reviewing provider) — selected by `KYC_PROVIDER`
(`mock`/`persona`) at DI-container build time
(`merchant.module.ts`'s `useFactory` binding), the same idiom
`BankTransferPort` uses for `BANK_TRANSFER_PROVIDER`. The mock still
resolves straight to `VERIFIED`/`REJECTED` in the same call — no
`PENDING` sitting in the database for days — but the real adapter
doesn't pretend to review instantly: `verify()` returns `PENDING`, the
merchant sits in `kycStatus: 'PENDING_REVIEW'` (with
`kycApplicationId` set, so the eventual decision can find it again), and
the actual decision (`VERIFIED`/`REJECTED`) arrives later via
`POST /webhooks/kyc`, verified by `KycWebhookGuard` — the same
"accept now, confirm later, verify the confirmation's signature" shape
this codebase already uses for the ACH/wire bank-transfer rails and PSP
webhooks. `scripts/mock-psp/server.js`'s `/persona/kyc-applications`
endpoint exercises this real, two-phase flow end-to-end (including a
real signed async callback) — same honest posture as
`docs/technical/tests/contract-testing.md` toward the Stripe/Adyen
sandbox: the mechanism is real and genuinely runnable, but no real
Persona/Onfido account has ever actually been called with real
credentials. `POST /admin/merchants/:id/kyc/submit` is re-callable
after a `REJECTED` decision (a merchant re-applying with corrected
information) against either provider.

**KYC submission also re-screens sanctions.** The `legalName` submitted
here doesn't only feed `KYCProviderPort` — it also re-runs sanctions/
watchlist screening at full confidence, superseding whatever
degraded-confidence result (based on the display `name` alone) this
merchant got at creation time, if it never supplied a `legalName` then.
A `HIT` at this step rejects the KYC submission outright rather than
just leaving `kycStatus` unchanged — see
[`risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening`](./risk-and-fraud.md#sanctionswatchlist-screening-onboarding--periodic-re-screening)
and [`merchants.md`](./merchants.md) for the full onboarding-pipeline
picture this is one step of.

**KYB is a separate, non-gating check.** `POST
/admin/merchants/:id/kyb/submit` verifies the *business* (registration,
tax ID, beneficial owners) rather than the individual `kycStatus`
already covers — tracked in its own `kybStatus` field, on its own
timeline, and **not** wired into `Payout.kycBlocked` or any other payout
gate. A `CONNECTED` merchant can have `kycStatus: 'VERIFIED'` and
`kybStatus: 'NOT_STARTED'` at the same time; only `kycStatus` affects
whether a payout can transfer. See
[`merchants.md#step-3--kyb-for-connected-merchants-only`](./merchants.md#step-3--kyb-for-connected-merchants-only)
for why that scope limit is deliberate, not a gap to be closed later
without a decision.

### Payout KYC gating and real transfer initiation

Two more `Payout` fields close the two gaps this section used to end on:

- **`kycBlocked`** — set at `runSweep()` time from the recipient's
  *current* `kycStatus`. A `Payout` for a merchant that isn't `VERIFIED`
  is still created — with the exact same `grossAmount`/`reserveAmount`/
  `netAmount` math as always, so the sweep's cursor still safely accounts
  for that money — just flagged so it can't be transferred yet. There's
  no `releaseEligibleAt`-style timer for this the way there is for the
  rolling reserve: "wait N days" means nothing for a status a human
  reviewer decides, however long that takes. `POST /admin/marketplace/recheck-kyc-blocks`
  (daily `@Cron`, or on demand) re-checks every currently-blocked
  `Payout` against the recipient's *current* `kycStatus` and clears the
  block once it's `VERIFIED` — including a `Payout` created *before* KYC
  was ever submitted.
- **`transferStatus`** (`NOT_INITIATED` | `PENDING_CONFIRMATION` |
  `INITIATED` | `FAILED`) — a real bank-transfer call via
  `BankTransferPort`, actually sending `netAmount` to the merchant
  instead of `Payout` being a pure accounting record with no rail to
  move real money. `POST /admin/marketplace/payouts/:id/initiate-transfer`
  (single payout, throws on a decline) and
  `POST /admin/marketplace/initiate-eligible-transfers` (daily
  `@Cron`/on-demand sweep, catches per-payout so one decline doesn't
  block the rest) both refuse a `kycBlocked` payout
  (`PAYOUT_KYC_BLOCKED`, 409) and refuse initiating the same payout's
  transfer twice, whether it's already confirmed or merely pending
  confirmation (`PAYOUT_TRANSFER_ALREADY_INITIATED`, 409 —
  `PayoutPort.markTransferInitiated()`/`markTransferPending()`'s
  conditional updates make this race-safe, the same posture
  `markReserveReleased()` already has, since this is money genuinely
  leaving the platform).

**Three interchangeable adapters, one real rail switch.** `BankTransferPort`
has three implementations — `MockBankTransferAdapter` (synchronous,
local dev/test default), and two real, async-settling rails,
`AchBankTransferAdapter`/`WireBankTransferAdapter` — selected by
`BANK_TRANSFER_PROVIDER` (`mock`/`ach`/`wire`) at DI-container build
time (`payment.module.ts`'s `useFactory` binding), the same
"env var picks the concrete adapter" idiom
`scripts/jobs/backup-storage/get-backup-storage.ts` uses for
`DELETION_BACKUP_STORAGE`. The two real rails don't pretend to settle
instantly the way the mock does: `initiateTransfer()` returns `PENDING`,
the `Payout` sits in `PENDING_CONFIRMATION`, and final settlement
(`INITIATED`) or failure (`FAILED`) arrives later via
`POST /webhooks/bank-transfer`, verified by `BankTransferWebhookGuard`
— the same "accept now, confirm later, verify the confirmation's
signature" shape this codebase already uses for PSP webhooks and
dispute resolution. `scripts/mock-psp/server.js`'s `/ach/transfers` and
`/wire/transfers` endpoints exercise this real, two-phase flow
end-to-end (including a real signed async callback — see
`scheduleBankTransferSettlement()` there) — same honest posture as
`docs/technical/tests/contract-testing.md` toward the Stripe/Adyen
sandbox: the mechanism is real and genuinely runnable, but no real
ACH/wire provider has ever actually been called with real credentials,
since none exist in this repository or its CI.

**The reserve follow-up transfer — a second, independent transfer.**
`Payout.reserveTransferStatus`/`reserveTransferId`/`reserveTransferInitiatedAt`/
`reserveTransferError` are a completely separate quad from the netAmount
ones above — a reserve released before, during, or long after the
netAmount transfer is equally eligible for its own transfer the moment
`reserveReleased` is true (`PayoutPort.findReserveTransferEligible()`
doesn't check the netAmount transfer's status at all). Same rail, same
`PENDING_CONFIRMATION`/`INITIATED`/`FAILED` shape, same
`BankTransferPort` — `PayoutService.initiateReserveTransfer()` sends
`reserveAmount` instead of `netAmount`, and
`POST /admin/marketplace/payouts/:id/initiate-reserve-transfer`
(single payout) plus `POST /admin/marketplace/initiate-eligible-reserve-transfers`
(daily `@Cron`/on-demand sweep) mirror the netAmount endpoints exactly.
A real rail's `POST /webhooks/bank-transfer` confirmation doesn't know
which of a payout's two transfers a given `transferId` belongs to, so
`PayoutService.confirmTransfer()` checks the netAmount transferId first,
then the reserve one — same idempotent, log-and-ignore posture toward
an unrecognized or already-resolved `transferId` either way.

Verified against real infrastructure in `test/marketplace-payouts.e2e-spec.ts`
(15 tests, the mock rail/mock KYC provider), `test/bank-transfer-rail.e2e-spec.ts`
(11 tests, the two real bank-transfer rails), and `test/kyc-review.e2e-spec.ts`
(9 tests, the real async KYC provider — submitting an application
against it returns `PENDING_REVIEW` with a real `kycApplicationId`, not
an immediate decision; a correctly-signed `approved`/`rejected` webhook
resolves it to `VERIFIED`/`REJECTED`; redelivering the same webhook
twice is idempotent; a webhook for an unknown `applicationId` is a
no-op `200`; a missing/invalid `X-KYC-Signature` is rejected `401`; and
the provider's outright-rejection marker fails synchronously without
ever reaching `PENDING_REVIEW`): a sweep withholds the exact configured
rolling-reserve percentage and computes gross/reserve/net correctly; a
merchant with no rolling reserve configured gets a `reserveStatus: 'NONE'`
payout with no `releaseEligibleAt`; running the sweep twice with no new
activity between runs creates no duplicate `Payout` (the cursor advances
correctly, no double-counting), and a new charge after that produces
exactly one more; a `PLATFORM` merchant's own proceeds are never swept
into a `Payout`; the reserve-release sweep releases an eligible reserve
(`holdDays: 0`) and leaves an ineligible one (`holdDays: 90`) alone; a
manual force-release works before eligibility and a second release
attempt is rejected with 409; `PATCH .../payout-reserve-policy` changes
the rate a later sweep actually uses; a fresh `CONNECTED` merchant
defaults to `NOT_STARTED` and its payouts are created `kycBlocked`; a
rejected KYC submission (`legalName` containing "reject", the mock
provider's decline marker) leaves payouts blocked; a verified merchant's
payout transfers successfully on the mock rail (real `transferId`
recorded, `INITIATED` immediately) and a second initiation attempt on
the same payout is rejected with 409; initiating a transfer for a
KYC-blocked payout is rejected with 409 before the bank is ever called;
the recheck sweep clears a payout created *before* KYC was submitted
once the merchant becomes `VERIFIED`; a mock-rail decline (`merchantId`
containing "transferfail") is recorded `FAILED` with a 422 response and
doesn't block a later retry; the transfer-sweep correctly initiates
every eligible payout while skipping KYC-blocked ones; on the ACH/Wire
rails specifically, `initiateTransfer()` lands the payout in
`PENDING_CONFIRMATION` (not `INITIATED`) with a real `transferId`; a
second initiation attempt while pending is rejected with 409; a
correctly-signed `settled` webhook confirms it to `INITIATED`, a
correctly-signed `failed` webhook moves it to `FAILED` with the given
reason; redelivering the same `settled` webhook twice is idempotent (no
error, no double-processing); a webhook for an unknown `transferId` is a
no-op `200`, not an error; a missing or invalid `X-Bank-Transfer-Signature`
is rejected with 401; and an outright rail rejection (`merchantId`
containing "transferreject") fails synchronously without ever reaching
`PENDING_CONFIRMATION`. `test/reserve-followup-transfer.e2e-spec.ts`
(8 tests) covers the reserve follow-up transfer specifically, always
releasing the reserve *after* the netAmount transfer already ran (the
exact ordering the gap used to name): initiating a reserve transfer
before the reserve is released is rejected `409`
(`PAYOUT_RESERVE_NOT_RELEASED`) even though netAmount's own transfer
already succeeded; releasing the reserve and then initiating its
transfer produces a real, separate `reserveTransferId` distinct from
`transferId`, with netAmount's own transfer completely untouched; a
second reserve-transfer attempt is rejected `409`; a reserve-transfer
decline is recorded `FAILED` independent of `transferStatus`; the
reserve-transfer sweep picks up a payout whose reserve was released
after its netAmount transfer already ran; a KYC-blocked payout can't
have its reserve transfer initiated even once the reserve is released;
and, against the real ACH rail specifically, a reserve transfer lands
`PENDING_CONFIRMATION` and a signed webhook confirms it to `INITIATED`
independent of the netAmount leg's own confirmation.

**What genuinely remains**: nothing from this section's original list —
the "no real KYC review," "still a mocked bank rail," and "no follow-up
transfer for a released reserve" gaps this section used to end on are
all now real, switchable, tested mechanisms. See
[`future-directions.md`](./future-directions.md#marketplace--split-payments)
for what's still missing at the marketplace-splits level (multi-party
splits with per-recipient FX).
