# Audit du backend Zwanga

## État après correctifs

Une série de correctifs est maintenant préparée dans le dépôt. Le [guide de livraison](docs/operations/audit-hardening-2026-10-10.md) précise leur portée, les migrations, le prérequis IAM du nouveau workflow et les points encore ouverts. Les constats ci-dessous décrivent la version auditée initialement ; ils ne signifient pas que ces défauts sont tous encore présents dans le code corrigé. Aucun correctif n'est considéré comme déployé sur AWS.

## Synthèse

Audit du 10 octobre 2026 sur le code local, base Git `f6b91fc`, incluant les modifications non commitées présentes au début de la revue. Le périmètre principal est le backend NestJS, ses dépendances, la configuration Terraform de production et son CI/CD. L'état réellement déployé dans AWS et l'application mobile ne sont pas certifiés par cette revue.

Les risques prioritaires concernent des dépendances exposées aux requêtes publiques, la révocation des sessions HTTP, les données privées renvoyées par l'ancienne route des avis, la reprise après une coupure Redis et les erreurs asynchrones des tâches planifiées. Un test en échec bloque également le pipeline actuel. Des garde-fous financiers existent déjà : il faut les compléter, pas les supprimer.

Aucun code applicatif, paramètre AWS, compte utilisateur ou paiement réel n'a été modifié. Ce rapport est le seul fichier ajouté par l'audit.

### Vérifications réalisées

- Vérification TypeScript : `tsc --noEmit --incremental false -p tsconfig.build.json` réussie.
- Jest : **146 suites réussies, 1 en échec, 9 ignorées ; 1 617 tests réussis, 1 en échec, 200 ignorés**.
- `npm audit --omit=dev --json` : **36 alertes de dépendances**, dont 2 critiques, 18 élevées et 16 modérées. Ce nombre comprend des chaînes transitives ; ce ne sont pas 36 failles dont l'exploitation dans l'application aurait été démontrée.
- Reproductions locales sans connexion à la base applicative : acceptation d'une identité dont les jetons stockés sont annulés ; projection SQL des données privées des auteurs d'avis ; erreur de cron échappant à sa promesse ; callback FlexPay acquitté après un échec de vérification ; avis répétés sans trajet ; compte déjà enregistré lorsque la création du véhicule échoue.
- Les tests locaux ont utilisé Node 24.11.0 ; Docker et le CI/CD ciblent Node 22. Aucun test de charge, attaque réseau ou test de paiement n'a été exécuté contre la production. Les tests PostgreSQL optionnels n'ont pas été activés.

Les recommandations sont classées P1, à traiter en priorité, et P2, à planifier ensuite. La gravité décrit l'impact du constat, pas une preuve qu'un incident s'est déjà produit en production.

## Priorité P1

### 01 Dépendances exposées permettant un arrêt du serveur

**Gravité élevée — sécurité et disponibilité — règle EXPRESS-DEPS-001.**

Preuves : [package-lock.json](package-lock.json#L4565) verrouille le Multer utilisé par Nest à **2.2.0** ; [package-lock.json](package-lock.json#L10446) verrouille Engine.IO à **6.6.9**. L'inscription publique utilise `FileFieldsInterceptor` dans [auth.controller.ts](src/auth/auth.controller.ts#L75). [configured-io.adapter.ts](src/common/configured-io.adapter.ts#L17) n'interdit pas les changements de transport Socket.IO.

L'avis officiel Multer décrit un arrêt du processus par des champs multipart malformés pour les versions antérieures à 2.3.0. Les limites de taille et le réencodage des images ne corrigent pas ce défaut du parseur. L'avis Engine.IO décrit un arrêt possible lors d'un changement de transport avec une version de protocole incohérente ; la correction est en 6.6.10. Sources : [avis Multer](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm), [avis Socket.IO](https://github.com/socketio/socket.io/security/advisories/GHSA-2gc4-cqfq-p2gv).

**À faire :** mettre à jour les dépendances directes et transitives concernées vers des versions corrigées compatibles, vérifier la version de Multer effectivement résolue par Nest, puis tester uploads et connexions Socket.IO des anciens clients. Ne pas lancer `npm audit fix --force` sans analyse. Aucune exploitation réseau de ces défauts n'a été tentée pendant l'audit.

Les deux alertes npm classées critiques concernent notamment Handlebars et proxy-addr. Leurs conditions d'exploitation dans ce projet ne sont pas démontrées ici ; elles ne doivent pas être présentées comme deux compromissions possibles déjà confirmées.

### 02 Révocation des jetons incomplète sur HTTP

**Gravité élevée — sécurité des sessions.**

Preuves : [jwt.strategy.ts](src/auth/strategies/jwt.strategy.ts#L30) vérifie l'existence et l'état du compte, mais pas la validité de la session enregistrée. [users.service.ts](src/users/users.service.ts#L183) ne charge pas l'empreinte du jeton. La réinitialisation du PIN annule pourtant les jetons dans [auth.service.ts](src/auth/auth.service.ts#L515), comme la déconnexion à la ligne 858. Le JWT d'accès a une durée par défaut de **1 jour** à la ligne 1596.

**Impact :** un ancien JWT d'accès encore signé et non expiré reste utilisable sur HTTP après déconnexion ou réinitialisation du PIN, tant que le compte demeure actif. Un détenteur illégitime de ce jeton n'est donc pas immédiatement expulsé. Le contrôle de l'état actif/suspendu fonctionne ; ce constat porte sur la session, pas sur un contournement de la suspension.

La vérification locale de `JwtStrategy.validate` accepte une identité active dont les deux jetons stockés sont `null`. Les WebSockets, eux, comparent l'empreinte dans [ws-session.service.ts](src/common/services/ws-session.service.ts#L30).

**À faire :** unifier HTTP et WebSocket autour d'une révocation serveur, par empreinte de session ou version de session. Tester déconnexion, changement/réinitialisation du PIN et rotation du refresh token. Si plusieurs appareils doivent rester connectés, prévoir des sessions par appareil plutôt qu'un unique champ écrasé à chaque connexion.

### 03 Données privées exposées par les anciens avis

**Gravité élevée — confidentialité — règle EXPRESS-INPUT-001, minimisation des réponses.**

Preuves : `GET /ratings/user/:userId`, [ratings.controller.ts](src/ratings/ratings.controller.ts#L22), renvoie directement [RatingsService.findByUser](src/ratings/ratings.service.ts#L64). La requête charge `relations: ['rater']` sans projection publique. Dans [user.entity.ts](src/users/entities/user.entity.ts#L52), plusieurs colonnes privées restent sélectionnables par défaut.

La génération locale de la requête TypeORM confirme la sélection des champs `phone`, `email`, `fcmToken`, `googleId` et `appleId` de l'auteur. Les mots de passe et empreintes JWT ont déjà `select: false` : ils ne font pas partie de cette fuite.

**Impact :** un utilisateur connecté peut obtenir des informations privées d'auteurs d'avis sans avoir partagé un trajet avec eux. La nouvelle route paginée possède une projection sûre, mais elle ne protège pas l'ancienne URL encore accessible.

**À faire :** appliquer un DTO public explicite aux deux routes, en conservant les champs nécessaires aux anciens clients. Ajouter un test de réponse de l'ancienne route interdisant ces champs, pas uniquement un test du nouvel endpoint `/page`.

### 04 Une coupure Redis exige une recréation du client

**Gravité élevée — disponibilité — règle EXPRESS-DOS-001.**

Preuves : [redis-options.ts](src/common/utils/redis-options.ts#L39) combine `disableOfflineQueue: true` et `reconnectStrategy: false`. Ces options servent au cache, à RedisService et à l'adaptateur Socket.IO. [redis-throttler.storage.ts](src/common/services/redis-throttler.storage.ts#L16) renvoie 503 si Redis échoue ; ce contrôle est global dans [app.module.ts](src/app.module.ts#L132).

**Impact :** après une rupture de connexion, le client ne reprend pas tout seul lorsque Redis revient. L'API peut continuer à répondre 503 jusqu'au remplacement de la tâche par ECS ; une coupure limitée au client pub/sub peut dégrader les événements inter-instances sans être détectée par le contrôle de santé du client Redis principal. Redis confirme que la valeur `false` désactive les reconnexions dans sa [documentation](https://redis.io/docs/latest/develop/clients/nodejs/connect/).

**À faire :** reconnexion avec délai progressif et aléatoire, délais de commande bornés, surveillance du pub/sub et distinction entre disponibilité du processus et capacité à servir les requêtes. Conserver le refus sécurisé des opérations sensibles ; ne pas désactiver silencieusement l'OTP ou les limites de tentatives en cas de panne.

### 05 Des erreurs de tâches planifiées peuvent arrêter le processus

**Gravité élevée — disponibilité et fiabilité.**

Preuves : [trip-availability-notification.service.ts](src/notifications/trip-availability-notification.service.ts#L38) lance `setImmediate(async () => ...)` puis retourne. Les lectures SQL de ce callback ne sont pas couvertes par la promesse observée par le planificateur. Le même motif existe dans [trips.service.ts](src/trips/trips.service.ts#L3947), à la ligne 4099, et dans [trip-requests.service.ts](src/trip-requests/trip-requests.service.ts#L2903).

**Impact :** une erreur PostgreSQL dans ces lectures devient une promesse rejetée non gérée. Un processus enfant local exécutant le vrai service avec une lecture DB simulée en échec a retourné du cron avant le travail, puis s'est arrêté avec le code 1. La configuration Winston comporte aussi des gestionnaires de rejets sans désactivation de son comportement de sortie dans [logger.module.ts](src/common/logger/logger.module.ts#L63).

**À faire :** attendre le travail dans la méthode planifiée, gérer les erreurs par lot et empêcher les chevauchements. `setImmediate` ne constitue pas une file de travaux ni une garantie de priorité aux requêtes HTTP. Ne pas masquer globalement toutes les exceptions pour garder artificiellement le serveur en vie.

### 06 Une confirmation FlexPay peut rester sans reprise automatique

**Gravité élevée — fiabilité financière.**

Preuves : [payments.service.ts](src/payments/payments.service.ts#L469) intercepte l'échec du contrôle FlexPay, sauvegarde un état en attente, puis retourne normalement à la ligne 483. Les contrôleurs de callback renvoient alors une réponse HTTP réussie. Aucun rapprochement périodique général des dépôts FlexPay en attente n'est visible dans PaymentsService ; les crons de retraits et de règlements en jetons ont d'autres périmètres.

Une simulation locale confirme qu'un timeout de `checkTransaction` produit un retour normal avec `status = initiated`. Les endpoints métier de statut peuvent reprendre le contrôle ultérieurement, mais cela dépend du retour de l'utilisateur ou d'une nouvelle notification du prestataire.

**Impact :** le paiement peut avoir réussi chez le prestataire alors que la recharge ou l'abonnement reste en attente si l'utilisateur ferme l'application et qu'aucun nouveau callback n'arrive. Ce constat ne démontre ni crédit frauduleux ni double débit : le refus de créditer sans preuve est une protection à conserver.

**À faire :** avant d'acquitter, enregistrer durablement un travail de vérification avec tentatives, prochaine échéance et alerte d'ancienneté, ou renvoyer une erreur temporaire conforme au contrat de retry du prestataire. Appliquer ensuite la finalisation métier de manière idempotente pour tous les points d'entrée, y compris le callback générique.

### 07 Le compte applicatif PostgreSQL est le compte maître RDS

**Gravité élevée — limitation des conséquences d'une compromission — règle security-privileges.**

Preuves : [database.tf](infra-aws/database.tf#L23) crée l'utilisateur maître avec `var.database_username`. [ssm.tf](infra-aws/ssm.tf#L16) construit le `DATABASE_URL` injecté dans l'API avec ce même utilisateur et mot de passe. Il ne s'agit donc pas seulement d'un nom contenant « admin » : les deux usages partagent réellement l'identité créée par RDS.

**Impact :** une compromission applicative ou une requête destructive dispose de droits plus larges que ceux nécessaires aux opérations métier. Cela ne prouve pas qu'une injection SQL existe. AWS recommande explicitement de ne pas utiliser le compte maître dans l'application : [privilèges RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.MasterAccounts.html).

**À faire :** séparer le rôle des migrations du rôle d'exécution, limiter celui-ci aux tables, séquences et fonctions nécessaires, puis vérifier les triggers financiers et les traitements de maintenance avec ce rôle réduit. Le staging préparé dispose déjà d'une séparation de rôles ; elle n'est pas présente dans cette configuration de production.

### 08 Le pipeline actuel est bloqué et ses tests SQL restent optionnels

**Gravité moyenne — blocage de livraison immédiat.**

Preuves : [welcome-bonus-repair-migration.spec.ts](src/database/welcome-bonus-repair-migration.spec.ts#L39) exige que `databaseMigrations.slice(-2)` soit constitué des migrations 63 et 64. Les migrations 65 et 66 figurent désormais à la fin de [migrations/index.ts](src/database/migrations/index.ts#L137). Le test échoue effectivement. Le workflow [deploy.yml](.github/workflows/deploy.yml#L55) exécute ce même ensemble de tests avant le build et le déploiement.

**À faire immédiatement :** tester la présence et l'ordre relatif des migrations correctives, sans imposer qu'aucune nouvelle migration ne puisse les suivre. Ne pas supprimer les nouveaux index pour satisfaire le test.

Par ailleurs, les suites PostgreSQL utilisent des variables d'activation, par exemple [driver-finance-postgres.spec.ts](src/database/driver-finance-postgres.spec.ts#L23) et [transactional-notifications-postgres.spec.ts](src/database/transactional-notifications-postgres.spec.ts#L31), non configurées dans le workflow de production examiné. Les 200 tests ignorés ne sont pas des validations réussies. Ajouter un job PostgreSQL/PostGIS jetable pour les migrations, triggers, verrous et notifications, sans accès aux données de production.

## Priorité P2

### 09 Déploiement et retour arrière insuffisamment déterministes

**Gravité moyenne — fiabilité opérationnelle.**

Preuves : [deploy.yml](.github/workflows/deploy.yml#L103) pousse `latest` avant les migrations ; celles-ci utilisent la définition de tâche existante à la ligne 136, puis le déploiement est forcé à la ligne 219. [ecs.tf](infra-aws/ecs.tf#L35) utilise un tag, `latest` par défaut dans [variables.tf](infra-aws/variables.tf#L199). Le service ne déclare pas de `deployment_circuit_breaker`.

**Impact :** une ancienne définition de tâche portant toujours `latest` ne suffit pas, à elle seule, à sélectionner l'ancienne image lors d'un nouveau déploiement forcé ou d'un lancement autonome. Le workflow ne lie pas explicitement les migrations et le déploiement au digest qu'il vient de construire. Un échec après migration ne rétablit pas automatiquement le schéma antérieur ; attendre `services-stable` ne vérifie pas une opération métier.

Nuance importante : ECS résout normalement le tag en digest pour maintenir la cohérence à l'intérieur d'un déploiement. Un simple remplacement de tâche ne doit donc pas être assimilé à une récupération systématique du nouveau `latest`. Le risque concerne surtout les nouveaux déploiements, lancements autonomes et procédures de retour arrière : [résolution des images ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html).

**À faire :** référencer le SHA ou digest exact dans une nouvelle révision de tâche, utiliser cette même image pour les migrations, prévoir un retour arrière applicatif et des migrations rétrocompatibles, puis un smoke test sans mutation sensible. Le [circuit breaker ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html) peut automatiser le retour à un déploiement sain ; il n'annule pas les migrations SQL.

### 10 Attentes PostgreSQL non bornées et index bloquants

**Gravité moyenne — disponibilité sous contention — règles conn-limits et lock-short-transactions.**

Preuves : [typeorm-options.ts](src/database/typeorm-options.ts#L109) ne configure ni délai d'acquisition de connexion, ni `statement_timeout`, ni `lock_timeout` global. `extra` ne contient que SSL. Le pool pg possède bien une limite, 10 connexions par défaut : ce n'est pas une absence de pool. En revanche, sans réglage de rôle ou serveur externe, l'attente d'acquisition et les requêtes n'ont pas de borne adaptée à l'API. Voir la [documentation du pool pg](https://node-postgres.com/apis/pool).

Les nouveaux [index des avis](src/database/migrations/1780000065000-IndexRatingPages.ts#L10) et [index des notifications](src/database/migrations/1780000066000-IndexNearbyRequestAlerts.ts#L11) utilisent `CREATE INDEX` dans une transaction. Les délais de 5 et 30 secondes sont utiles, mais ne rendent pas la construction non bloquante : les écritures peuvent attendre le verrou pendant cette période. Comportement décrit par [PostgreSQL](https://www.postgresql.org/docs/current/sql-createindex.html).

**À faire :** budgets distincts pour API et migrations, taille du pool compatible avec le nombre maximal de tâches et la capacité RDS, délais de verrous/requêtes, métriques d'attente. Pour les grandes tables, étudier des migrations d'index concurrentes hors transaction, avec gestion des index invalides. Aucun volume ou temps de blocage réel n'a été mesuré ici.

### 11 Des parcours restent proportionnels à tout l'historique

**Gravité moyenne — performance et passage à plusieurs instances.**

Preuves : [payments.service.ts](src/payments/payments.service.ts#L592) charge toutes les transactions d'un utilisateur pour les anciennes routes. [ratings.service.ts](src/ratings/ratings.service.ts#L64) charge tous ses avis et leurs auteurs. Les nouvelles routes paginées ne remplacent pas ces appels anciens.

[daily-engagement-notification.service.ts](src/notifications/daily-engagement-notification.service.ts#L23) et [trip-availability-notification.service.ts](src/notifications/trip-availability-notification.service.ts#L41) chargent tous les utilisateurs actifs. Les recommandations effectuent ensuite des lectures par utilisateur. [bookings.service.ts](src/bookings/bookings.service.ts#L347) vérifie périodiquement des invariants sur l'ensemble de l'historique et des comptes. Ces invariants sont utiles, mais leur coût croît avec les données.

La limitation hebdomadaire des notifications automatiques effectue une lecture puis un envoi séparés dans [notifications.service.ts](src/notifications/notifications.service.ts#L241). Deux processus peuvent tous deux passer la lecture avant qu'une notification ne soit enregistrée. Les verrous et clés d'événement des notifications transactionnelles ne s'appliquent pas automatiquement à ce chemin.

**À faire :** lots paginés, curseur de progression, colonnes minimales, unicité d'événement pour les notifications automatiques et coordination inter-instances. Déplacer les contrôles exhaustifs coûteux vers un traitement dédié ou moins fréquent, tout en conservant les vérifications financières ciblées. Faire évoluer les anciennes routes sans changer brutalement leur contrat pour les applications déjà publiées.

### 12 Une inscription peut échouer après création du compte

**Gravité moyenne — fiabilité et expérience utilisateur.**

Preuves : [auth.service.ts](src/auth/auth.service.ts#L261) valide la transaction de création du compte, puis enregistre le parrainage, le véhicule et les documents avant de générer les jetons. [registration-phone.policy.ts](src/users/registration-phone.policy.ts#L26) ne couvre que la réservation/libération du numéro et la sauvegarde du compte.

**Impact :** si la création du véhicule échoue, par exemple sur une plaque déjà utilisée, l'inscription renvoie une erreur sans jetons alors que le numéro appartient déjà au nouveau compte. La tentative suivante peut annoncer « numéro déjà utilisé ». Ce scénario a été reproduit avec des dépôts simulés : la transaction compte est déjà validée au moment de l'erreur véhicule. La connexion au compte peut rester possible ; les données ne sont pas nécessairement perdues.

**À faire :** regrouper les écritures métier devant réussir ensemble dans une transaction ou rendre l'inscription reprise/idempotente. Prévalider les contraintes connues et prévoir le nettoyage des fichiers envoyés avant une opération avortée. Ne pas inclure des appels réseau longs dans la transaction SQL.

### 13 Les avis ne prouvent pas la participation à un trajet

**Gravité moyenne — sécurité métier et intégrité de la réputation.**

Preuves : [ratings.service.ts](src/ratings/ratings.service.ts#L20) vérifie l'auto-évaluation et l'existence de la cible, mais pas une réservation partagée ni un trajet terminé. Le contrôle de doublon ne s'exécute que si `tripId` est fourni à la ligne 38. Ce champ est facultatif dans [rating.dto.ts](src/ratings/dto/rating.dto.ts#L11), et [rating.entity.ts](src/ratings/entities/rating.entity.ts#L17) ne déclare pas d'unicité métier correspondante.

**Impact :** un compte connecté peut influencer la réputation d'un autre utilisateur sans trajet réel, et recommencer sans `tripId`. Deux appels locaux simulés ont été acceptés. Le throttle limite le débit, pas cette autorisation.

**À faire :** rattacher la note à une interaction admissible, vérifier les participants et l'état du trajet, puis imposer l'unicité en base pour résister à deux requêtes concurrentes. Définir explicitement le traitement des avis historiques sans trajet.

### 14 La configuration économique de production comporte des points uniques de panne

**Gravité moyenne — disponibilité d'infrastructure, à confirmer sur les valeurs déployées.**

Preuves : les valeurs par défaut de [variables.tf](infra-aws/variables.tf#L124), [variables.tf](infra-aws/variables.tf#L182) et [variables.tf](infra-aws/variables.tf#L239) prévoient respectivement RDS sans Multi-AZ, un seul nœud Valkey et une tâche ECS. Dans [redis.tf](infra-aws/redis.tf#L23), le basculement automatique n'est activé qu'au-delà d'un nœud. L'autoscaling est désactivé par défaut.

**Impact :** si ces valeurs sont celles appliquées, maintenance, panne d'instance ou remplacement du seul processus peuvent interrompre le service. Les sauvegardes protègent la récupération des données, pas la continuité immédiate.

**À faire :** choisir explicitement le niveau de disponibilité acceptable. Corriger d'abord les défauts logiciels ci-dessus ; augmenter ensuite, selon le budget, le nombre de tâches ECS, ajouter un réplica Valkey et envisager RDS Multi-AZ. Le staging occasionnel peut rester mono-instance : lui imposer la même haute disponibilité augmenterait inutilement ses coûts.

## Protections à conserver

- Authentification globale, rôles administrateur et validation DTO avec rejet des propriétés inattendues.
- Colonnes de mot de passe et de jetons exclues des sélections ordinaires ; empreintes plutôt que jetons bruts stockés.
- Reset PIN transactionnel avec protection contre la réutilisation et délais locaux de verrou.
- Vérifications serveur des paiements, réservations de retraits, clés d'idempotence, ledger et rapprochement des retraits.
- Notifications critiques enregistrées durablement, prise de travail avec `SKIP LOCKED`, limites de concurrence et nouvelles tentatives.
- Autorisation des salons WebSocket, revalidation des sessions et limites d'événements.
- Validation et réencodage des images ; contrôles d'hôtes, d'adresses réseau et de taille pour la récupération des preuves KYC.
- Synchronisation TypeORM désactivée en production, conteneur non-root, TLS PostgreSQL/Redis et bases non publiques dans Terraform.

## Ordre de correction proposé

1. Débloquer le test de migrations sans retirer les nouvelles fonctionnalités ; corriger les dépendances exposées, les sessions HTTP et la réponse historique des avis.
2. Corriger la reprise Redis et les tâches planifiées, puis ajouter des tests simulant une panne et un retour des dépendances.
3. Fiabiliser la reprise des confirmations FlexPay et l'atomicité de l'inscription ; exécuter les tests SQL sur PostgreSQL/PostGIS jetable.
4. Séparer les droits DB, rendre le déploiement déterministe, borner les attentes SQL et les traitements volumineux.
5. Tester les contrats des clients mobiles déjà publiés en staging, puis arbitrer la redondance AWS selon le budget et les objectifs de disponibilité.

Les skills `security-best-practices` et `supabase-postgres-best-practices` ont cadré la revue des surfaces exposées, des droits et des transactions ; `pages:write-page` a servi à structurer ce rapport dans le dépôt. Leur utilisation ne constitue pas une certification de sécurité ni un audit d'intrusion exhaustif.
