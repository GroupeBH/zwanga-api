# Expiration des demandes selon l'acceptation

Règle corrigée le 12 septembre 2026. Elle remplace l'ancien délai de douze heures.

## Échéances

Les deux délais partent de `departureDateMax`, l'heure maximale de départ souhaitée.

- Sans conducteur accepté : `departureDateMax + 30 secondes`.
- Avec conducteur accepté : `departureDateMax + 2 heures`.

Exemple pour un départ souhaité au plus tard à 15 h : 15 h 00 min 30 s sans
acceptation, 17 h avec acceptation. La comparaison est inclusive à l'échéance.

`createdAt`, `selectedAt`, une nouvelle offre et les rafraîchissements n'ajoutent
aucun délai. Les dix minutes de mise en avant sur Home sont indépendantes.

Une acceptation est reconnue par `driver_selected`, `selectedDriverId`,
`tripId` ou une offre `accepted`. Une offre seulement en attente, rejetée ou
annulée reste dans le régime des trente secondes.

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
réservations reste intact. Les actions sur une demande expirée sont désactivées,
mais l'ouverture du trajet déjà créé reste possible.

Le minuteur est suspendu en arrière-plan et réévalue les données au retour au premier
plan ; il est annulé à la réinitialisation de l'API. Les données déjà chargées expirent
aussi hors connexion, sous réserve de l'heure de l'appareil. Le serveur conserve
l'autorité sur une acceptation reçue ensuite. Aucune demande déjà expirée n'est
réactivée automatiquement par le déploiement.

## Vérifications et déploiement

Les tests couvrent les limites à trente secondes et deux heures, les offres non
acceptées, une acceptation tardive, les liens au trajet, la confidentialité après
expiration, les écritures conditionnelles, le contrôle de version, le cron attendu,
le hors-ligne, l'arrière-plan et l'isolation de compte.

Déployer le backend et l'application, puis tester sur appareils les deux échéances,
un changement d'horaire, une acceptation juste avant expiration et une course en
cours au moment de l'expiration de sa demande. Les tests locaux ne constituent pas
un test de charge ni une validation contre la base de production.
