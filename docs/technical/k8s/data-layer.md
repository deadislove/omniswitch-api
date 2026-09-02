# Data Layer: Postgres, Redis, Vault, PgBouncer

Four manifests, one shape in common: each is a single-instance
`Deployment` (not a `StatefulSet`) with `strategy: Recreate` instead of
the default `RollingUpdate`, backed by a `PersistentVolumeClaim` where
it holds real state (`postgres.yaml`, `redis.yaml`) or none where it
doesn't (`vault.yaml`, dev-mode, in-memory only). `Recreate` matters
specifically because a `ReadWriteOnce` PVC can only be mounted by one
pod at a time — the default `RollingUpdate` would try to schedule the
new pod before the old one releases the volume and get stuck. Each also
mirrors `docker-compose.yml`'s own known-working config (same images,
same flags, same credentials shape) rather than inventing new topology,
on the theory that a config already proven to work locally is a safer
starting point than a from-scratch one.

None of the four were verified correct by reading the YAML alone — every
one was deployed to a real cluster and exercised for real before being
considered done, which is exactly what surfaced the bugs below. A
manifest that parses and a pod that reaches `Running` are both necessary
and both insufficient.

## `postgres.yaml`: real streaming replication, not a stand-in

`postgres-master` and `postgres-replica` are separate Deployments/PVCs/
Services (`postgres:16-alpine`), not a single Postgres pretending to be
two. The replica's container `command` runs the same bootstrap
`docker-compose.yml`'s replica service does on first start: loop
`pg_basebackup` against the master until it succeeds, write
`standby.signal`, append `primary_conninfo` to `postgresql.auto.conf`,
then `exec gosu postgres postgres`. On every subsequent restart `PGDATA`
is already populated and this whole block is skipped — the replica
starts directly as the standby it already is.

One deliberate difference from `docker-compose.yml`: the local compose
setup's init script (`scripts/postgres/init-master.sql`) hardcodes the
replication role's password as a literal string, and the
`POSTGRES_REPLICATION_USER`/`PASSWORD` env vars it sets are never
actually read by anything (the official Postgres image doesn't
recognize those names — that's an accepted shortcut for a local-only
stack). `postgres.yaml`'s own init `ConfigMap`
(`postgres-master-init`) instead reads `REPLICATION_USER`/
`REPLICATION_PASSWORD` from the container environment (itself sourced
from `configmap.yaml`'s `DB_REPLICATION_USER` and
`omniswitch-secrets`' `DB_REPLICATION_PASSWORD`), so overriding that
Secret in a real deployment actually takes effect instead of silently
doing nothing.

A row written on `postgres-master` appears on `postgres-replica` within
seconds, and `postgres-master`'s `pg_stat_replication` shows the
replica's `walreceiver` connection in `streaming` state — not just both
pods reaching `Ready`.

## `redis.yaml`: two real bugs, both invisible to a healthy pod

Single instance, `redis:7-alpine`, same `maxmemory`/eviction/AOF
persistence flags as `docker-compose.yml`'s redis service. The password
is read from `REDIS_PASSWORD` (an env var sourced from
`omniswitch-secrets`) rather than hardcoded on the command line the way
`docker-compose.yml`'s `--requirepass redis_secret` is.

Two bugs surfaced only by actually testing auth against a live pod, not
by the pod reaching `Ready`:

1. **`--requirepass` silently never applied.** An early version of the
   container `command` put each `redis-server` flag on its own YAML
   line with no shell `\` line-continuation. `exec redis-server` alone,
   with nothing joining it to the next line, is a syntactically
   complete shell statement — `exec` replaced the process immediately,
   and every flag after it, including `--requirepass`, was never
   reached. The pod still passed its own readiness probe (which also
   runs `redis-cli -a "$REDIS_PASSWORD" ping`, which succeeds whether or
   not a password is actually required) and looked completely healthy.
   Confirmed via `/proc/1/cmdline` inside the running container, which
   showed `redis-server *:6379` — the process's default display when
   started with zero arguments. Fixed by adding `\` continuations so the
   whole block is one shell statement — see the `command:` block's own
   comment in the file.
2. **A pre-existing typo in `k8s/secret.yaml`.** `REDIS_PASSWORD`'s
   base64 value decoded to `CHANGE_ME_REDMS_PASSWORD`, not
   `CHANGE_ME_REDIS_PASSWORD` as the file's own adjacent comment said.
   Fixed to match the documented placeholder.

With both fixes in place: unauthenticated `PING` is correctly refused
(`NOAUTH Authentication required`), the correct password works, and a
key written before `kubectl delete pod` on the Redis pod is still
present after the replacement pod (same PVC) comes up — real AOF
persistence, not just "the process didn't crash."

## `vault.yaml`: dev mode, and one capability-related crash loop

Runs Vault in `-dev` mode (`hashicorp/vault:1.15`), same as
`docker-compose.yml`. **This is explicitly not a production posture**:
dev mode auto-unseals on start, keeps everything in memory (a pod
restart loses every secret and the Transit key itself — the app's own
`VaultTransitService.onModuleInit()` re-creates the key idempotently,
but any ciphertext encrypted under the previous key instance becomes
permanently undecryptable), and its root token is a single long-lived
credential rather than a real auth method. Acceptable here for the same
reason `docker-compose.yml`'s local-dev setup is — a starting point for
exercising the rest of the manifest set, not a hardened
secrets-management deployment. `VAULT_DEV_ROOT_TOKEN_ID` is sourced from
`omniswitch-secrets`' `VAULT_TOKEN` (the same key `deployment.yaml`
already wires into the app), so overriding that Secret changes Vault's
own root token and the app's token together, keeping them in sync.

A real bug: an early version's `securityContext` set
`capabilities: {drop: [ALL], add: [IPC_LOCK]}` with no `runAsUser`, and
the pod crash-looped with `unable to set CAP_SETFCAP effective
capability: Operation not permitted`. Root cause, found by reading the
official image's own `docker-entrypoint.sh` directly: it starts as
root, runs `setcap cap_ipc_lock=+ep <vault binary>` (which itself needs
`CAP_SETFCAP`, not `IPC_LOCK`), then `su-exec vault` drops to the
non-root `vault` user (uid 100) before finally starting the server — the
*file* capability just set is what lets the post-drop process still
have `IPC_LOCK`. Granting only `IPC_LOCK` at the container level left
that `setcap` call itself failing before the privilege drop ever
happened.

Two fixes existed: grant `CAP_SETFCAP` too (let the image's own
mechanism run as designed, same class of fix as `pgbouncer.yaml`'s
setuid lesson below), or start the pod already as the non-root `vault`
uid/gid directly (`runAsUser: 100`, `runAsGroup: 1000` — confirmed via
`docker run ... id vault`, and `/vault/config`/`/vault/logs`/`/vault/file`
are already owned by that uid/gid at image build time) plus
`SKIP_SETCAP=true`, so the entrypoint's own `if [ "$(id -u)" = '0' ]`
check skips the `su-exec` step and `SKIP_SETCAP` skips the `setcap` call
entirely. The second, smaller-capability-set option was chosen — see the
Deployment's own `securityContext` comment for the full reasoning. The
container then only ever needs the one capability (`IPC_LOCK`) the
process actually uses at runtime, not the broader `CAP_SETFCAP` a
root-started container would transiently need to grant it to itself.

The mount-transit-engine → create-key → encrypt → decrypt sequence
`VaultTransitService` runs in the real app reproduces directly against
this Deployment (not just a `/sys/health` check), and the decrypted
plaintext matches the original exactly.

## `pgbouncer.yaml`: why a pooler exists at all

Two separate poolers (`pgbouncer-master`, `pgbouncer-replica`), each 2
replicas, transaction-mode pooling in front of `postgres.yaml`'s
`postgres-master`/`postgres-replica`. The reason this exists: each app
pod opens up to `extra.max: 20` connections (`app.module.ts`, one pool
for master writes, one for replica reads) — at `hpa.yaml`'s
`maxReplicas: 20` that's up to 400 potential direct connections against
each of master and replica, both configured for `max_connections=200`.
Already over budget at full scale, independent of data volume.
`DEFAULT_POOL_SIZE: 50` per pooler instance keeps real backend
connections well under that 200 limit, leaving headroom for
replication, migrations, and admin tooling.

No pod-level `securityContext` forcing non-root, deliberately: the
`edoburu/pgbouncer` image's entrypoint always writes a generated
`pgbouncer.ini` with a hardcoded `user = postgres` directive, which
PgBouncer itself then uses to `setuid()` from root down to the
`postgres` user after binding its listening socket — the image's own
built-in privilege-drop mechanism. Forcing the container to already
start as a non-root uid (an earlier version of this manifest did)
doesn't harden it further; it breaks that self-drop outright (`setuid`
to a *different* user than the one already running always fails with
`Operation not permitted`, root excepted) and crash-loops the pod on
both the `userlist.txt` write (no writable volume at `/etc/pgbouncer`
for a non-root user) and the `setuid` call itself. A real `psql` query
round-trips through the pooler successfully once the container is
allowed to start as root and self-drop.

`DB_HOST` for each pooler comes from `configmap.yaml`'s
`PGBOUNCER_MASTER_BACKEND_HOST`/`PGBOUNCER_REPLICA_BACKEND_HOST` —
deliberately separate from `DB_MASTER_HOST`/`DB_REPLICA_HOST`, which is
what the app itself connects to (the pooler, not the real database).
