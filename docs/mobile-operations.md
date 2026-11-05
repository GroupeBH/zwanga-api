# Centre de supervision mobile Zwanga

## État de la livraison locale — 5 novembre 2026

Le module `src/mobile-operations` étend le backend existant. Il fournit les API du centre de supervision Admin et de son instrumentation mobile. L’interface correspondante est intégrée dans `zwanga-admin` à `/mobile-operations`, aux côtés des Stores à `/stores`. Il ne crée ni backend indépendant, ni service Go, ni nouvelle infrastructure de push.

Les fonctionnalités sont désactivées par défaut. Aucune migration applicative, configuration AWS, modification Terraform/CI/CD, publication GitHub ou opération Google/Apple réelle n’a été exécutée pendant cette implémentation. Les tests fournisseurs utilisent des simulations ; les tests PostgreSQL démarrent des clusters locaux temporaires dédiés.

Cette livraison comprend le backend et l’interface Admin, pas une activation complète sur les appareils : le mobile devra appeler les nouveaux contrats. La recette avec les vrais comptes Google/Apple et les mesures à volume réel restent à effectuer.

## Utilisation dans Zwanga Admin

Le menu **Applications mobiles** apparaît selon les permissions renvoyées par le serveur, dans la navigation et la palette de recherche. Les styles globaux, les écrans métier et l’ancien écran `/app-updates` sont conservés.

- **Stores & Distribution** : vues Google/Apple, avis, versions, exports, synchronisations, configuration et permissions. La configuration affiche le mode WIF/ADC/compte de service Google ou clé d’équipe Apple, les noms des variables manquantes, les capacités testées et la fraîcheur. « Tester la connexion » met un travail en file : seul son résultat confirme la connexion. Les réponses publiques restent désactivables côté serveur.
- **Supervision mobile** : activité/rétention observées, inventaire paginé et historique des contacts des installations, versions déclarées, règles de mise à jour, campagnes, résolution des alertes et audit. Les valeurs indisponibles ne deviennent pas zéro ; acceptation d’un push, livraison et lecture restent distinctes.
- **Règles de mise à jour** : enregistrer en état inactif, puis confirmer séparément l’activation avec une preuve de disponibilité de la release pour toute la population. La modification désactive une règle déjà active. Le serveur contrôle les révisions et refuse les contradictions avec un déploiement progressif. L’UI ne remplace pas le branchement de `version/check` dans le mobile ni le contrôle des endpoints métier.
- **Campagnes** : brouillon (staging par défaut), ciblage/estimation, approbation par un autre administrateur, confirmation d’envoi immédiat ou planifié. La modification retire l’approbation. Une annulation ne rappelle pas un push déjà transmis. L’envoi est bloqué si `MOBILE_CAMPAIGNS_ENABLED` est désactivé. Les créations conservent leur UUID pendant les nouveaux essais de la même page après erreur réseau ; les transitions utilisent la révision serveur et une confirmation explicite.
- **Permissions personnalisées**, `/stores?tab=access` : un Super Admin peut attribuer les droits `mobile.*` aux comptes existants. Pour approuver une campagne, attribuer au minimum `mobile.campaigns.read` et `mobile.campaigns.approve` à un autre administrateur. L’envoi exige `mobile.campaigns.launch`. Les contrôles NestJS restent la référence, même en appel direct.

Le statut Store expose uniquement des drapeaux `features` et un `authMode` non secret. Si ces champs manquent sur un ancien backend, l’admin explique l’indisponibilité de la supervision sans appeler ses routes. Aucun secret Google/Apple n’est saisi dans le navigateur.

### Recette de l’interface

1. Démarrer backend compatible et admin selon leurs commandes habituelles, avec les migrations et variables de l’environnement choisi.
2. Se connecter en Super Admin ; ouvrir **Stores & Distribution → Configuration**, tester Google puis Apple et attendre le résultat. Cette étape, à effectuer par l’opérateur, contacte les fournisseurs réels.
3. Dans **Synchronisations**, lancer explicitement les imports nécessaires. Un rapport indisponible ne doit pas être présenté comme un zéro.
4. Dans **Supervision mobile**, contrôler les installations instrumentées. Avec deux comptes administratifs de test, vérifier brouillon, auto-approbation refusée, validation distincte, révision périmée et annulation. Ne lancer un envoi réel qu’avec une audience de test consentante.

Vérifications du lot UI : compilation Next.js de production et contrôles TypeScript admin/backend réussis ; tests unitaires et rendu des composants admin, tests backend ciblés Stores/Mobile Operations. Les suites PostgreSQL exigeant des binaires dédiés n’ont pas été relancées dans ce passage. Ces tests ne valident pas la connexion réelle Google/Apple, la livraison à un téléphone ou une recette navigateur de bout en bout.

## Audit préalable et architecture retenue

| Composant trouvé dans le dépôt | Réutilisation |
| --- | --- |
| NestJS 11, configuration globale, Swagger et validation DTO | Module importé par `AppModule`, préfixe existant `/api/v1`, DTO stricts |
| JWT, `RolesGuard`, permissions Store par compte administratif | Aucun nouveau mécanisme de connexion ; permissions `mobile.*` ajoutées au catalogue existant |
| TypeORM et migrations explicitement enregistrées | Une migration additive `1780000111000-MobileOperations` |
| PostgreSQL, traitements durables avec baux et `SKIP LOCKED` | Même principe pour les campagnes, sans ajouter BullMQ |
| Redis et `CacheService` | Cache analytics de 60 secondes, pas de requête Store à chaque page |
| `app-updates` | Registre `app_update_installations`, séquences, preuve par secret, catalogue `app_store_releases` |
| `store-management` | Clients Google/Apple, importations, métriques, avis, jobs, audit et boîte d’alertes |
| Notifications Firebase et outbox existantes | Transport borné, résultat protégé par bail, nouvelle catégorie non urgente |
| Secrets injectés par l’infrastructure existante | Noms de configuration uniquement ; aucune clé acceptée dans les DTO ou renvoyée par les nouvelles API |

Les risques prioritaires étaient le mélange des campagnes avec les sonneries de trajet, les envois après retrait du consentement, les doublons entre instances, les restrictions de version impossibles à satisfaire, et les statistiques trompeuses. Les contrôles PostgreSQL, de permissions et de confidentialité ont guidé l’implémentation.

## Activation et configuration

Les noms figurent aussi dans `.env.example`. Ne jamais y mettre les secrets réels.

| Variable | Défaut / effet |
| --- | --- |
| `MOBILE_OPERATIONS_ENABLED` | `false` ; active les nouvelles API et la supervision locale |
| `MOBILE_CAMPAIGNS_ENABLED` | `false` ; autorise la planification et le traitement des envois ; nécessite le module actif |
| `MOBILE_INSTALLATION_RETENTION_DAYS` | `180` ; accepte 90 à 730 jours |
| `STORE_MANAGEMENT_ENABLED` | Module Store existant ; nécessaire pour configurer ses intégrations, droits et règles |
| `STORE_SYNC_ENABLED` | Planification Store existante ; laisser `false` pendant la configuration |
| `STORE_REVIEW_REPLIES_ENABLED` | `false` ; publication de réponses refusée dans l’API **et** le worker tant que non activée |
| `STORE_GOOGLE_AUTH_MODE` | `service_account` par défaut, `adc`, ou `aws_wif` pour ECS/Fargate |
| `STORE_GOOGLE_WIF_AUDIENCE` | En `aws_wif`, ressource publique du fournisseur Google avec le numéro de projet, pool et provider |
| `GOOGLE_APPLICATION_CREDENTIALS` | En mode ADC, chemin serveur vers une configuration de confiance ; jamais un fichier fourni par un utilisateur |
| `STORE_GOOGLE_TEMPORARY_EDITS_ENABLED` | `false` ; opt-in requis pour lire les tracks via un edit temporaire, jamais commité |
| `STORE_APPLE_SALES_REPORTS_ENABLED` | `false` ; import journalier Sales and Trends en complément des Analytics Reports |
| `STORE_APPLE_VENDOR_NUMBER` | Numéro vendeur requis pour Sales and Trends |

Le mode `aws_wif` utilise les identifiants temporaires du rôle de tâche ECS et l’impersonation du compte de service Google sans clé privée ni fichier ADC. La confiance et les permissions doivent d’abord être configurées : procédure complète dans [Store Management](store-management.md#workload-identity-federation-aws-ecs--google-play). Le mode ADC reste disponible pour d’autres configurations de confiance ; un fichier AWS/EC2 standard ne suffit pas à gérer les métadonnées de Fargate. Apple réutilise les variables Issuer ID, Key ID, P8 et App ID documentées dans le même guide. La fédération Store ne modifie pas Firebase.

### Précautions Google et Apple

- Les pistes Google ne sont pas accessibles par une simple lecture indépendante : l’API utilise un edit temporaire. En créer un peut invalider un autre edit de la même identité. Par défaut, cette capacité est refusée explicitement. Après accord, utiliser une identité dédiée et activer uniquement ce flag. Le code ne commite jamais l’edit et ne publie pas de release.
- Les réponses aux avis sont préparables mais leur écriture est désormais désactivée par défaut, y compris pour les tâches déjà en file. Une activation ultérieure reste soumise aux permissions et confirmations existantes.
- Apple associe les builds et états de déploiement progressif aux versions importées. La disponibilité par territoire non importée reste `null`.
- Sales and Trends importe au maximum 31 jours par demande. Les unités commerciales et retours/crédits restent deux métriques distinctes, ventilées par type de produit, pays et version. Aucun total n’est présenté comme des installations réelles.
- Les importations existantes, délais, quotas, pagination, contraintes de fichiers et reprises restent ceux du module Store. Un rapport indisponible ne devient pas une série de zéros.

## Contrats destinés au mobile

Toutes les routes ci-dessous utilisent le préfixe `/api/v1`.

| Méthode et chemin | Authentification / usage |
| --- | --- |
| `PUT /mobile/installations/:id` | Public avec `x-installation-secret` ; enregistrement, activité, token et préférences atomiques |
| `POST /mobile/installations/:id/link` | JWT + secret ; associe uniquement le compte de la session |
| `POST /mobile/installations/:id/unlink` | JWT + secret ; déconnexion de l’association courante |
| `DELETE /mobile/installations/:id` | Secret ; retire token et télémétrie de l’installation |
| `POST /mobile/version/check` | Public ; secret requis si `installationId` est fourni |
| `GET /mobile/installations/:id/communications` | Secret ; communications éligibles paginées |
| `POST /mobile/installations/:id/communications/:campaignId/opened` | Secret ; ouverture déclarée, idempotente |

### Identité de l’installation

Le mobile génère un UUID v4 aléatoire et un secret cryptographique de 64 à 128 caractères base64url, conservés dans son stockage sécurisé. Il envoie le secret uniquement dans l’en-tête `x-installation-secret`, jamais dans l’URL, les traces ou un outil analytics. Le serveur ne conserve que son empreinte. Ce secret prouve le contrôle de l’installation, **pas l’identité d’une personne**.

Exemple de corps du `PUT` :

```json
{
  "platform": "android",
  "environment": "production",
  "version": "1.0.16",
  "build": "145",
  "sequence": 1,
  "enabled": false,
  "pushProvider": "fcm",
  "notificationPermission": "denied",
  "preferences": { "operational": false, "updates": false, "marketing": false }
}
```

Après autorisation système, envoyer `enabled: true`, `notificationPermission: "granted"` et `pushToken`, avec la prochaine séquence. Les booléens doivent être réels : `"false"` est refusé. Les champs `userId`, rôle et identifiant matériel permanent sont interdits.

`sequence` augmente à chaque modification et contact instrumenté. Un renvoi de la même requête est sans effet ; une requête ancienne ne peut restaurer un token ou consentement dépassé. Pour `link` et `unlink`, utiliser un **second compteur indépendant**, également nommé `sequence` dans le corps. Appeler `unlink` avant la révocation de la session lors de la déconnexion. Un ancien logout ne peut détacher le nouveau compte.

Un seul contact par jour UTC est conservé pour l’activité observée. Pas de collecte automatique de localisation, IMEI, contacts ou pays. Une suppression conserve un marqueur non réutilisable jusqu’au nettoyage ; après suppression, générer un nouvel UUID et secret. Les routes sont limitées en débit, mais ce mécanisme n’est pas une attestation anti-bot : ne pas considérer les comptes d’installations comme des personnes vérifiées.

Le transport accepté ici est **FCM pour Android et iOS via Firebase**. Un token APNs brut ou Expo n’est pas un token FCM et est hors de ce nouveau contrat ; aucun second transport n’a été ajouté. Les autres notifications existantes conservent leur fonctionnement.

### Version et restrictions

Exemple : `POST /mobile/version/check` avec `{"platform":"android","environment":"production","version":"1.0.16","build":"145"}`.

La réponse indique `updateAvailable`, `mode`, `required`, version/build recommandés et minimums, `message`, `storeUrl`, `blockedFeatures`, `validForSeconds` et `protectedOperations`. Le module désactivé renvoie `NONE` sans accès à ses tables. Le build natif, pas le nom marketing, détermine la compatibilité. Un build déclaré n’est pas une preuve cryptographique.

Les fonctionnalités limitables sont uniquement `create_trip`, `accept_request`, `create_booking`, `create_request`. Clôture de trajet, assistance, sécurité et trajet en cours sont toujours protégés dans le contrat. Cette livraison ne pose **aucun guard global** sur les endpoints métier : le mobile doit encore appliquer cette réponse aux nouvelles opérations. Une interdiction serveur ciblée, notamment pour une vulnérabilité critique, nécessitera une intégration métier explicite et des tests dédiés ; elle n’est pas activée implicitement ici.

Les politiques sont créées inactives. Leur activation exige une release existante disponible, une confirmation explicite, une justification, et l’absence d’état Store contradictoire importé. Une version en déploiement partiel ne peut pas imposer une mise à jour globale. En l’absence de donnée Store, la confirmation administrative reste nécessaire : elle n’est pas une garantie automatique de disponibilité dans chaque territoire. Une modification désactive la politique jusqu’à nouvelle validation. La sélection privilégie la politique applicable la plus récente. Les stores fournissent l’installation, jamais le backend.

## API d’administration

Préfixe `/api/v1/admin/mobile-operations`, JWT et permissions côté serveur :

| Groupe | Routes |
| --- | --- |
| Supervision | `GET overview`, `GET analytics`, `GET integrations` |
| Installations | `GET installations`, `GET installations/:id/history` |
| Releases | `GET releases`, `GET releases/:id` |
| Politiques | `GET/POST policies`, `PUT policies/:id`, `POST policies/:id/activate`, `POST policies/:id/deactivate` |
| Campagnes | `GET/POST campaigns`, `PUT campaigns/:id`, `GET campaigns/:id/preview`, `GET campaigns/:id/stats` |
| Actions campagnes | `POST campaigns/:id/approve`, `POST campaigns/:id/launch`, `POST campaigns/:id/cancel` |
| Audit et alertes | `GET audit-logs`, `GET alerts`, `POST alerts/:id/resolve` |

Les imports, avis, rapports, vitals, synchronisations, accès administrateurs et règles restent sous `/api/v1/admin/store-management`. Le catalogue des releases confirmées est réutilisé depuis `/api/v1/app-updates/releases`. Sa création peut déclencher les anciennes annonces si `APP_UPDATES_ENABLED=true` : pour la recette, désactiver ce flux existant plutôt que créer une annonce publique involontaire.

Permissions ajoutées : `mobile.analytics.read`, `mobile.installations.read`, `mobile.policies.manage`, `mobile.campaigns.read`, `mobile.campaigns.create`, `mobile.campaigns.approve`, `mobile.campaigns.launch`, `mobile.audit.read`. Un administrateur ordinaire garde la lecture par défaut ; les écritures exigent une attribution explicite. Les droits Store existants protègent intégrations/releases/alertes. Le super administrateur possède les permissions, mais ne peut pas approuver sa propre campagne.

Les créations acceptent un UUID v4 d’idempotence. Réutiliser cet identifiant avec un contenu différent produit un conflit. Les modifications exigent `revision`. Les activations, validations, lancements et annulations demandent `{"revision":1,"confirmed":true}`. Un lancement peut ajouter `scheduledAt`. Les conflits de révision demandent de recharger le détail, pas de forcer une action périmée.

## Campagnes : fiabilité et consentement

Circuit : brouillon → approbation par un autre administrateur → lancement/programmation → préparation des destinataires → envoi asynchrone. Modifier une campagne approuvée annule son approbation.

- Les promotions, informations générales, invitations à l’inscription et nouvelles fonctionnalités exigent le consentement `marketing`. Les mises à jour utilisent `updates`, la maintenance et les communications opérationnelles `operational`.
- Ciblage : environnement, plateforme, population anonyme/associée/conducteur/passager, build inférieur et inactivité. Les rôles viennent de la base, jamais du payload anonyme. Le compte associé doit être actif.
- Unicité SQL `(campaignId, installationId)` et `eventKey` : pas de double préparation entre instances. Les comptes ayant plusieurs installations peuvent recevoir un message par installation.
- Préparation : au maximum 10 destinataires par tranche globale de 30 secondes, attente si la file atteint 200 éléments en attente. Les nouvelles installations créées après le début de campagne sont exclues.
- Envoi : au maximum 2 tentatives par tranche globale de 5 secondes. Cette limite volontairement prudente est partagée entre toutes les instances. Ajouter une task ECS ne multiplie pas ce débit.
- Le worker vérifie de nouveau token, consentement, état/expiration de la campagne, activité du compte et droits de l’approbateur/lanceur immédiatement avant l’envoi. Les campagnes n’utilisent pas le token du compte pour contourner les préférences de l’installation.
- Le transport Firebase existant est borné. Les baux et écritures conditionnelles évitent qu’un ancien worker écrase le résultat d’un nouveau. Les échecs suivent le backoff existant, avec un plafond de cinq tentatives dans cette file.
- Priorité normale, pas de sonnerie de demande, TTL maximal d’une heure et jamais au-delà de l’expiration de campagne. Les files urgentes et financières excluent explicitement `mobile_campaign`.
- Les droits retirés stoppent les envois suivants. Une annulation ne rappelle pas un push déjà accepté par FCM. Un timeout après acceptation peut provoquer un doublon externe : le transport n’offre pas une garantie exactly-once. Un identifiant de notification stable et des identifiants de regroupement sont fournis pour la déduplication côté appareil.

`completed` signifie que la préparation des destinataires est terminée, pas que tous les messages sont arrivés. Les statistiques distinguent acceptation fournisseur, échecs, tokens invalides, suppressions et ouvertures déclarées. Livraison à l’appareil, lecture humaine et conversion attribuée restent `null` faute de preuve.

Le changement de préférences s’effectue par le `PUT` complet de l’installation, séquence supérieure. Il ne désactive pas les notifications transactionnelles de sécurité, trajet ou paiement du compte. Les annonces historiques `app-updates` anonymes respectent aussi le refus `updates` ; leur parcours authentifié historique doit être configuré séparément lors du branchement mobile.

## Analytics, alertes et conservation

Les réponses distinguent données observées, cohortes retenues et résultats actuellement connus. Elles exposent source, définition, unité, période, UTC, fraîcheur et limites. Les requêtes analytiques ont un budget SQL de cinq secondes et un cache de 60 secondes ; l’objectif de latence reste à mesurer sur un volume représentatif.

- Installations : état actuel de la cohorte dont le premier contact tombe dans la période. Une installation n’est pas une personne.
- Activité : contacts quotidiens instrumentés. Rétention J1/J7/J30 : retour au jour exact, sur cohortes assez anciennes, sans prétendre mesurer toutes les sessions.
- Adoption : dernier build connu des installations vues dans la période, les 100 combinaisons principales ; ce n’est pas un inventaire historique reconstruit.
- Builds obsolètes : installations sous un minimum déclaré actif ; le contrôle individuel de distribution reste réalisé par `version/check`.
- Associations : un compte déjà existant peut être lié ; la conversion installation → **nouvelle inscription** reste inconnue. Le ratio association/installation est nommé séparément.
- Inscriptions et premiers trajets : cohortes de comptes, état actuel du premier trajet ; conducteurs/passagers actifs basés sur les trajets terminés dans la période. Ces comptes ne sont pas attribués à un Store ou à un appareil.
- Les filtres plateforme/version s’appliquent aux données d’installations et aux sources Store compatibles. Les métriques métier utilisent la période uniquement, explicitement indiqué. Pays/source/dimensions Store utilisent les endpoints Store existants ; le pays d’installation n’est pas collecté.
- Les métriques Google/Apple gardent leurs définitions ; aucune somme automatique installations + téléchargements + unités commerciales. Une source désactivée ou indisponible est signalée sans faux zéro.

Trois règles supplémentaires utilisent la boîte d’alertes existante : `mobile_push_failure_percent`, `mobile_registration_drop_percent`, `mobile_required_policy_conflict`. La fenêtre est configurable entre 5 et 10 080 minutes, la confirmation entre 0 et 1 440 minutes. Un changement de règle recommence sa période de confirmation. Les pourcentages nécessitent au moins dix observations de référence. Une violation persistante crée un seul événement jusqu’au retour à la normale, avec journal de résolution. Les autres règles Store existantes restent disponibles. Les courriels nécessitent le SMTP Store actif ; aucun SMS n’est envoyé.

Le nettoyage quotidien UTC retire par petits lots les installations inactives au-delà de la rétention, leur télémétrie et leurs références de livraison. Les tokens des notifications de campagne terminées/échouées sont purgés après sept jours. Le registre conserve un marqueur temporaire après demande d’effacement pour empêcher le rejeu d’anciennes requêtes. Les utilisateurs, finances, KYC et trajets ne sont jamais supprimés par ce nettoyage. Les statistiques d’installation peuvent donc diminuer après effacement : elles portent sur les données conservées.

## Migration, recette et retour arrière

### Dépannage local : erreur interne sur la vue d’ensemble

Le 5 novembre 2026, l’API `/api/v1/admin/mobile-operations/overview` renvoyait une erreur SQL `colonne c.userId inexistante`. La base locale disposait du registre historique des installations, mais pas encore de la migration `MobileOperations1780000111000`. Renseigner les identifiants Google/Apple ou activer `MOBILE_OPERATIONS_ENABLED` ne crée pas les tables et colonnes : les migrations ne sont pas exécutées automatiquement au démarrage.

Après vérification de la destination locale et accord de l’opérateur, cette seule migration a été appliquée avec TypeORM en transaction ; aucune migration ne reste en attente sur cette base. Les requêtes de la vue d’ensemble ont ensuite réussi pour toutes les plateformes, Android et iOS. Aucun secret, réglage AWS, style Admin ou donnée métier existante n’a été modifié par cette correction.

Pour un autre environnement, vérifier d’abord `DATABASE_URL` / `MIGRATION_DATABASE_URL` (ou les paramètres `DATABASE_*`) sans les publier, puis :

```sh
npm run migration:show
# Examiner la liste : migration:run applique TOUTES les migrations en attente.
npm run migration:run
```

Ne pas activer `TYPEORM_SYNCHRONIZE` pour contourner cette étape. Une fois le schéma à jour, actualiser la page Admin. Un inventaire vide signifie qu’aucune installation n’est encore enregistrée dans cette base ; les contacts quotidiens nécessitent l’instrumentation mobile et les chiffres Store nécessitent leurs importations distinctes.

### Procédure de recette

1. Sur une **base locale dédiée**, vérifier la destination avant les commandes de migration habituelles. La nouvelle migration dépend des migrations Store et App Updates déjà présentes.
2. Laisser `MOBILE_CAMPAIGNS_ENABLED=false`, `STORE_SYNC_ENABLED=false`, réponses aux avis et edits temporaires désactivés. Activer seulement `MOBILE_OPERATIONS_ENABLED` pour la recette des contrats.
3. Tester enregistrement, séquence ancienne, rotation, préférences, association, changement de compte, logout retardé et effacement.
4. Créer une release et une politique de test ; vérifier builds, audience, expiration et contradiction avec un déploiement partiel importé. Ne pas créer d’annonce existante si son push est actif.
5. Tester deux administrateurs distincts, droits insuffisants, révision périmée, retrait des droits, annulation et consentement retiré après préparation.
6. Brancher le mobile : secret sécurisé, contacts limités au besoin, compteur persistant, version au démarrage/reprise, association/logout, préférences et événements d’ouverture. Effectuer la recette de l’interface Admin intégrée selon le parcours ci-dessus.
7. Valider séparément les comptes techniques Google/Apple et les importations réelles, avec l’autorisation des responsables. Activer les jobs et campagnes uniquement après cette recette, sans confondre contrôle local et validation fournisseur.

Tests sans secrets ni fournisseurs :

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns="mobile-operations|store-management|app-updates"
$env:MOBILE_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
$env:AUDIT_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
$env:APP_UPDATES_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
$env:INSTALLATION_UPDATES_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/mobile-operations/mobile-postgres.spec.ts src/store-management/store-postgres.spec.ts src/app-updates/app-updates-postgres.spec.ts src/app-updates/installation-updates-postgres.spec.ts
```

Les fixtures utilisent les binaires PostgreSQL indiqués, loopback, un port aléatoire et un répertoire temporaire vérifié ; elles n’utilisent pas la base du `.env`. Adapter le chemin à la machine.

Vérifications réalisées pendant cette intégration : compilation TypeScript sans émission réussie ; suite générale exécutée avec 3 449 tests réussis et 770 ignorés faute de leurs prérequis spécifiques ; puis 98 tests ciblés réussis après les derniers ajouts ; enfin 37 tests PostgreSQL réussis dans quatre suites isolées, incluant le worker concurrent et le retour arrière de migration. Ces résultats se recoupent et ne doivent pas être additionnés. Aucun test réel avec identifiants fournisseurs ni test de charge représentatif de la production n’a été effectué.

Pour arrêter les campagnes, désactiver leur flag et annuler les campagnes concernées. Un message déjà transmis au fournisseur peut encore arriver. Avant tout rollback de schéma, désactiver les nouveaux traitements et sauvegarder les nouvelles données. Le `down` retire les structures et colonnes ajoutées, donc perd les politiques/campagnes/télémétries de ce module ; il conserve les tables et données métier historiques. Ne jamais lancer ce rollback sur la production sans procédure approuvée.

L’index partiel ajouté à `notifications` est construit dans la migration transactionnelle : mesurer sa durée et les verrous sur une copie de taille représentative avant le déploiement. Les tests locaux ne prouvent pas une migration sans attente sur une grosse base.

## Limites explicites avant activation complète

- L’interface Admin est intégrée ; l’instrumentation mobile et la recette navigateur de bout en bout restent à valider séparément.
- Pas d’attestation native d’installation, de build ou de lecture humaine ; le throttling ne suffit pas contre un botnet distribué.
- Pas de transport APNs brut, attribution publicitaire, GA4/Crashlytics nouveau, collecte de pays ou identifiant matériel.
- Pas d’application automatique des restrictions aux endpoints métier existants, ni arrêt forcé d’un trajet.
- Pas de publication Store, déploiement AWS, provisioning de fédération, modification de secrets ou synchronisation réelle effectuée.
- La disponibilité Apple par territoire et certains diagnostics détaillés ne sont pas importés. Les dimensions réellement disponibles restent celles retournées par chaque source existante.

## Références officielles

- [Google Play Edits](https://developers.google.com/android-publisher/edits) : modèle transactionnel des pistes et effets des edits concurrents.
- [Google Auth Library Node.js](https://docs.cloud.google.com/nodejs/docs/reference/google-auth-library/latest) : ADC et fédération.
- [Versions App Store](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-appstoreversions) : relations builds et déploiement progressif.
- [Apple Sales Reports API](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports) et [définition du rapport Summary Sales](https://developer.apple.com/help/app-store-connect/reference/reporting/summary-sales-report/) : unités, dates et retours.
- [Comprendre la livraison FCM](https://firebase.google.com/docs/cloud-messaging/understand-delivery) : acceptation, livraison et limites d’observation.
