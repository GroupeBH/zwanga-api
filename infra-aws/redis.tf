resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "redis_auth" {
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "Valkey cache and Socket.IO pub/sub for ${local.name_prefix}"

  engine                     = "valkey"
  engine_version             = "7.2"
  auto_minor_version_upgrade = true
  node_type                  = var.redis_node_type
  port                       = 6379
  num_cache_clusters         = var.redis_num_cache_clusters
  parameter_group_name       = "default.valkey7"

  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.application.arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.redis_auth.result

  snapshot_retention_limit = 7
  snapshot_window          = "01:00-02:00"
  maintenance_window       = "sun:04:30-sun:05:30"
  apply_immediately        = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_engine.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "engine-log"
  }

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
