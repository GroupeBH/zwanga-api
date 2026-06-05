# Infrastructure Zwanga

Ce dossier contient maintenant deux cibles AWS separees:

- `ec2/`: l'infrastructure actuelle, basee sur EC2, VPC, Elastic IP, CloudWatch et Ansible.
- `lightsail/`: l'infrastructure low-cost pour le budget actuel de 15 USD/mois.

## Choix recommande maintenant

Avec le budget actuel, utilisez `infra/lightsail` et le workflow
`.github/workflows/aws-lightsail.yml`.

Le module Lightsail cree:

- 1 instance Ubuntu Lightsail;
- 1 IP statique attachee pour le DNS;
- les ports publics 80/443;
- SSH limite aux CIDR admin;
- Docker + Caddy + l'image backend via Ansible.

L'ancienne cible EC2 reste disponible dans `infra/ec2` et le workflow
`.github/workflows/aws.yml` pointe maintenant vers ce dossier.

Attention: si les deux workflows sont actifs sur la branche `release`, les deux
peuvent deployer. Gardez actif uniquement le workflow correspondant a la cible
que vous voulez utiliser en production.
