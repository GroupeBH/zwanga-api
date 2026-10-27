# Relais des demandes de trajet — 27 octobre 2026

## Périmètre et problème

La diffusion simultanée pouvait laisser une demande sans nouvelle sollicitation
après un refus. À la demande de l'utilisateur, le parcours devient séquentiel :
un conducteur reçoit la demande, puis le suivant en cas de refus ou sans réponse
pendant 40 secondes. Ce choix remplace la diffusion simultanée demandée auparavant.
Il concerne les commandes de trajet immédiates et programmées, pas les réservations
sur le trajet publié d'un conducteur : ces dernières ne peuvent pas être transférées
à un autre conducteur.

## Implémentation

Dans `zwanga-backend` :

- `dispatch/request-driver-queue.ts` conserve dans Redis les identifiants des
  conducteurs à contacter, un verrou temporaire par demande et les échéances dans
  un ensemble trié. Les opérations de liste vérifient le propriétaire du verrou.
- `dispatch/sequential-candidates.ts` choisit les conducteurs dans un rayon de
  5 km, par proximité, avec les contrôles existants : compte et KYC actifs,
  véhicule et places compatibles, position disponible, disponibilité et refus.
  Une fenêtre de 50 candidats borne le travail ; les fenêtres suivantes excluent
  les conducteurs déjà sollicités.
- `dispatch/sequential-dispatch.service.ts` prépare une seule invitation et sa
  notification dans la même transaction SQL. Le délai est fixé à **40 secondes
  depuis la création de l'invitation**, et ne dépasse pas la fin de la demande.
  Les horloges des téléphones et les accusés fournisseur ne prolongent pas ce délai.
- `POST /api/v1/driver-dispatch/requests/:id/events` reçoit un événement
  `{ type: "declined", offerId }`. Ce callback exige l'authentification et le rôle
  conducteur et vérifie l'appartenance de l'invitation. Les routes de refus déjà
  utilisées par les applications déclenchent également le relais.
- L'absence de réponse est détectée **sur le serveur**, par un traitement chaque
  seconde. Aucun webhook extérieur ni minuterie mobile n'est nécessaire pour
  produire cet événement. Le délai de traitement peut dépasser 40 secondes en
  cas de charge ou de panne ; l'ancienne acceptation devient invalide à l'échéance.
- Les formats `driver_dispatch_offer` et `trip_request_nearby` sont conservés,
  avec une échéance explicite pour les sonneries existantes. Les transports
  Firebase/Expo et les notifications de réservation ne sont pas remplacés.

Les changements touchent également `dispatch.service.ts`, son contrôleur et ses
DTO, `trip-requests.module.ts`, `trip-requests.service.ts`, `request-pages.ts`,
`shared-trip-offers.service.ts`, `shared-trip-alert.ts`, la récupération des demandes,
`notifications.service.ts` et `trips/save-request-trip.ts`.

## Cohérence et reprise

- PostgreSQL conserve l'historique des invitations, leurs échéances et les réponses.
  Redis stocke la file de travail, sans devenir l'autorité pour une acceptation.
  Une liste perdue est reconstruite à partir des conducteurs encore éligibles et
  des invitations SQL. Une échéance Redis manquante est récupérée depuis SQL.
- Aucun appel Redis ni Firebase n'est effectué dans les transactions de
  réservation. Les verrous SQL sérialisent les changements de demande et protègent
  contre deux acceptations. Les verrous Redis expirés ne peuvent pas libérer ceux
  d'un autre processus.
- Une panne Redis diffère le relais ; elle ne déclenche pas une diffusion générale.
  Un refus validé reste enregistré même si le conducteur suivant ne peut pas être
  sollicité immédiatement. Une transaction d'envoi annulée ne consomme pas
  définitivement le conducteur sorti de la liste Redis.
- Les anciens liens, lectures de listes, offres alternatives et acceptations sont
  contrôlés côté serveur. Après expiration, le conducteur précédent ne peut plus
  accepter. Après acceptation ou annulation, les autres notifications deviennent
  inactives et la file est retirée. Les signaux temps réel existants actualisent
  les appareils connectés ; les appareils hors ligne se réconcilient à leur retour.
- Une demande adressée à un conducteur précis reste privée après son refus ou
  silence. Le passager conserve le choix explicite de l'ouvrir aux autres.
- La vérification périodique utilise l'échéance Redis pour éviter de reprendre les
  verrous SQL des demandes encore dans leur fenêtre de réponse. Le travail est
  borné et limité à trois demandes simultanées par processus.

## Migration et mise en service

Migration préparée : `1780000097000-SequentialRequestQueue.ts`, ajoutée au registre.
Elle ajoute `sequentialDispatch` aux demandes, `sequential` aux invitations,
un index unique pour une invitation séquentielle en attente par demande, et un
déclencheur qui applique aussi cette contrainte aux insertions d'un ancien
allocateur pendant une mise à jour du serveur. Les anciennes demandes sont
adoptées sous verrou ; leurs invitations simultanées restantes sont annulées.

Les modèles TypeORM sont mis à jour. Le service utilise le dispositif existant
`DRIVER_DISPATCH_ENABLED` ; sa réponse de configuration annonce 40 secondes.
La migration doit précéder le démarrage du backend modifié. Aucune migration,
modification Redis ou mise en production n'a été effectuée sur AWS dans ce travail.
Le déploiement doit aussi terminer le retrait des anciens workers : le garde SQL
protège leurs insertions d'invitations, mais ne remplace pas le code de leur ancien
parcours de diffusion des notifications programmées.

## Validation et limites

Les essais utilisent un cluster PostgreSQL/PostGIS temporaire et un Redis local
isolé. Ils n'utilisent pas les valeurs de `.env`. Les transports push sont simulés :
aucune alerte n'est envoyée à un utilisateur réel.

Vérifications réalisées sous Node 24.22.1 :

- **14 nouveaux scénarios d'intégration réussis**, avec PostgreSQL/PostGIS et Redis
  réels et isolés : deux types de commande, file ordonnée, échéance de 40 secondes,
  refus et doublons, acceptation concurrente, annulation, Redis indisponible,
  échéance perdue, transaction annulée, verrou périmé, insertion d'un ancien worker,
  acceptation programmée, isolation entre demandes et callback HTTP authentifié.
- **81 tests PostgreSQL existants réussis**, après application de la nouvelle
  migration dans leur base temporaire et adaptation d'une attente de diffusion
  simultanée au nouveau comportement séquentiel.
- **106 tests unitaires de non-régression réussis** : refus, isolation des lots,
  visibilité, ciblage, édition et politiques de notifications.
- Compilation des sources de production :
  `tsc -p tsconfig.build.json --noEmit --incremental false` réussie.
  Le contrôle global incluant tous les anciens fichiers de test a aussi signalé
  des erreurs de typage hors de ce périmètre, notamment dans des fixtures de
  `trip-requests.service.spec.ts` et `users/*.spec.ts` ; il n'est pas annoncé vert.
- `git diff --check` sur les changements concernés : aucune erreur d'espacement.

Soit **201 tests distincts réussis**. Les erreurs de schéma/alias et de harnais
Windows rencontrées pendant la préparation ont été corrigées et les suites
concernées relancées. Aucun résultat de test JavaScript n'est assimilé à une
validation native sur téléphone.

Ces essais ne certifient pas l'audibilité, le réveil de l'écran ou la suppression
instantanée d'une carte déjà affichée par iOS/Android sur un appareil hors ligne.
La réception effective reste soumise au réseau, aux autorisations et au système.
Les constats de l'[audit AWS](operations/dispatch-ringing-diagnostic-2026-10-27.md), notamment le repli
d'enregistrement mobile, ne sont pas présentés comme résolus par cette file.
