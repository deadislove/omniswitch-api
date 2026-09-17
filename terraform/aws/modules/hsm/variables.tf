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

variable "allowed_principal_arns" {
  type        = list(string)
  description = "IAM principal ARNs (normally a single application IRSA role ARN) allowed to call Encrypt/Decrypt/GenerateDataKey against this key. Deliberately empty by default — this project doesn't have a per-workload application IRSA role built yet (../container-service only creates the cluster-wide IRSA OIDC *provider*; the app's own role, bound to its k8s ServiceAccount, is a follow-up not yet in scope). Leaving this empty means the key exists but nothing except the account root/key admins can use it yet — safe, not silently over-permissive."
  default     = []
}

variable "key_admin_arns" {
  type        = list(string)
  description = "IAM principal ARNs allowed full administrative control over the key (rotation, policy changes, scheduling deletion) — normally the Terraform execution role from ../iam plus any break-glass human admin roles. The account root always retains full access regardless of this list (see main.tf's policy statement for why: a key policy that omits root can permanently lock everyone out)."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
