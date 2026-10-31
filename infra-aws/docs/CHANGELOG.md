# Journal détaillé des changements d'infrastructure AWS

## INFRA-2026-10-31-001 — Proxy sortant Mobishastra avec Elastic IP

- **Date, auteur, statut :** préparation locale les 30–31 octobre 2026,
  Africa/Kinshasa, Codex à la demande du mainteneur. Non appliqué sur AWS.
- **Contexte et état précédent :** ECS utilise des IP publiques renouvelables.
  Mobishastra exige une liste blanche d'IP de sortie. L'ALB n'est pas une sortie
  réseau pour ces appels. Objectif : stabiliser uniquement le trafic SMS.
- **Configuration :** nouvelle racine `environments/mobishastra-proxy`, état S3
  séparé, EC2 Ubuntu ARM `t4g.micro`, gp3 chiffré 8 Gio, ENI persistante, EIP
  protégée. Ansible installe Squid CONNECT limité aux deux domaines Mobishastra,
  refuse les réseaux privés/métadonnées, préserve TLS et désactive les logs de
  contenu. Supervision systemd et métriques/alarmes CloudWatch.
- **AWS/IAM :** ressources nouvelles uniquement, sauf une règle de sortie TCP
  3128 ajoutée au groupe ECS vers le groupe proxy. Aucune route, tâche ECS, ALB,
  RDS, Redis, permission OIDC ou workflow modifié. Rôle EC2 limité aux canaux
  SSM et à une métrique dédiée ; pas de lecture de secrets. Aucun SSH public.
- **Backend :** `MobishastraSmsService` accepte `MOBISHASTRA_PROXY_URL` et
  `MOBISHASTRA_PROXY_REQUIRED`, documentées dans `.env.example`. Agent HTTPS
  Node dédié, TLS vérifié, délais bornés, pas de proxy global, de répétition ou
  de repli direct automatique. Aucune dépendance npm ajoutée. `.env`, SSM,
  `OTP_PROVIDER` et l'obligation d'inscription OTP sont inchangés.
- **Disponibilité et coûts :** aucune interruption avant activation. L'EC2
  unique n'est pas hautement disponible ; sa maintenance/reconstruction coupe
  temporairement les nouveaux SMS, pas les autres sorties du backend. Frais EC2,
  EBS, IPv4 publique, supervision et trafic. L'IP reste facturée à l'arrêt.
- **Données :** aucune migration SQL ni écriture utilisateur. Certificat de test
  fictif hors compilation de production. Aucun SMS envoyé pendant la validation.
- **Procédure et rollback :** [guide d'exploitation](../environments/mobishastra-proxy/README.md).
  Valider le plan séparé, créer l'instance, vérifier cloud-init/Squid, faire
  autoriser l'EIP, puis injecter les paramètres via le mécanisme SSM/ECS existant.
  L'activation du fournisseur OTP reste séparée. Conserver l'EIP/ENI en rollback.
- **Validation locale :** tests OTP et tunnel TLS, tests de configuration et
  heartbeat Python, vérifications réelles de Squid sur boucle locale, syntaxe
  Ansible, Terraform avec fournisseur simulé, compilation TypeScript et lint
  des fichiers concernés. Le plan réel et la recette SMS AWS restent à faire.


## INFRA-2026-10-27-003 — Exécuter les tests du relais Redis avant déploiement

- Date / statut : 27 octobre 2026 ; modification locale du workflow, aucun appel de déploiement.
- Problème : le pipeline fournissait PostgreSQL mais pas DISPATCH_TEST_REDIS_PORT ; la suite séquentielle pouvait être ignorée.
- Solution : .github/workflows/deploy.yml installe redis-server, démarre une instance de test liée à 127.0.0.1:16379 sans persistance, vérifie PONG, fournit le port aux tests et arrête cette instance ensuite.
- Conservé : pipeline release, PostgreSQL jetable, contrôle final ECS préexistant, ordre tests/compilation/migrations/déploiement. Aucun accès à Redis ou aux données de production.
- Vérifications : YAML analysé localement. Pas d'exécution GitHub Actions dans cette intervention ; validation sur le runner Ubuntu restant à réaliser. [Rapport des contrats et limites](../../docs/AUDIT_RECEPTION_SONNERIE_BACKEND_2026-10-27.md).


## INFRA-2026-10-27-002 — Attendre la confirmation du déploiement ECS après stabilisation

- **Date / statut / périmètre :** 27 octobre 2026, Africa/Kinshasa ; diagnostic
  AWS et GitHub en lecture seule, correctif CI/CD préparé localement pour la production.
- **Constat vérifié :** le [workflow 40503693732](https://github.com/GroupeBH/zwanga-api/actions/runs/40503693732)
  a passé les tests, la compilation, la construction d'image et les migrations.
  À 13:37:18, son contrôle final a renvoyé `false`. ECS a déclaré le déploiement
  `ecs-svc/0850713560371083635` terminé à 13:37:25. La révision `:29` est ensuite
  confirmée `PRIMARY / COMPLETED`, avec une tâche saine sur une attendue et une
  cible ALB `healthy`. L'image ECR correspond au commit `e35ae493030222c39fc30b080e3dbb2af3b5aadd`.
- **Cause :** le waiter [AWS `services-stable`](https://docs.aws.amazon.com/cli/latest/reference/ecs/wait/services-stable.html)
  vérifie le nombre de déploiements et l'égalité entre tâches actives et attendues,
  sans attendre `rolloutState=COMPLETED`. Une lecture unique de cet état juste
  après le waiter peut donc produire un faux échec. La chronologie observée est
  cohérente avec cette fenêtre ; le JSON exact lu à 13:37:18 n'était pas journalisé.
- **Avant / après :** `.github/workflows/deploy.yml` conserve le waiter, puis
  appelle `infra-aws/scripts/wait-for-ecs-deployment.cjs` au lieu du contrôle
  `jq` unique. Le script relit le service au maximum treize fois, avec douze
  pauses de dix secondes au maximum et un délai d'exécution de vingt secondes
  par appel AWS. Il exige toujours l'identifiant attendu, `PRIMARY`, `COMPLETED`,
  un seul déploiement et les comptes de tâches stabilisés. Un état `FAILED`
  explicite échoue immédiatement ; un rollback, un état incomplet persistant ou
  une erreur de lecture ne donne jamais un succès.
- **Diagnostic :** chaque lecture affiche l'identifiant attendu, les comptes
  de tâches, les identifiants et états des déploiements. Aucun environnement de
  conteneur ni secret n'est affiché. L'absence ou le format invalide de
  `EXPECTED_DEPLOYMENT` est refusé avant tout appel AWS.
- **Ressources / IAM / variables :** aucune modification Terraform, IAM, SSM,
  réseau ou dimensionnement. Réutilisation d'`ecs:DescribeServices` et des
  variables existantes `ECS_CLUSTER`, `ECS_SERVICE`, `EXPECTED_DEPLOYMENT`.
- **Disponibilité / données / coûts :** aucune relance du service ou migration
  par le correctif ; aucune dépendance ajoutée. Quelques lectures ECS et du
  temps de runner supplémentaires si la confirmation arrive après le waiter.
  Les étapes de construction, migration et mise à jour ECS restent identiques.
- **Validation :** scénarios automatisés dans `src/database/deployment-completion.spec.ts` :
  confirmation différée, succès immédiat, échec explicite, rollback stable,
  état manquant, limites de tentatives, comptes instables et erreurs AWS.
  Dix-huit tests réussis dans les deux suites `deployment-completion` et
  `deployment-revision`. Syntaxe Node, `git diff --check` et contrôle documentaire
  `HEAD WORKTREE` réussis. Les contrôles de révision immuable existants sont conservés.
- **Livraison / surveillance :** inclure script, tests, workflow et cette entrée
  dans la prochaine livraison ; vérifier le résultat et les diagnostics de
  « Wait for ECS stability ». Le déploiement déjà terminé ne doit pas être
  relancé uniquement pour repeindre le job en vert.
- **Retour arrière / limites :** revenir au précédent contrôle CI restaure
  aussi son risque de faux échec ; aucune restauration de base requise pour
  ce changement. Aucun push, redéploiement ou changement d'état AWS effectué ici.

## INFRA-2026-10-27-001 — Alignement Node et contrôles des dépendances avant déploiement

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date et heure de documentation | 2026-10-27 13:17, Africa/Kinshasa (UTC+1) |
| Auteur / opérateur | Codex, correctif documentaire local demandé par le mainteneur |
| Environnements concernés | développement, staging et production lors de la prochaine livraison |
| Statut | changements versionnés ; documentation complétée localement, déploiement non constaté |
| Type | CI/CD, environnement Node, construction Docker et sécurité des dépendances |
| Référence | commit `d84ee754593514924aba877bc037704c6899bc1d` ; contrôle `check-infra-documentation.sh` en échec |

### Contexte, état précédent et cause

Le commit remplace Node 22 par la version 24.22.1 définie dans `.nvmrc` et
actualise les dépendances applicatives. Auparavant, les deux workflows fixaient
Node 22, le Dockerfile utilisait `NODE_VERSION=22`, et Compose transmettait
`NODE_BASE_IMAGE`, argument non consommé par ce Dockerfile.

Le contrôle documentaire échoue parce que quatre fichiers surveillés changent
sans modification de ce journal. La documentation existante dans
`docs/CHANGEMENTS_TECHNIQUES.md` et le rapport de dépendances ne satisfait pas ce
contrôle. L'échec a été reproduit localement sur `HEAD^..HEAD` ; il intervient
avant les tests, la construction et les opérations AWS du workflow de production.

### Modifications réalisées

| Fichier | Modification | Raison |
| --- | --- | --- |
| `.github/workflows/deploy.yml` | `setup-node` lit `.nvmrc` ; exécution de `npm run test:dependencies` avant Jest | aligner l'exécution et contrôler les intégrations des dépendances |
| `.github/workflows/deploy-staging.yml` | même sélection Node et mêmes tests pour les actions `deploy` et `bootstrap` | contrôler le backend avant le démarrage du serveur de test |
| `Dockerfile` | argument `NODE_VERSION` par défaut à `24.22.1` | construire les étapes existantes depuis `node:24.22.1-alpine` |
| `docker-compose.yml` | argument de construction `NODE_VERSION: ${NODE_VERSION:-24.22.1}` à la place de `NODE_BASE_IMAGE` | transmettre l'argument réellement consommé par le Dockerfile |
| `.nvmrc`, `package.json`, `package-lock.json`, `test/dependency-security.test.cjs` | version Node, dépendances, substitutions et tests associés | maintenir la cohérence entre code, installation et image |
| `infra-aws/docs/CHANGELOG.md` | présente entrée | compléter la traçabilité exigée sans désactiver le contrôle |

**Ressources AWS :** aucune création, modification ou suppression exécutée pour
ce correctif documentaire. La future livraison conserve le pipeline existant :
image ECR, tâche de migrations et remplacement des tâches ECS ; le staging
conserve ses actions manuelles existantes. Aucun fichier Terraform modifié.

**Variables et paramètres :** `NODE_VERSION` est un argument de construction
non secret, avec `24.22.1` comme défaut. Aucun nouveau paramètre SSM, secret,
identifiant AWS ou variable d'exécution obligatoire pour l'application.

### Impacts

- **Disponibilité :** la documentation seule ne redémarre aucun service. Le
  changement Node sera effectif à la prochaine livraison de l'image ; les tests
  des dépendances natives et la santé des nouvelles tâches doivent être validés.
- **Sécurité et IAM :** les permissions, OIDC, certificats RDS et utilisateur
  Docker restent inchangés dans ce lot. Le détail des mises à jour et les limites
  de l'audit sont consignés dans le [rapport de dépendances](../../docs/operations/node-dependencies-security-2026-10-27.md).
- **Données :** aucune nouvelle migration dans ce commit ; le pipeline continue
  d'exécuter les migrations applicatives en attente selon sa procédure existante.
- **Coûts :** aucun service AWS ajouté ou redimensionné ; durée des tests CI
  potentiellement accrue. Le staging reste démarré par ses actions existantes.

### Livraison, surveillance et retour arrière

1. Inclure cette entrée dans le commit correctif ou la PR contenant les changements.
2. Exécuter le contrôle documentaire, puis laisser le pipeline vérifier
   l'installation, les tests des dépendances, Jest et la compilation. Aucun
   `terraform apply` ni changement SSM n'est requis pour cette correction.
3. Livrer par le workflow existant et contrôler la stabilisation ECS, les cibles
   ALB, `/health/live`, `/health`, les erreurs et les redémarrages pendant au moins
   30 minutes. Vérifier particulièrement le chargement des dépendances natives.
4. En cas de régression du runtime, utiliser la précédente image et la précédente
   définition de tâche validées, après vérification de leur compatibilité avec
   les migrations effectivement exécutées. Ne pas rétrograder seulement Node
   avec le nouveau manifeste de dépendances ; conserver un ensemble cohérent.

### Validation et éléments restant à faire

Le contrôle sans cette entrée reproduit l'échec sur les quatre fichiers cités.
La vérification locale `bash infra-aws/scripts/check-infra-documentation.sh HEAD^ WORKTREE`
réussit : `Infrastructure documentation check passed for 4 changed file(s).`
Elle inclut les changements du commit et ce correctif non commité.
`git diff --check` réussit également. Les tests applicatifs déjà réalisés sont détaillés dans les journaux
techniques ; ils ne sont pas réexécutés pour cette modification documentaire.
Le résultat du pipeline complet sur le futur commit reste à confirmer. Aucun
push GitHub, déploiement ou appel AWS effectué pour ce correctif.

## INFRA-2026-10-14-002 — Surveillance et sondes après audit de résilience

- Préparé localement uniquement : aucun `plan`, `apply`, changement SSM ou déploiement.
- Alarmes Redis corrigées avec `CacheClusterId` et `CacheNodeId`, pour chaque nœud.
  Les blocs `moved` conservent les trois alarmes existantes à l'indice zéro ; leurs
  noms restent inchangés. L'alarme d'évictions ne considère plus une absence de
  métriques comme un succès. Le tableau de bord affiche aussi les répliques.
- Ajout d'une alarme RDS `FreeableMemory` (128 Mio par défaut, configurable) et
  affichage mémoire/swap. Aucun redimensionnement ni changement de pool en AWS.
- Le chemin ALB par défaut devient `/health/live`, sans dépendance à Redis/RDS.
  **Déployer d'abord le backend qui valide `/health` avant `listen()`**, puis
  appliquer ce changement de sonde après lecture du plan. `/health` reste la
  sonde approfondie pour diagnostiquer DB/Redis/schéma. Une valeur explicite de
  `alb_health_check_path` dans les tfvars prime sur le nouveau défaut.
- Le CI/CD, `ecs.tf`, `oidc.tf`, les tailles et nombres de ressources ne changent
  pas dans ce lot. Le changement Didit décrit ci-dessous est préexistant et doit
  être examiné séparément dans le plan global.
- Vérification locale : `terraform fmt` sur les fichiers modifiés et
  `terraform validate` réussis avec les fournisseurs installés. Aucun état AWS
  n'a été modifié pour cette validation.

## INFRA-2026-10-14-001 — Retour du KYC Didit au SDK natif

- Date/périmètre : 14 octobre 2026, configuration locale uniquement. La nouvelle
  application utilise Didit par défaut sans parcours navigateur ; le mode hébergé
  préparé en production supprimait le token nécessaire au SDK.
- Appliqué : `production.auto.tfvars` sélectionne désormais le lancement natif.
  Les clés fournisseur, le workflow, les contrôles KYC et les permissions AWS
  restent inchangés. Aucune migration, suppression de dossier ou nouvelle session.
- Livraison restante : relire le plan Terraform avant application et renouveler
  les tâches ECS ; vérifier que le paramètre opérateur `KYC_PROVIDER` sélectionne
  Didit. Aucun apply, changement SSM ou déploiement effectué ici.
- Vérifications : 11 tests backend `didit-session-launch` réussis ; suite mobile
  complète réussie. Changement limité à une valeur déjà admise par la validation
  Terraform existante. Pas de validate/plan/apply ni d'essai sur téléphone physique.
  Le retour au SDK ne démontre pas la résolution des expirations ou crashs Android.
- Recette : [guide mobile du retour SDK](../../../zwanga/docs/KYC_DIDIT_NATIVE_20261014.md).

## INFRA-2026-10-13-004 — Configuration KYC AWS prête à livrer, activation séparée

- Date/périmètre : 13 octobre 2026, configuration locale de production, non appliquée.
  Le diagnostic avait trouvé une tâche sans AWS_KYC_* et le rôle de capture absent.
- Appliqué dans les fichiers : `kyc.tf` gère huit SecureString via le KMS existant,
  valide quotas/seuils et refuse les doubles déclarations ; `ssm.tf` ajoute leurs ARN
  aux références générées/réservées. `ecs.tf` attend les deux policies KYC avant la
  définition de tâche. `production.auto.tfvars` prépare IAM/SSM mais garde la capture
  désactivée. Paramètres opérateur historiques/fournisseur et OTP non remplacés.
- Sécurité/disponibilité : IAM limité à la capture et aux actions backend déjà
  prévues ; pas de clé permanente ni rôle Cognito public. Le state reste sensible.
  Pas de migration, suppression d'archive, nouveau bucket/serveur ni nouveau déploiement.
  Préparation sans vérification payante ; les essais et usages futurs restent facturables.
- Déploiement : nouveau plan relu, import préalable des éventuels paramètres
  externes homonymes, application approuvée, recette native, puis activation et
  livraison `release`. Pas de réutilisation de l'ancien plan Didit ni de push automatique.
- Surveillance : santé ECS/ALB, erreurs par catégorie, quotas, expirations et coût.
  Retour arrière par désactivation et remplacement des tâches ; `prevent_destroy`
  protège les paramètres, sans promettre la poursuite des captures pendant l'arrêt.
- Procédure et limites : [guide Amplify / AWS KYC](../../docs/operations/aws-kyc-amplify-rollout-2026-10-13.md).
- Vérifications : format des quatre fichiers Terraform et `terraform validate`
  réussis sous WSL (après un premier timeout du plugin pendant la compilation
  native simultanée). 92 tests backend ciblés passent, 13 tests PostgreSQL optionnels
  non exécutés dans cette commande. Compilation backend finale réussie ; les erreurs
  d'un changement administratif concurrent ont disparu sans modification de ce
  changement par ce correctif. Pas de preuve d'autorisation IAM réelle à ce stade.
- Plan de production lu/sauvegardé, non appliqué : 12 créations, 0 modification,
  1 suppression (ancienne définition de tâche uniquement). Service ECS actif
  inchangé, pas de remplacement RDS/Redis/S3/KMS, activation désactivée confirmée
  par lecture structurée. Régénérer le plan si l'environnement évolue avant apply.
- Limite native : relance Android après rafraîchissement des dépendances, puis
  blocage sur le compilateur hôte Hermes/`nmake` absent sous Windows. Aucun AAB
  final ou test biométrique physique déclaré validé ; build EAS/Linux requis.

## INFRA-2026-10-13-003 — Préparation IAM de la bascule KYC AWS

- Nouveau `kyc.tf` : rôle STS de capture à permission unique, policy backend
  Rekognition/Textract/AssumeRole et effacement des versions sous `kyc/evidence/`.
  Trust limitée au rôle ECS et aux rôles de développement explicitement déclarés.
- `enable_aws_kyc_permissions=false` par défaut : activation IAM séparée de
  l'activation métier. Région de traitement `eu-west-1`, sans déplacer ECS/S3/RDS.
  Sortie `aws_kyc_runtime_configuration` indicative ; aucune écriture SSM par ce fichier.
- `terraform.tfvars.example` documente l'opt-in. Aucun changement de CI/CD,
  `ecs.tf`, `oidc.tf` ou des variables réelles de production ; aucun apply exécuté.
- `terraform fmt kyc.tf` et `terraform validate` exécutés avec succès dans WSL.
  Pas de simulation d'autorisation IAM réelle ni de vérification biométrique facturée.
- Procédure et limites : [KYC AWS](../../docs/auth/aws-kyc.md), notamment migration
  existante, bucket privé, nouveau binaire natif et nouveaux paramètres SSM avant ECS.

## INFRA-2026-10-13-002 — Rectification du diagnostic Didit, sans changement AWS

- Le workflow existait et fonctionnait avant la mise à jour mobile, selon le signalement
  utilisateur. L'historique backend confirme l'absence de précontrôle de publication.
  Le `503 KYC_WORKFLOW_NOT_PUBLISHED` provenait d'une nouvelle dépendance ajoutée au
  diagnostic, pas d'une réponse observée de l'API de création de sessions.
- `DiditKycService.createSession` retrouve l'appel direct à `POST /v3/session/` avec
  le workflow configuré inchangé. L'API Didit reste souveraine pour accepter/refuser
  la session ; les contrôles d'expiration, d'URL, de propriétaire et de décision restent.
- Le mode `hosted` est conservé. Le diagnostic administratif et son option explicite
  de publication restent séparés, mais ne sont plus des prérequis de livraison ou de
  recette. Ne pas publier automatiquement le workflow pour résoudre le message SDK.
- Aucun changement Terraform, CI/CD, paramètre AWS ou workflow Didit effectué dans
  cette rectification. Aucune session fournisseur créée par les tests unitaires.
- L'entrée 001 ci-dessous décrit la préparation initiale ; ses consignes de blocage
  et de publication préalable sont remplacées par cette entrée et le
  [guide corrigé](../../docs/operations/didit-kyc-recovery-2026-10-13.md).

## INFRA-2026-10-13-001 — Préparation de la continuité KYC Didit

- **Statut / date / périmètre :** code et configuration préparés localement le
  13 octobre 2026 (Africa/Kinshasa), après diagnostic en lecture seule. Aucun apply,
  déploiement ECS, écriture SSM ou publication Didit exécuté dans cette livraison.
- **Contexte / preuves :** message d’expiration après photo sur Android, déclaré
  général. API/ALB saine ; workflow référencé en brouillon, sans publication de son
  groupe ; dossiers récents non expirés au moment du contrôle. L’origine exacte du
  message SDK demeure à confirmer ; une durée longue n’est pas une preuve de jeton valide.
- **Code préparé :** `src/users/didit-workflow-guard.ts` et intégration service
  empêchent la création sur workflow non publié et refusent les sessions inutilisables.
  `didit-session-launch.ts` ajoute un mode hébergé strictement limité au lien Didit de
  la même session, compatible avec les anciennes apps sans nouveau build.
  `didit-kyc-preflight.ts` fournit un contrôle en lecture seule et une option explicite
  de publication ciblée, sans choisir un autre workflow ou créer de dossier facturable.
- **Infrastructure / variables :** `variables.tf`, `ecs.tf`, `production.auto.tfvars`
  ajoutent `didit_kyc_launch_mode` (`native` par défaut, `hosted` préparé en production).
  Nom SSM `DIDIT_KYC_LAUNCH_MODE`, produit via le mécanisme existant et réservé à
  Terraform. Les clés et références Didit existantes sont conservées, sans valeur dans
  la documentation. Future révision ECS seulement ; pas de ressource ni permission IAM nouvelle.
- **Disponibilité / sécurité / données :** le mode web évite le SDK défaillant sous
  réserve de recette Android/iOS ; mêmes contrôles d’identité et propriétaire, signatures
  de webhook et statut serveur. Aucune approbation forcée, nouvelle dépendance ou migration.
  Le contrôle publication conserve un cache de succès de 60 s et mutualise les lectures ;
  pagination bornée, origine HTTP fixée. Les autres fonctionnalités et correctifs déjà
  présents ne sont pas supprimés.
- **Coûts :** pas de coût structurel nouvellement engagé ici. Lectures fournisseur
  additionnelles bornées. Les vérifications de recette et d’utilisateurs restent
  soumises à la facturation Didit ; le préflight n’en crée aucune.
- **Livraison / surveillance / rollback :** procédure et commandes dans
  [le guide de continuité](../../docs/operations/didit-kyc-recovery-2026-10-13.md).
  Revoir/publier le workflow configuré, vérifier le préflight, appliquer le plan
  Terraform approuvé, puis livrer l’image via le workflow `release` existant. Contrôler
  paramètres injectés, santé ECS/ALB et vraie capture Android/iOS. Retour au mode natif
  par plan et remplacement des tâches après recette ; aucun rollback de base. Une
  publication Didit se restaure par son versionnement, pas par une régression de statut.
- **Validation :** résultats de tests, compilation, contrôle réel en lecture seule
  et limites Terraform sont consignés dans `docs/CHANGEMENTS_TECHNIQUES.md` du dépôt
  mobile. Aucune disparition du blocage sur appareil annoncée avant livraison/recette.

## INFRA-2026-10-12-001 — Séparer vitalité et disponibilité

- **Statut / périmètre :** correctif dans le code local uniquement, le 12 octobre 2026 (Africa/Kinshasa). Aucun changement appliqué à AWS, aucun secret ni paramètre SSM modifié.
- **Constat vérifié :** `ecs.tf` et `Dockerfile` utilisaient la même sonde `/health` que le routage ALB. Cette sonde dépend de PostgreSQL, Redis et du contrat financier. Une panne partagée pouvait donc entraîner des redémarrages de processus sains ; amplification non reproduite en production.
- **Avant / après :** `src/health/health.controller.ts` expose `/health/live` sans accès externe ; `src/main.ts` l'exclut du préfixe API. `infra-aws/ecs.tf` et `Dockerfile` utilisent cette sonde pour la vitalité. ALB conserve `/health` et refuse toujours les requêtes sur dépendances ou schéma indisponibles. Les contrôles au démarrage restent inchangés.
- **Ressources / variables :** future révision de tâche ECS uniquement ; `ecs_container_port` reste utilisé, `alb_health_check_path` reste réservé à ALB. Ni ressource créée, ni IAM, redimensionnement, migration ou écriture de données. Aucun nouveau coût structurel attendu.
- **Limitation de débit :** seule la sonde `/health/live`, sans données métier et à coût constant, contourne le throttling Redis. Sans cette exemption, une panne Redis rendrait aussi la sonde de vitalité indisponible. La readiness et les routes métier gardent leurs limites.
- **Déploiement à faire :** publier d'abord une image avec `/health/live`, vérifier `/health` et `/health/live`, puis `terraform plan` dans `infra-aws`, examiner le plan et appliquer seulement après accord. Ne pas pointer une ancienne image vers la nouvelle sonde.
- **Vérifications locales :** test unitaire de vitalité sans dépendance ajouté dans `src/health/health.controller.spec.ts`, tests de readiness conservés. Aucun test de panne AWS ou appareil physique ; validations Terraform consignées dans le journal applicatif.
- **Surveillance après déploiement :** vérifier les cibles ALB, les tâches/redémarrages ECS, latences API et erreurs Redis/PostgreSQL pendant au moins 30 minutes, puis pendant une fenêtre de charge normale. Liveness seule ne garantit pas la disponibilité du service.
- **Retour arrière :** avant de revenir à une ancienne image, rétablir la sonde conteneur `/health` (ancienne définition ECS) ; examiner le plan et suivre la stabilisation. Aucune restauration de données nécessaire.


Les entrées sont classées de la plus récente à la plus ancienne. Elles décrivent le code versionné et les opérations réellement exécutées sur AWS, sans inclure de valeur secrète.

## INFRA-2026-10-10-002 — Correctifs de livraison après audit

- **Autorisation :** demande de mise en place des correctifs sans casser l'existant ; code uniquement, aucun apply, push d'image ou déploiement AWS exécuté.
- **Changements :** tests PostgreSQL/PostGIS isolés activés dans le workflow ; copie de la dernière configuration de la famille ECS et image API fixée au digest ; même révision pour migrations et service. Contrôle de stabilisation vérifiant que le déploiement attendu n'a pas été remplacé par un rollback.
- **Terraform :** circuit breaker ECS avec rollback ; `task_definition` du service pilotée par le workflow après migration. Terraform continue de publier la configuration, que le prochain workflow reprend. Permissions OIDC de lecture des définitions et d'enregistrement des révisions ajoutées, `PassRole` toujours limité aux rôles existants.
- **Ordre impératif :** relire/appliquer les changements IAM/ECS Terraform avant le premier workflow modifié. Après une modification Terraform/SSM, exécuter le workflow pour activer la configuration. Aucune transition financière `prepare` / `activate` réintroduite.
- **Base :** migrations additives 67 (reprises de dépôts FlexPay) et 68 (unicité des nouveaux avis vérifiés). Pas de suppression des données historiques. L'identité RDS d'exécution reste à séparer du compte maître.
- **Coût :** aucune augmentation des tailles ou du nombre de ressources. Les choix de haute disponibilité restent à valider séparément.
- **Retour arrière :** dernière révision saine via ECS ; ne pas annuler les migrations en supprimant des travaux financiers. Les nouvelles protections applicatives cessent si l'ancienne image est remise en service.
- **Guide :** [livraison et limites](../../docs/operations/audit-hardening-2026-10-10.md).

## INFRA-2026-10-10-001 — Staging EC2 à la demande avec Ansible, Docker et Caddy

- **Contexte/autorisation :** usage rare et court, budget privilégié ; choix EC2
  à la demande confirmé par l'utilisateur puis demande explicite d'Ansible,
  Caddy et Docker. La proposition managée de l'entrée précédente est remplacée.
- **État : configuration validée localement, plan revu, pas d'apply AWS.** Lecture
  STS : compte `046374119247` ; aucun EC2 staging et aucun objet state à
  `zwanga/staging/terraform.tfstate` lors du contrôle. Initialisation du backend
  S3 staging et premier plan réel sans verrou distant : **36 créations, 0
  modification, 0 destruction**. Plan final régénéré après adaptation Ansible et
  paramètre write-only : mêmes **36 créations, 0 modification, 0 destruction**.
  Lecture du JSON du plan : cible DNS staging exacte, `t4g.medium`, user-data de
  12 690 octets (sous la limite EC2 de 16 384). Aucun apply n'a été exécuté.
  Aucun secret de production consulté, aucun export RDS lancé, aucune branche,
  variable GitHub, image ECR ou ressource AWS créée par cette préparation.
- **Fichiers :** racine `infra-aws/environments/staging/` désormais indépendante
  (Terraform réseau/stockage/EC2/IAM/contrôleur/SSM), playbooks Ansible et template
  Caddy, helpers Docker/DB et export schema-only, tests Python/PostgreSQL/Terraform.
  `.github/workflows/deploy-staging.yml` remplacé par un workflow manuel uniquement.
  `.gitignore`, garde documentaire, README et ce journal mis à jour. Les ajouts
  antérieurs à `providers.tf`, `database.tf`, `variables.tf` de production sont
  retirés : leurs contenus et le workflow de déploiement production sont inchangés.
- **Architecture/coûts :** un EC2 ARM64 `t4g.medium`, Ubuntu 24.04, gp3 chiffré
  30 GiB, VPC/subnet/IGW dédiés, aucun NAT/ALB/RDS/ElastiCache/EIP. Docker : backend,
  PostgreSQL 18.3 + PostGIS construit en CI ARM64, Valkey 7.2.6, Caddy 2.10.2.
  ECR/S3 privés staging, Lambda ARM64 128 MiB et EventBridge toutes les cinq
  minutes, logs du contrôleur sept jours. Coût socle estimé 2,86 USD/mois éteint,
  3,07 pour 5 h, 3,72 pour 20 h ; budget indicatif 5–8 USD avec petits volumes,
  hors taxes/fournisseurs/traffic/sauvegardes additionnelles. Mode CPU Standard,
  pas de coût Unlimited mais bridage possible. Les images taguées, artefacts et
  backups locaux sont conservés : croissance à surveiller, pas de plafond garanti.
- **Configuration/Ansible :** cloud-init installe Ansible et AWS CLI ; le playbook
  local `configure.yml` gère Docker/Compose, Caddy, permissions et unités systemd.
  SSM exécute `deploy.yml` sans SSH, depuis un bundle publié par la CI sous un SHA
  Git validé. Les images sont immuables et construites avant de démarrer EC2.
  Le premier boot installe puis arrête EC2 ; aucune API ne démarre sans bootstrap.
- **IAM/isolation :** OIDC limité à `GroupeBH/zwanga-api:refs/heads/staging` ; CI
  limitée aux ECR/bucket de releases, contrôleur et document/instance SSM staging.
  Le rôle hôte n'utilise pas la politique SSM standard trop large en lecture de
  paramètres : lecture d'un seul paramètre staging, des artefacts et de ses médias.
  Le contrôleur ne peut démarrer/arrêter que cet EC2, ni modifier d'autre DNS que
  l'enregistrement A exact du staging. Aucun port SSH/DB/cache/API direct public.
  IMDSv2 obligatoire, hop limit 2 pour le SDK AWS dans Docker, aucun accès statique.
- **Paramètres :** `/zwanga-api/staging/integrations`, SecureString JSON `{}` au
  départ, initialisé via `value_wo` (Terraform >= 1.11) sans valeur conservée dans
  le state. La version write-only reste fixée à 1 ; gestion des clés test dans SSM.
  Allowlist des noms ; DB/JWT/AWS/domaine/URL pawaPay non remplaçables.
  pawaPay sandbox et opérations désactivées, FlexPaie non configuré, Didit KYC
  désactivé par défaut. Variables GitHub `STAGING_AWS_ROLE_ARN`, `STAGING_INSTANCE_ID`.
  Mots de passe DB/cache/JWT générés sur disque root-only, pas dans le state.
- **Données :** export explicite du schéma public et des métadonnées de migrations
  dans un snapshot SQL read-only cohérent ; checksum, choix financier et SHA source
  dans le manifeste. Aucun dump complet ni données personnelles. Import refusé
  si données ou base non vide. Rôle propriétaire pour migrations distinct du compte
  API non-superutilisateur. Backup local avant migration, pas de rollback SQL
  automatique ; marqueur empêchant de reprendre une vieille API après échec.
  Fixtures métier et clés externes restent à fournir avant recette fonctionnelle.
- **Disponibilité :** sessions de deux heures, timer local + watchdog AWS (jusqu'à
  cinq minutes de délai), arrêt sur échec CI. Pas d'IP fixe : DNS mis à jour au
  start et neutralisé au stop ; arrêt hors workflow traité au prochain watchdog.
  Aucun redémarrage automatique à l'arrivée d'une requête mobile ; pas de HA ni
  validation équivalente des services managés de production. Interruption de
  staging pendant sauvegarde/migrations ; production hors périmètre.
- **Contrôles :** syntaxe Ansible valide sans exécution de configuration,
  Terraform validate et test simulé après adaptation Ansible réussis. Les **19
  tests Python/PostgreSQL sont verts**, dont export read-only réel puis import
  sur PostgreSQL 18 jetable : aucun compte source copié, métadonnées conservées,
  compte API autorisé en DML mais refusé en DDL, second bootstrap refusé. Cluster
  arrêté et nettoyé. Le test a détecté et permis de corriger la tentative de recréer
  `public` : seule cette entrée TOC est omise, aucune suppression de schéma.
  Lanceur pg_ctl Windows corrigé pour ne pas hériter de pipes bloquants. YAML CI
  et Compose généré valides ; Docker Desktop arrêté, pas de build/recette conteneur
  locale. Garde documentaire normalisée LF et validée ; `git diff --check` réussi.
  Comparaison Git explicite : aucun changement de contenu du workflow de production
  ni de ses fichiers providers/database/variables. Plan final revu ; recette AWS,
  construction des images ARM64 et parcours applicatifs encore non exécutés.
- **Déploiement/rollback :** suivre le README : plan staging revu, apply, premier
  arrêt, publication branche/workflow, variables GitHub, export approuvé et upload
  bootstrap par l'opérateur, clés test, actions bootstrap/deploy et recette mobile.
  Une modification des fichiers invalide le plan précédent. `stop` conserve EBS,
  pas de destruction automatique ; suppression/replacement nécessite une revue
  explicite des sauvegardes, `prevent_destroy` et du volume conservé. Aucune action
  à mener sur ECS/RDS/SSM/state production. Un schéma avancé ne doit pas être rétrogradé.

## INFRA-2026-10-09-001 — Préparation du staging isolé et arbitrage des coûts

> Proposition initiale remplacée par le staging EC2/Ansible de l'entrée du 10 octobre.

- **Date/environnement/statut :** 9 octobre 2026, Africa/Kinshasa ; staging,
  configuration locale préparée, **aucune ressource AWS créée ou modifiée**.
  Même compte `046374119247`, région `eu-central-1` et domaine
  `staging.compute-api.zwanga-app.com` confirmés par l'utilisateur. La préparation
  est ensuite interrompue pour comparer les coûts à sa demande ; ne pas confondre
  cette entrée avec un staging déjà opérationnel.
- **Avant/après local :** la production reste la racine Terraform et le workflow
  `deploy.yml` historiques. Nouvelle racine `environments/staging/{main,variables,
  outputs}.tf`, verrou providers et test `tests/isolation.tftest.hcl`. Réutilisation
  du module commun, clé de state séparée, CIDR distinct, ECS/ECR/RDS/Valkey/SSM/KMS,
  ALB/ACM et bucket privé propres au staging. Le provider OIDC et la zone DNS du
  compte sont réutilisés sans reprendre le rôle CI/CD ni le domaine de production.
- **Fichiers partagés :** `variables.tf`, `providers.tf` et `database.tf` ajoutent
  une allowlist de compte et une version PostgreSQL facultatives, nulles par
  défaut pour conserver le comportement production. `.gitignore` exclut les
  variables et plans locaux staging. `README.md` explique les limites actuelles.
- **CI/CD :** nouveau `deploy-staging.yml`, branche `staging`, variables GitHub
  `STAGING_AWS_REGION`, `STAGING_AWS_ROLE_ARN`, `STAGING_ECR_REPOSITORY`,
  `STAGING_ECS_CLUSTER`, `STAGING_ECS_SERVICE`. Vérification explicite des noms,
  du rôle et du compte avant accès AWS, groupe de concurrence et cache distincts.
  Le contrôle documentaire couvre désormais `deploy*.yml` et la branche staging.
  Aucun paramètre GitHub, branche distante, image ou déploiement créé.
- **Lecture AWS uniquement :** ECS 512 CPU/1024 MiB ARM64, une tâche ; RDS
  PostgreSQL 18.3, `db.t4g.micro`, 20 GiB extensibles à 100, Single-AZ et sept jours
  de sauvegardes ; Valkey 7.2.6 sur un `cache.t4g.micro` ; domaine Route53 et blocage
  public du bucket de production confirmés. Aucune lecture de secrets, d'objets
  S3 ou de données utilisateurs. Aucun `terraform plan` connecté ni `apply`.
- **Sécurité/IAM/données :** nouveaux rôles staging limités à ses préfixes SSM,
  bucket et ressources ECS/ECR ; nouvelles clés JWT et secrets DB/Redis générés
  lors d'un futur apply. Aucun partage de base/cache ou de clé fournisseur avec
  la production. Le service reste à zéro tâche jusqu'au bootstrap. Il manque la
  procédure validée d'initialisation du schéma et des métadonnées de migrations
  sans données personnelles, les clés test et la configuration GitHub. Le guide
  PostgreSQL est utilisé pour cette séparation ; aucun dump/import n'est réalisé.
- **Coûts estimés, pas une facture :** catalogue public AWS consulté le 9 octobre,
  Francfort, 730 heures/mois, paiement à l'usage, hors taxes/crédits/remises et
  consommations externes. Fargate ARM : 0,03725 USD/vCPU-h et 0,00409 USD/GiB-h,
  soit environ 16,58 USD/mois pour la tâche. RDS : 0,019 USD/h, soit 13,87 hors
  stockage. Valkey : 0,0144 USD/h, soit 10,51. ALB : 0,027 USD/h, soit 19,71 hors
  LCU (0,008 USD/LCU-h). Trois IPv4 minimales indicatives : environ 10,95 USD/mois.
  Ajouter stockage RDS/S3, sauvegardes, logs, KMS, trafic et audit. Budget indicatif
  **80–110 USD/mois** pour la copie permanente ; **55–75 USD/mois** pour ECS/RDS
  limités à 8 h × 22 jours avec ALB/Valkey conservés. Ces horaires ne sont pas codés.
- **Alternative discutée, non implémentée :** un Lightsail Linux 4 Go/2 vCPU/80 Go
  coûte 24 USD/mois avec IPv4 incluse ; prévoir environ **30–40 USD/mois** avec un
  petit volume de sauvegardes/S3. Backend, PostgreSQL et Valkey en conteneurs sur
  un serveur unique : parité applicative visée, mais pas de parité ECS/RDS/ElastiCache
  ni de validation identique du réseau, des permissions et déploiements managés.
  Ne pas mutualiser la base de production pour économiser. RDS peut être arrêté,
  mais redémarre automatiquement après sept jours et son stockage reste facturé.
- **Sources tarifaires :** [Fargate](https://aws.amazon.com/fargate/pricing/),
  [RDS PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/),
  [ElastiCache](https://aws.amazon.com/elasticache/pricing/),
  [ALB](https://aws.amazon.com/elasticloadbalancing/pricing/),
  [IPv4](https://aws.amazon.com/vpc/pricing/),
  [Lightsail](https://aws.amazon.com/lightsail/pricing/).
- **Validation :** `terraform fmt` et `terraform validate` staging réussis, avec
  avertissement attendu de backend ignoré dans le module enfant : seul le backend
  de la racine staging est utilisé. Accès au registre providers indisponible depuis
  WSL ; initialisation hors backend avec les versions déjà installées (AWS 6.58.0,
  random 3.9.0). Premier test simulé : défaut de valeur inconnue pour le bucket,
  corrigé en utilisant son nom déterministe ; recontrôle réussi (**1 test simulé,
  0 échec**). Syntaxe YAML du workflow staging et `git diff --check` également
  validés. Ni pipeline GitHub ni parcours applicatif staging exécutés.
- **Déploiement ultérieur :** choisir le budget/architecture, finaliser et tester
  bootstrap et configuration de test, initialiser exclusivement la racine staging
  avec son backend S3, revoir un plan ne visant que les nouvelles ressources,
  approuver les coûts, appliquer, initialiser la base, fournir les secrets test,
  configurer `STAGING_*`, puis démarrer une tâche et vérifier HTTPS/OTP/KYC/paiements
  sandbox/notifications de test. Les clés réellement utilisables et les callbacks
  de fournisseurs doivent être explicitement configurés avant de tester leurs flux.
- **Surveillance/retour arrière :** surveiller budget, CPU/mémoire, erreurs HTTP,
  connexions DB/cache, logs et absence d'appels fournisseurs de production. Avant
  tout apply, abandonner cette préparation locale n'exige aucune action AWS. Après
  création future, couper seulement le service staging ne supprimera pas la facture
  ALB/RDS/Valkey ; toute destruction et sauvegarde nécessitera une revue de ses
  protections, uniquement dans son state, jamais dans celui de production.

## INFRA-2026-10-08-007 — Conservation KYC sans expiration, préparée localement

- **État : code local validé, 8 octobre 2026, Africa/Kinshasa ; aucun changement AWS.** L'utilisateur a choisi une conservation indéfinie après l'entrée 006. Aucun Terraform, CI/CD, IAM, secret, `.env` réel, tâche ECS ou configuration du dispatch modifié.
- Avant/après : la durée positive était obligatoire ; `DIDIT_KYC_ARCHIVE_RETENTION_DAYS=0` signifie désormais aucune expiration liée à l'âge. Vide/absent reste refusé. Les trois exemples d'environnement utilisent `0`, mais `DIDIT_KYC_ARCHIVE_ENABLED=false` est conservé et les hôtes restent à renseigner.
- Code/données : migration complémentaire `1780000062000-KycEvidenceIndefiniteRetention`, ajoutée à l'index sans modifier la 61. Rend `expiresAt` nullable via une opération de métadonnées transactionnelle, verrou limité à 5 s et requête à 15 s, sans réécrire les dossiers existants. Politique, file, capture et tests adaptés à `NULL`. Aucun changement de verdict KYC ou de notification.
- Disponibilité/confidentialité : les archives sans échéance restent accessibles aux admins autorisés, avec audit. Suppression admin ou suppression du dossier/compte = révocation immédiate et purge asynchrone inchangée. Les permissions S3 de l'entrée 006 restent requises, même sans expiration. La conservation chez Didit et les sauvegardes ne sont pas modifiées ; vérifier qu'aucune règle lifecycle ne supprime le préfixe indépendamment de l'application.
- Déploiement à faire : appliquer 61 puis 62 par la procédure habituelle avant activation ; déployer le backend, contrôler stockage privé/IAM/hôtes, faire la recette Didit/S3 et adapter l'information des utilisateurs. Ajouter la valeur `0` à SSM puis remplacer les tâches ECS selon le flux habituel ; aucun import ni déploiement n'a été effectué ici.
- Coûts : conservation S3 susceptible de croître sans borne temporelle et lectures/purges à surveiller ; aucun nouveau service ni coût cloud engagé par cette intervention, aucune estimation tarifaire faite.
- Validation : 86 tests KYC ciblés, 13 tests PostgreSQL 18 jetable et compilation réussis ; cluster arrêté/nettoyé. Tests couvrant l'absence de purge par âge, les suppressions admin/compte et la préservation des anciennes échéances. Pas de suite globale relancée, de plan/apply/validate Terraform, de push réel ou de recette native.
- Surveillance/retour arrière : surveiller volumes S3, échecs de capture/purge et accès admin. Désactiver la collecte conserve les purges demandées ; ne pas revenir à l'ancien code pour lire des échéances nulles, ni forcer un `down`. Revenir à une durée positive ne modifie que les nouvelles archives : changement des anciennes durées à traiter séparément et explicitement. Documentation : [guide Didit](../../docs/finance/kyc-didit-integration.md#8-octobre-2026--archivage-privé-des-justificatifs-didit).

## INFRA-2026-10-08-006 — Archivage privé des justificatifs KYC, préparé sans activation AWS

- **État : code local uniquement, 8 octobre 2026, Africa/Kinshasa.** Aucun déploiement, appel Didit/S3, migration RDS, push, modification IAM/Terraform/CI/CD ou crédit réel. Les changements de dispatch de l'entrée 005 sont conservés sans intervention.
- Avant : stockage du verdict Didit et résumé technique seulement ; médias externes non archivés. Après : migration `1780000061000-KycEvidenceArchive`, file SQL et audit, worker NestJS, routes admin authentifiées et copies normalisées privées dans `kyc/evidence/*`. Les endpoints mobiles et la validation KYC restent compatibles.
- Modifications : `src/users/kyc-evidence/*`, intégrations `didit-kyc.service.ts` / `admin.service.ts` et modules, migration/index, tests et exemples `.env.example`, `.env.docker.example`, `.env.production.example`. Aucune valeur de `.env` réel consultée ou modifiée.
- Nouveaux paramètres runtime facultatifs tant que la fonctionnalité reste éteinte : `DIDIT_KYC_ARCHIVE_ENABLED=false`, `DIDIT_KYC_ARCHIVE_RETENTION_DAYS` (à décider), `DIDIT_KYC_MEDIA_HOSTS` (hôtes exacts vérifiés). Réutilisation des variables Didit KYC, région et bucket existantes. Aucun nouvel identifiant AWS statique ni nouvelle dépendance.
- IAM/stockage : bucket privé et blocage public à vérifier avant activation ; chiffrement SSE-S3 AES256 explicite, clés immuables, aucun accès S3 direct exposé aux clients. Ajouter après revue `s3:ListBucketVersions` sur le bucket avec condition de préfixe `kyc/evidence/*`, et `s3:DeleteObjectVersion` sur les objets de ce préfixe. La purge énumère et supprime les versions/markers de chaque clé exacte ; les permissions actuelles Get/Put/Delete ne suffisent pas. Ces permissions n'ont pas été ajoutées automatiquement. Object Lock, lifecycle, réplication et sauvegardes doivent être examinés selon la durée choisie.
- Données/disponibilité : migration transactionnelle avec délais bornés et index de file ; aucune réécriture des anciens KYC ou données financières. Les téléchargements sont hors transaction, erreurs réseau reprises sans retirer l'approbation. La suppression d'un dossier invalide immédiatement l'accès, mais l'effacement S3 est asynchrone et surveillé ; références conservées en cas d'échec. La suppression des données chez Didit reste une procédure distincte.
- Coûts futurs : stockage/requêtes S3, lecture d'une décision Didit et téléchargements, CPU de normalisation et audit RDS ; aucun tarif chiffré ni gratuité supposée. Aucun coût cloud engagé pendant cette intervention.
- Déploiement prévu : sauvegardes/préconditions, migration 61 via procédure habituelle, backend avec collecte désactivée, contrôle du bucket/IAM et recette synthétique, décision de conservation/information des utilisateurs, puis ajout des paramètres validés et remplacement des tâches ECS. Ne pas activer sans confirmer les hôtes et la purge effective. Aucun apply ni plan Terraform nécessaire pour les seuls fichiers applicatifs ; une éventuelle extension IAM doit suivre une revue distincte.
- Surveillance : files `pending`/`failed`/`partial`, échéances, `ARCHIVE_PURGE_FAILED`, volumes/latences S3 et journal des accès admin. Régression à vérifier : même approbation KYC, même notification et même unicité du bonus. Retour arrière fonctionnel : remettre la collecte à `false` tout en gardant le worker de purge ; pas de `migration:revert` destructeur ni promesse d'effacement immédiat des sauvegardes.
- Documentation métier et recette : [intégration Didit](../../docs/finance/kyc-didit-integration.md#8-octobre-2026--archivage-privé-des-justificatifs-didit). Les vérifications locales ne remplacent pas une recette Didit/S3 autorisée.
- Validation locale : compilation backend réussie ; suite complète exécutée avec 1 491 tests réussis, 176 ignorés et 138 suites réussies ; puis 81 tests KYC ciblés après les derniers ajustements de concurrence et purge S3 ; 9 tests PostgreSQL 18 jetable réussis, cluster arrêté et supprimé après tests. Pas d'apply ni validate Terraform (aucun fichier Terraform modifié). Aucun fichier OTP ou script dispatch concurrent modifié par ce travail.

## INFRA-2026-10-08-005 — Activation des propositions au conducteur proche

### Contexte, autorisation et état initial

- Production, 8 octobre 2026 ; activation lancée à 07:56, fuseau Africa/Kinshasa.
  Statut final : **appliqué, service stable et configuration runtime vérifiée**.
  Opération autorisée dans la
  conversation après confirmation que les notifications iOS restaient standard.
- Le service utilisait la révision ECS 13 sans référence au paramètre
  `DRIVER_DISPATCH_ENABLED`. Le code et la sonnerie pouvaient être à jour sans
  que le flux de propositions ciblées soit actif. Les annonces générales
  `trip_request` conservent volontairement le son standard.
- Le contrôle de l'archive iOS 1.0.16 (134), documenté côté mobile, avait confirmé
  le WAV embarqué de 29 secondes. L'activation serveur ne démontre pas à elle
  seule sa lecture acoustique sur l'iPhone signalé.

### Changements appliqués et fichiers

- Création du seul paramètre runtime `DRIVER_DISPATCH_ENABLED` dans SSM, de type
  `SecureString`, avec la clé KMS applicative existante. Sa valeur n'est pas
  reproduite dans ce journal. Aucun import global de fichier d'environnement.
- Nouvelle révision ECS **14**, copiée de la **13**, ajoutant la référence à ce
  paramètre sur le conteneur API. Image applicative, sidecar, rôles IAM, réseaux,
  ports et dimensionnement conservés ; pas de reconstruction Docker.
- Service `zwanga-api-production-api` mis à jour vers cette révision. Déploiement
  progressif existant : minimum sain 100 %, maximum 200 %. Pas de `terraform apply`
  global, de modification du CI/CD ou d'activation du déploiement financier.
- `infra-aws/scripts/check-driver-dispatch.cjs` : contrôle exécuté dans l'image
  backend sans lancer Nest ni ses tâches planifiées. Une connexion PostgreSQL
  TLS vérifiée, session et transaction en lecture seule, délais bornés. Vérifie
  colonnes, index, migrations et code de présence automatique. Simule le transport
  Expo pour contrôler le son et les catégories, sans envoyer de notification.
- `infra-aws/scripts/invoke-driver-dispatch-preflight.ps1` : lance ce contrôle dans
  une tâche Fargate temporaire utilisant les mêmes accès réseau et références SSM.
  Refuse un service instable ou un tag d'image différent de l'image active.
- `infra-aws/scripts/enable-driver-dispatch.ps1` : exige le résultat positif de la
  tâche de contrôle et le même digest d'image ; refuse d'écraser un paramètre déjà
  présent ou une configuration concurrente. Sauvegarde les métadonnées de retour
  arrière dans un dossier temporaire, crée le paramètre, enregistre la révision
  puis déclenche le déploiement. Ne pas relancer aveuglément après une erreur
  partielle : inspecter les étapes déjà accomplies.

### Vérifications réellement effectuées

- Avant activation : service stable, tâche saine, tag ECR `latest` identique au
  digest de la tâche active. Le contrôle Fargate utilise ce même digest.
- Contrôle runtime avant activation réussi : schéma et index requis présents,
  toutes les migrations connues de l'image déjà appliquées, code de présence
  automatique présent ; serializer Expo compilé correct pour les capacités v0/v2,
  réservations et invitations ciblées, annonces générales conservées standard.
  Le conteneur de contrôle est sorti avec le code 0 ; aucune migration exécutée.
- Après lancement : santé HTTPS `/health` = 200 ; nouvelle tâche avec les mêmes
  digests API et sidecar que l'ancienne. Révision 14 `COMPLETED`, une tâche
  `RUNNING/HEALTHY`, aucune en attente ni en échec de démarrage ; cible ALB saine.
- Comparaison des paramètres des révisions : un seul ajout, une référence SSM
  dans `containerDefinitions[0].secrets`. Aucun autre paramètre runtime modifié.
- Deuxième contrôle Fargate après stabilisation : conteneur API sorti avec le
  code 0 ; activation chargée confirmée, contrôles schéma/migrations/code/payload
  de nouveau positifs. Deux tâches de contrôle au total, toutes deux arrêtées.
- Échantillon des journaux post-déploiement : pas d'erreur liée explicitement au
  composant ou aux routes du dispatch dans les 300 entrées consultées. Des erreurs
  du composant `WelcomeBonusService` subsistent et existaient aussi sur la révision
  précédente ; elles ne sont pas corrigées par cette activation. Ne pas interpréter
  la santé ECS comme une absence générale d'erreurs applicatives.
- Syntaxes JavaScript/PowerShell vérifiées. Aucun compte réel, réservation,
  acceptation ou paiement créé pour tester. Pas de validation acoustique iPhone.
- Contrôle documentaire `check-infra-documentation.sh HEAD WORKTREE` et
  `git diff --check` réussis. Les scripts opérationnels n'introduisent aucune
  nouvelle dépendance. Pas de compilation mobile ni de nouvelle bêta publiée.

### Exploitation, impacts et retour arrière

- Procédure utilisée : lancer `invoke-driver-dispatch-preflight.ps1`, attendre la
  sortie réussie du conteneur API et vérifier le résultat CloudWatch dédié, puis
  lancer `enable-driver-dispatch.ps1 -PreflightStatePath <fichier retourné>`.
  Surveiller ensuite ECS, ALB, `/health` et les erreurs du dispatch.
- Le paramètre suit la découverte SSM existante de `infra-aws/ssm.tf` : le prochain
  plan Terraform doit conserver sa référence. La mise à jour ECS manuelle doit
  être prise en compte avant tout apply ultérieur. Le workflow historique avec
  l'image `latest` reste utilisable ; aucun épinglage permanent du tag ajouté.
- IAM, certificats, routage, secrets existants et données métier inchangés.
  L'activation concerne les nouvelles demandes immédiates ; aucune conversion
  rétroactive des demandes générales. Les réservations publiées et leurs alertes
  restent indépendantes de ce drapeau. Les contrôles d'identité, véhicule,
  proximité, position récente, conducteur occupé et compatibilité push subsistent.
- Coûts : paramètre SSM supplémentaire, tâche(s) de contrôle Fargate éphémères et
  chevauchement temporaire de deux tâches pendant le rolling deployment ; aucun
  nouveau service permanent ni redimensionnement. Impact financier non mesuré.
- Retour arrière initial : remettre le service sur `zwanga-api-production-api:13`
  et attendre sa stabilité. Cette révision ne référence pas le paramètre ; ne pas
  supprimer de lignes SQL ni de propositions pour revenir en arrière. Si des
  propositions réelles ont déjà été émises, examiner leur état et les laisser
  terminer/expirer selon le parcours existant ; le retour arrière n'annule pas
  automatiquement les engagements déjà pris. Pour un retrait durable, désactiver
  ensuite le paramètre SSM et redéployer de façon contrôlée, afin d'éviter une
  réactivation au prochain plan Terraform. Ne pas utiliser la révision 13 si de
  nouveaux changements applicatifs/configurations ont été déployés entre-temps.

### Recette restante sur appareils

Rouvrir les apps passager et conducteur pour rafraîchir le statut serveur,
enregistrer les actions push et obtenir une position récente du conducteur.
Verrouiller l'iPhone du conducteur puis créer une **nouvelle** demande avec départ
« Maintenant », proche et compatible avec son véhicule. Vérifier la proposition
ciblée, le son, Accepter/Refuser et l'arrêt à l'ouverture ; refaire séparément une
réservation publiée. Les valeurs par défaut du code sont conservées : réponse
30 secondes, rayon 5 km, position utilisable pendant 5 minutes. Une position trop
ancienne, un conducteur occupé ou inéligible empêchent normalement la proposition.
Le contrôle serveur positif ne prouve ni la livraison APNs ni l'audibilité iOS.

## INFRA-2026-10-08-004 — Plafond cash cumulatif, sans changement du pipeline

- Préparé localement : migration applicative `1780000060000-CumulativeCashDebtLimit`, déclarée dans l'index TypeORM, et règles API associées. Aucune modification de workflow, Terraform, IAM, SSM ou ressource ; aucune action AWS.
- La dette cash autorisée est cumulée par conducteur : 25 jetons au total, et non par réservation. Les publications explicites incompatibles sont refusées ; les publications anciennes aux modes implicites conservent leurs autres modes sans cash. Les réservations déjà acceptées restent terminables.
- Migration transactionnelle, délais bornés, corps de fonctions vérifiés et verrous existants conservés ; aucun recalcul historique, solde ou notification passée modifié. Le `down` refuse l'annulation financière ; privilégier une correction en avant.
- Le contrôle de capacité à la publication fonctionne aussi en mode préparé. **Le drapeau `financial_rollout.enabled` n'est pas activé** : si faux, les réservations/prélèvements/régularisations cash restent inactifs. Contrôler son état effectif avant de considérer le flux actif ; ne pas le basculer pendant la coexistence avec un backend incompatible. Le workflow historique reste inchangé et ne le bascule pas.
- Déploiement prévu : migration via la procédure existante puis backend, et distribution de la mise à jour mobile pour le grisement et les nouvelles explications. Surveiller migrations, erreurs `CASH_DEBT_OUTSTANDING`/`CASH_COMMISSION_INSUFFICIENT` et finances après déploiement. Les limites de rolling deployment décrites dans l'entrée 002 restent applicables.
- Détails, invariants et tests : [journal financier](../../docs/finance/CHANGELOG.md#2026-10-08--tolérance-cash-cumulée-utilisable-tant-que-la-dette-reste-dans-les-25-jetons). Aucun accès RDS, paiement, notification réelle ni serveur applicatif lancé.
- Contrôles locaux finaux : 345 tests backend ciblés et 104 tests PostgreSQL isolés réussis (respectivement 8 et 3 ignorés), 49 tests mobile réussis, compilation backend et TypeScript mobile valides. Le cluster de test a été arrêté/nettoyé automatiquement. Aucun workflow ou fichier Terraform modifié.

## INFRA-2026-10-08-003 — Texte du bonus conducteur, sans modification du CI/CD

- Préparé localement, non déployé : migration applicative `1780000059000-DriverWelcomeBonusCopy`, enregistrée dans `src/database/migrations/index.ts`, et copie des notifications ORM. Le pipeline historique et tous les fichiers Terraform sont inchangés.
- Nouveau texte : « 5 000 FC vous sont offerts sous forme de jetons Zwanga pour vous permettre de payer votre abonnement Pro ». La fonction SQL conserve son crédit de 50 PTS, son éligibilité et sa déduplication ; seule la copie conducteur change. Pas de recrédit ni de renvoi aux bénéficiaires existants, pas de modification des notifications déjà stockées.
- Déploiement prévu : build, migrations TypeORM via le workflow existant, puis redéploiement de l'application. Aucune ressource, permission, variable SSM ou prestation payante ajoutée. Aucun apply, accès RDS, push ou déploiement AWS réalisé.
- La migration borne les délais et refuse une forme de fonction inconnue ; surveiller ses logs, le prochain bonus et l'unicité de sa notification. Son `down` restaure le texte futur uniquement, sans annuler de crédit ; ne pas annuler les migrations financières antérieures. Les limites du pipeline historique décrites ci-dessous restent valables.
- Validation et détails métier : [journal financier](../../docs/finance/CHANGELOG.md#2026-10-08--bonus-de-bienvenue-conducteur-présenté-en-fc-pour-pro).
- Contrôles locaux : 64 tests unitaires ciblés et 95 tests PostgreSQL 18 isolés réussis, 3 diagnostics ignorés ; compilation réussie, CI/CD et Terraform confirmés inchangés. Aucun serveur applicatif démarré.

## INFRA-2026-10-08-002 — Retour au CI/CD et à l'infrastructure antérieurs

### Contexte et statut

- Date : 8 octobre 2026, Africa/Kinshasa. Demande explicite de l'utilisateur : retirer les modifications de transition et revenir au CI/CD et à l'infrastructure existants.
- **Appliqué au dépôt uniquement.** Aucun appel AWS, apply, déploiement, changement GitHub distant, migration, écriture financière ou notification réelle effectué pendant cette intervention.
- Référence retenue : `6a45121` (5 octobre 2026), dernier commit avant les modifications CI/CD/Terraform de `cb271cf`. Les changements applicatifs de ce dernier ne sont pas annulés.
- Avant : publication par digest, épinglage de secours, préparation/remplacement/activation et contrôles des anciennes tâches. Des fichiers staging non suivis subsistaient aussi de la préparation précédente ; ce staging n'avait pas été provisionné.
- Après : pipeline historique sur `release`, tags du commit et `latest`, tâche de migrations TypeORM puis `force-new-deployment` et attente de stabilité. Aucun workflow staging restant.

### Fichiers et ressources

| Fichier | Modification |
| --- | --- |
| `.github/workflows/deploy.yml` | Restauration exacte de `6a45121`, sans les phases de transition ajoutées. Tests, build, contrôle documentaire, OIDC, runner ARM64, migrations et attente ECS historiques conservés. |
| `infra-aws/ecs.tf` | Restauration exacte : retrait du circuit breaker et de l'exception `ignore_changes = [task_definition]` ajoutés pour la transition. |
| `infra-aws/oidc.tf` | Restauration exacte : retrait des permissions ajoutées pour l'enregistrement des révisions, la lecture des définitions et l'inspection des anciennes tâches. Permissions historiques conservées. |
| `infra-aws/scripts/deploy-resilient.cjs`, `src/database/deployment-transition.spec.ts` | Suppression de l'orchestrateur abandonné et de ses tests, qui l'importaient. Récupérables dans l'historique Git (`cb271cf`). |
| `.github/workflows/deploy-staging.yml`, `infra-aws/scripts/deploy-staging.cjs`, fichiers source de `infra-aws/environments/staging/`, `infra-aws/tests/staging-isolation.tftest.hcl`, `src/database/staging-deployment.spec.ts` | Suppression des nouveaux fichiers staging locaux non suivis, désormais abandonnés ; aucun state, ressource AWS ou fichier de données supprimé. Ces fichiers non committés ne sont pas récupérables par Git. |
| `infra-aws/README.md`, présent journal | Retour à la procédure historique, ajout des limites actuelles et conservation de l'historique des décisions. |

Le reste des fichiers CI/CD et Terraform suivis était déjà identique à `6a45121`.
Aucune variable, valeur SSM, clé, base, bucket, DNS, VPC, cache ou image ECR modifié
sur AWS. Les secrets ne sont ni lus ni copiés. Les migrations, bonus, commissions,
notifications, KYC, OTP et autres fonctionnalités applicatives sont conservés.

### Impacts et limites

- Disponibilité : retour aux migrations exécutées pendant que l'ancienne application peut encore fonctionner, puis rolling deployment historique. Plus de vérification ajoutée de l'arrêt effectif de toutes les anciennes tâches ni d'image de secours épinglée. Le tag `latest` redevient mutable.
- Données : aucun rollback SQL. La migration `1780000056000` et le mécanisme d'activation financier restent dans le backend. Sans commissions cash existantes, cette migration initialise la politique en attente ; le pipeline historique n'appelle plus l'activation. Le contrôle `/health` accepte un schéma préparé : un CI vert ne prouve donc pas l'activation des nouveaux contrôles cash ni de l'index push différé.
- Définition ECS : si les phases de transition avaient déjà été exécutées hors de cette intervention, un service pointant vers un digest ne suivrait pas automatiquement le nouveau `latest`. Vérifier l'image réellement référencée avant relance ; aucune hypothèse sur l'état AWS réel n'est présentée comme vérifiée.
- IAM : les permissions supplémentaires de transition sont retirées du code ; elles ne sont pas retirées automatiquement du compte AWS. Terraform reprend la gestion de `task_definition` lors d'un éventuel apply.
- Coûts : aucun changement réel ; aucune nouvelle stack staging provisionnée. Le coût temporaire des tâches de migration et du rolling deployment historique reste possible lors d'un futur déploiement.

### Déploiement, surveillance et reprise

1. Relire le diff et vérifier la définition ECS, la disponibilité des sauvegardes RDS et l'état du schéma/activation avant une publication en production.
2. Si des changements Terraform de transition avaient effectivement été appliqués, exécuter un plan et le faire approuver avant tout apply ; ne pas appliquer un ancien plan enregistré. Ne pas détruire de stack ni modifier le state pour revenir au workflow historique.
3. Publier sur `release` uniquement après ces vérifications. Le workflow est revenu au format demandé, pas à un backend antérieur et pas à un schéma antérieur.
4. Surveiller les logs de migrations, événements ECS, cibles ALB et `/health`, puis vérifier les parcours financiers, l'état des contrôles cash et les notifications après déploiement.
5. Une reprise du mécanisme de transition nécessiterait une décision distincte et une restauration coordonnée des fichiers depuis Git après contrôle de l'état réel. Ne pas revenir à un ancien backend incompatible ni exécuter `migration:revert` sur l'historique financier.

### Validation locale

- Égalité avec `6a45121` vérifiée pour le workflow et les deux fichiers Terraform restaurés ; README initialement restauré puis complété par les avertissements ci-dessus.
- Les configurations CI/CD et Terraform suivies sont identiques à `6a45121` ; seuls le README et ce journal diffèrent dans ces répertoires pour documenter le retour.
- YAML des workflows et syntaxe bash de leurs commandes valides ; aucune référence restante aux orchestrateurs supprimés dans le code actif.
- `terraform fmt -check ecs.tf oidc.tf` et `terraform validate` réussis dans WSL, sans plan connecté à AWS.
- `npm run build` réussi. `npm test -- --runInBand` : 132 suites et 1 373 tests réussis ; 7 suites / 157 tests ignorés, dont les tests PostgreSQL nécessitant une activation explicite. Aucun test de déploiement réel ni vérification de l'état AWS.
- `git diff --check` et contrôle documentaire `check-infra-documentation.sh HEAD WORKTREE` réussis.

## INFRA-2026-10-07-001 — Déploiement financier en phases, images immuables et reprise

- **Entrée historique : orchestration CI/CD et changements Terraform annulés le 8 octobre 2026 ; voir `INFRA-2026-10-08-002`.** Le code/migrations applicatifs de cette transition n'ont pas été supprimés.
- **Statut : code local seulement.** Aucun `terraform apply`, déploiement ECS, changement SSM, migration RDS, crédit ou push réel pendant cette intervention.
- Problème : l'ancien workflow installait les contrôles cash avant de remplacer les serveurs, et réutilisait `:latest`. Un service stable pouvait aussi être une ancienne version rétablie par ECS.
- Fichiers : `.github/workflows/deploy.yml`, `infra-aws/scripts/deploy-resilient.cjs`, `ecs.tf`, `oidc.tf`, migration `1780000056000`, commandes `financial-rollout-cli` et tests associés. Les bonus, transferts, commissions sur toutes origines et autres évolutions applicatives sont conservés.
- Séquence : (1) vérifier le service sain et son digest actuel ; (2) épingler une révision de secours au digest réellement exécuté ; (3) préparer le schéma atomiquement avec les contrôles cash en attente lors d'une première transition ; (4) déployer la nouvelle image par digest ; (5) vérifier la définition cible, les conteneurs sains et l'arrêt effectif des anciennes tâches, y compris celles en drainage ; (6) activer la politique financière dans une transaction distincte. L'activation n'est pas un endpoint public.
- Publication ECR : tag de commit conservé, `:latest` n'est plus écrasé. Un échec de l'étape d'épinglage ne déclenche pas de rollback vers une image mutable. Le remplacement suivant utilise le circuit breaker ECS avec rollback vers la révision épinglée. Après activation, un rollback vers un serveur ancien pré-contrat est interdit ; une version compatible et une correction en avant sont nécessaires.
- Terraform active le circuit breaker et ignore les révisions applicatives `task_definition` du service, désormais gérées par CI. Il continue à produire le modèle d'infrastructure de la famille. **Le workflow lit ce dernier modèle avant de créer ses révisions**, donc les nouveaux noms SSM, variables, ressources et sidecars définis par Terraform sont conservés au prochain déploiement ; l'image de secours conserve, elle, la configuration réellement en service.
- IAM : ajout de `RegisterTaskDefinition` limité à la famille applicative, `DescribeTaskDefinition` avec `Resource=*` (pas de portée ressource supportée), et `ListTasks` limité par condition au cluster. Les permissions `RunTask`, `DescribeTasks` et `PassRole` existantes restent bornées. Référence : [autorisations ECS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html).
- **Prérequis avant fusion/déploiement sur `release` :** exécuter et relire un plan Terraform, puis appliquer les changements IAM/ECS voulus. Ne pas exécuter en parallèle un autre déploiement manuel/Terraform de l'application. Le premier déploiement comporte un remplacement supplémentaire pour épingler l'ancienne image ; prévoir la capacité temporaire de deux tâches et les tâches de migration/activation. Pas de nouvelle ressource permanente ou secret requis.
- Échec/reprise : si préparation échoue, l'ancien code reste en service (son image a pu être épinglée) ; si ECS revient à l'ancien serveur, le workflow échoue sans activer ; si une ancienne tâche peut encore exécuter du code, activation refusée. Un arrêt/cancel du workflow peut laisser `prepared` : relancer le workflow pour terminer, sans appliquer directement l'activation tant que l'absence des anciens serveurs n'est pas établie. Si des commissions existent déjà avec un serveur non marqué compatible, le précontrôle refuse le déploiement automatique et exige une reprise coordonnée.
- Vérifications locales : `terraform validate` réussi dans WSL, tests AWS simulés et PostgreSQL 18 jetables, compilation backend. Pas de plan connecté à AWS ni essai réel de circuit breaker. La santé applicative vérifie aussi le schéma financier, mais ne remplace pas une recette métier sur staging.
- Référence du mécanisme de rollback : [circuit breaker ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html). Le retour arrière automatique du code n'annule jamais les écritures financières.

## INFRA-2026-09-21-001 — Rotation du mot de passe FlexPaie payout en production

- Opération autorisée par l'utilisateur le 21 septembre 2026 ; région `eu-central-1`, compte `046374119247` ; statut : secret mis à jour, rolling deployment terminé et service sain.
- Source : uniquement `FLEXPAY_PAYOUT_PASSWORD` du fichier local `.env.production`, renseigné par l'utilisateur. Aucun autre paramètre de ce fichier importé ; aucune valeur secrète affichée, placée en argument de commande ou enregistrée dans ce journal.
- Authentification préalable auprès de l'URL payout de production référencée dans SSM : HTTP 200, succès métier et jeton avec durée de validité positive. Aucun appel `/pay` ni retrait de test déclenché.
- SSM : `/zwanga-api/production/env/FLEXPAY_PAYOUT_PASSWORD` passé de la version `1` à `2`, type `SecureString`, clé `alias/zwanga-api-production-application` conservée ; relecture comparée en mémoire à la valeur locale avec succès.
- ECS : `force-new-deployment` de `zwanga-api-production-api` dans `zwanga-api-production-cluster` à 12 h 00 min 56 s, heure de Kinshasa ; déploiement `ecs-svc/0817787192160772986`. Définition `zwanga-api-production-api:11` conservée ; digest applicatif vérifié identique avant relance : `sha256:7ace0e733127e9bb63d594676360b325ea2ed09ec233fe489e66aef4973c1f06`.
- Disponibilité : stratégie rolling, minimum sain 100 %, maximum 200 % ; l'ancienne tâche reste disponible pendant le démarrage de la nouvelle. Les connexions persistantes peuvent se reconnecter lors du retrait de l'ancienne tâche.
- Aucun changement de code applicatif, IAM, réseau, Terraform ou schéma de base ; aucun solde modifié par cette opération. Coût temporaire du chevauchement des tâches ECS, sans nouvelle ressource permanente.
- Validation finale : déploiement ECS `COMPLETED` et service stable à 12 h 03 min 26 s, heure de Kinshasa ; une tâche `RUNNING`, zéro tâche en attente. Nouvelle tâche `fa178d95b2fb4368b71e05df715dcef1` démarrée à 12 h 01 min 44 s, conteneur API `HEALTHY`, digest conservé ; ancienne tâche retirée du trafic. Cible ALB `healthy` et `https://compute-api.zwanga-app.com/health` en HTTP 200 avec API, base et Redis `ok`.
- Contrôle des logs de démarrage : aucune erreur d'authentification payout ni erreur fatale détectée. Une erreur `ECONNREFUSED 127.0.0.1:2000` du collecteur de traces a été relevée au démarrage ; elle n'a pas bloqué la santé API ni la stabilisation ECS. Ne pas assimiler le contrôle d'authentification préalable à un retrait de bout en bout : aucun transfert de test réalisé.
- Validation locale de la documentation : `git diff --check` réussi et contrôle `check-infra-documentation.sh HEAD WORKTREE` réussi (aucune modification de configuration d'infrastructure versionnée, hors documentation).
- Retour arrière : ne pas supprimer le paramètre ; ne rétablir une ancienne valeur que si elle reste acceptée par FlexPaie, puis relancer ECS. Le retour à une ancienne définition de tâche ne restaure pas la valeur SSM ; aucune restauration automatique de l'ancien mot de passe.

## INFRA-2026-09-19-001 — Validation locale des retraits de jetons achetés

- Référence : `FIN-WALLET-005`, suite de `INFRA-2026-09-18-001` ; opérateur : développement backend/mobile ; statut : validation locale, aucune action AWS exécutée.
- Durcissement des anciennes recharges : une réussite locale sans preuve de vérification complète ne crée pas de nouveaux jetons retirables ; recontrôle prestataire lors d'une vérification de statut.
- Validation : 743 tests backend et 54 tests mobiles ciblés réussis, TypeScript backend/mobile sans erreur ; 3 tests de migration réussis séparément sur PostgreSQL local temporaire. Aucun secret de production ni RDS utilisé dans ces tests.
- Aucun changement IAM, Terraform ou ressource AWS, ni nouvelle variable au-delà du commutateur documenté le 18 septembre. Coûts AWS inchangés par cette intervention.
- Déploiement et retour arrière : suivre la procédure coordonnée de l'entrée précédente ; arrêter les écrivains anciens avant migration, garder `WALLET_WITHDRAWALS_ENABLED=false` jusqu'à validation prestataire/staging. Pour désactiver, fermer les nouvelles demandes sans arrêter les callbacks et la réconciliation. Ne pas supprimer l'historique financier ni revenir à un backend ignorant la ventilation.

## INFRA-2026-09-18-001 — Retrait des jetons achetés, activation contrôlée

### Métadonnées et contexte

- Date : 18 septembre 2026 ; opérateur : développement backend/mobile.
- Référence : `FIN-WALLET-005` ; cible : ECS/RDS/SSM production ; statut : code local, déploiement planifié, non exécuté.
- Avant : achats et fidélité mélangés dans un solde sans ventilation ; pas de retrait d'achats. Revenus conducteur et parrainage déjà séparés.
- Objectif : retirer les achats prouvés, jamais la fidélité, en conservant l'origine après usage/transfert/remboursement.

### Code, configuration et ressources

- Migration `1780000038000` : ventilation disponible/réservée, origine des écritures, table des retraits, contraintes et clés uniques. Backfill conservateur des achats vérifiés ; soldes totaux inchangés.
- API de retrait authentifiée avec KYC, réservation et réconciliation ; client FlexPaie payout existant. Callback de recharge toujours vérifié.
- Nouvelle variable dans les exemples : `WALLET_WITHDRAWALS_ENABLED=false`. Import SSM et référence dans la définition ECS nécessaires avant activation à `true` après validation.
- Réutilisation des sept `FLEXPAY_PAYOUT_*` et de la base HTTPS `FLEXPAY_CALLBACK_BASE_URL` ou `PUBLIC_API_BASE_URL`, incluant le préfixe API. Pas de nouvel identifiant prestataire.
- Aucune ressource AWS, permission IAM, secret, solde ou transaction réelle modifié par ce travail. Pas de nouveau service facturable ; requêtes RDS et appels de vérification supplémentaires.

### Déploiement et disponibilité

1. Sauvegarder RDS et tester sur copie/staging, commutateur désactivé ; auditer les soldes hérités.
2. Suspendre les écrivains portefeuille anciens (instances, cron et callbacks) : ne pas faire de rolling deployment mélangeant ancien et nouveau code.
3. Appliquer les migrations en transaction, puis démarrer seulement les nouvelles instances. Prévoir une fenêtre de maintenance pour les écritures ; verrou limité à cinq secondes.
4. Valider les vrais contrats et callbacks FlexPaie, publier le mobile, importer le paramètre SSM et vérifier le plan/diff ECS avant activation explicite.

### Validation et surveillance

Tests locaux de ventilation, KYC, concurrence, reprises réseau, statuts et migration PostgreSQL isolée ; aucune connexion RDS ni payout réel utilisé. Validation prestataire/staging et appareils encore requise.
Surveiller réservations sans commande, `WALLET_WITHDRAWAL_RECONCILIATION_PENDING` et `WALLET_WITHDRAWAL_LATE_SUCCESS_REVIEW`. Une réponse incertaine ne déclenche pas de second paiement.

### Retour arrière et limites

Désactiver les nouvelles demandes avec le commutateur à `false`, en laissant tourner la réconciliation. Ne pas revenir à l'ancien écrivain de solde. Le down refuse après toute nouvelle écriture ventilée ou tout retrait ; correction en avant requise, aucune suppression de journal.
Les anciens achats sans preuve et transferts non ventilés restent utilisables, mais non retirables automatiquement. Voir [le guide opérationnel](../../docs/finance/purchased-token-withdrawals.md).

## INFRA-2026-09-17-002 — Fidélité par trajet et correction des gains cash subventionnés

### Métadonnées et périmètre

- Date : 17 septembre 2026 ; opérateur : développement backend.
- Environnement : code local destiné à ECS/RDS production.
- Statut : migration et déploiement non exécutés ; aucune modification de solde, SSM, ECS ou transfert FlexPaie.
- Référence : `FIN-LOYALTY-001`.

### Contexte et cause

La finalisation d'un trajet a échoué sur `CHK_driver_earnings_payment_mode` :
le schéma n'autorisait pas les gains `cash` alors que le service prend en charge
la subvention Zwanga de ces trajets. Ce blocage précédait la fidélité passager.
La nouvelle règle fixe une base de 1 jeton pour chaque conducteur/passager
éligible, y compris en cash ; seul le passager payé en jetons/électronique reçoit
le bonus distance/prix.

### Changements et variables

- Migration `1780000037000` : autoriser `cash` dans les gains et ajouter l'unicité
  des crédits de fidélité par utilisateur/trajet/composante, sans reprise de soldes.
- Backend : base distincte du règlement et du bonus, fins manuelles/automatiques
  prises en charge, crédits historiques conservés, logs `TRIP_LOYALTY_COMMITTED`.
- `.env.docker.example`, `.env.example`, `FLEXPAY_SETUP.md` : retrait de
  `ZWANGA_LOYALTY_BASE_REWARD`. Une ancienne valeur SSM est ignorée par le nouveau
  code ; aucune suppression SSM n'est nécessaire pour ce déploiement.
- Aucun nouvel identifiant FlexPaie ni aucune nouvelle variable obligatoire.
- [Guide fidélité](../../docs/finance/trip-loyalty.md) et
  [guide payout](../../docs/finance/flexpaie-payout-configuration.md) ajoutés.

### Validation, déploiement et surveillance

Valider les tests unitaires et le build, puis tester la migration sur staging.
Appliquer la migration via la tâche prévue avant l'activation du nouveau backend.
Contrôler les trajets cash, gratuits, non cash payés tardivement et les reprises
du même événement : un crédit de base et au plus un bonus par utilisateur/trajet.
Le contrôle CI de documentation reste actif ; cet ajout accompagne le changement
de `.env.docker.example`.

Validation locale effectuée : 58 suites / 659 tests Jest réussis, compilation
`npm run build`, `git diff --check` et contrôle de documentation
`check-infra-documentation.sh HEAD WORKTREE` réussis. La migration n'a pas été
exécutée sur une base PostgreSQL ; sa validation staging reste requise.

Surveiller `TRIP_LOYALTY_COMMITTED` et l'absence de nouvelle violation
`CHK_driver_earnings_payment_mode`. Aucun rattrapage historique automatique.
Les secrets payout doivent être confirmés avec FlexPaie avant toute correction
SSM : HTTP 200 à l'authentification ne garantit pas un succès métier.

### Impacts et retour arrière

Pas de nouvelle ressource AWS ; index supplémentaire et transactions de crédit
uniquement. Aucun encaissement cash direct n'est ajouté aux gains retirables.
Le rollback SQL refuse les suppressions de contraintes si de nouvelles écritures
cash/fidélité existent : conserver le schéma et préparer un correctif compatible,
sans effacer les crédits. Aucun secret n'est inclus dans ce journal.

## INFRA-2026-09-17-001 — Runtime FlexPaie payout v1.03 et déploiement des correctifs de sécurité

### Métadonnées

| Champ | Valeur |
| --- | --- |
| Date | 17 septembre 2026 |
| Auteur / opérateur | équipe de développement backend |
| Environnement | développement local ; production ECS Fargate / SSM visée |
| Statut | code versionné, complément documentaire local ; état AWS non vérifié lors de cette mise à jour |
| Type | documentation CI/CD, configuration runtime et sécurité applicative |
| Référence | commit `5991c8d` — `add jwt for socket gateway auth` |

### Contexte, état initial et cause vérifiée

Le commit remplace l'ancien exemple `merchantPayOutService` par la configuration
FlexPaie Payout v1.03 et complète le guide de versement conducteur. Il contient
également les correctifs OAuth et d'autorisation du chat REST/WebSocket.

Le contrôle `check-infra-documentation.sh` classe `.env.docker.example` parmi les
fichiers d'infrastructure. La comparaison `HEAD^ HEAD` échoue localement parce
que cet exemple a changé sans entrée correspondante dans ce journal. Le présent
complément documente le changement ; il ne désactive ni ne contourne le contrôle.

### Modifications du lot documenté

| Fichier | Modification | Objectif |
| --- | --- | --- |
| `.env.docker.example`, `.env.example`, `.env.production.example` | ajout des identifiants et URL payout dédiés, retrait de l'ancienne URL de repli dans l'exemple Docker | configurer le contrat Payout v1.03 |
| `infra-aws/docs/driver-payout-runtime.md` | avertissement sur l'ancien contrat et lien vers `FLEXPAY_SETUP.md` | éviter d'appliquer la configuration historique au nouveau client |
| `docs/oauth-exchange.md` | contrat du code d'échange Redis et configuration `FRONTEND_URL` | coordonner le frontend web et le backend |
| `docs/chat-websocket-security.md` | contrôle d'accès, validation des événements et politique `CORS_ORIGINS` commune | sécuriser le chat et conserver les payloads mobiles valides |
| `infra-aws/docs/CHANGELOG.md` | ajout de cette entrée | satisfaire la traçabilité exigée par la CI/CD |

### Variables et paramètres runtime

Les noms ci-dessous sont documentés sans aucune valeur sensible. Les paramètres
importés sont stockés sous `/zwanga-api/<environment>/env/*` dans SSM
`SecureString`, puis référencés par la définition de tâche ECS.

| Nom | Usage |
| --- | --- |
| `FLEXPAY_PAYOUT_SERVICE_URL` | URL HTTPS `/pay` fournie pour ce compte FlexPaie |
| `FLEXPAY_PAYOUT_USERNAME` | identifiant d'authentification payout dédié |
| `FLEXPAY_PAYOUT_PASSWORD` | secret d'authentification payout dédié ; ne pas utiliser `FLEXPAY_TOKEN` |
| `FLEXPAY_PAYOUT_MERCHANT_CODE` | surcharge du marchand ; repli applicatif sur le marchand FlexPay existant |
| `FLEXPAY_PAYOUT_AUTH_URL` | surcharge facultative de l'URL d'authentification |
| `FLEXPAY_PAYOUT_CHECK_TRANSACTION_URL` | surcharge facultative de l'URL de vérification d'une transaction |
| `FLEXPAY_PAYOUT_BALANCE_URL` | surcharge facultative de l'URL de consultation du solde |
| `FRONTEND_URL` | URL HTTPS explicite du frontend pour le callback OAuth web en production |
| `CORS_ORIGINS` | origines web autorisées pour HTTP et Socket.IO en production |

### Impacts et ressources AWS

- Cette mise à jour ne modifie que le journal : aucun import SSM, plan/apply
  Terraform, changement IAM, redémarrage ECS ou versement réel n'est exécuté.
- L'injection de nouveaux paramètres nécessite une définition de tâche ECS qui
  les référence ; la seule modification d'un fichier `.env` local ne suffit pas.
- Le déploiement du lot backend doit remplacer toutes les anciennes instances
  pour fermer leurs connexions WebSocket et leurs anciens abonnements aux rooms.
- Le callback OAuth web doit être déployé avec son frontend adapté à
  `POST /auth/exchange`. Les endpoints Google/Apple natifs restent inchangés.
- Le lot inclut aussi la migration `AddRideHistoryIndexes1780000036000` : deux
  index d'historique, sans suppression de données. Prévoir sa durée et les
  éventuels verrous de création d'index lors de la tâche de migration ECS.
- Aucun nouveau service AWS ni nouvelle permission IAM n'est prévu par ce
  complément ; l'ajout de paramètres et les tâches de déploiement peuvent
  utiliser les ressources facturables existantes. Aucun coût AWS n'est engagé ici.

### Procédure de déploiement et surveillance

1. Commiter et pousser ce journal avec le lot à livrer. Relancer uniquement
   l'ancien workflow sur le SHA `5991c8d` ne lui ajouterait pas ce document.
2. Vérifier les paramètres réellement présents dans SSM et les références ECS,
   sans afficher les valeurs. Si des paramètres manquent, préparer l'import
   ciblé avec `-IncludeNames` et `-DryRun` avant toute application autorisée.
3. Si l'injection runtime doit évoluer, contrôler un nouveau plan Terraform,
   refuser toute destruction inattendue et appliquer après validation.
4. Déployer le frontend OAuth compatible et le backend via le workflow existant,
   qui exécute les migrations avant de forcer le déploiement du service ECS.
5. Vérifier la stabilité ECS et `/health`, puis surveiller les logs applicatifs :
   connexion Redis, autorisations du chat, échanges OAuth et traitement payout.
   Valider la réception du suivi sur les deux clients d'un trajet de test ; une
   connexion conducteur seule ne prouve pas la réception côté passager.

Les procédures détaillées restent dans [FLEXPAY_SETUP.md](../../FLEXPAY_SETUP.md),
[oauth-exchange.md](../../docs/oauth-exchange.md) et
[chat-websocket-security.md](../../docs/chat-websocket-security.md).

### Validation locale de ce complément

| Contrôle | Résultat |
| --- | --- |
| `bash infra-aws/scripts/check-infra-documentation.sh HEAD^ HEAD` avant modification | échec reproduit : `.env.docker.example` sans changelog |
| `bash infra-aws/scripts/check-infra-documentation.sh HEAD^ WORKTREE` après modification | réussi : changement d'infrastructure accompagné du journal |
| `git diff --check` | réussi |
| Terraform, migration et déploiement AWS | non exécutés ; modification documentaire uniquement |

### Retour arrière et reste à faire

Ce complément documentaire n'a pas de rollback de données ou de ressources.
Pour le lot applicatif, ne pas réactiver les anciens accès non autorisés du chat
ni remettre des tokens OAuth dans une URL afin de contourner un échec de
déploiement. Préférer une correction ciblée ou une version de repli conservant
les protections. Ne supprimer aucun paramètre SSM tant qu'une tâche le référence.
La migration d'index peut rester en place lors d'un retour applicatif compatible.

Le contrôle local ne vaut pas validation de toute la CI/CD ni de la production :
le commit/push, le workflow sur le nouveau SHA et les vérifications AWS restent
à effectuer.

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
### ajout des variables d'environnement sur le bonus au premier trajet
nouvelle fonctionnalité dans service trip et booking

adding pawa pay services
