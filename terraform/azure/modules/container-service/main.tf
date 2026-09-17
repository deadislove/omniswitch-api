terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
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

# --- AKS cluster, on top of the community module (pinned — same
#     reasoning as the other two clouds' use of terraform-aws-modules/eks
#     and terraform-google-modules/kubernetes-engine).
#
#     `network_plugin_mode = "overlay"` — Azure CNI Overlay, the current
#     recommended AKS networking mode: pod IPs come from an internal
#     range the cluster manages itself, NOT from ../network's subnet CIDR
#     (unlike legacy Azure CNI, which required allocating real routable
#     subnet IPs per pod — a major address-space cost at any real pod
#     density). This is why ../network's subnet is a modest /24 rather
#     than something sized for one IP per pod.
#
#     `workload_autoscaler_profile.vertical_pod_autoscaler_enabled` is a
#     native module/cluster toggle — same real platform difference from
#     AWS already documented in ../../gcp/modules/container-service/
#     main.tf: AKS (like GKE) has first-party VPA support, so unlike the
#     AWS module this one does NOT Helm-install VPA's 3 controller
#     components separately. AKS also runs metrics-server as a managed
#     system add-on, same as GKE. ---

module "aks" {
  source  = "Azure/aks/azurerm"
  version = "~> 11.0"

  prefix              = local.name
  resource_group_name = var.resource_group_name
  location            = var.location

  kubernetes_version = var.kubernetes_version

  network_plugin      = "azure"
  network_plugin_mode = "overlay"
  vnet_subnet         = { id = var.subnet_id }

  agents_size          = var.node_vm_size
  agents_min_count     = var.node_min_count
  agents_max_count     = var.node_max_count
  auto_scaling_enabled = true

  private_cluster_enabled = var.private_cluster_enabled

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  workload_autoscaler_profile = {
    vertical_pod_autoscaler_enabled = true
  }

  tags = var.tags
}

resource "azurerm_container_registry" "app" {
  # ACR names must be globally unique across Azure and alphanumeric only
  # (no hyphens) — same naming-limitation story as the Storage Account
  # name in ../../bootstrap/main.tf.
  name                = replace(local.name, "-", "")
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "Standard"

  tags = var.tags
}

# --- Prometheus Adapter still needs a real Prometheus server — same gap
#     the AWS and GCP modules close with kube-prometheus-stack. AKS's own
#     managed Prometheus (Azure Monitor managed service for Prometheus)
#     was considered and NOT used here, for the same cross-cloud
#     consistency reason the GCP module gives for skipping Google Cloud
#     Managed Service for Prometheus: one Prometheus Operator/
#     PrometheusRule setup shared across all three clouds beats three
#     different managed-Prometheus integrations. ---

provider "helm" {
  kubernetes = {
    host                   = module.aks.host
    client_certificate     = base64decode(module.aks.client_certificate)
    client_key             = base64decode(module.aks.client_key)
    cluster_ca_certificate = base64decode(module.aks.cluster_ca_certificate)
  }
}

resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "65.5.1"
  namespace        = "monitoring"
  create_namespace = true

  depends_on = [module.aks]
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
