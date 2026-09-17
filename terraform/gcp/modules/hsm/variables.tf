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

variable "region" {
  type        = string
  description = "KMS key ring location — output of ../network. A key ring's location is permanent (can't be changed after creation), same as a bucket's."
}

variable "allowed_member_emails" {
  type        = list(string)
  description = "IAM member strings (e.g. \"serviceAccount:app@project.iam.gserviceaccount.com\") granted roles/cloudkms.cryptoKeyEncrypterDecrypter on the key. Deliberately empty by default — same reasoning as ../../aws/modules/hsm/variables.tf's allowed_principal_arns: no per-workload GKE Workload Identity binding exists yet to grant."
  default     = []
}

variable "rotation_period" {
  type        = string
  description = "Automatic key rotation period, as a duration string (e.g. \"7776000s\" = 90 days)."
  default     = "7776000s"
}

variable "labels" {
  type        = map(string)
  description = "Common labels applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
