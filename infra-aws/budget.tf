# Opt-in only. Alerts never interrupt trips, payments, databases or queues.
variable "monthly_cost_budget_usd" {
  description = "Optional account-wide monthly USD cost alert, excluding credits/refunds but including tax. Not a spending cap. Requires confirmed operator email addresses."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.monthly_cost_budget_usd == null ? true : var.monthly_cost_budget_usd > 0
    error_message = "monthly_cost_budget_usd must be null or positive."
  }
}

resource "aws_budgets_budget" "monthly" {
  count = var.monthly_cost_budget_usd == null ? 0 : 1

  name         = "${local.name_prefix}-monthly-account-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_cost_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
    include_tax    = true
  }

  dynamic "notification" {
    for_each = {
      actual_warning = { type = "ACTUAL", threshold = 80 }
      actual_limit   = { type = "ACTUAL", threshold = 100 }
      forecast_limit = { type = "FORECASTED", threshold = 100 }
    }
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = sort(tolist(var.alert_email_addresses))
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.alert_email_addresses) >= 1 && length(var.alert_email_addresses) <= 10
      error_message = "Provide 1 to 10 real operator addresses in alert_email_addresses before enabling the cost budget. No placeholder recipients."
    }
  }
}
