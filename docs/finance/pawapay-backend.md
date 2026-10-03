# pawaPay v2 : parcours backend Zwanga

Ce module prépare les dépôts Mobile Money, les versements et les remboursements pawaPay pour la RDC. Les clients mobiles peuvent continuer à utiliser leurs parcours actuels ; aucun écran mobile n'est requis pour déployer ce backend. Les mouvements de fonds restent désactivés tant que les indicateurs correspondants ne sont pas activés.

## Préparer la sandbox

1. Exécuter la migration `AddPawapayRefunds1780000045000` avec les autres migrations du backend.
2. Créer un jeton API sandbox pawaPay et configurer `PAWAPAY_API_TOKEN` et `PAWAPAY_API_BASE_URL=https://api.sandbox.pawapay.io` dans les secrets de l'environnement.
3. Configurer dans le dashboard pawaPay les trois URL publiques `POST /api/v1/payments/pawapay/deposits/callback`, `/payouts/callback` et `/refunds/callback` (préfixe à adapter selon `API_PREFIX`). Elles doivent être joignables en HTTPS et répondre avec HTTP 200 après traitement.
4. Générer une paire de clés EC P-256. Déposer **uniquement la clé publique** dans le dashboard pawaPay. Stocker la clé privée PEM encodée en Base64 dans `PAWAPAY_SIGNING_PRIVATE_KEY_BASE64` et son identifiant dans `PAWAPAY_SIGNING_KEY_ID` (SSM SecureString/KMS ou Secrets Manager). Activer `PAWAPAY_REQUIRE_SIGNED_REQUESTS=true` et `PAWAPAY_REQUIRE_SIGNED_CALLBACKS=true` dans la sandbox, puis activer les signatures dans le dashboard après un test de bout en bout.
5. Garder `PAYMENT_PRIMARY_PROVIDER=flexpay`. Activer successivement `PAWAPAY_DEPOSITS_ENABLED=true`, puis `PAWAPAY_PAYOUTS_ENABLED=true` après approvisionnement du portefeuille pawaPay. `PAWAPAY_REFUNDS_ENABLED=true` ouvre uniquement la route super-admin de remboursement.

En production, utiliser `https://api.pawapay.io`, un jeton et une paire de clés distincts. Le code impose les signatures financières et des callbacks en production. Le jeton, les clés et les URL de callback n'existent pas dans le dépôt. Ne pas copier l'URL sandbox de `.env.example` vers la production.

## Endpoints disponibles

Les chemins ci-dessous sont relatifs au préfixe API de Nest (`/api/v1` par défaut).

| Méthode | Chemin | Accès | Usage |
| --- | --- | --- | --- |
| GET | `/payments/providers` | utilisateur authentifié | Provider principal, activations et URL de callbacks |
| GET | `/payments/pawapay/methods` | utilisateur authentifié | Opérateurs RDC configurés, devises, limites et instructions PIN/USSD |
| GET | `/payments/pawapay/availability` | utilisateur authentifié | Disponibilité pawaPay des opérateurs RDC |
| POST | `/payments/pawapay/predict-provider` | utilisateur authentifié | Prévoir l'opérateur ; corps `{ "phone": "+243891234567" }` |
| GET | `/payments/pawapay/wallet-balances` | admin | Soldes des portefeuilles pawaPay |
| POST | `/payments/pawapay/deposits/callback` | pawaPay | Confirmation de dépôt |
| POST | `/payments/pawapay/payouts/callback` | pawaPay | Confirmation de versement |
| POST | `/payments/pawapay/refunds/callback` | pawaPay | Confirmation de remboursement |
| POST | `/payments/pawapay/refunds` | super-admin | Remboursement partiel ou total avec UUIDv4 client, montant et motif |
| GET | `/payments/pawapay/refunds/:refundId` | admin | Détail local du remboursement |
| POST | `/payments/pawapay/refunds/:refundId/check` | admin | Vérification du statut chez pawaPay |
| POST | `/payments/pawapay/refunds/:refundId/retry` | super-admin | Reprise avec le même UUID après deux minutes et un statut `NOT_FOUND` |
| POST | `/payments/pawapay/refunds/:refundId/resend-callback` | admin | Demander le renvoi du callback |
| POST | `/payments/pawapay/refunds/:refundId/fail-enqueued` | super-admin | Demander l'échec d'un remboursement encore `ENQUEUED` |
| GET | `/payments/pawapay/transactions/:paymentId/refunds` | admin | Remboursements liés à un dépôt |
| POST | `/payments/pawapay/transactions/:paymentId/check` | admin | Vérification forcée du dépôt ou versement chez pawaPay |
| POST | `/payments/pawapay/transactions/:paymentId/resend-callback` | admin | Demander le renvoi du callback |
| POST | `/payments/pawapay/transactions/:paymentId/fail-enqueued` | super-admin | Demander l'échec d'un versement `ENQUEUED` |

Les dépôts sont déclenchés par les endpoints existants de réservation, d'abonnement et de recharge de portefeuille ; les versements par les services existants de retrait et de gains. `preferredProvider: "pawapay"` et `pawaPayOperator` sont acceptés par les DTO de dépôt existants. L'opérateur peut être prédit via l'API pawaPay, mais l'appelant peut le préciser et le backend vérifie qu'il est actif pour la devise et le montant.

Le corps d'un remboursement est par exemple :

```json
{
  "refundId": "22222222-2222-4222-8222-222222222222",
  "paymentTransactionId": "55555555-5555-4555-8555-555555555555",
  "amount": 1500,
  "reason": "Remboursement validé par le support",
  "businessReversalReference": "LEDGER-123"
}
```

`refundId` doit rester identique lors d'une reprise. Le backend le persiste avant l'appel pawaPay, limite les remboursements cumulés au dépôt initial et garde un résultat réseau incertain en attente de réconciliation. Pour un paiement ayant déjà modifié une réservation, un abonnement ou le portefeuille Zwanga, l'administrateur doit d'abord faire la régularisation métier et fournir sa référence. Cette référence constitue une trace d'audit ; l'endpoint ne débite pas automatiquement les jetons ou les avantages déjà attribués.

## Suivi et exploitation

Les callbacks sont vérifiés par signature lorsque configurés (toujours en production), puis le backend relit le statut chez pawaPay avant de finaliser le paiement local. Une tâche toutes les minutes revérifie les paiements et remboursements non terminaux ; désactivation possible avec `PAWAPAY_RECONCILIATION_ENABLED=false`. `NOT_FOUND` reste en attente, car il ne prouve pas qu'un POST financier a échoué. Les états terminaux contradictoires exigent un rapprochement manuel et ne sont pas écrasés.

Avant une activation réelle : tester les trois opérateurs RDC avec les [numéros sandbox pawaPay](https://docs.pawapay.io/v2/docs/test_numbers), les callbacks signés, un timeout d'initiation, les échecs, un remboursement partiel et un versement `ENQUEUED`. Surveiller les soldes CDF/USD, les callbacks en erreur et les transactions qui restent en attente.

Documentation officielle : [dépôts](https://docs.pawapay.io/v2/docs/deposits), [versements](https://docs.pawapay.io/v2/docs/payouts), [remboursements](https://docs.pawapay.io/v2/docs/refunds), [signatures](https://docs.pawapay.io/v2/docs/signatures), [configuration active](https://docs.pawapay.io/v2/api-reference/toolkit/active-configuration).
