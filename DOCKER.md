# Guide Docker - ZWANGA Backend

Ce guide explique comment utiliser Docker pour développer et déployer l'application ZWANGA Backend.

## 📋 Prérequis

- Docker 20.10+
- Docker Compose 2.0+

## 🚀 Démarrage rapide

### 1. Configuration

Créez un fichier `.env` à la racine du projet avec vos variables d'environnement. Voir `ENV_VARIABLES.md` pour la liste complète.

Exemple minimal pour Docker :

```env
NODE_ENV=production
PORT=5000
API_PREFIX=api/v1

# Database
DATABASE_USER=postgres
DATABASE_PASSWORD=your_secure_password
DATABASE_NAME=zwanga_db
DATABASE_PORT=5432

# Redis
REDIS_PORT=6379
REDIS_HOST_PORT=6380
REDIS_PASSWORD=

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=1d
JWT_REFRESH_SECRET=your-super-secret-refresh-key
JWT_REFRESH_EXPIRES_IN=21d

# CORS
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

### 2. Démarrer tous les services

```bash
docker-compose up -d
```

Cette commande va :
- Construire l'image Docker de l'API
- Démarrer PostgreSQL avec PostGIS
- Démarrer Redis
- Démarrer l'API NestJS

### 3. Vérifier les logs

```bash
# Tous les services
docker-compose logs -f

# Un service spécifique
docker-compose logs -f api
docker-compose logs -f postgres
docker-compose logs -f redis
```

### 4. Arrêter les services

```bash
docker-compose down
```

Pour supprimer aussi les volumes (⚠️ supprime les données) :

```bash
docker-compose down -v
```

## 🔧 Commandes utiles

### Reconstruire l'image

```bash
docker-compose build api
docker-compose up -d api
```

### Accéder au shell du conteneur API

```bash
docker-compose exec api sh
```

### Accéder à PostgreSQL

```bash
docker-compose exec postgres psql -U postgres -d zwanga_db
```

### Accéder à Redis CLI

```bash
docker-compose exec redis redis-cli
```

### Vérifier l'état des services

```bash
docker-compose ps
```

### Redémarrer un service

```bash
docker-compose restart api
```

## 🛠️ Développement

Pour le développement avec hot-reload, utilisez le fichier de configuration de développement :

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Cela monte le code source en volume pour permettre le hot-reload.

## 📦 Structure Docker

### Dockerfile

Le Dockerfile utilise un build multi-stage :
- **Stage builder** : Installe les dépendances et compile TypeScript
- **Stage production** : Copie uniquement les fichiers nécessaires pour la production

### Volumes

- `postgres_data` : Données PostgreSQL persistantes
- `redis_data` : Données Redis persistantes
- `./uploads` : Fichiers uploadés par les utilisateurs

### Réseau

Tous les services sont sur le réseau `zwanga-network` pour communiquer entre eux.

## 🔍 Health Checks

Tous les services ont des health checks configurés :

- **PostgreSQL** : Vérifie que le serveur est prêt
- **Redis** : Vérifie que Redis répond
- **API** : Vérifie l'endpoint `/api/v1/health`

Vérifier les health checks :

```bash
docker-compose ps
```

## 🐛 Dépannage

### L'API ne démarre pas

1. Vérifiez les logs : `docker-compose logs api`
2. Vérifiez que PostgreSQL et Redis sont démarrés : `docker-compose ps`
3. Vérifiez les variables d'environnement dans `.env`

### Erreur de connexion à la base de données

1. Vérifiez que PostgreSQL est démarré : `docker-compose ps postgres`
2. Vérifiez les credentials dans `.env`
3. Vérifiez que PostGIS est installé : `docker-compose exec postgres psql -U postgres -d zwanga_db -c "SELECT PostGIS_version();"`

### Erreur de connexion à Redis

1. Vérifiez que Redis est démarré : `docker-compose ps redis`
2. Vérifiez la configuration dans `.env`
3. Si vous avez déjà un Redis local sur `6379`, laissez `REDIS_PORT=6379` et changez seulement `REDIS_HOST_PORT` (par défaut `6380`)

### Reconstruire depuis zéro

```bash
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

## 🚀 Production

Pour la production, assurez-vous de :

1. Utiliser des mots de passe forts
2. Configurer `NODE_ENV=production`
3. Configurer les variables d'environnement sensibles (JWT secrets, etc.)
4. Utiliser un reverse proxy (nginx, traefik, etc.)
5. Configurer les backups pour PostgreSQL et Redis
6. Utiliser des volumes nommés pour la persistance

## 📝 Notes

- Le port par défaut de l'API est **5000** (configurable via `PORT`)
- PostgreSQL utilise le port **5432** (configurable via `DATABASE_PORT`)
- Redis utilise le port **6379** à l'intérieur du réseau Docker
- Redis est exposé sur l'hôte via **6380** par défaut (configurable via `REDIS_HOST_PORT`)
- Les données sont persistées dans des volumes Docker
- PostGIS est automatiquement installé lors de la première création du conteneur PostgreSQL

