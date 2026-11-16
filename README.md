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
- Extension PostGIS (v3+) activée sur la base (`CREATE EXTENSION postgis;`)
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
> ☁️ **Base de données managée (Neon, Supabase, etc.)** : définissez simplement `DATABASE_URL=postgres://...` (avec `sslmode=require`). Cette variable remplace `DATABASE_HOST`, `DATABASE_USER`, etc.
> ☁️ **Redis managé (Upstash, etc.)** : utilisez `REDIS_URL=rediss://...`. Dans ce cas `REDIS_HOST/PORT/PASSWORD` sont ignorés.

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

## 🗺️ Gestion des localisations (PostGIS)

- Les trajets stockent désormais les points de départ / destination avec des colonnes `geography(Point, 4326)` afin de permettre des recherches géospatiales précises (radius, distances, etc.).
- Assurez-vous que l'extension PostGIS est installée et activée dans votre base :
  ```sql
  CREATE EXTENSION IF NOT EXISTS postgis;
  ```
- Les DTOs `CreateTripDto`, `SearchTripsDto` et `UpdateTripDto` utilisent désormais des champs `[longitude, latitude]` (`departureCoordinates`, `arrivalCoordinates`) pour représenter les points.
- Après mise à jour, exécutez une migration ou, en développement, laissez TypeORM synchroniser le schéma pour ajouter les colonnes `departurePoint` et `arrivalPoint`.
- Les filtres de recherche peuvent inclure des coordonnées + un rayon personnalisé (en km) pour exploiter les requêtes `ST_DWithin`.

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

## Documentation financière

Toute évolution liée aux paiements, aux prix, aux points, aux commissions,
aux remboursements, aux retraits ou au parrainage est documentée dans
[`docs/finance/README.md`](docs/finance/README.md).

## 📄 Licence

UNLICENSED

## Admin : filtres et statistiques serveur

Ces routes utilisent le préfixe API existant (`/api/v1`) et nécessitent le rôle
admin ou super-admin. Elles ne chargent pas d'échantillon de 500/1000 lignes :
les agrégations sont faites dans PostgreSQL.

- `GET /admin/trips?search=&status=&from=&to=&sort=departureDate:asc&page=1&limit=25`
  renvoie toujours `{ trips, total, page, limit }`. Recherche sur l'identifiant,
  le départ, l'arrivée, le nom et le téléphone du conducteur, avant pagination.
- `from`, `to` et `sort=champ:asc|desc` sont aussi pris en charge sur
  `/admin/payments`, `/admin/bookings`, `/admin/trip-requests`, `/admin/kyc`,
  `/safety/admin/reports` et `/support/admin/tickets`. Les champs de tri sont
  limités aux colonnes métier autorisées ; un tri invalide retourne 400.
- `GET /admin/analytics/overview?from=2026-10-01&to=2026-10-31&compare=previous`
  retourne `total`, `byStatus`, `daily`, `completionRate`, `cancellationRate`,
  `popularRoutes`, `drivers`, `previous` et les définitions. `previous` contient
  les mêmes indicateurs sur la période immédiatement précédente, de même durée.
- `GET /safety/admin/reports/stats?from=&to=` retourne `total`, `byReason`,
  `byStatus`. Les listes KYC et signalements gardent leur `total` même si la page
  demandée ne contient aucun élément.
- `GET /admin/payments/stats?from=&to=&groupBy=day|provider|operator` retourne
  les comptes, `successRate`, les `volumes` par devise, `groups`,
  `failuresByOperator` et `pendingPayouts` (âge depuis la création, pas depuis
  la dernière vérification). Opérateur non enregistré : `unknown`.
- `GET /admin/ratings/stats` (alias `/admin/evaluations/stats`) retourne la
  moyenne réelle, la distribution 1–5 et les statistiques/classements des trajets.
  Une absence de note donne `null`, jamais une estimation.
- `GET /admin/promotions/stats` retourne les conducteurs, l'activité et les
  récompenses de parrainage/fidélité enregistrées. Les codes promotionnels de
  démonstration présents dans l'interface ne constituent pas un programme réel.
- `GET /admin/search?q=` retourne `users`, `trips`, `payments`, `tickets`, chacun
  avec `{ items, total }` (maximum 10 résultats par type). Requête de 2 à 160
  caractères ; recherche téléphonique à partir de 3 chiffres. Aucun secret ou
  payload brut de prestataire n'est exposé.
- `POST /admin/bookings/bulk-status` : `{ "ids": ["uuid"], "status": "cancelled" }`.
  Statuts autorisés : `accepted`, `rejected`, `cancelled` ; `reason` facultatif.
- `POST /safety/admin/reports/bulk-status` : `{ "ids": ["uuid"], "status": "resolved" }`.
  Statuts : `under_review`, `resolved`, `dismissed` ; `adminNotes` facultatif.
  Ces deux opérations acceptent 1 à 50 UUID uniques, appliquent les règles métier
  existantes et retournent `{ results, total, succeeded, failed }`. Chaque ligne
  est indépendante : ne pas réexécuter tout le lot en cas de réussite partielle.
- `GET /admin/stores/syncs?limit=100` reste accepté ; 101 est refusé.

Dates : `from` est inclusif. `to=YYYY-MM-DD` inclut toute cette journée UTC ;
un `to` ISO avec fuseau est exclusif. Les listes sans dates gardent tout
l'historique. Les statistiques portent par défaut sur les 30 derniers jours
UTC, jour courant inclus, avec un maximum de 366 jours. La série des trajets
regroupe leur **date de création** et leur **statut actuel** ; ce n'est pas un
journal des événements d'annulation. Les ratios sans population sont `null`.
Les montants de devises différentes ne sont jamais additionnés.

Migration additive et réversible : `AdminAnalyticsIndexes1780000114000`.
Elle ajoute des index de lecture, sans changer les données. Sur de très grosses
tables, préparer les mêmes index avec `CREATE INDEX CONCURRENTLY` hors transaction
avant la migration ; les délais de verrouillage sont bornés. Aucune migration
de production n'est exécutée par les tests.

Les nouvelles routes sont documentées dans Swagger. Leur branchement dans les
pages du dépôt `zwanga-admin` est distinct : les anciennes réponses restent
compatibles, mais le frontend doit appeler ces routes pour abandonner ses calculs
sur échantillon. Les styles de l'admin ne sont pas modifiés.

## Zones opérationnelles et géofencing (observation)

Appliquer `OperationalZones1780000131000` et `ZoneRuntimeSettings1780000132000`
via le processus habituel, puis activer la surveillance dans la page Zones
avec un compte super admin. Aucune variable d'environnement ni redémarrage
n'est nécessaire pour changer ce réglage. Désactivé par défaut, le worker lit
uniquement l'état du module sans traiter de trajet. Les tests ne touchent
ni AWS ni la base applicative. Les nouveaux index sur `trips` et `trip_requests`
sont créés sous transaction avec délai limité : prévoir une fenêtre adaptée
sur les grosses bases. Cette fonctionnalité ne bloque jamais les demandes.

Routes (authentification obligatoire) :

- `GET /admin/zones/status` : activation et présence du schéma.
- `PUT /admin/zones/settings` : `{enabled,version}` (super admin). Réglage partagé
  entre les instances, changement audité et conflit 409 si la version a changé.
  Effet au prochain cycle (5 s environ), sans cache local. Les zones et leur
  historique restent accessibles pendant la pause. Un traitement déjà commencé
  termine avant la désactivation ; aucune nouvelle observation après sa validation.
  L'ancienne variable `GEOFENCING_ENABLED` est ignorée et peut être supprimée.
- `GET /admin/zones`, `/admin/zones/assignments`, `/admin/zones/events` :
  `{items,total,page,limit}`, 20 par défaut, maximum 100.
- `POST /admin/zones` : `name`, `description`, `active`, `priority`, `geometry`.
- `PUT /admin/zones/:id` : mêmes champs et `version` lue, sinon conflit 409.
- `GET /admin/zones/:id/audit` : auteur, version et date ; les snapshots complets
  des contours sont conservés en base. Désactivation plutôt que suppression.

Lecture administrateur, écriture super administrateur. GeoJSON `Polygon` ou
`MultiPolygon` WGS84 `[longitude,latitude]`, au plus 5 000 points et 100 anneaux.
Contours fermés, non vides et valides ; intersections incorrectes refusées.
Zones polaires et traversée de l'antiméridien non prises en charge. Dans
`zwanga-admin`, `/zones` utilise ces données réelles et non des communes fictives
ou un échantillon de 500 trajets. Import GeoJSON (Feature unique acceptée) et
aperçu des contours sans fond cartographique. Importer des limites vérifiées.

Observateur asynchrone toutes les 5 secondes, verrou PostgreSQL entre instances,
lots de 200 trajets et 200 demandes maximum, rotation par dernier contrôle.
Objets actifs ou modifiés dans les dernières 24 h seulement : aucun import
rétroactif de tout l'historique. Consulter `checkedAt` pour la fraîcheur.
Départ et arrivée attribués séparément, frontières incluses. Chevauchements :
priorité décroissante, surface croissante puis UUID. Hors couverture : zone
nulle et trajet toujours autorisé. Les attributions des objets encore suivis
sont recalculées après modification des zones ; les archives restent inchangées.

Les alertes concernent la sortie de **toutes les zones actives**, pas le passage
entre deux zones couvertes. Pour un trajet en cours, elles exigent trois GPS
conducteur distincts sur au moins 20 s, avec précision <= 35 m, âge <= 45 s et
intervalle <= 30 s. Tolérance de frontière : 50 m + précision GPS. Le retour
demande la même confirmation. Aucun GPS antérieur à une modification de zone
n'est reclassé sous les nouvelles limites. État persistant et événements
dédupliqués après redémarrage. Sans GPS fiable, sans zone active ou en panne
Redis, aucune sortie n'est déduite : absence d'alerte ne signifie pas couverture.

Alertes affichées dans l'admin, actualisées toutes les 15 s ; aucun push
automatique. Dispatch, paiement, embarquement et dépose automatiques inchangés.
Le module ne remplace pas la localisation mobile en veille. La capacité pour
1 000 trajets reste à mesurer en staging (retard d'observation, CPU et SQL).

Tests PostGIS sur un cluster temporaire loopback, sans chargement du `.env` :

```powershell
$env:ZONES_TEST_POSTGRES_BIN='C:\Program Files\PostgreSQL\18\bin'
node node_modules/jest/bin/jest.js --runInBand src/zones
```

Sans cette variable, les tests PostGIS sont explicitement ignorés, contrairement
aux tests unitaires. Le cluster temporaire est supprimé après la suite.
