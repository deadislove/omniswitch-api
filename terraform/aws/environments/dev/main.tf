module "network" {
  source = "../../modules/network"

  project            = var.project
  environment        = var.environment
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = var.single_nat_gateway
  tags               = var.tags
}

module "iam" {
  source = "../../modules/iam"

  project           = var.project
  environment       = var.environment
  github_org        = var.github_org
  github_repo       = var.github_repo
  github_deploy_ref = var.github_deploy_ref
  tags              = var.tags
}

module "container_service" {
  source = "../../modules/container-service"

  project             = var.project
  environment         = var.environment
  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  cluster_version     = var.cluster_version
  node_instance_types = var.node_instance_types
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size
  node_desired_size   = var.node_desired_size
  tags                = var.tags
}

module "cloud_saas" {
  source = "../../modules/cloud-saas"

  project                    = var.project
  environment                = var.environment
  vpc_id                     = module.network.vpc_id
  vpc_cidr                   = var.vpc_cidr
  private_subnet_ids         = module.network.private_subnet_ids
  allowed_security_group_ids = [module.container_service.node_security_group_id]
  db_name                    = var.db_name
  db_username                = var.db_username
  db_instance_class          = var.db_instance_class
  db_multi_az                = var.db_multi_az
  db_create_read_replica     = var.db_create_read_replica
  redis_node_type            = var.redis_node_type
  redis_num_cache_clusters   = var.redis_num_cache_clusters
  tags                       = var.tags
}

module "hsm" {
  source = "../../modules/hsm"

  project                = var.project
  environment            = var.environment
  allowed_principal_arns = var.hsm_allowed_principal_arns
  key_admin_arns         = [module.iam.github_actions_deploy_role_arn]
  tags                   = var.tags
}
