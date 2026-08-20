# FIN-TRIP-003 — Nombre de places facultatif dans une demande de trajet

Date : 19 août 2026  
Statut : implémenté  
Périmètre : création et modification des demandes de trajet, estimation tarifaire et application mobile

## 1. Besoin métier

Le passager ne doit pas être obligé de renseigner le nombre de places lorsqu'il publie une demande de trajet. Dans ce contexte, `numberOfSeats` désigne le nombre de places demandées pour les passagers, et non la capacité totale du véhicule du conducteur.

Le serveur doit toutefois disposer d'une quantité entière pour calculer le prix total, contrôler les offres et créer la réservation finale.

## 2. Règle fonctionnelle

La valeur effective est calculée ainsi :

```text
nombreDePlacesEffectif = numberOfSeats fourni ?? 1
```

- si le champ est absent ou vaut `null` à la création, le serveur utilise 1 ;
- si le champ est fourni, il doit être compris entre 1 et 2 ;
- la base conserve toujours un entier non nul ;
- l'API retourne la valeur effective, y compris lorsque le client ne l'a pas fournie ;
- lors d'une modification, l'absence du champ conserve la valeur déjà enregistrée ; elle ne la réinitialise pas ;
- les demandes existantes ne sont pas modifiées.

## 3. Comportement avant et après

Avant, `POST /api/v1/trip-requests` rejetait une demande sans `numberOfSeats`, même si l'application affichait déjà 1 comme valeur initiale.

Après :

1. l'application demande les options de véhicule sans envoyer le champ tant que le passager ne change pas le compteur ;
2. les endpoints d'estimation utilisent alors 1 pour calculer leurs réponses ;
3. la création peut également omettre le champ ;
4. le serveur enregistre explicitement `numberOfSeats = 1` ;
5. les offres conducteur, l'acceptation et la réservation continuent d'utiliser cette valeur enregistrée.

## 4. Contrats API

### 4.1 Création sans nombre de places

`POST /api/v1/trip-requests`

```json
{
  "departureLocation": "Gombe",
  "arrivalLocation": "Limete",
  "departureDateMin": "2026-08-19T14:00:00.000Z",
  "departureDateMax": "2026-08-19T15:00:00.000Z",
  "vehicleType": "car"
}
```

La réponse contient :

```json
{
  "numberOfSeats": 1
}
```

### 4.2 Création avec choix explicite

```json
{
  "numberOfSeats": 2
}
```

La validation 1 à 2 reste appliquée. Les endpoints `recommended-price` et `vehicle-options` acceptent eux aussi l'absence du champ et retournent `numberOfSeats: 1` comme valeur effective.

## 5. Impact financier

La grille tarifaire, les coefficients météo, les modes de paiement et les prix par place ne changent pas.

```text
prixTotalRecommandé = prixParPlaceRecommandé × nombreDePlacesEffectif
```

Par conséquent :

- champ omis : le prix total recommandé est identique au prix par place ;
- valeur 1 explicite : résultat strictement identique au champ omis ;
- valeur 2 : le prix total recommandé vaut deux fois le prix par place ;
- `maxPricePerSeat` reste un plafond par place et n'est pas transformé en prix total ;
- aucun paiement, portefeuille, point, gain de parrainage ou solde existant n'est recalculé ;
- aucun encaissement n'est créé par cette normalisation.

Le serveur demeure la source de vérité pour la valeur effective et le calcul tarifaire.

## 6. Données et migration

La colonne `trip_requests.numberOfSeats` reste non nullable. Le service fournit la valeur 1 avant l'insertion ; aucune migration n'est requise. Ce choix évite de propager une valeur `null` dans les offres, les trajets, les réservations et les calculs de paiement.

## 7. Autorisation, fraude, concurrence et idempotence

- les autorisations de création et de modification restent inchangées ;
- omettre le champ ne permet pas de contourner les limites : la valeur effective est 1 ;
- une valeur fournie supérieure à 2 reste refusée ;
- le conducteur doit toujours proposer au moins la valeur effective enregistrée ;
- la modification n'ajoute aucune écriture financière et n'introduit aucun nouveau risque de double débit ;
- les règles de paiement, de remboursement et d'idempotence existantes ne changent pas.

## 8. Fichiers touchés

Backend :

- `src/trip-requests/dto/trip-request.dto.ts` ;
- `src/trip-requests/trip-requests.service.ts` ;
- `src/trip-requests/entities/trip-request.entity.ts` ;
- `src/trip-requests/trip-requests.service.spec.ts`.

Application :

- `store/api/tripRequestApi.ts` ;
- `app/request/index.tsx` ;
- `app/request/[id].tsx`.

## 9. Tests et contrôles

- création sans `numberOfSeats` et persistance de la valeur 1 ;
- maintien des tests de prix pour une et deux places ;
- tests backend complets ;
- compilation TypeScript backend et mobile ;
- lint ciblé des écrans modifiés.

## 10. Déploiement et retour arrière

Déploiement : livrer le backend avant ou en même temps que l'application qui omet le champ. Un ancien client qui envoie toujours 1 ou 2 reste compatible.

Retour arrière : restaurer le caractère obligatoire du DTO et l'envoi systématique depuis le client. Aucune restauration de données n'est nécessaire, car toutes les lignes créées continuent de contenir une valeur valide.
