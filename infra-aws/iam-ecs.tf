data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.name_prefix}-ECSTaskExecutionRole"
  description        = "Pulls ECR images, writes logs and resolves SSM secrets for ${local.ecs_service_name}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid    = "ReadRuntimeParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = local.runtime_parameter_arns
  }

  statement {
    sid       = "DecryptRuntimeParameters"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.application.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "${local.name_prefix}-execution-secrets"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name_prefix}-ECSTaskRole"
  description        = "Runtime AWS permissions for ${local.ecs_service_name}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

data "aws_iam_policy_document" "ecs_runtime_aws_services" {
  count = var.application_s3_bucket_name != null || var.enable_rekognition_permissions ? 1 : 0

  dynamic "statement" {
    for_each = var.application_s3_bucket_name == null ? [] : [var.application_s3_bucket_name]

    content {
      sid    = "UseApplicationUploadBucket"
      effect = "Allow"
      actions = [
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject",
      ]
      resources = ["arn:${data.aws_partition.current.partition}:s3:::${statement.value}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_rekognition_permissions ? [1] : []

    content {
      sid    = "UseRekognitionForKycAndModeration"
      effect = "Allow"
      actions = [
        "rekognition:CompareFaces",
        "rekognition:DetectFaces",
        "rekognition:DetectModerationLabels",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "ecs_runtime_aws_services" {
  count = var.application_s3_bucket_name != null || var.enable_rekognition_permissions ? 1 : 0

  name   = "${local.name_prefix}-runtime-aws-services"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_runtime_aws_services[0].json
}

data "aws_iam_policy_document" "ecs_exec" {
  count = var.enable_ecs_execute_command ? 1 : 0

  statement {
    sid    = "AllowECSExecChannels"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_exec" {
  count = var.enable_ecs_execute_command ? 1 : 0

  name   = "${local.name_prefix}-ecs-exec"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_exec[0].json
}
