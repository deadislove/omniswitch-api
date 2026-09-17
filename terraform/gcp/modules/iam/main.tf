terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

# NOTE on scope — read before adding to this module:
#
# Same split as ../../aws/modules/iam: this module creates the Terraform-
# execution service account and GitHub Actions Workload Identity
# Federation (WIF is GCP's OIDC-federation equivalent — no long-lived
# service account key files in CI). It deliberately does NOT create GKE's
# own Workload Identity binding for the application's k8s ServiceAccount —
# that binding needs the GKE cluster to exist first (it's a
# `roles/iam.workloadIdentityUser` grant scoped to
# "serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA_NAME]", which requires
# a real cluster's Workload Identity pool), same ordering reason ../iam
# defers EKS IRSA to ../container-service on the AWS side.
#
# GCP resource-name length limits are much tighter than AWS's (e.g.
# workload_identity_pool_id: 4-32 chars, service_account account_id: 6-30
# chars) — names below are deliberately short (no full "${project}-
# ${environment}" prefix), since uniqueness only needs to hold within one
# GCP project, not across accounts the way AWS ARNs sometimes need to.

locals {
  name = "${var.project}-${var.environment}"

  # GCP custom IAM roles require literally enumerating individual
  # permission strings (no wildcard like AWS's "ec2:*") — hand-maintaining
  # that list for every service this project's modules touch would be
  # long and silently go stale as GCP adds/renames permissions. Composing
  # scoped PREDEFINED roles is GCP's own recommended alternative to
  # "roles/owner"/"roles/editor" for exactly this reason — narrower than
  # project-owner, without the enumeration-maintenance burden a custom
  # role would carry.
  terraform_execution_roles = [
    "roles/compute.networkAdmin",
    "roles/container.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/cloudsql.admin",
    "roles/redis.admin",
    "roles/storage.admin",
    "roles/secretmanager.admin",
    "roles/cloudkms.admin",
    "roles/artifactregistry.admin",
  ]
}

resource "google_service_account" "terraform_execution" {
  project      = var.gcp_project_id
  account_id   = "tf-exec-${var.environment}"
  display_name = "Terraform execution SA for ${local.name}"
}

resource "google_project_iam_member" "terraform_execution" {
  for_each = toset(local.terraform_execution_roles)

  project = var.gcp_project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.terraform_execution.email}"
}

# --- GitHub Actions Workload Identity Federation ---

resource "google_iam_workload_identity_pool" "github_actions" {
  project                   = var.gcp_project_id
  workload_identity_pool_id = "github-actions-${var.environment}"
  display_name              = "GitHub Actions (${var.environment})"
  description               = "Federates GitHub Actions OIDC tokens for ${var.github_org}/${var.github_repo} — no long-lived service account keys."
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_actions.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-${var.environment}"
  display_name                       = "GitHub (${var.environment})"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Scoped to a single repo + single ref — same narrow-by-default
  # reasoning as the AWS module's `sub` StringLike condition.
  attribute_condition = "assertion.repository == \"${var.github_org}/${var.github_repo}\" && assertion.ref == \"${var.github_deploy_ref}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_actions_impersonation" {
  service_account_id = google_service_account.terraform_execution.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_actions.name}/attribute.repository/${var.github_org}/${var.github_repo}"
}
