terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# NOTE on scope — same posture as ../../aws/modules/hsm and
# ../../gcp/modules/hsm: target state for
# src/shared/vault/vault-transit.service.ts, not an automatic cutover.
#
# Premium SKU, not Standard — Standard-SKU Key Vault keys are purely
# software-protected; Premium backs keys with an actual HSM (FIPS 140-2
# Level 2 validated), the fair equivalent of AWS KMS/GCP Cloud KMS's
# default HSM-backed guarantee. This is a SEPARATE Key Vault from
# ../cloud-saas's — see that module's top-of-file note for why Azure
# needing two Key Vaults here isn't a mistake or duplication.
#
# Real Azure Managed HSM (dedicated, single-tenant hardware — Azure's
# CloudHSM/Cloud HSM equivalent) is explicitly NOT built here, same
# "十、開放決策" item 4 reasoning as the other two clouds' hsm modules.

locals {
  name = "${var.project}-${var.environment}"
}

resource "azurerm_key_vault" "hsm" {
  # Same 24-char naming limit as ../cloud-saas's Key Vault — see that
  # module's comment for why the project prefix is dropped.
  name                = "kv-${var.environment}-hsm"
  resource_group_name = var.resource_group_name
  location            = var.location
  tenant_id           = data.azurerm_client_config.current.tenant_id

  sku_name = "premium"

  rbac_authorization_enabled = true

  # Blocks permanent deletion during the retention window (protects
  # against an accidental `terraform destroy` losing key material for
  # good) — the real tradeoff is that a genuinely-intended teardown of
  # this vault also can't fully complete until that window passes, same
  # "safety costs a bit of destroy-friction" shape as
  # ../../aws/modules/hsm's deletion_window_in_days on its KMS key.
  purge_protection_enabled = true

  tags = var.tags
}

# RBAC-mode Key Vaults grant NOBODY access by default, not even the
# identity that just created the vault — unlike AWS/GCP, where the
# deploying identity's own broad IAM role already covers key creation.
# Without this explicit self-grant, the azurerm_key_vault_key resource
# below would fail with a 403 on its very first apply.
resource "azurerm_role_assignment" "terraform_key_admin" {
  scope                = azurerm_key_vault.hsm.id
  role_definition_name = "Key Vault Crypto Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_key" "hmac_secrets" {
  name         = "hmac-secrets"
  key_vault_id = azurerm_key_vault.hsm.id
  key_type     = "RSA-HSM"
  key_size     = 2048
  key_opts     = ["encrypt", "decrypt", "wrapKey", "unwrapKey"]

  depends_on = [azurerm_role_assignment.terraform_key_admin]
}

resource "azurerm_role_assignment" "allowed_principals" {
  for_each = toset(var.allowed_principal_object_ids)

  scope                = azurerm_key_vault.hsm.id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = each.value
}

data "azurerm_client_config" "current" {}
