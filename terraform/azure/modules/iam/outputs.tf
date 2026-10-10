output "client_id" {
  value       = azurerm_user_assigned_identity.terraform_execution.client_id
  description = "Configure this as the client-id input to azure/login in the deploy workflow (used together with tenant_id/subscription_id below for OIDC federation, no client secret)."
}

output "tenant_id" {
  value       = data.azurerm_client_config.current.tenant_id
  description = "Configure this as the tenant-id input to azure/login."
}

output "subscription_id" {
  value       = data.azurerm_client_config.current.subscription_id
  description = "Configure this as the subscription-id input to azure/login."
}
