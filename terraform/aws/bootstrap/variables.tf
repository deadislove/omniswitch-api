variable "project" {
  type        = string
  description = "Project name, used as a prefix for the state bucket and lock table names."
  default     = "omniswitch-api"
}

variable "aws_region" {
  type        = string
  description = "Region to create the state bucket and lock table in. All environments' remote state lives in this one region regardless of which region their own resources are in."
  default     = "us-east-1"
}

variable "tags" {
  type        = map(string)
  description = "Common tags — see ../../shared/tagging.md."
  default = {
    "managed-by" = "terraform"
    "component"  = "bootstrap"
  }
}
