locals {
  ecs_base_environment = merge(
    {
      NODE_ENV            = "production"
      HOST                = "0.0.0.0"
      PORT                = tostring(var.ecs_container_port)
      API_PREFIX          = "api/v1"
      TYPEORM_SYNCHRONIZE = "false"
      AWS_REGION          = var.aws_region
      LOG_LEVEL           = "warn"
      GPS_LOG_SAMPLE_RATE = "0.01"
    },
    var.runtime_environment_variables,
    var.enable_xray_tracing ? {
      AWS_XRAY_CONTEXT_MISSING             = "LOG_ERROR"
      NODE_OPTIONS                         = "--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register"
      OTEL_EXPORTER_OTLP_ENDPOINT          = "http://127.0.0.1:4318"
      OTEL_EXPORTER_OTLP_PROTOCOL          = "http/protobuf"
      OTEL_LOGS_EXPORTER                   = "none"
      OTEL_METRICS_EXPORTER                = "none"
      OTEL_PROPAGATORS                     = "xray"
      OTEL_RESOURCE_ATTRIBUTES             = "service.name=${local.ecs_service_name},deployment.environment=${var.environment}"
      OTEL_SERVICE_NAME                    = local.ecs_service_name
      OTEL_TRACES_EXPORTER                 = "otlp"
      OTEL_TRACES_SAMPLER                  = "xray"
      OTEL_TRACES_SAMPLER_ARG              = tostring(var.xray_sampling_rate)
      OTEL_AWS_APPLICATION_SIGNALS_ENABLED = "false"
    } : {},
  )

  ecs_app_container = {
    name      = local.app_container_name
    image     = "${aws_ecr_repository.backend.repository_url}:${var.ecs_image_tag}"
    essential = true

    portMappings = [
      {
        containerPort = var.ecs_container_port
        hostPort      = var.ecs_container_port
        protocol      = "tcp"
      },
    ]

    secrets = [
      for name, arn in merge(
        local.ecs_environment_parameter_arns_by_env,
        local.generated_runtime_environment_parameter_arns_by_env,
        local.external_runtime_environment_parameter_arns_by_env,
        local.generated_secret_parameter_arns_by_env,
        ) : {
        name      = name
        valueFrom = arn
      }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = local.app_container_name
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:${var.ecs_container_port}${var.alb_health_check_path} >/dev/null || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    dependsOn = var.enable_xray_tracing ? [
      {
        containerName = local.otel_container_name
        condition     = "START"
      },
    ] : []
  }

  ecs_otel_collector_config = <<-YAML
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch/traces:
        timeout: 1s
        send_batch_size: 50

    exporters:
      awsxray:
        region: ${var.aws_region}

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch/traces]
          exporters: [awsxray]
  YAML

  ecs_otel_container = {
    name      = local.otel_container_name
    image     = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
    essential = false

    command = ["--config=env:AOT_CONFIG_CONTENT"]

    secrets = [
      for name, arn in local.otel_environment_parameter_arns_by_env : {
        name      = name
        valueFrom = arn
      }
    ]

    portMappings = [
      {
        containerPort = 4317
        hostPort      = 4317
        protocol      = "tcp"
      },
      {
        containerPort = 4318
        hostPort      = 4318
        protocol      = "tcp"
      },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.ecs_otel[0].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = local.otel_container_name
      }
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.ecs_cluster_name

  setting {
    name  = "containerInsights"
    value = var.enable_ecs_container_insights ? "enabled" : "disabled"
  }

  tags = {
    Name = local.ecs_cluster_name
  }
}

resource "aws_ecs_task_definition" "backend" {
  family                   = local.ecs_task_family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.ecs_task_cpu_architecture
  }

  container_definitions = jsonencode(concat(
    [local.ecs_app_container],
    var.enable_xray_tracing ? [local.ecs_otel_container] : [],
  ))

  tags = {
    Name = local.ecs_task_family
  }

  depends_on = [
    aws_iam_role_policy.ecs_task_execution_secrets,
    aws_iam_role_policy_attachment.ecs_task_execution,
  ]
}

resource "aws_ecs_service" "backend" {
  name                               = local.ecs_service_name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.backend.arn
  desired_count                      = var.ecs_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = var.enable_ecs_execute_command
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = var.ecs_deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.ecs_deployment_maximum_percent
  wait_for_steady_state              = var.ecs_wait_for_steady_state

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = local.app_container_name
    container_port   = var.ecs_container_port
  }

  tags = {
    Name = local.ecs_service_name
  }

  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.http_redirect,
    aws_lb_listener.https,
  ]
}

resource "aws_appautoscaling_target" "ecs" {
  count = var.ecs_enable_autoscaling ? 1 : 0

  max_capacity       = var.ecs_max_capacity
  min_capacity       = var.ecs_min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.backend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_memory" {
  count = var.ecs_enable_autoscaling ? 1 : 0

  name               = "${local.name_prefix}-ecs-memory"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.ecs_memory_target_utilization
    scale_in_cooldown  = var.ecs_scale_in_cooldown_seconds
    scale_out_cooldown = var.ecs_scale_out_cooldown_seconds

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "ecs_request_count" {
  count = var.ecs_enable_autoscaling ? 1 : 0

  name               = "${local.name_prefix}-ecs-request-count"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.ecs_request_count_per_target
    scale_in_cooldown  = var.ecs_scale_in_cooldown_seconds
    scale_out_cooldown = var.ecs_scale_out_cooldown_seconds

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.backend.arn_suffix}/${aws_lb_target_group.backend.arn_suffix}"
    }
  }
}
