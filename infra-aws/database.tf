resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-postgres-subnets"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.name_prefix}-postgres-subnets"
  }
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "aws_db_instance" "postgres" {
  identifier = "${local.name_prefix}-postgres"

  engine         = "postgres"
  instance_class = var.database_instance_class
  port           = 5432

  db_name  = var.database_name
  username = var.database_username
  password = random_password.database.result

  allocated_storage     = var.database_allocated_storage_gb
  max_allocated_storage = var.database_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.application.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.database_multi_az

  backup_retention_period    = 7
  backup_window              = "02:00-03:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  monitoring_interval             = var.rds_enhanced_monitoring_interval_seconds
  monitoring_role_arn             = var.rds_enhanced_monitoring_interval_seconds > 0 ? aws_iam_role.rds_enhanced_monitoring.arn : null

  deletion_protection       = var.database_deletion_protection
  skip_final_snapshot       = var.database_skip_final_snapshot
  final_snapshot_identifier = "${local.name_prefix}-postgres-final"
  copy_tags_to_snapshot     = true

  tags = {
    Name = "${local.name_prefix}-postgres"
  }

  depends_on = [
    aws_cloudwatch_log_group.rds_postgresql,
    aws_cloudwatch_log_group.rds_upgrade,
    aws_iam_role_policy_attachment.rds_enhanced_monitoring,
  ]
}
