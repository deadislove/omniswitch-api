variable "project" {
  type        = string
  description = "Project name, used as a prefix for resource names."
  default     = "omniswitch-api"
}

variable "location" {
  type        = string
  description = "Region for the state storage account."
  default     = "eastus"
}

variable "tags" {
  type        = map(string)
  description = "Common tags — see ../../shared/tagging.md."
  default = {
    "managed-by" = "terraform"
    "component"  = "bootstrap"
  }
}
