data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_lightsail_key_pair" "deploy" {
  count = local.create_key_pair ? 1 : 0

  name       = local.managed_key_pair_name
  public_key = trimspace(local.resolved_ssh_public_key)
}

resource "aws_lightsail_instance" "app" {
  name              = local.instance_name
  availability_zone = local.selected_az
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  ip_address_type   = var.ip_address_type
  key_pair_name     = local.selected_key_pair_name
  user_data         = templatefile("${path.module}/cloud-init.yml.tftpl", { hostname = local.instance_name })

  tags = local.common_tags

  lifecycle {
    precondition {
      condition     = var.estimated_monthly_usd <= var.monthly_budget_usd
      error_message = "The estimated monthly cost must stay within monthly_budget_usd."
    }
  }
}

resource "aws_lightsail_static_ip" "app" {
  count = var.attach_static_ip ? 1 : 0

  name = "${local.instance_name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "app" {
  count = var.attach_static_ip ? 1 : 0

  static_ip_name = aws_lightsail_static_ip.app[0].name
  instance_name  = aws_lightsail_instance.app.name
}

resource "aws_lightsail_instance_public_ports" "app" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = local.allowed_ssh_cidrs
  }

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = var.allowed_http_cidr_blocks
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
    cidrs     = var.allowed_https_cidr_blocks
  }

  lifecycle {
    precondition {
      condition     = length(local.allowed_ssh_cidrs) > 0
      error_message = "At least one SSH admin CIDR is required."
    }
  }
}
