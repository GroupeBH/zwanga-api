# Fidélité des trajets terminés

Statut : implémenté localement le 17 septembre 2026 ; migration et déploiement requis. Aucun crédit de production exécuté.

## Règle

| Bénéficiaire / situation | Jeton de base | Bonus |
| --- | --- | --- |
| Conducteur, trajet démarré puis terminé | 1 par trajet | Aucun |
| Passager transporté, paiement cash ou trajet gratuit | 1 par trajet | Aucun |
| Passager transporté, paiement jetons/électronique en attente ou échoué | 1 par trajet | Aucun tant que le paiement n'a pas réussi |
| Passager transporté, paiement jetons/électronique réussi et montant positif | 1 par trajet | Distance, sinon prix |
| Réservation annulée, rejetée, expirée, `no_show`, `boarding_uncertain` ou non terminée | 0 | Aucun |
| Trajet conducteur expiré sans démarrage | 0 | Aucun |

Le passager doit avoir une réservation `completed` et une preuve d'embarquement persistée (indicateur ou date). Sa dépose peut précéder la fin du trajet du conducteur. Le conducteur doit avoir un trajet `completed`, un `startedAt` et un `completedAt` cohérents. Une réservation de plusieurs places ne multiplie pas le jeton de base.

Le bonus existant reste réservé au **passager qui paie**. Avec les valeurs par défaut :

- Distance connue : `max(1, distance_en_km * 0.5)` jeton, arrondi à deux décimales.
- Sinon : 1 % du montant passager, converti en jetons (`ZWANGA_POINT_VALUE_CDF`, 100 CDF par défaut pour 1 jeton).
- Les deux bonus ne se cumulent pas. Un trajet gratuit n'ouvre pas droit à un bonus de paiement.

Exemple : 4,5 km en cash donne 1 jeton ; le même transport payé en jetons ou électroniquement donne 1 + 2,25 = 3,25 jetons au passager. Le conducteur reçoit 1 jeton pour son trajet.

`ZWANGA_LOYALTY_BASE_REWARD` est désormais ignorée : la base est fixée à 1, même si un ancien environnement contient 0 ou 5. Les paramètres `ZWANGA_LOYALTY_POINTS_PER_KM`, `ZWANGA_LOYALTY_MIN_REWARD`, `ZWANGA_LOYALTY_RATE` restent applicables au bonus. Leurs valeurs déployées peuvent différer des valeurs par défaut.

## Intégration et idempotence

- La base passager est créditée à la dépose, avant le règlement. Une erreur d'enregistrement du revenu conducteur n'annule pas ce crédit déjà validé.
- Les callbacks/paiements tardifs ajoutent seulement le bonus manquant, sans recréditer la base.
- Les fins de trajet manuelles et les deux branches de fin automatique créditent le conducteur. Une répétition de la fin manuelle vérifie le crédit manquant.
- Le registre conserve `type=loyalty_reward`, avec `relatedEntityType=trip_loyalty_base` ou `trip_loyalty_bonus` et `relatedEntityId=tripId`.
- Un verrou sur l'utilisateur sérialise les crédits, même à la création du portefeuille. Solde et écriture sont enregistrés dans la même transaction ; un index unique protège chaque combinaison utilisateur/trajet/composante.
- Les anciennes écritures `loyalty_reward` liées à une réservation du même trajet sont conservées : elles empêchent une nouvelle attribution passager lors d'une reprise.
- `TRIP_LOYALTY_COMMITTED` est journalisé après validation de la transaction, uniquement pour les nouvelles écritures.

## Migration et exploitation

La migration `1780000037000-AddTripLoyaltyAndCashSubsidyEarnings` ajoute l'index d'unicité et autorise `cash` dans `CHK_driver_earnings_payment_mode`. Le service ne crée toujours un gain cash que pour la part **subventionnée par Zwanga**, pas pour les espèces encaissées directement par le conducteur.

1. Valider la migration sur une base de test/staging.
2. L'appliquer dans la tâche de migration prévue par le déploiement, avant d'activer le nouveau backend.
3. Vérifier un trajet cash, un trajet électronique avec paiement tardif et une répétition des mêmes événements : base unique, bonus unique, aucun double crédit.
4. Contrôler les logs `TRIP_LOYALTY_COMMITTED` et le registre correspondant.

Aucun rattrapage en masse ni nouveau cron n'est ajouté. La migration ne modifie aucun solde et ne rejoue aucun paiement. Les trajets historiques affectés nécessitent un rapprochement ciblé, approuvé et idempotent ; un simple déploiement ne garantit pas leur régularisation.

Le rollback de schéma est refusé si des gains cash ou de nouvelles écritures de fidélité existent. Ne jamais supprimer des écritures financières pour forcer le retour arrière ; conserver le schéma et préparer un correctif compatible.

## Validation locale

- Suite Jest complète : 58 suites, 659 tests réussis.
- Compilation `npm run build` réussie.
- Contrôle `check-infra-documentation.sh HEAD WORKTREE` et `git diff --check` réussis.
- Tests des migrations limités au contrat SQL simulé : aucune migration exécutée sur PostgreSQL lors de cette validation. La validation staging reste nécessaire.
