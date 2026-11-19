# Correctifs des notifications et des traitements coûteux

Les correctifs locaux du 19 novembre 2026 suppriment la diffusion générale au démarrage, retirent la progression automatique du chemin d'accusé de réception GPS et réduisent les recherches et chargements d'historique coûteux. Les clients admin, partenaire et mobile utilisent désormais les nouveaux contrats bornés décrits ci-dessous. Les styles admin et partenaire sont conservés ; les contrôles de pagination réutilisent leurs composants/classes existants.

Le déploiement nécessite les migrations techniques et le backend **avant** les clients. Ces corrections ne constituent pas une validation de capacité à 1 000 trajets simultanés.

## Notification de démarrage

Une push `trip_started` est préparée uniquement pour les passagers possédant une réservation **acceptée sur ce trajet**. Cela inclut les commandes acceptées, qui créent une réservation. Le conducteur du trajet, les autres utilisateurs, les comptes indisponibles et les réservations en attente, refusées ou annulées sont exclus, même s'il reste des places libres.

L'intention d'envoi est enregistrée dans la même transaction que le démarrage ou la reprise. Une transaction annulée ne laisse aucune alerte. La clé d'événement déduplique les destinataires et les tentatives concurrentes. L'envoi utilise l'outbox existante, après commit, sans attendre le fournisseur push dans la requête de démarrage.

Au moment de l'envoi et des relances, le backend vérifie à nouveau que le trajet est en cours et que le destinataire reste un passager accepté. Ce contrôle s'applique aussi aux anciennes notifications encore traitées par le backend. Il ne peut pas rappeler une notification déjà confiée à FCM/Expo.

Les messages de sécurité aux contacts de confiance, distincts des push de disponibilité, conservent leur politique existante.

## Positions et progression automatique

Les endpoints de positions conducteur/passager et le gateway Socket.IO attendent la persistance de la position et l'inscription durable du travail avant de répondre. Ils n'attendent plus l'évaluation de récupération/dépose ni les appels push qu'elle peut produire. Les contrôles d'appartenance, de qualité et d'ordre temporel restent en place.

`ride_progress_jobs` conserve au plus une ligne par trajet. Une nouvelle position incrémente sa version sans retirer un verrou actif. Le worker :

- détecte le travail chaque seconde et poursuit le traitement quand une place se libère ;
- traite au maximum quatre trajets simultanément par instance ;
- utilise `FOR UPDATE SKIP LOCKED`, un jeton de possession et un bail de 90 secondes, renouvelé toutes les 20 secondes ;
- conserve une position arrivée pendant le traitement et la réévalue ensuite ;
- réessaie un travail en échec après cinq secondes ; un processus arrêté laisse son travail récupérable après expiration du bail ;
- attend ses traitements actifs à l'arrêt normal.

Les confirmations automatiques et notifications de proximité sont enregistrées dans l'outbox avec une clé stable par réservation, type et destinataire. Une alerte de récupération/proximité n'est plus envoyée si la réservation est déjà terminée. Les événements Socket.IO sont diffusés séparément ; la reconnexion et la lecture de l'état serveur restent nécessaires pour récupérer un événement temps réel manqué.

Cette file ne remplace pas l'idempotence des transitions financières. Une perte prolongée de connexion ou de bail peut faire reprendre une évaluation : les contrôles métier existants restent indispensables. La progression relit les positions et l'historique ; ce n'est pas un journal garantissant une émission socket pour chaque point GPS.

## Réduction des lectures et du travail répété

- Les listes et détails de demandes chargent les fonctions Premium par identifiants uniques, en lots de 100, puis réutilisent la même map dans les sérialiseurs. Les règles de confidentialité restent inchangées.
- L'estimation de prix et les options de véhicules résolvent le départ et l'arrivée en parallèle. Les grilles tarifaires restent inchangées ; le budget des fournisseurs et la qualité du repli sont précisés plus bas.
- Le TTL des aperçus d'itinéraire devient **86 400 secondes**, soit une journée, au lieu de 86 400 000 secondes. Le test passe par le véritable adaptateur Redis avec transport simulé. Les anciennes clés ne sont pas purgées globalement ; leurs nouvelles écritures utilisent le TTL corrigé.
- La réconciliation financière utilise un bail partagé dans `maintenance_job_leases`, afin que plusieurs réplicas ne lancent pas normalement le même contrôle. La cadence reste alignée sur les fenêtres de cinq minutes. Le diagnostic parcourt désormais des pages de 200 réservations/comptes, séquentiellement, avec transactions courtes, timeout SQL de 2,5 secondes maximum, attente de verrou de 500 ms et budget de parcours de 45 secondes. Une interruption est signalée comme échec/incomplétude, jamais comme zéro anomalie. Aucun solde n'est réécrit par ce diagnostic.

## Recherche géographique et fournisseurs

Le filtre spatial de départ sépare les trajets utilisant une position conducteur récente des trajets utilisant le point de départ. Il conserve la règle de fraîcheur de 90 secondes, le traitement des positions nulles, les exclusions et l'ordre des résultats. La nouvelle forme permet au planificateur d'utiliser les index GiST, dont `IDX_trips_current_location`. La sélection reste bornée avant l'hydratation des relations.

Le test `trip-search-profile.postgres.spec.ts` compare le SQL généré et sa variante historique `CASE` sur 5 000 trajets synthétiques. Les identifiants et leur ordre sont identiques. Une exécution locale a mesuré **69,622 ms contre 2,726 ms**, avec un `BitmapOr` des index spatiaux dans le nouveau plan. Il s'agit du temps d'exécution SQL d'un scénario local, pas d'un p95 HTTP, d'une mesure RDS ni d'une garantie de gain à toute densité. L'index augmente aussi le travail des écritures GPS : surveiller ce coût après déploiement.

Les recherches lentes journalisent les durées de sélection et d'enrichissement ainsi que le nombre de résultats, sans le contenu des filtres ni les coordonnées.

Les estimations ont un budget cible de 12 secondes : géocodages parallèles de 4 secondes maximum par appel, Directions de 6 secondes maximum dans le budget restant et attente météo de 1,5 seconde maximum. Les appels Google identiques en cours sont mutualisés par processus ; 64 travaux distincts maximum sont retenus. Le délai annule le transport Google via `AbortSignal`, y compris si la lecture du cache a consommé le budget. Les autres usages Google gardent leur timeout existant.

En échec Directions, le repli de distance à vol d'oiseau reste possible et la réponse indique `estimateQuality=degraded`. Une estimation `complete` nécessite l'itinéraire, le trafic et des données météo disponibles. Une météo indisponible ne déclenche pas à elle seule une majoration ; les tarifs par véhicule ne sont pas changés. Le TTL météo corrigé est de 1 200 **secondes**, et une observation âgée de plus de 40 minutes n'est plus utilisée comme actuelle. Le délai de réponse météo ne garantit pas l'annulation de son rafraîchissement en arrière-plan.

## Compatibilité des listes mobiles

Les routes legacy `/trip-requests`, `/trip-requests/my-requests`, `/trip-requests/my-offers` et `/wallet/ledger` acceptent `page` et `limit` avec une limite maximale de 100. Elles gardent leur réponse en tableau et un tri stable. **Sans pagination explicite, elles conservent leur réponse historique complète.**

Ce maintien protège les anciennes versions publiées. Le mobile local ne calcule plus ses compteurs de demandes depuis les historiques complets ; la recherche conducteur ne télécharge plus toute la collection visible.

| Client | Contrat utilisé | Limite et garanties |
| --- | --- | --- |
| Profil mobile | `GET /trip-requests/my-stats` | Compteurs SQL personnels, y compris offres en attente ; expiration effective évaluée sans modifier l'historique pendant cette lecture. |
| Recherche conducteur | `GET /trip-requests/discovery?page&limit&search&minSeats&sort` | 30 demandes par page dans le mobile, 100 maximum côté API. Recherche et tri avant pagination ; total serveur. Les refus, la proximité, le véhicule, la disponibilité et les droits conducteur restent contrôlés. |
| Fiche utilisateur admin | `GET /admin/users/:id/details?view=summary` puis `GET /admin/users/:id/history/:kind?limit&before` | Résumé SQL indépendant, cinq historiques de 25 éléments par page. Curseurs propres à l'utilisateur et à la section, boutons précédent/suivant et reprise sur erreur. |
| Espace terrain partenaire | `GET /partners/organizations/:id/field/overview?view=summary` et `GET /partners/organizations/:id/field/leads?page&limit&search&filter` | Liste de 25 éléments, filtres côté serveur, résumé complet mis en cache 30 secondes. Périmètre organisation/agent revalidé avant lecture du cache. Le support ne charge que la page recherchée et le prospect sélectionné. |

Les valeurs `:kind` sont `trips`, `bookings-passenger`, `bookings-driver`, `payments`, `requests`. La recherche conducteur accepte `nearby`, `soon` et `cheap` ; ce dernier conserve le sens existant côté conducteur : budgets proposés les plus élevés en premier. Le partenaire accepte aussi `status` et `id` pour une sélection précise dans son périmètre.

Les listes mobiles de demandes personnelles/offres et le wallet gardent les contrats `/trip-requests/pages/*` et `/wallet/ledger/page` existants. Les pages de découverte sont des vues vivantes : une acceptation ou une annulation entre deux pages peut déplacer des lignes. Les refus et expirations sont également retirés du cache mobile local. En arrière-plan, le dernier affichage et son total sont conservés sans relancer les abonnements ; ils ne sont pas réutilisés pour une autre identité.

Les exports de parrainage diffusent les comptes, récompenses et retraits par lots au lieu de construire toute la collection en mémoire. Récompenses/retraits utilisent un curseur ; les comptes restent paginés par `updatedAt,id`. Leur export n'est donc pas un instantané global immuable si ces champs changent pendant la lecture.

## Migration et mise en service

La migration `PerformanceWorkQueues1780000135000` crée les deux tables techniques et l'index de travail disponible. La migration `DiscoveryGeographyIndex1780000136000` crée l'index GiST de position conducteur avec `CREATE INDEX CONCURRENTLY`, vérifie sa validité et permet de reprendre une construction interrompue ayant laissé cet index invalide. Elle borne l'attente de verrou à 3 secondes et la construction à 5 minutes ; un timeout doit être traité avant de poursuivre le déploiement. Aucune des deux ne modifie les soldes, prix ou réservations existants.

La migration concurrente doit s'exécuter avec le mode TypeORM **`each`**, pas dans une transaction globale `all`. Elle restaure les timeouts de session en sortie.

1. Construire et tester le backend localement.
2. Vérifier la liste des migrations en attente sur la cible : les migrations précédentes présentes dans le dépôt peuvent aussi être en attente.
3. Faire exécuter les migrations par le mécanisme de déploiement existant **avant** de lancer cette version du backend. Sans les tables techniques, les nouvelles positions ne seront pas acquittées avec succès.
4. Déployer ensuite admin/partenaire et la version mobile compatible. Ne pas publier ces clients avant les nouveaux endpoints ; ne pas ajouter un repli silencieux vers tout l'historique sur erreur.
5. Vérifier un démarrage réservé, un démarrage sans passager accepté, une récupération et une dépose synthétiques ; contrôler la file et les erreurs du worker. Vérifier les compteurs, la recherche et plusieurs pages sur chaque client, ainsi que les frontières entre organisations/comptes.
6. Comparer les latences GPS, SQL et HTTP avant/après, puis seulement envisager une montée de charge progressive autorisée.

Le retour au binaire précédent peut conserver ces tables additives. Un rollback de migration exige l'arrêt des producteurs/workers, une file GPS vide et aucun bail de maintenance actif. La migration refuse la suppression dans les autres cas ; ne pas vider la file pour contourner cette protection.

Contrôle de file en lecture seule, sur la cible appropriée :

```sql
SELECT count(*) AS pending_trips,
       max(greatest(0, extract(epoch FROM clock_timestamp() - "availableAt"))) AS oldest_due_seconds
FROM ride_progress_jobs;
```

Un âge qui augmente durablement indique un retard de traitement à examiner. Ce contrôle n'ajoute pas automatiquement une alarme CloudWatch.

## Validation et travaux restants

La suite générale et les tests complémentaires sont exécutés localement. Les tests PostgreSQL utilisent un cluster jetable sur `127.0.0.1`, sans charger les accès applicatifs. Ils couvrent le ciblage, la concurrence de démarrage, le rollback, l'obsolescence des push, la conservation des nouvelles positions et la reprise des baux.

Première campagne du 19 novembre 2026 (notifications/GPS), sans additionner les campagnes qui se recouvrent :

- Compilation finale `npm run build` : réussie.
- Suite générale : **335 suites / 4 120 tests réussis**, 52 suites / 1 070 tests ignorés selon leurs conditions d'exécution. Cette campagne précède les dernières retouches, revérifiées ci-dessous.
- Revalidation ciblée après les dernières retouches : **14 suites / 174 tests réussis** ; les sept tests PostgreSQL optionnels sont exécutés séparément.
- Revalidation des notifications : **31 suites / 376 tests réussis**, 30 tests optionnels ignorés.
- PostgreSQL isolé : **sept tests réussis**, y compris les refus de rollback tant qu'une file ou un bail actif subsiste.

Les tests de proximité vérifient également qu'une position proche de l'arrivée avant la récupération ne consomme pas prématurément l'alerte unique destinée au passager embarqué.

Une exécution parallèle ciblée a signalé un worker Jest arrêté de force après les assertions réussies. La relance séquentielle avec `--detectOpenHandles` a terminé normalement : **174 tests réussis**, aucun handle restant signalé. L'avertissement parallèle n'a pas été reproduit dans cette relance.

### Complément : autres traitements coûteux et clients

La campagne complémentaire couvre la recherche géographique, les nouveaux contrats paginés, les agrégats et les budgets fournisseurs. Les premiers échecs ont conduit à corriger le harnais PostgreSQL (serveur et processus Node en UTC pour les colonnes `timestamp`), à aligner le test de proximité sur la règle « passager déjà embarqué », et à conserver le total mobile avec la liste lorsque l'écran est inactif. Les contrôles métier n'ont pas été désactivés pour faire passer les tests.

- Suite backend complète : **339 suites / 4 130 tests réussis**, zéro échec ; 54 suites / 1 079 tests ignorés selon leurs conditions d'exécution. Les tests PostgreSQL optionnels ci-dessous ont été lancés explicitement. Après les dernières retouches (dates de pagination et réutilisation du formateur de dates terrain), **7 suites / 40 tests ciblés réussis**. Ces campagnes se recouvrent et ne doivent pas être additionnées.
- Compilation backend `npm run build` : réussie.
- PostgreSQL/PostGIS isolé : **4 suites / 21 tests réussis**, dont les migrations concurrentes, la visibilité des demandes, les pages admin/partenaire, les comptes financiers, les exports et la reprise GPS/outbox.
- Mobile JavaScript ciblé : **97 tests réussis** (profil, recherche paginée, pause des écrans, refus et expirations).
- Partenaire : **15 fichiers / 98 tests réussis**, dont les contrats du mode mock. Ces tests mock ne prouvent pas à eux seuls la connexion au backend réel ; les services SQL sont vérifiés séparément ci-dessus.
- Admin : **81 tests existants réussis**, puis **2 nouveaux tests de pagination réussis** (contrats, totaux, curseurs et reprise sur erreur).
- Vérifications TypeScript sans émission : réussies pour le backend, l'admin, le partenaire et le mobile. Ces compilations ne remplacent pas les builds natifs ni la recette navigateur.

La suite générale parallèle a de nouveau signalé un worker arrêté de force après les assertions réussies. La relance des sept suites ciblées avec `--runInBand --detectOpenHandles` a terminé normalement : 40 tests réussis et aucune ressource ouverte signalée. L'origine de l'avertissement global n'est pas identifiée ; il n'est pas présenté comme résolu. La compilation backend a été relancée avec succès après les dernières modifications, ainsi que les sept tests PostgreSQL d'agrégats/pagination (sans les additionner aux 21 précédents).

Reproduction des tests PostgreSQL locaux (PowerShell, binaires PostgreSQL avec PostGIS installés) :

```powershell
$env:TZ = 'UTC'
$env:PERFORMANCE_TEST_POSTGRES_BIN = 'C:/Program Files/PostgreSQL/18/bin'
$env:TRIP_SEARCH_TEST_POSTGRES_BIN = $env:PERFORMANCE_TEST_POSTGRES_BIN
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/admin/remaining-performance.postgres.spec.ts src/tracking/performance-workflows.postgres.spec.ts src/trips/trip-search-profile.postgres.spec.ts src/trips/trip-search-postgres.spec.ts
```

### Limites et recommandations suivantes

- Le diagnostic financier reste un parcours historique complet, désormais paginé et borné en temps. Il n'est pas devenu incrémental. Un compte au journal très volumineux peut encore dépasser le timeout ; ne jamais interpréter cet échec comme une absence d'anomalies. Prochaine étape : contrôle incrémental des comptes modifiés, avec audit complet périodique séparé.
- Le statut terrain est dérivé des données utilisateur/KYC/trajet : ses filtres et totaux parcourent encore les prospects par lots de 200, avec budget de 10 secondes et timeout SQL court. La mémoire est bornée, pas le coût total indépendant de l'historique. Le résumé peut avoir 30 secondes de retard. Mesurer avant d'introduire une projection persistante des statuts.
- Les contrats legacy complets restent accessibles pour compatibilité. Mesurer leur utilisation et migrer les anciens clients avant de les retirer ; aucun plafond silencieux n'est appliqué aux anciennes réponses.
- Vérifier sur AWS les plans réels, les attentes du pool, le p95/p99, l'âge des files, les écritures GPS et les erreurs fournisseur. Les résultats locaux ne prouvent ni le délai de livraison sur téléphone, ni la reprise en veille, ni la capacité à 1 000 trajets.
- Effectuer une recette navigateur des nouveaux contrôles admin/partenaire et une recette mobile sur appareils physiques. Aucun changement CSS n'est nécessaire à ces intégrations ; les tests JavaScript ne remplacent pas une vérification visuelle.
- Intégrer explicitement ces suites PostgreSQL optionnelles au contrôle CI avec les binaires PostGIS et `TZ=UTC`, et isoler l'avertissement d'arrêt des workers de la suite complète.

Aucun déploiement AWS, changement de dimensionnement, test de charge en production, push réelle, SMS ou paiement réel n'est effectué par ces validations. Le guide PostgreSQL a orienté les transactions courtes, les claims concurrents et les tests de reprise ; la note suit le format de documentation opérationnelle du dépôt.
