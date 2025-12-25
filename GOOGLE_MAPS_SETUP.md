# Google Maps API - Configuration et Utilisation

Ce guide explique comment configurer et utiliser les APIs Google Maps dans le backend ZWANGA.

## 📋 Prérequis

1. Un compte Google Cloud Platform (GCP)
2. Un projet GCP avec les APIs suivantes activées :
   - **Directions API** : Pour calculer les itinéraires
   - **Places API** : Pour rechercher des lieux et obtenir des suggestions
   - **Geocoding API** : Pour convertir des adresses en coordonnées et vice versa

## 🔑 Configuration

### 1. Obtenir une clé API Google Maps

1. Allez sur [Google Cloud Console](https://console.cloud.google.com/)
2. Créez un projet ou sélectionnez un projet existant
3. Activez les APIs nécessaires :
   - [Directions API](https://console.cloud.google.com/apis/library/directions-backend.googleapis.com)
   - [Places API](https://console.cloud.google.com/apis/library/places-backend.googleapis.com)
   - [Geocoding API](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com)
4. Créez une clé API :
   - Allez dans "APIs & Services" > "Credentials"
   - Cliquez sur "Create Credentials" > "API Key"
   - Copiez la clé API générée

### 2. Configurer la clé API dans le projet

Ajoutez la clé API dans votre fichier `.env` :

```env
GOOGLE_MAPS_API_KEY=your-api-key-here
```

### 3. Restreindre la clé API (Recommandé pour la production)

Pour des raisons de sécurité, restreignez votre clé API :

1. Dans Google Cloud Console, allez dans "APIs & Services" > "Credentials"
2. Cliquez sur votre clé API
3. Sous "API restrictions", sélectionnez "Restrict key"
4. Sélectionnez uniquement les APIs nécessaires :
   - Directions API
   - Places API
   - Geocoding API
5. Sous "Application restrictions", vous pouvez restreindre par :
   - IP addresses (pour le backend)
   - HTTP referrers (si utilisé côté frontend)

## 🚀 Endpoints disponibles

Tous les endpoints sont préfixés par `/api/v1/google-maps`

### 1. Geocoding - Convertir une adresse en coordonnées

**POST** `/google-maps/geocode`

```json
{
  "address": "Kinshasa, République Démocratique du Congo",
  "region": "CD"
}
```

**Réponse :**
```json
{
  "formattedAddress": "Kinshasa, Democratic Republic of the Congo",
  "lat": -4.3276,
  "lng": 15.3136,
  "placeId": "ChIJ...",
  "addressComponents": [...]
}
```

### 2. Reverse Geocoding - Convertir des coordonnées en adresse

**POST** `/google-maps/reverse-geocode`

```json
{
  "lat": -4.3276,
  "lng": 15.3136
}
```

**Réponse :**
```json
{
  "formattedAddress": "Kinshasa, Democratic Republic of the Congo",
  "lat": -4.3276,
  "lng": 15.3136,
  "placeId": "ChIJ...",
  "addressComponents": [...]
}
```

### 3. Places Autocomplete - Suggestions de lieux

**GET** `/google-maps/places/autocomplete?input=Kinshasa&region=CD`

**Paramètres de requête :**
- `input` (requis) : Texte de recherche
- `locationLat` (optionnel) : Latitude pour biaiser les résultats
- `locationLng` (optionnel) : Longitude pour biaiser les résultats
- `radius` (optionnel) : Rayon en mètres pour le biais de localisation
- `region` (optionnel) : Code de région (ex: "CD" pour Congo)
- `language` (optionnel) : Code de langue (ex: "fr", "en")

**Réponse :**
```json
[
  {
    "placeId": "ChIJ...",
    "description": "Kinshasa, Democratic Republic of the Congo",
    "mainText": "Kinshasa",
    "secondaryText": "Democratic Republic of the Congo"
  }
]
```

### 4. Place Details - Détails d'un lieu

**GET** `/google-maps/places/details?placeId=ChIJ...&language=fr`

**Paramètres de requête :**
- `placeId` (requis) : ID du lieu obtenu via autocomplete ou search
- `language` (optionnel) : Code de langue

**Réponse :**
```json
{
  "placeId": "ChIJ...",
  "formattedAddress": "Kinshasa, Democratic Republic of the Congo",
  "lat": -4.3276,
  "lng": 15.3136,
  "name": "Kinshasa",
  "phoneNumber": "+243...",
  "website": "https://...",
  "rating": 4.5,
  "types": ["locality", "political"]
}
```

### 5. Places Search - Recherche de lieux

**GET** `/google-maps/places/search?query=restaurant Kinshasa&locationLat=-4.3276&locationLng=15.3136&radius=5000`

**Paramètres de requête :**
- `query` (requis) : Requête de recherche
- `locationLat` (optionnel) : Latitude
- `locationLng` (optionnel) : Longitude
- `radius` (optionnel) : Rayon de recherche en mètres
- `language` (optionnel) : Code de langue

**Réponse :**
```json
[
  {
    "placeId": "ChIJ...",
    "formattedAddress": "...",
    "lat": -4.3276,
    "lng": 15.3136,
    "name": "Restaurant Name",
    "rating": 4.5,
    "types": ["restaurant", "food", "point_of_interest"]
  }
]
```

### 6. Directions - Calcul d'itinéraires

**POST** `/google-maps/directions`

```json
{
  "origin": {
    "address": "Kinshasa, RDC"
  },
  "destination": {
    "lat": -4.3276,
    "lng": 15.3136
  },
  "waypoints": [
    {
      "placeId": "ChIJ..."
    }
  ],
  "mode": "driving",
  "avoid": ["tolls", "highways"],
  "optimizeWaypoints": true,
  "alternatives": false,
  "language": "fr",
  "region": "CD"
}
```

**Paramètres :**
- `origin` (requis) : Point de départ (peut être une adresse, coordonnées, ou placeId)
- `destination` (requis) : Point d'arrivée
- `waypoints` (optionnel) : Points intermédiaires
- `mode` (optionnel) : Mode de transport (`driving`, `walking`, `bicycling`, `transit`)
- `avoid` (optionnel) : Éviter (`tolls`, `highways`, `ferries`, `indoor`)
- `optimizeWaypoints` (optionnel) : Optimiser l'ordre des waypoints
- `alternatives` (optionnel) : Retourner des itinéraires alternatifs
- `language` (optionnel) : Code de langue
- `region` (optionnel) : Code de région
- `departureTime` (optionnel) : Timestamp Unix pour le départ
- `arrivalTime` (optionnel) : Timestamp Unix pour l'arrivée

**Réponse :**
```json
{
  "routes": [
    {
      "summary": "Avenue de la Justice and Route de Matadi",
      "legs": [
        {
          "distance": 15231,
          "duration": 1800,
          "startAddress": "Kinshasa, RDC",
          "endAddress": "Destination Address",
          "startLocation": {
            "lat": -4.3276,
            "lng": 15.3136
          },
          "endLocation": {
            "lat": -4.3276,
            "lng": 15.3136
          },
          "steps": [
            {
              "distance": 100,
              "duration": 60,
              "htmlInstructions": "Head <b>north</b> on...",
              "polyline": "encoded_polyline_string",
              "startLocation": {
                "lat": -4.3276,
                "lng": 15.3136
              },
              "endLocation": {
                "lat": -4.3276,
                "lng": 15.3136
              }
            }
          ]
        }
      ],
      "overviewPolyline": "encoded_polyline_string",
      "bounds": {
        "northeast": {
          "lat": -4.3276,
          "lng": 15.3136
        },
        "southwest": {
          "lat": -4.3276,
          "lng": 15.3136
        }
      },
      "copyrights": "Map data ©2024 Google",
      "warnings": []
    }
  ],
  "status": "OK"
}
```

## 💡 Exemples d'utilisation

### Exemple 1 : Rechercher un lieu et obtenir ses coordonnées

```typescript
// 1. Autocomplete pour trouver le lieu
const predictions = await googleMapsService.placesAutocomplete({
  input: 'Kinshasa',
  region: 'CD',
});

// 2. Obtenir les détails du premier résultat
const placeDetails = await googleMapsService.getPlaceDetails({
  placeId: predictions[0].placeId,
});

// Utiliser placeDetails.lat et placeDetails.lng
```

### Exemple 2 : Calculer un itinéraire

```typescript
const directions = await googleMapsService.getDirections({
  origin: {
    address: 'Kinshasa, RDC',
  },
  destination: {
    lat: -4.3276,
    lng: 15.3136,
  },
  mode: TravelMode.DRIVING,
  language: 'fr',
});

// Utiliser directions.routes[0] pour l'itinéraire principal
const route = directions.routes[0];
const totalDistance = route.legs.reduce((sum, leg) => sum + leg.distance, 0);
const totalDuration = route.legs.reduce((sum, leg) => sum + leg.duration, 0);
```

### Exemple 3 : Convertir une adresse en coordonnées

```typescript
const geocodeResult = await googleMapsService.geocode({
  address: 'Avenue de la Justice, Kinshasa',
  region: 'CD',
});

// Utiliser geocodeResult.lat et geocodeResult.lng
```

## 🔒 Sécurité

- **Ne jamais exposer la clé API côté frontend** : Toutes les requêtes doivent passer par le backend
- **Restreindre la clé API** : Limitez l'utilisation aux APIs nécessaires et aux IPs autorisées
- **Surveiller l'utilisation** : Surveillez les quotas et les coûts dans Google Cloud Console
- **Utiliser des quotas** : Configurez des quotas pour éviter les abus

## 💰 Coûts

Les APIs Google Maps sont facturées selon l'utilisation. Consultez la [page de tarification](https://mapsplatform.google.com/pricing/) pour plus d'informations.

**Note** : Google offre un crédit mensuel gratuit ($200/mois) qui couvre généralement une utilisation modérée.

## 📚 Documentation officielle

- [Google Maps Platform Documentation](https://developers.google.com/maps/documentation)
- [Directions API](https://developers.google.com/maps/documentation/directions)
- [Places API](https://developers.google.com/maps/documentation/places/web-service)
- [Geocoding API](https://developers.google.com/maps/documentation/geocoding)

