# Journal des modifications financières

Ce fichier répertorie les changements qui influencent un prix, un paiement, un solde, une commission, une récompense ou un retrait.

## 25 août 2026

### FIN-REF-005 — Accès profil et fiabilisation du partage

Statut : implémenté dans l'application mobile.

Résumé : l'espace de parrainage est désormais accessible depuis une carte mise en évidence sur le profil. Elle affiche le nombre de filleuls et le solde de jetons disponible. Le partage recharge le résumé si nécessaire, valide le lien HTTPS et ouvre la feuille de partage native avec un état de chargement. Toute indisponibilité produit maintenant un message visible au lieu d'une absence de réaction.

Impacts financiers et d'attribution :

- aucune modification du taux de 5 %, de la durée de douze mois, des soldes ou des règles de retrait ;
- aucun mouvement de jetons n'est effectué par l'affichage de la carte ou le partage ;
- les invitations WhatsApp et SMS utilisent obligatoirement le lien personnel validé ;
- le lien générique sans attribution n'est plus utilisé lorsque le résumé manque ;
- le partage reste disponible lorsque l'utilisateur refuse l'accès à ses contacts ;
- les erreurs de réseau, de configuration ChottuLink ou de lien invalide sont exposées à l'utilisateur.

Documentation : [referral-program.md](./referral-program.md).

### FIN-REF-004 — Gains détaillés par filleul

Statut : implémenté dans le backend et l'application mobile.

Résumé : le parrain voit ses filleuls directs et la commission cumulée générée par chacun. Le détail sépare les jetons en attente, les jetons libérés et les commissions inversées, sans révéler le montant ni le détail des paiements effectués par le filleul.

Impacts financiers et de confidentialité :

- le total gagné exclut toujours les récompenses `reversed` ;
- l'équivalent monétaire utilise la valeur actuelle du jeton dans la devise de retrait ;
- une récompense n'est comptée qu'une fois grâce à l'unicité financière existante par source ;
- les retraits du parrain ne réduisent pas le cumul historique attribué au filleul ;
- seuls le prénom et l'initiale du nom du filleul sont exposés au parrain ;
- aucun prix de course, abonnement, moyen de paiement ou identifiant de transaction du filleul n'est renvoyé dans cette liste.

Documentation : [referral-program.md](./referral-program.md).

### FIN-REF-003 — Remplacement de Branch par ChottuLink

Statut : implémenté dans le code ; configuration ChottuLink, migration et nouveaux builds natifs requis.

Résumé : ChottuLink remplace Branch pour la création, le partage et la résolution différée des liens de parrainage. Les règles financières, le taux de 5 %, la retenue et la fenêtre de rémunération de douze mois sont inchangés.

Impacts financiers et d'audit :

- séparation stricte entre la clé REST secrète du backend et la clé Mobile SDK ;
- migration des colonnes spécifiques à Branch vers des colonnes génériques de lien ;
- invalidation des anciennes URL Branch mises en cache, sans suppression des attributions historiques ;
- nouvelles attributions enregistrées avec `attributionProvider = chottulink` ;
- conservation du premier lien valide et du rattachement immuable ;
- aucun recalcul de commission, aucun mouvement de solde et aucune récompense rétroactive.

Documentation : [referral-program.md](./referral-program.md) et [chottulink-referral-setup.md](./chottulink-referral-setup.md).

### FIN-REF-002 — Lien Branch et attribution différée automatique

Statut : remplacé par `FIN-REF-003` avant mise en production.

Résumé : le code à saisir est remplacé dans l'application par un lien d'invitation Branch. Le premier clic valide est conservé jusqu'à 30 jours et transmis automatiquement lors d'une inscription téléphone, Google ou Apple. Le rattachement financier existant, le taux de 5 % et la fenêtre de rémunération de douze mois ne changent pas.

Impacts financiers :

- nouveau jeton opaque par parrain, sans identifiant utilisateur exposé ;
- attribution auditée avec fournisseur, lien et date de capture ;
- validation serveur avant création du compte ;
- aucun rattachement rétroactif d'un compte déjà connecté ;
- règle premier lien valide gagnant et parrain toujours immuable ;
- `referralCode` conservé uniquement pour les anciens liens ;
- aucune commission ni aucun solde recalculé par la migration.

Documentation actuelle : [referral-program.md](./referral-program.md) et [chottulink-referral-setup.md](./chottulink-referral-setup.md).

## 24 août 2026

### FIN-REF-001 — Parrainage, commissions et retraits FlexPay

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : chaque utilisateur possède un code. Le parrain reçoit 5 % du prix total effectivement payé par FlexPay pour les abonnements et courses de son filleul pendant douze mois à partir du premier paiement éligible. Les gains restent en attente sept jours, sont séparés des jetons promotionnels et deviennent retirables par FlexPay à partir de 50 jetons avec KYC approuvé.

Impacts financiers :

- cinq nouvelles tables d'audit, de solde, de récompense et de retrait ;
- aucune attribution ni commission rétroactive ;
- unicité par source de paiement et verrous pessimistes ;
- compartiments `pending`, `available`, `reserved` et `withdrawn` ;
- inversion comptable sans suppression de l'écriture originale ;
- nouveau motif de transaction `referral_payout` ;
- réconciliation idempotente des callbacks et succès FlexPay tardifs ;
- application mobile alignée pour l'inscription, le partage, le suivi et le retrait.

Documentation complète : [referral-program.md](./referral-program.md).

## 21 août 2026

### FIN-BOOKING-001 — Paiement à l'arrivée et non-embarquement automatique

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : le moyen de paiement est choisi à la réservation sans débit. Le paiement électronique et le débit de jetons deviennent possibles uniquement après l'arrivée. Après 10 minutes d'attente et un départ d'au moins 150 mètres, une réservation jamais embarquée passe automatiquement à `no_show` uniquement si une position passager fraîche prouve qu'il est resté au point de récupération. Si son GPS reprend ensuite et prouve un mouvement partagé dans le véhicule pendant le trajet, le `no_show` est récupéré automatiquement sans paiement anticipé. Sans preuve GPS suffisante, elle devient `boarding_uncertain` à la destination, sans paiement.

Impacts financiers :

- aucun prépaiement avant la prise en charge ;
- aucun débit, revenu conducteur, fidélité ou futur gain de parrainage pour `no_show` ou `boarding_uncertain` ;
- règlement FlexPay initié après arrivée ;
- débit de jetons tenté après arrivée et laissé `pending` si le solde est insuffisant ;
- suppression de la fausse réconciliation mobile qui confirmait prise en charge et dépose à la destination ;
- déclenchement de l'automate par les positions REST d'arrière-plan comme par le WebSocket ;
- acceptation du GPS passager après `no_show` tant que le trajet reste actif ;
- récupération financièrement neutre de `no_show` vers `accepted` après preuve de mouvement partagé ;
- sérialisation par trajet des décisions déclenchées simultanément par REST et Socket.IO ;
- persistance conditionnelle des positions par horodatage afin qu'un échantillon dupliqué ou ancien n'écrase jamais le plus récent ;
- dépose automatique depuis le GPS conducteur à la destination après un embarquement persisté ;
- retrait des confirmations manuelles des écrans conducteur et passager ;
- audit des méthodes de détection d'embarquement et de dépose ;
- conservation des montants ajustés lors d'une interruption ;
- affichage du montant serveur dans le modal passager de fin de trajet et bouton **Payer avec FlexPay** pour les réservations électroniques encore impayées.

Documentation complète : [booking-payment-at-arrival-and-automatic-no-show.md](./booking-payment-at-arrival-and-automatic-no-show.md).

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
