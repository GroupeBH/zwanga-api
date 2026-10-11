resource "aws_iam_role" "host" {
  name = "ZwangaStagingHostRole"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_instance_profile" "host" {
  name = "ZwangaStagingHostProfile"
  role = aws_iam_role.host.name
}
resource "aws_iam_policy" "ssm" {
  name = "ZwangaStagingSsmAgent"
  # Do not attach AmazonSSMManagedInstanceCore: its GetParameters '*' would
  # let the host read parameters outside staging.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Resource = "*", Action = [
      "ssm:UpdateInstanceInformation", "ssm:UpdateInstanceAssociationStatus",
      "ssm:ListInstanceAssociations", "ssm:DescribeAssociation", "ssm:ListAssociations",
      "ssm:PutInventory", "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult",
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
      "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage",
      "ec2messages:FailMessage", "ec2messages:GetEndpoint",
      "ec2messages:GetMessages", "ec2messages:SendReply"
    ]
  }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = aws_iam_policy.ssm.arn
}
resource "aws_iam_role_policy" "host" {
  role = aws_iam_role.host.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = [for r in aws_ecr_repository.images : r.arn] },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.integrations.arn },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.storage["artifacts"].arn}/*"] },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.storage["media"].arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.storage["media"].arn}/*" }
  ] })
}

resource "aws_iam_role" "controller" {
  name = "ZwangaStagingControllerRole"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "controller" {
  role = aws_iam_role.controller.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ec2:DescribeInstances"], Resource = "*" },
    { Effect = "Allow", Action = ["ec2:StartInstances", "ec2:StopInstances"], Resource = aws_instance.staging.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.controller.arn}:*" },
    { Effect = "Allow", Action = ["route53:ChangeResourceRecordSets"], Resource = "arn:aws:route53:::hostedzone/${local.zone}",
      Condition = { "ForAllValues:StringEquals" = {
        "route53:ChangeResourceRecordSetsNormalizedRecordNames" = [local.domain],
        "route53:ChangeResourceRecordSetsRecordTypes"           = ["A"],
        "route53:ChangeResourceRecordSetsActions"               = ["UPSERT"]
      } }
    }
  ] })
}

resource "aws_iam_role" "github" {
  name = "ZwangaStagingGitHubActionsRole"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
    Principal = { Federated = "arn:aws:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com" },
    Condition = { StringEquals = {
      "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub" = "repo:GroupeBH/zwanga-api:ref:refs/heads/staging"
    } }
  }] })
}
resource "aws_iam_role_policy" "github" {
  role = aws_iam_role.github.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:DescribeImages", "ecr:ListImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = [for r in aws_ecr_repository.images : r.arn] },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${aws_s3_bucket.storage["artifacts"].arn}/releases/*" },
    { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.controller.arn },
    { Effect = "Allow", Action = ["ssm:SendCommand"], Resource = [aws_ssm_document.runtime.arn, aws_instance.staging.arn] },
    { Effect = "Allow", Action = ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"], Resource = "*" }
  ] })
}
