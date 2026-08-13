resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "random_password" "jwt_refresh_secret" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "database_url" {
  name        = "${local.ssm_prefix}/DATABASE_URL"
  description = "PostgreSQL connection URL consumed by ECS Fargate"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = "postgresql://${var.database_username}:${random_password.database.result}@${aws_db_instance.postgres.address}:${aws_db_instance.postgres.port}/${var.database_name}?sslmode=require"
}

resource "aws_ssm_parameter" "redis_url" {
  name        = "${local.ssm_prefix}/REDIS_URL"
  description = "TLS Redis connection URL consumed by ECS Fargate"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}

resource "aws_ssm_parameter" "jwt_secret" {
  name        = "${local.ssm_prefix}/JWT_SECRET"
  description = "JWT signing secret consumed by ECS Fargate"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = random_password.jwt_secret.result
}

resource "aws_ssm_parameter" "jwt_refresh_secret" {
  name        = "${local.ssm_prefix}/JWT_REFRESH_SECRET"
  description = "Refresh token signing secret consumed by ECS Fargate"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = random_password.jwt_refresh_secret.result
}

resource "aws_ssm_parameter" "ecs_environment" {
  for_each = local.ecs_base_environment

  name        = "${local.ssm_prefix}/env/${each.key}"
  description = "ECS runtime environment variable ${each.key}"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = each.value
}

resource "aws_ssm_parameter" "application_s3_bucket_name" {
  count = var.application_s3_bucket_name == null ? 0 : 1

  name        = "${local.ssm_prefix}/env/AWS_S3_BUCKET_NAME"
  description = "S3 bucket used by the backend for uploads"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = var.application_s3_bucket_name
}

resource "aws_ssm_parameter" "otel_collector_config" {
  count = var.enable_xray_tracing ? 1 : 0

  name        = "${local.ssm_prefix}/env/AOT_CONFIG_CONTENT"
  description = "ADOT collector configuration injected into the tracing sidecar"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = local.ecs_otel_collector_config
}

locals {
  generated_secret_parameter_arns_by_env = {
    DATABASE_URL       = aws_ssm_parameter.database_url.arn
    REDIS_URL          = aws_ssm_parameter.redis_url.arn
    JWT_SECRET         = aws_ssm_parameter.jwt_secret.arn
    JWT_REFRESH_SECRET = aws_ssm_parameter.jwt_refresh_secret.arn
  }

  ecs_environment_parameter_arns_by_env = {
    for name in sort(keys(aws_ssm_parameter.ecs_environment)) :
    name => aws_ssm_parameter.ecs_environment[name].arn
  }

  generated_runtime_environment_parameter_arns_by_env = var.application_s3_bucket_name == null ? {} : {
    AWS_S3_BUCKET_NAME = aws_ssm_parameter.application_s3_bucket_name[0].arn
  }

  external_runtime_environment_parameter_arns_by_env = {
    for name in sort(tolist(var.external_runtime_environment_variable_names)) :
    name => "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/env/${name}"
  }

  otel_environment_parameter_arns_by_env = var.enable_xray_tracing ? {
    AOT_CONFIG_CONTENT = aws_ssm_parameter.otel_collector_config[0].arn
  } : {}

  runtime_parameter_arns = concat(
    values(local.generated_secret_parameter_arns_by_env),
    values(local.ecs_environment_parameter_arns_by_env),
    values(local.generated_runtime_environment_parameter_arns_by_env),
    values(local.external_runtime_environment_parameter_arns_by_env),
    values(local.otel_environment_parameter_arns_by_env),
  )
}
