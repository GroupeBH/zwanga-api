# Journal détaillé des changements d'infrastructure AWS

Les entrées sont classées de la plus récente à la plus ancienne. Elles décrivent le code versionné et les opérations réellement exécutées sur AWS, sans inclure de valeur secrète.

## INFRA-2026-09-02-001 — Retrait de DIDIT_API_BASE_URL du runtime ECS

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 2 septembre 2026 |
| Environnement | production, SSM Parameter Store, ECS Fargate |
| Statut | préparé localement ; `terraform apply` et suppression SSM requis |
| Type | configuration runtime |
| Déclencheur | l'hôte Didit configuré retournait `Not Found` |

### Cause racine

La valeur runtime `https://api.didit.me` surchargeait l'origine officielle utilisée
par l'API de vérification. La création de session attend
`https://verification.didit.me/v3/session/`.

### Modifications préparées

- le service Didit fixe l'origine autorisée et ignore l'ancienne variable ainsi que son alias ;
- les exemples et la documentation ne publient plus `DIDIT_API_BASE_URL` ;
- le script d'import `.env` refuse désormais cette variable retirée ;
- Terraform exclut cette variable de la découverte SSM et des références ECS manuelles ;
- les validations Terraform empêchent sa réintroduction dans la configuration runtime.

### Procédure d'application

1. Exécuter les validations Terraform puis contrôler le plan.
2. Vérifier que la nouvelle Task Definition retire la référence
   `/zwanga-api/production/env/DIDIT_API_BASE_URL`.
3. Appliquer Terraform et attendre la stabilisation du service ECS.
4. Vérifier que la Task Definition active ne référence plus cette variable.
5. Supprimer ensuite seulement l'ancien paramètre dans SSM Parameter Store.
6. Déployer le backend modifié et tester la création d'une session KYC authentifiée.

L'ordre Terraform puis code est sûr : la version backend actuellement déployée possède
déjà la bonne origine de repli lorsque la variable n'est pas injectée.

### Impacts

- aucune migration de base de données, permission IAM ou nouvelle valeur secrète ;
- déploiement roulant ECS attendu, sans coût additionnel.

### Retour arrière

Avant le déploiement du nouveau code, recréer au besoin le paramètre avec l'origine
officielle, retirer son exclusion Terraform puis appliquer. Après déploiement du code,
la surcharge runtime est volontairement ignorée.

## INFRA-2026-09-01-003 — Import ciblé des variables Didit et déploiement ECS

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 1 septembre 2026 |
| Environnement | production, SSM Parameter Store, ECS Fargate |
| Statut | appliqué sur AWS |
| Type | mise à jour runtime applicative |
| Déclencheur | activation du fournisseur KYC Didit en production |

### Modification réalisée

Le script `infra-aws/scripts/import-env-to-ssm.ps1` accepte maintenant
`-IncludeNames` pour importer seulement une liste ciblée de variables depuis un
fichier `.env.*`. Le filtre accepte une liste PowerShell ou une chaîne séparée
par virgules.

Cette protection évite d'écraser accidentellement d'autres paramètres runtime
quand l'opérateur veut uniquement mettre à jour un sous-ensemble de secrets.

### Opération AWS exécutée

Les paramètres suivants ont été importés depuis `.env.production` vers SSM
Parameter Store sous `/zwanga-api/production/env/*`, en `SecureString` et sans
afficher les valeurs :

```text
KYC_PROVIDER
DIDIT_KYC_ENABLED
DIDIT_API_BASE_URL
DIDIT_API_KEY
DIDIT_WORKFLOW_ID
DIDIT_WEBHOOK_SECRET
DIDIT_WEBHOOK_REQUIRE_SIGNATURE
DIDIT_WEBHOOK_TOLERANCE_SECONDS
```

Terraform a ensuite été appliqué avec le plan `didit-env-update.tfplan`.

Résultat :

- nouvelle révision ECS `zwanga-api-production-api:8` ;
- service ECS `zwanga-api-production-api` stable ;
- `desired=1`, `running=1`, `pending=0` ;
- aucune ressource ACM, DNS, ALB ou RDS modifiée ;
- health check public `https://compute-api.zwanga-app.com/health` retourné avec
  `status=ok`, `db=ok`, `redis=ok`.

### Commande d'import ciblé

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra-aws\scripts\import-env-to-ssm.ps1 `
  -EnvFile .\.env.production `
  -ProjectName zwanga-api `
  -Environment production `
  -AwsRegion eu-central-1 `
  -IncludeNames KYC_PROVIDER,DIDIT_KYC_ENABLED,DIDIT_API_BASE_URL,DIDIT_API_KEY,DIDIT_WORKFLOW_ID,DIDIT_WEBHOOK_SECRET,DIDIT_WEBHOOK_REQUIRE_SIGNATURE,DIDIT_WEBHOOK_TOLERANCE_SECONDS
```

### Impact sécurité

- les valeurs Didit restent dans SSM/KMS, hors Git et hors Terraform state ;
- ECS reçoit uniquement des références `valueFrom` vers les paramètres ;
- le rôle d'exécution conserve la policy compacte bornée au préfixe
  `/zwanga-api/production/*`.

## INFRA-2026-09-01-002 — Variables runtime pour le KYC Didit

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 1 septembre 2026 |
| Environnement | production/staging, ECS Fargate, SSM Parameter Store |
| Statut | documentation et exemples préparés ; import SSM et apply requis |
| Type | configuration runtime applicative |
| Déclencheur | migration du KYC Zwanga vers Didit |

### Modification réalisée

Les exemples d'environnement et `terraform.tfvars.example` documentent les
variables non secrètes permettant d'activer le fournisseur KYC Didit :

```text
KYC_PROVIDER
DIDIT_KYC_ENABLED
DIDIT_API_BASE_URL
DIDIT_WEBHOOK_REQUIRE_SIGNATURE
DIDIT_WEBHOOK_TOLERANCE_SECONDS
```

Les valeurs secrètes suivantes doivent être créées dans SSM Parameter Store sous
le préfixe runtime de l'environnement, sans être copiées dans Terraform state :

```text
DIDIT_API_KEY
DIDIT_WORKFLOW_ID
DIDIT_WEBHOOK_SECRET
```

### Déploiement requis

1. Créer/configurer le workflow Didit.
2. Ajouter les paramètres SSM sous `/zwanga-api/<environment>/env/*`.
3. Lancer un nouveau `terraform plan/apply` pour générer une nouvelle révision
   ECS contenant les variables.
4. Vérifier dans la task definition que les noms `DIDIT_*` sont injectés.
5. Configurer côté Didit l'URL webhook publique :

```text
https://<api-production>/api/v1/users/kyc/didit/webhook
```

### Impact sécurité

- Les secrets Didit restent hors Git.
- Le webhook est signé par défaut.
- L'ancienne validation Rekognition peut rester désactivée ou disponible en
  secours sans exposer de nouveau droit AWS.

## INFRA-2026-09-01-001 — Policy IAM compacte pour les paramètres SSM runtime

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 1 septembre 2026 |
| Environnement | production, ECS Fargate, IAM, SSM Parameter Store |
| Statut | correction préparée localement ; apply de reprise requis |
| Type | robustesse IAM et injection des secrets runtime |
| Déclencheur | `LimitExceeded: Maximum policy size of 10240 bytes exceeded` sur `zwanga-api-production-execution-secrets` |

### État observé

L'ajout manuel des variables `ADMIN_BOOTSTRAP_*` dans SSM Parameter Store a été
fait sous le bon préfixe :

```text
/zwanga-api/production/env/ADMIN_BOOTSTRAP_SECRET
/zwanga-api/production/env/ADMIN_BOOTSTRAP_PHONE
/zwanga-api/production/env/ADMIN_BOOTSTRAP_FIRST_NAME
/zwanga-api/production/env/ADMIN_BOOTSTRAP_LAST_NAME
/zwanga-api/production/env/ADMIN_BOOTSTRAP_DEFAULT_PASSWORD
```

La définition ECS active au moment du diagnostic était encore
`zwanga-api-production-api:6`, créée le 25 août 2026. Elle ne contenait aucune
référence `ADMIN_BOOTSTRAP_*` dans le conteneur `api`. Le backend recevait donc
une variable absente et retournait :

```json
{
  "message": "Le bootstrap super administrateur n'est pas configuré",
  "error": "Unauthorized",
  "statusCode": 401
}
```

Lors du `terraform apply bootstrap-secrets.tfplan`, AWS a refusé la mise à jour
de la policy inline du rôle d'exécution ECS parce que le document IAM dépassait
10 240 bytes. Avant l'échec, Terraform avait déjà désenregistré la task
definition `zwanga-api-production-api:6`, qui est passée `INACTIVE`.

### Cause racine

La policy `aws_iam_role_policy.ecs_task_execution_secrets` listait chaque ARN
SSM runtime individuellement via `local.runtime_parameter_arns`. Ce modèle est
trop fragile : chaque nouvelle variable importée sous `/env/*` allonge la
policy IAM, alors qu'AWS impose une limite stricte de 10 240 bytes pour une
policy inline attachée à un rôle.

Le workflow GitHub de déploiement force un nouveau déploiement ECS, mais il ne
recrée pas la task definition Terraform. Les nouveaux paramètres SSM ne sont
donc injectés qu'après un `terraform plan/apply` qui génère une nouvelle
révision de task definition.

### Modification réalisée

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `infra-aws/ssm.tf` | remplacement de la liste détaillée des ARN SSM par un ARN préfixe borné `parameter/zwanga-api/production/*` | garder la policy IAM compacte et stable |
| `infra-aws/docs/CHANGELOG.md` | documentation du diagnostic, de la cause, de la reprise et du rollback | conserver la traçabilité infra exigée |

La définition ECS continue de référencer explicitement les paramètres découverts
ou générés. Seule l'autorisation IAM qui permet à ECS de les lire devient
préfixée.

### Impact sécurité

Avant : le rôle d'exécution ECS pouvait lire uniquement les paramètres listés
un par un dans la task definition et dans la policy.

Après : le rôle d'exécution ECS peut lire les paramètres SSM sous le préfixe de
l'environnement courant :

```text
/zwanga-api/production/*
```

Ce périmètre couvre les paramètres générés par Terraform, les secrets importés
sous `/env/*` et le paramètre temporaire de migration sous `/migration/*`. Il ne
donne pas accès aux autres projets, aux autres environnements, ni aux valeurs
hors du préfixe Zwanga production.

### Impact disponibilité et données

- Données métier : aucune migration de base, aucune écriture applicative, aucun
  solde et aucun paiement modifié.
- Disponibilité : une nouvelle révision ECS doit être créée rapidement parce
  que la révision `:6` a été désenregistrée pendant l'apply échoué.
- Sécurité : les valeurs secrètes restent dans SSM `SecureString` et ne sont pas
  écrites en clair dans la task definition.
- Coûts : aucun coût additionnel.

### Reprise contrôlée

1. Régénérer un nouveau plan Terraform après cette correction :

   ```bash
   terraform -chdir=infra-aws plan -out=bootstrap-secrets-retry.tfplan
   ```

2. Refuser le plan s'il contient une destruction non voulue de Route53, ACM,
   ALB, RDS, Redis, SSM ou KMS.

3. Vérifier que le plan contient au minimum :

   - une modification de `aws_iam_role_policy.ecs_task_execution_secrets` ;
   - une création ou nouvelle révision de `aws_ecs_task_definition.backend` ;
   - une mise à jour du service ECS vers cette nouvelle révision.

4. Appliquer :

   ```bash
   terraform -chdir=infra-aws apply bootstrap-secrets-retry.tfplan
   ```

5. Vérifier que la nouvelle task definition contient les noms
   `ADMIN_BOOTSTRAP_*` dans `containerDefinitions[].secrets`.

6. Forcer un redéploiement ECS seulement si Terraform ne l'a pas déjà fait :

   ```bash
   aws ecs update-service \
     --region eu-central-1 \
     --cluster zwanga-api-production-cluster \
     --service zwanga-api-production-api \
     --force-new-deployment
   ```

### Validation attendue

Validations locales déjà effectuées après modification :

| Contrôle | Résultat |
| --- | --- |
| `terraform -chdir=infra-aws fmt -check` | réussi |
| `terraform -chdir=infra-aws validate` | réussi |

Validations à effectuer après le prochain `apply` :

```bash
aws ecs describe-services \
  --region eu-central-1 \
  --cluster zwanga-api-production-cluster \
  --services zwanga-api-production-api \
  --query 'services[0].taskDefinition' \
  --output text
```

Puis :

```bash
aws ecs describe-task-definition \
  --region eu-central-1 \
  --task-definition <nouvelle-task-definition> \
  --query "taskDefinition.containerDefinitions[?name=='api'].secrets[].name" \
  --output text
```

Les noms suivants doivent apparaître :

```text
ADMIN_BOOTSTRAP_SECRET
ADMIN_BOOTSTRAP_PHONE
ADMIN_BOOTSTRAP_FIRST_NAME
ADMIN_BOOTSTRAP_LAST_NAME
ADMIN_BOOTSTRAP_DEFAULT_PASSWORD
```

Le test HTTP de bootstrap ne doit plus retourner
`Le bootstrap super administrateur n'est pas configuré`.

### Retour arrière

Si la nouvelle task definition ne démarre pas, revenir à la dernière révision
ECS active connue qui contient une image saine et des secrets valides. Comme la
révision `:6` est `INACTIVE`, éviter de compter dessus pour un nouveau
déploiement. La correction IAM peut rester en place : elle réduit la taille de
policy et ne modifie aucune donnée.

## INFRA-2026-08-26-001 — Paramètres runtime du versement conducteur

Statut : configuration et documentation préparées localement ; aucun changement AWS exécuté.

Résumé : ajout de `DRIVER_PAYOUT_MIN_AMOUNT_CDF` à la configuration de production importable dans SSM. Les paramètres FlexPay de payout existants sont recensés, avec une procédure de plan, déploiement ECS, validation, surveillance et retour arrière. Le document exige que tout plan comportant une suppression ACM, DNS, ALB, SSM, RDS ou Redis soit refusé.

Impacts : aucun secret documenté, aucune ressource AWS modifiée à ce stade, aucun solde ou paiement recalculé. La valeur prendra effet après import SSM et nouvelle révision ECS.

Documentation complète : [driver-payout-runtime.md](./driver-payout-runtime.md).

## INFRA-2026-08-25-004 — Restauration et protection du domaine HTTPS public

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 25 août 2026 |
| Environnement | production, Route53, ACM et ALB `eu-central-1` |
| Statut | correction préparée, plan validé, application en cours |
| Type | incident DNS/HTTPS et durcissement Terraform |
| Déclencheur | `Could not resolve host: compute-api.zwanga-app.com` |

### État observé et preuve

Le domaine parent `zwanga-app.com` résolvait avec les NS Vercel. La délégation publique de `compute-api.zwanga-app.com` vers la zone Route53 `Z0100742PIM0UW6FZED7` fonctionnait également. Cependant, cette zone enfant ne contenait plus que les enregistrements `NS` et `SOA` : aucun alias `A` ne permettait d'atteindre l'ALB.

L'état Terraform ne contenait plus `aws_acm_certificate.api`, `aws_route53_record.api_alias`, `aws_lb_listener.https` ni `aws_vpc_security_group_ingress_rule.alb_https`. ACM ne contenait plus de certificat pour le domaine.

CloudTrail a confirmé l'événement `DeleteCertificate` du 25 août 2026 à `14:52:06Z` pour le certificat se terminant par `c3647798-12f0-4bf9-a031-c85b9dbcf906`. Son `userAgent` identifie Terraform `1.14.6` et le provider AWS `6.58.0`. La suppression a réussi sans erreur AWS.

### Cause racine

`api_domain_name` et `route53_hosted_zone_id` avaient tous les deux `null` comme valeur par défaut. Leurs valeurs n'étaient conservées que dans les arguments de certaines commandes manuelles. Un apply ultérieur sans ces arguments évaluait tous les `count` HTTPS à zéro et demandait légitimement à Terraform de supprimer les ressources précédemment gérées.

La configuration ne possédait ni source versionnée auto-chargée pour ces valeurs non sensibles, ni précondition de production, ni `prevent_destroy` sur la chaîne HTTPS.

### Modifications réalisées

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `.gitignore` | exception pour `infra-aws/production.auto.tfvars` | versionner uniquement la configuration de production non sensible |
| `infra-aws/production.auto.tfvars` | domaine, Hosted Zone ID et autres identifiants stables | auto-charger les valeurs à chaque plan/apply |
| `infra-aws/domain.tf` | précondition bloquante `production_https_guard` | refuser une production sans domaine et source de certificat |
| `infra-aws/domain.tf` | `prevent_destroy` sur ACM et les enregistrements Route53 critiques | empêcher une suppression implicite |
| `infra-aws/alb.tf` | `prevent_destroy` sur le listener HTTPS | préserver le point d'entrée TLS |
| `infra-aws/security-groups.tf` | `prevent_destroy` sur l'entrée publique `443/TCP` | préserver l'accessibilité HTTPS |
| `infra-aws/variables.tf` | descriptions alignées avec le caractère obligatoire en production | éviter l'interprétation erronée de variables facultatives |
| `infra-aws/docs/public-api-https.md` | architecture, diagnostic, validation et retour arrière | fournir le runbook permanent |

### Plan de restauration contrôlé

Le plan ciblé généré après ajout des protections contient `8 créations`, `1 modification` et `0 destruction` :

- nouveau garde-fou Terraform ;
- nouveau certificat ACM et sa validation DNS ;
- CAA, CNAME ACM et alias `A` Route53 ;
- règle entrante HTTPS du Security Group ;
- listener HTTPS `443` ;
- modification du listener HTTP pour rediriger vers HTTPS.

Il ne modifie ni ECS, ni RDS, ni Redis, ni SSM, ni les données ou paiements.

### Impacts

- Disponibilité : le domaine reste indisponible pendant l'émission du nouveau certificat ; l'URL HTTP technique de l'ALB reste disponible jusqu'au basculement du listener.
- Sécurité : le port public `443/TCP` est ouvert uniquement sur l'ALB. Le trafic ALB vers ECS conserve sa règle restreinte existante.
- Données : aucune migration et aucune écriture métier ou financière.
- Coûts : certificat ACM public sans coût additionnel direct ; zone Route53 et ALB déjà existants ; aucun nouvel ALB.
- Exploitation : une suppression volontaire future exige de retirer explicitement les protections dans le code et de faire revoir le plan.

### Validation

| Contrôle | Résultat |
| --- | --- |
| Délégation NS publique | réussie vers les quatre serveurs Route53 de la zone enfant |
| Contenu initial de la zone Route53 | uniquement `NS` et `SOA`, alias `A` absent |
| CloudTrail `DeleteCertificate` | origine Terraform confirmée |
| `terraform fmt` | réussi |
| `terraform validate` | réussi |
| Plan de restauration | `8 add`, `1 change`, `0 destroy` |
| ACM `ISSUED` | à compléter après application |
| Résolution DNS publique | à compléter après application |
| Test HTTPS `/health` | à compléter après application |
| Plan post-application | à compléter après application |

### Retour arrière

Il n'existe aucun rollback de données. En cas d'échec avant émission du certificat, conserver le CNAME de validation et diagnostiquer la délégation ou le CAA. Ne pas supprimer à nouveau le certificat ou l'alias. Pour une désactivation volontaire, retirer les protections dans une modification dédiée, faire approuver le plan destructif et coordonner le changement avec les clients mobiles.

## INFRA-2026-08-25-003 — Restauration du proxy d'échantillonnage X-Ray

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 25 août 2026 |
| Environnement | production, ECS Fargate `eu-central-1` |
| Statut | déployé et validé en production |
| Type | observabilité, ADOT Collector et X-Ray |
| Déclencheur | erreurs `ECONNREFUSED 127.0.0.1:2000` toutes les cinq minutes dans le conteneur `api` |

### Contexte et état observé

Chaque instance de l'application journalisait périodiquement un échec HTTP sur `http://localhost:2000/GetSamplingRules`. Les messages apparaissaient après les requêtes de production, car l'auto-instrumentation crée des traces pour les opérations HTTP, mais ils étaient répétés selon le cycle de rafraîchissement du sampler et non pour chaque appel métier.

La tâche `aed3d876a15d4d90bc622a98683ea18f`, utilisant la définition `zwanga-api-production-api:5`, a été inspectée en lecture seule :

- les conteneurs `api` et `aws-otel-collector` étaient `RUNNING` ;
- l'application était `HEALTHY` ;
- le collecteur ADOT `v0.49.0` écoutait correctement sur `4317` et `4318` ;
- le paramètre `AOT_CONFIG_CONTENT` contenait le receiver OTLP et l'exporter X-Ray, mais aucune extension `awsproxy` ;
- l'application utilisait `OTEL_TRACES_SAMPLER=xray`, dont le proxy par défaut est `localhost:2000` et le rafraîchissement par défaut cinq minutes.

### Cause racine

La configuration activait deux parties distinctes de l'observabilité : la production/exportation des traces et l'échantillonnage distant. La première était complète, mais la seconde ne l'était pas. Le sampler Node tentait de consulter les règles X-Ray tandis que le collecteur n'exposait aucun proxy sur le port attendu.

`OTEL_TRACES_SAMPLER_ARG` recevait en plus uniquement une valeur numérique. Pour le sampler `xray`, cette variable attend des options nommées telles que `endpoint` et `polling_interval`; le taux fixe appartient à la ressource AWS `aws_xray_sampling_rule` et non à cet argument.

### Modifications réalisées

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `infra-aws/ecs.tf` | ajout de `extensions.awsproxy` sur `0.0.0.0:2000` | servir les règles X-Ray au sampler Node |
| `infra-aws/ecs.tf` | activation de `service.extensions: [awsproxy]` | démarrer réellement l'extension |
| `infra-aws/ecs.tf` | ajout du port interne `2000/TCP` au sidecar | déclarer explicitement l'endpoint de la tâche |
| `infra-aws/ecs.tf` | argument du sampler remplacé par endpoint local et intervalle de 300 secondes | aligner le SDK et le collecteur |
| `infra-aws/ecs.tf` | image ADOT épinglée à `v0.49.0` | rendre les déploiements reproductibles |
| `infra-aws/variables.tf` | description corrigée de `xray_sampling_rate` | préciser que le taux configure la règle centralisée AWS |
| `infra-aws/docs/xray-remote-sampling.md` | guide complet du flux et du diagnostic | documenter exploitation et retour arrière |

Avant l'application, le paramètre SSM existant `/zwanga-api/production/env/AWS_S3_BUCKET_NAME` a été importé dans l'état Terraform. Sa valeur n'a pas été lue ni changée manuellement. L'application du plan a uniquement normalisé sa description, son identifiant de clé KMS et ses tags Terraform ; cette synchronisation a empêché Terraform de tenter de recréer un paramètre déjà présent.

### Impacts

- Disponibilité : aucune modification d'un endpoint métier, d'un port ALB ou du health check NestJS. Le changement provoquera un rolling deployment ECS normal.
- Observabilité : le sampler récupérera les règles centralisées ; les erreurs périodiques disparaîtront et le taux Terraform sera effectivement appliqué.
- Sécurité : aucun port entrant n'est ajouté au Security Group. Le port `2000` reste dans l'interface réseau partagée de la tâche. Les permissions X-Ray en lecture et écriture existaient déjà sur le rôle de tâche.
- Données et paiements : aucune migration, aucun changement de schéma et aucune écriture financière.
- Coûts : pas de nouvelle ressource persistante. L'échantillonnage fonctionnel peut modifier le volume réel de traces vers le taux centralisé configuré à 5 %, ce qui est le comportement attendu.
- Reproductibilité : le collecteur ne suivra plus implicitement les futures versions publiées sous le tag `latest`.

### Déploiement réalisé

1. Validation de la configuration et de la documentation locale.
2. Import du paramètre S3 existant dans l'état Terraform.
3. Examen puis application d'un plan ciblé : remplacement de la définition de tâche et mise à jour en place des trois paramètres SSM concernés.
4. Création de la définition `zwanga-api-production-api:6`.
5. Exécution d'une tâche de contrôle isolée avec la révision `:6`, puis arrêt de cette tâche après validation.
6. Rolling deployment du service `zwanga-api-production-api` de la révision `:5` vers `:6`.
7. Drainage automatique de l'ancienne tâche `aed3d876a15d4d90bc622a98683ea18f` après passage en bonne santé de la nouvelle tâche.

### Validation réalisée avant déploiement

| Contrôle | Résultat |
| --- | --- |
| État ECS initial et health check applicatif | tâche `:5` active et application saine malgré l'erreur de télémétrie |
| Logs initiaux du collecteur | OTLP `4317/4318` opérationnel, proxy `2000` absent |
| Lecture de `AOT_CONFIG_CONTENT` | cause confirmée sans lecture d'un secret applicatif |
| Comparaison avec la documentation ADOT/AWS | `awsproxy` requis pour le sampler X-Ray distant |
| `terraform fmt -check -recursive` | réussi |
| `terraform validate` | réussi |
| contrôle documentaire de l'infrastructure | réussi pour tous les fichiers d'infrastructure détectés |
| Tâche de contrôle sur la révision `:6` | conteneur API `HEALTHY`, collector prêt, aucun échec de démarrage |
| Logs ADOT sur la tâche de contrôle | `X-Ray proxy server started on 0.0.0.0:2000` puis `Everything is ready` |
| Déploiement du service | `COMPLETED`, une tâche désirée et une tâche active sur `:6` |
| Endpoint ALB `/health` | HTTP `200`, statut application, PostgreSQL et Redis à `ok` |
| Recherche CloudWatch sur la nouvelle tâche après plus de cinq minutes | aucune occurrence de `GetSamplingRules` ni de `ECONNREFUSED` |
| Plan Terraform ciblé après application | aucune modification restante |

### Surveillance et retour arrière

La procédure de surveillance détaillée se trouve dans [xray-remote-sampling.md](./xray-remote-sampling.md). Le critère principal est l'absence de nouvelle erreur `GetSamplingRules` après un intervalle supérieur à cinq minutes, accompagnée de traces récentes dans X-Ray.

Si le nouveau sidecar ne démarre pas ou si l'application devient instable, remettre le service sur la révision de définition ECS précédente. Aucun rollback de données n'est requis. Cette action restaure cependant l'erreur d'échantillonnage et ne constitue qu'un retour temporaire.

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

### new env for super admin
dans .env.docker.example
