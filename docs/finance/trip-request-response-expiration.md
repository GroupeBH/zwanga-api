# FIN-TRIP-002 — Expiration après deux heures sans réponse

Date : 19 août 2026  
Statut : implémenté dans le code  
Périmètre : demandes de trajet, offres conducteur, visibilité et notifications

## 1. Besoin métier

Une demande de trajet ne doit pas expirer à cause de la fin de la plage de départ souhaitée. Elle reste disponible pendant deux heures complètes après sa création et expire seulement si aucun conducteur n'a répondu pendant ce délai.

La règle exacte est :

```text
dateLimiteRéponse = createdAt + 2 heures

expiration =
  status = pending
  ET aucune offre conducteur enregistrée
  ET maintenant >= dateLimiteRéponse
```

La comparaison est inclusive : une première réponse reçue à la date limite ou après celle-ci est refusée si l'expiration a déjà été constatée.

## 2. Définition d'une réponse

Une réponse existe dès qu'une offre conducteur est enregistrée dans `driver_offers`. Le statut normal devient alors `offers_received`.

Pour protéger les données historiques ou temporairement désynchronisées, le backend considère également qu'une demande a reçu une réponse lorsque :

- son statut est déjà `offers_received` ; ou
- sa relation `driverOffers` contient au moins une offre, quel que soit l'état ultérieur de cette offre.

Une offre ensuite refusée ou annulée ne transforme donc pas la demande en « jamais répondue ». Après une première réponse, la demande ne passe plus automatiquement à `expired` par cette règle.

L'acceptation directe par un conducteur constitue une réponse finale : elle n'est autorisée que si la demande n'a pas déjà atteint l'état `expired`.

## 3. Comportement avant la modification

L'expiration était confondue avec `departureDateMax` :

- les listes publiques et personnelles excluaient les demandes dont `departureDateMax` était passé ;
- la création d'une offre et l'acceptation directe étaient refusées après cette date ;
- le cron horaire marquait comme expirées les demandes `pending` dont la plage de départ était terminée ;
- la notification d'expiration utilisait également `departureDateMax`.

Une demande créée pour un départ proche pouvait ainsi disparaître bien avant deux heures, même sans réponse.

## 4. Comportement après la modification

- `departureDateMin` et `departureDateMax` restent uniquement la plage de départ souhaitée par le passager ;
- `createdAt + 2 heures` devient l'unique échéance d'absence de réponse ;
- une demande de moins de deux heures reste visible même si sa plage de départ est déjà passée ;
- une demande de plus de deux heures avec au moins une offre reste en `offers_received` ;
- une demande de plus de deux heures sans offre passe en `expired` ;
- les lectures et les actions sensibles appliquent la règle immédiatement, sans attendre uniquement le cron ;
- les demandes expirées restent visibles dans l'historique du passager avec leur statut.

## 5. États et transitions

```text
pending
  ├─ première offre avant 2 h ─────────> offers_received
  ├─ acceptation directe avant 2 h ───> driver_selected
  ├─ annulation passager ──────────────> cancelled
  └─ aucune réponse à 2 h ─────────────> expired

offers_received
  ├─ offre acceptée ───────────────────> driver_selected
  └─ annulation passager ──────────────> cancelled
```

Il n'existe pas de transition automatique de `offers_received` vers `expired` dans ce lot.

## 6. Points d'application côté serveur

### Lecture publique

`GET /api/v1/trip-requests`

La requête ne filtre plus par `departureDateMax`. Elle charge les demandes `pending` et `offers_received`, applique l'expiration sans réponse, puis retire de la réponse publique les statuts `expired` et les demandes ayant déjà une offre acceptée.

### Historique du passager

`GET /api/v1/trip-requests/my-requests`

La plage de départ ne masque plus les demandes. Le passager peut donc voir une demande devenue `expired` et comprendre son résultat.

### Lecture individuelle

`GET /api/v1/trip-requests/:id`

Une lecture recalcule l'état d'une demande `pending` ancienne. Si elle a atteint deux heures sans offre, son statut est persisté en `expired` avant sérialisation.

### Modification

`PUT /api/v1/trip-requests/:id`

Modifier l'itinéraire, le véhicule ou la plage de départ ne redémarre pas le délai. L'échéance reste calculée depuis `createdAt`. Une demande déjà arrivée à deux heures sans réponse est marquée expirée et sa modification est refusée.

### Première réponse conducteur

`POST /api/v1/trip-requests/:id/offers` et l'acceptation directe contrôlent l'échéance avant de poursuivre. La fin de `departureDateMax` n'est plus utilisée comme motif d'expiration.

La date proposée dans une offre doit toujours respecter la plage de départ du passager : cette validation est distincte du cycle de vie de la demande.

## 7. Tâches planifiées

### Marquage des expirations

Le cron passe d'une exécution horaire à une exécution chaque minute.

Il recherche les demandes :

- `status = pending` ;
- `createdAt <= maintenant - 2 heures` ;
- sans offre conducteur.

La mise à jour finale exige encore `status = pending`. Cette condition empêche le cron d'écraser une demande qui vient de passer dans un autre état entre sa lecture et son écriture.

### Notification préventive

Toutes les quinze minutes, le serveur cherche les demandes sans réponse qui expireront dans les trente prochaines minutes. Une seule notification est envoyée grâce à `expirationNotificationSent`.

Le nombre de minutes affiché est calculé à partir de `createdAt + 2 heures`, et non de la plage de départ.

## 8. Données et migration

Aucune colonne et aucune migration ne sont ajoutées :

- `createdAt` fournit le début du délai ;
- `status` conserve l'état ;
- `driver_offers` prouve qu'une réponse a été reçue ;
- `expirationNotificationSent` évite les notifications répétées.

Les demandes historiques encore `pending` et âgées de plus de deux heures seront évaluées au premier cron, à la première lecture ou à la première tentative d'action après le déploiement.

## 9. Effet financier

Cette modification ne change :

- ni `maxPricePerSeat` ;
- ni le type de véhicule choisi ;
- ni la formule de recommandation ;
- ni le prix d'une offre existante ;
- ni un trajet, une réservation ou un paiement déjà créé ;
- ni les points, gains de parrainage, commissions ou soldes.

Elle prolonge potentiellement la période pendant laquelle une demande tarifée est visible. Le serveur continue de valider le prix et le véhicule au moment de la réponse. Aucune écriture financière n'est créée par l'expiration.

## 10. Concurrence et idempotence

- marquer plusieurs fois la même demande comme expirée est sans effet financier ;
- la mise à jour d'expiration cible uniquement une ligne encore `pending` ;
- une demande `offers_received`, `driver_selected`, `cancelled` ou `expired` n'est jamais réexpirée ;
- les lectures peuvent déclencher le même contrôle que le cron, ce qui réduit le délai de cohérence ;
- aucune transaction de paiement n'est ouverte ou annulée par cette règle.

Les créations de trajet et de réservation conservent leurs protections existantes. Leur regroupement futur dans une transaction de base de données unique reste recommandé indépendamment de cette modification.

## 11. Fichiers modifiés

| Fichier | Modification |
| --- | --- |
| `src/trip-requests/trip-requests.service.ts` | règle de deux heures, lectures, actions, cron et notification |
| `src/trip-requests/trip-requests.service.spec.ts` | tests avant/après deux heures et présence d'une réponse |
| `src/trip-requests/entities/trip-request.entity.ts` | commentaires séparant plage de départ et expiration |
| `app/request/[id].tsx` | texte utilisateur expliquant le délai de deux heures |

## 12. Vérifications couvertes

- une demande âgée de 119 minutes reste active ;
- une plage de départ passée ne provoque plus l'expiration ;
- une demande sans réponse âgée de 121 minutes expire ;
- une demande ayant reçu une offre reste active après trois heures ;
- une première offre après la limite est refusée ;
- les anciens calculs tarifaires et contrôles de véhicule continuent de passer.

## 13. Déploiement

1. déployer le backend ;
2. vérifier le démarrage du scheduler ;
3. contrôler le nombre de demandes `pending` âgées de plus de deux heures ;
4. vérifier qu'aucune demande avec une ligne dans `driver_offers` n'est passée en `expired` ;
5. publier le texte mobile mis à jour ;
6. surveiller pendant deux heures les transitions `pending → offers_received` et `pending → expired`.

## 14. Retour arrière

Le retour arrière restaure les filtres et cron basés sur `departureDateMax`. Il ne requiert aucune migration. Les lignes déjà marquées `expired` ne doivent pas être réactivées automatiquement sans validation métier, car un conducteur peut avoir organisé une autre course entre-temps.
