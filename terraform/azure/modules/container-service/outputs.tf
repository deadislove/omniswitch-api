output "cluster_name" {
  value       = module.aks.aks_name
  description = "AKS cluster name."
}

output "cluster_host" {
  value       = module.aks.host
  description = "AKS API server endpoint."
  sensitive   = true
}

output "oidc_issuer_url" {
  value       = module.aks.oidc_issuer_url
  description = "This cluster's Workload Identity OIDC issuer URL — the missing piece ../iam deliberately deferred here. The application's own federated credential (azurerm_federated_identity_credential) references this as its `issuer`."
}

output "acr_login_server" {
  value       = azurerm_container_registry.app.login_server
  description = "Push application images here."
}
