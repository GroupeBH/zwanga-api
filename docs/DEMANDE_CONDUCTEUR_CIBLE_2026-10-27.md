# Demande adressée à un conducteur — 27 octobre 2026

## Périmètre et problème

Le formulaire diffusait uniquement une demande aux conducteurs éligibles. Il ne
permettait pas au passager de choisir un conducteur proche ou de retrouver un
conducteur connu. L'utilisateur a demandé les deux possibilités, sans bouleverser
la création de commande existante.

## Solution appliquée

- Option **Choisir un conducteur** dans l'étape existante « Heure et prix ».
  La sélection est facultative. Sans sélection, le payload et la diffusion
  habituelle restent inchangés.
- Sélecteur avec deux onglets : conducteurs autour du départ (5 km) et recherche
  par nom ou identifiant de compte. La recherche d'un conducteur connu peut
  dépasser les 5 km ; la distance approximative est affichée avant le choix.
- Le serveur ne propose que les conducteurs éligibles : compte actif, dernier KYC
  approuvé, notifications enregistrées, position utilisable, véhicule compatible,
  capacité suffisante et absence de prise en charge concurrente. Un nom connu ne
  garantit donc pas un résultat. Aucun téléphone, jeton push ou point GPS exact
  n'est exposé dans cette liste.
- La sélection est une restriction d'audience, pas une attribution automatique.
  Seul le conducteur choisi reçoit la demande et peut y répondre. Les validations
  et le fonctionnement de l'acceptation existants sont conservés.
- Le ticket passager indique le destinataire et son refus explicite, lorsqu'il
  existe. **Envoyer aux conducteurs proches** élargit la même commande uniquement
  sur action du passager. Aucun élargissement automatique après refus ou silence.
  Une invitation encore en attente du conducteur choisi reste valide ; le premier
  conducteur qui accepte obtient la course. Les refus déjà enregistrés restent
  respectés. Une commande attribuée, expirée ou annulée ne peut plus être élargie.

## Fichiers et protections

Mobile : `components/trip-request/RequestDriverPicker.tsx`, `app/request/index.tsx`,
`store/api/requestDriverApi.ts`, `store/api/trip-request/{contracts,serverTypes,requestMapper}.ts`,
`types/tripRequests.ts`, `store/slices/requestDraftsSlice.ts`,
`hooks/trip-request/{useRequestDraft,useRequestSubmission,useRequestTripController}.ts`,
`features/trip-request/recoverRequest.ts`,
`features/request-detail/{RequestTargetDriver,RequestPassengerTicket,RequestDriverDecision}.tsx`.

La liste est bornée à 20 résultats. Recherche différée de 350 ms, requêtes RTK Query
uniquement lorsque le sélecteur est visible, au premier plan et connecté ; pas de
nouveau polling. Aucun résultat de l'ancien argument n'est proposé pendant une
recherche différente. Brouillon isolé par formulaire et effacé à sa fermeture ou
à la déconnexion. Après changement du type de véhicule, une sélection incompatible
bloque l'envoi et demande un nouveau choix, sans transformer la demande en diffusion
générale. La récupération après timeout compare aussi le conducteur ciblé.

Backend voisin : `src/trip-requests/driver-choices.ts`, `target-driver-policy.ts`,
`dto/driver-choice.dto.ts`, DTO de création, entité `TripRequest`, contrôleur/service,
`request-pages.ts`, `request-refusal.ts`, `request-edit-policy.ts`, récupération de
commande, offres de trajet partagé et `src/trips/save-request-trip.ts` ; filtrage
dans le dispatch immédiat/programmé/partagé et lors de la remise des notifications.
Les accès directs, offres et acceptations recontrôlent l'audience. L'élargissement
verrouille la commande et vérifie également les trajets/offres déjà attribués.

Migration `1780000096000-TargetTripRequestDriver` : colonne UUID nullable,
clé étrangère et index partiel. Les commandes existantes restent non ciblées.
Suppression du conducteur restreinte afin de ne pas transformer une demande privée
en demande publique. Rollback refusé tant qu'une commande contient un destinataire.
Migration enregistrée dans `src/database/migrations/index.ts`.

## Vérifications réalisées

- Mobile : **65 tests JavaScript réussis**, couvrant formulaire, choix du conducteur,
  sélection différée, réseau indisponible, changement de véhicule, doubles appuis,
  récupération après timeout, adresses, horaires et refus. TypeScript sans émission
  réussi. Rendu React simulé : ce n'est pas un essai graphique sur téléphone.
- Backend : **192 tests réussis dans 11 suites**, incluant PostgreSQL 18/PostGIS
  et PostgreSQL 17 jetables. Fournisseurs push simulés, aucun utilisateur réel.
  Les essais ont détecté une erreur d'alias TypeORM dans le nouveau prédicat SQL ;
  expression corrigée et vérifiée par les tests de listes et de confidentialité.
- Complément final : **18 tests réussis** dans 2 suites (dont 6 scénarios déjà
  comptés ci-dessus ; 74 tests hors filtre non rejoués). Création réelle via le
  service, sélection exclusive, élargissement conservant l'invitation initiale,
  acceptation et annulation des invitations concurrentes, validation des paramètres
  de recherche et refus des identifiants invalides. Total : **204 cas backend
  distincts vérifiés**, pas une campagne exhaustive de tout le projet.
- Compilation NestJS, TypeScript mobile, ESLint ciblé sans erreur, frontière réseau
  RTK Query et contrôle de taille réussis (**1 207 sources, aucune au-dessus de
  400 lignes**). `git diff --check` sans erreur d'espacement. Node temporaire
  24.22.1 pour la compilation et les tests.

## Mise en service et limites

Préparer/appliquer la migration puis mettre à jour **toutes** les instances backend
et workers avant de distribuer le mobile permettant le ciblage. Un ancien worker
ne connaît pas cette restriction d'audience. Aucun déploiement ni modification de
la base de production n'a été effectué pendant cette intervention.

Aucun changement natif ni dépendance ajouté. Aucun essai physique Android/iOS ni
envoi réel FCM/APNs pour cette fonctionnalité : les tests ne certifient pas la
réception de sonnerie sur un téléphone ni le rendu sur toutes les tailles d'écran.
La disponibilité peut changer entre sélection et envoi : le serveur revalide le
conducteur et affiche une erreur si nécessaire. Le refus est actualisé par la
lecture de détail existante ; aucune nouvelle notification passager de refus
n'a été ajoutée dans ce périmètre.
