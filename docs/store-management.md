# Store Management dans Zwanga

Le [Centre de supervision mobile](mobile-operations.md) étend désormais ce module côté backend : installations, politiques de versions, campagnes et monitoring. Les réponses aux avis exigent `STORE_REVIEW_REPLIES_ENABLED=true` et restent désactivées par défaut. La lecture Google des tracks nécessite l’opt-in `STORE_GOOGLE_TEMPORARY_EDITS_ENABLED=true` avec une identité dédiée. L’extension ajoute aussi le mode Google ADC et l’import optionnel Apple Sales and Trends ; voir le guide pour leurs limites et variables.

Store Management est intégré au backend NestJS existant et à la page `/stores` de `zwanga-admin`. L’API utilise les comptes administratifs existants. Le module est **désactivé par défaut** ; aucun accès Google, Apple ou SMTP ne démarre tant que son activation et ses identifiants ne sont pas configurés.

Le code reste local, sans push ni déploiement. Le 5 novembre 2026, après autorisation explicite, les accès Apple ont été testés, une demande Analytics `ONGOING` a été confirmée et les avis/versions/builds ont été importés dans la base locale. Les 17 paramètres Store ont également été préparés dans AWS SSM, **module et synchronisation désactivés**. Aucun workflow, fichier Terraform, rôle IAM ou service ECS n’a été modifié. Voir l’état précis et les étapes d’activation ci-dessous ; la fédération Google réelle et la recette en production restent à valider.

## Audit architectural et choix d’intégration

| Existant observé                                                    | Intégration retenue                                                                                 |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| NestJS 11, `AdminModule`, configuration globale                     | `StoreManagementModule` importé par `AdminModule`, sans backend indépendant                         |
| JWT, `RolesGuard`, rôles admin, super_admin et marketer             | Gardes réutilisés ; droits Store additionnels par compte administratif                              |
| TypeORM et liste explicite des entités et migrations                | Entités enregistrées dans les registres existants, deux migrations réversibles                      |
| PostgreSQL, tâches durables KYC/paiement avec baux et `SKIP LOCKED` | Même mécanisme de concurrence, file Store distincte ; pas de remplacement des traitements existants |
| Redis partagé et `CacheService`                                     | Cache du dashboard pendant 120 secondes, nouvelle génération après un import                        |
| Nest Schedule déjà installé                                         | Planificateur et processeur Store, sans infrastructure supplémentaire                               |
| Next.js, RTK Query, renouvellement JWT et styles Admin              | Endpoints injectés dans `baseApi`, page intégrée au shell existant                                  |
| Graphiques SVG existants                                            | Palette réutilisée ; courbe Store avec interruptions sur données manquantes                         |
| Export Excel SpreadsheetML existant                                 | Même générateur `.xls`, pas de fichier faussement nommé `.xlsx`                                     |

Le rectificatif architectural v1.1 privilégie la réutilisation des mécanismes opérationnels. BullMQ et Recharts, proposés dans la v1.0, n’ont donc pas été ajoutés. Redis reste le cache partagé ; PostgreSQL garantit la durabilité des tâches. Les seules nouvelles dépendances de production sont `pdf-lib` pour les synthèses PDF et `nodemailer` pour le transport SMTP optionnel.

Le guide PostgreSQL a orienté les contraintes d’unicité, index, transactions courtes et baux. Le guide PDF a été appliqué à la pagination et au contrôle visuel d’un rapport de démonstration de deux pages.

## Fonctions disponibles et limites des sources

| Domaine    | Fonction locale                                                                                                       | Conditions et limites                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Connexions | État, activation, cadences, tests asynchrones par capacité                                                            | Identifiants fournis uniquement au serveur ; les tests en lecture ne prouvent pas les droits de réponse    |
| Google     | Avis, réponses, tracks, releases, notes, CSV d’installations/acquisition/crashes, Android Vitals et groupes d’erreurs | GCS requiert le bucket de rapports et ses droits ; disponibilité selon le compte                           |
| Apple      | Avis, réponses, versions, builds, groupes TestFlight, rapports Analytics et Power & Performance                       | Données soumises aux permissions, délais et seuils de confidentialité                                      |
| Analytics  | Séries journalières, pays, dimensions, version quand exposée, comparaison par source                                  | Les différents fichiers Google d’installations ne sont jamais additionnés entre eux                        |
| Avis       | Recherche, note, dates, pays/version si exposés, avec/sans réponse, brouillon, validation, assignation, clôture       | Google expose via Reviews API les avis récemment créés/modifiés avec commentaire, pas l’ensemble des notes |
| Versions   | État observé, historique des changements, notes internes de refus, responsable et résolution                          | Pas de publication, de soumission ni de modification des fiches Store                                      |
| Métier     | Cohortes d’inscription, rôles actuels, KYC soumis/approuvés, premier trajet, trajets terminés                         | Résultats de cohortes à leur état actuel ; aucune copie des données personnelles                           |
| Alertes    | Règles, seuils, destinataires, événements persistants et acquittement dans Admin                                      | Courriel uniquement avec SMTP configuré ; pas de push aux usagers mobiles                                  |
| Exports    | CSV, Excel `.xls`, synthèse PDF, journal d’export                                                                     | Collections limitées à 10 000 lignes ; réduire le périmètre si nécessaire                                  |

Les indicateurs d’installation, suppression et sessions Apple proviennent des rapports standards. Les durées sont distinctes des comptes d’événements. Les nombres d’appareils/utilisateurs uniques ne sont pas additionnés entre dimensions. Les impressions et vues de page produit ne sont pas assimilées aux téléchargements.

La moyenne des **avis importés** est présentée comme une moyenne d’échantillon, jamais comme la note globale officielle de la fiche. Une valeur manquante reste absente ou indisponible. Une base installée est un état à une date ; un taux de crash n’est pas une quantité cumulable.

Les fichiers Google par version utilisent le **versionCode**, pas nécessairement le nom commercial de version. Pays et version sont des ventilations indépendantes dans ces fichiers : leur intersection peut être indisponible. Les filtres de store ne réattribuent pas les inscriptions Zwanga.

La plateforme d’un compte est celle du dernier appareil déclaré dans `app_update_clients`, et non celle utilisée à l’inscription. `unknown` est conservé. Le dernier login est seulement un indicateur d’activité disponible, pas une mesure DAU ou une série de sessions. Le ratio téléchargement vers inscription reste `null` lorsqu’aucun dénominateur compatible n’est établi.

Les groupes d’erreurs Google décrivent la fenêtre officielle par défaut des dernières 24 heures lors de l’import. Les performances Apple décrivent des percentiles par version récente, pas une série journalière. Les détails de diagnostics non importés restent consultables dans les consoles officielles. GA4, Crashlytics, les historiques d’avis Google par CSV et les opérations de publication V2 ne sont pas intégrés. Sales and Trends est désormais proposé en option par l’extension Mobile Operations, avec des unités commerciales distinctes des installations.

## Configuration serveur

Utiliser `.env.example` comme liste de noms, **pas comme fichier de secrets à partager**.

| Variable                          | Fonction                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `STORE_MANAGEMENT_ENABLED`        | `true` active le module ; défaut désactivé                                                                               |
| `STORE_SYNC_ENABLED`              | `true` active la création automatique des tâches ; les tâches manuelles sont traitées même si cette variable est `false` |
| `STORE_RETENTION_MONTHS`          | 24 par défaut, entre 1 et 120                                                                                            |
| `STORE_GOOGLE_PACKAGE_NAME`       | `com.zwanga` pour l’application actuelle                                                                                 |
| `STORE_GOOGLE_AUTH_MODE`          | `service_account` par défaut ; `adc` pour un fichier de confiance ; `aws_wif` pour le rôle ECS sans clé privée            |
| `STORE_GOOGLE_WIF_AUDIENCE`       | En `aws_wif`, ressource complète du fournisseur Google contenant le **numéro** de projet, le pool et le provider          |
| `STORE_GOOGLE_CLIENT_EMAIL`       | Adresse du compte de service dédié                                                                                       |
| `STORE_GOOGLE_PRIVATE_KEY`        | Seulement en `service_account` : clé PEM, retours à la ligne réels ou `\n` ; inutile en `aws_wif`                         |
| `STORE_GOOGLE_REPORTS_BUCKET`     | Bucket `pubsite_prod_...` fourni par Google Play                                                                         |
| `STORE_GOOGLE_INSTALL_DIMENSIONS` | `country,app_version,device,os_version` par défaut ; `country` seul réduit les imports                                   |
| `STORE_APPLE_APP_ID`              | `6756211830` pour l’application actuelle                                                                                 |
| `STORE_APPLE_ISSUER_ID`           | Issuer de la clé d’équipe Apple                                                                                          |
| `STORE_APPLE_KEY_ID`              | Identifiant de cette clé                                                                                                 |
| `STORE_APPLE_PRIVATE_KEY`         | Contenu PEM du fichier P8 ES256                                                                                          |
| `STORE_APPLE_REPORT_HOSTS`        | Facultatif, hôtes exacts supplémentaires pour les segments ; pas de wildcard                                             |

Les clés ne sont jamais acceptées dans un DTO, renvoyées par REST ou conservées dans les tables Store. Les diagnostics exposent des codes sûrs et les **noms** des variables manquantes, pas leurs valeurs. Les paramètres de production préparés le 5 novembre sont des `SecureString` chiffrés avec la clé KMS applicative existante ; ils ne sont pas encore référencés par la définition de tâche ECS active.

### Google Play

1. Créer un compte de service **dédié à cette intégration** dans Google Cloud et activer Android Publisher et Play Developer Reporting.
2. Lui donner accès à cette application dans Play Console, avec les permissions de lecture nécessaires ; n’ajouter la réponse aux avis qu’aux usages autorisés.
3. Autoriser la lecture des exports GCS. Le bucket de rapports n’est pas le bucket applicatif Zwanga.
4. Sur ECS, utiliser la fédération AWS décrite ci-dessous ; sinon, injecter l’adresse et la clé privée côté serveur pour le mode historique. Les jetons OAuth sont renouvelés par `google-auth-library`.
5. Lancer le test de connexion, puis consulter les capacités séparément.

La lecture des tracks utilise un **edit temporaire non validé**, supprimé ensuite. Aucun `commit` n’est appelé. Un compte technique séparé évite d’interférer avec les edits d’un outil de livraison. Un échec de nettoyage est signalé, pas ignoré.

### Workload Identity Federation AWS ECS → Google Play

Support ajouté localement le 5 novembre 2026, **non activé dans le runtime de production**. Il réutilise `google-auth-library` et le SDK AWS déjà installés. La configuration publique WIF et le bucket communiqué par l’opérateur sont préparés dans SSM ; le bucket est aussi renseigné dans le `.env` local. Aucun changement Terraform, IAM AWS ou CI/CD n’a été appliqué. La configuration du pool/provider Google n’a pas été vérifiée en direct.

Le rôle **de la tâche ECS** fournit ses identifiants temporaires ; Google vérifie une requête AWS `GetCallerIdentity` signée, puis délivre un jeton court au nom du compte de service autorisé. Ce compte doit toujours être invité dans Google Play Console. Ce n’est ni le rôle d’exécution ECS (chargement des secrets/image), ni le rôle GitHub Actions. La fédération ne donne pas de nouveaux droits à Apple et ne change pas l’authentification Firebase existante.

Conserver la politique `iam.disableServiceAccountKeyCreation`. Ne créer aucune clé privée Google, ne copier aucune clé AWS permanente et ne créer aucun fournisseur OIDC AWS pour ce mécanisme. La documentation Google distingue cette fédération par identifiants IAM du mécanisme AWS OIDC sortant.

#### 1. Confirmer le rôle réellement utilisé dans AWS

Lecture seule, depuis un terminal AWS déjà authentifié :

```bash
TASK_DEFINITION=$(aws ecs describe-services \
  --region eu-central-1 --cluster zwanga-api-production-cluster \
  --services zwanga-api-production-api \
  --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --region eu-central-1 \
  --task-definition "$TASK_DEFINITION" \
  --query 'taskDefinition.{taskRoleArn:taskRoleArn,executionRoleArn:executionRoleArn}'
```

Le code Terraform attend un rôle nommé `zwanga-api-production-ECSTaskRole`. Confirmer son ARN/compte avant de reprendre les valeurs ci-dessous. Ne modifier ni le trust policy ECS ni les droits AWS métier pour cette fédération. Si `taskRoleArn` est absent, arrêter la configuration et traiter ce prérequis séparément.

#### 2. Préparer Google Cloud

Les commandes suivantes sont **à exécuter manuellement dans Google Cloud Shell (Bash)** par une personne autorisée. Elles créent le pool/provider et accordent une permission sur le compte de service. Elles ne sont pas exécutées par le backend.

Projet confirmé : `zwanga-512110`. Compte confirmé : `zwanga-play-admin@zwanga-512110.iam.gserviceaccount.com`. Numéro de projet communiqué : `243495792368`. Le vérifier, car il est différent de l’ID :

```bash
GCP_PROJECT_ID=zwanga-512110
GCP_PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
GOOGLE_SERVICE_ACCOUNT=zwanga-play-admin@zwanga-512110.iam.gserviceaccount.com
WIF_POOL_ID=zwanga-aws-prod
WIF_PROVIDER_ID=ecs-fargate
# Confirmer ces deux valeurs avec taskRoleArn à l’étape 1.
AWS_ACCOUNT_ID=046374119247
AWS_TASK_ROLE_NAME=zwanga-api-production-ECSTaskRole
```

Prérequis : droits d’administration du pool et de la politique IAM du compte de service, droit d’activation des API, exigences de facturation du projet vérifiées avec l’administrateur Google. Ne pas accorder `Owner` au compte de service. S’il existe déjà un pool/provider dédié, inspecter sa configuration au lieu de recréer une ressource de même nom.

```bash
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com \
  androidpublisher.googleapis.com playdeveloperreporting.googleapis.com \
  --project="$GCP_PROJECT_ID"

gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
  --project="$GCP_PROJECT_ID" --location=global \
  --display-name="Zwanga AWS production"

gcloud iam workload-identity-pools providers create-aws "$WIF_PROVIDER_ID" \
  --project="$GCP_PROJECT_ID" --location=global \
  --workload-identity-pool="$WIF_POOL_ID" --account-id="$AWS_ACCOUNT_ID" \
  --attribute-mapping="google.subject=assertion.arn,attribute.aws_role=assertion.arn.extract('assumed-role/{role_name}/')" \
  --attribute-condition="assertion.account == '${AWS_ACCOUNT_ID}' && assertion.arn.startsWith('arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${AWS_TASK_ROLE_NAME}/')"

gcloud iam service-accounts add-iam-policy-binding "$GOOGLE_SERVICE_ACCOUNT" \
  --project="$GCP_PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.aws_role/${AWS_TASK_ROLE_NAME}"

# Affiche uniquement la configuration publique, jamais un jeton.
printf 'STORE_GOOGLE_WIF_AUDIENCE=//iam.googleapis.com/projects/%s/locations/global/workloadIdentityPools/%s/providers/%s\n' \
  "$GCP_PROJECT_NUMBER" "$WIF_POOL_ID" "$WIF_PROVIDER_ID"
```

La condition vérifie **le compte ET le rôle exact**, avec `/` après le nom pour éviter de faire confiance à un rôle au nom seulement préfixé. Ne pas remplacer cette liaison par `principalSet://.../*`. Réserver ce pool à ce périmètre ; un administrateur capable de modifier le provider modifie aussi cette frontière de confiance.

#### 3. Donner les accès Play Console

Dans **Utilisateurs et autorisations**, inviter l’adresse du compte de service et limiter les droits à l’application `com.zwanga` et aux lectures nécessaires. La permission IAM de fédération seule ne donne accès ni aux avis ni aux rapports Play. Configurer séparément les droits du bucket de rapports `pubsite_prod_...` pour les statistiques CSV, et vérifier les capacités Android Publisher/Reporting. Ne pas accorder de publication pour simplement consulter des statistiques ; les edits temporaires et réponses aux avis restent désactivés pendant la recette.

#### 4. Configuration à injecter au backend après préparation Google

```dotenv
STORE_GOOGLE_AUTH_MODE=aws_wif
STORE_GOOGLE_PACKAGE_NAME=com.zwanga
STORE_GOOGLE_CLIENT_EMAIL=zwanga-play-admin@zwanga-512110.iam.gserviceaccount.com
STORE_GOOGLE_WIF_AUDIENCE=//iam.googleapis.com/projects/243495792368/locations/global/workloadIdentityPools/zwanga-aws-prod/providers/ecs-fargate
STORE_GOOGLE_REPORTS_BUCKET=pubsite_prod_7262768137520374026
AWS_REGION=eu-central-1
STORE_SYNC_ENABLED=false
STORE_REVIEW_REPLIES_ENABLED=false
STORE_GOOGLE_TEMPORARY_EDITS_ENABLED=false
```

Vérifier que le numéro, le pool et le provider correspondent à la configuration Google Cloud réelle. Le bucket est celui communiqué par l’opérateur, sans `gs://` ; son accès reste à tester. `STORE_GOOGLE_PRIVATE_KEY` et `GOOGLE_APPLICATION_CREDENTIALS` ne sont **pas requis ni lus** par `aws_wif` ; ne pas retirer une variable partagée utilisée par un autre service. Ne pas injecter de clés AWS statiques : ECS fournit les identifiants temporaires du rôle. Le code refuse les identifiants sans jeton de session avec `GOOGLE_WIF_TEMPORARY_AWS_CREDENTIALS_REQUIRED` ; une configuration WIF invalide conserve le code sûr `GOOGLE_WIF_CONFIGURATION_INVALID`. Les autres détails d’erreur d’authentification restent masqués.

En production, ajouter les variables au mécanisme Parameter Store/ECS existant puis vérifier leur présence dans la **définition de tâche**, uniquement par leurs noms. Une nouvelle valeur SSM n’est pas chargée automatiquement dans une tâche déjà démarrée, et un nouveau nom n’est pas automatiquement ajouté à sa définition. Déployer ultérieurement le code et la définition appropriée par la procédure habituelle, après revue ; aucune commande de déploiement n’est lancée dans ce lot. Laisser le module désactivé tant que ses migrations existantes n’ont pas été appliquées/validées.

#### 5. Recette et limites

- Après les migrations Store et configuration, activer `STORE_MANAGEMENT_ENABLED=true`, laisser la planification désactivée, puis appeler avec un JWT Admin autorisé `POST /api/v1/admin/store-management/integrations/google/test` avec `{"requestId":"UUID_UNIQUE"}`. Cet endpoint met un test de connexion en file ; sa réponse initiale n’est pas une preuve de connexion réussie. Vérifier ensuite le job, les capacités et `GET /api/v1/admin/store-management/integrations/google/status`.
- Les accès réseau HTTPS vers `sts.googleapis.com`, `iamcredentials.googleapis.com` et les API Google utilisées doivent être disponibles. Le proxy Mobishastra n’intervient pas dans ce flux.
- Google renouvelle/cachera les jetons par scope ; les appels simultanés d’un même client partagent le renouvellement. Le SDK AWS gère la rotation de ses identifiants. Deux tâches ECS peuvent fonctionner sans partager de clé privée ni de cache de jetons dans Redis.
- L’attente de résolution AWS est bornée côté appelant à 5 secondes ; cette limite n’annule pas le fournisseur SDK sous-jacent. Chaque requête Google STS/impersonation est bornée à 10 secondes, sans redirection ni retry HTTP interne. Les erreurs retournées sont masquées ; aucun jeton, secret ou requête signée n’est journalisé par cet adaptateur.
- Sur le PC, le rôle ECS n’existe pas : utiliser un profil AWS de test avec identifiants temporaires et **une fédération de test séparée**. Ne pas ouvrir le rôle de production aux postes développeurs pour faciliter un test. Le mode ADC reste disponible pour une configuration locale de confiance. Les tests unitaires ci-dessous ne nécessitent aucun compte cloud.
- Pour suspendre les nouveaux imports sans toucher aux autres services, désactiver l’intégration Google et sa planification. Révoquer la liaison WIF pour bloquer les prochains renouvellements ; les jetons déjà délivrés restent potentiellement valides jusqu’à leur expiration. Aucune réécriture des permissions Google/AWS ni publication Store n’est faite automatiquement.

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/store-management/store-aws-wif.spec.ts src/mobile-operations/mobile-providers.spec.ts
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
```

La classe `StoreAwsWifClient` utilise `StsCredentials` (sous-module de `google-auth-library` 10.x) pour appliquer le même transport borné à STS et à l’impersonation. Conserver le test d’échange simulé lors des mises à jour de cette bibliothèque. La fédération réelle reste à valider après la configuration des deux consoles.

Validation locale de ce lot : compilation TypeScript réussie ; 115 tests ciblés réussis sur Store Management, Mobile Operations et App Updates, 37 ignorés faute d’activation de leurs fixtures PostgreSQL. Cela comprend 17 tests WIF, sans appeler AWS ou Google. Ce résultat ne remplace pas la recette de la configuration IAM réelle.

Références officielles : [configuration Google pour AWS](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds), [fournisseur AWS personnalisé pour ECS/Fargate](https://github.com/googleapis/google-auth-library-nodejs/blob/main/samples/customCredentialSupplierAwsWorkload.js), [configuration Google Play Developer API](https://developers.google.com/android-publisher/getting_started).

### Apple

1. Créer une clé d’équipe App Store Connect avec les droits adaptés et noter Issuer ID, Key ID et App ID.
2. Injecter la clé P8 côté serveur. Le JWT ES256 dure dix minutes et est renouvelé avant expiration.
3. Tester les accès application, avis, builds et rapports.
4. Si aucun rapport Analytics n’existe, demander explicitement une génération `ONGOING` dans Configuration. Cette action nécessite les droits Apple correspondants et ne publie aucune version.
5. Attendre la disponibilité des instances ; importer ensuite rapports et indicateurs techniques.

La collecte des rapports n’en crée pas implicitement. Les segments temporaires sont téléchargés sans transférer le JWT à leur hôte. HTTPS, hôtes autorisés, adresses publiques vérifiées, absence de redirection, limites de taille et contrôle de checksum protègent le téléchargement. Les URL signées ne sont pas stockées.

### Courriels administratifs

Configurer `STORE_SMTP_ENABLED=true`, `STORE_SMTP_HOST`, `STORE_SMTP_PORT` (465 ou 587), `STORE_SMTP_FROM`, `STORE_SMTP_USER` et `STORE_SMTP_PASSWORD`. TLS est obligatoire et les certificats sont vérifiés. Aucun e-mail n’est envoyé par les tests automatisés.

Les destinataires d’une règle sont des UUID de comptes back-office actifs avec `store.alerts.read`. Avant envoi, leur activité et leurs droits sont revérifiés ; les adresses sont mises en copie cachée. Sans SMTP, un événement demandé par e-mail reste en attente. En cas de résultat SMTP incertain, son état devient `unknown` et il n’est pas renvoyé automatiquement.

## Permissions et circuit des avis

Un `super_admin` possède tous les droits Store. Un `admin` sans profil personnalisé est lecteur. Un `marketer` ne possède aucun accès Store tant qu’un profil ne lui est pas attribué. Cela ne modifie pas leurs droits dans les autres modules.

Les profils `reader`, `technical`, `product`, `marketing`, `support` et `validator` sont disponibles. Le Super Admin peut attribuer une liste personnalisée via `PUT /access/:userId` ; une liste vide révoque l’accès Store. Les contrôles sont côté backend, indépendamment des boutons de l’interface. Un compte devant changer son mot de passe ne peut pas utiliser ces routes.

Le circuit d’une réponse est :

```text
brouillon -> soumission -> approbation -> tâche de publication -> résultat externe
```

Chaque brouillon possède une révision. Une modification invalide son approbation. Le préparateur ne peut pas s’auto-approuver, sauf Super Admin avec motif de dérogation journalisé. Le serveur publie le texte de la révision approuvée, jamais un texte libre reçu à l’étape de publication. Le worker revérifie les droits avant l’appel externe.

Les actions sont journalisées avec l’acteur, la ressource, la révision et les références de tâche. La réponse externe conserve sa référence et son état quand le fournisseur les expose. Un succès d’API peut précéder l’affichage public de la réponse.

## Routes administratives

Préfixe effectif : **`/api/v1/admin/store-management`**. L’alias `/api/v1/admin/stores` est utilisé par l’admin Next.js. Le préfixe global existant `/api/v1` n’est pas changé.

| Routes relatives                                                                                                                                   | Usage                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /status`, `/integrations`, `/integrations/:platform/status`                                                                                   | État, configuration sûre, capacités                          |
| `PATCH /integrations/:platform`, `POST /integrations/:platform/test`                                                                               | Activation, cadences, test asynchrone                        |
| `GET /overview`, `/dashboard`, `/analytics/google`, `/analytics/apple`, `/analytics/comparison`, `/analytics/acquisition`, `/analytics/conversion` | Dashboard normalisé avec méthodologie, cohortes et fraîcheur |
| `GET /analytics/downloads` | Dernier jour disponible par source et détail quotidien sur la période choisie |
| `GET /metrics/catalog`, `/metrics`, `/analytics/countries`                                                                                         | Définitions et historique paginé                             |
| `GET /records`, `/reviews`, `/reviews/:id`                                                                                                         | Ressources importées et détail du traitement interne         |
| `POST /reviews/:id/draft`, `/submit`, `/approve`, `/publish`, `/reconcile`                                                                         | Circuit contrôlé des réponses                                |
| `PATCH /reviews/:id/status`                                                                                                                        | Affectation, prise en charge ou clôture                      |
| `GET /versions`, `/builds`, `/review-status`, `/vitals`, `/vitals/errors`                                                                          | Distribution et technique                                    |
| `GET/POST /versions/:id/incidents`, `POST /incidents/:id/resolve`                                                                                  | Notes internes de refus/suivi                                |
| `POST /sync/:platform`, `GET /sync/history`, `GET /sync/:id`                                                                                       | Tâches manuelles et résultat                                 |
| `GET /syncs`, `POST /syncs/:id/retry`, `POST /apple/analytics-request`                                                                             | Alias, relance d’import et demande Apple                     |
| `GET /alerts`, `/alerts/events`, `/alerts/rules`                                                                                                   | Diagnostics, notifications persistantes, règles              |
| `POST /alerts/rules`, `PUT ou PATCH /alerts/rules/:id`, `POST /alerts/events/:id/acknowledge`                                                      | Paramétrage et traitement des alertes                        |
| `GET /reports`, `POST /reports/export`                                                                                                             | Catalogue des rapports et export                             |
| `GET /access`, `PUT /access/:userId`, `GET /audit-logs`                                                                                            | Profils, permissions et audit                                |

Les collections sont paginées (`page`, `limit`). Les dates sont au format `YYYY-MM-DD`. Dashboard/import : maximum 93 jours par demande ; historique métrique : maximum 366 jours. Une période ancienne peut être réimportée si la source la fournit. Les filtres absents ne doivent pas être envoyés comme chaînes vides.

Exemple de synchronisation manuelle :

```json
{
  "task": "reviews",
  "requestId": "10000000-0000-4000-8000-000000000001",
  "from": "2026-10-01",
  "to": "2026-10-19"
}
```

Conserver le même `requestId` pour rejouer la **même intention et le même contenu** après une réponse HTTP incertaine. Le réutiliser avec un autre contenu provoque un conflit. Une tâche en attente retourne son identifiant ; consulter son état, et non supposer que la synchronisation ou publication est déjà terminée.

## Derniers téléchargements et détail par dates

Dans **Stores & Distribution → Vue d’ensemble** et **Statistiques**, une synthèse
affiche désormais séparément les installations Android, les premiers téléchargements
iOS et les retéléchargements iOS. Elle réutilise les cartes, boutons et tableaux
existants de l’admin ; aucune feuille de style globale n’est modifiée.

- Le grand chiffre correspond au **dernier jour ayant une valeur importée**, avec
  date du rapport, date d’import et source officielle. Ce n’est pas un compteur
  depuis le lancement de l’application. Les mises à jour ne sont pas ajoutées aux
  téléchargements.
- Ce dernier jour peut être hors de la plage sélectionnée. Le bouton **Voir ce jour**
  sélectionne sa date. Les filtres plateforme/pays/version sont respectés dans les
  deux cas ; une ventilation absente reste indisponible.
- Le **total des jours disponibles** et le tableau quotidien suivent strictement
  les dates choisies, inclusives, dans la limite existante de 93 jours. La couverture
  affiche le nombre de jours renseignés et indique une période partielle. Un zéro
  explicitement rapporté est conservé ; aucun zéro n’est créé pour un jour absent.
  Même une période renseignée reste soumise aux seuils de confidentialité du store.
- Le code n’additionne pas Android et iOS, ni les différentes ventilations Google.
  Google utilise le jeu `installs` pour les pays ou `installs_app_version` si une
  version est demandée, jamais les deux. Apple utilise `App Store Downloads`.
- Les noms Apple `App Downloads Standard` et
  `App Store Installation and Deletion Standard` sont reconnus et rattachés aux
  jeux internes existants `App Store Downloads` et
  `App Store Installations and Deletions`. Les anciens noms restent compatibles ;
  les variantes `Detailed` ne sont pas cumulées avec `Standard`. Le nom officiel
  reçu est conservé dans `sourceName` du suivi de rapport. Cette correction ne
  nécessite aucune migration et ne crée pas de demande de rapport chez Apple.
- L’admin relit les données toutes les **15 secondes pendant que la page est
  active**, et après retour sur la page ou reconnexion. Ces lectures vont uniquement
  vers PostgreSQL/Redis, jamais vers les fournisseurs. L’onglet Statistiques et le
  graphique existant se rafraîchissent également. Un changement de filtres n’affiche
  pas provisoirement les chiffres de l’ancienne sélection.
- Un rapport externe doit d’abord être **importé** : cette fonction n’active pas
  `STORE_SYNC_ENABLED` et ne raccourcit pas le délai de publication Apple/Google.
  La planification existante reste configurable ; un import manuel reste possible
  avec les permissions appropriées. Aucune activation AWS n’est incluse dans ce lot.

Le nouvel endpoint utilise les gardes existants et `store.analytics.read`, une
limite de 20 requêtes par minute, les identifiants d’application configurés côté
serveur et une validation de période. La dernière valeur et les détails sont lus
dans un même snapshot PostgreSQL `REPEATABLE READ`, avec requêtes bornées à 5 secondes
et index existants. Les sommes restent en décimal PostgreSQL, sans arrondi JavaScript.
Le cache Redis dure 120 secondes mais sa génération change dès un import, y compris
une correction retirant tous les chiffres d’une journée. Il ne faut donc pas attendre
l’expiration de l’ancien cache après une correction.

Exemple, avec un JWT administratif autorisé :

```http
GET /api/v1/admin/stores/analytics/downloads?platform=apple&from=2026-10-01&to=2026-10-31
```

La réponse contient `metrics[].latest`, `metrics[].period` et `metrics[].daily`,
avec `null` pour les données indisponibles et `comparableAcrossStores=false`.
L’alias `/api/v1/admin/store-management/analytics/downloads` expose le même contrat.
Pas de nouvelle migration ni dépendance. Livrer le backend et `zwanga-admin` pour
disposer de l’affichage ; aucune donnée fictive n’est insérée dans la base applicative.

## Synchronisation et conservation

Cadences initiales : connexion toutes les six heures, avis chaque heure, catalogue toutes les deux heures, rapports et vitals chaque jour. Les cadences sont modifiables par intégration. Le planificateur passe chaque minute et le worker toutes les trente secondes.

PostgreSQL impose une seule tâche active par application et flux. Les baux durent cinq minutes ; un traitement a un délai d’arrêt de deux minutes et des requêtes externes bornées. Les workers utilisent `SKIP LOCKED` et un identifiant de bail pour empêcher un ancien worker d’écrire après reprise. Google et Apple sont traités séparément.

Les imports utilisent des identifiants uniques et remplacent des partitions journalières complètes. Une correction récente remplace l’ancienne partition, y compris les dimensions disparues ; une révision plus ancienne ne l’écrase pas. Les données déjà validées restent disponibles si un import ultérieur échoue. Un job peut donc avoir importé des partitions avant de signaler un échec sur une autre partie.

Les erreurs temporaires de lecture sont réessayées avec délai progressif et prise en compte de `Retry-After`, au maximum cinq tentatives. Les écritures externes ne sont pas rejouées automatiquement. Le traitement conserve des limites explicites : 20 pages par parcours, 12 Mo par fichier, 24 Mo cumulés pour une instance Apple décompressée, 50 000 lignes par rapport. Un dépassement doit être diagnostiqué ; il n’est pas présenté comme un import complet.

Le nettoyage quotidien retire l’historique Store ancien par petits lots. Les tâches actives ou incertaines, les avis encore en traitement et les versions référencées par un incident sont conservés. Ce nettoyage ne supprime ni utilisateurs, ni trajets, ni KYC. Le délai de 24 mois est une cible de rétention du module, pas une garantie de récupération rétroactive auprès des stores.

## Test local sans accès aux fournisseurs

Ne pas lancer les migrations avec une configuration pointant sur la production. Les tests PostgreSQL ci-dessous créent leur propre cluster temporaire, sur loopback et port aléatoire ; ils ne chargent pas la base du `.env` applicatif.

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns=store-management
$env:AUDIT_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/store-management/store-postgres.spec.ts
```

Adapter le chemin PostgreSQL à la machine. Pour l’admin, exécuter `node node_modules/typescript/bin/tsc --noEmit --incremental false` dans `zwanga-admin`. Les tests unitaires de ce dépôt utilisent `node --test`.

Pour tester ensuite dans une vraie base **locale dédiée**, vérifier l’hôte, la base et le port PostgreSQL avant d’utiliser les commandes de migration existantes. Appliquer les deux migrations Store, activer le module, laisser initialement `STORE_SYNC_ENABLED=false`, puis démarrer les applications avec leur procédure locale habituelle. La page `/stores` affichera les intégrations non configurées sans appeler les fournisseurs.

## Recette avec les comptes Google et Apple

1. Configurer les clés et tester chaque capacité séparément. Une clé invalide doit produire un diagnostic sans secret ; l’autre plateforme doit rester utilisable.
2. Importer avis et catalogue, contrôler pagination et correspondance avec les consoles.
3. Réimporter la même période : pas de doublons. Vérifier une correction tardive sur un rapport réel.
4. Tester un compte lecteur, un préparateur et un validateur. Une requête API manuelle sans permission doit être refusée.
5. Sur un avis choisi explicitement pour la recette, vérifier brouillon, auto-approbation refusée, approbation par une autre personne, publication, réponse officielle et audit. **Cette étape écrit publiquement sur le store** : ne pas l’exécuter sur un avis réel sans accord de l’équipe.
6. Créer une règle adaptée aux indicateurs disponibles, vérifier l’événement Admin puis, si autorisé, l’e-mail.
7. Exporter les résultats et comparer les définitions, périodes et totaux à la source. Valider l’interface sur desktop et tablette.
8. Activer la planification seulement après cette recette. Mesurer les latences et la charge avec le volume réel avant de retenir les objectifs de performance et disponibilité.

## Récupération après incident et retour arrière

- **Clé révoquée ou permission insuffisante** : désactiver l’intégration concernée, corriger les accès, redémarrer le processus pour renouveler les clients en mémoire, tester puis réactiver. Ne pas augmenter les privilèges de l’autre fournisseur.
- **Rapports absents** : contrôler demande Apple, bucket Google, période, délais et seuils de confidentialité. Ne pas créer des lignes de valeur zéro.
- **Import partiel ou limite atteinte** : consulter le code d’erreur et les éléments traités ; réduire la période ou les dimensions Google, puis relancer la lecture. Ne pas supprimer l’historique pour forcer un succès.
- **Réponse `unknown`** : vérifier la console, synchroniser à nouveau les avis, puis appeler `/reviews/:id/reconcile`. Le rapprochement exige une observation plus récente correspondant exactement au texte envoyé. Aucune nouvelle réponse n’est publiée par ce rapprochement. Si la réponse reste absente, une investigation technique est nécessaire avant de débloquer la demande ; il n’existe pas de bouton forçant un renvoi aveugle.
- **SMTP `unknown`** : consulter les journaux du relais ; ne pas renvoyer automatiquement un message dont la réception est incertaine.
- **Arrêt du module** : `STORE_MANAGEMENT_ENABLED=false`, puis redémarrage. Les routes métier existantes et les données déjà importées restent en place.
- **Revert de schéma** : arrêter les workers Store, sauvegarder les dix tables du module, puis appliquer `down` de `1780000078000`, ensuite de `1780000077000`. Cela supprime les imports, workflows, alertes et audits Store ; les tables métier ne sont pas modifiées. Préférer la désactivation au revert destructif si l’historique doit être conservé.

## Références officielles

Les conventions d’authentification, de rapports et de pagination reposent sur les documentations officielles suivantes :

- [Réponses aux avis Google Play](https://developers.google.com/android-publisher/reply-to-reviews)
- [Exports statistiques Google Play](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en)
- [Requêtes Android Vitals](https://developers.google.com/play/developer/reporting/metricset-queries)
- [Groupes d’erreurs Google](https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/vitals.errors.issues/search)
- [Jetons App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- [Téléchargement des rapports Apple](https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports)
- [Corrections et complétude Apple](https://developer.apple.com/documentation/analytics-reports/data-completeness-corrections)
- [Installations et suppressions Apple](https://developer.apple.com/documentation/analytics-reports/app-installs)
- [Sessions Apple](https://developer.apple.com/documentation/analytics-reports/app-sessions)
- [Power and Performance Metrics](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-perfpowermetrics)

## État de recette locale

Complément du 5 novembre 2026 : les pages Stores sont accessibles depuis le menu **Applications mobiles** et la palette selon les permissions du backend. La page `/mobile-operations` gère la supervision, les politiques et les campagnes ; voir le [parcours administrateur](mobile-operations.md#utilisation-dans-zwanga-admin). La configuration Store affiche WIF/Apple sans secret et suit l’exécution du test de connexion. Les profils personnalisés incluent les permissions mobiles. Les feuilles de style existantes n’ont pas été modifiées.

Le lot dispose de tests unitaires, HTTP/RBAC et PostgreSQL isolé. Une exécution générale a réussi avec **207 suites et 2 327 tests**, sans échec ; 19 suites et 309 tests exigeant un environnement particulier sont ignorés dans cette exécution. Le module Store est également testé séparément : contrôles de permissions, initialisation NestJS sans accès externes lorsque désactivé, imports, migrations aller-retour, concurrence, alertes et rapprochement des réponses incertaines. Les 12 tests Node de l’admin passent. Le backend et l’admin passent le contrôle TypeScript ; la compilation NestJS passe. La synthèse PDF de démonstration a été rendue et examinée sur deux pages.

Ces résultats historiques ne constituent pas une recette des fournisseurs. La connexion Apple a ensuite été vérifiée en réel (détails ci-dessous), mais la connexion Google, la publication d’une réponse réelle, la délivrabilité SMTP, les quotas du compte et la recette navigateur de bout en bout restent à valider. L’interface comprend la comparaison de deux versions, les notes de refus et leur résolution ; leur recette métier doit se faire avec les données et rôles de test de l’équipe. Les tests locaux ne constituent donc pas la validation finale de l’intégralité du cahier des charges.

### Import réel et préparation du 5 novembre 2026

- Apple : accès application, avis, builds et Analytics confirmés. Demande `ONGOING` confirmée après autorisation explicite, sans publication d’application ni réponse à un avis. Le client réutilise une demande active existante au lieu d’en créer une seconde.
- Base locale uniquement : **4 avis, 15 versions et 124 builds** importés par les tâches durables existantes. La page `/stores` permet de les consulter dans les onglets correspondants. Un filtre de dates peut exclure les avis plus anciens.
- Les tâches `connection`, `catalog` et `reviews` ont réussi. `reports` et `vitals` indiquent `REPORTS_NOT_YET_AVAILABLE` : aucun total de téléchargements ou taux de crash n’est inventé. Un enregistrement de performance a été observé, mais sa présence ne prouve pas que tous les indicateurs techniques sont disponibles.
- Apple annonce environ **24 à 48 heures après la première demande** pour les premiers rapports : [Analytics Reports API](https://developer.apple.com/help/app-store-connect-analytics/overview/analytics-reports-api). Relancer l’import `reports`, puis `vitals`, après disponibilité. Les périodes antérieures ne sont pas garanties par une demande `ONGOING` ; aucune demande historique `ONE_TIME_SNAPSHOT` n’a été lancée.
- Google : le bucket communiqué est configuré localement et dans SSM. Sur le PC, le test WIF est bloqué par l’absence d’identifiants AWS temporaires adaptés ; ne pas ouvrir la relation de confiance du rôle de production pour contourner cette protection. Les données Google ne sont donc pas encore importées.
- Validation de ce passage : **13 suites, 127 tests réussis, aucun ignoré**, sur `src/store-management` et `src/mobile-operations`, fixtures PostgreSQL isolées activées. Contrôle TypeScript de production sans émission réussi. Lecture réelle du dashboard Apple et pagination des avis/versions/builds réussies. Aucun test d’envoi de notification, de paiement ou de publication Store réel.

### Activation ultérieure en production

Le [modèle de configuration](../infra-aws/store-management.env.example) contient les noms et les valeurs publiques ; **ne jamais y renseigner une clé réelle**. Les 17 paramètres correspondants sont déjà créés en version 1 sous `/zwanga-api/production/env/`, tous en `SecureString`, sans écrasement préalable. Les deux drapeaux principaux et les réponses aux avis, edits Google temporaires, Sales and Trends et SMTP sont désactivés.

État AWS vérifié après préparation : service `zwanga-api-production-api`, définition `:38`, **1 tâche active sur 1 attendue**, déploiement `COMPLETED`. Cette définition n’injecte pas encore les paramètres Store. Aucun `update-service`, lancement de tâche, modification IAM ou migration de production n’a été effectué. Les imports locaux ne sont pas copiés dans RDS.

Ordre de mise en service :

1. Dans Google Cloud, vérifier le pool `zwanga-aws-prod`, le provider AWS `ecs-fargate`, la condition limitée au compte `046374119247` et au rôle `zwanga-api-production-ECSTaskRole`, ainsi que la liaison `roles/iam.workloadIdentityUser` du compte de service. Vérifier séparément les permissions Play Console et la lecture du bucket fourni. Ne pas accorder de droit de publication pour les statistiques.
2. Dans la procédure de livraison existante, **planifier et relire** les changements nécessaires pour injecter les 17 noms SSM dans la nouvelle définition de tâche. `infra-aws/ssm.tf` découvre les paramètres externes mais la définition active ne change pas toute seule. Ne pas appliquer un plan contenant d’autres changements non approuvés. Aucune commande `terraform apply` n’a été exécutée ici.
3. Livrer le code validé et appliquer les migrations nécessaires via le mécanisme existant avant activation. Vérifier les migrations Store `1780000077000`/`1780000078000` et, si la supervision mobile fait partie de la livraison, `1780000111000`. Ne pas exécuter un script local pointant implicitement vers la production. Vérifier l’accès SSM/KMS du rôle d’exécution à l’aide des noms et ARN uniquement.
4. Garder `STORE_MANAGEMENT_ENABLED=false` pendant la première vérification de démarrage. Après autorisation d’activation, passer ce seul drapeau à `true` et renouveler les tâches par la procédure de livraison habituelle ; `STORE_SYNC_ENABLED` reste `false`. Les changements de valeurs SSM ne sont pas relus par les tâches déjà démarrées.
5. Depuis **Stores & Distribution → Configuration**, lancer les tests Google et Apple, attendre leur résultat dans Synchronisations, puis importer manuellement avis, catalogue Apple, rapports et vitals. Tester Google avec les identifiants temporaires du **rôle de tâche ECS**, pas ceux du poste développeur. La demande Apple `ONGOING` existante sera réutilisée. Le catalogue Google reste volontairement désactivé tant que les edits temporaires ne sont pas autorisés séparément.
6. Contrôler sources, dates, disponibilité et rapprochement avec les consoles. Activer ensuite la planification (`STORE_SYNC_ENABLED=true` + renouvellement contrôlé des tâches) seulement après une recette réussie. Aucune activation des réponses aux avis, publications ou campagnes mobiles n’est incluse.

Surveillance : état des jobs, erreurs WIF/permissions, délais des rapports, fraîcheur des données, CPU/mémoire ECS et charge PostgreSQL. Ne jamais journaliser de clé, JWT ou URL signée. Pour suspendre, désactiver l’intégration ou le module puis renouveler les tâches de manière contrôlée ; conserver les données et audits. Ne pas supprimer un paramètre encore référencé par une définition active. Le détail des opérations est consigné dans [le journal infrastructure](../infra-aws/docs/CHANGELOG.md#infra-2026-11-05-001--préparation-store-management-sans-activation-ecs).
