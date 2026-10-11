output "api_url" { value = "https://${local.domain}" }
output "instance_id" { value = aws_instance.staging.id }
output "integration_parameter" { value = local.parameter }
output "artifacts_bucket" { value = aws_s3_bucket.storage["artifacts"].id }
output "github_repository_variables" {
  value = {
    STAGING_AWS_REGION   = local.region
    STAGING_AWS_ROLE_ARN = aws_iam_role.github.arn
    STAGING_INSTANCE_ID  = aws_instance.staging.id
  }
}
