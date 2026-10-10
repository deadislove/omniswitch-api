output "resource_group_name" {
  value       = azurerm_resource_group.this.name
  description = "Resource Group name — every other module's resources are created inside this same group."
}

output "resource_group_id" {
  value       = azurerm_resource_group.this.id
  description = "Full ARM resource ID of the Resource Group — used to scope custom roles/role assignments to this group instead of the whole subscription."
}

output "location" {
  value       = azurerm_resource_group.this.location
  description = "Pass-through of the region resources were created in, so downstream modules don't need their own location variable that could drift from this one."
}

output "vnet_id" {
  value       = azurerm_virtual_network.this.id
  description = "VNet ID — consumed by the container-service, cloud-saas, and hsm modules."
}

output "vnet_name" {
  value       = azurerm_virtual_network.this.name
  description = "VNet name."
}

output "subnet_id" {
  value       = azurerm_subnet.private.id
  description = "Private subnet ID — AKS nodes, and later Cloud SaaS private endpoints, live here."
}

output "nsg_id" {
  value       = azurerm_network_security_group.base.id
  description = "The minimal base NSG. Later modules should create their own scoped NSGs/rules rather than adding rules to this one."
}
