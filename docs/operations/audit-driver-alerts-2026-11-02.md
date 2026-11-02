# Audit de fiabilité des alertes de demandes de trajet

Date : 2 novembre 2026. Périmètre : code local du backend et de l’application `zwanga`, avec les modifications en cours, dont la sélection de plusieurs types de véhicule et la limite de fraîcheur de localisation de 48 heures. La version réellement déployée sur AWS n’a pas été comparée pendant cet audit.

La chaîne protège correctement l’attribution d’une demande et dispose de reprises SQL, Redis, push et temps réel. Les tests existants passent. Elle conserve toutefois deux risques de retard sous charge, une politique de reprise Firebase incomplète, un risque de blocage du renouvellement OAuth et des limites de reprise et de diagnostic côté téléphone. Une sonnerie systématique n’est pas démontrée par ces tests.

Aucun correctif applicatif, changement de configuration, migration applicative, déploiement, envoi push réel ou appel SMS/paiement n’a été effectué. Les seuls ajouts de cet audit sont ce rapport et un banc de diagnostic local ignoré par Git sous `tmp/`.

## Synthèse des priorités

| Référence | Priorité | Risque | Preuve |
|---|---|---|---|
| A01 | Haute sous dégradation SQL | Le verrou Redis expire avant le remplissage de la file ; la recherche recommence sans invitation | Branche reproduite avec recherche simulée à 10 001 ms |
| A02 | Haute sous charge ou lenteur fournisseur | Des invitations consomment leur fenêtre de réponse dans la file d’envoi | Limite de cinq envois, tri par type et échéance de 40 secondes vérifiés dans le code ; capacité réelle non mesurée |
| A03 | Moyenne | Reprises FCM trop précoces après limitation et répétition d’erreurs permanentes | Réponse synthétique 429 avec `Retry-After: 120`, politique SQL de reprise fixe |
| A04 | Moyenne, impact large si déclenché | Un renouvellement OAuth qui ne se termine pas empêche les envois suivants | Deux essais espacés sur la même application Firebase, aucune nouvelle authentification |
| A05 | Moyenne | La reprise native Android peut être exécutée après expiration de l’invitation | Worker ordinaire différé ; comportement réel en veille à mesurer |
| A06 | Moyenne | Impossible de distinguer précisément une alerte affichée mais silencieuse d’une sonnerie démarrée | Contrat de reçus et branche de publication audio vérifiés |

Les priorités décrivent les conditions et l’impact possibles, pas la fréquence observée en production. Les simulations A01 et A04 injectent une défaillance ; elles ne prouvent pas qu’elle se produit actuellement sur AWS.

## Protections confirmées

- Une file de candidats Redis par demande ; PostgreSQL conserve l’invitation, l’exclusivité et la notification durable dans la transaction d’attribution. Les appels aux fournisseurs sont faits après validation de cette transaction.
- Réévaluation du candidat avant réservation, contrôles de compte/KYC, véhicule actif et compatible, capacité, proximité et conflits de trajets. Les tests couvrent également le passage à un autre type de véhicule accepté.
- Relais après refus ou expiration, scanner des échéances chaque seconde et récupération indépendante depuis SQL. La découverte périodique couvre les demandes sans invitation ; les délais et les contraintes SQL évitent un élargissement silencieux à plusieurs destinataires simultanés.
- Envoi urgent déclenché après création de l’invitation, voie temps réel indépendante du temps d’attente HTTP Firebase, notifications périmées écartées, token utilisateur relu avant l’envoi.
- Envoi FCM HTTP borné et effectivement interrompu, propriété des reprises protégée par un jeton, renouvellement du bail de notification et écriture du résultat conditionnée au propriétaire courant.
- Android v6 : réception native sans attendre React en arrière-plan, déduplication persistante, carte de secours et reprise locale. iOS : alerte APNs avec échéance et son, sans imposer l’exécution JavaScript en arrière-plan.
- Les restrictions de compte et les échéances restent vérifiées côté mobile ; une reprise ne renouvelle pas arbitrairement l’invitation.

## A01 Le verrou de découverte peut expirer trop tôt

Dans `src/trip-requests/dispatch/request-driver-queue.ts:19`, le verrou dure 10 secondes. `seed` refuse d’écrire si son propriétaire a expiré. Dans `src/trip-requests/dispatch/sequential-dispatch.service.ts:125`, la recherche normale utilise directement le gestionnaire SQL : elle ne bénéficie pas du budget de trois secondes du mode de secours. Le timeout SQL général est de 30 secondes par défaut (`src/database/typeorm-options.ts:117`), sans compter l’attente d’une connexion.

Une recherche terminée après 10 secondes peut donc être correcte mais inutilisable : `seed` renvoie `false`, le service programme une reprise et ne réserve aucun conducteur. Si cette latence se répète, les reprises peuvent reproduire le même problème. Le secours SQL n’est pas activé par cette seule expiration : il dépend d’une erreur Redis.

La simulation exécute le vrai `advance`, avec le premier résultat transactionnel et les dépendances simulés : deux recherches à 10 001 ms produisent deux reports et aucune transaction de création d’invitation. Il ne s’agit pas d’une mesure de temps PostgreSQL.

Correctif recommandé : aligner le budget total de découverte sur le bail, ou découvrir avant la prise du bail puis revalider sous verrou SQL. Si un renouvellement est retenu, le borner et vérifier sa propriété. Ajouter un test avec expiration réelle du verrou Redis, retard du pool et deux workers concurrents ; ne pas simplement allonger le verrou sans borne de travail.

## A02 La file des push peut consommer la fenêtre de réponse

`src/notifications/notifications.service.ts:802` limite les envois urgents à cinq simultanément par processus. Le tri à la ligne 830 privilégie toujours `driver_dispatch_offer`, puis l’ancienneté ; les demandes programmées et de partage envoyées comme `trip_request_nearby` ne bénéficient pas d’un quota équitable. La fenêtre métier de 40 secondes commence à la création de l’invitation, avant que l’envoi ait obtenu un worker.

Le transport peut prendre cinq secondes d’authentification puis quinze secondes d’envoi (`src/notifications/bounded-firebase-send.ts:7`). Une accumulation d’envois lents réduit donc le délai utile au conducteur ; sous un flux continu d’offres immédiates, les autres types peuvent attendre jusqu’à expiration. Le temps réel et la récupération REST atténuent ce risque pour une application ouverte, pas pour tous les téléphones en veille.

Exemple de capacité, et non mesure de charge : avec cinq workers et quinze secondes par envoi, seize invitations simultanées exigent quatre vagues. La quatrième ne peut commencer qu’après 45 secondes, au-delà des 40 secondes métier. Augmenter sans limite le nombre de workers déplacerait le problème vers PostgreSQL ou le fournisseur.

Correctif recommandé : ordonnancement tenant compte des échéances et de l’équité entre types, métriques d’ancienneté de la file, capacité bornée ajustée à des mesures, séparation explicite du délai d’acheminement et du temps utile de réponse si le produit valide ce changement. Toute adaptation doit conserver un seul conducteur réservé, des échéances durables et une durée totale maximale.

## A03 La reprise Firebase ignore la temporisation du fournisseur

`src/notifications/bounded-firebase-send.ts:165` classe 429 et 5xx comme transitoires mais ne transmet pas `Retry-After`. `FirebaseDeliveryError` ne contient pas de délai de prochaine tentative. La voie urgente reprend les lignes `failed` après quinze secondes (`src/notifications/notifications.service.ts:826`), sans exploiter le caractère permanent ou transitoire de l’erreur pour cette sélection.

Une réponse synthétique `429` avec `Retry-After: 120` confirme que le statut est conservé mais pas le délai. Le code peut retenter avant l’heure autorisée, et répéter une erreur de configuration ou de payload tant que la notification reste pertinente. Cela ne rend pas une ancienne invitation à nouveau valide, mais consomme inutilement des tentatives et des workers.

Correctif recommandé : persister une classification sûre et une prochaine date de tentative ; respecter `Retry-After`, appliquer un recul progressif avec variation aléatoire pour les erreurs transitoires, suspendre les erreurs permanentes jusqu’à changement pertinent de configuration/token. Si la prochaine tentative dépasse l’échéance métier, ne pas ressusciter la sonnerie. Ces règles suivent les [recommandations de reprise FCM](https://firebase.google.com/docs/cloud-messaging/scale-fcm).

## A04 Le timeout OAuth ne termine pas le renouvellement partagé

Dans `src/notifications/bounded-firebase-send.ts:24`, les appels partagent `state.pending`. Les appelants expirent, mais cette promesse n’est effacée que lorsqu’elle se termine. Si `credential.getAccessToken()` ne se résout ni ne rejette, chaque appel ultérieur retrouve la même promesse et expire à son tour. Les limites d’attente protègent les workers, pas la reprise de l’authentification elle-même.

La simulation utilise une promesse volontairement bloquée. Deux essais séparés de plus d’une minute produisent un seul appel à `getAccessToken` et aucun envoi HTTP. Ce scénario conditionnel ne permet pas de conclure à une panne OAuth actuelle ; un renouvellement qui finit par réussir fonctionne déjà et possède un test.

Correctif recommandé : borner et, si possible, annuler l’opération réseau sous-jacente ; prévoir une récupération contrôlée du client d’authentification et une alerte sur un renouvellement anormalement long. Ne pas simplement effacer `pending` toutes les cinq secondes, ce qui multiplierait des requêtes abandonnées.

## A05 La reprise Android est durable mais non prioritaire

`../zwanga/native/android/notifications/RideDeliveryWorker.java:16` programme un travail ordinaire après au moins cinq secondes, avec recul exponentiel. L’affichage initial est bien tenté immédiatement dans `RideFirebaseMessagingService` ; ce point concerne son secours si la publication initiale échoue ou reste inachevée.

Cette reprise ne possède pas de garantie de démarrage avant la fin d’une invitation courte. Firebase recommande un travail WorkManager accéléré pour prolonger le traitement d’un message prioritaire, avec une exemption courte lorsqu’il est programmé immédiatement après réception. Voir la [documentation de priorité Android FCM](https://firebase.google.com/docs/cloud-messaging/android-message-priority).

Correctif recommandé : étudier une reprise accélérée sans délai initial, avec le mode de repli adapté aux quotas, en conservant l’affichage immédiat, la déduplication, les protections de compte et l’échéance absolue. Valider les courses entre le callback Notifee tardif et le worker, puis tester en veille profonde sur appareils physiques. Ne pas transformer les refus de permissions en boucle de relance.

## A06 Un affichage confirmé ne confirme pas le son

`src/notifications/ride-notification-receipt.ts:10` accepte `received` et `displayed`, pas un état audio. Dans `../zwanga/native/android/notifications/RideCardDelivery.java:100`, l’appel à `startPublished` précède un reçu d’affichage, mais son retour n’est pas une preuve de démarrage du lecteur. Le service audio peut légitimement refuser de jouer : mode silencieux, volume nul, canal désactivé, appel en cours, restrictions système. Les diagnostics JavaScript existent aussi, mais ils ne forment pas une chronologie audio corrélée à chaque notification côté backend.

De plus, les reçus natifs sont conservés localement puis remontés par le parcours JavaScript (`../zwanga/services/rideNotificationReceipt.ts:68`, `../zwanga/hooks/auth/usePushRegistration.ts:67`). En veille, une absence de reçu serveur peut être une absence de synchronisation, pas une absence d’affichage. La reprise unique Android v6 après douze secondes est protégée par la déduplication ; il ne faut pas interpréter son déclenchement comme une perte certaine.

Correctif recommandé : télémétrie bornée et sans données sensibles pour `audio_started`, `audio_failed`, `audio_suppressed` avec motifs, notification corrélée et heure observée sur l’appareil. Un lecteur démarré ne prouve toujours pas que l’utilisateur a entendu. Ajouter des indicateurs séparés : création → invitation, invitation → acceptation fournisseur, reçu et affichage, démarrage audio, refus/expiration → invitation suivante. Les accusés ne doivent pas conditionner l’affichage ni prolonger une invitation à l’infini.

## Vérifications exécutées

| Campagne locale | Résultat |
|---|---|
| Backend ciblé notifications, échéances, résilience dispatch, localisation, candidats et délais Redis | 329 tests réussis, 69 ignorés ; 29 suites réussies, trois conditionnelles ignorées |
| PostgreSQL/PostGIS et Redis jetables : dispatch séquentiel, dispatch et notifications transactionnelles | 240 tests réussis, trois ignorés ; trois suites réussies ; ressources jetables arrêtées |
| Mobile : notifications conducteur, payload natif, reçus, audio, temps réel, récupération, inscription push et iOS | 127 tests réussis, aucun échec |
| Simulations supplémentaires sans accès réseau | Expiration du bail de découverte, renouvellement OAuth bloqué et perte de `Retry-After` reproduits |

Les simulations utilisent les classes réelles avec dépendances et horloge contrôlées. Le premier essai du banc a été interrompu à cause d’une interaction entre une réponse HTTP synthétique et l’horloge simulée ; le banc corrigé s’est terminé avec succès. Aucun fichier applicatif n’a été adapté pour faire passer ces scénarios.

Les campagnes ne constituent ni une charge représentative de la production, ni une nouvelle compilation native, ni une réception réelle FCM/APNs, ni une mesure acoustique. Elles ne certifient pas les versions présentes sur les stores. Les chiffres ne remplacent pas une vérification sur Android/iPhone physiques, écran éteint, app fermée, réseau instable et paramètres de notification variés.

## Ordre recommandé pour la fiabilisation

1. Corriger le budget de découverte et son bail Redis ; ajouter le cas lent aux tests de non-régression.
2. Traiter les reprises FCM et le renouvellement OAuth avec des limites explicites et une récupération maîtrisée.
3. Mesurer la saturation de la voie urgente avec un fournisseur simulé lent, puis ajouter un ordonnancement équitable respectant les échéances.
4. Renforcer la reprise Android et la télémétrie, puis réaliser une recette réelle sur plusieurs marques Android et sur iPhone.

Objectifs de recette proposés, à valider comme objectifs internes : invitation initiale et relais après refus en moins de trois secondes au p95 sous charge nominale ; relais au plus tard quelques secondes après l’échéance prévue ; aucune double attribution ; aucune sonnerie d’une invitation déjà expirée. Mesurer séparément le délai fournisseur et celui du téléphone. Aucun de ces objectifs n’est présenté ici comme un résultat obtenu.

Le guide PostgreSQL a orienté l’examen des baux, verrous et reprises transactionnelles. Le guide `write-page` a servi à séparer constats, reproductions, recommandations et limites dans ce rapport local.
