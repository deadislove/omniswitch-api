# Partial backend configuration — deliberately no bucket/table names here.
# Terraform's backend block can't reference variables (it's evaluated before
# any variables are resolved), and the bucket/table names depend on the AWS
# account ID (see ../../bootstrap/main.tf's local.state_bucket_name), which
# isn't a fixed literal this file could safely hardcode across accounts.
#
# Supply the real values at `terraform init` time instead:
#   terraform init -backend-config=backend.hcl
# using a backend.hcl you create locally from backend.hcl.example, filled in
# with the outputs of `terraform output` in ../../bootstrap. backend.hcl
# itself is gitignored (see ../../../.gitignore) — it is real deployment
# config, not something to commit.

terraform {
  backend "s3" {
    key     = "dev/terraform.tfstate"
    encrypt = true
  }
}
