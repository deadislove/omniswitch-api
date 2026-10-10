output "cluster_name" {
  value       = module.gke.name
  description = "GKE cluster name."
}

output "cluster_endpoint" {
  value       = module.gke.endpoint
  description = "GKE API server endpoint."
  sensitive   = true
}

output "cluster_ca_certificate" {
  value       = module.gke.ca_certificate
  description = "Base64-encoded cluster CA certificate, for kubeconfig generation."
  sensitive   = true
}

output "workload_identity_pool" {
  value       = "${var.gcp_project_id}.svc.id.goog"
  description = "This cluster's Workload Identity pool — the missing piece ../iam deliberately deferred here. Per-workload IAM bindings (e.g. for the app's own k8s ServiceAccount) reference this, granting roles/iam.workloadIdentityUser on \"serviceAccount:<this value>[NAMESPACE/KSA_NAME]\"."
}

output "artifact_registry_repository_url" {
  value       = "${var.region}-docker.pkg.dev/${var.gcp_project_id}/${google_artifact_registry_repository.app.repository_id}"
  description = "Push application images here."
}
