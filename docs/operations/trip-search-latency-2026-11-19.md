# Diagnostic des lenteurs de recherche de trajets — 19 novembre 2026

## Conclusion

Le principal coût **mesuré dans la recherche géographique tracée** est l'appel PostgreSQL qui sélectionne la page de trajets : **1 171 ms sur 1 194 ms côté serveur, soit environ 98 %**. L'attente d'une connexion SQL et les accès Redis de cette même requête sont très courts. Les métriques de la fenêtre ne montrent pas de saturation globale du CPU, de la mémoire ou du disque.

La priorité est donc le plan de cette requête, pas un nouveau redimensionnement AWS. Cela ne prouve pas encore quel opérateur SQL est responsable : les traces mesurent l'appel depuis le backend, pas le détail de l'exécution PostgreSQL. Une analyse du plan et des attentes SQL reste nécessaire avant de choisir une réécriture ou un index.

Un défaut indépendant a aussi été identifié dans le code : le cache des aperçus d'itinéraire reçoit une durée en millisecondes alors que son adaptateur Redis attend des secondes. Il peut conserver ces clés pendant **1 000 jours au lieu d'un jour**. Ce défaut n'explique pas les durées de la trace examinée, mais constitue un risque d'accumulation mémoire.

## Périmètre et méthode

- Relecture du [rapport de la sonde précédente](production-load-2026-11-19.md) et de ses résultats locaux.
- Lectures historiques AWS uniquement : ECS/ECR, X-Ray, CloudWatch, configuration RDS et deux paramètres non secrets de journalisation/échantillonnage.
- Fenêtre étudiée : **19 novembre, 02:12–02:17 Kinshasa**, soit `01:12–01:17 UTC`.
- Aucun nouveau trafic de test, aucune requête SQL exécutée sur RDS, aucun changement de schéma, paramètre, déploiement ou capacité. Aucun correctif applicatif dans cette intervention.
- Les exports locaux ne conservent que les durées et classifications utiles : pas de corps de réponse métier, d'adresse IP, d'identifiant utilisateur ou de SQL contenant des valeurs personnelles.
- Le guide `supabase-postgres-best-practices` a servi à séparer les mesures d'exécution des hypothèses sur les index. Les préconisations ci-dessous restent à valider par un plan représentatif.

### Version de code examinée

ECS utilise la définition de tâche `zwanga-api-production-api:44`. Le digest de son image est :

`sha256:651a238b472a9c675eadbd420e314eb64159ad9310c5616b476f091f9f8c4be8`.

ECR associe ce digest au tag de commit `51d1952cc8845ffa3e8beb1c87573351c7383877`. Les fichiers suivants ont été récupérés dans GitHub à ce commit ; leur empreinte Git correspond au contenu local normalisé :

- `src/trips/trips.service.ts` ;
- `src/trips/trip-discovery-page.ts` ;
- `src/common/route-preview.ts` ;
- `src/common/interceptors/logging.interceptor.ts` ;
- `src/common/services/cache.service.ts` ;
- `src/common/utils/redis-cache-store.ts`.

Cette comparaison porte sur ces fichiers et le commit associé à l'image ; ce n'est pas une attestation reproductible de tout son contenu. Le HEAD local est différent et les modifications locales non liées ont été conservées.

## 1. Preuve par les traces de production

310 résumés X-Ray ont été examinés dans la fenêtre, sans pagination restante. **Deux** correspondent au User-Agent de la sonde. Les deux traces détaillées ont été récupérées intégralement ; aucune trace demandée n'est restée non traitée. Les autres résumés ne sont pas assimilables à des requêtes HTTP du test.

### Recherche géographique

Trace `1-6afe4d87-3034ea36286e13ef720ea4d4`, début à **02:14:47,988 Kinshasa**, HTTP 200.

| Étape | Durée observée |
| --- | ---: |
| Requête HTTP côté serveur | 1 193,883 ms |
| Appel SQL principal `pg.query:WITH` | **1 171,070 ms** |
| Acquisition de sa connexion PostgreSQL | 0,048 ms |
| Deux SELECT suivants | 1,102 ms et 1,161 ms |
| Plus long des 21 spans Redis | 1,137 ms |
| Plus long des 20 spans S3/SDK | 11,961 ms |

Les opérations qui se chevauchent ne doivent pas être additionnées. Le chemin de préparation des images utilise la signature d'URL ; ces spans SDK ne démontrent pas 20 téléchargements d'images depuis S3. Le code des aperçus d'itinéraire ne fait pas d'appel Google Maps depuis la liste.

Le nom du span `WITH`, le chemin HTTP et le code vérifié désignent la sélection paginée comme le coût dominant. Le texte SQL détaillé et son plan ne figurent pas dans les informations exploitées ici. La durée inclut le travail et les attentes de la base ainsi que le retour vers le client PostgreSQL ; elle n'est pas une mesure du CPU SQL seul.

### Liste sans filtre

Trace `1-6afe4dc7-54092e0e8397a3afe11c606d`, début à **02:15:51,296 Kinshasa**, HTTP 200.

- Durée serveur : **30,282 ms**.
- Un SELECT : **16,521 ms** ; acquisition de connexion : **0,063 ms**.
- Deux spans Redis : **3,178 ms et 6,738 ms**.
- Aucun span S3.

Ce profil est cohérent avec la liste en cache suivie de la vérification SQL des trajets encore disponibles. Le cache n'élimine volontairement pas les contrôles de disponibilité des comptes, véhicules et trajets.

**Limite :** deux traces ne permettent ni un p95 représentatif ni l'explication de chacune des 48 requêtes de la sonde. En particulier, cette liste rapide côté serveur n'explique pas à elle seule le maximum client de 3,925 secondes.

## 2. État des ressources pendant la fenêtre

Les valeurs ci-dessous sont les extrêmes des points CloudWatch reçus, généralement agrégés par minute. Elles peuvent masquer un pic bref ou une attente propre à une requête.

| Mesure | Observation |
| --- | ---: |
| CPU ECS | Maximum 7,09 % |
| Mémoire ECS | Maximum 24,22 % |
| CPU RDS | Maximum 16,30 % |
| Connexions RDS | Maximum 19 |
| Mémoire RDS disponible | Minimum environ 809 Mio |
| Crédits CPU RDS | 576 au point reçu à 02:13 |
| Latence de lecture disque RDS | Maximum des points : 1 ms |
| Latence d'écriture disque RDS | Maximum des points : 6,73 ms |
| File disque RDS | Maximum 0,0873 |
| Lectures / écritures disque RDS | Au plus 1,30 / 10,78 opérations par seconde dans les points reçus |
| Swap RDS | Environ 1 Mio, sans forte variation |
| Soldes EBS I/O et débit | 99 % au point reçu pour chacun |
| CPU moteur Redis primaire | Maximum 0,52 % |
| Mémoire Redis primaire | Maximum 2,36 % |
| Évictions Redis primaire | 0 sur les cinq points reçus |

Ces données n'étayent pas une panne de cache, un épuisement des connexions ou une saturation générale du stockage comme cause de cette sonde. Elles n'excluent ni un mauvais plan SQL, ni un calcul séquentiel coûteux, ni un verrou ponctuel. Deux tâches ECS étaient actives et les cibles ALB étaient saines lors du contrôle post-sonde.

## 3. Traitements coûteux ou suspects dans le code

### Priorité 1 — Sélection SQL géographique : coût confirmé, mécanisme à isoler

Sources : `src/trips/trips.service.ts:427`, `:529`, `:596`, `:3132` et `src/trips/trip-discovery-page.ts:9`, `:32`.

La requête combine :

1. Disponibilité du compte et du véhicule, statut du trajet et places restantes.
2. Rayon de recherche par `ST_DWithin` sur un `CASE` : position courante si suffisamment récente, sinon point de départ.
3. Priorité Premium issue d'une sous-requête corrélée sur les abonnements.
4. Calcul de distance et tri, puis limitation à 21 candidats pour renvoyer 20 résultats.
5. Jointures des conducteurs et véhicules après la limitation, via une CTE matérialisée.

Les points à vérifier dans le plan, par ordre de priorité :

- **Expression géographique dynamique :** l'index déclaré sur `departurePoint` ne suffit pas à garantir une recherche indexée sur le résultat du `CASE`. Chercher les scans, le nombre de lignes rejetées et le coût de `ST_DWithin`/`ST_Distance`. Une réécriture en branches indexables est une piste, à tester sans changer la règle GPS de 90 secondes.
- **Classement Premium avant LIMIT :** la sous-requête « dernier abonnement actif » peut être évaluée sur bien plus de lignes que les 20 retournées. Examiner ses boucles, son index et les tris. La pagination borne l'hydratation, pas nécessairement tout le travail de sélection.
- **Comparaison des véhicules convertis en texte :** `v.id::text = trip."vehicleId"::text` peut rendre moins utile l'index UUID ordinaire. Vérifier les types réels et le plan avant toute harmonisation ; ne pas introduire un cast qui échouerait sur des identifiants historiques invalides.
- Vérifier aussi les estimations de cardinalité, les attentes, les tris temporaires et l'éventuel coût JIT. Aucun de ces mécanismes internes n'a été mesuré directement sur RDS dans cette intervention.

`ST_DWithin` sait utiliser des index spatiaux adaptés, mais cela ne prouve pas que notre expression les utilise effectivement ([documentation PostGIS](https://postgis.net/docs/ST_DWithin.html)). Ne pas supprimer la CTE matérialisée ou ajouter des index à l'aveugle.

### Priorité 2 — Cache géographique et taille des réponses

Sources : `src/trips/trips.service.ts:362` et `:422`.

- La liste sans filtre bénéficie d'un cache de 300 secondes avec revalidation SQL.
- Les recherches filtrées passent par `searchPage` et recalculent leur sélection ; elles ne bénéficient pas de ce cache de liste.
- Une optimisation SQL profite donc à chaque recherche géographique. Un cache éventuel devra tenir compte des filtres, des places, des acceptations/annulations et de la position courante ; il ne doit pas rendre visibles des offres obsolètes.
- Dans la sonde, les corps reçus étaient d'environ **86 Ko pour 30 trajets** et **57–58 Ko pour 20 trajets**. Réduire les champs inutiles ou examiner la compression pourrait aider le transport mobile, mais aucun temps de transfert distinct n'a été enregistré.

Les durées client incluent réseau, éventuelle ouverture de connexion, téléchargement et validation JSON. La sonde réutilise les connexions (`keepAlive`), mais ne sépare pas DNS/TCP/TLS/TTFB/téléchargement. Elle n'enregistre pas de corrélation par identifiant avec X-Ray : **ne pas soustraire des percentiles client et serveur, ni apparier des requêtes concurrentes sur l'heure seule**.

### Priorité 3 — Enrichissements après sélection : pas le problème principal mesuré

Sources : `src/trips/trips.service.ts:602`, `:3431`, `:3478`, `:3627`, `src/common/route-preview.ts:35`, `src/common/services/s3.service.ts:101`.

- Notes et avantages Premium sont chargés par groupes d'utilisateurs, pas par une requête SQL pour chaque carte.
- Les deux SELECT après la sélection totalisent environ 2,3 ms dans la trace lente. Les paralléliser ne récupérerait pas les 1,17 seconde de la sélection.
- Les aperçus effectuent des lectures Redis par trajet ; un regroupement peut réduire les opérations à plus forte charge, mais elles sont rapides ici.
- Pas d'appel Google Maps par carte ; les aperçus utilisent une durée connue, Redis ou une approximation locale.
- Les signatures d'URL et l'hydratation ne dominent pas cette trace. L'hydratation des réservations n'est pas chargée par les jointures de cette sélection.

### Défaut secondaire confirmé dans le code — Unité du TTL des aperçus

Sources : `src/common/route-preview.ts:7`, `:22`, `src/common/services/cache.service.ts:33`, `src/common/utils/redis-cache-store.ts:15`, `:77`.

`rememberRoutePreview` transmet `86_400_000` (24 h exprimées en millisecondes). `CacheService` transmet la valeur sans conversion ; le cache-manager installé la relaie au store, dont `resolveTtlSeconds` et `setEx` l'interprètent en secondes : **86 400 000 secondes = 1 000 jours**.

La vérification applicative `savedAt` refuse néanmoins de réutiliser les valeurs de plus de 24 h : le risque identifié est la conservation inutile de clés, pas l'utilisation d'estimations vieilles de 1 000 jours. Les clés réécrites, invalidées ou évincées peuvent disparaître plus tôt.

Le test `src/common/route-preview.spec.ts` vérifie actuellement la valeur milliseconde contre un mock, sans traverser l'adaptateur Redis : il ne protège pas ce contrat. Prévoir une correction ciblée de l'appel et un test de bout en bout des unités avec un client Redis simulé. **Ne pas changer globalement l'unité du store**, les autres appels utilisant des secondes. Les TTL réellement présents dans Redis n'ont pas été lus ; aucune purge ni correction n'a été effectuée.

Reproduction locale effectuée pendant ce diagnostic : `tmp/check-route-preview-ttl-2026-11-19.cjs` traverse le véritable helper, `CacheService`, le cache-manager installé et le store du projet, avec un client Redis et sa connexion simulés. Résultat : `setEx` reçoit bien **86 400 000 secondes**, pour 86 400 attendues ; zéro connexion Redis réelle. Cela confirme le défaut d'unité dans ce chemin de code, pas le nombre ni les TTL des clés déjà présentes en production.

## 4. Limites de l'observabilité actuelle

- La lecture SSM du seul niveau de journalisation confirme `LOG_LEVEL=warn`. L'intercepteur émet les réponses réussies au niveau `log`/info. Aucun événement portant le User-Agent de la sonde n'a été trouvé dans le groupe ECS sur la fenêtre : pas de chronométrage exhaustif des réponses 200 exploitable ici. Une modification SSM seule ne prouverait toutefois pas la valeur chargée dans une tâche déjà démarrée.
- X-Ray fournit bien des traces, mais seulement deux requêtes de ce test sont disponibles dans la fenêtre. Le sampler est configuré pour interroger le collecteur ; cela ne justifie pas d'affirmer un taux d'échantillonnage effectif exact à partir de ces deux traces.
- RDS indique `PerformanceInsightsEnabled=false`, `DatabaseInsightsMode=standard`, monitoring renforcé à 60 secondes. Aucun historique d'attentes SQL détaillé n'a été exploité.
- Aucun événement `duration:` dans les logs PostgreSQL de la fenêtre. Les paramètres de journalisation consultés sont aux valeurs moteur par défaut, sans seuil lent explicite observé.
- `pg_stat_statements` apparaît dans `shared_preload_libraries`. L'installation de l'extension dans la base et ses statistiques effectives n'ont pas été vérifiées ; ne pas conclure qu'il est inutilisable ou vide.
- Les anciens plans locaux d'octobre sous `tmp/load-results/` utilisent PostgreSQL Windows, des données synthétiques et des variantes de SQL sans les contrôles actuels compte/véhicule. Ils ne sont pas un plan d'exécution de la production actuelle.

## 5. Suite recommandée avant d'augmenter la charge

1. Obtenir le SQL et ses paramètres de forme représentative sans journaliser les données personnelles ; vérifier en lecture seule les index réellement présents et les statistiques SQL disponibles. Commencer par `EXPLAIN` sans exécution. Un `EXPLAIN (ANALYZE, BUFFERS)` exécute la requête : le réserver d'abord à une copie représentative isolée, ou à une intervention de production explicitement bornée et autorisée ([documentation PostgreSQL](https://www.postgresql.org/docs/current/using-explain.html)).
2. Tester séparément les hypothèses de filtre géographique, de priorité Premium et de comparaison UUID. Conserver les contrôles compte/véhicule, la règle GPS, les places, l'ordre Premium, les curseurs et les limites ; vérifier l'égalité des résultats avant/après.
3. Corriger séparément le TTL des aperçus, avec un test du contrat jusqu'à `setEx`. Évaluer les clés anciennes de manière bornée avant toute opération de nettoyage ; pas de `FLUSHDB` ni de balayage bloquant.
4. Ajouter un chronométrage structuré et sobre des recherches lentes : sélection SQL, attentes du pool, enrichissement, cache et taille de réponse ; corrélation par identifiant de requête/trace, sans coordonnées, téléphone ou contenu métier. Éviter de passer tout le backend en `debug`.
5. Rejouer le même petit scénario seulement après ces vérifications et avec la même autorisation opérationnelle, puis envisager un palier supérieur. Mesurer séparément le temps serveur et le transport client.

**Décision : ne pas augmenter la charge ni acheter de la capacité supplémentaire sur la seule base de cette sonde.** Le point chaud SQL est localisé ; le plan responsable reste à établir. La capacité de 1 000 trajets/demandes et les flux GPS/dispatch/paiement ne sont pas validés par cette analyse.

## Pièces locales

- `tmp/production-load-results/2026-11-19T01-12-31-202Z/report.json` : sonde initiale.
- `tmp/production-load-results/2026-11-19T01-18-05-339Z/report.json` : contrôle différé.
- `tmp/trip-latency-traces-2026-11-19.json` : projections anonymisées des deux traces.
- `tmp/trip-latency-metrics-2026-11-19.json` : métriques disque et résultat des recherches bornées dans les logs.
- `tmp/trip-latency-diagnostic-2026-11-19.cjs` et `tmp/trip-latency-metrics-2026-11-19.cjs` : collecteurs temporaires limités aux lectures historiques. Aucun lancement du générateur de charge dans cette intervention.
- `tmp/check-route-preview-ttl-2026-11-19.cjs` : reproduction hors réseau du défaut d'unité du TTL.
