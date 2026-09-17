variable "project" {
  type        = string
  description = "Project name, used as a prefix for every resource name and in labels."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name (dev / staging / production) — used in resource names and labels."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production."
  }
}

variable "gcp_project_id" {
  type        = string
  description = "The real GCP project ID resources are created in."
}

variable "region" {
  type        = string
  description = "Region — output of ../network."
}

variable "network_id" {
  type        = string
  description = "VPC network — output of ../network. Cloud SQL/Memorystore connect over this via Private Service Access (see main.tf), never a public IP."
}

variable "db_name" {
  type        = string
  description = "Database name — must match the app's DB_NAME config, same as ../../aws/modules/cloud-saas/variables.tf's equivalent."
  default     = "omniswitch_payments"
}

variable "db_username" {
  type        = string
  description = "Postgres user the app connects as."
  default     = "omniswitch_admin"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier. Recommended: db-custom-2-8192 (2 vCPU/8GB) for dev, larger for production — this is a real cost/performance tradeoff, not a placeholder."
  default     = "db-custom-2-8192"
}

variable "db_availability_type" {
  type        = string
  description = "\"ZONAL\" (single zone) or \"REGIONAL\" (synchronous HA standby in another zone — Cloud SQL's name for what AWS calls Multi-AZ). Recommended: REGIONAL outside dev."
  default     = "ZONAL"

  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.db_availability_type)
    error_message = "db_availability_type must be ZONAL or REGIONAL."
  }
}

variable "db_create_read_replica" {
  type        = bool
  description = "Whether to create a read replica — independent of db_availability_type, same distinction as ../../aws/modules/cloud-saas/variables.tf's db_multi_az vs db_create_read_replica."
  default     = false
}

variable "db_disk_size_gb" {
  type        = number
  description = "Initial disk size in GB (disk_autoresize is enabled, so this is a floor, not a hard cap)."
  default     = 50
}

variable "redis_tier" {
  type        = string
  description = "\"BASIC\" (single node) or \"STANDARD_HA\" (replica + automatic failover). Recommended: STANDARD_HA outside dev."
  default     = "BASIC"

  validation {
    condition     = contains(["BASIC", "STANDARD_HA"], var.redis_tier)
    error_message = "redis_tier must be BASIC or STANDARD_HA."
  }
}

variable "redis_memory_size_gb" {
  type        = number
  description = "Memorystore instance size in GB."
  default     = 1
}

variable "backup_bucket_force_destroy" {
  type        = bool
  description = "See ../../aws/modules/cloud-saas/variables.tf's equivalent — same reasoning."
  default     = false
}

variable "labels" {
  type        = map(string)
  description = "Common labels applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
