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
}

# NOTE on scope — same posture as the other two clouds' cloud-saas
# modules: this is the managed-service target state, not an automatic
# replacement for k8s/postgres.yaml/redis.yaml's self-hosted instances.
# See ../../aws/modules/cloud-saas/main.tf's top-of-file note for the
# full reasoning, unchanged here.
#
# Real platform difference from AWS/GCP, worth flagging clearly: Azure
# Key Vault unifies what AWS/GCP split into two separate services
# (Secrets Manager + KMS). This module creates a Standard-SKU Key Vault
# as the general secrets container (this cloud's Secrets-Manager
# equivalent — software-protected, for storing plain values, not doing
# crypto operations). ../hsm creates a SEPARATE Premium-SKU Key Vault
# specifically for the HSM-backed hmac_secret/mfa_secret envelope-
# encryption key. Two Key Vaults, two different purposes — not
# redundant, and not a mistake if it looks unusual next to AWS/GCP's
# single-KMS-key shape.

locals {
  name = "${var.project}-${var.environment}"
}

resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "_%@"
}

# --- Postgres Flexible Server needs its OWN dedicated, delegated
#     subnet for VNet integration — it can't share ../network's AKS
#     subnet. This is why it's created here, in cloud-saas, rather than
#     in ../network: it's specific to this one managed service, the
#     same reasoning ../../gcp/modules/cloud-saas gives for creating its
#     own Private Service Access peering here instead of in its network
#     module. ---

resource "azurerm_subnet" "postgres" {
  name                 = "${local.name}-postgres"
  resource_group_name  = var.resource_group_name
  virtual_network_name = var.vnet_name
  address_prefixes     = [var.postgres_subnet_cidr]

  delegation {
    name = "postgres-flexible-server"

    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name}.postgres.database.azure.com"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "${local.name}-postgres-link"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = var.vnet_id
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                = "${local.name}-db"
  resource_group_name = var.resource_group_name
  location            = var.location

  version = "16"

  administrator_login    = var.db_username
  administrator_password = random_password.db_master.result

  sku_name   = var.db_sku_name
  storage_mb = var.db_storage_mb

  delegated_subnet_id = azurerm_subnet.postgres.id
  private_dns_zone_id = azurerm_private_dns_zone.postgres.id

  dynamic "high_availability" {
    for_each = var.db_ha_enabled ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  tags = var.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = var.db_name
  server_id = azurerm_postgresql_flexible_server.this.id
}

resource "azurerm_postgresql_flexible_server" "replica" {
  count = var.db_create_read_replica ? 1 : 0

  name                = "${local.name}-db-replica"
  resource_group_name = var.resource_group_name
  location            = var.location

  create_mode      = "Replica"
  source_server_id = azurerm_postgresql_flexible_server.this.id

  tags = var.tags
}

# --- Azure Cache for Redis ---

resource "azurerm_redis_cache" "this" {
  name                = "${local.name}-redis"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku_name = var.redis_sku_name
  family   = var.redis_sku_name == "Premium" ? "P" : "C"
  capacity = var.redis_capacity

  minimum_tls_version           = "1.2"
  non_ssl_port_enabled          = false
  public_network_access_enabled = false

  tags = var.tags
}

# --- Storage account + container for deletion backups
#     (AzureBlobBackupStorage adapter). Wire the outputs into
#     DELETION_BACKUP_AZURE_CONNECTION_STRING / DELETION_BACKUP_AZURE_
#     CONTAINER — see src/jobs/backup-storage/get-backup-storage.ts. ---

resource "random_string" "backup_storage_suffix" {
  length  = 14
  special = false
  upper   = false
}

resource "azurerm_storage_account" "backup" {
  # Same 24-char/no-hyphen naming limitation as ../../bootstrap's state
  # storage account — the human-readable "${project}-${environment}"
  # prefix doesn't fit alongside a uniqueness suffix, so it's dropped
  # here too and carried in tags instead.
  name                     = "backup${random_string.backup_storage_suffix.result}"
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = var.backup_storage_replication_type

  # Deny-by-default network ACL — same reasoning as
  # ../../bootstrap/main.tf's state storage account. Real access (once
  # the app is wired to write here — see
  # ../../../docs/technical/deployment/infrastructure-as-code.md's known
  # gaps) needs a private endpoint or an explicit ip_rules entry, not yet
  # configured.
  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  tags = var.tags
}

resource "azurerm_storage_container" "deletion_backups" {
  name                  = "deletion-backups"
  storage_account_id    = azurerm_storage_account.backup.id
  container_access_type = "private"
}

# --- Key Vault skeleton — general secrets container. Same scope
#     limitation as the other two clouds' equivalents: container +
#     the DB master password only, no real application secret
#     migration here. ---

resource "azurerm_key_vault" "app_secrets" {
  # Key Vault names are capped at 24 characters — "${local.name}-
  # secrets" would exceed that for "production" (26 chars), so this
  # drops the project prefix rather than truncating unpredictably.
  # Same naming-limit story as the storage account and ACR names above.
  name                = "kv-${var.environment}-secrets"
  resource_group_name = var.resource_group_name
  location            = var.location
  tenant_id           = data.azurerm_client_config.current.tenant_id

  sku_name = "standard"

  rbac_authorization_enabled = true

  # Deny-by-default network ACL — same reasoning as the storage account
  # above. Real, not-yet-resolved consequence: azurerm_key_vault_secret
  # below calls this vault's own data-plane endpoint, which this ACL
  # also gates — whoever applies this module for real needs their own
  # IP allow-listed via ip_rules (or a private endpoint) before the
  # secret-write step succeeds, not just before the vault itself is
  # created. Same as ../hsm/main.tf's identical note on its own vault.
  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
  }

  tags = var.tags
}

resource "azurerm_key_vault_secret" "db_master_password" {
  name         = "db-master-password"
  value        = random_password.db_master.result
  key_vault_id = azurerm_key_vault.app_secrets.id
}

data "azurerm_client_config" "current" {}
