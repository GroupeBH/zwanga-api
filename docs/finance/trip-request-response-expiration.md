# FIN-TRIP-004 — Expiration après douze heures sans conducteur accepté

Date : 20 août 2026
Statut : implémenté dans le code
Remplace : `FIN-TRIP-002`, qui expirait seulement les demandes sans aucune offre après deux heures

## 1. Besoin métier

Une demande de trajet ne doit pas rester indéfiniment dans la liste publique ou sur l'écran d'accueil. Elle reste ouverte pendant douze heures à partir de sa création. À l'issue de ce délai, elle expire si aucun conducteur n'a été accepté.

Une simple offre conducteur ne prolonge plus la durée de vie de la demande. Cette correction couvre notamment les anciennes demandes `offers_received` qui pouvaient rester visibles pendant plusieurs mois.

## 2. Formule

```text
dateExpiration = createdAt + 12 heures

expiration =
  dateCourante >= dateExpiration
  ET status appartient à {pending, offers_received}
  ET aucune offre conducteur n'est accepted
  ET selectedDriverId est null
  ET tripId est null
```

La comparaison est inclusive : à exactement `createdAt + 12 heures`, la demande est expirée avant toute nouvelle réponse ou acceptation.

La plage de départ `departureDateMin` / `departureDateMax` reste une préférence de planification. Elle ne redémarre pas et ne remplace pas l'échéance d'expiration.

## 3. États concernés

| État | Après 12 heures | Motif |
| --- | --- | --- |
| `pending` | devient `expired` | aucune acceptation |
| `offers_received` avec offres en attente, rejetées ou annulées | devient `expired` | aucune offre acceptée |
| `offers_received` avec une offre `accepted` | conservé, puis normalement `driver_selected` | conducteur accepté |
| `driver_selected` | conservé | demande déjà attribuée |
| `cancelled` | inchangé | état terminal |
| `expired` | inchangé | état terminal |

Une nouvelle offre reçue à la onzième heure ne donne donc pas douze heures supplémentaires. L'échéance reste liée au `createdAt` de la demande.

## 4. Comportement backend

Le service centralise la règle dans `expireUnacceptedRequests`.

La vérification est exécutée lors :

- de la lecture de la liste publique des demandes ;
- de la lecture d'une demande particulière ;
- de la lecture de l'historique du passager ;
- d'une modification de demande ;
- de la création, du rejet ou de l'acceptation d'une offre ;
- de l'acceptation directe d'une demande par un conducteur ;
- du cron d'expiration exécuté chaque minute.

La liste publique charge les états `pending` et `offers_received`, persiste les expirations échues, puis retire immédiatement les demandes `expired` de la réponse.

## 5. Nettoyage des anciennes demandes

Aucune migration de schéma n'est nécessaire. Les anciennes demandes de janvier ou d'une autre période sont traitées automatiquement :

1. le cron charge les demandes `pending` et `offers_received` âgées d'au moins douze heures ;
2. les demandes sans conducteur accepté passent à `expired` ;
3. la lecture de la liste publique applique la même règle sans attendre le prochain cron ;
4. elles disparaissent du Home tout en restant consultables comme historique du passager.

Le traitement est idempotent : une ligne déjà `expired` n'est pas modifiée une seconde fois.

## 6. Protection contre une acceptation concurrente

Avant l'expiration, le service recherche une offre `accepted`, un `selectedDriverId` ou un `tripId`. La mise à jour finale exige encore :

- un état `pending` ou `offers_received` ;
- `selectedDriverId IS NULL` ;
- `tripId IS NULL`.

Ces conditions empêchent le cron d'écraser une demande dont l'attribution a déjà été persistée entre la lecture et la mise à jour.

## 7. Protection supplémentaire dans l'application

Le Home mobile applique aussi une limite locale de douze heures aux demandes non acceptées. Ce filtre défensif évite qu'une ancienne réponse mise en cache, ou provenant temporairement d'un backend pas encore mis à jour, réapparaisse à l'écran.

Le filtre mobile conserve une demande si l'application détecte au moins un des éléments suivants :

- état `driver_selected` ;
- `selectedDriverId` présent ;
- `tripId` présent ;
- offre avec l'état `accepted`.

Le backend reste la source de vérité et persiste réellement l'état `expired`.

## 8. Notification avant expiration

Le contrôle des notifications continue toutes les quinze minutes. Une notification peut être envoyée dans les trente dernières minutes avant l'échéance, donc à partir de onze heures et trente minutes après la création.

Le message indique désormais que la demande expirera si aucun conducteur n'est confirmé.

## 9. Impact financier

Cette correction ne crée aucun paiement, débit, crédit ou jeton :

- le prix recommandé enregistré avec la demande n'est pas recalculé ;
- aucun paiement existant n'est annulé ou remboursé ;
- aucun gain conducteur ou gain de parrainage n'est créé ;
- les anciennes écritures financières ne sont pas modifiées.

Une demande sans conducteur accepté ne doit normalement posséder aucune réservation payée. Si une incohérence historique associe déjà un `tripId`, la protection `tripId IS NULL` empêche son expiration automatique et impose une vérification manuelle.

## 10. API et compatibilité

Aucun contrat d'API ne change. Les valeurs existantes restent utilisées :

- `pending` ;
- `offers_received` ;
- `driver_selected` ;
- `cancelled` ;
- `expired`.

Les clients déjà publiés reçoivent simplement moins de demandes obsolètes dans `GET /api/v1/trip-requests`.

## 11. Fichiers modifiés

| Fichier | Modification |
| --- | --- |
| `src/trip-requests/trip-requests.service.ts` | délai de douze heures, expiration des états ouverts, cron et contrôles d'action |
| `src/trip-requests/entities/trip-request.entity.ts` | commentaire de notification mis à jour |
| `src/trip-requests/trip-requests.service.spec.ts` | scénarios de délai, offres non acceptées et offre acceptée |
| `app/(tabs)/index.tsx` | filtre défensif du Home |

## 12. Tests couverts

- une demande âgée de onze heures et cinquante-neuf minutes reste visible ;
- une demande `pending` âgée de plus de douze heures expire ;
- une demande `offers_received` très ancienne sans offre acceptée expire ;
- une demande avec une offre `accepted` n'est pas expirée ;
- une demande récente avec une offre en attente reste visible ;
- une nouvelle réponse conducteur est refusée après l'échéance ;
- le build backend et le typage mobile restent valides.

## 13. Déploiement et vérification

Ordre recommandé :

1. déployer le backend ;
2. confirmer dans les logs l'exécution du cron d'expiration ;
3. vérifier le nombre de lignes `pending` et `offers_received` âgées de plus de douze heures ;
4. confirmer que les lignes sans conducteur accepté passent à `expired` ;
5. déployer l'application mobile ;
6. vider ou rafraîchir le cache de la liste des demandes ;
7. confirmer que les demandes anciennes ne sont plus présentes sur la carte ni dans la liste du Home.

Le retour arrière remettrait en service l'ancien comportement qui pouvait conserver indéfiniment les demandes ayant reçu une offre. Les demandes déjà marquées `expired` ne doivent pas être réactivées automatiquement.
