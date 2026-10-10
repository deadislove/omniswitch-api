output "cluster_name" {
  value       = module.eks.cluster_name
  description = "EKS cluster name — for kubectl/CI config and for ../cloud-saas security group rules that need to allow traffic from cluster nodes."
}

output "cluster_endpoint" {
  value       = module.eks.cluster_endpoint
  description = "EKS API server endpoint."
}

output "cluster_certificate_authority_data" {
  value       = module.eks.cluster_certificate_authority_data
  description = "Base64-encoded cluster CA certificate, for kubeconfig generation."
  sensitive   = true
}

output "oidc_provider_arn" {
  value       = module.eks.oidc_provider_arn
  description = "ARN of this cluster's own IRSA OIDC provider — created by the eks module itself (enable_irsa = true), now that the cluster's real issuer URL exists. This is the missing piece ../iam deliberately deferred to this module; per-workload IRSA roles (e.g. for the app's own service account) should reference this output, not build their own OIDC provider."
}

output "node_security_group_id" {
  value       = module.eks.node_security_group_id
  description = "Security group attached to worker nodes — for ../cloud-saas to scope RDS/ElastiCache ingress rules to actual cluster traffic instead of the whole VPC CIDR."
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.app.repository_url
  description = "Push application images here; referenced by the CI deploy workflow using the role from ../iam."
}
