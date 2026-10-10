terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# NOTE on scope — same posture as ../../aws/modules/cloud-saas: this is
# the managed-service target state (Cloud SQL, Memorystore), not an
# automatic replacement for k8s/postgres.yaml/redis.yaml's self-hosted
# instances. See that module's own top-of-file note for the full
# reasoning — it applies here unchanged.

locals {
  name = "${var.project}-${var.environment}"
}

# --- Private Service Access — the GCP mechanism that lets Cloud SQL and
#     Memorystore get a private IP inside this VPC instead of a public
#     one. AWS's equivalent concept (RDS/ElastiCache in a private subnet)
#     doesn't need a separate peering step because AWS subnets are
#     already VPC-scoped; GCP's managed services live in Google-owned
#     tenant projects and need this explicit VPC peering connection to
#     reach into var.network_id. ---

resource "google_compute_global_address" "private_service_access" {
  project       = var.gcp_project_id
  name          = "${local.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = var.network_id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = var.network_id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]
}

# --- Cloud SQL for PostgreSQL ---
#
# No AWS-style single-flag "manage_master_user_password" here — GCP has
# no equivalent native Secrets-Manager-backed credential management for
# Cloud SQL, so the master password is generated and stored explicitly
# below (random_password + Secret Manager), a genuine platform gap
# relative to the AWS module, not an oversight.

resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "_%@"
}

resource "google_secret_manager_secret" "db_master_password" {
  project   = var.gcp_project_id
  secret_id = "${local.name}-db-master-password"

  replication {
    auto {}
  }

  labels = var.labels
}

resource "google_secret_manager_secret_version" "db_master_password" {
  secret      = google_secret_manager_secret.db_master_password.id
  secret_data = random_password.db_master.result
}

resource "google_sql_database_instance" "this" {
  project             = var.gcp_project_id
  name                = "${local.name}-db"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.environment == "production"

  settings {
    tier              = var.db_tier
    availability_type = var.db_availability_type
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true
    user_labels       = var.labels

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
  }

  depends_on = [google_service_networking_connection.private_service_access]
}

resource "google_sql_database" "app" {
  project  = var.gcp_project_id
  name     = var.db_name
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "app" {
  project  = var.gcp_project_id
  name     = var.db_username
  instance = google_sql_database_instance.this.name
  password = random_password.db_master.result
}

# Internal Cloud-SQL-to-Cloud-SQL read replica — deliberately no
# `replica_configuration` block: that block is only for replicating from
# an EXTERNAL (non-Cloud SQL) source. An internal replica just needs
# `master_instance_name` set.
resource "google_sql_database_instance" "replica" {
  count = var.db_create_read_replica ? 1 : 0

  project              = var.gcp_project_id
  name                 = "${local.name}-db-replica"
  region               = var.region
  database_version     = "POSTGRES_16"
  master_instance_name = google_sql_database_instance.this.name

  settings {
    tier        = var.db_tier
    user_labels = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
  }
}

# --- Memorystore for Redis ---

resource "google_redis_instance" "this" {
  project        = var.gcp_project_id
  name           = "${local.name}-redis"
  region         = var.region
  tier           = var.redis_tier
  memory_size_gb = var.redis_memory_size_gb
  redis_version  = "REDIS_7_0"

  authorized_network = var.network_id

  auth_enabled            = true
  transit_encryption_mode = "SERVER_AUTHENTICATION"

  labels = var.labels
}

# --- GCS bucket for deletion backups (GcsBackupStorage adapter) ---
#
# Wire the bucket name output into DELETION_BACKUP_GCS_BUCKET — see
# src/jobs/backup-storage/get-backup-storage.ts. Unlike the AWS version,
# there's no separate *_REGION env var to wire (GCS resolves a bucket's
# location automatically; the app's GcsBackupStorage adapter never needs
# to be told).

resource "google_storage_bucket" "deletion_backups" {
  project       = var.gcp_project_id
  name          = "${var.gcp_project_id}-${var.environment}-deletion-backups"
  location      = var.region
  force_destroy = var.backup_bucket_force_destroy

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  labels = var.labels
}

# --- Secret Manager skeleton — same scope limitation as
#     ../../aws/modules/cloud-saas's Secrets Manager section: container
#     only, no real application secret migration here. ---

resource "google_secret_manager_secret" "app_secrets" {
  project   = var.gcp_project_id
  secret_id = "${local.name}-app-secrets"

  replication {
    auto {}
  }

  labels = var.labels
}

resource "google_secret_manager_secret_version" "app_secrets_placeholder" {
  secret      = google_secret_manager_secret.app_secrets.id
  secret_data = jsonencode({})

  lifecycle {
    ignore_changes = [secret_data]
  }
}
