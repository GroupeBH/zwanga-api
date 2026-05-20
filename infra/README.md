# Infrastructure AWS Zwanga Backend

Ce dossier est aligne sur le modele `zwanga-infra`: Terraform provisionne AWS, GitHub Actions construit une image Docker immutable, puis Ansible deploie cette image sur les noeuds EC2.

## Architecture

```text
Internet
  -> DNS externe
     -> IP publique active, ou les deux IPs si le DNS supporte le failover
        -> Caddy sur EC2 primary ou secondary
           -> conteneur API local
           -> conteneur API peer via IP privee VPC
```

Par defaut:

- 1 VPC.
- 2 subnets publics dans 2 AZ si disponibles.
- 2 EC2 Ubuntu quand `secondary_instance_enabled = true`.
- 2 Elastic IPs.
- 1 security group partage.
- Caddy sur chaque EC2.
- 1 conteneur `zwanga-api` par EC2.
- Logs Docker envoyes vers CloudWatch avec le driver `awslogs`.
- Alarmes CloudWatch pour les status checks EC2.

Postgres et Redis restent externes a AWS. Il faut autoriser les Elastic IPs des EC2 cote fournisseur DB/cache.

## CI/CD GitHub Actions

Le workflow `.github/workflows/aws.yml` se lance sur chaque push vers `master`.

Il fait:

1. `npm ci`.
2. `npm run build`.
3. build Docker de l'image de production.
4. push vers Docker Hub avec les tags `${GITHUB_SHA}` et `latest`.
5. soit il declenche le repo `zwanga-infra` existant via `repository_dispatch`;
6. soit il execute le dossier `infra/` local: Terraform apply, generation de l'inventaire Ansible, puis deploiement en `serial: 1`.

Cette approche evite de construire l'image sur l'EC2. La prod tire une image deja construite et identifiee par le commit Git.

Mode recommande si `zwanga-infra` est deja le repo d'infra en production:

- mettez `INFRA_REPOSITORY=owner/zwanga-infra` dans les variables GitHub de ce repo backend;
- ajoutez le secret `INFRA_REPO_TOKEN`;
- le backend ne fera alors que build/push l'image et declencher `zwanga-infra`.

Mode autonome:

- laissez `INFRA_REPOSITORY` vide;
- ce repo executera son propre Terraform + Ansible depuis `infra/`.

## Secrets GitHub

Secrets requis:

- `AWS_ROLE_TO_ASSUME`: role IAM assume par GitHub Actions via OIDC. L'ancien nom `AWS_ROLE_ARN` reste accepte.
- `EC2_SSH_PRIVATE_KEY`: cle privee SSH utilisee par GitHub Actions. Le workflow derive la cle publique et Terraform cree le key pair EC2 correspondant.
- `ANSIBLE_PRODUCTION_ENV`: contenu complet du fichier `.env` de production.
- `DOCKERHUB_TOKEN`: token Docker Hub.
- `INFRA_REPO_TOKEN`: token GitHub pour declencher `zwanga-infra`, requis seulement si `INFRA_REPOSITORY` est defini.
- `TFVARS_CONTENT`: contenu complet de `infra/terraform/terraform.tfvars`.
- `TF_BACKEND_CONFIG_CONTENT`: contenu complet de `infra/terraform/backend.hcl`.

`TFVARS_CONTENT` et `TF_BACKEND_CONFIG_CONTENT` sont requis seulement en mode autonome. Alternative backend: au lieu de `TF_BACKEND_CONFIG_CONTENT`, vous pouvez utiliser `TF_STATE_BUCKET`, `TF_STATE_KEY`, `TF_STATE_REGION`.

## Variables GitHub

Variables recommandees:

- `AWS_REGION`: par exemple `eu-central-1`.
- `APP_IMAGE_REPOSITORY`: par exemple `gbhsarl/zwanga-backend`.
- `DOCKERHUB_USERNAME`: utilisateur Docker Hub.
- `DOMAIN_NAME`: domaine public de l'API.
- `CADDY_EMAIL`: email Let's Encrypt.
- `ADMIN_CIDR`: votre IP admin permanente en `/32`, optionnel si deja dans `TFVARS_CONTENT`.
- `ADMIN_SSH_CIDR_BLOCKS`: liste JSON d'IPs admin autorisees, par exemple `["203.0.113.10/32"]`. Le workflow ajoute automatiquement l'IP du runner GitHub.
- `INSTANCE_TYPE`: par exemple `t3.micro` ou `t3.small`.
- `INFRA_REPOSITORY`: repo infra a declencher, par exemple `gbhsarl/zwanga-infra`. Laissez vide pour utiliser `infra/` localement.

## Fichiers Terraform

Copiez les exemples pour un deploiement local:

```bash
cp infra/terraform/backend.hcl.example infra/terraform/backend.hcl
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

Valeurs importantes dans `terraform.tfvars`:

- `key_name`: optionnel en local seulement, si vous voulez reutiliser un key pair EC2 existant. En CI, ne le mettez pas dans `TFVARS_CONTENT`; le workflow genere la cle publique depuis `EC2_SSH_PRIVATE_KEY`.
- `admin_cidr`: IP admin en `/32`.
- `secondary_instance_enabled`: active le second noeud.
- `domain_name` et `caddy_email`: domaine TLS Caddy.
- `app_image_repository`: repository Docker Hub.
- `app_image_tag`: tag a deployer, souvent surcharge par GitHub Actions.

## Deploiement local

Depuis la racine du projet:

```bash
PRIVATE_KEY_PATH=~/.ssh/zwanga.pem \
APP_ENV_FILE=./infra/ansible/env/production.env \
./infra/deploy.sh
```

Ou en surchargeant l'image:

```bash
./infra/deploy.sh \
  --private-key ~/.ssh/zwanga.pem \
  --app-env-file ./infra/ansible/env/production.env \
  --app-image-repository gbhsarl/zwanga-backend \
  --app-image-tag latest
```

## Strategie DNS

Le modele reste low-cost:

- mode simple: le DNS pointe vers l'Elastic IP primary;
- Caddy primary load-balance vers l'API locale et l'API secondary via IP privee;
- en incident EC2 primary, basculez le DNS vers l'Elastic IP secondary;
- utilisez un TTL court, par exemple 60 ou 120 secondes.

Si vous voulez une vraie disponibilite active-active avec TLS sans compromis, l'evolution naturelle est un Application Load Balancer AWS devant les deux EC2.

## Migrations DB

`TYPEORM_SYNCHRONIZE=false` doit rester la norme en prod. Les migrations doivent etre creees, relues et committees avec le code, puis executees de facon controlee avant le deploiement applicatif.

Pour l'instant, ce workflow deploie l'image et l'infra. L'etape migration peut etre ajoutee ensuite dans Ansible avec un service Docker temporaire, une fois le `DataSource` TypeORM CLI et les scripts `migration:*` finalises.
