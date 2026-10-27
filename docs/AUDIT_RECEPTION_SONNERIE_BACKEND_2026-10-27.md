# Réception des sonneries et préparation du backend — 27 octobre 2026

## Périmètre et résultat

Cible déclarée par l'utilisateur : **Android Play Store 1.0.18, build 176**.
Préparation du backend uniquement ; l'utilisateur effectuera son déploiement.
Aucun déploiement, migration réelle, push réel ou modification du code mobile
d'exécution dans cette intervention. Les changements locaux préexistants sont conservés.

Les contrats de notification du backend actuel ont été exécutés contre les
parseurs et le registre d'alertes du commit mobile
`0ffc1910343a95356a45ab1124dec1e2e797ed9d` (version applicative 1.0.18), sans
utiliser les modifications mobiles non committées. EAS utilise une numérotation
distante : le numéro Android du fichier de configuration local ne prouve pas celui
du store. **La correspondance exacte entre cet arbre Git et le binaire 176 n'a pas
été attestée par un artefact EAS/Play.** Le résultat est une compatibilité de
sources vérifiée, pas une certification du binaire distribué.

## Fonctionnement actuel côté mobile

| Situation | Chemin et responsabilité |
| --- | --- |
| Android natif v6, application inactive | FCM → `RideFirebaseMessagingService` → `RideCardDelivery` → carte Notifee native ; ne dépend pas du démarrage de React pour la publication. Worker local de reprise bornée. |
| Android v4 | FCM → carte Expo de secours silencieuse et tâche JavaScript → carte Notifee sonore. Si la tâche JS ne démarre pas à temps, seule la carte silencieuse peut apparaître. |
| Android v3 | FCM data → tâche JavaScript → Notifee ; pas de carte native de secours v4. |
| Android v2 / non inscrit | Notification distante visible, son/canal selon les capacités enregistrées. Le serveur conserve ce repli ; il ne présume pas la présence du récepteur natif v6. |
| iOS | APNs, via Expo ou Firebase v5 : carte et son distants. Dans l'application, lecteur `expo-audio`. La voie Firebase est conditionnée par le binaire et sa configuration. |
| Application active | Push et socket utilisent les mêmes identifiants d'alerte et le même lecteur au premier plan. Les lectures REST actualisent l'état et les écrans ; elles ne réveillent pas un téléphone à elles seules. |
| Déverrouillage / ouverture | `useRideRinging` restaure les alertes, `driverNotifications` transfère le son Android vers le lecteur au premier plan après remplacement de la carte. Une ouverture n'est pas une acceptation. |
| Réponse | Actions existantes : refus REST, acceptation rapide des demandes immédiates, ou ouverture du détail pour les demandes programmées ; réservation sur trajet publié traitée séparément. |

Le récepteur natif vérifie le compte lié à la session, son expiration, les
identifiants du message, l'auteur, les autorisations et le canal. Le réveil et le
plein écran nécessitent aussi les conditions natives, le consentement et les
réglages système ; le serveur ne peut pas les activer dans un binaire installé.

Fichiers principaux examinés : `hooks/auth/usePushRegistration.ts`,
`hooks/notifications/useRideRinging.ts`, `useDriverNotifications.ts`,
`useRideRealtime.ts`, `services/driverNotifications.ts`, `nativeRideDelivery.ts`,
`foregroundRideSound.ts`, `rideNotificationReceipt.ts`, `backgroundNotificationTask.ts`,
`iosFirebaseMessaging.ts`, `features/notifications/driverInvitation.ts`,
`rideSound.ts`, `ridePlaybackDeadline.ts`, `services/rideAlertSession.ts`,
`native/android/notifications/RideFirebaseMessagingService.java`,
`RideCardDelivery.java`, `RideNotificationBundle.java` et `DriverAlertModule.java`.

La sonnerie est embarquée dans `assets/sounds/driver_ring.wav` pour iOS/lecteur JS
et `assets/sounds/android/driver_ring.wav` pour Android ; copie native Android :
`android/app/src/main/res/raw/driver_ring.wav`. Elle n'est pas téléchargée depuis Redis
ou transmise comme fichier par le socket. Le message déclenche la lecture locale.

## Défauts corrigés côté backend

### Identifiant de carte de secours

Une demande programmée séquentielle contient désormais **à la fois** un
`tripRequestId` et un `offerId`. `androidDriverBackup` choisissait le premier
identifiant non nul parmi réservation/offre/demande, donc l'offre, alors que le
mobile identifie une carte `nearby` par la demande. Cette divergence compliquait
notamment le nettoyage de secours par identifiant après une décision.

Correction dans `src/notifications/android-driver-backup.ts` : identifiant choisi
selon le type (`bookingId`, `offerId` ou `tripRequestId`). Le nouvel `offerId` reste
dans les données ; aucun changement d'action ni de route mobile.

### Durée de transport des invitations expirées

Le TTL v4/v6 d'une demande programmée restait à cinq minutes même si l'invitation
expirait après 40 secondes. Le récepteur v6 contrôle cette expiration, mais une
carte de secours d'un protocole antérieur pouvait arriver trop tard.

Correction dans le même fichier : le transport est borné par la première échéance
valide parmi `expiresAt` et `alertExpiresAt`, avec plafond de cinq minutes. Une
réservation sans échéance conserve son comportement de secours antérieur.
Ce TTL limite la livraison par FCM, **pas la durée d'un son déjà démarré**.
[Documentation FCM sur le TTL et l'acceptation fournisseur](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).

### Vérifications du relais dans le pipeline

`.github/workflows/deploy.yml` préparait PostgreSQL mais pas Redis. La suite
`sequential-dispatch.postgres.spec.ts` était donc susceptible d'être ignorée par
sa condition d'environnement. Le workflow prépare maintenant un Redis de test
sur loopback, port 16379, sans persistance, fournit son port à Jest puis l'arrête.
La modification préexistante du contrôle final ECS est conservée.
Syntaxe YAML vérifiée localement ; **workflow GitHub non exécuté**.

## Limites qui nécessitent encore du travail mobile ou un essai physique

1. **Repli de protocole mémorisé dans la session.** Dans `usePushRegistration`,
   le succès d'un repli remplit `capabilityKey` sans mémoriser le protocole accepté.
   Une session passée de v6 à v2 n'essaie donc pas automatiquement de remonter à v6.
   Constat déjà reproduit dans l'[audit AWS](operations/dispatch-ringing-diagnostic-2026-10-27.md).
   Pour le test serveur, fermer puis rouvrir réellement Zwanga recrée cet état
   mémoire et permet une nouvelle inscription ; vérifier ensuite le protocole
   effectivement enregistré. Ne pas convertir tous les comptes en v6 côté serveur.
2. **Expiration serveur et carte Android distinctes.** `RideNotificationBundle`
   n'applique `timeoutAfter` qu'au type `dispatch`, pas à `nearby`. Une carte
   programmée déjà affichée peut donc persister après les 40 secondes et son
   extrait natif peut finir au-delà de l'échéance. Les métadonnées de fin limitent
   le lecteur au retour dans l'app, mais ne coupent pas à elles seules la
   notification Android déjà publiée. L'acceptation tardive reste refusée côté
   serveur. Une fermeture native synchronisée à l'échéance reste à préparer
   dans un prochain binaire.
3. **Transfert du son à l'entrée.** Création du canal, annulation de la carte,
   remplacement puis initialisation du lecteur passent par plusieurs appels
   natifs. Une interruption, une échéance déjà dépassée ou un échec natif peut
   provoquer une coupure. Les tests de reprise ne mesurent pas cette latence sur
   les téléphones du test ; un backend seul ne corrige pas ce code installé.
4. **Observation incomplète de la réception.** `received`/`displayed` ne prouvent
   pas que le son a été audible. Les reçus natifs peuvent être transmis seulement
   au retour dans l'app. Le renvoi serveur borné v6 utilise la déduplication
   native ; il n'est pas étendu aveuglément aux protocoles plus anciens.
5. **Délai de contact consommé par le transport.** Les 40 secondes commencent à
   la création de l'invitation SQL, pas à l'affichage. Un appareil lent ou hors
   réseau peut ne pas avoir le temps de répondre. Aucun reçu n'étend ce délai.
6. **Voie Expo iOS conservée.** Les demandes proches via cette voie n'ajoutent
   pas de catégorie native de décision : l'ajouter seule ferait apparaître un
   bouton « Refuser » sans le protocole nécessaire à son exécution sur l'ancien
   client. Ouverture du détail conservée. La voie Firebase v5 possède déjà sa
   catégorie dédiée. Aucun build iOS précis n'a été fourni pour cet audit.

La présentation reste également soumise au système et aux autorisations du
téléphone ; voir la [documentation Android](https://developer.android.com/develop/ui/views/notifications/time-sensitive).
Il n'y a pas de garantie de réveil ou de son audible sur tous les appareils.

## Vérifications réalisées

- **45 tests backend réussis** : nouvelle suite `ride-mobile-compatibility.spec.ts`
  (23 cas), et suites natives Android, iOS et fiabilité de livraison. Envois
  Firebase et Expo simulés, protocoles 0 à 6, demandes immédiates/programmées,
  réservations et échéances. Les assertions de TTL de la suite existante ont
  été adaptées à la correction effective.
- **20 contrôles croisés réussis** contre le commit mobile indiqué : messages
  réellement construits par les fonctions backend puis lus par les parseurs du
  commit, routes, actions, identité, doublons, refus de l'auto-notification et
  absence de reprise d'une invitation expirée.
- **88 tests mobiles réussis**, sans échec ni test ignoré : inscription push,
  validation du payload natif, reprise audio, expiration, restauration, actions,
  socket et règles audio. Inclut une politique Java exécutée sur JVM ; ce n'est
  pas un essai Android instrumenté.
- Compilation TypeScript backend sans émission réussie. YAML du workflow
  correctement analysé. Pas de compilation native, de test sur appareil ou de
  nouvel essai PostgreSQL/Redis dans cette intervention ; les 104 scénarios
  d'intégration précédents sont décrits dans le rapport des correctifs du relais.

Commande reproductible depuis le dépôt mobile, après installation des dépendances :

```powershell
node scripts/check-backend-mobile-ringing.cjs --backend ../zwanga-backend --mobile-ref 0ffc1910343a95356a45ab1124dec1e2e797ed9d
```

Ce script ne lit que les modules de contrat explicitement autorisés et ne contacte
aucun fournisseur. Le commit peut être remplacé par celui attesté du build 176.

## Mise à jour serveur et test avec le mobile 176

Préparation locale disponible dans `zwanga-backend`, à déployer par l'utilisateur.
Le lot du relais dépend des migrations 95 à 98, y compris les changements de
refus et de ciblage ; ne pas publier les seuls fichiers de notification en
présumant que cela active la file Redis. Exécuter les migrations enregistrées
avant le démarrage du nouveau backend et attendre le retrait des anciens workers
avant les essais : le déclencheur SQL de la migration 97 ne rend pas les anciens
workers compatibles avec toutes les phases de la migration 98.

Le workflow `release` existant exécute tests, compilation, migration puis
déploiement. Les modifications locales doivent être relues et incluses
explicitement dans le lot ; aucune fusion de `master`, aucun commit ni push n'a
été effectué pendant cet audit.

Essais recommandés après déploiement : deux conducteurs éligibles avec comptes
distincts, commandes créées volontairement pour le test, puis refus, silence de
40 secondes et acceptation. Refaire ces cas app ouverte, hors app et écran
verrouillé ; vérifier séparément envoi serveur, réception, affichage, son et
ouverture du bon détail. Ajouter une réservation sur un trajet publié pour
contrôler ce parcours distinct. Ces essais restent **à réaliser**.
