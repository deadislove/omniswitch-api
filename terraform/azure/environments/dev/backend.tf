# Partial backend configuration — same reasoning as the other two
# clouds' backend.tf: the storage account name is a random-suffixed
# value only known after ../../bootstrap has been applied, so it can't
# be hardcoded here.
#
# Supply the real values at `terraform init` time:
#   terraform init -backend-config=backend.hcl
# using a backend.hcl you create locally from backend.hcl.example.
# backend.hcl itself is gitignored — real deployment config, not for
# commit.

terraform {
  backend "azurerm" {
    key = "dev.terraform.tfstate"
  }
}
