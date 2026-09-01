# ADR-0002: Transactional outbox for ledger events instead of a dual write

## Status

Accepted

## Context

Every money movement has to produce a balanced double-entry ledger
event (`LedgerOutboxEvent.validateDoubleEntry()` — debits equal credits
per currency, enforced in the constructor) *and* eventually be
published somewhere downstream — in a real deployment, an accounting
system or an event bus; in this reference system, an in-process
`EventEmitter2` emit (`ledger.outbox.published`) standing in for that
transport.

Writing the ledger row to Postgres and publishing it to that downstream
system can't be a single atomic operation — they're two different
systems with no shared transaction. A naive "write to Postgres, then
call the publish API" dual write has a window where the write commits
but the publish never happens (crash, network failure, or a
five-nines-uptime downstream mistake), silently producing a ledger
entry that never reaches accounting. The reverse order has the same
problem in the other direction.

This isn't hypothetical for *this* codebase specifically — the timing
of the ledger write itself was already a source of a real bug: entries
used to be written speculatively at payment-intent creation, before
the PSP was ever called, which double-booked money that was never
actually charged whenever routing or the PSP call failed (see
[`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md#when-entries-are-written--this-matters-more-than-it-looks)).
Getting *when* a ledger row is written wrong once was enough reason to
be deliberate about the mechanism that publishes it, too.

## Decision

Write the `LedgerOutboxEvent` as a `PENDING` row in the *same* database
transaction as the payment-state change it represents —
`LedgerOutboxPort.saveWithPayment()`, called inside
`PaymentCheckoutSaga`'s `dataSource.transaction(...)` block alongside
the payment entity save. The row is guaranteed to exist if and only if
the state change it represents actually committed.

A separate process, `LedgerOutboxRelayService` (a cron job on a
10-second tick), polls for `PENDING` rows and publishes them, marking
each `PUBLISHED` only after the publish call succeeds. A publish
failure marks the event `FAILED` — terminal, not auto-retried. A
separate 5-minute sweep (`detectStaleEvents`) alerts on anything that's
been `PENDING` too long without ever being attempted (relay crash or
falling behind), but doesn't resubmit `FAILED` events itself — that's a
deliberate operator action (`POST /admin/outbox/:id/retry`,
ADMIN/OPERATOR only), not an automatic retry loop or a hand-run SQL
update against production.

Full design and the reliability contract (poll → publish →
mark-published-only-on-success → alert on failure) in
[`../business-domain/ledger-and-settlement.md`](../business-domain/ledger-and-settlement.md#the-outbox-pattern-and-the-relay).

## Consequences

**What this buys**: the ledger's own internal consistency (a payment
never confirms without a matching ledger row, and a ledger row never
exists without a confirmed payment) is guaranteed by Postgres
transaction atomicity — no distributed-transaction coordinator, no
2PC. The relay can crash, restart, or fall behind arbitrarily and
catch up from `PENDING` state; nothing is lost, only delayed (subject
to the stale-event alert threshold).

**What this costs**: eventual consistency between "the payment is
confirmed" and "the downstream system has the ledger event" — there's
a real window (bounded by the relay's 10-second tick under normal
operation) where a payment is `SUCCEEDED` in Postgres but the ledger
event hasn't reached its destination yet. Anything reading ledger
state has to be written with that lag in mind rather than assuming
read-after-write consistency across the two systems.

**What this doesn't cover**: the outbox pattern only guarantees *this
system's own* writes are internally self-consistent. It says nothing
about whether this system's ledger agrees with the PSP's own
settlement records — a bug that produces a wrong-but-internally-valid
ledger entry (right shape, wrong amount) would sail straight through
outbox validation. `ReconciliationService` closes that separate gap by
diffing against each PSP's actual settlement report — see
[`../technical/reconciliation.md`](../technical/reconciliation.md). The
two mechanisms are complementary, not redundant: outbox guarantees
internal consistency, reconciliation guarantees external agreement.

**The transport is explicitly a stand-in, not the load-bearing part**:
`EventEmitter2` has no persistence or delivery guarantee of its own —
if the process crashes between `PUBLISHED` being marked and any
in-process subscriber finishing its work, that subscriber's work is
lost. That's acceptable here because nothing in this reference system
currently has a subscriber whose work needs that guarantee; a real
deployment swapping in Kafka/SNS/a real accounting API would inherit
whatever delivery guarantee that broker provides, without needing to
change the poll → mark-published-only-on-success contract itself.

## Alternatives considered

- **Dual write** (save payment, then directly call the downstream
  publish API in the same request): rejected outright — no way to make
  this atomic across two different systems, and the failure mode
  (silently-lost ledger events) is exactly the kind of bug that's easy
  to miss in testing and expensive in a payments system specifically.
- **Change Data Capture (CDC) off the `ledger_outbox` table** (e.g.
  Debezium tailing the WAL) instead of an application-level relay:
  would remove the 10-second polling latency and the relay as a
  separate failure mode to operate, at the cost of a real CDC
  pipeline's own operational surface (connector config, WAL retention,
  schema-change handling). Deliberately not built here — the polling
  relay's simplicity was judged worth more than CDC's lower latency
  for a reference system at this scale; revisit if publish latency
  ever needs to beat single-digit seconds.
- **Two-phase commit across Postgres and the downstream broker**:
  would need XA support from both sides and a transaction coordinator
  neither Postgres's typical deployment nor most event brokers make
  easy to operate reliably; the outbox pattern gets the same
  end-to-end guarantee (published iff the state change committed)
  without either side needing to support distributed transactions.
