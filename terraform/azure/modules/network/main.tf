terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# NOTE on why this module's shape differs from both other clouds', not
# just a mechanical port:
#
# Azure introduces a resource-organization layer neither AWS nor GCP
# has: the Resource Group. Every resource below is created inside one —
# there's no AWS-account-level or GCP-project-level equivalent "flat"
# namespace to place things in directly.
#
# Like ../../gcp/modules/network (and unlike AWS), the subnet here is a
# single region-spanning subnet, not one per availability zone — Azure
# subnets are regional constructs; AKS node pools handle their own
# zone spread (see ../container-service).

locals {
  name = "${var.project}-${var.environment}"
}

resource "azurerm_resource_group" "this" {
  name     = "${local.name}-rg"
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "this" {
  name                = "${local.name}-vnet"
  address_space       = [var.vnet_cidr]
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_subnet" "private" {
  name                 = "${local.name}-private"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.subnet_cidr]
}

# --- NAT Gateway — outbound-only internet access for the private
#     subnet, same role as the AWS/GCP modules' equivalents. Azure NAT
#     Gateway needs its own Standard SKU public IP attached explicitly
#     (not auto-provisioned the way AWS's aws_nat_gateway allocates its
#     own EIP inline). ---

resource "azurerm_public_ip" "nat" {
  name                = "${local.name}-nat-ip"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  name                = "${local.name}-nat"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  nat_gateway_id       = azurerm_nat_gateway.this.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "private" {
  subnet_id      = azurerm_subnet.private.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}

# --- Base NSG — deliberately minimal, same posture as the AWS module's
#     base security group and the GCP module's baseline firewall rule:
#     only Azure's own implicit default rules (deny inbound from
#     internet, allow within VNet) apply here; detailed rules are added
#     by later modules, not centralized in this one. ---

resource "azurerm_network_security_group" "base" {
  name                = "${local.name}-base"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_subnet_network_security_group_association" "private" {
  subnet_id                 = azurerm_subnet.private.id
  network_security_group_id = azurerm_network_security_group.base.id
}
