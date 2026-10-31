# All providers are mocked. This suite NEVER connects to AWS or an S3 backend.
mock_provider "aws" {
  mock_data "aws_ssm_parameter" { defaults = { value = "ami-0123456789abcdef0" } }
  mock_data "aws_subnet" { defaults = { vpc_id = "vpc-test" } }
  mock_data "aws_vpc" { defaults = { id = "vpc-test", cidr_block = "10.42.0.0/16" } }
  mock_data "aws_security_group" { defaults = { vpc_id = "vpc-test" } }
  mock_data "aws_route_table" {
    defaults = { routes = [{ cidr_block = "0.0.0.0/0", gateway_id = "igw-test" }] }
  }
  mock_resource "aws_network_interface" { defaults = { private_ip = "10.42.0.123" } }
  mock_resource "aws_eip" { defaults = { public_ip = "198.51.100.1" } }
}

run "isolated_mock_resources" {
  command = apply
  assert {
    condition     = aws_instance.proxy.instance_type == "t4g.micro" && aws_instance.proxy.root_block_device[0].volume_size == 8
    error_message = "Unexpected proxy cost/size change."
  }
  assert {
    condition     = aws_instance.proxy.root_block_device[0].encrypted && aws_instance.proxy.metadata_options[0].http_tokens == "required"
    error_message = "Require encrypted disk and IMDSv2."
  }
  assert {
    condition     = length(aws_instance.proxy.user_data) <= 16384 && strcontains(aws_instance.proxy.user_data, "ansible-playbook")
    error_message = "Bootstrap must use Ansible and fit the EC2 user-data size limit."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.ecs_to_proxy.referenced_security_group_id == var.ecs_security_group_id && aws_vpc_security_group_ingress_rule.ecs_to_proxy.from_port == 3128 && aws_vpc_security_group_ingress_rule.ecs_to_proxy.to_port == 3128 && aws_vpc_security_group_ingress_rule.ecs_to_proxy.cidr_ipv4 == null
    error_message = "The proxy must not be open to the Internet."
  }
  assert {
    condition     = aws_network_interface.proxy.source_dest_check && output.backend_proxy_url == "http://10.42.0.123:3128" && output.mobishastra_whitelist_ipv4 == "198.51.100.1"
    error_message = "This is an explicit proxy, not a default NAT route. Do not swap the private URL and public EIP."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.proxy.policy, "GetParameter") && !strcontains(aws_iam_role_policy.proxy.policy, "s3:") && !strcontains(aws_iam_role_policy.proxy.policy, "ecs:")
    error_message = "The proxy must not read secrets/data or control ECS."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.proxy_health.treat_missing_data == "breaching" && aws_cloudwatch_metric_alarm.proxy_health.namespace == "Zwanga/MobishastraProxy"
    error_message = "A stopped instance or missing heartbeat must trigger an alarm."
  }
}
