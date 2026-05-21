resource "aws_security_group" "app" {
  name_prefix            = "${local.name_prefix}-app-"
  description            = "Public HTTP/HTTPS and restricted SSH access for ${local.name_prefix}"
  vpc_id                 = aws_vpc.main.id
  revoke_rules_on_delete = true

  tags = {
    Name = "${local.name_prefix}-app-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = toset(var.allowed_http_cidr_blocks)

  security_group_id = aws_security_group.app.id
  description       = "HTTP from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.allowed_https_cidr_blocks)

  security_group_id = aws_security_group.app.id
  description       = "HTTPS from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(local.allowed_ssh_cidrs)

  security_group_id = aws_security_group.app.id
  description       = "SSH from ${each.value}"
  cidr_ipv4         = each.value
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "private_app_mesh" {
  security_group_id            = aws_security_group.app.id
  description                  = "Private app traffic between cluster nodes"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.app_port
  ip_protocol                  = "tcp"
  to_port                      = var.app_port
}

resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound IPv4"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${local.instance_name}/app"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "caddy" {
  name              = "/${local.instance_name}/caddy"
  retention_in_days = var.log_retention_days
}

resource "aws_sns_topic" "ops" {
  count = length(var.alarm_email_endpoints) > 0 ? 1 : 0

  name = "${local.instance_name}-ops-alerts"
}

resource "aws_sns_topic_subscription" "ops_email" {
  for_each = toset(var.alarm_email_endpoints)

  topic_arn = aws_sns_topic.ops[0].arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "system_status_check_failed" {
  for_each = local.monitored_instances

  alarm_name          = "${local.instance_name}-${each.key}-system-status-check-failed"
  alarm_description   = "Triggers EC2 recovery when the AWS system status check fails for the ${each.key} node."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed_System"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = each.value.id
  }

  alarm_actions = concat(
    ["arn:aws:automate:${var.aws_region}:ec2:recover"],
    length(var.alarm_email_endpoints) > 0 ? [aws_sns_topic.ops[0].arn] : []
  )
  ok_actions = length(var.alarm_email_endpoints) > 0 ? [aws_sns_topic.ops[0].arn] : []
}

resource "aws_cloudwatch_metric_alarm" "instance_status_check_failed" {
  for_each = local.monitored_instances

  alarm_name          = "${local.instance_name}-${each.key}-instance-status-check-failed"
  alarm_description   = "Alerts when the OS/guest status check fails for the ${each.key} node."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "StatusCheckFailed_Instance"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = each.value.id
  }

  alarm_actions = length(var.alarm_email_endpoints) > 0 ? [aws_sns_topic.ops[0].arn] : []
  ok_actions    = length(var.alarm_email_endpoints) > 0 ? [aws_sns_topic.ops[0].arn] : []
}

resource "aws_ssm_parameter" "secure_params" {
  for_each = local.ssm_secure_parameter_names

  name      = "/${local.instance_name}/${each.value}"
  type      = "SecureString"
  value     = var.ssm_secure_parameters[each.value]
  overwrite = true
  tier      = "Standard"

  tags = {
    Name = "${local.instance_name}-${each.value}"
  }
}
