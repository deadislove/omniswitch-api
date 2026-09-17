terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

locals {
  name = "${var.project}-${var.environment}"

  common_tags = merge(var.tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "container-service"
  })
}

# --- EKS cluster, on top of the community module (pinned — see
#     ../../README.md for why this module is community-sourced while
#     network/iam are hand-rolled). enable_irsa = true is what actually
#     creates the IRSA OIDC provider bound to THIS cluster's real issuer
#     URL — the thing ../iam deliberately did NOT build, because that
#     issuer doesn't exist until the module below creates it. ---

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = local.name
  kubernetes_version = var.cluster_version

  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  endpoint_public_access = var.cluster_endpoint_public_access

  enable_irsa = true

  addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni    = {}
  }

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size
      subnet_ids     = var.private_subnet_ids
    }
  }

  tags = local.common_tags
}

# --- helm provider auth — short-lived token via `aws eks get-token`
#     instead of the data.aws_eks_cluster_auth data source, so a token
#     minted at the start of a long `terraform apply` doesn't expire
#     (EKS tokens last ~15 minutes) before helm_release resources near
#     the end of the same apply need to authenticate. ---

provider "helm" {
  kubernetes = {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { Name = local.name })
}

# --- Cluster-wide add-ons. All three genuinely belong here rather than in
#     ../../../k8s/ per the boundary documented in ../../README.md: low
#     change frequency, cluster-scoped (not this-application-scoped), and
#     the application's own k8s/hpa.yaml already silently assumes
#     metrics-server exists (see the plan doc's Container Service section
#     for that gap). Chart versions below are pinned to a recent release
#     as of this module's authoring — confirm against each chart's current
#     release before the first real apply, same as any other dependency
#     bump. ---

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.2"
  namespace  = "kube-system"

  depends_on = [module.eks]
}

# kube-prometheus-stack is not one of the checklist's three named add-ons,
# but it's a real, previously-unstated prerequisite for the other two: the
# Prometheus Adapter add-on below needs an actual Prometheus server to read
# metrics from, and k8s/prometheus-rules.yaml already documents itself as
# "not applied by any deploy path in this repo" because no cluster here has
# ever run the Prometheus Operator it targets — this closes that gap rather
# than silently leaving Prometheus Adapter pointed at nothing.
resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "65.5.1"
  namespace        = "monitoring"
  create_namespace = true

  depends_on = [module.eks]
}

# VPA — the 3 controller components (Recommender / Updater / Admission
# Controller) this project has no in-cluster instance of yet. The
# per-workload VPA *custom resource* (the thing that actually opts this
# application's Deployment in) stays in ../../../k8s/, not here — same
# controller-vs-instance split as the HPA API itself.
resource "helm_release" "vpa" {
  name       = "vpa"
  repository = "https://charts.fairwinds.com/stable"
  chart      = "vpa"
  version    = "4.6.0"
  namespace  = "kube-system"

  set = [
    {
      name  = "recommender.enabled"
      value = "true"
    },
    {
      name  = "updater.enabled"
      value = "true"
    },
    {
      name  = "admissionController.enabled"
      value = "true"
    },
  ]

  depends_on = [module.eks]
}

# Prometheus Adapter — exposes custom Prometheus metrics (this project's
# omniswitch_* series, plus the new traffic-rate metric the plan doc's
# section 4 calls for) via custom.metrics.k8s.io, so the application's own
# HPA (in ../../../k8s/hpa.yaml) can eventually scale on something other
# than CPU/Memory.
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
