output "network_id" {
  value       = google_compute_network.this.id
  description = "VPC network ID — consumed by the container-service, cloud-saas, and hsm modules."
}

output "network_name" {
  value       = google_compute_network.this.name
  description = "VPC network name (some GCP resources want the name, not the full ID)."
}

output "subnet_id" {
  value       = google_compute_subnetwork.private.id
  description = "Private regional subnet ID — GKE nodes, Cloud SQL, Memorystore all live here."
}

output "subnet_name" {
  value       = google_compute_subnetwork.private.name
  description = "Private regional subnet name."
}

output "pods_range_name" {
  value       = google_compute_subnetwork.private.secondary_ip_range[0].range_name
  description = "Secondary range name for GKE pod IPs — the container-service module's GKE cluster references this by name, not by CIDR."
}

output "services_range_name" {
  value       = google_compute_subnetwork.private.secondary_ip_range[1].range_name
  description = "Secondary range name for GKE Service ClusterIPs."
}

output "region" {
  value       = var.region
  description = "Pass-through of the region this network was created in, so downstream modules don't need their own region variable that could drift from this one."
}
