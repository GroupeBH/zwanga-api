# Correctifs issus de l’audit mobile/backend — 6 novembre 2026

Complément aux travaux backend déjà présents, sans déploiement ni modification de production.

## Changements locaux

- `src/users/account-lifecycle.service.ts` libère ensemble `targetDriverId` et son échéance pour une demande encore ouverte, non attribuée et sans trajet lié. `dispatchCheckedAt` est réinitialisé. Les mises à jour restent dans la transaction sous verrou existante ; aucun réseau n’est ajouté à la transaction. Demandes attribuées, annulées et expirées non rouvertes, contrôles de refus/proximité/véhicule conservés.
- Six cas PostgreSQL ajoutés dans `src/users/account-lifecycle-postgres.spec.ts` : visibilité réelle après désactivation, idempotence, rollback, protection des états non ouverts. Suite activée dans `.github/workflows/deploy.yml` via `ACCOUNT_LIFECYCLE_TEST_POSTGRES_BIN`.
- `src/mobile-operations/mobile-analytics.service.ts` conserve un contrat typé identique entre cache et calcul, sans changer les requêtes, le format HTTP ou la durée du cache. `mobile-postgres.spec.ts` vérifie qu’un cache hit ne refait pas de transaction.
- Typage des mocks Google/Gaxios ajusté dans `store-aws-wif.spec.ts`. Tests des petits exports adaptés au contrat buffer/flux dans `admin-users-vehicle-postgres.spec.ts`. Restauration de la liste des migrations du test `admin-analytics-postgres.spec.ts` sans réaffectation d’une propriété en lecture seule.
- `package.json` / `package-lock.json` : overrides des branches modernes vulnérables vers glob 14.0.2 / minimatch 11.0.1. Les anciennes API callback et la version majeure de NestJS restent inchangées. `test/dependency-security.test.cjs` vérifie versions résolues, découverte TypeORM et annulation.
- `src/notifications/ride-mobile-compatibility.spec.ts` remplace une attente instable à 1 ms près par quatre cas déterministes. Ceux-ci ont révélé une divergence entre TTL Android et garde après OAuth. `notifications.service.ts` borne aussi la fenêtre/permis de sonnerie et la garde d’envoi par l’expiration métier des invitations. La récupération des réservations/décisions après sonnerie reste inchangée.

## Vérifications et limites

- Cycle de vie PostgreSQL/PostGIS jetable : **17/17 réussis**.
- Dépendances : **7/7 tests réussis**, dont échanges HTTP/gRPC locaux, création des instrumentations, sharp/bcrypt et YAML Swagger.
- TypeScript incluant les tests : réussi après corrections.
- ESLint strict du service analytics réussi après typage de ses lignes SQL. Restent 67 erreurs dans les trois fichiers de tests vérifiés, contre 120 sur les quatre fichiers Git précédents avec la même configuration. Aucune exclusion de règle ; le lint backend global n’est pas annoncé comme réussi.
- Recette avec les vrais endpoints RTK mobiles, HTTP/Nest et PostgreSQL jetable : **10/10 réussis**, couvrant prix négocié, consentement, concurrence et confidentialité des réservations.
- Tests SQL analytics/exports : **43/43 réussis**. Jest global final : **3 688 réussites, 0 échec, 836 ignorés**, dont 28 cas de compatibilité des alertes et 20 Google/WIF réussis. Les suites SQL ignorées dans la passe globale ne sont pas comptées comme validées ; les exécutions SQL explicites sont séparées.
- Audit npm développement inclus : aucune alerte modérée/élevée/critique, **7 paquets faibles** issus d’un seul [avis deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), sans version corrigée publiée. Consommateurs directs : jest-config et fork-ts-checker-webpack-plugin ; pas de preuve d’inexploitabilité.

Les tests utilisent des données synthétiques, des bases jetables et des connexions externes bloquées. Ils ne prouvent pas la réception FCM/APNs ni l’absence de crash iOS/Android. Les échéances Redis existantes restent applicables au prochain relais après libération du ciblage. Les anciennes demandes déjà bloquées en production ne sont pas réécrites par cette intervention. Aucun workflow AWS déclenché.

Le journal mobile `docs/CHANGEMENTS_TECHNIQUES.md` référence le compte rendu détaillé `docs/CORRECTIFS_AUDIT_GLOBAL_20261106.md` dans le dépôt Zwanga. Les changements préexistants, notamment les correctifs de cinq suites de mocks backend, sont conservés sans être attribués à cette intervention.
