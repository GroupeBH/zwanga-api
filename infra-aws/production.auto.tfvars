# Configuration non sensible et durable de la pile AWS de production.
# Terraform charge automatiquement ce fichier. Ne jamais y ajouter de secret :
# les secrets applicatifs restent dans AWS SSM Parameter Store.

github_owner      = "GroupeBH"
github_repository = "zwanga-api"
github_branch     = "release"

application_s3_bucket_name     = "medias-zwanga"
enable_rekognition_permissions = true
didit_kyc_launch_mode          = "native"

# Prepare AWS KYC for the next native build; this does NOT enable captures.
enable_aws_kyc_permissions           = true
manage_aws_kyc_runtime_configuration = true
aws_kyc_region                       = "eu-west-1"
aws_kyc_enabled                      = false

api_domain_name        = "compute-api.zwanga-app.com"
route53_hosted_zone_id = "Z0100742PIM0UW6FZED7"
