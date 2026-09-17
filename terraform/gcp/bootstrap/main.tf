terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # No `backend` block — same chicken-and-egg reasoning as
  # ../../aws/bootstrap/main.tf. This root module's own state stays local.
}

provider "google" {
  project = var.gcp_project_id
  region  = var.region
}

resource "google_storage_bucket" "terraform_state" {
  # GCS bucket names are globally unique across ALL of GCP, like S3 —
  # the project ID is already globally unique, so it's a safe suffix
  # without inventing an extra piece of state (unlike AWS, which needed
  # an account ID pulled from a data source since S3 bucket names aren't
  # derivable from anything else available at this point).
  name     = "${var.gcp_project_id}-terraform-state"
  location = var.region

  versioning {
    enabled = true
  }

  uniform_bucket_level_access = true

  public_access_prevention = "enforced"

  # GCS backend has native state locking built in (via object generation
  # preconditions) — unlike AWS's S3 backend, no separate DynamoDB-
  # equivalent lock table is needed here.

  labels = var.labels
}
