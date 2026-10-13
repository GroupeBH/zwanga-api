# Additive and opt-in. IAM and runtime preparation do not activate KYC.
# The existing CI/CD deploys the configuration revision after a native recipe.
variable "enable_aws_kyc_permissions" {
  description = "Prepare Rekognition Liveness, Textract and private evidence permissions. Runtime activation remains separate."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_aws_kyc_permissions || var.application_s3_bucket_name != null
    error_message = "AWS KYC requires the existing private application_s3_bucket_name."
  }
}

variable "aws_kyc_region" {
  description = "Processing region shared by the backend and native Liveness capture (independent of ECS/S3 region)."
  type        = string
  default     = "eu-west-1"
  validation {
    condition     = contains(["eu-west-1", "us-east-1", "us-west-2", "ap-northeast-1", "ap-south-1"], var.aws_kyc_region)
    error_message = "Choose a region supported by this KYC integration."
  }
}

variable "aws_kyc_development_role_arns" {
  description = "Optional exact SAME-ACCOUNT developer role ARNs allowed to assume the capture role for local tests. Their own policies must also allow AssumeRole. Never mobile identities or wildcard principals."
  type        = set(string)
  default     = []
  validation {
    condition = alltrue([for arn in var.aws_kyc_development_role_arns :
      can(regex("^arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "Only explicit developer IAM roles from this AWS account may be trusted."
  }
}

data "aws_iam_policy_document" "kyc_capture_trust" {
  count = var.enable_aws_kyc_permissions ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = concat([aws_iam_role.ecs_task.arn], sort(tolist(var.aws_kyc_development_role_arns)))
    }
  }
}

resource "aws_iam_role" "kyc_capture" {
  count                = var.enable_aws_kyc_permissions ? 1 : 0
  name                 = "${local.name_prefix}-KycCaptureRole"
  description          = "Temporary credentials for native Face Liveness streaming only"
  assume_role_policy   = data.aws_iam_policy_document.kyc_capture_trust[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "kyc_capture" {
  count = var.enable_aws_kyc_permissions ? 1 : 0
  statement {
    sid       = "CaptureOnly"
    actions   = ["rekognition:StartFaceLivenessSession"]
    resources = ["*"] # This action does not support resource-level permissions.
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_kyc_region]
    }
  }
}

resource "aws_iam_role_policy" "kyc_capture" {
  count  = var.enable_aws_kyc_permissions ? 1 : 0
  name   = "native-capture-only"
  role   = aws_iam_role.kyc_capture[0].id
  policy = data.aws_iam_policy_document.kyc_capture[0].json
}

data "aws_iam_policy_document" "kyc_backend" {
  count = var.enable_aws_kyc_permissions ? 1 : 0
  statement {
    sid = "VerifyIdentityServerSide"
    actions = [
      "rekognition:CreateFaceLivenessSession", "rekognition:GetFaceLivenessSessionResults",
      "rekognition:DetectFaces", "rekognition:CompareFaces", "textract:DetectDocumentText",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_kyc_region]
    }
  }
  statement {
    sid       = "IssueTemporaryCaptureCredentials"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.kyc_capture[0].arn]
  }
  statement {
    sid       = "PrivateEvidenceObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.application_s3_bucket_name}/kyc/evidence/*"]
  }
  statement {
    sid       = "EvidenceVersionErasure"
    actions   = ["s3:ListBucketVersions"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.application_s3_bucket_name}"]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["kyc/evidence/*"]
    }
  }
}

resource "aws_iam_role_policy" "kyc_backend" {
  count  = var.enable_aws_kyc_permissions ? 1 : 0
  name   = "${local.name_prefix}-aws-kyc"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.kyc_backend[0].json
}

output "aws_kyc_runtime_configuration" {
  description = "Non-secret configuration guide. KYC_PROVIDER and AWS_S3_PUBLIC_BUCKET stay operator-owned; verify storage and device tests before activation."
  value = var.enable_aws_kyc_permissions ? {
    AWS_KYC_REGION            = var.aws_kyc_region
    AWS_KYC_LIVENESS_ROLE_ARN = aws_iam_role.kyc_capture[0].arn
    AWS_S3_PUBLIC_BUCKET      = "false"
    AWS_KYC_ENABLED           = tostring(var.aws_kyc_enabled)
    KYC_PROVIDER              = "aws"
  } : {}
}

variable "manage_aws_kyc_runtime_configuration" {
  description = "Create the AWS_KYC_* SSM parameters and ECS references after preparing IAM. Existing external parameters must be imported first."
  type        = bool
  default     = false
  validation {
    condition     = !var.manage_aws_kyc_runtime_configuration || var.enable_aws_kyc_permissions
    error_message = "Prepare AWS KYC IAM before managing its runtime configuration."
  }
}

variable "aws_kyc_enabled" {
  description = "Activate new AWS captures and the worker only after native device tests. Preparing IAM/SSM alone must not create paid sessions."
  type        = bool
  default     = false
  validation {
    condition     = !var.aws_kyc_enabled || (var.enable_aws_kyc_permissions && var.manage_aws_kyc_runtime_configuration)
    error_message = "AWS KYC activation requires managed configuration and prepared IAM."
  }
}

variable "aws_kyc_limits" {
  description = "Attempt quotas and server-owned confidence thresholds; not a guaranteed invoice cap."
  type = object({
    daily              = number, monthly = number, per_user = number,
    liveness_threshold = number, face_threshold = number
  })
  default = { daily = 100, monthly = 1000, per_user = 3, liveness_threshold = 95, face_threshold = 95 }
  validation {
    condition = (alltrue([for value in values(var.aws_kyc_limits) : value == floor(value)]) &&
      var.aws_kyc_limits.daily >= 1 && var.aws_kyc_limits.daily <= 10000 &&
      var.aws_kyc_limits.monthly >= 1 && var.aws_kyc_limits.monthly <= 100000 &&
      var.aws_kyc_limits.per_user >= 1 && var.aws_kyc_limits.per_user <= 5 &&
      var.aws_kyc_limits.liveness_threshold >= 90 && var.aws_kyc_limits.liveness_threshold <= 100 &&
    var.aws_kyc_limits.face_threshold >= 90 && var.aws_kyc_limits.face_threshold <= 100)
    error_message = "AWS KYC quotas and thresholds must be integers within the backend policy bounds."
  }
}

locals {
  aws_kyc_parameters = var.manage_aws_kyc_runtime_configuration ? {
    AWS_KYC_ENABLED            = tostring(var.aws_kyc_enabled)
    AWS_KYC_REGION             = var.aws_kyc_region
    AWS_KYC_LIVENESS_ROLE_ARN  = aws_iam_role.kyc_capture[0].arn
    AWS_KYC_DAILY_LIMIT        = tostring(var.aws_kyc_limits.daily)
    AWS_KYC_MONTHLY_LIMIT      = tostring(var.aws_kyc_limits.monthly)
    AWS_KYC_USER_DAILY_LIMIT   = tostring(var.aws_kyc_limits.per_user)
    AWS_KYC_LIVENESS_THRESHOLD = tostring(var.aws_kyc_limits.liveness_threshold)
    AWS_KYC_FACE_THRESHOLD     = tostring(var.aws_kyc_limits.face_threshold)
  } : {}
  aws_kyc_environment_parameter_arns_by_env = {
    for name, parameter in aws_ssm_parameter.aws_kyc_environment : name => parameter.arn
  }
}

resource "aws_ssm_parameter" "aws_kyc_environment" {
  for_each    = local.aws_kyc_parameters
  name        = "${local.ssm_prefix}/env/${each.key}"
  description = "Managed AWS KYC configuration ${each.key}"
  type        = "SecureString"
  key_id      = aws_kms_key.application.arn
  value       = each.value
  lifecycle {
    # Disable captures with aws_kyc_enabled=false, not by deleting configuration
    # still referenced by running ECS tasks or retained AWS dossiers.
    prevent_destroy = true
    precondition {
      condition = (length(setintersection(toset(keys(var.runtime_environment_variables)), toset(keys(local.aws_kyc_parameters)))) == 0 &&
      length(setintersection(var.external_runtime_environment_variable_names, toset(keys(local.aws_kyc_parameters)))) == 0)
      error_message = "Managed AWS_KYC_* variables cannot also be declared as external or generic runtime variables. Import existing SSM parameters instead."
    }
  }
}
