output "terraform_execution_sa_email" {
  value       = google_service_account.terraform_execution.email
  description = "Configure this as the service_account input to google-github-actions/auth in the deploy workflow."
}

output "workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github_actions.name
  description = "Configure this as the workload_identity_provider input to google-github-actions/auth."
}
