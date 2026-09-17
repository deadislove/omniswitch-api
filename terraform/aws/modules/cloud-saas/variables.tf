variable "project" {
  type        = string
  description = "Project name, used as a prefix for every resource name and in tags."
  default     = "omniswitch-api"
}

variable "environment" {
  type        = string
  description = "Environment name (dev / staging / production) — used in resource names and tags."

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be one of: dev, staging, production."
  }
}

variable "vpc_id" {
  type        = string
  description = "VPC to place RDS/ElastiCache in — output of ../network."
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR — output of ../network. Used only as a fallback ingress source if allowed_security_group_ids is empty; prefer scoping ingress to the actual cluster security group instead of the whole VPC."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the DB/cache subnet groups — output of ../network."
}

variable "allowed_security_group_ids" {
  type        = list(string)
  description = "Security groups allowed to reach RDS (5432) and ElastiCache (6379) — normally just the EKS node security group (../container-service's node_security_group_id output), so ingress is scoped to real cluster traffic instead of the whole VPC CIDR. See the plan doc's stance on minimal-capability-over-broad-grant."
}

variable "db_name" {
  type        = string
  description = "Database name — must match the app's DB_NAME config (k8s/configmap.yaml)."
  default     = "omniswitch_payments"
}

variable "db_username" {
  type        = string
  description = "Master username. The master password itself is never a variable here — see main.tf's use of manage_master_user_password (RDS-managed, stored in Secrets Manager, never in state or a .tfvars file)."
  default     = "omniswitch_admin"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class. Recommended: db.t4g.medium for dev, db.r6g.large+ for production — this is a real cost/performance tradeoff, not a placeholder to leave at the dev default everywhere."
  default     = "db.t4g.medium"
}

variable "db_engine_version" {
  type        = string
  description = "PostgreSQL major.minor version — should track the version this project's Postgres is actually tested against (docker-compose.yml uses postgres:16-alpine)."
  default     = "16.4"
}

variable "db_multi_az" {
  type        = bool
  description = "Multi-AZ standby (separate from the read replica below — Multi-AZ is synchronous failover protection, the read replica is for read scaling/DR). Recommended: true outside dev, matching the plan doc's HA section and 20260912-gap-improvement-plan.md's P0-1 (real DR needs this on)."
  default     = false
}

variable "db_create_read_replica" {
  type        = bool
  description = "Whether to create a cross-AZ read replica. See db_multi_az's description for how this differs from Multi-AZ."
  default     = false
}

variable "db_allocated_storage" {
  type        = number
  description = "Allocated storage in GB."
  default     = 50
}

variable "redis_node_type" {
  type        = string
  description = "ElastiCache node type. Recommended: cache.t4g.micro for dev, cache.r6g.large+ for production."
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_clusters" {
  type        = number
  description = "Number of nodes in the replication group (1 primary + N-1 replicas). >= 2 enables automatic failover — matches this app's own k8s/redis.yaml note that it has no cluster-mode/sharding awareness, so replication (not clustering) is the right HA shape here too."
  default     = 2
}

variable "backup_bucket_force_destroy" {
  type        = bool
  description = "Whether the deletion-backup S3 bucket can be destroyed even if it still has objects in it. Recommended: false outside dev — an accidental `terraform destroy` should not silently take backups with it."
  default     = false
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to every resource this module creates — see ../../../shared/tagging.md."
  default     = {}
}
