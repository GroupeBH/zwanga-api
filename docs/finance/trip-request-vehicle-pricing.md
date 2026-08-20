# FIN-TRIP-001 — Choix du véhicule et tarification d'une demande de trajet

Date : 18 août 2026  
Statut : implémenté dans le code ; migration à exécuter avant activation  
Périmètre : demandes de trajet, estimation tarifaire, offres conducteur et création du trajet

## 1. Besoin métier

Avant de créer une demande de trajet, le passager doit pouvoir comparer les types de véhicules et voir leur prix respectif pour le même itinéraire et le même nombre de places.

Le type choisi doit ensuite :

- être envoyé lors de la création ;
- être conservé dans la base ;
- être retourné dans les lectures de la demande ;
- déterminer le prix recommandé côté serveur ;
- limiter les véhicules que les conducteurs peuvent proposer ;
- rester cohérent avec le véhicule utilisé pour créer le trajet final.

## 2. Comportement avant la modification

Le backend possédait déjà :

- trois types de véhicules dans `VehicleType` ;
- un endpoint calculant le prix d'un seul type ;
- une grille de 500 CDF/km/passager pour une voiture et 1 000 CDF/km/passager pour une moto ;
- un coefficient météorologique appliqué en cas de forte pluie.

Cependant :

- le client devait demander les prix type par type ;
- le champ `vehicleType` reçu à la création n'était pas enregistré dans `trip_requests` ;
- une modification de l'itinéraire pouvait recalculer une demande moto avec le tarif voiture ;
- un conducteur pouvait proposer ou utiliser un véhicule d'un type différent de celui demandé.

## 3. Comportement après la modification

Le flux attendu devient :

1. Le client envoie l'itinéraire et le nombre de places à `POST /api/v1/trip-requests/vehicle-options`.
2. Le serveur calcule une seule fois la distance et le coefficient météo.
3. Le serveur retourne toutes les options avec leur prix par place et leur prix total.
4. Le passager sélectionne une option.
5. Le client envoie ce `vehicleType` à `POST /api/v1/trip-requests`.
6. Le serveur recalcule le prix et enregistre le type choisi.
7. Toute offre ou acceptation utilisant un autre type de véhicule est refusée.

Depuis `FIN-VEH-001`, chaque nouveau véhicule conducteur possède lui aussi un type choisi explicitement. Le serveur ne classe plus silencieusement un nouveau véhicule sans type comme `car`. Voir [Type obligatoire à la création d'un véhicule](./vehicle-type-registration.md).

Le cycle de vie de la demande est indépendant de sa plage de départ : depuis `FIN-TRIP-002`, elle expire après deux heures uniquement si aucun conducteur n'a répondu. Voir [Expiration après deux heures sans réponse](./trip-request-response-expiration.md).

Depuis `FIN-TRIP-003`, le nombre de places peut être omis. Le serveur utilise alors une place pour les contrôles et le prix total. Voir [Nombre de places facultatif dans une demande](./trip-request-optional-seat-count.md).

Le montant envoyé ou affiché par le client n'est jamais considéré comme une source de vérité.

## 4. Types et grille tarifaire

| Valeur API            | Libellé        |          Tarif actuel | Capacité maximale métier |
| --------------------- | -------------- | --------------------: | -----------------------: |
| `car`                 | Voiture        |   500 CDF/km/passager |       dépend du véhicule |
| `motorcycle_2_wheels` | Moto à 2 roues | 1 000 CDF/km/passager |                 2 places |
| `motorcycle_3_wheels` | Moto à 3 roues | 1 000 CDF/km/passager |                 3 places |

Ces tarifs sont actuellement définis dans le service. Toute modification future de la grille devra créer une nouvelle entrée dans le journal financier et préciser sa date d'effet.

## 5. Formule financière

Pour chaque type :

```text
distanceKm = distanceMeters / 1000
prixParPlace = arrondi(distanceKm × tarifParKmParPassager × coefficientMétéo)
prixTotal = prixParPlace × nombreDePlaces
```

Règles :

- devise : CDF ;
- l'arrondi du prix par place utilise `Math.round`, donc à l'unité CDF la plus proche ;
- le prix total est calculé après l'arrondi du prix par place ;
- le coefficient météo minimal retenu est `1` ;
- une forte pluie peut actuellement fournir un coefficient `1.3` ;
- si Google Directions ne fournit pas de distance, le service tente une distance géodésique directe ;
- si aucune distance exploitable n'est disponible, les prix recommandés valent `null` et la création ne doit pas inventer un montant côté client.

### Exemple

Pour 5 km, deux places et sans majoration météo :

| Type           | Prix par place | Prix total |
| -------------- | -------------: | ---------: |
| Voiture        |      2 500 CDF |  5 000 CDF |
| Moto à 2 roues |      5 000 CDF | 10 000 CDF |
| Moto à 3 roues |      5 000 CDF | 10 000 CDF |

Avec un coefficient météo de `1.3`, le prix voiture par place devient `3 250 CDF`.

## 6. Contrats API

### 6.1 Lister les options

`POST /api/v1/trip-requests/vehicle-options`

Authentification : requise.  
Limitation : 20 requêtes par minute.

Exemple de requête :

```json
{
  "departureLocation": "Gombe",
  "departureCoordinates": [15.3136, -4.3073],
  "arrivalLocation": "N'djili",
  "arrivalCoordinates": [15.403, -4.4075],
  "numberOfSeats": 2
}
```

Exemple de réponse simplifiée pour 5 km :

```json
{
  "currency": "CDF",
  "pricingModel": "distance_per_vehicle_type",
  "distanceMeters": 5000,
  "numberOfSeats": 2,
  "weatherImpact": {
    "heavyRain": false,
    "priceMultiplier": 1
  },
  "options": [
    {
      "vehicleType": "car",
      "displayName": "Voiture",
      "maximumSeats": null,
      "availableForRequestedSeats": true,
      "pricePerKmPerPassenger": 500,
      "recommendedPricePerSeat": 2500,
      "recommendedTotalPrice": 5000
    },
    {
      "vehicleType": "motorcycle_2_wheels",
      "displayName": "Moto à 2 roues",
      "maximumSeats": 2,
      "availableForRequestedSeats": true,
      "pricePerKmPerPassenger": 1000,
      "recommendedPricePerSeat": 5000,
      "recommendedTotalPrice": 10000
    },
    {
      "vehicleType": "motorcycle_3_wheels",
      "displayName": "Moto à 3 roues",
      "maximumSeats": 3,
      "availableForRequestedSeats": true,
      "pricePerKmPerPassenger": 1000,
      "recommendedPricePerSeat": 5000,
      "recommendedTotalPrice": 10000
    }
  ]
}
```

### 6.2 Créer la demande

`POST /api/v1/trip-requests`

Le champ suivant est maintenant obligatoire :

```json
{
  "vehicleType": "car"
}
```

Valeurs acceptées : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`.

Le serveur recalcule `maxPricePerSeat` lorsque ce montant n'est pas explicitement utilisé comme plafond par le passager. Le type sélectionné est retourné dans la réponse sous `vehicleType`.

### 6.3 Modifier la demande

`PUT /api/v1/trip-requests/:id`

`vehicleType` reste optionnel pendant une modification. S'il change et qu'aucun nouveau plafond de prix n'est envoyé, le prix recommandé est recalculé avec le nouveau type.

Deux contrats financiers sont donc distingués :

```json
{
  "vehicleType": "motorcycle_2_wheels"
}
```

Dans ce premier cas, le serveur recalcule `maxPricePerSeat` avec la distance, la grille du nouveau véhicule et le coefficient météo courant.

```json
{
  "vehicleType": "motorcycle_3_wheels",
  "maxPricePerSeat": 6500
}
```

Dans ce second cas, `6500 CDF` est considéré comme un plafond volontairement personnalisé par le passager. Le serveur le conserve et ne le remplace pas par sa recommandation.

Une demande ayant déjà un conducteur ou une offre acceptée reste non modifiable selon les règles existantes.

## 7. Persistance et migration

Migration : `1780000015000-AddVehicleTypeToTripRequests.ts`.

Modification de `trip_requests` :

```sql
ALTER TABLE "trip_requests"
ADD COLUMN "vehicleType" "public"."vehicles_type_enum"
NOT NULL DEFAULT 'car';
```

Un index `IDX_trip_requests_vehicle_type` est ajouté.

### Compatibilité des données existantes

Toutes les demandes existantes deviennent `car`, car leur type réel n'était pas conservé. Cette valeur est une décision de migration et non une déduction historique.

La migration ne modifie pas :

- `maxPricePerSeat` existant ;
- le prix d'un trajet déjà créé ;
- une réservation ou un paiement déjà initié ;
- un revenu conducteur existant ;
- un solde de points.

## 8. Validation des offres conducteur

Lorsqu'un conducteur fait une offre :

- le véhicule doit lui appartenir ;
- le véhicule doit être actif ;
- son type doit correspondre à `tripRequest.vehicleType` ;
- sa capacité doit couvrir `availableSeats` ;
- le prix offert ne doit pas dépasser `maxPricePerSeat` lorsqu'il existe.

Si `vehicleId` n'est pas envoyé, le backend cherche automatiquement un véhicule actif du conducteur correspondant exactement au type demandé. L'offre est refusée si aucun véhicule compatible n'existe.

Lors d'une acceptation directe, la même règle de type est appliquée. Le backend ne sélectionne plus le premier véhicule actif sans tenir compte du choix du passager.

## 9. Fichiers modifiés

| Fichier                                                                 | Modification                                            | Effet financier                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `src/trip-requests/entities/trip-request.entity.ts`                     | Ajout de `vehicleType` et de son index                  | Conserve la règle tarifaire choisie         |
| `src/database/migrations/1780000015000-AddVehicleTypeToTripRequests.ts` | Migration et retour arrière                             | Initialise les anciennes demandes à `car`   |
| `src/database/migrations/index.ts`                                      | Enregistrement de la migration                          | Permet son exécution en production          |
| `src/trip-requests/dto/trip-request.dto.ts`                             | `vehicleType` obligatoire à la création                 | Empêche une création sans choix explicite   |
| `src/trip-requests/trip-requests.controller.ts`                         | Nouvel endpoint `vehicle-options`                       | Expose les montants calculés par le serveur |
| `src/trip-requests/trip-requests.service.ts`                            | Calcul groupé, persistance, validation et sérialisation | Garantit la cohérence type/prix/véhicule    |
| `src/trip-requests/trip-requests.service.spec.ts`                       | Tests des prix et incompatibilités                      | Protège les règles tarifaires               |

## 10. Idempotence et concurrence

Cette modification ne crée pas directement de transaction de paiement. Elle prépare le prix maximal par place qui sera repris lors de la création du trajet et de la réservation.

Les règles existantes qui empêchent plusieurs acceptations restent en place. Une amélioration future pourra regrouper l'acceptation de la demande, la sélection du véhicule, la création du trajet et la création de la réservation dans une transaction de base de données unique.

## 11. Tests couverts

- voiture à 500 CDF/km/passager ;
- moto à 1 000 CDF/km/passager ;
- coefficient de pluie `1.3` ;
- retour simultané des trois options ;
- prix total dépendant du nombre de places ;
- refus d'une capacité supérieure à celle d'une moto ;
- refus d'un véhicule dont le type diffère du choix du passager ;
- changement du type avec recalcul du prix lorsque le plafond est omis ;
- changement du type avec conservation d'un plafond personnalisé ;
- compilation TypeScript de la migration et des nouveaux contrats.

## 12. Déploiement

Ordre obligatoire :

1. sauvegarder la base ou disposer d'un instantané récupérable ;
2. déployer le code contenant l'entité et la migration ;
3. exécuter la migration TypeORM ;
4. vérifier que toutes les lignes de `trip_requests` ont un `vehicleType` ;
5. publier le client qui appelle `vehicle-options` et envoie le champ obligatoire ;
6. surveiller les erreurs `400` liées aux anciens clients qui n'envoient pas encore `vehicleType`.

Pour éviter une rupture avec une ancienne application mobile, le déploiement du client et celui de l'obligation DTO doivent être coordonnés.

## 13. Retour arrière

La méthode `down` supprime l'index puis la colonne. Elle ne doit être utilisée qu'après retour à une version du backend qui ne lit plus `vehicleType`.

Un retour arrière perd le choix de type enregistré après la migration. Il ne modifie toutefois pas les trajets, réservations et paiements déjà matérialisés.

## 14. Limites et décisions futures

- Les tarifs sont encore codés dans le service et non dans une table tarifaire versionnée.
- Les voitures n'ont pas de capacité maximale globale ; la capacité dépend des données du véhicule et du trajet.
- Les motos à deux et trois roues ont actuellement le même tarif.
- Le prix recommandé sert de plafond accepté pour le flux d'acceptation directe ; un futur catalogue tarifaire devra distinguer clairement « estimation », « plafond » et « prix final ».
- L'historique ne conserve pas encore la version de grille tarifaire utilisée. Cette donnée deviendra importante avant de permettre la modification dynamique des tarifs par un administrateur.
