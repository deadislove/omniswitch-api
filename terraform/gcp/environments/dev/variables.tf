variable "gcp_project_id" {
  type        = string
  description = "The real GCP project ID this environment deploys into."
}

variable "region" {
  type        = string
  description = "See ../../modules/network/variables.tf. Independent of the state backend's own region (see ../../bootstrap/variables.tf)."
  default     = "us-east1"
}

variable "project" {
  type        = string
  description = "Project name, passed through to every module."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name — fixed to \"dev\" in this root module, same reasoning as ../../aws/environments/dev/variables.tf's equivalent."
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "This root module is environments/dev — it must not be pointed at another environment."
  }
}

variable "subnet_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.30.0.0/20"
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
  default     = "latest"
}

variable "node_machine_type" {
  type        = string
  description = "See ../../modules/container-service/variables.tf."
  default     = "e2-standard-4"
}

variable "node_min_count" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 1
}

variable "node_max_count" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 2
}

variable "gke_deletion_protection" {
  type        = bool
  description = "See ../../modules/container-service/variables.tf's deletion_protection."
  default     = false
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

variable "db_tier" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "db-custom-2-8192"
}

variable "db_availability_type" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "ZONAL"
}

variable "db_create_read_replica" {
  type        = bool
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = false
}

variable "redis_tier" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "BASIC"
}

variable "redis_memory_size_gb" {
  type        = number
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = 1
}

variable "hsm_allowed_member_emails" {
  type        = list(string)
  description = "See ../../modules/hsm/variables.tf. Empty by default — no per-workload GKE Workload Identity binding exists yet to grant."
  default     = []
}

variable "labels" {
  type        = map(string)
  description = "Common labels merged into every module's own labels — see ../../../shared/tagging.md."
  default     = {}
}
