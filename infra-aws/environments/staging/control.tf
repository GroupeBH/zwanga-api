data "archive_file" "controller" {
  type        = "zip"
  source_file = "${path.module}/control/handler.py"
  output_path = "${path.module}/.terraform/staging-control.zip"
}
resource "aws_cloudwatch_log_group" "controller" {
  name              = "/aws/lambda/${local.name}-control"
  retention_in_days = 7
}
resource "aws_lambda_function" "controller" {
  function_name                  = "${local.name}-control"
  role                           = aws_iam_role.controller.arn
  handler                        = "handler.handler"
  runtime                        = "python3.13"
  architectures                  = ["arm64"]
  filename                       = data.archive_file.controller.output_path
  source_code_hash               = data.archive_file.controller.output_base64sha256
  timeout                        = 30
  memory_size                    = 128
  reserved_concurrent_executions = 1
  environment {
    variables = {
      INSTANCE_ID = aws_instance.staging.id
      HOSTED_ZONE = local.zone
      DOMAIN      = local.domain
    }
  }
  depends_on = [aws_iam_role_policy.controller, aws_route53_record.staging]
}
resource "aws_cloudwatch_event_rule" "watchdog" {
  name                = "${local.name}-autostop"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "watchdog" {
  rule  = aws_cloudwatch_event_rule.watchdog.name
  arn   = aws_lambda_function.controller.arn
  input = jsonencode({ action = "watchdog" })
}
resource "aws_lambda_permission" "watchdog" {
  statement_id  = "StagingWatchdog"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.controller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog.arn
}
resource "aws_ssm_document" "runtime" {
  name          = "${local.name}-runtime"
  document_type = "Command"
  content = jsonencode({
    schemaVersion = "2.2",
    description   = "Only this staging host; no arbitrary shell or production endpoint",
    parameters = {
      action  = { type = "String", allowedValues = ["deploy", "bootstrap", "resume", "status"] },
      release = { type = "String", allowedPattern = "^[a-f0-9]{40}$" }
    },
    mainSteps = [{ action = "aws:runShellScript", name = "runtime", inputs = {
      timeoutSeconds = "900",
      runCommand = [
        "set -eu",
        "test -f /opt/zwanga-staging/host-ready",
        "if [ '{{ action }}' = deploy ] || [ '{{ action }}' = bootstrap ]; then aws s3 cp 's3://${aws_s3_bucket.storage["artifacts"].id}/releases/{{ release }}/ansible/' /opt/zwanga-staging/ansible/ --recursive --region ${local.region} --only-show-errors; fi",
        "ansible-playbook -i localhost, -c local /opt/zwanga-staging/ansible/deploy.yml -e 'operation={{ action }} release={{ release }}'"
      ]
    } }]
  })
}
