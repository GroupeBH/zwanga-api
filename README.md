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

## ☁️ Stockage des fichiers (Amazon S3)

L'application supporte le stockage des fichiers multimédias sur Amazon S3 avec modération de contenu automatique via AWS Rekognition.

### Configuration

1. **Stockage S3** : Configurez les variables d'environnement AWS (voir `AWS_S3_SETUP.md`)
2. **Modération de contenu** : Activez AWS Rekognition pour détecter automatiquement le contenu inapproprié

### Fonctionnalités

- ✅ Upload automatique vers S3 (ou stockage local en fallback)
- ✅ Modération de contenu avec AWS Rekognition
- ✅ Détection de contenu explicite, violence, drogues, symboles de haine, etc.
- ✅ URLs présignées pour l'accès sécurisé aux fichiers privés
- ✅ Support des fichiers publics ou privés

Voir `AWS_S3_SETUP.md` pour la configuration détaillée.

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

## 🚀 PM2 - Gestion des processus

L'application utilise PM2 pour la gestion des processus en production.

### Commandes PM2

```bash
# Démarrer avec PM2
npm run pm2:start

# Arrêter
npm run pm2:stop

# Redémarrer
npm run pm2:restart

# Voir les logs
npm run pm2:logs

# Monitoring
npm run pm2:monit
```

Voir `PM2_GUIDE.md` pour plus de détails.

## 💾 Cache Redis

Le système de cache Redis est configuré pour améliorer les performances :

- **Trips** : Cache de 5 minutes pour les listes et détails
- **Vehicles** : Cache de 10 minutes pour les véhicules
- **Bookings** : Cache de 3 minutes pour les réservations
- **Notifications** : Cache pour les notifications utilisateur

Le cache est automatiquement invalidé lors des opérations de modification (create, update, delete).

## 🔐 Sécurité et Logging

L'application implémente plusieurs mesures de sécurité :

- ✅ **Authentification JWT** : Toutes les routes sont protégées par défaut
- ✅ **Contrôle d'accès basé sur les rôles (RBAC)** : Restrictions par rôle (Admin, Driver, Passenger)
- ✅ **Rate Limiting** : Protection contre les abus et attaques DDoS
- ✅ **Logging complet** : Toutes les requêtes et opérations sont loggées
- ✅ **Validation des entrées** : Validation automatique des DTOs
- ✅ **Modération de contenu** : Détection automatique de contenu inapproprié

Voir `SECURITY.md` pour plus de détails sur la sécurité et le logging.

## 📄 Licence

UNLICENSED
