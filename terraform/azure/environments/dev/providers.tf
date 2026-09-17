terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  # Empty features {} block is mandatory for the azurerm provider even
  # with no overrides — leaving it out is a hard error, not a warning.
  features {}
}
