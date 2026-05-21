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

variable "aws_region" {
  description = "AWS region where Lightsail resources are created."
  type        = string
  default     = "eu-central-1"
}

variable "availability_zone" {
  description = "Optional Lightsail availability zone override. Leave empty to auto-pick the first available AZ."
  type        = string
  default     = ""
}

variable "instance_name" {
  description = "Lightsail instance name. Leave empty to use zwanga-api for prod."
  type        = string
  default     = ""
}

variable "blueprint_id" {
  description = "Lightsail blueprint ID."
  type        = string
  default     = "ubuntu_22_04"
}

variable "bundle_id" {
  description = "Lightsail bundle ID. small_3_0 is the default public-IPv4 bundle chosen for the current 15 USD/month budget."
  type        = string
  default     = "small_3_0"
}

variable "ip_address_type" {
  description = "Lightsail IP address type. Keep ipv4 for a simple public IPv4 deployment with a static IP."
  type        = string
  default     = "ipv4"

  validation {
    condition     = contains(["ipv4", "dualstack"], var.ip_address_type)
    error_message = "ip_address_type must be ipv4 or dualstack."
  }
}

variable "monthly_budget_usd" {
  description = "Target monthly infrastructure budget, excluding taxes and external services."
  type        = number
  default     = 15
}

variable "estimated_monthly_usd" {
  description = "Estimated monthly Lightsail instance cost used as a budget guardrail."
  type        = number
  default     = 12
}

variable "attach_static_ip" {
  description = "Attach a Lightsail static IP for stable DNS. Attached static IPs are intended to stay with the instance."
  type        = bool
  default     = true
}

variable "key_pair_name" {
  description = "Existing Lightsail key pair name. Leave empty to use the regional Lightsail default key pair, or when providing ssh_public_key."
  type        = string
  default     = null
}

variable "ssh_public_key" {
  description = "Optional public SSH key material used to create a dedicated Lightsail key pair. Leave empty to use the regional Lightsail default key pair."
  type        = string
  default     = null
  sensitive   = true
}

variable "ssh_public_key_path" {
  description = "Path to a local public SSH key used to create a Lightsail key pair."
  type        = string
  default     = null
}

variable "ansible_ssh_private_key_file" {
  description = "Optional private key path to embed in the generated Ansible inventory."
  type        = string
  default     = null
}

variable "admin_cidr" {
  description = "Single admin public IP in /32 CIDR format for SSH."
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

variable "extra_tags" {
  description = "Extra AWS tags to add to all resources."
  type        = map(string)
  default     = {}
}
