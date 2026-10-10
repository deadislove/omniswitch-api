output "network_id" {
  value       = module.network.network_id
  description = "See ../../modules/network/outputs.tf."
}

output "subnet_id" {
  value       = module.network.subnet_id
  description = "See ../../modules/network/outputs.tf. Consumed by the container-service and cloud-saas modules once they exist."
}

output "pods_range_name" {
  value       = module.network.pods_range_name
  description = "See ../../modules/network/outputs.tf."
}

output "services_range_name" {
  value       = module.network.services_range_name
  description = "See ../../modules/network/outputs.tf."
}

output "terraform_execution_sa_email" {
  value       = module.iam.terraform_execution_sa_email
  description = "See ../../modules/iam/outputs.tf."
}

output "workload_identity_provider" {
  value       = module.iam.workload_identity_provider
  description = "See ../../modules/iam/outputs.tf. Configure this as the deploy workflow's workload_identity_provider input."
}

output "gke_cluster_name" {
  value       = module.container_service.cluster_name
  description = "See ../../modules/container-service/outputs.tf."
}

output "gke_workload_identity_pool" {
  value       = module.container_service.workload_identity_pool
  description = "See ../../modules/container-service/outputs.tf."
}

output "artifact_registry_repository_url" {
  value       = module.container_service.artifact_registry_repository_url
  description = "See ../../modules/container-service/outputs.tf."
}

output "db_private_ip" {
  value       = module.cloud_saas.db_private_ip
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "redis_host" {
  value       = module.cloud_saas.redis_host
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "backup_bucket_name" {
  value       = module.cloud_saas.backup_bucket_name
  description = "See ../../modules/cloud-saas/outputs.tf. Wire into DELETION_BACKUP_GCS_BUCKET."
}

output "hmac_secrets_crypto_key_id" {
  value       = module.hsm.crypto_key_id
  description = "See ../../modules/hsm/outputs.tf."
}
