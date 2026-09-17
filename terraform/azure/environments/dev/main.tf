module "network" {
  source = "../../modules/network"

  project     = var.project
  environment = var.environment
  location    = var.location
  vnet_cidr   = var.vnet_cidr
  subnet_cidr = var.subnet_cidr
  tags        = var.tags
}

module "iam" {
  source = "../../modules/iam"

  project             = var.project
  environment         = var.environment
  resource_group_name = module.network.resource_group_name
  resource_group_id   = module.network.resource_group_id
  location            = module.network.location
  github_org          = var.github_org
  github_repo         = var.github_repo
  github_deploy_ref   = var.github_deploy_ref
  tags                = var.tags
}

module "container_service" {
  source = "../../modules/container-service"

  project             = var.project
  environment         = var.environment
  resource_group_name = module.network.resource_group_name
  location            = module.network.location
  subnet_id           = module.network.subnet_id
  kubernetes_version  = var.kubernetes_version
  node_vm_size        = var.node_vm_size
  node_min_count      = var.node_min_count
  node_max_count      = var.node_max_count
  tags                = var.tags
}

module "cloud_saas" {
  source = "../../modules/cloud-saas"

  project                         = var.project
  environment                     = var.environment
  resource_group_name             = module.network.resource_group_name
  location                        = module.network.location
  vnet_id                         = module.network.vnet_id
  vnet_name                       = module.network.vnet_name
  postgres_subnet_cidr            = var.postgres_subnet_cidr
  db_name                         = var.db_name
  db_username                     = var.db_username
  db_sku_name                     = var.db_sku_name
  db_storage_mb                   = var.db_storage_mb
  db_ha_enabled                   = var.db_ha_enabled
  db_create_read_replica          = var.db_create_read_replica
  redis_sku_name                  = var.redis_sku_name
  redis_capacity                  = var.redis_capacity
  backup_storage_replication_type = var.backup_storage_replication_type
  tags                            = var.tags
}

module "hsm" {
  source = "../../modules/hsm"

  project                      = var.project
  environment                  = var.environment
  resource_group_name          = module.network.resource_group_name
  location                     = module.network.location
  allowed_principal_object_ids = var.hsm_allowed_principal_object_ids
  tags                         = var.tags
}
