# Simulation d'une Infra "Prete Prod" (Documentation)

Ce document decrit quoi ajouter a la stack actuelle pour simuler une infra proche production, sans deployer encore sur Kubernetes.

## 1) Perimetre

Objectif: passer d'un setup dev "fonctionnel" a un setup "production-like" avec:

- observabilite complete (metrics, logs, alerts, traces)
- securite au niveau edge (TLS, headers, rate limiting)
- resilience (backups, failover, runbooks)
- gouvernance de deploiement (CI/CD, quality gates)
- tests de charge et tests de panne

## 2) Etat actuel du projet

Deja en place:

- Nginx reverse proxy + load balancer (`least_conn`) devant `api-1` et `api-2`
- PostgreSQL + Redis
- Monitoring de base: Prometheus + Grafana + Loki + Promtail
- Exporters: Redis exporter et Postgres exporter
- healthchecks Docker sur services critiques

Fichiers de reference:

- `docker-compose.yml`
- `docker-compose.nginx.yml`
- `docker/nginx/lb.conf`
- `docker/monitoring/prometheus.yml`
- `docker/monitoring/grafana/provisioning/datasources/datasources.yml`
- `MONITORING_GUIDE.md`
- `NGINX_LB_GUIDE.md`

## 3) Cible "prod-like" recommandee

Ajouter les briques suivantes, dans cet ordre:

1. Alertmanager + regles Prometheus
2. TLS front Nginx + durcissement HTTP
3. Tracing distribue (OpenTelemetry + Tempo ou Jaeger)
4. Sauvegardes Postgres + exercices de restauration
5. Queue async + worker dedie
6. Hardening containers (droits, FS, limites ressources)
7. CI/CD avec quality gates et scans
8. Tests de charge + chaos/failure drills

## 4) Composants a ajouter

### 4.1 Alerting (priorite P1)

But: ne pas "observer passivement", mais etre notifie automatiquement.

A ajouter:

- `alertmanager` dans Docker Compose
- fichier de regles Prometheus (ex: `docker/monitoring/alerts.yml`)
- route d'alerte (email, Slack, Discord, webhook)

Alertes minimales conseillees:

- `ApiInstanceDown`: une instance API indisponible > 1 min
- `Nginx5xxHigh`: taux 5xx depasse un seuil (ex: > 2%)
- `PostgresDown` / `RedisDown`
- `PostgresExporterDown` / `RedisExporterDown`
- `HighLatencyP95`: p95 HTTP > seuil defini
- `DiskUsageHigh` pour volumes DB/monitoring

Critere de validation:

- une panne API forcee declenche bien une alerte en < 2 min
- une resolution de panne ferme l'alerte automatiquement

### 4.2 TLS + securite edge (priorite P1)

But: simuler une entree internet reelle.

A ajouter:

- terminaison TLS sur Nginx (`443`)
- redirection `80 -> 443`
- certificats (local: auto-signes ou `mkcert`; preprod/prod: ACME/Let's Encrypt)

Durcissement Nginx recommande:

- `HSTS`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`
- limitation de taille body (`client_max_body_size`)
- rate limiting par IP sur endpoints sensibles (`/auth/*`)
- timeouts explicites et politique retry claire

Critere de validation:

- tous les appels API externes passent en HTTPS
- scans de base (ex: SSL Labs en environnement externe) sans alertes majeures

### 4.3 Tracing distribue (priorite P2)

But: diagnostiquer rapidement les lenteurs et erreurs inter-services.

A ajouter:

- OpenTelemetry SDK cote API NestJS
- `otel-collector` en compose
- backend traces (Grafana Tempo ou Jaeger)
- correlation logs/traces (trace id dans logs applicatifs)

Signals cibles:

- trace par requete HTTP
- spans DB (PostgreSQL), Redis, appels externes
- propagation de contexte sur jobs async

Critere de validation:

- depuis Grafana/Tempo, une requete lente est navigable de bout en bout

### 4.4 Backups + restore drills (priorite P1)

But: garantir la recuperation reelle des donnees.

A ajouter:

- strategie backup Postgres (ex: `pg_dump` planifie + retention)
- stockage backup sur volume dedie (local) puis objet distant (S3/MinIO) en etape suivante
- script de restauration documente et teste

Rythme minimum:

- backup quotidien
- test de restauration au moins 1 fois/semaine en environnement de test

Critere de validation:

- restauration complete en moins du RTO defini
- donnees verifiees apres restore

### 4.5 Queue async + workers (priorite P2)

But: sortir les traitements lourds du chemin synchrone HTTP.

A ajouter:

- file de messages (BullMQ/Redis Streams ou RabbitMQ)
- service worker dedie (container separe)
- retries, DLQ (dead letter queue), idempotence

Cas d'usage cibles:

- envoi notifications
- traitements media
- calculs ou integrations externes

Critere de validation:

- API reste reactive meme si le worker est ralenti

### 4.6 Hardening runtime (priorite P1)

But: reduire surface d'attaque et risques d'instabilite.

A appliquer:

- containers non-root
- `read_only: true` la ou possible
- `no-new-privileges:true`
- `cap_drop: [ALL]` (puis ajouter seulement si necessaire)
- limites CPU/RAM par service
- healthcheck + readiness logique par service
- segmentation reseau (frontend/proxy, backend, data)

Critere de validation:

- un service ne peut pas ecrire hors volumes explicitement montes
- pression memoire sur un service n'entraine pas un effondrement global

### 4.7 CI/CD et gouvernance (priorite P2)

But: fiabiliser chaque changement.

Pipeline minimum recommande:

1. lint + tests unitaires + tests e2e critiques
2. build image + scan vulnerabilites
3. verification migrations DB
4. deploiement preprod
5. smoke tests post-deploiement

Quality gates:

- blocage si tests rouges
- blocage si CVE critique non acceptee
- blocage si migrations non compatibles

### 4.8 Load test + chaos drills (priorite P2)

But: verifier les SLO avant incident reel.

A ajouter:

- scenarios `k6` (login, recherche trajets, creation reservation, etc.)
- campagnes de charge regulieres (baseline puis pic)
- tests de panne:
  - kill `api-1` en charge
  - restart Redis
  - latence DB injectee (toxiproxy optionnel)

Critere de validation:

- p95 et taux d'erreur restent dans les objectifs SLO

## 5) SLO de depart proposes

Exemples pragmatiques:

- disponibilite API mensuelle >= 99.5%
- p95 endpoints critiques <= 500 ms
- taux d'erreur 5xx < 1%
- RPO DB <= 24h
- RTO service critique <= 60 min

Ces valeurs sont un point de depart, a ajuster avec les contraintes metier.

## 6) Runbooks minimaux a ecrire

Runbooks prioritaires:

- `RUNBOOK_502_NGINX.md`
- `RUNBOOK_DB_DEGRADED.md`
- `RUNBOOK_REDIS_UNAVAILABLE.md`
- `RUNBOOK_HIGH_LATENCY.md`
- `RUNBOOK_RESTORE_POSTGRES.md`

Chaque runbook doit contenir:

1. symptomes
2. checks immediats (commandes)
3. hypotheses probables
4. actions correctives
5. validation post-correctif
6. prevention long terme

## 7) Plan d'implementation en phases

### Phase 1 (P1) - 1 a 2 semaines

- Alertmanager + regles de base
- TLS Nginx + headers securite
- hardening containers essentiel
- backup quotidien + test restore hebdomadaire

Livrable: stack stable avec alertes actionnables et securite edge minimale.

### Phase 2 (P2) - 1 a 2 semaines

- OpenTelemetry + backend traces
- queue async + worker
- dashboards SLO (latence, erreurs, saturation)

Livrable: diagnostic rapide des incidents et meilleure resilience applicative.

### Phase 3 (P2+) - continu

- CI/CD complet avec scans
- load tests automatiques
- chaos drills periodiques

Livrable: cadence de release fiable et capacite a absorber incidents/reprises.

## 8) Checklist de validation finale

- [ ] Acces API en HTTPS uniquement
- [ ] Alertes critiques testees de bout en bout
- [ ] Dashboards Grafana couvrent les SLI majeurs
- [ ] Traces disponibles pour les endpoints critiques
- [ ] Backups verifies par restauration reelle
- [ ] Limites ressources appliquees a tous les services
- [ ] Pipeline CI/CD bloque les regressions
- [ ] Tests de charge executes et resultats archives
- [ ] Runbooks critiques valides par l'equipe

## 9) Notes importantes pour ce projet

- Le load balancer Nginx est deja en mode resolution dynamique des upstreams Docker (`resolver 127.0.0.11` + `resolve`), ce qui evite les 502 apres recreation des containers API.
- Les datasources Grafana sont provisionnees automatiquement (`Prometheus`, `Loki`).
- La prochaine etape la plus rentable est `Alertmanager + regles + dashboard SLO`.

