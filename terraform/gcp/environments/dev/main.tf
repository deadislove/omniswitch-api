module "network" {
  source = "../../modules/network"

  project        = var.project
  environment    = var.environment
  gcp_project_id = var.gcp_project_id
  region         = var.region
  subnet_cidr    = var.subnet_cidr
  pods_cidr      = var.pods_cidr
  services_cidr  = var.services_cidr
  labels         = var.labels
}

module "iam" {
  source = "../../modules/iam"

  project           = var.project
  environment       = var.environment
  gcp_project_id    = var.gcp_project_id
  github_org        = var.github_org
  github_repo       = var.github_repo
  github_deploy_ref = var.github_deploy_ref
  labels            = var.labels
}

module "container_service" {
  source = "../../modules/container-service"

  project             = var.project
  environment         = var.environment
  gcp_project_id      = var.gcp_project_id
  region              = var.region
  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  pods_range_name     = module.network.pods_range_name
  services_range_name = module.network.services_range_name
  kubernetes_version  = var.kubernetes_version
  node_machine_type   = var.node_machine_type
  node_min_count      = var.node_min_count
  node_max_count      = var.node_max_count
  deletion_protection = var.gke_deletion_protection
  labels              = var.labels
}

module "cloud_saas" {
  source = "../../modules/cloud-saas"

  project                = var.project
  environment            = var.environment
  gcp_project_id         = var.gcp_project_id
  region                 = var.region
  network_id             = module.network.network_id
  db_name                = var.db_name
  db_username            = var.db_username
  db_tier                = var.db_tier
  db_availability_type   = var.db_availability_type
  db_create_read_replica = var.db_create_read_replica
  redis_tier             = var.redis_tier
  redis_memory_size_gb   = var.redis_memory_size_gb
  labels                 = var.labels
}

module "hsm" {
  source = "../../modules/hsm"

  project               = var.project
  environment           = var.environment
  gcp_project_id        = var.gcp_project_id
  region                = var.region
  allowed_member_emails = var.hsm_allowed_member_emails
  labels                = var.labels
}
