# Monitoring Stack (Loki + Prometheus + Grafana)

La stack monitoring est integree dans `docker-compose.yml`.

## Services ajoutes

- `loki` (logs store)
- `promtail` (collecte des logs Docker vers Loki)
- `prometheus` (collecte des metriques)
- `grafana` (visualisation)
- `redis-exporter` (metriques Redis)
- `postgres-exporter` (metriques PostgreSQL)

## Ports

- Grafana: `http://127.0.0.1:3001`
- Prometheus: `http://127.0.0.1:9090`
- Loki: `http://127.0.0.1:3100`

## Lancer avec load balancer Nginx

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
```

## Lancer sans load balancer

```bash
docker compose -f docker-compose.yml up -d --build
```

## Connexion Grafana

- URL: `http://127.0.0.1:3001`
- Login: `admin`
- Mot de passe: `admin`

Vous pouvez changer les identifiants avec:

- `GRAFANA_ADMIN_USER`
- `GRAFANA_ADMIN_PASSWORD`

## Datasources Grafana (provisionnees automatiquement)

- `Prometheus` -> `http://prometheus:9090`
- `Loki` -> `http://loki:3100`

## Arreter

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down
```

