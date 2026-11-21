# Production : contrôle préalable et sonde de charge du 19 novembre 2026

Statut : **sonde courte terminée sans erreur HTTP ; latence à investiguer ; capacité maximale non déterminée**. Les heures ci-dessous sont celles de Kinshasa (UTC+1), sauf mention contraire.

## Périmètre autorisé

Sonde courte, en lecture seule, sur `https://compute-api.zwanga-app.com` :

- `GET /health` ;
- `GET /api/v1/trips` ;
- `GET /api/v1/trips?departureCoordinates=15.28%2C-4.34&departureRadiusKm=20&minSeats=1&limit=20`.

Le script `test/load/production-readonly.cjs` prévoit trois paliers de 1, 2 et 4 requêtes simultanées, six rafales par palier, espacées d'au moins 10,5 secondes : **42 requêtes métier**, plus les sondes de santé et de vérification initiale. Aucun contournement des quotas, aucune authentification ni nouvelle tentative automatique. Les corps des réponses ne sont pas enregistrés.

Ne sont pas testés : création/acceptation de demandes, GPS et WebSockets, dispatch, livraison FCM/APNs, OTP, paiements, basculement, autoscaling ou saturation. Le test ne certifie pas 1 000 trajets simultanés.

## Infrastructure observée

Contrôle AWS en lecture seule vers 2 h 02, dans `eu-central-1` :

| Composant | État constaté |
| --- | --- |
| API ECS | Révision 44, 2 tâches souhaitées et actives, 0 en attente, déploiement terminé |
| Autoscaling API | Minimum 2, maximum 3 ; aucune suspension |
| RDS PostgreSQL | `db.t4g.small`, disponible, Single-AZ, aucune modification en attente |
| Redis | 2 nœuds disponibles, Multi-AZ et basculement automatique activés ; `-001` primaire |
| Alarmes | 19 `OK` ; alarme des appels AWS non autorisés encore `ALARM` |

Les réductions de capacité visibles dans l'ancien plan Terraform fourni n'ont pas été constatées sur ces ressources.

## Vérification de la correction KMS

Les deux politiques IAM ont été modifiées à **1 h 54 min 46 s** : rôle d'exécution ECS et rôle de livraison CloudTrail vers CloudWatch Logs. Les autorisations sont limitées à `kms:GenerateDataKey` et `kms:Decrypt`, à la clé d'observabilité, au passage par CloudWatch Logs et aux contextes de chiffrement des groupes concernés.

Dans la fenêtre CloudTrail examinée, le dernier refus KMS retrouvé date de **1 h 53 min 05 s**, avant la correction. Des vérifications ultérieures des deux rôles renvoient `DryRunOperationException` avec le message indiquant que l'appel aurait réussi sans le mode de simulation. Ce code signale ici un contrôle d'autorisation réussi, pas un nouveau refus ([documentation AWS](https://docs.aws.amazon.com/kms/latest/developerguide/testing-permissions.html)). La consultation des événements reste soumise au délai de publication de CloudTrail.

CloudTrail est actif et ses dernières livraisons S3/CloudWatch ne signalent pas d'erreur. L'alarme n'a pas été acquittée artificiellement ni désactivée. CloudWatch peut encore évaluer des points précédents lorsqu'une métrique devient sporadique ([traitement des données manquantes](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html)).

Une vérification suivante a examiné 85 événements KMS depuis la correction, sans pagination restante : 78 sans erreur et 7 contrôles `DryRunOperationException`, aucun refus. Le dernier événement publié dans cet échantillon était daté de 2 h 07 min 59 s. L'alarme est revenue naturellement à **`OK` à 2 h 11 min 56 s**, constaté à 2 h 12 min 02 s.

## Premier contrôle préalable

Exécution de 2 h 02 min 39 s à 2 h 02 min 56 s :

- Résultat : `preflight_refused`, motif `CloudWatch alarm active`.
- **Zéro requête HTTP de test**, zéro donnée métier créée ou modifiée.
- Rapport local : `tmp/production-load-results/2026-11-19T01-02-39-319Z/report.json`.
- Tests locaux des garde-fous de la sonde : 6 réussis.
- Tests locaux de cohérence du profil de capacité, du périmètre KMS et des contrôles CI : 16 réussis. Il s'agit de tests de configuration, pas d'une validation de capacité AWS.

Les métriques du quart d'heure précédant ce contrôle montraient un CPU ECS maximal de 23,14 %, un CPU RDS maximal de 8,39 %, au plus 18 connexions SQL, un CPU Redis maximal de 0,52 %, une occupation mémoire Redis maximale de 2,33 % et aucune éviction dans les points reçus. Ce sont des mesures avant charge, pas un résultat de test.

Un second contrôle à 2 h 11 min 22 s a encore été refusé avant le rétablissement de l'alarme, avec zéro requête HTTP également (`tmp/production-load-results/2026-11-19T01-11-22-969Z/report.json`). Les deux cibles ALB étaient saines et ECS stable. Le test n'a été lancé qu'après le constat du retour à `OK`.

## Résultats de la sonde

Trafic de **2 h 12 min 47 s à 2 h 16 min 00 s**, rapport final enregistré à 2 h 16 min 07 s :

- Résultat du script : `completed`, sans déclenchement d'un arrêt de sécurité.
- 42 requêtes métier valides sur 42, toutes en HTTP `200` : 21 listes et 21 recherches géographiques.
- 6 sondes supplémentaires valides en `200` : quatre contrôles de santé et deux vérifications initiales des routes métier. Total : **48 requêtes HTTP**.
- Les listes contenaient 30 trajets ; les recherches géographiques, 20. Aucun corps de réponse n'a été conservé.
- Aucune ressource AWS créée et aucune commande de modification AWS exécutée par le test. Les lectures utilisent néanmoins les services existants et leur facturation habituelle ; le coût marginal n'a pas été mesuré.
- Rapport brut local : `tmp/production-load-results/2026-11-19T01-12-31-202Z/report.json`.
- Environ 3,02 Mio de corps de réponses reçus (3 162 789 octets), hors en-têtes, TLS et appels de supervision ; ce volume n'est pas une mesure de facturation.

| Lectures simultanées | Requêtes métier | HTTP 200 valides | Médiane client | p95 client | Maximum client |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 6 | 6 | 306 ms | 1 638 ms | 1 638 ms |
| 2 | 12 | 12 | 1 408 ms | 2 965 ms | 2 965 ms |
| 4 | 24 | 24 | 1 529 ms | 3 689 ms | 3 925 ms |

Sur les 42 requêtes métier, médiane de 1 464 ms et p95 de 2 965 ms. Par route, p95 de 1 947 ms pour la liste et 2 965 ms pour la recherche géographique. Les quatre sondes de santé ont pris entre 245 et 865 ms.

Ces mesures vont du départ de la requête au téléchargement complet et à la validation de la réponse sur le poste de test. Elles incluent le réseau et, le cas échéant, l'établissement de la connexion TLS. Elles ne représentent pas le seul temps d'exécution du backend. Les effectifs sont petits ; le p95 du premier palier est son maximum. Ce n'est pas une mesure statistique robuste d'une charge soutenue.

Le maximum de 3 925 ms est proche du seuil d'arrêt de 4 000 ms appliqué par cette exécution. **L'absence d'erreur ne suffit donc pas à déclarer les performances satisfaisantes.** Ne pas augmenter la charge avant d'avoir expliqué la latence.

## Télémétrie et interprétation

Le contrôle différé de **2 h 18 min 05 s à 2 h 18 min 22 s** a réussi (`preflight_passed`), sans émettre de requête HTTP. Il confirme : 2 tâches API stables sur la même révision 44, 2 cibles ALB saines, 20 alarmes à `OK`, RDS et Redis disponibles.

Rapport du contrôle différé : `tmp/production-load-results/2026-11-19T01-18-05-339Z/report.json`.

Les points publiés pour les cinq minutes de 2 h 12 à 2 h 16 incluses, fenêtre encadrant le trafic du test, donnent :

| Mesure CloudWatch | Valeur observée dans cette fenêtre |
| --- | ---: |
| CPU ECS, maximum des points reçus | 7,09 % |
| Mémoire ECS, maximum | 24,22 % |
| CPU RDS, maximum | 16,30 % |
| Connexions RDS, maximum | 19 |
| Mémoire RDS libre, minimum | Environ 809 Mio |
| Crédits CPU RDS, point à 2 h 13 | 576 |
| CPU moteur Redis primaire, maximum | 0,52 % |
| Mémoire Redis primaire, maximum | 2,36 % |
| Évictions Redis primaire | 0 sur les cinq points reçus |
| Cibles ALB malsaines | 0 sur les cinq points reçus |

Aucun point de comptage 5xx ALB/cible n'a été renvoyé sur cette fenêtre ; les 48 appels du générateur, eux, sont directement vérifiés en `200`. Ne pas assimiler l'absence de points à une preuve exhaustive de l'absence d'erreurs sur tous les autres parcours.

Les p95 `TargetResponseTime` ALB par minute étaient de 1,217 s, 1,359 s, 1,192 s, **1,967 s**, puis 0,016 s de 2 h 12 à 2 h 16. Ce sont des agrégats du trafic partagé, pas une corrélation individuelle avec les requêtes du test ; ne pas soustraire leurs percentiles aux percentiles client pour calculer une latence réseau. La composante serveur est donc elle aussi à examiner, même sans saturation CPU apparente.

Conclusion : la disponibilité et les réponses des deux parcours publics ont tenu sous cette petite sonde. La latence augmente avec les paliers, mais cet échantillon court ne permet pas d'en isoler la cause ni de fixer un plafond de capacité. La priorité est de profiler les lectures de trajets (temps SQL, attentes du pool, cache, appels dépendants, taille et sérialisation des réponses) et de comparer les mesures serveur/client sur un banc représentatif. Aucune de ces causes possibles n'est démontrée par cette sonde seule.

## Critères d'arrêt

Le script refuse ou arrête le trafic en cas d'alarme active, de déploiement concurrent, de cible ALB dégradée, de métriques obligatoires absentes/périmées, d'erreur HTTP (y compris 429), de réponse invalide, de latence excessive ou de dépassement des seuils de ressources. Le trafic est limité dans le temps. Aucun seuil ni aucune alarme ne doit être modifié pour faire passer le test.

## Suite nécessaire pour mesurer une limite de capacité

Même si cette sonde réussit, utiliser ensuite un environnement représentatif isolé avec des comptes et trajets synthétiques, sans destinataires réels ni fournisseurs payants actifs. Définir les fréquences GPS, le nombre de connexions, le rythme de création des demandes et la taille des vagues de dispatch. Monter par paliers et mesurer notamment la latence jusqu'à l'invitation durable et l'accusé de réception, les erreurs, les doublons, le retard des files et les connexions SQL. Tester séparément l'endurance et la reprise après panne. Tout palier supérieur sur la production nécessite une nouvelle validation de son périmètre et de ses conditions d'arrêt.
