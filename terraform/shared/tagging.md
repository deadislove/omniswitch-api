# Tagging / Labeling Convention

One shared schema across all three clouds, even though each cloud's
native mechanism has a different name (AWS/Azure: tags, GCP: labels).
This file is the single source of truth for the schema — each cloud's
modules map onto it using their own native syntax, not each
independently inventing their own key set.

| Key | Example value | Purpose |
|---|---|---|
| `project` | `omniswitch-api` | Identify which project a resource belongs to across accounts/subscriptions |
| `environment` | `dev` / `staging` / `production` | Environment isolation and cost splitting |
| `managed-by` | `terraform` | Signals this resource is IaC-managed — don't hand-edit it in a console |
| `component` | `network` / `iam` / `container-service` / `cloud-saas` / `hsm` | Maps to the module categories in the plan doc |
| `owner` | (team/individual) | Audit and on-call routing |
| `cost-center` | (optional) | Only if cost needs to be split further |

## How it's enforced

Every module accepts a single `tags` (AWS/Azure) or `labels` (GCP)
input variable, populated once at the `environments/*` root and passed
down — no module decides its own tag set independently. See
`aws/modules/network/variables.tf`'s `tags` variable for the reference
shape other modules and other clouds should match.

A stricter version of this (not built yet) would add a CI policy check
(`checkov`/`tfsec` custom rule) that fails `terraform plan` if a
resource is missing a required tag — see the plan doc's CI section.
