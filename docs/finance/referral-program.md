# FIN-REF-001 — Parrainage, commissions et retraits FlexPay

Date : 25 août 2026  
Statut : implémenté dans le code ; migration à appliquer  
Périmètre : inscription, abonnements, courses, paiements FlexPay, jetons retirables, KYC, retraits et application mobile

## 1. Décision métier

Chaque utilisateur Zwanga possède un lien d'invitation ChottuLink personnel. Le filleul ouvre ce lien, installe l'application si nécessaire puis s'inscrit ou se connecte sans saisir de code. L'application rattache automatiquement le parrain lors de la création du compte ou, pour un compte existant, seulement si aucun parrain n'est encore enregistré.

Le parrain reçoit **5 % du prix total réellement payé** par son filleul pour :

- un abonnement Pro payé et confirmé par FlexPay ;
- une course terminée, déposée automatiquement, puis payée et confirmée par FlexPay.

La rémunération s'applique pendant **douze mois**. La période commence à la date du **premier paiement éligible réussi** du filleul, et non à sa date d'inscription.

Le programme est à un seul niveau : le parrain du parrain ne reçoit rien.

## 2. Comportement avant et après

Avant ce changement, aucun code ni aucune commission n'était enregistré et l'invitation partageait un lien générique.

Après ce changement :

- chaque compte possède un jeton de lien opaque et un lien ChottuLink personnel ;
- l'attribution différée est acceptée par les inscriptions téléphone, Google et Apple ;
- le rattachement du parrain est immuable ;
- les paiements éligibles créent une commission de 5 % en attente ;
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
3. `booking.paymentMode = electronic` ;
4. `booking.paymentStatus = succeeded` ;
5. la transaction FlexPay possède `purpose = trip_booking` ;
6. le filleul possède un parrain ;
7. la date du paiement est postérieure ou égale à `referredAt` ;
8. la date de paiement se trouve dans la fenêtre de douze mois.

Une course en espèces, en jetons, `no_show`, `boarding_uncertain`, annulée, non déposée ou non payée ne génère rien.

Le point d'intégration est `finalizeCompletedBooking`. Les mises à jour REST et Socket.IO peuvent toutes provoquer la réévaluation, mais l'unicité de la source garantit une seule commission.

## 5. Formules, arrondis et exemples

Les calculs utilisent `payment_transactions.amount`. Le client ne transmet jamais le montant de la commission.

```text
taux = 0,05
commissionMonetaire = arrondi(montantReellementPaye × taux, 2 décimales)
jetonsParrainage = arrondi(commissionMonetaire ÷ valeurDuJetonDansLaDeviseSource, 2 décimales)
montantRetraitCDF = arrondi(jetonsRetires × valeurDuJetonCDF, 2 décimales)
```

Avec la configuration livrée :

```text
1 jeton = 100 CDF
abonnement payé = 5 000 CDF
commission = 5 000 × 0,05 = 250 CDF
gain = 250 ÷ 100 = 2,50 jetons
```

Pour une course de 10 000 CDF, la commission vaut 500 CDF, soit 5 jetons.

Le taux, le brut, la devise, la valeur du jeton, la commission et les jetons sont persistés dans chaque récompense. Une modification de configuration ne recalcule donc pas l'historique.

Le système livré est configuré en CDF. Une autre devise exige `REFERRAL_MONEY_PER_TOKEN_<DEVISE>` ; sans cette valeur, le calcul est refusé pour éviter une conversion implicite erronée.

## 6. Fenêtre de rémunération d'un an

Les champs concernés se trouvent sur le profil du filleul :

- `qualifiedAt` : date du premier paiement éligible réussi ;
- `rewardWindowEndsAt` : `qualifiedAt + 12 mois`.

Avant le premier paiement, les deux champs restent `null`. Une inscription sans achat ne consomme donc pas la période. Le paiement qui initialise la fenêtre est rémunéré. Un paiement strictement postérieur à `rewardWindowEndsAt` ne crée rien.

## 7. Retenue de sept jours

Toute récompense commence dans l'état `pending` avec `holdUntil = paidAt + 7 jours`.

Un cron horaire libère les récompenses à échéance. La lecture du récapitulatif ou des récompenses réalise aussi cette libération. Deux écritures sont produites : débit de `pending`, puis crédit de `available`. La récompense passe à `available` et devient retirable.

## 8. Modèle de données

Migrations : `1780000018000-AddReferralProgram.ts`, `1780000019000-AddBranchReferralAttribution.ts`, puis `1780000020000-ReplaceBranchWithChottuLink.ts`.

### 8.1 `referral_profiles`

| Champ | Rôle |
| --- | --- |
| `userId` | propriétaire unique du profil et du code |
| `code` | code alphanumérique unique en majuscules |
| `linkToken` | jeton opaque unique embarqué dans l'URL de destination ChottuLink |
| `shareLinkUrl` | dernier lien court créé par le fournisseur actif |
| `shareLinkGeneratedAt` | date de création utilisée pour le renouvellement préventif |
| `referredByUserId` | parrain immuable, ou `null` |
| `referredAt` | date du rattachement |
| `attributionProvider` | `chottulink`, `branch` historique ou `legacy_code` |
| `attributionLinkToken` | jeton ayant effectivement attribué le compte |
| `attributionReferringLink` | lien d'origine tronqué à 500 caractères pour audit |
| `attributionCapturedAt` | date du clic reçue du SDK |
| `qualifiedAt` | premier paiement éligible |
| `rewardWindowEndsAt` | fin de la période de douze mois |

Une contrainte interdit l'auto-parrainage.

### 8.2 `referral_accounts`

| Compartiment | Utilisation |
| --- | --- |
| `pendingTokens` | commissions dans la retenue |
| `availableTokens` | montant retirable |
| `reservedTokens` | retrait créé, réponse FlexPay non finale |
| `withdrawnTokens` | retraits réussis cumulés |

Un seul compte existe par utilisateur. Les montants sont en `numeric(14,2)`.

### 8.3 `referral_rewards`

Une ligne représente la commission d'une source. L'index `UNIQUE(sourceType, sourceEntityId)` matérialise l'idempotence. Les états sont `pending`, `available` et `reversed`.

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

Les utilisateurs historiques reçoivent un code et un compte vide lors de la migration. Ils peuvent désormais utiliser une invitation tant que `referredByUserId` est `null`. Le rattachement ne crée aucune commission rétroactive : seuls les paiements éligibles confirmés après le rattachement peuvent générer 5 %.

### 9.4 Comptes existants sans parrain

`POST /api/v1/referrals/me/attribution` accepte le jeton ChottuLink d'un utilisateur authentifié. L'opération verrouille son profil avec `pessimistic_write`, puis applique les règles suivantes :

- aucun parrain : premier rattachement accepté et daté ;
- même parrain : succès idempotent sans nouvelle mutation ni notification ;
- autre parrain déjà présent : refus, sans modification ;
- auto-parrainage : refus ;
- jeton expiré, invalide ou parrain suspendu : refus.

Le rattachement démarre seulement la relation. La fenêtre financière de douze mois commence toujours au premier paiement éligible réussi. Une notification push est envoyée au parrain uniquement lors du premier rattachement si son appareil possède un token FCM.

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

| Méthode | Route | Authentification | Fonction |
| --- | --- | --- | --- |
| `POST` | `/api/v1/referrals/validate-code` | publique, limitée | valider un code |
| `POST` | `/api/v1/referrals/resolve-attribution` | publique, limitée | valider un jeton de lien ChottuLink |
| `GET` | `/api/v1/referrals/me` | JWT | code, règles et soldes |
| `POST` | `/api/v1/referrals/me/attribution` | JWT, limitée | rattacher le premier parrain d'un compte existant |
| `GET` | `/api/v1/referrals/me/referrals` | JWT | filleuls directs |
| `GET` | `/api/v1/referrals/me/rewards` | JWT | commissions |
| `GET` | `/api/v1/referrals/me/ledger` | JWT | registre comptable |
| `GET` | `/api/v1/referrals/me/withdrawals` | JWT | retraits |
| `POST` | `/api/v1/referrals/me/withdrawals` | JWT, limité | demander un retrait |
| `GET` | `/api/v1/referrals/withdrawals/:orderNumber/status` | JWT | vérifier FlexPay |
| `POST` | `/api/v1/referrals/withdrawals/flexpay/callback` | publique, limitée et vérifiée | callback FlexPay |

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

| Variable | Valeur livrée | Effet |
| --- | --- | --- |
| `REFERRAL_REWARD_RATE` | `0.05` | 5 % du prix total payé |
| `REFERRAL_HOLD_DAYS` | `7` | retenue |
| `REFERRAL_REWARD_WINDOW_MONTHS` | `12` | durée depuis le premier paiement |
| `REFERRAL_MIN_WITHDRAWAL_TOKENS` | `50` | retrait minimum |
| `REFERRAL_TOKENS_CURRENCY` | `PTS` | identifiant technique du jeton retirable |
| `REFERRAL_PAYOUT_CURRENCY` | `CDF` | devise de retrait |
| `REFERRAL_MONEY_PER_TOKEN_CDF` | `100` | valeur du jeton |
| `REFERRAL_SHARE_BASE_URL` | `https://zwanga.app/register` | lien partagé |
| `REFERRAL_ATTRIBUTION_DAYS` | `30` | délai maximal entre résolution du lien et inscription |
| `CHOTTULINK_REST_API_KEY` | vide | clé REST secrète `c_api_...` utilisée uniquement par le backend |
| `CHOTTULINK_API_URL` | endpoint officiel `create-link` | création serveur du lien |
| `CHOTTULINK_DOMAIN` | vide | domaine `*.chottu.link` configuré dans le dashboard |
| `CHOTTULINK_LINK_REFRESH_DAYS` | `330` | renouvellement préventif du lien court |
| `FLEXPAY_REFERRAL_PAYOUT_CALLBACK_URL` | vide | URL dédiée optionnelle |

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

Backend : `src/referrals/*`, `src/auth/auth.service.ts`, `src/subscriptions/subscriptions.service.ts`, `src/bookings/bookings.service.ts`, `src/payments/entities/payment-transaction.entity.ts` et les migrations `1780000018000`, `1780000019000` et `1780000020000`.

Application : `app.config.js`, `app/+native-intent.tsx`, `app/(tabs)/profile.tsx`, `app/referrals.tsx`, `app/invite.tsx`, `app/wallet.tsx`, `app/auth.tsx`, `components/ReferralAttributionHandler.tsx`, `components/auth/steps/ProfileStep.tsx`, `services/chottuLinkReferral.ts`, `utils/referralAttribution.ts`, `utils/shareReferralLink.ts`, `store/api/referralApi.ts`, `store/api/authApi.ts` et `types/index.ts`.

## 17. Déploiement

1. Sauvegarder la base et rapprocher les paiements.
2. Déployer le backend avec les variables renseignées.
3. Configurer l'application, le domaine et les stores dans ChottuLink.
4. Appliquer les migrations `1780000018000`, `1780000019000`, puis `1780000020000`.
5. Vérifier un profil, un `linkToken` et un compte à zéro par utilisateur.
6. Dans le dépôt mobile, exécuter `npx expo prebuild --clean` avec les variables ChottuLink renseignées, contrôler le diff natif, puis produire de nouveaux builds iOS et Android ; une mise à jour OTA ne suffit pas.
7. Ouvrir un lien sur un appareil sans Zwanga, installer puis créer le filleul.
8. Vérifier l'audit ChottuLink et le rattachement immuable.
9. Confirmer un abonnement FlexPay test.
10. Vérifier une récompense de 5 % en `pending`.
11. Vérifier sa libération après sept jours.
12. Effectuer un retrait test.
13. Rejouer les callbacks pour confirmer l'idempotence.

Aucune récompense rétroactive n'est créée.

## 18. Rapprochement comptable

Pour chaque compte :

```text
pendingTokens = somme des écritures du bucket pending
availableTokens = somme des écritures du bucket available
reservedTokens = somme des écritures du bucket reserved
withdrawnTokens = somme des écritures du bucket withdrawn
```

Contrôler aussi une seule récompense par source, une transaction `referral_payout` réussie par retrait réussi, la formule de conversion et l'absence de récompense sur une course non électronique.

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
- 5 % exact sur abonnement et course ;
- aucun gain pour espèces, jetons, essai ou paiement non réussi ;
- début au premier paiement et fin après douze mois ;
- callback répété et concurrence REST/Socket.IO ;
- libération après sept jours, jamais avant ;
- inversion `pending` et `available` ;
- retrait sous le minimum, KYC absent et solde insuffisant ;
- deux retraits concurrents ;
- succès, échec, annulation et succès tardif FlexPay ;
- rapprochement des quatre compartiments ;
- build backend et vérification TypeScript mobile.
