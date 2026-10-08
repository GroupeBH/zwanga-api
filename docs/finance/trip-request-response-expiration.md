# Expiration des demandes selon l'acceptation

Règle mise à jour le 8 octobre 2026 : trois heures sans conducteur confirmé,
au lieu des trente secondes appliquées depuis le 12 septembre. Deux heures
conservées pour les demandes acceptées ; ce changement ne prolonge pas un trajet engagé.

## Échéances

Les deux délais partent de `departureDateMax`, l'heure maximale de départ souhaitée.

- Sans conducteur accepté : `departureDateMax + 3 heures`.
- Avec conducteur accepté : `departureDateMax + 2 heures`.

Exemple pour un départ souhaité au plus tard à 15 h : 18 h sans
acceptation, 17 h avec acceptation. La comparaison est inclusive à l'échéance.

`createdAt`, `selectedAt`, une nouvelle offre et les rafraîchissements n'ajoutent
aucun délai. Les dix minutes de mise en avant sur Home sont indépendantes.

Une acceptation est reconnue par `driver_selected`, `selectedDriverId`,
`tripId` ou une offre `accepted`. Une offre seulement en attente, rejetée ou
annulée reste dans le régime des trois heures.

La recherche GPS immédiate continue seulement jusqu'à `departureDateMax` ; les
invitations individuelles gardent leur délai court. Ces trois heures ne prolongent
ni le créneau proposé à un conducteur, ni la validité d'une invitation. Pour un
nouveau départ, le passager doit reprogrammer sa demande. Les délais des demandes
acceptées ne sont pas recalculés depuis `selectedAt`.

## Demande, trajet et historique

Seule la demande passe à `expired`. Les liens vers le conducteur, le véhicule,
les offres et le trajet sont conservés pour l'historique.

**L'expiration ne supprime ni n'annule aucun trajet, réservation ou paiement.**
Le suivi d'un trajet démarré reste disponible dans les écrans de trajets.
Aucun débit, remboursement, crédit ou versement n'est déclenché par ce contrôle.

Les demandes acceptées ne sont plus publiques dès l'acceptation. Le délai de deux
heures concerne leur présence dans les demandes actives de leurs participants,
pas une exposition supplémentaire aux autres conducteurs. Le détail et l'historique
restent accessibles aux personnes autorisées après expiration. La confidentialité
continue d'utiliser les identifiants du conducteur et du trajet, même avec le statut
`expired` et sans ancien enregistrement d'offre.

## Backend

`expireRequests` applique les échéances lors des lectures de demandes, des
actions existantes et avant la création d'un trajet depuis une demande acceptée.
Le cron `markExpiredTripRequests` passe toutes les trente secondes, attend sa
promesse complète et ne superpose pas deux exécutions dans une même instance.

Les candidats sont filtrés sur `departureDateMax` (index existant), puis la règle
choisit le délai selon l'acceptation. La mise à jour ne porte que sur le statut de
la demande et vérifie son statut, son conducteur, son trajet, sa plage de départ
et son horodatage de modification lus auparavant. La comparaison de `updatedAt`
conserve le contrôle de version à la précision milliseconde fournie par le pilote
Postgres à JavaScript ; le stockage Postgres peut avoir des microsecondes.

Une acceptation ou un changement d'horaire déjà persisté n'est pas écrasé si ces
conditions ne correspondent plus. Seules les mises à jour affectant une ligne
produisent une expiration locale ou une notification. Les notifications partent
après les écritures, sans appel réseau dans une transaction. Aucun schéma ni index
n'est modifié, et aucune migration n'est nécessaire.

La persistance par cron peut arriver au passage suivant ; les lectures appliquent
la règle immédiatement, sans attendre le cron. La disparition mobile ne dépend
pas de cette latence.

## Notifications

Une demande non acceptée conserve sa notification informative d'expiration.
Une demande acceptée ne reçoit pas de faux message « aucun conducteur accepté »,
ni de message assimilable à une annulation de son trajet.

Le rappel de prise en charge en retard ne vise que les demandes acceptées encore
dans leur délai de deux heures. L'expiration ne déclenche pas la modale de libération
du conducteur. Les rappels avant expiration des demandes non acceptées suivent
désormais la nouvelle échéance.

## Application

`features/trip-request/requestExpiration.ts` porte les mêmes constantes et critères.
Le middleware `store/middleware/tripRequestExpiration.ts` utilise un seul minuteur
pour les caches RTK Query. Il vise l'échéance la plus proche avec une réévaluation
bornée à trente secondes, sans aucune requête HTTP supplémentaire.

Le cache public perd les demandes expirées ; les caches de détail et d'historique
conservent les demandes avec `expired`. Le Home, la recherche, les marqueurs et les
compteurs actifs se mettent ainsi à jour ensemble. Le cache des trajets et des
réservations reste intact. Une demande expirée sans conducteur confirmé peut être
reprogrammée ; une demande déjà prise en charge conserve uniquement les actions
compatibles avec son historique, dont l'ouverture du trajet créé.

Le minuteur est suspendu en arrière-plan et réévalue les données au retour au premier
plan ; il est annulé à la réinitialisation de l'API. Les données déjà chargées expirent
aussi hors connexion, sous réserve de l'heure de l'appareil. Le serveur conserve
l'autorité sur une acceptation reçue ensuite. Aucune demande déjà expirée n'est
réactivée automatiquement par le déploiement.

## Vérifications et déploiement

Les tests couvrent les limites à trois heures et deux heures, les offres non
acceptées, une acceptation tardive, les liens au trajet, la confidentialité après
expiration, les écritures conditionnelles, le contrôle de version, le cron attendu,
le hors-ligne, l'arrière-plan et l'isolation de compte.

Déployer le backend et l'application, puis tester sur appareils les deux échéances,
un changement d'horaire, une acceptation juste avant expiration et une course en
cours au moment de l'expiration de sa demande. Les tests locaux ne constituent pas
un test de charge ni une validation contre la base de production.

## Modifier ou reprogrammer — 8 octobre 2026

### Demande du passager et administration

- `PUT /trip-requests/:id` : propriétaire authentifié.
- `PUT /admin/trip-requests/:id` : administrateur, délégation contrôlée vers le même service.
- Statuts modifiables : `pending`, `offers_received` et `expired`, seulement sans
  conducteur sélectionné, offre acceptée ou trajet lié. Les demandes annulées
  ne sont pas réactivées. Une demande acceptée expirée n'est pas une demande libre.
- Pour rouvrir une demande expirée (y compris avant le passage du cron), envoyer
  **les deux** dates : `departureDateMin` strictement future et `departureDateMax`
  après celle-ci. L'identifiant reste le même, le statut redevient `pending` et
  le rappel d'expiration est réinitialisé.
- Les lieux, repères, coordonnées, dates, places, type de véhicule, budget,
  paiement et description restent éditables. Contrôles de capacité/KYC conservés.
  Un prix confirmé n'est pas remplacé automatiquement par une estimation.
- Une modification effective retire les anciennes offres en attente (`rejected`)
  et annule les invitations dispatch encore en attente (`cancelled`) ; elles ne
  peuvent pas être acceptées avec des conditions anciennes. Un formulaire sans
  changement n'invalide rien. Aucune notification supplémentaire de diffusion
  générale n'est envoyée lors de la modification.
- Une demande immédiate reprogrammée après expiration, ou au-delà de l'horizon
  immédiat (début à plus de dix minutes / fin à plus d'une heure), devient une
  demande classique. Sinon le dispatch continue avec les conducteurs non encore
  sollicités ; sa limite d'une invitation par conducteur et demande est conservée.
- `expectedUpdatedAt` est facultatif pour compatibilité. Les interfaces mises à
  jour envoient la valeur à l'ouverture du formulaire : réponse `409` si elle est
  périmée. Fermer, actualiser et rouvrir avant de réessayer ; pas de retry automatique.
  Les mises à jour techniques `dispatchCheckedAt` et du rappel d'expiration ne
  modifient plus cet horodatage.

Les calculs/geocodages restent hors transaction. Sous verrou de la demande,
le service recontrôle le snapshot, les liens, les offres acceptées et le nouveau
créneau, puis persiste uniquement les champs éditables. Création/acceptation
d'offre et insertion finale d'un trajet issu d'une acceptation directe utilisent
le même verrou. Le guide PostgreSQL a orienté ces transactions courtes et cet
ordre de verrouillage ; aucun changement de schéma ni variable d'environnement.

### Trajet publié du conducteur

`POST /trips/:id/reprogram` reçoit les champs de `UpdateTripDto`, avec une nouvelle
`departureDate` future obligatoire, et renvoie **un nouveau trajet / identifiant**.
Le propriétaire doit encore respecter les conditions de publication (compte,
KYC, véhicule, photo, quotas, modes de paiement et règles financières).

Admissible : trajet public dont la date de départ est passée, jamais démarré,
statut `upcoming` ou `completed`, sans demande liée, réservation active ni trace
d'embarquement. Le statut historique ne distingue pas un trajet terminé sans
démarrage d'une expiration automatique ; ce contrôle ne prétend pas le faire.
Le champ de réponse facultatif `canReprogram` guide le mobile ; les conditions
sont toujours revérifiées à l'appel, même si le cache du client est ancien.

Les réservations, paiements et statuts de l'ancien trajet ne sont pas modifiés
ou transférés. La nouvelle publication repasse par `TripsService.create` ; son
échec ne rouvre pas l'ancien trajet. Les doubles clics sont bloqués dans le mobile,
mais cet endpoint de création n'a pas de clé d'idempotence persistante : après une
réponse réseau incertaine, vérifier « Mes trajets » avant de le relancer.

### Interfaces et livraison

Le détail mobile affiche « Modifier » ou « Reprogrammer ». Le formulaire de trajet
préremplit le précédent parcours et propose une date future ; il explique qu'une
nouvelle publication sera créée. Après succès, navigation vers son nouvel ID.
L'admin masque l'édition des demandes engagées et envoie seulement les champs
modifiés ; les dates `datetime-local` utilisent le fuseau du navigateur sans
supprimer les secondes des heures inchangées.

Déployer d'abord le backend, puis admin/mobile. Les anciennes versions restent
sur leurs endpoints existants, mais celles qui calculent trente secondes en local
peuvent encore masquer trop tôt une demande. Les nouvelles actions et l'affichage
à trois heures nécessitent la mise à jour mobile ; pas de correction rétroactive
des binaires déjà distribués. Aucun déploiement n'a été effectué dans cette tâche.

### Résultats locaux

- Suite backend globale : 1 556 tests réussis, 184 ignorés ; 142 suites réussies.
- Après l'ajustement final de l'horodatage du dispatch : 13 tests PostgreSQL 18 /
  PostGIS réussis sur cluster temporaire, dont édition simultanée à l'acceptation,
  invalidation d'offre et acceptation d'une nouvelle offre après modification.
  Les clusters ont été arrêtés et leurs données de test supprimées.
- Compilation backend, TypeScript mobile/admin sans émission : réussis.
- Tests Node ciblés mobile : 12 sur cache/expiration/édition et 4 sur republication,
  doubles clics, conservation du flux PUT et échec serveur. Admin : 3 tests sur
  dates locales, patch minimal et restrictions d'édition.
- Ces résultats ne remplacent pas les essais sur appareils, les tests de charge
  ou une validation sur AWS ; aucun service applicatif local n'a été lancé.
