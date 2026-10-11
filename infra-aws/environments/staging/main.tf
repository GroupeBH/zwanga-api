terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
  }
  # Never run -migrate-state or copy the production state into this root.
  backend "s3" {
    bucket              = "tfstates-zwanga-api"
    key                 = "zwanga/staging/terraform.tfstate"
    region              = "eu-central-1"
    allowed_account_ids = ["046374119247"]
    encrypt             = true
    use_lockfile        = true
  }
}

provider "aws" {
  region              = "eu-central-1"
  allowed_account_ids = ["046374119247"]
  default_tags {
    tags = { Project = "zwanga-api", Environment = "staging", ManagedBy = "Terraform" }
  }
}

locals {
  account   = "046374119247"
  region    = "eu-central-1"
  name      = "zwanga-api-staging"
  domain    = "staging.compute-api.zwanga-app.com"
  zone      = "Z0100742PIM0UW6FZED7"
  registry  = "${local.account}.dkr.ecr.${local.region}.amazonaws.com"
  parameter = "/zwanga-api/staging/integrations"
  config = {
    region    = local.region, domain = local.domain, registry = local.registry,
    artifacts = "zwanga-staging-artifacts-${local.account}",
    media     = "zwanga-staging-media-${local.account}", parameter = local.parameter
  }
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_vpc" "staging" {
  cidr_block           = "10.43.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}
resource "aws_subnet" "staging" {
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = "10.43.0.0/24"
  map_public_ip_on_launch = true
}
resource "aws_internet_gateway" "staging" { vpc_id = aws_vpc.staging.id }
resource "aws_route_table" "staging" {
  vpc_id = aws_vpc.staging.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.staging.id
  }
}
resource "aws_route_table_association" "staging" {
  subnet_id      = aws_subnet.staging.id
  route_table_id = aws_route_table.staging.id
}
resource "aws_security_group" "staging" {
  name   = local.name
  vpc_id = aws_vpc.staging.id
  # No SSH, PostgreSQL, cache or direct API ingress. Operations use SSM.
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_s3_bucket" "storage" {
  for_each      = toset(["media", "artifacts"])
  bucket        = "zwanga-staging-${each.key}-${local.account}"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "storage" {
  for_each                = aws_s3_bucket.storage
  bucket                  = each.value.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "storage" {
  for_each = aws_s3_bucket.storage
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "tls" {
  for_each = aws_s3_bucket.storage
  bucket   = each.value.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [each.value.arn, "${each.value.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_ecr_repository" "images" {
  for_each             = toset(["backend", "postgres"])
  name                 = "${local.name}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_ecr_lifecycle_policy" "images" {
  for_each   = aws_ecr_repository.images
  repository = each.value.name
  # Keep tagged releases, including the last deployed image during long idle periods.
  policy = jsonencode({ rules = [{ rulePriority = 1, description = "Expire untagged layers after 7 days",
    selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 },
    action    = { type = "expire" }
  }] })
}
resource "aws_ssm_parameter" "integrations" {
  name             = local.parameter
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "{}"
  value_wo_version = 1
  # Bootstrap only, without persisting the remote secret in Terraform state.
  # Never increment this version to edit credentials: use the SSM console.
}

resource "aws_instance" "staging" {
  ami                                  = nonsensitive(data.aws_ssm_parameter.ubuntu.value)
  instance_type                        = "t4g.medium"
  subnet_id                            = aws_subnet.staging.id
  vpc_security_group_ids               = [aws_security_group.staging.id]
  iam_instance_profile                 = aws_iam_instance_profile.host.name
  associate_public_ip_address          = true
  instance_initiated_shutdown_behavior = "stop"
  user_data_replace_on_change          = true
  user_data = "#cloud-config\n${yamlencode({
    package_update = true,
    packages       = ["ansible-core", "awscli", "python3"],
    write_files = concat(
      [{ path = "/opt/zwanga-staging/config.json", permissions = "0600", content = jsonencode(local.config) }],
      [for name in ["configure.yml", "deploy.yml", "templates/Caddyfile.j2"] : {
        path    = "/opt/zwanga-staging/ansible/${name}", permissions = "0600", encoding = "gz+b64",
        content = base64gzip(file("${path.module}/ansible/${name}"))
      }],
      [for name in ["runtime.py", "zwanga-staging.service", "zwanga-staging-stop.service", "zwanga-staging-stop.timer"] : {
        path    = "/opt/zwanga-staging/ansible/files/${name}", permissions = "0600", encoding = "gz+b64",
        content = base64gzip(file("${path.module}/host/${name}"))
      }]
    ),
    runcmd = [
      ["chmod", "0700", "/opt/zwanga-staging"],
      ["ansible-playbook", "-i", "localhost,", "-c", "local", "/opt/zwanga-staging/ansible/configure.yml"],
      # The first provisioning boot installs packages then stops, without an API.
      ["shutdown", "-h", "+1"]
    ]
  })}"
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    delete_on_termination = false
  }
  # Avoid Unlimited CPU-credit charges; sustained load may throttle.
  credit_specification { cpu_credits = "standard" }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # AWS SDK inside Docker uses the instance role.
  }
  tags = { Name = local.name }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [ami] # AMI replacement requires an explicit data-recovery plan.
  }
  depends_on = [aws_route_table_association.staging, aws_iam_role_policy_attachment.ssm, aws_iam_role_policy.host]
}

resource "aws_route53_record" "staging" {
  zone_id = local.zone
  name    = local.domain
  type    = "A"
  ttl     = 60
  records = ["0.0.0.0"]
  lifecycle { ignore_changes = [records] }
}
