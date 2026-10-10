output "key_vault_id" {
  value       = azurerm_key_vault.hsm.id
  description = "Premium (HSM-backed) Key Vault ID."
}

output "key_id" {
  value       = azurerm_key_vault_key.hmac_secrets.id
  description = "HSM-backed key ID — the eventual KmsEncryptionService (see main.tf's top-of-file note) would reference this."
}
