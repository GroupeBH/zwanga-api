# Versements conducteur : correctif du 15 septembre 2026

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

Aucune nouvelle migration. Déployer d'abord le backend avec sa configuration
validée, puis l'application mobile. Celle-ci conserve une intention de versement
sur le téléphone avant envoi et réutilise sa clé après une réponse perdue.

Les suites `payout-flow.spec.ts`, `driver-payout-recovery.spec.ts`,
`flexpay.service.spec.ts`, `payments.service.spec.ts` et
`driver-settlements.service.spec.ts` utilisent des transports et une base simulés.
Un test autorisé dans l'environnement marchand réel reste nécessaire avant
d'annoncer la résolution de l'incident de production.
