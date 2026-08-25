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

resource "aws_ssm_parameter" "redis_tls" {
  name        = "${local.ssm_prefix}/REDIS_TLS"
  description = "Enables TLS for Redis and Socket.IO adapter clients"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = "true"
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

data "aws_ssm_parameters_by_path" "external_runtime_environment" {
  # Application secrets imported from a local .env file live under this path.
  # We only use their names/ARNs to inject them into ECS. Values are not
  # decrypted into Terraform state.
  path            = "${local.ssm_prefix}/env"
  recursive       = false
  with_decryption = false
}

locals {
  generated_secret_parameter_arns_by_env = {
    DATABASE_URL       = aws_ssm_parameter.database_url.arn
    REDIS_URL          = aws_ssm_parameter.redis_url.arn
    REDIS_TLS          = aws_ssm_parameter.redis_tls.arn
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

  otel_environment_parameter_arns_by_env = var.enable_xray_tracing ? {
    AOT_CONFIG_CONTENT = aws_ssm_parameter.otel_collector_config[0].arn
  } : {}

  reserved_runtime_environment_variable_names = toset(concat(
    # AWS_S3_BUCKET_NAME is always Terraform-owned. Keep it reserved even when
    # application_s3_bucket_name is null so a parameter scheduled for deletion
    # cannot be rediscovered as an external secret in the same plan.
    ["AWS_S3_BUCKET_NAME"],
    keys(local.generated_secret_parameter_arns_by_env),
    keys(local.ecs_environment_parameter_arns_by_env),
    keys(local.generated_runtime_environment_parameter_arns_by_env),
    keys(local.otel_environment_parameter_arns_by_env),
  ))

  discovered_external_runtime_environment_parameter_arns_by_env = {
    for name, arn in zipmap(
      data.aws_ssm_parameters_by_path.external_runtime_environment.names,
      data.aws_ssm_parameters_by_path.external_runtime_environment.arns,
    ) :
    trimprefix(name, "${local.ssm_prefix}/env/") => arn
    if startswith(name, "${local.ssm_prefix}/env/")
    && can(regex("^[A-Za-z_][A-Za-z0-9_]*$", trimprefix(name, "${local.ssm_prefix}/env/")))
    && !contains(local.reserved_runtime_environment_variable_names, trimprefix(name, "${local.ssm_prefix}/env/"))
  }

  manual_external_runtime_environment_parameter_arns_by_env = {
    for name in sort(tolist(var.external_runtime_environment_variable_names)) :
    name => "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/env/${name}"
  }

  external_runtime_environment_parameter_arns_by_env = merge(
    local.discovered_external_runtime_environment_parameter_arns_by_env,
    local.manual_external_runtime_environment_parameter_arns_by_env,
  )

  external_runtime_environment_parameter_names_by_env = {
    for name in sort(keys(local.external_runtime_environment_parameter_arns_by_env)) :
    name => "${local.ssm_prefix}/env/${name}"
  }

  runtime_parameter_arns = concat(
    values(local.generated_secret_parameter_arns_by_env),
    values(local.ecs_environment_parameter_arns_by_env),
    values(local.generated_runtime_environment_parameter_arns_by_env),
    values(local.external_runtime_environment_parameter_arns_by_env),
    values(local.otel_environment_parameter_arns_by_env),
    [local.database_import_source_url_parameter_arn],
  )
}
