# Confirmation du cash et notation native — 22 septembre 2026

## Problème

`paymentStatus = not_required` pour une réservation cash signifie paiement hors
plateforme, pas encaissement réel. La dépose n'est pas une preuve de réception.
Pour solliciter une notation de l'application après un trajet réussi et payé,
l'utilisateur a demandé une confirmation explicite du cash par le conducteur.

## Solution

- `bookings/cash-receipts.controller.ts` expose `PUT /bookings/:id/cash-receipt`,
  authentifié et limité en fréquence. Le corps contient le montant et la devise
  montrés au conducteur, jamais un identifiant de conducteur faisant autorité.
- `cash-receipts.service.ts` vérifie le propriétaire du trajet, le cash,
  la dépose et la réservation terminée. Une requête UPDATE paramétrée revérifie
  les conditions, y compris montant/devise, sous le verrou de ligne PostgreSQL.
  `COALESCE` conserve le premier reçu lors de doubles appuis et retries.
- Trois colonnes nullable : date `timestamptz`, conducteur `uuid`, montant
  `numeric(10,2)`. Le guide `supabase-postgres-best-practices` a orienté ces types
  et la restriction à une écriture atomique sans appel externe sous verrou.
- Les colonnes ont `update: false` dans l'entité : un save ORM basé sur une copie
  antérieure ne peut pas effacer le reçu. Le service dédié seul les écrit.
- Une contrainte lie le reçu au cash, au montant payé hors plateforme et au
  statut `not_required`. Elle protège aussi contre une modification concurrente
  du mode ou du montant. `BookingsService.updatePaymentMode` refuse explicitement
  de changer un mode dont le cash a déjà été déclaré reçu.
- Les caches sont invalidés. La projection `activity/activity.service.ts` inclut
  les nouveaux champs dans les révisions conducteur/passager. Le mobile observe
  les mêmes données RTK Query, sans nouveau polling de notation.

## Comportements conservés

Aucun débit, crédit, transfert FlexPay, règlement conducteur, paiement en jetons
ou recalcul de subvention n'est exécuté par cette confirmation. Aucun ancien
cash n'est confirmé automatiquement. Les états électroniques et les dates
`paidAt` restent inchangés. La déclaration du conducteur n'est pas une preuve bancaire.
Un trajet interrompu peut avoir un reçu cash valide, mais le mobile ne le compte
pas comme trajet complet éligible à la sollicitation automatique.

## Déploiement

Migration `1780000039000-AddCashReceipts.ts`, enregistrée dans le registre des
migrations. Appliquer avant le code backend lisant les colonnes ; les anciennes
applications continuent à fonctionner, sans pouvoir confirmer le cash.
Aucun backfill. Acquisition du verrou DDL limitée à cinq secondes ; tester la
validation de contrainte sur staging. Le rollback détruit les reçus ajoutés et
ne doit pas être exécuté sans sauvegarde/décision explicite.

Le mobile nécessite de nouveaux builds iOS/Android pour `expo-store-review`.
Le comptage, les seuils 1/10/20, les trois tentatives sur 365 jours et la trace
par compte sont locaux dans AsyncStorage ; ce backend ne stocke pas les avis
Apple/Google et n'affirme pas qu'une fenêtre a été affichée ou un avis publié.

## Vérifications et limites

`cash-receipts.spec.ts`, `activity.spec.ts` et `booking-activity.spec.ts` :
20 tests réussis avec repositories simulés. Contrôle final TypeScript backend
sans émission réussi ; résultats complets documentés dans le journal mobile.
Pas de migration exécutée sur une base réelle, pas de déploiement, pas d'essai
physique ni de preuve d'absence de freeze. Les courses concurrentes sont simulées
et doivent aussi être éprouvées contre PostgreSQL sur staging.

Documentation complète côté application : `docs/NATIVE_STORE_REVIEW.md` et
`docs/CHANGEMENTS_TECHNIQUES.md` dans le dépôt mobile `zwanga`.
