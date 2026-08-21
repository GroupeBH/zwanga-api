# Paiement à l’arrivée et non-embarquement automatique

Identifiant : `FIN-BOOKING-001`

Statut : implémenté dans le code, migration non encore appliquée en production.

Dernière mise à jour : 21 août 2026.

## 1. Besoin métier

Le passager choisit son moyen de paiement pendant la réservation, mais il ne paie jamais avant son arrivée. La prise en charge, la progression physique de la course et le règlement financier sont donc trois responsabilités distinctes.

Si le conducteur attend au point de rendez-vous puis repart sans avoir embarqué le passager, la réservation doit être classée automatiquement `no_show` sans paiement. Ce classement reste récupérable pendant le trajet : si le GPS passager réapparaît et prouve ensuite un déplacement partagé avec le véhicule, l'embarquement est validé. Tant que cette preuve n'existe pas, la réservation ne produit ni revenu conducteur, ni jeton de fidélité, ni future récompense de parrainage.

## 2. Comportement avant et après

### Avant

- le choix `points` pouvait débiter les jetons dès la réservation ou lors d'un changement de mode ;
- les modes `electronic` et `points` pouvaient bloquer la confirmation de prise en charge ou d'arrivée tant qu'ils n'étaient pas prépayés ;
- l'application conducteur pouvait, à la destination finale, confirmer artificiellement la prise en charge puis l'arrivée de toutes les réservations encore acceptées ;
- une réservation non embarquée restait `accepted` et empêchait la fin automatique du trajet ;
- le partage de position du passager s'arrêtait lorsque l'application passait en arrière-plan.

### Après

- le mode est enregistré à la réservation sans débit ;
- la prise en charge n'exige aucun paiement préalable ;
- le règlement est ouvert uniquement après l'arrivée ;
- un non-embarquement détecté passe à `no_show` et ne bloque plus la fin du trajet ;
- un `no_show` peut revenir à `accepted` avec `pickedUp = true` si une preuve GPS tardive d'embarquement est obtenue avant la fin du trajet ;
- l'application ne fabrique plus de prise en charge ou d'arrivée à la destination finale ;
- l'embarquement et la dépose sont validés automatiquement ; les anciens endpoints manuels sont conservés uniquement comme mécanisme de reprise audité et ne sont plus proposés dans l'application ;
- la position passager peut continuer à être transmise en arrière-plan lorsque la permission système a été accordée.

## 3. Invariants financiers

1. Sélectionner un mode de paiement ne signifie pas payer.
2. Avant l'arrivée, `POST /bookings/:id/pay` est refusé par le serveur.
3. Avant l'arrivée, sélectionner `points` conserve `paymentStatus = pending` et ne crée aucun débit de portefeuille.
4. Une réservation `no_show` ou `boarding_uncertain` ne produit aucun débit, revenu, bonus, commission ou récompense.
5. Les récompenses de fidélité et revenus conducteur ne sont finalisés qu'après un règlement réussi, sauf pour les espèces et les courses gratuites qui sont hors encaissement électronique de la plateforme.
6. Une réservation complétée mais non payée par un mode électronique reste physiquement terminée et financièrement `pending`.
7. Une preuve physique ne doit jamais être fabriquée pour débloquer un traitement financier.

## 4. Cycle de vie

| Moment                                       | Statut réservation   | Mode                | Statut paiement                                          | Mouvement financier         |
| -------------------------------------------- | -------------------- | ------------------- | -------------------------------------------------------- | --------------------------- |
| Création                                     | `pending`            | choix du passager   | `pending` ou `not_required` si gratuit                   | aucun                       |
| Acceptation                                  | `accepted`           | inchangé            | inchangé                                                 | aucun                       |
| Embarquement                                 | `accepted`           | inchangé            | inchangé                                                 | aucun                       |
| Arrivée physique                             | `completed`          | inchangé            | dépend du mode                                           | voir section 5              |
| Non-embarquement                             | `no_show`            | conservé pour audit | `cancelled`, sauf paiement historique déjà réussi        | aucun nouveau mouvement     |
| Embarquement tardif prouvé après `no_show`   | `accepted`           | inchangé            | `pending` pour jetons/électronique, sinon `not_required` | aucun débit avant l'arrivée |
| Embarquement indéterminable à la destination | `boarding_uncertain` | conservé pour audit | `cancelled`, sauf paiement historique déjà réussi        | aucun nouveau mouvement     |

Les champs physiques `pickedUp*` et `droppedOff*` restent indépendants des champs `payment*`. Une décision automatique met à jour `pickedUp` ou `droppedOff` et sa méthode d'audit, mais ne fabrique pas les indicateurs historiques `*ConfirmedByPassenger`.

## 5. Traitement par moyen de paiement

### 5.1 Espèces

Le passager règle directement le conducteur à l'arrivée. Zwanga n'encaisse pas ce montant par FlexPay. Le backend place la réservation à `paymentStatus = not_required` pour indiquer qu'aucune transaction électronique n'est attendue.

Limite : le paiement physique n'est pas vérifiable automatiquement par la plateforme.

### 5.2 Paiement électronique

Le choix `electronic` est enregistré à la réservation avec un état en attente. Après `completed` ou une preuve de dépose persistée :

1. le passager appelle `POST /bookings/:id/pay` ;
2. le serveur recalcule le montant depuis le tarif persisté ;
3. FlexPay est initialisé ;
4. l'état devient `initiated`, puis `succeeded`, `failed` ou `cancelled` selon la réponse et le callback ;
5. fidélité et revenu conducteur sont finalisés seulement après `succeeded`.

Dans l'application passager, le modal de fin de trajet affiche le champ serveur `booking.paymentAmount` avec `booking.paymentCurrency` et rappelle le mode choisi à la réservation. L'application ne recalcule pas le tarif à partir du prix du trajet : elle conserve ainsi un éventuel montant ajusté. Lorsque `paymentMode = electronic`, que la dépose est confirmée et que le paiement reste dû, le modal affiche **Payer avec FlexPay**. Ce bouton appelle `POST /bookings/:id/pay` avec `method = mobile_money`, puis ouvre uniquement l'URL de paiement renvoyée par le serveur. Il n'est pas affiché pour les espèces, les jetons, une course gratuite ou un paiement déjà confirmé.

### 5.3 Jetons Zwanga

Le choix technique reste `points` pour compatibilité, mais l'interface affiche « jetons ».

- avant l'arrivée : aucun appel à `WalletService.payForBooking` ;
- à l'arrivée : le serveur tente le débit ;
- solde suffisant : `paymentStatus = succeeded` ;
- solde insuffisant ou erreur : la course reste `completed`, le paiement reste `pending` et l'utilisateur peut réessayer depuis la fenêtre d'arrivée.

Le montant d'une course interrompue conserve le montant ajusté déjà persisté. Le règlement d'arrivée ne remplace pas ce montant par le plein tarif initial.

### 5.4 Course gratuite

Si le montant serveur est nul, `paymentStatus = not_required`. Aucun portefeuille ni fournisseur de paiement n'est appelé.

## 6. Détection automatique du non-embarquement

Une réservation passe à `no_show` seulement si toutes les conditions suivantes sont réunies :

- réservation `accepted` sur un trajet `ongoing`/`active` ;
- aucune prise en charge déjà confirmée ;
- arrivée du conducteur au point de récupération persistée dans `driverPickupArrivedAt` ;
- délai d'attente de 10 minutes écoulé ;
- dernière position conducteur encore fraîche ;
- conducteur éloigné d'au moins 150 mètres du point de récupération ;
- une position passager fraîche existe encore au point de récupération ;
- cette position passager reste dans un rayon de 25 mètres du point de récupération ;
- cette position passager est séparée du conducteur de plus de 25 mètres.

L'absence ou l'ancienneté de la position passager ne constitue jamais une preuve d'absence. Sans position passager fraîche, le serveur n'émet donc pas `no_show`. Cette règle protège le passager quand Android/iOS suspend le GPS, quand le réseau disparaît ou quand la batterie coupe la tâche d'arrière-plan.

Le résultat est audité dans :

| Champ                        | Valeur                                          |
| ---------------------------- | ----------------------------------------------- |
| `status`                     | `no_show`                                       |
| `noShowDetectedAt`           | date serveur de décision                        |
| `noShowReason`               | `automatic_non_boarding`                        |
| `noShowDriverDistanceMeters` | distance conducteur-point de récupération       |
| `rejectionReason`            | texte métier d'audit                            |
| `paymentStatus`              | `cancelled` si aucun paiement historique réussi |

Un événement temps réel `passenger_no_show` est envoyé aux écrans conducteur et passager. Le passager reçoit aussi une notification push indiquant que le conducteur s'est éloigné, la distance constatée, l'absence de paiement et la nécessité de conserver sa localisation active en cas d'embarquement tardif. La notification est envoyée seulement après la mise à jour conditionnelle vers `no_show` : une concurrence REST/Socket.IO ne peut donc pas produire deux notifications pour la même transition.

### 6.1 Reprise tardive du GPS et récupération

Tant que le trajet est `active`, l'endpoint passager accepte les positions d'une réservation `accepted` ou `no_show`. L'application ne coupe donc plus le suivi GPS lors du seul passage à `no_show`.

Lorsque conducteur et passager réapparaissent ensemble loin du point de récupération, le serveur peut créer une candidature `in_trip_recovery`. Une simple proximité instantanée ne suffit jamais. Le même détecteur exige notamment :

- des positions conducteur et passager fraîches et suffisamment précises ;
- des horodatages compatibles ;
- au moins sept échantillons valides dans la fenêtre par défaut ;
- une proximité stable selon le rayon GPS dynamique ;
- un déplacement cohérent des deux appareils ;
- au moins 20 secondes et 80 mètres de mouvement partagé dans le chemin normal, ou les garanties renforcées du chemin trafic lent.

Après confirmation, le serveur applique atomiquement la transition suivante :

| Élément                 | Valeur après récupération                                          |
| ----------------------- | ------------------------------------------------------------------ |
| `status`                | `accepted`                                                         |
| `pickedUp`              | `true`                                                             |
| `pickedUpAt`            | date serveur de confirmation                                       |
| `pickupDetectionMethod` | `automatic_shared_movement_late_recovery`                          |
| `paymentStatus`         | `pending` pour `electronic`/`points` payants, sinon `not_required` |
| champs `noShow*`        | conservés pour l'audit                                             |
| `rejectionReason`       | `null`                                                             |

Aucun paiement n'est déclenché par cette récupération. Le paiement reste soumis à l'arrivée physique. Les places disponibles sont recalculées puisque le `no_show` avait auparavant libéré la capacité logique du trajet.

## 7. Protection contre les faux positifs

La détection GPS n'est jamais une preuve absolue. Les protections mises en place sont :

- partage passager en premier plan et en arrière-plan ;
- preuve positive obligatoire avant tout `no_show` : passager encore au point de récupération et conducteur réellement reparti ;
- blocage du `no_show` si la position passager est absente, ancienne ou proche du conducteur ;
- confirmation d'embarquement fondée sur plusieurs échantillons de proximité et de mouvement partagé ;
- une confirmation d'embarquement persistée n'est jamais annulée par une perte ultérieure du GPS passager ;
- impossibilité pour l'application de confirmer automatiquement tous les passagers à la destination finale.

Si le véhicule atteint la destination finale sans preuve suffisante d'embarquement, la réservation passe à `boarding_uncertain`. Toutefois, une candidature d'embarquement GPS active et non expirée diffère cette clôture afin de laisser finir l'évaluation tardive. Sans candidature active, l'état terminal libère le trajet mais n'affirme ni l'absence ni la présence du passager et interdit tout paiement ou avantage financier.

Audit de cet état :

| Champ                                   | Valeur                                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| `status`                                | `boarding_uncertain`                                              |
| `boardingUncertainDetectedAt`           | date serveur de décision                                          |
| `boardingUncertainReason`               | `trip_destination_reached_without_boarding_evidence`              |
| `boardingUncertainDriverDistanceMeters` | distance conducteur-point de récupération au moment de la clôture |
| `paymentStatus`                         | `cancelled` si aucun paiement historique réussi                   |

L'événement temps réel correspondant est `passenger_boarding_uncertain`.

## 8. Fin automatique du trajet

Une réservation `no_show` ou `boarding_uncertain` n'est plus `accepted`; elle ne bloque donc normalement pas `tryCompleteTripAtDestination`. Exception : une candidature GPS tardive active et non expirée diffère brièvement la clôture du trajet. Le dernier point GPS conducteur peut ensuite clôturer le trajet à la destination.

L'application conducteur, y compris sa tâche de localisation en arrière-plan :

1. envoie la position au serveur ;
2. laisse le serveur confirmer `pickup`, `no_show`, `boarding_uncertain` ou `dropoff` ;
3. recharge les réservations ;
4. demande la fin du trajet ; le serveur réconcilie atomiquement les réservations encore ouvertes avant de le clôturer.

Elle ne transforme plus une réservation non embarquée en réservation complétée.

Les deux transports de position déclenchent exactement le même automate :

- WebSocket utilisé lorsque l'application est active ;
- `PUT /trips/:id/driver-location` utilisé en repli et par la tâche conducteur d'arrière-plan.

Ce raccordement REST corrige le cas où le conducteur arrivait à destination avec l'application en veille mais où la prise en charge, la dépose et la fin du trajet n'étaient jamais évaluées.

Après un embarquement persisté, une position conducteur fraîche à 25 mètres ou moins de la destination passager suffit à confirmer automatiquement la dépose. La perte du GPS passager après l'embarquement ne peut donc plus bloquer la course. Les champs `pickupDetectionMethod` et `dropoffDetectionMethod` conservent la méthode de détection pour l'audit.

## 9. Autorisations et endpoints

| Endpoint                                     | Acteur                                                                 | Règle financière                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /bookings`                             | passager                                                               | enregistre le mode, aucun débit                                                    |
| `PUT /bookings/:id/payment-mode`             | passager propriétaire                                                  | avant arrivée : choix seulement ; après arrivée avec `points` : tentative de débit |
| `POST /bookings/:id/pay`                     | passager propriétaire                                                  | refusé avant arrivée ; FlexPay après arrivée                                       |
| `PUT /bookings/:id/confirm-pickup`           | conducteur du trajet, reprise seulement                                | aucune exigence de prépaiement ; audit `manual_driver_recovery`                    |
| `PUT /bookings/:id/confirm-pickup-passenger` | passager propriétaire, reprise seulement                               | aucune exigence de prépaiement ; audit `manual_passenger_recovery`                 |
| `PUT /bookings/:id/confirm-dropoff`          | conducteur du trajet, reprise seulement                                | termine physiquement puis règle selon le mode ; audit `manual_driver_recovery`     |
| `PUT /bookings/:id/passenger-location`       | passager propriétaire, statut `accepted` ou `no_show` sur trajet actif | peut récupérer un embarquement tardif, jamais un débit avant arrivée               |
| `PUT /trips/:id/driver-location`             | conducteur du trajet                                                   | peut déclencher `no_show`, arrivée et fin de trajet                                |

## 10. Tables et migration

Migration : `1780000017000-AddBookingNoShowState.ts`.

Elle :

- ajoute `no_show` et `boarding_uncertain` à l'enum PostgreSQL `bookings_status_enum` ;
- ajoute `noShowDetectedAt` ;
- ajoute `noShowReason` ;
- ajoute `noShowDriverDistanceMeters`.
- ajoute `boardingUncertainDetectedAt` ;
- ajoute `boardingUncertainReason` ;
- ajoute `boardingUncertainDriverDistanceMeters` ;
- ajoute `pickupDetectionMethod` et `dropoffDetectionMethod`.

Le `down` convertit les lignes `no_show` et `boarding_uncertain` en `cancelled` avant de reconstruire l'enum. Cette conversion perd la distinction métier et ne doit être exécutée qu'après export des données d'audit.

## 11. Idempotence, concurrence et cas historiques

- Une réservation déjà `completed` ou `boarding_uncertain` ne peut plus être annulée par le flux normal. Un `no_show` est récupérable uniquement par une preuve automatique de mouvement partagé pendant le trajet actif.
- Les déclenchements REST et Socket.IO d'un même trajet sont sérialisés dans le processus serveur : un seul automate persiste une transition à la fois, puis l'évaluation suivante recharge l'état courant.
- Les positions conducteur et passager utilisent un compare-and-set SQL sur `lastLocationUpdateAt`/`passengerLastLocationUpdateAt`. Un échantillon identique ou plus ancien, qu'il arrive par REST ou Socket.IO, ne peut pas écraser une position plus récente.
- La confirmation d'embarquement utilise une mise à jour conditionnelle limitée aux statuts `accepted`/`no_show` avec `pickedUp = false`. Deux évaluations concurrentes ne peuvent donc pas émettre deux confirmations persistées.
- Les transitions `no_show`, `boarding_uncertain`, dépose et fin de trajet utilisent elles aussi des mises à jour conditionnelles. Seul le gagnant d'une concurrence peut déclencher le règlement ou publier l'événement associé.
- L'ordre des transports n'a pas d'impact métier : REST et Socket.IO appellent les mêmes services, le même historique GPS et le même automate.
- Un paiement `succeeded` ne peut plus changer de mode.
- Un nouvel appel `points` sur une réservation complétée sert de tentative contrôlée de règlement ; l'idempotence du registre de portefeuille doit empêcher un double débit.
- La finalisation fidélité/revenu s'appuie sur les mécanismes d'unicité déjà présents dans les services portefeuille et règlements conducteur.
- Cas historique anormal : si une réservation déclarée `no_show` possède déjà `paymentStatus = succeeded`, le paiement n'est pas effacé. Une erreur d'audit est journalisée et une revue financière manuelle est obligatoire.

## 12. Parrainage

`FIN-REF-001` reste planifié. Lors de son implémentation, une course ne pourra devenir une source de gain de parrainage que si :

- la réservation est `completed` ;
- le paiement éligible est réellement confirmé selon la politique de la plateforme ;
- la réservation n'est ni `no_show`, ni `boarding_uncertain`, ni annulée, ni remboursée ;
- la source financière est unique et traçable.

Aucun gain de parrainage n'est créé par ce changement.

## 13. Tests et validation

Les tests couvrent notamment :

- refus du paiement électronique avant arrivée ;
- sélection des jetons avant arrivée sans débit ;
- débit des jetons après arrivée ;
- prise en charge autorisée avec paiement encore en attente ;
- conservation d'un tarif ajusté lors d'une interruption ;
- affichage du montant serveur et du mode choisi dans le modal passager de fin de trajet ;
- présence du bouton FlexPay uniquement pour une réservation électronique arrivée et encore impayée ;
- passage automatique à `no_show` après attente et départ ;
- protection contre `no_show` lorsque le GPS passager manque, est ancien ou suit encore le conducteur ;
- création d'une candidature loin du point de rendez-vous lorsque le GPS reprend pendant le trajet ;
- récupération de `no_show` vers un embarquement confirmé sans paiement anticipé ;
- sérialisation des évaluations concurrentes REST/Socket.IO ;
- rejet atomique des positions dupliquées ou arrivées dans le désordre ;
- dépose automatique à la destination à partir du GPS conducteur après embarquement ;
- passage à `boarding_uncertain` à la destination sans preuve d'embarquement ;
- absence d'avantage financier pour `no_show` et `boarding_uncertain`.

Commandes de validation :

```text
npm test -- --runInBand src/bookings/bookings.service.spec.ts
npm run build
```

Application :

```text
npx tsc --noEmit
npm run lint
```

## 14. Déploiement et rapprochement

1. Sauvegarder la base.
2. Exécuter la migration avant de déployer le code utilisant `no_show`.
3. Déployer le backend, puis l'application.
4. Vérifier un scénario espèces, jetons suffisants, jetons insuffisants, FlexPay réussi, `no_show` et `boarding_uncertain`.
5. Contrôler qu'une réservation `no_show` ou `boarding_uncertain` ne possède aucune nouvelle écriture de débit, fidélité, revenu conducteur ou parrainage.
6. Couper puis réactiver le GPS passager pendant un trajet, vérifier la création d'une candidature tardive puis `automatic_shared_movement_late_recovery` après mouvement partagé.
7. Envoyer le même échantillon simultanément par REST et Socket.IO et vérifier une seule position persistée et une seule transition métier.
8. Rechercher les réservations historiques `completed` avec paiement électronique `pending` et les traiter comme créances à régler, pas comme erreurs de progression physique.
9. Rechercher tout `no_show` avec paiement `succeeded` et ouvrir une revue manuelle.
10. Rechercher tout `boarding_uncertain` avec paiement `succeeded` et ouvrir une revue manuelle.

## 15. Limites connues

- Une course déjà bloquée avant ce déploiement n'est pas automatiquement reclassée sans nouvelle preuve GPS ou action de récupération autorisée.
- Le système ne peut pas prouver un paiement en espèces.
- Le partage en arrière-plan dépend des permissions et restrictions d'énergie du téléphone.
- Les seuils de 10 minutes et 150 mètres sont des règles métier codées en constantes ; toute modification future doit créer une nouvelle entrée financière documentée.
