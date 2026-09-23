resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "Public entry point for HTTP and optional HTTPS traffic"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-alb-sg"
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks-sg"
  description = "Strict traffic rules for ECS Fargate tasks with public egress only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-ecs-tasks-sg"
  }
}

resource "aws_security_group" "database_import" {
  name        = "${local.name_prefix}-database-import-sg"
  description = "One-off Neon to RDS import task egress rules"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-database-import-sg"
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-postgres-sg"
  description = "PostgreSQL accepts traffic only from ECS Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-postgres-sg"
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Redis accepts traffic only from ECS Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-redis-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "Public HTTP"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count = local.alb_https_enabled ? 1 : 0

  security_group_id = aws_security_group.alb.id
  description       = "Public HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ecs_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  description                  = "ALB to ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.ecs_container_port
  to_port                      = var.ecs_container_port
}

resource "aws_vpc_security_group_ingress_rule" "ecs_tasks_from_alb" {
  security_group_id            = aws_security_group.ecs_tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "NestJS traffic from ALB only"
  ip_protocol                  = "tcp"
  from_port                    = var.ecs_container_port
  to_port                      = var.ecs_container_port
}

resource "aws_vpc_security_group_ingress_rule" "database_from_ecs_tasks" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  description                  = "PostgreSQL from ECS tasks only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_database_import" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.database_import.id
  description                  = "PostgreSQL from the one-off Neon import task"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs_tasks" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  description                  = "Redis TLS from ECS tasks only"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_egress_rule" "ecs_tasks_to_database" {
  security_group_id            = aws_security_group.ecs_tasks.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "ECS tasks to PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "ecs_tasks_to_redis" {
  security_group_id            = aws_security_group.ecs_tasks.id
  referenced_security_group_id = aws_security_group.redis.id
  description                  = "ECS tasks to Redis TLS"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_egress_rule" "ecs_tasks_https" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "HTTPS APIs, ECR, CloudWatch Logs, SSM and X-Ray through the task public IP"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "ecs_tasks_dns_udp" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "DNS over UDP to the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "ecs_tasks_dns_tcp" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "DNS over TCP to the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "database_import_to_database" {
  security_group_id            = aws_security_group.database_import.id
  referenced_security_group_id = aws_security_group.database.id
  description                  = "Import task to private AWS RDS PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "database_import_to_external_postgresql" {
  security_group_id = aws_security_group.database_import.id
  description       = "Import task to Neon PostgreSQL public endpoint"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_vpc_security_group_egress_rule" "database_import_https" {
  security_group_id = aws_security_group.database_import.id
  description       = "HTTPS for image pulls, SSM, CloudWatch Logs and AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "database_import_dns_udp" {
  security_group_id = aws_security_group.database_import.id
  description       = "DNS over UDP to the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "database_import_dns_tcp" {
  security_group_id = aws_security_group.database_import.id
  description       = "DNS over TCP to the VPC resolver"
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}
