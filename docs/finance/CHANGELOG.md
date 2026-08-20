# Journal des modifications financières

Ce fichier répertorie les changements qui influencent un prix, un paiement, un solde, une commission, une récompense ou un retrait.

## 20 août 2026

### FIN-TRIP-004 — Expiration douze heures après la fin de la plage de départ

Statut : implémenté.

Résumé : toute demande `pending` ou `offers_received` expire à `departureDateMax + 12 heures` tant qu'aucun conducteur n'a été accepté. Une simple offre ne maintient plus la demande ouverte indéfiniment. Le Home possède le même filtre défensif fondé sur la fin de la plage de départ.

Impacts financiers :

- aucun paiement, solde ou jeton n'est modifié ;
- aucun prix de demande historique n'est recalculé ;
- les demandes anciennes sans acceptation passent à `expired` au cron ou à la prochaine lecture ;
- les demandes associées à un conducteur accepté ou à un trajet sont protégées.

Cette règle remplace `FIN-TRIP-002`.

Documentation complète : [trip-request-response-expiration.md](./trip-request-response-expiration.md).

### FIN-WALLET-001 — Jetons Zwanga et bonus d'abonnement

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : l'appellation utilisateur « points » devient « jetons ». Chaque abonnement Pro payé et confirmé crédite exactement 25 jetons, une seule fois par abonnement.

Impacts financiers :

- nouvelle écriture `subscription_reward` de `+25` ;
- aucun bonus pour les essais, paiements en attente, échoués ou annulés ;
- index unique et verrou du portefeuille contre le double crédit ;
- paiement de l'abonnement en jetons éligible au même bonus ;
- aucune modification en masse des soldes ou transactions historiques ;
- aucun changement du taux de conversion existant.

Documentation complète : [token-denomination-subscription-reward.md](./token-denomination-subscription-reward.md).

## 19 août 2026

### FIN-TRIP-003 — Nombre de places facultatif dans une demande

Statut : implémenté.

Résumé : `numberOfSeats` peut être omis lors de la création d'une demande. Le serveur enregistre alors une place par défaut afin de conserver des calculs tarifaires, des offres et des réservations déterministes.

Impacts financiers :

- aucun tarif par kilomètre ou par place n'est modifié ;
- le champ omis produit le même prix total qu'une place explicitement demandée ;
- aucun paiement, solde, jeton ou gain de parrainage existant n'est recalculé ;
- aucune migration de données n'est nécessaire.

Documentation complète : [trip-request-optional-seat-count.md](./trip-request-optional-seat-count.md).

### FIN-TRIP-002 — Expiration après deux heures sans réponse

Statut : remplacé le 20 août 2026 par `FIN-TRIP-004`.

Résumé : une demande `pending` expire désormais à `createdAt + 2 heures` seulement lorsqu'aucune offre conducteur n'a été enregistrée. La plage de départ souhaitée ne sert plus de date d'expiration.

Impacts financiers :

- aucun montant, paiement, solde ou jeton n'est modifié ;
- une demande tarifée peut rester visible plus longtemps qu'avant ;
- une demande ayant déjà reçu une offre n'expire plus automatiquement ;
- les prix et transactions existants ne sont pas recalculés.

Documentation complète : [trip-request-response-expiration.md](./trip-request-response-expiration.md).

### FIN-VEH-001 — Type obligatoire à la création d'un véhicule

Statut : implémenté.

Résumé : toute création de véhicule exige désormais un choix explicite parmi `car`, `motorcycle_2_wheels` et `motorcycle_3_wheels`. Les mêmes valeurs sont envoyées depuis l'inscription téléphone, Apple, Google, le profil et la publication d'un trajet.

Impacts financiers :

- aucune transaction, aucun solde et aucun paiement existant ne sont modifiés ;
- la suppression du défaut implicite `car` protège la correspondance entre le véhicule réel et le type qui détermine le tarif d'une demande ;
- la grille tarifaire et les formules de `FIN-TRIP-001` restent inchangées ;
- les véhicules historiques ne sont pas reclassés.

Documentation complète : [vehicle-type-registration.md](./vehicle-type-registration.md).

## 18 août 2026

### FIN-TRIP-001 — Choix du type de véhicule et prix associés

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : le passager peut obtenir les trois choix de véhicules et leurs prix pour un même itinéraire, puis enregistrer explicitement son choix dans la demande. Les conducteurs ne peuvent proposer ou utiliser qu'un véhicule du type choisi.

Impacts financiers :

- le prix recommandé dépend maintenant explicitement du type persisté ;
- le serveur reste la source du calcul ;
- le choix est conservé jusqu'à la création du trajet et de la réservation ;
- aucun encaissement existant n'est modifié rétroactivement ;
- les anciennes demandes sont migrées vers `car`.

Documentation complète : [trip-request-vehicle-pricing.md](./trip-request-vehicle-pricing.md).

### DOC-FIN-001 — Gouvernance documentaire financière

Statut : implémenté.

Résumé : création de la documentation financière obligatoire, de ses invariants et du présent journal. Ce changement ne modifie aucun solde et ne déclenche aucun paiement.

## Changements planifiés

### FIN-REF-001 — Parrainage

Statut : planifié, non implémenté.

Portée prévue : codes de parrainage, attribution d'un parrain, récompenses sur le revenu Zwanga, période d'attente, registre comptable séparé et retraits Mobile Money.

Le détail sera ajouté avant toute migration ou écriture de récompense.
