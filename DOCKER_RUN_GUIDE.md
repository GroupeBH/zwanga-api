# Guide pour lancer l'application avec Docker

## ❌ Problème actuel

Quand vous utilisez `docker run`, le conteneur est isolé et ne peut pas accéder à `localhost:5432` pour PostgreSQL.

## ✅ Solution 1 : Utiliser docker-compose (Recommandé)

Lancez tous les services ensemble avec docker-compose :

```bash
# Démarrer tous les services (postgres, redis, api)
docker-compose up -d

# Voir les logs
docker-compose logs -f api

# Arrêter tous les services
docker-compose down
```

**Avantages :**
- Tous les services sont sur le même réseau Docker
- Les services peuvent communiquer entre eux par nom (postgres, redis)
- Configuration centralisée dans `docker-compose.yml`

## ✅ Solution 2 : Utiliser docker run avec réseau Docker

Si vous préférez utiliser `docker run`, vous devez d'abord :

1. **Lancer PostgreSQL et Redis avec docker-compose :**
```bash
docker-compose up -d postgres redis
```

2. **Lancer l'API en se connectant au même réseau :**
```bash
docker run -it --rm \
  --network zwanga-backend_zwanga-network \
  -p 5000:5000 \
  --env-file .env \
  -e DATABASE_HOST=postgres \
  -e REDIS_HOST=redis \
  zwanga-api
```

## ✅ Solution 3 : Utiliser host.docker.internal (Windows/Mac)

Si PostgreSQL et Redis tournent sur votre machine hôte (pas dans Docker) :

```bash
docker run -it --rm \
  -p 5000:5000 \
  --env-file .env \
  -e DATABASE_HOST=host.docker.internal \
  -e REDIS_HOST=host.docker.internal \
  zwanga-api
```

**Note :** `host.docker.internal` permet au conteneur d'accéder aux services sur la machine hôte.

## 🔍 Vérifier les services

```bash
# Voir tous les conteneurs
docker ps

# Voir les réseaux Docker
docker network ls

# Voir les logs d'un service
docker-compose logs postgres
docker-compose logs redis
docker-compose logs api
```

