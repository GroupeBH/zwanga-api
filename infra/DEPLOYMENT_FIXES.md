# Correctifs Deploiement AWS

Derniere mise a jour: 2026-05-20.

Ce document liste les problemes rencontres pendant la mise en place du
deploiement AWS, les causes identifiees, les changements appliques, et les
verifications a faire apres un run GitHub Actions.

## 1. Authentification AWS GitHub Actions

Probleme:

- Eviter de stocker `AWS_ACCESS_KEY_ID` et `AWS_SECRET_ACCESS_KEY` dans GitHub.
- Reduire le risque lie aux cles AWS longue duree.

Changement applique:

- Le workflow utilise OIDC avec `AWS_ROLE_TO_ASSUME`.
- GitHub Actions recoit des credentials temporaires via AWS STS.

Fichiers concernes:

- `.github/workflows/aws.yml`

Secrets/variables attendus:

- Secret: `AWS_ROLE_TO_ASSUME`
- Permission workflow: `id-token: write`

Verification:

```bash
aws sts get-caller-identity
```

Dans GitHub Actions, l'etape `Configure AWS credentials` doit passer sans
`AWS_ACCESS_KEY_ID` permanent configure dans les secrets du repo.

## 2. Permission SSH EC2 `Permission denied (publickey)`

Probleme:

- Ansible echouait sur SSH avec:

```text
Permission denied (publickey)
```

Cause:

- Les instances EC2 avaient ete creees sans key pair, ou avec un `key_name`
  different de la cle privee stockee dans `EC2_SSH_PRIVATE_KEY`.
- Changer le secret GitHub ne change pas la cle SSH d'une instance deja lancee.

Changement applique:

- Le workflow ecrit `EC2_SSH_PRIVATE_KEY` dans un fichier temporaire.
- Le workflow derive automatiquement la cle publique avec `ssh-keygen -y`.
- `deploy.sh` passe cette cle publique a Terraform via `ssh_public_key`.
- Terraform cree un `aws_key_pair.deploy` correspondant exactement a la cle
  privee GitHub.
- En CI, `deploy.sh` force `key_name` et `existing_key_name` a vide quand une
  cle publique est fournie, afin d'eviter les anciennes valeurs de
  `TFVARS_CONTENT`.

Fichiers concernes:

- `.github/workflows/aws.yml`
- `infra/deploy.sh`
- `infra/terraform/compute.tf`
- `infra/terraform/locals.tf`
- `infra/terraform/terraform.tfvars.example`
- `infra/README.md`

Regle actuelle:

- En CI, ne mettez pas `key_name` dans `TFVARS_CONTENT`.
- Le secret `EC2_SSH_PRIVATE_KEY` doit contenir le contenu complet de la cle
  privee PEM/OpenSSH.

Verification:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=zwanga-api-primary" \
  --query "Reservations[].Instances[].{Id:InstanceId,Key:KeyName,PublicIp:PublicIpAddress,State:State.Name}" \
  --output table
```

La colonne `Key` doit contenir un nom du type:

```text
zwanga-prod-deploy-xxxxxxxx
```

## 3. Caddy en redemarrage permanent

Probleme:

- Ansible echouait sur la validation Caddy avec:

```text
Container ... is restarting
```

Cause initiale masquee:

- La validation etait faite dans le conteneur Caddy deja en redemarrage.
- Les logs Caddy n'etaient pas imprimes automatiquement.

Changement applique:

- Le playbook valide maintenant le `Caddyfile` avant `docker compose up` avec
  un conteneur one-shot.
- Le playbook attend explicitement que le conteneur Caddy soit `running`.
- En cas d'echec, le playbook imprime:
  - `docker compose ps`
  - `docker compose logs caddy --tail=200`

Fichier concerne:

- `infra/ansible/playbooks/deploy.yml`

Verification:

```bash
cd /opt/zwanga
sudo docker compose ps
sudo docker compose logs caddy --tail=200
```

## 4. `Caddyfile: permission denied`

Probleme:

- Les logs Caddy affichaient:

```text
Error: reading config from file: open /etc/caddy/Caddyfile: permission denied
```

Cause:

- Le `Caddyfile` etait genere en `0640`.
- Le repertoire `/opt/zwanga` etait en `0750`.
- Le process Caddy dans le conteneur ne pouvait pas lire le fichier monte.

Changement applique:

- `/opt/zwanga` passe en `0755`.
- `docker-compose.yml` passe en `0644`.
- `Caddyfile` passe en `0644`.
- `.env` reste en `0600`, car il contient les secrets applicatifs.

Fichier concerne:

- `infra/ansible/playbooks/deploy.yml`

Verification rapide sur une instance:

```bash
ls -ld /opt/zwanga
ls -l /opt/zwanga/Caddyfile /opt/zwanga/docker-compose.yml /opt/zwanga/.env
cd /opt/zwanga
sudo docker compose up -d caddy
sudo docker compose ps
```

Permissions attendues:

```text
/opt/zwanga              drwxr-xr-x
/opt/zwanga/Caddyfile    -rw-r--r--
/opt/zwanga/docker-compose.yml -rw-r--r--
/opt/zwanga/.env         -rw-------
```

## 5. Migrations base de donnees

Etat actuel:

- Le workflow AWS deploie l'image Docker et l'infra.
- Il ne lance pas encore de migration TypeORM automatiquement.
- `TYPEORM_SYNCHRONIZE=false` reste la norme, y compris en prod.

Probleme evite:

- TypeORM ne doit pas modifier le schema automatiquement au demarrage de
  l'application, surtout avec deux instances applicatives.

Action manuelle requise pour les changements SQL:

```bash
psql "$DATABASE_URL" -f migrations/prevent-multiple-active-driver-trips.sql
```

Evolution recommandee:

- Ajouter une etape de migration controlee avant le redemarrage applicatif,
  avec un job unique ou un conteneur temporaire execute une seule fois.

## 6. Checklist avant relance du workflow

Secrets GitHub requis:

- `AWS_ROLE_TO_ASSUME`
- `EC2_SSH_PRIVATE_KEY`
- `ANSIBLE_PRODUCTION_ENV`
- `DOCKERHUB_TOKEN`
- `TFVARS_CONTENT`
- `TF_BACKEND_CONFIG_CONTENT`

Variables GitHub recommandees:

- `AWS_REGION`
- `APP_IMAGE_REPOSITORY`
- `DOCKERHUB_USERNAME`
- `DOMAIN_NAME`
- `CADDY_EMAIL`
- `INSTANCE_TYPE`
- `ADMIN_SSH_CIDR_BLOCKS`

Points a verifier:

- `TFVARS_CONTENT` ne contient pas `key_name` en CI.
- `EC2_SSH_PRIVATE_KEY` contient bien toute la cle privee, avec les lignes
  `BEGIN` et `END`.
- Le domaine `DOMAIN_NAME` pointe vers l'Elastic IP primaire.
- Le fournisseur Postgres/Redis autorise les Elastic IPs des EC2.
- Les migrations SQL necessaires ont ete appliquees manuellement tant que le
  workflow ne gere pas encore les migrations.
