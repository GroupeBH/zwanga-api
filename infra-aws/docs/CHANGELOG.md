# Journal détaillé des changements d'infrastructure AWS

Les entrées sont classées de la plus récente à la plus ancienne. Elles décrivent le code versionné et les opérations réellement exécutées sur AWS, sans inclure de valeur secrète.

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
