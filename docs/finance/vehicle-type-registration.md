# FIN-VEH-001 — Type obligatoire à la création d'un véhicule

Date : 19 août 2026  
Statut : implémenté dans le code  
Périmètre : véhicules, inscription conducteur, application mobile et cohérence tarifaire

## 1. Besoin métier

Chaque véhicule utilisable sur Zwanga doit être classé explicitement dans l'un des trois types canoniques :

| Valeur API | Libellé mobile | Capacité maximale métier |
| --- | --- | ---: |
| `car` | Voiture | dépend du véhicule et du trajet |
| `motorcycle_2_wheels` | Moto à 2 roues | 2 places |
| `motorcycle_3_wheels` | Moto à 3 roues | 3 places |

Cette classification est financièrement sensible : le type du véhicule doit correspondre au type demandé par le passager, lequel détermine le tarif recommandé de la course. Le type ne crée toutefois aucune transaction à lui seul.

## 2. Comportement avant la modification

- `vehicles.type` existait déjà en base avec une valeur par défaut `car`.
- `POST /api/v1/vehicles` acceptait l'absence du type.
- le service remplaçait silencieusement un type absent par `car` ;
- le formulaire partagé du profil et de la publication ne permettait pas de choisir le type ;
- l'inscription présentait des catégories locales `sedan`, `suv`, `van` et `moto`, incompatibles avec l'enum du serveur ;
- l'inscription classique n'envoyait pas le choix et le flux Google ignorait les informations du véhicule conducteur.

Ce comportement pouvait classer une moto comme voiture et rendre incohérents l'appariement, la capacité et le tarif utilisé plus tard.

## 3. Comportement après la modification

1. Le conducteur choisit obligatoirement un type avant de valider le véhicule.
2. Le mobile envoie la valeur canonique dans le champ `type`.
3. Le DTO et le service refusent toute création sans type.
4. La valeur est conservée dans `vehicles.type` et retournée dans les réponses.
5. Le profil et l'étape véhicule de la publication affichent le libellé du type enregistré.
6. L'inscription téléphone, Apple et Google transmettent le même contrat véhicule.
7. Une modification ultérieure du type reste possible par `PUT /api/v1/vehicles/:id`, sous réserve des règles de capacité des trajets actifs.

Il n'existe plus de repli serveur vers `car` pour une nouvelle création.

## 4. Contrats API

### 4.1 Création authentifiée

`POST /api/v1/vehicles`

```json
{
  "type": "motorcycle_2_wheels",
  "brand": "Honda",
  "model": "CB125",
  "color": "Rouge",
  "licensePlate": "MOTO-001"
}
```

Le champ `type` est obligatoire et doit appartenir à `VehicleType`. Une absence ou une autre valeur produit une réponse `400`.

### 4.2 Inscription téléphone

`POST /api/v1/auth/register` utilise `multipart/form-data` :

```text
role=driver
isDriver=true
vehicle[type]=motorcycle_3_wheels
vehicle[brand]=TVS
vehicle[model]=King
vehicle[color]=Bleu
vehicle[licensePlate]=TRI-001
```

### 4.3 Inscription sociale

`POST /api/v1/auth/google/mobile` et `POST /api/v1/auth/apple/mobile` acceptent le même objet imbriqué :

```json
{
  "idToken": "token-du-fournisseur",
  "phone": "+243900000000",
  "role": "driver",
  "isDriver": true,
  "vehicle": {
    "type": "car",
    "brand": "Toyota",
    "model": "Corolla",
    "color": "Noir",
    "licensePlate": "ABC-1234"
  }
}
```

Les données véhicule sont refusées si `isDriver` est faux. Pour un utilisateur social déjà existant, le endpoint conserve son rôle de connexion et ne recrée pas de véhicule.

## 5. Validation et règles métier

- `type`, `brand`, `model`, `color` et `licensePlate` sont requis à la création ;
- la plaque est normalisée en majuscules sans séparateurs avant comparaison ;
- une plaque appartenant à un autre utilisateur est refusée ;
- une plaque inactive du même propriétaire réactive et met à jour le véhicule existant ;
- le propriétaire doit exister ;
- la création par `/vehicles` exige une session authentifiée ;
- les inscriptions publiques restent protégées par validation DTO et limitation de débit ;
- un changement vers une moto est refusé si un trajet actif exige plus de places que sa capacité.

## 6. Effet financier exact

Cette modification :

- ne crée aucun paiement, point, gain de parrainage, retrait ou écriture de portefeuille ;
- ne recalcule aucun trajet ou paiement existant ;
- ne modifie aucun solde ;
- ne change pas la grille tarifaire définie dans `FIN-TRIP-001`.

Elle protège en amont la règle suivante :

```text
vehicle.type = tripRequest.vehicleType
```

Le prix recommandé reste calculé côté serveur à partir de `tripRequest.vehicleType`, de la distance, du nombre de places et du coefficient météo. Le type enregistré sur le véhicule sert à empêcher l'utilisation d'un véhicule incompatible avec ce choix tarifaire.

## 7. Application mobile

Le catalogue partagé `constants/vehicleTypes.ts` fournit les trois identifiants, libellés, descriptions et icônes. Il est utilisé par :

- l'inscription conducteur ;
- l'ajout depuis le profil ;
- l'ajout pendant la publication d'un trajet.

Le bouton de validation du formulaire partagé reste désactivé tant qu'aucun type n'est choisi. Les formulaires parents répètent la validation avant l'appel réseau. La sélection est remise à `null` à la fermeture ou à la réinitialisation, ce qui oblige un nouveau choix explicite.

Les adaptateurs de réponses véhicule utilisent temporairement `car` uniquement pour lire une réponse d'un ancien serveur qui ne fournirait pas encore `type`. Ce repli de lecture ne s'applique jamais à une nouvelle création.

## 8. Fichiers modifiés

### Backend

| Fichier | Modification | Justification financière |
| --- | --- | --- |
| `src/vehicles/dto/vehicle.dto.ts` | `type` obligatoire à la création | interdit un classement tarifaire implicite |
| `src/vehicles/vehicles.service.ts` | validation du type et suppression du défaut | garantit la donnée source |
| `src/vehicles/vehicles.service.spec.ts` | test de l'absence et des trois types | protège le contrat |
| `src/auth/dto/auth.dto.ts` | véhicule conducteur ajouté au flux Google | aligne les inscriptions sociales |
| `src/auth/auth.controller.ts` | schéma Swagger et transfert des options Google | documente et transmet le contrat |
| `src/auth/auth.service.ts` | rôle et véhicule lors d'une première inscription Google | évite de perdre le type choisi |

### Application

| Fichier | Modification |
| --- | --- |
| `constants/vehicleTypes.ts` | catalogue canonique partagé |
| `components/VehicleFormModal.tsx` | choix tactile obligatoire et accessible |
| `components/auth/types.ts` | remplacement des anciennes catégories locales |
| `app/auth.tsx` | envoi du type dans les trois modes d'inscription |
| `app/(tabs)/profile.tsx` | choix, création et affichage du type |
| `app/publish.tsx` | choix lors de l'ajout en cours de publication |
| `store/api/authApi.ts` | contrats Google et Apple typés |
| `store/api/vehicleApi.ts` | `type` obligatoire dans la mutation de création |
| `store/api/tripApi.ts`, `store/api/userApi.ts` | lecture du type dans les adaptateurs |
| `types/index.ts` | type ajouté au modèle `Vehicle` |

## 9. Idempotence et concurrence

La création n'ajoute aucune écriture financière. La normalisation et l'unicité de la plaque évitent deux véhicules concurrents pour la même plaque. Une contrainte unique détectée après une course concurrente est rechargée : le véhicule est réactivé pour son propriétaire ou refusé s'il appartient à un tiers.

## 10. Déploiement et compatibilité

1. déployer le backend qui accepte les valeurs canoniques ;
2. publier l'application avec le sélecteur obligatoire ;
3. surveiller les réponses `400` contenant `type` dans les champs manquants ;
4. vérifier sur un échantillon que chaque nouveau véhicule possède le type choisi ;
5. rapprocher les types des véhicules avec les demandes et trajets associés.

Aucune nouvelle migration n'est requise : la colonne enum `vehicles.type` existe déjà. Les véhicules historiques ne sont pas reclassés par cette modification.

## 11. Retour arrière

Le retour arrière applicatif peut restaurer l'ancien formulaire et rendre le DTO facultatif. Il est déconseillé de rétablir le défaut silencieux `car`, car cela réintroduirait une ambiguïté tarifaire. Aucun paiement, point ou solde n'est à annuler lors du retour arrière.

## 12. Vérifications

- création voiture ;
- création moto à 2 roues ;
- création moto à 3 roues ;
- refus lorsque `type` manque ;
- refus d'une baisse de capacité incompatible avec un trajet actif ;
- build TypeScript backend ;
- compilation TypeScript mobile ;
- lint mobile.

Document associé : [choix du véhicule et tarification d'une demande](./trip-request-vehicle-pricing.md).
