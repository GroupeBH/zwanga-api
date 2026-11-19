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

# Dimensionnement de production retenu, chargé même sans -var-file de capacité.
# Garder ces valeurs alignées avec profiles/capacity-175.tfvars.json (test CI).
# Le fichier operators.tfvars reste local et doit être fourni explicitement
# pour les destinataires d'alertes ; sans eux, le budget bloque le plan.
ecs_task_cpu_architecture                = "ARM64"
ecs_task_cpu                             = "512"
ecs_task_memory                          = "1024"
ecs_desired_count                        = 2
ecs_enable_autoscaling                   = true
ecs_min_capacity                         = 2
ecs_max_capacity                         = 3
ecs_enable_availability_zone_rebalancing = true
ecs_cpu_target_utilization               = 60
ecs_memory_target_utilization            = 70
ecs_request_count_per_target             = 1000
ecs_scale_in_cooldown_seconds            = 600
ecs_scale_out_cooldown_seconds           = 60
ecs_deployment_minimum_healthy_percent   = 100
ecs_deployment_maximum_percent           = 200

database_instance_class           = "db.t4g.small"
database_allocated_storage_gb     = 20
database_max_allocated_storage_gb = 100
database_multi_az                 = false
database_deletion_protection      = true
database_skip_final_snapshot      = false

# Deux nœuds activent Multi-AZ et automatic_failover_enabled dans redis.tf.
redis_node_type                          = "cache.t4g.micro"
redis_num_cache_clusters                 = 2
alb_enable_stickiness                    = true
alb_health_check_path                    = "/health"
enable_ecs_container_insights            = false
enable_xray_tracing                      = true
xray_sampling_rate                       = 0.01
cloudwatch_log_retention_days            = 7
rds_enhanced_monitoring_interval_seconds = 60
monthly_cost_budget_usd                  = 175
