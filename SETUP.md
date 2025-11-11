# ZWANGA Backend - Guide de démarrage

## Configuration initiale

1. Créer un fichier `.env` à la racine du projet avec le contenu suivant :

```env
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1

DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=zwanga_user
DATABASE_PASSWORD=zwanga_password
DATABASE_NAME=zwanga_db

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=1d
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-in-production
JWT_REFRESH_EXPIRES_IN=7d

FCM_PROJECT_ID=
FCM_PRIVATE_KEY=
FCM_CLIENT_EMAIL=

MAX_FILE_SIZE=5242880
UPLOAD_DEST=./uploads

THROTTLE_TTL=60
THROTTLE_LIMIT=10

TRIAL_PERIOD_DAYS=7
SUBSCRIPTION_PRICE=5000
```

2. Installer les dépendances :
```bash
npm install
```

3. Démarrer PostgreSQL et Redis :
```bash
docker-compose up -d postgres redis
```

4. Lancer l'application :
```bash
npm run start:dev
```

L'API sera disponible sur `http://localhost:3000`
La documentation Swagger sera disponible sur `http://localhost:3000/api/v1/docs`

## Structure des endpoints

- `/api/v1/auth` - Authentification
- `/api/v1/users` - Gestion des utilisateurs
- `/api/v1/vehicles` - Gestion des véhicules
- `/api/v1/trips` - Gestion des trajets
- `/api/v1/bookings` - Gestion des réservations
- `/api/v1/chat` - Chat REST API
- `/api/v1/ratings` - Notations
- `/api/v1/subscriptions` - Abonnements
- `/api/v1/admin` - Administration

## WebSocket

Le chat en temps réel utilise WebSocket sur le namespace `/chat`.

Connexion :
```javascript
const socket = io('http://localhost:3000/chat', {
  auth: {
    token: 'your-jwt-token'
  }
});
```

Events :
- `join_booking` - Rejoindre une conversation de réservation
- `send_message` - Envoyer un message
- `get_messages` - Récupérer les messages
- `new_message` - Nouveau message reçu

