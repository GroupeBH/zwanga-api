# Synthèse d'audit — backend + application mobile (21 octobre 2026)

## Suivi local — correctifs financiers du 21 octobre

Le constat statique ci-dessous précède les corrections suivantes : intention de retrait de parrainage persistée, reprise durable des commissions trajet, éligibilité du cash confirmé (sans abonnement en jetons), protection des dépôts FlexPay contre les réponses tardives et validation d'un débit réel avant commission sur paiement en jetons. Les migrations 85/86 et leurs limites de retour arrière sont documentées dans [la politique financière](../finance/referral-program.md#21-octobre-2026--cash-confirmé-et-reprises-financières).

Les quatre suites financières précédemment ignorées par le pipeline acceptent désormais ses variables PostgreSQL existantes ; **aucun workflow n'a été modifié**. Neuf suites PostgreSQL isolées passent (214 tests, trois scénarios existants ignorés), sans prestataire réel ni base applicative. Suite générale : 2 521 tests réussis ; 395 ignorés sans activation, dont les intégrations exécutées séparément ci-dessus. Deux tests supplémentaires d'isolation du worker passent également. Compilation TypeScript réussie. Ce suivi ne constitue pas une validation de l'état AWS ni la résolution de tous les autres constats de cet audit.

Audit statique du backend `zwanga-backend` et de l'application mobile `zwanga` (Expo 54). Aucun code modifié. Pas de test exécuté, pas de test de charge, pas d'accès AWS. Les chiffres de charge sont des estimations à mesurer.

## État des audits précédents (10 et 18 oct.)

Corrigés dans le code actuel (non commité / non déployé) : Multer 2.4.0 et Engine.IO 6.6.11, révocation de session HTTP, rotation de refresh conditionnelle, projection publique des avis, reconnexion Redis, timeouts PostgreSQL, circuit breaker ECS.

## Backend — points ouverts

| # | Gravité | Constat |
|---|---|---|
| 1 | Élevé | `TRUSTED_PROXY_CIDRS` absent de tout le Terraform : derrière l'ALB, les requêtes anonymes (login, OTP, inscription) partagent peut-être un seul compteur de limitation. À vérifier dans SSM/ECS. |
| 2 | Élevé | L'API utilise le compte maître RDS (`ssm.tf`, `database.tf`). Différé volontairement. |
| 3 | Élevé | `npm audit` : 13 alertes élevées, 16 modérées, 0 critique. Surtout `pm2`, `firebase` (SDK client), `@grpc/grpc-js`, `js-yaml`, `brace-expansion`. `pm2` et `firebase` sont peut-être inutiles dans l'image. Pas de `npm audit` dans le CI. |
| 4 | Moyen | Swagger (`/api/v1/docs`) public en production. |
| 5 | Moyen | ~40 crons dans chaque processus. Certains protégés (`SKIP LOCKED`, verrous), d'autres seulement par un drapeau mémoire (`financialReconciliationRunning`) ou sans verrou (`retryInterruptionSettlements`). À contrôler avant plusieurs tâches ECS. |
| 6 | Moyen | Crons toutes les 5/30 s (dispatch, outbox, KYC) sur un pool de 10 connexions : risque d'attente pour les requêtes HTTP. Non mesuré. |
| 7 | Moyen | Callback FlexPay public non signé (re-vérifié via `checkTransaction`, correct). Confirmer par test que la reprise fonctionne si la vérification échoue. |
| 8 | Moyen | Profil Terraform par défaut sans redondance : 1 tâche ECS, 1 nœud Valkey, RDS sans Multi-AZ. |
| 9 | Faible | Pas de `helmet` / en-têtes de sécurité. |
| 10 | Faible | Nombreux `logs/combined*.log` locaux à purger ; anciens rapports d'audit à la racine périmés. |
| 11 | Faible | Suites PostgreSQL optionnelles : les ~266 tests ignorés ne valident rien. |

## Mobile ↔ backend — intégrité

- **Contrat de routes** : 206 URLs mobiles comparées à 434 routes backend. Les écarts sont des endpoints jamais utilisés par un écran : `/auth/verify-phone`, `/auth/verify-kyc`, `/safety/trip-security/*` (11 routes, inexistantes côté backend), `/trips/:id/book`, `/trip-requests/:id/offers/:id/reject`. Aucun parcours actif cassé, mais un futur écran `trip-security` recevrait un 404.
- **Versionnement** : seul `x-zwanga-finance-contract: 2` est envoyé. Pas d'en-tête de version/plateforme, d'où les couches de compatibilité (gateway sans ack, doubles routes `/page`).
- **Idempotence** : clés UUID sur retraits et paiements conducteur (solide). Absentes sur réservation, création de trajet, recharge ; le mobile compense par réconciliation après timeout. L'unicité d'une réservation sous double envoi n'est pas vérifiée.
- **Sessions** : refresh à vol unique, cooldown 60 s, version de session côté mobile ; un timeout ou 5xx ne déconnecte pas. Cohérent avec la rotation conditionnelle du backend. Jetons dans SecureStore, aucun jeton dans les logs mobiles.
- **Inscription sans OTP** : `isPhoneVerified: false` à l'inscription, OTP désactivé par défaut côté mobile. Permet de créer un compte avec le numéro d'un tiers (récupérable par réinitialisation de PIN). Choix produit à documenter.
- **Autres** : clé ChottuLink en `EXPO_PUBLIC_*` dans le binaire (à restreindre côté fournisseur) ; objet utilisateur en clair dans AsyncStorage (vérifier le vidage à la déconnexion) ; pas d'épinglage de certificat (choix assumé).

## Performance des interactions

- **Goulot probable : la position GPS.** Conducteur 5 s (WebSocket) ou 8 s (HTTP en arrière-plan), passager 7 s. À chaque position, `evaluateAutomaticRideProgressForTrip` recharge toutes les réservations du trajet avec 3 jointures (`trip`, `trip.driver`, `passenger`) puis enchaîne des vérifications par réservation, sérialisées par trajet.
  - Estimation : ~0,6 évaluation/s pour un trajet à 3 passagers ; ~180/s pour 300 trajets actifs, avec un pool de 10 connexions par tâche.
  - Pistes : seuil de déplacement/intervalle avant réévaluation, projection sans `driver`/`passenger`, positions dans Redis avec écriture périodique en base.
- **Polling mobile** (15 à 60 s, suspendu hors écran) compatible avec les limites par route (suivi à 60/min). Le bruit de fond de lectures pourrait passer en événements WebSocket.
- Timeouts cohérents : mobile 20 s (lecture) / 60 s (mutation), serveur `statement_timeout` 30 s.

## Ordre de traitement recommandé

1. Mesurer puis alléger `evaluateAutomaticRideProgressForTrip`.
2. Vérifier `TRUSTED_PROXY_CIDRS` en production.
3. Commiter les correctifs existants et activer les suites PostgreSQL en CI.
4. Retirer/mettre à jour `pm2` et `firebase` ; ajouter `npm audit` au CI.
5. Protéger Swagger en production.
6. Ajouter `x-app-version` / `x-app-platform` côté mobile ; test de contrat de routes dans le CI ; nettoyer les endpoints orphelins.
7. Vérifier l'unicité des réservations sous double envoi ; décider de l'OTP à l'inscription.
8. Auditer les crons avant montée à plusieurs instances ; séparer le rôle PostgreSQL applicatif ; décider du niveau de redondance AWS.
