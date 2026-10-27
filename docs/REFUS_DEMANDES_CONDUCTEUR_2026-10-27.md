# Demandes refusées : visibilité propre à chaque conducteur

Date : 2026-10-27. Périmètre : application mobile et dépôt voisin `zwanga-backend`.

## Problème constaté

Le refus d'une demande proche arrêtait l'alerte, mais ne retirait pas durablement
la demande des listes du conducteur. Le serveur exigeait un événement de sonnerie
préalable et ne conservait plus certains refus après traitement de cet événement.
Le mobile pouvait revenir à l'accueil malgré un échec de synchronisation.

## Solution appliquée

- Backend : table `trip_request_driver_refusals`, clé unique conducteur/demande,
  index sur la demande et références avec suppression en cascade. Migration
  `1780000095000-RememberDriverRequestRefusals.ts`, enregistrée dans l'index.
  Elle reprend les anciens refus explicites encore présents, jamais les demandes
  simplement ignorées. Elle ne peut pas reconstituer un ancien refus non enregistré.
- `src/trip-requests/request-refusal.ts` enregistre le refus dans une transaction
  verrouillant la demande, accepte les répétitions sans doublon et masque les
  notifications correspondantes de ce conducteur. Il fonctionne depuis une liste,
  même sans notification préalable, et après expiration de la sonnerie.
- Listes disponibles, pagination et détail filtrés dans `trip-requests.service.ts`
  et `request-pages.ts`. Le détail d'un trajet déjà attribué reste accessible.
  Filtrage avant pagination, puis nouvelle vérification pendant l'hydratation.
- Dispatch immédiat, alertes programmées, alertes de trajet partagé, contrôles de
  livraison et préparation de la sonnerie excluent ce couple conducteur/demande.
  Fichiers : `dispatch.service.ts`, `scheduled-request-alert.ts`,
  `shared-trip-alert.ts`, `notifications.service.ts`, `nearby-request-cooldown.ts`.
  Le parcours historique de réouverture filtre aussi les refus dans
  `trip-request-recovery.service.ts` et `trip-requests.service.ts`.
- Mobile : `nearbyRequestRefusal.ts` et `useRequestDriverActions.ts` attendent la
  confirmation serveur avant de fermer la demande et d'arrêter l'alerte. Un échec
  reste visible et permet de réessayer. Les actions concurrentes sont regroupées.
- `driverDispatchApi.ts` et `trip-request/refusalCache.ts` retirent la demande des
  caches disponibles après confirmation dans la même session, puis actualisent les
  listes et notifications. Les caches des commandes du passager sont conservés.
- `nearbyNotificationAction.ts`, `driverNotificationResponse.ts`,
  `driverInvitation.ts` et `useDriverNotifications.ts` dirigent un refus confirmé
  vers l'accueil. Une réponse incertaine garde l'accès au détail pour réessayer.
  Le parcours des réservations est conservé.

## Comportements conservés et précautions

La demande du passager n'est pas annulée. Les autres conducteurs peuvent toujours
la consulter et recevoir son alerte. Ignorer une sonnerie ne masque pas la demande.
Aucune suspension générale des alertes ni pénalité de 24 heures n'est réintroduite.
Les changements de compte/session empêchent une réponse tardive de masquer les
données du nouveau compte. Les identités SQL sont liées comme paramètres.

## Vérifications et limites

- Mobile : 56 tests JavaScript ciblés réussis (cache RTK réel, actions de
  notifications simulées, double clic, réseau indisponible, changement de session,
  navigation et parcours d'acceptation préservés). TypeScript et ESLint ciblé passent.
- Contrôles réseau et taille des sources : réussis ; 1 204 sources contrôlées,
  aucune au-dessus de 400 lignes.
- Backend : 167 tests réussis dans dix suites, dont la persistance, la concurrence
  et la migration sur PostgreSQL 17 jetable. Les trois suites de réouverture,
  routage et confidentialité passent aussi après le dernier ajout : 33 tests
  (certains déjà comptés dans les 167). Compilation NestJS réussie.
- PostgreSQL 18/PostGIS jetable : les 73 scénarios existants passent. Le scénario
  ajouté listes/pagination/alertes passe lors de sa relance ciblée après stabilisation
  de la date de création de la fixture (73 autres scénarios non rejoués). Fournisseurs
  de push simulés, aucun compte réel ni base existante utilisé.
- La première exécution géographique sur PostgreSQL 17 a été bloquée par l'absence
  de PostGIS. PostgreSQL 18 dispose de l'extension. Le nouveau scénario de pagination
  utilise une date de création historique fixe pour isoler le refus de la borne
  temporelle `asOf` et des différences de fuseau de l'environnement de test.
- Aucun essai physique Android/iOS, aucune compilation native et aucun envoi réel
  FCM/APNs pour cette modification. Une notification déjà remise au système avant
  le refus ne peut pas être rappelée de tous les téléphones par une transaction SQL.

## Mise en service

Migration préparée, non appliquée à la production. Déployer le backend avec cette
migration avant le mobile : les nouvelles requêtes serveur nécessitent cette table.
Sans ce déploiement, l'ancien serveur ne garantit pas la persistance du refus.
Le rollback supprime la nouvelle table ; les refus enregistrés uniquement dans cette
table ne sont alors plus mémorisés. Aucun déploiement ni modification de base de
production n'a été effectué.
