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

variable "location" {
  type        = string
  description = "Azure region. Like GCP (and unlike AWS), an Azure subnet is a regional construct, not zonal — AKS node pools spread across Availability Zones within this region on their own, same reasoning as ../../gcp/modules/network's single regional subnet."
  default     = "eastus"
}

variable "vnet_cidr" {
  type        = string
  description = "CIDR block for the VNet."
  default     = "10.40.0.0/16"
}

variable "subnet_cidr" {
  type        = string
  description = "CIDR block for the single private subnet — AKS nodes/pods (Azure CNI Overlay, so pod IPs don't need to come from this range — see the container-service module) and later Cloud SaaS private endpoints all live here."
  default     = "10.40.1.0/24"
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
