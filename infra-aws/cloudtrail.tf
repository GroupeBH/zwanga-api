# Dedicated KMS key for audit logs and CloudWatch Logs. The policy grants only
# the AWS services that must encrypt delivery data, plus the account root for
# key administration through IAM.
data "aws_iam_policy_document" "observability_kms" {
  statement {
    sid       = "EnableAccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid    = "AllowCloudTrailEncryption"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid       = "AllowCloudTrailDescribeKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid    = "AllowCloudWatchLogsEncryption"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }

  statement {
    sid    = "AllowMonitoringServicesForEncryptedSNS"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sns.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "observability" {
  description             = "Encryption key for ${local.name_prefix} audit and monitoring logs"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.observability_kms.json

  tags = {
    Name = "${local.name_prefix}-observability-key"
  }
}

resource "aws_kms_alias" "observability" {
  name          = "alias/${local.name_prefix}-observability"
  target_key_id = aws_kms_key.observability.key_id
}

# CloudTrail stores durable, validated audit records in a dedicated bucket.
resource "aws_s3_bucket" "cloudtrail" {
  bucket        = local.cloudtrail_bucket_name
  force_destroy = false

  tags = {
    Name    = local.cloudtrail_bucket_name
    Purpose = "CloudTrail audit logs"
  }
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.observability.arn
      sse_algorithm     = "aws:kms"
    }

  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    id     = "expire-audit-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.cloudtrail_s3_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  depends_on = [aws_s3_bucket_versioning.cloudtrail]
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid       = "AWSCloudTrailAclCheck20150319"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid     = "AWSCloudTrailWrite20150319"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.cloudtrail.arn,
      "${aws_s3_bucket.cloudtrail.arn}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/${local.name_prefix}"
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Purpose = "CloudTrail near-real-time detection"
  }
}

data "aws_iam_policy_document" "cloudtrail_logs_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_logs" {
  name               = "${local.name_prefix}-CloudTrailLogsRole"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_logs_assume_role.json
}

data "aws_iam_policy_document" "cloudtrail_logs" {
  statement {
    sid    = "WriteCloudTrailEvents"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "cloudtrail_logs" {
  name   = "${local.name_prefix}-cloudtrail-cloudwatch"
  role   = aws_iam_role.cloudtrail_logs.id
  policy = data.aws_iam_policy_document.cloudtrail_logs.json
}

resource "aws_cloudtrail" "main" {
  name                          = local.cloudtrail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  kms_key_id                    = aws_kms_key.observability.arn
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  enable_logging                = true

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_logs.arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  dynamic "insight_selector" {
    for_each = var.enable_cloudtrail_insights ? toset(["ApiCallRateInsight", "ApiErrorRateInsight"]) : toset([])

    content {
      insight_type = insight_selector.value
    }
  }

  depends_on = [
    aws_iam_role_policy.cloudtrail_logs,
    aws_s3_bucket_policy.cloudtrail,
  ]

  tags = {
    Name = local.cloudtrail_name
  }
}

# Security detections based on the CloudTrail stream in CloudWatch Logs.
resource "aws_cloudwatch_log_metric_filter" "unauthorized_api_calls" {
  name           = "${local.name_prefix}-unauthorized-api-calls"
  log_group_name = aws_cloudwatch_log_group.cloudtrail.name
  pattern        = "{ ($.errorCode = \"*UnauthorizedOperation\") || ($.errorCode = \"AccessDenied*\") }"

  metric_transformation {
    name      = "UnauthorizedApiCalls"
    namespace = "${var.project_name}/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "root_account_usage" {
  name           = "${local.name_prefix}-root-account-usage"
  log_group_name = aws_cloudwatch_log_group.cloudtrail.name
  pattern        = "{ $.userIdentity.type = \"Root\" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != \"AwsServiceEvent\" }"

  metric_transformation {
    name      = "RootAccountUsage"
    namespace = "${var.project_name}/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "console_login_failure" {
  name           = "${local.name_prefix}-console-login-failure"
  log_group_name = aws_cloudwatch_log_group.cloudtrail.name
  pattern        = "{ $.eventName = \"ConsoleLogin\" && $.responseElements.ConsoleLogin = \"Failure\" }"

  metric_transformation {
    name      = "ConsoleLoginFailures"
    namespace = "${var.project_name}/Security"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "unauthorized_api_calls" {
  alarm_name          = "${local.name_prefix}-security-unauthorized-api-calls"
  alarm_description   = "Unauthorized AWS API calls detected by CloudTrail"
  namespace           = "${var.project_name}/Security"
  metric_name         = "UnauthorizedApiCalls"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "root_account_usage" {
  alarm_name          = "${local.name_prefix}-security-root-account-usage"
  alarm_description   = "AWS root account activity detected by CloudTrail"
  namespace           = "${var.project_name}/Security"
  metric_name         = "RootAccountUsage"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "console_login_failure" {
  alarm_name          = "${local.name_prefix}-security-console-login-failure"
  alarm_description   = "AWS Management Console login failure detected by CloudTrail"
  namespace           = "${var.project_name}/Security"
  metric_name         = "ConsoleLoginFailures"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 1
  period              = 300
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
