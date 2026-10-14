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
`PaymentLifecycleService.capture()` (manual capture),
`WebhookProcessingService.markSucceeded()` (async/3DS-confirmed charges),
and `AmbiguousPaymentService.bookSucceeded()` (manually-resolved
ambiguous outcome) — looks this rate up through the same shared
`ChargeLedgerParamsResolverService.resolve()` call rather than each
maintaining its own copy, so none of them can drift from each other the
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
PSP rather than booking a ledger entry). Whether the platform fee is meant to
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
drift between estimate and actual, instead of an unrealistic exact
match every time. Against a real production Stripe/Adyen deployment,
`fetchFeeStatement()`'s real implementation would call that PSP's own fee
reporting API instead of `mock-psp` — the same
mock-now/real-later posture as this codebase's other PSP integrations.

## Real interchange qualification and downgrade

The two sections above are about what this platform charges a merchant
(`platformFeeBps`) and what a PSP in turn charges this platform
(`fetchFeeStatement()`) — both already-blended numbers a PSP hands
back after its own processing. Neither models the layer underneath
both: interchange, the fee a card network actually sets and an issuing
bank actually collects on every transaction, which both Stripe's and
Adyen's own pricing already bakes in rather than exposes line by line.
`evaluateInterchangeQualification()`
(`domain/services/interchange-qualification.ts`) models that layer
directly — the real mechanics behind an acquirer's margin, which a
platform operating purely on top of PSP-blended pricing never has to
reason about.

**Interchange isn't one number.** Real Visa/Mastercard interchange is
a published matrix running to dozens of categories per brand, keyed on
card product, merchant category, and channel, revised twice a year.
`lookupInterchangeRate()` (`domain/services/interchange-rate-table.ts`)
models a deliberately simplified version of that same shape — brand
(`CardBrand`) × product tier (`CardProduct`: `CONSUMER`,
`CONSUMER_REWARDS`, `COMMERCIAL`) — at illustrative, round numbers in
the real neighborhood of published card-not-present rates. Amex and
Discover get one flat rate regardless of product tier (both price
closer to a single blended rate than Visa/Mastercard's product-tiered
table); every other network falls back to a conservative default
rather than guessing at a table this project has no published source
for.

**A transaction downgrades off its best-qualified rate when the data
a network requires for that rate wasn't there.** Three checks, each
independently capable of triggering a downgrade:

- **AVS mismatch** — the billing address didn't match what the card
  issuer has on file.
- **CVV mismatch** — the security code didn't match.
- **Late settlement** — captured more than 48 hours after
  authorization (`SETTLEMENT_WINDOW_HOURS`, an illustrative stand-in
  for the real network-required submission window, which varies by
  brand and region). Only reachable through the manual-capture flow —
  an immediate-capture charge authorizes and captures in the same PSP
  call, so this check can never fire there.

A downgrade adds a flat surcharge (`DOWNGRADE_SURCHARGE_BPS`) on top of
the best-qualified rate; the fixed per-transaction fee never changes on
a downgrade, matching how a real interchange downgrade works. The
result — qualified rate, applied rate, and which checks failed, if
any — is recorded once a charge actually captures
(`PaymentAggregate.recordInterchangeQualification()`) and surfaced on
`GET /payments/:id`.

**AVS/CVV results come from the PSP's own authorization response, not
a separate check this platform runs independently.** Real Stripe
returns these per-check (`payment_method_details.card.checks`); real
Adyen returns a single coded `avsResult`/`cvcResult` string. Both PSP
adapters normalize their own vocabulary into this port's shared
`AvsResult`/`CvvResult` types — see `PSPChargeResponse`'s own docblock
for the exact mapping, including why `PARTIAL` (one of Stripe's two
AVS checks passing, the other failing) only ever comes from Stripe.

**Network tokenization is a real, if minor, connection to this same
layer.** A transaction authorized via a real network token (Visa VTS /
Mastercard MDES — see `compliance-and-security.md`'s own section on
this, a different layer from this backend's PCI-scope tokenization)
often qualifies for a better real-world interchange rate than the same
card presented as a raw PAN, since the network itself vouches for the
token-to-card binding. `PSPChargeResponse.networkTokenized` surfaces
the PSP's own signal for this (undefined for Adyen unless the merchant
account opted into the relevant additionalData field — see that
field's docblock), but this platform's own
`lookupInterchangeRate()`/`evaluateInterchangeQualification()` doesn't
yet fold it into the rate this illustrative model actually applies —
recorded for visibility only, the same "no decisioning role yet"
posture `PaymentAggregate.pspRiskSignal` already uses, rather than a
rate adjustment this project has a published source to model
accurately.
