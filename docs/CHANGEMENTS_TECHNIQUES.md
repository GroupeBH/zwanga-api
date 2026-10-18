# Journal des changements techniques

## 18 octobre 2026 — Synchronisation du test PostgreSQL de dispatch

- Le déploiement GitHub Actions #61 s'est arrêté sur un unique `deadlock detected`
  dans le `beforeEach` de `dispatch-postgres.spec.ts`, avant les étapes AWS.
  `respond()` lance intentionnellement un cycle avec `void this.tick()` ; le
  nettoyage `TRUNCATE users CASCADE` pouvait commencer pendant ce cycle.
- Correction limitée au test : espion Jest avec implémentation réelle conservée,
  suivi des promesses retournées par `tick()`, attente avec `Promise.allSettled`
  après chaque cas, avant le nettoyage et avant la fermeture de la connexion.
  Une éventuelle promesse rejetée reste un échec après attente des autres cycles.
  Relancer simplement `tick()` ne suffirait pas : son garde anti-chevauchement
  retourne immédiatement lorsqu'un cycle est déjà actif.
- Régression ajoutée : une allocation est retenue par une barrière explicite,
  la réponse au conducteur reste immédiate, et la préparation du nettoyage doit
  attendre la fin du cycle d'arrière-plan. Pas de délai arbitraire, de retry du
  `TRUNCATE`, de test désactivé ni de changement du service applicatif.
- Vérification : **37 tests réussis lors de chacun des trois passages** sur
  PostgreSQL 18/PostGIS local jetable (environ 66 s, 44 s et 49 s). Rapports :
  `tmp/dispatch-sync-1.json`, `tmp/dispatch-sync-2.json`, `tmp/dispatch-sync-3.json`.
  Le contrôle `tsc -p tsconfig.build.json --noEmit --incremental false` passe.
  Le contrôle TypeScript global, incluant toutes les suites de tests, échoue
  sur des erreurs dans d'autres fichiers de tests non modifiés ; aucune erreur
  signalée dans le fichier corrigé. Aucun succès global de typage n'est revendiqué.
- Le guide PostgreSQL a orienté la correction vers la séparation du nettoyage
  et des transactions actives, sans modifier les verrous métier. Aucun changement
  CI/CD, Terraform ou AWS, aucun push ni redéploiement ; la validation distante
  PostgreSQL 16/Linux ARM64 reste à effectuer après publication du correctif.

## 18 octobre 2026 — Diagnostic mémoire RDS en lecture seule

Complément au précontrôle ci-dessous, sans lancer le test de charge ni changer
AWS, Terraform, le CI/CD, le backend ou les paramètres PostgreSQL. Aucun secret
récupéré, aucune connexion SQL ouverte, aucune requête HTTP applicative envoyée.

- **Périmètre mesuré :** sept jours de métriques CloudWatch jusqu'au 18 octobre
  vers 11 h 38, heure de Kinshasa, par périodes de dix minutes ; 360 mesures
  Enhanced Monitoring à la minute sur les six dernières heures ; compteurs
  agrégés sur 11 888 événements PostgreSQL exportés, environ 2,73 Mo analysés.
  Les séries CloudWatch sont complètes et la pagination des journaux système
  a été épuisée. Rapport local filtré, sans messages SQL ni noms de processus
  applicatifs : `tmp/rds-memory-diagnosis/2026-10-18T10-38-27-216Z/report.json`.
- **Mémoire disponible CloudWatch :** moyenne d'environ **64,2 Mio**, minimum
  **22,6 Mio**, dernière moyenne sur dix minutes **70,3 Mio**. Les moyennes
  journalières restent entre environ 59 et 68 Mio : faible marge durable, sans
  diminution continue démontrée sur cette semaine.
- **Swap :** les maxima par période culminent à **170,5 Mio** sur la semaine,
  dernier maximum **116,8 Mio**. Les mesures système distinctes sur six heures
  passent d'environ **128,3 à 122,5 Mio** de swap utilisé. Les compteurs système
  montrent des échanges non nuls, mais l'attente d'I/O CPU reste en moyenne à
  **0,97 %**, au maximum **2,7 %**, sans tâche bloquée dans les échantillons.
  Ce n'est pas une preuve de saturation disque ni de swap complètement inactif.
- **Autres ressources :** CPU RDS maximal **27,4 %** sur sept jours, connexions
  réseau clientes généralement **10**, pics ponctuels à **20**. Crédits CPU
  au minimum **287,2**, stockage libre au minimum **16,81 Gio**, profondeur de
  file disque maximale **0,30**. Les moyennes de latence disque par période
  sont d'environ **0,72 ms en lecture / 0,67 ms en écriture** sur la semaine ;
  elles ne mesurent pas les temps des requêtes SQL ou de l'application.
- **Pas d'incident mémoire identifié dans les journaux examinés :** aucun des
  motifs recherchés pour OOM, échec d'allocation, signal 9, épuisement des
  connexions, réinitialisation, deadlock ou statement timeout. Cela ne garantit
  pas l'absence de tout incident : la portée dépend des journaux exportés et
  des motifs recherchés. Les événements RDS consultés ne montrent que des
  sauvegardes sur sept jours, pas de redémarrage signalé.
- **Répartition système :** environ **921 Mio** visibles par l'OS ; groupe
  agrégé « RDS processes » entre **406 et 444 Mio** de RSS ; cache de fichiers
  entre **170 et 235 Mio**. Ces mesures ne forment pas une comptabilité additive
  (pages partagées, agrégats). `memory.free` système et `FreeableMemory`
  CloudWatch ne sont pas interchangeables : cette dernière reflète
  `MemAvailable`. Ne pas ajouter arbitrairement le cache à la marge disponible.
- **Configuration :** instance `db.t4g.micro`, PostgreSQL 18.3, `available`,
  Single-AZ, groupe `default.postgres18` synchronisé, aucune modification en
  attente. Enhanced Monitoring est déjà actif à 60 secondes ; Performance
  Insights n'est pas activé. Les paramètres du groupe exposent les formules
  AWS par défaut, pas nécessairement les valeurs effectives de `pg_settings`.
  Le code local plafonne le pool API à 10 par défaut, mais sa configuration
  effectivement déployée n'a pas été certifiée par une connexion SQL.

**Conclusion :** marge mémoire structurellement faible, sans fuite ni panne
mémoire démontrée. Le refus de charge reste une précaution du banc (128 Mio),
pas la preuve d'une interruption imminente. L'attribution exacte aux requêtes
nécessiterait des statistiques SQL supplémentaires via un accès autorisé.
Le guide PostgreSQL a orienté le contrôle du pool et l'interprétation prudente
des mesures ; aucune augmentation aveugle des connexions ou de `work_mem`.

**Suite recommandée, non appliquée :** fiabiliser les alarmes mémoire et Redis,
envisager `db.t4g.small` (2 Gio au lieu de 1 Gio) pour davantage de réserve,
puis remesurer avant toute charge. Le redimensionnement doit être approuvé et
planifié avec une interruption potentielle, particulièrement en Single-AZ ;
ni le gain de capacité ni une absence de coupure ne sont garantis par cet audit.

Références : [définitions des métriques RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html),
[interprétation de la mémoire PostgreSQL par AWS](https://aws.amazon.com/blogs/database/understand-memory-management-in-amazon-rds-for-postgresql-to-avoid-out-of-memory/),
[caractéristiques des classes RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html).

## 18 octobre 2026 — Précontrôle du test de charge en production : charge non lancée

- Autorisation : test bref et plafonné sur les lectures, sans changement AWS.
  Vérifications vers **11 h 26–11 h 30, heure de Kinshasa (UTC+1)**. Deux passages
  de précontrôle AWS seulement ; **zéro requête HTTP applicative de test envoyée**.
  Le second rapport indique `preflight_refused`, pas un test réussi ou une capacité
  mesurée : `tmp/production-load-results/2026-10-18T10-29-49-048Z/report.json`.
- **Motif de refus préventif :** RDS `db.t4g.micro`, PostgreSQL 18.3, présente
  environ **60–78 Mio de mémoire disponible** sur les quinze minutes précédentes
  (70 Mio au dernier point), avec **116–118 Mio de swap utilisé**. Le seuil local
  de sécurité du banc est 128 Mio ; ce n'est pas un seuil universel imposé par AWS.
  La lecture complémentaire sur une heure confirme une faible marge persistante.
  Un niveau de swap non nul ne prouve pas à lui seul une panne ni des échanges
  disque actifs ; aucun diagnostic de fuite mémoire n'est établi ici.
- La base est `available`, CPU maximal **5,84 %**, **10 connexions**, environ
  **16,8 Gio de stockage disponible**, crédits CPU non épuisés. ECS a une tâche
  active et stable, cible ALB `healthy`, CPU maximal **10,41 %**, mémoire maximale
  **18,95 %** sur la fenêtre. Redis est disponible, CPU moteur inférieur à 0,49 %,
  mémoire autour de 3,64 %. Ces observations ne prouvent pas une tenue sous charge.
- **Supervision à corriger ultérieurement :** aucune alarme retournée pour
  `AWS/RDS / FreeableMemory` avec la dimension de cette base. Les alarmes Redis
  CPU/mémoire sont `INSUFFICIENT_DATA` avec la dimension `ReplicationGroupId` ; les
  métriques existent bien avec `CacheClusterId` + `CacheNodeId`. Les dimensions des
  alarmes sont donc à vérifier. Aucun correctif d'alarme/Terraform appliqué.
- Version observée : définition ECS `zwanga-api-production-api:20`, image API
  `sha256:20d44b95608708ddef28595ce3458d0bfa0f3d32adac37d1217eb5325cad25bc`,
  tag ECR `30ef4d254c96e0fca198abd69272b7867d4b9c40`, publiée le 15 octobre.
  Le checkout local est `d5e3268c9c6992ea0e87d108392f8f6d7146947e` ; le commit du
  tag de production n'est pas disponible localement pour une comparaison source.
  Les performances du code local ne sont pas une mesure de cette image déployée.
- Banc séparé ajouté dans `test/load/production-readonly.cjs` : cible HTTPS fixe,
  liste blanche de trois GET (health, liste et recherche de trajets), rafales de
  1/2/4 lectures, 42 lectures métier prévues, au plus 24/minute pour le même handler,
  arrêt dur avant cinq minutes. Pas de JWT, de faux `X-Forwarded-For`, de retry,
  de redirection automatique ni de réponse utilisateur enregistrée. Les quotas,
  erreurs, latences, états ECS/ALB et métriques peuvent arrêter le test. CloudWatch
  étant différé, ses alertes ne garantissent pas une réaction instantanée à toute
  dégradation. Les seuils du banc n'ont pas été abaissés pour forcer son exécution.
- Réexécuter **uniquement les lectures AWS** :
  `node test/load/production-readonly.cjs --preflight`.
  Le mode actif exige un argument explicite et une autorisation opérateur ; il
  n'a **pas été exécuté** pendant cette intervention. Six tests hors réseau du
  banc et deux tests de l'isolation locale passent ; aucun changement backend,
  secret, CI/CD, infrastructure, migration ou ressource distante créée.
- Suite proposée : examiner la consommation et le dimensionnement mémoire RDS,
  fiabiliser les alarmes, puis refaire le précontrôle avant toute montée en charge.
  Le guide PostgreSQL a conduit à mesurer cette marge sans augmenter le pool.
  Voir les définitions de [FreeableMemory et SwapUsage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html)
  et les [recommandations AWS sur la mémoire RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Troubleshooting.html#CHAP_Troubleshooting.FreeableMemory).

## 18 octobre 2026 — Pagination des commandes et transferts rejoués : préparation mobile

Ajout d’endpoints paginés authentifiés (commandes disponibles/personnelles et offres),
sélection bornée avant hydratation, recherche paramétrée et curseurs précis.
Référence optionnelle de transfert : un rejeu identique est reconnu sous les
verrous des portefeuilles sans refaire le débit. Les anciens clients et les
règles de solde restent compatibles. Migration 1780000075000 préparée pour les
index de pagination et l’unicité comptable, avec budgets DDL transactionnels.

64 tests ciblés réussis et typage validé ; repositories/DDL simulés, pas de test
de concurrence PostgreSQL réelle. Aucune migration exécutée, aucun déploiement
ou changement AWS. Livraison backend avant mobile ; les anciennes lectures de
l’accueil/recherche/compteurs restent un travail séparé pour ne pas tronquer les
actions prioritaires. Détails et précautions :
[Correctifs backend de l’audit mobile](operations/mobile-audit-fixes-2026-10-18.md).

## 18 octobre 2026 — Correctifs locaux après le test de charge

- **Périmètre :** code backend, tests et documentation uniquement. Aucun changement
  AWS, Terraform, CI/CD, `.env`, fournisseur OTP/KYC ou base existante durant cette
  intervention. Les autres modifications déjà présentes dans le dépôt sont conservées.
- **Cache public des trajets :** les propriétés `undefined` du DTO ES2023 ne sont
  plus considérées comme des filtres. `GET /trips` sans query utilise le cache
  existant ; `false`, `0`, un tri ou une pagination explicites continuent à passer
  par la recherche. Les départs devenus passés sont exclus aussi lors d'un cache hit.
  Sur un cache miss, `findAll` réutilise `search({})` : la limite de 30, la priorité
  Pro avant pagination et le tableau JSON restent identiques au parcours public
  observé avant correction. La clé existante est conservée pour les invalidations.
  Un test PostgreSQL avec 31 trajets et un conducteur Pro placé en dernière date
  vérifie cette équivalence, puis une deuxième lecture sans SQL.
- **Recherche géographique :** le plan réel montrait 5 000 passages dans les
  jointures conducteur/véhicule avant le `LIMIT`. Une CTE matérialisée TypeORM
  sélectionne maintenant les identifiants et clés de tri de la page avant de
  joindre les relations (au plus `limit + 1`, soit 51). Une seule instruction SQL,
  donc un seul instantané ; pas de requête supplémentaire par trajet. Aucun nouvel
  index ni réglage du pool/JIT. Le rayon PostGIS, le GPS frais de moins de 90 secondes,
  son repli sur le départ, les trajets privés et le classement Pro sont conservés.
  Un premier essai séparant les branches géographiques n'a pas amélioré les mesures
  et a été retiré ; le prédicat géographique initial reste en place.
- **Pagination :** les nouveaux curseurs opaques conservent le timestamp PostgreSQL
  exact, microsecondes comprises. Les anciens curseurs ISO restent acceptés avec
  conversion en `Date`, pour éviter de comparer un horaire UTC comme un timestamp
  local sans fuseau. Les tests reproduisent le doublon de frontière puis vérifient
  les pages suivantes/précédentes, le tri Pro et les anciens curseurs.
- **Démarrage compilé :** déplacement de l'import de la migration 75 avant le
  registre qui la référence ; évite une erreur d'initialisation CommonJS. Contenu
  et ordre des migrations inchangés. Un test transpile et évalue le registre sans
  exécuter les migrations. Les migrations de fonctionnalités déjà ajoutées par
  ailleurs ne font pas partie de cette optimisation.
- **Reproduction isolée (PowerShell) :** utiliser une sortie dédiée pour ne pas
  interférer avec `dist` et un éventuel serveur en mode watch. Ces variables sont
  propres au banc local et ne doivent pas être ajoutées à AWS.

  ```powershell
  node node_modules/typescript/bin/tsc -p test/load/tsconfig.json
  node --test test/load/isolation.test.cjs
  $env:LOAD_TEST_BUILD_DIR = Join-Path (Get-Location) 'node_modules/.cache/zwanga-load-build'
  $env:LOAD_TEST_DIAGNOSTICS_ONLY = '0'
  node test/load/run.cjs
  ```

  `LOAD_TEST_DIAGNOSTICS_ONLY=1` permet seulement un EXPLAIN sur les trajets fictifs,
  sans charge ni fixtures de réservations/notifications. Le mode complet capture
  les plans après les mesures, dans une transaction en lecture seule avec timeout.
  Il vérifie aussi trois lectures consécutives de la liste avec **zéro requête SQL**.
  Les analyses EXPLAIN ont guidé la correction conformément au skill PostgreSQL,
  sans augmentation spéculative du pool. Les fichiers de compilation temporaires
  initialement créés sous `tmp/load-build` ont été supprimés ; ils sont régénérables
  dans la sortie dédiée ci-dessus. Les rapports restent conservés.
- Vérification finale : compilation TypeScript isolée réussie, **162 tests ciblés
  dans huit suites réussis**, dont six tests PostgreSQL/PostGIS réels ; deux tests
  supplémentaires du garde réseau et de l'environnement isolé réussis. Il ne s'agit
  pas d'une exécution de toute la suite du projet. Les identifiants des comptes,
  véhicules et trajets des tests sont exclusivement synthétiques.

### Mesures après correction

- Référence : `tmp/load-results/2026-10-18T01-25-41-406Z/report.json`.
  Mesure finale : `tmp/load-results/2026-10-18T09-03-11-186Z/report.json`.
  Même PC, même volume de fixtures et mêmes paliers ; pas des exécutions simultanées
  ni un benchmark contrôlé de production. La liste conserve ses 30 trajets et la
  recherche géographique sa limite de 20 pour ce scénario. Le banc vérifie ces
  deux tailles sur chaque réponse. Le rapport intermédiaire
  `2026-10-18T08-50-05-392Z` utilisait encore la liste historique de 50 ; la mesure
  finale ci-dessus le remplace pour la comparaison.

| Scénario | p95 avant → après | Débit avant → après (req/s) |
| --- | ---: | ---: |
| Liste publique, concurrence 10 | 352 → 33 ms | 49,3 → 383,8 |
| Géographie, concurrence 10 | 1 258 → 422 ms | 13,4 → 44,4 |
| Mixte, concurrence 1 | 348 → 128 ms | 8,9 → 25,9 |
| Mixte, concurrence 10 | 767 → 243 ms | 37,7 → 107,1 |
| Mixte, concurrence 30 | 1 327 → 527 ms | 40,6 → 104,6 |
| Mixte, concurrence 60 | 1 867 → 1 148 ms | 42,6 → 99,3 |
| Profil, concurrence 10 | 121 → 97 ms | 128,0 → 144,3 |
| Notifications, concurrence 10 | 102 → 59 ms | 165,3 → 243,8 |

- **14 468 requêtes mesurées**, toutes HTTP 200 et contenu valide, en 105,3 secondes
  de charge cumulée. Zéro SQL sur les 4 615 lectures de liste chaude ; recherche
  géographique toujours à trois SQL par réponse, profil huit et notifications quatre.
  Les 429/401 des vérifications de sécurité sont attendus et séparés des mesures.
- EXPLAIN normal : environ **431 → 91 ms**, jointures utilisateurs/véhicules
  **5 000 → 21 itérations**, désormais via index. Plan avant dans
  `tmp/load-results/2026-10-18T08-38-27-829Z/report.json` (diagnostic trajets seuls),
  plan après inclus dans le nouveau rapport complet. Aucun changement JIT retenu.
- Cache validé sur trois lectures consécutives ; quota réel 30 succès puis 5 refus
  429 ; dix refresh simultanés donnent un succès et neuf refus 401, ancien access
  token rejeté, nouveau accepté. Aucune tentative de connexion externe enregistrée.
- **Limites restantes :** à concurrence 60, jusqu'à 95 acquisitions du pool en
  attente, malgré le meilleur débit. Le profil reste coûteux (huit SQL). RSS maximal
  d'environ 335 Mo ; retour à faible charge p95 134 ms, pool sans attente. Il reste
  nécessaire de tester la durée, les pannes et un environnement représentatif avant
  toute conclusion de capacité AWS. Les gains du profil/notifications ne sont pas
  attribuables aux seuls correctifs trajets sur ce PC partagé.
- Backend de charge et Redis arrêtés, cluster PostgreSQL et données temporaires
  supprimés automatiquement ; seuls les rapports/logs et fichiers de compilation
  régénérables restent sur disque. Aucune ressource de production touchée.

## 18 octobre 2026 — Banc de charge HTTP local isolé

- Exécution reproductible : `npm.cmd run build`, puis
  `node --test test/load/isolation.test.cjs` et `node test/load/run.cjs`.
  PostgreSQL avec PostGIS est requis (Windows : PostgreSQL 18 par défaut,
  surcharge possible avec `LOAD_TEST_PG_BIN`) ainsi que Redis (Windows : Ubuntu
  WSL). Aucune nouvelle dépendance npm. Ne pas lancer contre un serveur existant.
- Le banc ne propose volontairement aucune URL cible : il crée PostgreSQL,
  Redis et un backend éphémères sur des ports loopback, sans charger `.env` ni
  hériter des secrets. Un garde réseau bloque les connexions TCP du backend
  sauf vers ses deux dépendances de test. Les processus et données temporaires
  sont nettoyés dans le bloc de fin, y compris en cas d'échec.
- Données fictives : 1 000 comptes, 200 véhicules, 10 000 trajets,
  20 000 réservations et 50 000 notifications, insérées par lots.
  Les vrais contrôles JWT et le limiteur Redis restent actifs ; les adresses
  proxy simulées sont acceptées uniquement par le serveur loopback de ce banc.
  Vérification séparée du quota et de dix refresh concurrents sur une session.
- Paliers mixtes de 1, 10, 30 et 60 requêtes simultanées, puis mesures par route
  (liste des trajets, recherche géographique, profil et notifications) et retour
  à faible charge. Chaque palier dure 12 secondes, configurable entre 2 et 30
  avec `LOAD_TEST_STAGE_SECONDS`. Rapports JSON et logs dans `tmp/load-results/`.
  Il s'agit d'une charge en boucle fermée, pas d'un nombre d'utilisateurs actifs
  ni d'un débit imposé. Les latences comprennent l'attente des réponses complètes.
- Limites : générateur et services partagent le PC ; schéma de test issu des
  entités et index de lecture, sans triggers financiers ni contrôle readiness
  du schéma financier. Cron, trafic WebSocket, OTP, KYC, paiements, push externes,
  ALB/TLS, panne de dépendance et haute disponibilité ne sont pas évalués.
  Ces mesures ne donnent pas la capacité de l'infrastructure AWS.
- Aucun changement du code métier, de Terraform, du CI/CD ou d'AWS pour ce test.

### Résultat de l'exécution locale du 18 octobre

- Rapport brut : `tmp/load-results/2026-10-18T01-25-41-406Z/report.json`.
  6 078 requêtes mesurées en 107,3 secondes de charge cumulée, toutes HTTP 200
  avec contrôle du contenu. Les 429/401 des vérifications de protection sont
  attendus et comptés séparément. Deux premiers essais ont échoué pendant la
  préparation des fixtures (alias SQL ambigu, puis insertion trop volumineuse),
  avant les mesures ; leurs ressources ont également été nettoyées.
- Charge mixte : concurrence 1 / 10 / 30 / 60, débit respectif
  8,9 / 37,7 / 40,6 / 42,6 requêtes/s, p95 348 / 767 / 1 327 / 1 867 ms.
  La hausse de concurrence améliore peu le débit au-delà de 10 : le pool de
  10 connexions atteint 79 acquisitions en attente au palier 60. Ce sont des
  attentes de connexion, pas 79 connexions supplémentaires ni 79 utilisateurs.
- Routes isolées, concurrence 10 : liste 49,3 req/s (p95 352 ms), recherche
  géographique 13,4 req/s (p95 1 258 ms), profil 128,0 req/s (p95 121 ms),
  notifications 165,3 req/s (p95 102 ms). Le profil exécute huit requêtes SQL
  par réponse, les notifications quatre et chaque lecture des trajets trois.
- Défaut confirmé sans correction métier : `TripsController.findAll` teste
  `Object.keys(searchTripsDto).length`. Le DTO compilé ES2023 contient quinze
  propriétés même quand la query est vide ; la route appelle donc `search`,
  non `findAll`, et ne bénéficie pas du cache prévu pour la liste. Reproduction
  avec `plainToInstance(SearchTripsDto, {})` et observation de 3 SQL par requête.
  Le libellé historique `trips_cached` du rapport désigne cette liste sans
  filtre, **pas une preuve de cache hit** ; le banc utilise désormais le nom
  neutre `trips_list`. La recherche géographique est la route la plus lente de
  cet échantillon ; identifier sa cause exacte nécessite des plans SQL et des
  mesures supplémentaires, pas une augmentation aveugle du pool.
- Protections : 30 requêtes acceptées puis 5 réponses 429 pour une même IP ;
  dix refresh concurrents donnent un succès et neuf refus 401 ; ancien access
  token refusé, nouveau accepté. Aucun essai de connexion externe observé.
- Retour à faible charge : p95 459 ms contre 485 ms lors de l'échauffement,
  sans attente du pool. Mémoire RSS du backend : pic d'environ 340 Mo ; un test
  aussi court ne permet pas de conclure à l'absence de fuite mémoire.
- Contexte : Windows, i7-1185G7, 8 processeurs logiques, 15,7 Gio de RAM,
  Node 24.11, PostgreSQL 18/PostGIS 3.6 et Redis 7.0.15 via WSL, sur le même PC
  que le générateur et les autres applications. Aucune projection de capacité
  ECS/RDS. Build et deux tests de l'isolation réussis. Backend/Redis arrêtés,
  cluster PostgreSQL et répertoire temporaire supprimés ; rapports conservés.

## 18 octobre 2026 — Activation du mode Didit natif en production AWS

- **Demande et constat :** utiliser le SDK Didit sur mobile. Le paramètre
  `/zwanga-api/production/env/DIDIT_KYC_LAUNCH_MODE` était encore `hosted` en
  production ; `/zwanga-api/production/env/KYC_PROVIDER` valait déjà `didit`.
- **Action exécutée :** passage du seul mode de lancement à `native` dans SSM,
  version 2, le 18 octobre à 01:16:55 (Africa/Kinshasa). Type `SecureString`,
  clé KMS et niveau Standard conservés. Fournisseur Didit inchangé ; aucune
  clé API, aucun workflow ni paramètre OTP modifié.
- **Prise en compte :** renouvellement progressif du service
  `zwanga-api-production-api`, cluster `zwanga-api-production-cluster`, région
  `eu-central-1`. Même définition de tâche `:20` et même image backend immuable
  `sha256:20d44b95608708ddef28595ce3458d0bfa0f3d32adac37d1217eb5325cad25bc`.
  Aucun nouveau code, migration SQL, plan/apply Terraform ou changement CI/CD.
- **Vérifications réelles :** relecture SSM des deux valeurs et références de
  la définition ECS ; nouvelle tâche `HEALTHY` et cible ALB `healthy` ; réponses
  HTTP 200 de `/health/live` et `/health`. Déploiement `COMPLETED` à 01:20:07,
  service stable avec une tâche active, aucune tâche en attente. ECS Exec est
  désactivé : pas d'inspection directe de l'environnement à l'intérieur du
  conteneur ; les paramètres sont référencés sans version figée et la tâche a
  été créée après leur mise à jour.
- **Limites :** aucun KYC réel/SDK sur téléphone exécuté. Les apps déjà
  installées utilisent leur logique existante quand elles reçoivent un jeton
  SDK ; les correctifs mobiles locaux ne sont pas distribués par cette action.
  Le fichier Terraform local prévoit déjà `didit_kyc_launch_mode = "native"` ;
  il n'a pas été modifié. Les constats « aucune action AWS » de l'intervention
  précédente ci-dessous concernaient les correctifs locaux avant cette demande.
- **Retour arrière si nécessaire :** remettre uniquement le mode SSM à `hosted`
  puis renouveler ECS avec la même image. Non exécuté.

## 18 octobre 2026 — Correctifs d'audit locaux et maintien du KYC Didit natif

- Sessions : rotation conditionnelle des empreintes de jetons pour ne pas rétablir
  une session révoquée pendant un refresh concurrent. Formats JWT et durées conservés.
- Fiabilité/performance : envois OTP non rejoués aveuglément, quotas atomiques Redis,
  outbox transactionnelle pour les expirations/retards, lots bornés d'expiration,
  écritures groupées de diffusion conducteur et traitement urgent borné à cinq envois
  simultanés. Masquage des liens de suivi dans les journaux et délais DDL de la nouvelle
  migration de diffusion. Détails et limites dans
  [le suivi de l'audit](operations/audit-2026-10-18.md#suivi-des-correctifs-locaux).
- Identité : retraits contrôlés avec le dernier dossier KYC. Pour AWS seulement,
  analyse automatique conservée mais revue humaine finale tant que l'authenticité
  documentaire n'est pas établie ; aucun déclassement des approbations existantes.
- **Didit reste le parcours actuel.** Le mode backend natif exige un jeton SDK réel,
  sans substituer un identifiant ou un lien web. Côté dépôt mobile `zwanga`, le SDK
  est utilisé sur Android/iOS ; pas de repli navigateur après erreur et protection
  contre les doubles appuis. Le parcours Web reste disponible pour la cible Web.
- Aucun fichier Terraform ou CI/CD modifié pour ces correctifs, aucune action sur AWS,
  aucune modification des secrets ni des fournisseurs configurés. Les valeurs optionnelles
  des quotas et le mode Didit natif sont illustrés dans `.env.example` uniquement.
- Contrôles : compilation backend de production et typage mobile réussis ; 14 tests
  mobiles ciblés réussis ; tests PostgreSQL temporaires de session/KYC et PostGIS de
  dispatch/expiration réussis. Aucun SMS, appel KYC réel ou test sur téléphone effectué.
  Suite globale finale : 2 156 tests réussis, 266 ignorés, aucun échec ; réserves
  et suites PostgreSQL activées séparément consignées dans le suivi d'audit.

## 18 octobre 2026 — Démarrage après pause et tentatives répétées

- **Problème et périmètre :** `pauseTrip` remet un trajet à `upcoming` sans
  effacer `startedAt`, alors que `startTrip` exigeait `startedAt IS NULL`.
  Une reprise après pause avant embarquement était donc refusée avec le message
  « Le statut du trajet a changé ». Ce chemin a été reproduit par test de service ;
  aucune consultation de l'historique du compte ayant signalé l'erreur.
- **Solution :** `src/trips/trips.service.ts` distingue premier démarrage et
  reprise simple. Le premier initialise le suivi ; la reprise garde l'heure de
  début et la position, et recalcule l'arrivée depuis l'heure de reprise. La mise
  à jour atomique garde les critères trajet/conducteur/état et vérifie NULL ou
  NOT NULL selon le cas, sans égalité fragile sur le timestamp. Une tentative
  répétée ou perdante face à un autre démarrage renvoie l'état actif actualisé
  du même conducteur, sans rejouer la transition ni les notifications. Les
  autres conflits reçoivent `TRIP_START_STATE_CHANGED` avec le texte existant.
- **Conservé :** autorisation du conducteur, KYC, exclusion d'un autre trajet
  actif, index d'unicité existant, prix/places/paiements, aucun redémarrage d'un
  trajet annulé ou terminé. Le workflow d'interruption reste prioritaire et
  conserve les choix des passagers ; une reprise simple avec un passager encore
  à bord est refusée. Les appels externes restent hors de la mise à jour courte,
  conformément aux précautions du skill PostgreSQL. Pas de nouveau verrou long.
- **Tests :** `src/trips/trip-start-restart.spec.ts` ajouté. Avec
  `src/trips/trips.service.spec.ts` et `src/trips/driver-interruption.workflow.spec.ts`,
  **61 tests réussis** : pause/reprise, premiers démarrages, appels répétés et
  concurrents, annulation concurrente, états terminaux et contrôles de conducteur
  et d'interruption. Repositories/services simulés, pas de validation de
  concurrence PostgreSQL réelle. `tsc --noEmit --incremental false -p
  tsconfig.build.json` et `git diff --check` réussis.
- **Mobile associé :** lecture fraîche et unique des conflits connus, sans
  renvoyer automatiquement le démarrage ; affichage de navigation seulement si
  le serveur confirme le bon trajet en cours. Loader voiture/itinéraire partagé
  et accessible. 121 tests mobiles ciblés réussis, aperçu Web seulement.
  Détails dans `docs/DEMARRAGE_TRAJET_ET_CHARGEMENT_NAVIGATION.md` du dépôt mobile.
- **Livraison/limites :** correctif non déployé ; déploiement backend nécessaire
  et code mobile à livrer séparément. Aucune nouvelle migration, dépendance ou
  variable pour ce correctif, aucune donnée modifiée. Les autres changements
  préexistants restent distincts. Recette physique Android/iOS à effectuer ;
  aucun crash natif ou gain de performance déclaré validé.

## 17 octobre 2026 — Tous les conducteurs admissibles à 5 km et rappel de position

- **Périmètre/problème :** les commandes proches étaient proposées à un seul
  conducteur ; le mobile doit envoyer sa position hors course toutes les
  3 minutes et un rappel est demandé après plus de 6 heures sans position.
- **Solution :** dispatch.service.ts, nearby-driver-policy.ts et
  scheduled-request-alert.ts diffusent par lots de 50 à tous les conducteurs
  admissibles à 5 km. Sélection filtrée avant LIMIT, dédoublonnage par destinataire,
  poursuite par le cron existant. Les invitations immédiates verrouillent la
  commande à l'acceptation : premier gagnant, autres invitations annulées.
  trip-requests.service.ts retire le secours non géographique lorsque ce
  dispatch est activé. Les commandes programmées ouvrent toujours les détails.
- **Rappel :** stale-location-reminder.ts et le cron de dispatch.service.ts
  vérifient toutes les 5 minutes les présences de plus de 6 heures, par lots de
  100, sans rappel répété avant une nouvelle position. Outbox et marqueur sont
  transactionnels avec SKIP LOCKED. notifications.service.ts revalide avant
  livraison/réessai ; pas de sonnerie urgente ni de coordonnées dans le rappel.
- **Schéma :** migration 1780000074000-BroadcastDriverRequests.ts enregistrée
  dans migrations/index.ts ; retrait de l'unicité par commande, maintien des
  unicités par conducteur/paire, index de lecture/cron, colonne de rappel.
  Retour arrière refusé si des invitations multiples sont encore pending :
  attendre leur passage effectif au statut expired avec le nouveau worker.
  Déploiement contrôlé nécessaire, migrations non automatiques, verrous DDL
  à surveiller. Aucun changement de base applicative ou de configuration AWS ici.
- **Conservé :** droits/KYC, disponibilité, compatibilité véhicule/places,
  cinq envois urgents simultanés maximum, token courant et livraison hors
  transaction métier, limites de réessai. Fenêtre de position par défaut de
  5 minutes ; un ancien réglage inférieur utilise ce défaut. Suivi en course
  inchangé. Les changements portefeuille préexistants ne font pas partie de ceci.
- **Tests :** 115 réussis dans dispatch-postgres.spec.ts,
  scheduled-request-alert.spec.ts, scheduled-request-delivery.spec.ts,
  trip-request-alert-routing.spec.ts, driver-action-notifications.spec.ts et
  notifications.service.spec.ts. PostgreSQL 18/PostGIS temporaire réel pour
  les lots de 52, la concurrence, les seuils 4 999/5 001 m, le rappel et la
  migration aller/retour. Typage production sans émission réussi.
- **Limites :** push simulés, aucun téléphone réel ni mesure de charge globale.
  APNs/FCM et les tâches mobiles peuvent être retardés. Un rappel nécessite une
  position déjà connue ; rétention historique d'un jour inchangée. Une désactivation
  locale peut encore déclencher un rappel unique côté serveur. Pas de garantie
  de livraison simultanée ou de résolution de crash. Le mobile associé comporte
  81 tests GPS/navigation réussis et sa documentation détaillée dans
  docs/ALERTES_PROXIMITE_LOCALISATION.md du dépôt zwanga.

## 15 octobre 2026 — Réception interrompue du profil : diagnostic HTTP fiable

- **Problème constaté :** une interruption de `PUT /users/me` était journalisée
  comme une erreur serveur 500 par `LoggingInterceptor`, alors que le filtre
  global connaissait déjà certaines erreurs de réception. Cet événement isolé
  ne démontre pas la cause des fermetures Android après connexion.
- **Solution appliquée :** `src/common/http-request-abort.ts` centralise la
  reconnaissance de ces interruptions, y compris `ECONNRESET` + `aborted`.
  `src/common/interceptors/logging.interceptor.ts` laisse le filtre produire
  l'avertissement regroupé, sans doublon ni faux 500. Les statuts HTTP 4xx
  identifiés sont des avertissements ; les 5xx restent des erreurs. Les erreurs
  non standard ne font plus échouer le logger lors de leur lecture.
  `src/common/filters/api-exception.filter.ts` utilise le même classificateur.
- **Comportements conservés :** message français `REQUEST_ABORTED`/400 si la
  réponse est encore possible, absence de réponse sur connexion fermée,
  authentification, droits, validation et limites d'images, arrêt avant le
  gestionnaire métier en cas de multipart incomplet. Un `ECONNRESET` générique
  d'un service externe n'est pas assimilé à une réception interrompue. Aucun
  changement de schéma, de dépendance, de délai serveur ou de configuration AWS.
- **Tests :** `logging.interceptor.spec.ts`, `api-exception.filter.spec.ts`,
  `profile-upload-abort.spec.ts` et `auth/session-error.spec.ts` : **34 tests
  réussis**. Le test multipart ouvre un vrai serveur Nest HTTP local, envoie
  des données synthétiques incomplètes et coupe le client ; le gestionnaire ne
  s'exécute pas. Un envoi complet suivant réussit. Ni compte réel ni DB utilisés.
- **Vérifications :** `tsc -p tsconfig.build.json --noEmit --incremental false`
  et `git diff --check` réussis. `tsc` incluant toutes les specs reste en échec
  dans des tests hors périmètre non modifiés ; ne pas assimiler le build valide
  à une suite globale de tests entièrement validée.
- **Livraison et limites :** code prêt à intégrer au déploiement habituel, pas
  encore déployé ici. Aucune migration ou nouvelle variable requise. La correction
  supprime le diagnostic erroné, elle ne répare pas une connexion interrompue et
  ne démontre pas la résolution du crash natif Android. Le client mobile reçoit
  séparément un budget d'envoi du profil de 60 s, une session à propriétaire
  unique et des rapports de diagnostic complémentaires.
