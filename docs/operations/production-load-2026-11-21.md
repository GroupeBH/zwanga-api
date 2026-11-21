# Production : contrôle après déploiement et sonde du 21 novembre 2026

**Résultat : sonde courte terminée, 48 réponses HTTP 200 valides ; latence de recherche encore à investiguer. La capacité maximale n'est pas déterminée.**

Les heures ci-dessous sont celles de Kinshasa (UTC+1), sauf mention contraire. Aucun déploiement, changement AWS ou appel d'écriture métier n'a été effectué pendant cette intervention.

## Déploiement et infrastructure vérifiés

| Composant | État constaté en lecture seule |
| --- | --- |
| ECS API | Révision 45, déploiement `COMPLETED`, 2 tâches actives, 0 en attente, 2 cibles ALB saines |
| Répartition API | Une tâche dans `eu-central-1a`, une dans `eu-central-1b` ; 0,5 vCPU et 1 Gio par tâche, collecteur de télémétrie inclus |
| Autoscaling API | Minimum 2, maximum 3 ; aucune suspension |
| RDS | PostgreSQL 18.3, `db.t4g.small`, disponible, **Single-AZ** |
| Redis/Valkey | 2 nœuds `cache.t4g.micro`, disponibles dans deux AZ ; Multi-AZ et basculement automatique activés |
| Alarmes CloudWatch | Les 20 alarmes interrogées sont restées `OK` aux contrôles du test et au contrôle différé |
| Livraison des alertes | **Aucun abonnement** au topic SNS `zwanga-api-production-alerts` lors de la vérification |

L'image des deux conteneurs API correspond au digest ECR `sha256:15698276a13df32a85d14b156c96a0cca4ff17811951d5a155cfdbce566017d7`, publié à 3 h 16 min 41 s, tagué `fd0722be626cb1a7385138725c4ffcf8b239228d`. Le service a atteint son état stable à 3 h 21 min 56 s.

Le commit du tag de production n'est pas présent dans le dépôt Git local, dont HEAD est `bf1a58d` lors du contrôle. La correspondance image ECR / tâches ECS est vérifiée, mais pas la parité exacte entre ce commit de production et tous les fichiers locaux. Ce test ne valide pas individuellement toutes les nouvelles fonctionnalités.

## Garde-fous et déroulement

Le premier précontrôle, à 3 h 24, a refusé le trafic : `Safety threshold: ecs_cpu`. La fenêtre de sécurité contenait encore les points CPU à 98,37 % et 95,24 % des minutes 3 h 19 et 3 h 20, concomitantes au démarrage des tâches. **Zéro requête HTTP** a été envoyée lors de ce refus. Les points suivants étaient revenus nettement sous le seuil.

Le précontrôle de 3 h 26 a réussi naturellement, sans modification des seuils ni des alarmes. Le script surveille directement AWS toutes les 30 secondes et arrête le trafic en cas de dégradation, même en l'absence d'abonné SNS.

Sonde exécutée avec le script existant [production-readonly.cjs](../../test/load/production-readonly.cjs), inchangé :

- Cible : `https://compute-api.zwanga-app.com`, région `eu-central-1`.
- Routes : `GET /health`, `GET /api/v1/trips` et `GET /api/v1/trips?departureCoordinates=15.28%2C-4.34&departureRadiusKm=20&minSeats=1&limit=20`.
- Paliers de 1, 2 et 4 requêtes simultanées, six rafales par palier, espacées d'au moins 10,5 secondes ; au plus 24 lectures métier par minute.
- Arrêt sur erreur HTTP, réponse invalide, latence excessive, alarme active, changement de déploiement, cible dégradée ou métrique de sécurité absente/périmée. Aucun contournement du rate limiting, aucune relance automatique.
- Pas d'authentification, de création de trajet, de GPS/WebSocket, de dispatch, de SMS/push, de KYC ni de paiement. Aucun corps de réponse ni identifiant d'utilisateur conservé.
- Les 10 tests locaux du script de sécurité ont réussi ; ce ne sont pas des tests fonctionnels complets du backend.

Trafic de **3 h 30 min 12 s à 3 h 33 min 27 s** ; résultat final `completed`, sans arrêt de sécurité. Le contrôle AWS différé de **3 h 35** a également réussi sans émettre de requête HTTP.

## Résultats HTTP

**42 lectures métier sur 42 valides**, toutes en HTTP 200 : 21 listes de 30 trajets et 21 recherches géographiques de 20 trajets. Six vérifications supplémentaires, quatre de santé et deux initiales métier, étaient également valides en HTTP 200 : **48 appels au total**, sans 429 ni 5xx dans cet échantillon.

| Lectures simultanées | Requêtes métier | Médiane client | p95 client | Maximum client |
| --- | ---: | ---: | ---: | ---: |
| 1 | 6 | 942 ms | 2 080 ms | 2 080 ms |
| 2 | 12 | 1 077 ms | 3 133 ms | 3 133 ms |
| 4 | 24 | 1 174 ms | 1 954 ms | 2 433 ms |

Sur les 42 lectures métier : médiane **1 174 ms**, p95 **2 096 ms**, maximum **3 133 ms**. Par route, le p95 est de **1 077 ms** pour la liste et **2 433 ms** pour la recherche géographique. Les contrôles de santé vont de 243 à 1 117 ms, le maximum étant la première sonde.

Ces durées client incluent le réseau, éventuellement TLS, le téléchargement et la validation. Les effectifs sont petits : le p95 des deux premiers paliers correspond à leur maximum. Il ne s'agit pas d'une charge soutenue ni d'une mesure robuste des limites.

Comparaison avec le [19 novembre](production-load-2026-11-19.md), même protocole : le p95 global passe de 2 965 à 2 096 ms, soit environ 29 % de moins dans cet échantillon ; celui du palier 4 passe de 3 689 à 1 954 ms. Les paliers 1 et 2 sont en revanche moins rapides que lors de la sonde précédente. Cache, trafic partagé, données et réseau ne sont pas contrôlés : **aucun gain uniforme ni lien causal avec un correctif particulier n'est démontré**.

## Métriques pendant le test

Les données publiées ont été relues après le test pour couvrir les quatre minutes de **3 h 30 à 3 h 33 incluses**. Les métriques de ressources utilisent les maxima/minima par minute indiqués, pas seulement une moyenne globale.

| Mesure CloudWatch | Valeur sur cette fenêtre |
| --- | ---: |
| CPU ECS, maximum | 6,00 % |
| Mémoire ECS, maximum | 19,43 % |
| CPU RDS, maximum | 16,17 % |
| Connexions RDS | 20 |
| Mémoire RDS libre, minimum | 753 Mio |
| Swap RDS, maximum | 7,26 Mio |
| Stockage RDS libre, minimum | 16,77 Gio |
| Crédits CPU RDS, point à 3 h 30 | 576 |
| CPU moteur Redis, maximum des deux nœuds | 0,52 % |
| Mémoire Redis, maximum des deux nœuds | 2,34 % |
| Évictions Redis | 0 sur chacun des quatre points de chacun des deux nœuds |
| Cibles ALB malsaines | 0 sur les quatre points |

Les p95 ALB `TargetResponseTime` par minute sont respectivement **1,250 / 1,378 / 1,492 / 1,483 s**. Ils concernent le trafic partagé, sans corrélation individuelle avec les requêtes du générateur. Ne pas soustraire ces percentiles aux percentiles client pour calculer un temps réseau.

Les séries 5xx ALB et cibles n'ont pas renvoyé de point ; cela ne prouve pas l'absence d'erreur sur tous les parcours. Les 48 réponses HTTP 200 du test sont, elles, directement vérifiées. Aucun signe de saturation CPU, mémoire ou Redis n'a été mesuré sur cette petite charge ; aucune réserve de capacité pour 1 000 trajets ne peut en être extrapolée.

## Source de lenteur : ce qui est mesuré et ce qui reste à prouver

La lecture filtrée des logs de 3 h 04 à 3 h 34 retrouve **22 événements `trip_search_slow`**, tous entre 3 h 30 et 3 h 33, avec 20 résultats chacun. Les horaires et effectifs concordent avec les recherches géographiques de la sonde, sans identifiant de corrélation permettant de l'affirmer requête par requête. Aucun événement `ERROR`/`FATAL` n'a été retrouvé par le filtre appliqué sur cette fenêtre ; ce n'est pas un audit exhaustif des logs.

| Champ des logs | Minimum | Médiane | Maximum |
| --- | ---: | ---: | ---: |
| `selectionMs` | 1 128 ms | 1 204,5 ms | 1 495 ms |
| `enrichmentMs` | 14 ms | 19,5 ms | 109 ms |
| `totalMs` | 1 148 ms | 1 233,5 ms | 1 515 ms |

La sélection représente **97,9 % du temps cumulé de ces 22 événements lents**. C'est donc la première étape à profiler, avant d'augmenter les ressources AWS. Cette proportion ne décrit pas toutes les recherches, seulement les événements dépassant le seuil de journalisation.

Dans le code local, [trips.service.ts](../../src/trips/trips.service.ts) mesure l'appel à `selectDiscoveryPage`. [trip-discovery-page.ts](../../src/trips/trip-discovery-page.ts) sélectionne une page dans un CTE matérialisé avant de charger conducteur et véhicule via `getRawAndEntities()`. Le chemin inclut le filtrage géographique, le tri par distance et rang d'abonnement, puis l'hydratation TypeORM. `selectionMs` englobe l'attente éventuelle du pool et l'aller-retour SQL : **ce n'est pas un temps d'exécution PostgreSQL isolé**. `enrichmentMs` est calculé comme `totalMs - selectionMs` et couvre le reste de la méthode.

La fenêtre X-Ray consultée contient 12 traces, toutes HTTP 200, sans erreur, faute ni throttling : dix sont des routes de santé et deux d'autres routes. **Aucune trace de recherche de trajets ni sous-segment SQL correspondant n'a été recueilli**. Le plan SQL réel, les index effectivement présents en production, le temps d'attente du pool et la correspondance exacte avec le commit déployé restent à vérifier. Aucun `EXPLAIN ANALYZE` ni changement de schéma n'a été lancé sur RDS.

## Suites prioritaires

1. **Rétablir un destinataire d'alertes** sur le topic SNS, puis vérifier sa confirmation et la réception. Rien n'a été modifié pendant ce test ; `OK` dans CloudWatch ne garantit pas la livraison d'une notification.
2. **Profiler la sélection sur la version réellement déployée** : comparer son SQL, ses migrations et ses index, mesurer séparément attente du pool / exécution SQL / hydratation, obtenir un plan sur un environnement représentatif. Tout plan exécutant la requête en production doit être borné et explicitement cadré. Le guide PostgreSQL a servi à conserver cette distinction entre mesure et hypothèse, sans proposer d'index à l'aveugle.
3. **Compléter les traces de recherche** pour corréler une requête à ses dépendances, sans augmenter globalement l'échantillonnage ni journaliser de données personnelles par défaut.
4. **Préparer la vraie validation de capacité dans un environnement isolé représentatif** : trajets et comptes synthétiques, prestataires payants/notifications réelles désactivés, fréquence GPS et cadence de demandes définies. Tester séparément concurrence, endurance, files d'alertes, autoscaling et reprise après panne. Le RDS Single-AZ reste un point de disponibilité non testé ici.

Conclusion : le déploiement est stable et les deux parcours publics testés répondent correctement sous la charge bornée. **La recherche reste lente côté sélection ; la limite de capacité et les flux métier authentifiés ne sont pas validés.**

## Pièces de mesure locales

Ces fichiers bruts restent dans `tmp/production-load-results/`, ignoré par Git :

- `2026-11-21T02-24-41-208Z/report.json` : précontrôle refusé, zéro HTTP.
- `2026-11-21T02-26-42-673Z/report.json` : précontrôle réussi.
- `2026-11-21T02-29-57-498Z/report.json` : sonde terminée et mesures HTTP.
- `2026-11-21T02-35-02-139Z/report.json` : contrôle différé et métriques publiées couvrant la fin du test.
- `release-inspection-2026-11-21T02-29-05-113Z.json` et `release-inspection-2026-11-21T02-34-00-192Z.json` : inspection bornée et expurgée des tâches, images, logs et traces.

Seul ce rapport est ajouté aux fichiers suivables du dépôt. Aucune configuration de production ni code applicatif n'a été modifié.

## Correctifs locaux après la sonde

Cette section concerne l'intervention suivante, demandée après la remise du rapport : **correctifs locaux, non déployés**. Les mesures de production ci-dessus décrivent toujours la révision 45 avant ces corrections.

La lecture des fichiers `trips.service.ts` et `trip-discovery-page.ts` au commit GitHub tagué dans ECR confirme la présence des deux chemins examinés dans la version déployée. Le banc synthétique initial, sans véhicule ni abonnement, ne couvrait pas leur coût.

Le banc complété contient 5 000 utilisateurs, trajets, véhicules et abonnements. L'ancien filtre convertit la clé primaire du véhicule en texte ; le plan relit aussi séquentiellement les utilisateurs pour chaque trajet lorsque l'estimation géographique est trop basse. Les vérifications ont été remplacées par des recherches scalaires sur les clés primaires UUID, sans changer les règles de disponibilité. La liste en cache revalide toujours comptes et véhicules ; les filtres, priorités premium et curseurs restent appliqués avant la réponse.

Une comparaison locale du même résultat ordonné mesure **16 931 ms avant contre 136 ms après** sur ce jeu dense ; une seconde exécution complète mesure **10 837 ms contre 75 ms**. Les plans corrigés utilisent les index des utilisateurs et véhicules au lieu de leurs parcours séquentiels répétés. Ces durées dépendent du poste et de la charge locale : elles ne prédisent pas la latence RDS après déploiement. Aucun nouvel index ni migration n'est nécessaire pour ce correctif.

Les événements lents disposent maintenant de `poolWaitMs`, `databaseRoundTripMs`, `ormMs`, `queryCount`, `preparationMs` et `postSelectionMs`. Le temps aller-retour inclut transport et décodage du pilote : ce n'est pas un temps d'exécution SQL pur. Un span `trips.discovery.select` suit l'échantillonnage OpenTelemetry existant ; aucun SQL, paramètre, résultat ou exception contenant des données personnelles n'y est enregistré. Les mesures restent internes, sans changement du contrat HTTP.

Validation ciblée : **93 tests Jest**, dont 9 tests PostgreSQL/PostGIS exécutés sur des clusters jetables, et **29 tests Node** de garde-fous CI/infrastructure réussis. Compilation NestJS réussie. Les nouveaux modules de requête passent ESLint ; le contrôle large des fichiers historiques signale encore leur dette de formatage/typage, sans réécriture globale de `trips.service.ts`. La configuration Terraform, son format et le contrôle documentaire sont valides. Les tests n'appellent ni base applicative ni prestataire réel.

La configuration SNS et le précontrôle sont renforcés comme décrit dans le [journal infrastructure](../../infra-aws/docs/CHANGELOG.md). Le nouveau précontrôle a bien refusé le trafic en l'absence d'abonnement confirmé (`tmp/production-load-results/2026-11-21T07-11-50-774Z/report.json`). Aucun nouvel essai de charge n'a été lancé. Le plan privé `infra-aws/alerts-production-20261121.tfplan`, limité à **1 ajout d'abonnement SNS, 0 modification, 0 suppression**, a ensuite été autorisé.

## Activation des alertes après autorisation

L'abonnement a été créé en production puis confirmé par le destinataire le 21 novembre. L'application Terraform a été interrompue par son délai après la création : son verrou résiduel a été libéré après vérification de l'absence de processus actif, puis l'abonnement existant a été importé à la place de l'ancienne référence absente d'AWS. La sauvegarde privée permet de vérifier que les autres instances de ressources gérées sont inchangées. Le state réconcilié est au numéro de série 51, avec `pending_confirmation=false` et sans verrou résiduel. Ne pas réutiliser l'ancien plan.

Le précontrôle AWS du 21 novembre à 17 h 29 (Kinshasa) est réussi : **20 alarmes OK, 1 abonnement email confirmé, zéro requête HTTP**. Son rapport reste privé dans `tmp/production-load-results/2026-11-21T16-29-25-194Z/report.json`. Ce contrôle ne mesure ni la latence corrigée ni la capacité de production et ne remplace pas un essai de réception d'alerte opérationnelle. Le bucket du state n'a pas de versioning activé ; cette protection reste à préparer séparément.

Il reste à déployer le backend après revue et à vérifier la réception d'une notification de contrôle autorisée. Refaire ensuite le précontrôle et la même sonde bornée avant d'envisager un palier supplémentaire. Ne pas modifier l'infrastructure de calcul pour compenser une lenteur SQL non mesurée après correction.
