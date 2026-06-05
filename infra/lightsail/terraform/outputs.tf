output "instance_name" {
  description = "Lightsail instance name."
  value       = aws_lightsail_instance.app.name
}

output "bundle_id" {
  description = "Lightsail bundle ID."
  value       = var.bundle_id
}

output "monthly_budget_usd" {
  description = "Budget guardrail configured for this stack."
  value       = var.monthly_budget_usd
}

output "estimated_monthly_usd" {
  description = "Estimated monthly Lightsail instance cost used by the budget guardrail."
  value       = var.estimated_monthly_usd
}

output "static_ip_name" {
  description = "Lightsail static IP name when enabled."
  value       = var.attach_static_ip ? aws_lightsail_static_ip.app[0].name : ""
}

output "public_ip" {
  description = "Public IP address to use in DNS."
  value       = local.public_ip
}

output "private_ip" {
  description = "Private IP address of the Lightsail instance."
  value       = aws_lightsail_instance.app.private_ip_address
}

output "application_url" {
  description = "Expected application URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${local.public_ip}"
}

output "app_url" {
  description = "Public application URL, compatible with deploy.sh."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${local.public_ip}"
}

output "health_url" {
  description = "Documented public health URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}${var.app_healthcheck_path}" : "http://${local.public_ip}${var.app_healthcheck_path}"
}

output "ssh_command" {
  description = "SSH command for the instance."
  value       = "ssh ubuntu@${local.public_ip}"
}

output "ansible_inventory" {
  description = "Generated Ansible inventory content for the app host."
  value = join("\n", [
    "[app]",
    "primary ansible_host=${local.public_ip} private_ip=${aws_lightsail_instance.app.private_ip_address} ansible_user=ubuntu ansible_python_interpreter=/usr/bin/python3${var.ansible_ssh_private_key_file != null ? " ansible_ssh_private_key_file=${var.ansible_ssh_private_key_file}" : ""}",
    "",
    "[app:vars]",
    "ansible_python_interpreter=/usr/bin/python3",
    "",
  ])
}

output "deploy_admin_cidrs" {
  description = "Admin CIDRs passed to Ansible."
  value       = local.allowed_ssh_cidrs
}

output "deploy_admin_cidr" {
  description = "Primary admin CIDR."
  value       = length(local.allowed_ssh_cidrs) > 0 ? local.allowed_ssh_cidrs[0] : ""
}

output "deploy_app_image_repository" {
  description = "Docker image repository used by Ansible."
  value       = var.app_image_repository
}

output "deploy_app_image_tag" {
  description = "Docker image tag used by Ansible."
  value       = var.app_image_tag
}

output "deploy_app_port" {
  description = "App port used by Ansible and Caddy."
  value       = var.app_port
}

output "deploy_caddy_email" {
  description = "Caddy email used by Ansible."
  value       = var.caddy_email
}

output "deploy_domain_name" {
  description = "Domain name passed to Ansible."
  value       = var.domain_name
}

output "deploy_instance_name" {
  description = "Logical instance name used for the deployment."
  value       = local.instance_name
}

output "deploy_region" {
  description = "AWS region used for the deployment."
  value       = var.aws_region
}

output "deploy_public_ip" {
  description = "Public IP used by deploy.sh."
  value       = local.public_ip
}

output "deploy_private_ip" {
  description = "Private IP used by deploy.sh."
  value       = aws_lightsail_instance.app.private_ip_address
}

output "deploy_ssh_username" {
  description = "SSH username used by the Ubuntu Lightsail blueprint."
  value       = "ubuntu"
}
