# Fiabilisation des alertes conducteur — correctifs du 2 novembre 2026

## Complément — cohérence backend AWS / code local / mobile

- **Compatibilité mobile :** les requêtes de création, modification et recherche de conducteur avec un seul type utilisent `vehicleType`, compatible avec l'ancien DTO strict. Les sélections multiples restent intactes ; un ancien serveur qui les refuse produit un message invitant à sélectionner un type, sans nouvelle tentative automatique de création ni réduction silencieuse du choix.
- **Délai de réponse :** migration additive **110 — ReceiptResponseWindow**. Les nouvelles invitations automatiques ont au maximum 40 secondes pour recevoir un accusé authentifié, puis 40 secondes de réponse à compter du premier accusé accepté côté serveur, plafonnées par l'expiration de la demande (80 secondes au total maximum). Verrouillage demande puis invitation, aucun appel réseau sous verrou. Un doublon n'allonge pas le délai ; une invitation déjà expirée, refusée, remplacée ou acceptée n'est jamais réactivée. Redis peut conserver l'ancien réveil : la relecture SQL retrouve la nouvelle échéance et reprogramme ce réveil. Les invitations déjà créées avant migration et la priorité explicite de trois minutes sur la carte restent inchangées.
- **Limite importante :** c'est le délai d'acceptation serveur qui est corrigé, pas une garantie de 40 secondes audibles. Le mobile actualise l'offre après l'accusé, mais les sons/cartes natifs déjà présentés gardent leur échéance sonore d'origine pour éviter une nouvelle sonnerie ou une prolongation sur un doublon. Un téléphone qui ne remonte pas son accusé avant l'échéance de livraison reste soumis au relais après 40 secondes. Aucun appel natif, FCM ou SMS réel n'a été effectué.
- **Localisation :** `needsLocationRefresh` et `alertLocationMaxAgeSeconds` distinguent la position durable pour consulter les demandes de la position de moins de 48 h requise pour recevoir les nouvelles alertes. Le statut tient aussi compte de la position récente du trajet en cours. L'application adapte ses indications, sans modifier le rayon ni l'opt-out ni les autorisations système.
- **Trajets récurrents :** une occurrence nouvelle en conflit horaire n'annule plus le lot des autres jours. Un véhicule absent/inactif met le modèle en pause sous contrôle de sa révision, avec une notification transactionnelle unique ; une réparation concurrente n'est pas écrasée. Les erreurs SQL et les conflits de publication manuelle restent des erreurs, pas des succès silencieux.
- **Déploiement ultérieur :** appliquer les migrations enregistrées, dont la 110, avant le backend ; déployer le backend avant les fonctions multi-véhicules du nouveau mobile. Aucun changement AWS, Terraform ou CI/CD effectué pour ce complément. Les changements préexistants de ces fichiers sont conservés.
- **Premières vérifications :** 11 tests sur PostgreSQL jetable réussis (concurrence des accusés, expiration, propriétaire, migration aller/retour et intégrité du portefeuille), 62 tests mobiles ciblés réussis ; compilations TypeScript backend et mobile réussies. Les vérifications plus larges sont consignées après leur exécution ci-dessous.

### Revalidation du complément

- Suite PostgreSQL de cohérence étendue : **14 tests réussis**, dont trois cas de pause de récurrence (précision microseconde SQL, modification concurrente et rollback de la notification). Le verrouillage court et la notification dans la transaction suivent les recommandations PostgreSQL utilisées pour cette intervention.
- Dispatch séquentiel sur PostgreSQL/PostGIS et Redis jetables : **77 réussites, trois scénarios optionnels ignorés**. Une première exécution combinée avait dépassé les délais de préparation/arrêt du PostgreSQL temporaire ; la relance séparée est réussie, sans allonger les délais de production.
- Régressions mobiles ciblées après ajustement des actions de notification et de l'empreinte API : **75 réussites, zéro échec**. L'empreinte modifiée concerne uniquement les deux mutations de demande désormais compatibles avec l'ancien backend ; les tests comportementaux conservent les choix multiples et empêchent leur réduction silencieuse.
- Une action explicite sur une notification de dispatch utilise la validation de l'échéance actuelle par le serveur, plutôt que de refuser localement à partir de l'ancien contenu push. Les décisions hors ligne ne sont pas rejouées et les réservations conservent leur contrôle local existant. Le banc HTTP mobile optionnel vérifie aussi le contrat enrichi des accusés et mesure les 40 secondes depuis leur acceptation, pas depuis la création.
- TypeScript backend de production réussi après les derniers changements ; vérification des différences Git réussie. Aucun solde réel corrigé, aucune infrastructure modifiée, aucun service distant appelé par ces régressions.
- Contrôle mobile complet `node scripts/check-release.cjs` : **3 090 réussites, zéro échec, un test ignoré** (3 091 tests). TypeScript, ESLint, frontières réseau, taille des sources et parité des sources natives sont également réussis. Cette parité n'est pas une compilation ni un essai Android/iOS physique.
- Campagne générale backend `node node_modules/jest/bin/jest.js --runInBand --silent` : **271 suites réussies, 38 ignorées ; 3 327 tests réussis, zéro échec, 748 ignorés**. Les suites conditionnées par PostgreSQL/Redis ou un banc mobile ne sont pas annoncées validées par ce total. La campagne de cohérence PostgreSQL et les suites dispatch séparées couvrent les changements de cette intervention ; leurs nombres ne s'ajoutent pas aveuglément à ce total.
- La suite générale dispatch a exécuté ses **127 tests avec succès**, mais son nettoyage a dépassé deux fois le délai Windows de 30 secondes. Les journaux du PostgreSQL jetable montrent un checkpoint/synchronisation disque de plusieurs minutes. Le nettoyage attend désormais jusqu'à quatre minutes sous Windows, puis échoue si l'arrêt n'est pas confirmé ; le délai Linux reste de 30 secondes. Ni délai métier, ni assertion de latence, ni configuration PostgreSQL de l'application ne sont modifiés. **Relance complète finale réussie : 127 tests, zéro échec, code de sortie 0, PostgreSQL et Redis temporaires arrêtés.**

Les six constats de [l’audit](audit-driver-alerts-2026-11-02.md) ont été traités localement dans le backend et l’application `zwanga`. Aucun déploiement, changement AWS/Terraform/CI/CD, envoi push réel ou appel SMS/paiement n’a été effectué. Les changements concurrents de véhicules multiples, localisation et retraits sont conservés.

## Changements

| Audit | Correction | Protection conservée / limite |
|---|---|---|
| A01 — bail Redis consommé par la recherche SQL | Libération du bail avant la découverte, requête dans une transaction avec `statement_timeout=3s`, trois découvertes simultanées maximum par processus, nouvelle acquisition du bail avant remplissage. Une saturation programme une reprise durable à une seconde. | L’attente du pool ne détient plus ce bail. Revalidation SQL de la demande, de sa version et du candidat ; un seul conducteur réservé. Le timeout de connexion existant reste applicable. |
| A02 — attente des envois urgents | Ordre FIFO commun aux types urgents ; huit envois simultanés par défaut, plafond configurable et borné. Contrôle de l’échéance d’invitation avant et après OAuth. Journaux de temps d’attente et durée de tentative. | Le délai métier n’est pas renouvelé à chaque envoi. Les nouvelles invitations automatiques disposent de 40 secondes, conformément à la dernière décision. Une réservation/décision encore valide conserve son comportement de carte tardive. Une charge arbitraire ne peut pas être absorbée dans ce délai. |
| A03 — reprises trop fréquentes | Compteur, prochaine tentative et erreur permanente persistés en PostgreSQL ; délai exponentiel avec aléa, respect de `Retry-After`, attente minimale de 60 secondes après un 429 FCM. Les sélecteurs de reprises utilisent ces champs. | Les échéances métier restent prioritaires : une offre expirée n’est pas ressuscitée. Une erreur permanente n’est pas reprise en boucle ; un nouveau token utilisateur peut autoriser une nouvelle tentative après le délai. |
| A04 — OAuth bloqué | Client JWT public `google-auth-library` déjà installé, transport réellement annulable à cinq secondes, sans reprise HTTP cachée, renouvellement partagé, court délai de récupération et nouveau client à la tentative suivante. Invalidation des caches de token après un 401 FCM. | Pas de course abandonnant indéfiniment des appels réseau. Les logs ne contiennent ni clé ni token. Les erreurs permanentes de configuration exigent une intervention, pas des tentatives infinies. |
| A05 — récupération Android tardive | Worker immédiatement éligible ; mode accéléré Android 12+, repli normal si quota épuisé. Déduplication persistante avant initialisation audio lors d’une fin tardive de publication Notifee. | Android plus ancien conserve un worker normal sans délai initial. L’envoi initial natif, le travail unique `KEEP`, la limite de reprises, le propriétaire du compte et l’échéance restent vérifiés. Android peut malgré tout différer le travail. |
| A06 — affichage distinct du son | Trois observations bornées `audio_started`, `audio_failed`, `audio_suppressed`, avec motifs autorisés et dates appareil/serveur séparées. Émission de `audio_started` après `MediaPlayer.start()` et `isPlaying()`. | Le diagnostic concerne le lecteur natif Android en arrière-plan. Ce n’est pas une preuve d’audibilité, ni une mesure équivalente sur iOS/lecteur JS au premier plan. Aucun enregistrement audio, numéro ou coordonnée ajouté. |

La file de candidats reste **propre à chaque demande**, dans Redis. PostgreSQL conserve les invitations et la notification transactionnelle ; les appels aux fournisseurs restent hors transaction d’attribution. Les règles de véhicule, KYC, proximité, fraîcheur GPS, refus, disponibilité et unicité ne sont pas supprimées pour accélérer l’envoi. Le guide PostgreSQL a orienté la durée des verrous et les tests sur instances isolées.

## Configuration et migration

`URGENT_PUSH_WORKERS` est facultatif : valeur par défaut `8`, entier accepté de `1` à `20` (une valeur supérieure est plafonnée à `20`, une valeur invalide revient à `8`). Ce budget est **par processus** : multiplier les tâches ECS multiplie aussi la concurrence. Ne pas augmenter sans observer PostgreSQL et les quotas du fournisseur. Aucun fichier `.env` n’a été modifié.

Migrations enregistrées : `1780000106000-AlertDeliveryReliability`, `1780000107000-DriverResponse75Seconds`, puis `1780000108000-DriverResponse40Seconds`.

- `notifications` : `pushAttempts`, `pushRetryAt`, `pushPermanentFailure`.
- `ride_notification_receipts` : `audioEvents`, objet JSON limité applicativement à trois étapes autorisées ; première observation conservée par étape.
- Migration transactionnelle avec attente de verrou limitée à cinq secondes et requêtes à quinze secondes ; elle échoue plutôt que d’attendre indéfiniment sous charge.
- La migration historique `107` n’est pas réécrite. La nouvelle `108` rétablit le plafond du trigger à 40 secondes pour les futures invitations séquentielles, y compris si un ancien allocateur demande encore 75 secondes. Aucune échéance existante n’est modifiée. Son `down` restaure le plafond de 75 secondes pour les futures insertions ; le code doit également être restauré pour demander cette durée.

Ordre de livraison, à réaliser séparément :

1. Exécuter les migrations encore en attente dans l’ordre `106`, `107`, `108` avec le mécanisme habituel, **avant** le nouveau backend. Les nouveaux champs de l’entité seraient sinon absents et les lectures échoueraient. `108` fixe l’état final du plafond à 40 secondes.
2. Déployer le backend, puis contrôler les journaux et les demandes synthétiques de recette. Aucun changement d’endpoint existant ; les métadonnées de reçu sont facultatives.
3. Reconstruire et publier l’application Android via le workflow mobile habituel : le plugin `withDriverAlertSources` copie les sources Java canoniques. Une simple mise à jour JavaScript n’applique pas le worker ni le lecteur natif corrigés. Les anciennes applications bénéficient des améliorations backend, sans nouvelle télémétrie audio.

Retour arrière : revenir d’abord au backend précédent et conserver temporairement les colonnes additives est le choix le moins intrusif. Le `down` existe et a été testé, mais il supprime les métadonnées de reprise/audio ; il ne doit pas tourner pendant que le nouveau backend les utilise. Il ne supprime pas les notifications ni les demandes de trajet.

Après une erreur permanente de clé/configuration, réparer les identifiants ne remet pas automatiquement toutes les anciennes notifications dans la file. Toute remise en traitement doit être ciblée et revalider l’état métier ; aucun outil de relance massive ni réémission d’invitations expirées n’a été ajouté.

## Observabilité

`URGENT_PUSH_QUEUE_DELAY` signale une attente d’au moins cinq secondes. `URGENT_PUSH_RESULT` rapporte `queueAgeMs`, `elapsedMs`, le statut et l’occupation des workers, sans token ni contenu de demande.

Les reçus audio sont rattachés à une notification appartenant au compte authentifié, puis transmis à la réouverture/reprise de l’app. Ils peuvent donc arriver tard. `recordedAt` est la date serveur ; `observedAt` est la date appareil, bornée entre sept jours dans le passé et cinq minutes dans le futur. Leur absence ne prouve pas l’absence de sonnerie. Une erreur de télémétrie ne bloque jamais l’alerte et ne prolonge pas sa durée.

## Délai automatique de 40 secondes par conducteur

Le délai part de la réservation serveur de l’invitation, pas de la réception sur le téléphone. Un refus passe immédiatement au candidat suivant ; l’absence de réponse attend l’échéance de 40 secondes, puis le traitement des échéances relaie au suivant. Les échéances Redis, SQL, la configuration retournée au client et les limites de livraison/récupération des notifications de demande utilisent la même durée. Un push reçu à la 35e seconde dispose des cinq secondes restantes, pas de 40 secondes supplémentaires. La séparation entre délai de livraison et délai de réponse après accusé de réception n’est pas ajoutée ici.

Les anciennes invitations déjà émises gardent leur échéance SQL originale ; les nouveaux sélecteurs de récupération sont bornés à 40 secondes pour les demandes. La priorité de 180 secondes d’un conducteur explicitement choisi sur la carte et le délai de décision passager de 120 secondes sont des parcours distincts et restent inchangés. Les autres notifications gardent leur fenêtre de sonnerie/realtime de 60 secondes et leur fenêtre de reprise sans accusé de réception de 45 secondes. Les protections natives plafonnant la lecture sonore continue à 60 secondes sont conservées, sans prolonger une invitation expirée.

Le rattrapage REST dans `zwanga/features/notifications/driverAlertRecovery.ts` accepte les alertes de demande jusqu’à leur échéance, avec un plafond de 40 secondes. Les anciennes applications conservent leurs propres plafonds de rattrapage mais restent soumises à l’échéance absolue retournée par le backend. La modification mobile harmonise ce plafond local sans changement de style ni de code natif.

Vérification du retour à 40 secondes : **77 tests PostgreSQL/Redis réussis, trois ignorés**, dont le relais après une attente réelle de 40 secondes et le retour arrière de `108` sans modification des échéances enregistrées. Une deuxième campagne de **125 tests PostgreSQL** vérifie notamment les fenêtres distinctes des demandes et réservations. Les services temporaires sont arrêtés.

## Vérifications du retour à 40 secondes et du rapprochement admin

| Contrôle | Résultat |
|---|---|
| Campagne générale backend, environnement isolé sans accès prestataire | 3 270 réussites, zéro échec, 717 ignorés ; 268 suites réussies |
| Relance ciblée après finalisation du contrat admin et des délais | 102 réussites, zéro échec |
| PostgreSQL/PostGIS/Redis, deux campagnes dédiées | 77 + 125 réussites, zéro échec, trois scénarios optionnels ignorés |
| Administration, rapprochement et non-régression financière | 43 réussites, zéro échec |
| Mobile, alertes et reçus | 132 réussites, zéro échec |
| TypeScript backend, admin et mobile, sans émission | Réussi |
| ESLint des nouveaux fichiers backend et de la récupération mobile modifiée | Réussi |

Les tests ignorés de la campagne générale ne sont pas annoncés comme validés ; les campagnes ciblées recouvrent une partie de cette suite et ne s’additionnent pas à son total. Les tests admin simulent les échanges HTTP et les états de composants ; ils ne sont pas un essai dans un navigateur ni un appel FlexPaie réel. Aucun versement, SMS, push distant ou déploiement effectué.

Le contrat ajouté `POST /api/v1/admin/payments/:paymentId/reconcile` et la correction du message admin sont décrits dans le [guide financier](../finance/driver-payout-corrections.md). Les consignes PostgreSQL ont guidé la migration courte et bornée, sans réécriture de l’historique ni des échéances publiées.

## Vérifications locales de la campagne initiale

- Campagne générale backend isolée : **3 209 tests réussis, zéro échec, 709 ignorés**. Les tests qui nécessitent PostgreSQL/Redis ou une activation explicite ne sont pas tous exécutés par cette campagne.
- Campagne ciblée backend après les derniers ajustements : **344 réussites, zéro échec, 73 ignorés**.
- Campagne dédiée PostgreSQL/PostGIS/Redis : les **quatre nouveaux tests** de migration/reprises/reçus et les **120 tests de dispatch** passent. Le premier passage de la suite séquentielle a révélé une assertion supposant que huit recherches démarrent toutes immédiatement, alors que le budget est désormais de trois. Le test vérifie maintenant les reports durables puis leur reprise. Le délai de nettoyage de son PostgreSQL temporaire a également été porté de 30 à 60 secondes après un checkpoint Windows de 32 secondes ; aucune temporisation de production n’a changé. Second passage séquentiel : **75 réussites, zéro échec, trois ignorés**. Le cas de découverte retardée de onze secondes vérifie la libération du bail puis une invitation et une notification uniques. Les instances temporaires des campagnes sont arrêtées.
- Tests mobiles ciblés : **131 réussis, zéro échec**, dont les contrats de récupération native et les reçus audio. Ces tests incluent des simulations et des vérifications de source.
- TypeScript backend de production et mobile : réussis, sans émission.
- ESLint mobile ciblé, contrôle de taille des sources mobiles et vérification des différences : réussis.
- Banc Android natif : `assembleDebug` hors ligne réussi, avec compilation des sources Java modifiées. Il ne s’agit pas de la compilation complète de l’application ni d’un essai sur téléphone.
- Simulation de capacité : seize notifications, fournisseur simulé à quinze secondes, huit envois simultanés maximum ; le dernier envoi démarre à quinze secondes lors du drainage suivant simulé. Ce résultat n’est pas une latence de réception FCM ni une garantie sous charge réelle ; le déclenchement du cron ajoute sa propre attente.
- Simulation OAuth : huit demandes concurrentes partagent un seul appel bloqué ; le transport est annulé à cinq secondes et une tentative ultérieure récupère. Aucun fournisseur réel contacté.

Les nombres des campagnes ne doivent pas être additionnés : certains tests sont rejoués. Les fichiers ignorés `tmp/audit-alerts-*` et `tmp/ci-*-20261031.*` contiennent les sorties locales, sans être requis au runtime.

## Recette restant à effectuer

Sur un téléphone Android de test : application en arrière-plan et écran éteint, demande immédiate puis programmée, refus du premier conducteur, absence de réponse pendant 40 secondes, second conducteur, notifications désactivées, économie d’énergie et quota WorkManager épuisé. Contrôler l’absence de double sonnerie et l’arrêt à expiration, puis les reçus après réouverture. Vérifier aussi le parcours iOS existant sur appareil.

FCM/APNs, la connexion, le volume, les permissions, le mode silencieux, les restrictions Android/iOS et un arrêt forcé peuvent empêcher une sonnerie. Les correctifs réduisent les défauts de la chaîne applicative ; ils ne permettent pas de garantir que chaque appareil sonnera.

Références fournisseur : [temporisation et charge FCM](https://firebase.google.com/docs/cloud-messaging/scale-fcm), [priorité des messages Android](https://firebase.google.com/docs/cloud-messaging/android-message-priority), [travaux accélérés WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work), [authentification Google par compte de service](https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
