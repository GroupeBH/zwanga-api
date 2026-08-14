# Infrastructure AWS de Zwanga

Ce dossier provisionne l'infrastructure AWS du backend NestJS en Terraform. La variante appliquee ici est la version propre economique : ECS Fargate au lieu d'App Runner, taches ECS en subnets publics sans NAT Gateway, RDS et Redis prives, monitoring AWS natif.

## Architecture

```text
Internet
  |
  v
Application Load Balancer public
  |
  v
ECS Fargate service public-subnet, desired_count = 1, entree seulement depuis ALB
  |
  |-- RDS PostgreSQL chiffre, port 5432 autorise seulement depuis ECS
  |-- ElastiCache Redis TLS, port 6379 autorise seulement depuis ECS
  |-- IP publique ECS pour ECR, CloudWatch, SSM, X-Ray et APIs externes
  `-- VPC Gateway Endpoint S3

GitHub Actions -- OIDC/STS --> IAM Role --> ECR push + ECS force deployment
ECS Task Execution Role --> ECR, CloudWatch Logs, SSM SecureString + KMS Decrypt pour toutes les variables runtime
ECS Task Role --> X-Ray, ECS Exec optionnel

Observabilite
  |-- CloudWatch Logs: ECS, ADOT, PostgreSQL, Redis et CloudTrail
  |-- CloudWatch Dashboard + alarmes --> SNS email
  |-- EventBridge --> alerte echec de deploiement ECS
  |-- CloudTrail multi-region --> CloudWatch Logs + S3 chiffre et versionne
  `-- ADOT sidecar --> AWS X-Ray
```

## Organisation des fichiers

```text
infra-aws/
|-- bootstrap/                 # bucket S3 du state Terraform
|-- backend.tf                 # backend S3 configure par backend.hcl
|-- providers.tf               # provider AWS et data sources
|-- variables.tf               # entrees configurables
|-- locals.tf                  # noms, ARN et tags communs
|-- network.tf                 # VPC, subnets, IGW, routes, endpoint S3
|-- security-groups.tf         # flux ALB/ECS/RDS/Redis/DNS/HTTPS
|-- kms.tf                     # cle de chiffrement applicative
|-- database.tf                # RDS PostgreSQL prive
|-- redis.tf                   # ElastiCache Redis prive avec TLS
|-- ecr.tf                     # registre Docker et retention
|-- ssm.tf                     # toutes les variables runtime en SecureString
|-- iam-ecs.tf                 # roles ECS task/execution
|-- oidc.tf                    # provider GitHub OIDC et role CI/CD
|-- alb.tf                     # ALB public et target group ECS
|-- ecs.tf                     # cluster, task definition, service et autoscaling optionnel
|-- monitoring.tf              # dashboard, alarmes, SNS et EventBridge
|-- cloudtrail.tf              # audit multi-region, S3, KMS et detections
|-- observability-logs.tf      # log groups ECS/RDS/Redis et monitoring RDS
|-- xray.tf                    # IAM X-Ray et sampling rules
`-- outputs.tf                 # valeurs a copier dans GitHub Actions
```

## Prerequis

- Terraform `>= 1.10`
- AWS CLI authentifie avec un role de provisioning
- Docker pour pousser l'image initiale
- Un proprietaire GitHub connu pour restreindre le role OIDC

Aucune cle `AWS_ACCESS_KEY_ID` ou `AWS_SECRET_ACCESS_KEY` ne doit etre ajoutee aux secrets GitHub. Le workflow utilise OIDC et des identifiants STS temporaires.

## 1. Creer le bucket de state

Le state contient des valeurs sensibles generees par Terraform. Il ne doit jamais etre conserve dans Git.

```bash
cd infra-aws/bootstrap
cp terraform.tfvars.example terraform.tfvars
# Modifier state_bucket_name avec un nom S3 globalement unique.
terraform init
terraform plan
terraform apply
```

## 2. Initialiser l'infrastructure principale

```bash
cd ..
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
```

Modifier au minimum :

- `backend.hcl` : nom du bucket cree a l'etape precedente ;
- `terraform.tfvars` : `github_owner` si tu utilises un fichier local de variables ;
- optionnellement, les variables non sensibles dans `runtime_environment_variables` ;
- les destinataires `alert_email_addresses` ;
- `alb_certificate_arn` si tu as deja un certificat ACM pour HTTPS.

Si ton compte AWS possede deja le provider OIDC GitHub Actions, renseigne aussi :

```hcl
github_oidc_provider_arn = "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
```

AWS n'autorise qu'un seul provider OIDC pour `https://token.actions.githubusercontent.com` par compte. Cette variable evite l'erreur `EntityAlreadyExists`.

Puis :

```bash
terraform init -backend-config=backend.hcl
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

Le service ECS peut etre cree avant que l'image `latest` existe dans ECR, car `ecs_wait_for_steady_state = false` par defaut. La premiere execution GitHub Actions pousse l'image et force ensuite un nouveau deploiement ECS.

### Variables d'environnement dans SSM

Toutes les variables runtime du conteneur ECS sont stockees dans AWS SSM Parameter Store en `SecureString` avec la cle KMS applicative.

Terraform genere automatiquement :

- `/zwanga-api/production/DATABASE_URL`
- `/zwanga-api/production/REDIS_URL`
- `/zwanga-api/production/REDIS_TLS`
- `/zwanga-api/production/JWT_SECRET`
- `/zwanga-api/production/JWT_REFRESH_SECRET`

Les variables declarees dans `runtime_environment_variables` sont creees sous :

```text
/zwanga-api/production/env/NOM_DE_VARIABLE
```

Exemple :

```hcl
runtime_environment_variables = {
  CORS_ORIGINS        = "https://zwanga-app.com,https://www.zwanga-app.com"
  FRONTEND_URL        = "https://zwanga-app.com"
  GOOGLE_MAPS_API_KEY = "replace-me"
  FLEXPAY_API_KEY     = "replace-me"
}
```

Ces valeurs sont injectees dans ECS via le bloc `secrets`, donc elles ne sont pas ecrites en clair dans la definition de tache. Attention quand meme : toute valeur fournie a Terraform reste dans le state Terraform. Pour les secrets tres sensibles deja existants, tu peux les modifier directement dans SSM apres l'apply, puis garder des placeholders dans `terraform.tfvars`.

Pour eviter de stocker les secrets externes dans le state Terraform, importe ton fichier d'environnement production directement dans SSM. Ce fichier reste sur ta machine et n'est pas versionne dans GitHub :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra-aws\scripts\import-env-to-ssm.ps1 `
  -EnvFile .\.env.production `
  -DryRun
```

Si le dry-run est correct :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra-aws\scripts\import-env-to-ssm.ps1 `
  -EnvFile .\.env.production
```

Utilise un fichier `.env.production` separe de ton `.env` local. Les valeurs locales et production ne doivent pas etre melangees. Le script refuse d'importer `.env` vers l'environnement `production`, sauf si tu passes explicitement `-AllowLocalEnvForProduction`.

Le script cree les parametres `/zwanga-api/production/env/*` en `SecureString`. Au prochain `terraform apply`, Terraform decouvre automatiquement ces parametres et les injecte dans la definition ECS via le bloc `secrets`, sans lire les valeurs en clair.

### Adapter un `.env` exporte depuis Render

Garde dans `.env.production` les variables metier :

- fournisseurs de paiement : `FLEXPAY_*`, `FLEX_PAIE_TOKEN` ;
- notifications : `FCM_*`, `INFOBIP_*`, `KECCEL_*`, `WHATSAPP_*` ;
- OAuth et cartes : `GOOGLE_*`, `APPLE_*` ;
- URLs publiques : `CORS_ORIGINS`, `FRONTEND_URL`, callbacks applicatifs ;
- configuration produit : subscriptions, limites, pays par defaut.

Ne migre pas depuis Render les variables d'infrastructure suivantes : elles sont ignorees par le script et remplacees par Terraform/ECS :

- `DATABASE_*`, `DATABASE_URL`, `POSTGRES_*` ;
- `REDIS_*`, `REDIS_URL` ;
- `PORT`, `HOST`, `NODE_ENV`, `API_PREFIX`, `TYPEORM_SYNCHRONIZE` ;
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` ;
- `AWS_S3_BUCKET_NAME`, gere par `application_s3_bucket_name` ;
- `JWT_SECRET`, `JWT_REFRESH_SECRET`, generes dans SSM par Terraform.

Ne remets pas `AWS_ACCESS_KEY_ID` ni `AWS_SECRET_ACCESS_KEY` dans SSM pour ECS. En production Fargate, l'application utilise le role IAM de la tache. Si tu actives S3 ou Rekognition :

- renseigne `application_s3_bucket_name` pour creer `AWS_S3_BUCKET_NAME` dans SSM et donner au role ECS l'acces au bucket d'uploads ;
- mets `enable_rekognition_permissions = true` si `AWS_REKOGNITION_ENABLED` ou `AWS_REKOGNITION_KYC_ENABLED` vaut `true`.

Sans fichier `terraform.tfvars`, tu peux passer ces valeurs au moment de l'apply :

```powershell
terraform apply `
  -var="application_s3_bucket_name=TON_BUCKET_UPLOADS" `
  -var="enable_rekognition_permissions=true"
```

## 3. Pousser une premiere image si necessaire

Depuis la racine `zwanga-backend` :

```bash
AWS_REGION="$(terraform -chdir=infra-aws output -raw aws_region)"
ECR_URL="$(terraform -chdir=infra-aws output -raw ecr_repository_url)"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%%/*}"
docker build --target production -t "$ECR_URL:latest" .
docker push "$ECR_URL:latest"
```

Sous PowerShell :

```powershell
$AwsRegion = terraform -chdir=infra-aws output -raw aws_region
$EcrUrl = terraform -chdir=infra-aws output -raw ecr_repository_url
$EcrRegistry = $EcrUrl.Split('/')[0]
aws ecr get-login-password --region $AwsRegion | docker login --username AWS --password-stdin $EcrRegistry
docker build --target production -t "${EcrUrl}:latest" .
docker push "${EcrUrl}:latest"
```

## 4. Configurer GitHub Actions

Dans `Settings > Secrets and variables > Actions > Variables`, creer :

| Variable GitHub | Commande Terraform |
| --- | --- |
| `AWS_REGION` | `terraform output -raw aws_region` |
| `AWS_ROLE_ARN` | `terraform output -raw github_actions_role_arn` |
| `ECR_REPOSITORY` | `terraform output -raw ecr_repository_name` |
| `ECS_CLUSTER` | `terraform output -raw ecs_cluster_name` |
| `ECS_SERVICE` | `terraform output -raw ecs_service_name` |

Le workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) teste le backend, construit l'image, publie les tags du commit et `latest`, execute les migrations TypeORM dans une tache ECS temporaire, puis appelle `aws ecs update-service --force-new-deployment`.

Ordre du deploiement :

```text
tests
build NestJS
build/push Docker vers ECR
tache ECS temporaire : npm run migration:run:prod
ecs update-service --force-new-deployment
wait services-stable
```

La tache de migration reutilise la definition ECS du service. Elle recupere donc les memes variables SSM que l'application et accede a RDS avec les memes Security Groups. Si une migration echoue, le workflow s'arrete avant de redeployer le service.

## Observabilite et alertes

Apres l'apply, ouvrir le dashboard :

```bash
terraform output -raw cloudwatch_dashboard_url
```

La couche d'observabilite fournit :

- metriques et alarmes ECS : CPU et memoire ;
- metriques et alarmes ALB : latence, targets unhealthy et reponses HTTP 5xx ;
- metriques et alarmes RDS : CPU et espace disque libre ;
- metriques et alarmes Redis : CPU moteur, memoire et evictions ;
- logs ECS applicatifs et logs ADOT ;
- logs PostgreSQL (`postgresql`, `upgrade`) et RDS Enhanced Monitoring ;
- logs Redis (`slow-log`, `engine-log`) en JSON ;
- CloudTrail multi-region avec validation d'integrite, S3 chiffre/versionne et CloudWatch Logs ;
- alertes de securite CloudTrail : `AccessDenied`, usage root et echecs de connexion console ;
- tracing X-Ray avec echantillonnage economique.

## Profil cout economique

Les valeurs par defaut sont pensees pour environ 100 utilisateurs quotidiens :

- `ecs_desired_count = 1`
- `ecs_task_cpu = "512"` et `ecs_task_memory = "1024"`
- ECS tourne dans les subnets publics avec `assign_public_ip = true`
- `database_instance_class = "db.t4g.micro"`
- `database_multi_az = false`
- `redis_node_type = "cache.t4g.micro"`
- `redis_num_cache_clusters = 1`
- `alb_enable_stickiness = true`
- `enable_ecs_container_insights = false`
- `enable_cloudtrail_insights = false`
- `xray_sampling_rate = 0.05`

Pour activer le multi-instance en production, mettre `ecs_enable_autoscaling = true`, `ecs_min_capacity = 2` et `ecs_max_capacity = 6`. Le scaling utilise la memoire ECS comme signal principal et `ALBRequestCountPerTarget` comme signal secondaire, avec `scale_in_cooldown = 300s` et `scale_out_cooldown = 60s`.

Pour une production critique, augmenter `ecs_desired_count`, activer l'autoscaling, passer RDS en Multi-AZ et ajouter un second noeud Redis.

Socket.IO est pret pour plusieurs taches ECS : l'application utilise `@socket.io/redis-adapter` avec `REDIS_URL`, et le target group ALB active la stickiness pour eviter les erreurs de session quand un client utilise encore le long-polling avant l'upgrade WebSocket.

## Securite

- RDS et Redis n'ont aucune exposition publique.
- Leurs Security Groups n'acceptent que le Security Group ECS Fargate.
- Redis impose TLS et un token d'authentification.
- RDS, Redis, ECR et SSM utilisent KMS.
- GitHub OIDC est restreint au depot et a la branche declares.
- Le role GitHub peut pousser uniquement dans ce repository ECR et redeployer uniquement ce service ECS.
- Toutes les variables runtime sont injectees par ARN SSM ; elles ne sont pas ecrites dans le workflow ni en clair dans la task definition ECS.
- Les groupes de logs geres utilisent une cle KMS d'observabilite.
- CloudTrail dispose d'un bucket distinct, non public et limite au trail par `aws:SourceArn`.

Attention : les secrets generes restent presents dans le state Terraform. Restreindre strictement l'acces IAM au bucket de state.

Si le provider GitHub OIDC existe deja dans le compte AWS, importer la ressource avant le premier apply :

```bash
terraform import aws_iam_openid_connect_provider.github \
  arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com
```

## Commandes de controle

```bash
terraform fmt -recursive
terraform validate
terraform plan
```

Documentation officielle utile :

- [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [ECS services](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html)
- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)
- [OIDC GitHub Actions](https://docs.github.com/en/actions/reference/security/oidc)
- [Bonnes pratiques CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html)
