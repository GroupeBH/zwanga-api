# Infrastructure AWS de Zwanga

Ce dossier provisionne l'infrastructure AWS du backend NestJS en Terraform. La variante appliquee ici est la version propre economique : ECS Fargate au lieu d'App Runner, taches ECS en subnets publics sans NAT Gateway, RDS et Redis prives, monitoring AWS natif.

## Documentation obligatoire des modifications

Chaque modification ou opération AWS doit être décrite dans le [journal détaillé](./docs/CHANGELOG.md) en suivant le [modèle de changement](./docs/change-template.md). Le [guide documentaire](./docs/README.md) précise le périmètre, les preuves attendues et les informations qui ne doivent jamais être copiées. Un contrôle GitHub Actions fait échouer la pull request et le déploiement AWS lorsque ce journal n'est pas mis à jour.

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
|-- docs/                      # journal, règles et modèle de changement
|-- scripts/                   # import, migration et contrôles opérationnels
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

Le flux détaillé d'observabilité et le diagnostic du sampler sont décrits dans [Échantillonnage distant X-Ray avec ADOT sur ECS](./docs/xray-remote-sampling.md).

L'architecture DNS, ACM et ALB du domaine public est décrite dans [HTTPS de l'API publique](./docs/public-api-https.md).

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
- `production.auto.tfvars` : source versionnee des identifiants non sensibles indispensables a la production ;
- `terraform.tfvars` : uniquement pour des surcharges locales non versionnees ;
- optionnellement, les variables non sensibles dans `runtime_environment_variables` ;
- les destinataires `alert_email_addresses` ;
- `api_domain_name = "compute-api.zwanga-app.com"` pour exposer l'API en HTTPS ;
- `route53_hosted_zone_id` si la zone DNS `zwanga-app.com` est dans Route53 ;
- ou `alb_certificate_arn` si tu as deja un certificat ACM valide pour `compute-api.zwanga-app.com`.

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

### HTTPS pour `compute-api.zwanga-app.com`

Le certificat ACM utilise par un Application Load Balancer doit etre cree dans la meme region que l'ALB, ici `eu-central-1`.

Dans l'architecture de production actuelle, `zwanga-app.com` reste gere par Vercel et le sous-domaine `compute-api.zwanga-app.com` est delegue a la zone publique Route53 `Z0100742PIM0UW6FZED7`. Les quatre enregistrements NS de cette zone sont publies chez Vercel. L'alias `A`, le CNAME de validation ACM et le CAA sont ensuite geres uniquement dans cette zone enfant Route53.

Les variables non sensibles correspondantes sont versionnees dans `production.auto.tfvars` et chargees automatiquement par Terraform. Un apply de production refuse de continuer si le domaine et sa source de certificat ne sont pas configures. Les ressources critiques utilisent aussi `prevent_destroy` afin qu'un oubli de variables ne puisse plus supprimer silencieusement HTTPS.

Pour une autre installation utilisant une zone Route53, fournir le Hosted Zone ID autoritaire du domaine ou du sous-domaine a Terraform :

```bash
ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name compute-api.zwanga-app.com \
  --query "HostedZones[?Name=='compute-api.zwanga-app.com.'] | [0].Id" \
  --output text | sed 's#/hostedzone/##')

echo "$ZONE_ID"

terraform apply \
  -var='api_domain_name=compute-api.zwanga-app.com' \
  -var="route53_hosted_zone_id=$ZONE_ID" \
  -var='alert_email_addresses=["dev.gbh.sarl@gmail.com"]'
```

`ZONE_ID` doit afficher un vrai identifiant Route53 de type `Z0123456789ABCDEFG`, jamais un placeholder.

Terraform cree alors :

- le certificat ACM public ;
- les enregistrements DNS de validation ACM ;
- l'alias DNS `compute-api.zwanga-app.com` vers l'ALB ;
- le listener HTTPS `443` ;
- la redirection HTTP `80` vers HTTPS.

Si la zone DNS n'est pas dans Route53, cree le certificat ACM manuellement dans `eu-central-1`, valide-le par DNS chez ton fournisseur, puis passe son ARN :

```bash
terraform apply \
  -var='api_domain_name=compute-api.zwanga-app.com' \
  -var='alb_certificate_arn=arn:aws:acm:eu-central-1:046374119247:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' \
  -var='alert_email_addresses=["dev.gbh.sarl@gmail.com"]'
```

Dans ce cas, cree aussi chez ton fournisseur DNS un CNAME :

```text
compute-api.zwanga-app.com -> <terraform output -raw alb_dns_name>
```

Ne teste pas HTTPS avec le DNS technique de l'ALB : le certificat correspond au domaine `compute-api.zwanga-app.com`.

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
  PUBLIC_API_BASE_URL = "https://compute-api.zwanga-app.com"
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

`application_s3_bucket_name` est obligatoire lorsque `environment = "production"`. Terraform refuse ainsi un apply de production qui supprimerait accidentellement `/zwanga-api/production/env/AWS_S3_BUCKET_NAME`. Ce nom reste aussi reserve a Terraform meme si la variable est absente dans un autre environnement : l'auto-decouverte SSM ne peut donc jamais conserver dans ECS une reference vers un parametre programme pour suppression.

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
tache ECS temporaire : npm run database:assert-bootstrap:prod && npm run migration:run:prod
ecs update-service --force-new-deployment
wait services-stable
```

La tache de migration reutilise la definition ECS du service. Elle recupere donc les memes variables SSM que l'application et accede a RDS avec les memes Security Groups. Avant TypeORM, elle verifie que RDS contient deja les tables de base importees depuis Neon (`users`, `trips`, `bookings`). Si RDS est vide, le workflow s'arrete avec un message clair : il faut importer Neon avant d'executer les migrations incrementales.

## Importer les donnees NeonDB vers AWS RDS

RDS est prive et accepte PostgreSQL uniquement depuis les taches ECS. L'import propre se fait donc avec une tache ECS Fargate temporaire, pas directement depuis ton PC.

Flux :

```text
NeonDB public
  |
  | pg_dump
  v
tache ECS temporaire dans le VPC
  |
  | pg_restore
  v
AWS RDS PostgreSQL prive
```

### 1. Appliquer Terraform

```bash
terraform apply \
  -var="github_owner=GroupeBH" \
  -var="github_repository=zwanga-api" \
  -var="github_branch=release" \
  -var="application_s3_bucket_name=medias-zwanga" \
  -var="enable_rekognition_permissions=true"
```

Terraform cree une task definition ECS dediee a l'import :

```bash
terraform output -raw database_import_task_definition_arn
```

### 2. Preparer le secret Neon dans SSM

Ne mets pas l'URL Neon dans GitHub ni dans Terraform. Stocke-la localement dans SSM :

```bash
cd /mnt/c/Users/hp/projects/zwanga-backend/infra-aws
bash scripts/put-neon-database-url-to-ssm.sh
```

Le script demande `NEON_DATABASE_URL` en saisie cachee et l'ecrit dans :

```text
/zwanga-api/production/migration/NEON_DATABASE_URL
```

### 3. Geler les ecritures cote Render/Neon

Avant l'import final :

- arrete temporairement le service Render ou mets l'application en maintenance ;
- si le service ECS AWS tourne deja, mets temporairement `desired-count` a `0` ;
- evite toute nouvelle inscription, reservation, paiement ou mise a jour de trajet ;
- garde Neon intact apres l'import, le temps de verifier AWS.

Exemple pour arreter temporairement l'application AWS avant l'import :

```bash
aws ecs update-service \
  --region "$(terraform output -raw aws_region)" \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" \
  --desired-count 0
```

### 4. Lancer l'import Neon vers RDS

```bash
bash scripts/run-neon-to-rds-import.sh
```

Le script lance une tache ECS Fargate qui execute :

```text
pg_dump Neon --format=custom --no-owner --no-acl --exclude-extension=postgis_sfcgal
pg_restore RDS --clean --if-exists --no-owner --no-acl --single-transaction
ANALYZE
```

Les logs sont dans CloudWatch :

```text
/ecs/zwanga-api-production/database-import
```

`postgis_sfcgal` est exclu du dump car Neon peut l'avoir activee alors qu'Amazon RDS PostgreSQL ne la fournit pas toujours. L'application Zwanga utilise PostGIS pour les positions GPS (`geography(Point,4326)`), donc l'extension `postgis` suffit pour les besoins applicatifs actuels.

Si les logs affichent un timeout vers Neon comme :

```text
connection to server at "...neon.tech", port 5432 failed: Operation timed out
```

cela signifie que la tache ECS ne peut pas sortir vers le PostgreSQL public de Neon. L'import utilise un Security Group dedie qui autorise uniquement :

- DNS vers le resolver VPC ;
- HTTPS vers AWS APIs/ECR/CloudWatch/SSM ;
- PostgreSQL prive vers RDS ;
- PostgreSQL public `5432` vers Neon pour la duree de l'import.

Applique Terraform avant de relancer l'import pour creer ce Security Group :

```bash
terraform apply \
  -var="application_s3_bucket_name=medias-zwanga" \
  -var="enable_rekognition_permissions=true"
```

Important : l'ancien projet utilisait `TYPEORM_SYNCHRONIZE=true`. La base Neon contient donc le schema initial reel, alors que les migrations TypeORM actuelles sont des migrations incrementales. Elles ne savent pas creer une base vide de zero. Le premier bootstrap AWS doit donc etre :

```text
1. Terraform cree RDS vide
2. Import Neon complet vers RDS
3. GitHub Actions execute les migrations incrementales restantes
4. ECS redeploie l'application
```

### 5. Verifier puis deployer

Apres l'import :

- verifie les logs CloudWatch de la tache ;
- lance ou relance le workflow GitHub Actions sur `release` ;
- le workflow executera `npm run database:assert-bootstrap:prod && npm run migration:run:prod` dans ECS avant de redeployer l'application ;
- teste `/health`, login, recherche de trajets, wallet, paiements et tracking.

Si tu ne redeploies pas immediatement via GitHub Actions, remets le service AWS a `1` :

```bash
aws ecs update-service \
  --region "$(terraform output -raw aws_region)" \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" \
  --desired-count 1
```

Ne supprime pas Neon tant que l'application AWS n'a pas ete verifiee avec les donnees importees.

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
