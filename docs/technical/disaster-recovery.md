# Disaster Recovery: Multi-Region / Cross-AZ

**Status: strategy documented, not verified against real infrastructure.**
Everything under "Target design" and the failover drill below is a
concrete, implementable plan — not something that has been run against
a real second region or a real multi-AZ cluster in this repository. No
cloud account spanning regions/AZs was available to build and drill
against. Treat this the same way as
[`secret-management.md`](./secret-management.md)'s migration path and
[`k8s/log-shipping-example.yaml`](../../k8s/log-shipping-example.yaml):
a real, actionable design, but "designed correctly" and "verified to
work" are different claims, and only the first one is true today. See
"How to confirm it actually works" below for exactly what running the
real drill would look like and what evidence would upgrade this doc's
status.

## Current state (real, deployed, single-region)

Everything in `k8s/` today is **one cluster, one region**, and — per
[`k8s/deployment.yaml`](../../k8s/deployment.yaml)'s own anti-affinity
rule — pods are only guaranteed to spread across different *nodes*
(`topologyKey: kubernetes.io/hostname`), not different availability
zones. Unless the cluster's own node pool happens to span AZs and the
scheduler happens to place replicas accordingly, there's no explicit
guarantee against all three `omniswitch-api` replicas landing in the
same AZ.

The stateful layer is a harder single point of failure than the
stateless app tier:

- **Postgres** ([`k8s/postgres.yaml`](../../k8s/postgres.yaml), see
  [`k8s/data-layer.md`](./k8s/data-layer.md)): exactly one
  `postgres-master` and one `postgres-replica`, both single-instance
  Deployments in the same cluster/region. Losing the master's node (or
  its AZ, or the region) stops all writes until a human intervenes —
  there is no automatic promotion today.
- **Redis** ([`k8s/redis.yaml`](../../k8s/redis.yaml)): a single
  instance. It backs idempotency locks, the cross-replica circuit
  breaker, and JWT revocation (see
  [`security-and-compliance.md`](./security-and-compliance.md#jwt-revocation)
  for why JWT auth fails **closed**, not open, when Redis is
  unreachable — confirmed for real in
  [`chaos-testing.md`](./tests/chaos-testing.md)'s `redis-outage.sh` finding).
  Losing this pod doesn't just degrade the app, it makes every
  authenticated request fail by design until Redis is back.
- **Vault** ([`k8s/vault.yaml`](../../k8s/vault.yaml)): dev-mode, single
  instance, in-memory — already flagged as not production-ready in
  [`secret-management.md`](./secret-management.md). A DR strategy for
  Vault itself is a prerequisite this doc doesn't solve; see "Known gaps"
  below.

In short: today's architecture tolerates losing *one pod* per
component (the app tier scales to 3+ replicas; Postgres/Redis do not),
but not losing a node, an AZ, or a region. There has been no real
failover drill because there is no second cluster to fail over to.

## Target design

### Topology: active-passive across two regions

Two independently-deployed clusters — a **primary** region (serves all
traffic) and a **secondary** region (warm standby, not serving traffic
day-to-day) — each running the same manifest set in `k8s/`. Active-passive,
not active-active: this codebase's write path assumes a single Postgres
primary (`app.module.ts`'s `replication` config: one master pool for
writes, one replica pool for reads). Active-active would require either
multi-master conflict resolution Postgres doesn't give you for free, or
a rewrite of the write path to shard by region — both far larger than
what "add DR" should mean. Active-passive is the design that fits the
codebase as it exists, not the one with the best theoretical RTO.

### RTO / RPO targets

| Metric | Target | Why |
|---|---|---|
| **RPO** (max acceptable data loss) | ≤ 60 seconds | Cross-region Postgres replication (below) is necessarily asynchronous — synchronous replication across regions would add tens-to-hundreds of ms to every write's latency, which the smart-routing/PSP-timeout budgets elsewhere in this codebase aren't designed around. 60s is a target for *typical* replication lag under normal load, not a hard guarantee — the actual number depends on cross-region network conditions and must be measured (see the drill below), not assumed. |
| **RTO** (max acceptable downtime) | ≤ 30 minutes | This is a **manual failover** design (see below) — no automated promotion. 30 minutes budgets for a human being paged, confirming the primary region is actually down (not a transient blip — flapping into a false failover is worse than staying down a few extra minutes), and executing the runbook. An automated failover (e.g. Patroni/repmgr-style leader election) could bring this to single-digit minutes but is explicitly out of scope — see "Known gaps." |

Both numbers are **design targets to drill against**, not measured
facts — see "How to confirm it actually works."

### Per-component plan

- **Kubernetes**: a second cluster in the secondary region, provisioned
  from the same `k8s/` manifests (parameterize the region-specific bits
  — image registry mirror, storage class, ingress DNS name — via
  `configmap.yaml`, not by forking the manifests). Kept scaled down
  (e.g. `replicas: 1` on `deployment.yaml`, or scaled to 0 with a
  documented "scale up during failover" step) rather than fully warm at
  the primary's traffic-serving size, to avoid paying for idle
  production-scale capacity — traded against a slightly longer RTO to
  scale up during the drill.
- **Postgres**: the secondary region's `postgres-replica` streams from
  the primary region's `postgres-master` the same way
  [`k8s/data-layer.md`](./k8s/data-layer.md) already describes
  same-region replication working — `pg_basebackup` + `standby.signal` +
  `primary_conninfo` — just with `primary_conninfo` pointing across a
  cross-region network path (VPN/VPC-peering/Transit Gateway,
  environment-specific, not something `k8s/` should own) instead of a
  same-cluster Service DNS name. Failover is: confirm the primary region
  really is unreachable, run `SELECT pg_promote();` (or touch the
  configured `promote_trigger_file`, depending on Postgres version) on
  the secondary's replica, then point `DB_MASTER_HOST` (in the secondary
  cluster's own `configmap.yaml`) at the now-promoted instance and roll
  the app deployment. This is a **manual** step, deliberately — an
  automatic promotion needs a fencing mechanism to guarantee the old
  primary can never come back and accept writes too (split-brain), which
  this design doesn't attempt to solve.
- **Redis**: **no cross-region replication.** Redis here holds
  idempotency locks, circuit breaker state, and the JWT revocation set —
  all rebuildable/ephemeral, not source-of-truth data (the ledger and
  outbox tables, which are, live in Postgres and are covered above).
  The secondary region starts with an **empty** Redis on failover. The
  accepted consequence, stated plainly rather than glossed over: a JWT
  revoked in the primary region shortly before failover (logout,
  deactivation, admin-triggered "log out everywhere") will *not* be in
  the secondary region's revocation set, and would be accepted there
  until it naturally expires — a real, bounded security gap during the
  failover window, not a hypothetical one. Closing it would mean either
  synchronously replicating the revocation set (defeats the point of not
  replicating Redis) or shortening JWT TTL specifically to bound this
  window — not implemented; flagged here so it's a known, accepted
  trade-off instead of a silent one.
- **Vault**: not solved by this doc. Real Vault DR replication is an
  Enterprise feature; the dev-mode single instance this repo ships
  doesn't have a DR story at all. A production deployment needs its own
  Vault HA/DR design before multi-region failover is trustworthy for the
  secrets it protects (`hmac_secret`, delegation signing keys) — see
  "Known gaps."
- **DNS / traffic routing**: a failover-routing DNS record (e.g. Route 53
  failover routing policy, or the equivalent on whatever DNS provider is
  in use) with a health check against `GET /health` in the primary
  region. On a real regional outage, the health check fails and DNS
  shifts new connections to the secondary region's ingress. Client-side
  DNS TTL/caching means this is not instant — budget it into the RTO
  measurement, don't assume it's free.

### Cross-AZ within a region (do this first)

Full cross-region failover needs a second cluster and is the larger
lift. Cross-AZ resilience *within* the existing single region is a
smaller, independently useful step that catches a more common failure
(one AZ having a bad day) without needing a second cluster at all:

1. Confirm the cluster's node pool actually spans ≥3 AZs (a cloud-provider/
   cluster-config concern, not something in `k8s/`).
2. Add a `topologySpreadConstraints` (or a `requiredDuringScheduling`
   pod anti-affinity keyed on `topology.kubernetes.io/zone`, not just
   `kubernetes.io/hostname`) to `deployment.yaml`, so the 3 app replicas
   are actually forced across 3 different zones instead of only
   different nodes.
3. Confirm the storage class backing `postgres.yaml`'s/`redis.yaml`'s
   PVCs either replicates across zones or is provisioned in a zone that
   survives independently of the app tier's zone spread — a
   single-zone PVC means the stateful pod is still down if that one zone
   goes, regardless of how well the stateless app tier is spread.

This is the recommended next concrete step before attempting full
cross-region DR — it's testable against the single existing cluster (no
second region needed) and directly reduces the blast radius of the most
common real-world failure class (an AZ outage), which is more likely
than a full region loss.

## How to implement

1. Provision the secondary region's cluster and apply the same `k8s/`
   manifest set to it (region-specific values via `configmap.yaml`).
2. Establish the cross-region network path Postgres replication needs
   (VPC peering / Transit Gateway / VPN — provider-specific).
3. Point the secondary cluster's `postgres-replica` at the primary's
   `postgres-master` across that path; confirm streaming replication
   the same way `data-layer.md` verifies it same-region (`pg_stat_replication`
   showing the replica's `walreceiver` in `streaming` state).
4. Deploy the app to the secondary cluster scaled down (see "Per-component
   plan" above); it will error on startup/health-check against its own
   empty Redis and local Vault until those are addressed — that's
   expected for a cold-standby app tier, not a bug to fix here.
5. Configure DNS failover routing with a health check against the
   primary region's `/health`.
6. Write down the actual promotion command sequence for the Postgres
   version in use (`pg_promote()` vs. trigger-file, depending on
   version) as a runbook — don't rely on remembering it live during a
   real incident.

## How to validate / accept it

Before treating this design as "done," each of the following must be
independently true and observed, not assumed:

- [ ] Cross-region replication lag has been **measured** under realistic
      write volume (not just confirmed present) — gives a real number to
      compare against the 60s RPO target.
- [ ] The promotion command has been **executed** against a real
      secondary-region replica and produces a writable primary.
- [ ] The app, pointed at the newly-promoted secondary, **successfully
      processes a real charge** end-to-end (not just passes `/health`).
- [ ] DNS failover has been **triggered by a real health-check failure**
      (not a manual DNS edit) and the time-to-propagate has been
      measured against real client behavior, not assumed to be
      instantaneous.
- [ ] The Redis-empty-on-failover gap (see "Per-component plan" above)
      has been explicitly acknowledged by whoever owns the production
      security posture — this is a decision to accept a trade-off, not
      a checkbox that can be silently ticked.
- [ ] A **failback** procedure (returning to the original primary region
      once it recovers, without losing writes accepted by the promoted
      secondary in the meantime) has been written down. Not designed in
      this doc — failback is materially harder than failover (the old
      primary needs to be re-synced *as a replica* of the newly-promoted
      one, not just restarted) and deserves its own pass.

## How to confirm it actually works: the failover drill

This is what would upgrade this document's status from "documented" to
"verified" — the same standard [`chaos-testing.md`](./tests/chaos-testing.md)
already holds the single-region resilience mechanisms to, applied at
region scope:

1. Record the current replication lag (`pg_stat_replication` on the
   primary) and the current wall-clock time — call this `T0`.
2. Simulate a primary-region outage: block the network path between the
   primary region and everything else (not just stopping the app pods —
   the point is to test whether the *secondary* can take over, which a
   graceful app shutdown in the primary doesn't exercise the same way).
3. Confirm the DNS health check actually fails and, left alone, actually
   fails over — don't manually intervene at this step; that's the thing
   being tested.
4. Run the documented promotion procedure on the secondary region's
   Postgres replica.
5. Scale up the secondary region's app deployment and confirm it serves
   traffic.
6. Run a real charge through the secondary region end-to-end (same bar
   as `chaos-testing.md`'s scripts: a real HTTP request, checking the
   real response, not a log line).
7. Record the wall-clock time when step 6 first succeeds — call this
   `T1`. **`T1 - T0` is the real, measured RTO** — compare it against the
   30-minute target above and update the target (or fix what made it
   slower) based on the real number, not the other way around.
8. Compare the last write committed on the old primary (from its own
   WAL/logs, captured before cutting the network in step 2) against the
   first write visible on the promoted secondary — **that gap is the
   real, measured RPO.**
9. Restore the network path, and confirm the old primary does **not**
   attempt to resume accepting writes (the split-brain risk "Per-component
   plan" above flags) — it should come back only as a replica of the
   newly-promoted primary, per whatever failback procedure gets written
   per the "How to validate" checklist above.
10. Write up what actually happened, the same honest way
    `chaos-testing.md` and `ci-cd.md` document real findings — including
    anything that didn't work as designed. A drill that reveals a gap
    and gets documented is more valuable than one where every step is
    quietly assumed to have gone fine.

## Known gaps

- **Vault has no DR story** — dev-mode single instance, no cross-region
  replication designed or available (Enterprise-only upstream feature).
  Blocks trusting this design for the secrets Vault protects until
  solved separately.
- **Redis state doesn't survive failover** (idempotency locks, circuit
  breaker state, JWT revocation) — accepted trade-off, not a solved
  problem; see "Per-component plan" above for the specific security
  consequence.
- **No automated promotion/failover** — this is a manual-runbook design.
  Automating it (Patroni, repmgr, or a cloud-managed Postgres with
  built-in cross-region failover) would improve RTO but adds its own
  failure modes (a fencing mechanism that fails open causes exactly the
  split-brain this design manually avoids) and is out of scope here.
- **Never drilled against real infrastructure** — see the status banner
  at the top of this document.
