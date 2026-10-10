variable "project" {
  type        = string
  description = "Project name, used as a prefix for every resource name and in tags."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name (dev / staging / production) — used in resource names and tags."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production."
  }
}

variable "resource_group_name" {
  type        = string
  description = "Resource Group — output of ../network."
}

variable "location" {
  type        = string
  description = "Region — output of ../network."
}

variable "vnet_id" {
  type        = string
  description = "VNet — output of ../network. Used for the private DNS zone's virtual network link."
}

variable "vnet_name" {
  type        = string
  description = "VNet name — output of ../network. Used to create this module's own delegated subnet for Postgres (see main.tf's note on why that subnet lives here, not in ../network)."
}

variable "postgres_subnet_cidr" {
  type        = string
  description = "CIDR for the dedicated subnet Postgres Flexible Server's VNet integration delegates to it. Must not overlap ../network's own subnet_cidr."
  default     = "10.40.2.0/24"
}

variable "db_name" {
  type        = string
  description = "Database name — must match the app's DB_NAME config, same as the other two clouds' cloud-saas modules."
  default     = "omniswitch_payments"
}

variable "db_username" {
  type        = string
  description = "Postgres administrator login."
  default     = "omniswitch_admin"
}

variable "db_sku_name" {
  type        = string
  description = "Postgres Flexible Server SKU (tier_family_size format, e.g. \"B_Standard_B1ms\" for dev burstable, \"GP_Standard_D2s_v3\"+ for production). Real cost/performance tradeoff, not a placeholder."
  default     = "B_Standard_B1ms"
}

variable "db_storage_mb" {
  type        = number
  description = "Storage size in MB."
  default     = 32768
}

variable "db_ha_enabled" {
  type        = bool
  description = "Enables zone-redundant high availability (Azure's name for what AWS calls Multi-AZ and GCP calls REGIONAL availability_type). Recommended: true outside dev."
  default     = false
}

variable "db_create_read_replica" {
  type        = bool
  description = "Whether to create a read replica — independent of db_ha_enabled, same distinction as the other two clouds' cloud-saas modules."
  default     = false
}

variable "redis_sku_name" {
  type        = string
  description = "\"Basic\" (single node), \"Standard\" (primary + replica, automatic failover), or \"Premium\" (adds clustering/persistence/VNet injection). Recommended: Standard or above outside dev."
  default     = "Standard"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.redis_sku_name)
    error_message = "redis_sku_name must be Basic, Standard, or Premium."
  }
}

variable "redis_capacity" {
  type        = number
  description = "Redis instance size tier (0-6 for Basic/Standard, 1-5 for Premium — see azurerm_redis_cache docs for the full size table)."
  default     = 1
}

variable "backup_storage_replication_type" {
  type        = string
  description = "Replication type for the deletion-backup storage account (LRS/GRS/...). Recommended: GRS outside dev, same reasoning as ../../bootstrap's state storage account."
  default     = "LRS"
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
