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

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC. Must be large enough to carve public+private subnets out of for every AZ in availability_zones."
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  type        = list(string)
  description = "Availability zones to spread subnets across. At least 3 for real multi-AZ HA."

  validation {
    condition     = length(var.availability_zones) >= 3
    error_message = "At least 3 availability zones are required for the HA design this module assumes."
  }
}

variable "single_nat_gateway" {
  type        = bool
  description = "If true, all private subnets share one NAT Gateway (cheaper, single point of failure for egress). If false, one NAT Gateway per AZ (real HA, ~3x the NAT Gateway cost). Recommended: true for dev, false for production — a real cost/HA tradeoff that should be recorded explicitly, not decided silently."
  default     = true
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md for the shared schema. Merged with this module's own component tag, not replacing it."
  default     = {}
}
