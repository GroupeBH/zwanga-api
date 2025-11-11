# ZWANGA Backend

Backend API pour la plateforme de covoiturage ZWANGA à Kinshasa.

## 🚀 Technologies

- **NestJS** - Framework Node.js
- **TypeORM** - ORM pour PostgreSQL
- **PostgreSQL** - Base de données relationnelle
- **Redis** - Cache et sessions
- **JWT** - Authentification
- **Firebase Cloud Messaging** - Notifications push
- **WebSockets** - Communication en temps réel
- **Docker** - Conteneurisation
- **Swagger** - Documentation API

## 📋 Prérequis

- Node.js 20+
- Docker et Docker Compose
- PostgreSQL 15+
- Redis 7+

## 🛠️ Installation

1. Cloner le repository
```bash
git clone <repository-url>
cd zwanga-backend
```

2. Installer les dépendances
```bash
npm install
```

**Note:** Si vous rencontrez des erreurs de dépendances peer, le fichier `.npmrc` est configuré pour utiliser `--legacy-peer-deps` automatiquement.

3. Configurer les variables d'environnement
```bash
cp .env.example .env
# Éditer .env avec vos configurations
```

4. Démarrer les services avec Docker Compose
```bash
docker-compose up -d postgres redis
```

5. Lancer l'application
```bash
# Développement
npm run start:dev

# Production
npm run build
npm run start:prod
```

## 📚 Documentation API

Une fois l'application démarrée, accédez à la documentation Swagger :
```
http://localhost:3000/api/v1/docs
```

## 🏗️ Architecture

### Modules principaux

- **AuthModule** - Authentification JWT, inscription, connexion
- **UserModule** - Gestion des profils utilisateurs et KYC
- **VehicleModule** - Gestion des véhicules
- **TripModule** - Publication et recherche de trajets
- **BookingModule** - Réservations de trajets
- **ChatModule** - Messagerie en temps réel (WebSocket)
- **RatingModule** - Système de notation
- **SubscriptionModule** - Gestion des abonnements
- **NotificationModule** - Notifications push (FCM)
- **AdminModule** - Backoffice admin

## 🔐 Authentification

L'API utilise JWT pour l'authentification. Inclure le token dans les requêtes :

```
Authorization: Bearer <token>
```

## 📝 Variables d'environnement

Voir `.env.example` pour la liste complète des variables.

## 🐳 Docker

Pour démarrer tous les services :
```bash
docker-compose up -d
```

Pour arrêter :
```bash
docker-compose down
```

## 🧪 Tests

```bash
# Tests unitaires
npm run test

# Tests e2e
npm run test:e2e

# Couverture
npm run test:cov
```

## 📄 Licence

UNLICENSED
