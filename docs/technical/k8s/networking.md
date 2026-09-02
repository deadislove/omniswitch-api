# Networking: NetworkPolicy, Ingress, TLS

## `network-policy.yaml`: default-deny plus 14 explicit allows

This is ordinary least-privilege pod-to-pod traffic control for the
`payments` namespace, not full PCI DSS Requirement 1 CDE segmentation —
this system's whole design intent is to never hold a raw PAN in the
first place, so there is no CDE to isolate. See
[`../security-and-compliance.md`](../security-and-compliance.md)'s
"Network segmentation" section for that framing. Without this file, any
pod in the namespace could reach any other pod on any port, including
the database/cache/secrets-store pods holding merchant credentials and
HMAC/TOTP secrets — that's the gap it closes.

Requires a `NetworkPolicy`-enforcing CNI (Calico, Cilium, etc.) to have
any effect at all — a cluster's default CNI commonly does not enforce
this resource and would silently no-op. `scripts/network-policy-verify.sh`
is the tool for confirming a specific cluster actually enforces these
rules, and that they're neither too permissive nor accidentally blocking
real traffic — it checks both directions (an unauthorized pod refused,
the app's own intended traffic still allowed), which a manifest reviewed
by eye alone cannot prove either half of.

### Rule 1: `default-deny-all`

`podSelector: {}` with both `Ingress` and `Egress` in `policyTypes` —
every rule below is an explicit exception carved out of this one.

### Rule 2: `allow-dns-egress`

Every pod still needs to resolve cluster DNS names
(`pgbouncer-master.payments.svc.cluster.local`, etc.) — without this,
default-deny egress breaks name resolution for every other rule below
before it even gets a chance to matter.

### Rules 3–7: the app's own traffic paths

`allow-ingress-to-api` (ingress controller → `omniswitch-api`, port
`3000`), `allow-api-to-pgbouncer`, `allow-pgbouncer-to-postgres`,
`allow-api-to-redis`, `allow-api-to-vault` — each named for exactly the
path it allows. `allow-ingress-to-api` is the one rule in this file
whose source isn't a manifest this repo defines (see "What's assumed"
below).

### Rules 8–11: the ingress-side counterparts, and why they're separate rules

A Kubernetes `NetworkPolicy` Egress rule only controls what the *source*
pod is allowed to send — it does not implicitly permit the matching
traffic on the *destination* pod's side. Because `default-deny-all` sets
`Ingress: deny` for every pod in the namespace, PgBouncer/Postgres/
Redis/Vault each also need an explicit Ingress-allow rule naming which
pod may reach them, or they refuse the connection even though the
source's Egress rule permits sending it. This was a real, found-live
bug: applying only the Egress-side rules to a real `NetworkPolicy`-
enforcing cluster left every one of these four connections timing out
from an `omniswitch-api` pod, despite its own Egress rules explicitly
allowing that traffic — the packets left the source pod and were
dropped on arrival at the destination.

`allow-ingress-to-pgbouncer` accepts two independent sources (`from`
list entries are OR'd, not ANDed): `omniswitch-api` and any
`workload-type: batch-job` pod (the archiving/deletion/
partition-maintenance/drop-cutover-tables jobs, which also go through
PgBouncer rather than connecting to Postgres directly).

`allow-ingress-to-postgres` additionally allows `postgres-replica`
itself as a source, on top of the pgbouncer sources — this is the
replica's own streaming-replication connection to the master
(`pg_basebackup` plus its ongoing WAL stream), easy to miss since this
rule's `podSelector` already covers both `postgres-master` and
`postgres-replica`, but this particular `from` entry is only ever
relevant to the master. A separate rule,
`allow-postgres-replica-to-master`, is the Egress-side counterpart on
the replica's own pod. Without both, a default-deny cluster lets
PgBouncer through while silently blocking replication itself — which
`postgres.yaml`'s replica depends on to boot at all. See
[`data-layer.md`](./data-layer.md) for the replication mechanism this
rule protects.

### Rule 12: `allow-batch-jobs-to-pgbouncer`

Selected by the shared `workload-type: batch-job` label every job's pod
template carries (read directly from each `*-cronjob.yaml`/
`*-job.yaml` manifest, not guessed), rather than each job's own distinct
`app:` label — a future fifth job only needs this one label to be
covered automatically.

### Rule 13: `allow-prometheus-to-api`

Matches on `kubernetes.io/metadata.name: monitoring` (the label every
namespace gets automatically from Kubernetes itself), assuming
Prometheus runs in a namespace literally named `monitoring` — see "What's
assumed" below.

### What's assumed, not confirmed against a real manifest

`ingress-nginx` (rule 3) and Prometheus (rule 13) are the two sources
this file has no manifest in this repo to check its label/namespace
assumptions against — `postgres-master`/`postgres-replica`/`redis`/
`vault` used to be in this same category before their real manifests
existed (see [`data-layer.md`](./data-layer.md)); confirming
`ingress-nginx`'s actual namespace label was part of installing it for
real — see
[`../deployment/prerequisites.md`](../deployment/prerequisites.md).

### What's explicitly NOT covered

- **Outbound egress from `omniswitch-api` to Stripe/Adyen over the
  public internet (443)** — `configmap.yaml`'s `ADYEN_BASE_URL` points
  at the real `checkout-live.adyen.com`. A default-deny egress policy
  with no rule for this breaks every real charge/refund/capture/
  dispute-evidence call the moment this policy is applied to a cluster
  actually processing payments. Harder to express as a static
  `NetworkPolicy` than the rules above — Stripe/Adyen don't publish
  fixed IP ranges a plain `ipBlock` could pin, so this needs either a
  DNS-aware egress mechanism (e.g. Cilium) or an explicit egress proxy.
  Left as an open decision, not guessed at.
- **Egress from the batch-job pods to a cloud `BackupStorage`
  endpoint** (S3/GCS/Azure), when `DELETION_BACKUP_STORAGE` isn't
  `"local"` (the default, which needs no network egress at all).

## `ingress.yaml`

Routes `api.omniswitch.io`'s `/api/v1`, `/health`, and `/api/docs`
prefixes to `omniswitch-api`'s Service on port `80` (not `3000` — see
[`application.md`](./application.md)'s note on Service vs. container
port). `nginx.ingress.kubernetes.io/ssl-redirect` and
`force-ssl-redirect` send plain HTTP to HTTPS; `limit-rps`/
`limit-connections` are an ingress-level backstop behind the app's own
rate limiting; `proxy-read-timeout`/`proxy-send-timeout`/
`proxy-buffering: off` support Server-Sent Events; `proxy-body-size:
50m` allows bulk uploads.

`cert-manager.io/cluster-issuer: "letsencrypt-prod"` names a
`ClusterIssuer` this file assumes already exists — see
[`../deployment/prerequisites.md`](../deployment/prerequisites.md) for
what a real one needs (a real ACME account/email, a DNS-01 or HTTP-01
solver) versus a self-signed stand-in for local testing that exercises
the same cert-manager mechanism under the same name.

### Security headers live in `ingress-nginx-security-headers-configmap.yaml`, not here

This Ingress does **not** set its 5 security headers
(`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`,
`Referrer-Policy`, `Strict-Transport-Security`,
`Content-Security-Policy`) via a per-Ingress
`nginx.ingress.kubernetes.io/configuration-snippet` annotation, and this
was a real, confirmed deployment blocker, not a stylistic choice: a
default-configured modern `ingress-nginx` install rejects that
annotation outright at admission time
(`allowSnippetAnnotations: false` has been the chart default since
`ingress-nginx` ~v1.9, a CVE-driven hardening default). Re-enabling that
flag doesn't help either — the specific `more_set_headers` directive
these headers would need is separately flagged as a "risky annotation"
by an independent admission check, regardless of the flag. There is no
supported way to keep a `configuration-snippet` annotation and have this
Ingress deploy against a default-configured controller.

The fix: these 5 headers are set via `ingress-nginx`'s controller-level
`add-headers` global config instead —
`ingress-nginx-security-headers-configmap.yaml` is the `ConfigMap`
holding the header values, deployed to the `ingress-nginx` namespace
(not `payments`, unlike every other manifest here) because it wires
into the controller's own config, not into anything this app's
Deployment/Service reads directly. This only takes effect if whoever
installs `ingress-nginx` sets
`controller.config.add-headers=ingress-nginx/omniswitch-security-headers`
at Helm-install time — see
[`../deployment/prerequisites.md`](../deployment/prerequisites.md) for
the exact command. Skipping that wiring doesn't produce an error: the
Ingress deploys fine and serves traffic fine, it just silently never
sends the security headers.

This is coarser-grained than a per-Ingress annotation would have been —
`add-headers` applies to every route this `ingress-nginx` install
serves, not just `omniswitch-api-ingress` — but this repo's own
`ingress-nginx` is assumed dedicated to this one application rather than
shared multi-tenant, so that broader scope is the correct one here, not
a compromise.

Against a real Helm-installed `ingress-nginx` + `cert-manager`: a
self-signed `ClusterIssuer` under the real `letsencrypt-prod` name
issues a real certificate, HTTPS termination and the HTTP→HTTPS redirect
both work, all three path rules route correctly, all 5 security headers
appear on every response including the redirect itself, and
`allow-ingress-to-api` is load-bearing in both directions — removing it
breaks the path, restoring it fixes it.
