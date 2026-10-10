output "vpc_id" {
  value       = aws_vpc.this.id
  description = "VPC ID — consumed by the container-service, cloud-saas, and hsm modules to place resources inside this network."
}

output "vpc_cidr" {
  value       = aws_vpc.this.cidr_block
  description = "The VPC's CIDR block, for security-group rules that need to reference it (e.g. RDS allowing traffic from anywhere inside the VPC)."
}

output "public_subnet_ids" {
  value       = [for s in aws_subnet.public : s.id]
  description = "Public subnet IDs, one per AZ — for anything that needs a public IP (the ingress load balancer, a bastion if one is ever added)."
}

output "private_subnet_ids" {
  value       = [for s in aws_subnet.private : s.id]
  description = "Private subnet IDs, one per AZ — EKS node groups, RDS, ElastiCache all live here, never in a public subnet."
}

output "base_security_group_id" {
  value       = aws_security_group.base.id
  description = "The minimal, egress-only base security group. Later modules should create their own scoped security groups rather than adding ingress rules to this one."
}

output "nat_gateway_ids" {
  value       = { for k, v in aws_nat_gateway.this : k => v.id }
  description = "NAT Gateway IDs keyed by availability zone — mostly useful for cost/HA auditing (how many NAT Gateways actually exist, matching single_nat_gateway's setting)."
}
