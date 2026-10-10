output "resource_group_name" {
  value       = azurerm_resource_group.state.name
  description = "Feed this into each environment's backend config — see ../environments/dev/backend.tf."
}

output "storage_account_name" {
  value       = azurerm_storage_account.terraform_state.name
  description = "Feed this into each environment's backend config."
}

output "container_name" {
  value       = azurerm_storage_container.terraform_state.name
  description = "Feed this into each environment's backend config."
}
