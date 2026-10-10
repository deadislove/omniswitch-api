output "state_bucket_name" {
  value       = google_storage_bucket.terraform_state.name
  description = "Feed this into each environment's backend config — see ../environments/dev/backend.tf."
}
