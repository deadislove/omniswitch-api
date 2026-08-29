# Deployment

How to actually get `k8s/` running, as opposed to
[`../k8s/`](../k8s/), which documents what each manifest is and why
it's shaped the way it is. Start here if you're trying to answer "how
do I deploy this," not "what does this manifest do."

- [`prerequisites.md`](./prerequisites.md) — cluster infrastructure
  `k8s/` assumes already exists (a default `StorageClass`,
  `ingress-nginx` with specific Helm values, `cert-manager` with a real
  `ClusterIssuer`), the dependency order manifests need to be applied
  in, and a table of known silent-failure gotchas — things that produce
  no error at `kubectl apply` time but silently don't work
- [`runbook.md`](./runbook.md) — the literal command sequence, start to
  finish, from an empty cluster to a verified working deployment
- [`charge-latency-test-environment.md`](./charge-latency-test-environment.md) —
  how to temporarily stand up a mock PSP on top of a real deployment,
  for exercising a full charge round-trip (end-to-end latency
  measurement, adapter testing) without pointing `k8s/configmap.yaml`'s
  production PSP URLs at anything real
