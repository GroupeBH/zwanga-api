# Préparation du déploiement et reprise des tests de charge

## Décision

Le dimensionnement AWS observé le 19 novembre 2026 est conforme au profil retenu.
Le déploiement applicatif doit passer par la CI corrigée et ses migrations avant
ECS. Il n'exige pas de nouvel agrandissement RDS ou Redis sur la seule base de
cette revue. L'ouverture commerciale de Zwanga Pro et un test à 1 000 trajets ne
sont pas validés par ce contrôle.

Le précontrôle de 20 h 09–20 h 10 (Kinshasa) a refusé toute charge car l'alarme
d'utilisation du compte root était active. L'opérateur a confirmé une
intervention volontaire (déconnexion root). Cette alarme est revenue à `OK`
à 20 h 34 min 41 s, sans acquittement forcé. Le précontrôle a effectué uniquement
des lectures AWS : zéro sonde HTTP, zéro opération métier.

Le nouveau précontrôle démarré à **20 h 39** a réussi : `preflight_passed`,
20 alarmes `OK`, zéro requête HTTP et zéro sonde. Cela autorise à préparer la
prochaine étape, pas à déduire qu'un test de charge a été exécuté. Rapport local
ignoré : `tmp/production-load-results/2026-11-19T19-39-02-174Z/report.json`.

## Infrastructure constatée

| Composant | État lu sur AWS |
| --- | --- |
| API | Révision 44, 2 tâches saines, ARM64, 0,5 vCPU et 1 Gio par tâche ; deux cibles ALB saines |
| Autoscaling | Minimum 2, maximum 3, aucune suspension |
| RDS | PostgreSQL 18.3, `db.t4g.small`, 20 Gio, Single-AZ, disponible, aucune modification en attente, sauvegardes 7 jours |
| Valkey | Deux `cache.t4g.micro`, Multi-AZ et failover activés, disponible, aucune modification en attente |
| Alarmes | 19 à `OK` ; root à `ALARM`, depuis 18 h 11 sur un point de 18 h 06 ; refus AWS à `OK` |
| Terraform | Backend local initialisé et objet S3 existant : `tfstates-zwanga-api/zwanga/ecs-fargate/eu-central-1/terraform.tfstate` |

La ligne des alarmes décrit le premier contrôle ; la relecture ciblée de
l'alarme root confirme son retour à `OK` indiqué ci-dessus.

Le plan connecté, calculé avec `operators.tfvars` après vérification du compte
et des 187 adresses du state, prévoit **1 création, 0 modification, 0 suppression** :
un abonnement email SNS aux alertes. Aucune réduction de RDS/Redis, suppression
d'autoscaling ou de budget, ni changement IAM/KMS n'est prévu. Les contrôles du
plan passent. Le plan enregistré reste local et ignoré par Git ; aucun `apply`
n'a été exécuté. La création de l'abonnement et sa confirmation par le
destinataire nécessitent une action distincte, pas un changement de capacité.
La lecture SNS confirme une liste d'abonnements vide sur le topic d'alertes :
des alarmes `OK` ne prouvent donc pas que les alertes email sont opérationnelles.
Rétablir et confirmer cet abonnement avant une exploitation sous charge non
surveillée ; ne pas publier l'adresse privée ni le plan dans GitHub.

Dans les quinze minutes couvertes par le précontrôle, CPU ECS maximal 24,42 %,
mémoire ECS maximale 26,37 %, CPU RDS maximal 8,16 %, au plus 18 connexions SQL,
environ 829 Mio de mémoire RDS libre au minimum. Le CPU moteur des deux nœuds
Valkey reste sous 0,51 %, leur mémoire sous 2,31 %, sans éviction dans les points
reçus. Ces mesures décrivent le trafic courant, pas une capacité sous charge.
RDS reste un point de panne Single-AZ. Le budget de 175 USD est un objectif
surveillé, pas un plafond de consommation.

## Lenteurs et correctifs

La [sonde précédente](production-load-2026-11-19.md) a réussi ses 42 lectures
métier, avec un maximum client de 3 925 ms. Le [diagnostic des traces](trip-search-latency-2026-11-19.md)
a observé 1 171 ms SQL sur une recherche de 1 194 ms côté serveur. Cette mesure
justifie le travail sur la requête géographique, sans attribuer toute lenteur
réseau ou tout parcours métier à la même cause.

Le profilage relancé pendant cette revue, sur PostgreSQL 18 local et 5 000 trajets
synthétiques, conserve les mêmes identifiants dans le même ordre. `EXPLAIN ANALYZE`
mesure 92,262 ms pour l'ancienne condition et 3,243 ms pour la condition corrigée.
Le parcours séquentiel des trajets est remplacé par un `BitmapOr` des index
`IDX_trips_current_location` et `IDX_trips_departure_point`. Il s'agit d'une
mesure SQL locale, non d'un p95 applicatif ou d'une garantie de capacité AWS.

Le code local contient déjà les corrections décrites dans
[les correctifs de performance](performance-fixes-2026-11-19.md) : filtre spatial
indexable, index GiST concurrent, sélection avant hydratation, préchargement des
abonnements, file GPS durable, notifications de démarrage réservées aux passagers
acceptés, pagination des nouveaux clients et durées de cache corrigées.

Cette revue corrige en plus :

- La CI ignorait les suites PostgreSQL GPS/outbox et agrégats/pagination : export
  `PERFORMANCE_TEST_POSTGRES_BIN` et fuseau `TZ=UTC` ajoutés aux deux pipelines.
- L'exemple du backend Terraform pointait vers une autre clé de state : il est
  aligné sur la pile existante, avec test de cohérence et consigne d'arrêt si le
  state paraît vide. Aucun state distant n'est déplacé.
- La sonde ne regardait que Redis `001` : elle contrôle les deux nœuds, même après
  promotion de `002`. Les métriques partielles, valeurs invalides et alarmes
  inconnues sont refusées. Une surveillance finale en échec ne peut plus laisser
  un résultat de test annoncé comme réussi.
- La migration des files GPS n'avait pas de budget SQL propre : création et
  suppression bornent maintenant l'attente de verrou à 3 secondes et l'instruction
  à 30 secondes, sans retirer les protections de rollback ni changer le schéma.

## Ordre de livraison

1. Intégrer après revue les changements de la branche de travail
   `LAB-8-Mettre-en-place-le-parrainage-dans-la-plateforme` vers `release` : le
   workflow de production refuse les autres branches. Faire passer les tests et
   le build du commit corrigé dans GitHub Actions. Le poste utilise Node 24.11.0,
   plus ancien que le 24.22.1 exigé par `.nvmrc`, `package.json` et Docker ; garder
   la version CI prévue et mettre à jour l'outillage local séparément.
2. Vérifier les migrations réellement en attente sur la cible avant la fenêtre
   de livraison. Cette revue n'a pas lu la table de migrations RDS ; ne pas
   supposer que seules les cinq dernières migrations sont en attente.
3. Le workflow `deploy.yml` construit une image ARM64 à digest immuable, lance
   `database:assert-bootstrap:prod` puis `migration:run:prod`, et n'actualise ECS
   qu'après succès. Conserver `migrationsTransactionMode: each` : l'index
   `DiscoveryGeographyIndex1780000136000` s'exécute hors transaction, avec attente
   de verrou bornée à 3 secondes et construction à 5 minutes. Un échec arrête la
   livraison, sans forcer ou falsifier le statut de migration.
4. Les migrations `PerformanceWorkQueues1780000135000` et `1780000136000`
   préparent GPS/recherche ; `ZwangaProFoundations1780000137000`,
   `ZwangaProSettlements1780000138000` et `ZwangaProOperations1780000139000`
   préparent les nouvelles tables/colonnes financières. Le backend les attend.
5. Vérifier la nouvelle révision PRIMARY/COMPLETED, les deux cibles ALB, `/health`
   et les erreurs de workers. Recetter recherche, notification ciblée, récupération
   et dépose avec comptes de test maîtrisés avant la montée de charge. Les
   produits Pro restent désactivés jusqu'à recette complète ; la clé d'identité
   de stock et les interfaces complémentaires sont des prérequis à leur ouverture.
6. Livrer les clients admin/partenaire/mobile compatibles après les nouveaux
   endpoints. Les anciennes listes complètes restent disponibles pour les anciens
   mobiles : leur coût n'est pas supprimé tant que ces clients les utilisent.
7. L'événement root étant confirmé volontaire, attendre un état de supervision sain. Avec une
   nouvelle autorisation, refaire d'abord la petite sonde en lecture seule et
   comparer temps SQL, p95 serveur/client et erreurs. Ne pas monter directement à
   1 000 trajets : GPS, dispatch, push, paiements et reprise nécessitent un banc
   isolé représentatif et un protocole distinct.

Un rollback applicatif ne doit pas ignorer des réserves de gains Pro actives.
Les migrations additives peuvent rester en place ; ne pas vider les files ni
supprimer les journaux pour revenir en arrière. Voir
[les conditions de repli Pro](../zwanga-pro-integration.md).

## Vérifications

Contrôles locaux effectués pendant cette revue :

- 35 tests Node réussis : dépendances/intégrations, politique CI, KMS,
  dimensionnement, cohérence du backend Terraform et garde-fous de la sonde.
- 27 tests unitaires Jest réussis : options TypeORM, architecture et politiques
  Pro, puis 3 contrôles des budgets de migration.
- 57 tests PostgreSQL réussis au terme des relances : 36 Pro, 7 statistiques et
  pagination, 7 files GPS/notifications, 6 recherches et 1 profilage. Les 14 tests
  statistiques/files ont également été relancés avec le budget SQL ajouté.
- ESLint ciblé sur le harnais PostgreSQL et les nouveaux tests de migration :
  aucune erreur. `terraform validate` réussi après une première tentative
  interrompue par le démarrage trop lent du fournisseur.
- Audit des dépendances de production : aucune vulnérabilité connue signalée.
- Contrôle de documentation infrastructure et `git diff --check` réussis.

La compilation NestJS initiale et sa relance finale ont réussi. Des fichiers de
mise à jour mobile ont été modifiés en parallèle hors du périmètre de cette
revue : ils n'ont pas été édités et leurs scénarios métier ne sont pas couverts
par nos suites ciblées. Aucune suite complète
GitHub Actions, image Docker ARM64 locale, migration de production ou recette
sur téléphone n'est déduite de ces contrôles ciblés.

Une première initialisation PostgreSQL jetable a dépassé 60 secondes sur ce
poste, puis une préparation de schéma/données a dépassé 120 secondes pendant
des vérifications concurrentes. Le profilage exécuté seul a ensuite réussi
en 91,7 secondes au total, dont 50,1 secondes de préparation. Son délai de
préparation est séparé du budget SQL `EXPLAIN` conservé à 10 secondes.
Le harnais utilise désormais `initdb --no-sync` uniquement pour les
répertoires de test neufs, ce qui évite d'attendre la synchronisation initiale
sur disque. Le paramètre serveur `fsync` reste activé, vérifié dans le test de
profilage. Cette option est prévue pour les tests et ne doit pas servir à créer
une base de production ([documentation PostgreSQL](https://www.postgresql.org/docs/18/app-initdb.html)).

Le contrôle connecté utilisé est `node test/load/production-readonly.cjs --preflight`,
pas `--run-confirmed-readonly`. Aucune alarme, permission KMS, taille d'instance,
paramètre SSM ni donnée applicative n'a été modifiée.
