terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# NOTE on why this module's shape differs from ../../aws/modules/network,
# not just a find-and-replace port of it:
#
# AWS subnets are zonal (one CIDR per AZ), so the AWS module creates N
# public + N private subnets, one pair per AZ. GCP subnets are REGIONAL —
# one subnet's CIDR spans every zone in the region, and GCE/GKE resources
# in that subnet get scheduled across zones automatically. Forcing a
# one-subnet-per-zone shape onto GCP would fight the platform, not mirror
# AWS's actual intent (spread real capacity across failure domains) — that
# still happens here, just via the GKE node pool's own zone distribution
# (see ../container-service) rather than via multiple subnets.
#
# There's also no "public subnet" here at all: unlike an AWS ALB/NLB,
# which sits inside a subnet with a route to an Internet Gateway, GCP's
# external Load Balancers are a global anycast frontend that attaches
# directly to the VPC network — backend instances/pods can stay fully
# private (no external IP) and still be reachable through it. So this
# module is deliberately one private, VPC-native regional subnet (with
# GKE's required pod/service secondary ranges) plus Cloud NAT for
# outbound-only internet access — the closest real GCP equivalent to the
# AWS module's private-subnet-plus-NAT-Gateway shape.

resource "google_compute_network" "this" {
  project                 = var.gcp_project_id
  name                    = "${var.project}-${var.environment}"
  auto_create_subnetworks = false
}

locals {
  name = "${var.project}-${var.environment}"
}

resource "google_compute_subnetwork" "private" {
  project       = var.gcp_project_id
  name          = "${local.name}-private"
  region        = var.region
  network       = google_compute_network.this.id
  ip_cidr_range = var.subnet_cidr

  # Nodes/instances in this subnet reach Google APIs (e.g. GCR, Secret
  # Manager) over Google's internal network instead of needing a public IP.
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# --- Cloud NAT — outbound-only internet access for private instances,
#     the GCP equivalent of the AWS module's NAT Gateway. Unlike AWS,
#     there's no single_nat_gateway cost/HA tradeoff to make here: Cloud
#     NAT is a regional, fully-managed service (no per-AZ gateway to
#     provision or pay for separately). ---

resource "google_compute_router" "this" {
  project = var.gcp_project_id
  name    = "${local.name}-router"
  region  = var.region
  network = google_compute_network.this.id
}

resource "google_compute_router_nat" "this" {
  project                            = var.gcp_project_id
  name                               = "${local.name}-nat"
  router                             = google_compute_router.this.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# --- Baseline firewall rule. GCP's default is implicit deny-all ingress
#     (unlike an AWS default security group, which is more permissive) —
#     so there is no AWS-style "base security group" to hand-roll here.
#     Only the minimum needed for node-to-node/pod-to-pod cluster traffic
#     is opened; detailed service-specific ingress (RDS-equivalent,
#     ElastiCache-equivalent) is added by later modules, same deferral as
#     the AWS network module. ---

resource "google_compute_firewall" "allow_internal" {
  project = var.gcp_project_id
  name    = "${local.name}-allow-internal"
  network = google_compute_network.this.id

  direction     = "INGRESS"
  source_ranges = [var.subnet_cidr, var.pods_cidr, var.services_cidr]

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "icmp"
  }
}
