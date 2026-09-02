# Incident Response

A runbook for the alerts defined in [`monitoring/alert.rules.yml`](../../monitoring/alert.rules.yml)
(evaluated locally by `docker-compose.yml`'s `prometheus`/`alertmanager`
services against real metrics — see that file's header for how to verify
one actually fires) and mirrored, illustratively, in
[`k8s/prometheus-rules.yaml`](../../k8s/prometheus-rules.yaml) for a
cluster already running the Prometheus Operator.

This is not a substitute for a formal incident management program — see
[`security-and-compliance.md`](./security-and-compliance.md)'s Req 12 gap
(no formal governance documents, no vendor management program). What's
here is the concrete, technical half: what each alert means, what a
responder should do first, and which existing admin endpoint or service
method is the actual fix. There is no paging integration wired up yet
(see `monitoring/alertmanager.yml`) — until one exists, "on-call" means
whoever is watching http://localhost:9093 (or, in a real cluster, the
Prometheus Operator's Alertmanager UI).

## Severity levels

| Severity | Meaning | Response expectation |
|---|---|---|
| `critical` | Money is at risk of being mis-booked, lost, or the API is unreachable | Investigate immediately |
| `warning` | Degraded but not yet incorrect — a PSP is struggling, a backlog is building | Investigate within the current business day |

## Alerts

### OmniSwitchApiDown

**Meaning**: Prometheus hasn't been able to scrape `/metrics` for 1
minute — either the pod(s) are down, or something ahead of them (ingress,
network policy) is broken.

**First step**: `kubectl get pods -n payments -l app=omniswitch-api` — if
pods are `CrashLoopBackOff` or `0/N Ready`, check `kubectl logs` and the
readiness probe (`GET /health/ready`) directly. If pods look healthy,
suspect `k8s/network-policy.yaml` (Prometheus → `:3000/metrics` is one of
the explicitly-allowed rules — see `security-and-compliance.md`'s network
segmentation section) or the ingress/service layer instead.

### PSPCircuitBreakerOpen

**Meaning**: `RedisCircuitBreakerService` has tripped a provider's circuit
— see that service's own docblock for the two ways this happens (a burst
of real failures, or a sustained slow-call rate). New charges are being
routed to the other PSP, or failing outright if the OPEN one was the only
provider available for the charge's currency/amount.

**First step**: `GET /api/v1/payments/routing/health` to see current state
and rolling success rate/latency per provider. If the PSP's own status
page confirms an outage, this is expected behavior working correctly —
wait for the automatic HALF_OPEN recovery (`RECOVERY_TIME_MS`, 30s) rather
than intervening. If the PSP looks healthy on their end and this system's
own metrics disagree, `POST /api/v1/payments/routing/circuit-breaker/:provider/reset`
is the operator escape hatch.

### PSPSuccessRateLow

**Meaning**: A provider's rolling 15-minute success rate has dropped below
80%, but hasn't (yet) tripped the circuit breaker's own OPEN threshold —
this is the earlier warning.

**First step**: Same `GET /api/v1/payments/routing/health` check as above.
Often a leading indicator of `PSPCircuitBreakerOpen` about to fire; treat
it as a heads-up to check the PSP's status page before it escalates, not
as something requiring its own separate fix.

### LedgerOutboxDeadLetters

**Meaning**: One or more `LedgerOutboxEvent` rows exhausted their retry
budget and are sitting in `FAILED` status — a payment state change
happened, but its ledger entry never made it to relay. This is a
financial-integrity issue, not just an operational one.

**First step**: `GET /api/v1/admin/outbox/failed` to see what's stuck and
why (each row carries its last error). Once the underlying cause is
understood and fixed (a schema mismatch, a downstream outage that's since
recovered, etc.), `POST /api/v1/admin/outbox/:id/retry` per event. Do not
retry blindly before understanding why it failed — a `FAILED` outbox
event next to a `ReconciliationMismatchFound` alert for the same window is
a strong signal they're the same underlying incident.

### LedgerOutboxBacklogHigh

**Meaning**: The `PENDING` outbox queue has stayed above 100 for 10
minutes — `LedgerOutboxRelayService` is falling behind, or has stopped
running. This threshold is illustrative (see the alert's own
`description`), not calibrated against real production volume.

**First step**: Confirm `LedgerOutboxRelayService.relayPendingEvents()` is
actually still firing every 10 seconds (check logs — unlike most of this
codebase's other recurring sweeps, this one has no admin-triggerable
on-demand equivalent, since it's designed to run continuously rather than
be nudged manually). If it's not firing at all, that's a scheduler-level
problem (pod restart, `@nestjs/schedule` not registered) worth escalating
directly. If it is firing but the backlog still isn't draining, this is a
throughput problem, not a correctness one — treat it as a capacity signal
for that cron's frequency or batch size, not something to page critical
on.

### ReconciliationMismatchFound

**Meaning**: `ReconciliationService`'s most recent hourly run for this
provider found at least one place where this system's ledger and the
PSP's own settlement report disagree — see that service's docblock for
the three mismatch shapes (`MISSING_AT_PSP`, `AMOUNT_MISMATCH`,
`UNKNOWN_AT_PSP`). This is the safety net for ledger/outbox bugs that
tests structurally can't catch; treat every occurrence as real until
proven otherwise, not as noise.

**First step**: `GET /api/v1/admin/reconciliation/runs` to see the run's
full mismatch list (each entry names the payment/transaction id and
describes the discrepancy). `MISSING_AT_PSP` is the more dangerous
direction — this system believes a charge succeeded that the PSP has no
record of. Escalate to finance/on-call engineering per your organization's
process; this document doesn't prescribe one (see the Req 12 gap noted
above). `POST /api/v1/admin/reconciliation/run` re-runs on demand once you
believe the cause is fixed, to confirm the next window comes back clean.
