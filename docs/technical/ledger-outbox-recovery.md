# Ledger outbox recovery

## What this is, and what it isn't

This is the operator-facing recovery path for dead-lettered ledger
outbox events. It's not the outbox mechanism itself — that's
`databases/`'s territory (the transactional-outbox pattern, the
10-second publish tick, the 5-minute stale-event alert). This doc
covers the narrower question: once the relay has already tried an
event and given up, what happens next.

## Why `FAILED` is terminal, not auto-retried

`LedgerOutboxRelayService`'s `@Cron(EVERY_10_SECONDS)` tick picks up
`PENDING` events and publishes them, marking each `PUBLISHED` only on
success. A publish failure calls `markFailed()` and stops there — no
automatic retry loop. That's deliberate: retrying indefinitely risks
double-publishing downstream if a consumer already received and
processed the event once, and the relay failed on a transient error
unrelated to delivery (a timeout after the message actually landed,
for instance). Stopping and surfacing the failure to a human beats
silently resending something that may have already gone out.

Before `OutboxRecoveryService` existed, the only way back from
`FAILED` was a hand-run `UPDATE ledger_outbox SET status = 'PENDING'
WHERE id = ...` against production — the same category of gap `npm
run seed:admin` closed for merchant bootstrap: a real operational need
with no safe interface built for it.

## What an operator sees, and what retry actually does

`GET /admin/outbox/failed` (`ADMIN`/`OPERATOR` only, optional `limit`)
lists every event currently in `FAILED` status: `paymentId`,
`eventType` (`PAYMENT_CHARGED`/`RESERVE_RELEASED`/`RESERVE_TOPPED_UP`/
`PAYMENT_REFUNDED` — see `databases/` for what each actually posts to
the ledger), `retryCount`, `lastError`, `createdAt`, `processedAt`.

`POST /admin/outbox/:id/retry` does exactly one thing: reset that
event's status from `FAILED` back to `PENDING`, so the relay's next
tick picks it up again. It never touches the event's `entries`
(the debit/credit lines) — those were already validated for
double-entry balance at creation, and this endpoint is a
delivery-status reset, not a ledger-correction tool. If the underlying
entries themselves are wrong, this isn't the fix for that.

The reset is atomic and conditional — `resetToPending()` only succeeds
if the event's current status is actually `FAILED` at the moment of
the update. Two operators retrying the same event, or a retry landing
just as the relay independently succeeds in the background, resolve
without a lost-update race: whichever request's conditional update
loses gets a `409 OUTBOX_EVENT_NOT_FAILED` naming the event's current
status instead of silently clobbering the other outcome. An unknown
`id` is a plain `404 OUTBOX_EVENT_NOT_FOUND`.

| Endpoint | What it does |
|---|---|
| `GET /admin/outbox/failed?limit=...` | Lists dead-lettered events for operator review |
| `POST /admin/outbox/:id/retry` | Resets to `PENDING` for the relay's next tick; `404`/`409` as above |

## How this differs from the stale-event sweep

`LedgerOutboxRelayService.detectStaleEvents()` runs every 5 minutes
and looks for events still sitting in `PENDING` long past when the
relay should have attempted them — a crashed replica mid-batch, or
write throughput that's been outrunning the 10-second tick. That's an
alert, not a recovery action: those events are still `PENDING` and the
relay will pick them up on its own next tick regardless; the point of
the alert is just making sure a human notices something's been off for
longer than it should. This recovery tool handles the other case —
an event the relay *did* attempt, and which failed outright, sitting
in `FAILED` until an operator decides whether to retry it.
