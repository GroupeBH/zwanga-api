# Store Management dans Zwanga

Store Management est intégré au backend NestJS existant et à la page `/stores` de `zwanga-admin`. L’API utilise les comptes administratifs existants. Le module est **désactivé par défaut** ; aucun accès Google, Apple ou SMTP ne démarre tant que son activation et ses identifiants ne sont pas configurés.

Les changements sont locaux. Ni les workflows CI/CD, ni Terraform, ni AWS ne sont modifiés. Aucun code n’a été poussé sur GitHub. La validation des connexions réelles et la recette utilisateur restent nécessaires avant une activation en production.

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

Les groupes d’erreurs Google décrivent la fenêtre officielle par défaut des dernières 24 heures lors de l’import. Les performances Apple décrivent des percentiles par version récente, pas une série journalière. Les détails de diagnostics non importés restent consultables dans les consoles officielles. GA4, Crashlytics, Sales and Trends, les historiques d’avis Google par CSV et les opérations de publication V2 ne sont pas intégrés dans ce lot.

## Configuration serveur

Utiliser `.env.example` comme liste de noms, **pas comme fichier de secrets à partager**.

| Variable                          | Fonction                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `STORE_MANAGEMENT_ENABLED`        | `true` active le module ; défaut désactivé                                                                               |
| `STORE_SYNC_ENABLED`              | `true` active la création automatique des tâches ; les tâches manuelles sont traitées même si cette variable est `false` |
| `STORE_RETENTION_MONTHS`          | 24 par défaut, entre 1 et 120                                                                                            |
| `STORE_GOOGLE_PACKAGE_NAME`       | `com.zwanga` pour l’application actuelle                                                                                 |
| `STORE_GOOGLE_CLIENT_EMAIL`       | Adresse du compte de service dédié                                                                                       |
| `STORE_GOOGLE_PRIVATE_KEY`        | Clé PEM du compte de service, retours à la ligne réels ou `\n`                                                           |
| `STORE_GOOGLE_REPORTS_BUCKET`     | Bucket `pubsite_prod_...` fourni par Google Play                                                                         |
| `STORE_GOOGLE_INSTALL_DIMENSIONS` | `country,app_version,device,os_version` par défaut ; `country` seul réduit les imports                                   |
| `STORE_APPLE_APP_ID`              | `6756211830` pour l’application actuelle                                                                                 |
| `STORE_APPLE_ISSUER_ID`           | Issuer de la clé d’équipe Apple                                                                                          |
| `STORE_APPLE_KEY_ID`              | Identifiant de cette clé                                                                                                 |
| `STORE_APPLE_PRIVATE_KEY`         | Contenu PEM du fichier P8 ES256                                                                                          |
| `STORE_APPLE_REPORT_HOSTS`        | Facultatif, hôtes exacts supplémentaires pour les segments ; pas de wildcard                                             |

Les clés ne sont jamais acceptées dans un DTO, renvoyées par REST ou conservées dans les tables Store. Les diagnostics exposent des codes sûrs et les **noms** des variables manquantes, pas leurs valeurs. Pour une future production, injecter les secrets avec le mécanisme sécurisé déjà utilisé par Zwanga. Aucune configuration AWS n’a été réalisée ici.

### Google Play

1. Créer un compte de service **dédié à cette intégration** dans Google Cloud et activer Android Publisher et Play Developer Reporting.
2. Lui donner accès à cette application dans Play Console, avec les permissions de lecture nécessaires ; n’ajouter la réponse aux avis qu’aux usages autorisés.
3. Autoriser la lecture des exports GCS. Le bucket de rapports n’est pas le bucket applicatif Zwanga.
4. Injecter l’adresse et la clé privée côté serveur. Les jetons OAuth sont renouvelés par `google-auth-library`.
5. Lancer le test de connexion, puis consulter les capacités séparément.

La lecture des tracks utilise un **edit temporaire non validé**, supprimé ensuite. Aucun `commit` n’est appelé. Un compte technique séparé évite d’interférer avec les edits d’un outil de livraison. Un échec de nettoyage est signalé, pas ignoré.

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

Le lot dispose de tests unitaires, HTTP/RBAC et PostgreSQL isolé. Une exécution générale a réussi avec **207 suites et 2 327 tests**, sans échec ; 19 suites et 309 tests exigeant un environnement particulier sont ignorés dans cette exécution. Le module Store est également testé séparément : contrôles de permissions, initialisation NestJS sans accès externes lorsque désactivé, imports, migrations aller-retour, concurrence, alertes et rapprochement des réponses incertaines. Les 12 tests Node de l’admin passent. Le backend et l’admin passent le contrôle TypeScript ; la compilation NestJS passe. La synthèse PDF de démonstration a été rendue et examinée sur deux pages.

La connexion réelle aux deux comptes, la publication d’une réponse réelle, la délivrabilité SMTP, les quotas du compte et la recette navigateur de bout en bout ne sont pas validés par ces tests locaux. L’interface comprend la comparaison de deux versions, les notes de refus et leur résolution ; leur recette métier doit se faire avec les données et rôles de test de l’équipe. Les tests locaux ne constituent donc pas la validation finale de l’intégralité du cahier des charges.
