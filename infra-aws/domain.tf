locals {
  create_route53_api_alias = var.api_domain_name != null && var.route53_hosted_zone_id != null && local.alb_https_enabled
}

resource "terraform_data" "production_https_guard" {
  input = {
    environment            = var.environment
    api_domain_name        = var.api_domain_name
    route53_hosted_zone_id = var.route53_hosted_zone_id
    alb_certificate_arn    = var.alb_certificate_arn
  }

  lifecycle {
    precondition {
      condition = (
        var.environment != "production" ||
        (
          var.api_domain_name != null &&
          (var.route53_hosted_zone_id != null || var.alb_certificate_arn != null)
        )
      )
      error_message = "Production requires api_domain_name and either route53_hosted_zone_id or alb_certificate_arn. Refusing a plan that could remove public HTTPS resources."
    }
  }
}

resource "aws_acm_certificate" "api" {
  count = local.create_route53_validated_alb_certificate ? 1 : 0

  domain_name       = var.api_domain_name
  validation_method = "DNS"

  depends_on = [
    aws_route53_record.api_caa,
  ]

  lifecycle {
    create_before_destroy = true
    prevent_destroy       = true
  }

  tags = {
    Name = "${local.name_prefix}-api-certificate"
  }
}

resource "aws_route53_record" "api_certificate_validation" {
  for_each = local.create_route53_validated_alb_certificate ? {
    for option in aws_acm_certificate.api[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id         = var.route53_hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "api_caa" {
  count = var.api_domain_name != null && var.route53_hosted_zone_id != null ? 1 : 0

  zone_id = var.route53_hosted_zone_id
  name    = var.api_domain_name
  type    = "CAA"
  ttl     = 300

  records = [
    "0 issue \"amazon.com\"",
    "0 issue \"amazontrust.com\"",
    "0 issue \"awstrust.com\"",
    "0 issue \"amazonaws.com\"",
  ]

  allow_overwrite = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_acm_certificate_validation" "api" {
  count = local.create_route53_validated_alb_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for record in aws_route53_record.api_certificate_validation : record.fqdn]

  depends_on = [
    aws_route53_record.api_caa,
  ]
}

resource "aws_route53_record" "api_alias" {
  count = local.create_route53_api_alias ? 1 : 0

  zone_id = var.route53_hosted_zone_id
  name    = var.api_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.backend.dns_name
    zone_id                = aws_lb.backend.zone_id
    evaluate_target_health = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
