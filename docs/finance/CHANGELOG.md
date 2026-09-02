# Journal des modifications financières

Ce fichier répertorie les changements qui influencent un prix, un paiement, un solde, une commission, une récompense ou un retrait.

## 1 septembre 2026

### KYC-DIDIT-002 — Typage explicite des colonnes KYC nullable

Statut : implémenté localement ; aucun changement de schéma SQL attendu, relance
de `migration:run` requise pour appliquer la migration Didit en attente.

Résumé : TypeORM refusait d'initialiser le DataSource PostgreSQL pendant
`migration:run` parce que certains champs nullable de `KycDocument`, notamment
`selfieUrl`, étaient inférés comme `Object` après leur typage TypeScript en
`string | null`. Les colonnes concernées déclarent maintenant explicitement leur
type SQL.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, jeton ou retrait ;
- aucun recalcul des dossiers KYC existants ;
- aucun changement de statut KYC existant ;
- correction bloquante pour permettre à TypeORM de lancer les migrations ;
- les retraits restent conditionnés par `kyc_documents.status = approved`.

Documentation complète : [kyc-didit-integration.md](./kyc-didit-integration.md).

### KYC-DIDIT-001 — Migration vers Didit comme fournisseur KYC

Statut : implémenté localement ; migration, variables Didit, configuration
webhook Didit, déploiement API, puis publication app/admin requis.

Résumé : le KYC peut désormais être lancé via une session Didit créée par le
backend, puis exécutée en priorité par le SDK React Native Didit dans l'app
mobile. Le backend crée la session avec `vendor_data = users.id`, synchronise la
décision côté serveur et reçoit les webhooks signés. Les modules financiers
continuent de lire `kyc_documents.status`, ce qui évite de casser les retraits
conducteur et parrainage.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, taux de conversion, solde ou montant ;
- l'app mobile utilise `session_token` avec le SDK Didit pour capturer la pièce
  d'identité et le visage/liveness ;
- l'URL Didit reste disponible en secours WebBrowser si le module natif n'est
  pas encore présent dans le build installé ;
- ajout de colonnes nullable dans `kyc_documents` pour tracer le fournisseur et
  la session Didit ;
- `approved` active le compte sauf suspension ;
- `pending` et `rejected` maintiennent le compte en `pending_kyc` sauf
  suspension ;
- les retraits restent conditionnés par un KYC `approved` ;
- `/users/kyc` reste disponible en compatibilité legacy ;
- `/users/kyc/didit/sync` ne fait jamais confiance au statut fourni par l'app
  pour approuver un KYC ;
- les webhooks Didit sont vérifiés par signature V2, avec secours simple
  limité aux sessions déjà connues localement ;
- les payloads sensibles Didit ne sont pas stockés intégralement.

Documentation complète : [kyc-didit-integration.md](./kyc-didit-integration.md).

### FIN-ADMIN-RBAC-002 — Bootstrap superadmin et création web des admins

Statut : implémenté dans le backend et l'administration web ; migration,
variables d'environnement de bootstrap, déploiement API et déploiement
`zwanga-admin` requis.

Résumé : le premier `super_admin` peut être créé par un flux OTP protégé par
clé de bootstrap. Une fois connecté, le `super_admin` peut créer les comptes
`admin` depuis `zwanga-admin` avec un mot de passe temporaire. Tous les comptes
créés par bootstrap ou par l'interface doivent changer ce mot de passe avant
d'accéder aux routes admin protégées par rôle.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, conversion ou formule ;
- nouvelle colonne `users.passwordChangeRequired` par défaut à `false` ;
- aucun compte existant n'est promu ou modifié par la migration ;
- création unique du premier `super_admin`, limitée au numéro configuré et
  protégée par OTP ;
- création ou promotion des comptes `admin` réservée au `super_admin` ;
- conversion possible d'un ancien compte `driver`/`passenger` en `admin`, sans
  suppression d'historique ni recalcul financier ;
- refus d'écraser un compte `admin` ou `super_admin` existant ;
- accès aux routes financières protégé tant que le mot de passe temporaire n'a
  pas été remplacé ;
- secrets de bootstrap à stocker dans Parameter Store/Secrets Manager puis à
  faire tourner après création.

Documentation complète : [admin-finance-access-control.md](./admin-finance-access-control.md) et [../admin-account-provisioning.md](../admin-account-provisioning.md).

## 31 août 2026

### FIN-ADMIN-RBAC-001 — Séparation admin / super administrateur

Statut : implémenté dans le backend et l'administration web ; migration de rôle, déploiement API et déploiement `zwanga-admin` requis.

Résumé : le back-office distingue désormais les administrateurs opérationnels du super administrateur. Le login web passe par `/auth/admin/login`, les comptes `admin` et `super_admin` sont acceptés dans `zwanga-admin`, et les actions financières sensibles restent réservées au super administrateur.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, conversion ou formule ;
- ajout de `super_admin` à l'énumération PostgreSQL des rôles utilisateur ;
- ajustements de jetons et rapprochements de retraits de parrainage réservés au `super_admin` ;
- lecture des pages Finance autorisée aux administrateurs simples ;
- interface web en lecture seule pour les actions sensibles lorsqu'un admin simple est connecté ;
- création des comptes back-office de secours par CLI avec mot de passe saisi en mode masqué ;
- refus du login admin pour les comptes `driver` et `passenger`.

Documentation complète : [admin-finance-access-control.md](./admin-finance-access-control.md).

### FIN-DRIVER-003 — Livraison fiable du gain conducteur

Statut : implémenté dans le backend et l'application mobile ; déploiement API et nouveaux binaires Android/iOS requis, sans migration.

Résumé : les notifications financières distinguent maintenant les tokens FCM natifs des `ExpoPushToken`, conservent les échecs critiques et les retentent toutes les cinq minutes pendant 72 heures. Lorsque l'application est ouverte hors de l'écran de navigation, le push de fin de trajet ouvre aussi un modal détaillant le total, le gain acquis, le liquide à encaisser et le paiement électronique attendu.

Impacts financiers et opérationnels :

- aucun changement de calcul, de commission, de solde ou de retrait ;
- notification persistée même lorsque le conducteur n'a momentanément aucun token ;
- livraison Expo pour iOS/Expo et Firebase pour les tokens natifs Android ;
- suppression conditionnelle des tokens déclarés invalides par le fournisseur ;
- reprise concurrente sûre avec `FOR UPDATE SKIP LOCKED`, réseau exécuté hors transaction ;
- aucun double modal avec le résumé temps réel de l'écran de navigation ;
- resynchronisation mobile automatique après rotation du token push ;
- aucune migration ni nouvelle variable d'environnement.

Documentation complète : [driver-trip-revenue-notification.md](./driver-trip-revenue-notification.md).

## 27 août 2026

### FIN-REF-008 — Fiabilisation PostgreSQL du rattachement

Statut : implémenté dans le backend ; déploiement API requis, sans migration.

Résumé : les rattachements ChottuLink échouaient en production parce que TypeORM combinait `FOR SHARE` avec la jointure externe utilisée pour charger le parrain. Le backend sérialise désormais chaque filleul avec un verrou transactionnel PostgreSQL et charge séparément le profil et l'utilisateur du parrain.

Impacts financiers et d'attribution :

- suppression des HTTP 500 déterministes sur `POST /referrals/me/attribution` ;
- rattachement atomique, immuable et idempotent, même pour un ancien compte sans profil ;
- sérialisation commune avec la création paresseuse du profil et du compte ;
- aucune double notification lors des reprises mobiles ;
- aucun changement du taux de 5 %, des soldes, de la retenue ou de la fenêtre de douze mois ;
- aucune migration, variable d'environnement ou modification Parameter Store.

Documentation complète : [referral-attribution-postgresql-hardening.md](./referral-attribution-postgresql-hardening.md).

### FIN-REF-007 — Fiabilisation mobile et comptes existants sans parrain

Statut : implémenté dans le backend et l'application mobile ; déploiement API et nouveaux binaires Android/iOS requis, sans migration.

Résumé : une invitation ChottuLink peut désormais rattacher un compte existant lorsque celui-ci ne possède pas encore de parrain. Le rattachement reste transactionnel, immuable et idempotent. Les App Links, Universal Links, attributions différées, caches de session, notifications et solutions de secours du partage ont été renforcés.

Impacts financiers :

- aucun changement du taux de 5 %, de la retenue de sept jours ou de la valeur du jeton ;
- aucune commission rétroactive avant le rattachement ;
- fenêtre de douze mois toujours déclenchée par le premier paiement éligible réussi ;
- aucun remplacement d'un parrain déjà enregistré ;
- aucune migration ni modification de solde ;
- nouvelle route authentifiée `POST /referrals/me/attribution`, limitée à dix appels par minute.

Documentation complète : [referral-attribution-reliability.md](./referral-attribution-reliability.md).

## 26 août 2026

### FIN-REF-006 — Administration globale du parrainage

Statut : implémenté dans le backend ; migration d'index et déploiement requis.

Résumé : la page **Finance > Parrainage** dispose désormais de routes administratives dédiées pour les comptes, les commissions et les retraits. Le rapprochement d'un retrait consulte FlexPay et réutilise le règlement idempotent existant sans permettre à l'opérateur de forcer un succès.

Impacts financiers et de confidentialité :

- aucun changement du taux de 5 %, de la retenue ou de la fenêtre de douze mois ;
- agrégats globaux des compartiments `pending`, `available`, `reserved` et `withdrawn` ;
- aucune exposition des tokens ChottuLink ou réponses FlexPay brutes ;
- rapprochement limité aux administrateurs et à cinq appels par minute ;
- chargement groupé évitant les requêtes N+1 ;
- index composites dédiés aux tris et filtres administratifs ;
- aucune nouvelle variable d'environnement ou ressource AWS.

Documentation complète : [admin-referral-management.md](./admin-referral-management.md).

### FIN-WALLET-ADMIN-001 — Consultation et ajustement audité des jetons

Statut : implémenté dans le backend et l'administration web ; migration et déploiement requis.

Résumé : les routes globales de consultation des portefeuilles et du registre alimentent désormais la page **Finance > Jetons**. Les ajustements exceptionnels utilisent un verrou pessimiste, une transaction unique, un motif obligatoire et un UUID d'idempotence protégé par un index unique.

Impacts financiers :

- aucune modification de la valeur d'un jeton ni conversion monétaire ;
- lecture globale paginée et utilisateurs assainis ;
- crédit ou débit manuel plafonné, sans solde négatif ;
- solde et registre validés ou annulés ensemble ;
- répétition HTTP sans double mouvement ;
- migration ajoutant le type `admin_adjustment`, sans modifier les soldes existants ;
- aucune nouvelle variable d'environnement ou ressource AWS.

Documentation complète : [admin-token-wallet-management.md](./admin-token-wallet-management.md).

### FIN-DRIVER-002 — Notification du montant conducteur à la fin du trajet

Statut : implémenté dans le backend et l'application mobile ; déploiement requis, sans migration.

Résumé : la clôture unique d'un trajet produit un résumé financier serveur, l'envoie au conducteur par push et l'affiche dans le modal de fin. L'interface sépare le revenu net confirmé, le prix brut à encaisser en liquide et le revenu électronique net encore attendu.

Lorsqu'un paiement électronique attendu est confirmé après la clôture, une notification supplémentaire est envoyée uniquement lors de la création unique du revenu conducteur.

Impacts financiers :

- aucune nouvelle écriture, aucun débit, aucun crédit et aucun retrait ;
- les réservations sans dépose prouvée sont exclues ;
- le liquide n'est jamais ajouté au solde retirable ;
- l'électronique en attente n'est jamais présenté comme acquis ;
- calcul serveur avec le taux de commission configuré et la devise du trajet ;
- transition conditionnelle empêchant une double notification REST/Socket.IO ;
- endpoint limité au conducteur authentifié du trajet ;
- aucune migration ni nouvelle variable d'environnement.

Documentation complète : [driver-trip-revenue-notification.md](./driver-trip-revenue-notification.md).

### FIN-DRIVER-001 — Versement Mobile Money des revenus conducteur

Statut : implémenté dans le backend et l'application mobile ; migration et déploiement de production requis.

Résumé : après confirmation du paiement de fin de course, le revenu net devient retirable par le conducteur dans l'application. Le décaissement utilise le service FlexPay `merchantPayOutService`, exige un KYC approuvé et reste réservé jusqu'à une confirmation finale. Un échec ou une annulation confirmés libèrent le montant et rendent une nouvelle demande possible depuis l'app.

Impacts financiers :

- aucune modification du prix de course ni du taux de commission de 5 % ;
- verrou pessimiste par conducteur avant calcul et réservation du solde ;
- clé d'idempotence unique par intention de retrait ;
- unicité entre retrait et transaction de paiement ;
- timeout réseau conservé en attente au lieu d'être considéré comme échec certain ;
- callbacks vérifiés par défaut auprès de FlexPay ;
- comparaison de la référence, de l'`orderNumber`, du montant et de la devise ;
- rapprochement automatique toutes les cinq minutes ;
- historique des retraits et action **Réessayer** après échec final dans l'application ;
- migration de schéma sans modification des soldes historiques.

Documentation complète : [driver-electronic-trip-payout.md](./driver-electronic-trip-payout.md).

### FIN-BOOKING-002 — Règlement atomique des courses en jetons

Statut : implémenté dans le backend et l'application mobile ; migration et déploiement de production requis.

Résumé : le débit de jetons, le statut payé de la réservation et le revenu net conducteur sont désormais enregistrés dans une seule transaction PostgreSQL. Les appels concurrents REST/Socket.IO et les répétitions réseau sont idempotents. Un réconciliateur prudent complète les anciens débits prouvés sans jamais créer de débit rétroactif. L'application rafraîchit les caches financiers et rend le compte CDF conducteur visible depuis le profil.

Impacts financiers :

- aucune modification de la valeur d'un jeton, du prix des courses ou du taux de commission ;
- débit passager et revenu conducteur validés ou annulés ensemble ;
- verrous pessimistes sur réservation et portefeuille ;
- maintien des contraintes uniques par réservation ;
- nouvelles contraintes de non-négativité et de conservation du montant ;
- réparation automatique uniquement en présence d'une écriture `booking_payment` existante ;
- anomalie `succeeded` sans débit signalée sans prélèvement automatique ;
- séparation visible entre portefeuille passager en jetons et revenus conducteur en CDF.

Documentation complète : [atomic-token-trip-settlement.md](./atomic-token-trip-settlement.md).

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
