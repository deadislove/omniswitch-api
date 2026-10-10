output "resource_group_name" {
  value       = module.network.resource_group_name
  description = "See ../../modules/network/outputs.tf."
}

output "vnet_id" {
  value       = module.network.vnet_id
  description = "See ../../modules/network/outputs.tf."
}

output "subnet_id" {
  value       = module.network.subnet_id
  description = "See ../../modules/network/outputs.tf. Consumed by the container-service and cloud-saas modules."
}

output "terraform_execution_client_id" {
  value       = module.iam.client_id
  description = "See ../../modules/iam/outputs.tf."
}

output "tenant_id" {
  value       = module.iam.tenant_id
  description = "See ../../modules/iam/outputs.tf."
}

output "subscription_id" {
  value       = module.iam.subscription_id
  description = "See ../../modules/iam/outputs.tf."
}

output "aks_cluster_name" {
  value       = module.container_service.cluster_name
  description = "See ../../modules/container-service/outputs.tf."
}

output "aks_oidc_issuer_url" {
  value       = module.container_service.oidc_issuer_url
  description = "See ../../modules/container-service/outputs.tf."
}

output "acr_login_server" {
  value       = module.container_service.acr_login_server
  description = "See ../../modules/container-service/outputs.tf."
}

output "db_fqdn" {
  value       = module.cloud_saas.db_fqdn
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "redis_host" {
  value       = module.cloud_saas.redis_host
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "backup_container_name" {
  value       = module.cloud_saas.backup_container_name
  description = "See ../../modules/cloud-saas/outputs.tf. Wire into DELETION_BACKUP_AZURE_CONTAINER."
}

output "hmac_secrets_key_id" {
  value       = module.hsm.key_id
  description = "See ../../modules/hsm/outputs.tf."
}
