# FIN-BOOKING-003 — Subvention Zwanga du premier trajet passager

Dernière mise à jour : 4 septembre 2026  
Statut : implémenté localement ; migration, import SSM et déploiement backend requis.

## 1. Besoin métier

Lors de son premier trajet réel sur Zwanga, un passager paie seulement 40 % du prix total dû. Les 60 % restants sont subventionnés par Zwanga.

Cette règle doit être calculée côté serveur pour éviter qu'une application mobile modifiée puisse changer le montant. Elle doit aussi protéger le conducteur : la réduction accordée au passager ne doit pas réduire son gain attendu.

## 2. Définitions

- `grossPaymentAmount` : prix total serveur du trajet avant subvention.
- `paymentAmount` : montant réellement demandé au passager.
- `passengerPaymentRate` : part payée par le passager, `0.40` par défaut.
- `zwangaSubsidyAmount` : remise commerciale prise en charge par Zwanga, soit `grossPaymentAmount - paymentAmount`.
- `firstTripSubsidyApplied` : marque durable indiquant que la réservation consomme la subvention premier trajet.

Exemple pour un trajet de `10 000 CDF` :

```text
grossPaymentAmount = 10 000 CDF
passengerPaymentRate = 0,40
paymentAmount = 10 000 × 0,40 = 4 000 CDF
zwangaSubsidyAmount = 10 000 - 4 000 = 6 000 CDF
```

## 3. Éligibilité

La subvention est réservée uniquement si toutes les conditions suivantes sont vraies :

1. `FIRST_TRIP_SUBSIDY_ENABLED` est actif ;
2. le prix brut serveur est strictement positif ;
3. le passager n'a aucun trajet déjà complété, déposé ou payé ;
4. le passager n'a aucune autre réservation active ayant déjà réservé la subvention ;
5. la réservation courante n'est pas annulée, rejetée, expirée, `no_show` ou `boarding_uncertain`.

Un ancien utilisateur qui a déjà voyagé avant le déploiement ne reçoit donc pas la réduction sur son prochain trajet. La règle porte sur le premier trajet réel du passager, pas seulement sur le premier trajet après la sortie de cette fonctionnalité.

## 4. États qui libèrent la subvention

La réservation de la subvention est libérée si la réservation devient :

- `cancelled` ;
- `rejected` ;
- `expired` ;
- `no_show` ;
- `boarding_uncertain`.

Ces états ne prouvent pas un trajet payable. Le passager pourra donc encore bénéficier de la réduction lors de son premier trajet réellement complété.

## 5. Modes de paiement

### Paiement électronique FlexPay

Le passager paie `paymentAmount`. FlexPay n'encaisse donc que 40 % du prix total lors du premier trajet subventionné.

Le revenu conducteur reste calculé sur `grossPaymentAmount`, puis la commission Zwanga habituelle est appliquée :

```text
commission = arrondi(grossPaymentAmount × ZWANGA_COMMISSION_RATE)
revenu conducteur = arrondi(grossPaymentAmount - commission)
```

Avec `ZWANGA_COMMISSION_RATE = 0.05` et un trajet de `10 000 CDF` :

```text
passager paie = 4 000 CDF
subvention commerciale = 6 000 CDF
commission théorique Zwanga = 500 CDF
revenu conducteur = 9 500 CDF
```

### Paiement en jetons

Le débit interne de jetons est calculé à partir de `paymentAmount`, pas à partir du prix brut. Pour un trajet de `10 000 CDF` et `1 jeton = 100 CDF`, le passager dépense donc `40` jetons au lieu de `100`.

Le revenu conducteur est enregistré sur le prix brut du trajet, avec la commission Zwanga habituelle.

### Paiement en liquide

Le conducteur encaisse seulement `paymentAmount` auprès du passager.

La part `zwangaSubsidyAmount` devient une créance conducteur disponible dans `driver_earnings`, avec `paymentMode = cash`, `commissionRate = 0`, `commissionAmount = 0` et `netAmount = zwangaSubsidyAmount`.

Ce choix évite que le conducteur finance indirectement la promotion.

## 6. Parrainage et fidélité

Pour les commissions de parrainage de course, la source reste le montant réellement payé par le filleul :

- FlexPay : `payment_transactions.amount` ;
- jetons : `bookings.paymentAmount` après débit confirmé.

La partie subventionnée par Zwanga ne génère pas de commission de parrainage. Cette séparation empêche qu'une subvention commerciale crée en plus une dépense de parrainage sur une somme que le passager n'a pas payée.

La fidélité passager reste calculée sur le montant passager quand il existe, afin de ne pas accorder des jetons de fidélité sur la part prise en charge par Zwanga.

## 7. Concurrence et idempotence

Une contrainte unique partielle protège la réservation de la subvention :

```text
un seul booking par passengerId
où firstTripSubsidyApplied = true
et status non libéré
```

Si deux réservations concurrentes tentent de réserver la subvention, une seule garde la réduction. L'autre repasse automatiquement au prix complet.

Le paiement en jetons conserve le règlement atomique existant : débit passager, statut de réservation et revenu conducteur sont validés ou annulés ensemble.

## 8. Modèle de données

Migration : `1780000031000-AddFirstTripSubsidyToBookings.ts`.

Colonnes ajoutées à `bookings` :

- `grossPaymentAmount numeric(10,2)` ;
- `firstTripSubsidyApplied boolean not null default false` ;
- `passengerPaymentRate numeric(7,6)` ;
- `zwangaSubsidyAmount numeric(10,2) not null default 0`.

Contraintes :

- subvention non négative ;
- taux passager strictement compris entre `0` et `1` ;
- cohérence entre brut, montant passager et subvention lorsque la subvention est appliquée.

Index :

- unicité partielle de la subvention active par passager ;
- index partiel d'historique pour détecter rapidement un passager ayant déjà voyagé.

La migration initialise `grossPaymentAmount = paymentAmount` pour les réservations historiques lorsque le brut n'est pas encore renseigné. Elle ne recalcule aucun paiement, solde, retrait, commission ou revenu historique.

## 9. Contrats API

Les réponses de paiement de réservation exposent :

```json
{
  "payment": {
    "amount": 4000,
    "grossAmount": 10000,
    "passengerAmount": 4000,
    "firstTripSubsidyApplied": true,
    "passengerPaymentRate": 0.4,
    "zwangaSubsidyAmount": 6000,
    "currency": "CDF"
  }
}
```

`amount` reste l'alias historique du montant à payer par le passager.

Les notifications de revenu conducteur peuvent aussi inclure `grossTripAmount` et `zwangaSubsidyAmount` afin que l'application affiche clairement la part prise en charge par Zwanga.

## 10. Variables d'environnement

| Variable                            | Valeur recommandée | Rôle                                                  |
| ----------------------------------- | ------------------ | ----------------------------------------------------- |
| `FIRST_TRIP_SUBSIDY_ENABLED`        | `true`             | active ou coupe la subvention sans changer le code    |
| `FIRST_TRIP_PASSENGER_PAYMENT_RATE` | `0.40`             | part du prix brut payée par le passager               |
| `TRIP_PAYMENT_CURRENCY`             | `CDF`              | devise des courses                                    |
| `ZWANGA_COMMISSION_RATE`            | `0.05`             | commission appliquée aux revenus électroniques/jetons |

Sur AWS, importer les deux nouvelles variables dans SSM Parameter Store sous `/zwanga-api/production/env/*`, puis créer une nouvelle révision ECS.

## 11. Fichiers modifiés

Backend :

- `src/bookings/bookings.service.ts` ;
- `src/bookings/entities/booking.entity.ts` ;
- `src/driver-settlements/driver-settlements.service.ts` ;
- `src/database/migrations/1780000031000-AddFirstTripSubsidyToBookings.ts` ;
- `src/database/migrations/index.ts`.

Configuration et documentation :

- `.env.example` ;
- `.env.docker.example` ;
- `.env.production.example` ;
- `infra-aws/terraform.tfvars.example` ;
- `docs/finance/README.md` ;
- `docs/finance/CHANGELOG.md` ;
- `docs/finance/referral-program.md`.

## 12. Tests obligatoires

- création d'une réservation éligible avec `paymentAmount = 40 %` et `grossPaymentAmount = 100 %` ;
- refus de la subvention si le passager possède déjà un trajet complété/payé ;
- libération après annulation, rejet, expiration, `no_show` ou `boarding_uncertain` ;
- débit en jetons sur le montant passager uniquement ;
- revenu conducteur électronique/jetons calculé sur le brut ;
- revenu conducteur cash limité à la part subventionnée ;
- parrainage calculé sur le montant réellement payé ;
- build TypeScript.

## 13. Déploiement production

1. Sauvegarder la base et relever les compteurs de `bookings`, `driver_earnings`, `wallet_ledger_entries`, `payment_transactions` et `referral_rewards`.
2. Importer `FIRST_TRIP_SUBSIDY_ENABLED=true` et `FIRST_TRIP_PASSENGER_PAYMENT_RATE=0.40` dans SSM.
3. Vérifier le plan Terraform/ECS : aucune suppression ACM, DNS, ALB, RDS, Redis, SSM ou KMS ne doit apparaître.
4. Déployer le backend.
5. Exécuter la migration `1780000031000`.
6. Tester un premier trajet de faible montant en cash, FlexPay et jetons.
7. Vérifier que le conducteur voit le brut, la part cash ou électronique, et la subvention Zwanga.
8. Vérifier qu'un deuxième trajet du même passager n'est pas subventionné.

## 14. Rapprochement production

Requêtes de contrôle :

```sql
SELECT "passengerId", COUNT(*)
FROM bookings
WHERE "firstTripSubsidyApplied" = true
  AND status NOT IN ('cancelled', 'rejected', 'expired', 'no_show', 'boarding_uncertain')
GROUP BY "passengerId"
HAVING COUNT(*) > 1;
```

```sql
SELECT id, "paymentAmount", "grossPaymentAmount", "zwangaSubsidyAmount"
FROM bookings
WHERE "firstTripSubsidyApplied" = true
  AND (
    "grossPaymentAmount" < "paymentAmount"
    OR "zwangaSubsidyAmount" <> ROUND(("grossPaymentAmount" - "paymentAmount")::numeric, 2)
  );
```

```sql
SELECT b.id, b."paymentMode", b."paymentAmount", b."grossPaymentAmount", e."grossAmount", e."netAmount"
FROM bookings b
JOIN driver_earnings e ON e."bookingId" = b.id
WHERE b."firstTripSubsidyApplied" = true;
```

## 15. Retour arrière

Pour couper immédiatement la promotion sans rollback de code :

```text
FIRST_TRIP_SUBSIDY_ENABLED=false
```

Ensuite redéployer ECS pour recharger la variable.

Le rollback SQL supprime les colonnes et index de subvention, mais il ne doit pas être lancé si des paiements subventionnés ont déjà été effectués sans décision de rapprochement, car les montants conducteur et les écritures de paiement conserveraient leurs valeurs historiques.
