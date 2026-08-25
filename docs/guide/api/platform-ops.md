# Platform Operations API

Source: `outbox-admin.controller.ts`, `reconciliation-admin.controller.ts`,
`legal-hold-admin.controller.ts`, `ambiguous-payment-admin.controller.ts`,
`health.controller.ts`, `metrics.controller.ts`. These endpoints exist
for operators and infrastructure, not for merchants integrating with
the API.

---

## Ledger outbox recovery (`/admin/outbox`)

See [`system-design.md`](../system-design.md#4-other-core-flows-worth-knowing-before-you-touch-them)
for the Outbox pattern this recovers from. A publish failure is
deliberately **terminal** (`FAILED`, not auto-retried) — these
endpoints are how an operator brings a dead-lettered event back to life
after investigating why it failed.

- **Roles**: `ADMIN`, `OPERATOR`

### `GET /admin/outbox/failed`

List dead-lettered events awaiting review. Optional `?limit=`.

**Shape**: `{ id, paymentId, eventType, status, retryCount, lastError?, createdAt, processedAt? }`

### `POST /admin/outbox/:id/retry`

Resets a `FAILED` event back to `PENDING` so the relay (every 10s)
retries it on its next tick.

**Response `200`**: `{ id, status: "PENDING" }`

- **Errors**: `404` not found; `409` not currently `FAILED` (lost a race
  with another retry, or already moved on).

---

## Reconciliation (`/admin/reconciliation`)

The ledger/settlement safety net unit and e2e tests structurally can't
provide — diffs this system's own ledger against each PSP's settlement
report for a time window. See
[`../../technical/reconciliation.md`](../../technical/reconciliation.md) for
the mechanism and a real timezone bug it once surfaced.

- **Roles**: `ADMIN`, `OPERATOR`

### `GET /admin/reconciliation/runs`

List recent runs, optionally filtered by `?pspProvider=STRIPE|ADYEN` and
`?limit=`.

- **Errors**: `400` unknown `pspProvider`.

### `POST /admin/reconciliation/run`

Triggers a run on demand.

**Body**: `{ pspProvider: 'STRIPE'|'ADYEN', since?: ISO-8601, until?: ISO-8601 }`
— defaults to the last hour if `since`/`until` are omitted.

**`ReconciliationRunSummaryDto` shape**:

```json
{
  "id": "a1b2c3d4-...",
  "pspProvider": "STRIPE",
  "windowStart": "2026-01-01T00:00:00.000Z",
  "windowEnd": "2026-01-01T01:00:00.000Z",
  "transactionsChecked": 42,
  "status": "CLEAN",
  "mismatchCount": 0,
  "mismatches": [],
  "ranAt": "2026-01-01T01:00:05.000Z"
}
```

A mismatch is one of `MISSING_AT_PSP` (we have it, the PSP doesn't),
`AMOUNT_MISMATCH` (both have it, amounts disagree), or `UNKNOWN_AT_PSP`
(the PSP has a transaction we don't).

---

## Legal hold (`/admin/payments/:id/legal-hold`)

Blocks a payment from the data-retention pipeline — see
[`../../compliance/data-retention.md`](../../compliance/data-retention.md#legal-hold)
for the full design (why it's a single boolean with no audit trail, and
why placing a hold on an archived payment restores it to the live
table). Both the archiving job and the deletion job exclude a
`legal_hold = true` payment regardless of its age, status, or dispute
state.

- **Roles**: `ADMIN`, `OPERATOR`

### `POST /admin/payments/:id/legal-hold`

Places a hold. If the payment is currently archived
(`archive.payments`), this restores it to the live `payments` table as
part of placing the hold — a record under active legal/regulatory
scrutiny needs to be reachable through the normal payment query path,
not left in cold storage.

**Response `200`**: `{ id, legalHold: true, location: "live" | "restored-from-archive" }`

- **Errors**: `404` payment not found in either `payments` or `archive.payments`.

### `DELETE /admin/payments/:id/legal-hold`

Releases a hold. Only ever operates on the live table — a held payment
is always live (`POST` guarantees that). The payment simply becomes
archive-eligible again the next time the archiving job runs, once its
age/status/dispute conditions are otherwise met; there's no separate
"re-archive" step.

**Response `200`**: `{ id, legalHold: false, location: "live" }`

- **Errors**: `404` payment not currently in the live `payments` table.

---

## Ambiguous payment resolution (`/admin/payments/ambiguous`, `/admin/payments/:id/resolve-ambiguous`)

A payment reaches `AMBIGUOUS` when a PSP call gets no response at all
(not a decline — a timeout/network failure) and a same-provider retry
also gets no response — see
[`../../business-domain/payment-lifecycle.md`](../../business-domain/payment-lifecycle.md)'s
note on `AMBIGUOUS`. There is currently no automated way for this
system to resolve one on its own — these two endpoints are the manual
escape hatch: find one, then record what an operator found by checking
the PSP's own dashboard/API directly.

- **Roles**: `ADMIN`, `OPERATOR`

### `GET /admin/payments/ambiguous`

List `AMBIGUOUS` payments across every merchant. Optional
`?olderThanMinutes=` — omit (or `0`) to list every currently
`AMBIGUOUS` payment regardless of age.

**Shape**: `{ paymentId, merchantId, amount, currency, pspProvider?, failureReason, createdAt, ageMinutes }`

### `POST /admin/payments/:id/resolve-ambiguous`

Records what actually happened at the PSP. `SUCCEEDED` books the same
ledger entries a webhook confirmation would (fee/reserve/split
resolution, a real ledger outbox entry) — this is recording a real
charge as collected, not just flipping a status flag. `FAILED` records
that no charge occurred; nothing is booked.

**Body**: `{ outcome: 'SUCCEEDED'|'FAILED', pspTransactionId?: string, reason?: string }`
— `pspTransactionId` is required when `outcome` is `SUCCEEDED` (an
ambiguous outcome never received one automatically; that's what made
it ambiguous).

**Response `200`**: the payment detail shape (same as `GET /payments/:id`).

- **Errors**: `404` payment not found; `409` payment is not currently
  `AMBIGUOUS`; `422` `outcome: 'SUCCEEDED'` without `pspTransactionId`.

**What this doesn't do**: actively query the PSP to resolve the
ambiguity automatically — an operator still has to go check the PSP
directly. A scheduled sweep that does this on its own is a larger,
separate piece of work, not yet built.

---

## Health (`/health`) — unversioned, no `/api` prefix

Kubernetes probe contract — fixed paths owned by infrastructure, not
this API's versioned surface.

- **Public**, no auth.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Readiness: DB ping + heap/RSS thresholds. `503` if any indicator is down. |
| `GET /health/live` | Liveness: just confirms the process is running. Always `200` if reachable at all. |
| `GET /health/ready` | Readiness: DB ping only (narrower than `/health`). |

## Metrics (`/metrics`) — unversioned, no `/api` prefix

Prometheus scrape endpoint (`text/plain; version=0.0.4`).

- **Public**, no auth (matches the Prometheus scrape convention — access
  control belongs at the network layer for a metrics endpoint).

| Metric | Labels | Meaning |
|---|---|---|
| `omniswitch_psp_circuit_breaker_state` | `provider` | 0=CLOSED, 1=HALF_OPEN, 2=OPEN |
| `omniswitch_psp_success_rate_percent` | `provider` | Rolling 15-minute window |
| `omniswitch_psp_avg_latency_ms` | `provider` | |
| `omniswitch_ledger_outbox_pending_total` | — | Events awaiting relay |
| `omniswitch_ledger_outbox_failed_total` | — | Dead-lettered events |
| `omniswitch_payments_total` | `status`, `provider` | Payment volume — pull-computed from the `payments` table at scrape time, not an in-process counter (see [`system-design.md`](../system-design.md#5-cross-cutting-infrastructure-concerns) for why that distinction matters across replicas) |

Plus default Node.js/process metrics from `prom-client`'s
`collectDefaultMetrics()` (heap, event loop lag, GC, CPU).
