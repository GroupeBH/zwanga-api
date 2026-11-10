# Avance cash unique : six premiers trajets

## Règle validée

Cette modification remplace le projet local de trois trajets gratuits jusqu'au 20 janvier 2027. Il n'existe plus de date de fin ni d'exonération : la commission reste de 5 %.

- Le conducteur peut engager ses six premiers trajets cash avec passagers sans préfinancer toute la commission. Les jetons déjà disponibles restent utilisés en priorité ; le complément est enregistré comme dette.
- Après ces six trajets, les nouvelles admissions cash exigent une dette régularisée et la totalité des jetons nécessaires. L'ancienne tolérance cumulée de 25 jetons ne s'ajoute pas à cette règle.
- Le règlement ne renouvelle jamais l'avance. Les jetons reçus régularisent les commissions via le mécanisme comptable existant.
- Un trajet partagé compte une seule fois, mais chaque réservation conserve sa commission. Les trajets électroniques/en jetons, les publications sans passagers et les auto-réservations ne donnent pas droit à une avance cash supplémentaire.
- Les encaissements cash historiques comptent. Aucune commission historique n'est recalculée ni offerte rétroactivement.

## Contrôle transactionnel

La migration `DriverCashSixTripCredit1780000118000` ajoute `driver_cash_credit_trips` et relie chaque commission admise à son droit d'avance. Le verrou du portefeuille existant sérialise les admissions : au maximum six trajets peuvent consommer ou réserver le droit simultanément.

Une réservation acceptée ou une demande attribuée réserve une place. La clôture avec passager déposé et encaissement confirmé consomme définitivement cette place. L'absence de confirmation conserve la réservation, sans autoriser un septième trajet à crédit. Une annulation avant encaissement libère la place. Une annulation ultérieure ne supprime pas un droit déjà consommé. La demande et son trajet créé ensuite partagent le même identifiant logique, sans double dette ni double compteur.

Les courses déjà acceptées peuvent se terminer. Les portefeuilles bloqués ne deviennent pas éligibles. Les seuils et les montants envoyés par le mobile ne font pas autorité.

Les nouvelles réservations de demande et les nouvelles vérifications de publication utilisent 10 FC/jeton, comme le backend actuel ; les anciennes commissions gardent leur conversion enregistrée. Les transactions restent locales à PostgreSQL, sans appel fournisseur sous verrou. Les recommandations du skill PostgreSQL ont guidé la réutilisation du verrou, les contraintes et la limitation des transactions.

## API et mobile

`GET /driver-finance/me` expose `cash.creditAllowance` : `eligible`, `remainingTrips`, `completedTrips`, `reservedTrips`, `tripLimit: 6`, `oneTime: true`. `remainingTrips` déduit les trajets en cours. `completedTrips` compte les encaissements confirmés, plafonnés à six. `cashCommissionRate` reste à `0.05`. L'avance n'est pas un solde de jetons fictif.

Le montant de dette en FC est calculé avec la conversion propre à chaque commission, y compris les anciennes. Comme auparavant, les obligations engagées par les réservations actives peuvent faire partie du montant à couvrir.

Le rappel enrichit la notification d'encaissement conducteur existante : montant de la commission, cumul à régulariser et compteur `/6`. Le déclencheur `cash_credit_receipt_notice` ne crée pas une seconde notification ; la clé d'événement existante protège les doubles clics/rejeux. Le message du passager reste inchangé. Le mobile affiche aussi un rappel avant confirmation du cash, ainsi que les conditions dans la publication, l'acceptation et le portefeuille, sans refonte de styles.

## Livraison et retour arrière

Travail local uniquement : aucune migration appliquée à une base applicative, aucun push GitHub, changement AWS ou transfert réel.

Avant activation : sauvegarde et recette sur une base de préproduction, appliquer les migrations précédentes puis `1780000118000`, livrer le backend, puis la version mobile correspondante. Le mécanisme `financial_rollout` existant n'est pas activé par cette migration. Ne pas charger ce backend avant la création de ses fonctions SQL.

Un ancien mobile peut encore refuser une acceptation sans réserve : sa mise à jour est nécessaire pour bénéficier de l'avance dans tous les parcours. Le nouveau mobile conserve la compatibilité de calcul avec les anciennes réponses serveur, sans inventer un droit aux six trajets lorsqu'il est absent.

Le retour arrière SQL restaure les fonctions précédentes si la nouvelle politique n'a pas été utilisée. Dès qu'un droit existe, il refuse d'effacer l'historique financier : utiliser une migration corrective, pas un rollback destructif.

## Vérifications

Les tests ciblés couvrent la concurrence, la septième admission, les remboursements partiels/complets, les trajets partagés, les annulations, le transfert demande/réservation, les encaissements, les doubles soumissions et la compatibilité mobile. Le cluster PostgreSQL de test est jetable et n'utilise pas `.env`.

- PostgreSQL réel isolé : **123 tests réussis**, 3 scénarios préexistants ignorés (diagnostic d'anciennes versions). Quinze scénarios couvrent spécifiquement la nouvelle avance.
- API/projections, politique, ordre des migrations, reçus et erreurs : **48 tests réussis**, 5 suites.
- Mobile : **54 tests JavaScript réussis**, 8 fichiers, dont nouveaux contrôles de la sixième/septième admission, remboursement sans renouvellement et affichage de dette.
- TypeScript backend et mobile : réussi. ESLint ciblé sur les sources modifiées et le nouveau banc PostgreSQL : réussi. `git diff --check` backend : réussi.
- Deux reprises ont dépassé les 30 secondes de création du cluster jetable. Le délai du banc a été aligné sur celui du helper existant (60 secondes, initialisation globale 90 secondes), sans modifier les assertions, les délais métier ou la configuration applicative. La dernière exécution PostgreSQL, incluant les demandes gratuites qui ne consomment pas le droit, réussit en environ 92 secondes.

Les tests JavaScript ne constituent pas une validation native Android/iOS ni un test réel de livraison FCM. La suite complète du dépôt et les services de production ne sont pas validés par cette seule campagne.
