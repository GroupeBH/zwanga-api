# Documentation financière de Zwanga

Dernière mise à jour : 26 août 2026

## Objectif

Ce répertoire est la référence fonctionnelle et technique de toute modification qui peut créer, déplacer, convertir, bloquer, rembourser ou retirer une valeur financière dans Zwanga.

Il couvre notamment :

- les paiements FlexPay ;
- les prix des courses et des abonnements ;
- les commissions Zwanga ;
- les revenus et retraits des conducteurs ;
- les jetons Zwanga (identifiants techniques historiques `points`/`PTS`) ;
- les ajustements et remboursements ;
- le système de parrainage et ses retraits ;
- les taux de conversion et toute configuration qui modifie un montant.

Une modification financière n'est considérée comme terminée que si sa documentation et son entrée dans le journal des changements sont à jour.

## Distinction obligatoire entre les valeurs

### Argent réel

Les montants CDF ou USD encaissés ou décaissés par FlexPay représentent de l'argent réel. Ils sont suivis dans `payment_transactions` et dans les entités métier associées.

### Jetons Zwanga

Les jetons sont une unité interne du portefeuille `POINTS`. Les identifiants `points` et `PTS` sont conservés pour la compatibilité technique, mais l'appellation visible est « jetons Zwanga ». Leur valeur monétaire est configurable et ne doit jamais être supposée à partir du nom de l'unité.

La configuration livrée indique `1 jeton = 100 CDF`. La configuration effective de chaque environnement doit tout de même être vérifiée avant un déploiement financier.

### Gains de parrainage

Les gains de parrainage sont séparés des jetons d'usage. Ils représentent une créance retirable en CDF, répartie entre les compartiments `pending`, `available`, `reserved` et `withdrawn`. Le taux, la valeur du jeton et les montants utilisés sont figés sur chaque opération financière.

## Invariants comptables

Toute évolution financière doit respecter les règles suivantes :

1. Un montant affiché au client est recalculé côté serveur avant d'être enregistré ou payé.
2. Une même source financière ne peut produire qu'une seule écriture de crédit ou de débit du même type.
3. Les callbacks externes doivent être idempotents.
4. Une écriture comptable existante n'est pas supprimée pour corriger un solde ; une écriture inverse est ajoutée.
5. Le montant, la devise, le taux et la source utilisés par un calcul sont conservés lorsque le résultat devient retirable.
6. Un retrait ne peut jamais dépasser le solde disponible après prise en compte des sommes déjà bloquées.
7. Les montants en attente ne sont ni dépensables ni retirables.
8. Une modification de tarif ne change pas rétroactivement les transactions déjà confirmées.
9. Toute migration financière possède une méthode `down`, une stratégie de déploiement et une procédure de rapprochement.
10. Tout endpoint public de callback est limité, vérifié et relié à une transaction interne connue.

## Registre des documents

- [Choix du véhicule et tarification d'une demande de trajet](./trip-request-vehicle-pricing.md)
- [Type obligatoire à la création d'un véhicule](./vehicle-type-registration.md)
- [Expiration douze heures après la fin de la plage de départ](./trip-request-response-expiration.md)
- [Nombre de places facultatif dans une demande](./trip-request-optional-seat-count.md)
- [Jetons Zwanga et bonus de 25 jetons après paiement d'abonnement](./token-denomination-subscription-reward.md)
- [Paiement à l'arrivée, progression automatique et non-embarquement](./booking-payment-at-arrival-and-automatic-no-show.md)
- [Règlement atomique des courses payées en jetons](./atomic-token-trip-settlement.md)
- [Versement Mobile Money des revenus conducteur](./driver-electronic-trip-payout.md)
- [Notification du montant conducteur à la fin du trajet](./driver-trip-revenue-notification.md)
- [Parrainage, commissions de 5 % et retraits FlexPay](./referral-program.md)
- [Configuration ChottuLink du lien de parrainage automatique](./chottulink-referral-setup.md)
- [Journal des modifications financières](./CHANGELOG.md)

Les documents détaillés du paiement, des jetons et du parrainage sont enrichis en même temps que les lots correspondants.

## Contenu exigé pour chaque modification

Chaque modification financière doit documenter :

- l'identifiant du changement ;
- le besoin métier ;
- le comportement avant et après ;
- les fichiers et tables touchés ;
- la formule exacte et les règles d'arrondi ;
- les devises et conversions ;
- les états métier ;
- les contrôles d'autorisation et de fraude ;
- l'idempotence et la concurrence ;
- les conséquences sur les remboursements ;
- les endpoints et exemples de contrats ;
- les variables d'environnement ;
- les tests ;
- le déploiement, le rapprochement et le retour arrière ;
- les limitations ou décisions encore ouvertes.

## Validation avant mise en production

Pour toute livraison touchant à l'argent :

- exécuter les tests unitaires concernés ;
- exécuter le build TypeScript ;
- appliquer la migration sur une copie de la base ;
- comparer les soldes calculés aux écritures de registre ;
- vérifier les valeurs réelles des variables d'environnement ;
- effectuer au moins un scénario de succès, échec, callback répété et remboursement ;
- confirmer que les logs ne divulguent ni jeton FlexPay ni donnée de paiement sensible.
