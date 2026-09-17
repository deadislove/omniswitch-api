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

variable "subnet_id" {
  type        = string
  description = "Subnet — output of ../network. AKS nodes attach here; pod IPs come from the Azure CNI Overlay range instead (see main.tf), not this subnet."
}

variable "kubernetes_version" {
  type        = string
  description = "AKS minor version, or null to track AKS's current default."
  default     = null
}

variable "node_vm_size" {
  type        = string
  description = "VM size for the default node pool."
  default     = "Standard_D4s_v5"
}

variable "node_min_count" {
  type        = number
  description = "Minimum node count for the autoscaling default node pool."
  default     = 3
}

variable "node_max_count" {
  type        = number
  description = "Maximum node count."
  default     = 6
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
