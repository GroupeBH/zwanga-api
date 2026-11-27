# Sonde de production du 22 novembre 2026

**La reprise a terminé les trois paliers de 1, 2 et 4 requêtes simultanées : 48 appels HTTP sur 48 valides, tous en 200, sans arrêt de sécurité.** Le premier essai avait été interrompu pendant le deuxième palier par une lecture CloudWatch indisponible, après 18 réponses valides. Les deux essais sont conservés ci-dessous ; ni la capacité maximale ni 1 000 trajets simultanés ne sont validés par cette petite sonde publique.

Les heures sont celles de Kinshasa (UTC+1). Premier trafic le **22 novembre, de 1 h 07 min 47 s à 1 h 09 min 35 s**, puis reprise de **1 h 21 min 39 s à 1 h 24 min 52 s**. Aucun déploiement, changement de capacité, publication SNS ou appel d'écriture métier n'a été effectué pendant ces interventions.

## Reprise après diagnostic

Le blocage du premier essai était une perte de supervision `cloudwatch/get-metric-data`, pas un refus HTTP du backend. L'ancien `catch` supprimait l'exception de la commande AWS. Il est donc impossible de départager rétrospectivement un délai dépassé, une erreur réseau, un refus AWS ou une réponse invalide. Aucune de ces causes n'est confirmée et l'échec ne s'est pas reproduit.

Le lecteur AWS local [production-monitoring.cjs](../../test/load/production-monitoring.cjs) conserve désormais l'opération, l'heure, la durée et une catégorie d'échec, avec codes AWS/processus autorisés. Les sorties brutes, arguments et messages pouvant contenir des secrets ne sont pas conservés. Délais inchangés : connexion 5 s, lecture 10 s, processus 20 s ; une seule tentative. Toute indisponibilité continue d'arrêter le trafic. Les **15 tests automatisés** de supervision et de garde-fous réussissent. Les nouveaux tests sont ajoutés aux workflows production et staging ; les **33 contrôles locaux** de cette commande CI (supervision, politique CI, budget, KMS et état Terraform) réussissent. Aucun pipeline n'a été déclenché.

Deux précontrôles sans trafic applicatif ont réussi avant la reprise. Puis les **44 appels AWS de la sonde ont réussi**, dont huit `GetMetricData` en **3,11 à 3,58 s**. Les huit instantanés ont retrouvé les 20 alarmes `OK`, l'abonnement email confirmé et la même révision ECS 46. Ce résultat confirme une supervision disponible pendant la reprise, pas la cause technique de l'incident initial.

### Résultats des trois paliers

| Concurrence | Lectures métier valides | Médiane client | p95 client | Maximum client |
| --- | ---: | ---: | ---: | ---: |
| 1 | 6 sur 6 | 324 ms | 519 ms | 519 ms |
| 2 | 12 sur 12 | 367 ms | 2 028 ms | 2 028 ms |
| 4 | 24 sur 24 | 502 ms | 1 899 ms | 1 982 ms |

Les 42 lectures métier et six contrôles supplémentaires sont tous en HTTP 200, sans 429 ni 5xx dans cet échantillon. Le p95 métier global est de **1,90 s** : **611 ms** pour les 21 listes et **1,98 s** pour les 21 recherches géographiques. Les routes, le rythme des rafales et le plafond de quatre appels simultanés sont inchangés. Aucun nouveau palier supérieur à quatre n'a été lancé.

### Contrôle différé après la reprise

Le précontrôle AWS de **1 h 25 min 49 s** est réussi. Ses points CloudWatch de **1 h 21 à 1 h 24 incluses** couvrent les quatre minutes du trafic.

| Mesure | Valeur sur cette fenêtre |
| --- | ---: |
| CPU ECS, maximum | 6,09 % |
| Mémoire ECS, maximum | 21,83 % |
| CPU RDS, maximum | 6,85 % |
| Connexions RDS | 19 à 20 |
| Mémoire RDS libre, minimum | Environ 729 Mio |
| CPU moteur Redis, maximum des deux nœuds | 0,52 % |
| Mémoire Redis, maximum des deux nœuds | 2,35 % |
| Évictions Redis | 0 sur les quatre points de chaque nœud |
| Cibles ALB malsaines | 0 sur les quatre points |
| p95 ALB par minute | 82 / 138 / 80 / 181 ms |

Aucun signe de saturation n'apparaît sous cette petite charge. Les séries 5xx ALB n'ont aucun point sur la fenêtre ; les 48 réponses 200 sont directement observées côté sonde. Les percentiles ALB sont des agrégats du trafic partagé, distincts des durées client et non soustractibles à celles-ci.

La lecture filtrée des logs de **0 h 55 à 1 h 25** ne retrouve aucun événement `ERROR`, `FATAL` ou `trip_search_slow`, avec pagination complète. Les huit traces X-Ray de cette fenêtre n'ont ni erreur, ni faute serveur, ni throttling. Une trace `/api/v1/trips` est en HTTP 200 et dure 9 ms, avec des spans Redis de 1 ms ; aucun span SQL ni `trips.discovery.select` n'y apparaît. Cette trace isolée, non corrélée à une requête précise de la sonde, ne permet pas d'attribuer les pointes client proches de deux secondes au réseau ou à la base.

## Historique du premier essai

Les sections suivantes décrivent uniquement l'essai interrompu de 1 h 07 à 1 h 09.

## Version et infrastructure contrôlées

- API ECS révision **46**, déploiement terminé, deux tâches saines et deux cibles ALB saines. Une tâche dans chacune des zones `eu-central-1a` et `eu-central-1b` ; 512 unités CPU et 1 024 Mio par tâche, collecteur inclus.
- Image API des deux tâches : `sha256:b881bbcab113e9378ce7686bebe2096a7484cfd8939cd660b47eeca9fdf9a512`. Tag de commit ECR : `e5c79233ef95f9b78896154200d641e5453a8317`, image publiée le 21 novembre à 17 h 59.
- PostgreSQL 18.3 sur `db.t4g.small`, disponible, Single-AZ. Redis disponible, Multi-AZ et basculement automatique activés ; métriques contrôlées sur les deux nœuds.
- Les 20 alarmes du périmètre sont `OK` aux contrôles réussis, avec un abonnement email SNS confirmé. Ce constat ne remplace pas un essai de réception d'alerte opérationnelle.

Le dépôt local est au commit `0cf90ef`. Le commit associé à l'image n'est pas présent dans les objets Git locaux, mais la lecture de ce commit sur GitHub confirme la parité exacte des deux fichiers examinés : `trips.service.ts` (blob `84a5e638b368fe232a3a079ce4c7bf64b99bec9f`) et `discovery-eligibility.ts` (blob `6e4ab306a5bab4019b92f059c6bedf0b9de535f0`). Le service utilise les filtres corrigés ; cette vérification ne couvre pas tous les fichiers du backend.

## Périmètre et résultats HTTP

Lors du premier essai, le script [production-readonly.cjs](../../test/load/production-readonly.cjs) était inchangé. Ses **11 tests de garde-fous avaient réussi** avant la sonde.

Le plan prévoyait trois paliers de 1, 2 et 4 lectures simultanées, six rafales espacées d'au moins 10,5 secondes par palier, soit au maximum 42 lectures métier et six contrôles supplémentaires. Les seules routes autorisées étaient `/health`, `/api/v1/trips` et la recherche géographique publique déjà utilisée lors du test précédent. Aucun compte ni trajet n'a été créé ; les parcours GPS/WebSocket, dispatch, SMS/push, KYC et paiement étaient exclus. Aucun corps de réponse n'a été conservé.

| Concurrence | Lectures métier effectuées | État du palier | Médiane client | p95 client / maximum |
| --- | ---: | --- | ---: | ---: |
| 1 | 6 sur 6 | Terminé | 379 ms | 527 ms |
| 2 | 8 sur 12 | Interrompu par la supervision | 396 ms | 1 942 ms |
| 4 | 0 sur 24 | Non commencé | — | — |

Les **14 lectures métier** sont valides en HTTP 200 : sept listes de 30 résultats et sept recherches géographiques de 20 résultats. Leur médiane globale est de **393 ms**, leur p95 et maximum de **1 942 ms**. Le maximum des listes est de 647 ms. Les quatre contrôles supplémentaires, dont deux de santé, sont également valides en HTTP 200 : **18 appels au total**, aucun 429 ni 5xx dans cet échantillon.

Ces mesures client incluent réseau, TLS éventuel, téléchargement et validation. Avec de si petits effectifs, les p95 des paliers correspondent aux maxima. Elles ne représentent pas une charge soutenue ni des temps SQL isolés.

## Arrêt de sécurité et retour de la supervision

Le résultat du premier essai reste `stopped_early`, avec le motif `Read-only monitoring unavailable: cloudwatch/get-metric-data`. Aucun seuil ni garde-fou n'a été modifié ; le trafic a été interrompu jusqu'aux nouveaux précontrôles de la reprise décrite plus haut.

Le contrôle final AWS a réussi. Le précontrôle séparé de **1 h 10**, sans requête HTTP applicative, est également `preflight_passed`. Un appel diagnostique isolé à `GetMetricData`, avec les mêmes limites de délai et sans nouvelle tentative automatique, a ensuite réussi en **6 121 ms**, avec 19 séries complètes.

Le script remplace l'exception initiale par un message générique : le code AWS, la durée et l'éventuel dépassement de délai ne sont pas conservés. **La cause exacte de cet échec de lecture reste indéterminée.** Les contrôles suivants réussis ne permettent ni d'affirmer une panne générale CloudWatch, ni d'invalider rétroactivement l'arrêt de sécurité.

## Métriques publiées pendant le trafic

Le contrôle différé contient les points des trois minutes de **1 h 07 à 1 h 09 incluses**, couvrant la fin du trafic.

| Mesure | Valeur sur cette fenêtre |
| --- | ---: |
| CPU ECS, maximum | 2,76 % |
| Mémoire ECS, maximum | 21,78 % |
| CPU RDS, maximum | 6,89 % |
| Connexions RDS | 20 |
| Mémoire RDS libre, minimum | Environ 758 Mio |
| Stockage RDS libre, minimum | Environ 16,77 Gio |
| Swap RDS, maximum | Environ 14,47 Mio |
| CPU moteur Redis, maximum des deux nœuds | 0,51 % |
| Mémoire Redis, maximum des deux nœuds | 2,35 % |
| Évictions Redis | 0 sur les trois points de chaque nœud |
| Cibles ALB malsaines | 0 sur les trois points |
| p95 ALB par minute | 106 / 84 / 81 ms |

Les séries de 5xx ALB/cibles ne contiennent aucun point sur cette fenêtre ; ce n'est pas une preuve d'absence d'erreur sur tous les parcours. Les 18 réponses 200 de la sonde sont, elles, directement observées. Les percentiles ALB concernent le trafic partagé et ne doivent pas être soustraits des percentiles client pour calculer un temps réseau.

Aucun signe de saturation CPU, mémoire ou Redis n'apparaît sous cette petite charge. Les durées ALB sont nettement inférieures aux 1,25–1,49 s par minute du [21 novembre](production-load-2026-11-21.md), mais ce test interrompu comporte moins de requêtes et aucun palier à quatre. Données, cache, réseau et trafic partagé ne sont pas contrôlés : aucun gain de capacité chiffré ni effet causal isolé n'est démontré.

## Logs et traces

La lecture filtrée des logs de **0 h 40 à 1 h 10** ne retrouve aucun événement correspondant à `ERROR`, `FATAL` ou `trip_search_slow`, avec pagination complète. Cela ne constitue pas un audit exhaustif des logs et ne fournit pas les temps détaillés des requêtes rapides.

X-Ray retourne neuf traces : huit HTTP 200 et une HTTP 401 sur une autre route, aucune faute serveur ni throttling. Aucune trace de recherche de trajets n'a été échantillonnée. Le 401 ne correspond pas aux appels publics de la sonde, tous en 200 ; les temps SQL, pool et hydratation ne peuvent pas être corrélés individuellement à cette sonde.

## Suites

Le diagnostic détaillé de supervision est en place et la reprise des paliers bornés est terminée. Les conditions d'arrêt sont conservées ; si une lecture AWS échoue à nouveau, son diagnostic assaini permettra de cibler le problème avant une autre reprise.

La validation représentative des **1 000 trajets/demandes** reste à préparer séparément avec comptes et trajets synthétiques, GPS, dispatch, files d'alertes, endurance et reprises. La sonde terminée valide seulement les lectures publiques à faible concurrence, sans tester ces parcours, l'autoscaling ou le failover. Une montée de charge supérieure doit définir son débit, sa durée et ses seuils d'arrêt avant exécution.

## Rapports privés

Les fichiers suivants restent ignorés par Git, sous `tmp/production-load-results/` :

- `2026-11-22T00-04-47-629Z/report.json` : précontrôle initial réussi.
- `2026-11-22T00-07-22-589Z/report.json` : sonde interrompue et contrôle final.
- `2026-11-22T00-10-34-015Z/report.json` : précontrôle différé réussi et métriques couvrant la fin du trafic.
- `release-inspection-2026-11-22T00-10-20-180Z.json` : version déployée, logs filtrés et agrégats X-Ray.
- `2026-11-22T00-20-37-488Z/report.json` et `2026-11-22T00-21-04-245Z/report.json` : précontrôles instrumentés avant reprise, sans trafic applicatif.
- `2026-11-22T00-21-30-754Z/report.json` : reprise terminée, 48 réponses HTTP valides et diagnostics des 44 appels AWS.
- `2026-11-22T00-25-46-992Z/report.json` : contrôle différé et métriques couvrant la reprise.
- `release-inspection-2026-11-22T00-25-16-918Z.json` : version, logs filtrés et traces après la reprise.
