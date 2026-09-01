# Kubernetes Manifests

`k8s/` is a coherent, deployable set — every manifest either backs a
real Deployment/Service this application owns, or is the application
itself. This folder documents what's actually in `k8s/` and why it's
shaped the way it is; for how to actually get it running (install
order, cluster prerequisites, known gotchas), see
[`../deployment/`](../deployment/) instead — that's the operational
runbook, this is the reference.

Background jobs (`archiving-cronjob.yaml`, `deletion-cronjob.yaml`,
`partition-maintenance-cronjob.yaml`, `drop-cutover-tables-job.yaml`)
are covered by [`../jobs.md`](../jobs.md), not repeated here — that doc
already goes deep on the job subsystem's own architecture, the
`BackupStorage` factory pattern, and the `workload-type: batch-job` pod
label these manifests all carry.

## What's here

- [`data-layer.md`](./data-layer.md) — `postgres.yaml`, `redis.yaml`,
  `vault.yaml`, `pgbouncer.yaml`: the real backing services this app
  depends on, each single-instance and built to mirror
  `docker-compose.yml`'s known-working local config rather than
  inventing new topology
- [`application.md`](./application.md) — `deployment.yaml`,
  `service.yaml`, `hpa.yaml`, `configmap.yaml`, `secret.yaml`,
  `external-secrets-example.yaml`: the application itself, its scaling
  behavior, and its configuration/secret wiring
- [`networking.md`](./networking.md) — `network-policy.yaml` (the
  namespace's default-deny-plus-explicit-allow segmentation model) and
  `ingress.yaml`/`ingress-nginx-security-headers-configmap.yaml` (TLS
  termination, routing, security headers)

## What's real vs. what's assumed to already exist

Everything in the table below is a real, tracked manifest in `k8s/`.
Three things `k8s/` depends on are deliberately **not** in it, because
they're shared cluster infrastructure rather than something this one
application should own or ship:

| Dependency | Why it's not in `k8s/` |
|---|---|
| A default `StorageClass` | Cluster-wide provisioning concern, not application-specific |
| `ingress-nginx` (the controller itself) | Typically one shared install per cluster, not per-application |
| `cert-manager` + a `ClusterIssuer` | Same reasoning, plus the right issuer config (real ACME account, DNS) is environment-specific |

See [`../deployment/prerequisites.md`](../deployment/prerequisites.md)
for how to actually install and wire up each of these three.

## Manifest inventory

| File | Kind(s) | Covered in |
|---|---|---|
| `postgres.yaml` | Deployment, Service, PVC, ConfigMap (init scripts) | [`data-layer.md`](./data-layer.md) |
| `redis.yaml` | Deployment, Service, PVC | [`data-layer.md`](./data-layer.md) |
| `vault.yaml` | Deployment, Service | [`data-layer.md`](./data-layer.md) |
| `pgbouncer.yaml` | Deployment, Service (x2 — master/replica poolers) | [`data-layer.md`](./data-layer.md) |
| `deployment.yaml` | Deployment | [`application.md`](./application.md) |
| `service.yaml` | Service | [`application.md`](./application.md) |
| `hpa.yaml` | HorizontalPodAutoscaler | [`application.md`](./application.md) |
| `configmap.yaml` | ConfigMap | [`application.md`](./application.md) |
| `secret.yaml` | Secret | [`application.md`](./application.md) |
| `external-secrets-example.yaml` | SecretStore, ExternalSecret (illustrative, not applied) | [`application.md`](./application.md) |
| `network-policy.yaml` | NetworkPolicy (x14) | [`networking.md`](./networking.md) |
| `ingress.yaml` | Ingress | [`networking.md`](./networking.md) |
| `ingress-nginx-security-headers-configmap.yaml` | ConfigMap | [`networking.md`](./networking.md) |
| `archiving-cronjob.yaml`, `deletion-cronjob.yaml`, `partition-maintenance-cronjob.yaml`, `drop-cutover-tables-job.yaml` | CronJob (x3), Job | [`../jobs.md`](../jobs.md) |
