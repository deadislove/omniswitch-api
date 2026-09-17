variable "project" {
  type        = string
  description = "Project name, used as a prefix for every resource name and in labels. NOT the same as gcp_project_id below — this is this app's own name, gcp_project_id is the GCP account/project it deploys into."
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
  description = "The real GCP project ID resources are created in — no default, this is always account-specific."
}

variable "region" {
  type        = string
  description = "GCP region. GKE node pools and Cloud SQL/Memorystore instances spread across this region's zones for HA — see main.tf's note on why this module has ONE regional subnet, not one subnet per zone like the AWS network module."
  default     = "us-east1"
}

variable "subnet_cidr" {
  type        = string
  description = "Primary IP range for the regional private subnet — where GKE nodes, Cloud SQL private IPs, and Memorystore instances live."
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  type        = string
  description = "Secondary IP range for GKE pod IPs (VPC-native/alias-IP cluster mode requires this — every pod gets a real routable IP from this range, not NAT'd like Docker's default bridge network)."
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  type        = string
  description = "Secondary IP range for GKE Service ClusterIPs."
  default     = "10.30.0.0/20"
}

variable "labels" {
  type        = map(string)
  description = "Kept for interface consistency with every other module (see ../../../shared/tagging.md) — but NOT actually applied to anything in this module. Verified against the google provider's resource schema: google_compute_network/subnetwork/router/router_nat/firewall none support labels at all (an actual GCP API limitation for core networking primitives, not something this module forgot to wire up). Modules further down the stack (IAM, GKE, Cloud SQL, storage, KMS) do support labels and do apply this."
  default     = {}
}
