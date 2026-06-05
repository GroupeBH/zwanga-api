locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  instance_name = var.instance_name != "" ? var.instance_name : (
    var.project_name == "zwanga" && var.environment == "prod" ? "zwanga-api" : "${local.name_prefix}-api"
  )

  selected_az = var.availability_zone != "" ? var.availability_zone : data.aws_availability_zones.available.names[0]
  secondary_selected_az = var.secondary_availability_zone != "" ? var.secondary_availability_zone : (
    length(data.aws_availability_zones.available.names) > 1 ? (
      data.aws_availability_zones.available.names[0] == local.selected_az ? data.aws_availability_zones.available.names[1] : data.aws_availability_zones.available.names[0]
    ) : local.selected_az
  )

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.extra_tags
  )

  input_key_name          = var.key_name != null && var.key_name != "" ? var.key_name : null
  input_existing_key_name = var.existing_key_name != null && var.existing_key_name != "" ? var.existing_key_name : null
  resolved_ssh_public_key = var.ssh_public_key != null && var.ssh_public_key != "" ? var.ssh_public_key : try(file(pathexpand(coalesce(var.ssh_public_key_path, ""))), null)
  create_key_pair         = local.resolved_ssh_public_key != null && local.input_key_name == null && local.input_existing_key_name == null
  managed_key_name        = local.resolved_ssh_public_key != null ? "${local.name_prefix}-deploy-${substr(sha1(nonsensitive(local.resolved_ssh_public_key)), 0, 8)}" : null
  selected_key_name       = try(coalesce(local.input_key_name, local.input_existing_key_name, aws_key_pair.deploy[0].key_name), null)
  selected_ami_id         = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu.id
  public_ip               = var.allocate_elastic_ip ? aws_eip.primary[0].public_ip : aws_instance.primary.public_ip
  public_dns              = var.allocate_elastic_ip ? aws_eip.primary[0].public_dns : aws_instance.primary.public_dns
  ansible_key_fragment    = var.ansible_ssh_private_key_file != null ? " ansible_ssh_private_key_file=${var.ansible_ssh_private_key_file}" : ""
  allowed_ssh_cidrs       = var.admin_cidr != null && var.admin_cidr != "" ? distinct(concat([var.admin_cidr], var.allowed_ssh_cidr_blocks)) : var.allowed_ssh_cidr_blocks

  monitored_instances = merge(
    {
      primary = {
        id         = aws_instance.primary.id
        private_ip = aws_instance.primary.private_ip
        public_ip  = var.allocate_elastic_ip ? aws_eip.primary[0].public_ip : aws_instance.primary.public_ip
      }
    },
    var.secondary_instance_enabled ? {
      secondary = {
        id         = aws_instance.secondary[0].id
        private_ip = aws_instance.secondary[0].private_ip
        public_ip  = var.allocate_elastic_ip ? aws_eip.secondary[0].public_ip : aws_instance.secondary[0].public_ip
      }
    } : {}
  )

  ssm_secure_parameter_names = nonsensitive(toset(keys(var.ssm_secure_parameters)))
}
