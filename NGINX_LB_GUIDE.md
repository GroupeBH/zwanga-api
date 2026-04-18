# Nginx Reverse Proxy + Load Balancer (Docker Compose)

Ce setup permet de simuler un reverse proxy et un load balancer avec Nginx devant 2 instances de l'API NestJS.

## Fichiers ajoutes

- `docker-compose.nginx.yml`
- `docker/nginx/lb.conf`

## Architecture

- `api-1` et `api-2`: deux instances backend sur le reseau Docker interne.
- `nginx`: point d'entree unique expose sur `http://localhost:18080` (ou `${NGINX_PORT}`).
- Strategie de load balancing Nginx: `least_conn`.
- Monitoring inclus via `docker-compose.yml`:
  - Grafana: `http://127.0.0.1:3001`
  - Prometheus: `http://127.0.0.1:9090`
  - Loki: `http://127.0.0.1:3100`

## Base de donnees utilisee

Le host/port DB des instances `api-1` et `api-2` utilise des variables reservees a Docker Compose:

- `DOCKER_DATABASE_HOST` (defaut: `postgres`)
- `DOCKER_DATABASE_PORT` (defaut: `5432`)

Cela permet de garder `DATABASE_HOST=localhost` dans `.env` pour les executions locales hors Docker.

Exemple:

- `DOCKER_DATABASE_HOST=host.docker.internal` -> utilise votre PostgreSQL local/host
- `DOCKER_DATABASE_HOST=postgres` -> utilise le service PostgreSQL du compose

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
curl http://localhost:18080/api/v1/health
```

3. Voir vers quelle instance la requete est routee

```bash
curl -i http://localhost:18080/api/v1/health
```

Regarder les headers:

- `X-Upstream-Addr`
- `X-Upstream-Status`

## Test de repartition (PowerShell)

```powershell
1..10 | ForEach-Object {
  (Invoke-WebRequest -Uri "http://localhost:18080/api/v1/health" -Method GET).Headers["X-Upstream-Addr"]
}
```

## Test de bascule (failover)

1. Stopper une instance:

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml stop api-2
```

2. Rejouer des requetes sur `http://localhost:18080/api/v1/health`.

Nginx continuera a repondre via l'instance restante.

## Arret

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down
```

Si vous voulez supprimer aussi les volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down -v
```

## Notes de stabilite

- La config Nginx supporte la re-resolution DNS Docker des upstreams API (`api-1`, `api-2`).
- Si vous rebuild/recreatez les containers API, Nginx suit les nouveaux IP sans rester bloque sur d'anciens upstreams.

## Aller plus loin

Voir `PROD_INFRA_SIMULATION_GUIDE.md` pour la roadmap "infra prete prod" (alerting, TLS, tracing, backups, hardening, CI/CD, load tests).
