variable "aws_region" {
  description = "AWS region of the Terraform state bucket."
  type        = string
  default     = "eu-west-1"
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for Terraform state."
  type        = string
}

variable "project_name" {
  description = "Project tag applied to the state bucket."
  type        = string
  default     = "zwanga"
}
