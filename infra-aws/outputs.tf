output "aws_region" {
  description = "Value for the GitHub AWS_REGION repository variable."
  value       = var.aws_region
}

output "vpc_id" {
  description = "Application VPC ID."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs used by RDS and Redis."
  value       = aws_subnet.private[*].id
}

output "ecs_public_subnet_ids" {
  description = "Public subnet IDs used by ECS Fargate tasks with assign_public_ip=true."
  value       = aws_subnet.public[*].id
}

output "ecr_repository_name" {
  description = "Value for the GitHub ECR_REPOSITORY repository variable."
  value       = aws_ecr_repository.backend.name
}

output "ecr_repository_url" {
  description = "Private ECR repository URL used for the initial image push."
  value       = aws_ecr_repository.backend.repository_url
}

output "github_actions_role_arn" {
  description = "Value for the GitHub AWS_ROLE_ARN repository variable."
  value       = aws_iam_role.github_actions.arn
}

output "ecs_cluster_name" {
  description = "Value for the GitHub ECS_CLUSTER repository variable."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Value for the GitHub ECS_SERVICE repository variable."
  value       = aws_ecs_service.backend.name
}

output "alb_dns_name" {
  description = "Public DNS name of the Application Load Balancer."
  value       = aws_lb.backend.dns_name
}

output "alb_url" {
  description = "Public HTTP URL of the Application Load Balancer. Use HTTPS after setting alb_certificate_arn."
  value       = var.alb_certificate_arn == null ? "http://${aws_lb.backend.dns_name}" : "https://${aws_lb.backend.dns_name}"
}

output "runtime_parameter_names" {
  description = "SecureString parameters injected into ECS Fargate. Values remain secret."
  value = merge(
    {
      DATABASE_URL       = aws_ssm_parameter.database_url.name
      REDIS_URL          = aws_ssm_parameter.redis_url.name
      REDIS_TLS          = aws_ssm_parameter.redis_tls.name
      JWT_SECRET         = aws_ssm_parameter.jwt_secret.name
      JWT_REFRESH_SECRET = aws_ssm_parameter.jwt_refresh_secret.name
    },
    {
      for name in sort(keys(aws_ssm_parameter.ecs_environment)) :
      name => aws_ssm_parameter.ecs_environment[name].name
    },
    var.application_s3_bucket_name == null ? {} : {
      AWS_S3_BUCKET_NAME = "${local.ssm_prefix}/env/AWS_S3_BUCKET_NAME"
    },
    local.external_runtime_environment_parameter_names_by_env,
    var.enable_xray_tracing ? {
      AOT_CONFIG_CONTENT = aws_ssm_parameter.otel_collector_config[0].name
    } : {},
  )
}

output "cloudwatch_dashboard_name" {
  description = "Central operations dashboard name."
  value       = aws_cloudwatch_dashboard.operations.dashboard_name
}

output "cloudwatch_dashboard_url" {
  description = "Direct URL to the central CloudWatch operations dashboard."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.operations.dashboard_name}"
}

output "alerts_topic_arn" {
  description = "SNS topic receiving operational, deployment and security alarms."
  value       = aws_sns_topic.alerts.arn
}

output "cloudtrail_arn" {
  description = "Multi-region audit trail ARN."
  value       = aws_cloudtrail.main.arn
}

output "cloudtrail_log_bucket" {
  description = "Dedicated encrypted S3 bucket containing validated CloudTrail audit files."
  value       = aws_s3_bucket.cloudtrail.id
}

output "xray_sampling_rule_names" {
  description = "X-Ray sampling rules created for ECS tracing."
  value = var.enable_xray_tracing ? {
    health_checks = aws_xray_sampling_rule.health_checks[0].rule_name
    application   = aws_xray_sampling_rule.application[0].rule_name
  } : {}
}

output "observability_log_groups" {
  description = "CloudWatch Logs groups and prefix managed by the observability layer."
  value = {
    cloudtrail     = aws_cloudwatch_log_group.cloudtrail.name
    rds_postgresql = aws_cloudwatch_log_group.rds_postgresql.name
    rds_upgrade    = aws_cloudwatch_log_group.rds_upgrade.name
    redis_slow     = aws_cloudwatch_log_group.redis_slow.name
    redis_engine   = aws_cloudwatch_log_group.redis_engine.name
    ecs_app        = aws_cloudwatch_log_group.ecs_app.name
    ecs_otel       = try(aws_cloudwatch_log_group.ecs_otel[0].name, null)
  }
}
