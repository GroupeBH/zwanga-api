data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "deploy" {
  count = local.create_key_pair ? 1 : 0

  key_name   = local.managed_key_name
  public_key = trimspace(local.resolved_ssh_public_key)
}

resource "aws_instance" "primary" {
  ami                         = local.selected_ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  key_name                    = local.selected_key_name
  associate_public_ip_address = true
  monitoring                  = var.enable_detailed_monitoring
  user_data                   = templatefile("${path.module}/cloud-init.yml.tftpl", { hostname = local.name_prefix })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "${local.name_prefix}-root"
    }
  }

  tags = {
    Name = "${local.instance_name}-primary"
    Role = "primary"
  }
}

resource "aws_instance" "secondary" {
  count = var.secondary_instance_enabled ? 1 : 0

  ami                         = local.selected_ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public_secondary[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  key_name                    = local.selected_key_name
  associate_public_ip_address = true
  monitoring                  = var.enable_detailed_monitoring
  user_data                   = templatefile("${path.module}/cloud-init.yml.tftpl", { hostname = "${local.name_prefix}-secondary" })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true

    tags = {
      Name = "${local.name_prefix}-secondary-root"
    }
  }

  tags = {
    Name = "${local.instance_name}-secondary"
    Role = "secondary"
  }
}

resource "aws_eip" "primary" {
  count = var.allocate_elastic_ip ? 1 : 0

  domain = "vpc"

  tags = {
    Name = "${local.instance_name}-primary-eip"
    Role = "primary"
  }
}

resource "aws_eip" "secondary" {
  count = var.allocate_elastic_ip && var.secondary_instance_enabled ? 1 : 0

  domain = "vpc"

  tags = {
    Name = "${local.instance_name}-secondary-eip"
    Role = "secondary"
  }
}

resource "aws_eip_association" "primary" {
  count = var.allocate_elastic_ip ? 1 : 0

  allocation_id = aws_eip.primary[0].id
  instance_id   = aws_instance.primary.id
}

resource "aws_eip_association" "secondary" {
  count = var.allocate_elastic_ip && var.secondary_instance_enabled ? 1 : 0

  allocation_id = aws_eip.secondary[0].id
  instance_id   = aws_instance.secondary[0].id
}
