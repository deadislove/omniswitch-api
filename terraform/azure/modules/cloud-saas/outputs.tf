output "db_fqdn" {
  value       = azurerm_postgresql_flexible_server.this.fqdn
  description = "Postgres FQDN — maps to the app's DB_HOST config."
}

output "db_replica_fqdn" {
  value       = var.db_create_read_replica ? azurerm_postgresql_flexible_server.replica[0].fqdn : null
  description = "Read replica FQDN, or null if db_create_read_replica is false."
}

output "db_master_password_secret_id" {
  value       = azurerm_key_vault_secret.db_master_password.id
  description = "Key Vault secret holding the Postgres master password — read it, don't hardcode it, when configuring the app."
}

output "redis_host" {
  value       = azurerm_redis_cache.this.hostname
  description = "Redis hostname — maps to the app's REDIS_HOST config."
}

output "redis_ssl_port" {
  value       = azurerm_redis_cache.this.ssl_port
  description = "Redis TLS port — maps to the app's REDIS_PORT config (non-TLS port is disabled, see main.tf)."
}

output "backup_storage_connection_string" {
  value       = azurerm_storage_account.backup.primary_connection_string
  description = "Wire this into DELETION_BACKUP_AZURE_CONNECTION_STRING (see src/jobs/backup-storage/get-backup-storage.ts)."
  sensitive   = true
}

output "backup_container_name" {
  value       = azurerm_storage_container.deletion_backups.name
  description = "Wire this into DELETION_BACKUP_AZURE_CONTAINER."
}

output "key_vault_id" {
  value       = azurerm_key_vault.app_secrets.id
  description = "ID of the (mostly empty) general secrets Key Vault — see main.tf's note distinguishing this from ../hsm's separate Premium Key Vault."
}
