# FIN-DRIVER-002 — Notification du montant conducteur à la fin du trajet

Dernière mise à jour : 31 août 2026
Statut : implémenté dans le backend et l'application mobile ; déploiement requis, aucune migration de base.

## 1. Besoin métier

À la clôture effective d'un trajet, le conducteur doit connaître immédiatement la situation financière des réservations réellement terminées :

- montant net déjà ajouté à ses gains pour les paiements électroniques ou en jetons confirmés ;
- montant brut à encaisser directement auprès des passagers ayant choisi le liquide ;
- montant net encore attendu lorsque le paiement électronique du passager n'est pas confirmé.

La notification ne doit jamais présenter une somme liquide comme un solde retirable sur Zwanga et ne doit jamais présenter un paiement électronique en attente comme déjà acquis.

## 2. Comportement avant et après

Avant ce changement, le modal conducteur confirmait uniquement l'arrivée à destination et proposait de noter les passagers. Aucun montant n'était affiché et aucune notification financière dédiée n'était envoyée.

Après ce changement :

1. la transition unique du trajet de `ongoing` vers `completed` déclenche le calcul serveur ;
2. une notification push `driver_trip_revenue` est persistée puis envoyée par le fournisseur correspondant au token du conducteur ;
3. l'événement de progression automatique contient le même résumé pour le modal en temps réel ;
4. l'application interroge l'endpoint authentifié si l'événement reçu par REST ou Socket.IO ne contient pas le résumé ;
5. le modal sépare visuellement les montants confirmés, liquides et électroniques en attente ;
6. un appui sur la notification ouvre l'espace **Revenus conducteur**.

Si le paiement électronique est encore attendu à la clôture, la création ultérieure et unique du `driver_earning` envoie une notification `driver_booking_earning_confirmed`. Le conducteur est ainsi informé lorsque le montant passe réellement dans ses gains, même s'il a déjà quitté l'écran du trajet.

## 3. Réservations prises en compte

Une réservation contribue au résumé uniquement lorsqu'au moins une preuve persistée de dépose existe :

- `status = completed` ;
- `droppedOff = true` ;
- `droppedOffConfirmedByPassenger = true` ;
- `droppedOffAt` ou `droppedOffConfirmedAt` renseigné.

Les réservations `pending`, `rejected`, `cancelled`, `no_show`, `boarding_uncertain` ou `expired` sans preuve de dépose ne génèrent aucun montant.

Le montant brut vient en priorité de `booking.paymentAmount`, figé par le serveur à l'arrivée. Pour une ancienne réservation où cette valeur manque, le repli est `trip.pricePerSeat × max(1, numberOfSeats)`. Un trajet gratuit produit `0`.

## 4. Calculs affichés

Soit `G` le montant brut d'une réservation terminée et `r` le taux `ZWANGA_COMMISSION_RATE`.

```text
net électronique ou jetons = arrondi_centime(G × (1 - r))
liquide à encaisser = G
total attendu affiché = confirmé net + électronique attendu net + liquide brut
```

Avec `r = 0,05` :

- paiement électronique confirmé de `10 000 CDF` : `9 500 CDF` dans **Gain ajouté** ;
- paiement électronique non confirmé de `10 000 CDF` : `9 500 CDF` dans **Paiement électronique attendu** ;
- paiement liquide de `10 000 CDF` : `10 000 CDF` dans **À encaisser en liquide**.

Le montant liquide correspond à la somme que le passager remet directement au conducteur. Il n'est pas inséré dans `driver_earnings`, n'augmente pas le solde retirable et ne déclenche pas de transfert FlexPay. Le système actuel ne prélève pas automatiquement la commission Zwanga sur le liquide ; un mécanisme de dette ou de compensation serait une évolution financière distincte.

## 5. Signification des trois montants

| Champ API                 | Libellé application           | Signification comptable                                                |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `confirmedAmount`         | Gain ajouté                   | revenu net d'un paiement électronique ou en jetons confirmé            |
| `cashToCollectAmount`     | À encaisser en liquide        | prix brut à recevoir directement du passager                           |
| `electronicPendingAmount` | Paiement électronique attendu | revenu net estimé, non retirable avant confirmation                    |
| `totalExpectedAmount`     | total technique               | somme des trois compartiments, sans création d'écriture supplémentaire |

## 6. Idempotence et concurrence REST/Socket.IO

La clôture manuelle utilise désormais une mise à jour conditionnelle :

```text
UPDATE trips
SET status = completed
WHERE id = :tripId AND driverId = :driverId AND status = ongoing
```

La clôture automatique appliquait déjà la même comparaison d'état. Une seule voie — REST ou Socket.IO — peut donc obtenir `affected = 1` et publier la notification de fin.

Dans l'application, la clé `driver_arrived_destination:<tripId>:completed` empêche l'ouverture répétée du modal lorsque le même résultat arrive par Socket.IO puis par synchronisation REST. La récupération HTTP du résumé vérifie encore que le modal courant concerne le même trajet avant de modifier son état.

## 7. Push notification

Types :

- `driver_trip_revenue` pour le résumé produit par la clôture du trajet ;
- `driver_booking_earning_confirmed` lorsqu'un paiement électronique postérieur à la clôture crée effectivement le revenu retirable.

Exemple de données :

```json
{
  "type": "driver_trip_revenue",
  "role": "driver",
  "driverId": "uuid-conducteur",
  "tripId": "uuid-trajet",
  "currency": "CDF",
  "confirmedAmount": 9500,
  "cashToCollectAmount": 5000,
  "electronicPendingAmount": 4750,
  "totalExpectedAmount": 19250
}
```

Le corps est composé uniquement des compartiments non nuls. La livraison dépend du format du token :

- `ExponentPushToken[...]` ou `ExpoPushToken[...]` : API Expo Push ;
- tout autre token mobile : Firebase Cloud Messaging.

Le backend ne mélange donc plus les tokens Expo et FCM. Pour Expo, le ticket d'acceptation est conservé puis son reçu est vérifié après quinze minutes, dans la fenêtre de disponibilité de 24 heures recommandée par Expo. Une réponse ou un reçu `DeviceNotRegistered`, `messaging/invalid-registration-token` ou `messaging/registration-token-not-registered` supprime le token uniquement s'il est encore celui enregistré sur l'utilisateur. Une rotation concurrente vers un nouveau token ne peut pas être effacée par l'échec de l'ancien.

La notification est enregistrée même lorsque le token manque ou que le fournisseur est indisponible. Les notifications financières `driver_trip_revenue` et `driver_booking_earning_confirmed` en échec, ainsi que les envois restés `pending`, sont repris toutes les cinq minutes pendant 72 heures, par lots de 25. La sélection utilise `FOR UPDATE SKIP LOCKED` dans une transaction courte ; l'appel réseau est exécuté après le commit afin de ne pas garder de verrou pendant une latence externe. La clôture du trajet reste réussie et le résumé demeure récupérable dans l'application.

La notification de confirmation tardive est idempotente : elle est envoyée uniquement dans la branche qui insère le nouveau `driver_earning`. Une nouvelle lecture du callback retrouve le revenu existant et n'envoie pas une seconde notification.

## 8. Contrat API

```text
GET /api/v1/driver-settlements/trips/:tripId/revenue-summary
Authorization: Bearer <JWT>
```

Le serveur utilise l'identité du JWT et exige que `trip.driverId` corresponde à l'utilisateur. Un autre utilisateur reçoit une réponse `404`, ce qui évite aussi de révéler l'existence ou les montants d'un trajet tiers.

Exemple de réponse :

```json
{
  "tripId": "uuid-trajet",
  "currency": "CDF",
  "commissionRate": 0.05,
  "confirmedAmount": 9500,
  "cashToCollectAmount": 5000,
  "electronicPendingAmount": 4750,
  "totalExpectedAmount": 19250,
  "completedBookings": 3,
  "generatedAt": "2026-08-26T11:00:00.000Z"
}
```

## 9. Interface mobile

Sur l'écran de navigation, le modal existant **Trajet terminé** est enrichi sans ajouter un second modal concurrent :

- vert : argent confirmé et ajouté aux gains ;
- ambre : liquide à encaisser directement ;
- bleu : paiement électronique encore attendu ;
- chargement court pendant le repli HTTP ;
- message non bloquant si le résumé est momentanément indisponible.

En dehors de l'écran de navigation, la réception au premier plan de `driver_trip_revenue` ouvre un modal global qui affiche :

- le total du trajet ;
- la part déjà acquise dans les gains ;
- le liquide à encaisser ;
- l'électronique encore attendue ;
- un bouton **Voir mes gains**.

La notification `driver_booking_earning_confirmed` ouvre également un modal lorsque le paiement électronique attendu devient réellement retirable. Sur `/trip/navigate/:id`, le gestionnaire global masque son push et son modal parce que le modal local, alimenté par Socket.IO avec repli REST, possède déjà cette clôture. Le conducteur peut toujours fermer le modal ou noter les passagers. Les montants sont formatés dans la devise renvoyée par le serveur.

## 10. Données, remboursements et effets financiers

- aucune table, colonne ou migration n'est ajoutée ;
- aucune écriture `driver_earning`, aucun débit et aucun retrait n'est créé par la notification ;
- les calculs lisent les états déjà persistés ;
- un paiement électronique échoué demeure dans le compartiment attendu tant que la réservation reste payable ;
- un `no_show` ou une dépose incertaine n'apparaît jamais comme revenu ;
- les règles de remboursement et de retrait de `FIN-DRIVER-001` restent inchangées.

## 11. Fichiers concernés

Backend :

- `src/notifications/notifications.service.ts` ;
- `src/notifications/notifications.service.spec.ts` ;
- `src/driver-settlements/driver-settlements.service.ts` ;
- `src/driver-settlements/driver-settlements.controller.ts` ;
- `src/driver-settlements/driver-settlements.module.ts` ;
- `src/trips/trips.service.ts` et `src/trips/trips.module.ts` ;
- `src/bookings/bookings.service.ts`.

Application :

- `components/NotificationHandler.tsx` ;
- `components/AuthGuard.tsx` ;
- `services/pushNotifications.ts` ;
- `app/trip/navigate/[id].tsx` ;
- `services/trackingSocket.ts` ;
- `store/api/driverSettlementsApi.ts` ;
- `utils/notificationNavigation.ts` ;
- `app/notifications.tsx` ;
- `types/index.ts`.

## 12. Configuration

Ce changement n'ajoute aucune variable d'environnement. Il utilise :

- `ZWANGA_COMMISSION_RATE` ;
- `TRIP_PAYMENT_CURRENCY` ;
- la configuration Firebase existante pour les tokens natifs ;
- l'API publique Expo Push pour les `ExpoPushToken`.

## 13. Tests

Les tests couvrent :

- `10 000 CDF` électronique confirmé donnant `9 500 CDF` net ;
- séparation du liquide, du confirmé et de l'électronique attendu ;
- exclusion d'un `no_show` ;
- contenu financier de la notification push ;
- aiguillage d'un `ExpoPushToken` vers Expo et persistance du ticket reçu ;
- conservation d'une notification financière sans token ;
- suppression conditionnelle d'un token Expo déclaré `DeviceNotRegistered` ;
- contrôle différé d'un reçu Expo refusé par APNs ou FCM ;
- verrouillage non bloquant du lot de reprise (`FOR UPDATE SKIP LOCKED`) ;
- notification unique lorsque le paiement électronique attendu devient un gain disponible après la clôture ;
- publication après une seule transition de fin réussie ;
- enrichissement de l'événement automatique ;
- compilation TypeScript backend et mobile.

## 14. Déploiement et validation

1. Déployer le backend sans migration.
2. Vérifier que l'endpoint de résumé répond uniquement au conducteur du trajet.
3. Publier la nouvelle version mobile.
4. Tester séparément un trajet liquide, électronique confirmé, électronique en attente et mixte.
5. Déclencher simultanément une mise à jour REST et Socket.IO près de la destination et confirmer qu'un seul modal apparaît.
6. Mettre l'application en arrière-plan et vérifier la réception du push.
7. Laisser l'application au premier plan hors navigation et vérifier le push ainsi que le modal global.
8. Vérifier qu'un seul modal apparaît lorsque le conducteur est encore sur `/trip/navigate/:id`.
9. Vérifier un appareil Android avec token natif et un appareil iOS avec `ExpoPushToken`.
10. Vérifier qu'un montant liquide ne modifie pas le solde de retrait.

## 15. Rapprochement et retour arrière

Le rapprochement consiste à comparer, pour chaque trajet testé :

```text
cashToCollectAmount = somme des paymentAmount des réservations cash déposées
confirmedAmount = somme des montants nets des réservations électroniques/jetons réussies
electronicPendingAmount = somme nette des réservations électroniques déposées non réussies
```

Le retour arrière retire l'endpoint, l'enrichissement de l'événement et l'affichage mobile. Aucune donnée financière ne doit être restaurée ou recalculée, car cette évolution est en lecture seule sur les écritures monétaires.
