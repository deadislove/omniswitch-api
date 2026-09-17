output "state_bucket_name" {
  value       = aws_s3_bucket.terraform_state.id
  description = "Feed this into each environment's backend config (-backend-config=\"bucket=...\") — see ../environments/dev/backend.hcl.example."
}

output "lock_table_name" {
  value       = aws_dynamodb_table.terraform_locks.id
  description = "Feed this into each environment's backend config (-backend-config=\"dynamodb_table=...\")."
}
