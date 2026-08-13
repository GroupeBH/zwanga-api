data "aws_iam_policy_document" "ecs_xray" {
  count = var.enable_xray_tracing ? 1 : 0

  statement {
    sid    = "PublishXRayTraces"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadXRaySamplingConfiguration"
    effect = "Allow"
    actions = [
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:GetSamplingStatisticSummaries",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_xray" {
  count = var.enable_xray_tracing ? 1 : 0

  name   = "${local.name_prefix}-xray-tracing"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_xray[0].json
}

# Health checks are sampled very lightly to avoid noisy traces and unnecessary cost.
resource "aws_xray_sampling_rule" "health_checks" {
  count = var.enable_xray_tracing ? 1 : 0

  rule_name      = "${local.name_prefix}-health"
  priority       = 100
  version        = 1
  reservoir_size = 0
  fixed_rate     = 0.01
  url_path       = var.alb_health_check_path
  host           = "*"
  http_method    = "GET"
  service_name   = local.ecs_service_name
  service_type   = "*"
  resource_arn   = "*"
  attributes     = {}
}

resource "aws_xray_sampling_rule" "application" {
  count = var.enable_xray_tracing ? 1 : 0

  rule_name      = "${local.name_prefix}-application"
  priority       = 1000
  version        = 1
  reservoir_size = 1
  fixed_rate     = var.xray_sampling_rate
  url_path       = "*"
  host           = "*"
  http_method    = "*"
  service_name   = local.ecs_service_name
  service_type   = "*"
  resource_arn   = "*"
  attributes     = {}
}
