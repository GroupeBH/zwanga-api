resource "aws_lb" "backend" {
  name               = "${local.name_prefix}-api-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  idle_timeout               = 300
  enable_deletion_protection = var.alb_enable_deletion_protection

  tags = {
    Name = "${local.name_prefix}-api-alb"
  }
}

resource "aws_lb_target_group" "backend" {
  name        = "${local.name_prefix}-api-tg"
  vpc_id      = aws_vpc.main.id
  protocol    = "HTTP"
  port        = var.ecs_container_port
  target_type = "ip"

  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = var.alb_health_check_path
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  stickiness {
    enabled         = var.alb_enable_stickiness
    type            = "lb_cookie"
    cookie_duration = var.alb_stickiness_cookie_duration_seconds
  }

  tags = {
    Name = "${local.name_prefix}-api-tg"
  }
}

resource "aws_lb_listener" "http_forward" {
  count = var.alb_certificate_arn == null ? 1 : 0

  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = var.alb_certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.alb_certificate_arn == null ? 0 : 1

  load_balancer_arn = aws_lb.backend.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}
