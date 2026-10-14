# Livraison des correctifs de fiabilité et de sécurité

Les sections initiales décrivent la livraison du 10 octobre. Le [complément du 14 octobre](#complément-du-14-octobre-2026--performance-et-résilience) décrit un nouveau lot **applicatif uniquement**, sans modification du CI/CD ni de Terraform.

Les correctifs conservent les routes existantes et les réponses en tableau utilisées par les anciens clients. Ils ajoutent deux migrations, la reprise durable des dépôts FlexPay et un déploiement ECS par digest. Aucun déploiement ni changement de données AWS n'a été effectué pendant leur préparation.

## Prérequis de livraison

1. Relire le plan Terraform **de production**, sans appliquer le staging par inadvertance. Appliquer les permissions OIDC `ecs:DescribeTaskDefinition` et `ecs:RegisterTaskDefinition`, ainsi que la configuration du circuit breaker ECS, **avant** le premier lancement du nouveau workflow. Ne pas appliquer aveuglément d'autres changements présents dans le plan.
2. Valider cette révision en staging avec ses propres paramètres et services de test. Tester notamment connexion/refresh, reset PIN, inscription avec plaque déjà utilisée, recharge et abonnement avec callback répété, avis et notifications.
3. Lancer le workflow depuis `release`. Il exécute les tests, construit l'image, copie la dernière configuration de la famille ECS et fixe l'image de l'API au digest construit. Les variables SSM, rôles, volumes, health checks et sidecars sont conservés.
4. La même nouvelle révision ECS exécute les migrations puis sert l'API. Les migrations `1780000067000` et `1780000068000` doivent avoir réussi **avant** le lancement du nouveau code, y compris hors CI. Les migrations précédentes ne sont ni supprimées ni renommées.
5. Après stabilisation, vérifier la santé HTTP et les scénarios métier avec des comptes de test. La vérification ECS refuse un faux succès lorsque le service s'est stabilisé en revenant à l'ancienne version.

Terraform continue à définir la configuration des tâches. Le service ignore désormais les changements de `task_definition` apportés par Terraform : **après une modification de configuration/SSM, relancer le workflow pour la déployer**. Cela empêche un `terraform apply` de rétablir accidentellement une ancienne image. Aucun mécanisme financier `prepare` / `activate` n'est réintroduit.

Le circuit breaker peut revenir au dernier déploiement sain, mais **n'annule pas les migrations SQL**. Les deux nouvelles migrations sont additives ; un retour applicatif à l'ancienne image laisse les nouveaux champs et travaux en place. Ne pas supprimer la file de reprise ni les avis pour revenir en arrière. Les nouvelles garanties de sessions, d'avis et de traitement ne s'appliquent plus si l'ancien code est remis en service.

## Corrections applicatives

| Constat de l'audit | Correctif ou limite |
| --- | --- |
| 01 Dépendances exposées | Multer 2.4.0, Engine.IO 6.6.11, proxy-addr 2.0.8, Axios 1.20.0, Handlebars 4.7.10, Joi 17.13.8 et js-yaml 4.3.2 sur les branches 4.x concernées. Les autres alertes transitives nécessitent encore un triage. |
| 02 Sessions HTTP | Contrôle de l'empreinte du JWT stocké ; compatibilité avec les anciennes valeurs brutes. Logout et reset PIN révoquent désormais aussi les requêtes HTTP. Un identifiant aléatoire empêche de recréer le même JWT dans la même seconde. |
| 03 Données privées dans les avis | Projection publique de l'auteur, tout en conservant la réponse historique en tableau et ses champs d'avis. |
| 04 Redis | Reconnexion avec attente progressive et aléatoire, sans file hors ligne. Démarrage borné à 10 secondes, déconnexion sans attente infinie, erreurs des sondes gérées. Les contrôles de sécurité ne sont pas contournés pendant une panne. |
| 05 Crons | Les quatre promesses détachées sont attendues par Nest ; leurs exécutions ne se chevauchent plus dans le même processus. |
| 06 FlexPay | File PostgreSQL, prise de travail avec `SKIP LOCKED`, bail et tentatives espacées. La finalisation métier doit réussir avant clôture. Un résultat tardif en attente ne remplace pas un succès confirmé. |
| 08 Validation | Assertion d'ordre des migrations corrigée. Les suites PostgreSQL/PostGIS jetables sont activées dans le CI de production, sans identifiants applicatifs. |
| 09 Livraison ECS | Révision par digest, même image pour migrations/API, circuit breaker et contrôle explicite du déploiement attendu. Activation IAM/Terraform préalable requise. |
| 10 Attentes SQL | Pool et délais explicites pour l'API, distincts des migrations. Les constructions d'index transactionnelles restent un point de vigilance sur une grosse base. |
| 11 Traitements volumineux | Destinataires de notifications parcourus par lots de 100 ; contrôle hebdomadaire et insertion atomiques, puis livraison par la file existante. Les anciens historiques non paginés et les contrôles financiers exhaustifs sont conservés pour ne pas changer leur contrat ou supprimer des protections. |
| 12 Inscription | Numéro, compte, parrainage et véhicule partagent la même transaction. Pour l'inscription téléphone, documents et jetons de connexion y participent aussi ; nettoyage des fichiers de cette tentative en cas d'échec de la transaction. |
| 13 Avis | Un trajet effectué entre conducteur et passager est requis. Sans `tripId`, résolution du dernier trajet commun non évalué. Verrou par paire et index unique pour les nouveaux avis vérifiés ; conservation des avis historiques. |

L'absence de numéro dans les auteurs des avis est volontaire. Les clients affichent le nom ou « Utilisateur ». Les nouveaux contrôles refusent les sessions révoquées et les avis sans trajet réel ; ces refus ne nécessitent pas de nouvelle route mobile.

## Exploitation des reprises FlexPay

La migration inscrit les dépôts FlexPay encore `pending` ou `initiated` dans `payment_reconciliation_jobs`. Un trigger inscrit aussi les nouveaux dépôts et les dépôts modifiés. Les retraits gardent leur propre rapprochement et sont exclus de cette file.

Chaque minute, une instance prend au plus cinq travaux, avec un bail de quinze minutes. Après une tentative non terminée, l'attente augmente jusqu'à six heures. Un arrêt du processus n'efface pas le travail : il devient reprenable après expiration du bail. Une commande manquante reste en attente ; le worker **ne relance jamais un débit** pour la remplacer.

Une modification du statut ou du numéro de commande rouvre le travail et incrémente sa révision. Une confirmation reçue pendant la finalisation ne peut donc pas être acquittée par un ancien worker. Un callback identique ne rouvre pas inutilement un travail terminé.

Le registre métier applique le résultat aux jetons, à la réservation ou à l'abonnement. Les abonnements déjà actifs ou expirés ne sont pas prolongés par rejeu. Un paiement réussi concernant un abonnement annulé est laissé en régularisation, sans remplacer l'abonnement actuel : vérifier le paiement et décider du remboursement ou du traitement avec le support.

Requête de suivi, en lecture seule, à exécuter avec un compte autorisé :

```sql
SELECT "paymentId", attempts, "createdAt", "nextAttemptAt", "leaseUntil", "lastError"
FROM payment_reconciliation_jobs
WHERE "completedAt" IS NULL
ORDER BY "createdAt"
LIMIT 100;
```

Les messages `Payment reconciliation pending` signalent les erreurs et l'ancienneté. Une alerte CloudWatch dédiée reste à configurer. Les paiements déjà terminés avant migration ne sont pas rejoués en masse ; examiner séparément les incidents historiques de finalisation.

## Variables et limites restantes

Aucune nouvelle variable n'est obligatoire pour les correctifs applicatifs :

| Variable facultative | Défaut | Portée |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | 10 | Connexions maximum par processus API |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 5000 | Acquisition/connexion PostgreSQL |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30000 | Durée d'une instruction API |
| `DATABASE_LOCK_TIMEOUT_MS` | 5000 | Attente d'un verrou API |
| `MIGRATION_DATABASE_POOL_MAX` | 2 | Pool du CLI de migrations |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Identité distincte pour le CLI, si elle est préparée |

Le budget `idle_in_transaction_session_timeout` de l'API est de 60 secondes. Les migrations gardent leurs propres délais locaux. Dimensionner le pool sur l'ensemble des tâches ECS, pas seulement sur une instance.

**Le constat 07 sur le compte maître RDS n'est pas résolu en production.** Prévoir un rôle applicatif limité et un rôle de migration, tester les triggers et les tâches de maintenance avec ces droits, puis retirer les identifiants maître de la tâche API. Ajouter seulement `MIGRATION_DATABASE_URL` à la même tâche ne réalise pas cette séparation.

**Le constat 14 sur la redondance AWS reste un arbitrage de budget.** Aucun passage automatique à deux tâches, à un réplica Valkey ou à RDS Multi-AZ n'est réalisé. Le staging occasionnel reste économique.

Les versions réellement distribuées sur les stores, Node 22/ARM64 dans l'image et le comportement du service AWS doivent encore être validés par le workflow/staging. Les tests locaux ne constituent pas une garantie d'absence de régression.

## Vérifications locales

- Suite générale Jest : **156 suites et 1 656 tests réussis** ; 10 suites et 205 tests SQL optionnels ignorés lors de cette exécution. Ils ne sont pas comptés comme réussis.
- Après le dernier garde-fou d'abonnement, nouvelle exécution ciblée : **4 suites, 25 tests réussis** (abonnements, reprise des paiements, inscription).
- Migrations 67/68 et file de reprise sur PostgreSQL 18 jetable : **6 tests réussis**, dont concurrence entre workers, bail expiré, rollback, callback tardif et unicité des nouveaux avis.
- Ensemble des suites PostgreSQL/PostGIS activées séparément : **11 suites et 205 tests réussis**. Trois scénarios de compatibilité avec le code réellement déployé restent ignorés, faute de référence `DEPLOYED_BACKEND_AUDIT_COMMIT`. Les six tests de migrations ci-dessus font partie de ces 205 tests ; ne pas additionner les exécutions ciblées à la suite générale pour en déduire un total unique.
- Vérification TypeScript sans émission, `terraform fmt -check`, `terraform validate`, contrôle documentaire et syntaxe YAML/Bash du workflow : réussis. Aucun `terraform apply` exécuté.
- `npm audit --omit=dev` : **29 alertes**, dont **0 critique, 13 élevées et 16 modérées**, contre 36 à l'audit initial. Les alertes transitives restantes ne sont ni ignorées ni considérées comme corrigées ; les rétrogradations majeures suggérées par `audit fix --force` n'ont pas été appliquées.

Ces contrôles locaux utilisent Node 24 et PostgreSQL 18 ; la validation Linux/Node 22/ARM64 et PostgreSQL 16 reste à exécuter dans le CI. Les services externes sont simulés : aucun paiement, OTP ou push réel n'a été émis.

## Références techniques

Les versions des dépendances corrigent notamment les dénis de service publiés par [Multer](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm) et [Engine.IO](https://github.com/socketio/socket.io/security/advisories/GHSA-2gc4-cqfq-p2gv). Le comportement de retour arrière et les droits ECS suivent la documentation [circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html) et [autorisations ECS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html).

## Complément du 14 octobre 2026 : performance et résilience

Ce lot corrige les risques applicatifs de l'audit suivant. Aucun déploiement, changement de paramètres AWS, modification de Terraform, du CI/CD ou de l'application mobile n'est effectué. Il n'ajoute **ni migration ni variable d'environnement obligatoire** ; les migrations déjà présentes dans la branche restent nécessaires au reste de la version.

### Correctifs

| Risque | Changement |
| --- | --- |
| Expiration et démarrage concurrents | `expire-pending-trip.ts` regroupe transition du trajet, expiration des réservations et restitution des places dans une transaction. Seule une transition depuis `pending`, sans démarrage, avec départ dépassé de deux heures, peut réussir. `startTrip` fait aussi une mise à jour conditionnelle et ne réécrit plus un ancien compteur de places. |
| Double restitution de places | Seul le traitement ayant effectivement expiré le trajet restitue les places des réservations **acceptées**, pas celles encore en attente. Le compteur ne dépasse pas `totalSeats`. Une erreur SQL annule l'ensemble. |
| Cron volumineux ou chevauchant | Le cron horaire est attendu avec `waitForCompletion`. Lecture des identifiants par lots de 100, pagination par identifiant sans `OFFSET`, puis traitement individuel ; il continue au-delà de 100 trajets dans la même exécution. Un échec isolé ne bloque pas les suivants. Les caches de trajet et de réservations concernées sont invalidés après commit. |
| Arrêt d'une réplique affectant les autres | Le signal `server_restart` et la déconnexion du tracking utilisent l'opérateur Socket.IO `local`. La destruction du gestionnaire de sessions nettoie ses minuteries sans envoyer de faux `session_expired` pendant le drainage. Les vérifications normales de révocation et d'expiration restent actives hors arrêt. |
| Prestataire de messagerie bloqué | Les POST de `MessagingService` ont un délai HTTP de 5 s et une borne RxJS de 5,5 s par tentative. Pas de nouvel essai de payload après timeout, erreur réseau, 401, 429 ou 5xx, car le message pourrait déjà être parti. Les variantes restent possibles après rejet explicite 400/415/422. Les services OTP distincts ne sont pas changés. |
| Cache de lecture indisponible | Les erreurs du cache optionnel ne transforment plus une écriture métier réussie en erreur HTTP. Lecture manquée puis chemin de chargement habituel, délai de 600 ms par commande, suivi local borné des invalidations échouées. Aucun vidage global de Redis et aucun contournement des contrôles d'authentification. |
| Occurrences récurrentes en double | Relecture des couples modèle/date sous le verrou existant du conducteur, avant insertion ; déduplication dans le lot également. Le curseur du modèle avance par mise à jour partielle monotone, sans réécrire son statut ou ses paramètres depuis une ancienne copie. |
| Régression de l'historique GPS | Comparaison et écriture atomiques Redis par script Lua. En cas de concurrence, reconstruction depuis le dernier état, au plus trois tentatives. Un point plus ancien ne remplace pas un point récent. |
| Accumulation des évaluations GPS | Une évaluation active et une seule évaluation supplémentaire en attente par trajet/processus. Les appels suivants partagent le résultat sans republier ses événements. L'autorisation d'une position conducteur lit le trajet sans charger tous ses passagers. |

Le guide `supabase-postgres-best-practices` a orienté les transactions courtes : verrouillage ordonné des réservations puis du trajet, cohérent avec les mises à jour existantes, et aucun appel HTTP, push ou Redis sous ces verrous. Les routes et formats des réponses mobiles ne changent pas. Le démarrage ayant perdu une course avec une autre transition renvoie une erreur demandant d'actualiser, sans nouvelle notification de démarrage.

### Validation de ce lot

- Compilation de production `npm run build` : réussie.
- Suite générale finale : **180 suites et 2 066 tests réussis** ; 14 suites et 243 tests optionnels ignorés. Les tests SQL ignorés ne sont pas assimilés à des tests réussis. Les exécutions ciblées déjà incluses dans ces 2 066 tests ne s'additionnent pas à ce total.
- PostgreSQL 18 isolé : 3 suites et 22 tests réussis, dont les 4 nouveaux scénarios de concurrence/rollback et les 18 tests existants de valeur des jetons et bonus de bienvenue. Les clusters sont temporaires, écoutent uniquement sur la boucle locale et sont nettoyés ; aucune configuration de base applicative n'est lue.
- La nouvelle suite SQL utilise les véritables helpers TypeORM mais des tables de test minimales : elle ne remplace pas une validation de l'ensemble des migrations et triggers de production.
- Le contrôle TypeScript global incluant tous les fichiers de tests signale encore des erreurs de typage dans des fixtures hors périmètre de ce lot. Il n'est pas déclaré réussi ; la compilation applicative et les suites Jest sont des contrôles distincts.

Rejouer les contrôles sous PowerShell (adapter le chemin aux binaires installés) :

```powershell
npm.cmd run build
npm.cmd test -- --runInBand --silent
$env:RESILIENCE_TEST_POSTGRES_BIN = 'C:/Program Files/PostgreSQL/18/bin'
$env:TOKEN_VALUE_TEST_POSTGRES_BIN = 'C:/Program Files/PostgreSQL/18/bin'
$env:WELCOME_BONUS_TEST_POSTGRES_BIN = 'C:/Program Files/PostgreSQL/18/bin'
npm.cmd test -- --runInBand --silent resilience-postgres.spec.ts token-value-postgres.spec.ts welcome-bonus-200-postgres.spec.ts
```

Ces trois variables servent **uniquement aux tests locaux**, pas à Parameter Store. Le CI existant n'a pas été modifié pour activer la nouvelle suite SQL. Aucun SMS, paiement ou push réel n'a été envoyé par ces tests.

### Limites et contrôles après livraison

- **Haute disponibilité AWS inchangée** : ajouter une seconde tâche ECS, la redondance Redis/RDS ou corriger les alarmes CloudWatch demande un lot d'infrastructure distinct et un arbitrage de coût.
- Pendant un déploiement progressif, les anciens processus n'appliquent pas ces nouvelles protections. Attendre leur remplacement complet avant de conclure à la protection entre tous les workers. Les doublons récurrents historiques ne sont pas supprimés.
- Le suivi des invalidations échouées est local au processus. Une autre réplique peut conserver une projection jusqu'à expiration de son TTL. Au-delà de 1 000 clés en échec, le cache de lecture du processus est désactivé jusqu'au redémarrage ; la charge peut alors se reporter sur PostgreSQL ou les services amont. Aucune garantie de cohérence distribuée forte n'est ajoutée.
- La limitation des évaluations GPS est par processus ; elle n'est pas un verrou distribué. En cas de forte contention Redis, un échantillon peut être abandonné après trois tentatives, sans écraser le plus récent. Le script Redis et les reconnexions de vrais appareils doivent encore être éprouvés en environnement représentatif.
- Les notifications d'expiration restent envoyées après le commit : un arrêt entre commit et notification peut empêcher leur émission. Ce lot ne transforme pas tous ces envois en file transactionnelle durable.
- Vérifier après livraison : démarrage/expiration, réservation acceptée et compteur de places, publication récurrente, reconnexion du tracking pendant un redéploiement, latences HTTP/GPS et taux d'erreur Redis/messagerie. Les tests locaux ne garantissent pas l'absence de régression ni un gain de latence chiffré en production.

## Complément du 14 octobre 2026 — dernier audit, correctifs locaux

### Code et compatibilité

- Les rappels de départ n'enregistrent plus une ancienne entité `Trip` complète.
  La modification ciblée du drapeau et l'insertion dans l'outbox existante sont
  atomiques. Une clé par type de rappel, trajet, date de départ et destinataire
  déduplique les workers ; le rappel d'expiration proche n'est plus répété à
  chaque passage de cron pour une même date. Les envois ont lieu après commit.
- Ces deux crons lisent par lots de 100. Une erreur isolée n'arrête pas le lot.
  Avant livraison, un rappel est supprimé si le trajet a commencé, a été annulé,
  a été reprogrammé, ou si la réservation concernée n'est plus acceptée.
- La création d'une réservation et l'expiration partagent un verrou consultatif
  transactionnel par trajet, acquis avant les verrous de lignes. La création
  relit/verrouille le trajet et revérifie statut, places, tarif, mode de paiement
  et réservation existante juste avant l'insertion. Le géocodage reste hors
  transaction ; aucune réservation n'est insérée après une expiration gagnante.
- Le repli de la réduction première course utilise un savepoint en transaction :
  une violation d'unicité ne laisse plus le retry dans une transaction PostgreSQL
  déjà annulée. La création d'une demande en attente ne réécrit plus le compteur
  de places après commit ; elle ne consomme pas de place.
- Le cron de détection d'un téléphone éteint attend la fin du travail, traite par
  lots et déduplique sous verrou par utilisateur/trajet/réservation. L'alerte et
  sa notification sont enregistrées ensemble. Cela n'ajoute **pas** de SMS ou
  d'appel aux contacts : cette partie était et reste un TODO dans le flux existant.
- `POST /app-updates/client` reste authentifié. Quand les annonces sont
  désactivées, il renvoie une réponse 2xx `{ registered: false, enabled: false }`
  sans consulter la base. Les routes administratives restent protégées/désactivées.
- Les commandes du client Redis métier sont bornées par
  `REDIS_COMMAND_TIMEOUT_MS` (défaut 2000 ms, de 100 à 10000 ms). Une échéance
  force la récupération de la connexion et rejette la file bloquée ; aucun retry
  automatique d'écriture ambiguë ni contournement de l'authentification.
  La file du client est plafonnée à 1000 commandes. Le cache optionnel conserve
  son délai plus court et son comportement de repli déjà en place.
- Un échec temporaire DB/Redis ferme les WebSockets avec le signal existant
  `server_restart` (`reason=dependency_unavailable`, `retryAfterSeconds=5`), pas
  `session_expired`. Les sessions réellement révoquées/expirées restent refusées.
- La récupération des clés Apple est mutualisée entre appels concurrents,
  bornée à cinq secondes y compris le corps HTTP, annulée à l'échéance et renvoie
  503 en cas d'indisponibilité. Les contrôles cryptographiques ne changent pas.

Le guide `supabase-postgres-best-practices` a orienté les transactions courtes,
l'ordre des verrous et l'absence d'appels externes sous verrou. Aucune nouvelle
migration n'est nécessaire pour ce complément ; l'outbox et sa contrainte
`eventKey` doivent déjà être présentes via les migrations existantes.

### Ordre de livraison ultérieure

1. Livrer le backend avec le CI/CD existant, attendre la fin du remplacement des
   anciennes tâches, puis tester les parcours métier. Les anciens workers ne
   participent pas aux nouveaux verrous : la période mixte n'offre pas toutes
   ces garanties.
2. Lire le plan Terraform séparément. Le backend vérifie DB, Redis et contrat du
   schéma après `app.init()` et **avant d'écouter**. Ensuite seulement, passer la
   sonde ALB à `/health/live`, tout en conservant `/health` pour les diagnostics.
   Un incident partagé DB/Redis peut encore rendre les opérations indisponibles,
   mais ne doit plus provoquer le remplacement de tous les processus sains.
3. Appliquer séparément les corrections d'alarmes et vérifier qu'elles reçoivent
   bien des métriques. L'alarme mémoire peut légitimement passer en ALARM sur le
   petit RDS actuel ; elle ne déclenche aucun redimensionnement automatique.
4. Avant deux tâches ECS, prévoir le budget de connexions pour les tâches
   supplémentaires d'un déploiement : avec un pool de 10, deux tâches permettent
   20 connexions API, et quatre tâches temporairement 40, hors autres clients.
   Un pool de 5 par tâche ramène ces plafonds à 10/20 ; le valider sous charge avant
   de le choisir. Le défaut et les paramètres AWS existants sont conservés ici.
5. La redondance ECS/Valkey/RDS et une éventuelle augmentation de mémoire RDS
   restent des opérations d'infrastructure à réaliser explicitement. Aucun
   changement de capacité, de CI/CD, d'`ecs.tf` ou d'`oidc.tf` dans ce complément.

`RESILIENCE_TEST_POSTGRES_BIN` reste une variable de test local uniquement. Les
tests utilisent un cluster temporaire sur loopback, arrêté et nettoyé ensuite.
Ne pas utiliser une URL de production pour les tests. Les délais et contrôles
ajoutés ne remplacent pas un test de bascule ou de charge représentatif. L'outbox
déduplique les événements à la création ; elle ne promet pas un envoi push
exactement une fois si le fournisseur accepte un envoi puis que son accusé est perdu.

### Vérifications de ce complément

- Suite générale : 182 suites / 2 075 tests réussis ; 14 suites / 250 tests
  optionnels ignorés lors de ce passage (dont la suite PostgreSQL isolée).
- Six tests supplémentaires de livraison des rappels, ajoutés après le lancement
  global, passent. Le rejeu ciblé réservations + santé + rappels passe également
  (75 tests). Ne pas additionner ces 75 aux tests globaux : ils se recouvrent.
- PostgreSQL 18 isolé : 12 tests réussis, dont la création concurrente face à
  l'expiration, la déduplication des rappels/alertes, le rollback de l'outbox et le
  savepoint après conflit de réduction première course. Le premier lancement
  dans le bac à sable n'autorisait pas le démarrage du cluster ; le rejeu avec
  autorisation locale réussit. Le cluster de test est arrêté et nettoyé.
- `npm run build`, TypeScript applicatif sans émission, `git diff --check`,
  `terraform fmt` et `terraform validate` passent. Pas de test de charge ni de
  bascule réelle AWS, et aucun envoi réel OTP/push/paiement dans ces tests.
