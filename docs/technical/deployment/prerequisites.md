# Deployment Prerequisites and Maintenance Guide

`k8s/` is a coherent, deployable set — every manifest in it has a
backing Deployment/Service/PVC, not just a reference to a Service name
that nothing defines. See [`../k8s/`](../k8s/) for what each manifest
actually does; this document is the operational side — what has to
exist before those manifests will work, in what order to apply them,
and how to recognize the specific ways getting either wrong fails
silently. `kubectl apply -f k8s/` alone is not enough:
several pieces of cluster infrastructure this manifest set *assumes
already exist* are not part of `k8s/` itself, and getting them wrong
fails in ways that range from an obvious error to a completely silent,
no-error gap. This document exists so the next person deploying or
maintaining this doesn't have to rediscover any of it by hitting the
failure first.

## Cluster infrastructure that must exist before `k8s/` will work

None of the following live in this repo's `k8s/` folder. They are
cluster-wide infrastructure this application's manifests assume a
deployer has already installed — the same way `k8s/pgbouncer.yaml`
depends on `k8s/postgres.yaml`'s Services, but ingress-nginx and
cert-manager are different in kind: they're shared platform controllers
typically installed once per cluster, not something a single
application's manifest set should own.

### 1. A default `StorageClass`

`k8s/postgres.yaml` and `k8s/redis.yaml` each declare a
`PersistentVolumeClaim` with no `storageClassName` — they rely on the
cluster having a default `StorageClass` that can satisfy a
`ReadWriteOnce` claim. Every managed Kubernetes offering (EKS, GKE, AKS)
provides one out of the box; a bare-metal cluster might not. If these
PVCs stay `Pending` forever, this is the first thing to check
(`kubectl get storageclass`).

### 2. `ingress-nginx`, installed via Helm with specific values

```
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.config.add-headers=ingress-nginx/omniswitch-security-headers
kubectl label namespace ingress-nginx app.kubernetes.io/name=ingress-nginx
kubectl apply -f k8s/ingress-nginx-security-headers-configmap.yaml
```

Two non-obvious requirements this app's manifests depend on, neither of
which the Helm chart sets up automatically:

- **The `app.kubernetes.io/name=ingress-nginx` namespace label.**
  `k8s/network-policy.yaml`'s `allow-ingress-to-api` rule matches on this
  label via a `namespaceSelector`. A freshly Helm-installed
  `ingress-nginx` namespace only carries Kubernetes' own auto-added
  `kubernetes.io/metadata.name` — nothing labels it
  `app.kubernetes.io/name=ingress-nginx` on its own. Skip this label and
  ingress traffic to `omniswitch-api` is silently refused by the
  default-deny `NetworkPolicy`: no error anywhere, requests just time out
  at the TCP level.
- **`controller.config.add-headers` pointing at
  `k8s/ingress-nginx-security-headers-configmap.yaml`'s ConfigMap.**
  `k8s/ingress.yaml`'s security headers (`X-Frame-Options`, CSP, HSTS,
  etc.) are set this way rather than via a per-Ingress
  `nginx.ingress.kubernetes.io/configuration-snippet` annotation — modern
  `ingress-nginx` releases reject that annotation outright by default
  (`allowSnippetAnnotations: false`, a security-hardening default), and
  the specific `more_set_headers` directive these headers would need is
  separately flagged as a "risky annotation" by an independent check even
  when that flag is turned back on. `controller.config.add-headers` is
  the mechanism that actually works. Skip this wiring and the Ingress
  still deploys and serves traffic fine — it just silently never sends
  the security headers. No error, no warning, nothing in the logs; the
  only way to notice is to check the response headers directly.

### 3. `cert-manager`, with a real `ClusterIssuer` named `letsencrypt-prod`

```
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
```

`k8s/ingress.yaml`'s `cert-manager.io/cluster-issuer: "letsencrypt-prod"`
annotation names a `ClusterIssuer` that must be created separately — this
repo intentionally does not include one, since the right configuration is
environment-specific (a real deployment needs a real ACME account/email
and a DNS-01 or HTTP-01 solver, none of which this repo can supply
generically). A minimal real one:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: <real ops contact email>
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
```

For local/offline testing only — never for anything real — a
`selfSigned: {}` issuer under the same name exercises the same
cert-manager code path (watching for a `ClusterIssuer` of a given name
and issuing against it) without needing real DNS or a real ACME account.

## Deployment order

`kubectl apply -f k8s/` applies everything in one pass and mostly
self-heals via each Deployment's own retry/readiness behavior, but the
dependency order that actually matters if deploying by hand or debugging
a partial rollout:

1. `configmap.yaml`, `secret.yaml` — everything else reads from these.
2. `postgres.yaml`, `redis.yaml`, `vault.yaml` — the data-layer backends.
   `postgres.yaml`'s replica specifically needs `postgres-master`
   reachable to complete its `pg_basebackup` bootstrap on first start.
3. `network-policy.yaml` — apply before or alongside the above, not
   after; a `default-deny-all` policy applied *after* pods are already
   talking to each other doesn't reliably retroactively break existing
   connections on every CNI. Apply it early and let the explicit allow
   rules do their job from the start.
4. `pgbouncer.yaml` — depends on `postgres.yaml` being reachable
   (`PGBOUNCER_MASTER_BACKEND_HOST`/`PGBOUNCER_REPLICA_BACKEND_HOST` in
   `configmap.yaml`).
5. `deployment.yaml`, `service.yaml`, `hpa.yaml` — the application itself.
   Depends on `pgbouncer.yaml`, `redis.yaml`, and `vault.yaml` all being
   reachable — see `k8s/deployment.yaml`'s own comments on
   `DB_MASTER_PORT`/`DB_REPLICA_PORT`/`VAULT_ADDR` for why each of those
   specific env vars matters (a missing `DB_REPLICA_PORT`, in particular,
   fails the whole `DataSource.initialize()` call rather than just the
   replica connection, since TypeORM's `replication` mode treats
   master+replica startup as one unit).
6. `ingress.yaml` — depends on `service.yaml` existing (routes to the
   `omniswitch-api` Service) and on `cert-manager`/the `letsencrypt-prod`
   `ClusterIssuer` above already existing (issues the TLS certificate).
7. `archiving-cronjob.yaml`, `deletion-cronjob.yaml`,
   `partition-maintenance-cronjob.yaml`, `drop-cutover-tables-job.yaml` —
   no ordering dependency on each other or on step 6; depend on
   `pgbouncer.yaml` the same way the app does.

## Known silent-failure gotchas

None of the following produce an error at `kubectl apply` time. Every one
looks like a successful, healthy deployment right up until the specific
behavior it affects is actually exercised.

| Symptom | Cause | Where it's covered |
|---|---|---|
| App pod crash-loops on boot, `DataSource.initialize()` failing | `DB_MASTER_PORT`/`DB_REPLICA_PORT` missing from `deployment.yaml`'s env | [`../k8s/application.md`](../k8s/application.md) |
| `pgbouncer` pod crash-loops on `setuid`/writing `userlist.txt` | A `securityContext` forcing non-root — breaks the `edoburu/pgbouncer` image's own root→non-root privilege-drop mechanism | [`../k8s/data-layer.md`](../k8s/data-layer.md) |
| `vault` pod `CrashLoopBackOff`, `unable to set CAP_SETFCAP` | A `securityContext` granting `IPC_LOCK` but not accounting for the official image's own root→non-root `setcap`/`su-exec` sequence | [`../k8s/data-layer.md`](../k8s/data-layer.md) |
| `redis` pod healthy, but `requirepass` never actually enforced | A YAML multi-line `command` missing shell `\` line-continuations — `exec redis-server` alone is a complete statement, silently dropping every flag after it | [`../k8s/data-layer.md`](../k8s/data-layer.md) |
| Ingress traffic to `omniswitch-api` refused, no error | `ingress-nginx` namespace missing the `app.kubernetes.io/name=ingress-nginx` label `network-policy.yaml`'s `namespaceSelector` needs | This document, section 2 above |
| Ingress responses missing all 5 security headers, no error | `ingress-nginx` installed without `controller.config.add-headers` wired to `k8s/ingress-nginx-security-headers-configmap.yaml` | This document, section 2 above; [`../k8s/networking.md`](../k8s/networking.md) |

## Verifying a deployment actually works, not just that it applied cleanly

`scripts/network-policy-verify.sh` proves both that unauthorized traffic
is refused and that the app's own required traffic is allowed, which a
`kubectl apply` succeeding cannot tell you on its own. Every gotcha in
the table above was found by actually deploying to a real cluster and
testing the real behavior — reviewing the YAML by eye did not surface any
of them. That's worth keeping in mind for any future change to `k8s/`:
a manifest that parses correctly and a pod that reaches `Running` are
both necessary and both insufficient to call a change verified.
