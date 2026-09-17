terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

locals {
  name = "${var.project}-${var.environment}"

  # AZ index map, e.g. { "us-east-1a" = 0, "us-east-1b" = 1, ... } — used to
  # derive deterministic, non-overlapping CIDR blocks per AZ without the
  # caller having to hand-compute subnet ranges.
  az_index = { for idx, az in var.availability_zones : az => idx }

  # /24 subnets carved out of the /16 VPC CIDR — private subnets use the
  # low indexes (0, 1, 2, ...), public subnets use indexes offset by 100
  # (100, 101, 102, ...) so the two ranges never collide and stay visually
  # distinguishable when reading `terraform plan` output or the AWS console.
  #
  # NOTE: a real EKS deployment using the VPC CNI often wants larger
  # subnets than /24 (each pod consumes a real VPC IP) — revisit this
  # newbits value once real pod-density numbers exist; /24 (254 usable
  # IPs) is a reasonable starting point for a reference deployment, not a
  # number picked to be final.
  private_subnet_cidrs = { for az, idx in local.az_index : az => cidrsubnet(var.vpc_cidr, 8, idx) }
  public_subnet_cidrs  = { for az, idx in local.az_index : az => cidrsubnet(var.vpc_cidr, 8, idx + 100) }

  common_tags = merge(var.tags, {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Component   = "network"
  })
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, {
    Name = local.name
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.name}-igw"
  })
}

# --- Public subnets (one per AZ) ---

resource "aws_subnet" "public" {
  for_each = local.public_subnet_cidrs

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name                     = "${local.name}-public-${each.key}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1" # required tag for EKS's AWS Load Balancer Controller to discover public subnets
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-public"
  })
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# --- Private subnets (one per AZ) ---

resource "aws_subnet" "private" {
  for_each = local.private_subnet_cidrs

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = merge(local.common_tags, {
    Name                              = "${local.name}-private-${each.key}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1" # required tag for EKS's internal load balancers
  })
}

# --- NAT Gateway(s) — either one shared (single_nat_gateway = true, cheaper,
#     single point of failure for private-subnet egress) or one per AZ
#     (single_nat_gateway = false, real HA, ~3x cost). See variables.tf's
#     own docblock for when to use which. ---

resource "aws_eip" "nat" {
  for_each = var.single_nat_gateway ? { (var.availability_zones[0]) = local.public_subnet_cidrs[var.availability_zones[0]] } : local.public_subnet_cidrs

  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name}-nat-${each.key}"
  })
}

resource "aws_nat_gateway" "this" {
  for_each = aws_eip.nat

  allocation_id = each.value.id
  subnet_id     = aws_subnet.public[each.key].id

  tags = merge(local.common_tags, {
    Name = "${local.name}-nat-${each.key}"
  })

  depends_on = [aws_internet_gateway.this]
}

# --- Private route tables — one per AZ, each routing to either its own AZ's
#     NAT Gateway or the single shared one, depending on single_nat_gateway. ---

resource "aws_route_table" "private" {
  for_each = local.private_subnet_cidrs

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = var.single_nat_gateway ? aws_nat_gateway.this[var.availability_zones[0]].id : aws_nat_gateway.this[each.key].id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-private-${each.key}"
  })
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# --- Base security group — deliberately minimal. Ingress rules for the
#     cluster (node-to-node, control-plane-to-node) and for managed
#     services (RDS, ElastiCache) are each added by their own module,
#     not centralized here. ---

resource "aws_security_group" "base" {
  name        = "${local.name}-base"
  description = "Base security group - egress scoped to the VPC only, no ingress rules. Later phases add their own scoped ingress rules rather than widening this one."
  vpc_id      = aws_vpc.this.id

  egress {
    # Scoped to the VPC's own CIDR, not 0.0.0.0/0 - nothing currently
    # attaches to this group (it's exposed as an output for future use),
    # and unrestricted egress to the public internet is unnecessary for
    # anything that would. A resource that genuinely needs internet
    # egress (e.g. via NAT Gateway) should get its own scoped security
    # group, not rely on this one being wide open.
    description = "Allow outbound within the VPC only - inbound is deliberately not opened here"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-base"
  })
}
