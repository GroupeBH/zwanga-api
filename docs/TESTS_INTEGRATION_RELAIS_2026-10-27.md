# Essais locaux du relais backend et des alertes mobiles — 27 octobre 2026

## Périmètre

Demande : tester localement les ajouts du relais Redis et leur intégration avec
les notifications et actions mobiles. Aucun déploiement, accès à la base de
production, compte réel ou envoi FCM/APNs réel. Aucun fichier `.env` n'est chargé.

Ces essais exécutent une chaîne intégrée, mais **pas une recette complète de
l'application React Native installée depuis le store**. Le package Android
séparé `com.zwanga.audit` n'a pas de permission Internet et ne remplace pas Zwanga.

## Ce qui est exécuté

- PostgreSQL 18/PostGIS jetable, Redis dédié sur `127.0.0.1:16379`, API NestJS sur
  un port local aléatoire. Les migrations nécessaires au relais et aux reçus sont
  appliquées à la base de test ; ce n'est pas une migration d'une copie de production.
- Création par le véritable contrôleur et service de demandes, filtrage géographique,
  file Redis, transactions de refus et d'acceptation, autorisation métier et DTO.
- Véritable `NotificationService`, sérialisation du message et requête HTTP de
  transport. Seul le fournisseur Firebase est remplacé par un serveur local.
  Le test rejette les destinations HTTP externes.
- Payload backend injecté par ADB dans le véritable `RideCardDelivery` compilé
  depuis les sources natives actuelles. Android/Notifee publient la carte ; son
  reçu d'affichage est renvoyé à l'API backend par le contrat mobile réel.
- Véritables parseurs, gestionnaires `nearbyNotificationAction` et
  `driverNotificationResponse`, et définitions d'API TypeScript du mobile local.
  Redux réseau, SecureStore, authentification de test et retour visuel sont des
  adaptateurs. L'action est appelée à la frontière du callback natif ; ce n'est
  pas un toucher traversant le pont React Native et l'écran métier complet.
- Émulateur Android 16/API 36, banc recompilé hors ligne avec JDK 17 et Gradle
  8.14.3. Le lecteur natif, les notifications, le verrouillage et le réveil de
  l'écran utilisent les services Android réels.

## Scénarios intégrés ajoutés

1. Demande programmée créée par HTTP ; un seul conducteur proche est sollicité.
   Un conducteur qui commande pour lui-même et un conducteur hors rayon sont exclus.
   Le reçu d'affichage appartient uniquement au destinataire.
2. Refus exécuté par le gestionnaire mobile et envoyé à l'API : le conducteur
   suivant reçoit une invitation ; rejouer le premier refus ne saute pas ce suivant.
   Le premier conducteur ne peut plus consulter la demande.
3. Demande immédiate laissée sans réponse : attente de quarante secondes réelles,
   relais par le planificateur NestJS, sans vieillissement artificiel SQL.
   Le second conducteur accepte par le gestionnaire mobile ; l'acceptation est
   persistée une seule fois, la file s'arrête et un tiers ne voit plus la demande.

La confirmation envoyée au passager est distinguée des invitations conducteur :
elle est attendue après acceptation et ne constitue pas une sollicitation supplémentaire.

## Résultats

- Deux suites PostgreSQL/Redis : **106 tests réussis**, dont les deux parcours
  croisés ajoutés. Première mesure du relais, avec appels explicites du worker :
  **40,412 secondes**. Les deux nouveaux parcours ont ensuite été rejoués avec le
  véritable `ScheduleModule` NestJS : **2 réussites**, relais observé à
  **41,164 secondes**, sans appel manuel du worker pendant l'attente. Les 23
  autres cas étaient volontairement exclus de cette seconde commande ciblée ;
  ils avaient réussi dans l'exécution complète. Le délai inclut la cadence du
  cron, la charge locale et la publication HTTP, pas une garantie de livraison à
  exactement 40 secondes sur un téléphone.
- Contrats de push Android/iOS et réponses aux réservations : **51 tests réussis**.
- Gestionnaires et politiques mobiles : **129 tests réussis**, dont refus,
  ciblage, déduplication, restauration, expiration et transfert de sonnerie.
- Publieur Android de production dans le banc : **9 scénarios réussis** : carte
  visible/actionnable, déduplication, secours après échec Notifee, réservation
  tardive silencieuse, exclusion de l'auteur, offre expirée, reprise WorkManager,
  écran réveillé et activité plein écran lorsque l'autorisation est accordée.
- Cycle de vie et boutons Android : **21 scénarios réussis, aucun échec** :
  8 réceptions (demande/réservation, application ouverte, autre application active,
  veille sans/avec plein écran), refus de permission, 6 appuis sur la notification
  et 6 sur le plein écran. La carte est conservée à l'ouverture, le lecteur natif
  reprend après déverrouillage, et la décision simulée arrête le lecteur et retire
  la carte. Les boutons du banc ouvrent sa fiche fictive : les décisions HTTP
  réelles sont vérifiées séparément dans les deux parcours croisés ci-dessus.
  Total natif : **30 scénarios**, sans extrapolation aux téléphones physiques.
- TypeScript backend avec `tsconfig.build.json --noEmit --incremental false` :
  **réussi**. ESLint des adaptateurs mobiles modifiés : **réussi**.
- TypeScript global avec les tests : **40 erreurs dans des fichiers `.spec.ts`
  préexistants**, sans erreur dans le nouvel adaptateur. Cette commande avait
  aussi tenté une écriture de cache refusée par le sandbox. Le contrôle du build
  a ensuite été exécuté sans cache incrémental. La validation globale des tests
  TypeScript reste donc incomplète, même si les suites ciblées passent sous Jest.

## Corrections du banc et fichiers

- `scripts/audits/test-native-ride-delivery.cjs` : les dates synthétiques utilisent
  l'horloge de l'émulateur. Un décalage mesuré d'environ **−3,3 secondes** par rapport
  au PC produisait un faux échec sur une offre expirée d'une seule seconde.
  L'horloge du téléphone et le code de production ne sont pas modifiés.
- Les deux runners Android acceptent `RIDE_AUDIT_OUTPUT` pour conserver les traces
  précédentes. `scripts/audit-android-alerts.cjs` remet aussi le consentement et
  l'app-op plein écran du seul package de test à leur état de test par défaut.
- `tests/helpers/rideActionHttpClient.cjs` charge le TypeScript mobile réel et
  remplace ses frontières de stockage, réseau Redux et interface native.
- Backend : `test/sequential-mobile-flow.ts`, appelé par
  `src/trip-requests/dispatch/sequential-dispatch.postgres.spec.ts`, uniquement
  lorsque `RIDE_AUDIT_MOBILE_ROOT` est explicitement défini.
- Aucun changement de logique applicative ni de protocole de production dans
  cette intervention. Les modifications locales préexistantes sont conservées.

## Reproduction

Installer préalablement le package du banc recompilé, puis utiliser un émulateur
dédié sans PIN ni données personnelles. Démarrer un Redis de test dédié sans
persistance sur le port 16379, jamais le Redis de l'application.

Depuis le backend, avec Node 24.22.1 :

```powershell
$env:DISPATCH_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
$env:DISPATCH_TEST_REDIS_PORT='16379'
$env:RIDE_AUDIT_MOBILE_ROOT='C:/Users/hp/projects/zwanga'
$env:RIDE_AUDIT_ADB='C:/Users/hp/AppData/Local/Android/Sdk/platform-tools/adb.exe'
$env:RIDE_AUDIT_SERIAL='emulator-5554'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/trip-requests/dispatch/sequential-dispatch.postgres.spec.ts src/trip-requests/dispatch/dispatch-postgres.spec.ts
```

Depuis le mobile, exécuter les runners **successivement**, sans autre test qui
utilise le même émulateur. Mettre le dossier `platform-tools` dans `PATH` :

```powershell
$env:RIDE_AUDIT_OUTPUT='.expo/ride-e2e-20261027'
node scripts/audits/test-native-ride-delivery.cjs
$env:RIDE_AUDIT_OUTPUT='.expo/ride-e2e-20261027/lifecycle'
node scripts/audit-android-alerts.cjs emulator-5554 --with-lock --fixed
```

Les bases jetables sont arrêtées et supprimées par les fixtures. Arrêter uniquement
le Redis de test démarré pour cette session après les essais. Les preuves locales
sont dans `.expo/ride-e2e-20261027/` et les journaux temporaires
`zwanga-e2e-20261027-*.txt`. Les identités des fixtures sont entièrement synthétiques.

Pour cette exécution, les clusters créés pendant la session ont été supprimés et
l'instance Redis temporaire a été arrêtée après vérification de son PID et de son
port. Les anciens dossiers de tests datés des 22 et 26 octobre n'ont pas été touchés.
Les captures plein écran sont volontairement masquées par `FLAG_SECURE` : les
preuves de lancement et d'interaction viennent des états Android et des événements,
pas d'une capture lisible de cet écran protégé.
Le banc est revenu au lanceur Android, écran actif ; son consentement plein écran
est remis à false et son app-op à default. Le verrouillage initial de l'émulateur
est restauré. Aucun réglage de l'application Zwanga réelle n'a été modifié.

## Limites

Pas de transport FCM/APNs ni de connexion WebSocket réelle, de reprise du processus complet React Native,
d'authentification réelle, de mesure d'audibilité sur haut-parleur, de Doze profond,
de restriction constructeur ou d'essai iPhone. La réservation est couverte par
les contrats, gestionnaires et scénarios natifs ; sa création métier complète
par une interface passager n'est pas jouée dans le nouveau test croisé.

Les scénarios utilisent le mobile local actuel. Ils ne prouvent pas que le binaire
Play Store **1.0.18 (176)** contient exactement ces sources ; le précédent audit de
compatibilité reste applicable séparément. Aucun résultat ici ne garantit la
livraison de toutes les sonneries ni l'absence de crash en production.
