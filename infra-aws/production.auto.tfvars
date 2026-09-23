# Configuration non sensible et durable de la pile AWS de production.
# Terraform charge automatiquement ce fichier. Ne jamais y ajouter de secret :
# les secrets applicatifs restent dans AWS SSM Parameter Store.

github_owner      = "GroupeBH"
github_repository = "zwanga-api"
github_branch     = "release"

application_s3_bucket_name     = "medias-zwanga"
enable_rekognition_permissions = true

api_domain_name        = "compute-api.zwanga-app.com"
route53_hosted_zone_id = "Z0100742PIM0UW6FZED7"
