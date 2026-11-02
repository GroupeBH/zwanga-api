# Demandes de trajet avec plusieurs types de véhicule

Date : 2 novembre 2026. Implémentation locale dans le backend et l’application Zwanga, sans déploiement.

Le passager peut accepter une voiture, une moto à deux roues, une moto à trois roues, ou une combinaison de ces types. Les conducteurs possédant au moins un véhicule actif compatible deviennent éligibles. Cela élargit les candidats, sans transformer le relais séquentiel existant en sonnerie simultanée chez tous les conducteurs.

## Contrat API

`POST /api/v1/trip-requests` et `PUT /api/v1/trip-requests/:id` acceptent le champ additionnel suivant :

```json
{
  "vehicleType": "car",
  "vehicleTypes": ["car", "motorcycle_2_wheels"],
  "numberOfSeats": 2,
  "maxPricePerSeat": 2500
}
```

Cet extrait complète les autres champs de la demande. `vehicleTypes` contient de un à trois éléments distincts parmi `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. Les tableaux vides, valeurs nulles, doublons et types inconnus sont refusés. Si les deux champs sont envoyés, le type scalaire doit appartenir à la liste ; le serveur conserve son premier élément comme type principal.

- Ancien client envoyant seulement `vehicleType` : choix unique, inchangé.
- Nouveau client envoyant seulement `vehicleTypes` : accepté ; `vehicleType` est déduit du premier élément.
- Modification sans ces champs : les choix existants restent conservés.
- Modification contenant seulement `vehicleType` : remplace les choix par ce type unique.
- Lectures des demandes et offres associées : liste normalisée `vehicleTypes`, avec le champ historique conservé.
- Recherche facultative d’un conducteur : `GET /api/v1/trip-requests/driver-choices?...&vehicleTypes=car,motorcycle_2_wheels`. La réponse inclut le type réel du véhicule retenu.

Le budget est commun à tous les types sélectionnés. Le premier type sert de référence à l’estimation, pas de nouveau tarif à appliquer après acceptation. Le montant confirmé et les commissions existantes restent inchangés. Le nombre de places doit être compatible avec tous les types choisis ; les contrôles d’identité pour les places supplémentaires restent actifs.

## Attribution et cohérence

Les sélections multiples sont utilisées pour la découverte et la revalidation des candidats Redis, le secours SQL existant, les alertes programmées, les propositions de partage, la carte des conducteurs, le ciblage et l’acceptation d’une demande. Un conducteur avec plusieurs véhicules compatibles n’est pas ajouté une fois par véhicule. La capacité est contrôlée avant de retenir son véhicule, afin qu’un véhicule trop petit ne masque pas un autre véhicule compatible.

Rayon de proximité, compte actif, KYC, disponibilité, préférences de découverte, règles de localisation existantes, refus antérieurs, délai d’invitation, consentement au partage et verrouillage restent conservés. La version du cache de candidats inclut la liste entière. Les données de push transportent la liste sous forme de chaîne JSON ; les réponses REST contiennent un tableau.

Dans le mobile, la création et la modification utilisent des cases à cocher, sans changement de charte graphique. Au moins un choix reste sélectionné. Listes, détails, conducteur ciblé, véhicules proposés à l’acceptation et récupération après timeout utilisent aussi les choix multiples. Aucune nouvelle permission ni dépendance native.

## Migration et mise en service

Migration : `RequestVehicleTypes1780000104000`.

1. Exécuter la migration avec la procédure habituelle avant de démarrer le nouveau backend. Elle ajoute une colonne `text[]` nullable, sans réécriture des anciennes lignes ; les lectures retombent sur leur type historique. La contrainte est ajoutée `NOT VALID` pour éviter un scan initial, mais contrôle les nouvelles écritures. Un déclencheur maintient la cohérence du type principal et des écritures scalaires des anciens serveurs.
2. Terminer le déploiement du backend et vérifier les parcours à choix unique et multiples avant de publier le mobile. Un ancien serveur ne connaît pas les nouvelles listes ; la coexistence d’images pendant le déploiement n’est pas le moment d’activer la nouvelle interface.
3. Publier la mise à jour mobile. Les anciennes versions continuent leur choix unique ; elles ne disposent pas de la nouvelle interface multi-sélection et peuvent encore afficher uniquement le type principal.

Retour arrière : revenir à un backend ne lisant plus `vehicleTypes` avant d’exécuter `down`. Celle-ci retire le déclencheur, la contrainte et la colonne ; elle conserve le premier type mais perd les choix supplémentaires. Les trajets, réservations et paiements ne sont pas modifiés par cette migration. Ne pas remettre l’ancien backend avec de nouveaux clients multi-sélection sans prévoir leur compatibilité.

Le guide PostgreSQL a orienté l’ajout sans backfill, les contraintes, la sélection bornée des candidats et les essais sur des instances isolées. Aucun changement Terraform, CI/CD ou variable d’environnement n’est nécessaire pour cette fonctionnalité.

## Vérifications locales

- Backend : 317 tests ciblés réussis dans 29 suites. Les suites conditionnelles SQL/Redis ignorées dans cette commande sont vérifiées séparément pour le relais séquentiel.
- PostgreSQL/PostGIS et Redis jetables : 74 tests d’intégration réussis, trois cas conditionnels ignorés. Ils incluent refus et timeout entre types différents, exclusions de distance/type, sélection d’un véhicule suffisamment grand, contraintes et migration aller-retour.
- PostgreSQL/PostGIS complémentaire : 176 tests réussis pour le dispatch, le partage et le changement de conducteur. L’assertion de forme de la réponse des conducteurs a été adaptée au nouveau champ public `vehicleType` ; les contrôles de confidentialité restent actifs.
- Mobile : 98 tests ciblés réussis, dont sélection multiple, brouillon, transmission et conservation du budget en édition, compatibilité du conducteur ciblé, capacités, récupération après timeout et non-régression des horaires/adresses.
- TypeScript backend de production et mobile, ESLint mobile ciblé, limite de taille des sources et `git diff --check` réussis.

Ces vérifications n’incluent pas une réception FCM/APNs réelle, une sonnerie sur appareil ou une compilation native. La réception effective dépend toujours du réseau et des autorisations système. Aucun serveur applicatif existant ni base de production n’a été modifié.
