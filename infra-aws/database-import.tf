locals {
  database_import_command = <<-EOT
set -eu

export PGCONNECT_TIMEOUT="$${PGCONNECT_TIMEOUT:-20}"

: "$${NEON_DATABASE_URL:?NEON_DATABASE_URL is required}"
: "$${DATABASE_URL:?DATABASE_URL is required}"

echo "Checking Neon source connectivity..."
psql "$${NEON_DATABASE_URL}" -v ON_ERROR_STOP=1 -c "select current_database() as source_database, current_user as source_user;" >/dev/null

echo "Checking RDS target connectivity..."
psql "$${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "select current_database() as target_database, current_user as target_user;" >/dev/null

dump_file="/tmp/neon.dump"

echo "Starting full Neon to RDS import. Target objects may be dropped and recreated."
pg_dump "$${NEON_DATABASE_URL}" \
  --format=custom \
  --file "$${dump_file}" \
  --no-owner \
  --no-acl \
  --exclude-extension=postgis_sfcgal \
  --exclude-schema=neon_auth \
  --verbose

echo "Restoring dump into RDS..."
pg_restore \
  --dbname "$${DATABASE_URL}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --exit-on-error \
  --single-transaction \
  --verbose \
  "$${dump_file}"

echo "Running ANALYZE on RDS target..."
psql "$${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "analyze;"

rm -f "$${dump_file}"

echo "Neon to RDS import completed successfully."
EOT
}

resource "aws_cloudwatch_log_group" "database_import" {
  name              = local.database_import_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days
  kms_key_id        = aws_kms_key.observability.arn

  tags = {
    Name = local.database_import_log_group_name
  }
}

resource "aws_ecs_task_definition" "database_import" {
  family                   = local.database_import_task_family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.database_import_task_cpu
  memory                   = var.database_import_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  ephemeral_storage {
    size_in_gib = var.database_import_ephemeral_storage_gb
  }

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.ecs_task_cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = local.database_import_container_name
      image     = var.database_import_image
      essential = true
      command   = ["sh", "-ec", local.database_import_command]

      secrets = [
        {
          name      = "NEON_DATABASE_URL"
          valueFrom = local.database_import_source_url_parameter_arn
        },
        {
          name      = "DATABASE_URL"
          valueFrom = aws_ssm_parameter.database_url.arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.database_import.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = local.database_import_container_name
        }
      }
    }
  ])

  tags = {
    Name = local.database_import_task_family
  }

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution,
  ]
}
