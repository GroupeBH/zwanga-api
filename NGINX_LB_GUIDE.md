# Nginx Reverse Proxy + Load Balancer (Docker Compose)

Ce setup permet de simuler un reverse proxy et un load balancer avec Nginx devant 2 instances de l'API NestJS.

## Fichiers ajoutes

- `docker-compose.nginx.yml`
- `docker/nginx/lb.conf`

## Architecture

- `api-1` et `api-2`: deux instances backend sur le reseau Docker interne.
- `nginx`: point d'entree unique expose sur `http://localhost:8080`.
- Strategie de load balancing Nginx: `least_conn`.
- Monitoring inclus via `docker-compose.yml`:
  - Grafana: `http://127.0.0.1:3001`
  - Prometheus: `http://127.0.0.1:9090`
  - Loki: `http://127.0.0.1:3100`

## Base de donnees utilisee

Le host/port DB des instances `api-1` et `api-2` vient de `.env`:

- `DATABASE_HOST`
- `DATABASE_PORT`

Exemple:

- `DATABASE_HOST=host.docker.internal` -> utilise votre PostgreSQL local/host
- `DATABASE_HOST=postgres` -> utilise le service PostgreSQL du compose

## Demarrage

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
```

## Verification rapide

1. Etat des services

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml ps
```

2. Healthcheck via Nginx

```bash
curl http://localhost:8080/api/v1/health
```

3. Voir vers quelle instance la requete est routee

```bash
curl -i http://localhost:8080/api/v1/health
```

Regarder les headers:

- `X-Upstream-Addr`
- `X-Upstream-Status`

## Test de repartition (PowerShell)

```powershell
1..10 | ForEach-Object {
  (Invoke-WebRequest -Uri "http://localhost:8080/api/v1/health" -Method GET).Headers["X-Upstream-Addr"]
}
```

## Test de bascule (failover)

1. Stopper une instance:

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml stop api-2
```

2. Rejouer des requetes sur `http://localhost:8080/api/v1/health`.

Nginx continuera a repondre via l'instance restante.

## Arret

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down
```

Si vous voulez supprimer aussi les volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down -v
```
