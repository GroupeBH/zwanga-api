# Diagnostic des demandes et sonneries du 27 octobre 2026

Période demandée : 14 h 30 à 15 h, Africa/Kinshasa (UTC+1).
Production examinée : ECS `zwanga-api-production-api:29`, image du commit
`e35ae493030222c39fc30b080e3dbb2af3b5aadd`. Les changements locaux en cours sur
les refus et le conducteur ciblé ne font pas partie de cette image.

## Méthode et périmètre

- Consultation ECS, CloudWatch et de deux paramètres non secrets :
  `DRIVER_DISPATCH_ENABLED=true` et `LOG_LEVEL=warn`.
- Les deux pages de logs couvrant la fenêtre contiennent 78 événements.
  Les succès HTTP/push ne sont pas journalisés à ce niveau ; leur absence des
  logs ne prouve donc pas une absence d'envoi.
- RDS est privé, ECS Exec désactivé, aucun accès SSM disponible. Après accord
  explicite de l'utilisateur, une seule tâche temporaire a exécuté un script
  sans démarrage NestJS ni ordonnanceur, avec PostgreSQL en lecture seule,
  vérification TLS, requêtes limitées à cinq secondes et arrêt maximal à 90 s.
- Tâche de diagnostic : `1d0d339ec76e400a8dfccdf240620666`. Elle s'est arrêtée
  le 27 octobre à 15:15:25, avec code de sortie 0. Le service principal est resté
  sur la révision 29, actif avec une tâche sur une attendue et aucune en attente.
- Aucun redéploiement, changement de paramètre ou écriture métier effectué.
  Les résultats locaux minimisés sont dans `tmp/driver-ringing-readonly-result-20261027.json`,
  ignoré par Git ; ils ne contiennent ni nom, téléphone, coordonnées GPS ni jeton.

## Résultats des demandes

Toutes les heures ci-dessous sont à Kinshasa. Les sept demandes ont le type de
véhicule `car`, une place et `immediateDispatch=false` : elles empruntent le
parcours des demandes planifiées, même lorsque le départ est proche.

| Création | Demande (préfixe UUID) | Notifications / statut `sent` | Accusés réception et affichage | Refus enregistrés |
| --- | --- | --- | --- | --- |
| 14:48:21 | `04d6f491` | 6 / 6 | 1 | 1 |
| 14:51:50 | `d1077595` | 6 / 6 | 1 | 0 |
| 14:52:07 | `c32d1b9e` | 6 / 6 | 1 | 1 |
| 14:54:01 | `27e0a500` | 6 / 6 | 1 | 0 |
| 14:54:35 | `5ed27787` | 6 / 6 | 1 | 0 |
| 14:56:12 | `5c601ed2` | 6 / 6 | 1 | 1 |
| 14:58:35 | `de02f05c` | 6 / 6 | 1 | 1 |

Au total : 42 notifications `trip_request_nearby`, dont 28 via FCM et 14 via
Expo, toutes marquées `sent`. Aucune invitation exclusive dans
`trip_request_dispatch_offers` pour ces demandes. Un même appareil a remonté
les sept accusés de réception/affichage ; sept reprises natives uniques sont
enregistrées. Aucun code d'échec d'affichage n'est remonté dans ces accusés.

**Limite de preuve :** `sent` prouve l'acceptation par le fournisseur, pas la
réception ni le son audible. L'absence d'accusé n'est pas non plus une preuve
de non-réception, notamment avec les anciens protocoles. Un accusé `displayed`
ne mesure pas le volume ou la lecture audio.

## Refus depuis la liste et absence de relais

Deux refus sont bien enregistrés pour le conducteur `05202f77…` :

- demande `5c601ed2…`, créée à 14:56:12, refusée à 14:56:36 ;
- demande `de02f05c…`, créée à 14:58:35, refusée à 14:58:52.

Ce conducteur a une notification Expo marquée `sent` pour chaque demande,
mais aucun accusé de réception/affichage. Cela est compatible avec le témoignage
de l'utilisateur : découverte de la demande dans les priorités de l'application
et refus manuel, sans sonnerie constatée. Son identité n'a pas été confirmée
par l'utilisateur ; les préfixes servent uniquement à corréler les données.

Pour ces deux demandes, les six notifications ont toutes été créées avant le
refus. Aucune nouvelle notification destinée à un conducteur supplémentaire
n'apparaît après le refus dans le relevé.

Dans la version déployée :

1. `enqueueScheduledRequestAlert` diffuse aux conducteurs admissibles par lots
   de 50 et exclut les couples demande/conducteur déjà présents dans l'outbox.
2. `declineNearbyRequest` enregistre le refus dans l'événement de sonnerie puis
   le réconcilie. Il ne choisit pas un successeur et ne déclenche pas un nouvel
   envoi urgent. Le traitement périodique peut ajouter des conducteurs jamais
   contactés, mais ne relance pas ceux dont l'envoi a déjà été enregistré.
3. Ce parcours est distinct de `respond(..., 'decline')` des invitations de
   dispatch immédiat, qui rappelle `allocateNext` dans sa transaction.

L'attente « refus depuis les priorités → sonnerie immédiate chez le suivant »
n'est donc pas assurée dans le parcours effectivement utilisé par ces tests.

## Un refus rejeté et une limite de diagnostic

À 14:55:27, CloudWatch contient un avertissement HTTP sur
`PUT /api/v1/driver-dispatch/nearby-requests/5ed27787-f9c8-4aa8-b29c-3c6ae8bf71e1/decline`.
Aucun refus n'est enregistré pour cette demande dans les événements lus.

Le service déployé renvoie une erreur lorsque le conducteur n'a pas d'événement
de sonnerie préalable. C'est un défaut de compatibilité avec le refus depuis
la liste, déjà traité par des changements locaux non déployés. Il explique un
scénario possible ici, mais le statut et le message HTTP exacts ne sont pas
conservés par le format actuel du log (`[object Object]`). Il serait incorrect
d'affirmer que ce refus précis a nécessairement échoué avec un 404.

## Sonnerie et proximité

- Des conducteurs compatibles se trouvent à quelques mètres selon leurs
  dernières positions enregistrées ; certains utilisent le protocole de
  notification v2 et un autre le récepteur natif v6. Ces numéros désignent le
  protocole déclaré, pas la version du store.
- Un conducteur proche est encore marqué occupé par un trajet et une demande
  attribuée au moment du diagnostic. Cette photographie ultérieure n'établit
  pas son état exact à 14:55, ni son identité parmi les testeurs.
- Pour la demande `5ed27787…`, le récepteur natif indique une observation locale
  à 14:54:35, mais les accusés ont été remontés au serveur à 15:04:35. Cela
  démontre une remontée tardive des accusés, pas dix minutes de retard du push.
- `updatedAt` d'une notification Expo peut être modifié par la vérification du
  reçu fournisseur ; il ne faut pas l'interpréter comme son heure d'envoi initiale.
- Les alertes ont une échéance de sonnerie d'environ 60 secondes. La réception,
  l'affichage et le début réel du son doivent être distingués pour diagnostiquer
  les autres appareils ; les preuves disponibles ne permettent pas d'attribuer
  leur silence à un paramètre Android, au volume ou au fournisseur.

## Correctifs à poursuivre

1. Livrer et vérifier le refus idempotent par conducteur, y compris depuis la
   liste sans alerte préalable, avec exclusion durable du conducteur ayant refusé.
2. Ajouter une orchestration explicite de relais après refus pour les demandes
   planifiées : sélection du prochain admissible, invitation durable, réveil
   de l'envoi après commit, limites de répétition et vérification de l'état courant.
   Les modifications locales d'exclusion des refus ne suffisent pas, seules, à
   établir ce relais sur des destinataires déjà contactés par diffusion groupée.
3. Vérifier la réception et l'audio sur les versions mobiles réellement utilisées,
   notamment les protocoles v2 et v6 et les accusés remontés au réveil. Une acceptation
   FCM/Expo ne doit pas être présentée comme une sonnerie réussie.
4. Conserver le statut HTTP, le code d'erreur et le requestId dans les logs
   structurés, ainsi que les étapes sélection/envoi/réception pour chaque invitation.

Ce passage établit le diagnostic ; il ne modifie pas les règles métier,
les applications mobiles ni la configuration de production.
