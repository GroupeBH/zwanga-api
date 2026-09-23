# FIN-WALLET-001 — Jetons Zwanga et bonus d'abonnement

Date : 20 août 2026  
Statut : implémenté dans le code ; migration à appliquer  
Périmètre : portefeuille, registre comptable, paiements d'abonnement et application mobile

## 1. Besoin métier

L'unité auparavant présentée aux utilisateurs sous le nom de « points Zwanga » prend le nom de « jetons Zwanga ». Lorsqu'un utilisateur paie un abonnement Pro, son portefeuille reçoit 25 jetons.

Le changement doit préserver les soldes existants, les anciennes applications, l'historique comptable et l'idempotence des callbacks de paiement.

## 2. Terminologie et compatibilité

### 2.1 Nom visible

Tous les nouveaux libellés, messages, erreurs, descriptions d'écriture et écrans utilisent « jeton » ou « jetons Zwanga ».

### 2.2 Identifiants techniques conservés

Les valeurs suivantes restent volontairement inchangées :

- type de compte : `points` et `WalletAccountType.POINTS` ;
- mode de paiement : `points` et `TripPaymentMode.POINTS` ;
- devise interne historique : `PTS` ;
- champs compatibles : `pointsAmount` et `pointsCurrency` ;
- route compatible : `POST /api/v1/subscriptions/subscribe/points` ;
- variables existantes préfixées par `ZWANGA_POINTS_`.

De nouveaux champs de lecture sont ajoutés aux plans : `tokensAmount`, `tokensCurrency` et `subscriptionRewardTokens`. Les anciens champs restent disponibles pour les clients déjà publiés.

Il s'agit donc d'un changement de dénomination utilisateur, pas d'une conversion de solde ni de la création d'une seconde monnaie interne.

## 3. Règle du bonus d'abonnement

```text
bonusAbonnement = 25 jetons
nouveauSolde = ancienSolde + 25
```

Le bonus est accordé lorsque toutes les conditions suivantes sont satisfaites :

1. l'abonnement est payant (`isTrial = false`) ;
2. le paiement FlexPay possède l'état `succeeded`, ou le débit du portefeuille en jetons a réussi ;
3. l'abonnement est activé ;
4. aucune écriture `subscription_reward` n'existe déjà pour cet utilisateur et cet abonnement.

Le bonus n'est pas accordé pour :

- un essai gratuit ;
- un paiement `pending` ou `initiated` ;
- un paiement échoué ou annulé ;
- un simple affichage d'un abonnement actif ;
- une seconde réception du même callback.

## 4. Paiement avec des jetons

Un abonnement payé avec le portefeuille reçoit aussi le bonus, car il s'agit bien d'un abonnement payé. Le mouvement net vaut :

```text
mouvementNet = -prixAbonnementEnJetons + 25
```

Exemple avec un prix de 50 jetons :

```text
débit abonnement = -50
bonus abonnement = +25
mouvement net = -25 jetons
```

Deux écritures distinctes sont conservées. Le bonus ne réduit pas ou ne modifie pas rétroactivement le prix de l'abonnement.

## 5. Registre comptable

Nouvelle valeur :

| Champ | Valeur |
| --- | --- |
| `type` | `subscription_reward` |
| `accountType` | `points` (identifiant technique historique) |
| `amount` | `25.00` |
| `relatedEntityType` | `subscription` |
| `relatedEntityId` | identifiant UUID de l'abonnement |
| `paymentTransactionId` | transaction FlexPay confirmée, ou `null` pour un paiement en jetons |
| `currency` | devise interne du compte, normalement `PTS` |
| `description` | `Bonus de 25 jetons pour l abonnement ...` |

L'index partiel unique `UQ_wallet_ledger_subscription_reward` interdit deux bonus pour la même combinaison utilisateur, type et abonnement.

Le solde et l'écriture sont enregistrés dans une transaction avec verrou pessimiste sur le compte. En cas de concurrence, la transaction perdante est annulée ; le service relit ensuite l'écriture gagnante.

## 6. Valeur financière

La configuration actuelle conserve la valeur historique par défaut :

```text
1 jeton = 100 CDF
25 jetons = 2 500 CDF de valeur d'usage configurée
```

Le changement ne modifie ni `ZWANGA_POINT_VALUE_CDF`, ni les taux de fidélité, ni le prix des courses, ni le prix de l'abonnement.

Les jetons promotionnels restent une unité interne utilisable selon les fonctionnalités actuelles et ne deviennent pas retirables. `FIN-REF-001` implémente un compte séparé pour les gains de parrainage retirables ; le bonus de 25 jetons n'y est jamais versé.

## 7. Callbacks, idempotence et concurrence

- un callback FlexPay répété appelle le crédit, mais retrouve l'écriture existante ;
- une vérification manuelle du statut et un callback simultanés sont protégés par l'index unique ;
- le statut `succeeded` est obligatoire avant le crédit FlexPay ;
- un callback répété ne prolonge plus une seconde fois la date de fin du même abonnement déjà activé ;
- aucun appel du client ne peut choisir le montant du bonus.

## 8. Annulation et remboursement

Il n'existe actuellement aucun flux automatisé de remboursement d'un abonnement déjà confirmé. Le bonus n'est donc pas repris automatiquement après activation. Si un remboursement d'abonnement est ajouté, il devra créer une écriture compensatoire ; il ne devra jamais supprimer l'écriture d'origine.

## 9. Migration

Migration : `1780000016000-AddSubscriptionTokenRewards.ts`.

Elle :

1. autorise `subscription_reward` dans `CHK_wallet_ledger_type` ;
2. crée l'index unique partiel ;
3. ne modifie aucun solde existant ;
4. ne renomme aucune ancienne ligne.

La méthode `down` refuse explicitement le retour arrière si des bonus existent, afin d'éviter la suppression ou l'invalidation silencieuse d'écritures financières. Un rapprochement et des écritures compensatoires sont alors requis avant le rollback.

## 10. Historique existant

Les descriptions historiques contenant « points » ne sont pas réécrites en base, car une écriture financière historique ne doit pas être altérée. L'application les présente sous le nom « jetons » au moment de l'affichage.

Aucun bonus rétroactif en masse n'est créé par la migration.

## 11. Déploiement

Ordre recommandé :

1. sauvegarder et rapprocher `wallet_accounts` avec `wallet_ledger_entries` ;
2. appliquer la migration ;
3. déployer le backend ;
4. déployer l'application mobile ;
5. confirmer un abonnement FlexPay en environnement de test ;
6. vérifier une seule écriture `subscription_reward` de `25.00` et le solde final ;
7. rejouer le callback et confirmer l'absence de second crédit.

## 12. Fichiers principaux

- `src/wallet/entities/wallet-ledger-entry.entity.ts` ;
- `src/wallet/wallet.service.ts` ;
- `src/subscriptions/subscriptions.service.ts` ;
- `src/database/migrations/1780000016000-AddSubscriptionTokenRewards.ts` ;
- `app/wallet.tsx` ;
- `app/subscriptions/payment.tsx`.

## 13. Tests

- crédit exact de 25 jetons ;
- aucun crédit en statut non confirmé ;
- crédit après confirmation FlexPay ;
- crédit après paiement en jetons ;
- second appel sans second mouvement ;
- build backend, tests complets, TypeScript mobile et lint ciblé.
