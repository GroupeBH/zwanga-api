# Règlement atomique des courses payées en jetons

Identifiant : `FIN-BOOKING-002`

Statut : implémenté dans le backend et l'application mobile ; migration et déploiement de production requis.

Dernière mise à jour : 26 août 2026.

## 1. Besoin métier

Lorsqu'un passager paie une course en jetons après son arrivée, Zwanga doit garantir les trois résultats suivants comme une seule opération comptable :

1. le portefeuille du passager est débité du nombre exact de jetons ;
2. la réservation est marquée payée avec le montant et la devise de référence ;
3. la créance nette du conducteur est créée en CDF.

Un échec technique ne doit jamais laisser uniquement le débit passager. Les répétitions provenant de REST, Socket.IO, d'un double toucher, d'une reconnexion ou du réconciliateur ne doivent jamais produire un second débit ou un second revenu conducteur.

## 2. Constat de l'incident du 26 août 2026

Les journaux de production disponibles montrent, pour le test signalé :

- un prix de course de `8 000 CDF` ;
- un débit de `80 jetons`, avec `1 jeton = 100 CDF` ;
- un solde serveur restant de `138,82 jetons` après le débit ;
- un revenu conducteur brut de `8 000 CDF` ;
- une commission Zwanga de `400 CDF`, soit 5 % ;
- un revenu conducteur net enregistré de `7 600 CDF`.

Le serveur n'a donc pas supprimé tout le portefeuille et a bien créé le revenu conducteur pour ce test. Deux défauts réels ont néanmoins été identifiés :

- l'application n'invalidait pas explicitement tous les caches financiers après le paiement ;
- le conducteur ne disposait d'aucun écran accessible présentant son compte de règlement CDF, distinct du portefeuille de jetons du passager.

L'audit du code a aussi révélé une faiblesse structurelle plus grave : le débit, le statut payé et le revenu conducteur étaient auparavant enregistrés dans des transactions de base séparées. Un incident entre ces étapes aurait pu produire le symptôme signalé. `FIN-BOOKING-002` supprime cette fenêtre de panne.

## 3. Distinction des comptes

### Portefeuille du passager

`wallet_accounts.balance` contient des jetons Zwanga. Pour la configuration actuelle :

```text
jetonsDébités = arrondi(prixCDF ÷ 100, 2)
```

Exemple :

```text
8 000 CDF ÷ 100 CDF/jeton = 80 jetons
```

### Compte de règlement du conducteur

Le conducteur ne reçoit pas les jetons du passager. Il reçoit une créance monétaire dans `driver_earnings`, affichée en CDF :

```text
commission = arrondi(prixBrut × tauxCommission, 2)
revenuNet = arrondi(prixBrut - commission, 2)
```

Avec un prix de `8 000 CDF` et un taux de 5 % :

```text
commission = 400 CDF
revenuNet = 7 600 CDF
```

Le portefeuille « Jetons » et l'écran « Revenus conducteur » représentent donc deux comptes et deux unités différentes.

## 4. Comportement avant et après

### Avant

1. `WalletService.payForBooking` ouvrait et validait une transaction limitée au portefeuille.
2. `BookingsService` enregistrait ensuite `paymentStatus = succeeded` dans une autre écriture.
3. `DriverSettlementsService` créait ensuite le revenu conducteur dans une troisième écriture.
4. Une erreur entre les étapes pouvait laisser un état partiel.
5. La vérification d'idempotence précédait le verrou du portefeuille, ce qui élargissait la fenêtre de concurrence.
6. L'app ne rafraîchissait pas systématiquement les caches `Wallet` et `DriverSettlement`.
7. Aucun écran mobile ne rendait le revenu conducteur visible.

### Après

Une seule transaction PostgreSQL exécute les opérations suivantes :

1. verrou pessimiste sur la réservation ;
2. relecture du trajet et recalcul serveur du prix ;
3. verrou pessimiste sur le portefeuille du passager ;
4. relecture du registre comptable après le verrou ;
5. contrôle du solde et débit exact ;
6. création de l'écriture immuable `booking_payment` ;
7. mise à jour de la réservation vers `succeeded` ;
8. création du revenu conducteur net ;
9. validation unique de la transaction.

Si une étape échoue, PostgreSQL annule les huit écritures précédentes. Aucune validation applicative intermédiaire n'est considérée comme un paiement réussi.

## 5. Invariants financiers

1. Une course en jetons n'est débitée qu'après la dépose ou le passage de la réservation à `completed`.
2. Le montant est recalculé sur le serveur à partir du trajet, du nombre de places et d'un éventuel ajustement kilométrique persisté.
3. Le client mobile ne choisit jamais librement le nombre de jetons à débiter.
4. Le solde d'un portefeuille ne peut jamais être négatif.
5. Une réservation ne peut posséder qu'une écriture `booking_payment` par passager.
6. Une réservation ne peut produire qu'un revenu conducteur.
7. Le débit passager, le statut payé et le revenu conducteur sont validés ou annulés ensemble.
8. Une répétition avec le même prix renvoie l'écriture existante sans modifier le solde.
9. Une répétition avec un montant différent est refusée comme incohérence financière et n'effectue aucun mouvement.
10. Le brut conducteur est strictement positif.
11. Le taux de commission est compris entre 0 inclus et 1 exclu.
12. `brut = commission + net` doit rester vrai au centime près.
13. Une réparation automatique ne crée jamais un nouveau débit passager.
14. Les avantages secondaires — fidélité et parrainage — ne peuvent plus empêcher la création préalable du revenu conducteur.
15. La présence d'une écriture `booking_refund` interdit toute nouvelle capture de la même réservation.

## 6. Idempotence et concurrence REST/Socket.IO

Le verrou de réservation sérialise tous les déclencheurs qui tentent de régler la même course. Le verrou du portefeuille sérialise les dépenses concurrentes d'un même utilisateur sur plusieurs services.

Les contraintes existantes restent la dernière ligne de défense :

- `UQ_wallet_ledger_booking_type` interdit deux écritures du même type pour une réservation ;
- `UQ_driver_earnings_booking` interdit deux revenus pour une réservation ;
- `UQ_wallet_accounts_user_type` interdit deux portefeuilles de jetons pour un utilisateur.

Cette combinaison couvre notamment :

- double toucher sur le bouton de paiement ;
- requête REST répétée après délai réseau ;
- événement Socket.IO et requête REST simultanés ;
- reprise de l'application après passage hors ligne ;
- exécution concurrente du réconciliateur sur plusieurs tâches ECS.

## 7. Contraintes ajoutées par la migration

Migration : `1780000021000-HardenTokenTripSettlements.ts`.

| Table | Contrainte | Garantie |
| --- | --- | --- |
| `wallet_accounts` | `CHK_wallet_accounts_balance_non_negative` | `balance >= 0` |
| `wallet_ledger_entries` | `CHK_wallet_ledger_balance_after_non_negative` | `balanceAfter >= 0` |
| `driver_earnings` | `CHK_driver_earnings_gross_positive` | brut strictement positif |
| `driver_earnings` | `CHK_driver_earnings_commission_rate_range` | taux valide |
| `driver_earnings` | `CHK_driver_earnings_amounts_non_negative` | commission et net non négatifs |
| `driver_earnings` | `CHK_driver_earnings_amount_conservation` | conservation du montant |

L'index `IDX_wallet_ledger_entries_account_created` accélère la lecture de la dernière écriture de chaque portefeuille utilisée par le contrôle de rapprochement.

Les contraintes sont ajoutées avec `NOT VALID`, puis validées explicitement dans la même migration. Cela réduit le verrou initial tout en empêchant la mise en production si l'historique viole un invariant.

La méthode `down` retire uniquement ces contraintes. Elle ne supprime ni écriture comptable, ni solde, ni revenu.

## 8. Réconciliation automatique

Toutes les cinq minutes, `BookingsService.reconcileTokenTripSettlements` recherche au maximum 50 réservations qui possèdent déjà une preuve de débit `booking_payment`, mais dont le statut payé ou le revenu conducteur manque.

La réparation :

- reprend exactement le même flux transactionnel ;
- réutilise l'écriture existante sans second débit ;
- complète le statut `succeeded` et le revenu conducteur ;
- ignore les réservations remboursées ;
- reste sûre si plusieurs instances ECS l'exécutent simultanément.

Une réservation déclarée payée sans écriture de débit est seulement comptée et journalisée avec :

```text
FINANCIAL_INVARIANT_VIOLATION pointsBookingsSucceededWithoutDebit=<nombre>
```

Le système n'effectue aucun débit rétroactif dans ce cas. Une revue humaine est obligatoire.

Le même contrôle compare le solde courant de chaque portefeuille au `balanceAfter` de sa dernière écriture. Une différence produit `walletBalanceLedgerMismatches=<nombre>` et n'est jamais corrigée automatiquement : réécrire un solde sans rapprochement humain pourrait aggraver l'incident.

Les réparations et erreurs utilisent les événements :

```text
TOKEN_BOOKING_DEBIT_COMMITTED
DRIVER_EARNING_COMMITTED
TOKEN_TRIP_SETTLEMENT_COMMITTED
TOKEN_SETTLEMENT_RECONCILIATION
TOKEN_SETTLEMENT_RECONCILIATION_FAILED
FINANCIAL_INVARIANT_VIOLATION
```

## 9. Application mobile

Les changements mobiles sont les suivants :

- `updateBookingPaymentMode` invalide désormais les caches `Booking`, `Wallet` et `DriverSettlement` ;
- le modal de paiement continue de relire le portefeuille après le règlement ;
- un nouvel écran `driver-earnings` affiche le montant disponible, les retraits en cours, les montants déjà versés et chaque course créditée ;
- l'écran se rafraîchit au focus, à la reconnexion, toutes les 30 secondes et par glissement manuel ;
- le profil conducteur expose une action « Revenus » avec le montant disponible en CDF.

Cette interface évite d'interpréter l'absence de jetons dans le portefeuille conducteur comme une absence de paiement : le règlement conducteur est monétaire et se trouve dans son espace dédié.

## 10. API et compatibilité

Aucun endpoint public ni champ de réponse existant n'est supprimé.

Endpoints utilisés par l'application :

| Méthode | Route | Rôle |
| --- | --- | --- |
| `PUT` | `/api/v1/bookings/:id/payment-mode` | sélectionner les jetons et déclencher le règlement après arrivée |
| `GET` | `/api/v1/wallet/me` | solde passager en jetons |
| `GET` | `/api/v1/wallet/ledger` | journal du portefeuille |
| `GET` | `/api/v1/driver-settlements/me` | synthèse monétaire conducteur |
| `GET` | `/api/v1/driver-settlements/earnings` | courses créditées |

Les identifiants techniques `points` et `PTS` sont conservés pour compatibilité avec les anciennes versions de l'application.

## 11. Variables d'environnement

Aucune nouvelle variable n'est ajoutée par `FIN-BOOKING-002`.

Les valeurs existantes doivent être vérifiées avant le déploiement :

| Variable | Rôle | Valeur attendue actuellement |
| --- | --- | --- |
| `ZWANGA_POINT_VALUE_CDF` | valeur d'usage d'un jeton | `100` |
| `ZWANGA_POINTS_CURRENCY` | unité technique du portefeuille | `PTS` |
| `TRIP_PAYMENT_CURRENCY` | devise des courses | `CDF` |
| `ZWANGA_COMMISSION_RATE` | commission plateforme | `0.05` |

## 12. Remboursements

Le flux de remboursement existant n'est pas modifié. Une course remboursée conserve l'écriture originale `booking_payment` et ajoute une écriture `booking_refund` positive. Le réconciliateur exclut explicitement ces réservations afin de ne pas les marquer payées à nouveau.

L'annulation ou l'inversion d'un revenu conducteur doit continuer à utiliser un état ou une écriture compensatrice ; une ligne financière historique ne doit jamais être supprimée.

## 13. Tests réalisés

Les tests couvrent :

- solde insuffisant sans écriture ;
- débit et registre dans la même transaction ;
- répétition sans second débit ;
- prix ajusté par distance ;
- échec de création du revenu conducteur faisant échouer la transaction complète ;
- réparation d'un débit prouvé ;
- anomalie sans registre détectée mais non débitée ;
- calcul de la commission conducteur à 5 % ;
- compilation TypeScript du backend et de l'application.

Commande backend :

```bash
npm test -- --runInBand wallet/wallet.service.spec.ts bookings/bookings.service.spec.ts driver-settlements/driver-settlements.service.spec.ts
npm run build
```

Commande application :

```bash
npx tsc --noEmit
```

## 14. Déploiement et rapprochement

### Avant migration

Effectuer une sauvegarde de la base, puis exécuter les contrôles agrégés suivants :

```sql
SELECT COUNT(*) AS negative_wallets
FROM wallet_accounts
WHERE balance < 0;

SELECT COUNT(*) AS negative_ledger_balances
FROM wallet_ledger_entries
WHERE "balanceAfter" < 0;

SELECT COUNT(*) AS invalid_driver_earnings
FROM driver_earnings
WHERE "grossAmount" <= 0
   OR "commissionRate" < 0
   OR "commissionRate" >= 1
   OR "commissionAmount" < 0
   OR "netAmount" < 0
   OR "grossAmount" <> "commissionAmount" + "netAmount";
```

Les trois résultats doivent valoir zéro. Si ce n'est pas le cas, ne pas modifier les soldes à l'aveugle : exporter les identifiants concernés dans un canal sécurisé, rapprocher les paiements et créer une correction compensatrice auditée.

### Ordre de livraison

1. sauvegarder PostgreSQL ;
2. exécuter les requêtes de précontrôle ;
3. construire l'image backend contenant la migration ;
4. appliquer `1780000021000` ;
5. déployer le backend ;
6. vérifier `/api/v1/health` ;
7. surveiller les six événements financiers pendant au moins 30 minutes ;
8. tester une course de faible montant avec un compte de test ;
9. comparer le débit du registre, le solde final, le statut de réservation et le revenu conducteur ;
10. publier ensuite la version mobile avec l'écran de revenus.

### Rapprochement post-déploiement

Pour chaque course de test :

```text
soldeAvant - soldeAprès = prixCDF ÷ valeurJetonCDF
abs(écriture booking_payment) = soldeAvant - soldeAprès
revenuBrut = prixCDF
revenuBrut = commission + revenuNet
paymentStatus = succeeded
```

Vérifier aussi qu'un second appel de la même route ne change aucun des quatre montants.

## 15. Retour arrière

Un retour arrière du code réintroduirait la fenêtre de panne et n'est donc recommandé qu'en cas d'indisponibilité majeure. Si nécessaire :

1. arrêter les nouvelles captures en jetons au niveau applicatif ;
2. laisser finir les transactions en cours ;
3. sauvegarder et rapprocher les écritures créées depuis le déploiement ;
4. déployer la version précédente ;
5. ne retirer les contraintes avec `migration:revert` que si elles bloquent réellement l'ancienne version ;
6. conserver toutes les écritures financières ;
7. ouvrir une revue manuelle pour chaque `FINANCIAL_INVARIANT_VIOLATION`.

La migration inverse ne rembourse rien automatiquement et ne doit jamais être utilisée comme mécanisme de correction de solde.

## 16. Fichiers modifiés

Backend :

- `src/bookings/bookings.service.ts` ;
- `src/bookings/bookings.service.spec.ts` ;
- `src/wallet/wallet.service.ts` ;
- `src/wallet/wallet.service.spec.ts` ;
- `src/wallet/entities/wallet-account.entity.ts` ;
- `src/wallet/entities/wallet-ledger-entry.entity.ts` ;
- `src/driver-settlements/driver-settlements.service.ts` ;
- `src/driver-settlements/entities/driver-earning.entity.ts` ;
- `src/database/migrations/1780000021000-HardenTokenTripSettlements.ts` ;
- `src/database/migrations/index.ts`.

Application :

- `store/api/bookingApi.ts` ;
- `app/driver-earnings.tsx` ;
- `app/(tabs)/profile.tsx` ;
- `app/_layout.tsx`.

## 17. Limites explicites

Une « fiabilité totale » ne peut pas signifier qu'un téléphone hors ligne affichera immédiatement le nouveau solde. La garantie forte porte sur la base : aucune transaction validée ne peut contenir seulement le débit sans le statut payé et le revenu conducteur. L'application relit ensuite cette source fiable au focus, à la reconnexion et périodiquement.

Le rapprochement avec un fournisseur externe, les remboursements FlexPay après succès et les alertes CloudWatch automatiques restent des flux distincts. Les motifs de logs de ce changement sont conçus pour servir de base à ces alarmes.
