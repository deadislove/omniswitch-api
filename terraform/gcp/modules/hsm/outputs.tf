output "key_ring_id" {
  value       = google_kms_key_ring.this.id
  description = "KMS key ring ID."
}

output "crypto_key_id" {
  value       = google_kms_crypto_key.hmac_secrets.id
  description = "Crypto key ID — the eventual KmsEncryptionService (see main.tf's top-of-file note) would reference this."
}
