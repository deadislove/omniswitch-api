output "db_endpoint" {
  value       = aws_db_instance.this.endpoint
  description = "RDS primary endpoint (host:port) — maps to the app's DB_HOST config."
}

output "db_replica_endpoint" {
  value       = var.db_create_read_replica ? aws_db_instance.replica[0].endpoint : null
  description = "RDS read replica endpoint, or null if db_create_read_replica is false."
}

output "db_master_user_secret_arn" {
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  description = "ARN of the Secrets Manager secret RDS itself created and manages for the master credential (see manage_master_user_password in main.tf)."
}

output "redis_primary_endpoint" {
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
  description = "Redis primary endpoint — maps to the app's REDIS_HOST config."
}

output "redis_reader_endpoint" {
  value       = aws_elasticache_replication_group.this.reader_endpoint_address
  description = "Redis reader endpoint, for read-scaling if the app ever splits reads from writes (it currently doesn't — see k8s/redis.yaml)."
}

output "backup_bucket_name" {
  value       = aws_s3_bucket.deletion_backups.id
  description = "Wire this into DELETION_BACKUP_S3_BUCKET (see src/jobs/backup-storage/get-backup-storage.ts)."
}

output "backup_bucket_region" {
  value       = data.aws_region.current.region
  description = "Wire this into DELETION_BACKUP_S3_REGION."
}

output "app_secrets_arn" {
  value       = aws_secretsmanager_secret.app_secrets.arn
  description = "ARN of the (currently empty) application secrets container — see main.tf's Secrets Manager section for scope."
}

data "aws_region" "current" {}
