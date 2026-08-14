terraform {
  # The bucket is created once by infra-aws/bootstrap. Runtime values are
  # supplied with: terraform init -backend-config=backend.hcl
  backend "s3" {
    bucket       = "tfstates-zwanga-api"
    key          = "zwanga/ecs-fargate/eu-central-1/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
