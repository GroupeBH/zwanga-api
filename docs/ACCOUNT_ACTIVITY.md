# Résumé de l'activité personnelle — 22 septembre 2026

## Problème

Le mobile relisait périodiquement plusieurs listes personnelles complètes pour
détecter un trajet, une réservation, un paiement ou une interruption. Le partage
des requêtes RTK ne supprimait pas le coût de production/transfert de ces listes.

## Solution appliquée

Nouveau `GET /api/v1/me/activity`, enregistré par `ActivityModule` dans
`src/app.module.ts` et protégé par `@Auth()`. Le compte vient exclusivement de
`request.user.userId`. Réponse non partageable : `Cache-Control: private, no-store`.

Le contrat de version 1 renvoie `userId`, les catégories `trips`, `bookings` et
`requests` (chacune : `count`, `revision` SHA-256), `hasLiveActivity` et
`passengerTrackingBookingId` (identifiant ou null). Les détails financiers et
itinéraires ne sont pas transportés dans ce résumé.

`src/activity/activity.service.ts` effectue trois projections SQL groupées,
avec colonnes explicites et identité filtrée dans chaque requête. Aucune requête
par élément, hydratation d'historique, notation, géocodage, calcul de tarif ou
communication externe. Les politiques de lecture existantes préservent les
activités inachevées, les changements récents et les paiements initiés.

`activity.model.ts` stabilise les empreintes malgré l'ordre SQL et les doublons
de jointure. Les positions GPS de suivi et leurs horodatages ne changent pas
l'empreinte. Les coordonnées fixes, états de paiement/dépose/interruption et
offres sont surveillés. Le préarmement passager utilise la fenêtre existante
de deux heures avant / douze heures après le départ ; un trajet accepté en
cours est prioritaire. Le franchissement de fenêtre ne nécessite pas de modifier
la réservation en base.

Dans `src/bookings/bookings.service.ts`, `findAllByPassenger(..., true)`
(`scope=activity`) contourne désormais le cache de liste : un résumé frais ne
doit pas être suivi d'une liste Redis ancienne considérée comme à jour. Le
chemin des listes ordinaires/historiques conserve son cache.

## Précautions et limites

- Lecture seule : pas de migration, de nouveaux index, ni de mutation de
  paiement, de suivi GPS, d'embarquement ou de dépose.
- Une erreur d'une des trois lectures échoue le résumé ; elle n'est pas
  remplacée par un état vide qui ferait perdre l'activité connue au mobile.
- Le petit JSON n'implique pas un coût SQL constant : activités inachevées,
  demandes sélectionnées et jointures d'interruption peuvent produire beaucoup
  de lignes. Mesurer avec les volumes réels et `EXPLAIN (ANALYZE, BUFFERS)` dans
  un environnement adapté avant toute optimisation d'index.
- Les anciennes routes restent disponibles pour les anciennes applications et
  pour les lectures détaillées déclenchées par une empreinte modifiée.

## Validation

- TypeScript de compilation : `node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.build.json`.
- Tests : `node node_modules/jest/bin/jest.js --runInBand --watch=false activity.spec.ts activity-read-policy.spec.ts activity-cache.spec.ts`.
- Quatre suites / onze tests réussis : empreintes, préarmement, source du compte,
  SQL TypeORM basé sur les métadonnées réelles, politiques existantes et cache.
  `src/activity/booking-activity.spec.ts` exerce la méthode de lecture avec un
  cache obsolète et vérifie que seul le chemin d'activité le contourne.
- Tests SQL sans connexion PostgreSQL : ni plan d'exécution réel, ni charge de
  production, ni application des résultats à un compte réel n'ont été mesurés.

## Intégration mobile et déploiement

Déployer le backend d'abord. Le nouveau mobile sonde ce résumé toutes les 60 s
au repos et toutes les 30 s en activité, au premier plan et en ligne. Il relit
seulement les catégories modifiées/en échec, en plus des lectures initiales et
contrôles métier conservés. Les notifications/mutations invalident également
le résumé. En cas de 404/405, le mobile conserve ses anciens pollings pour cette
session, afin de supporter un déploiement progressif. Les erreurs temporaires
ne déclenchent pas cette compatibilité.

La description détaillée des fichiers mobiles, des reprises, de la recette native
et des résultats est dans `zwanga/docs/ACCOUNT_ACTIVITY_COORDINATION.md`,
référencée par le journal `zwanga/docs/CHANGEMENTS_TECHNIQUES.md`.
Aucun déploiement n'a été exécuté pendant l'implémentation.
