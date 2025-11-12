# Variables d'environnement - ZWANGA Backend

Ce document liste toutes les variables d'environnement nécessaires pour configurer l'application.

## 📋 Fichier .env

Créez un fichier `.env` à la racine du projet avec les variables suivantes :

```env
# ============================================
# Application
# ============================================
NODE_ENV=development
PORT=5000
API_PREFIX=api/v1

# ============================================
# Database (PostgreSQL)
# ============================================
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=zwanga_user
DATABASE_PASSWORD=zwanga_password
DATABASE_NAME=zwanga_db

# ============================================
# Redis
# ============================================
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# ============================================
# JWT Authentication
# ============================================
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=1d
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-in-production
JWT_REFRESH_EXPIRES_IN=21d

# ============================================
# Firebase Cloud Messaging (FCM)
# ============================================
# Option 1 (Recommended): Full JSON credentials encoded in Base64
FCM_CREDENTIALS_BASE64=
# Option 2: Individual credentials (if not using FCM_CREDENTIALS_BASE64)
FCM_PROJECT_ID=
FCM_PRIVATE_KEY=
FCM_CLIENT_EMAIL=

# ============================================
# File Upload
# ============================================
MAX_FILE_SIZE=5242880
UPLOAD_DEST=./uploads

# ============================================
# Amazon S3 Configuration (Optional)
# ============================================
# Set AWS_S3_BUCKET_NAME to enable S3 storage (leave empty to use local storage)
AWS_S3_BUCKET_NAME=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Set to 'true' if your S3 bucket is public (default: false, uses presigned URLs)
AWS_S3_PUBLIC_BUCKET=false
# Expiration time for presigned URLs in seconds (default: 3600 = 1 hour)
AWS_S3_PRESIGNED_URL_EXPIRES_IN=3600

# ============================================
# AWS Rekognition - Content Moderation (Optional)
# ============================================
# Set to 'true' to enable content moderation (default: false)
AWS_REKOGNITION_ENABLED=false
# Minimum confidence threshold for moderation labels (0-100, default: 50)
AWS_REKOGNITION_MIN_CONFIDENCE=50

# ============================================
# Rate Limiting
# ============================================
THROTTLE_TTL=60
THROTTLE_LIMIT=10

# ============================================
# Subscriptions
# ============================================
TRIAL_PERIOD_DAYS=7
SUBSCRIPTION_PRICE=5000
```

## 🔐 Durées de validité des tokens JWT

- **Access Token** (`JWT_EXPIRES_IN`) : **1 jour** (`1d`)
  - Utilisé pour authentifier les requêtes API
  - Expire après 24 heures
  - Doit être renouvelé via le refresh token

- **Refresh Token** (`JWT_REFRESH_EXPIRES_IN`) : **3 semaines** (`21d`)
  - Utilisé pour obtenir un nouveau access token
  - Expire après 21 jours
  - Stocké dans la base de données pour chaque utilisateur

## 📝 Format des durées

Les durées peuvent être exprimées en :
- `s` : secondes (ex: `3600s`)
- `m` : minutes (ex: `60m`)
- `h` : heures (ex: `24h`)
- `d` : jours (ex: `1d`, `21d`)
- `w` : semaines (ex: `3w`)

Exemples :
- `1d` = 1 jour
- `21d` = 21 jours (3 semaines)
- `7d` = 7 jours (1 semaine)
- `24h` = 24 heures (1 jour)

## 🔒 Sécurité

⚠️ **IMPORTANT** : En production, changez les valeurs suivantes :
- `JWT_SECRET` : Utilisez une clé secrète forte et unique
- `JWT_REFRESH_SECRET` : Utilisez une clé secrète différente de `JWT_SECRET`
- `DATABASE_PASSWORD` : Utilisez un mot de passe fort
- `REDIS_PASSWORD` : Configurez un mot de passe Redis en production

## 📚 Documentation supplémentaire

- Voir `AWS_S3_SETUP.md` pour la configuration AWS S3 et Rekognition
- Voir `FCM_SETUP.md` pour la configuration Firebase Cloud Messaging
- Voir `PM2_GUIDE.md` pour la gestion des processus avec PM2

