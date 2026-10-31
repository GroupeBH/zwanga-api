resource "aws_iam_role" "proxy" {
  name = "ZwangaMobishastraProxyHostRole"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_instance_profile" "proxy" {
  name = "ZwangaMobishastraProxyHostProfile"
  role = aws_iam_role.proxy.name
}
resource "aws_iam_role_policy" "proxy" {
  role = aws_iam_role.proxy.id
  # Reuse the staging principle: SSM channels only, NOT GetParameters '*'.
  # The proxy cannot read production secrets, data buckets, RDS or Redis.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Resource = "*", Action = [
      "ssm:UpdateInstanceInformation",
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
      "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage",
      "ec2messages:FailMessage", "ec2messages:GetEndpoint",
      "ec2messages:GetMessages", "ec2messages:SendReply"
    ] },
    { Effect    = "Allow", Resource = "*", Action = ["cloudwatch:PutMetricData"],
      Condition = { StringEquals = { "cloudwatch:namespace" = "Zwanga/MobishastraProxy" } }
    }
  ] })
}

resource "aws_cloudwatch_metric_alarm" "proxy_health" {
  alarm_name          = "${local.name}-unavailable"
  alarm_description   = "Local Squid refusal probe failed or heartbeat missing; does not prove provider SMS availability."
  namespace           = "Zwanga/MobishastraProxy"
  metric_name         = "ProxyHealthy"
  dimensions          = { Component = "mobishastra-proxy" }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "host_status" {
  alarm_name          = "${local.name}-ec2-status"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.proxy.id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "host_cpu" {
  alarm_name          = "${local.name}-cpu-high"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.proxy.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 70
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
