locals {
  name_prefix = "${var.project_name}-${var.environment}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  ssm_prefix  = "/${var.project_name}/${var.environment}"

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      Repository  = "${var.github_owner}/${var.github_repository}"
    },
    var.extra_tags,
  )

  ecs_cluster_name    = "${local.name_prefix}-cluster"
  ecs_service_name    = "${local.name_prefix}-api"
  ecs_task_family     = "${local.name_prefix}-api"
  ecs_cluster_arn     = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster/${local.ecs_cluster_name}"
  ecs_service_arn     = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.ecs_cluster_name}/${local.ecs_service_name}"
  ecs_task_arn_pattern = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${local.ecs_cluster_name}/*"
  ecs_task_definition_arn_pattern = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.ecs_task_family}:*"
  app_container_name  = "api"
  otel_container_name = "aws-otel-collector"

  cloudtrail_name        = "${local.name_prefix}-audit"
  cloudtrail_arn         = "arn:${data.aws_partition.current.partition}:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_name}"
  cloudtrail_bucket_name = "${local.name_prefix}-cloudtrail-${data.aws_caller_identity.current.account_id}"
  dashboard_name         = "${local.name_prefix}-operations"

  rds_postgresql_log_group_name = "/aws/rds/instance/${local.name_prefix}-postgres/postgresql"
  rds_upgrade_log_group_name    = "/aws/rds/instance/${local.name_prefix}-postgres/upgrade"
  redis_slow_log_group_name     = "/aws/elasticache/${local.name_prefix}-redis/slow-log"
  redis_engine_log_group_name   = "/aws/elasticache/${local.name_prefix}-redis/engine-log"
  ecs_app_log_group_name        = "/ecs/${local.name_prefix}/api"
  ecs_otel_log_group_name       = "/ecs/${local.name_prefix}/aws-otel-collector"

  # AWS X-Ray sampling rule names are limited to 32 characters.
  # Keep a short, predictable prefix so production names like
  # "zwanga-api-production-application" do not fail at plan/apply time.
  environment_code = lookup(
    {
      production  = "prod"
      staging     = "stg"
      development = "dev"
    },
    var.environment,
    substr(var.environment, 0, 4),
  )
  xray_rule_prefix           = substr("${var.project_name}-${local.environment_code}", 0, 20)
  xray_health_rule_name      = "${local.xray_rule_prefix}-health"
  xray_application_rule_name = "${local.xray_rule_prefix}-app"
  github_oidc_provider_arn   = coalesce(var.github_oidc_provider_arn, one(aws_iam_openid_connect_provider.github[*].arn))
}
