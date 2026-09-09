# Settlement, Routing & Reconciliation

This covers PSP selection, verifying the ledger against what a PSP
actually reports, and the reserve mechanism. The ledger/accounting
content that used to live in this file has moved to its own topic files:

- [`ledger-accounting.md`](./ledger-accounting.md) — the double-entry
  bookkeeping model and the outbox pattern
- [`fee-model.md`](./fee-model.md) — platform fee rate, volume tiers,
  and PSP interchange cost reconciliation
- [`fx-conversion.md`](./fx-conversion.md) — merchant settlement
  currency, refund/dispute rate replay, presentment currency
- [`marketplace-and-payouts.md`](./marketplace-and-payouts.md) —
  marketplace splits, payout scheduling, KYC gating, transfer initiation

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

The mechanisms above (double-entry validation, the outbox pattern —
see [`ledger-accounting.md`](./ledger-accounting.md)) only guarantee
this system's *own* writes are internally consistent — none of
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
made it possible for one authorization to produce several
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
observation, separately from reconciliation.** See
[`risk-and-fraud.md`](./risk-and-fraud.md#ambiguous-risk-monitoring-psp-reliability-signal)
for the full mechanism and why it's kept independent of chargeback-driven
risk tiering below.

## Merchant risk tiering & reserves

See [`risk-and-fraud.md`](./risk-and-fraud.md#risk-tiering-chargeback-driven-reserves)
for the business-policy view (tier thresholds, why the sweep moves in
both directions, the manual-override posture) — this section covers the
ledger/booking mechanics specifically.

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

**Booking — composes with the fee and FX legs, doesn't replace
them (see [`fee-model.md`](./fee-model.md) and [`fx-conversion.md`](./fx-conversion.md)).**
`reserveBps` is carved out of the net amount (after the platform
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
[`infra-verification-status.md`](../technical/tests/infra-verification-status.md)'s
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

**Reserve top-up on escalation (Phase 1)**: de-escalation still only
changes `reserveBps`/`reserveHoldDays` going forward — nothing about an
already-booked `ReserveHold` changes when a merchant's history improves.
Escalation is different: `ReserveService.topUpHeldReservesForMerchant()`
recomputes every still-`HELD` hold's target amount against the new,
higher `reserveBps` — using `ReserveHold.netAmount` (the original net
amount the hold was carved from, stored on the hold specifically so a
later escalation doesn't have to reverse-engineer it from a rate that
may not even be the one in effect anymore) — and books the difference
with `createReserveTopUpEntries()`, the mirror image of the release
entries above:

| Account | Type | Entry | Amount | Currency |
|---|---|---|---|---|
| `{merchantId}` | MERCHANT | DEBIT | additional reserve amount | charge currency |
| `{merchantId}_RESERVE` | RESERVE | CREDIT | additional reserve amount | charge currency |

The merchant's `MERCHANT` balance already received the full net amount
at charge time (net of the original, smaller reserve slice), so topping
up means clawing part of that back — the same direction any other ledger
takes when pulling back funds already credited. A hold already
`RELEASED` before the escalation happens is never touched (its funds
already left the reserve account — there's nothing left here to top up),
and a later de-escalation never reverses a top-up that already ran. See
`test/risk-tiering.e2e-spec.ts`'s top-up test for the full sequence.

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
still illustrative production defaults, not calibrated against real
fraud data — `scripts/calibration/` has run the actual calibration
*methodology* (precision/recall scoring against known labels) against a
realistic synthetic dataset, since no real fraud/chargeback history
exists in this repo, but that's a validated method, not a real number to
ship; no MCC code, account tenure, or dispute-reason-code weighting; and
a tier change only ever affects charges going forward, never reserves
already withheld from earlier ones.
