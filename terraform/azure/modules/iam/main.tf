terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# NOTE on scope — read before adding to this module:
#
# Same split as ../../aws/modules/iam and ../../gcp/modules/iam: this
# module creates the Terraform-execution identity and GitHub Actions
# federation. It deliberately does NOT create AKS's own Workload
# Identity federated credential for the application's k8s ServiceAccount
# — that credential's `issuer` needs the AKS cluster's own OIDC issuer
# URL, which only exists once ../container-service creates the cluster,
# same ordering reason as the other two clouds.
#
# Azure's GitHub Actions federation pattern is the simplest of the three
# clouds: a User-Assigned Managed Identity (UAMI) plus a Federated
# Identity Credential directly on it — no separate App Registration/
# Service Principal resource needed (unlike, say, an AWS IAM role's
# OIDC-federated trust policy or a GCP Workload Identity Pool), so this
# module doesn't need the azuread provider at all, only azurerm.
#
# Custom-role actions DO support namespace wildcards
# ("Microsoft.Network/*") — a real difference from GCP, whose custom
# roles need every permission string enumerated individually (see
# ../../gcp/modules/iam/main.tf's note on that). This module's
# least-privilege role composition is closer in spirit to the AWS IAM
# module's per-service wildcard statements than to the GCP module's
# predefined-role composition.

locals {
  name = "${var.project}-${var.environment}"
}

resource "azurerm_user_assigned_identity" "terraform_execution" {
  name                = "${local.name}-tf-exec"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_federated_identity_credential" "github_actions" {
  name                = "${local.name}-github-actions"
  resource_group_name = var.resource_group_name
  parent_id           = azurerm_user_assigned_identity.terraform_execution.id

  issuer  = "https://token.actions.githubusercontent.com"
  subject = "repo:${var.github_org}/${var.github_repo}:ref:${var.github_deploy_ref}"

  # Fixed value Microsoft's own docs specify for GitHub Actions ->
  # Entra ID federation — not this project's own audience string.
  audience = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_definition" "terraform_execution" {
  name        = "${local.name}-terraform-execution"
  scope       = var.resource_group_id
  description = "Least-privilege (scoped-to-service, not Owner/Contributor) role for the identity that runs terraform plan/apply for this project."

  permissions {
    actions = [
      "Microsoft.Network/*",
      "Microsoft.ContainerService/*",
      "Microsoft.ContainerRegistry/*",
      "Microsoft.DBforPostgreSQL/*",
      "Microsoft.Cache/*",
      "Microsoft.Storage/*",
      "Microsoft.KeyVault/*",
      "Microsoft.ManagedIdentity/*",
      "Microsoft.Authorization/roleAssignments/write",
      "Microsoft.Authorization/roleAssignments/delete",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
    ]
    not_actions = []
  }

  assignable_scopes = [var.resource_group_id]
}

resource "azurerm_role_assignment" "terraform_execution" {
  scope              = var.resource_group_id
  role_definition_id = azurerm_role_definition.terraform_execution.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.terraform_execution.principal_id
}

data "azurerm_client_config" "current" {}
