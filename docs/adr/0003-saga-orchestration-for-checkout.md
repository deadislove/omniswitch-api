# ADR-0003: Orchestrated saga with compensating actions for checkout

## Status

Accepted

## Context

A checkout is a multi-step flow spanning two systems that can't share a
transaction: this system's own Postgres (payment intent, ledger) and a
third-party PSP's HTTP API (the actual charge). The steps are: create
payment intent → resolve fee/FX/reserve/split parameters and validate
them → risk scoring → smart PSP routing → PSP charge (with fallback to
a second PSP on failure) → book the ledger entry once funds are
actually confirmed.

Several of those steps can fail independently, and each failure mode
needs a different response — a routing failure (no PSP available)
should never touch the PSP at all; a PSP charge failure should leave no
ledger entry; an invalid marketplace split has to be caught *before*
the PSP is called, because once a customer's card is actually charged
there's no "undo" available (see the `chargeLedgerParams` resolution
order in
[`../../src/modules/payment/application/sagas/payment-checkout.saga.ts`](../../src/modules/payment/application/sagas/payment-checkout.saga.ts)).
There's no distributed transaction coordinator across "this system's
Postgres" and "Stripe/Adyen's API" — a 2PC-style commit protocol isn't
something a PSP exposes.

## Decision

`PaymentCheckoutSaga.execute()` is a single orchestrator that runs the
steps in a fixed order and explicitly compensates on failure — an
**orchestrated** saga (one coordinator owns the sequence and decides
what happens on failure), not a **choreographed** one (each step
reacting to the previous step's event with no central coordinator).
Steps:

1. Create payment intent (`PENDING`, no ledger entry — funds haven't
   moved).
2. Resolve and validate `chargeLedgerParams` (fee/FX/reserve/split) —
   moved to run *before* PSP routing specifically because it's the
   first step in this saga that can throw for a reason that isn't "the
   PSP failed," and discovering an invalid split after a real charge
   already succeeded would leave money moved with no ledger entry and
   no compensating action to reverse it.
3. Risk scoring — stored for audit, doesn't gate anything itself; the
   PSP's own response is what decides `REQUIRES_ACTION` (3DS), not a
   pre-emptive score threshold (see the saga's own docblock for the
   bug this fixed: a threshold-triggered `REQUIRES_ACTION` used to
   fabricate a 3DS URL without ever calling the PSP, producing a
   payment stuck in `REQUIRES_ACTION` with no `pspTransactionId` and
   no webhook that could ever resolve it).
4. Smart routing (`AcquirerRoutingService.selectOptimalAdapter`) — a
   routing failure compensates immediately, no PSP call attempted.
5. PSP charge, with automatic fallback to the next-scored available
   PSP if the first one's actual charge call fails
   (`executeWithSmartRouting`) — see
   [ADR-0004](./0004-smart-routing-with-circuit-breaker.md).
6. On `SUCCEEDED`: book the ledger entry, atomically, in the same DB
   transaction as the payment status update — the only branch that
   writes to the ledger. `REQUIRES_CAPTURE` and `REQUIRES_ACTION`
   update payment status but book nothing; those paths' eventual
   ledger entry is written later by `PaymentLifecycleService.capture()`
   or `WebhookProcessingService`, respectively — not by this saga.

Failure at any step before a successful PSP charge calls
`compensate_markFailed()`: mark the payment `FAILED` and persist,
inside a `try`/`catch` that itself logs (not throws) if the
compensation write fails, since a failed compensation still needs to
surface somewhere rather than crash the request path a second time.

**A third, distinct outcome exists alongside success/failure**: if the
PSP call gets no response at all (not a decline) and a same-provider
retry also gets no response, `compensate_markAmbiguous()` marks the
payment `AMBIGUOUS` and the saga **returns normally** (`200`) instead
of throwing. This is deliberate, not an oversight — throwing here
would make `IdempotencyInterceptor` delete its Redis lock/cache (it
does that on any thrown error), so a client's legitimate retry with
the same `Idempotency-Key` would generate a brand-new `paymentId` and
re-run the whole saga, risking a second real charge attempt on top of
a first attempt that might have already succeeded at the PSP.
Returning normally means the retry instead hits the interceptor's
cached `AMBIGUOUS` response. See
[`../business-domain/payment-lifecycle.md`](../business-domain/payment-lifecycle.md)
for how `AMBIGUOUS` eventually resolves (an automated sweep queries the
PSP directly; manual admin resolution covers whatever that doesn't).

## Consequences

**What this buys**: exactly one place to read to understand the whole
checkout flow and its failure modes — the docblock at the top of
`payment-checkout.saga.ts` states the three compensation cases
directly (PSP timeout → mark `FAILED`, no ledger entry ever written;
DB write fails → no charge attempted; charge succeeds but DB update
fails → idempotency key prevents a double charge on retry). A
choreographed alternative would spread that same logic across however
many event handlers react to each step, with no single file that shows
the whole sequence.

**What this costs — the saga has no true rollback for a completed PSP
charge.** Every compensating action here runs *before* the PSP
actually moves money (routing failure, invalid split, all-PSPs-failed).
There is no "reverse a completed PSP charge" step, which is exactly
why step 2 (parameter validation) was moved earlier rather than left
to run after a successful charge, and why the saga's docblock is
explicit that this is a real, permanent constraint on what can safely
be validated late versus what must be validated before Step 5. Any new
step added to this saga that can fail needs the same treatment: can it
run before money moves, or does it need its own compensating action
design (which this codebase doesn't have a pattern for yet — see
`future-directions.md` for what's still open)?

**Crash recovery relies on idempotency, not saga state persistence.**
The saga doesn't checkpoint its own progress to Postgres step-by-step
— if the process crashes mid-execution, there's no "resume from step
4" story. What actually protects against a double charge on retry is
`idempotencyKey` (`IdempotencyInterceptor`, Redis `SETNX`) at the API
boundary, plus each downstream step's own idempotent design (a
deterministic idempotency key for subscription billing periods —
`SubscriptionService.periodPaymentId()` — is the same underlying
pattern applied to a *different* saga-adjacent flow). This is a
narrower guarantee than a saga framework with durable step state would
give, and was an explicit trade for not needing a saga-orchestration
framework/library for a single, well-understood flow.

## Alternatives considered

- **Choreography** (each step publishes an event, the next step's
  handler reacts): avoids a single God-object orchestrator, but scatters
  the failure-mode reasoning above across N event handlers with no one
  place that shows the full sequence or lets a reader reason about
  *all* the ways a checkout can end. Given how much this saga's design
  already depends on precise ordering (validate splits before routing,
  book the ledger only in the `SUCCEEDED` branch, never speculatively),
  an explicit orchestrator was judged easier to get right and keep
  right than N loosely-coupled handlers.
- **Two-phase commit / distributed transaction across this system and
  the PSP**: not available — PSPs don't expose a prepare/commit
  protocol, so this was never actually on the table, only ruled out for
  completeness.
- **A saga-orchestration framework/library** (e.g. Temporal,
  a dedicated saga library) instead of a plain injectable service:
  would add durable step-by-step state and built-in retry/resume
  semantics, at the cost of a new piece of infrastructure to run and
  operate. For a single saga with a bounded, well-understood step
  count, the added guarantees weren't judged worth the operational
  surface — revisit if the number of distinct sagas in this codebase
  grows enough that duplicated compensation/idempotency logic across
  them becomes the bigger cost.
