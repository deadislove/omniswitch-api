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

variable "allowed_principal_object_ids" {
  type        = list(string)
  description = "Entra ID object IDs (normally a future application-side managed identity) granted the \"Key Vault Crypto User\" role. Deliberately empty by default — same reasoning as the other two clouds' equivalents: no per-workload AKS Workload Identity binding exists yet to grant."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
