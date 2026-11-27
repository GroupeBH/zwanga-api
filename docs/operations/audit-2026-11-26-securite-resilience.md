# Audit sécurité et résilience — 26 novembre 2026

## Synthèse

Audit en lecture seule du backend sur la branche `LAB-8-Mettre-en-place-le-parrainage-dans-la-plateforme`, base `0cf90ef`, **y compris les ~100 fichiers modifiés et non commités** présents au moment de la revue. Périmètre : code NestJS, Terraform `infra-aws`, workflows GitHub, image Docker et historique Git. L'état réellement appliqué dans AWS n'est pas vérifié. Aucun fichier applicatif, aucune ressource AWS et aucun paiement n'ont été modifiés.

Les audits précédents ont produit de vrais progrès. Les correctifs suivants sont en place :

- révocation des sessions sur HTTP ;
- dépendances sans alerte ;
- déploiement par digest avec retour arrière automatique (circuit breaker) ;
- files SQL durables.

Quatre sujets dominent désormais :

1. **Secrets de production toujours exposés dans l'historique Git.** Le constat P0 du 6 novembre n'est pas clos.
2. **Chaîne CI/CD.** Une dépendance npm compromise peut obtenir le rôle AWS de déploiement, et un ancien workflow Cloud Run déploie encore à chaque push sur `master`.
3. **Fraude financière par la logique métier.** Ces défauts, mis en évidence au second passage, ne relèvent pas d'une faille technique :
   - subvention du premier trajet sans plafond, calculée sur un prix libre ;
   - rejeu d'un callback FlexPay déjà payé ;
   - conversion de jetons gratuits en gains retirables ;
   - aucune reprise des gains après un remboursement.
4. **Exposition des données et sécurité des personnes :**
   - les routes de réservation renvoient les entités brutes : position en direct, email et jeton push du conducteur ;
   - les alertes SOS n'atteignent personne ;
   - autres défauts du code : débit de jetons sur la seule déclaration du conducteur, force brute du PIN, changement de numéro sans preuve, annulation en pleine course, sessions WebSocket fantômes.

L'audit a été mené en deux passages. Le second a couvert les zones restées en surface au premier : paiements et parrainage, inventaire des routes, modules B2B, sérialisation et données.

Gravité : critique / élevée / moyenne / faible. **Vérifié** signifie que le chemin de code a été relu de bout en bout et, si indiqué, reproduit localement. **À confirmer** signifie que le résultat dépend de l'état AWS ou du trafic réel.

### Vérifications exécutées

| Contrôle | Résultat |
| --- | --- |
| `tsc --noEmit -p tsconfig.build.json` (avec le travail non commité) | Réussi |
| `npm audit` dépendances de production, puis dev incluses | **0 alerte** (29 au 10 octobre) |
| Recherche de motifs de secrets dans l'historique Git (414 commits) | Uniquement des exemples ou fixtures, sauf `infra-aws/tfplan` (S1) |
| Suites jest ciblées : sessions JWT, rotation, throttler, adapter Redis, budget SQL, échéance Redis, ws-session, fresh-read-batch | 65 tests réussis |
| Reproduction locale de la fuite de sessions WebSocket (R1) | Reproduite : 6 sessions conservées, puis connexions refusées |
| Sonde locale du `LoginDto` réel (A1) | Corps non-chaîne accepté sans compteur par compte |

Aucun test de charge, d'intrusion réseau ou de paiement n'a été lancé. Terraform n'était pas installé : l'infrastructure a été relue sans `validate`.

---

## Plan d'action

| Ordre | Action | Constats |
| --- | --- | --- |
| 1 — Aujourd'hui | Rotation coordonnée des secrets RDS, Valkey et JWT ; supprimer `gcloud.yml` et révoquer `GCP_SA_KEY` / `ENV_VARS` | S1, S3 |
| 1 bis — Aujourd'hui | Vérifier si la subvention du premier trajet est active en production. Si oui : plafond d'urgence (configuration ou désactivation), revue des gains subventionnés élevés et des retraits récents. Chercher `FlexPay check returned orderNumber in reference field` dans CloudWatch | M1, M2 |
| 2 — Avant de commiter la branche | Ne plus capturer les jetons sur `manual_driver_confirmation` ; unifier l'ordre des verrous | F1, F3 |
| 3 — Prochaine livraison | Mappers de réponse pour `bookings` et jeton push lié à l'installation ; annulation interdite après embarquement ; callback FlexPay sans reprise de l'ordre fourni ; clé du quota de connexion ; changement de numéro avec OTP ; sessions WebSocket fantômes ; ordre d'arrêt des crons | D1, D2, B1, M2, A1, A2, R1, R2 |
| 3 bis — Décision produit | SOS : brancher une file back-office avec astreinte et les SMS aux contacts, ou retirer la promesse dans l'application tant que ce n'est pas fait | H1 |
| 3 ter — Prochain lot financier | Seuls les jetons achetés deviennent des gains ; reprise des gains et du parrainage au remboursement ; retraits vers un nouveau numéro sous PIN + OTP | M3, M4, M6 |
| 4 — Cette semaine | Séparer le job CI de tests du job de déploiement, épingler les actions, environnement `production` protégé | S2 |
| 5 — Planifier | Rôle PostgreSQL non maître, WAF et logs ALB, alarmes de panne totale, sauvegardes hors compte, sonde ALB légère | S4, I1 à I5 |

---

## P0 — Opérations immédiates

### S1 — Critique — Secrets de production dans l'historique GitHub (ouvert depuis le 6 novembre) — vérifié

**Preuves :**

- `infra-aws/tfplan`, ajouté par `ba9884f` le 26 septembre et retiré par `c319fe8` le 6 novembre, reste accessible dans l'historique de `origin/master`, de `origin/LAB-8-…` et de trois branches locales.
- L'archive contient un `tfstate` avec **36 valeurs sensibles en clair**, dont :
  - le mot de passe maître RDS ;
  - le jeton d'authentification Valkey ;
  - `JWT_SECRET` et `JWT_REFRESH_SECRET` ;
  - `DATABASE_URL` et `REDIS_URL` complètes.
- Seules les longueurs ont été lues : aucune valeur n'a été affichée ni recopiée.
- Les secrets proviennent de `random_password` sans `keepers` (`infra-aws/ssm.tf:1-9`, `database.tf:10`, `redis.tf:6`). Ils ne changent donc pas sans `-replace` explicite, et aucune trace de rotation n'existe dans le dépôt ou le CHANGELOG infra.

**Impact réel :**

- **RDS et Valkey :** ils sont privés, donc exploiter leurs identifiants suppose un accès au VPC. Combiné à S2 (lancement de tâche ECS depuis le CI), ce prérequis devient atteignable.
- **JWT :** la fabrication d'un JWT d'accès est **bloquée** par la comparaison d'empreinte en base (`src/auth/strategies/jwt.strategy.ts:44-47`, même contrôle côté WebSocket). En revanche, `JWT_SECRET` signe aussi :
  - l'historique du chatbot (`src/chatbot/chatbot.service.ts:24`) ;
  - les permis de sonnerie (`src/notifications/notifications.service.ts:738-745`) ;
  - les URLs locales signées en repli (`src/main.ts:224`).

**À faire :**

1. `terraform apply -replace` sur les quatre `random_password` dans une fenêtre planifiée. La rotation JWT déconnecte tous les utilisateurs.
2. Redéployer.
3. Purger l'historique (`git filter-repo`), forcer la mise à jour des branches distantes, puis demander à GitHub la purge des vues en cache.
4. Ajouter gitleaks (ou équivalent) en CI et en hook local.
5. Supprimer les ~20 plans et la sauvegarde d'état présents en clair sur le poste (`infra-aws/*.tfplan`, `tmp/*.tfplan`, `tmp/sns-state-before-reconcile-20261121.tfstate.backup`).

### S2 — Élevée — Le job de production expose le rôle AWS de déploiement à tout le code exécuté — vérifié

**Preuves :**

- `.github/workflows/deploy.yml:9-11` accorde `id-token: write` au workflow entier.
- Un seul job `test-build-deploy` exécute :
  - `npm ci` avec les scripts d'installation (l.54) ;
  - toute la suite de tests (l.89) ;
  - puis le déploiement.
- Le rôle OIDC autorise `RunTask`, `RegisterTaskDefinition`, `PassRole` des rôles de tâche et la lecture des logs (`infra-aws/oidc.tf:82-161`).
- Les actions sont référencées par tag, pas par SHA, et aucun `environment:` avec approbation n'est configuré.

**Scénario :** une dépendance compromise publiée sur `release` demande un jeton OIDC, lance une tâche avec la commande `env`, puis relit tous les secrets `/zwanga-api/production/*` dans CloudWatch.

**À faire :**

- séparer un job de tests sans `id-token` d'un job de déploiement minimal ;
- passer à `npm ci --ignore-scripts` hors build ;
- épingler les actions par SHA ;
- créer un environnement GitHub `production` avec relecteurs, puis restreindre `sub` à `environment:production` ;
- créer une famille de tâches dédiée aux migrations, à commande figée.

### S3 — Élevée — Ancien workflow Cloud Run actif sur `master` — vérifié (impact à confirmer)

**Preuves :**

- `.github/workflows/gcloud.yml:3-6` déploie à chaque push sur `master` :
  - avec une clé de compte de service longue durée (l.25) ;
  - en `--allow-unauthenticated` ;
  - sans bloc `permissions:`.
- `echo "${{ secrets.ENV_VARS }}" > .env` (l.41) fait interpréter le secret par le shell.

**Scénario :** si ces secrets sont encore valides, chaque fusion sur `master` publie une seconde API publique avec les variables fournies. Ses crons et ses paiements tourneraient en parallèle de la vraie production.

**À faire :**

- supprimer `gcloud.yml` ;
- révoquer `GCP_SA_KEY` et `ENV_VARS` ;
- vérifier et arrêter le service Cloud Run ;
- traiter de même `main.yml` (cible Lightsail disparue, clé SSH et `.env` de production référencés) et `docker-publish.yml` (image de production publiée sur Docker Hub : vérifier que le dépôt est privé).

### S4 — Élevée — L'application utilise toujours le compte maître RDS (SEC-02, ouvert) — vérifié

**Preuves :**

- `infra-aws/database.tf:23-24` crée le compte maître.
- `infra-aws/ssm.tf:16` construit `DATABASE_URL` avec ce compte, injecté dans l'API (l.99).
- Les migrations tournent avec la même identité.
- `src/database/typeorm-options.ts:186` sait déjà lire `MIGRATION_DATABASE_URL`, mais aucun rôle distinct n'est créé.

**À faire :**

- un rôle DML pour l'exécution ;
- un rôle DDL injecté **uniquement** dans la tâche de migration (un paramètre sous `/env/` serait injecté dans toute l'API) ;
- `manage_master_user_password` ou `password_wo` pour sortir le mot de passe maître de l'état Terraform.

---

## P1 — Code à corriger

### F1 — Élevée — Le conducteur peut seul faire débiter les jetons du passager — vérifié, **régression non commitée**

**Chemin :**

1. Un trajet issu d'une demande passe en mode `driver_only` (`src/ride-declarations/ride-confirmation-mode.ts:6-10`).
2. La seule confirmation du conducteur rend l'embarquement puis l'arrivée `ready` (`ride-declaration.model.ts:31-41`).
3. La réservation devient `COMPLETED` avec `manual_driver_confirmation` (`ride-declarations.service.ts:118-130`).
4. `finishManualRideEffects` accepte désormais cette méthode (`src/bookings/bookings.service.ts:3920`, ajout absent de `HEAD`).
5. `settlePaymentAfterArrival` est appelé, puis `capturePointsPaymentForBooking` (l.3000-3008), qui débite les jetons du passager et enregistre le gain du conducteur.

**Contrôles absents :**

- `validateManualRidePassenger` (l.3898) ne vérifie que le KYC ;
- aucune position GPS n'est comparée ;
- aucune durée minimale n'est exigée ;
- `occurredAt` est fourni par le client, dans une tolérance de 72 h ;
- une fois l'étape appliquée, le passager ne peut plus contester (`RIDE_ALREADY_CONFIRMED`).

**Scénario :** le conducteur accepte une demande payée en jetons, démarre, puis envoie deux `PUT /ride-declarations/booking/:id` à quelques secondes d'intervalle. Le débit a lieu au passage suivant du cron de réparation (30 s).

**À faire :** en `driver_only`, laisser `paymentStatus=PENDING` jusqu'à une action du passager, ou exiger une preuve GPS serveur (embarquement, destination, durée minimale) avec une fenêtre de contestation avant le débit. Ajouter le test correspondant. Le cas cash (récompenses de fin de trajet attribuées sans action du passager) est à examiner dans le même lot.

### A1 — Élevée — Le quota par compte de `/auth/login` se contourne : force brute du PIN à 4 chiffres — vérifié (sonde locale)

**Preuves :**

- Le garde lit le corps brut, avant le pipe de validation. Le compteur par compte n'existe que si `typeof req.body.phone === 'string'` (`src/common/guards/throttler.guard.ts:21`).
- Or `LoginDto` applique `String(value)` avant validation. `{"phone":243…,"pin":1234}` est donc accepté sans compteur de compte.
- La clé est calculée sur les chiffres bruts : `+243…`, `0…` et `00243…` donnent des compteurs distincts pour un même compte.
- Il ne reste que 10 requêtes par minute et par IP, sans WAF (I1). Avec ~100 adresses, les 10 000 PIN se testent en une dizaine de minutes pour un numéro connu (voir A5).
- Le même défaut touche `admin/login`.

**À faire :**

- refuser un `phone` non-chaîne dans le garde ;
- calculer la clé après `normalizeOtpPhone` ;
- ajouter un compteur d'échecs persistant par compte, avec délai progressif ou verrouillage temporaire et notification par SMS.

À vérifier en parallèle : `TRUSTED_PROXY_CIDRS` n'apparaît ni dans Terraform ni dans les workflows, et `src/main.ts:174-177` ne fait qu'avertir. Si `req.ip` vaut l'adresse de l'ALB, tous les clients anonymes partagent un seul compteur IP. Un attaquant peut alors bloquer la connexion et l'OTP pour tout le monde.

### A2 — Élevée — Changement de numéro sans preuve, puis prise de contrôle durable — vérifié

**Preuves :**

- `PUT /users/me` accepte un nouveau `phone` sans PIN ni OTP. Seuls les rôles admin sont bloqués (`src/users/users.service.ts:356-360`), alors que le commentaire juste au-dessus décrit précisément ce risque.
- `canUseSelfServicePinReset` n'exige pas un numéro vérifié, et `verifyPinResetOtp` le marque ensuite comme vérifié (`src/auth/auth.service.ts:473-481`, `579-587`).

**Scénario :** avec une session volée ou un téléphone déverrouillé, l'attaquant change le numéro, demande `pin/reset`, reçoit l'OTP sur son propre numéro et fixe un nouveau PIN. Les sessions de la victime sont révoquées et la victime ne peut plus récupérer son compte par SMS.

**À faire :**

- exiger le PIN et un OTP envoyé sur le nouveau numéro ;
- notifier l'ancien numéro ;
- bloquer la réinitialisation du PIN pendant un délai après un changement de numéro.

### R1 — Élevée — Sessions WebSocket fantômes : conducteurs privés de temps réel jusqu'à 24 h — vérifié et reproduit, **déjà en production**

**Mécanisme :**

- `WsSessionService.connect` (`src/common/services/ws-session.service.ts:62-88`) attend successivement le JWT, le quota Redis et la lecture SQL de l'utilisateur.
- Il n'enregistre la session et `socket.once('disconnect')` qu'après ces attentes. Une coupure pendant cette phase laisse donc une entrée qui ne sera jamais retirée.
- Le balayage `validateSessions` ne la purge pas, car le jeton reste valide.
- Au bout de 6 entrées pour un même utilisateur, toutes ses nouvelles connexions sont refusées (l.76) jusqu'à l'expiration du JWT, soit 1 jour. Le plafond de 2000 sessions par tâche peut aussi se remplir.
- Le code est identique dans `HEAD`.

**Scénario :** un réseau mobile instable ou une base lente (attente de pool jusqu'à 5 s) suffit à déclencher le blocage. Le conducteur ne reçoit plus les alertes de course ni le suivi.

**À faire :** abonner `disconnect` avant le premier `await`, ou vérifier `socket.connected` juste avant `sessions.set`. Purger aussi les sockets déconnectés dans le balayage.

### R2 — Élevée — À l'arrêt d'une tâche, les crons écrivent encore après le retrait de l'outbox — mécanisme vérifié

**Mécanisme :**

- Nest exécute tous les `onModuleDestroy`, puis les `beforeApplicationShutdown`. Les crons ne s'arrêtent que dans `SchedulerOrchestrator.beforeApplicationShutdown`, après les 10 s d'attente de `TrackingShutdownService` (`src/tracking/tracking-shutdown.service.ts:47`).
- Pendant ce temps, le subscriber transactionnel est déjà désinscrit (`src/notifications/transactional-notifications.subscriber.ts:76-79`) et Redis fermé (`src/common/services/redis.service.ts:41-47`).
- Les crons aws-kyc (5 s), réconciliation de paiements (10 s), PawaPay et retraits continuent de valider des écritures.

**Effet possible à chaque déploiement :** une validation KYC passée à `APPROVED` sans `applyKycApprovalHook` (compte non activé), et des notifications financières perdues en silence.

**À faire :**

- un provider de `AppModule`, détruit en premier, qui arrête et attend les jobs du `SchedulerRegistry` ;
- ne désinscrire le subscriber qu'après la DataSource ;
- un `stopTimeout` ECS de 60 à 90 s, au lieu des 30 s par défaut, qui sont égales au délai de fermeture forcée de `src/main.ts:146-153`.

---

## Second passage — fraude, exposition des données, sécurité des personnes

### M1 — Critique — Subvention du premier trajet sans plafond, calculée sur un prix libre — chaîne financière vérifiée, activation en production à confirmer

**Preuves :**

- `pricePerSeat` n'a qu'un `@Min(0)` (`src/trips/dto/trip.dto.ts:114-116`). Le seul autre contrôle est le minimum de 2 500 FC des demandes (`trip-request-pricing.ts:22-27`).
- Zwanga prend en charge `prix × (1 − FIRST_TRIP_PASSENGER_PAYMENT_RATE)`, soit 60 % avec la valeur d'exemple 0,40, **sans plafond** (`src/bookings/bookings.service.ts:3267-3278`).
- L'éligibilité ne dépend que du `passengerId` (l.3307-3366). Un compte neuf suffit : pas de KYC pour 1 ou 2 places, et pas d'OTP à l'inscription par défaut (D5).
- En cash, la subvention est créditée au conducteur dès la dépose, sans aucun mouvement d'argent du passager (`src/driver-settlements/cash-subsidy-settlement.ts:8-41`). Le gain est disponible immédiatement puis retirable (`driver-settlements.service.ts:675`, `reservePayout` l.1089).

**Scénario :**

1. Un conducteur KYC publie un trajet de 4 places à 10 M FC la place.
2. Quatre comptes neufs réservent en cash, puis déclarent et confirment l'encaissement et la dépose.
3. Résultat : 4 × 6 M FC retirables. La commission cash n'est qu'une dette sur les six premiers trajets.

**À faire :**

- plafond absolu de subvention par réservation ;
- prix maximal par place fixé côté serveur, par exemple une grille prix/km ;
- retenue des gains subventionnés jusqu'à un contrôle ou une ancienneté ;
- alerte sur les gains subventionnés au-dessus d'un seuil.

### M2 — Élevée — Callback FlexPay public : un ordre déjà payé peut être rejoué sur une autre réservation — vérifié, exploitation dépendante du format de réponse FlexPay

**Preuves :**

- L'`orderNumber` d'un callback non signé est recopié dans la transaction (`src/payments/payments.service.ts:572`). C'est ensuite cet ordre qui est vérifié auprès de FlexPay.
- Si FlexPay renvoie l'ordre dans `reference`, l'écart avec la référence marchande est seulement journalisé (l.1054-1057). `assertProviderTransactionMatches` ne compare alors que l'ordre, le montant et la devise.
- `orderNumber` n'est pas unique (`payment-transaction.entity.ts:85-87`) et le passage FAILED → SUCCEEDED est admis (`flexpay-deposit-state.ts:22-43`).
- Reproduit par une preuve jest locale avec mocks.

**Scénario :**

1. Le passager paie une réservation de 5 000 FC (ordre O1).
2. Il crée une seconde réservation au même prix, dont l'initiation échoue sans ordre.
3. Il poste `{reference: R2, orderNumber: O1, code: "0"}` sur `/bookings/flexpay/callback`.
4. La réservation R2 est payée et le gain du conducteur est créé. L'opération peut être répétée.

Même chemin sur `/subscriptions/flexpay/callback`. Les recharges et les versements, eux, ont un contrôle d'identité strict.

**À faire :**

- ne jamais reprendre l'ordre fourni par un callback de dépôt, mais uniquement celui enregistré à l'initiation ;
- appliquer à tous les dépôts la règle d'identité des recharges ;
- index unique partiel sur (`provider`, `orderNumber`).

### M3 — Élevée — Jetons gratuits convertis en argent par un trajet complice — chemin financier vérifié

**Mécanisme :** une réservation payée en jetons débite des jetons de toute origine, et ce débit devient un gain conducteur retirable (`wallet.service.ts:413-418`, `bookings.service.ts:2948-2963`).

**Sources de jetons gratuits :**

- bonus de bienvenue par compte KYC, sans unicité de pièce d'identité côté backend ;
- bonus de distance proportionnel aux kilomètres, indépendant du prix (`wallet.service.ts:1312-1364`) ;
- transferts entre comptes sans plafond ni KYC (`wallet.service.ts:547-674`), qui permettent d'agréger une ferme de comptes.

**À faire :** ne convertir en gain retirable que les jetons achetés, comme le fait déjà le crédit d'actifs. Plafonner le bonus de distance et les transferts de jetons non achetés.

### D1 — Élevée — Les routes de réservation renvoient des entités brutes : position en direct, email et jeton push du conducteur — vérifié

**Preuves :**

- `GET /bookings/my-bookings`, `/my-bookings/history`, `/my-bookings/trip/:id`, `GET /bookings/:id`, les mutations qui renvoient `findOne`, et `GET /bookings/trip/:tripId` côté conducteur renvoient l'entité TypeORM avec `trip.driver`, `trip.vehicle` et `passenger` (`src/bookings/bookings.service.ts:1426, 1436, 1463, 1504, 1541`).
- Il n'y a ni `ClassSerializerInterceptor`, ni `@Exclude`, ni `toJSON`.
- Seuls le PIN et les jetons de session sont en `select: false`. Partent donc dans la réponse :
  - `phone`, `email`, `googleId`, `appleId`, `fcmToken` et `lastLoginAt` du conducteur ;
  - `trip.currentLocation`, c'est-à-dire sa position en direct ;
  - la plaque du véhicule.
- Ces données sortent **quel que soit le statut** de la réservation, alors que `tripResponseForViewer` (`trip-read-policy.ts:56-73`) les réserve aux réservations acceptées.
- Pendant une demande d'interruption, les `User` complets des co-passagers sont aussi attachés (l.1594).

**Scénario :** un compte quelconque réserve une place sur un trajet trouvé par la recherche. Sa réservation reste en attente, ou est refusée depuis moins de 48 h. Il interroge `GET /bookings/:id` en boucle et suit le conducteur en temps réel.

**À faire :**

- mappers explicites pour toutes les réponses `bookings`, qui réutilisent `sanitizeUser` et les règles par statut de la politique trajet ;
- en complément, `select: false` sur `fcmToken`, `googleId`, `appleId` et `email`.

### D2 — Élevée — Détournement du canal push d'un conducteur — vérifié (enchaîné à D1)

**Mécanisme :**

- `POST /users/fcm-token` attribue n'importe quel jeton à l'appelant. Il le retire à son titulaire et supprime ses enregistrements de notification conducteur (`src/users/users.service.ts:851-873`).
- Les envois Expo partent sans jeton d'accès (`notifications.service.ts:651-656`). La sécurité renforcée d'Expo est donc désactivée : quiconque possède le jeton peut envoyer des notifications à l'appareil.

**Scénario :** un passager récupère le `fcmToken` du conducteur via D1 et le poste sur son compte. Le conducteur ne reçoit plus les alertes de course tant que son application n'a pas réenregistré le jeton. L'attaquant peut aussi lui envoyer de fausses notifications d'hameçonnage.

**À faire :**

- lier l'enregistrement du jeton à la preuve d'installation (`x-installation-secret`, déjà utilisée par `mobile-operations`) ;
- refuser un jeton déjà possédé par un autre compte sans cette preuve ;
- activer la sécurité push d'Expo.

### B1 — Élevée — Le passager peut annuler en pleine course, sans frais — vérifié

**Preuves :**

- `cancel` (`src/bookings/bookings.service.ts:2389-2475`) n'interdit l'annulation après embarquement **qu'au conducteur** (l.2429-2439). Rien n'arrête le passager quand `pickedUp` est vrai.
- Effets :
  - réservation CANCELLED ;
  - jetons remboursés ;
  - commission cash libérée ;
  - trajet privé clôturé.
- Le flux d'interruption, qui exige l'accord du conducteur et un tarif partiel, est contourné.
- La lecture se fait sans verrou avant le `save` : une complétion concurrente peut être écrasée (à confirmer).

**À faire :** refuser l'annulation dès qu'il y a embarquement ou déclaration, et rediriger vers l'interruption. Effectuer l'annulation par `UPDATE … WHERE status IN (…) AND NOT "pickedUp"`.

### H1 — Élevée — Une alerte SOS n'atteint aucun opérateur ni aucun contact — vérifié

**Preuves :**

- Les alertes sont enregistrées (`src/safety/safety.service.ts:243-277`), mais aucun code hors de `src/safety` ne lit `safety_alerts` : il n'existe ni route back-office ni file de support.
- `notifyEmergencyContacts` (l.680-720) se contente d'un log, avec un `TODO` l.704. La seule notification part vers l'auteur de l'alerte lui-même.

**Scénario :** un passager agressé déclenche le SOS. Personne n'est prévenu.

**À faire :** une file back-office temps réel avec astreinte, plus les SMS aux contacts d'urgence. D'ici là, ne pas présenter la fonction comme active dans l'application. C'est aussi un risque de responsabilité pour l'entreprise.

### Constats moyens du second passage

| Id | Constat | Preuve | À faire |
| --- | --- | --- | --- |
| M4 | Retraits de parrainage et retraits conducteur vers **n'importe quel numéro**, sans PIN, OTP ni plafond journalier. Avec une session volée (A2, A6), le solde part vers le Mobile Money de l'attaquant. | `referrals.service.ts:899-905`, `driver-settlements.service.ts:1120-1126` | Numéro vérifié du compte par défaut ; nouveau numéro sous PIN + OTP, délai de carence et notification. |
| M5 | Commission de parrainage cash égale à 1 % d'un montant déclaré sur un prix libre, par un passager et un conducteur qui peuvent être complices. | `referrals.service.ts:759-773`, `cash-receipts.service.ts:32-151` | Libérer la récompense seulement après règlement de la commission ; exclure les trajets financés par avance ou dette. |
| M6 | Rien n'est repris après un remboursement : `reverseBookingReward` n'a aucun appelant et aucun gain n'est jamais passé `CANCELLED`. Le remboursement PawaPay accepte une référence métier libre. Zwanga paie alors deux fois. | `referrals.service.ts:871`, `pawapay-operations.service.ts:157-163` | Reprise du gain et du parrainage dans la transaction de remboursement ; retenue sur les gains. |
| D3 | Le lien de suivi public reste valable jusqu'à 168 h, y compris s'il a été créé après la course, et renvoie `trip.currentLocation` sans revérifier ni le statut ni la fraîcheur de la position. | `src/tracking/tracking.service.ts:98-144, 259-263` | Position seulement si la réservation est acceptée, non déposée, le trajet actif et la position fraîche ; expiration à la fin de la course. |
| D4 | La suppression de compte anonymise la ligne `users`, mais laisse les contacts d'urgence (données de tiers), les véhicules et leurs photos, les messages, les destinataires des liens de suivi et les points GPS des réservations. `trips.currentLocation` n'est jamais effacé après une course. Versioning du bucket S3 à vérifier. | `users.service.ts:107-124, 257-308` | Purger ou anonymiser ces tables dans la suppression ; job qui efface les positions N jours après la course. |
| D5 | Inscription sans preuve de possession du numéro par défaut (`REGISTRATION_PHONE_OTP_REQUIRED=false`, absent de Terraform). Permet les comptes jetables (M1, M3) et le squat du numéro d'un tiers. | `src/auth/auth.service.ts:1699-1712` | Activer en production et l'imposer au démarrage. |
| B2 | Notes gonflables par un compte complice : une note par trajet, mais aucun dédoublonnage par auteur dans la moyenne (à confirmer). | `ratings.service.ts:31-45, 94-101` | Auteurs distincts, pondération par KYC et trajets payants. |

### Constats faibles du second passage

| Constat | Preuve |
| --- | --- |
| Attribution de parrainage possible quelle que soit l'ancienneté du compte (fenêtre basée sur une date fournie par le client) ; seul contrôle anti-auto-parrainage : `referrerUserId === userId`. | `referrals.service.ts:238-260, 392, 1868-1893` |
| Plafond de financement de documents comparé sans tenir compte de la devise ; transfert sans clé d'idempotence pour les anciens clients ; paiement électronique « près de l'arrivée » peut-être non remboursé à l'annulation (à confirmer). | `subscriptions.service.ts:571-590`, `wallet.service.ts:560`, `bookings.service.ts:3026-3045` |
| `POST /bookings` ne refuse pas un trajet `isPrivate` dont l'UUID est connu (à confirmer). | `bookings.service.ts:1146-1395` |
| `GET /public/drivers/:id`, anonyme, expose les plaques et le statut de crédit du conducteur. | `public-driver.service.ts:16-31` |
| Alerte SOS rattachable à n'importe quel `tripId` ou `bookingId` ; `PUT /safety/reports/:id/status` sans `@Roles` (rôle vérifié dans le service, mais `passwordChangeRequired` contourné). | `safety.service.ts:250-262`, `safety.controller.ts:180-189` |
| Véhicule auto-déclaré sans document : la plaque appartient au premier qui la déclare, ce qui permet de squatter une plaque. | `vehicles.service.ts:124-141`, `driver-activation.ts:9-17` |
| Écarts d'exposition : plaque dans `GET /users/:id/public`, téléphone du conducteur dans `driver-contact` quel que soit le statut, `GET /users/me` avec les clés S3 et le numéro des pièces KYC. | `users.service.ts:1341-1348`, `bookings.service.ts:2701-2740` |
| Aucune validation des variables d'environnement au démarrage (longueur et unicité des secrets, `NODE_ENV`, signatures obligatoires). | `src/config/config.module.ts:6-14` |
| Le scan de secrets non commité (`.github/actions/secret-scan`) bloquera tout déploiement tant que l'historique n'est pas purgé (S1). `scripts/` et `.github/actions/` ne sont pas suivis : commiter les workflows sans eux casse la CI. | `.github/actions/secret-scan/action.yml:29`, `deploy.yml:42` |
| Hash du secret d'installation comparé par `!==` (non exploitable en pratique) ; secrets passés en argument de ligne de commande dans deux scripts d'import SSM. | `installation-updates.service.ts:77`, `import-env-to-ssm.ps1:193` |

### Zones relues sans défaut au second passage

- **Modules B2B :**
  - `store-management` : permissions en base, double validation, aucune publication d'app, SSRF verrouillée ;
  - `partners` : isolement par organisation ;
  - `pro-services`, `mobile-operations` : secret d'installation comparé à temps constant.
- **Garde globale :** JWT et rôles globaux, routes publiques uniquement via `@Public()`.
- **Trajets :** KYC conducteur exigé à chaque point d'entrée, places recomptées sous verrou, recherche et détail des trajets projetés proprement.
- **Signatures et paiements :**
  - PawaPay et Didit : signatures exigées ;
  - PawaPay : état final non régressable ;
  - retraits de parrainage : verrous, KYC sous verrou, idempotence, un seul retrait ouvert ;
  - wallet : contrainte CHECK sur les soldes, taux de change fixé côté serveur.
- **Données :**
  - migrations récentes additives et compatibles avec un déploiement progressif ;
  - `TYPEORM_SYNCHRONIZE` impossible en production ;
  - aucun OTP de test ni compte de revue en dur ;
  - scripts de charge de production limités à des GET publics sur confirmation explicite.

---

## P2 — À planifier

| Id | Gravité | Constat | Preuve | À faire |
| --- | --- | --- | --- | --- |
| F2 | Moyenne | Un passager qui ne paie pas laisse le trajet du conducteur `ACTIVE` sans fin : la clôture exige `SUCCEEDED`, un trajet `ONGOING` n'expire pas, et il n'existe ni bascule conducteur ni clôture admin. Le conducteur ne peut alors plus accepter de demande directe. | `src/bookings/paid-request-completion.ts:7-28`, `src/trips/complete-trip-transaction.ts:35-37`, `trip-requests.service.ts:1201` | Séparer clôture et règlement (créance « paiement dû ») ; reprise par cron ou action admin. |
| F3 | Moyenne | Ordres de verrous opposés : « réservation puis trajet » (GPS passager, clôture, interruption) contre « trajet puis réservation » (déclarations, assistance à l'arrivée). Risque de deadlock 40P01 dans les cas concurrents ; le commentaire l.65 est devenu faux. | `driver-interruption.workflow.ts:229-234`, `ride-declarations.service.ts:66-68`, `arrival-assistance.service.ts:108-119`, `persist-tracking-location.ts:27-41` | Un seul ordre partout, plus un test de concurrence PostgreSQL. |
| A3 | Moyenne | `passenger_location` est diffusé dans la room `trip:<id>`, donc aux autres passagers, qui peuvent suivre un co-passager avant sa prise en charge. | `src/tracking/tracking.gateway.ts:295-297` | N'émettre que vers la room du conducteur. |
| A4 | Moyenne | La connexion Google ou Apple ne refuse pas les rôles back-office, qui obtiennent un JWT admin sans mot de passe admin. La liaison par email ne vérifie pas `email_verified` (à confirmer). | `auth.service.ts:1134-1152`, `1538-1567` ; `admin-account.provisioning.ts:98-125` | Refuser l'OAuth pour ces rôles ou effacer les identifiants à la promotion ; exiger `email_verified`. |
| A5 | Moyenne | Énumération des comptes : `/users/phone/send-otp`, public, répond « aucun compte » ou « déjà utilisé » avant l'envoi. La connexion révèle aussi qu'un compte est suspendu avant la vérification du PIN. | `users.service.ts:895-903`, `auth.service.ts:374` | Réponse générique ; existence contrôlée à la vérification. |
| A6 | Moyenne | JWT d'accès valable 1 jour (refresh à 90 j par défaut, 21 j en exemple de production), une seule session par compte. | `auth.service.ts:1749-1756` | Accès de 15 à 30 min, en s'appuyant sur la rotation de refresh déjà robuste. |
| R3 | Moyenne | Un seul balayage SQL en échec ferme jusqu'à 2000 sockets d'une tâche, d'où une tempête de reconnexions pendant que la base est lente. | `ws-session.service.ts:101-117` | Délai de grâce sur plusieurs échecs, erreurs d'élagage traitées à part, aléa sur `retryAfterSeconds`. |
| R4 | Moyenne | Redis conditionne tout le HTTP (limiteurs qui refusent si Redis ne répond pas) et chaque événement WebSocket. Pendant une bascule Valkey, l'API répond 503 partout. | `app.module.ts:136-147`, `ws-session.service.ts:139-143` | Quota local dégradé pour le GPS et les lectures ; refus maintenu pour l'OTP, l'auth et la finance. |
| I1 | Moyenne | Ni WAF ni logs d'accès ALB, pas de `drop_invalid_header_fields`, logs applicatifs conservés 7 jours. | `infra-aws/alb.tf:1-14`, `production.auto.tfvars:57` | WAF avec règles managées et rate-based (login, OTP, cartes), logs ALB vers S3, au moins 90 jours. |
| I2 | Moyenne | Une panne totale peut passer inaperçue : seule `UnHealthyHostCount` existe, en `notBreaching`. Aucune alarme `HealthyHostCount < 1`, 5XX ELB ou sonde externe. | `infra-aws/monitoring.tf:204-222` | Ajouter ces alarmes et une sonde Route 53 ou Synthetics. |
| I3 | Moyenne | `/health`, utilisé par l'ALB, interroge la base, Redis et le schéma. Un redémarrage RDS mono-AZ ou une bascule Valkey provoque des remplacements de tâches en boucle. | `src/health/health.controller.ts:26-50` | Sonde ALB légère, contrôle profond réservé aux alarmes ; Multi-AZ RDS selon le budget. |
| I4 | Moyenne | PITR de 7 jours, aucune copie hors compte ou hors région. | `infra-aws/database.tf:37` | AWS Backup avec copie inter-comptes, rétention de 30 à 35 jours. |
| I5 | Moyenne | Bucket d'état Terraform en SSE-S3, sans politique restreignant les principals, alors qu'il contient tous les secrets. | `infra-aws/bootstrap/main.tf:46-54` | SSE-KMS avec politique restrictive ; `value_wo` pour SSM, comme en staging. |

## Points faibles à traiter au fil de l'eau

| Domaine | Constat | Preuve |
| --- | --- | --- |
| Export parrainages | Prénom, nom et email non neutralisés contre l'injection de formules ; peu exploitable en SpreadsheetML typé, mais le devient après réenregistrement en CSV. Réutiliser le neutraliseur de `store-management`. | `src/admin/user-referrals-spreadsheet.ts:48-59` |
| Recouvrement | Le rôle `analyst`, exclu de la liste des débiteurs, reçoit quand même leur téléphone via `credit-contracts` (liste et détail). | `credit-collections.service.ts:233-238`, `credit-contracts.service.ts` |
| Sécurité des personnes | Numéros des contacts d'urgence écrits en clair au niveau `warn`, alors que ces contacts **ne sont jamais prévenus** (TODO). | `src/safety/safety.service.ts:704-708` |
| OTP Keccel | Aucun compteur local de tentatives (Mobishastra en a 5) ; `verify-otp` n'est limité que par IP. | `src/otp/otp.service.ts:146-166` |
| Chat | N'importe quel membre peut ajouter un utilisateur, qui récupère tout l'historique, ou retirer un participant, y compris le support. | `src/chat/chat.service.ts:259-296` |
| Photo de véhicule | `photoUrl` libre : URL présignée générée pour toute clé hors `kyc/`, y compris `pro/` (pièces de crédit, clé UUID à deviner). | `vehicles.service.ts:455-457`, `file-upload.service.ts:215-233` |
| Exposition | Swagger public en production ; proxys Google Maps et Yandex anonymes, d'où un risque de coût. | `src/main.ts:271-272`, `google-maps.controller.ts:34-82` |
| Redis | Un seul dépassement de 2 s réinitialise toute la connexion ; pub/sub et cache sans PING, ce qui peut cacher une connexion à demi ouverte. | `redis.service.ts:54-64`, `redis-options.ts:58-69` |
| Socket.IO | Messages limités à 1 Mo par défaut, décodés avant l'authentification ; viser environ 64 Ko. | `src/common/configured-io.adapter.ts:15-21` |
| Clôture payée | Points de fidélité et notification de revenu envoyés hors outbox, après le commit, sans reprise possible. | `bookings.service.ts:3110-3118` |
| Dispatch | Le scan des échéances est traité par toutes les réplicas, qui attendent toutes le même verrou. | `sequential-dispatch.service.ts:383-392` |
| Diagnostic | Les crashs ne sont écrits que dans un fichier du conteneur (perdu avec la tâche) ; les timeouts SQL et la saturation du pool répondent 500 au lieu de 503. | `logger.module.ts:58-67`, `api-exception.filter.ts:104` |
| Images | ECR `MUTABLE` avec `latest` toujours poussé ; bundle CA RDS téléchargé sans somme de contrôle et ajouté à la confiance système ; images de base épinglées par tag, pas par digest. | `infra-aws/ecr.tf:3`, `Dockerfile:12-16` |
| Infra diverse | Tâche d'import Neon (`pg_restore --clean` avec le compte maître) toujours déployée ; ALB sans protection contre la suppression ; sortie 443 ouverte vers Internet ; staging dans le même compte que la production ; proxy Mobishastra sur une seule instance EC2. | `infra-aws/database-import.tf:29-38`, `security-groups.tf:138-145` |
| Poste de travail | `.env` contient une clé IAM AWS longue durée ; `.env.production`, la clé privée de signature et le jeton PawaPay ; `docker-compose.yml` publie sur 0.0.0.0 avec Grafana admin/admin et Redis sans mot de passe. | Fichiers locaux, non suivis par Git |

---

## État des constats antérieurs

| Constat | État |
| --- | --- |
| Fuite `tfplan` (06/11 F01) | **Ouvert** : rotation et purge non faites (S1) |
| Révocation JWT sur HTTP (10/10 n°02) | Corrigé : empreinte comparée à temps constant, alignée sur le WebSocket |
| Rotation du refresh token | Corrigé : compare-and-swap avec reçu de reprise |
| Dépendances (10/10 n°01) | Corrigé : 0 alerte npm |
| Reconnexion Redis (10/10 n°04) | Corrigé : backoff avec aléa, file hors ligne désactivée, deadline de commande. Redis reste un point unique (R4) |
| Crons (10/10 n°05) | Corrigé pour les rejets et chevauchements ; ordre d'arrêt défaillant (R2) |
| Compte maître RDS (10/10 n°07, 09/11 SEC-02) | **Ouvert** (S4) |
| Déploiement par digest (10/10 n°09) | Corrigé pour l'essentiel ; reste ECR mutable et `latest` |
| Pool SQL (10/10 n°10) | Corrigé : 10 connexions par tâche, statement 30 s, lock 5 s |
| Haute disponibilité (10/10 n°14, 09/11 HA-01) | Partiel : 2 à 3 tâches et Valkey Multi-AZ ; RDS toujours mono-AZ |

## Protections solides à conserver

- **Sessions :** révocation par empreinte sur HTTP et WebSocket, rotation de refresh par compare-and-swap, comparaisons à temps constant.
- **Contrôle d'accès :** les 73 routes admin sont annotées `@Roles` ; l'escalade de rôle en libre-service est filtrée ; `ValidationPipe` en `whitelist` + `forbidNonWhitelisted`.
- **Uploads :** vérification des octets magiques, ré-encodage sharp avec suppression des EXIF, KYC exclu des URLs présignées.
- **Finance :** montants en centimes `BigInt`, mutations conditionnelles et idempotentes, reçu cash par un seul `UPDATE` conditionnel, recouvrements entièrement paramétrés, devis de remboursement anticipé recalculé côté serveur.
- **Files de travail :** files SQL durables avec bail et `SKIP LOCKED`, outbox transactionnelle, budget SQL de fond, admissions WebSocket bornées.
- **Appels sortants :** délais bornés sur FCM, Expo, SMS, paiements et cartes.
- **Infrastructure :** RDS et Valkey privés avec TLS imposé, KMS avec rotation, SSM SecureString, CloudTrail multi-région validé, ALB en TLS 1.2/1.3, OIDC sans clé longue durée, circuit breaker ECS, conteneur non-root.

## Méthode et limites

- Premier passage en quatre volets parallèles : finance du code récent, authentification et accès, résilience runtime, infra et CI/CD.
- Second passage en trois volets : argent entrant et sortant avec parrainage, inventaire des routes et modules B2B, données et sérialisation.
- Relus directement dans le code lors de la consolidation : S1, S2, S3, F1, A1, A2, R1, M1, M2, D1, D2, B1 et H1. Les autres constats reposent sur la lecture du code par les volets correspondants, avec quelques preuves jest locales (M2, B1, D1, R1, A1), sans reproduction systématique.
- L'état réellement appliqué dans AWS (paramètres SSM, `TRUSTED_PROXY_CIDRS`, protection de la branche `release`, validité des secrets GCP et Docker Hub) n'a pas été vérifié.
- Les tests locaux ne garantissent pas l'absence de régression en production.
