# One encrypted notification channel is shared by operational alarms, security
# detections and ECS deployment failures.
resource "aws_sns_topic" "alerts" {
  name              = "${local.name_prefix}-alerts"
  display_name      = "Zwanga AWS alerts"
  kms_master_key_id = aws_kms_key.observability.arn

  tags = {
    Purpose = "Operational and security alerts"
  }
}

resource "aws_sns_topic_subscription" "email" {
  for_each = var.alert_email_addresses

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_event_rule" "ecs_deployment_failures" {
  name        = "${local.name_prefix}-ecs-deployment-failures"
  description = "Capture failed ECS service deployments"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Deployment State Change"]
    account     = [data.aws_caller_identity.current.account_id]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      eventName  = ["SERVICE_DEPLOYMENT_FAILED"]
    }
  })

  tags = {
    Purpose = "ECS deployment failure detection"
  }
}

resource "aws_cloudwatch_event_target" "ecs_deployment_failures" {
  rule      = aws_cloudwatch_event_rule.ecs_deployment_failures.name
  target_id = "SendToSns"
  arn       = aws_sns_topic.alerts.arn
}

data "aws_iam_policy_document" "alerts_sns" {
  statement {
    sid    = "AccountAdministration"
    effect = "Allow"
    actions = [
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:AddPermission",
      "sns:RemovePermission",
      "sns:DeleteTopic",
      "sns:Subscribe",
      "sns:ListSubscriptionsByTopic",
      "sns:Publish",
    ]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowEventBridgePublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.ecs_deployment_failures.arn]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarmsPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:${local.name_prefix}-*"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_sns.json
}

# -----------------------------------------------------------------------------
# ECS Fargate alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_high_cpu" {
  alarm_name        = "${local.name_prefix}-ecs-high-cpu"
  alarm_description = "ECS Fargate service CPU utilization is above the configured threshold"
  namespace         = "AWS/ECS"
  metric_name       = "CPUUtilization"
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.ecs_cpu_alarm_threshold
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_high_memory" {
  alarm_name        = "${local.name_prefix}-ecs-high-memory"
  alarm_description = "ECS Fargate service memory utilization is above the configured threshold"
  namespace         = "AWS/ECS"
  metric_name       = "MemoryUtilization"
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.ecs_memory_alarm_threshold
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# ALB alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name        = "${local.name_prefix}-alb-target-5xx"
  alarm_description = "The API target group returned HTTP 5xx responses"
  namespace         = "AWS/ApplicationELB"
  metric_name       = "HTTPCode_Target_5XX_Count"
  dimensions = {
    LoadBalancer = aws_lb.backend.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alb_5xx_alarm_threshold
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_high_latency" {
  alarm_name        = "${local.name_prefix}-alb-high-latency"
  alarm_description = "Average API target response time is above the configured threshold"
  namespace         = "AWS/ApplicationELB"
  metric_name       = "TargetResponseTime"
  dimensions = {
    LoadBalancer = aws_lb.backend.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.alb_latency_alarm_threshold_seconds
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name        = "${local.name_prefix}-alb-unhealthy-targets"
  alarm_description = "At least one ECS target behind the ALB is unhealthy"
  namespace         = "AWS/ApplicationELB"
  metric_name       = "UnHealthyHostCount"
  dimensions = {
    LoadBalancer = aws_lb.backend.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  period              = 60
  statistic           = "Maximum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# RDS alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_high_cpu" {
  alarm_name          = "${local.name_prefix}-rds-high-cpu"
  alarm_description   = "RDS PostgreSQL CPU utilization is above the configured threshold"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.rds_cpu_alarm_threshold
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_low_storage" {
  alarm_name          = "${local.name_prefix}-rds-low-storage"
  alarm_description   = "RDS PostgreSQL free storage is below the configured threshold"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
  comparison_operator = "LessThanOrEqualToThreshold"
  threshold           = var.rds_free_storage_alarm_threshold_bytes
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Minimum"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# -----------------------------------------------------------------------------
# ElastiCache Redis alarms
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "redis_high_cpu" {
  alarm_name          = "${local.name_prefix}-redis-high-engine-cpu"
  alarm_description   = "Redis engine CPU utilization is above the configured threshold"
  namespace           = "AWS/ElastiCache"
  metric_name         = "EngineCPUUtilization"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.redis.replication_group_id }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.redis_cpu_alarm_threshold
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "redis_high_memory" {
  alarm_name          = "${local.name_prefix}-redis-high-memory"
  alarm_description   = "Redis database memory usage is above the configured threshold"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.redis.replication_group_id }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.redis_memory_alarm_threshold
  evaluation_periods  = var.alarm_evaluation_periods
  datapoints_to_alarm = var.alarm_evaluation_periods
  period              = 300
  statistic           = "Average"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "redis_evictions" {
  alarm_name          = "${local.name_prefix}-redis-evictions"
  alarm_description   = "Redis evicted at least one key during the evaluation period"
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.redis.replication_group_id }
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = local.dashboard_name

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 2
        properties = {
          markdown = "# ${local.name_prefix} - Operations\nECS Fargate, ALB, RDS, Redis, CloudTrail security signals, X-Ray traces and application logs. Alerts: `${aws_sns_topic.alerts.name}`."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 2
        width  = 12
        height = 6
        properties = {
          title  = "ECS Fargate"
          region = var.aws_region
          period = 300
          stat   = "Average"
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.backend.name, { label = "CPU %" }],
            [".", "MemoryUtilization", ".", ".", ".", ".", { label = "Memory %" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 2
        width  = 12
        height = 6
        properties = {
          title  = "Application Load Balancer"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.backend.arn_suffix, { label = "Requests" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", "TargetGroup", aws_lb_target_group.backend.arn_suffix, { label = "Target 5xx" }],
            [".", "TargetResponseTime", ".", ".", "TargetGroup", ".", { label = "Latency s", stat = "Average", yAxis = "right" }],
            [".", "UnHealthyHostCount", ".", ".", "TargetGroup", ".", { label = "Unhealthy targets", stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 8
        width  = 12
        height = 6
        properties = {
          title  = "RDS PostgreSQL"
          region = var.aws_region
          period = 300
          stat   = "Average"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.postgres.identifier, { label = "CPU %" }],
            [".", "DatabaseConnections", ".", ".", { label = "Connections", yAxis = "right" }],
            [".", "FreeStorageSpace", ".", ".", { label = "Free storage", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 8
        width  = 12
        height = 6
        properties = {
          title  = "ElastiCache Redis"
          region = var.aws_region
          period = 300
          stat   = "Average"
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "ReplicationGroupId", aws_elasticache_replication_group.redis.replication_group_id, { label = "Engine CPU %" }],
            [".", "DatabaseMemoryUsagePercentage", ".", ".", { label = "Memory %" }],
            [".", "CurrConnections", ".", ".", { label = "Connections", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 14
        width  = 12
        height = 6
        properties = {
          title  = "CloudTrail security detections"
          region = var.aws_region
          period = 300
          stat   = "Sum"
          metrics = [
            ["${var.project_name}/Security", "UnauthorizedApiCalls", { label = "Unauthorized API calls" }],
            [".", "RootAccountUsage", { label = "Root account usage" }],
            [".", "ConsoleLoginFailures", { label = "Console login failures" }],
          ]
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 14
        width  = 12
        height = 6
        properties = {
          title  = "Recent denied AWS API calls"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.cloudtrail.name}' | fields @timestamp, userIdentity.arn, eventSource, eventName, errorCode | filter ispresent(errorCode) | sort @timestamp desc | limit 50"
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 20
        width  = 24
        height = 6
        properties = {
          title  = "Recent ECS application logs"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.ecs_app.name}' | fields @timestamp, @message | sort @timestamp desc | limit 100"
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 26
        width  = 12
        height = 6
        properties = {
          title  = "PostgreSQL errors"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.rds_postgresql.name}' | fields @timestamp, @message | filter @message like /ERROR|FATAL|PANIC/ | sort @timestamp desc | limit 50"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 26
        width  = 12
        height = 6
        properties = {
          title  = "Redis slow and engine logs"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE logGroups(namePrefix: ['/aws/elasticache/${local.name_prefix}-redis/']) | fields @timestamp, @log, @message | sort @timestamp desc | limit 50"
        }
      },
    ]
  })
}
