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
  description = "Resource Group — output of ../network. The custom role's assignable_scopes and the role assignment are both scoped to this group, not the whole subscription."
}

variable "resource_group_id" {
  type        = string
  description = "Full ARM resource ID of the Resource Group — output of ../network."
}

variable "location" {
  type        = string
  description = "Azure region — output of ../network. The user-assigned identity itself is a regional resource."
}

variable "github_org" {
  type        = string
  description = "GitHub organization/user that owns the repo allowed to assume the deploy identity via federated credentials."
}

variable "github_repo" {
  type        = string
  description = "GitHub repo name (without the org prefix) allowed to federate in."
  default     = "omniswitch-api"
}

variable "github_deploy_ref" {
  type        = string
  description = "The git ref allowed to federate in, e.g. \"refs/heads/main\" — same narrow-by-default reasoning as ../../aws/modules/iam and ../../gcp/modules/iam's equivalents."
  default     = "refs/heads/main"
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
