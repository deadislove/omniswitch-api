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
  description = "Region — output of ../network, must match (a GKE cluster and its VPC-native subnet must be in the same region)."
}

variable "network_id" {
  type        = string
  description = "VPC network — output of ../network."
}

variable "subnet_id" {
  type        = string
  description = "Regional subnet — output of ../network."
}

variable "pods_range_name" {
  type        = string
  description = "Secondary range name for pod IPs — output of ../network."
}

variable "services_range_name" {
  type        = string
  description = "Secondary range name for Service ClusterIPs — output of ../network."
}

variable "kubernetes_version" {
  type        = string
  description = "GKE minor version, or \"latest\" to track the release channel's current default."
  default     = "latest"
}

variable "node_machine_type" {
  type        = string
  description = "Machine type for the default node pool."
  default     = "e2-standard-4"
}

variable "node_min_count" {
  type        = number
  description = "Minimum nodes per zone (the module's node pool autoscaling is per-zone, not a single cluster-wide number — see main.tf's note)."
  default     = 1
}

variable "node_max_count" {
  type        = number
  description = "Maximum nodes per zone."
  default     = 2
}

variable "deletion_protection" {
  type        = bool
  description = "Whether Terraform is allowed to destroy the cluster. Recommended: true outside dev — same posture as ../../aws/modules/cloud-saas's db_instance deletion_protection."
  default     = false
}

variable "labels" {
  type        = map(string)
  description = "Common labels applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
