# Sécurité du chat et compatibilité mobile

## Autorisation des conversations de réservation

Seuls le passager de la réservation (`Booking.passengerId`) et le conducteur du
trajet associé (`Booking.trip.driverId`) peuvent rejoindre `booking:<bookingId>`.
Le contrôle précède `client.join`; connaître un UUID ne donne aucun droit.

L'API REST applique la même règle avant de créer une conversation liée à une
réservation ou d'y ajouter des participants. Un participant légitime ne peut pas
y inviter un tiers. Les conversations générales et de support conservent leurs
contrôles d'appartenance existants.

Une ancienne ligne de participation ajoutée sans autorisation ne permet plus de
lister la conversation, de lire ses messages, d'y écrire ou de recevoir ses push.
La liste est filtrée en SQL avant pagination et comptage. La jointure compare
explicitement l'UUID de réservation comme texte, car `Conversation.bookingId`
est une colonne texte, sans migration ni suppression de données historiques.

## WebSocket

Les namespaces `/chat` et `/tracking` conservent leurs noms d'événements et leurs
payloads valides. Chaque événement passe par un guard d'authentification et un
`ValidationPipe` propre au gateway. Les identifiants sont des UUID v4; les champs
inattendus sont rejetés. Les messages doivent être non blancs et faire au maximum
4 000 caractères. Les positions sont deux nombres finis; les métadonnées GPS
facultatives et les horodatages ISO existants restent acceptés. La normalisation
géographique existante reste appliquée ensuite.

Le JWT est vérifié avant d'établir l'identité du socket. Les événements arrivant
avant la fin de cette vérification, ou après expiration du JWT, sont refusés.
Les erreurs gardent le format `error: { message }`, sans exposer d'erreur interne.
Cette modification n'ajoute pas de révocation immédiate des sockets déjà connectés.

La validation utilise des exceptions WebSocket, conformément à la
[documentation NestJS](https://docs.nestjs.com/websockets/pipes).

## CORS et déploiement

HTTP et Socket.IO partagent la politique `CORS_ORIGINS` existante : liste exacte
d'origines séparées par des virgules en production, origines libres en
développement. Les clients natifs sans en-tête `Origin` restent acceptés mais
doivent présenter un JWT valide. Une liste vide en production interdit les
origines web.

La politique est appliquée au serveur Engine.IO partagé, pas seulement aux
namespaces. `allowRequest` vérifie aussi les connexions WebSocket directes :
[Socket.IO précise que CORS seul ne les protège pas](https://socket.io/docs/v4/handling-cors/).

Au déploiement, remplacer/redémarrer toutes les instances backend pour fermer
les anciennes connexions et vider leurs abonnements aux rooms. Une ancienne
instance conserve l'ancien comportement tant qu'elle reste accessible.

## Application mobile

Les payloads de `services/chatSocket.ts` et `services/trackingSocket.ts` dans
`zwanga` ont été vérifiés en lecture seule. Aucun changement de format mobile
n'est nécessaire pour les requêtes valides. Le renouvellement des tokens dans
`store/index.ts` reconnecte déjà les deux clients avec leur nouvelle identité.
Les nouveaux refus doivent être traités comme des erreurs d'accès, jamais comme
une invitation à réessayer avec un autre identifiant.

Le correctif OAuth précédent concerne la redirection navigateur et l'échange
du code à usage unique. Les endpoints natifs `POST /auth/google/mobile` et
`POST /auth/apple/mobile` sont inchangés. Un client qui utilise la redirection
navigateur doit toutefois suivre le nouveau flux décrit dans `oauth-exchange.md`.

## Vérifications automatisées

- Contrôles du service REST : tiers, participant légitime, anciennes adhésions,
  invitations, lecture, envoi, pagination et destinataires des notifications.
- Connexions Socket.IO locales réelles : autorisation avant abonnement, diffusion
  réservée aux deux parties, guards, DTOs, erreurs compatibles et CORS.
- Validation des coordonnées, identifiants, contenus et JWT sans services externes.

Aucune base de production, notification réelle ou configuration AWS n'est modifiée
par ces tests.
