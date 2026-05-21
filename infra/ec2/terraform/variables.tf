variable "project_name" {
  description = "Project name used in AWS resource names and tags."
  type        = string
  default     = "zwanga"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "instance_name" {
  description = "Name prefix for AWS resources, compatible with zwanga-infra."
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "AWS region where resources are created."
  type        = string
  default     = "eu-central-1"
}

variable "availability_zone" {
  description = "Optional primary AZ override. Leave empty to auto-pick the first available AZ."
  type        = string
  default     = ""
}

variable "secondary_availability_zone" {
  description = "Optional secondary AZ override. Leave empty to auto-pick another AZ when available."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the primary public subnet."
  type        = string
  default     = "10.42.1.0/24"
}

variable "secondary_public_subnet_cidr" {
  description = "CIDR block for the secondary public subnet."
  type        = string
  default     = "10.42.2.0/24"
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.micro"
}

variable "ami_id" {
  description = "Optional AMI override. Leave empty to use latest Ubuntu 22.04 LTS amd64."
  type        = string
  default     = ""
}

variable "secondary_instance_enabled" {
  description = "When true, provisions a second EC2 node for the low-cost failover/load-balancing topology."
  type        = bool
  default     = true
}

variable "key_name" {
  description = "Existing EC2 key pair name. Preferred when reusing the already deployed zwanga-infra style."
  type        = string
  default     = null
}

variable "existing_key_name" {
  description = "Backward-compatible alias for key_name."
  type        = string
  default     = null
}

variable "ssh_public_key" {
  description = "Public SSH key material used to create an EC2 key pair."
  type        = string
  default     = null
  sensitive   = true
}

variable "ssh_public_key_path" {
  description = "Path to a local public SSH key used to create an EC2 key pair."
  type        = string
  default     = null
}

variable "ansible_ssh_private_key_file" {
  description = "Optional private key path to embed in the generated Ansible inventory."
  type        = string
  default     = null
}

variable "admin_cidr" {
  description = "Single admin public IP in /32 CIDR format for SSH. Kept compatible with zwanga-infra."
  type        = string
  default     = null
}

variable "allowed_ssh_cidr_blocks" {
  description = "CIDR blocks allowed to reach SSH. Use your own public IP with /32."
  type        = list(string)
  default     = []
}

variable "allowed_http_cidr_blocks" {
  description = "CIDR blocks allowed to reach HTTP."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_https_cidr_blocks" {
  description = "CIDR blocks allowed to reach HTTPS."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GiB."
  type        = number
  default     = 30
}

variable "allocate_elastic_ip" {
  description = "Allocate and associate an Elastic IP for stable DNS."
  type        = bool
  default     = true
}

variable "enable_detailed_monitoring" {
  description = "Enable EC2 detailed monitoring. This improves metrics granularity but adds cost."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Public API domain used by Caddy and outputs."
  type        = string
  default     = ""
}

variable "caddy_email" {
  description = "Optional email address used by Caddy for ACME/Let's Encrypt."
  type        = string
  default     = ""
}

variable "app_image_repository" {
  description = "Docker Hub repository for the Zwanga backend image, for example gbhsarl/zwanga-backend."
  type        = string
  default     = ""
}

variable "app_image_tag" {
  description = "Docker image tag deployed by Ansible."
  type        = string
  default     = "latest"
}

variable "app_port" {
  description = "Internal NestJS HTTP port."
  type        = number
  default     = 5200
}

variable "app_healthcheck_path" {
  description = "Public health path used in outputs."
  type        = string
  default     = "/api/v1/health"

  validation {
    condition     = startswith(var.app_healthcheck_path, "/")
    error_message = "app_healthcheck_path must start with '/'."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention period in days."
  type        = number
  default     = 14
}

variable "alarm_email_endpoints" {
  description = "Optional email recipients subscribed to CloudWatch/SNS alerts for EC2 failures."
  type        = list(string)
  default     = []
}

variable "ssm_secure_parameters" {
  description = "Optional SecureString SSM parameters to create, keyed by short name."
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "extra_tags" {
  description = "Extra AWS tags to add to all resources."
  type        = map(string)
  default     = {}
}
