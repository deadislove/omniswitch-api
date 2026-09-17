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

variable "github_org" {
  type        = string
  description = "GitHub organization/user that owns the repo allowed to assume the deploy service account via Workload Identity Federation."
}

variable "github_repo" {
  type        = string
  description = "GitHub repo name (without the org prefix) allowed to federate in."
  default     = "omniswitch-api"
}

variable "github_deploy_ref" {
  type        = string
  description = "The git ref allowed to federate in, e.g. \"refs/heads/main\" — same narrow-by-default reasoning as ../../aws/modules/iam/variables.tf's equivalent."
  default     = "refs/heads/main"
}

variable "labels" {
  type        = map(string)
  description = "Kept for interface consistency (see ../../../shared/tagging.md) — but NOT actually applied here. Verified against the provider schema: google_service_account, google_iam_workload_identity_pool(_provider), and google_project_iam_member none support labels — IAM/identity resources generally don't carry labels in GCP's resource model, same genuine platform limitation noted in ../network/variables.tf's labels variable."
  default     = {}
}
