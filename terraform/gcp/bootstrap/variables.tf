variable "gcp_project_id" {
  type        = string
  description = "The real GCP project ID the state bucket is created in."
}

variable "region" {
  type        = string
  description = "Region for the state bucket."
  default     = "us-east1"
}

variable "labels" {
  type        = map(string)
  description = "Common labels — see ../../shared/tagging.md."
  default = {
    "managed-by" = "terraform"
    "component"  = "bootstrap"
  }
}
