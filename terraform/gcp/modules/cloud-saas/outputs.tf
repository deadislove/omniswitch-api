output "db_private_ip" {
  value       = google_sql_database_instance.this.private_ip_address
  description = "Cloud SQL private IP — maps to the app's DB_HOST config."
}

output "db_replica_private_ip" {
  value       = var.db_create_read_replica ? google_sql_database_instance.replica[0].private_ip_address : null
  description = "Read replica private IP, or null if db_create_read_replica is false."
}

output "db_master_password_secret_id" {
  value       = google_secret_manager_secret.db_master_password.secret_id
  description = "Secret Manager secret holding the Cloud SQL master password — read it, don't hardcode it, when configuring the app."
}

output "redis_host" {
  value       = google_redis_instance.this.host
  description = "Memorystore host — maps to the app's REDIS_HOST config."
}

output "redis_port" {
  value       = google_redis_instance.this.port
  description = "Memorystore port — maps to the app's REDIS_PORT config."
}

output "backup_bucket_name" {
  value       = google_storage_bucket.deletion_backups.name
  description = "Wire this into DELETION_BACKUP_GCS_BUCKET (see src/jobs/backup-storage/get-backup-storage.ts)."
}

output "app_secrets_id" {
  value       = google_secret_manager_secret.app_secrets.secret_id
  description = "ID of the (currently empty) application secrets container — see main.tf's Secret Manager section for scope."
}
