output "state_bucket_name" {
  description = "Copy this value to ../backend.hcl."
  value       = aws_s3_bucket.terraform_state.id
}

output "state_bucket_region" {
  description = "Region to use in ../backend.hcl."
  value       = var.aws_region
}
