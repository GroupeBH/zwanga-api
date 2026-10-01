# Profil et parcours conducteur — 29–30 septembre 2026

`GET /users/me` conserve `user` et `stats` et ajoute `profileState` version 1.
Le bloc appartient au `userId` indiqué. Il expose un statut d'identité et un
état conducteur comprenant `status`, `nextAction`, `canPublish`,
`activeVehicleCount` et `requested`. Aucune clé ni URL de document dans ce bloc.

Le client affiche la prochaine action ; il ne déduit pas l'activation à partir
du nombre total de véhicules ou d'un booléen local. Les véhicules inactifs ou
appartenant à un autre compte ne remplissent pas les prérequis. L'identité est
le dernier document par création puis identifiant décroissants, comme le
contrôle de publication. Didit « Not Started » reste une étape à commencer.

| Situation | Action |
| --- | --- |
| Passager sans demande conducteur | `start` |
| Identité absente, non commencée ou rejetée | `verify_identity` |
| Identité en cours/approuvée, aucun véhicule actif | `add_vehicle` |
| Identité en cours et véhicule actif | `wait` |
| Prérequis réunis, activation non encore confirmée | `activate` |
| Conducteur autorisé à publier | `none` |
| Compte suspendu/inactif ou rôle protégé | `contact_support` |

L'ajout du véhicule est possible pendant l'examen de l'identité. Les réponses
de `POST /users/driver-onboarding` et `POST /users/driver-activation` restent
compatibles : après succès, le client relit le profil avant de choisir une étape.
Un GET ne modifie aucun rôle. Les activations existantes après KYC/ajout de
véhicule restent en place. Les autorisations serveur sont revérifiées lors des
opérations ; `canPublish` est un état d'affichage, pas un jeton d'autorisation.

Déployer le backend avant le client utilisant ce contrat. Aucun changement
de schéma, migration, modification massive de comptes ni déploiement réalisé
par cette intervention. Les tests ajoutés sont des tests unitaires avec dépôts
simulés ; la livraison native et la base réelle nécessitent une validation
séparée. Le journal détaillé de l'intervention est dans le dépôt mobile,
`docs/CHANGEMENTS_TECHNIQUES.md`.

## Vérifications locales

Les quatre suites ciblées `profile-state`, `driver-activation`,
`didit-kyc.service` et `users.service.otp` passent : 63 tests Jest,
avec dépôts et fournisseur simulés (pas de message réel envoyé).
Le contrôle TypeScript de production (`tsconfig.build.json`, sans émission)
passe. Le contrôle global incluant toutes les spécifications signale encore
14 erreurs dans des fichiers de tests non modifiés par cette intervention.
Ni la base réelle, ni le fournisseur Didit en production, ni un appareil
physique n'ont été validés. Aucun gain de performance SQL n'est mesuré.
