locals {
  name_prefix = "${var.project_name}-${var.environment}"
  instance_name = var.instance_name != "" ? var.instance_name : (
    var.project_name == "zwanga" && var.environment == "prod" ? "zwanga-api" : "${local.name_prefix}-api"
  )

  selected_az = var.availability_zone != "" ? var.availability_zone : data.aws_availability_zones.available.names[0]

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Platform    = "lightsail"
    },
    var.extra_tags
  )

  input_key_pair_name     = var.key_pair_name != null && var.key_pair_name != "" ? var.key_pair_name : null
  resolved_ssh_public_key = var.ssh_public_key != null && var.ssh_public_key != "" ? var.ssh_public_key : try(file(pathexpand(coalesce(var.ssh_public_key_path, ""))), null)
  create_key_pair         = local.resolved_ssh_public_key != null && local.input_key_pair_name == null
  managed_key_pair_name   = local.resolved_ssh_public_key != null ? "${local.name_prefix}-lightsail-${substr(sha1(nonsensitive(local.resolved_ssh_public_key)), 0, 8)}" : null
  selected_key_pair_name  = try(coalesce(local.input_key_pair_name, aws_lightsail_key_pair.deploy[0].name), null)
  allowed_ssh_cidrs       = var.admin_cidr != null && var.admin_cidr != "" ? distinct(concat([var.admin_cidr], var.allowed_ssh_cidr_blocks)) : var.allowed_ssh_cidr_blocks
  public_ip               = var.attach_static_ip ? aws_lightsail_static_ip.app[0].ip_address : aws_lightsail_instance.app.public_ip_address
}
