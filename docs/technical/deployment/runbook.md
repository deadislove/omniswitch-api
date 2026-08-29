# Deployment Runbook

The literal command sequence for taking a fresh, empty Kubernetes
cluster to a working deployment. See
[`prerequisites.md`](./prerequisites.md) for *why* each prerequisite
step below is needed and the specific silent-failure modes each one
guards against — this document is the commands, that one is the
reasoning.

## 1. Cluster infrastructure

```
# ingress-nginx, cert-manager, and a ClusterIssuer named letsencrypt-prod —
# see prerequisites.md sections 2 and 3 for the exact Helm commands and
# why each --set/label matters.
```

A default `StorageClass` (prerequisites.md section 1) needs no action on
a managed Kubernetes offering (EKS/GKE/AKS) — verify one exists with
`kubectl get storageclass` before continuing on anything else.

## 2. Namespace and configuration

```bash
kubectl create namespace payments
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
```

Before this step on a real deployment: replace every `CHANGE_ME_*`
placeholder in `k8s/secret.yaml` with a real value (or point it at a
real secrets backend — see [`../k8s/application.md`](../k8s/application.md)'s
`external-secrets-example.yaml` section). Applying the file as-is is
fine for a local/test cluster, not for anything real.

## 3. Network policy

```bash
kubectl apply -f k8s/network-policy.yaml
```

Applied here, before any of the pods it governs exist — see
[`../k8s/networking.md`](../k8s/networking.md) for why applying a
`default-deny-all` policy after pods are already talking to each other
isn't reliably equivalent across every CNI.

## 4. Data layer

```bash
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/vault.yaml
kubectl wait --for=condition=Ready pod -l app=postgres-master -n payments --timeout=120s
kubectl wait --for=condition=Ready pod -l app=postgres-replica -n payments --timeout=120s
kubectl wait --for=condition=Ready pod -l app=redis -n payments --timeout=60s
kubectl wait --for=condition=Ready pod -l app=vault -n payments --timeout=60s
kubectl apply -f k8s/pgbouncer.yaml
kubectl wait --for=condition=Ready pod -l app=pgbouncer-master -n payments --timeout=60s
kubectl wait --for=condition=Ready pod -l app=pgbouncer-replica -n payments --timeout=60s
```

Waiting for each layer before applying the next isn't strictly required
(`pgbouncer` retries its backend connection, the app retries its
`DataSource.initialize()` call), but turns a failure at any layer into
an immediate, localized error instead of a confusing failure two steps
later.

## 5. The application

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/hpa.yaml
kubectl rollout status deployment/omniswitch-api -n payments --timeout=120s
```

The container's own entrypoint runs pending migrations before starting
the server (`node ./node_modules/typeorm/cli.js ... migration:run &&
exec node dist/main.js` — see the `Dockerfile`'s final `CMD`), so no
separate migration `Job` is needed. **Open question, not verified
either way**: `deployment.yaml` defaults to 3 replicas starting
concurrently on a fresh deploy, each running `migration:run`
independently — whether TypeORM's own migration-locking behavior makes
three simultaneous `migration:run` invocations against an empty schema
safe hasn't been tested here. If a fresh deploy's pods crash-loop with a
migration-related error, this is the first thing to suspect; scaling to
1 replica for the very first deploy, then back to 3, sidesteps the
question entirely if it turns out to matter.

## 6. Ingress

```bash
kubectl apply -f k8s/ingress.yaml
kubectl get certificate omniswitch-tls-cert -n payments -w
```

Wait for the `Certificate` to report `READY: True` before expecting
HTTPS to work — `cert-manager` issuing against a real ACME server can
take anywhere from a few seconds (self-signed, local testing) to a
minute or more (real Let's Encrypt HTTP-01 challenge).

## 7. Background jobs

```bash
kubectl apply -f k8s/archiving-cronjob.yaml
kubectl apply -f k8s/deletion-cronjob.yaml
kubectl apply -f k8s/partition-maintenance-cronjob.yaml
kubectl apply -f k8s/drop-cutover-tables-job.yaml
```

No ordering dependency on step 6 or on each other — see
[`../jobs.md`](../jobs.md) for what each one does.

## Verifying the deployment, not just that every `kubectl apply` succeeded

```bash
kubectl get pods -n payments
NETPOL_VERIFY_NAMESPACE=payments bash scripts/network-policy-verify.sh
curl -sk https://<your-host>/health/ready
```

`scripts/network-policy-verify.sh` proves the `NetworkPolicy` rules are
both correctly scoped (unauthorized pods refused) and not accidentally
too narrow (the app's own required traffic still works) — a
`kubectl apply` succeeding, or every pod reaching `Running`, proves
neither of those on its own. See
[`../k8s/networking.md`](../k8s/networking.md) for what the script
actually checks.
