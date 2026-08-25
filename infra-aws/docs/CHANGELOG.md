# Journal détaillé des changements d'infrastructure AWS

Les entrées sont classées de la plus récente à la plus ancienne. Elles décrivent le code versionné et les opérations réellement exécutées sur AWS, sans inclure de valeur secrète.

## INFRA-2026-08-25-002 — Gouvernance documentaire obligatoire

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 25 août 2026 |
| Environnements | tous |
| Statut | implémenté et validé localement |
| Type | documentation, contrôle qualité et CI/CD |
| Déclencheur | exigence de documenter chaque modification ou mise à jour d'infrastructure |

### Contexte et objectif

L'infrastructure possédait un guide d'installation complet, mais aucun registre imposant de documenter séparément chaque évolution, son risque, ses preuves et son retour arrière. Une modification Terraform pouvait donc être fusionnée sans conserver son contexte opérationnel.

L'objectif est de rendre la documentation indissociable du changement Git et de fournir un historique exploitable lors d'un incident, d'un audit de sécurité, d'une estimation de coût ou d'un retour arrière.

### Modifications réalisées

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `infra-aws/docs/README.md` | règles, périmètre et responsabilités | définir ce qui doit être documenté |
| `infra-aws/docs/change-template.md` | modèle détaillé réutilisable | uniformiser le niveau de preuve |
| `infra-aws/docs/CHANGELOG.md` | registre chronologique | conserver l'historique réel |
| `infra-aws/scripts/check-infra-documentation.sh` | comparaison Git entre base et tête | détecter une modification sans journal |
| `.github/workflows/infra-documentation.yml` | contrôle sur pull request et branche `release` | empêcher la fusion ou le déploiement non documenté |
| `.github/workflows/deploy.yml` | contrôle documentaire placé avant les tests et le build | empêcher directement un déploiement AWS non documenté |
| `infra-aws/README.md` | liens et organisation actualisée | rendre le processus visible dès l'entrée dans le dossier |

Le contrôle couvre Terraform, les scripts AWS, les workflows AWS, le `Dockerfile`, les fichiers Compose déployables et leur exemple d'environnement Docker. Les modifications limitées au dossier documentaire ne sont pas considérées comme des mutations d'infrastructure.

### Informations exigées

Chaque entrée doit décrire le contexte, l'état avant/après, les fichiers et ressources, les variables sans leurs secrets, les impacts disponibilité/sécurité/données/coûts, la procédure de déploiement, les validations, la surveillance et le retour arrière.

Le contrôle automatique exige que `infra-aws/docs/CHANGELOG.md` change en même temps qu'un fichier d'infrastructure. La qualité et l'exactitude des informations restent soumises à la revue humaine.

### Impacts

- Disponibilité et données : aucun changement sur une ressource AWS ou sur les données applicatives.
- Sécurité : réduction du risque de modification IAM, SSM ou réseau non tracée ; interdiction explicite de documenter les valeurs secrètes.
- Coût AWS : aucun.
- CI : ajout d'un job Ubuntu limité à cinq minutes et utilisant uniquement Git ; coût GitHub Actions faible.
- Exploitation : toute évolution d'infrastructure nécessite désormais une entrée documentaire dans le même changement.

### Validation réalisée

| Contrôle | Résultat |
| --- | --- |
| Analyse syntaxique Bash du script | réussie |
| Exécution locale sur les changements non commités | réussie, journal détecté |
| Vérification du YAML du workflow | réussie |
| `git diff --check` | réussi |

### Déploiement, surveillance et retour arrière

Le workflow devient actif après son arrivée sur GitHub. Le workflow de déploiement exécute aussi le contrôle avant toute construction d'image, migration ou mutation ECS. Son résultat doit en complément être déclaré obligatoire dans la protection de la branche `release` afin de bloquer les pull requests non conformes avant fusion.

En cas de faux positif, corriger le périmètre dans le script et documenter la correction. Le retour arrière consiste à retirer le workflow et le script ; il n'affecte aucune ressource AWS, mais il supprime la garantie automatique et doit donc être explicitement approuvé et journalisé.

## INFRA-2026-08-25-001 — Protection et restauration du paramètre S3 ECS

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 25 août 2026 |
| Environnement | production, `eu-central-1` |
| Statut | appliqué et validé |
| Type | Terraform, SSM Parameter Store et ECS Fargate |
| Déclencheur | échec de la tâche de migration du workflow GitHub Actions |

### Contexte et symptôme

La tâche ECS temporaire chargée d'exécuter les migrations TypeORM ne démarrait pas. ECS retournait `ResourceInitializationError` et signalait comme paramètre invalide `/zwanga-api/production/env/AWS_S3_BUCKET_NAME`. Aucun flux applicatif ni aucune migration n'avait commencé, ce qui expliquait l'absence de flux CloudWatch pour le conteneur et le code de sortie inconnu.

Les déploiements précédents réussissaient parce que ce paramètre existait encore au moment où leurs tâches ECS démarraient.

### Cause racine vérifiée

CloudTrail a enregistré le 25 août 2026 à `14:51:29Z` un appel `DeleteParameter` pour `/zwanga-api/production/env/AWS_S3_BUCKET_NAME`. L'agent appelant était Terraform `1.14.6` avec `terraform-provider-aws 6.58.0`, sous l'opérateur `eugene`.

`aws_ssm_parameter.application_s3_bucket_name` était conditionné par `application_s3_bucket_name != null`. Un `terraform apply` de production lancé sans cette variable a donc planifié la suppression du paramètre. Pendant le même cycle, la source de données d'auto-découverte SSM pouvait encore voir le nom existant et le classer comme variable externe lorsque la variable Terraform était `null`. La définition ECS conservait alors une référence vers le paramètre que Terraform supprimait.

### Modifications du dépôt

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `infra-aws/variables.tf` | `application_s3_bucket_name` obligatoire en production et validation du nom | empêcher un apply destructeur par omission |
| `infra-aws/variables.tf` | interdiction de `AWS_S3_BUCKET_NAME` dans les maps runtime et externes | conserver une seule source de vérité |
| `infra-aws/ssm.tf` | réservation permanente du nom `AWS_S3_BUCKET_NAME` | empêcher sa redécouverte comme secret externe pendant une suppression |
| `infra-aws/terraform.tfvars.example` | valeur de production et permission Rekognition explicites | rendre la configuration attendue visible |
| `infra-aws/scripts/import-env-to-ssm.ps1` | avertissement dédié pour la variable S3 ignorée | orienter l'opérateur vers Terraform et IAM |
| `infra-aws/README.md` | description du garde-fou et de la responsabilité Terraform | documenter l'exploitation future |

### Opération AWS effectuée

Le paramètre `/zwanga-api/production/env/AWS_S3_BUCKET_NAME` a été recréé en `SecureString`, chiffré avec l'alias KMS applicatif `alias/zwanga-api-production-application`. Sa valeur désigne le bucket existant `medias-zwanga` dans `eu-central-1`.

Aucun identifiant AWS permanent n'a été ajouté à ECS, SSM, GitHub ou au dépôt. Le rôle de tâche ECS reste la source d'autorisation pour S3 et le rôle d'exécution reste limité à la lecture des paramètres runtime et au déchiffrement KMS.

### Impacts

- Disponibilité : la tâche de migration bloquée peut maintenant démarrer ; le service ECS déjà actif n'a pas été interrompu.
- Données : aucune migration et aucune écriture PostgreSQL n'ont été exécutées pendant l'échec initial ou le test de vérification.
- Sécurité : aucune permission IAM supplémentaire n'a été accordée ; la valeur reste chiffrée dans SSM.
- Coût : création d'une version standard SSM et exécution d'une tâche Fargate de vérification très courte ; impact négligeable.
- Déploiements futurs : un plan Terraform de production sans nom de bucket échoue désormais avant toute modification AWS.

### Validation réalisée

| Contrôle | Résultat |
| --- | --- |
| Existence du bucket `medias-zwanga` dans `eu-central-1` | confirmé |
| Comparaison des références ECS avec Parameter Store | 98 références, 0 manquante |
| `terraform fmt -check -recursive` | réussi |
| `terraform validate` | réussi |
| Dry-run de l'import `.env` | avertissement Terraform affiché pour `AWS_S3_BUCKET_NAME` |
| Tâche ECS Fargate de vérification avec commande inoffensive | secrets chargés, conteneur arrêté avec code `0` |

### Déploiement et suivi

1. Versionner les modifications Terraform et documentaires.
2. Relancer le workflow GitHub Actions échoué.
3. Vérifier la réussite de la tâche TypeORM, puis la stabilité du service ECS.
4. Surveiller `/ecs/zwanga-api-production/api`, les événements ECS et les alarmes de déploiement.

### Retour arrière

Le paramètre SSM ne doit pas être supprimé tant qu'une définition ECS le référence. Pour retirer S3 dans un environnement non productif, il faut d'abord appliquer une définition de tâche sans `AWS_S3_BUCKET_NAME`, vérifier qu'aucune tâche active ne dépend du bucket, puis supprimer le paramètre et les permissions. En production, le garde-fou doit rester actif ; son retrait nécessite une conception de remplacement et une nouvelle entrée dans ce journal.
