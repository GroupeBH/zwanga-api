# Infrastructure AWS de Zwanga

Ce dossier provisionne l'infrastructure AWS du backend NestJS en Terraform. La variante appliquee ici est la version propre economique : ECS Fargate au lieu d'App Runner, taches ECS en subnets publics sans NAT Gateway, RDS et Redis prives, monitoring AWS natif.

## Documentation obligatoire des modifications

Chaque modification ou opération AWS doit être décrite dans le [journal détaillé](./docs/CHANGELOG.md) en suivant le [modèle de changement](./docs/change-template.md). Le [guide documentaire](./docs/README.md) précise le périmètre, les preuves attendues et les informations qui ne doivent jamais être copiées. Un contrôle GitHub Actions fait échouer la pull request et le déploiement AWS lorsque ce journal n'est pas mis à jour.

## Retour au déploiement historique — 8 octobre 2026

**Mise à jour du 10 octobre :** les correctifs d'audit préparent maintenant une
révision ECS par digest et un circuit breaker, sans réintroduire d'étapes de
transition financière. Appliquer d'abord les nouvelles permissions IAM, puis
lancer le workflow. Une modification Terraform/SSM nécessite ensuite un
workflow pour être activée. Voir le [guide de livraison](../docs/operations/audit-hardening-2026-10-10.md).

Historique du changement du 8 octobre :

À la demande de l'utilisateur, le workflow de production et la configuration
Terraform ont été remis à leur état du commit `6a45121`, avant l'orchestration
de transition. Les fichiers de staging préparés localement ont été retirés.
Cette modification concerne le dépôt uniquement : aucun changement AWS appliqué.

Le pipeline publie de nouveau le tag du commit et `latest`, exécute les migrations
TypeORM avec la définition ECS du service, puis force son redéploiement. Il
n'exécute plus les étapes `prepare` / `activate`, ne fixe plus une image de secours
par digest et n'attend plus explicitement l'arrêt de tous les anciens serveurs.

**Limites à vérifier avant production :** les fonctionnalités et migrations
applicatives récentes sont conservées. La migration `1780000056000` peut laisser
`financial_rollout.enabled=false` lorsqu'aucun historique de commission cash
n'existe ; l'ancien pipeline ne réalise pas l'activation différée. Un `/health`
vert ne prouve pas que ces nouveaux contrôles cash sont actifs. Aucune activation
ou modification financière n'a été effectuée pendant ce retour au CI/CD historique.
Si la définition ECS réelle pointe déjà vers un digest ou un ancien tag de commit,
republier `latest` et forcer un déploiement ne change pas cette image : vérifier
la définition réellement utilisée, les migrations et les sauvegardes avant toute
relance. Ne pas lancer de régression des migrations pour restaurer le pipeline.

Voir le [journal de ce retour](./docs/CHANGELOG.md#infra-2026-10-08-002--retour-au-cicd-et-à-linfrastructure-antérieurs).

## Architecture

### Staging économique à la demande — 10 octobre 2026

**Configuration préparée ; aucune ressource staging créée à ce stade.** Le choix
retenu remplace la proposition ECS/RDS permanente : un EC2 `t4g.medium` ARM64,
Ubuntu 24.04, disque gp3 chiffré de 30 GiB, arrêté entre les séances de test.
Le workflow de production et ses ressources Terraform restent inchangés.

- **Terraform** : racine indépendante `environments/staging/`, state
  `zwanga/staging/terraform.tfstate`, compte `046374119247`, région `eu-central-1`,
  réseau dédié `10.43.0.0/16`, rôles IAM, SSM, ECR et buckets privés staging.
- **Ansible** : `ansible/configure.yml` installe Docker et Compose, configure
  Caddy et les unités systemd. Cloud-init installe seulement les outils de
  bootstrap et transmet les fichiers au playbook. SSM exécute Ansible **localement
  sur EC2** ; aucun port SSH ni clé SSH n'est requis. Pas de connexion Ansible SSH.
- **Docker Compose** : backend NestJS, PostgreSQL/PostGIS, Valkey 7.2.6 et Caddy.
  Images backend/PostgreSQL construites en CI ARM64 et référencées par SHA Git
  immuable, jamais `latest`. L'image PostGIS est construite sur `postgres:18.3-trixie`
  car `postgis/postgis` ne fournit pas ARM64. Disques des conteneurs persistants.
- **Caddy** : HTTPS automatique et proxy HTTP/WebSocket vers `api:5200`, sur
  `staging.compute-api.zwanga-app.com`. Seuls 80/443 sont publics ; API en loopback,
  PostgreSQL/Valkey sans publication de ports. Certificats conservés sur disque.
- **Arrêt** : timer systemd à deux heures depuis le démarrage, doublé d'un contrôle
  Lambda/EventBridge toutes les cinq minutes, indépendant de la santé du serveur.
  Un nouvel appel `start` ne prolonge pas une séance active. Un échec GitHub
  déclenche aussi un arrêt ; le watchdog couvre les runners interrompus.
- **DNS** : pas d'Elastic IP facturée à l'arrêt. Le contrôleur met à jour uniquement
  l'enregistrement A du staging au démarrage et le neutralise à l'arrêt. Après un
  arrêt hors workflow, prévoir jusqu'à cinq minutes plus le TTL de 60 s pour cette
  neutralisation. Aucun enregistrement de production n'est modifiable par ce rôle.

Il n'y a ni ALB, ni NAT Gateway, ni RDS, ni ElastiCache supplémentaires. Les tests
fonctionnels utilisent le même code applicatif, mais ne valident pas la parité
d'infrastructure ECS/RDS/IAM/ALB. PostgreSQL/Valkey communiquent dans le réseau Docker
local sans TLS, contrairement aux services managés. Pas de haute disponibilité.

#### Budget et limites

Tarifs relevés le 9 octobre 2026 à Francfort : EC2 0,0384 USD/h, gp3
0,0952 USD/Go/mois et IPv4 0,005 USD/h. Socle disque/serveur/IP : environ
2,86 USD/mois sans utilisation, 3,07 USD pour 5 h, 3,72 USD pour 20 h.
Budget indicatif **5–8 USD/mois** avec peu de données et d'images : ce n'est pas
un plafond. Hors taxes, trafic, sauvegardes supplémentaires et fournisseurs.
Le disque, ECR/S3, les logs et le contrôle périodique restent facturables à l'arrêt.
Les crédits CPU sont en mode Standard : pas de supplément Unlimited, mais une
charge soutenue peut être bridée. Nettoyer manuellement les anciennes images
taguées/artefacts et les sauvegardes locales après revue ; ne pas supprimer
l'image de `last-release.json`. Pas de rétention automatique des données de test.

#### Premier provisionnement

Depuis la racine du dépôt, avec Terraform >= 1.11, après revue du code et du budget :

```bash
terraform -chdir=infra-aws/environments/staging init -reconfigure
terraform -chdir=infra-aws/environments/staging validate
terraform -chdir=infra-aws/environments/staging test
terraform -chdir=infra-aws/environments/staging plan -out=tfplan
# Examiner chaque action : seulement des ressources staging, aucun remplacement prod.
terraform -chdir=infra-aws/environments/staging apply tfplan
terraform -chdir=infra-aws/environments/staging output github_repository_variables
```

Ne jamais utiliser `-migrate-state`, copier le state production ou appliquer depuis
`infra-aws/` pour créer le staging. Régénérer le plan après toute modification.
Le premier démarrage installe Ansible/Docker, puis demande l'arrêt du serveur.
Attendre cet arrêt et vérifier cloud-init/SSM avant de lancer une séance.

Configurer les variables GitHub `STAGING_AWS_ROLE_ARN` et `STAGING_INSTANCE_ID`
avec les outputs ; `STAGING_AWS_REGION` est fourni mais la région du workflow est
volontairement fixée à `eu-central-1`. Publier le workflow sur la branche par défaut
pour l'afficher dans Actions, et le code à tester sur `staging`. OIDC autorise
**uniquement** `refs/heads/staging`. Aucun déploiement staging automatique au push.

#### Initialiser une base sans données personnelles

Les migrations sont incrémentales : elles ne créent pas le schéma initial.
Ne pas activer `TYPEORM_SYNCHRONIZE`, importer un dump complet ou marquer toutes
les migrations comme exécutées sur un schéma créé seulement à partir des entités.

L'outil `environments/staging/export-baseline.cjs` exporte depuis un même snapshot
**en lecture seule** : schéma `public`, historique `typeorm_migrations` et seul
booléen `financial_rollout.enabled`. Aucun compte, portefeuille, paiement, KYC,
session ou token push. Il ne charge aucun `.env` et ne contacte pas AWS.

1. Fournir explicitement `STAGING_BASELINE_SOURCE_URL` dans l'environnement d'un
   poste ayant accès à la source approuvée, sans coller sa valeur dans le terminal
   ou le journal. Pour une source distante, fournir aussi `STAGING_BASELINE_CA_FILE`
   (TLS vérifié). Installer `pg_dump` 18 ; `STAGING_BASELINE_PG_DUMP` permet de
   préciser son chemin. Aucun accès réseau à RDS n'est ouvert automatiquement.
2. Exécuter `node infra-aws/environments/staging/export-baseline.cjs
   infra-aws/environments/staging/baseline-reviewed <SHA_COMPLET_IMAGE_SOURCE>`.
   Le dossier de sortie doit être nouveau. Le SHA est celui du code réellement
   associé au schéma source, pas arbitrairement le HEAD local.
3. Revoir `schema.dump` avec `pg_restore --list` et, si nécessaire, sa version SQL ;
   revoir le manifeste et son choix de politique financière. Un schéma contient
   des fonctions exécutables : n'accepter qu'une source de confiance. Uploader
   **uniquement** `schema.dump` et `manifest.json` sous `bootstrap/` du bucket
   `zwanga-staging-artifacts-046374119247`. Le rôle GitHub n'a pas ce droit : cette
   étape est réservée à l'opérateur de bootstrap. Ne pas committer ces artefacts.
4. Lancer l'action GitHub `bootstrap` sur la branche `staging`, puis `deploy`.
   L'import refuse un dump contenant des données et toute base non vide ; il
   restaure en une transaction, puis installe les métadonnées et droits. En cas
   d'import partiel, l'API reste bloquée : inspecter, ne pas relancer un nettoyage
   destructeur ni effacer le marqueur aveuglément.
5. Créer ensuite les comptes et paramètres métier **fictifs** nécessaires aux tests.
   L'export ne copie pas les catalogues/configurations métier autres que le booléen
   financier ; les fixtures et la recette restent nécessaires.

Le compte API PostgreSQL n'est pas superutilisateur ; un propriétaire distinct
exécute les migrations. Les secrets locaux (DB, cache, JWT) sont générés sur EC2,
conservés dans des fichiers root-only sur EBS chiffré et réutilisés au redémarrage.
Une sauvegarde locale précède chaque migration. Un échec de migration/santé pose
un verrou de déploiement : le prochain boot ne relance pas une ancienne API contre
un schéma potentiellement avancé. Corriger puis redéployer ; pas de rollback SQL
automatique. Une sauvegarde sur le même disque n'est pas une sauvegarde hors site.

#### Intégrations de test et utilisation

Le seul paramètre `/zwanga-api/staging/integrations` est un `SecureString` JSON,
initialement `{}`, créé avec `value_wo` pour ne pas stocker sa valeur dans le state.
Ne pas incrémenter `value_wo_version` pour gérer les clés : cela réinitialiserait le
JSON. Renseigner dans la console SSM les clés **de test** nécessaires :
Didit (`DIDIT_OTP_API_KEY`, etc.), cartographie, Firebase (`FCM_CREDENTIALS_BASE64`
ou `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY`), pawaPay sandbox, bootstrap
admin. Les noms autorisés figurent dans `host/runtime.py`. Les clés Firebase privées
restent encodées en base64 comme attendu par le backend. Ne pas réutiliser les
comptes/tokens push de production. La taille SSM Standard limite ce JSON à 4 KiB ;
pour davantage de secrets, revoir le découpage avant activation.

Les paramètres DB/JWT/AWS/domaine et l'URL pawaPay ne peuvent pas être remplacés
par ce JSON. pawaPay reste borné au sandbox et ses opérations sont désactivées par
défaut ; FlexPaie n'est pas configuré. Didit KYC est initialement désactivé, les OTP
réels nécessitent un compte crédité. Rien ne simule automatiquement la réussite
des fournisseurs. Configurer leurs callbacks staging avant de tester ces flux.

Dans Actions → **Staging EC2 on demand**, choisir la branche `staging` :

| Action | Effet |
| --- | --- |
| `bootstrap` | Test/build, démarrage, configuration Ansible et premier import revu ; aucune API activée |
| `deploy` | Test/build avant démarrage, Ansible, sauvegarde, migrations, conteneurs puis contrôle HTTPS |
| `start` | Démarre et reprend le dernier déploiement réussi sans reconstruire les images |
| `stop` | Neutralise le DNS et arrête EC2, sans supprimer les données |
| `status` | Affiche l'état et le temps restant sans démarrer le serveur |

Configurer seulement l'application mobile **de développement** avec l'URL staging ;
aucune modification des versions stores ou de leur API de production. Prévoir
quelques minutes au démarrage et les premières émissions de certificats HTTPS.

#### Vérifications et exploitation

```bash
python3 -m unittest discover -s infra-aws/environments/staging/tests -p 'test_*.py'
ansible-playbook -i localhost, --syntax-check infra-aws/environments/staging/ansible/deploy.yml
```

Le test PostgreSQL réel est opt-in via `STAGING_TEST_POSTGRES_BIN` : nouveau cluster
temporaire, port loopback aléatoire, arrêt/nettoyage en fin de test, aucune lecture
du `.env`. La recette AWS doit vérifier Ansible, ARM64/PostGIS, redémarrage avec
données/certificats, migrations, HTTPS/WebSocket, absence d'accès aux ressources
de production et les deux mécanismes d'arrêt. Surveiller EBS, mémoire, CPU/crédits,
logs Docker bornés, erreurs du contrôleur et facture AWS. `prevent_destroy` et la
conservation EBS empêchent une suppression automatique du serveur/données ; un
remplacement d'AMI nécessite sauvegarde et plan de restauration explicites.

Voir le [journal du staging](./docs/CHANGELOG.md#infra-2026-10-10-001--staging-ec2-à-la-demande-avec-ansible-docker-et-caddy).

### Architecture de production (inchangée)

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

Pour importer uniquement une famille de variables sans écraser le reste des
paramètres runtime, utilise `-IncludeNames` :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra-aws\scripts\import-env-to-ssm.ps1 `
  -EnvFile .\.env.production `
  -IncludeNames KYC_PROVIDER,DIDIT_KYC_ENABLED,DIDIT_API_KEY,DIDIT_WORKFLOW_ID,DIDIT_WEBHOOK_SECRET,DIDIT_WEBHOOK_REQUIRE_SIGNATURE,DIDIT_WEBHOOK_TOLERANCE_SECONDS
```

Utilise un fichier `.env.production` separe de ton `.env` local. Les valeurs locales et production ne doivent pas etre melangees. Le script refuse d'importer `.env` vers l'environnement `production`, sauf si tu passes explicitement `-AllowLocalEnvForProduction`.

Le script cree les parametres `/zwanga-api/production/env/*` en `SecureString`. Au prochain `terraform apply`, Terraform decouvre automatiquement ces parametres et les injecte dans la definition ECS via le bloc `secrets`, sans lire les valeurs en clair.

Le role d'execution ECS lit les parametres SSM au moyen d'une autorisation IAM
bornee au prefixe de l'environnement, par exemple
`/zwanga-api/production/*`. La task definition continue de referencer les
parametres exacts a injecter, mais la policy IAM n'enumere plus chaque ARN un
par un afin d'eviter la limite AWS de 10 240 bytes sur les policies inline.

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
