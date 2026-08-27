# Administration des portefeuilles de jetons

Identifiant : `FIN-WALLET-ADMIN-001`  
Date : 26 août 2026  
Statut : implémenté, migration et déploiement requis

## Besoin métier

La page **Finance > Jetons** de `zwanga-admin` doit permettre à un administrateur de consulter les soldes et le registre global. Un ajustement manuel exceptionnel doit être possible sans modifier directement la base et sans compromettre le caractère append-only du registre.

## Comportement avant la modification

L'interface appelait trois contrats inexistants. Les deux lectures recevaient un `404`, affichaient zéro jeton et présentaient le message « routes d'administration non déployées ». L'action d'ajustement ne pouvait pas aboutir.

## Comportement après la modification

- `GET /admin/wallets` renvoie les comptes paginés et une synthèse globale.
- `GET /admin/wallets/ledger` renvoie les écritures paginées, filtrables par type.
- `POST /admin/wallets/:userId/adjustments` applique un crédit ou un débit exceptionnel, audité et idempotent.
- Seuls les utilisateurs ayant le rôle `admin` peuvent accéder à ces routes.
- Les champs secrets de l'utilisateur et les payloads FlexPay ne sont jamais renvoyés.

## Contrats HTTP

### Liste des comptes

```http
GET /api/v1/admin/wallets?page=1&limit=25&search=Aline
Authorization: Bearer <jeton-admin>
```

La recherche porte sur l'identifiant utilisateur, le prénom, le nom, le téléphone et l'adresse électronique. `limit` est borné à 200.

```json
{
  "accounts": [],
  "total": 0,
  "page": 1,
  "limit": 25,
  "summary": {
    "accounts": 0,
    "totalBalance": 0,
    "positiveBalances": 0,
    "negativeBalances": 0,
    "currency": "PTS"
  }
}
```

La synthèse est calculée sur tous les portefeuilles, indépendamment de la page et de la recherche affichées.

### Registre

```http
GET /api/v1/admin/wallets/ledger?page=1&limit=25&type=top_up&search=Aline
Authorization: Bearer <jeton-admin>
```

Le filtre `type` doit appartenir à l'énumération `WalletLedgerEntryType`. Une valeur inconnue produit une réponse `400`.

### Ajustement manuel

```http
POST /api/v1/admin/wallets/7bd.../adjustments
Authorization: Bearer <jeton-admin>
Content-Type: application/json

{
  "requestId": "123e4567-e89b-12d3-a456-426614174000",
  "amount": 25,
  "reason": "Régularisation validée sous le ticket SUP-1042"
}
```

`amount` est signé : une valeur positive crédite, une valeur négative débite. Le montant ne peut pas être nul, comporte au maximum deux décimales et reste compris entre `-1 000 000` et `1 000 000` jetons. Le motif contient entre 10 et 500 caractères.

## Écriture comptable

Un ajustement crée une ligne :

- `type = admin_adjustment` ;
- `relatedEntityType = admin_wallet_adjustment` ;
- `relatedEntityId = requestId` ;
- `description = Ajustement par admin <adminId>: <motif>` ;
- `amount` contient le mouvement signé ;
- `balanceAfter` contient le nouveau solde exact.

Le solde est calculé avec la formule :

```text
nouveauSolde = arrondi2(soldeVerrouillé + montantSigné)
```

Un résultat négatif est interdit. Aucun argent FlexPay n'est encaissé ou décaissé par cet endpoint et aucune conversion CDF/jeton n'est effectuée.

## Atomicité, concurrence et idempotence

Le backend verrouille la ligne `wallet_accounts` avec `pessimistic_write`. La modification du solde et la création de l'écriture sont exécutées dans la même transaction PostgreSQL : elles réussissent ensemble ou sont annulées ensemble.

L'interface génère un UUID `requestId` une seule fois à l'ouverture du formulaire. Le backend conserve cet UUID dans le registre. L'index partiel unique `UQ_wallet_ledger_admin_adjustment_request` empêche une répétition de produire une deuxième écriture. Une répétition avec le même UUID renvoie le solde courant sans nouvelle modification ; l'utilisation du même UUID pour un autre utilisateur est rejetée.

## Autorisation et confidentialité

- JWT obligatoire avec `UserRole.ADMIN`.
- Limite de 30 lectures par minute et 5 ajustements par minute.
- Le rôle est contrôlé par le guard et de nouveau par le service financier avant écriture.
- Le mot de passe, les tokens d'accès, le token FCM et les identifiants sociaux ne sont pas sérialisés.
- Le journal applicatif contient les identifiants d'audit et les montants, jamais un secret d'authentification.

## Schéma et migration

La migration `1780000023000-AddAdminWalletAdjustments.ts` :

1. autorise `admin_adjustment` dans `CHK_wallet_ledger_type` ;
2. crée l'index d'idempotence partiel ;
3. refuse le retour arrière si une écriture `admin_adjustment` existe déjà.

Elle ne modifie aucun solde et ne crée aucune écriture historique.

## Fichiers modifiés

### Backend

- `src/admin/admin.controller.ts`
- `src/admin/admin.service.ts`
- `src/admin/admin.module.ts`
- `src/admin/dto/admin-wallet.dto.ts`
- `src/wallet/wallet.service.ts`
- `src/wallet/entities/wallet-ledger-entry.entity.ts`
- `src/database/migrations/1780000023000-AddAdminWalletAdjustments.ts`
- `src/database/migrations/index.ts`

### Administration web

- `lib/features/finance/types.ts`
- `lib/features/finance/financeApi.ts`
- `app/(admin)/tokens/page.tsx`

## Variables d'environnement et infrastructure

Aucune nouvelle variable d'environnement, ressource AWS, permission IAM ou entrée Parameter Store n'est requise.

## Tests réalisés

- sérialisation numérique des soldes et agrégats ;
- suppression des informations sensibles de l'utilisateur ;
- pagination, recherche et filtre du registre ;
- rejet d'un type d'écriture inconnu ;
- crédit atomique avec écriture `admin_adjustment` ;
- répétition idempotente du même `requestId` ;
- compilation TypeScript du backend et de `zwanga-admin`.

## Déploiement

1. Sauvegarder PostgreSQL et relever le nombre d'écritures et la somme des soldes.
2. Déployer le backend contenant la migration.
3. Exécuter `npm run migration:run:prod` dans la tâche de migration prévue par l'infrastructure.
4. Déployer `zwanga-admin`.
5. Vérifier les deux lectures avec un compte admin.
6. Effectuer un crédit de test minimal avec un motif traçable, puis répéter exactement la même requête et confirmer qu'une seule écriture existe.

## Rapprochement après déploiement

Comparer chaque solde au dernier `balanceAfter`, puis contrôler les doublons :

```sql
SELECT "accountId", COUNT(*)
FROM wallet_ledger_entries
WHERE type = 'admin_adjustment'
GROUP BY "accountId", "relatedEntityId"
HAVING COUNT(*) > 1;
```

Le résultat attendu est vide. Toute divergence doit être investiguée ; elle ne doit jamais être corrigée par un `UPDATE` direct du registre.

## Retour arrière

Le code peut être redéployé sans exposer les routes. La migration ne peut être annulée automatiquement qu'avant le premier ajustement. Après une écriture réelle, conserver le schéma et désactiver l'endpoint est la stratégie sûre ; supprimer le type rendrait le registre historique invalide.

## Limites

Cette fonctionnalité administre uniquement le portefeuille d'usage en jetons. Elle ne modifie pas les gains de parrainage, les revenus conducteurs, les paiements FlexPay ou les soldes retirables.
