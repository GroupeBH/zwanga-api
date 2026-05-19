output "vpc_id" {
  description = "Created VPC ID."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs keyed by role."
  value = merge(
    {
      primary = aws_subnet.public.id
    },
    var.secondary_instance_enabled ? {
      secondary = aws_subnet.public_secondary[0].id
    } : {}
  )
}

output "security_group_id" {
  description = "Security group ID."
  value       = aws_security_group.app.id
}

output "instance_ids" {
  description = "EC2 instance IDs keyed by role."
  value       = { for role, instance in local.monitored_instances : role => instance.id }
}

output "elastic_ips" {
  description = "Elastic/Public IPs keyed by role."
  value       = { for role, instance in local.monitored_instances : role => instance.public_ip }
}

output "private_ips" {
  description = "Private IPs keyed by role."
  value       = { for role, instance in local.monitored_instances : role => instance.private_ip }
}

output "public_ip" {
  description = "Primary public IP address to use in DNS."
  value       = local.public_ip
}

output "public_dns" {
  description = "Primary public DNS name."
  value       = local.public_dns
}

output "external_dns_failover_targets" {
  description = "Public IPs to use as primary/secondary targets in an external DNS provider."
  value       = { for role, instance in local.monitored_instances : role => instance.public_ip }
}

output "application_url" {
  description = "Expected application URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${local.public_ip}"
}

output "app_url" {
  description = "Public application URL, compatible with zwanga-infra deploy.sh."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${local.public_ip}"
}

output "health_url" {
  description = "Documented public health URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}${var.app_healthcheck_path}" : "http://${local.public_ip}${var.app_healthcheck_path}"
}

output "ssh_commands" {
  description = "SSH commands keyed by role."
  value = merge(
    {
      primary = "ssh ubuntu@${local.monitored_instances.primary.public_ip}"
    },
    var.secondary_instance_enabled ? {
      secondary = "ssh ubuntu@${local.monitored_instances.secondary.public_ip}"
    } : {}
  )
}

output "ansible_inventory" {
  description = "Generated Ansible inventory content for the app hosts."
  value = join("\n", concat(
    ["[app]"],
    [
      "primary ansible_host=${local.monitored_instances.primary.public_ip} private_ip=${local.monitored_instances.primary.private_ip} ansible_user=ubuntu ansible_python_interpreter=/usr/bin/python3${local.ansible_key_fragment}"
    ],
    var.secondary_instance_enabled ? [
      "secondary ansible_host=${local.monitored_instances.secondary.public_ip} private_ip=${local.monitored_instances.secondary.private_ip} ansible_user=ubuntu ansible_python_interpreter=/usr/bin/python3${local.ansible_key_fragment}"
    ] : [],
    ["", "[app:vars]", "ansible_python_interpreter=/usr/bin/python3", ""]
  ))
}

output "cloudwatch_log_group_app" {
  description = "CloudWatch log group for app logs."
  value       = aws_cloudwatch_log_group.app.name
}

output "cloudwatch_log_group_caddy" {
  description = "CloudWatch log group for Caddy logs."
  value       = aws_cloudwatch_log_group.caddy.name
}

output "ops_alerts_topic_arn" {
  description = "SNS topic ARN used for infra alerts when email endpoints are configured."
  value       = length(var.alarm_email_endpoints) > 0 ? aws_sns_topic.ops[0].arn : ""
}

output "deploy_admin_cidrs" {
  description = "Admin CIDRs passed to Ansible."
  value       = local.allowed_ssh_cidrs
}

output "deploy_admin_cidr" {
  description = "Primary admin CIDR compatible with zwanga-infra."
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

output "deploy_primary_public_ip" {
  description = "Primary public IP used by deploy.sh to build the Ansible inventory."
  value       = local.monitored_instances.primary.public_ip
}

output "deploy_primary_private_ip" {
  description = "Primary private IP used by deploy.sh to build Caddy upstream inventory data."
  value       = local.monitored_instances.primary.private_ip
}

output "deploy_secondary_public_ip" {
  description = "Secondary public IP used by deploy.sh when enabled."
  value       = try(local.monitored_instances.secondary.public_ip, "")
}

output "deploy_secondary_private_ip" {
  description = "Secondary private IP used by deploy.sh when enabled."
  value       = try(local.monitored_instances.secondary.private_ip, "")
}

output "deploy_secondary_enabled" {
  description = "Whether the low-cost failover node is enabled."
  value       = var.secondary_instance_enabled
}

output "ssm_parameter_names" {
  description = "Created SSM parameter names."
  value       = [for p in aws_ssm_parameter.secure_params : p.name]
  sensitive   = true
}
