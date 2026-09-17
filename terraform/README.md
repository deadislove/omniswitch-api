# Terraform

Provisions the cloud infrastructure `k8s/`'s manifests assume already
exists — the VPC, the Kubernetes cluster itself, IAM, managed
database/cache, and key-management/HSM.

**Status**: AWS (`aws/`), GCP (`gcp/`), and Azure (`azure/`) all have
real modules, written and `terraform fmt`/`validate`-clean, but **not
yet applied against a real account on any of the three** — no cloud
credentials exist in the environment this was authored in, so
`terraform plan`/`apply` and every real connectivity check are still
outstanding across all three clouds. See
[`../docs/technical/deployment/infrastructure-as-code.md`](../docs/technical/deployment/infrastructure-as-code.md)
for the full breakdown of what's built, the security posture, and every
known gap.

## The boundary with `k8s/` — read this before adding anything here

Terraform's scope stops at **the cluster and everything below it**:
VPC/network, IAM, the EKS cluster itself plus cluster-wide add-ons
(`metrics-server`, the VPA controller components, Prometheus Adapter),
managed database/cache/object storage, and KMS/HSM.

Everything **inside** the cluster that belongs to this specific
application — `Deployment`, `Service`, `HPA`, `VPA` (the CR instance,
not the controller), `NetworkPolicy`, `ConfigMap`, `CronJob` — stays in
[`../k8s/`](../k8s/), applied via `kubectl` (or a GitOps tool later),
**not** through Terraform's Kubernetes/Helm provider. Mixing
infrastructure provisioning and application deployment into one
Terraform state is a well-known anti-pattern (infrastructure changes
rarely and carries more blast radius; application deploys happen
constantly and need fast iteration) — keeping them apart is deliberate,
not an oversight.

## Structure

```
terraform/
├── aws/
│   ├── bootstrap/       # one-time: creates the S3+DynamoDB remote state
│   │                    #   backend itself, using local state (chicken-egg
│   │                    #   problem — the backend can't manage its own state)
│   ├── modules/
│   │   ├── network/     # hand-rolled: VPC, subnets, NAT/IGW, route tables
│   │   ├── iam/         # hand-rolled: least-privilege roles
│   │   ├── container-service/  # wraps terraform-aws-modules/eks (pinned)
│   │   ├── cloud-saas/  # RDS, ElastiCache, S3, Secrets Manager
│   │   └── hsm/         # KMS (CloudHSM is a later, separate decision)
│   └── environments/
│       ├── dev/
│       ├── staging/     # scaffold only until dev is proven
│       └── production/  # scaffold only until dev is proven
├── gcp/
│   ├── bootstrap/       # one-time: GCS remote state backend (native locking,
│   │                    #   no separate lock table needed unlike AWS)
│   ├── modules/
│   │   ├── network/     # hand-rolled: one regional VPC-native subnet, Cloud NAT
│   │   ├── iam/         # hand-rolled: least-privilege roles + WIF for GitHub Actions
│   │   ├── container-service/  # wraps terraform-google-modules/kubernetes-engine (pinned)
│   │   ├── cloud-saas/  # Cloud SQL, Memorystore, GCS, Secret Manager
│   │   └── hsm/         # Cloud KMS (Cloud HSM is a later, separate decision)
│   └── environments/
│       ├── dev/
│       ├── staging/
│       └── production/
├── azure/
│   ├── bootstrap/       # one-time: Storage Account remote state backend (blob
│   │                    #   lease locking, no separate lock table needed)
│   ├── modules/
│   │   ├── network/     # hand-rolled: Resource Group, VNet, one subnet, NAT Gateway
│   │   ├── iam/         # hand-rolled: least-privilege role + Federated Identity Credential
│   │   ├── container-service/  # wraps Azure/aks/azurerm (pinned)
│   │   ├── cloud-saas/  # Postgres Flexible Server, Cache for Redis, Storage, Key Vault
│   │   └── hsm/         # Premium (HSM-backed) Key Vault key (Managed HSM is a later, separate decision)
│   └── environments/
│       ├── dev/
│       ├── staging/
│       └── production/
└── shared/
    └── tagging.md       # the one tag/label schema all three clouds map onto
```

**Why hand-rolled network/IAM but a community module for the cluster**:
the network and IAM shape here is simple enough that hand-rolling it is
both fast and legible — no external dependency to pin and trust. EKS is
a different story: a real production-grade EKS setup carries a lot of
accumulated operational detail (launch template quirks, IRSA OIDC
wiring, addon lifecycle management) that a well-maintained community
module has already gotten right — re-deriving that from scratch buys
little and risks missing something subtle. This split is deliberate,
not an inconsistency.

## Running this

Same shape for all three clouds — substitute `aws`/`gcp`/`azure` below:

```bash
# One-time, per cloud account/project/subscription: create the remote
# state backend itself
cd aws/bootstrap   # or gcp/bootstrap, or azure/bootstrap
terraform init
terraform apply

# Then, per environment:
cd ../environments/dev
cp terraform.tfvars.example terraform.tfvars   # fill in real values, never commit this file
cp backend.hcl.example backend.hcl             # fill in the bootstrap output values, never commit this file
terraform init -backend-config=backend.hcl
terraform fmt -check
terraform validate
terraform plan
# terraform apply only after a human has reviewed the plan output
```

No credentials for any of the three clouds exist in the environment
this was authored in — `terraform fmt`/`validate` were run and pass on
all three; `plan`/`apply` need to be run by whoever has real credentials,
against a real account. Same honest "mechanism is real, never run
against a real account yet" posture this codebase already uses for the
ACH/wire bank rails and the Persona KYC integration.
