terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No `backend` block — same chicken-and-egg reasoning as the other two
  # clouds' bootstrap/main.tf. This root module's own state stays local.
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "state" {
  name     = "${var.project}-terraform-state-rg"
  location = var.location
  tags     = var.tags
}

# Storage account names must be globally unique across ALL of Azure,
# 3-24 chars, lowercase letters/digits only (no hyphens) — much tighter
# than S3/GCS bucket naming, and this project's own hyphenated name
# doesn't fit as a prefix without stripping it down. A random suffix
# fills the uniqueness role AWS's account ID / GCP's project ID played
# in the other two bootstrap modules.
resource "random_string" "suffix" {
  length  = 16
  special = false
  upper   = false
}

resource "azurerm_storage_account" "terraform_state" {
  name                     = "tfstate${random_string.suffix.result}"
  resource_group_name      = azurerm_resource_group.state.name
  location                 = azurerm_resource_group.state.location
  account_tier             = "Standard"
  account_replication_type = "GRS"

  blob_properties {
    versioning_enabled = true
  }

  # Deny-by-default network ACL, with only first-party Azure services
  # bypassing it — Azure's own default when no network_rules block is
  # declared at all is "Allow" (see
  # https://learn.microsoft.com/en-us/azure/storage/common/storage-network-security),
  # which would leave the state backend reachable from any IP on the
  # internet (auth-gated, but still a wider blast radius than needed).
  # This does mean `terraform init` against this backend won't work from
  # an arbitrary laptop/CI runner until whoever operates this adds their
  # own IP via ip_rules or a private endpoint — not yet configured, same
  # "secure by default, not yet wired for real usage" posture as the
  # connection-pooling gap documented in
  # ../../../docs/technical/deployment/infrastructure-as-code.md.
  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  tags = var.tags
}

resource "azurerm_storage_container" "terraform_state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.terraform_state.id
  container_access_type = "private"

  # Azure's backend uses blob leases for state locking natively — same
  # "no separate lock-table resource needed" story as GCS, and unlike
  # AWS's S3 backend, which needed a DynamoDB table.
}
