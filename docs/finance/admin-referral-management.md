# Administration du parrainage

Identifiant : `FIN-REF-006`  
Date : 26 août 2026  
Statut : implémenté, migration d'index et déploiement requis

## Besoin métier

L'administration web doit pouvoir auditer les comptes parrains, les commissions issues des abonnements et des courses, ainsi que les retraits FlexPay. Les routes `/referrals/me` restent privées et ne doivent jamais être détournées pour produire une vue globale.

## Comportement avant la modification

La page **Finance > Parrainage** appelait quatre contrats absents du backend et recevait un `404`. Les données existaient dans `referral_accounts`, `referral_profiles`, `referral_rewards` et `referral_withdrawals`, mais seuls leurs propriétaires pouvaient consulter leurs propres éléments sous `/referrals/me`.

## Comportement après la modification

- un administrateur consulte les comptes parrains et les quatre compartiments de jetons ;
- il consulte les commissions, leurs sources, leur retenue et leur statut ;
- il consulte les demandes de retrait et leur transaction assainie ;
- il peut relancer une vérification FlexPay sans forcer un statut local ;
- les routes privées utilisateur restent inchangées ;
- les secrets ChottuLink et les réponses brutes FlexPay ne sont jamais exposés.

## Contrats HTTP

Toutes les routes exigent un JWT associé à `UserRole.ADMIN`.

### Comptes parrains

```http
GET /api/v1/admin/referrals/accounts?page=1&limit=25&search=ZWALINE
Authorization: Bearer <jeton-admin>
```

La recherche porte sur l'identifiant utilisateur, le prénom, le nom, le téléphone, l'adresse électronique et le code de parrainage.

```json
{
  "accounts": [],
  "total": 0,
  "page": 1,
  "limit": 25,
  "summary": {
    "accounts": 0,
    "referredUsers": 0,
    "pendingTokens": 0,
    "availableTokens": 0,
    "reservedTokens": 0,
    "withdrawnTokens": 0,
    "pendingWithdrawals": 0,
    "currency": "PTS"
  }
}
```

`directReferralsCount` est calculé en une requête groupée pour tous les parrains de la page. Aucune requête supplémentaire n'est exécutée par ligne.

### Commissions

```http
GET /api/v1/admin/referrals/rewards?page=1&limit=25&status=pending&search=Aline
Authorization: Bearer <jeton-admin>
```

Les statuts acceptés sont `pending`, `available` et `reversed`. Une valeur inconnue produit une réponse `400`.

Les champs financiers sont sérialisés en nombres : `grossAmount`, `rate`, `rewardAmount`, `rewardTokens` et `sourceMoneyPerToken`. Aucun recalcul n'est effectué par cette route.

### Retraits

```http
GET /api/v1/admin/referrals/withdrawals?page=1&limit=25&status=initiated
Authorization: Bearer <jeton-admin>
```

Les statuts acceptés sont `pending`, `initiated`, `succeeded`, `failed` et `cancelled`.

### Rapprochement d'un retrait

```http
POST /api/v1/admin/referrals/withdrawals/7bd.../reconcile
Authorization: Bearer <jeton-admin>
```

Cette route ne permet jamais de choisir le statut final. Elle retrouve l'`orderNumber` interne, appelle `PaymentsService.checkPaymentStatus` par l'intermédiaire du flux existant `ReferralsService.checkWithdrawalStatus`, puis applique la réponse FlexPay dans la transaction idempotente existante.

Un retrait déjà `succeeded` est retourné sans nouvel appel fournisseur. Un retrait sans transaction ou sans `orderNumber` vérifiable produit une réponse `400`.

## Règles financières inchangées

Cette fonctionnalité ne change pas :

- le taux de commission de 5 % ;
- la fenêtre de rémunération de douze mois ;
- la retenue de sept jours ;
- la valeur monétaire historique enregistrée par jeton ;
- le minimum de retrait ;
- les règles KYC ;
- les transitions `pending`, `available`, `reserved` et `withdrawn`.

Les vues admin sont des lectures. Seul le rapprochement peut déclencher une transition déjà autorisée par la réponse FlexPay et le service métier existant.

## Confidentialité

Les réponses n'incluent jamais :

- `ReferralProfile.linkToken` ;
- `ReferralProfile.attributionLinkToken` ;
- `ReferralProfile.attributionReferringLink` ;
- les mots de passe et tokens de session utilisateur ;
- `rawInitiationResponse`, `rawCallbackPayload` ou `rawCheckResponse` de FlexPay.

Le lien public `shareLinkUrl` et le fournisseur d'attribution peuvent être affichés pour l'audit opérationnel.

## Autorisation et limitation

- JWT et `Roles(UserRole.ADMIN)` obligatoires ;
- 30 lectures par minute et par adresse IP ;
- 5 rapprochements par minute ;
- contrôle supplémentaire du rôle administrateur dans le service avant tout appel FlexPay ;
- `limit` borné entre 1 et 200 ;
- termes de recherche tronqués à 160 caractères et transmis comme paramètres SQL.

## PostgreSQL et performance

Les jointures utilisateurs sont regroupées dans les requêtes principales. Le nombre de filleuls est chargé par lot afin d'éviter un schéma N+1.

La migration `1780000024000-AddAdminReferralReadIndexes.ts` ajoute uniquement des index :

- comptes triés par `updatedAt, id` ;
- commissions triées par `createdAt, id` ;
- commissions filtrées par `status` puis triées ;
- retraits triés par `requestedAt, id` ;
- retraits filtrés par `status` puis triés.

Elle ne crée, ne modifie et ne supprime aucun solde ni aucune écriture financière.

Les index sont créés par une migration transactionnelle classique. PostgreSQL peut donc prendre brièvement un verrou sur chaque table pendant leur construction. Exécuter cette migration dans la fenêtre de déploiement prévue et surveiller la durée sur une copie représentative de la production avant application.

La pagination reste basée sur `page/limit` pour respecter le contrat actuel de l'interface. Si le registre atteint un volume rendant les pages profondes coûteuses, une évolution vers un curseur composé de la date et de l'UUID sera nécessaire.

## Fichiers modifiés

### Backend

- `src/admin/admin-referrals.service.ts`
- `src/admin/admin-referrals.service.spec.ts`
- `src/admin/admin.controller.ts`
- `src/admin/admin.module.ts`
- `src/database/migrations/1780000024000-AddAdminReferralReadIndexes.ts`
- `src/database/migrations/index.ts`

### Administration web

- `app/(admin)/referrals/page.tsx` : message de compatibilité du backend ;
- `docs/admin-finance-api-contract.md` : état réel du contrat.

## Variables d'environnement et infrastructure

Aucune nouvelle variable d'environnement, permission IAM, ressource AWS ou entrée Parameter Store n'est requise. Le rapprochement utilise la configuration FlexPay déjà nécessaire aux retraits de parrainage.

## Tests

- agrégats globaux et conversion des nombres PostgreSQL ;
- comptage groupé des filleuls directs ;
- suppression des tokens ChottuLink ;
- suppression des champs utilisateur sensibles ;
- filtre et validation des statuts ;
- rapprochement par le flux FlexPay existant ;
- suppression des réponses FlexPay brutes ;
- interdiction du rapprochement à un non-administrateur ;
- tests existants du service de parrainage ;
- compilation TypeScript et build du backend.

## Déploiement

1. Sauvegarder PostgreSQL et relever les agrégats des quatre compartiments de parrainage.
2. Déployer le backend contenant les routes et la migration.
3. Exécuter les migrations jusqu'à `1780000024000` dans la tâche dédiée.
4. Déployer `zwanga-admin`.
5. Tester les trois vues avec un compte administrateur.
6. Vérifier qu'un compte non-admin reçoit `403`.
7. Rapprocher un retrait `initiated` de test et confirmer que son résultat correspond au statut FlexPay.

## Surveillance et rapprochement

Après déploiement, surveiller les erreurs `400`, `403`, `404`, `429` et les erreurs fournisseur sur la route de rapprochement. Comparer les synthèses admin aux tables sources :

```sql
SELECT
  count(*) AS accounts,
  coalesce(sum("pendingTokens"), 0) AS pending,
  coalesce(sum("availableTokens"), 0) AS available,
  coalesce(sum("reservedTokens"), 0) AS reserved,
  coalesce(sum("withdrawnTokens"), 0) AS withdrawn
FROM referral_accounts;
```

Les valeurs doivent correspondre aux métriques de l'administration. Une divergence ne doit jamais être corrigée par une modification directe des comptes ou du registre.

## Retour arrière

Les routes peuvent être retirées en redéployant la version précédente du backend. Les index de lecture peuvent être supprimés avec la méthode `down` de la migration sans perte de données. Un rapprochement déjà confirmé reste une opération financière réelle et ne doit pas être annulé par un rollback de code.
