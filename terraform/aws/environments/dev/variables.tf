variable "aws_region" {
  type        = string
  description = "Region this environment's resources live in — independent of the state backend's own region (see bootstrap/variables.tf)."
  default     = "us-east-1"
}

variable "project" {
  type        = string
  description = "Project name, passed through to every module."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name — fixed to \"dev\" in this root module. staging/production get their own environments/* root module rather than a shared variable default, so a wrong -var flag can't accidentally point plan/apply at the wrong environment."
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "This root module is environments/dev — it must not be pointed at another environment."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "See ../../modules/network/variables.tf."
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  type        = list(string)
  description = "See ../../modules/network/variables.tf. Must have at least 3 entries."
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "single_nat_gateway" {
  type        = bool
  description = "See ../../modules/network/variables.tf. Defaults to true (single shared NAT) for dev — cost over HA is the right tradeoff for a non-production environment."
  default     = true
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
  description = "See ../../modules/iam/variables.tf. Dev may reasonably track a non-main branch (e.g. \"refs/heads/develop\") if this project ever adopts one — production should not loosen this without a deliberate reason."
  default     = "refs/heads/main"
}

variable "cluster_version" {
  type        = string
  description = "See ../../modules/container-service/variables.tf."
  default     = "1.31"
}

variable "node_instance_types" {
  type        = list(string)
  description = "See ../../modules/container-service/variables.tf."
  default     = ["m6i.large"]
}

variable "node_min_size" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 3
}

variable "node_max_size" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 6
}

variable "node_desired_size" {
  type        = number
  description = "See ../../modules/container-service/variables.tf."
  default     = 3
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

variable "db_instance_class" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "db.t4g.medium"
}

variable "db_multi_az" {
  type        = bool
  description = "See ../../modules/cloud-saas/variables.tf. false for dev by default — cost over HA, same tradeoff class as single_nat_gateway."
  default     = false
}

variable "db_create_read_replica" {
  type        = bool
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = false
}

variable "redis_node_type" {
  type        = string
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_clusters" {
  type        = number
  description = "See ../../modules/cloud-saas/variables.tf."
  default     = 2
}

variable "hsm_allowed_principal_arns" {
  type        = list(string)
  description = "See ../../modules/hsm/variables.tf. Empty by default — no per-workload application IRSA role exists yet to grant."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common tags merged into every module's own tags — see ../../../shared/tagging.md."
  default     = {}
}
