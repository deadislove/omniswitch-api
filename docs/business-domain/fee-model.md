# Fee Model

This describes how the platform fee — what this system keeps from every
charge — is calculated, and the separate, now-reconciled question of
what a PSP actually charges *this platform* to process that charge. See
[`ledger-accounting.md`](./ledger-accounting.md) for how a `FEE` entry
fits into the double-entry model, and
[`risk-and-fraud.md`](./risk-and-fraud.md) for the reserve mechanism
(a related but distinct withholding, computed separately from the fee).

## Platform fee rate

The platform fee rate is per-merchant: `MerchantEntity.platformFeeBps`
(basis points — 150 = 1.5%, the rate every merchant gets by default unless
set otherwise at onboarding or via `PATCH
/admin/merchants/:id/fee-rate`). Every place that books a `FEE` ledger
entry — `PaymentCheckoutSaga` (immediate capture),
`PaymentLifecycleService.capture()` (manual capture), and
`WebhookProcessingService.markSucceeded()` (async/3DS-confirmed charges)
— looks this rate up through the same shared
`ChargeLedgerParamsResolverService.resolve()` call rather than each
maintaining its own copy, so all three can't drift from each other the
way they once did (see DEV_README.md's Fee model entry for the real bug
this duplication caused). This used to be a single hardcoded `0.015`
across every call site, with no way to differentiate merchants at all.

## Volume-based fee tiers

`MerchantEntity.feeTiers` — an optional,
ascending list of `{ minVolumeMinorUnits, bps }` steps — supersedes
`platformFeeBps` once this merchant's trailing *current-calendar-month*
`SUCCEEDED` charge volume, **in the same currency as the charge being
priced**, reaches a tier's threshold (set via `PATCH
/admin/merchants/:id/fee-tiers`; an empty array clears it back to the
flat rate). Deliberately scoped per currency rather than one blended
figure — a merchant taking both USD and EUR charges accumulates two
separate volume totals, each against the same tier thresholds, since
blending them would need an FX rate applied retroactively to historical
charges, which nothing else in this codebase does either (see
[`fx-conversion.md`](./fx-conversion.md#refunds-and-lost-disputes-replay-the-original-charge-time-rate)
for the general shape of that constraint). Volume is computed from state
*before* the charge being priced — so the specific charge that pushes
trailing volume past a threshold still bills at the old rate; the discount
applies starting with the next one. Both this and `platformFeeBps` itself
only ever affect charges going forward, never retroactively re-price
already-booked ledger entries.

## PSP interchange cost — a separate number, now reconciled against a real (simulated) statement

`SmartRoutingStrategy.calculateFee()` separately *estimates* PSP fees for
routing/display purposes (`estimatedFee` in API responses) using each
adapter's `feePercentage`/`fixedFeeMinorUnits` — a different number from
`platformFeeBps`/`feeTiers` above, computed for a different purpose (choosing a
PSP, not booking a ledger entry). Whether the platform fee is meant to
cover "PSP cost plus margin" is a pricing decision this codebase doesn't
make on its own — the two numbers are still independently set — but the
gap this section used to describe (no way to check the *estimate* against
what a PSP actually charges) is closed: `PspFeeScheduleService` makes the
routing-time estimate configurable per deployment (previously hardcoded),
and `POST /admin/psp-cost-reconciliation/run` computes that estimate for
real from real settled charges and diffs it against a real fee statement,
fetched automatically via `PSPAdapterPort.fetchFeeStatement()` (a manual
override is still accepted, e.g. to reconcile against a downloaded real
PSP statement instead). In this environment, `fetchFeeStatement()` calls
`mock-psp`'s `/statement` endpoints, which compute a genuine,
deterministic *simulated* real fee — including a "premium card" surcharge
on a fifth of transactions — so the reconciliation report exercises real
drift between estimate and actual, not an unrealistic exact match every
time. Against a real production Stripe/Adyen deployment,
`fetchFeeStatement()`'s real implementation would call that PSP's own fee
reporting API instead of `mock-psp` — the same
mock-now/real-later posture as this codebase's other PSP integrations.
