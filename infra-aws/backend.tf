terraform {
  # The bucket is created once by infra-aws/bootstrap. Runtime values are
  # supplied with: terraform init -backend-config=backend.hcl
  backend "s3" {}
}
