terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# NOTE on scope — read before applying this module:
#
# `../../../k8s/postgres.yaml` and `../../../k8s/redis.yaml` already
# self-host Postgres (streaming-replication master+replica) and Redis
# *inside* the cluster, mirroring docker-compose.yml — this module does
# NOT replace them automatically. It builds the managed-service target
# state (RDS, ElastiCache) that 20260912-gap-improvement-plan.md's gap
# analysis calls out as more production-grade than self-hosting stateful
# services in Kubernetes. Adopting it is a real cutover with a real
# migration (pg_dump/restore or logical replication onto RDS, redis
# RDB/AOF onto ElastiCache, then repointing DB_HOST/REDIS_HOST and
# retiring postgres.yaml/redis.yaml/pgbouncer.yaml) — not something this
# module does by existing. See the plan doc's Cloud SaaS checklist entry
# for this call-out.

locals {
  name = "${var.project}-${var.environment}"

  common_tags = merge(var.tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "cloud-saas"
  })
}

# --- RDS for PostgreSQL ---

resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db"
  subnet_ids = var.private_subnet_ids

  tags = merge(local.common_tags, { Name = "${local.name}-db" })
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Allow Postgres (5432) only from the security groups in allowed_security_group_ids, not the whole VPC CIDR."
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.allowed_security_group_ids
    content {
      description     = "Postgres from an allowed security group"
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name}-rds" })
}

resource "aws_db_instance" "this" {
  identifier     = "${local.name}-db"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage      = var.db_allocated_storage
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.db_username
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # AWS-managed master credential — RDS generates the password itself and
  # stores it in Secrets Manager; it never appears in Terraform state or
  # in this module's variables, unlike a hand-rolled random_password would.
  manage_master_user_password = true

  multi_az                  = var.db_multi_az
  backup_retention_period   = 7
  deletion_protection       = var.environment == "production"
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${local.name}-db-final" : null

  tags = merge(local.common_tags, { Name = "${local.name}-db" })
}

resource "aws_db_instance" "replica" {
  count = var.db_create_read_replica ? 1 : 0

  identifier             = "${local.name}-db-replica"
  replicate_source_db    = aws_db_instance.this.identifier
  instance_class         = var.db_instance_class
  publicly_accessible    = false
  vpc_security_group_ids = [aws_security_group.rds.id]
  skip_final_snapshot    = true

  tags = merge(local.common_tags, { Name = "${local.name}-db-replica" })
}

# --- ElastiCache for Redis ---

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids

  tags = merge(local.common_tags, { Name = "${local.name}-redis" })
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Allow Redis (6379) only from the security groups in allowed_security_group_ids, not the whole VPC CIDR."
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.allowed_security_group_ids
    content {
      description     = "Redis from an allowed security group"
      from_port       = 6379
      to_port         = 6379
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name}-redis" })
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${local.name}-redis"
  description          = "Redis replication group for ${local.name} — replaces the single self-hosted k8s/redis.yaml instance once migrated, same reasoning: no client-side cluster-mode awareness, so replication (not sharding) is the right HA shape."

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type

  num_cache_clusters         = var.redis_num_cache_clusters
  automatic_failover_enabled = var.redis_num_cache_clusters > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = merge(local.common_tags, { Name = "${local.name}-redis" })
}

# --- S3 bucket for deletion backups (S3BackupStorage adapter) ---
#
# Bucket name/region output below are meant to be wired directly into the
# app's DELETION_BACKUP_S3_BUCKET / DELETION_BACKUP_S3_REGION config (see
# src/jobs/backup-storage/get-backup-storage.ts) — not a separate bucket
# nobody reads from.

resource "aws_s3_bucket" "deletion_backups" {
  bucket        = "${local.name}-deletion-backups"
  force_destroy = var.backup_bucket_force_destroy

  tags = merge(local.common_tags, { Name = "${local.name}-deletion-backups" })
}

resource "aws_s3_bucket_versioning" "deletion_backups" {
  bucket = aws_s3_bucket.deletion_backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deletion_backups" {
  bucket = aws_s3_bucket.deletion_backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "deletion_backups" {
  bucket = aws_s3_bucket.deletion_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Secrets Manager skeleton ---
#
# Only the container. Migrating real application secrets (hmac_secret,
# mfa_secret, PSP API keys, ...) into this is deliberately out of scope
# for this module — that is an application-layer cutover with its own
# rollout plan, not something a `terraform apply` should do as a side
# effect. `lifecycle.ignore_changes` on secret_string means Terraform
# creates the container once and never fights whatever process populates
# it afterward (application deploy, a human via the console, etc).

resource "aws_secretsmanager_secret" "app_secrets" {
  name        = "${local.name}-app-secrets"
  description = "Container for this application's runtime secrets. Terraform creates the container only — population is an application-layer concern, not managed here."

  tags = merge(local.common_tags, { Name = "${local.name}-app-secrets" })
}

resource "aws_secretsmanager_secret_version" "app_secrets_placeholder" {
  secret_id     = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({})

  lifecycle {
    ignore_changes = [secret_string]
  }
}
