# Crédit des subventions cash et fiabilité du récapitulatif

Date : 18 septembre 2026. Correctif préparé localement, non déployé par cette intervention.

## Incident confirmé

Dans CloudWatch, le 17 septembre à 21:09:46 UTC (22:09:46 à Kinshasa),
l'insertion d'un gain de 3 000 CDF, mode `cash`, a été refusée par
`CHK_driver_earnings_payment_mode`. L'application présentait néanmoins « Gain ajouté ».

La règle reste inchangée : pour un premier trajet à 5 000 CDF, le passager
doit 2 000 CDF en cash (40 %), Zwanga finance 3 000 CDF (60 %).
`FIRST_TRIP_PASSENGER_PAYMENT_RATE=0.40` est correct et n'a pas été modifié.
Le cash remis au conducteur n'est pas crédité une seconde fois dans ses revenus.

## Correctifs serveur

- La migration `1780000037000-AddTripLoyaltyAndCashSubsidyEarnings`, déjà préparée,
  autorise `cash` dans la contrainte du registre des gains. Elle conserve la
  contrainte unique par réservation. Aucun solde ni prix n'est réécrit par la migration.
- Un délai de verrouillage de cinq secondes fait échouer la migration plutôt que
  de laisser une attente de verrou prolongée bloquer le trafic. La migration doit
  être exécutée transactionnellement par le mécanisme TypeORM existant.
- `cash-subsidy-settlement.ts` relit la réservation sous verrou transactionnel
  `FOR UPDATE`. Le montant utilisé est la subvention persistée, jamais une nouvelle
  estimation ni le tarif actuel du trajet.
- Il vérifie que le montant total est égal à la somme passager + subvention,
  au centime. Une incohérence est signalée et n'est pas « corrigée » automatiquement.
- Un crédit existant, y compris annulé ou déjà payé, n'est ni dupliqué ni réactivé.
- La notification d'un crédit de fin de trajet n'est envoyée qu'après COMMIT.
  L'audit `CASH_SUBSIDY_COMMITTED bookingId=… net=…` est visible au niveau warn
  actuellement activé en production.

## Reprise automatique autorisée

L'utilisateur a explicitement autorisé la reprise automatique le 18 septembre.
Après déploiement, `CashSubsidyRecoveryService` examine au plus 50 réservations
toutes les cinq minutes : mode cash, subvention positive déjà enregistrée,
statut accepté ou terminé avec dépose/fin effective, aucun gain existant.

Le service appelle le même chemin verrouillé que l'arrivée normale. Deux instances
ECS ou une arrivée simultanée ne doivent créer qu'un crédit. Le curseur tourne
entre les lots pour qu'une anomalie permanente ne bloque pas les suivants.
L'index partiel `IDX_bookings_cash_subsidy_recovery` et l'index unique des gains
évitent le chargement de tout l'historique à chaque passage.

Il ne lance aucun transfert FlexPay, ne prélève aucun jeton, ne marque aucun
paiement cash comme reçu et ne recalcule pas les prix. Une réservation annulée,
non embarquée, non terminée, gratuite ou sans subvention n'est pas créditée.
Les erreurs restent visibles sous `CASH_SUBSIDY_RECOVERY_FAILED` ; elles nécessitent
une vérification manuelle si les montants sont incohérents.

## Contrat API et application mobile

Le résumé financier charge les gains enregistrés en une requête par trajet :

- `ledgerVerified: true` atteste que le registre a été consulté ;
- `confirmedAmount` somme les crédits disponibles ou déjà payés, pas les estimations ;
- `creditPendingAmount` indique les subventions cash ou paiements déjà réussis
  dont le crédit conducteur manque encore ;
- `cashToCollectAmount` reste le montant dû directement par le passager ;
- `electronicPendingAmount` reste séparé pour les paiements non confirmés.

Sans crédit enregistré : 0 confirmé + 3 000 en attente + 2 000 cash = 5 000 CDF.
Après crédit : 3 000 confirmés + 0 en attente + 2 000 cash = 5 000 CDF.
Un gain annulé n'est pas présenté comme un nouveau crédit en attente.

Le mobile partage la présentation entre le modal de navigation et les notifications.
Un ancien serveur sans `ledgerVerified` produit « Gain à vérifier », jamais
« Gain ajouté ». Les notifications invalident le cache RTK Query des revenus.
Le crédit cash est identifié comme participation Zwanga dans l'historique des gains.

Une réservation cash terminée avec `paymentStatus=not_required` n'émet plus
de notification « paiement passager confirmé ». L'arrivée et `updatedAt` ne sont
pas des justificatifs de remise d'espèces. Les confirmations électroniques/jetons
avec statut `succeeded` restent affichées, sans attribuer une action au passager.

## Déploiement et vérification

1. Inclure les nouveaux fichiers, dont la migration encore non suivie initialement,
   dans la livraison backend. Le registre `databaseMigrations` l'inclut déjà.
2. Exécuter les tests et déployer via le workflow existant, qui exécute les
   migrations avant le remplacement du service ECS. Ne pas activer `synchronize`.
3. Vérifier la réussite de la migration et la présence du cron dans le nouveau backend.
4. Observer `CASH_SUBSIDY_RECOVERY` et `CASH_SUBSIDY_COMMITTED`. Pour l'incident,
   la réservation `67b8afe6-a7d8-43e0-8dff-84abebf3d517` doit avoir exactement un gain
   de 3 000 CDF, sans modifier les 2 000 CDF dus en cash.
5. Vérifier Revenus puis publier le correctif mobile. Le déploiement backend est
   indispensable : une mise à jour mobile seule ne change pas la contrainte SQL.

Aucune migration ni régularisation n'a été exécutée en production pendant cette
intervention. Les tests automatisés utilisent des dépôts simulés ; une vérification
sur PostgreSQL et sur appareils reste nécessaire avant/après livraison.

## Retour arrière

La méthode `down` refuse le retrait de la contrainte si des crédits cash ou crédits
de fidélité associés existent. Ne jamais supprimer ces écritures pour forcer le rollback.
En cas d'anomalie, suspendre le service de reprise et auditer les réservations ;
aucun script de suppression ou de remise à zéro de solde n'est prévu.
