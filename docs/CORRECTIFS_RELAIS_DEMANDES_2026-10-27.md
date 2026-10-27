# Correctifs du relais des demandes — 27 octobre 2026

## Problème et périmètre

Application des correctifs de l'audit de la file séquentielle : attente Redis non
bornée, acceptation interrompue empêchant le relais, contre-proposition considérée
comme une absence de réponse et délai peu explicite dans la fiche conducteur.
Changements locaux dans les dépôts mobile et backend ; aucune mise en production.

## Solutions appliquées

### Redis et reprise

`src/common/utils/redis-command-deadline.ts` protège maintenant `zScore`, `zAdd`,
`zRangeByScore` et `zRem`, en plus des commandes précédentes. Le délai utilise la
configuration existante du client Redis. Une opération expirée déclenche la reprise
de connexion sans rejouer automatiquement une écriture dont le résultat est inconnu.

`src/trip-requests/dispatch/sequential-dispatch.service.ts` lance la lecture des
échéances Redis et le secours SQL indépendamment. Une lecture Redis en échec
n'empêche plus la lecture SQL ; après le délai maximal, le cycle libère son état
d'exécution. Une panne Redis peut toujours retarder l'attribution, qui exige son
verrou : aucun contournement par diffusion générale n'a été ajouté.

### Trois étapes de réponse distinctes

Migration préparée : `1780000098000-RequestResponsePhases.ts`, enregistrée dans
`src/database/migrations/index.ts`. Elle ajoute aux invitations une phase
`driver`, `passenger` ou `accepting`, ainsi qu'un jeton interne de finalisation.

- **Conducteur : 40 secondes** depuis la création serveur de l'invitation,
  limitées par la fin de la demande. Le refus passe au suivant sans attendre.
- **Contre-proposition : jusqu'à 2 minutes** pour la décision du passager,
  limitées par la fin de la demande. Elle constitue une réponse du conducteur,
  arrête sa sollicitation et conserve l'exclusivité pendant cette décision.
  À l'expiration, l'offre est explicitement annulée avant le relais ; le refus du
  conducteur retire également sa contre-proposition.
- **Acceptation reçue à temps : jusqu'à 2 minutes** de préparation protégée,
  avec un jeton généré exclusivement côté serveur. Un traitement tardif ou une
  seconde acceptation ne peut pas utiliser le jeton d'un autre traitement.

La fenêtre de 40 secondes reste une fenêtre de **tentative de contact**, et non
40 secondes garanties après affichage sur le téléphone. Les retards du transport
la consomment toujours. Cette règle conserve l'échéance reçue par les clients
natifs et évite de prolonger indéfiniment une invitation sans accusé mobile.
Un protocole distinguant livraison et présentation reste une évolution séparée.

### Acceptation et récupération

`dispatch/request-acceptance.ts`, `sequential-policy.ts`,
`trip-requests.service.ts`, `trips/save-request-trip.ts` et `trips.service.ts` :

- Réservation de l'acceptation sous verrou avant la préparation longue du trajet.
- Vérification du jeton et de l'échéance à la création du trajet et à la réservation.
- Pour l'acceptation directe séquentielle, réservation acceptée, places et sélection
  de la demande sont enregistrées dans la même transaction, via les contrôles
  existants de `BookingsService.create`. Une erreur annule l'ensemble de cette étape.
- Si la préparation échoue, seul son propre jeton est libéré et la reprise est
  déclenchée. Un défaut de cache après validation ne provoque pas de seconde réservation.
- Après un arrêt du processus, un trajet provisoire sans réservation est annulé
  après l'échéance de préparation, puis le relais reprend. Une réservation déjà
  acceptée est rattachée à sa demande, sans attribuer celle-ci à un autre conducteur.
- Une ancienne réservation encore en attente est reprise par le service habituel
  d'acceptation. Les états historiques comportant des réservations payées, annulées
  ou incohérentes ne sont pas supprimés automatiquement : ils conservent une reprise
  prudente et peuvent nécessiter le traitement métier existant. Ce n'est pas une
  réparation générale de toutes les incohérences historiques.
- Une annulation du passager nettoie également un trajet provisoire réellement vide.

`dispatch/dispatch.service.ts` empêche d'utiliser la réponse rapide des commandes
immédiates pour contourner la finalisation d'une commande programmée.
`notifications.service.ts` et le relais écartent les sollicitations devenues
obsolètes après réponse et les notifications d'offres retirées.

### Fiche mobile

Le détail expose un `responseWindow` facultatif avec phase, échéance et heure
serveur. Contrats, types et mapping sont adaptés dans `store/api/trip-request`
et `types/tripRequests.ts`.

`requestResponseWindow.ts`, `useRequestResponseWindow.ts`,
`useRequestDetailData.ts`, `useRequestDetailController.ts`,
`RequestDriverDecision.tsx` et `RequestPassengerTicket.tsx` ajoutent :

- un compte à rebours près des boutons du conducteur ;
- des textes distincts pour la réponse du passager et la confirmation en cours ;
- le blocage des actions après expiration ou en cas de métadonnées de délai invalides ;
- une actualisation à l'échéance, sans répétition à chaque rendu ;
- l'arrêt du minuteur quand l'écran est inactif et la réconciliation au retour.

Le calcul utilise la durée donnée par le serveur, ancrée au début de la lecture.
Une nouvelle requête utilisant encore l'ancienne réponse ne prolonge pas le compteur.
L'autorité reste le serveur. Le champ étant facultatif, les réponses d'un ancien
backend restent compatibles.

## Comportements conservés et précautions

Proximité et éligibilité des conducteurs, demandes ciblées privées, exclusions des
refus, formats Firebase/Expo, réservations sur trajets publiés et règles de paiement
sont conservés. Aucun nouveau modal de confirmation. Aucun changement aux fichiers
natifs ni lecture des secrets pour ce travail. Aucun changement importé de master.

La migration 98 exige la migration 97 de la file séquentielle. Le backend modifié
doit démarrer avec ces migrations ; les anciens workers doivent être retirés pour
ne pas interpréter une phase d'attente passager comme une invitation ordinaire.
Aucune migration n'a été exécutée sur les environnements existants.

## Vérifications et résultats

Sous Node 24.22.1, avec PostgreSQL/PostGIS jetable et Redis local isolé :

- **104 scénarios d'intégration serveur réussis** : 23 dans la suite séquentielle
  et 81 dans la suite de dispatch existante. Couverture du refus, de l'expiration,
  des accès, de la concurrence, de la reprise Redis, des trajets provisoires
  abandonnés, des confirmations déjà enregistrées, du rollback transactionnel,
  des contre-propositions et de l'annulation pendant la préparation.
- **59 tests unitaires backend distincts réussis** : délais Redis, listes,
  confidentialité, choix du conducteur et édition des demandes.
- **23 tests mobiles réussis**, dont 7 nouveaux tests du délai : décalage d'horloge,
  latence, données anciennes pendant une actualisation, retour au premier plan,
  phases, expiration et métadonnées invalides.
- TypeScript mobile et compilation des sources de production backend réussis.
- ESLint sur les fichiers mobiles concernés, contrôle de taille des sources et
  `git diff --check` réussis.

Soit **186 tests distincts réussis**. Les fixtures de migration ont été adaptées
à la phase supplémentaire. Les premiers appels utilisant deux noms de suites
inexistants ont été corrigés ; les suites réellement visées ont ensuite réussi.

Les notifications et fournisseurs des tests sont simulés ou remplacés par un
serveur HTTP local. Aucun push envoyé à un utilisateur réel. Aucun essai physique,
aucune mesure de charge, aucune certification de sonnerie, de réveil d'écran ou
d'absence de crash natif. Les modifications restent à déployer et à valider sur
appareils après migration.
