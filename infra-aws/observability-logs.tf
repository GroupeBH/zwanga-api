# -----------------------------------------------------------------------------
# Managed service logs
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ecs_app" {
  name              = local.ecs_app_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "ECS Fargate"
    LogType = "application"
  }
}

resource "aws_cloudwatch_log_group" "ecs_otel" {
  count = var.enable_xray_tracing ? 1 : 0

  name              = local.ecs_otel_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "ECS Fargate"
    LogType = "otel-collector"
  }
}

resource "aws_cloudwatch_log_group" "rds_postgresql" {
  name              = local.rds_postgresql_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "RDS PostgreSQL"
  }
}

resource "aws_cloudwatch_log_group" "rds_upgrade" {
  name              = local.rds_upgrade_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "RDS PostgreSQL"
  }
}

resource "aws_cloudwatch_log_group" "redis_slow" {
  name              = local.redis_slow_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "ElastiCache Redis"
    LogType = "slow-log"
  }
}

resource "aws_cloudwatch_log_group" "redis_engine" {
  name              = local.redis_engine_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Service = "ElastiCache Redis"
    LogType = "engine-log"
  }
}

# RDS Enhanced Monitoring publishes operating-system metrics to CloudWatch Logs.
data "aws_iam_policy_document" "rds_enhanced_monitoring_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_enhanced_monitoring" {
  name               = "${local.name_prefix}-RDSEnhancedMonitoringRole"
  assume_role_policy = data.aws_iam_policy_document.rds_enhanced_monitoring_assume_role.json
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  role       = aws_iam_role.rds_enhanced_monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
