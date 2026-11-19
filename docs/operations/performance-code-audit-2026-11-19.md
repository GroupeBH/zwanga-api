# Audit transversal des lenteurs du backend — 19 novembre 2026

## Conclusion

La lenteur n'est pas expliquée, à ce stade, par un simple manque de puissance AWS.

La **cause dominante mesurée sur une recherche géographique** reste son appel SQL principal : **1 171 ms sur 1 194 ms côté serveur**, environ 98 %. Le mécanisme interne responsable — plan, calcul spatial, tri, attentes — n'est pas encore isolé. Les autres constats ci-dessous sont des chemins coûteux **confirmés dans le code local**, pas des explications rétrospectives démontrées de cette trace.

Les risques les plus importants sont :

1. La sélection SQL des trajets géographiques.
2. Le démarrage d'un trajet qui attend une notification à tous les comptes actifs ayant un token, sans filtre géographique.
3. La liste historique des demandes, non paginée, avec des lectures d'abonnement par utilisateur sérialisé.
4. Les réponses et diffusions GPS qui attendent les traitements automatiques de course, lesquels peuvent attendre des notifications externes.
5. Les contrôles financiers complets exécutés toutes les cinq minutes dans chaque processus API.

**Aucun correctif applicatif, déploiement, changement AWS ou nouveau test de charge n'a été réalisé pour cet audit.** Seuls ce rapport et des outils de diagnostic locaux ont été ajoutés. Les changements préexistants ont été préservés.

## Périmètre et niveau de preuve

- Dépôt examiné : `zwanga-backend`, état local du 19 novembre, y compris ses modifications non commitées.
- Inventaire syntaxique de **1 103 fichiers TypeScript** sous `src` : **581 fichiers applicatifs**, **382 fichiers de tests**, **140 fichiers de migrations**.
- Balayage transversal, puis lecture ciblée des chemins chauds, de leurs appelants, des limites de pagination, des opérations différées et de leurs protections. Il ne s'agit pas d'une lecture manuelle exhaustive de chaque ligne ni d'une certification de tous les scénarios.
- Les compteurs de l'inventaire sont des pistes, pas un décompte de défauts : un `find` peut porter sur un tableau, une pagination peut être ajoutée par un helper, un `Promise.all` peut être borné.
- Les dépôts mobile/admin, leurs rendus sur téléphone et le réseau client ne sont pas réaudités ici. Les endpoints backend qui les servent le sont. Une route encore exposée n'est pas une preuve que toutes les versions mobiles l'utilisent.
- Le diagnostic historique AWS utilisé est détaillé dans [le rapport sur la recherche](trip-search-latency-2026-11-19.md). Fenêtre : **02:12–02:17, heure de Kinshasa, le 19 novembre**. Pas de nouvelle mesure AWS dans cette extension d'audit.
- Le précédent diagnostic a rapproché six fichiers de recherche/cache du commit associé à l'image ECS. Les autres fichiers de cet audit n'ont pas été comparés à l'image actuellement déployée.
- Le guide `supabase-postgres-best-practices` a servi à distinguer les coûts observés, les risques de requêtes répétées et les hypothèses d'index à confirmer.

**P1** : à traiter avant une montée de charge représentative. **P2** : coût conditionnel ou croissant avec l'historique, à traiter dans le durcissement. Ce classement n'est pas un niveau de gravité sécurité.

## Constats prioritaires

### 1. P1 — La recherche géographique concentre le temps SQL mesuré

Sources : `src/trips/trips.service.ts:427`, `:529`, `:596`, `:3132` ; `src/trips/trip-discovery-page.ts:9`.

Le filtre de proximité utilise un point calculé par `CASE` entre position GPS fraîche et point de départ. Le classement combine distance et priorité d'abonnement, avec une sous-requête corrélée sur les abonnements. Certaines jointures convertissent les identifiants en texte. Ces expressions peuvent coûter davantage qu'un simple accès indexé, mais **leur présence ne prouve pas qu'un index manque ou n'est jamais utilisé**.

La page est déjà sélectionnée avant les jointures d'affichage : il faut conserver ce bon découpage. L'appel géographique tracé a passé 1 171,070 ms dans le `WITH`, contre 0,048 ms pour obtenir sa connexion. La liste sans filtre tracée séparément a répondu en 30,282 ms côté serveur.

**Action recommandée :** récupérer le SQL exact et ses paramètres représentatifs, examiner d'abord `EXPLAIN`, puis `EXPLAIN (ANALYZE, BUFFERS)` dans un environnement représentatif avec budgets et autorisation adaptés. Contrôler les lignes parcourues, les boucles de sous-requête, le tri, les expressions spatiales, les conversions, les statistiques et les attentes avant de proposer une migration d'index. `ANALYZE` exécute réellement la requête ; ne pas le lancer sans limite sur la production.

**Validation :** mêmes résultats, ordre, disponibilité et pagination ; réduction des durées SQL et du p95 sur plusieurs recherches, à chaud et à froid. Une seule trace n'est pas un p95.

### 2. P1 — Le démarrage d'un trajet attend un envoi global de notifications

Sources : `src/trips/trips.service.ts:1797`, `:2302`, `:2309`, `:2342` ; `src/notifications/notifications.service.ts:1456`, `:1490`.

Quand un trajet démarre avec des places libres, `startTrip` attend `notifyNearbyUsersAboutTripStart`. Malgré son nom, cette méthode charge **tous les utilisateurs actifs**, puis retire le conducteur et les comptes sans token. Elle n'applique ni rayon géographique ni plafond de destinataires.

`sendToMultiple` crée les notifications du lot et attend leur livraison. Dans ce chemin avec `userIds`, la concurrence est limitée à **cinq** : le problème n'est donc pas une concurrence infinie, mais le volume total sans borne et le nombre de lots attendus par la réponse HTTP. Chaque livraison refait des contrôles de propriétaire de token et sollicite le fournisseur push.

**Impact :** durée de démarrage proportionnelle aux destinataires ; écritures et requêtes répétées ; contention possible avec GPS, dispatch et recherche. Ce chemin n'explique pas directement le `GET` géographique tracé, sauf concurrence de ressources non démontrée ici.

**Action recommandée :** définir l'audience réellement pertinente, la filtrer en base et la borner ; enregistrer durablement l'intention d'envoi puis livrer hors du chemin HTTP. Réutiliser les mécanismes d'outbox/claims existants et isoler les annonces non urgentes des alertes de dispatch. Ne pas remplacer l'attente par une simple promesse non suivie.

**Validation :** nombre de destinataires borné, retour HTTP indépendant de leur nombre, reprise après arrêt du worker, absence de notification pour une offre devenue indisponible.

### 3. P1 — La liste historique des demandes reste non paginée

Sources : `src/trip-requests/trip-requests.controller.ts:62` ; `src/trip-requests/trip-requests.service.ts:843`, `:851`, `:883`, `:889`.

`GET /trip-requests` sans `scope=home` charge toutes les demandes correspondant aux conditions de visibilité/proximité, encore disponibles, avec passager, conducteurs, véhicule et offres. Il n'y a pas de `take`/`limit` dans cette branche. Les contrôles de visibilité existent : **ce n'est pas une lecture sans filtre de toute la base**.

Le service hydrate les relations, réévalue les expirations, filtre puis sérialise toute la collection avec `Promise.all`. Sous forte densité locale de demandes/offres, cela augmente les lignes transférées, l'hydratation TypeORM, la mémoire et la taille JSON. `scope=home` est, lui, borné par la présélection des identifiants ; des endpoints `pages/*` existent déjà.

**Action recommandée :** faire converger les clients vers les contrats paginés existants ; borner la sélection avant les jointures ; choisir des projections minimales. Vérifier les clients legacy avant toute modification de contrat.

**Validation :** données synthétiques avec de nombreuses demandes dans un même rayon ; taille de page et temps mémoire stables ; aucun relâchement des règles d'éligibilité, d'expiration ou de confidentialité.

### 4. P1 — La sérialisation des demandes déclenche des lectures d'abonnement répétées

Sources : `src/trip-requests/trip-requests.service.ts:2554`, `:2566`, `:2742`, `:2825`, `:2841` ; `src/subscriptions/subscriptions.service.ts:465`, `:517`, `:524`.

Sans map de préchargement, chaque `sanitizeUser` attend `getPremiumOverview`, qui effectue un `findOne` sur l'abonnement actif. Un même utilisateur peut être relu plusieurs fois. La liste disponible sérialise au moins le passager de chaque demande ; le détail et d'autres listes peuvent également sérialiser des conducteurs/offres. La variante paginée réduit le volume mais conserve cette répétition.

La détection d'un abonnement expiré peut en plus sauvegarder son statut et invalider des caches depuis cette lecture. Cette branche ne s'exécute pas pour chaque utilisateur, mais ajoute des écritures possibles à un chemin de consultation.

**Action recommandée :** collecter les identifiants uniques et utiliser `getPremiumFeaturesForUsers`, puis transmettre la map aux sérialiseurs. Le chemin admin `findForAdminBatch` le fait déjà : réutiliser ce modèle. L'éligibilité doit rester fraîche et les expirations ne doivent pas être masquées.

**Validation :** mesurer le nombre de requêtes d'abonnement pour 1, 20 et 100 demandes, avec utilisateurs répétés et abonnements expirés. Il doit dépendre du nombre de lots, pas du nombre de lignes sérialisées.

### 5. P1 — Le flux GPS attend la progression automatique et ses effets

Sources : `src/tracking/tracking.gateway.ts:197`, `:205`, `:217`, `:221` ; `src/bookings/bookings.service.ts:232`, `:4298`, `:4306`, `:6081`, `:6130`, `:6344`, `:6478` ; `src/bookings/coalesced-ride-progress.ts:21`, `:61`.

Après l'enregistrement de la position conducteur, le gateway attend `evaluateAutomaticRideProgressForTrip` **avant** la diffusion `driver_location` et l'accusé de réception. Le chemin passager attend également la progression et des vérifications de proximité.

L'évaluation relit les réservations actives du trajet et exécute leurs étapes de récupération/dépose. Certaines transitions attendent `sendNotification`, dont l'implémentation attend effectivement la livraison externe (`notifications.service.ts:329`, `:435`). Une notification lente peut donc retarder un événement GPS alors que la position est déjà persistée.

Le coalescer est utile : une évaluation active et au plus une relecture en attente par trajet, avec **1 000 ms entre démarrages**. Un second appel rapproché peut attendre le reste de cette seconde, même si son opération est courte. Ce mécanisme est local au processus ; ce n'est pas un verrou distribué. Il ne bloque pas les autres trajets et ne doit pas être supprimé sans remplacement.

**Action recommandée :** séparer accusé/diffusion de position durablement acceptée et progression métier asynchrone durable, avec déduplication, ordre et reprise. Conserver la validation d'appartenance, les timestamps, l'historique GPS et l'idempotence des paiements. Déporter les notifications des transitions dans l'outbox.

**Validation :** fournisseur push artificiellement lent, GPS rapprochés conducteur/passager, redémarrage et deux instances API ; vérifier à la fois la latence des positions et la récupération/dépose sans événement perdu ni double facturation.

### 6. P2 — Des contrôles financiers globaux sont répétés dans chaque API

Sources : `src/bookings/bookings.service.ts:279`, `:287`, `:359`, `:384` ; `src/wallet/wallet-integrity.ts:5` ; `src/app.module.ts:76` ; `src/database/typeorm-options.ts:113`.

Toutes les cinq minutes, `reconcileTokenTripSettlements` traite au plus 50 candidats, **mais** réalise ensuite deux diagnostics non bornés à ces 50 : décompte historique d'anomalies de règlement et agrégation de tout le journal comptable par compte. Le drapeau `financialReconciliationRunning` empêche un chevauchement dans une instance seulement.

Le scheduler étant chargé avec l'API, plusieurs réplicas peuvent exécuter ces diagnostics globaux au même instant. Leur coût croît avec l'historique et partage la base avec le trafic interactif. Cela n'établit ni un double débit ni une contention effectivement observée dans la fenêtre précédente.

**Action recommandée :** une prise de tâche distribuée, des contrôles incrémentaux sur les comptes modifiés, et un contrôle global périodique conservé dans un worker avec budget temporel. Ne pas désactiver le contrôle comptable ni réécrire automatiquement des soldes depuis l'agrégation.

**Validation :** une seule exécution globale avec deux instances ; reprise après crash ; couverture des anomalies anciennes ; temps SQL et attentes du pool avant/après.

### 7. P2 — Plusieurs vues de gestion et historiques chargent encore tout

| Chemin | Source | Coût confirmé dans le code |
| --- | --- | --- |
| Fiche utilisateur admin | `src/admin/admin.service.ts:757` | Cinq lectures d'historique en parallèle : trajets, deux collections de réservations, paiements et demandes, avec relations. Puis enrichissement des demandes. |
| Exports de parrainage | `src/admin/admin-referrals.service.ts:292`, `:309`, `:322` | `getMany()` de tous les comptes/récompenses/retraits sélectionnés, puis construction du fichier en mémoire. Les routes d'export les appellent. |
| Tableau terrain partenaire | `src/partners/partners.service.ts:358`, `:384` | Chargement de tous les prospects d'une organisation/agent, enrichissement et agrégations JavaScript. Des lots d'enrichissement existent, mais pas de borne sur le total chargé. |
| Historique wallet legacy | `src/wallet/wallet.service.ts:165`, `src/wallet/wallet.controller.ts:84` | Journal complet de l'utilisateur ; une variante paginée existe déjà. |

**Impact :** un compte ou une organisation anciennement actif peut coûter bien plus qu'un compte neuf. Une fiche admin peut mettre en concurrence cinq requêtes initiales dans un pool API dont la valeur **par défaut** est dix connexions ; la configuration effective peut la remplacer.

**Action recommandée :** résumé SQL séparé des sous-listes paginées ; chargement à la demande par onglet ; exports par curseur/stream avec contrôle de débit ou job asynchrone. `src/admin/streaming-export.ts` offre déjà un modèle pour d'autres exports. Ne pas tronquer silencieusement les totaux financiers.

**Validation :** comptes à historique volumineux, mémoire maximale, taille des réponses et stabilité des totaux ; vérifier que les clients utilisent réellement la route paginée.

### 8. P2 — Durée de cache erronée : 1 000 jours au lieu de 24 heures

Sources : `src/common/route-preview.ts:22` ; `src/common/utils/redis-cache-store.ts:15`, `:77`.

Le helper transmet `86_400_000`, calculé en millisecondes. Le magasin Redis le traite en secondes et appelle `SETEX` avec cette valeur : **1 000 jours**. La preuve hors ligne utilise le vrai helper, `CacheService`, `cache-manager` et le vrai magasin, avec uniquement le client Redis remplacé.

**Impact :** accumulation inutile de clés, même si la validation de fraîcheur du lecteur peut rejeter leur contenu. Ce n'est pas la cause démontrée du temps SQL : la fenêtre mesurée n'avait pas d'éviction et la mémoire Redis était basse. L'ancienne alarme d'éviction n'est pas attribuée à ce défaut sans données supplémentaires.

**Action recommandée :** corriger l'unité au point d'appel et ajouter un test traversant l'adaptateur. Traiter les clés existantes par inspection et correction ciblées, après autorisation : ne jamais vider Redis globalement, qui contient aussi des états critiques.

### 9. P2 — Les estimations attendent des appels externes à budget élevé

Sources : `src/trip-requests/trip-requests.service.ts:477`, `:484`, `:490`, `:2287`, `:2302` ; `src/google-maps/google-maps.module.ts:10` ; `src/google-maps/google-maps.service.ts:574`, `:650`, `:735`, `:774`.

Sans coordonnées utilisables, le géocodage du départ puis de l'arrivée est attendu successivement. L'estimation attend ensuite l'itinéraire et la météo, ceux-ci en parallèle. Google Maps a un timeout par requête de **30 secondes** ; le calcul de prix ne passe pas de budget plus court à `getDirections`.

Les itinéraires trafic ont déjà un cache de 60 secondes et une clé arrondie à la minute. Les trois types de véhicules réutilisent **le même** instantané itinéraire/météo : il n'y a pas trois appels itinéraires systématiques pour les trois prix. Ce chemin n'est pas utilisé pour l'aperçu de chaque trajet dans la liste géographique étudiée.

**Action recommandée :** budget global de réponse adapté à l'estimation, appels indépendants parallélisés lorsque possible, déduplication des calculs identiques en cours et repli explicitement marqué comme estimation dégradée. Ne pas supprimer le trafic/météo ni modifier les règles tarifaires pour gagner du temps.

**Validation :** cache froid, coordonnées manquantes, timeout fournisseur et appels simultanés identiques ; vérifier les tarifs et le statut de précision retourné.

## Protections existantes à conserver

- Sélection paginée de trajets avant les jointures d'affichage ; vérification de disponibilité même après lecture du cache.
- Endpoints de demandes paginés et présélection bornée pour l'accueil.
- Claims SQL et `SKIP LOCKED` sur plusieurs outbox, délais de validité et recontrôle des destinataires. Il serait incorrect d'affirmer que tous les crons dupliquent leurs effets sur chaque réplica.
- Dispatch par vagues et concurrence bornée ; séparation de la diffusion temps réel et de l'envoi push dans l'outbox existante.
- Historique GPS borné, rejet des anciennes positions et regroupement des évaluations. Un gain de latence ne doit pas affaiblir ces garanties.
- Chat paginé avec résumés chargés en lots, listes support/admin récentes paginées et analyses serveur déjà agrégées en SQL : le vieux problème des échantillons de 1 000 lignes n'est pas généralisé à ces nouvelles routes.
- Imports Store : limites de téléchargement/décompression de 12 Mio, nombre de lignes/colonnes borné, timeout, claims de jobs et insertion par lots. Le parsing reste du travail JavaScript à surveiller, mais aucune importation lente n'a été mesurée ici.
- Contrôles d'identité ciblés sur les requêtes authentifiées. Ne pas masquer une désactivation de compte en introduisant un cache d'autorisation non invalidé.
- Pas d'appel de chiffrement/compression synchrone identifié par le balayage dans les chemins HTTP examinés. Les deux correspondances de fichiers/processus synchrones sont la lecture de certificat au démarrage et un outil de préflight KYC, pas une cause démontrée des recherches.
- Les méthodes génériques Redis `keys`/`delPattern` et `reset` existent, mais aucun appel métier chaud correspondant n'a été retrouvé dans ce balayage. Leur seule existence n'est pas retenue comme cause actuelle.

## Infra et observabilité : conséquences, pas diagnostic de saturation

Le profil Terraform local suivi dans `infra-aws/production.auto.tfvars` déclare des tâches de 512 unités CPU / 1 024 Mio et un autoscaling de 2 à 3 tâches. Ce sont des valeurs souhaitées locales, pas une nouvelle lecture de l'état AWS. `operators.tfvars` n'a pas été exposé ni modifié.

Ajouter un réplica peut répartir les requêtes, mais augmente aussi les pools et les tâches planifiées non coordonnées. Cela ne supprime ni une requête SQL coûteuse, ni un chargement intégral, ni l'attente d'un fournisseur externe. Ne pas augmenter automatiquement le pool PostgreSQL ou le nombre de workers sans mesurer les files et la capacité de la base.

Dans la fenêtre historique, CPU ECS au plus 7,09 %, RDS au plus 16,30 %, mémoire Redis au plus 2,36 % et aucune éviction. Ces agrégats ne montrent pas de saturation globale, mais peuvent masquer des pics courts et des attentes individuelles.

La couverture de traces était limitée : **deux requêtes HTTP de la sonde retrouvées**, et les succès HTTP étaient journalisés à un niveau inférieur au `warn` alors constaté. Pour la suite, instrumenter sans données personnelles :

- histogrammes HTTP/WS par route normalisée, durée SQL, nombre de requêtes par appel et attente du pool ;
- event-loop delay, mémoire/GC, durée et chevauchement des jobs ;
- âge des outbox, retard avant émission/acceptation push, temps fournisseur et suppression d'alertes périmées ;
- dates de capture, réception, persistance, diffusion et confirmation GPS ;
- cache hit/miss et durée de vie, sans identifiants sensibles ni coordonnées dans les étiquettes.

L'acceptation d'une push par le fournisseur n'est pas la réception sur le téléphone ; un span SDK S3 de signature n'est pas la preuve d'un téléchargement réseau d'image.

## Vérifications exécutées

**Tests locaux ciblés : cinq suites, 32 tests réussis**, le 19 novembre. Ils vérifient les contrats et protections existants, pas la capacité ni la performance réelle :

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/bookings/coalesced-ride-progress.spec.ts src/common/route-preview.spec.ts src/trips/trip-discovery-page.spec.ts src/trip-requests/request-pages.spec.ts src/tracking/tracking-location-ack.spec.ts
```

La suite du coalescer confirme notamment l'espacement d'une seconde et l'absence de blocage des autres trajets. La suite actuelle d'aperçu d'itinéraire passe malgré le défaut d'unité : elle ne couvre pas son interprétation réelle par le magasin Redis.

Outils temporaires locaux, non destinés au déploiement :

- `tmp/performance-code-inventory-2026-11-19.cjs` et son inventaire JSON ; syntaxe du script vérifiée.
- `tmp/check-route-preview-ttl-2026-11-19.cjs` : reproduction relancée, `actualSetExSeconds=86400000`, `expectedTtlSeconds=86400`, **zéro connexion Redis réelle**.

Pas d'exécution d'`EXPLAIN ANALYZE`, de requête métier RDS, de SMS, de paiement, de push réelle ou de test de charge supplémentaire. Pas de conclusion de capacité à 1 000 trajets simultanés.

## Ordre de travail proposé

1. Obtenir le plan représentatif de la recherche lente et ses attentes ; corriger uniquement après comparaison avant/après.
2. Borner la liste legacy et supprimer les lectures d'abonnement répétées ; corriger séparément l'unité de TTL avec un test d'adaptateur.
3. Retirer le broadcast global du démarrage HTTP et découpler les événements GPS des effets externes, en gardant une reprise durable.
4. Coordonner les diagnostics financiers ; paginer les vues historiques et les exports restants ; instrumenter les budgets externes.
5. Rejouer les scénarios sur données synthétiques représentatives : recherche, demandes, acceptation, GPS, récupération/dépose, notifications périmées, déconnexions et concurrence de jobs.
6. Après comparaison des résultats et accord explicite, réaliser une charge de production progressive avec seuils d'arrêt. Distinguer débit de recherche, trajets actifs, fréquence GPS, demandes simultanées et fan-out d'alertes ; ce ne sont pas la même charge.

Les gains chiffrés et la nécessité d'un nouveau dimensionnement restent à établir. Une migration Go ou une augmentation AWS ne remplace pas ces corrections de volume et de séquencement.

## Références techniques

- Lire et mesurer un plan ; `EXPLAIN ANALYZE` exécute la requête : [PostgreSQL — Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html).
- Le préfiltrage spatial peut exploiter les index disponibles, contrairement à un calcul de distance généralisé : [PostGIS — ST_DWithin](https://postgis.net/docs/ST_DWithin.html). L'utilisation effective dans nos expressions reste à vérifier par le plan.
