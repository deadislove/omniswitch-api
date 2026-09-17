terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

# --- GKE cluster, on top of the community module (pinned — same reasoning
#     as ../../aws/modules/container-service's use of
#     terraform-aws-modules/eks: node-pool lifecycle, Workload Identity
#     wiring, and add-on management are all details a well-maintained
#     module has already gotten right).
#
#     `regional = true` (the module's own default) — a real GKE regional
#     cluster replicates the control plane across 3 zones AND spreads the
#     default node pool across those same zones automatically, without
#     this module needing to enumerate zones itself (unlike the AWS
#     module, which explicitly lists subnet_ids per AZ) — see ../network's
#     own note on why GCP subnets don't need one-per-zone treatment
#     either. Same HA outcome, different mechanism.
#
#     `enable_vertical_pod_autoscaling` and `horizontal_pod_autoscaling`
#     are native module toggles — this is the real, checklist-documented
#     platform difference from AWS: GKE has first-party VPA/HPA-adjacent
#     support built into the cluster resource itself, so unlike
#     ../../aws/modules/container-service this module does NOT need to
#     separately Helm-install VPA's 3 controller components or
#     metrics-server (GKE Standard clusters already run metrics-server as
#     a managed system component). ---

module "gke" {
  source  = "terraform-google-modules/kubernetes-engine/google"
  version = "~> 44.0"

  project_id = var.gcp_project_id
  name       = local.name
  region     = var.region

  network    = var.network_id
  subnetwork = var.subnet_id

  ip_range_pods     = var.pods_range_name
  ip_range_services = var.services_range_name

  kubernetes_version = var.kubernetes_version

  enable_vertical_pod_autoscaling = true
  horizontal_pod_autoscaling      = true

  deletion_protection = var.deletion_protection

  node_pools = [
    {
      name         = "default"
      machine_type = var.node_machine_type
      min_count    = var.node_min_count
      max_count    = var.node_max_count
      autoscaling  = true
    }
  ]

  node_pools_labels = {
    all = var.labels
  }
}

# --- Prometheus Adapter still needs a real Prometheus server to read
#     from, same gap the AWS module closes with kube-prometheus-stack —
#     GKE's own Workload Identity/VPA/HPA support doesn't include a
#     bundled Prometheus. Installed the same way as the AWS module: Helm,
#     against this cluster, once it exists. ---

provider "helm" {
  kubernetes = {
    host                   = "https://${module.gke.endpoint}"
    cluster_ca_certificate = base64decode(module.gke.ca_certificate)
    token                  = data.google_client_config.default.access_token
  }
}

data "google_client_config" "default" {}

resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "65.5.1"
  namespace        = "monitoring"
  create_namespace = true

  depends_on = [module.gke]
}

resource "helm_release" "prometheus_adapter" {
  name       = "prometheus-adapter"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "prometheus-adapter"
  version    = "4.11.0"
  namespace  = "monitoring"

  set = [
    {
      name  = "prometheus.url"
      value = "http://kube-prometheus-stack-prometheus.monitoring.svc"
    },
    {
      name  = "prometheus.port"
      value = "9090"
    },
  ]

  depends_on = [helm_release.kube_prometheus_stack]
}

resource "google_artifact_registry_repository" "app" {
  project       = var.gcp_project_id
  location      = var.region
  repository_id = local.name
  format        = "DOCKER"

  labels = var.labels
}
