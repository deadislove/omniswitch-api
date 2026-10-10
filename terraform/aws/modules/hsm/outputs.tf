output "key_arn" {
  value       = aws_kms_key.hmac_secrets.arn
  description = "KMS key ARN — the eventual KmsEncryptionService (see main.tf's top-of-file note) would reference this."
}

output "key_id" {
  value       = aws_kms_key.hmac_secrets.key_id
  description = "KMS key ID."
}

output "alias_arn" {
  value       = aws_kms_alias.hmac_secrets.arn
  description = "Human-readable alias ARN — safer to reference from application config than the raw key ID, since the alias can be repointed at a new key (e.g. during rotation) without a config change."
}
