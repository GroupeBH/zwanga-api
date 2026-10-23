# Versements conducteur et résolution des retraits bloqués

## 23 octobre 2026 — Résolution du parrainage et prévention des retraits sans provision

Le parcours de résolution couvre maintenant les **gains conducteur** et les
**jetons de parrainage disponibles**. Aucune annulation n'est déclenchée sur le
seul âge du retrait ou le seul solde marchand. Un versement en attente peut
encore être exécuté par FlexPaie après réapprovisionnement.

### API d'administration

Toutes les routes ci-dessous sont préfixées par `/api/v1` et exigent le JWT
administrateur existant. Le contrôle de rôle reste côté backend.

| Route | Rôle et usage |
| --- | --- |
| `GET /admin/referrals/withdrawals?status=pending` | Admin/super-admin : liste paginée, puis `status=initiated` pour les versements acceptés |
| `GET /admin/referrals/withdrawals/:id` | Admin/super-admin : détail, référence attendue et preuve de résolution éventuelle |
| `POST /admin/referrals/withdrawals/:id/reconcile` | Super-admin : vérifier sans réémettre ; restitution automatique uniquement si non-envoi prouvé ou échec définitif vérifié |
| `POST /admin/referrals/withdrawals/:id/resolve-not-paid` | **Super-admin uniquement** : libération après confirmation définitive de non-exécution |
| `GET /admin/driver-payouts` | Admin/super-admin : file des retraits conducteur à examiner, déjà existante |
| `POST /admin/driver-payouts/:id/reconcile` | Admin/super-admin : contrôle du versement conducteur |
| `POST /admin/driver-payouts/:id/resolve-not-paid` | Admin/super-admin : résolution conducteur existante, contrat conservé |

Le corps de résolution est identique pour les deux types de retrait :

```json
{
  "expectedReference": "REFERENCE_ZWANGA_DU_RETRAIT",
  "confirmedNotPaid": true,
  "reason": "Non-exécution définitive confirmée par FlexPaie",
  "evidenceReference": "REFERENCE_DE_CONFIRMATION_DU_PRESTATAIRE"
}
```

Procédure : lire le dossier, lancer `reconcile`, puis obtenir de FlexPaie une
confirmation **définitive** de non-exécution/annulation si l'état reste incertain.
Un ticket simplement ouvert, un timeout, « transaction introuvable » ou une
capture de solde insuffisant ne constituent pas cette preuve. Soumettre ensuite
la résolution avec `expectedReference` renvoyée par le dossier. Sans transaction
créée, cette référence correspond à l'ID du retrait. Délai de sécurité : 15 minutes.
Une indisponibilité du contrôle ou de l'authentification FlexPaie ne bloque pas
la résolution avec cette preuve externe. Une incohérence de référence, de
bénéficiaire ou de montant reste bloquante ; elle n'est pas assimilée à une panne.

Les réponses ajoutent `expectedReference`, `canResolveNotPaid` et
`resolutionRequiresProviderConfirmation`. Ce sont des indications pour
l'interface, **pas des permissions ni une confirmation du prestataire**. Les
listes de parrainage indiquent également `isStale` (24 h), `requiresReview` et
`canRetry`. Le détail conserve `resolution` et signale
`lateSuccessAfterRelease`. Les anciens champs/statuts restent compatibles.
Ces endpoints sont également raccordés localement dans `zwanga-admin`, sans
modification des fichiers de style :

- **Parrainage → Retraits → Détails / traiter** : consultation pour les admins,
  vérification et libération sur preuve pour les super-admins, y compris sans
  transaction encore créée.
- **Paiements → Retraits de gains à examiner** : file paginée, ouverture par
  identifiant de retrait, vérification, libération sur preuve et clôture d'un
  incident de succès tardif pour les admins/super-admins.
- Depuis le détail d'une transaction conducteur/parrainage liée, **Ouvrir le
  dossier de retrait** utilise l'identifiant du retrait, pas celui du paiement.

Le panneau distingue l'état local de celui de la transaction prestataire et
affiche l'historique ou la preuve enregistrée. La confirmation n'est jamais
précochée. Le dossier est relu avant toute action ; les doubles clics sont
bloqués, les soldes/historiques invalidés après traitement, et une panne
d'actualisation après un succès n'est pas présentée comme un rejet du traitement.
Un backend ancien sans les capacités de résolution ne permet aucune libération
dans l'interface. La preuve externe reste obligatoire ; le bouton ne commande
pas d'annulation chez FlexPaie.

Validation admin locale : 30 tests réussis (dont 18 nouveaux tests de règles,
contrats API, rendu React et gestionnaires d'action simulés), contrôle TypeScript
et build Next.js réussis. Aucun retrait réel, test navigateur authentifié contre
un prestataire ou déploiement n'a été exécuté.

### Garanties financières et notifications

- Le parrainage passe en `cancelled` et les jetons réservés redeviennent
  disponibles, une seule fois, dans leur **compte de parrainage**. Aucun crédit
  de portefeuille ordinaire, bonus ou conversion au taux actuel n'est créé.
- Pour les gains conducteur, le calcul existant du disponible déduit les retraits
  en cours/réussis ; l'annulation libère la réservation sans ajouter de gains.
- La libération locale n'appelle pas une API d'annulation FlexPaie et ne falsifie
  pas `payment_transactions.status`. Les contrôles/callbacks continuent.
- Un succès tardif du parrainage redébite les jetons restitués, une seule fois,
  conserve l'audit et peut rendre le disponible négatif si des jetons ont déjà
  été réutilisés. Cette dette n'est pas effacée ni remplacée par zéro. Un retrait
  conducteur confirmé tardivement conserve le blocage de rapprochement existant.
- La notification « Retrait annulé » est enregistrée dans la même transaction
  que la restitution via le subscriber/outbox existant. Son envoi push intervient
  après commit, selon la disponibilité du service et du jeton appareil.
- L'ordre de verrouillage propriétaire → retrait → paiement → compte et les
  transactions courtes suivent le guide PostgreSQL. Aucun appel réseau sous
  verrou. Les répétitions et les appels concurrents ne doublent pas la restitution.

### Contrôle facultatif du solde marchand avant envoi

`FLEXPAY_PAYOUT_BALANCE_CHECK_ENABLED=true` active un GET du solde **avant** `/pay`
pour les deux types de retrait. Valider auparavant les accès et l'URL
`FLEXPAY_PAYOUT_BALANCE_URL` auprès de FlexPaie. Par défaut, le contrôle est désactivé
afin de ne pas imposer un nouvel endpoint à une configuration existante.

Si le solde de la devise ne couvre pas le montant, aucun `/pay` n'est envoyé :
erreur `PAYOUT_INSUFFICIENT_MERCHANT_BALANCE`. Si le contrôle activé échoue ou
renvoie une devise absente/ambiguë, aucun envoi non plus :
`PAYOUT_BALANCE_UNAVAILABLE`. Le paiement est enregistré en échec, donc les
réservations peuvent être libérées par les parcours existants. Aucun solde
marchand ni secret n'est exposé à l'utilisateur.

Ce contrôle ne réserve pas le solde chez FlexPaie : des frais ou d'autres
versements simultanés peuvent encore provoquer un refus/une attente ensuite.
La réponse effective du prestataire reste déterminante. Le contrôle ne débloque
pas rétroactivement les retraits existants et ne rejoue jamais `/pay`.

### Livraison ultérieure

Exécuter la migration `1780000090000-ReferralWithdrawalResolution` avant le code
qui utilise le nouveau détail/résolution. Elle crée seulement la table d'audit
`referral_withdrawal_resolutions` et son index ; aucun solde ni retrait existant
n'est changé. Le rollback est possible tant que la table est vide et refusé
après utilisation pour conserver les preuves. La migration est enregistrée dans
la liste TypeORM existante. Ne pas utiliser `synchronize` en production.

Après libération, l'utilisateur rafraîchit son solde et crée une **nouvelle**
demande avec une nouvelle clé d'idempotence ; rejouer l'ancienne retourne
l'ancienne opération. Les retraits réels existants doivent être traités dossier
par dossier. Aucun paramètre AWS, Terraform, CI/CD, déploiement ou virement réel
n'est modifié par cette intervention locale.

Validation locale : suite globale de 227 suites / 2 629 tests réussis, avec
450 tests conditionnels ignorés dans ce passage. Les vérifications PostgreSQL
ont été exécutées séparément sur des bases jetables : 18 scénarios de résolution
du parrainage, 5 de récupération conducteur et 10 de retrait sur solde de
parrainage disponible, tous réussis. Après le dernier ajustement de gestion des
pannes d'authentification, les 20 tests ciblés du contrat de résolution et du
service conducteur passent également. Les appels FlexPaie et l'envoi réel des
push sont simulés ; le test PostgreSQL vérifie la notification persistée dans
l'outbox, pas sa réception sur un téléphone.

## Résolution des retraits bloqués du 3 octobre 2026

Le backend et l'écran mobile des gains conducteur disposent maintenant d'un
parcours de vérification et de résolution. Un délai dépassé ne prouve jamais
l'échec du virement : aucun retrait n'est annulé sur son seul âge. Ces changements
sont locaux, non déployés, et ne résolvent pas automatiquement l'incident existant.

### Comportements

- Les retraits `pending` / `initiated` de plus de 24 heures nécessitent une revue,
  même s'ils ont un `orderNumber`. La variable facultative
  `DRIVER_PAYOUT_REVIEW_AFTER_MINUTES` remplace ce seuil (15 à 43 200 minutes,
  défaut 1 440). Aucune nouvelle variable n'est nécessaire pour activer le défaut.
- Le conducteur peut demander une vérification, même sans numéro de commande.
  Les répétitions retournent le même dossier sans renvoyer d'argent.
- Le support dispose d'une liste paginée des dossiers anciens, signalés ou sans
  numéro de commande, d'un détail et d'un historique des interventions.
- Un numéro de commande retrouvé chez FlexPay peut être fourni au rapprochement.
  Il n'est associé qu'après contrôle de la référence par l'API authentifiée.
- La libération manuelle exige un administrateur, la référence exacte du dossier,
  une attestation explicite et la référence de la confirmation **définitive** de
  non-exécution ou d'annulation obtenue chez FlexPay. Un simple ticket ouvert,
  « transaction introuvable », timeout, capture du téléphone ou solde non reçu
  n'est pas une confirmation suffisante.
- La libération locale met le retrait en `cancelled`, mais ne falsifie pas le
  statut de la transaction prestataire. Elle ne lance pas d'appel d'annulation
  chez FlexPay et ne supprime aucun historique. Les gains deviennent disponibles
  par le calcul existant du solde, sans crédit supplémentaire au portefeuille.
- Une confirmation tardive de succès reste traitée : le retrait devient
  `succeeded`, un incident est enregistré et les nouveaux retraits du conducteur
  sont bloqués jusqu'au rapprochement. Clore cet incident ne rembourse rien et
  conserve le versement réussi dans le calcul du solde.
- La réconciliation automatique reste toutes les cinq minutes, avec rotation
  par `lastReconciledAt` pour ne plus relire uniquement les 50 plus anciens cas.
- Les états terminaux restent compatibles avec l'ancienne app. Après résolution
  serveur, son rafraîchissement peut déjà rétablir la possibilité de retrait ;
  le nouveau bouton de signalement nécessite la mise à jour mobile.

### Endpoints

Toutes les routes sont sous `/api/v1`. Les opérations conducteur exigent son JWT
et vérifient la propriété du retrait. Les opérations `/admin` exigent le rôle
administrateur (ou super-administrateur via la hiérarchie existante).

| Méthode et route | Action |
| --- | --- |
| `POST /driver-settlements/payouts/:id/review` | Signaler avec `{ "reason": "Retrait non reçu" }` |
| `POST /driver-settlements/payouts/:id/refresh` | Vérifier par ID interne, sans nouvel envoi |
| `GET /admin/driver-payouts?limit=50&offset=0` | File des dossiers à vérifier |
| `GET /admin/driver-payouts/:id` | Détail et 100 derniers événements |
| `POST /admin/driver-payouts/:id/reconcile` | Vérifier ; corps `{}` ou `{ "orderNumber": "REFERENCE_FLEXPAY" }` |
| `POST /admin/driver-payouts/:id/resolve-not-paid` | Libérer après confirmation externe définitive |
| `POST /admin/driver-payouts/:id/close-late-success` | Clore un incident tardif après rapprochement financier |

Exemple de corps de résolution (valeurs fictives à remplacer par les références
du dossier réel, **uniquement après confirmation du prestataire**) :

```json
{
  "expectedReference": "REFERENCE_ZWANGA_DU_RETRAIT",
  "confirmedNotPaid": true,
  "reason": "Non-exécution définitive confirmée par FlexPay",
  "evidenceReference": "REFERENCE_DE_LA_CONFIRMATION_FLEXPAY"
}
```

Si aucune transaction n'a été créée, `expectedReference` est l'ID du retrait.
Le backend refuse les retraits de moins de 15 minutes, les références incohérentes,
les versements déjà réussis et la résolution manuelle PawaPay. Un statut vérifié
de succès ne peut pas être forcé en échec. L'endpoint `close-late-success` exige
`reason` et `evidenceReference` ; il n'efface ni le versement ni une éventuelle dette.

### Déploiement et traitement de l'incident existant

1. Livrer la migration `1780000046000-AddDriverPayoutRecovery` puis le backend
   selon le workflow habituel. Ne pas utiliser `synchronize` ni modifier les
   statuts à la main en SQL. La migration ajoute les champs de revue, les index
   et `driver_payout_events`, sans annuler aucun retrait existant.
2. Avec un compte administrateur, retrouver le retrait via la file puis lire
   son détail. Vérifier son montant, conducteur, référence et numéro FlexPay.
3. Exécuter `reconcile`. Si le numéro manque, le demander à FlexPay à partir de
   la référence marchand et le faire vérifier par ce même endpoint.
4. Si le résultat demeure inconnu, laisser les fonds réservés et obtenir la
   confirmation définitive du prestataire. Après cette confirmation seulement,
   utiliser `resolve-not-paid` et conserver la preuve dans le dossier de support.
5. Le conducteur actualise ses gains puis crée un **nouveau** retrait avec une
   nouvelle clé d'idempotence. Rejouer l'ancienne clé retourne l'ancien retrait.

La référence de l'incident de production n'a pas été fournie : aucun retrait réel
n'a été inspecté, annulé ou relancé dans cette intervention. Une validation réelle
avec FlexPay reste nécessaire. Ne jamais partager un token dans le motif ou la preuve.

### Garanties et validation

Les recommandations PostgreSQL ont guidé les transactions courtes et l'ordre de
verrouillage conducteur → retrait → transaction, sans appel réseau sous verrou.
Création du paiement et réservation sont liées atomiquement, empêchant une
soumission concurrente ou une soumission après libération d'un retrait non envoyé.
Les réponses FlexPay retardées ne peuvent plus écraser un succès déjà enregistré.
Les preuves et acteurs sont consignés ; le rollback de la migration est refusé
si cet historique contient des événements.

Fichiers principaux : `src/driver-settlements/driver-payout-recovery.*`, DTO et
entités associés, `driver-settlements.service.ts`, `src/payments/flexpay-payout-state.ts`,
`payments.service.ts` et la migration. Côté mobile : API de règlements, hook
`useDriverPayout`, `PayoutHistory`, modèle de présentation et types des gains.

Validation locale : 303 tests sur les paiements, règlements et retraits de jetons ;
5 tests sur une base PostgreSQL 18 jetable (libérations concurrentes, succès
tardif, soumission unique, annulation avant soumission, audit) ; 43 tests
JavaScript mobile. Contrôles TypeScript backend et mobile réussis.
La base de test a été arrêtée et supprimée. Aucun essai sur appareil physique,
appel marchand réel, migration de production ou déploiement n'a été effectué.

## Historique du correctif du 15 septembre 2026

> Mise à jour du 17 septembre 2026 : les références à `merchantPayOutService`
> et au token d'encaissement ci-dessous décrivent l'ancien contrat. Le retrait
> utilise désormais l'API Payout v1.03 avec authentification dédiée et URL `/pay`.
> Voir [la configuration actuelle](../../FLEXPAY_SETUP.md#driver-earnings-payouts-flexpaie-payout-v103).
> Les garanties de réservation et d'idempotence restent conservées. Les variables
> payout ont été ajoutées vides au `.env` local ; aucun déploiement ni virement réel.

## Sens du transfert

Conformément à la documentation FlexPay API v1.4 fournie (pages 8 à 10),
`merchantPayOutService` transfère l'argent depuis le compte marchand Zwanga
vers le Mobile Money du conducteur. Les identifiants marchands restent sur le
serveur. Le conducteur ne paie pas pour recevoir ses gains et n'a pas besoin
d'un compte marchand FlexPay.

## Corrections

- Téléphone du profil normalisé avant la réservation : formes locales `089…`,
  nationales `89…`, internationales `243…`, `+243…` et `00243…` acceptées
  si elles correspondent à un numéro RDC valide par longueur et format.
  Le numéro de connexion du profil n'est pas modifié. Le format envoyé à FlexPay est `243…`.
- Un refus HTTP explicite `400/401/403/404/405/422` n'est plus traité comme
  une livraison incertaine. La transaction passe en échec et le service de
  règlement applique cet échec au retrait, libérant le montant réservé.
- Les délais dépassés, erreurs réseau, 5xx et réponses non interprétables
  restent en attente. Les autres statuts HTTP, dont 408 et 429, sont conservés
  par prudence comme incertains. Aucun renvoi automatique d'argent.
- Une erreur de sauvegarde après acceptation de FlexPay ne doit pas rendre les
  fonds disponibles pour un second envoi.
- Les réponses au conducteur contiennent `reference` et `requiresReview`.
  Les messages de versement ne demandent plus de valider un paiement au téléphone.
- Une insuffisance de fonds du marchand ne demande pas au conducteur de recharger
  son propre compte. Les messages techniques et secrets ne sont pas présentés
  dans le message de versement.
- Verrou du compte conducteur, identité approuvée, disponibilité du solde et
  idempotence existants conservés. Deux représentations équivalentes du même
  numéro sont maintenant comparées sous leur forme canonique.

## Configuration de production

En `NODE_ENV=production`, configurer explicitement `FLEXPAY_PAYOUT_SERVICE_URL`
ou `FLEXPAY_MOBILE_BASE_URL`. Le service refuse les URL de versement qui ne
ciblent pas `merchantPayOutService` et impose HTTPS en production. Il refuse
également un callback local ou non HTTPS en production.

Vérifier, sans journaliser les valeurs secrètes :

1. URL du service marchand fournie par FlexPay et environnement correct.
2. `FLEXPAY_TOKEN` et `FLEXPAY_MERCHANT_CODE` du compte Zwanga, droits de versement
   activés et fonds disponibles sur ce compte.
3. Callback public avec le préfixe API correct, via
   `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL` ou la base publique existante.
4. URL de vérification cohérente avec l'environnement des versements.
5. `FLEXPAY_VERIFY_CALLBACKS=true`, migrations d'idempotence antérieures
   appliquées, tâche de rapprochement active.

Ces valeurs réelles et l'activation du compte ne sont pas vérifiables avec les
tests unitaires. Aucun `.env`, paramètre SSM ou environnement distant n'a été modifié.

## Cas historiques et limites

Les anciennes opérations en attente sans numéro de commande ne sont pas
libérées par ce correctif. La documentation fournie ne décrit pas de recherche
par référence interne seule. L'assistance doit les rapprocher avec FlexPay avant
toute nouvelle tentative ou modification de solde.

Le rapprochement existant traite les opérations munies d'un `orderNumber` toutes
les cinq minutes. Ne pas désactiver la vérification des callbacks pour débloquer
un versement. Ne pas créer une migration qui annule tous les retraits en attente.

## Livraison et tests

Le correctif de septembre n'ajoutait pas de migration ; celui du 3 octobre en
ajoute une, décrite plus haut. Déployer d'abord le backend avec sa configuration
validée, puis l'application mobile. Celle-ci conserve une intention de versement
sur le téléphone avant envoi et réutilise sa clé après une réponse perdue.

Les suites `payout-flow.spec.ts`, `driver-payout-recovery.spec.ts`,
`flexpay.service.spec.ts`, `payments.service.spec.ts` et
`driver-settlements.service.spec.ts` utilisent des transports et une base simulés.
Un test autorisé dans l'environnement marchand réel reste nécessaire avant
d'annoncer la résolution de l'incident de production.
