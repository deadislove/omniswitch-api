output "vpc_id" {
  value       = module.network.vpc_id
  description = "See ../../modules/network/outputs.tf."
}

output "private_subnet_ids" {
  value       = module.network.private_subnet_ids
  description = "See ../../modules/network/outputs.tf. Consumed by the container-service and cloud-saas modules."
}

output "public_subnet_ids" {
  value       = module.network.public_subnet_ids
  description = "See ../../modules/network/outputs.tf."
}

output "base_security_group_id" {
  value       = module.network.base_security_group_id
  description = "See ../../modules/network/outputs.tf."
}

output "github_actions_deploy_role_arn" {
  value       = module.iam.github_actions_deploy_role_arn
  description = "See ../../modules/iam/outputs.tf. Configure this as the deploy workflow's role-to-assume."
}

output "cluster_name" {
  value       = module.container_service.cluster_name
  description = "See ../../modules/container-service/outputs.tf."
}

output "cluster_endpoint" {
  value       = module.container_service.cluster_endpoint
  description = "See ../../modules/container-service/outputs.tf."
}

output "oidc_provider_arn" {
  value       = module.container_service.oidc_provider_arn
  description = "See ../../modules/container-service/outputs.tf. Use this for any future per-workload IRSA role."
}

output "node_security_group_id" {
  value       = module.container_service.node_security_group_id
  description = "See ../../modules/container-service/outputs.tf. Consumed by the cloud-saas module to scope RDS/ElastiCache ingress rules."
}

output "ecr_repository_url" {
  value       = module.container_service.ecr_repository_url
  description = "See ../../modules/container-service/outputs.tf."
}

output "db_endpoint" {
  value       = module.cloud_saas.db_endpoint
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "redis_primary_endpoint" {
  value       = module.cloud_saas.redis_primary_endpoint
  description = "See ../../modules/cloud-saas/outputs.tf."
}

output "backup_bucket_name" {
  value       = module.cloud_saas.backup_bucket_name
  description = "See ../../modules/cloud-saas/outputs.tf. Wire into DELETION_BACKUP_S3_BUCKET."
}

output "backup_bucket_region" {
  value       = module.cloud_saas.backup_bucket_region
  description = "See ../../modules/cloud-saas/outputs.tf. Wire into DELETION_BACKUP_S3_REGION."
}

output "hmac_secrets_kms_key_arn" {
  value       = module.hsm.key_arn
  description = "See ../../modules/hsm/outputs.tf."
}
