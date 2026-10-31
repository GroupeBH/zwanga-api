terraform {
  required_version = ">= 1.11.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.71" }
  }
  # Separate root/state. Never import or migrate the production backend state here.
  backend "s3" {
    bucket              = "tfstates-zwanga-api"
    key                 = "zwanga/mobishastra-proxy/terraform.tfstate"
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
    tags = { Project = "zwanga-api", Environment = "production", Component = "mobishastra-proxy", ManagedBy = "Terraform" }
  }
}

variable "public_subnet_id" {
  description = "Existing public production subnet; its default route must remain the Internet Gateway."
  type        = string
  default     = "subnet-097de52bae124db83"
}
variable "ecs_security_group_id" {
  description = "Only this existing backend security group may connect to the proxy."
  type        = string
  default     = "sg-098ca6e23c7dbf487"
}
variable "alarm_actions" {
  description = "Optional existing SNS topic ARNs. Empty means alarm state only, no operator notification."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.alarm_actions : startswith(arn, "arn:aws:sns:eu-central-1:046374119247:")])
    error_message = "Use existing SNS topics in this account and region."
  }
}

locals {
  name = "zwanga-api-production-mobishastra-proxy"
  config = {
    private_ip = aws_network_interface.proxy.private_ip
    vpc_cidr   = data.aws_vpc.existing.cidr_block
    region     = "eu-central-1"
    namespace  = "Zwanga/MobishastraProxy"
    component  = "mobishastra-proxy"
  }
}

data "aws_subnet" "existing" { id = var.public_subnet_id }
data "aws_vpc" "existing" { id = data.aws_subnet.existing.vpc_id }
data "aws_security_group" "ecs" { id = var.ecs_security_group_id }
data "aws_route_table" "existing" { subnet_id = var.public_subnet_id }
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_security_group" "proxy" {
  name        = local.name
  description = "Private Mobishastra CONNECT proxy; no public ingress or SSH"
  vpc_id      = data.aws_vpc.existing.id
  lifecycle {
    precondition {
      condition     = data.aws_security_group.ecs.vpc_id == data.aws_vpc.existing.id
      error_message = "The ECS security group and proxy subnet must share the same VPC."
    }
    precondition {
      condition     = anytrue([for r in data.aws_route_table.existing.routes : r.cidr_block == "0.0.0.0/0" && startswith(coalesce(r.gateway_id, "none"), "igw-")])
      error_message = "A pre-existing Internet Gateway default route is required. No routes will be changed."
    }
  }
}
resource "aws_vpc_security_group_ingress_rule" "ecs_to_proxy" {
  security_group_id            = aws_security_group.proxy.id
  referenced_security_group_id = var.ecs_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
  description                  = "CONNECT from backend tasks only"
}
# The only change to an existing resource: one additive, independently owned rule.
resource "aws_vpc_security_group_egress_rule" "ecs_to_proxy" {
  security_group_id            = var.ecs_security_group_id
  referenced_security_group_id = aws_security_group.proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 3128
  to_port                      = 3128
  description                  = "Dedicated Mobishastra proxy; other ECS egress unchanged"
}
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.proxy.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Mobishastra TLS, SSM, CloudWatch and operating-system updates"
}
resource "aws_vpc_security_group_egress_rule" "apt" {
  security_group_id = aws_security_group.proxy.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "Ubuntu signed package repositories; Squid never allows port 80 tunnels"
}
resource "aws_vpc_security_group_egress_rule" "dns" {
  for_each          = toset(["tcp", "udp"])
  security_group_id = aws_security_group.proxy.id
  cidr_ipv4         = "${cidrhost(data.aws_vpc.existing.cidr_block, 2)}/32"
  ip_protocol       = each.key
  from_port         = 53
  to_port           = 53
}

# Keep both identities independent of the instance: no backend URL/whitelist
# change on a reviewed EC2 replacement. These guards intentionally block destroy.
resource "aws_network_interface" "proxy" {
  subnet_id         = var.public_subnet_id
  security_groups   = [aws_security_group.proxy.id]
  source_dest_check = true # Forward proxy, NOT a NAT/router.
  tags              = { Name = local.name }
  lifecycle { prevent_destroy = true }
}
resource "aws_eip" "proxy" {
  domain = "vpc"
  tags   = { Name = local.name }
  lifecycle { prevent_destroy = true }
}
resource "aws_eip_association" "proxy" {
  allocation_id        = aws_eip.proxy.id
  network_interface_id = aws_network_interface.proxy.id
}

resource "aws_instance" "proxy" {
  ami                         = nonsensitive(data.aws_ssm_parameter.ubuntu.value)
  instance_type               = "t4g.micro"
  iam_instance_profile        = aws_iam_instance_profile.proxy.name
  user_data_replace_on_change = true
  primary_network_interface {
    network_interface_id = aws_network_interface.proxy.id
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true # No OTP, customer data or provider secret on this host.
  }
  credit_specification { cpu_credits = "standard" }
  user_data = "#cloud-config\n${yamlencode({
    package_update = true,
    packages       = ["ansible-core"],
    write_files = concat(
      [{ path = "/opt/zwanga-mobishastra-proxy/config.json", permissions = "0600", content = jsonencode(local.config) }],
      [for name in ["configure.yml", "templates/squid.conf.j2"] : {
        path    = "/opt/zwanga-mobishastra-proxy/ansible/${name}", permissions = "0600", encoding = "gz+b64",
        content = base64gzip(file("${path.module}/ansible/${name}"))
      }],
      [for name in ["health.py", "squid-override.conf", "proxy-health.service", "proxy-health.timer", "squid-logrotate"] : {
        path    = "/opt/zwanga-mobishastra-proxy/ansible/files/${name}", permissions = "0600", encoding = "gz+b64",
        content = base64gzip(file("${path.module}/host/${name}"))
      }]
    ),
    runcmd = [["ansible-playbook", "-i", "localhost,", "-c", "local", "/opt/zwanga-mobishastra-proxy/ansible/configure.yml"]]
  })}"
  tags = { Name = local.name }
  lifecycle {
    ignore_changes = [ami] # Security updates via Ubuntu; AMI refresh requires a planned replacement.
  }
  # EIP must be attached BEFORE cloud-init starts installing packages.
  depends_on = [aws_eip_association.proxy, aws_iam_role_policy.proxy, aws_vpc_security_group_egress_rule.https, aws_vpc_security_group_egress_rule.apt, aws_vpc_security_group_egress_rule.dns]
}

output "mobishastra_whitelist_ipv4" {
  description = "Send this Elastic IP to Mobishastra. Never use it as the backend proxy URL."
  value       = aws_eip.proxy.public_ip
}
output "backend_proxy_url" {
  description = "Set MOBISHASTRA_PROXY_URL to this private endpoint only AFTER proxy readiness and whitelisting."
  value       = "http://${aws_network_interface.proxy.private_ip}:3128"
}
output "instance_id" { value = aws_instance.proxy.id }
output "elastic_ip_allocation_id" { value = aws_eip.proxy.id }
