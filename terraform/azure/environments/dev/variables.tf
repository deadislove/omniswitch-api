variable "project" {
  type        = string
  description = "Project name, passed through to every module."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name — fixed to \"dev\" in this root module, same reasoning as the other two clouds' environments/dev/variables.tf equivalents."
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "This root module is environments/dev — it must not be pointed at another environment."
  }
}

variable "location" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "eastus"
}

variable "vnet_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.40.0.0/16"
}

variable "subnet_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.40.1.0/24"
}

variable "github_org" {
  type        = string
  description = "See ../../modules/iam/variables.tf."
}

variable "github_repo" {
  type        = string
  description = "See ../../modules/iam/variables.tf."
  default     = "omniswitch-api"
}

variable "github_deploy_ref" {
  type        = string
  description = "See ../../modules/iam/variables.tf."
  default     = "refs/heads/main"
}

variable "kubernetes_version" {
  type        = string
  description = "See ../../modules/container-service/variables.tf."
  default     = null
}

variable "node_vm_size" {
  type        = string
  description = "See ../../modules/container-service/variables.tf."
  default     = "Standard_D4s_v5"
}

variable "node_min_count" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 3
}

variable "node_max_count" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 6
}

variable "postgres_subnet_cidr" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "10.40.2.0/24"
}

variable "db_name" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "omniswitch_payments"
}

variable "db_username" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "omniswitch_admin"
}

variable "db_sku_name" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "B_Standard_B1ms"
}

variable "db_storage_mb" {
  type        = number
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = 32768
}

variable "db_ha_enabled" {
  type        = bool
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = false
}

variable "db_create_read_replica" {
  type        = bool
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = false
}

variable "redis_sku_name" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "Standard"
}

variable "redis_capacity" {
  type        = number
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = 1
}

variable "backup_storage_replication_type" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "LRS"
}

variable "hsm_allowed_principal_object_ids" {
  type        = list(string)
  description = "See ../../modules/hsm/variables.tf. Empty by default — no per-workload AKS Workload Identity binding exists yet to grant."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common tags merged into every module's own tags — see ../../../shared/tagging.md."
  default     = {}
}
