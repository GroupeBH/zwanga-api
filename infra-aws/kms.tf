resource "aws_kms_key" "application" {
  description             = "Encryption key for ${local.name_prefix} data and parameters"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-application-key"
  }
}

resource "aws_kms_alias" "application" {
  name          = "alias/${local.name_prefix}-application"
  target_key_id = aws_kms_key.application.key_id
}
