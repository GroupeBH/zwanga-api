# FIN-REF-001 — Parrainage, commissions et retraits FlexPay

## 21 octobre 2026 — Cash confirmé et reprises financières

Décision courante : **les trajets cash deviennent éligibles ; les abonnements payés en jetons restent exclus**, même avec des jetons achetés. Le parrain du passager reçoit 1 % de la part payée par son filleul, hors subvention Zwanga. Aucun prélèvement supplémentaire au conducteur : le partage reste inclus dans la commission plateforme de 5 %, avec la même tolérance de dette cash.

### Preuve de paiement et reprise

- Cash : réservation `completed`, dépose persistée, reçu d'encaissement du conducteur (`cashReceivedAt`, montant et conducteur). `not_required` seul ne prouve pas l'encaissement. Seuls les nouveaux reçus après migration 86 sont éligibles, y compris pour un trajet non encore encaissé au déploiement. Les reçus historiques ne sont pas recrédités après un simple réenregistrement.
- Migration **1780000086000-ReferralBookingRecovery** : file PostgreSQL alimentée dans la même transaction que le reçu ou le changement d'état de la réservation. Traitement chaque minute, lots bornés, bail, backoff et acquittement par révision. Un crédit validé avant perte de l'acquittement est repris sans deuxième récompense. Aucun appel au prestataire pour la commission cash. Pas de rejeu massif de l'historique.
- Un paiement de trajet en jetons doit être appuyé par un débit négatif unique du journal et ne pas être intégralement remboursé. Une anomalie reste à régulariser, sans créer arbitrairement une commission retirable.
- La retenue de sept jours, la fenêtre de douze mois et le seuil de retrait de 1 000 jetons disponibles sont inchangés. Le résumé API ajoute les modes éligibles et précise que le cash exige un reçu.

### Intention de retrait

`POST /referrals/me/withdrawals` accepte désormais `idempotencyKey`, UUID facultatif pour compatibilité. Le client doit générer une clé par intention et conserver cette clé et les paramètres après un timeout. Une reprise retrouve le même retrait, y compris terminal, sans nouveau débit ni nouvel envoi. Un changement de montant/destination avec la même clé renvoie 409. Une autre intention en cours bloque une nouvelle demande.

```json
{"tokens":1000,"phone":"+243891234567","idempotencyKey":"550e8400-e29b-41d4-a716-446655440000"}
```

Anciennes applications sans clé : regroupement des demandes identiques tant qu'un retrait est en cours, puis pendant deux minutes après son résultat terminal (ou sa dernière mise à jour pour une ancienne ligne sans date de traitement). **Une relance très tardive après un retrait terminé n'est pas distinguable d'une nouvelle intention sans clé** ; une mise à jour client reste nécessaire pour la garantie durable. Aucun nouveau champ obligatoire.

`GET /referrals/me/withdrawals/:id` lit uniquement le retrait du propriétaire authentifié, même sans numéro de commande prestataire. Une reprise ne réémet jamais un envoi incertain. Les réservations sans aucune transaction associée restent récupérables après quinze minutes par le mécanisme existant.

### Livraison et limites

- Appliquer **85 — ReferralWithdrawalIdempotency**, puis **86 — ReferralBookingRecovery**, avant le serveur ; `/health` contrôle les nouveaux objets. Remplacer toutes les instances : une ancienne instance ne connaît pas la clé d'intention.
- Migration 85 : UUID nullable et unicité par utilisateur/clé. Aucun solde historique modifié. Les retours arrière SQL sont refusés dès que les clés ou la file sont utilisées ; correction en avant pour préserver les preuves financières.
- Les suites de récupération/retrait acceptent aussi `PAYOUT_TEST_POSTGRES_BIN`, celles de taux/bonus `WALLET_TEST_POSTGRES_BIN`. Le workflow existant les active désormais sans modification CI/CD. Aucun changement AWS, Terraform ou `.env`.
- Un transfert potentiellement envoyé mais sans preuve de résultat doit rester réservé : vérification prestataire et rapprochement support, jamais renvoi ou remboursement aveugle. Le reçu cash est une déclaration du conducteur, pas une preuve bancaire. Les anciennes routes d'historique complet restent compatibles, avec leur risque de volume ; préférer les routes paginées.

## 20 octobre 2026 — Suppression du bonus d'inscription et de rattachement

Le parrain ne reçoit **aucun jeton à l'inscription, au rattachement d'un compte existant ou au rattachement par un admin**. Seuls les paiements éligibles du filleul produisent désormais une rémunération :

- **1 %** sur un abonnement réellement payé et confirmé par FlexPay/PawaPay ; pas de gain sur un essai gratuit ou un abonnement payé en jetons, notamment avec le bonus de bienvenue Zwanga ;
- **1 %** sur un trajet terminé, avec dépose effectuée et paiement confirmé (électronique ou jetons ; cash confirmé ajouté le 21 octobre ci-dessus). Les trajets non terminés, annulés et impayés restent exclus.

Le taux de 10 FC, la retenue de sept jours, la fenêtre de douze mois à partir du premier paiement éligible, l'absence de rétroactivité et le retrait dès 1 000 jetons disponibles sont conservés. Le bonus de bienvenue de 500 jetons du **bénéficiaire KYC** est indépendant et n'est pas supprimé.

Le taux abonnement est désormais de **1 % par défaut et au maximum**, y compris si `REFERRAL_SUBSCRIPTION_REWARD_RATE` ou son fallback historique `REFERRAL_REWARD_RATE` contient encore `0.05`. Une configuration plus restrictive reste respectée. Un abonnement éligible de **5 000 FC produit 50 FC, soit 5 jetons**. Le résumé API expose le même taux que le calcul. Seules les nouvelles récompenses sont calculées ainsi : une commission déjà enregistrée à 5 % conserve son montant, même si son callback est rejoué. Cette réduction ne nécessite aucune migration supplémentaire, ni modification mobile ; `.env.example` est aligné sur `0.01`, sans modifier les environnements réels ni AWS.

`creditAttributionBonus` est supprimé du service. `REFERRAL_ATTRIBUTION_BONUS_TOKENS` est obsolète et ignoré, même si la production contient encore `5` ou une autre valeur positive. `rules.attributionBonusTokens` et la réponse du rattachement admin conservent le champ numérique à `0` pour les anciens clients. Le push de nouveau filleul est informatif ; aucun nouvel événement financier `attribution_bonus` n'est créé.

Les anciens bonus restent dans le registre et le solde, sans reprise ni suppression. La migration historique 29, le type d'écriture et les lecteurs de notifications historiques sont conservés.

### Audit admin, migration et déploiement

Le motif et l'identifiant de l'admin étaient inclus dans l'écriture financière du bonus. Pour ne pas perdre cette trace, la migration **`1780000082000-ReferralAttributionAudit`** ajoute deux colonnes nullable à `referral_profiles` : `attributionAdminId` (UUID) et `attributionAdminReason` (300 caractères maximum, comme le DTO existant). Elles sont enregistrées avec le premier rattachement, dans la même transaction ; une répétition ne les remplace pas. Elles ne sont pas sélectionnées par défaut ni ajoutées aux réponses publiques.

- Appliquer la migration 82 via le mécanisme transactionnel existant avant le nouveau backend ; elle suit les migrations de taux/bonus 80 et 81 déjà préparées.
- Pas de nouvelle variable, aucun recalcul financier ni extraction/reconstruction des anciens audits.
- Les recommandations PostgreSQL conservent l'ordre des verrous et les notifications hors transaction. Les délais de migration sont bornés ; le retour arrière n'efface pas un audit utilisé.
- Remplacer toutes les anciennes instances : tant qu'une ancienne version traite une inscription, elle peut encore attribuer son bonus. Aucun changement de CI/CD ou d'infrastructure n'est inclus.
- Le blocage financier est serveur et n'exige pas une mise à jour des stores. Le texte explicatif ajouté à l'app sera visible après sa livraison.

Les passages historiques ci-dessous décrivant le crédit de cinq jetons sont remplacés par cette décision. Vérifications et limites : [journal financier](CHANGELOG.md).

## Règle courante — 20 octobre 2026 : 10 FC par jeton

- `1 jeton = 10 CDF` pour tous les jetons Zwanga ; nombre de jetons existants conservé.
- Retrait de parrainage dès **1 000 jetons disponibles = 10 000 CDF**, avec KYC approuvé. Aucun autre compartiment ni portefeuille ne complète le disponible.
- Pro à 5 000 FC coûte 500 jetons. Les futurs bonus de bienvenue passent à **500 jetons**, sans complément des anciens bonus de 50 ou 200.
- Le Pro payé avec le bonus de bienvenue ne rémunère pas le parrain. Le flux Pro en jetons reste exclu et une garde explicite protège aussi les callbacks incohérents. Un abonnement réellement payé et confirmé par le prestataire reste éligible, même au premier mois.
- Les deux taux de parrainage sont de 1 % : abonnement éligible et trajet éligible. Par exemple, 1 % de 5 000 FC donnent 50 FC, soit 5 jetons au nouveau taux.
- Le réseau à plusieurs niveaux du tableur joint est **abandonné sur instruction de l'utilisateur** ; ni nouveaux rangs, ni Packs Pro, ni bonus USD.
- Les nouvelles migrations, la compatibilité mobile et le déploiement sont détaillés dans [la politique des jetons](purchased-token-withdrawals.md). Aucun changement en production n'a été réalisé.

## Contrôle du solde disponible — 20 octobre 2026

Un retrait ne peut utiliser que `referral_accounts.availableTokens` de l'utilisateur authentifié. Les jetons `pendingTokens`, `reservedTokens`, `withdrawnTokens`, les recharges, les bonus du portefeuille ordinaire et les gains conducteur ne peuvent pas compléter ce solde. Les commissions arrivées à maturité sont d'abord libérées suivant les règles existantes ; les autres restent en attente.

Le serveur vérifie le montant (minimum 1 000 jetons, deux décimales maximum), puis relit le compte de parrainage sous verrou transactionnel. Il déplace exactement le montant demandé du disponible vers le réservé avant l'appel au prestataire, sans appel réseau sous verrou. Les montants ou soldes non numériques/incohérents sont refusés. Les champs clients permettant de choisir un autre solde sont rejetés par la validation HTTP existante.

Exemple : 800 jetons disponibles et 5 000 en attente ne permettent pas de retirer 1 000 jetons. Avec 1 500 disponibles, deux demandes simultanées de 1 000 ne peuvent pas toutes deux être financées. Les callbacks de confirmation et les règles de déblocage après échec restent inchangés. Les gains conducteur conservent leur propre circuit de retrait.

Pas de migration, de variable d'environnement supplémentaire ni de changement du corps de requête mobile. Le déploiement du backend sera nécessaire pour appliquer le durcissement en production.

Validation locale : 544 tests des modules parrainage, portefeuille, paiements et gains conducteur réussis, plus 5 tests sur un cluster PostgreSQL/PostGIS jetable (solde disponible seul, montant exact, concurrence, maturité et rollback). Compilation applicative réussie. Le test PostgreSQL s'active avec `REFERRAL_TEST_POSTGRES_BIN` pointant vers les binaires locaux ; il ne lit pas `.env` et les versements externes sont simulés.

## Historique du 14 octobre 2026 — remplacé par le taux de 10 FC ci-dessus

Les montants/seuils de cette section documentent l'étape précédente. La règle du 14 octobre autorisait `POST /referrals/me/withdrawals` dès **1 000 jetons par demande**, soit **25 000 CDF**, avec KYC et solde disponible suffisants. La valeur était de **25 FC pour tous les jetons Zwanga**. Le résumé indiquait `withdrawal.enabled=true`, `minimumTokens=1000`, `moneyPerToken=25`, et `blocked=true` si le KYC ou le solde était insuffisant. Le minimum de 1 000 est conservé, mais le taux courant est désormais 10.

Les soldes acquis gardent leur nombre de jetons ; aucun crédit multiplicateur. Les taux de récompense restent inchangés, les nouvelles récompenses sont converties à 25 FC/jeton. Les anciens retraits déjà transmis gardent leur taux/montant enregistré. Les gains conducteur restent retirables ; les jetons du portefeuille d'usage restent non retirables. Voir [la politique actuelle, ses migrations et les limites mobiles](purchased-token-withdrawals.md).

## Spécification initiale (historique)

Date : 25 août 2026  
Statut : implémenté dans le code ; migration à appliquer  
Périmètre : inscription, abonnements, courses, paiements FlexPay, jetons retirables, KYC, retraits et application mobile

## 1. Décision métier

Chaque utilisateur Zwanga possède un lien d'invitation ChottuLink personnel. Le filleul ouvre ce lien, installe l'application si nécessaire puis s'inscrit ou se connecte sans saisir de code. L'application rattache automatiquement le parrain lors de la création du compte ou, pour un compte existant, seulement si aucun parrain n'est encore enregistré.

Le parrain reçoit :

- **5 jetons de parrainage disponibles immédiatement** quand le filleul est rattaché pour la première fois ;
- **1 % du prix total réellement payé** pour un abonnement Pro payé et confirmé par FlexPay/PawaPay ;
- **1 % du montant réellement payé par le filleul** pour une course terminée, déposée automatiquement, puis payée par FlexPay ou en jetons Zwanga.

Pour les courses, ce 1 % est prélevé sur la commission plateforme Zwanga de 5 %. Le conducteur conserve donc son calcul existant : il reçoit le net après la commission globale de 5 %. Sur une course parrainée, Zwanga conserve économiquement 4 % et le parrain reçoit 1 %.

Le backend applique cette règle comme un invariant métier : même si `REFERRAL_BOOKING_REWARD_RATE` est configuré par erreur à `0.05`, la commission de course du parrain est plafonnée à `0.01`, c'est-à-dire 1 % du montant payé par le filleul. Ce plafonnement évite de confondre le taux abonnement avec le partage de commission trajet.

La rémunération variable s'applique pendant **douze mois**. La période commence à la date du **premier paiement éligible réussi** du filleul, et non à sa date d'inscription. Le bonus fixe de rattachement n'attend pas le premier paiement.

Le programme est à un seul niveau : le parrain du parrain ne reçoit rien.

## 2. Comportement avant et après

Avant ce changement, aucun code ni aucune commission n'était enregistré et l'invitation partageait un lien générique.

Après ce changement :

- chaque compte possède un jeton de lien opaque et un lien ChottuLink personnel ;
- l'attribution différée est acceptée par les inscriptions téléphone, Google et Apple ;
- le rattachement du parrain est immuable ;
- le premier rattachement crédite 5 jetons disponibles au parrain ;
- les paiements éligibles créent une commission en attente : 1 % sur abonnement FlexPay/PawaPay, 1 % sur course FlexPay ou jetons ;
- la commission devient disponible après sept jours ;
- les gains sont séparés des jetons promotionnels ;
- un utilisateur KYC approuvé peut retirer au moins 50 jetons par FlexPay Mobile Money ;
- l'application partage le lien, puis affiche les règles, les soldes, les commissions et les retraits.

## 3. Deux catégories de jetons

### 3.1 Jetons promotionnels ou d'usage

Le portefeuille existant `wallet_accounts` conserve les recharges, la fidélité, les transferts, le bonus de 25 jetons d'abonnement et les paiements en jetons. Ces jetons ne sont **pas retirables en argent** par le nouveau flux.

### 3.2 Jetons de parrainage

Les commissions utilisent `referral_accounts` et `referral_ledger_entries`. Elles représentent une créance retirable. Elles ne peuvent ni être dépensées comme le solde promotionnel ni être transférées.

Cette séparation empêche notamment que le bonus promotionnel de 25 jetons soit retiré en espèces.

## 4. Sources éligibles

### 4.1 Abonnement

Une commission est créée seulement si :

1. `subscription.isTrial = false` ;
2. la transaction appartient à FlexPay ;
3. `payment.purpose = subscription_pro` ;
4. `payment.status = succeeded` ;
5. le filleul possède un parrain ;
6. la date du paiement est postérieure ou égale à `referredAt` ;
7. la date de paiement se trouve dans la fenêtre de douze mois.

Un abonnement payé avec des jetons peut toujours recevoir le bonus promotionnel de 25 jetons, mais il ne génère aucune commission de parrainage.

### 4.2 Course

Une commission est créée seulement si :

1. `booking.status = completed` ;
2. `booking.droppedOff = true` ;
3. `booking.paymentMode = electronic` ou `points` ;
4. `booking.paymentStatus = succeeded` ;
5. pour `electronic`, la transaction FlexPay possède `purpose = trip_booking` ;
6. pour `points`, le débit interne des jetons du passager est confirmé ;
7. le filleul possède un parrain ;
8. la date du paiement est postérieure ou égale à `referredAt` ;
9. la date de paiement se trouve dans la fenêtre de douze mois.

Une course en espèces, `no_show`, `boarding_uncertain`, annulée, non déposée ou non payée ne génère rien.

Le point d'intégration est `finalizeCompletedBooking`. Les mises à jour REST et Socket.IO peuvent toutes provoquer la réévaluation, mais l'unicité de la source garantit une seule commission.

## 5. Formules, arrondis et exemples

Les calculs utilisent le montant confirmé côté serveur. Pour FlexPay, la source est `payment_transactions.amount`. Pour un paiement en jetons, la source est `bookings.paymentAmount` après débit interne confirmé. Si le premier trajet du filleul est subventionné par Zwanga, la commission parrain est donc calculée sur les 40 % réellement payés par le filleul, pas sur `bookings.grossPaymentAmount` ni sur `bookings.zwangaSubsidyAmount`. Le client ne transmet jamais le montant de la commission.

```text
tauxAbonnement = 0,05
tauxCommissionZwangaTrajet = 0,05
tauxParrainTrajet = 0,01
commissionMonetaire = arrondi(montantReellementPaye × tauxApplicable, 2 décimales)
jetonsParrainage = arrondi(commissionMonetaire ÷ valeurDuJetonDansLaDeviseSource, 2 décimales)
montantRetraitCDF = arrondi(jetonsRetires × valeurDuJetonCDF, 2 décimales)
```

Avec la configuration livrée :

```text
1 jeton = 100 CDF
abonnement payé = 5 000 CDF
commission parrain = 5 000 × 0,05 = 250 CDF
gain = 250 ÷ 100 = 2,50 jetons
```

Pour une course de 10 000 CDF :

```text
commission plateforme brute = 10 000 × 0,05 = 500 CDF
part parrain = 10 000 × 0,01 = 100 CDF = 1 jeton
part Zwanga nette = 10 000 × 0,04 = 400 CDF
gain conducteur = 10 000 - 500 = 9 500 CDF
```

Le taux, le brut, la devise, la valeur du jeton, la commission et les jetons sont persistés dans chaque récompense. Une modification de configuration ne recalcule donc pas l'historique.

Le système livré est configuré en CDF. Une autre devise exige `REFERRAL_MONEY_PER_TOKEN_<DEVISE>` ; sans cette valeur, le calcul est refusé pour éviter une conversion implicite erronée.

## 6. Fenêtre de rémunération d'un an

Les champs concernés se trouvent sur le profil du filleul :

- `qualifiedAt` : date du premier paiement éligible réussi ;
- `rewardWindowEndsAt` : `qualifiedAt + 12 mois`.

Avant le premier paiement, les deux champs restent `null`. Une inscription sans achat ne consomme donc pas la période. Le paiement qui initialise la fenêtre est rémunéré. Un paiement strictement postérieur à `rewardWindowEndsAt` ne crée rien.

## 7. Retenue de sept jours

Toute commission liée à un paiement commence dans l'état `pending` avec `holdUntil = paidAt + 7 jours`.

Le bonus fixe de 5 jetons au rattachement n'est pas une commission de paiement. Il est crédité directement dans `availableTokens`, avec une écriture `referral_ledger_entries.type = attribution_bonus`.

Un cron horaire libère les récompenses à échéance. La lecture du récapitulatif ou des récompenses réalise aussi cette libération. Deux écritures sont produites : débit de `pending`, puis crédit de `available`. La récompense passe à `available` et devient retirable.

## 8. Modèle de données

Migrations : `1780000018000-AddReferralProgram.ts`, `1780000019000-AddBranchReferralAttribution.ts`, `1780000020000-ReplaceBranchWithChottuLink.ts`, `1780000029000-AddReferralAttributionBonus.ts`, puis `1780000030000-EnforceReferralBookingRewardRateCap.ts`.

### 8.1 `referral_profiles`

| Champ                      | Rôle                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `userId`                   | propriétaire unique du profil et du code                          |
| `code`                     | code alphanumérique unique en majuscules                          |
| `linkToken`                | jeton opaque unique embarqué dans l'URL de destination ChottuLink |
| `shareLinkUrl`             | dernier lien court créé par le fournisseur actif                  |
| `shareLinkGeneratedAt`     | date de création utilisée pour le renouvellement préventif        |
| `referredByUserId`         | parrain immuable, ou `null`                                       |
| `referredAt`               | date du rattachement                                              |
| `attributionProvider`      | `chottulink`, `branch` historique ou `legacy_code`                |
| `attributionLinkToken`     | jeton ayant effectivement attribué le compte                      |
| `attributionReferringLink` | lien d'origine tronqué à 500 caractères pour audit                |
| `attributionCapturedAt`    | date du clic reçue du SDK                                         |
| `qualifiedAt`              | premier paiement éligible                                         |
| `rewardWindowEndsAt`       | fin de la période de douze mois                                   |

Une contrainte interdit l'auto-parrainage.

### 8.2 `referral_accounts`

| Compartiment      | Utilisation                              |
| ----------------- | ---------------------------------------- |
| `pendingTokens`   | commissions dans la retenue              |
| `availableTokens` | montant retirable                        |
| `reservedTokens`  | retrait créé, réponse FlexPay non finale |
| `withdrawnTokens` | retraits réussis cumulés                 |

Un seul compte existe par utilisateur. Les montants sont en `numeric(14,2)`.

### 8.3 `referral_rewards`

Une ligne représente la commission d'une source. L'index `UNIQUE(sourceType, sourceEntityId)` matérialise l'idempotence. Les états sont `pending`, `available` et `reversed`.

La contrainte `CHK_referral_rewards_booking_rate_cap` interdit toute nouvelle récompense `booking_payment` avec un taux supérieur à `0.010000`. Elle est ajoutée en `NOT VALID` pour ne pas casser un déploiement si des lignes historiques doivent être auditées, mais PostgreSQL l'applique immédiatement aux nouvelles insertions et mises à jour.

### 8.4 `referral_withdrawals`

Chaque demande conserve les jetons, le montant CDF, la valeur du jeton figée, le téléphone, la transaction FlexPay et la raison d'échec. Les états sont `pending`, `initiated`, `succeeded`, `failed` et `cancelled`.

### 8.5 `referral_ledger_entries`

Le registre est append-only. Chaque transfert entre compartiments produit deux lignes signées. Les types sont `reward_pending`, `reward_released`, `reward_reversed`, `withdrawal_reserved`, `withdrawal_succeeded` et `withdrawal_refunded`.

Chaque ligne conserve `balanceAfter`, le compartiment, la source et la transaction de paiement éventuelle.

## 9. Attribution automatique à l'inscription

### 9.1 Création et partage du lien

`GET /api/v1/referrals/me` crée, met en cache et retourne un lien court ChottuLink. Le backend appelle `POST https://api2.chottulink.com/chotuCore/pa/v1/create-link` avec la clé REST dans l'en-tête `API-KEY` et :

- le domaine ChottuLink configuré ;
- une URL de destination contenant `provider=chottulink` et le `referralToken` opaque ;
- `ios_behavior = 2` et `android_behavior = 2` pour ouvrir l'application ;
- les UTM `user_share`, `referral` et `zwanga_referral` ;
- le titre et la description de partage.

Le lien est renouvelé préventivement après 330 jours. En cas d'indisponibilité de ChottuLink, le dernier lien ChottuLink connu est conservé ; sans ancien lien, l'URL web de repli est retournée et la prochaine lecture retente la création. La clé REST n'est jamais envoyée à l'application.

### 9.2 Clic, installation différée et première ouverture

Le SDK ChottuLink est initialisé au démarrage de l'application native. L'application traite les ouvertures initiales, les liens reçus au premier plan et l'événement natif `ChottuLinkDeepLinkResolved`. Elle accepte uniquement une URL de destination portant `provider=chottulink` et un `referralToken` valide :

1. l'application extrait le jeton de l'URL de destination résolue ;
2. l'application appelle `POST /api/v1/referrals/resolve-attribution` ;
3. le serveur vérifie l'existence et l'état actif du parrain ;
4. l'application conserve localement le premier lien valide pendant 30 jours ;
5. l'écran d'inscription s'ouvre sans champ de code ;
6. `referralToken`, `referralReferringLink` et `referralCapturedAt` sont envoyés lors de la création du compte ;
7. le serveur rattache le parrain et persiste les informations d'audit.

La règle est **premier lien valide gagnant**. Un second lien ne remplace pas une attribution locale encore valide. Un lien ouvert pendant que l'utilisateur est déjà connecté est immédiatement présenté à la route authentifiée d'attribution. Lorsqu'un utilisateur se connecte après avoir ouvert un lien, l'attribution reste conservée jusqu'à la confirmation du backend. Elle est consommée après un succès ou un refus définitif, mais reste disponible après une erreur réseau.

Le SDK pouvant restituer la même attribution différée à plusieurs démarrages, l'application conserve pendant 90 jours la liste limitée des attributions différées déjà consommées. Cela interdit le rejeu automatique sur un deuxième compte du même appareil. Un nouveau clic direct reste traitable.

La fenêtre locale d'attribution de 30 jours commence à la résolution du lien par le SDK ChottuLink, notamment à la première ouverture après installation. ChottuLink ne fournit pas de date de clic dans cet événement, mais une date de résolution. Cette fenêtre ne doit pas être confondue avec la rémunération de douze mois, qui commence au premier paiement éligible du filleul.

### 9.3 Contrats d'inscription

Les propriétés automatiques sont acceptées par :

- `POST /api/v1/auth/register` ;
- `POST /api/v1/auth/google/mobile` ;
- `POST /api/v1/auth/apple/mobile`.

Le serveur valide le format, la date maximale de 30 jours et le profil correspondant avant la création ou le rattachement authentifié. Le parrain doit exister, être actif et non suspendu. Après inscription, le lien personnel du nouvel utilisateur et son compte à zéro sont créés. Aucun endpoint ne permet de remplacer son parrain.

Exemple de propriétés ajoutées au formulaire ou au JSON d'inscription :

```json
{
  "referralToken": "Z5MJkPNEXwlUzvLTWajEGIzXq3u5PF9W",
  "referralProvider": "chottulink",
  "referralReferringLink": "https://zwanga.chottu.link/AbCdEf",
  "referralCapturedAt": "2026-08-25T10:00:00.000Z"
}
```

`referralCode` reste accepté uniquement pour la compatibilité avec d'anciens liens déjà diffusés. Il n'existe plus de champ de saisie manuelle dans l'application.

Les utilisateurs historiques reçoivent un code et un compte vide lors de la migration. Ils peuvent désormais utiliser une invitation tant que `referredByUserId` est `null`. Le rattachement crédite le bonus fixe de 5 jetons au parrain, mais ne crée aucune commission rétroactive : seuls les paiements éligibles confirmés après le rattachement peuvent générer une commission.

### 9.4 Comptes existants sans parrain

`POST /api/v1/referrals/me/attribution` accepte le jeton ChottuLink d'un utilisateur authentifié. L'opération sérialise le filleul avec un `pg_advisory_xact_lock`, puis charge séparément le profil et l'utilisateur du parrain afin de ne jamais appliquer un verrou PostgreSQL sur une jointure externe TypeORM. Elle applique les règles suivantes :

- aucun parrain : premier rattachement accepté et daté ;
- même parrain : succès idempotent sans nouvelle mutation ni notification ;
- autre parrain déjà présent : refus, sans modification ;
- auto-parrainage : refus ;
- jeton expiré, invalide ou parrain suspendu : refus.

Le rattachement démarre la relation et crédite une seule fois le bonus fixe de 5 jetons au parrain. La fenêtre financière de douze mois commence toujours au premier paiement éligible réussi. Une notification push est envoyée au parrain uniquement lors du premier rattachement si son appareil possède un token FCM.

## 10. Retrait FlexPay

### 10.1 Conditions

Le retrait est accepté si :

1. le KYC possède un document `approved` ;
2. la demande vaut au moins 50 jetons ;
3. `availableTokens` couvre la demande ;
4. un téléphone Mobile Money est disponible ;
5. la devise et la valeur du jeton sont configurées.

Avec `1 jeton = 100 CDF`, le minimum vaut 5 000 CDF.

### 10.2 Réservation atomique

Avant l'appel FlexPay, une transaction verrouille le compte, débite `availableTokens`, crédite `reservedTokens`, crée le retrait et ajoute deux écritures. Deux demandes simultanées ne peuvent pas utiliser le même solde.

### 10.3 Réconciliation

- succès : `reserved → withdrawn` ;
- échec ou annulation : `reserved → available` ;
- callback répété : aucune seconde mutation ;
- échec corrigé tardivement en succès : correction `available → withdrawn` auditée.

Si FlexPay a accepté la demande mais qu'une erreur locale survient ensuite, le solde reste réservé. Le callback ou la vérification de statut reprend la réconciliation ; il n'est pas libéré prématurément.

La transaction utilise `purpose = referral_payout`, `relatedEntityType = referral_withdrawal` et le préfixe `REF`.

## 11. Annulations et inversions

Un paiement échoué ou annulé réconcilie sa source. Une récompense `pending` est débitée de `pendingTokens`; une récompense `available` est débitée de `availableTokens`. Elle passe à `reversed` avec date et motif. L'écriture d'origine est conservée et une écriture inverse est ajoutée.

Si les jetons ont déjà été retirés, le disponible peut devenir négatif. Cette dette absorbe les commissions suivantes et bloque tout nouveau retrait.

Il n'existe pas encore de flux métier complet de remboursement après paiement confirmé. Toute future route de remboursement devra appeler cette inversion.

## 12. Endpoints

| Méthode | Route                                               | Authentification              | Fonction                                          |
| ------- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `POST`  | `/api/v1/referrals/validate-code`                   | publique, limitée             | valider un code                                   |
| `POST`  | `/api/v1/referrals/resolve-attribution`             | publique, limitée             | valider un jeton de lien ChottuLink               |
| `GET`   | `/api/v1/referrals/me`                              | JWT                           | code, règles et soldes                            |
| `POST`  | `/api/v1/referrals/me/attribution`                  | JWT, limitée                  | rattacher le premier parrain d'un compte existant |
| `GET`   | `/api/v1/referrals/me/referrals`                    | JWT                           | filleuls directs                                  |
| `GET`   | `/api/v1/referrals/me/rewards`                      | JWT                           | commissions                                       |
| `GET`   | `/api/v1/referrals/me/ledger`                       | JWT                           | registre comptable                                |
| `GET`   | `/api/v1/referrals/me/withdrawals`                  | JWT                           | retraits                                          |
| `POST`  | `/api/v1/referrals/me/withdrawals`                  | JWT, limité                   | demander un retrait                               |
| `GET`   | `/api/v1/referrals/withdrawals/:orderNumber/status` | JWT                           | vérifier FlexPay                                  |
| `POST`  | `/api/v1/referrals/withdrawals/flexpay/callback`    | publique, limitée et vérifiée | callback FlexPay                                  |

Exemple :

```json
{
  "tokens": 50,
  "phone": "+243891234567"
}
```

Le téléphone peut être omis pour utiliser celui du compte.

### 12.1 Gains par filleul

`GET /api/v1/referrals/me/referrals` renvoie uniquement les filleuls directs du compte authentifié. Pour chacun, la réponse fournit le prénom, l'initiale du nom, les dates de rattachement et de qualification, ainsi que :

- `rewardCount` : nombre de commissions non annulées ;
- `earnedTokens` : cumul historique des commissions `pending` et `available` ;
- `pendingTokens` : jetons encore dans la période de retenue ;
- `releasedTokens` : jetons ayant terminé la retenue, y compris ceux retirés ensuite ;
- `reversedTokens` : cumul informatif des commissions annulées, exclu du gain ;
- `earnedAmount` : équivalent de `earnedTokens` calculé avec la valeur actuelle du jeton ;
- `currency` : devise de retrait de cet équivalent.

Le cumul reste attribué au filleul après un retrait afin de représenter ce qu'il a rapporté historiquement. La liste ne renvoie jamais le prix des courses, le prix des abonnements, le moyen de paiement, les références FlexPay ou les identifiants des transactions du filleul.

## 13. Autorisation, fraude et confidentialité

- le client ne choisit ni taux ni brut éligible ;
- un utilisateur ne consulte que ses données ;
- la validation publique ne révèle que le prénom du parrain ;
- le lien utilise un jeton aléatoire de 256 bits et ne révèle ni identifiant utilisateur ni code interne ;
- un code inactif ou suspendu est refusé ;
- l'auto-parrainage est contrôlé par le service et la base ;
- le rattachement ne peut pas être remplacé ;
- aucun gain n'est créé avant `succeeded` ;
- les callbacks utilisent le traitement FlexPay central et une transaction connue ;
- les routes sensibles sont limitées ;
- le KYC est obligatoire au décaissement, pas à l'accumulation ;
- aucun secret FlexPay n'est renvoyé à l'application.

La détection anti-abus multi-comptes par appareil ou graphe de paiement reste une amélioration ultérieure.

## 14. Variables d'environnement

| Variable                               | Valeur livrée                   | Effet                                                                |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `REFERRAL_SUBSCRIPTION_REWARD_RATE`    | `0.01`                          | 1 % du prix payé pour un abonnement éligible ; plafond serveur à 1 % |
| `REFERRAL_BOOKING_REWARD_RATE`         | `0.01`                          | 1 % du montant payé par le filleul pour une course FlexPay ou jetons |
| `REFERRAL_ATTRIBUTION_BONUS_TOKENS`    | `5`                             | bonus disponible au premier rattachement d'un filleul                |
| `REFERRAL_REWARD_RATE`                 | `0.01`                          | fallback abonnement historique, lui aussi plafonné à 1 %             |
| `REFERRAL_HOLD_DAYS`                   | `7`                             | retenue                                                              |
| `REFERRAL_REWARD_WINDOW_MONTHS`        | `12`                            | durée depuis le premier paiement                                     |
| `REFERRAL_MIN_WITHDRAWAL_TOKENS`       | `50`                            | retrait minimum                                                      |
| `REFERRAL_TOKENS_CURRENCY`             | `PTS`                           | identifiant technique du jeton retirable                             |
| `REFERRAL_PAYOUT_CURRENCY`             | `CDF`                           | devise de retrait                                                    |
| `REFERRAL_MONEY_PER_TOKEN_CDF`         | `100`                           | valeur du jeton                                                      |
| `REFERRAL_SHARE_BASE_URL`              | `https://zwanga.app/register`   | lien partagé                                                         |
| `REFERRAL_ATTRIBUTION_DAYS`            | `30`                            | délai maximal entre résolution du lien et inscription                |
| `CHOTTULINK_REST_API_KEY`              | vide                            | clé REST secrète `c_api_...` utilisée uniquement par le backend      |
| `CHOTTULINK_API_URL`                   | endpoint officiel `create-link` | création serveur du lien                                             |
| `CHOTTULINK_DOMAIN`                    | vide                            | domaine `*.chottu.link` configuré dans le dashboard                  |
| `CHOTTULINK_LINK_REFRESH_DAYS`         | `330`                           | renouvellement préventif du lien court                               |
| `FLEXPAY_REFERRAL_PAYOUT_CALLBACK_URL` | vide                            | URL dédiée optionnelle                                               |

`REFERRAL_BOOKING_REWARD_RATE` est volontairement séparé de `REFERRAL_REWARD_RATE`. Le premier concerne les courses et ne peut pas dépasser 1 % du prix total ; le second ne doit pas être utilisé pour les courses et reste uniquement un fallback legacy pour les abonnements.

Si l'URL dédiée est vide, le serveur la construit avec `FLEXPAY_CALLBACK_BASE_URL` ou `PUBLIC_API_BASE_URL`.

## 15. Application mobile

- SDK officiel `react-native-chottulink-sdk` et `expo-dev-client` ;
- domaines universels iOS, intent filters et Install Referrer Android ;
- écoute centralisée des liens avant l'authentification ;
- stockage local du premier jeton valide pendant 30 jours ;
- inscription automatique pour téléphone, Google et Apple ;
- suppression du champ manuel ;
- bannière non éditable confirmant l'invitation reconnue ;
- écran `app/referrals.tsx` avec soldes, commissions et retraits ;
- contrôles du minimum, du KYC et du solde ;
- carte de parrainage visible directement dans le profil, avec nombre de filleuls et solde disponible ;
- partage natif centralisé dans `utils/shareReferralLink.ts`, avec validation HTTPS du lien ChottuLink ;
- rechargement du lien avant partage lorsqu'il n'est pas encore présent dans le cache mobile ;
- indicateur de préparation et message explicite si le lien ou le partage natif est indisponible ;
- partage possible dans `app/invite.tsx` même lorsque l'accès aux contacts est refusé ;
- invitation WhatsApp ou SMS toujours construite avec le lien personnel validé, sans lien générique qui ferait perdre l'attribution ;
- accès depuis le profil, le portefeuille et les paramètres.

Le portefeuille continue d'afficher les jetons promotionnels. Une bannière mène au compte séparé.

## 16. Fichiers principaux

Backend : `src/referrals/*`, `src/auth/auth.service.ts`, `src/subscriptions/subscriptions.service.ts`, `src/bookings/bookings.service.ts`, `src/payments/entities/payment-transaction.entity.ts` et les migrations `1780000018000`, `1780000019000`, `1780000020000` et `1780000029000`.

Application : `app.config.js`, `app/+native-intent.tsx`, `app/(tabs)/profile.tsx`, `app/referrals.tsx`, `app/invite.tsx`, `app/wallet.tsx`, `app/auth.tsx`, `components/ReferralAttributionHandler.tsx`, `components/auth/steps/ProfileStep.tsx`, `services/chottuLinkReferral.ts`, `utils/referralAttribution.ts`, `utils/shareReferralLink.ts`, `store/api/referralApi.ts`, `store/api/authApi.ts` et `types/index.ts`.

## 17. Déploiement

1. Sauvegarder la base et rapprocher les paiements.
2. Déployer le backend avec les variables renseignées.
3. Configurer l'application, le domaine et les stores dans ChottuLink.
4. Appliquer les migrations `1780000018000`, `1780000019000`, `1780000020000`, puis `1780000029000`.
5. Vérifier un profil, un `linkToken` et un compte à zéro par utilisateur.
6. Dans le dépôt mobile, exécuter `npx expo prebuild --clean` avec les variables ChottuLink renseignées, contrôler le diff natif, puis produire de nouveaux builds iOS et Android ; une mise à jour OTA ne suffit pas.
7. Ouvrir un lien sur un appareil sans Zwanga, installer puis créer le filleul.
8. Vérifier l'audit ChottuLink et le rattachement immuable.
9. Confirmer un abonnement FlexPay test.
10. Vérifier une commission abonnement de 1 % en `pending` (5 jetons pour 5 000 FC).
11. Vérifier une commission course de 1 % en `pending`, aussi bien pour FlexPay que pour les jetons.
12. Vérifier que le rattachement du filleul crédite une seule fois 5 jetons disponibles.
13. Vérifier la libération des commissions après sept jours.
14. Effectuer un retrait test.
15. Rejouer les callbacks pour confirmer l'idempotence.

Aucune récompense rétroactive n'est créée.

## 18. Rapprochement comptable

Pour chaque compte :

```text
pendingTokens = somme des écritures du bucket pending
availableTokens = somme des écritures du bucket available
reservedTokens = somme des écritures du bucket reserved
withdrawnTokens = somme des écritures du bucket withdrawn
```

Contrôler aussi une seule récompense par source, un seul bonus `attribution_bonus` par filleul rattaché, une transaction `referral_payout` réussie par retrait réussi, la formule de conversion et l'absence de récompense sur une course en espèces.

Audit spécifique au partage de commission trajet :

```sql
SELECT id, "referrerUserId", "referredUserId", "sourceEntityId",
       "grossAmount", rate, "rewardAmount", "rewardTokens", "createdAt"
FROM referral_rewards
WHERE "sourceType" = 'booking_payment'
  AND rate > 0.010000
ORDER BY "createdAt" DESC;
```

Cette requête ne modifie rien. Toute ligne retournée doit être rapprochée manuellement avant de valider définitivement la contrainte sur l'historique.

## 19. Retour arrière

La méthode `down` refuse de supprimer les tables si une récompense, un retrait, une écriture ou un solde non nul existe. Avant un rollback après activité : arrêter les écritures, rapprocher FlexPay, exporter les tables, solder ou compenser les montants et obtenir une validation financière explicite.

La migration de fournisseur `1780000020000` ne touche pas aux attributions ni aux comptes. Son `down` remet les noms de colonnes Branch mais ne recrée pas leurs anciennes URL mises en cache ; revenir réellement à Branch exigerait une réinstallation et une régénération des liens.

## 20. Scénarios de test obligatoires

- jeton de lien valide, invalide, expiré, parrain inactif et auto-parrainage ;
- premier lien valide gagnant, second lien ignoré et compte connecté ignoré ;
- clic avec application installée et installation différée depuis les stores ;
- inscriptions téléphone, Google et Apple sans saisie manuelle ;
- ouverture de l'espace de parrainage depuis le profil ;
- partage natif avec résumé déjà chargé et après rechargement du résumé ;
- erreur réseau ou lien absent affiché à l'utilisateur, sans action silencieuse ;
- partage direct lorsque l'autorisation des contacts est refusée ;
- invitation WhatsApp et repli SMS conservant le lien personnel ;
- rattachement immuable ;
- bonus unique de 5 jetons au premier rattachement ;
- 1 % sur abonnement FlexPay/PawaPay, même avec l'ancienne configuration à 5 % ;
- 1 % exact sur course FlexPay ou jetons ;
- aucun gain pour espèces, essai ou paiement non réussi ;
- début au premier paiement et fin après douze mois ;
- callback répété et concurrence REST/Socket.IO ;
- libération après sept jours, jamais avant ;
- inversion `pending` et `available` ;
- retrait sous le minimum, KYC absent et solde insuffisant ;
- deux retraits concurrents ;
- succès, échec, annulation et succès tardif FlexPay ;
- rapprochement des quatre compartiments ;
- build backend et vérification TypeScript mobile.
