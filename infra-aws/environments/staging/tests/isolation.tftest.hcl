mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-0123456789abcdef0", arn = "arn:aws:ec2:eu-central-1:046374119247:instance/i-0123456789abcdef0" }
  }
}
mock_provider "archive" {}

run "isolated_on_demand_staging" {
  command = plan
  assert {
    condition     = length(aws_instance.staging.user_data) <= 16384 && strcontains(aws_instance.staging.user_data, "ansible-playbook")
    error_message = "Cloud-init must only bootstrap Ansible and fit EC2's 16 KiB user-data limit."
  }
  assert {
    condition     = output.api_url == "https://staging.compute-api.zwanga-app.com"
    error_message = "The staging API domain must never be production."
  }
  assert {
    condition     = aws_instance.staging.instance_type == "t4g.medium" && aws_instance.staging.root_block_device[0].volume_size == 30
    error_message = "Unexpected recurring cost: staging size must be reviewed explicitly."
  }
  assert {
    condition     = aws_instance.staging.instance_initiated_shutdown_behavior == "stop" && aws_instance.staging.root_block_device[0].encrypted && !aws_instance.staging.root_block_device[0].delete_on_termination
    error_message = "Stopping must retain encrypted staging data."
  }
  assert {
    condition     = alltrue([for r in aws_security_group.staging.ingress : contains([80, 443], r.from_port) && r.from_port == r.to_port])
    error_message = "No SSH, database, cache or direct API exposure is permitted."
  }
  assert {
    condition     = aws_cloudwatch_event_rule.watchdog.schedule_expression == "rate(5 minutes)" && aws_lambda_function.controller.reserved_concurrent_executions == 1
    error_message = "Independent auto-stop and serialized control must remain enabled."
  }
  assert {
    condition     = aws_ssm_parameter.integrations.name == "/zwanga-api/staging/integrations" && alltrue([for r in aws_ecr_repository.images : startswith(r.name, "zwanga-api-staging-") && r.image_tag_mutability == "IMMUTABLE"])
    error_message = "Secrets and images must be staging-only."
  }
  assert {
    condition     = strcontains(aws_iam_role.github.assume_role_policy, "repo:GroupeBH/zwanga-api:ref:refs/heads/staging") && !strcontains(aws_iam_role.github.assume_role_policy, "refs/heads/release")
    error_message = "Only the staging branch may assume the staging deployment role."
  }
}
