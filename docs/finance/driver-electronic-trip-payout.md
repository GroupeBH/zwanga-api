# FIN-DRIVER-001 — Versement Mobile Money des revenus conducteur

Dernière mise à jour : 26 août 2026  
Statut : implémenté dans le backend et l'application ; migration et déploiement de production requis.

## 1. Besoin métier

Après la fin d'une course, le passager paie le montant calculé par le serveur. Quand ce paiement électronique est réellement confirmé, Zwanga doit :

1. créer une créance nette pour le conducteur ;
2. rendre cette créance visible dans l'application ;
3. permettre au conducteur vérifié de demander son versement vers son numéro Mobile Money ;
4. conserver le montant comme réservé tant que FlexPay n'a pas confirmé le résultat final ;
5. permettre un nouveau retrait depuis l'application après un échec ou une annulation confirmés.

Le paiement passager et le versement conducteur sont deux transactions distinctes. Le passager n'est jamais débité avant son arrivée.

## 2. Décisions fonctionnelles

- Le conducteur déclenche le retrait dans l'application. Il n'y a pas de décaissement automatique vers un numéro non confirmé par le profil.
- Le bouton apparaît dans **Profil > Revenus conducteur**.
- La destination par défaut est le téléphone du compte conducteur.
- Un KYC approuvé est obligatoire.
- L'application propose par défaut le retrait de tout le solde disponible.
- Après un retrait `failed` ou `cancelled`, un bouton **Réessayer** permet de soumettre une nouvelle demande.
- Un retrait `pending` ou `initiated` ne peut pas être rejoué : son montant demeure réservé.
- Le décaissement utilise uniquement FlexPay Mobile Money. La documentation FlexPay Card concerne l'encaissement par carte et ne définit aucun versement vers une carte bancaire.

## 3. Conditions de création d'un revenu conducteur

Un `driver_earning` est créé uniquement si toutes les conditions suivantes sont vraies :

- la réservation est arrivée à destination ou est `completed` ;
- le mode est `electronic` ou `points` ;
- `booking.paymentStatus = succeeded` ;
- le montant brut est strictement positif ;
- le trajet possède un conducteur ;
- aucun revenu n'existe déjà pour cette réservation.

Pour une course électronique, le callback FlexPay ne suffit pas à lui seul lorsque `FLEXPAY_VERIFY_CALLBACKS=true`. Le serveur interroge l'endpoint de vérification FlexPay et contrôle la référence, le numéro de commande, le montant et la devise avant de confirmer le paiement.

## 4. Calcul monétaire

Pour un prix brut `G` et un taux de commission `r` :

```text
commission = arrondi_centime(G × r)
revenu_net = arrondi_centime(G - commission)
```

Configuration actuelle : `ZWANGA_COMMISSION_RATE = 0.05`.

Exemple pour une course de `10 000 CDF` :

```text
commission Zwanga = 10 000 × 0,05 = 500 CDF
revenu conducteur = 10 000 - 500 = 9 500 CDF
```

Les valeurs `grossAmount`, `commissionRate`, `commissionAmount`, `netAmount` et `currency` sont figées dans `driver_earnings`. Une modification future du taux ne recalcule pas les revenus historiques.

## 5. Calcul du solde retirable

```text
revenus_disponibles = somme(driver_earnings.netAmount où status = available)
sommes_bloquées = somme(driver_payouts.amount où status ∈ pending, initiated, succeeded)
solde_retirable = max(0, revenus_disponibles - sommes_bloquées)
```

Les retraits `failed` et `cancelled` ne sont plus bloqués et leur montant redevient retirable. Les retraits réussis restent soustraits définitivement.

## 6. États du retrait

| État | Signification | Effet sur le solde |
| --- | --- | --- |
| `pending` | demande réservée localement ou livraison FlexPay incertaine | montant bloqué |
| `initiated` | FlexPay a accepté la demande et a renvoyé un `orderNumber` | montant bloqué |
| `succeeded` | transfert confirmé par FlexPay | montant payé et définitivement consommé |
| `failed` | échec final confirmé | montant libéré et retirable à nouveau |
| `cancelled` | annulation finale confirmée | montant libéré et retirable à nouveau |

La réponse initiale `code = 0` de `merchantPayOutService` signifie seulement « demande reçue ». Elle ne doit jamais être interprétée comme un transfert final réussi.

## 7. Flux complet

```text
paiement passager confirmé après arrivée
  -> driver_earning net disponible
  -> conducteur ouvre Revenus conducteur
  -> confirmation du montant et du téléphone masqué
  -> réservation atomique du solde
  -> POST FlexPay merchantPayOutService
  -> pending/initiated
  -> callback FlexPay + vérification du statut
       -> succeeded : montant payé
       -> failed/cancelled : montant libéré, bouton Réessayer
       -> résultat incertain : reste bloqué, cron de réconciliation
```

## 8. Fiabilité, concurrence et idempotence

### 8.1 Verrou conducteur

La réservation du retrait s'exécute dans une transaction PostgreSQL avec un verrou pessimiste sur l'utilisateur conducteur. Deux requêtes simultanées pour le même conducteur sont donc sérialisées avant le calcul du solde.

### 8.2 Clé d'idempotence

L'application génère un UUID v4 pour chaque intention de retrait. La paire `(driverId, idempotencyKey)` est unique en base.

- rejouer la même clé avec le même montant et le même téléphone renvoie le retrait existant ;
- rejouer la même clé avec d'autres données est refusé ;
- un double tap ou un retry HTTP ne crée pas un second transfert ;
- une nouvelle tentative après échec utilise une nouvelle clé.

Les anciens retraits reçoivent leur propre identifiant comme clé pendant la migration, sans modifier leurs montants ou états.

### 8.3 Unicité de la transaction FlexPay

Deux index uniques partiels protègent les deux directions du rattachement :

- une `paymentTransactionId` ne peut appartenir qu'à un retrait ;
- une source `driver_payout:<payoutId>` ne peut créer qu'une transaction de paiement.

Avant tout nouvel appel FlexPay, le service recherche aussi une transaction existante pour `driver_payout:<payoutId>`. Même si deux retries concurrents ne voient initialement aucune transaction, un seul insert peut gagner ; le second ne peut donc pas atteindre l'appel externe.

### 8.4 Timeout ou coupure réseau

Une coupure pendant le `POST` FlexPay ne prouve pas que FlexPay n'a rien reçu. Dans ce cas :

- la transaction de paiement reste `pending` ;
- le retrait et son montant restent réservés ;
- aucune nouvelle demande identique n'est envoyée automatiquement ;
- un callback ultérieur peut conclure l'opération ;
- le rapprochement périodique vérifie les opérations possédant un `orderNumber`.

Seul un échec certain avant toute transaction FlexPay libère immédiatement le montant.

Si le serveur s'arrête après la réservation locale mais avant même la création d'une `payment_transaction`, le rapprochement attend quinze minutes, vérifie une seconde fois l'absence de transaction FlexPay liée, puis classe le retrait en échec. Le montant redevient alors disponible et le conducteur peut le redemander dans l'application.

### 8.5 Callback et vérification

La vérification FlexPay est active par défaut. Une valeur explicite `FLEXPAY_VERIFY_CALLBACKS=false` est réservée à un environnement de test contrôlé.

Avant tout passage à `succeeded`, le serveur compare :

- la référence interne ;
- `orderNumber` ;
- le montant ;
- la devise ;
- le statut de la transaction FlexPay.

Un callback répété est idempotent. Un callback d'échec ne peut pas rétrograder un retrait déjà réussi.

## 9. Contrats API

Tous les endpoints privés utilisent l'identité issue du JWT ; un conducteur ne peut lire ou vérifier que ses propres retraits.

| Méthode | Route | Usage |
| --- | --- | --- |
| `GET` | `/api/v1/driver-settlements/me` | solde, KYC, téléphone et minimum |
| `GET` | `/api/v1/driver-settlements/earnings` | historique des courses créditées |
| `GET` | `/api/v1/driver-settlements/payouts` | historique et statut des retraits |
| `POST` | `/api/v1/driver-settlements/payouts` | demande manuelle de retrait |
| `GET` | `/api/v1/driver-settlements/payouts/:orderNumber/status` | vérification manuelle |
| `POST` | `/api/v1/driver-settlements/payouts/flexpay/callback` | callback public FlexPay limité en fréquence |

Exemple de demande :

```json
{
  "amount": 9500,
  "idempotencyKey": "8a94aa7d-dfc2-4fc9-9f71-faf4df306907"
}
```

Le champ `phone` demeure facultatif pour compatibilité ; sans valeur, le téléphone du profil est utilisé.

Exemple de réponse initiée :

```json
{
  "id": "uuid-retrait",
  "amount": 9500,
  "currency": "CDF",
  "status": "initiated",
  "orderNumber": "numero-flexpay",
  "paymentMessage": "Demande de paiement envoyee. Veuillez valider sur votre telephone"
}
```

## 10. Modèle de données et migration

Migration : `1780000022000-HardenDriverPayouts.ts`.

- colonne non nulle `driver_payouts.idempotencyKey varchar(80)` ;
- index unique `(driverId, idempotencyKey)` ;
- index unique partiel sur `paymentTransactionId IS NOT NULL` ;
- index unique partiel sur la source `payment_transactions(driver_payout:<payoutId>)` ;
- remplissage non financier des anciennes lignes avec `id::text`.

La migration ne crée, ne débite, ne crédite et ne recalcule aucun montant. Elle s'arrête explicitement si elle détecte un doublon historique de rattachement ; ces lignes doivent alors être rapprochées sans suppression automatique avant de relancer la migration.

## 11. Variables d'environnement

| Variable | Type | Rôle |
| --- | --- | --- |
| `ZWANGA_COMMISSION_RATE` | décimal | taux de commission, `0.05` |
| `TRIP_PAYMENT_CURRENCY` | texte | devise des courses et revenus, `CDF` |
| `DRIVER_PAYOUT_MIN_AMOUNT_CDF` | décimal positif | minimum d'un retrait conducteur |
| `FLEXPAY_PAYOUT_SERVICE_URL` | URL | endpoint `merchantPayOutService` |
| `FLEXPAY_CHECK_TRANSACTION_URL` | URL | vérification par `orderNumber` |
| `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL` | URL | callback dédié, facultatif si base publique configurée |
| `FLEXPAY_CALLBACK_BASE_URL` | URL | base publique de repli |
| `FLEXPAY_TOKEN` | secret | jeton Bearer FlexPay |
| `FLEXPAY_MERCHANT_CODE` | configuration sensible | code marchand |
| `FLEXPAY_VERIFY_CALLBACKS` | booléen | vérification serveur ; conserver `true` en production |

Sur AWS, ces variables sont importées depuis `.env.production` vers le préfixe SSM avec `infra-aws/scripts/import-env-to-ssm.ps1`. Aucune valeur secrète ne doit être copiée dans la documentation ou les logs.

## 12. Fichiers modifiés

Backend :

- `src/driver-settlements/driver-settlements.service.ts` ;
- `src/driver-settlements/driver-settlements.module.ts` ;
- `src/driver-settlements/dto/driver-settlement.dto.ts` ;
- `src/driver-settlements/entities/driver-payout.entity.ts` ;
- `src/payments/payments.service.ts` ;
- `src/database/migrations/1780000022000-HardenDriverPayouts.ts` et index ;
- exemples de variables d'environnement.

Application :

- `app/driver-earnings.tsx` ;
- `store/api/driverSettlementsApi.ts` ;
- `types/index.ts`.

## 13. Tests obligatoires

- création unique du revenu conducteur après paiement confirmé ;
- calcul `10 000 - 5 % = 9 500 CDF` ;
- verrou pessimiste et refus du dépassement de solde ;
- même clé d'idempotence rejouée sans second appel FlexPay ;
- timeout FlexPay conservé en `pending` ;
- callback et vérification répétés sans double versement ;
- rejet d'une référence, d'un montant ou d'une devise incohérents ;
- échec final libérant le solde et nouvelle demande possible dans l'app ;
- build NestJS et vérification TypeScript de l'application.

## 14. Déploiement

1. Sauvegarder la base et relever les totaux de `driver_earnings`, `driver_payouts` et `payment_transactions` de type `driver_payout`.
2. Vérifier les URLs FlexPay et conserver `FLEXPAY_VERIFY_CALLBACKS=true`.
3. Importer les variables de `.env.production` dans SSM.
4. Examiner le plan Terraform/ECS : aucune suppression de certificat, DNS, base ou paramètre financier ne doit apparaître.
5. Déployer le backend et exécuter `npm run migration:run:prod` une seule fois.
6. Vérifier que la migration `1780000022000` est appliquée.
7. Déployer la nouvelle application mobile.
8. Tester un retrait de faible montant avec un compte FlexPay de validation.
9. Surveiller les callbacks et le rapprochement pendant au moins un cycle de cinq minutes.

## 15. Rapprochement de production

```text
nombre de revenus par booking <= 1
nombre de retraits par (driverId, idempotencyKey) = 1
nombre de retraits par paymentTransactionId non nul <= 1
solde retirable >= 0
somme des payouts succeeded = somme des transferts FlexPay confirmés correspondants
```

Une opération `pending` sans `orderNumber` après un timeout ne doit pas être relancée manuellement avant vérification auprès de FlexPay par sa référence interne.

## 16. Retour arrière

- Le code applicatif peut être remis à la version précédente tant qu'aucun retrait du nouveau client n'est en cours.
- La colonne d'idempotence peut rester en base sans effet sur l'ancien code ; il est préférable de ne pas exécuter immédiatement le `down`.
- Le `down` supprime uniquement les index et la colonne, sans modifier les montants.
- Ne jamais supprimer un retrait ou une transaction FlexPay pour corriger un solde.
- Ne jamais libérer manuellement un retrait `pending` après timeout sans preuve que FlexPay n'a pas transféré l'argent.

## 17. Limites connues

- Le document FlexPay fourni ne définit ni signature de callback ni clé d'idempotence native du fournisseur. La vérification par l'API FlexPay, la référence interne et les contraintes Zwanga compensent cette limite.
- Le versement vers une carte bancaire n'est pas supporté par la documentation fournie.
- La confirmation d'un changement de numéro Mobile Money reste fondée sur le téléphone du profil et le KYC existant.
