# Infrastructure AWS Lightsail Zwanga Backend

Cette cible est l'option low-cost pour le budget actuel de 15 USD/mois.

Par defaut, Terraform cree une seule instance Lightsail Ubuntu avec le bundle
`small_3_0`, une IP publique IPv4 statique attachee, et les ports 80/443 publics. Les logs
Docker restent locaux avec rotation pour eviter une dependance CloudWatch.

Postgres et Redis restent externes a AWS. Il faut autoriser l'IP statique
Lightsail cote fournisseur DB/cache.

## Budget

Valeurs par defaut:

- `monthly_budget_usd = 15`
- `estimated_monthly_usd = 12`
- `bundle_id = "small_3_0"`
- `ip_address_type = "ipv4"`

Cette estimation couvre l'instance Lightsail. Elle n'inclut pas les taxes, un
nom de domaine, les services externes, les snapshots, les excedents de trafic,
ou une IP statique laissee detachee.

## CI/CD GitHub Actions

Le workflow `.github/workflows/aws-lightsail.yml`:

1. valide Terraform et Ansible dans `infra/lightsail`;
2. construit l'image Docker de production;
3. pousse l'image vers Docker Hub;
4. applique Terraform Lightsail;
5. deploie l'image avec Ansible.

## Secrets GitHub

Secrets requis:

- `AWS_ROLE_TO_ASSUME`: role IAM assume par GitHub Actions via OIDC. L'ancien nom `AWS_ROLE_ARN` reste accepte.
- `LIGHTSAIL_SSH_PRIVATE_KEY`: cle privee SSH utilisee pour Ansible. Par defaut, utilisez la cle privee Lightsail regionale par defaut. Si absent, le workflow reutilise `EC2_SSH_PRIVATE_KEY`.
- `ANSIBLE_PRODUCTION_ENV`: contenu complet du `.env` de production. Vous pouvez aussi utiliser `LIGHTSAIL_ANSIBLE_PRODUCTION_ENV`.
- `DOCKERHUB_TOKEN`: token Docker Hub.
- `LIGHTSAIL_TF_STATE_BUCKET` ou `TF_STATE_BUCKET`: bucket S3 pour le state Terraform.

Secrets optionnels:

- `LIGHTSAIL_TFVARS_CONTENT`: contenu complet de `infra/lightsail/terraform/terraform.tfvars`.
- `LIGHTSAIL_TF_BACKEND_CONFIG_CONTENT`: contenu complet de `infra/lightsail/terraform/backend.hcl`.
- `LIGHTSAIL_SSH_PUBLIC_KEY`: cle publique a importer si vous voulez une cle dediee geree par Terraform au lieu de la cle par defaut Lightsail.

N'utilisez pas le `TFVARS_CONTENT` EC2 pour Lightsail: les variables ne sont pas
les memes et vous risquez de melanger les states.

## Variables GitHub

Variables recommandees:

- `AWS_REGION` ou `LIGHTSAIL_AWS_REGION`: par exemple `eu-central-1`.
- `APP_IMAGE_REPOSITORY`: par exemple `gbhsarl/zwanga-backend`.
- `DOCKERHUB_USERNAME`: utilisateur Docker Hub.
- `DOMAIN_NAME` ou `LIGHTSAIL_DOMAIN_NAME`: domaine public de l'API.
- `CADDY_EMAIL` ou `LIGHTSAIL_CADDY_EMAIL`: email Let's Encrypt.
- `ADMIN_CIDR`: votre IP admin permanente en `/32`.
- `ADMIN_SSH_CIDR_BLOCKS`: liste JSON d'IPs admin autorisees, par exemple `["203.0.113.10/32"]`.
- `LIGHTSAIL_BUNDLE_ID`: `small_3_0` par defaut.
- `LIGHTSAIL_KEY_PAIR_NAME`: nom d'une cle Lightsail existante, seulement si vous ne voulez pas la cle par defaut.
- `RUN_DB_MIGRATIONS`: `false` par defaut sur Lightsail. Gardez les migrations dans le workflow dedie.

Le workflow ajoute automatiquement l'IP du runner GitHub aux CIDR SSH pendant le
deploiement. Ajoutez aussi votre IP admin pour pouvoir vous connecter apres le
run.

Sur Lightsail, la restriction par IP de SSH se fait dans les ports publics
geres par Terraform. Le firewall local `ufw` laisse donc le port 22 ouvert par
defaut (`restrict_ssh_with_host_firewall: false`) afin qu'un nouveau runner
GitHub, avec une IP differente du run precedent, ne soit pas bloque avant
qu'Ansible puisse se connecter.

## Deploiement local

Depuis la racine du projet:

```bash
cp infra/lightsail/terraform/backend.hcl.example infra/lightsail/terraform/backend.hcl
cp infra/lightsail/terraform/terraform.tfvars.example infra/lightsail/terraform/terraform.tfvars
```

Puis:

```bash
PRIVATE_KEY_PATH=~/.ssh/zwanga-lightsail.pem \
APP_ENV_FILE=./infra/lightsail/ansible/env/production.env \
./infra/lightsail/deploy.sh
```

Sans `key_pair_name` ni `ssh_public_key`, Terraform laisse Lightsail utiliser
la cle par defaut de la region. Le fichier passe dans `PRIVATE_KEY_PATH` doit
donc etre cette cle privee par defaut.

Ou en surchargeant l'image:

```bash
./infra/lightsail/deploy.sh \
  --private-key ~/.ssh/zwanga-lightsail.pem \
  --app-env-file ./infra/lightsail/ansible/env/production.env \
  --app-image-repository gbhsarl/zwanga-backend \
  --app-image-tag latest
```

## DNS

Pointez votre domaine vers l'output Terraform `public_ip`. Si `domain_name` est
configure, Caddy demandera automatiquement un certificat Let's Encrypt.

## Migrations DB

Le deploiement Lightsail ne lance pas les migrations par defaut. Utilisez le
workflow `.github/workflows/aws-lightsail-migrations.yml` apres le deploiement,
quand la base managée est joignable et que les variables DB du secret
`LIGHTSAIL_ANSIBLE_PRODUCTION_ENV` ou `ANSIBLE_PRODUCTION_ENV` sont correctes.

Ce workflow est manuel. Il prend un input `app_image_tag`, ouvre SSH pour l'IP
du runner GitHub dans les ports Lightsail via Terraform, puis lance
`npm run migration:run:prod` dans un conteneur one-shot sur l'instance
Lightsail. La migration part donc de l'IP statique Lightsail, pas directement
du runner GitHub.
