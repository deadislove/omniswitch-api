# Ledger, Settlement & Smart Routing

## Double-entry bookkeeping model

Every money movement produces a `LedgerOutboxEvent` with a set of
`LedgerEntry` rows that must balance — total debits equal total credits, per
currency (`LedgerOutboxEvent.validateDoubleEntry()` enforces this in the
constructor; it's not optional bookkeeping hygiene, malformed entries throw
before they can ever be persisted).

### Charge entries (`createChargeEntries`)

For a successful charge of amount `A` with platform fee `F` (1.5% of `A`,
hardcoded in the saga — see caveat below):

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

## Smart PSP routing

`SmartRoutingStrategy` (pure domain logic, no I/O) picks a PSP for
every charge — there's no caching or sticky routing, every charge
re-decides.

**Per-merchant PSP entitlement**: `MerchantEntity.enabledPspProviders` (`jsonb`, defaults to
every PSP this system has an adapter for — currently `STRIPE` and
`ADYEN` — so every existing merchant is unaffected until narrowed via
`PATCH /admin/merchants/:id/psp-entitlement`) restricts which PSPs a
merchant's charges may ever route through. If the charge request set
`preferredProvider` and it's outside this merchant's entitlement, the
charge is **rejected** with `422 PREFERRED_PROVIDER_NOT_ENTITLED` —
checked explicitly, before candidate filtering even runs — not
silently routed to a different, entitled PSP. This is a deliberate
asymmetry from the availability/currency/country filter below:
entitlement reflects a merchant's real contractual relationship with a
PSP (a merchant onboarded to Stripe hasn't necessarily agreed to have
Adyen ever touch its transactions), a permission boundary an operator
configured on purpose — silently rerouting around it would hide a real
integration bug (a client still requesting a PSP that was deliberately
revoked) rather than surfacing it.

**Filtering** (applied to build the general candidate pool — used both
for scoring when there's no preference, and to validate a preferred
provider that passed the entitlement check above): a single pass over
the entitled PSPs, checked in this order — available and circuit
breaker not `OPEN`, entitled (redundant with the explicit check above
for a `preferredProvider`, but this is also where a non-preferred PSP
gets dropped from the pool for lacking entitlement), supports the
transaction's currency, and — if BIN country info is present —
supports that country.

**Preference override** (checked before scoring): if the charge
request set `preferredProvider` and that PSP survived entitlement and
the filter above, it's selected directly — a true override, not a
scoring input, matching the charge API's own documented contract
("overrides smart routing"). Scoring below is only reached when
there's no preference, or the preferred provider didn't survive the
availability/currency/country filter (not the entitlement check above,
which rejects outright rather than falling through).

**Scoring** (0–~100 points, roughly, when no preference decided it):

| Factor | Points | Reasoning |
|---|---|---|
| Circuit breaker state | 40 (CLOSED) / 10 (HALF_OPEN) / 0 (OPEN, filtered out earlier) | Availability dominates the score — a cheaper PSP that's currently failing shouldn't win |
| Success rate | 0–30 | Recent reliability |
| Latency | 0–15 (lower latency = more points) | Faster PSPs preferred when otherwise equal |
| Fee | 0–15 (lower fee = more points) | Cost optimization |
| EU card × Adyen | +10 | PSD2/SCA — Adyen is the stronger EU acquirer for this reference setup |
| Non-EU card × Stripe | +5 | Lower fees for US-centric traffic in this reference setup |

**Fallback**: if the top-scored PSP's actual charge call fails,
`PaymentProcessorFactory.executeWithFallback` retries against the
next-highest-scored PSP that's currently available, in order, until one
succeeds or the list is exhausted (`usedFallback: true` in the response
tells the caller this happened).

**Circuit breaker**: 5 failures **within a 60-second window** opens the
circuit for 30 seconds, after which it moves to `HALF_OPEN` — not 5
*consecutive* failures: the failure count is a Redis counter with a
60-second TTL refreshed on every failure, and a success while the
circuit is still `CLOSED` does not reset it (only a `HALF_OPEN →
CLOSED` recovery does), so 5 failures scattered across that window with
successes interspersed still trips it. `HALF_OPEN` admits exactly **one**
trial call (a shared Redis counter, atomically incremented, gates it) —
a success on that trial closes the circuit; a failure re-opens it
immediately, without needing to re-accumulate 5 failures. Every other
call arriving while that single trial is still outstanding is rejected
the same as `OPEN`, rather than the whole replica fleet's traffic
resuming at once the instant the state flips — the entire point of a
recovery probe is to send the PSP a trickle, not a burst, right as it
may be starting to recover. State lives in Redis
(`RedisCircuitBreakerService`, via the same `CachePort` idempotency
already uses — no new connection), shared across every replica — this
used to be per-process instance fields on
`StripePSPAdapter`/`AdyenPSPAdapter`, which meant each pod made its own
independent availability judgment about each PSP with zero coordination
between them: forcing 5 failures against one replica trips the breaker
as seen by a second replica that never made any of those calls itself.
Metrics (`successCount`/`totalRequests`/`totalLatencyMs`) are
bucketed into a 15-minute sliding window (per-minute Redis keys, summed at
read time) rather than accumulating for as long as the Redis keys live —
see [`distributed-state.md`](../technical/distributed-state.md) for the
bucketing design.

A second trigger also opens the circuit independently of the above: a
call that never throws but takes longer than 5 seconds counts as
"slow," and once at least 5 of the most recent calls are in the window
and half or more were slow, the circuit opens anyway — otherwise a PSP
that's silently hanging (not erroring, just never responding) wouldn't
trip the breaker until it actually started throwing, which could take
up to 2.5 minutes at 5 required failures.

## Reconciliation

The mechanisms above (double-entry validation, the outbox pattern) only
guarantee this system's *own* writes are internally consistent — none of
them can catch a bug where this system's ledger and the PSP's actual
settlement records silently disagree. `ReconciliationService` closes that
gap: an hourly job (plus on-demand via the admin API) diffs our own
charged-status payments against each PSP's own settlement report (Stripe's
balance transactions, Adyen's settlement report) and flags anything that
doesn't match — a charge we booked that the PSP has no record of, an
amount mismatch, or a PSP settlement we have no payment record for at all.
Full design, plus a real pre-existing timezone bug this surfaced in the
date-range query layer, in
[`docs/technical/reconciliation.md`](../technical/reconciliation.md).
Matching sums settlement records sharing a `pspTransactionId` rather than
assuming exactly one per id — required once partial-capture accounting
(below) made it possible for one authorization to produce several
settlement records at the PSP.

**Does not cover `AMBIGUOUS` payments** — a payment whose PSP call got
no response at all never received a `pspTransactionId`, so it has
nothing to match against a PSP settlement record; `ReconciliationService`
skips any payment without one. See
[`payment-lifecycle.md`](./payment-lifecycle.md)'s note on `AMBIGUOUS`
for the full picture — a separate automated sweep asks the PSP directly
what happened (a read-only lookup by idempotency key, not something
this reconciliation job itself does), and books the same ledger entries
as a webhook confirmation once it gets a definitive answer; a manual
admin action (`POST /admin/payments/:id/resolve-ambiguous`) remains
available for whatever that sweep's retry budget doesn't resolve.

**A merchant whose `AMBIGUOUS` incidents pile up gets flagged for
observation, separately from reconciliation.**
`AmbiguousRiskMonitoringService` watches for two independent signals
per merchant — more than a configurable threshold of incidents in a
rolling 24h window, or a run of consecutive charges that were *all*
ambiguous — and sets `MerchantEntity.ambiguousRiskFlagged` when either
trips. Purely observational: it does not throttle, hold, or otherwise
change how that merchant's charges are processed, and a flag auto-clears
once no new incident has occurred for a configurable number of days
(default 60). See
[`../guide/api/merchants-and-auth.md`](../guide/api/merchants-and-auth.md#ambiguous-risk-observation)
for the admin-facing endpoints.

## Fee model

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

**Volume-based fee tiers**: `MerchantEntity.feeTiers` — an optional,
ascending list of `{ minVolumeMinorUnits, bps }` steps — supersedes
`platformFeeBps` once this merchant's trailing *current-calendar-month*
`SUCCEEDED` charge volume, **in the same currency as the charge being
priced**, reaches a tier's threshold (set via `PATCH
/admin/merchants/:id/fee-tiers`; an empty array clears it back to the
flat rate). Deliberately scoped per currency rather than one blended
figure — a merchant taking both USD and EUR charges accumulates two
separate volume totals, each against the same tier thresholds, since
blending them would need an FX rate applied retroactively to historical
charges, which nothing else in this codebase does either (see "Refunds
and lost disputes replay the original charge-time rate" below for the
general shape of that constraint). Volume is computed from state *before*
the charge being priced — so the specific charge that pushes trailing
volume past a threshold still bills at the old rate; the discount applies
starting with the next one. Both this and `platformFeeBps` itself only
ever affect charges going forward, never retroactively re-price
already-booked ledger entries.

**Still not modeled**: this platform fee still isn't reconciled against
actual PSP interchange cost. `SmartRoutingStrategy.calculateFee()`
separately *estimates* PSP fees for routing/display purposes
(`estimatedFee` in API responses) using each adapter's
`feePercentage`/`fixedFeeMinorUnits` — that's a different number from
`platformFeeBps`/`feeTiers`, computed for a different purpose (choosing a
PSP, not booking a ledger entry), and the two still aren't connected. If
the platform fee is meant to be "PSP cost plus margin," that calculation
doesn't exist yet — a configurable, even volume-tiered, platform-side
rate didn't change that.

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
`WebhookProcessingService.markSucceeded()`) — the same three sites the fee
model above is wired into, via `ChargeLedgerParamsResolverService`. This
used to be an identical private method copy-pasted into all three (each
one's own comment explicitly flagged it as "kept local for a small
helper, not worth a shared service" — first for two callers, then noted
again as a judgment call once it became three); it was finally extracted
when the reserve mechanism below added a third concern to the same
lookup. An FX rate lookup failure does **not** fail the
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

This closes the specific, narrow gap DEV_README used to flag ("nothing
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
`DisputeService`'s `LOST` resolution path convert their clawback amount
using that *same* stored rate before booking. `LedgerOutboxEvent.createRefundEntries()`
gained the identical two-leg-via-`FX_CLEARING` shape `createChargeEntries()`
already had, just with every entry type flipped (reversing a payout, not
creating one):

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

**Still not modeled** (see
[`future-directions.md`](./future-directions.md#cross-border-settlement--tax)
for the fuller business-domain framing): VAT/tax handling isn't touched
at all, and while refunds/dispute losses now net cleanly against the
original charge, there's still no hedging or rate-lock *product* (e.g. a
merchant who wants a guaranteed rate before the charge even happens, the
way real cross-border processors sometimes offer) — this system quotes
at charge time and nothing before that.

## Merchant risk tiering & reserves

Every merchant used to be treated identically — same fee, same payout
timing, no concept of a risk-based hold. Real processors differentiate: a
higher-risk merchant typically has a slice of each charge withheld in a
rolling reserve for a period, specifically to cover potential future
chargebacks. Fixed with `MerchantEntity.reserveBps`/`reserveHoldDays`
(basis points of the *net* amount, directly configurable per merchant —
same idiom as `platformFeeBps`, not a `riskTier` enum this codebase has
no real risk model to drive) and a new `ReserveHold` domain object
tracking each individual withheld amount's own `HELD` -> `RELEASED`
lifecycle, separate from the `LedgerOutboxEvent` that created it — a hold
has to be queryable and individually releasable long after the ledger
event that created it was already published.

**Booking — composes with the fee and FX legs above, doesn't replace
them.** `reserveBps` is carved out of the net amount (after the platform
fee), always in the *charge* currency, before any settlement-currency
conversion:

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `PSP_SETTLEMENT_ACCOUNT` | PSP_SETTLEMENT | DEBIT | gross amount | charge currency |
| `PLATFORM_FEE_ACCOUNT` | FEE | CREDIT | fee | charge currency |
| `{merchantId}_RESERVE` | RESERVE | CREDIT | reserve amount | charge currency |
| `{merchantId}` | MERCHANT | CREDIT | net − reserve (− FX legs if applicable) | charge or settlement currency |

The `RESERVE` credit is just a fourth entry in the same charge-currency
group above — it still balances, since it's carved out of the same net
amount that would otherwise have gone entirely to `MERCHANT` (or into the
`FX_CLEARING` legs, if this merchant also has a settlement currency
configured — reserve withholding happens first, so the FX conversion
above then runs on the *net-of-reserve* amount instead of the full net
amount). No new clearing account needed, unlike FX conversion — a reserve
never changes currency, so it never breaks the per-currency balance
`validateDoubleEntry()` already enforces.

**Release**: `ReserveService` releases a hold either via a daily `@Cron`
sweep (every `HELD` hold whose `releaseEligibleAt` has passed) or an
operator's manual override (`POST /admin/reserves/:id/release`, bypasses
the eligibility check). Both book the exact reverse entry —
`createReserveReleaseEntries()` — atomically with the status flip, in one
DB transaction:

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `{merchantId}_RESERVE` | RESERVE | DEBIT | reserve amount | charge currency |
| `{merchantId}` | MERCHANT | CREDIT | reserve amount | charge currency |

Release is always in the currency the hold was withheld in — deliberately
**not** re-converted to whatever settlement currency the merchant might
have configured by release time (which could be weeks or months after the
original charge). Re-running FX at an arbitrary later date would mean
either capturing a brand-new rate the platform has to actually honor, or
silently reusing the original charge-time rate for a transaction
happening much later — both more likely to mislead than help. Manage a
merchant's reserve policy via `PATCH /admin/merchants/:id/reserve-policy`;
list/inspect holds via `GET /admin/reserves`.

**A real race condition found verifying the manual-release endpoint**:
`ReserveService.release()` originally re-fetched the hold via a repository
read after committing the release transaction, to return its now-current
state to the caller. That re-fetch reliably came back still `HELD` — this
app's `DataSource` routes plain reads to a Postgres replica (see
[`infra-verification-status.md`](../technical/infra-verification-status.md)'s
measured ~1s replication lag), and a read running microseconds after the
write committed to master lost that race every time. Fixed by returning
the already-mutated in-memory `ReserveHold` aggregate instead of
re-querying — the same "don't re-fetch after your own write" posture
`DisputeService.submitEvidence()`/`MerchantService`'s update methods
already use.

## Automatic risk-tier adjustment

`RiskTieringService` closes the gap the section above used to end on: a
daily sweep (`POST /admin/risk-tiering/run` on demand, same dual
on-demand + scheduled shape as `ReconciliationService`/`ReserveService`)
recomputes each auto-managed merchant's trailing 90-day lost-dispute rate
and adjusts `reserveBps`/`reserveHoldDays` to one of three tiers — in
both directions, not just escalation, since every tick recomputes from
scratch off the current window rather than only ever ratcheting up.
`MerchantEntity.riskTierAutoManaged` (default `true`) gates this; an
operator's manual `PATCH .../reserve-policy` call sets it to `false` as a
side effect, so a hand-tuned reserve doesn't get silently overwritten by
the next sweep — `PATCH .../risk-tier-auto` re-enables it.

**Two real bugs found building this** (both about the denominator —
"how many settled charges did this merchant actually have"): counting
only `SUCCEEDED` payments undercounts, since a lost dispute moves a
payment to `REFUNDED` — exactly removing the transactions this service
most needs to count. Fixed by counting the same `chargedStatuses` set
(`SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`)
`findByProviderAndDateRange()` already uses. Separately,
`PaymentRepositoryPort.count()`'s `fromDate`/`toDate` filter fields were
advertised in the interface but silently ignored by the implementation —
nothing had called `count()` with a date range before this service to
notice. Both fixed together; see
[`../../DEV_README.md`](../../DEV_README.md#merchant-risk-tiering--reserves---resolved)
for the full writeup.

**Still not modeled** (see
[`future-directions.md`](./future-directions.md#merchant-risk-tiering--reserves)
for the fuller business-domain framing): the tiering thresholds are
deliberately simple/illustrative, not calibrated against real fraud data;
no MCC code, account tenure, or dispute-reason-code weighting; and a tier
change only ever affects charges going forward, never reserves already
withheld from earlier ones.

## Marketplace splits

A `MerchantEntity` can now be a `PLATFORM` (the default — every merchant
that existed before this is one, unchanged) or a `CONNECTED` account
onboarded under a specific platform (`platformMerchantId`). This is the
first "not a flat peer" relationship between merchants this system
models — see
[`future-directions.md`](./future-directions.md#marketplace--split-payments)
for why that used to be a real, unmodeled gap.

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
- **A merchant settlement-currency conversion at the same time**
  (`SPLIT_WITH_SETTLEMENT_CONVERSION_UNSUPPORTED`, 409) — deciding which
  FX rate applies to a charge that's partly "platform pricing" and partly
  "connected-account pricing" is a real design question (does each
  connected account have its own settlement currency? the same one as the
  platform?) this system doesn't attempt to answer yet.
- **No connected-account KYC/onboarding review.** Creating a `CONNECTED`
  merchant is still the same instant, admin-only `POST /admin/merchants`
  call as any other merchant — there's no verification workflow before an
  account can start receiving splits. See
  [`future-directions.md`](./future-directions.md#marketplace--split-payments)
  for the fuller framing.

### Reversing a split on refund or dispute loss

`PaymentAggregate.recordSplits()` remembers the *original* charge-time
`splits` (recorded once, immutable — same posture as
`recordSettlementConversion()`), so `PaymentLifecycleService.refund()` and
a lost dispute's clawback (`DisputeService.resolveByPspDisputeId()`) both
reverse each recipient's share **proportionally**, instead of only ever
debiting the charging (platform) merchant's own account regardless of how
the charge was split:

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
money.** Unlike the charge-time reserve (`ReserveHold`, which withholds
via a real `RESERVE`-account ledger entry), that split is a pure
scheduling overlay: the split's `MERCHANT` credit already correctly
represents what the connected merchant is owed, and stays untouched
throughout. It just tracks, separately, how much of that balance has
been confirmed disbursable in a given sweep versus held back as a
rolling reserve — the same distinction a bank's "ledger balance" and
"available balance" draw. *Actually sending* `netAmount` somewhere real
is a separate action — see "Real payout initiation" below.

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
processors have real regulatory obligations here). `MerchantEntity.kycStatus`
(`NOT_STARTED` | `VERIFIED` | `REJECTED`) now gates that, via
`POST /admin/merchants/:id/kyc/submit` (`{ legalName, taxId }`) calling
`KYCProviderPort.verify()` — a real HTTP call to an external verification
service (a mock one, in this reference system), not a database flag an
operator flips by hand.

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

Deliberately a synchronous, three-state decision — no `PENDING` sitting
in the database for days — since a real KYC provider's review is
genuinely asynchronous (often over days, sometimes needing a human), and
mocking that out fully would mean building a whole webhook-callback
flow for a decision this reference system has no real reviewer to make
anyway. `POST /admin/merchants/:id/kyc/submit` is re-callable after a
`REJECTED` decision (a merchant re-applying with corrected information).

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
- **`transferStatus`** (`NOT_INITIATED` | `INITIATED` | `FAILED`) — a
  real (mocked) bank-transfer call via the new `BankTransferPort`,
  actually sending `netAmount` to the merchant instead of `Payout` being
  a pure accounting record with no rail to move real money.
  `POST /admin/marketplace/payouts/:id/initiate-transfer` (single
  payout, throws on a decline) and `POST /admin/marketplace/initiate-eligible-transfers`
  (daily `@Cron`/on-demand sweep, catches per-payout so one decline
  doesn't block the rest) both refuse a `kycBlocked` payout
  (`PAYOUT_KYC_BLOCKED`, 409) and refuse initiating the same payout's
  transfer twice (`PAYOUT_TRANSFER_ALREADY_INITIATED`, 409 —
  `PayoutPort.markTransferInitiated()`'s conditional update makes this
  race-safe, the same posture `markReserveReleased()` already has, since
  this is money genuinely leaving the platform).

**Deliberately scoped to `netAmount` only — never a later-released
reserve.** If a `Payout`'s reserve is released *after* its `netAmount`
was already transferred, this system has no mechanism to send a
follow-up transfer for just the released reserve amount — a real
implementation would either delay transfer initiation until any reserve
has settled, or model transfers as a running ledger against a payout
rather than a single one-shot action. Documented, not built, in this
pass — see "What genuinely remains" below.

Verified against real infrastructure in `test/marketplace-payouts.e2e-spec.ts`
(14 tests): a sweep withholds the exact configured rolling-reserve
percentage and computes gross/reserve/net correctly; a merchant with no
rolling reserve configured gets a `reserveStatus: 'NONE'` payout with no
`releaseEligibleAt`; running the sweep twice with no new activity between
runs creates no duplicate `Payout` (the cursor advances correctly, no
double-counting), and a new charge after that produces exactly one more;
a `PLATFORM` merchant's own proceeds are never swept into a `Payout`; the
reserve-release sweep releases an eligible reserve (`holdDays: 0`) and
leaves an ineligible one (`holdDays: 90`) alone; a manual force-release
works before eligibility and a second release attempt is rejected with
409; `PATCH .../payout-reserve-policy` changes the rate a later sweep
actually uses; a fresh `CONNECTED` merchant defaults to `NOT_STARTED`
and its payouts are created `kycBlocked`; a rejected KYC submission
(`legalName` containing "reject", the mock provider's decline marker)
leaves payouts blocked; a verified merchant's payout transfers
successfully (real `transferId` recorded) and a second initiation
attempt on the same payout is rejected with 409; initiating a transfer
for a KYC-blocked payout is rejected with 409 before the bank is ever
called; the recheck sweep clears a payout created *before* KYC was
submitted once the merchant becomes `VERIFIED`; a bank decline
(`merchantId` containing "transferfail") is recorded `FAILED` with a 422
response and doesn't block a later retry; and the transfer-sweep
correctly initiates every eligible payout while skipping KYC-blocked
ones.

**What genuinely remains**: no real KYC review (the mock decision is
synchronous and marker-driven, not an actual human/AI reviewer over
days); no follow-up transfer for a reserve released after its payout's
`netAmount` was already sent (see above); and this is still a mocked
bank rail — `BankTransferPort`'s real-world equivalent (ACH, SEPA, a
wire) settles over days and would need its own webhook-driven
confirmation the way dispute resolution/3DS do, not the synchronous
"sent" this mock resolves with immediately.
