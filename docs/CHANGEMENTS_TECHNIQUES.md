# Journal des changements techniques

## 2026-10-27 — Compatibilité sonnerie avec Android 1.0.18 (176)

- Préparation serveur : identifiant de secours par type, expiration de transport bornée pour les demandes séquentielles, Redis isolé dans le pipeline de tests.
- Contrats v0 à v6 conservés ; aucune migration supplémentaire ni modification mobile d'exécution. Les migrations 95 à 98 du relais restent nécessaires pour publier le lot complet.
- 45 tests backend, 88 tests mobiles et 20 contrôles croisés réussis ; TypeScript backend et YAML vérifiés. Ni déploiement, ni notification réelle, ni essai physique.
- Détail, limites et test avec le mobile du store : [rapport](AUDIT_RECEPTION_SONNERIE_BACKEND_2026-10-27.md).


## 2026-10-27 — Correctifs du relais et des réponses aux demandes

- Délais Redis complétés, acceptation protégée avant préparation puis finalisée avec la réservation, reprise des trajets provisoires et fenêtre distincte pour les contre-propositions.
- Migration `1780000098000-RequestResponsePhases` préparée ; contrôles d'accès et notifications obsolètes adaptés. Paiements, réservations des trajets publiés et ciblage privé conservés.
- 104 scénarios d'intégration serveur, 59 tests unitaires serveur et 23 tests mobiles distincts réussis. TypeScript vérifié ; push simulés, bases jetables, aucun déploiement.
- Fichiers, résultats et limites : [rapport des correctifs](CORRECTIFS_RELAIS_DEMANDES_2026-10-27.md).


## 2026-10-27 — File Redis et relais des demandes après 40 secondes

- **Demande :** solliciter un seul conducteur, passer au suivant après refus ou
  absence de réponse pendant 40 secondes, retirer la demande après acceptation.
- **Solution préparée :** file Redis, callback authentifié, traitement serveur des
  échéances, historique SQL, contrôles d'acceptation et migration backend.
- **Comportements conservés :** demandes ciblées privées, contrôles de proximité,
  formats de notification et parcours de réservation des trajets publiés.
- **Vérifications et limites :** voir [le dossier technique](FILE_DEMANDES_REDIS_2026-10-27.md).
  Aucun déploiement ni test push sur des utilisateurs de production.

## 2026-10-27 — Destinataire facultatif des demandes de trajet

- Problème : aucun ciblage d'un conducteur proche ou connu.
- Appliqué : sélection éligible bornée, audience privée, contrôles des lectures,
  offres, refus et notifications ; élargissement explicite sous verrou de commande.
  Migration additive 1780000096000 et protections contre une ouverture involontaire.
- Conservé : diffusion sans destinataire, acceptation volontaire, prix et dates,
  refus persistants et règle du premier conducteur qui accepte.
- Vérifications et limites : tests unitaires et PostgreSQL/PostGIS jetables,
  compilation NestJS ; pas de déploiement, de base réelle ni d'envoi push réel.
  Voir [le rapport complet](DEMANDE_CONDUCTEUR_CIBLE_2026-10-27.md).


## 2026-10-27 - Refus persistants des demandes par conducteur

- Probleme : un refus arretait une alerte sans retirer durablement la demande
  des listes ; refus sans notification ou apres expiration parfois non enregistres.
- Applique : table par conducteur/demande, transaction idempotente, filtres des
  listes/details/pagination, alertes immediates/programmees/partagees et reouverture.
  Migration additive 1780000095000, non appliquee en production.
- Conserves : demande du passager, autres conducteurs, trajets attribues,
  absence de penalite globale et absence de masquage pour une demande ignoree.
- Verification : 167 tests dans 10 suites, puis 33 tests de reouverture/routage/
  confidentialite (avec recoupement) ; compilation NestJS reussie.
  PostgreSQL/PostGIS : 73 scenarios existants passent ; le nouveau scenario
  de refus passe en relance ciblee apres stabilisation de sa fixture temporelle.
- Details, fichiers, commandes de controle et limites :
  [rapport refus conducteur](REFUS_DEMANDES_CONDUCTEUR_2026-10-27.md).
  Bases jetables locales uniquement ; aucun push reel ni deploiement.


## 2026-10-27 — Tests de notifications et de dispatch après réservation des envois

- Le journal CI fourni présente 12 échecs dans deux suites. Les simulations de
  `notifications.service.spec.ts` ignoraient la mise à jour conditionnelle des
  notifications réservées et conservaient les anciennes tailles de lots.
  `dispatch-speech.spec.ts` simulait encore une allocation individuelle, alors
  que le service utilise désormais une sélection et une écriture groupées.
- Les simulations respectent les réservations actuelles : cinq envois urgents
  simultanés au maximum, vingt lots au maximum par passage, arrêt des nouvelles
  réservations après deux secondes. Les tests contrôlent les mises à jour avec
  identifiant de réservation, l'annulation des notifications obsolètes et la
  libération des traitements simulés même lorsqu'une assertion échoue.
- Régressions couvertes : perte de réservation avant envoi, résultat d'un ancien
  worker qui ne doit pas écraser celui de son successeur, descriptions vocales
  pour 1, 3 et 50 invitations avec un nombre constant de requêtes simulées.
- Validation locale : `jest --runInBand --silent src/notifications
  src/trip-requests/dispatch` réussit avec 290 tests dans 26 suites ; 71 tests
  conditionnels ne sont pas exécutés. `tsc --noEmit --incremental false -p
  tsconfig.build.json` réussit également. Ce passage ne remplace pas la recette
  PostgreSQL ni l'exécution complète du pipeline sur le futur commit.
- Périmètre du correctif : trois fichiers de tests et cette documentation.
  Aucun changement du service en production, du schéma, du CI/CD ou d'AWS pour
  ce correctif ; les autres modifications déjà présentes dans le dépôt restent
  distinctes. Aucun envoi réel aux fournisseurs ni déploiement.

## 2026-10-27 - Node et dependances de securite

- Probleme : Node non fixe au correctif LTS actuel et 30 paquets affectes selon npm.
- Solution : Node 24.22.1, versions compatibles et substitutions ciblees, Docker/Compose/CI alignes.
- Precautions : aucun deploiement, migration ou changement du schema ; registre ADOT conserve.
- Fichiers, mesures et limites : [rapport de securite des dependances](operations/node-dependencies-security-2026-10-27.md).


## 2026-10-24 — Reprises fiables backend/mobile et traitements bornés

- **KYC Didit :** dans `src/users/didit-kyc.service.ts`, les événements d'une
  session remplacée ne modifient plus ni le dossier ni son identifiant de
  session, même après plusieurs livraisons. Les événements de démarrage tardifs
  ne font pas régresser une décision ; une approbation concurrente empêche aussi
  une création de session de la remplacer. Les mises en revue/resoumission
  légitimes de la session courante restent traitées, conformément aux
  [statuts Didit](https://help.didit.me/verification-sessions/session-statuses).
- **Sessions :** `POST /auth/refresh` accepte un `requestId` UUID v4 optionnel.
  Le mobile le sauvegarde avant envoi. Le backend conserve un reçu AES-GCM dans
  Redis pendant 120 secondes, écrit avant la rotation conditionnelle. La reprise
  exige le même identifiant et les empreintes de la session actuellement en base.
  Déconnexion, nouveau login, suspension, changement de rôle et réinitialisation
  du PIN restent prioritaires. Aucun ancien jeton n'est accepté sans ces preuves.
  Redis indisponible : 503, pas de rotation sans reçu. Clients sans `requestId` :
  ancien comportement conservé, sans bénéfice de reprise d'une réponse perdue.
- **Demandes de trajet :** `PUT /trip-requests/:id/release-driver` accepte
  `searchNow` optionnel (true par défaut pour les anciens clients). true renouvelle
  la plage à maintenant → +30 minutes et rend la demande éligible au dispatch ;
  false libère le conducteur et laisse la demande expirée jusqu'à modification
  des horaires. Une demande immédiate n'est plus diffusée à tous les conducteurs
  par ce chemin : le worker existant sélectionne le prochain conducteur éligible.
- **Paiements :** récupération toutes les 10 secondes, cinq opérations réclamées
  au maximum, deux traitements simultanés, aucun chevauchement local ; leases et
  contrôles de révision conservés. Une erreur d'acquittement n'interrompt plus les
  autres opérations. Backoff plafonné à 15 minutes et avertissement dès 15 minutes
  d'ancienneté. Les échéances déjà enregistrées et les leases de 15 minutes restent
  respectées ; ce n'est pas une garantie de règlement en 15 minutes.
- **GPS :** progression cadencée à une évaluation/seconde/trajet/processus avec
  relecture différée, sans réponse fondée sur un état ancien mis en cache. Chargement
  limité aux réservations acceptées, absentes ou à embarquement incertain ; jointure
  du profil conducteur retirée de cette lecture. Logique d'arrivée, points et gains
  conservée. Le regroupement n'est pas un verrou distribué entre instances.
- **Vérifications :** 681 tests ciblés/49 suites backend, 441 tests JavaScript
  mobile/44 fichiers ; quatre tests supplémentaires avec PostgreSQL 18 jetable
  après autorisation de démarrage hors environnement restreint. Base temporaire
  nettoyée. Simulation couplée des vrais services : réponse perdue, deux requêtes,
  une rotation, aucune déconnexion. Vérifications TypeScript sans émission des
  deux dépôts. Fournisseurs simulés ; aucun paiement/OTP/push réel, ni essai natif.
- **Déploiement ultérieur :** backend d'abord, puis mobile (nouveaux champs de DTO).
  Aucun changement Terraform, AWS, CI/CD, `.env`, dépendance, migration, commit ou
  push. Aucune nouvelle variable obligatoire : le secret JWT de renouvellement et
  Redis existants servent au reçu. Une reprise après expiration du reçu ou perte
  de Redis peut encore imposer une reconnexion ; ne pas assimiler ces tests à un
  test de charge ni à une validation de haute disponibilité en production.

### Vérification complémentaire du 24 octobre 2026

Les correctifs ci-dessus étaient déjà présents dans les deux répertoires lors
de cette reprise. Ils ont été relus et validés sans écraser les modifications
locales ni ajouter de changement métier.

- Backend : `jest --runInBand --silent --testPathIgnorePatterns src/database`
  réussit avec **2 738 tests dans 219 suites** ; 189 tests conditionnels et
  11 suites restent ignorés. Cette commande exclut les suites de `src/database`.
- PostgreSQL : les **4 tests** de `session-rotation-postgres.spec.ts` réussissent
  séparément sur un cluster PostgreSQL 18 jetable, sans configuration applicative.
  Le premier démarrage était empêché dans le sandbox ; l'exécution autorisée hors
  sandbox a réussi, puis le cluster temporaire a été arrêté et supprimé.
- Mobile : **441 tests JavaScript ciblés dans 44 fichiers** réussissent ; les SDK,
  transports et stockages natifs restent simulés.
- `tsc --noEmit --incremental false` réussit dans les deux dépôts (configuration
  `tsconfig.build.json` pour le backend). `git diff --check` ne signale aucune
  erreur dans les deux dépôts.
- Simulation couplée avec le code réel d'authentification backend et mobile :
  réponse perdue après la rotation, reconnexion, même identifiant de tentative,
  **deux requêtes, une seule rotation, session récupérée sans déconnexion**.
  Redis, PostgreSQL et le transport sont simulés dans cette simulation spécifique.

Ces contrôles ne remplacent pas une recette Android/iOS sur appareil ni un test
de charge. Aucun service de paiement, OTP, KYC ou push réel n'a été appelé et
aucun changement AWS, Terraform, CI/CD ou publication n'a été effectué.

## 2026-10-24 — Correctifs des tests de sécurité Didit et HTTP

- Le statut envoyé par le mobile reste accepté dans le DTO mais ne décide plus
  du KYC. Décision fournisseur incomplète : 502 explicite, aucune écriture ni
  activation ; approbations/rejets existants préservés.
- Horodatage signé lié à l'en-tête et à la fenêtre de validité des webhooks.
  Rejeu avec en-tête rafraîchi bloqué, formats numériques/texte pris en charge.
  V2 invalide non rétrogradable ; Simple exige une décision serveur fraîche et
  ne stocke plus de données non signées en cas de panne fournisseur.
- En-têtes HTTP : retrait de l'empreinte Express, `nosniff`, absence de cache
  pour auth/KYC et les requêtes autorisées. CORS, Swagger et médias inchangés.
- Validation : 499 tests backend/31 suites, 47 tests JS mobile/3 fichiers,
  TypeScript sans émission et deux reproductions Didit désormais négatives.
  Aucune requête fournisseur réelle, migration, variable ajoutée, modification
  mobile, Terraform, AWS, CI/CD, commit ou push.
- Détails et limites : [suivi du rapport de sécurité](operations/penetration-tests-2026-10-24.md).

## 2026-10-24 — Tests de sécurité locaux backend/mobile

- Campagne ciblée, sans correctif métier, changement d'infrastructure, paiement,
  appel fournisseur, modification de compte ni déploiement.
- Ajout d'une sonde HTTP/Socket.IO limitée à la boucle locale, de 24 tests
  HTTP adverses isolés et de deux reproductions KYC hors réseau.
- Résultats : 388 tests backend et 194 tests JavaScript mobile réussis ;
  26 contrôles réseau conformes et 2 observations ; activité Android interne
  refusée à l'appel externe sur l'émulateur debug. TypeScript backend validé.
- Deux défauts Didit reproduits séparément : statut client utilisé lorsque la
  décision fournisseur manque, et ancien webhook signé accepté avec un en-tête
  temporel récent. Scripts d'audit volontairement en sortie 1 si reproduits ;
  pas de changement de la suite CI/CD. Aucun test de paiement ou KYC payant.
- Détails, conditions d'exploitation, limites et recommandations :
  [rapport de sécurité](operations/penetration-tests-2026-10-24.md) et
  [modèle de menaces](../zwanga-backend-threat-model.md).

## 2026-10-23 — Bascule vers les espèces après complément Mobile Money bloqué

- Commande authentifiée/idempotente, marqueur durable et garde-fous transactionnels
  préparés pour payer le trajet en espèces sans attendre le résultat d’une recharge.
  La recharge tardive reste créditable dans le portefeuille, pas dans ce trajet.
- Fichiers, précautions et tests : [bascule cash](finance/token-cash-fallback.md).
  Règles cash/parrainage conservées ; réception des espèces toujours confirmée
  par le conducteur. Collecte directe en attente non débloquée artificiellement.
- Vérifications : 47 tests de paiement/reprise et 108 tests de commissions réussis,
  dont PostgreSQL 18/PostGIS isolé ; trois cas de compatibilité ignorés faute de
  commit de déploiement explicite. TypeScript build sans émission et diff check
  réussis ; suite backend globale non relancée. Aucun déploiement, aucun
  paiement fournisseur, aucune migration sur une base existante ni essai natif.

## 23 octobre 2026 — Cohérence backend/mobile : chat, reconnexion et notifications

- **Constat :** le mobile envoyait les messages par HTTP, mais seul le gateway
  diffusait `new_message`. Les notifications financières/KYC et le signal
  `server_restart` n'étaient pas entièrement traités côté mobile. Les retraits
  de parrainage mobiles ne transmettaient pas de clé durable de reprise.
- **Backend appliqué :** `src/chat/chat-realtime.service.ts` est lié au même
  serveur `/chat` et à son adaptateur existant. `ChatService` diffuse une seule
  fois après sauvegarde vers les rooms utilisateurs authentifiées, y compris
  sans jeton push. Les participants réels d'une réservation sont recontrôlés ;
  les anciennes adhésions étrangères ne reçoivent rien. Le gateway ne rediffuse
  plus le message. L'échec de diffusion ne transforme pas l'enregistrement en
  erreur et les lectures REST restent disponibles.
- **Compatibilité Didit :** `didit-kyc.service.ts` ajoute `launchMode` à la réponse
  de création de session. Les champs existants restent inchangés. Le SDK reste
  le choix normal ; le mobile peut respecter un mode `hosted` explicitement
  choisi par le serveur, pour la même session et une URL Didit validée.
- **Mobile associé (`../zwanga`) :** intention de retrait persistée avant POST,
  conservation du montant/téléphone/UUID, lecture par ID après confirmation,
  reconnexion temporaire bornée avec backoff/jitter, relecture du chat au retour
  du socket, politique commune de navigation et invalidation de cache pour
  retraits, ajustements de jetons, commissions, paiements et décisions KYC.
  Le contenu d'une notification ne donne jamais une autorisation ni un solde.
- **Vérifications :** 228 tests backend réussis dans 18 suites ciblées, dont
  échanges Socket.IO réels en boucle locale avec dépendances simulées ;
  vérification TypeScript backend sans émission réussie. Côté mobile : 494 tests
  JavaScript réussis dans 45 fichiers et TypeScript sans émission réussi ;
  leurs limites sont détaillées dans le journal du dépôt mobile.
- **Périmètre conservé :** aucun paiement réel, migration nouvelle, changement
  Terraform/CI/CD, modification AWS ou push GitHub pour ces correctifs.
  Les 14 anciens appels mobiles vers des routes absentes restent inchangés :
  leur suppression groupée a été bloquée par le contrôle de sécurité et requiert
  une validation séparée des contrats. Aucun écran actif identifié ne les utilise.
- **Limites :** pas de recette Android/iOS physique ni validation de la version
  des stores. Déployer le backend seul ne met pas à jour les handlers mobiles ;
  ces comportements demandent la distribution de la nouvelle version mobile.

## 23 octobre 2026 — Reprise Mobile Money et changement de paiement après refus

- **Constat / périmètre :** une réponse perdue au complément en jetons pouvait
  laisser le passager sans référence et sans possibilité sûre de changer.
  Le mixte était refusé même après un échec fournisseur confirmé ; un callback
  de refus ancien pouvait aussi rétablir le mode électronique.
- **Solution :** nouvel endpoint authentifié/limité `POST /wallet/topups/recover`
  dans `src/wallet/wallet.controller.ts`, `dto/recover-topup.dto.ts` et
  `wallet.service.ts`. `src/payments/topup-recovery.ts` et `payments.service.ts`
  retrouvent la tentative par sa clé d'origine ou réservent cette référence en
  annulation si elle n'a jamais été enregistrée. L'index unique départage
  récupération et initiation tardive ; aucun nouveau débit ni HTTP sous verrou.
  Un paiement en attente existant n'est jamais déclaré refusé sans preuve.
- **Rejeu :** l'initiation idempotente relit désormais un résultat fournisseur
  existant sans refaire la collecte ; le service wallet applique le crédit
  vérifié/dédupliqué existant avant de retourner son solde.
- **Réservation :** `src/bookings/bookings.service.ts` réconcilie le paiement
  électronique avant de permettre un autre mode, bloque attente/inconnu/succès
  et ignore un ancien refus reçu après passage en espèces/jetons.
  `mixed-cash-payment.service.ts` accepte le mixte après `FAILED`/`CANCELLED`
  mais conserve le blocage pour attente/succès et recharge non résolue. Cela
  remplace expressément la règle du 22 octobre « même échoué » ci-dessous.
- **Conservés :** identité authentifiée, paramètres d'origine, preuve de crédit,
  déduplication, contrôle du montant/arrivée et réception cash par le conducteur.
  Le parrainage reste calculé sur la part espèces ; aucun calcul ajouté sur
  les jetons. Pas de nouvelle migration : référence unique existante utilisée.
- **Vérifications :** 158 tests unitaires/services réussis (paiements, wallet,
  réservations, claim idempotent et nouvelles suites `topup-recovery` et
  `booking-payment-recovery`), puis 11 tests PostgreSQL isolés réussis dans
  `mixed-cash-payment-postgres`, y compris deux courses réelles sur l'index
  unique. Cluster jetable local avec transports simulés, sans base distante.
  TypeScript build sans émission et lint des deux nouveaux fichiers de
  production réussis. Les erreurs du TypeScript global des anciennes specs et
  du lint global ne sont pas certifiées corrigées.
- **Livraison / limites :** aucune production modifiée, aucun déploiement,
  secret ou paiement réel. Backend à livrer avant le mobile ; une collecte
  déjà envoyée sans résultat exploitable reste à réconcilier, elle ne peut pas
  être effacée sur simple timeout. La migration mixte antérieure demeure un
  prérequis si non livrée. Parcours, fichiers mobiles et recette physique :
  [fiche du dépôt mobile voisin](../../zwanga/docs/PAIEMENT_RECUPERATION_MOBILE_MONEY.md).

## 22 octobre 2026 — Paiement mixte jetons et espèces après l'arrivée

- **Problème / périmètre :** un solde de jetons insuffisant imposait le complément
  Mobile Money. Ajout local du complément cash autorisé par l'utilisateur ;
  le correctif précédent de vérification MM est conservé. Aucune opération sur
  la production, aucun appel prestataire ni déploiement.
- **Endpoint :** `src/bookings/mixed-cash-payment.{controller,service}.ts`,
  `dto/mixed-cash-payment.dto.ts` et `bookings.module.ts` ajoutent
  `POST /bookings/:id/pay-tokens-cash`, authentifié et limité en fréquence.
  Arrivée confirmée, réservation terminée, CDF, propriétaire, deux moyens acceptés,
  prix/valeur/quantité consentis et solde disponible sont revérifiés. Aucune
  conversion avant arrivée, après cash reçu ou paiement réussi. La présence
  d'un paiement fournisseur sur la réservation, même échoué, ou d'une recharge
  encore en attente bloque la conversion pour éviter un règlement concurrent.
- **Atomicité :** verrou de réservation, verrous des portefeuilles ordonnés,
  débit avec le service wallet existant, écriture de gain et notification outbox
  dans la même transaction. Aucun appel fournisseur. Une reprise avec les mêmes
  montants lit le résultat existant ; une différence est refusée. Une panne de
  cache après commit ne transforme pas le succès en échec. Les recommandations
  `supabase-postgres-best-practices` ont guidé la durée et l'ordre des verrous.
- **Contrat additif :** `entities/booking.entity.ts`, `bookings.service.ts`,
  `driver-finance.service.ts` et `driver-settlements.service.ts` préservent le
  brut/subvention ; après mixte, `paymentAmount` est le reliquat cash,
  `mixedTokenAmount`/`mixedTokenQuantity`/`mixedPaymentAt` prouvent la part jetons.
  Le total passager est cash + jetons. Le mode reste `cash/not_required` ; les
  contraintes de réception et fonctions de commission cash existantes restent
  inchangées. La créance conducteur couvre les jetons nets de commission plus
  une éventuelle subvention, jamais les espèces déjà reçues physiquement.
  Une subvention disponible peut être étendue seulement si elle correspond
  exactement à la réservation antérieure ; aucun gain incohérent n'est écrasé.
- **Parrainage :** inchangé à la demande explicite de l'utilisateur, sur la part
  espèces effectivement confirmée uniquement. Aucun calcul sur les jetons.
- **Migration :** `1780000089000-MixedTokensCash.ts`, inscrite dans `index.ts`,
  ajoute les champs et protège répartition, montant total et absence d'une
  collecte électronique ultérieure. Elle ne remplace aucun trigger cash existant.
  Migration transactionnelle avec attentes bornées ; rollback interdit dès
  qu'une répartition est utilisée, pour ne pas effacer une preuve financière.
- **Vérifications :** 117 tests unitaires de régression réussis (réception cash,
  arrivée, gains/subventions/revenus, portefeuille, refus de recharge), plus
  16 tests financement/parrainage. Deux suites PostgreSQL isolées : 113 réussis,
  trois tests optionnels préexistants ignorés. Sept cas du service mixte testent
  débit concurrent unique, 58 jetons/580 FC + 3 920 FC cash, remise cash séparée,
  subvention non dupliquée, rollback en cas d'erreur, montants/acteur invalides,
  interverrouillage fournisseur et panne cache. Le helper
  `test/mixed-cash-commission-postgres.ts` vérifie les anciens triggers réels,
  le remboursement unique de commission et le rollback sûr de migration.
  TypeScript build sans émission et lint des six nouveaux fichiers réussis.
  Les neuf suites unitaires ont aussi été rejouées ensemble : 133 tests réussis.
  Pas de certification du lint global.
- **Livraison / limites :** migration/backend à livrer en test avant le mobile ;
  option mobile masquée sans `mixedCashSupported`. CDF et arrivée uniquement.
  Toute ancienne transaction fournisseur ou écriture de gain incompatible
  exige une réconciliation préalable. Pas de test téléphone ni paiement réel.
  Le détail du parcours, des fichiers mobiles et de la recette figure dans
  `zwanga/docs/PAIEMENT_MIXTE_JETONS_ESPECES.md` du dépôt mobile voisin.

## 22 octobre 2026 — Résilience du dispatch et banc de charge isolé

- **Allocation :** exclusion des départs sans coordonnées et des demandes immédiates
  sans prix avant pagination ; lots de 25 réservés atomiquement entre instances
  (`SKIP LOCKED`, bail de 10 s), trois traitements simultanés maximum par instance.
  Une erreur n'interrompt plus le reste du lot. Libération du bail uniquement par
  son propriétaire. Une seconde lecture après verrouillage de la présence évite
  d'insérer une invitation sur un conducteur réservé depuis le snapshot SQL.
  La sélection matérialise aussi la version MVCC de la présence pour ignorer
  immédiatement une réservation concurrente : comparaison `xmin` dans la même
  instruction uniquement, jamais stockée ni utilisée comme version métier.
  Le plan SQL à 1 000 conducteurs a également révélé des balayages répétés des
  véhicules : ajout des index partiels propriétaire/type/véhicule actif et
  conducteur/demandes déjà attribuées, puis séparation des exclusions
  « déjà sollicité » et « invitation en attente ».
- **Temps réel :** les acceptations classiques/partagées et éditions transportent
  maintenant leur identifiant dans les événements TypeORM. Une file PostgreSQL
  distincte (`ride_realtime_deliveries`) délivre les invitations sur le socket
  existant sans attendre FCM/Expo ; reprise d'un traitement interrompu après 5 s,
  réexamen de l'éligibilité et respect de l'échéance sonore originale de 30 s.
  Le transport reste « au moins une fois » : les clients dédupliquent par eventId.
  Le bail push reste à 120 s : raccourcir ce bail pendant un envoi SDK non annulable
  pourrait provoquer des doublons. Le canal temps réel ne dépend plus de ce bail.
- **Pause de proximité :** un succès FCM/Expo ne prouve plus une réception.
  Les refus explicites continuent de compter. Une absence de réponse ne compte
  qu'après un accusé de l'application et au moins 10 s disponibles pour répondre.
  Les anciennes versions sans accusé restent fonctionnelles, sans pénalité pour
  une simple absence. Les pauses déjà enregistrées ne sont pas réécrites.
- **Contrat mobile additif :** après réception effective, appeler
  `POST /api/v1/driver-dispatch/notifications/:id/received`, authentifié en conducteur,
  sans corps. `id` = `notificationId` du push ou `eventId` du socket. Réponse
  `{ received: boolean }`, idempotente, limitée au destinataire et à une invitation
  encore valable. Ne pas appeler depuis un reçu fournisseur. Aucun changement
  mobile effectué ici ; le secours socket bénéficie aux clients écoutant `ride_alert`.
- **Migration :** `1780000088000-DispatchDeliveryResilience`, additive et réversible,
  ajoute les reçus, les baux et les index. Elle doit précéder l'exécution du nouveau
  backend. Le rollback retire seulement ces structures techniques ; coordonner
  le retour de code avant de retirer le schéma. Aucun Terraform/CI/CD modifié.
- **Mesure reproductible :** `npm run test:load:dispatch` (ou `-- --quick`).
  `LOAD_TEST_PG_BIN` désigne uniquement les exécutables PostgreSQL avec PostGIS.
  Base neuve sur boucle locale, environnement nettoyé, aucun `.env` chargé,
  connexions externes interdites, transports simulés. Rapport JSON horodaté dans
  `tmp/dispatch-load-*/report.json`, nettoyage automatique de la base jetable.
  Le test porte sur les vrais services/SQL et non sur HTTP, FCM/APNs, Redis réseau,
  AWS ou un basculement multi-hôte. Les résultats ne sont pas une capacité de production.
  Les trois instances simulées partagent un processus Node et un pool de huit
  connexions. Les cycles de 5 s sont alignés comme le cron, avec un premier cycle
  immédiat (jusqu'à 5 s d'attente initiale supplémentaires en conditions réelles).
  La fixture inclut l'index KYC de la migration 52, sans ses triggers financiers.
  `-- --diagnose` produit le plan `EXPLAIN ANALYZE` sur la base jetable seulement.
- **Non-régression locale :** compilation TypeScript sans émission réussie.
  Suite générale : 2 611 tests réussis, 423 conditionnels ignorés, un timeout
  Store Management ; les 29 tests de cette suite passent à la relance isolée.
  Après le dernier correctif de concurrence : **94/94 tests PostgreSQL/PostGIS**
  et **66/66 tests unitaires ciblés** réussis. Le test de concurrence bloque
  volontairement une sélection pendant qu'une autre transaction réserve le
  conducteur, puis vérifie que le suivant est choisi en une seule sélection.
  Le passage PostgreSQL utilise `--testTimeout=15000` : certains nettoyages de
  fixtures dépassaient 5 s sur ce PC chargé. Les budgets des services et du banc
  de charge ne sont pas augmentés. Migration aller/retour et reçus sont vérifiés.
- **Charge finale (22/10, 19:08 UTC) :** 1 000 conducteurs fictifs, PostgreSQL 18,
  pool de 8 connexions ; rapport local
  `tmp/dispatch-load-2026-10-22T19-08-15-906Z/report.json`.

  | Scénario | Résultat local |
  | --- | --- |
  | 200 allocations en rafale, un worker simulé | 6,28 s ; 31,87 allocations/s |
  | 200 allocations, trois instances simulées dans le même processus | 3,71 s ; 53,94 allocations/s |
  | 100 demandes, cadence de 5 s | Première offre P95 : 15,45 s ; quatre cycles |
  | 300 positions GPS, concurrence 30 | 240,45 opérations/s ; P95 : 169,65 ms |
  | 20 refus, concurrence 5 | 20 successeurs réservés ; P95 : 108,44 ms |
  | Reprise de 50 invitations avec capacité push occupée | 171,35 ms ; aucun doublon observé |
  | 500 alertes, cadence de 2 s | 8,50 s ; 500 émissions simulées, aucun doublon |

  Tous les contrôles passent, aucun avertissement/erreur de service enregistré,
  aucune connexion externe tentée ; base jetable arrêtée et nettoyée.
  Le rollback SQL ne laisse ni offre ni outbox orpheline ; douze acceptations
  simultanées ne créent qu'une attribution. Une première rafale de refus avait
  révélé un passage différé au successeur : le contrôle MVCC et sa reproduction
  PostgreSQL corrigent ce cas dans la mesure finale.
  Le cron reste une limite de latence sous rafale : cette mesure ne garantit ni
  un premier appel instantané pour 100 demandes ni la livraison réelle au téléphone.
  Résultats ponctuels sur PC partagé, sans estimation de capacité AWS/haute disponibilité.

## 22 octobre 2026 — Recharge de complément : conserver les états en attente

- **Problème constaté :** le parcours mobile jetons + complément Mobile Money
  affiche parfois une vérification indisponible. Le contrôle local de preuve
  FlexPay exigeait un justificatif complet de crédit sur une réponse encore
  non finale, y compris corrélée par sa référence au numéro de commande interrogé.
  L'absence de certains champs produisait alors un rejet HTTP 400. Le défaut est
  établi par le code et les tests, sans logs du paiement réel signalé.
- **Solution appliquée :** `src/payments/wallet-topup-check-evidence.ts` reçoit
  explicitement l'issue calculée dans `payments.service.ts`. Les réponses en
  attente sont soumises aux contrôles de corrélation, mais pas aux exigences de
  preuve d'un crédit réussi. Elles conservent l'état non final et le numéro de
  commande. Le contrôle des montants/devises fournis, le refus des incohérences,
  les preuves complètes de réussite et l'idempotence du portefeuille restent
  inchangés. Aucun assouplissement du crédit des jetons ou nouveau code de statut
  prestataire interprété comme une réussite.
- **Tests / résultats :** `wallet-topup-decline.spec.ts` couvre les états non
  finaux corrélés sans preuve complète, les incohérences toujours refusées et la
  réponse portefeuille sans crédit ni écriture ledger. 164 tests réussis dans
  9 suites ciblées paiements/portefeuille/reçus cash/avant-arrivée. Compilation
  TypeScript de production sans émission et `git diff --check` réussis. Le lint
  du helper est vert ; les 119 erreurs du service et les 8 erreurs de sa fixture
  sont déjà présentes dans HEAD, aucun diagnostic supplémentaire après correctif.
- **Limites :** tests unitaires simulés, aucune base réelle ni API de paiement
  contactée. Aucun déploiement ou migration. La version backend doit être
  déployée pour corriger les réponses servies au mobile. Le paiement mixte
  jetons/espèces n'est pas ajouté : cash reste un choix pour tout le trajet.
  Les vraies erreurs de vérification restent bloquantes pour éviter un double
  paiement. Changements mobiles documentés dans leur journal technique.

## 22 octobre 2026 — Demandes entrantes : délais fixes et synchronisation

- **Problème :** la reprise d'une notification pouvait prolonger son délai ; les
  invitations n'utilisaient pas le socket existant et Firebase n'avait pas de
  contrat APNs interactif pour un token iOS natif.
- **Solution :** suppression de `notifications/recover-driver-offer.ts` et de son
  appel ; échéance sonore ancrée à la création. `dispatch.service.ts` durcit la
  lecture de l'actionnabilité et signale la décision après commit. Ajout de
  `ride-alert-realtime.service.ts`, `ride-alert-changes.ts`, raccordement au gateway
  `/chat` et à `NotificationsModule`. L'annulation sauvegarde la demande déjà
  verrouillée pour permettre le signal de changement après transaction.
  Les signaux sont regroupés dans une file de 200 clés maximum et un worker,
  sans attendre une seconde connexion SQL depuis le callback de commit. Une
  invitation socket part après `SENT`, conservant la comptabilisation des refus
  et absences. Un prix absent n'est plus renvoyé comme zéro par la fiche dispatch.
  `ios-driver-push.ts`, capacité v5 et `notifications.service.ts` préparent le
  transport APNs via Firebase sans VoIP/Critical Alerts.
- **Conservé :** décisions transactionnelles/idempotentes, premier accepté gagnant,
  exclusion de l'auteur, pause de 24 h, demandes programmées/partagées, anciens
  transports Android et Expo. Les signaux Socket.io ne constituent pas des décisions.
- **Vérifié :** exécution finale : 55 tests de politique/dispatch PostgreSQL/PostGIS
  sur cluster local jetable, puis 81 tests de notifications (cinq suites) réussis ;
  compilation TypeScript production réussie. Le subscriber est vérifié après
  commit réel. Deux tentatives précédentes ont subi des délais de préparation locale
  dépassés ; l'exécution finale utilise `--testTimeout=20000`, sans modifier les
  délais métier, les assertions de concurrence ni les données de production.
- **Limites :** aucune migration nouvelle, aucun déploiement, aucune base de
  production touchée. Les migrations préexistantes du compteur de proximité restent
  nécessaires. Aucun envoi APNs/FCM réel ni essai physique. Suivi complet et résultats
  finaux dans [le journal des boucles mobile](../../zwanga/docs/DEMANDES_ENTRANTES_LOOPS_2026-10-22.md).

## 22 octobre 2026 — Pause de 24 heures après quatre demandes proches ignorées ou refusées

- **Problème / périmètre :** la proximité seule continuait à solliciter un
  conducteur ne répondant pas aux demandes. Règle limitée à `trip_request_nearby`
  et `driver_dispatch_offer`, jamais aux réservations publiées ou aux retours
  passagers. Quatre demandes distinctes, refus et absences cumulés, déclenchent
  une pause non extensible de 24 heures ; le compteur repart à zéro ensuite.
- **Solution appliquée :** nouvelle politique `src/notifications/nearby-request-cooldown.ts`,
  migration additive `1780000087000-NearbyRequestRingingCooldown.ts` enregistrée
  dans `src/database/migrations/index.ts`, deux tables avec contrainte unique
  conducteur/demande. Le guide PostgreSQL a guidé l'index partiel, les types de
  dates, les mises à jour groupées et les transactions courtes état → événements,
  sans réseau sous verrou. Le contrôle de livraison de `notifications.service.ts`
  et `dispatch/nearby-driver-policy.ts` filtrent les conducteurs en pause.
  Un cron minute traite des lots bornés et ne se chevauche pas dans une instance.
- **Refus :** `dispatch.controller.ts` / `dispatch.service.ts` exposent
  `PUT /driver-dispatch/nearby-requests/:id/decline`, authentifié, réservé aux
  conducteurs, UUID validé, limité en fréquence et dédupliqué. Il ne modifie pas
  la commande du passager. Les réponses dispatch existantes sont également
  reconnues avant tout nouvel envoi. Les anciens payloads avec `offerId` seul et
  les nouvelles tentatives d'envoi restent compatibles.
- **Précautions :** aucun changement de rayon, de présence ou de statut du
  conducteur. Notifications de proximité suspendues, demandes toujours
  consultables manuellement. Réservations, événements de trajet et réponses aux
  passagers inchangés. Un envoi `failed` ou `pending` ne pénalise pas le conducteur ;
  une absence suppose un envoi `sent`, une échéance dépassée, aucune réponse et
  une demande encore disponible. Fenêtre plafonnée à 60 secondes et aux échéances
  existantes. Les anciens événements ne prolongent pas la pause ni ne relancent
  immédiatement une nouvelle pause après expiration.
- **Vérifications :** suites nouvelles `nearby-request-cooldown.spec.ts` et
  `nearby-request-cooldown.postgres.spec.ts`, adaptation du mock de
  `driver-request-policy.spec.ts` et des migrations des fixtures dispatch/partage.
  54 tests ciblés réussis, dont 9 PostgreSQL 17 isolés, puis 119 tests unitaires
  complémentaires réussis. Le journal mobile associé détaille les contrôles et
  l'intégration des refus dans `zwanga/docs/CHANGEMENTS_TECHNIQUES.md` au 22 octobre.
  Les suites dispatch/partage PostgreSQL 18/PostGIS passent aussi : **75 tests**
  (dont les tests de politique purs), avec exclusion puis réintégration effective
  du conducteur en pause. TypeScript production sans émission et ESLint des
  nouveaux fichiers de politique/migration validés ; le
  contrôle global incluant les anciennes fixtures conserve des erreurs de types
  hors périmètre et n'est pas présenté comme validé.
- **Limites / déploiement :** migration préparée mais jamais exécutée sur une
  base applicative ; aucun déploiement, envoi réel ou modification de configuration.
  Appliquer la migration avant le nouveau backend, puis distribuer le mobile.
  Aucun historique antérieur recompté. `sent` n'atteste pas une réception audible ;
  les erreurs de reçus Expo tardives ne défont pas le compteur et les push déjà
  en vol ne sont pas rappelés. Sans liaison mobile, un refus local reste constaté
  à l'échéance comme absence de réponse. Tests physiques iOS/Android et charge
  production non réalisés ; aucune promesse de disparition de crash ou de chauffe.

## 20 octobre 2026 — Correction UUID des confirmations de demande acceptée

- **Cause confirmée :** `ride-response-delivery.ts` comparait `trips.id` (UUID) à `trip_requests.tripId` (varchar), puis cette référence texte à un paramètre UUID. PostgreSQL refusait la requête avec `42883`, avant tout envoi du push `trip_request_accepted`, même pour une demande dont le trajet n'était pas encore créé. Les tests unitaires simulant la requête ne détectaient pas cette incompatibilité.
- **Correctif :** conversion explicite et protégée de la référence vers UUID pour la jointure ; comparaison du paramètre UUID avec `trips.id`. Le guide PostgreSQL a conduit à conserver la clé primaire non convertie, pour maintenir son index utilisable. Une ancienne référence mal formée ou pointant vers un trajet absent rend le message obsolète sans erreur SQL. Les contrôles du destinataire, du conducteur sélectionné, de l'état du trajet et de `selectedAt` restent actifs.
- **Reprise :** le worker existant peut reprendre les notifications encore actives dont la prise en charge a expiré (120 secondes), après vérification de l'état métier courant. Pas de remise en attente globale ni de replay des messages déjà envoyés. Aucune notification réelle déclenchée par les tests.
- **Validation :** trois nouveaux scénarios PostgreSQL ont d'abord reproduit l'erreur sur l'ancien code (sans trajet, trajet à venir, trajet en cours). Après correction : **46 tests PostgreSQL réels réussis**, **67 tests unitaires ciblés réussis**, compilation TypeScript sans émission validée. La suite PostgreSQL existante a été enrichie avec le vrai type varchar de la référence, les reprises, les décisions obsolètes, les références invalides, les réservations et l'absence de doublons ; aucun nouveau paramétrage CI/CD nécessaire.
- **Vérification locale en lecture seule :** la requête corrigée réussit également pour la notification signalée, dont l'état métier permet toujours la livraison. Son dernier échec enregistré est désormais « Aucun token push actif pour cet utilisateur » : la correction SQL ne remplace pas l'enregistrement du jeton de l'appareil par l'application. Aucun envoi ni réarmement manuel de cette notification n'a été exécuté pendant la vérification.
- **Périmètre :** modification locale du code et des tests uniquement, aucune migration supplémentaire pour ce correctif, aucun changement des données applicatives, de `.env`, Terraform, AWS ou GitHub. Ce résultat corrige le défaut identifié ; il ne constitue pas une validation de l'état actuel des migrations AWS ni une garantie générale de déploiement.

## 20 octobre 2026 — Passage immédiat au conducteur suivant après refus

- **Commandes immédiates :** `DriverDispatchService` propose désormais une demande à un seul conducteur éligible à la fois, par distance croissante dans le rayon existant de 5 km. Le refus et l'invitation du suivant (avec sa notification persistante) sont enregistrés dans la même transaction, sans attendre le cron global ni son lot de 25 demandes. Chaque conducteur n'est sollicité qu'une fois pour une même demande.
- **Fin du délai :** le délai de réponse reste configurable par `DRIVER_DISPATCH_RESPONSE_SECONDS` (30 secondes par défaut). Le cycle existant, toutes les 5 secondes, poursuit la recherche après expiration ; sous charge, plusieurs cycles peuvent être nécessaires. La recherche s'arrête après acceptation, annulation ou expiration de la demande. Sans candidat, la demande reste ouverte et peut trouver un nouveau conducteur disponible à un cycle ultérieur.
- **Fiabilité :** le guide PostgreSQL a orienté la transaction courte et l'ordre de verrouillage demande → offre → présence. Les refus répétés ne sautent pas de conducteur, deux workers ne créent pas deux propositions pour la même demande et les appels push restent hors transaction. Un ancien push ne peut plus réactiver une offre expirée ; la prolongation bornée d'une offre encore valide en attente d'envoi est conservée.
- **Compatibilité :** mêmes routes, DTO, réponses et protocole de sonnerie mobile. L'application appelle déjà `PUT /driver-dispatch/offers/:id/respond` avec `decision: decline`. Les invitations déjà émises par l'ancien broadcast restent valides jusqu'à leur réponse/expiration, sans nouvelle diffusion ajoutée en parallèle. Les alertes de demandes programmées et de partage d'un trajet en cours restent inchangées, avec consentement du passager pour le partage.
- **Livraison :** déclenchement de la voie push urgente après commit ; la réception et la sonnerie physique dépendent toujours du transport push, des permissions et du téléphone. Pas de promesse de sonnerie instantanée si le téléphone est hors ligne. Le passage séquentiel est effectif une fois toutes les instances de l'ancien backend remplacées.
- **Vérifications :** 53 tests réussis dans `dispatch-postgres.spec.ts` sur PostgreSQL/PostGIS local jetable, dont chaîne de refus, première acceptation, concurrence, délai dépassé, anciens pushes, compatibilité broadcast et plus de 50 candidats. Compilation TypeScript validée. Aucun appel push réel ni test sur téléphone.
- **Non-régression générale :** première exécution : 2 505 réussites, 361 tests d'intégration non activés et quatre échecs dans `trip-request-price.spec.ts`. Ces quatre échecs provenaient du simulateur de base qui ne fournissait pas `manager.transaction`, déjà utilisé par l'acceptation avec notification persistante. Seul le simulateur de ce test a été adapté, avec assertions supplémentaires sur la transaction et la notification, sans modification du code métier de prix. Relance de ce fichier et de `dispatch-handoff.spec.ts` : 21 tests réussis.
- **Relance finale ciblée :** `npm test -- --runInBand --testPathPatterns 'trip-requests|notifications|driver-action'` : 435 tests réussis dans 31 suites, 95 tests PostgreSQL non activés dans cette commande (la suite dispatch a été exécutée séparément ci-dessus). Pas de seconde exécution intégrale après la correction du seul simulateur de prix.
- **Périmètre local :** aucune nouvelle migration requise pour ce changement ; réutilisation du schéma et des index de dispatch existants. Aucun changement AWS, Terraform, CI/CD, `.env` réel ou publication GitHub.

## 20 octobre 2026 — Correctifs de fiabilité financière, sans Terraform

- **Périmètre :** achats Pro en jetons atomiques, protection des succès FlexPay contre les réponses tardives, reprise durable des règlements FlexPay/PawaPay, récupération des réservations de parrainage jamais envoyées, contrôle des callbacks périmés, assiette finale des commissions et allègement des GET de parrainage.
- **Base :** migration `1780000083000-FinancialRecovery`, nouvelle file versionnée pour compatibilité avec les anciens workers, garde SQL contre l'envoi après libération, index ciblés. Le guide PostgreSQL a conduit à garder les transactions courtes, les verrous dans l'ordre utilisateur → retrait → paiement, et les appels prestataires hors transaction.
- **Non-régression :** mêmes endpoints et contrats mobiles, montants/historiques conservés. Pas de libération d'un paiement prestataire incertain, pas de replay global. Les anciens historiques non paginés restent un risque de volume documenté jusqu'à migration des clients.
- **Exploitation :** appliquer les migrations avant le backend ; `/health` contrôle la présence du nouveau schéma. Aucune modification Terraform, CI/CD, AWS, secrets ni publication GitHub. Procédure et limites dans le [journal financier](finance/CHANGELOG.md).

## 20 octobre 2026 — Parrainage abonnement à 1 % uniquement

- **Demande :** réduire le pourcentage du parrain sur un abonnement éligible de 5 % à 1 %, sans modifier les autres règles financières.
- **Appliqué :** `src/referrals/referrals.service.ts` utilise 1 % par défaut et plafonne également les anciennes variables à 1 %. `.env.example`, le guide du parrainage et son exemple chiffré sont alignés ; le résumé API utilise le même calcul. Les variables réelles et l'application mobile ne sont pas modifiées.
- **Préservé :** récompenses historiques non recalculées, déduplication des callbacks, exclusions des abonnements gratuits/en jetons, absence de bonus au rattachement, 1 % trajet et 5 % commission plateforme. Aucun changement de schéma ni migration supplémentaire.
- **Vérifications :** tests des configurations anciennes/invalides/absentes, prestataires FlexPay/PawaPay et récompenses historiques dans `referrals.service.spec.ts` ; résultats dans le [journal financier](finance/CHANGELOG.md). Aucun appel prestataire réel, aucune modification AWS, Terraform, CI/CD ou GitHub.

## 20 octobre 2026 — Plus de bonus au rattachement d'un filleul

- **Demande :** le parrain gagne uniquement un pourcentage des abonnements et trajets éligibles du filleul, plus de crédit à l'inscription ou au rattachement.
- **Appliqué :** `referrals.service.ts` supprime `creditAttributionBonus` et sa configuration ; réponse compatible `attributionBonusTokens: 0`. Les inscriptions par code/lien, le rattachement authentifié et l'action admin partagent ce chemin sans crédit. Le push de nouveau filleul n'annonce aucun gain immédiat. `.env.example` marque la variable obsolète ; `.env` réel inchangé.
- **Audit préservé :** migration additive `1780000082000-ReferralAttributionAudit`, entité `ReferralProfile` et documentation Swagger admin. L'identifiant et le motif admin, auparavant dans le bonus financier, sont désormais enregistrés dans la transaction du premier rattachement et ne sont pas sélectionnés par défaut. Répétitions et retours arrière ne peuvent pas écraser une trace. Aucun ancien solde ni journal modifié.
- **Conservé :** 5 % abonnement, 1 % trajet terminé/payé, exclusions des paiements gratuits/Pro en jetons, retenue sept jours, fenêtre douze mois, taux 10 FC et minimum de retrait 1 000 jetons disponibles. Le bonus de bienvenue 500 reste indépendant.
- **Mobile :** texte explicatif dans `app/referrals.tsx`, assertion de rendu dans `tests/referralScreenPerformance.test.js`, [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md). Le contrôle financier reste serveur.
- **Vérifications :** 29 tests PostgreSQL réels et 77 tests mobiles ciblés réussis ; détails finaux backend/TypeScript dans le [journal financier](finance/CHANGELOG.md). Prestataires simulés, pas de test sur téléphone.
- **Activation :** appliquer la migration 82 via la tâche existante avant le nouveau backend, puis remplacer toutes les instances qui attribuaient encore cinq jetons. Rien n'est déployé ici ; CI/CD, Terraform, AWS et GitHub inchangés.

## 20 octobre 2026 — Jeton à 10 FC, bienvenue à 500 et retraits du parrainage disponible

- **Périmètre et décisions :** nouveau taux de 10 FC pour tous les jetons, futurs bonus de 500 jetons pour maintenir les 5 000 FC, retrait dès 1 000 jetons disponibles. Réseau du tableur abandonné sur instruction explicite ; système de parrainage existant conservé.
- **Backend :** `wallet/token-value.policy.ts` devient la référence à 10, utilisée par les conversions existantes. `referral-withdrawal-balance.ts` vérifie le minimum, les décimales et le disponible puis réserve en centièmes sous le verrou existant ; aucun jeton en attente, réservé ou promotionnel ne finance le retrait. `referrals.service.ts` exclut explicitement les abonnements Pro en jetons des récompenses de parrainage, même avec un callback prestataire incohérent.
- **Base :** migrations `1780000080000-TokenValue10Cdf` et `1780000081000-WelcomeBonus500Tokens` enregistrées, transactions et délais bornés selon le guide PostgreSQL. Nouveau défaut des réservations et future attribution de bienvenue uniquement ; anciens nombres de jetons, bonus 50/200, historiques et opérations engagées conservés. Pas de distribution dans la migration. Retour arrière de 81 refusé : correction en avant nécessaire.
- **Mobile :** messages de refus, contrôle du disponible actualisé et double clic, lecture du taux serveur pour les recharges et du taux de réservation pour les paiements. Détails et vérifications dans le [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md).
- **Validation :** 634 tests backend ciblés, puis 2 426 tests réussis dans la suite générale (337 tests d'intégration non activés par défaut). 25 tests PostgreSQL financiers exécutés séparément sur clusters locaux jetables et 203 tests mobiles ciblés réussis ; TypeScript backend et mobile validés. Prestataires simulés ; aucun test Mobile Money réel ni essai sur téléphone.
- **Déploiement non réalisé :** aucun AWS, CI/CD, Terraform, `.env` réel ou GitHub modifié. Les deux migrations et une livraison backend sont nécessaires ; le nouvel affichage exige aussi une livraison mobile. Coordonnez la bascule : les anciennes instances calculent à 25, les nouvelles à 10, et le bonus SQL passe à 500 dès sa migration. [Règles et procédure financière](finance/purchased-token-withdrawals.md).

## 20 octobre 2026 — Prix par place dans les notifications natives conducteur

- **Problème :** les cartes Android Notifee disposaient de la destination,
  mais le prix manquait dans les métadonnées des réservations et commandes
  programmées. Le mobile ne doit pas effectuer une lecture réseau additionnelle
  en veille pour le deviner.
- **Solution préparée :** `src/notifications/ride-speech-data.ts` transporte
  facultativement `ridePricePerSeat` et `ridePriceKind` (`fare` ou `budget`),
  uniquement pour un nombre décimal valide, non négatif et borné. Un tarif
  absent reste absent, un vrai zéro reste représentable.
  `transactional-notifications.subscriber.ts` fournit le tarif publié par place ;
  `dispatch.service.ts`, `scheduled-request-alert.ts` et `shared-trip-alert.ts`
  fournissent le budget demandé par place. Les champs restent des chaînes
  compatibles FCM. Aucun contenu privé supplémentaire autre que ce tarif.
- **Conservé :** ciblage, SQL et transactions existants, consentement de partage,
  délais, destinataires, contrôles d’accès et endpoints de décision inchangés.
  Les travaux de partage en cours ne sont pas remplacés. Pas de migration ni de
  lecture supplémentaire par conducteur.
- **Vérifications :** 40 tests réussis dans quatre suites Jest : formateur
  `ride-speech-data`, subscriber transactionnel, `scheduled-request-alert` et
  `dispatch-speech`. Les assertions vérifient les vrais champs des producteurs,
  les montants absents/invalides et le zéro explicite, sans base réelle.
  L’intégration mobile est documentée dans le
  [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md), entrée du même
  jour « Actions Notifee et fiche de notification avec tarif et destination ».
- **Limites :** changements locaux uniquement, aucun déploiement, accès à la
  base ou envoi réel FCM/APNs. Les anciens clients ignorent les champs facultatifs.
  Les cartes déjà envoyées ne sont pas réécrites.

## 20 octobre 2026 — Partager un trajet en cours avec accord du nouveau passager

Le dispatch des courses indépendantes continue d’exclure les conducteurs
occupés. Un circuit distinct les avertit désormais d’une commande compatible
avec leurs places libres, puis exige la proposition du conducteur et l’accord
explicite du passager avant de créer sa réservation.

- **Éligibilité :** trajet `ongoing`, véhicule actif du type demandé, places déjà
  déclarées libres, conducteur actif avec dernier KYC approuvé, prise en charge
  dans un rayon de 5 km et créneau commençant dans les dix prochaines minutes
  au plus, non dépassé. La position du trajet en cours est prioritaire ; la
  dernière position de découverte sert de repli, sans limite d’ancienneté.
  Le refus explicite des notifications de proximité est conservé.
- **Prix :** tarif par place du trajet existant, au plus égal au budget du
  demandeur ; mode de paiement demandé accepté par le trajet. Les remises,
  paiements, commissions et points suivent le service de réservation existant.
  Aucune augmentation automatique du nombre de places déclarées et aucune
  facturation au moment de la proposition. Le conducteur vérifie les adresses
  et le détour avant de proposer : pas de calcul automatique de compatibilité
  d’itinéraire ni de garantie de temps de détour.
- **Consentement :** `DriverOffer.existingTripId` désigne le trajet partagé ;
  `sharedTripConsentAt` et `sharedBookingId` conservent la preuve et la
  réservation. L’ancien endpoint `accept-offer` refuse une telle offre. Seul
  `POST /trip-requests/:id/shared-offers/:offerId/accept` avec `consent: true`,
  appelé par le propriétaire de la commande, l’accepte.
  La conversion implicite globale des DTO est neutralisée pour ce champ :
  les chaînes `"true"` et `"false"` ne constituent pas un consentement.
- **Atomicité :** verrou de commande puis verrou de trajet, revalidation du
  véhicule, du KYC, du prix et des places. Réservation acceptée, consommation
  des places, affectation et notifications sont persistées ensemble. Les
  autres offres/invitations perdent leur validité ; une répétition retourne
  la réservation déjà enregistrée. Un refus conserve la commande ouverte,
  y compris la recherche immédiate de conducteurs indépendants.
- **API complémentaire :** `GET /trip-requests/:id/shared-offers/context`,
  `POST /trip-requests/:id/shared-offers` avec `tripId`, et
  `POST /trip-requests/:id/shared-offers/:offerId/decline`. Les offres restent
  consultables via la liste existante et les nouveaux endpoints sont Swagger.
- **Annulation :** la réservation ajoutée peut être annulée avant embarquement
  via la commande. La fermeture d’un trajet privé vérifie sous verrou qu’aucune
  autre réservation active ne reste, pour protéger les autres passagers.
  La libération du conducteur par le passager de la commande d’origine garde
  également le trajet ouvert si d’autres passagers y sont encore inscrits.
  L’annulation d’une commande non affectée est sérialisée avec son acceptation.
- **Fichiers :** `src/trip-requests/shared-trip-*`,
  `dispatch/shared-trip-alert.ts`, `bookings/bookable-trip-transaction.ts`,
  `bookings/private-trip-cancellation.ts`, services de commandes/réservations,
  entité `DriverOffer` et migration `SharedTripOffers1780000079000`.
- **Mise en service ultérieure :** appliquer les migrations du backend avant
  d’exécuter le nouveau code, puis distribuer le mobile compatible pour proposer
  et accepter le partage. Aucun nouveau secret ou variable d’environnement :
  les alertes utilisent l’activation existante du dispatch. Le rollback de la
  migration est possible avant usage ; après consentement enregistré, il refuse
  de supprimer silencieusement ces preuves. Rien n’est déployé sur AWS et le
  CI/CD reste inchangé.

Les tests `shared-trip-policy.spec.ts` et `shared-trip-postgres.spec.ts` couvrent
notamment les limites, refus, changement d’état, concurrence sur la dernière
place, double acceptation, retour arrière transactionnel et conservation du
trajet des autres passagers. Les tests PostgreSQL utilisent un cluster jetable
avec données fictives. La réception réelle FCM/APNs et le parcours embarqué
Android/iOS restent à valider sur appareils.

Vérifications locales : suite générale de 210 suites et 2 384 tests réussis,
328 tests ignorés dans ce lancement selon leurs prérequis ; 92 tests ciblés
avec PostgreSQL/PostGIS puis 21 tests de partage PostgreSQL après ajout des
derniers scénarios ; dernière vérification ciblée de 165 tests backend réussis ;
24 tests JavaScript mobiles réussis. Les compilations
applicatives se vérifient avec `tsc -p tsconfig.build.json --noEmit` côté backend
et `tsc --noEmit` côté mobile : les deux passent. Aucun test ne lance un paiement
ou un push réel.

## 20 octobre 2026 — Exclure l’auteur des alertes de sa propre commande

- **Périmètre et constat :** un conducteur peut être passager lorsqu’il commande.
  Des tests terrain signalent une sonnerie sur son propre appareil. Les trois
  sélections locales de destinataires excluaient déjà l’auteur, mais les
  messages ne portaient pas toujours son identifiant et la livraison ne
  contrôlait pas cette exclusion. La cause du push réellement reçu n’a pas été
  reproduite ni attribuée à un serveur déployé ; les correctifs renforcent les
  contrôles aux frontières où ils manquaient.
- **Production des messages :** ajout de `passengerId` dans
  `src/trip-requests/dispatch/scheduled-request-alert.ts`, `dispatch.service.ts`
  et `src/trip-requests/trip-requests.service.ts`. Le rayon, le nombre de
  destinataires, les exclusions SQL existantes, les droits et la capacité de
  sonnerie restent inchangés.
- **Livraison et reprise :** `src/notifications/driver-request-owner.ts` réutilise
  l’auteur porté par les nouveaux messages ; pour les anciens, lecture
  paramétrée par l’identifiant de demande ou d’offre. Dans
  `notifications.service.ts`, une alerte conducteur sans auteur déterminable ou
  dont l’auteur est le destinataire est rendue inactive sans envoi. Une erreur
  de lecture reste un échec temporaire reprenable, avec diagnostic générique
  sans données personnelles. Les validations SQL existantes des alertes
  programmées et offres immédiates excluent l’auteur réel avant renvoi et
  enrichissent l’ancien message avec son identifiant. Aucun aller-retour
  supplémentaire par conducteur pour les messages nouvellement produits ;
  aucune migration, aucun index ajouté ni changement de données exécuté.
- **Compatibilité :** les notifications destinées au passager (acceptation,
  refus, offre d’un conducteur) restent autorisées pour un compte conducteur
  commandant comme passager. Un jeton push partagé par plusieurs comptes reste
  bloqué par le contrôle d’unicité préexistant. Le mobile reçoit l’auteur pour
  refuser aussi les alertes personnelles à la réception/restauration.
- **Tests :** `driver-request-policy.spec.ts` couvre les quatre types de demande,
  un auteur conducteur, les anciens messages sans auteur, une offre sans
  identifiant de demande, les erreurs transitoires, les commandes disparues et
  les réponses légitimes au passager. `scheduled-request-alert.spec.ts`,
  `dispatch-speech.spec.ts` et `driver-action-notifications.spec.ts` vérifient
  les exclusions, paramètres et métadonnées. Commande Jest `--runInBand
  --no-cache --silent --testPathPatterns 'notifications|scheduled-request-alert.spec|
  dispatch-speech.spec|trip-request-privacy.spec|trip-request-alert-routing.spec'` :
  **15 suites réussies, 226 tests réussis, 27 ignorés** dans la suite
  `transactional-notifications-postgres.spec.ts` non configurée. TypeScript
  `tsc --project tsconfig.build.json --noEmit --incremental false` réussi.
  Les transports et requêtes sont simulés : aucune mesure EXPLAIN, aucun essai
  FCM/APNs réel et aucune validation PostgreSQL de cette modification.
- **Précautions et limites :** modifications locales préexistantes préservées.
  Aucun déploiement, accès en écriture à une base, envoi de notification,
  changement de configuration ou de secrets. Déployer ce correctif serveur et
  le mobile avant la recette à deux comptes, premier plan/veille/relance :
  l’auteur ne sonne pas, les autres conducteurs reçoivent la demande, puis leur
  réponse notifie l’auteur en tant que passager. Aucune disparition de crash
  ou amélioration de consommation native annoncée.

## 19 octobre 2026 — Gestion des véhicules de la plateforme par l'admin

- **Demande et périmètre :** fournir au back-office une liste globale filtrable
  par type, puis la possibilité de consulter, modifier et désactiver un véhicule.
  Implémentation backend uniquement ; les routes propriétaire `/vehicles`
  et les filtres `/admin/users` ajoutés précédemment restent inchangés.
- **Endpoints (préfixe habituel `/api/v1`) :**
  - `GET /admin/vehicles?vehicleType=car&isActive=true&page=1&limit=25` :
    renvoie `{ vehicles, total, page, limit }`. `vehicleType` accepte `car`,
    `motorcycle_2_wheels`, `motorcycle_3_wheels`. Sans ce paramètre, tous les
    types sont inclus. Sans `isActive`, actifs et désactivés sont inclus ;
    `isActive=true` ou `false` filtre leur état. Pagination : 25 lignes par
    défaut, 200 maximum, pages entières positives. Filtres appliqués en base
    avant comptage/pagination ; tri `createdAt DESC, id DESC` stable à dates égales.
  - `GET /admin/vehicles/:vehicleId` : détail, y compris pour un véhicule inactif.
  - `PUT /admin/vehicles/:vehicleId` : modification partielle de `brand`, `model`,
    `color`, `type`, `licensePlate`, `photoUrl`, `isActive`. Corps vide refusé.
    Exemple : `{ "color": "Noir", "licensePlate": "1234AB01" }`. Les champs texte
    sont bornés et nettoyés ; les valeurs nulles/non conformes sont refusées.
    `isActive` attend un booléen JSON, jamais une chaîne `"false"`/`"true"`.
    `true` utilise la réactivation existante, sans contourner l'éligibilité du
    compte conducteur ; `false` applique les mêmes vérifications que ci-dessous.
  - `PUT /admin/vehicles/:vehicleId/deactivate` : aucune suppression physique ;
    renvoie `{ id, isActive: false, message }`. Une répétition sur un véhicule
    déjà inactif reste possible. L'identifiant doit être un UUID valide.
- **Réponses et accès :** chaque véhicule contient ses propriétés et un objet
  `owner` limité à l'identité/contact, rôle et état du propriétaire. Photos
  converties par le service d'URL existant, sans accès aux pièces KYC. Pas de
  mot de passe, jeton de session ou jeton push. Authentification JWT et rôles
  admin/super-admin requis, contrôle du compte administrateur actif également
  dans le service ; marketeurs, conducteurs et passagers refusés. Limites
  existantes de fréquence : 30 lectures/minute, 10 écritures/minute.
- **Règles conservées :** `AdminVehiclesService` récupère le propriétaire en
  base, jamais dans le corps reçu. Liste blanche de champs éditables : impossible
  de changer `ownerId`, `id` ou les dates. Les écritures délèguent à
  `VehiclesService.update/remove` : normalisation/unicité des plaques, capacité
  du type face aux trajets, invalidation des caches et règles d'activation
  conducteur existantes. Désactivation refusée avec HTTP 400 et le code
  `VEHICLE_HAS_ACTIVE_TRIPS` pour les trajets `ongoing`/`upcoming`, ou
  `VEHICLE_HAS_ACTIVE_RECURRING_TRIPS` pour un modèle récurrent actif non terminé.
  Les trajets terminés/annulés et l'historique sont conservés. Actions réussies
  journalisées avec l'admin, le véhicule et les noms des champs, sans leurs
  valeurs ; il ne s'agit pas d'une nouvelle table d'audit immuable.
- **Implémentation :** nouveaux `src/admin/admin-vehicles.controller.ts`,
  `admin-vehicles.service.ts`, `dto/admin-vehicles.dto.ts` ; branchement dans
  `admin.module.ts` avec le `VehiclesModule` existant. Lecture TypeORM avec
  jointure many-to-one et sélection bornée du propriétaire, sans requête en
  base par véhicule. Aucun changement de schéma, migration, `.env`, dépendance,
  Terraform, CI/CD ou environnement AWS.
- **Vérifications :** 141 tests admin/véhicules unitaires et HTTP réussis ;
  16 tests PostgreSQL 18/PostGIS isolés réussis (dont les six de non-régression
  du filtre utilisateurs). Nouveaux tests dans `admin-vehicles.spec.ts`,
  `admin-vehicles.http.spec.ts`, `admin-vehicles-postgres.spec.ts`. Validation
  des rôles et DTO via HTTP local, filtres/totaux/jointures, modifications
  persistées, unicité des plaques, capacité, refus de désactivation par les
  deux chemins, récurrence, historique et invalidation des caches. Compilation
  TypeScript `tsconfig.build.json --noEmit --incremental false` validée.
  PostgreSQL jetable arrêté et supprimé après les tests ; aucune base réelle,
  lecture de `.env` ni utilisation de S3/Redis. L'authentification des tests HTTP
  est synthétique ; les règles de rôle et les pipes Nest sont réels. Pas de
  simulation de publications concurrentes, test de charge ou validation du
  front admin. Le modèle de concurrence du service véhicule existant est inchangé.

## 19 octobre 2026 — Filtre admin par type de véhicule actif

- **Demande :** filtrer `GET /admin/users` et `GET /admin/users/export` sur
  le véhicule actif, avec un champ utilisable par le filtre défensif du front.
- **Contrat :** paramètre facultatif `vehicleType=car`,
  `vehicleType=motorcycle_2_wheels` ou `vehicleType=motorcycle_3_wheels`.
  Absence ou chaîne vide : aucun filtre supplémentaire. Toute autre valeur
  est refusée avec HTTP 400 avant une requête en base. Les paramètres existants
  `role`, `search`, `registeredFrom`, `registeredTo`, `page` et `limit` gardent
  leur sens ; l'export reste non paginé. Exemple :
  `/api/v1/admin/users?role=driver&vehicleType=motorcycle_2_wheels` ; mêmes
  filtres sur `/api/v1/admin/users/export`.
- **Sélection :** au moins un véhicule du propriétaire doit avoir
  `isActive=true` et le type demandé. Un ancien véhicule désactivé ne suffit
  pas. Le modèle autorisant plusieurs véhicules actifs, la sous-requête
  `EXISTS` construite avec TypeORM filtre avant pagination et comptage, sans
  dupliquer les utilisateurs. Les valeurs sont liées comme paramètres SQL.
- **Réponse :** chaque utilisateur de la liste expose `activeVehicleType`
  (une des trois valeurs ou `null` sans véhicule actif). Avec un filtre, le
  type actif correspondant est privilégié pour que le front ne rejette pas
  un utilisateur possédant plusieurs types de véhicules. Sans filtre, on
  retient le véhicule actif le plus récemment créé, puis l'UUID décroissant
  en cas d'égalité. Le détail utilisateur, qui partage ce sérialiseur,
  reçoit également ce champ. Les colonnes et le nom du fichier XLS ne changent
  pas ; seul son jeu d'utilisateurs est filtré.
- **Fichiers et précautions :** `src/admin/admin.controller.ts` expose et
  documente le paramètre Swagger ; `dto/admin-users.dto.ts` le valide ;
  `admin.service.ts` mutualise liste/export et enrichit le chargement groupé
  des véhicules existant, sans requête par utilisateur. Droits admin,
  limitations de fréquence, règles KYC/rôle et suppression des secrets dans
  les réponses conservés. Aucune migration, dépendance, variable d'environnement,
  modification Terraform/CI/CD, intervention ou déploiement AWS.
- **Vérification :** 75 tests du module admin réussis et six tests sur
  PostgreSQL 18 local jetable dans `admin-users-vehicle-postgres.spec.ts`.
  Couverture des trois types, véhicules désactivés, propriétaires multiples,
  champ retourné, pagination/total, export et combinaison rôle/KYC/recherche/
  dates. Test SQL activé avec `AUDIT_TEST_POSTGRES_BIN`, sans lecture de `.env`
  ni accès à une base applicative ; cluster arrêté et supprimé après les tests.
  Les noms synthétiques du test combiné sont ASCII pour rester indépendants
  de la locale C de ce cluster. TypeScript `tsconfig.build.json --noEmit
  --incremental false` validé. Pas de test de charge ni mesure en production.

## 19 octobre 2026 — Détails des trajets pour les annonces vocales mobiles

- **Problème / demande :** les alertes conducteurs n'exposaient pas de description
  structurée utilisable par une annonce vocale courte. La nouvelle annonce doit
  être lue uniquement au premier plan ; en arrière-plan, le mobile conserve le
  vocal réservé au trajet en cours et la sonnerie des nouvelles alertes.
- **Solution appliquée :** `src/notifications/ride-speech-data.ts` produit
  `rideSpeechVersion`, `rideDeparture`, `rideArrival`, `rideSeats` et
  `rideDepartureAt`, tous scalaires, optionnels et bornés. Pas de nom, téléphone,
  coordonnées ou message libre ajouté à ces métadonnées. Le subscriber
  `transactional-notifications.subscriber.ts` utilise les points de réservation
  du passager, avec repli sur le trajet. Les producteurs
  `src/trip-requests/dispatch/dispatch.service.ts` et `scheduled-request-alert.ts`
  fournissent les points, places et date prévus pour les commandes immédiates
  et programmées. Aucun appel à un service distant de synthèse vocale.
  `src/notifications/notifications.service.ts` inclut aussi la limite `ringUntil`
  dans les commandes programmées APNs/FCM v2 (déjà présente en FCM v3) pour
  permettre une reprise au premier plan seulement pendant la fenêtre fraîche.
  La durée de sonnerie et l'expiration métier ne sont pas prolongées.
- **Conservé :** mêmes transactions, contrôles d'accès, rayon/destinataires,
  délais d'offre, événements dédupliqués, compatibilité anciens clients et
  transports FCM/APNs ; champs supplémentaires ignorables par un ancien mobile.
  Pas de requête supplémentaire, changement de SQL, schéma ou migration.
- **Tests :** 141 tests passent dans `ride-speech-data.spec.ts`,
  `transactional-notifications.subscriber.spec.ts`, `scheduled-request-alert.spec.ts`,
  `dispatch-speech.spec.ts`, `driver-action-notifications.spec.ts`,
  `passenger-ride-sound.spec.ts`, `bookings.service.spec.ts`. Vérifications des
  descriptions, des replis, des valeurs invalides, de tous les producteurs et
  de la conservation des champs dans les transports FCM/APNs. TypeScript
  `tsconfig.build.json --noEmit` réussi. Tests synthétiques, sans base réelle.
- **Limites :** aucun déploiement AWS, notification réelle ou validation sonore
  sur téléphone. Le comportement de lecture appartient au mobile et doit être
  livré/testé avec lui ; détails et recette dans le
  [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md).

## 19 octobre 2026 — Sonnerie des réponses de réservation côté passager

- **Constat :** seule l’acceptation d’une commande (`trip_request_accepted`)
  demandait le son embarqué côté passager. Les réponses aux réservations publiées
  utilisaient `booking_response` ou un payload sans type, donc un son ordinaire.
- **Solution appliquée :** `src/bookings/bookings.service.ts` fournit type,
  statut et rôle passager pour les acceptations/refus, y compris dans la file
  transactionnelle des invitations. `src/notifications/notifications.service.ts`
  ajoute le son `driver_ring` / `driver_ring.wav`, le destinataire passager et
  `ringUntil` aux réponses compatibles ; tag Android stable par réservation.
  Ces métadonnées permettent au mobile d’arrêter son lecteur lorsque le passager
  ouvre le trajet concerné, sans lui attribuer les boutons du conducteur.
- **Conservé :** validation du token de notification et de sa capacité, client
  ancien recevant toujours un push visible, expiration des offres conducteurs,
  transactions de réservation, rayon de diffusion et contrôles d’acceptation.
  Les statuts terminé/annulé ne deviennent pas des réponses sonores. Aucun
  changement de schéma, migration, SQL de sélection ou configuration AWS.
- **Vérification :** 101 tests Jest passent dans `passenger-ride-sound.spec.ts`,
  `driver-action-notifications.spec.ts`, `bookings.service.spec.ts`. Vérification
  TypeScript `tsconfig.build.json --noEmit` réussie. Tests synthétiques ; aucun
  push réel envoyé et aucune preuve de lecture audio sur téléphone physique.
- **Livraison :** correctif local à déployer avec le mobile décrit dans le
  [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md). Le son système
  reste borné à 29–30 s en arrière-plan ; le lecteur au premier plan relève du
  mobile. Aucun déploiement ou changement de données de production effectué.

## 18 octobre 2026 — Vérification du contrat Apple email / App Review

- **Périmètre :** nouvelle présentation du refus App Review du 12 octobre,
  avec `property email should not exist` à la fin de l’inscription Apple.
  Le correctif `RegistrationCompatibilityDto` est déjà présent : transformation
  de l’ancien champ `email` en `undefined` et héritage pour les DTO téléphone,
  Google et Apple. Les autres champs inconnus restent refusés et l’adresse Apple
  utilisée par le service provient du jeton vérifié, pas du corps client.
- **Vérification réelle de l’API AWS actuelle :** deux requêtes synthétiques à
  `/auth/apple/mobile`, avec jeton volontairement invalide : l’une contenant
  `email` obtient `401` sans erreur sur ce champ ; l’autre contenant un champ
  inconnu obtient `400` avec rejet explicite. Aucune authentification réussie,
  aucun compte créé, aucun jeton valide ou secret utilisé, aucune modification
  AWS/RDS. Cela ne prouve pas quelle API était appelée par l’ancien binaire.
- **Vérification locale :** `node node_modules/jest/bin/jest.js --runInBand
  --silent --runTestsByPath src/auth/registration-compatibility.spec.ts
  src/auth/apple-keys-resilience.spec.ts src/auth/driver-signup.spec.ts` :
  **58 tests réussis**. Contrôle de la suppression de `email` avant la logique
  applicative, du rejet des champs inconnus/privilégiés, de la provenance de
  l’adresse, de la vérification Apple et des inscriptions conducteur.
- **Corrections complémentaires mobiles :** adresse de secours encore Render
  remplacée par AWS, destination du profil de production EAS explicitée,
  possibilité de compléter le nom Apple absent dans le formulaire et suppression
  de `email` résiduel de l’inscription par téléphone. Voir le
  [journal mobile](../../zwanga/docs/CHANGEMENTS_TECHNIQUES.md#2026-10-18--connexion-apple--finalisation-du-profil-et-api-de-production).
  Le code fonctionnel serveur n’a pas été modifié par cette vérification.
- **Limites :** aucune preuve de connexion avec un véritable compte Apple sur
  iPhone/iPad, aucune nouvelle soumission ou promesse d’acceptation App Review.
  Les essais natifs du nouveau build, neuf et après mise à jour, restent requis.

## 18 octobre 2026 — Dernière position conducteur durable et analyse GPS mobile

- **Demande et périmètre :** accepter une localisation ancienne et utiliser la
  dernière position connue pour les demandes immédiates et programmées ; analyser
  les envois mobiles en arrière-plan. Modifications backend locales uniquement :
  aucun déploiement, aucune modification AWS, Terraform, CI/CD, `.env` ou mobile.
- **Implémentation :** `src/trip-requests/dispatch/dispatch.service.ts` ne refuse
  plus un GPS pour son ancienneté. Les dates invalides ou de plus de cinq secondes
  dans le futur restent refusées, avec le code explicite
  `DRIVER_POSITION_TIMESTAMP_INVALID`. Un envoi retardé ne remplace pas une position
  horodatée plus récemment. Une position peut être enregistrée pendant une prise
  en charge, mais le conducteur reste exclu des nouvelles propositions tant qu'il
  est occupé. La précision et les coordonnées restent validées par le DTO.
- **Sélection et acceptation :** `driver-location-policy.ts` centralise le critère
  de position utilisable, partagé par les demandes immédiates, programmées et le
  contrôle d'acceptation. Une position durable reste utilisable même si son ancien
  `expiresAt` est passé. Suppression du cron qui effaçait les positions âgées de
  plus d'un jour. Une seule position par conducteur est conservée, pas un historique.
  Les suppressions utilisateur/véhicule continuent d'appliquer leurs clés étrangères.
  Les réponses de statut conservent leurs anciens champs et ajoutent
  `locationPolicy: last_known`, `positionExpires` et les métadonnées de position.
  `positionFreshSeconds` et `expiresAt` restent des informations de compatibilité,
  pas un délai d'exclusion pour les positions durables.
- **Migration additive :** `1780000076000-RetainDriverLastLocation.ts`, enregistrée
  dans `src/database/migrations/index.ts`, ajoute `discoveryEnabled` nullable.
  `true` autorise la sélection sans limite d'âge ; `false` mémorise une
  désactivation explicite par l'API de présence ; `NULL` conserve la règle des
  anciennes lignes. Pas de backfill ni réécriture des coordonnées. Les anciens
  `expiresAt` ne permettent pas de distinguer une expiration d'un arrêt volontaire :
  une ligne historique expirée attend donc une nouvelle remontée GPS acceptée pour
  devenir durable. Cette remontée peut elle-même être ancienne, mais ne doit pas
  remplacer un point plus récent. Les positions déjà purgées ne sont pas recréées.
  Un heartbeat retardé ou un nouveau GPS ne réactive pas un `false` explicite ; une
  nouvelle activation volontaire via l'API de présence est nécessaire.
- **Garanties conservées :** rayon 5 km basé sur le point connu, KYC approuvé,
  compte conducteur actif, jeton push, véhicule/type/places compatibles, exclusions
  des engagements en cours, diffusion par lots de 50 et déduplication. La durée
  de validité des invitations et alertes push est inchangée : seule la localisation
  cesse d'expirer. Le rappel GPS après six heures reste informatif, avec un texte
  adapté ; il n'est plus créé pour une présence explicitement désactivée.
  Les règles PostgreSQL ont conduit à garder la migration additive, les transactions
  courtes et l'index spatial existant, sans index booléen ni appel réseau sous verrou.

### Analyse de l'application mobile actuelle, sans modification

Les sources examinées sont dans le dépôt voisin `zwanga`, pas nécessairement le
binaire actuellement distribué sur les stores.

1. `components/DriverPresenceCoordinator.tsx` démarre le suivi quand un conducteur
   authentifié ouvre l'app et que le dispatch est actif. Il tente le service natif
   ou, à défaut, un relevé au premier plan toutes les 180 secondes. Si le service
   natif est déclaré démarré, le coordinateur ne force pas de premier relevé HTTP :
   il attend le prochain callback natif.
2. `services/nearbyDriverLocation.ts` utilise `expo-location` et une tâche
   `TaskManager` déclarée au niveau du module. Autorisation arrière-plan, GPS actif
   et compte correspondant sont requis. Profil équilibré, `timeInterval` et
   `deferredUpdatesInterval` à 180 000 ms, distance minimale nulle. Les callbacks
   peuvent envoyer en veille ; le démarrage du service exige l'app au premier plan.
3. Android utilise une notification de service persistante mais configure
   `killServiceOnDestroy: true` pour la proximité. iOS a le mode natif `location`
   et demande l'autorisation « Toujours ». Manifest Android et Info.plist déclarent
   les permissions nécessaires. Déclaration native ne signifie pas autorisation
   effectivement accordée sur le téléphone. Le système peut retarder les relevés ;
   une app terminée ne garantit pas la poursuite du suivi
   ([documentation Expo Location](https://docs.expo.dev/versions/latest/sdk/location/#background-location)).
4. **Restriction mobile encore présente :** `nearbyDriverLocationPolicy.ts` rejette
   avant envoi les points de plus de 30 secondes, de précision supérieure à 250 m,
   simulés, invalides ou datés de plus de cinq secondes dans le futur. Le callback
   ne conserve que le point le plus récent d'un lot. Le correctif serveur ne peut
   pas récupérer les points éliminés côté mobile. Une harmonisation de cette
   règle nécessite une modification mobile distincte, non réalisée ici.
5. `nearbyDriverPositionDelivery.ts` envoie latitude, longitude, précision et date
   par `PUT /driver-dispatch/position`, avec transport authentifié, renouvellement
   de session et délai HTTP de dix secondes. Un seul envoi à la fois ; aucune file
   persistante de GPS. Échec réseau/429 : attente croissante de 30 secondes à cinq
   minutes, puis nouvel essai sur un prochain point. 401/403/404 : arrêt du suivi
   natif jusqu'à une réconciliation ultérieure. Les erreurs GPS sont peu visibles.
6. Un trajet actif suspend cette tâche de proximité. Le suivi de trajet utilise
   une autre tâche et un autre endpoint, environ toutes les huit secondes, avec
   `killServiceOnDestroy: false` sur Android. Il n'alimente pas directement la
   présence de proximité : après un trajet, la dernière position de découverte
   peut rester celle d'avant le départ jusqu'à la reprise des relevés de proximité.
7. Le bouton mobile « Désactiver la localisation en veille » arrête la collecte
   native et mémorise le choix localement ; il n'appelle pas l'API de désactivation
   des propositions. Le premier plan peut encore fournir un GPS. Avec la nouvelle
   règle, arrêter cette collecte ne retire donc pas la dernière position déjà connue
   du serveur. Refuser les alertes et refuser la collecte en veille sont deux choix
   différents ; la désactivation explicite de présence backend reste respectée.

### Vérification et déploiement restant

- Compilation de production : `tsc --project tsconfig.build.json --noEmit
  --incremental false` réussie.
- Backend : **70 tests** dans les quatre suites dispatch ciblées, dont une base
  PostgreSQL 18/PostGIS jetable sur loopback ; **96 tests** supplémentaires de
  notifications et demandes de trajet. Cas couverts : position de 90 jours,
  sélection immédiate/programmée, acceptation, ordre des GPS, refus volontaire,
  conducteur occupé, transition legacy, migration aller/retour et concurrence.
- Mobile : **42 tests JavaScript existants** réussis (`nearbyDriverLocation`,
  `nearbyDriverDelivery`, `nearbyDriverPermission`, `driverAvailability`). Ces tests
  confirment les règles actuelles ; ce ne sont pas des essais natifs sur téléphone.
- Le premier essai PostgreSQL a été bloqué au démarrage par le sandbox ; la relance
  avec l'autorisation locale adaptée a réussi, avec arrêt/nettoyage du cluster jetable.
  Aucun accès à une base applicative ni envoi de push réel pendant ces tests.
- Avant mise en service : exécuter la migration enregistrée avec le mécanisme
  habituel **avant** de lancer le nouveau backend. Aucun nouveau paramètre AWS
  nécessaire. Vérifier ensuite un conducteur de test, une position reçue et une
  alerte réellement affichée sur Android/iOS. Ne pas interpréter ces tests locaux
  comme une preuve de correction des incidents de production précédents.
- Risque produit accepté : un conducteur ayant quitté la zone peut être sollicité
  selon son ancienne position. L'ancienneté du GPS ne bloque plus la sélection,
  mais ne constitue toujours pas une preuve de sa présence réelle ni de la
  disponibilité de son téléphone.

## 18 octobre 2026 — Diffusion à tous les conducteurs proches et push de secours

- **Périmètre et problème :** une nouvelle commande peut ne produire aucun push
  chez un conducteur. La demande est de notifier tous les conducteurs éligibles
  à 5 km, pour les départs immédiats comme programmés. Le backend possédait déjà
  une diffusion par lots de 50, continuée aux cycles suivants, mais les deux
  sélections exigeaient un enregistrement `driver_notification_clients` lié au
  jeton courant. Une inscription incomplète, un ancien client ou une rotation de
  jeton pouvait donc exclure le conducteur avant même la préparation d’un push.
  Le cas programmé exigeait même une capacité de sonnerie v2/v3. Ce défaut est
  établi dans le code ; son lien avec un essai utilisateur particulier n’a pas
  été prouvé par une trace de livraison.
- **Solution appliquée :** `dispatch/scheduled-request-alert.ts` et
  `dispatch/dispatch.service.ts` sélectionnent désormais les destinataires sans
  filtre de capacité sonore. Le générateur SQL devenu inutilisé est retiré de
  `dispatch/nearby-driver-policy.ts` (chemins sous `src/trip-requests/`). La
  capacité sert seulement à choisir le transport dans
  `src/notifications/notifications.service.ts` : Android v3 conserve le message
  de données traité par Notifee, les versions compatibles conservent leur son
  existant ; sans capacité suffisante, le serveur envoie un push visible avec
  titre/corps, priorité élevée et canal `zwanga_default` avec son standard. Ce
  secours utilise aussi un délai de livraison borné à l’échéance de l’alerte,
  au plus 30 secondes. Sur iOS, le push ordinaire reste visible quand la capacité
  manque et reçoit désormais cette même durée de validité bornée.
- **Comportements conservés :** rayon géographique de 5 km, position récente,
  conducteur actif avec KYC approuvé et jeton push, véhicule et places adaptés,
  exclusions des trajets/prises en charge en cours et du demandeur. La limite
  de 50 borne un lot, pas le nombre total de destinataires. Clés de déduplication,
  reprise des lots, outbox transactionnelle, contrôle du destinataire et de
  l’état de la commande avant livraison conservés. Pour l’immédiat, la première
  acceptation gagne et invalide les autres offres ; une commande programmée ne
  réserve pas les conducteurs. Aucun nouveau canal de sonnerie, consentement
  contourné, volume forcé, dépendance ou schéma ajouté. Les migrations de
  diffusion déjà présentes restent un prérequis du déploiement habituel.
- **Vérifications AWS en lecture seule :** service ECS actif/stable lors du
  contrôle, activation du dispatch confirmée, référence des identifiants FCM
  présente. Aucun secret d’authentification, token ou contenu utilisateur affiché
  ou copié ici. Sur 1 042 lignes du flux courant, dans une fenêtre maximale de
  six heures, aucun des marqueurs recherchés de création de commande/envoi push
  n’apparaissait. Cet échantillon ne démontre ni la réception d’un téléphone,
  ni un échec FCM, ni la cause de l’essai signalé. Aucune modification AWS/RDS,
  exécution de tâche distante, notification réelle ou migration n’a été lancée.
- **Tests :** `scheduled-request-alert.spec.ts`, `scheduled-request-delivery.spec.ts`
  et `driver-action-notifications.spec.ts` : **52 tests réussis**, avec transport
  ordinaire de secours pour capacités absentes/anciennes et durée de validité.
  `notifications.service.spec.ts`, `driver-request-policy.spec.ts` et
  `automatic-notification.spec.ts` : **47 tests réussis**, dont protection des
  passagers, propriété des jetons, erreurs transport et reprises. Compilation
  `tsc -p tsconfig.build.json --noEmit --incremental false` réussie. La suite
  PostgreSQL/PostGIS comporte deux nouveaux cas immédiat/programmé : cinq
  conducteurs de capacités différentes, absence d’inscription, jeton renouvelé,
  véhicule incompatible, position périmée/hors rayon et appels concurrents.
  **39 tests réussis sur PostgreSQL 18/PostGIS local jetable** (environ 43 s),
  dont diffusion à 52 conducteurs en plusieurs lots et première acceptation
  concurrente unique. Premier lancement dans le bac à sable : démarrage local
  de PostgreSQL impossible, avant tout test SQL. La relance autorisée a permis
  de vérifier le SQL réel ; les assertions de l’ancien cas excluant le client
  historique ont été adaptées au nouveau comportement et la capacité de places
  de la moto de test corrigée. Le cluster temporaire est arrêté et nettoyé par
  la suite ; aucune base applicative n’a été utilisée. `git diff --check` validé.
- **Précautions et limites :** le guide PostgreSQL a orienté la conservation de
  `ST_DWithin`, des lots bornés sans `OFFSET`, des transactions et verrous
  existants. Aucun gain de performance chiffré n’est revendiqué. Modifications
  locales uniquement, sans fusion de `master`, commit/push ou déploiement. La
  réception FCM/APNs et la sonnerie réelle restent à vérifier sur appareil après
  livraison du backend, avec plusieurs conducteurs géolocalisés à proximité.

## 18 octobre 2026 — Synchronisation du test PostgreSQL de dispatch

- Le déploiement GitHub Actions #61 s'est arrêté sur un unique `deadlock detected`
  dans le `beforeEach` de `dispatch-postgres.spec.ts`, avant les étapes AWS.
  `respond()` lance intentionnellement un cycle avec `void this.tick()` ; le
  nettoyage `TRUNCATE users CASCADE` pouvait commencer pendant ce cycle.
- Correction limitée au test : espion Jest avec implémentation réelle conservée,
  suivi des promesses retournées par `tick()`, attente avec `Promise.allSettled`
  après chaque cas, avant le nettoyage et avant la fermeture de la connexion.
  Une éventuelle promesse rejetée reste un échec après attente des autres cycles.
  Relancer simplement `tick()` ne suffirait pas : son garde anti-chevauchement
  retourne immédiatement lorsqu'un cycle est déjà actif.
- Régression ajoutée : une allocation est retenue par une barrière explicite,
  la réponse au conducteur reste immédiate, et la préparation du nettoyage doit
  attendre la fin du cycle d'arrière-plan. Pas de délai arbitraire, de retry du
  `TRUNCATE`, de test désactivé ni de changement du service applicatif.
- Vérification : **37 tests réussis lors de chacun des trois passages** sur
  PostgreSQL 18/PostGIS local jetable (environ 66 s, 44 s et 49 s). Rapports :
  `tmp/dispatch-sync-1.json`, `tmp/dispatch-sync-2.json`, `tmp/dispatch-sync-3.json`.
  Le contrôle `tsc -p tsconfig.build.json --noEmit --incremental false` passe.
  Le contrôle TypeScript global, incluant toutes les suites de tests, échoue
  sur des erreurs dans d'autres fichiers de tests non modifiés ; aucune erreur
  signalée dans le fichier corrigé. Aucun succès global de typage n'est revendiqué.
- Le guide PostgreSQL a orienté la correction vers la séparation du nettoyage
  et des transactions actives, sans modifier les verrous métier. Aucun changement
  CI/CD, Terraform ou AWS, aucun push ni redéploiement ; la validation distante
  PostgreSQL 16/Linux ARM64 reste à effectuer après publication du correctif.

## 18 octobre 2026 — Diagnostic mémoire RDS en lecture seule

Complément au précontrôle ci-dessous, sans lancer le test de charge ni changer
AWS, Terraform, le CI/CD, le backend ou les paramètres PostgreSQL. Aucun secret
récupéré, aucune connexion SQL ouverte, aucune requête HTTP applicative envoyée.

- **Périmètre mesuré :** sept jours de métriques CloudWatch jusqu'au 18 octobre
  vers 11 h 38, heure de Kinshasa, par périodes de dix minutes ; 360 mesures
  Enhanced Monitoring à la minute sur les six dernières heures ; compteurs
  agrégés sur 11 888 événements PostgreSQL exportés, environ 2,73 Mo analysés.
  Les séries CloudWatch sont complètes et la pagination des journaux système
  a été épuisée. Rapport local filtré, sans messages SQL ni noms de processus
  applicatifs : `tmp/rds-memory-diagnosis/2026-10-18T10-38-27-216Z/report.json`.
- **Mémoire disponible CloudWatch :** moyenne d'environ **64,2 Mio**, minimum
  **22,6 Mio**, dernière moyenne sur dix minutes **70,3 Mio**. Les moyennes
  journalières restent entre environ 59 et 68 Mio : faible marge durable, sans
  diminution continue démontrée sur cette semaine.
- **Swap :** les maxima par période culminent à **170,5 Mio** sur la semaine,
  dernier maximum **116,8 Mio**. Les mesures système distinctes sur six heures
  passent d'environ **128,3 à 122,5 Mio** de swap utilisé. Les compteurs système
  montrent des échanges non nuls, mais l'attente d'I/O CPU reste en moyenne à
  **0,97 %**, au maximum **2,7 %**, sans tâche bloquée dans les échantillons.
  Ce n'est pas une preuve de saturation disque ni de swap complètement inactif.
- **Autres ressources :** CPU RDS maximal **27,4 %** sur sept jours, connexions
  réseau clientes généralement **10**, pics ponctuels à **20**. Crédits CPU
  au minimum **287,2**, stockage libre au minimum **16,81 Gio**, profondeur de
  file disque maximale **0,30**. Les moyennes de latence disque par période
  sont d'environ **0,72 ms en lecture / 0,67 ms en écriture** sur la semaine ;
  elles ne mesurent pas les temps des requêtes SQL ou de l'application.
- **Pas d'incident mémoire identifié dans les journaux examinés :** aucun des
  motifs recherchés pour OOM, échec d'allocation, signal 9, épuisement des
  connexions, réinitialisation, deadlock ou statement timeout. Cela ne garantit
  pas l'absence de tout incident : la portée dépend des journaux exportés et
  des motifs recherchés. Les événements RDS consultés ne montrent que des
  sauvegardes sur sept jours, pas de redémarrage signalé.
- **Répartition système :** environ **921 Mio** visibles par l'OS ; groupe
  agrégé « RDS processes » entre **406 et 444 Mio** de RSS ; cache de fichiers
  entre **170 et 235 Mio**. Ces mesures ne forment pas une comptabilité additive
  (pages partagées, agrégats). `memory.free` système et `FreeableMemory`
  CloudWatch ne sont pas interchangeables : cette dernière reflète
  `MemAvailable`. Ne pas ajouter arbitrairement le cache à la marge disponible.
- **Configuration :** instance `db.t4g.micro`, PostgreSQL 18.3, `available`,
  Single-AZ, groupe `default.postgres18` synchronisé, aucune modification en
  attente. Enhanced Monitoring est déjà actif à 60 secondes ; Performance
  Insights n'est pas activé. Les paramètres du groupe exposent les formules
  AWS par défaut, pas nécessairement les valeurs effectives de `pg_settings`.
  Le code local plafonne le pool API à 10 par défaut, mais sa configuration
  effectivement déployée n'a pas été certifiée par une connexion SQL.

**Conclusion :** marge mémoire structurellement faible, sans fuite ni panne
mémoire démontrée. Le refus de charge reste une précaution du banc (128 Mio),
pas la preuve d'une interruption imminente. L'attribution exacte aux requêtes
nécessiterait des statistiques SQL supplémentaires via un accès autorisé.
Le guide PostgreSQL a orienté le contrôle du pool et l'interprétation prudente
des mesures ; aucune augmentation aveugle des connexions ou de `work_mem`.

**Suite recommandée, non appliquée :** fiabiliser les alarmes mémoire et Redis,
envisager `db.t4g.small` (2 Gio au lieu de 1 Gio) pour davantage de réserve,
puis remesurer avant toute charge. Le redimensionnement doit être approuvé et
planifié avec une interruption potentielle, particulièrement en Single-AZ ;
ni le gain de capacité ni une absence de coupure ne sont garantis par cet audit.

Références : [définitions des métriques RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html),
[interprétation de la mémoire PostgreSQL par AWS](https://aws.amazon.com/blogs/database/understand-memory-management-in-amazon-rds-for-postgresql-to-avoid-out-of-memory/),
[caractéristiques des classes RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.DBInstanceClass.Summary.html).

## 18 octobre 2026 — Précontrôle du test de charge en production : charge non lancée

- Autorisation : test bref et plafonné sur les lectures, sans changement AWS.
  Vérifications vers **11 h 26–11 h 30, heure de Kinshasa (UTC+1)**. Deux passages
  de précontrôle AWS seulement ; **zéro requête HTTP applicative de test envoyée**.
  Le second rapport indique `preflight_refused`, pas un test réussi ou une capacité
  mesurée : `tmp/production-load-results/2026-10-18T10-29-49-048Z/report.json`.
- **Motif de refus préventif :** RDS `db.t4g.micro`, PostgreSQL 18.3, présente
  environ **60–78 Mio de mémoire disponible** sur les quinze minutes précédentes
  (70 Mio au dernier point), avec **116–118 Mio de swap utilisé**. Le seuil local
  de sécurité du banc est 128 Mio ; ce n'est pas un seuil universel imposé par AWS.
  La lecture complémentaire sur une heure confirme une faible marge persistante.
  Un niveau de swap non nul ne prouve pas à lui seul une panne ni des échanges
  disque actifs ; aucun diagnostic de fuite mémoire n'est établi ici.
- La base est `available`, CPU maximal **5,84 %**, **10 connexions**, environ
  **16,8 Gio de stockage disponible**, crédits CPU non épuisés. ECS a une tâche
  active et stable, cible ALB `healthy`, CPU maximal **10,41 %**, mémoire maximale
  **18,95 %** sur la fenêtre. Redis est disponible, CPU moteur inférieur à 0,49 %,
  mémoire autour de 3,64 %. Ces observations ne prouvent pas une tenue sous charge.
- **Supervision à corriger ultérieurement :** aucune alarme retournée pour
  `AWS/RDS / FreeableMemory` avec la dimension de cette base. Les alarmes Redis
  CPU/mémoire sont `INSUFFICIENT_DATA` avec la dimension `ReplicationGroupId` ; les
  métriques existent bien avec `CacheClusterId` + `CacheNodeId`. Les dimensions des
  alarmes sont donc à vérifier. Aucun correctif d'alarme/Terraform appliqué.
- Version observée : définition ECS `zwanga-api-production-api:20`, image API
  `sha256:20d44b95608708ddef28595ce3458d0bfa0f3d32adac37d1217eb5325cad25bc`,
  tag ECR `30ef4d254c96e0fca198abd69272b7867d4b9c40`, publiée le 15 octobre.
  Le checkout local est `d5e3268c9c6992ea0e87d108392f8f6d7146947e` ; le commit du
  tag de production n'est pas disponible localement pour une comparaison source.
  Les performances du code local ne sont pas une mesure de cette image déployée.
- Banc séparé ajouté dans `test/load/production-readonly.cjs` : cible HTTPS fixe,
  liste blanche de trois GET (health, liste et recherche de trajets), rafales de
  1/2/4 lectures, 42 lectures métier prévues, au plus 24/minute pour le même handler,
  arrêt dur avant cinq minutes. Pas de JWT, de faux `X-Forwarded-For`, de retry,
  de redirection automatique ni de réponse utilisateur enregistrée. Les quotas,
  erreurs, latences, états ECS/ALB et métriques peuvent arrêter le test. CloudWatch
  étant différé, ses alertes ne garantissent pas une réaction instantanée à toute
  dégradation. Les seuils du banc n'ont pas été abaissés pour forcer son exécution.
- Réexécuter **uniquement les lectures AWS** :
  `node test/load/production-readonly.cjs --preflight`.
  Le mode actif exige un argument explicite et une autorisation opérateur ; il
  n'a **pas été exécuté** pendant cette intervention. Six tests hors réseau du
  banc et deux tests de l'isolation locale passent ; aucun changement backend,
  secret, CI/CD, infrastructure, migration ou ressource distante créée.
- Suite proposée : examiner la consommation et le dimensionnement mémoire RDS,
  fiabiliser les alarmes, puis refaire le précontrôle avant toute montée en charge.
  Le guide PostgreSQL a conduit à mesurer cette marge sans augmenter le pool.
  Voir les définitions de [FreeableMemory et SwapUsage](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html)
  et les [recommandations AWS sur la mémoire RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Troubleshooting.html#CHAP_Troubleshooting.FreeableMemory).

## 18 octobre 2026 — Pagination des commandes et transferts rejoués : préparation mobile

Ajout d’endpoints paginés authentifiés (commandes disponibles/personnelles et offres),
sélection bornée avant hydratation, recherche paramétrée et curseurs précis.
Référence optionnelle de transfert : un rejeu identique est reconnu sous les
verrous des portefeuilles sans refaire le débit. Les anciens clients et les
règles de solde restent compatibles. Migration 1780000075000 préparée pour les
index de pagination et l’unicité comptable, avec budgets DDL transactionnels.

64 tests ciblés réussis et typage validé ; repositories/DDL simulés, pas de test
de concurrence PostgreSQL réelle. Aucune migration exécutée, aucun déploiement
ou changement AWS. Livraison backend avant mobile ; les anciennes lectures de
l’accueil/recherche/compteurs restent un travail séparé pour ne pas tronquer les
actions prioritaires. Détails et précautions :
[Correctifs backend de l’audit mobile](operations/mobile-audit-fixes-2026-10-18.md).

## 18 octobre 2026 — Correctifs locaux après le test de charge

- **Périmètre :** code backend, tests et documentation uniquement. Aucun changement
  AWS, Terraform, CI/CD, `.env`, fournisseur OTP/KYC ou base existante durant cette
  intervention. Les autres modifications déjà présentes dans le dépôt sont conservées.
- **Cache public des trajets :** les propriétés `undefined` du DTO ES2023 ne sont
  plus considérées comme des filtres. `GET /trips` sans query utilise le cache
  existant ; `false`, `0`, un tri ou une pagination explicites continuent à passer
  par la recherche. Les départs devenus passés sont exclus aussi lors d'un cache hit.
  Sur un cache miss, `findAll` réutilise `search({})` : la limite de 30, la priorité
  Pro avant pagination et le tableau JSON restent identiques au parcours public
  observé avant correction. La clé existante est conservée pour les invalidations.
  Un test PostgreSQL avec 31 trajets et un conducteur Pro placé en dernière date
  vérifie cette équivalence, puis une deuxième lecture sans SQL.
- **Recherche géographique :** le plan réel montrait 5 000 passages dans les
  jointures conducteur/véhicule avant le `LIMIT`. Une CTE matérialisée TypeORM
  sélectionne maintenant les identifiants et clés de tri de la page avant de
  joindre les relations (au plus `limit + 1`, soit 51). Une seule instruction SQL,
  donc un seul instantané ; pas de requête supplémentaire par trajet. Aucun nouvel
  index ni réglage du pool/JIT. Le rayon PostGIS, le GPS frais de moins de 90 secondes,
  son repli sur le départ, les trajets privés et le classement Pro sont conservés.
  Un premier essai séparant les branches géographiques n'a pas amélioré les mesures
  et a été retiré ; le prédicat géographique initial reste en place.
- **Pagination :** les nouveaux curseurs opaques conservent le timestamp PostgreSQL
  exact, microsecondes comprises. Les anciens curseurs ISO restent acceptés avec
  conversion en `Date`, pour éviter de comparer un horaire UTC comme un timestamp
  local sans fuseau. Les tests reproduisent le doublon de frontière puis vérifient
  les pages suivantes/précédentes, le tri Pro et les anciens curseurs.
- **Démarrage compilé :** déplacement de l'import de la migration 75 avant le
  registre qui la référence ; évite une erreur d'initialisation CommonJS. Contenu
  et ordre des migrations inchangés. Un test transpile et évalue le registre sans
  exécuter les migrations. Les migrations de fonctionnalités déjà ajoutées par
  ailleurs ne font pas partie de cette optimisation.
- **Reproduction isolée (PowerShell) :** utiliser une sortie dédiée pour ne pas
  interférer avec `dist` et un éventuel serveur en mode watch. Ces variables sont
  propres au banc local et ne doivent pas être ajoutées à AWS.

  ```powershell
  node node_modules/typescript/bin/tsc -p test/load/tsconfig.json
  node --test test/load/isolation.test.cjs
  $env:LOAD_TEST_BUILD_DIR = Join-Path (Get-Location) 'node_modules/.cache/zwanga-load-build'
  $env:LOAD_TEST_DIAGNOSTICS_ONLY = '0'
  node test/load/run.cjs
  ```

  `LOAD_TEST_DIAGNOSTICS_ONLY=1` permet seulement un EXPLAIN sur les trajets fictifs,
  sans charge ni fixtures de réservations/notifications. Le mode complet capture
  les plans après les mesures, dans une transaction en lecture seule avec timeout.
  Il vérifie aussi trois lectures consécutives de la liste avec **zéro requête SQL**.
  Les analyses EXPLAIN ont guidé la correction conformément au skill PostgreSQL,
  sans augmentation spéculative du pool. Les fichiers de compilation temporaires
  initialement créés sous `tmp/load-build` ont été supprimés ; ils sont régénérables
  dans la sortie dédiée ci-dessus. Les rapports restent conservés.
- Vérification finale : compilation TypeScript isolée réussie, **162 tests ciblés
  dans huit suites réussis**, dont six tests PostgreSQL/PostGIS réels ; deux tests
  supplémentaires du garde réseau et de l'environnement isolé réussis. Il ne s'agit
  pas d'une exécution de toute la suite du projet. Les identifiants des comptes,
  véhicules et trajets des tests sont exclusivement synthétiques.

### Mesures après correction

- Référence : `tmp/load-results/2026-10-18T01-25-41-406Z/report.json`.
  Mesure finale : `tmp/load-results/2026-10-18T09-03-11-186Z/report.json`.
  Même PC, même volume de fixtures et mêmes paliers ; pas des exécutions simultanées
  ni un benchmark contrôlé de production. La liste conserve ses 30 trajets et la
  recherche géographique sa limite de 20 pour ce scénario. Le banc vérifie ces
  deux tailles sur chaque réponse. Le rapport intermédiaire
  `2026-10-18T08-50-05-392Z` utilisait encore la liste historique de 50 ; la mesure
  finale ci-dessus le remplace pour la comparaison.

| Scénario | p95 avant → après | Débit avant → après (req/s) |
| --- | ---: | ---: |
| Liste publique, concurrence 10 | 352 → 33 ms | 49,3 → 383,8 |
| Géographie, concurrence 10 | 1 258 → 422 ms | 13,4 → 44,4 |
| Mixte, concurrence 1 | 348 → 128 ms | 8,9 → 25,9 |
| Mixte, concurrence 10 | 767 → 243 ms | 37,7 → 107,1 |
| Mixte, concurrence 30 | 1 327 → 527 ms | 40,6 → 104,6 |
| Mixte, concurrence 60 | 1 867 → 1 148 ms | 42,6 → 99,3 |
| Profil, concurrence 10 | 121 → 97 ms | 128,0 → 144,3 |
| Notifications, concurrence 10 | 102 → 59 ms | 165,3 → 243,8 |

- **14 468 requêtes mesurées**, toutes HTTP 200 et contenu valide, en 105,3 secondes
  de charge cumulée. Zéro SQL sur les 4 615 lectures de liste chaude ; recherche
  géographique toujours à trois SQL par réponse, profil huit et notifications quatre.
  Les 429/401 des vérifications de sécurité sont attendus et séparés des mesures.
- EXPLAIN normal : environ **431 → 91 ms**, jointures utilisateurs/véhicules
  **5 000 → 21 itérations**, désormais via index. Plan avant dans
  `tmp/load-results/2026-10-18T08-38-27-829Z/report.json` (diagnostic trajets seuls),
  plan après inclus dans le nouveau rapport complet. Aucun changement JIT retenu.
- Cache validé sur trois lectures consécutives ; quota réel 30 succès puis 5 refus
  429 ; dix refresh simultanés donnent un succès et neuf refus 401, ancien access
  token rejeté, nouveau accepté. Aucune tentative de connexion externe enregistrée.
- **Limites restantes :** à concurrence 60, jusqu'à 95 acquisitions du pool en
  attente, malgré le meilleur débit. Le profil reste coûteux (huit SQL). RSS maximal
  d'environ 335 Mo ; retour à faible charge p95 134 ms, pool sans attente. Il reste
  nécessaire de tester la durée, les pannes et un environnement représentatif avant
  toute conclusion de capacité AWS. Les gains du profil/notifications ne sont pas
  attribuables aux seuls correctifs trajets sur ce PC partagé.
- Backend de charge et Redis arrêtés, cluster PostgreSQL et données temporaires
  supprimés automatiquement ; seuls les rapports/logs et fichiers de compilation
  régénérables restent sur disque. Aucune ressource de production touchée.

## 18 octobre 2026 — Banc de charge HTTP local isolé

- Exécution reproductible : `npm.cmd run build`, puis
  `node --test test/load/isolation.test.cjs` et `node test/load/run.cjs`.
  PostgreSQL avec PostGIS est requis (Windows : PostgreSQL 18 par défaut,
  surcharge possible avec `LOAD_TEST_PG_BIN`) ainsi que Redis (Windows : Ubuntu
  WSL). Aucune nouvelle dépendance npm. Ne pas lancer contre un serveur existant.
- Le banc ne propose volontairement aucune URL cible : il crée PostgreSQL,
  Redis et un backend éphémères sur des ports loopback, sans charger `.env` ni
  hériter des secrets. Un garde réseau bloque les connexions TCP du backend
  sauf vers ses deux dépendances de test. Les processus et données temporaires
  sont nettoyés dans le bloc de fin, y compris en cas d'échec.
- Données fictives : 1 000 comptes, 200 véhicules, 10 000 trajets,
  20 000 réservations et 50 000 notifications, insérées par lots.
  Les vrais contrôles JWT et le limiteur Redis restent actifs ; les adresses
  proxy simulées sont acceptées uniquement par le serveur loopback de ce banc.
  Vérification séparée du quota et de dix refresh concurrents sur une session.
- Paliers mixtes de 1, 10, 30 et 60 requêtes simultanées, puis mesures par route
  (liste des trajets, recherche géographique, profil et notifications) et retour
  à faible charge. Chaque palier dure 12 secondes, configurable entre 2 et 30
  avec `LOAD_TEST_STAGE_SECONDS`. Rapports JSON et logs dans `tmp/load-results/`.
  Il s'agit d'une charge en boucle fermée, pas d'un nombre d'utilisateurs actifs
  ni d'un débit imposé. Les latences comprennent l'attente des réponses complètes.
- Limites : générateur et services partagent le PC ; schéma de test issu des
  entités et index de lecture, sans triggers financiers ni contrôle readiness
  du schéma financier. Cron, trafic WebSocket, OTP, KYC, paiements, push externes,
  ALB/TLS, panne de dépendance et haute disponibilité ne sont pas évalués.
  Ces mesures ne donnent pas la capacité de l'infrastructure AWS.
- Aucun changement du code métier, de Terraform, du CI/CD ou d'AWS pour ce test.

### Résultat de l'exécution locale du 18 octobre

- Rapport brut : `tmp/load-results/2026-10-18T01-25-41-406Z/report.json`.
  6 078 requêtes mesurées en 107,3 secondes de charge cumulée, toutes HTTP 200
  avec contrôle du contenu. Les 429/401 des vérifications de protection sont
  attendus et comptés séparément. Deux premiers essais ont échoué pendant la
  préparation des fixtures (alias SQL ambigu, puis insertion trop volumineuse),
  avant les mesures ; leurs ressources ont également été nettoyées.
- Charge mixte : concurrence 1 / 10 / 30 / 60, débit respectif
  8,9 / 37,7 / 40,6 / 42,6 requêtes/s, p95 348 / 767 / 1 327 / 1 867 ms.
  La hausse de concurrence améliore peu le débit au-delà de 10 : le pool de
  10 connexions atteint 79 acquisitions en attente au palier 60. Ce sont des
  attentes de connexion, pas 79 connexions supplémentaires ni 79 utilisateurs.
- Routes isolées, concurrence 10 : liste 49,3 req/s (p95 352 ms), recherche
  géographique 13,4 req/s (p95 1 258 ms), profil 128,0 req/s (p95 121 ms),
  notifications 165,3 req/s (p95 102 ms). Le profil exécute huit requêtes SQL
  par réponse, les notifications quatre et chaque lecture des trajets trois.
- Défaut confirmé sans correction métier : `TripsController.findAll` teste
  `Object.keys(searchTripsDto).length`. Le DTO compilé ES2023 contient quinze
  propriétés même quand la query est vide ; la route appelle donc `search`,
  non `findAll`, et ne bénéficie pas du cache prévu pour la liste. Reproduction
  avec `plainToInstance(SearchTripsDto, {})` et observation de 3 SQL par requête.
  Le libellé historique `trips_cached` du rapport désigne cette liste sans
  filtre, **pas une preuve de cache hit** ; le banc utilise désormais le nom
  neutre `trips_list`. La recherche géographique est la route la plus lente de
  cet échantillon ; identifier sa cause exacte nécessite des plans SQL et des
  mesures supplémentaires, pas une augmentation aveugle du pool.
- Protections : 30 requêtes acceptées puis 5 réponses 429 pour une même IP ;
  dix refresh concurrents donnent un succès et neuf refus 401 ; ancien access
  token refusé, nouveau accepté. Aucun essai de connexion externe observé.
- Retour à faible charge : p95 459 ms contre 485 ms lors de l'échauffement,
  sans attente du pool. Mémoire RSS du backend : pic d'environ 340 Mo ; un test
  aussi court ne permet pas de conclure à l'absence de fuite mémoire.
- Contexte : Windows, i7-1185G7, 8 processeurs logiques, 15,7 Gio de RAM,
  Node 24.11, PostgreSQL 18/PostGIS 3.6 et Redis 7.0.15 via WSL, sur le même PC
  que le générateur et les autres applications. Aucune projection de capacité
  ECS/RDS. Build et deux tests de l'isolation réussis. Backend/Redis arrêtés,
  cluster PostgreSQL et répertoire temporaire supprimés ; rapports conservés.

## 18 octobre 2026 — Activation du mode Didit natif en production AWS

- **Demande et constat :** utiliser le SDK Didit sur mobile. Le paramètre
  `/zwanga-api/production/env/DIDIT_KYC_LAUNCH_MODE` était encore `hosted` en
  production ; `/zwanga-api/production/env/KYC_PROVIDER` valait déjà `didit`.
- **Action exécutée :** passage du seul mode de lancement à `native` dans SSM,
  version 2, le 18 octobre à 01:16:55 (Africa/Kinshasa). Type `SecureString`,
  clé KMS et niveau Standard conservés. Fournisseur Didit inchangé ; aucune
  clé API, aucun workflow ni paramètre OTP modifié.
- **Prise en compte :** renouvellement progressif du service
  `zwanga-api-production-api`, cluster `zwanga-api-production-cluster`, région
  `eu-central-1`. Même définition de tâche `:20` et même image backend immuable
  `sha256:20d44b95608708ddef28595ce3458d0bfa0f3d32adac37d1217eb5325cad25bc`.
  Aucun nouveau code, migration SQL, plan/apply Terraform ou changement CI/CD.
- **Vérifications réelles :** relecture SSM des deux valeurs et références de
  la définition ECS ; nouvelle tâche `HEALTHY` et cible ALB `healthy` ; réponses
  HTTP 200 de `/health/live` et `/health`. Déploiement `COMPLETED` à 01:20:07,
  service stable avec une tâche active, aucune tâche en attente. ECS Exec est
  désactivé : pas d'inspection directe de l'environnement à l'intérieur du
  conteneur ; les paramètres sont référencés sans version figée et la tâche a
  été créée après leur mise à jour.
- **Limites :** aucun KYC réel/SDK sur téléphone exécuté. Les apps déjà
  installées utilisent leur logique existante quand elles reçoivent un jeton
  SDK ; les correctifs mobiles locaux ne sont pas distribués par cette action.
  Le fichier Terraform local prévoit déjà `didit_kyc_launch_mode = "native"` ;
  il n'a pas été modifié. Les constats « aucune action AWS » de l'intervention
  précédente ci-dessous concernaient les correctifs locaux avant cette demande.
- **Retour arrière si nécessaire :** remettre uniquement le mode SSM à `hosted`
  puis renouveler ECS avec la même image. Non exécuté.

## 18 octobre 2026 — Correctifs d'audit locaux et maintien du KYC Didit natif

- Sessions : rotation conditionnelle des empreintes de jetons pour ne pas rétablir
  une session révoquée pendant un refresh concurrent. Formats JWT et durées conservés.
- Fiabilité/performance : envois OTP non rejoués aveuglément, quotas atomiques Redis,
  outbox transactionnelle pour les expirations/retards, lots bornés d'expiration,
  écritures groupées de diffusion conducteur et traitement urgent borné à cinq envois
  simultanés. Masquage des liens de suivi dans les journaux et délais DDL de la nouvelle
  migration de diffusion. Détails et limites dans
  [le suivi de l'audit](operations/audit-2026-10-18.md#suivi-des-correctifs-locaux).
- Identité : retraits contrôlés avec le dernier dossier KYC. Pour AWS seulement,
  analyse automatique conservée mais revue humaine finale tant que l'authenticité
  documentaire n'est pas établie ; aucun déclassement des approbations existantes.
- **Didit reste le parcours actuel.** Le mode backend natif exige un jeton SDK réel,
  sans substituer un identifiant ou un lien web. Côté dépôt mobile `zwanga`, le SDK
  est utilisé sur Android/iOS ; pas de repli navigateur après erreur et protection
  contre les doubles appuis. Le parcours Web reste disponible pour la cible Web.
- Aucun fichier Terraform ou CI/CD modifié pour ces correctifs, aucune action sur AWS,
  aucune modification des secrets ni des fournisseurs configurés. Les valeurs optionnelles
  des quotas et le mode Didit natif sont illustrés dans `.env.example` uniquement.
- Contrôles : compilation backend de production et typage mobile réussis ; 14 tests
  mobiles ciblés réussis ; tests PostgreSQL temporaires de session/KYC et PostGIS de
  dispatch/expiration réussis. Aucun SMS, appel KYC réel ou test sur téléphone effectué.
  Suite globale finale : 2 156 tests réussis, 266 ignorés, aucun échec ; réserves
  et suites PostgreSQL activées séparément consignées dans le suivi d'audit.

## 18 octobre 2026 — Démarrage après pause et tentatives répétées

- **Problème et périmètre :** `pauseTrip` remet un trajet à `upcoming` sans
  effacer `startedAt`, alors que `startTrip` exigeait `startedAt IS NULL`.
  Une reprise après pause avant embarquement était donc refusée avec le message
  « Le statut du trajet a changé ». Ce chemin a été reproduit par test de service ;
  aucune consultation de l'historique du compte ayant signalé l'erreur.
- **Solution :** `src/trips/trips.service.ts` distingue premier démarrage et
  reprise simple. Le premier initialise le suivi ; la reprise garde l'heure de
  début et la position, et recalcule l'arrivée depuis l'heure de reprise. La mise
  à jour atomique garde les critères trajet/conducteur/état et vérifie NULL ou
  NOT NULL selon le cas, sans égalité fragile sur le timestamp. Une tentative
  répétée ou perdante face à un autre démarrage renvoie l'état actif actualisé
  du même conducteur, sans rejouer la transition ni les notifications. Les
  autres conflits reçoivent `TRIP_START_STATE_CHANGED` avec le texte existant.
- **Conservé :** autorisation du conducteur, KYC, exclusion d'un autre trajet
  actif, index d'unicité existant, prix/places/paiements, aucun redémarrage d'un
  trajet annulé ou terminé. Le workflow d'interruption reste prioritaire et
  conserve les choix des passagers ; une reprise simple avec un passager encore
  à bord est refusée. Les appels externes restent hors de la mise à jour courte,
  conformément aux précautions du skill PostgreSQL. Pas de nouveau verrou long.
- **Tests :** `src/trips/trip-start-restart.spec.ts` ajouté. Avec
  `src/trips/trips.service.spec.ts` et `src/trips/driver-interruption.workflow.spec.ts`,
  **61 tests réussis** : pause/reprise, premiers démarrages, appels répétés et
  concurrents, annulation concurrente, états terminaux et contrôles de conducteur
  et d'interruption. Repositories/services simulés, pas de validation de
  concurrence PostgreSQL réelle. `tsc --noEmit --incremental false -p
  tsconfig.build.json` et `git diff --check` réussis.
- **Mobile associé :** lecture fraîche et unique des conflits connus, sans
  renvoyer automatiquement le démarrage ; affichage de navigation seulement si
  le serveur confirme le bon trajet en cours. Loader voiture/itinéraire partagé
  et accessible. 121 tests mobiles ciblés réussis, aperçu Web seulement.
  Détails dans `docs/DEMARRAGE_TRAJET_ET_CHARGEMENT_NAVIGATION.md` du dépôt mobile.
- **Livraison/limites :** correctif non déployé ; déploiement backend nécessaire
  et code mobile à livrer séparément. Aucune nouvelle migration, dépendance ou
  variable pour ce correctif, aucune donnée modifiée. Les autres changements
  préexistants restent distincts. Recette physique Android/iOS à effectuer ;
  aucun crash natif ou gain de performance déclaré validé.

## 17 octobre 2026 — Tous les conducteurs admissibles à 5 km et rappel de position

- **Périmètre/problème :** les commandes proches étaient proposées à un seul
  conducteur ; le mobile doit envoyer sa position hors course toutes les
  3 minutes et un rappel est demandé après plus de 6 heures sans position.
- **Solution :** dispatch.service.ts, nearby-driver-policy.ts et
  scheduled-request-alert.ts diffusent par lots de 50 à tous les conducteurs
  admissibles à 5 km. Sélection filtrée avant LIMIT, dédoublonnage par destinataire,
  poursuite par le cron existant. Les invitations immédiates verrouillent la
  commande à l'acceptation : premier gagnant, autres invitations annulées.
  trip-requests.service.ts retire le secours non géographique lorsque ce
  dispatch est activé. Les commandes programmées ouvrent toujours les détails.
- **Rappel :** stale-location-reminder.ts et le cron de dispatch.service.ts
  vérifient toutes les 5 minutes les présences de plus de 6 heures, par lots de
  100, sans rappel répété avant une nouvelle position. Outbox et marqueur sont
  transactionnels avec SKIP LOCKED. notifications.service.ts revalide avant
  livraison/réessai ; pas de sonnerie urgente ni de coordonnées dans le rappel.
- **Schéma :** migration 1780000074000-BroadcastDriverRequests.ts enregistrée
  dans migrations/index.ts ; retrait de l'unicité par commande, maintien des
  unicités par conducteur/paire, index de lecture/cron, colonne de rappel.
  Retour arrière refusé si des invitations multiples sont encore pending :
  attendre leur passage effectif au statut expired avec le nouveau worker.
  Déploiement contrôlé nécessaire, migrations non automatiques, verrous DDL
  à surveiller. Aucun changement de base applicative ou de configuration AWS ici.
- **Conservé :** droits/KYC, disponibilité, compatibilité véhicule/places,
  cinq envois urgents simultanés maximum, token courant et livraison hors
  transaction métier, limites de réessai. Fenêtre de position par défaut de
  5 minutes ; un ancien réglage inférieur utilise ce défaut. Suivi en course
  inchangé. Les changements portefeuille préexistants ne font pas partie de ceci.
- **Tests :** 115 réussis dans dispatch-postgres.spec.ts,
  scheduled-request-alert.spec.ts, scheduled-request-delivery.spec.ts,
  trip-request-alert-routing.spec.ts, driver-action-notifications.spec.ts et
  notifications.service.spec.ts. PostgreSQL 18/PostGIS temporaire réel pour
  les lots de 52, la concurrence, les seuils 4 999/5 001 m, le rappel et la
  migration aller/retour. Typage production sans émission réussi.
- **Limites :** push simulés, aucun téléphone réel ni mesure de charge globale.
  APNs/FCM et les tâches mobiles peuvent être retardés. Un rappel nécessite une
  position déjà connue ; rétention historique d'un jour inchangée. Une désactivation
  locale peut encore déclencher un rappel unique côté serveur. Pas de garantie
  de livraison simultanée ou de résolution de crash. Le mobile associé comporte
  81 tests GPS/navigation réussis et sa documentation détaillée dans
  docs/ALERTES_PROXIMITE_LOCALISATION.md du dépôt zwanga.

## 15 octobre 2026 — Réception interrompue du profil : diagnostic HTTP fiable

- **Problème constaté :** une interruption de `PUT /users/me` était journalisée
  comme une erreur serveur 500 par `LoggingInterceptor`, alors que le filtre
  global connaissait déjà certaines erreurs de réception. Cet événement isolé
  ne démontre pas la cause des fermetures Android après connexion.
- **Solution appliquée :** `src/common/http-request-abort.ts` centralise la
  reconnaissance de ces interruptions, y compris `ECONNRESET` + `aborted`.
  `src/common/interceptors/logging.interceptor.ts` laisse le filtre produire
  l'avertissement regroupé, sans doublon ni faux 500. Les statuts HTTP 4xx
  identifiés sont des avertissements ; les 5xx restent des erreurs. Les erreurs
  non standard ne font plus échouer le logger lors de leur lecture.
  `src/common/filters/api-exception.filter.ts` utilise le même classificateur.
- **Comportements conservés :** message français `REQUEST_ABORTED`/400 si la
  réponse est encore possible, absence de réponse sur connexion fermée,
  authentification, droits, validation et limites d'images, arrêt avant le
  gestionnaire métier en cas de multipart incomplet. Un `ECONNRESET` générique
  d'un service externe n'est pas assimilé à une réception interrompue. Aucun
  changement de schéma, de dépendance, de délai serveur ou de configuration AWS.
- **Tests :** `logging.interceptor.spec.ts`, `api-exception.filter.spec.ts`,
  `profile-upload-abort.spec.ts` et `auth/session-error.spec.ts` : **34 tests
  réussis**. Le test multipart ouvre un vrai serveur Nest HTTP local, envoie
  des données synthétiques incomplètes et coupe le client ; le gestionnaire ne
  s'exécute pas. Un envoi complet suivant réussit. Ni compte réel ni DB utilisés.
- **Vérifications :** `tsc -p tsconfig.build.json --noEmit --incremental false`
  et `git diff --check` réussis. `tsc` incluant toutes les specs reste en échec
  dans des tests hors périmètre non modifiés ; ne pas assimiler le build valide
  à une suite globale de tests entièrement validée.
- **Livraison et limites :** code prêt à intégrer au déploiement habituel, pas
  encore déployé ici. Aucune migration ou nouvelle variable requise. La correction
  supprime le diagnostic erroné, elle ne répare pas une connexion interrompue et
  ne démontre pas la résolution du crash natif Android. Le client mobile reçoit
  séparément un budget d'envoi du profil de 60 s, une session à propriétaire
  unique et des rapports de diagnostic complémentaires.
