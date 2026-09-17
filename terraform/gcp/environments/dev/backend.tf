# Partial backend configuration — same reasoning as
# ../../aws/environments/dev/backend.tf: the bucket name depends on the
# GCP project ID, which this file can't safely hardcode across accounts.
#
# Supply the real value at `terraform init` time:
#   terraform init -backend-config=backend.hcl
# using a backend.hcl you create locally from backend.hcl.example.
# backend.hcl itself is gitignored — real deployment config, not for
# commit.

terraform {
  backend "gcs" {
    prefix = "dev"
  }
}
