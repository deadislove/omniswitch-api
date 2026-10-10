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

variable "resource_group_name" {
  type        = string
  description = "Resource Group — output of ../network."
}

variable "location" {
  type        = string
  description = "Region — output of ../network."
}

variable "subnet_id" {
  type        = string
  description = "Subnet — output of ../network. AKS nodes attach here; pod IPs come from the Azure CNI Overlay range instead (see main.tf), not this subnet."
}

variable "kubernetes_version" {
  type        = string
  description = "AKS minor version, or null to track AKS's current default."
  default     = null
}

variable "node_vm_size" {
  type        = string
  description = "VM size for the default node pool."
  default     = "Standard_D4s_v5"
}

variable "node_min_count" {
  type        = number
  description = "Minimum node count for the autoscaling default node pool."
  default     = 3
}

variable "node_max_count" {
  type        = number
  description = "Maximum node count."
  default     = 6
}

variable "private_cluster_enabled" {
  type        = bool
  description = "Whether the AKS API server is private-only. Defaults to true — a public API server with no authorized IP ranges fails this project's own CI security gate (Trivy AZU-0041). Real consequence of the true default: `terraform apply` (including this module's own helm_release resources — kube-prometheus-stack, prometheus-adapter) can only run from something with network access to the VNet (a bastion, a VPN, or a self-hosted CI runner inside the VNet) — a plain GitHub-hosted Actions runner cannot reach a private cluster. See docs/technical/deployment/infrastructure-as-code.md's known gaps for the full writeup. Set to false only alongside a deliberately narrow api_server_authorized_ip_ranges list if you need hosted-runner convenience and accept the wider exposure — this module doesn't currently expose that list as a variable since the default posture is private."
  default     = true
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
