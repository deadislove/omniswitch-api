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

variable "github_org" {
  type        = string
  description = "GitHub organization/user that owns the repo allowed to assume the deploy role via OIDC federation — scopes the trust policy so no other GitHub repo (or a forked PR) can assume it."
}

variable "github_repo" {
  type        = string
  description = "GitHub repo name (without the org prefix) allowed to assume the deploy role via OIDC federation."
  default     = "omniswitch-api"
}

variable "github_deploy_ref" {
  type        = string
  description = "The git ref allowed to assume the deploy role, e.g. \"refs/heads/main\". Deliberately narrow — a workflow running on a feature branch or a PR from a fork should not be able to touch real infrastructure. Widen with a second role, not by loosening this one, if staging ever needs a different branch."
  default     = "refs/heads/main"
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md for the shared schema."
  default     = {}
}
