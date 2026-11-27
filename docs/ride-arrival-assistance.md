# Embarquement, arrivée et assistance près de la destination

État du code local au **25 novembre 2026**. Backend NestJS et application mobile ; aucun déploiement effectué par cette intervention.

## Règles métier

| Origine et situation | Validation manuelle | Détection GPS |
| --- | --- | --- |
| Trajet issu d’une demande passager (`trip.tripRequestId` enregistré en base) | Le conducteur valide l’embarquement et l’arrivée. Un ancien client passager ne peut pas contourner cette règle. | Conservée. |
| Trajet publié par un conducteur puis réservé | Comportement existant : double confirmation pour l’embarquement ; la confirmation du passager suffit à l’arrivée. | Conservée. |
| Proposition serveur de dépose proche de la destination | **L’accord explicite du passager suffit** à valider son arrivée et ouvrir le paiement, sans confirmation supplémentaire du conducteur. | Les règles automatiques existantes restent prioritaires. |

Une réservation peut représenter plusieurs places : la confirmation porte sur cette réservation, pas sur les autres passagers du trajet. Pour une commande, le traitement existant poursuit la clôture du trajet. Pour un trajet partagé, les autres réservations continuent leur propre progression.

## Quand demander si la dépose a eu lieu ?

Le serveur suit un arrêt après embarquement et propose la confirmation lorsque :

- la réservation est acceptée, le trajet est en cours, aucune dépose ni contestation n’est enregistrée ;
- le véhicule reste **plus de cinq minutes à 100 m au maximum** de la destination de cette réservation (à défaut, destination du trajet) ;
- les positions sont précises à **35 m ou mieux**, avec un intervalle maximal de **45 secondes** ; au moins huit observations distinctes sont nécessaires ;
- le déplacement par rapport au point initial de l’arrêt ne dépasse pas **20 m** et la vitesse, lorsqu’elle est connue, ne dépasse pas **0,8 m/s**.

Un échantillon dupliqué ne fait pas progresser le compteur. Les observations anciennes, imprécises, invalides, antérieures à l’embarquement, un déplacement ou une interruption de mesure invalident/recommencent l’observation. L’absence de GPS n’est **jamais** une preuve d’immobilité. Un bouchon peut donc provoquer une question, mais la proposition seule ne termine pas la course.

Le conducteur et le passager reçoivent chacun une notification durable. Dans la navigation passager active et en ligne, la proposition ouvre la feuille de confirmation existante, une fois par identifiant. Elle demande explicitement si le passager est descendu et explique que son accord termine la course et ouvre le paiement. Aucune réponse positive n’est générée automatiquement.

La lecture mobile existante (toutes les 30 secondes sur l’écran actif) est réutilisée : aucun nouveau polling GPS ou minuteur de cinq minutes sur le téléphone. La livraison effective d’une notification dépend toujours de la connexion, du fournisseur et des permissions du téléphone.

## Acceptation jusqu’à 200 m

La proposition est valable **dix minutes** et n’est créée **qu’une fois par réservation**. Le passager envoie son identifiant avec sa déclaration explicite de dépose :

```text
PUT /ride-declarations/booking/:bookingId
stage = dropoff
decision = confirm
arrivalPromptId = identifiant fourni par le serveur
```

Sous verrou du trajet puis de la réservation, le backend vérifie à nouveau l’identité du titulaire, l’état courant, l’absence de contestation, l’embarquement, l’identifiant et l’échéance de la proposition. Une position récente du conducteur connue du serveur est nécessaire : fraîcheur maximale **45 secondes**, précision **35 m**, concordance avec la dernière position persistée et distance **au plus 200 m** de la destination. Les coordonnées éventuellement envoyées par le passager ne suffisent pas à autoriser cette exception.

Si la vérification réussit, la réservation passe à `completed`, la dépose est enregistrée avec la méthode `manual_passenger_near_destination` et l’accord est horodaté. Le paiement existant devient accessible. **Le tarif convenu ne change pas, aucun paiement réussi ni encaissement cash n’est inventé.** Le parcours normal de règlement et de confirmation du cash reste distinct.

Sans réponse, après expiration, en cas de position trop ancienne ou de refus serveur, cette proposition ne clôture rien. Les commandes ordinaires du conducteur et la détection GPS restent utilisables. Il n’y a pas de seconde proposition automatique après expiration dans cette version.

## Fiabilité et coût des traitements

- État d’arrêt borné dans Redis, une clé par réservation proche de la destination, expiration de dix minutes, mise à jour conditionnelle atomique, sans boucle de réessai.
- Réutilisation de l’historique conducteur déjà lu pour l’évaluation GPS. Aucune écriture SQL ajoutée pour les positions ordinaires.
- Proposition et deux notifications enregistrées dans la même transaction PostgreSQL ; aucune notification externe avant commit. Une erreur d’écriture annule les trois écritures.
- Transactions courtes et ordre de verrous `trajet → réservation`. Lecture Redis avant la transaction de consentement ; aucun appel push, SMS ou prestataire de paiement sous ces verrous.
- Contrôle de livraison des notifications différées : proposition courante, non acceptée, non expirée, réservation et compte encore admissibles. Une ancienne question n’est pas envoyée après clôture.
- Les répétitions d’une confirmation, une réponse HTTP perdue et la course entre validation conducteur/passager ne génèrent pas plusieurs transitions ni plusieurs versions de suivi.
- La colonne `arrivalPrompt` est protégée des sauvegardes ORM ordinaires (`update: false`) ; seules les écritures ciblées sous verrou peuvent modifier cette preuve.
- Les permissions ordinaires utilisent l’origine persistée du trajet, jamais un indicateur choisi par le client. Les contestations et validations GPS existantes sont conservées.

## Fichiers principaux

- `src/ride-declarations/ride-confirmation-mode.ts` : politique selon l’origine.
- `src/ride-declarations/ride-declarations.service.ts` : autorisations, consentement, états et reprise idempotente.
- `src/bookings/arrival-assistance.policy.ts` : seuils et contrôles GPS purs.
- `src/bookings/arrival-assistance.service.ts` : état Redis, proposition et notifications transactionnelles.
- `src/bookings/bookings.service.ts` : branchement après les règles GPS existantes, notifications et suivi du règlement.
- `src/notifications/ride-progress-delivery.ts` : admissibilité des notifications différées.
- Mobile : `features/ride-recovery/`, `store/api/rideRecoveryApi.ts`, `utils/notificationNavigation.ts`, panneaux de navigation conducteur/passager et modal d’embarquement contourné.

## Livraison et vérification

1. Appliquer la migration additive **`ArrivalAssistance1780000141000`** via le processus de migration habituel, **avant de démarrer le nouveau backend**. Elle ajoute uniquement `bookings.arrivalPrompt`, nullable, sans réécriture de l’historique. Le verrou DDL est borné à cinq secondes ; un échec doit être examiné et relancé dans une fenêtre adaptée.
2. Déployer le backend puis la nouvelle application mobile. L’ancienne application ne dispose pas de la nouvelle question et ses confirmations passager ordinaires seront refusées pour les trajets issus de demandes ; prévoir cette compatibilité dans la livraison.
3. Recetter sur deux appareils : demande et trajet publié, arrêt proche avec consentement/sans réponse, positions absentes ou imprécises, reconnexion, écran en veille, annulation concurrente, paiement et cash.

Vérifications effectuées : **246 tests backend distincts et 93 tests mobiles JavaScript ciblés réussis** ; contrôles TypeScript complets backend et mobile valides. ESLint mobile ciblé ne signale aucune erreur ; cinq avertissements de dépendances de hooks restent dans `usePassengerNavigationNotices.ts` (hors changement de dépendances de cette intervention).

Les tests locaux comprennent les politiques d’autorisation/GPS, la progression existante, les doubles clics et reprises mobiles, ainsi que six scénarios sur **PostgreSQL temporaire isolé** : concurrence entre réplicas, confirmation concurrente conducteur/passager, répétitions après perte de réponse, annulation, notifications devenues inadmissibles et rollback des notifications. La migration y est réellement exécutée, mais aucune base applicative ni AWS n’a été modifié. Cette suite PostgreSQL est opt-in via `ARRIVAL_TEST_POSTGRES_BIN` pointant vers les binaires PostgreSQL locaux ; sans cette variable, elle est ignorée et ne compte pas comme validée.

Les scénarios PostgreSQL utilisent des entités minimales et des points JSON pour les tests de verrouillage : ils ne certifient pas toute la chaîne PostGIS/HTTP ni le matériel GPS. Les tests UI sont JavaScript avec dépendances simulées. Les notifications réelles, la livraison écran en veille, la clôture de bout en bout sur appareil et les paiements réels restent à recetter. Aucun test de charge ni gain de capacité n’est annoncé.
