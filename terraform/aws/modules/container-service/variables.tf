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

variable "vpc_id" {
  type        = string
  description = "VPC to place the cluster in — output of ../network."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs the node group and control-plane ENIs use — output of ../network. Must span at least 3 AZs (see the plan doc's HA section)."
}

variable "cluster_version" {
  type        = string
  description = "Kubernetes minor version for the EKS control plane."
  default     = "1.31"
}

variable "node_instance_types" {
  type        = list(string)
  description = "Instance types for the managed node group, tried in order for Spot/On-Demand capacity."
  default     = ["m6i.large"]
}

variable "node_min_size" {
  type        = number
  description = "Minimum node count. Independent of k8s/hpa.yaml's pod-level minReplicas (3) — this is nodes, not pods; keep at least 3 for the same multi-AZ HA reasons."
  default     = 3
}

variable "node_max_size" {
  type        = number
  description = "Maximum node count the managed node group's own ASG can scale to — a ceiling above the pod-level HPA's maxReplicas (20 in k8s/hpa.yaml), since real workloads bin-pack multiple pods per node."
  default     = 6
}

variable "node_desired_size" {
  type        = number
  description = "Initial desired node count. The managed node group's ASG, not this variable, keeps the cluster running afterward — Terraform re-asserting this on every apply would fight the Kubernetes Cluster Autoscaler if one is ever added."
  default     = 3
}

variable "cluster_endpoint_public_access" {
  type        = bool
  description = "Whether the EKS API server endpoint is reachable from the public internet. Defaults to false (private-only) — a public endpoint fails this project's own CI security gate (Trivy AWS-0040/AWS-0041) regardless of CIDR scoping, since AWS-0040 fires on public access being enabled at all. Real consequence of the false default: `terraform apply` (including this module's own helm_release resources — metrics-server, kube-prometheus-stack, VPA, prometheus-adapter) can only run from something with network access to the VPC (a bastion, a VPN, or a self-hosted CI runner inside the VPC) — a plain GitHub-hosted Actions runner cannot reach a private endpoint. See docs/technical/deployment/infrastructure-as-code.md's known gaps for the full writeup. Set to true only with a deliberately narrow, non-0.0.0.0/0 CIDR list if you need hosted-runner convenience and accept the wider exposure."
  default     = false
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
