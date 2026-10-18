# Correctifs backend liés à l’audit mobile — 18 octobre 2026

## Périmètre

Préparation autorisée des correctifs de pagination des commandes et de protection
des transferts rejoués. Code, tests et migration seulement : aucun déploiement,
aucune exécution sur la base, aucun changement de secrets, AWS ou configuration.
Les autres modifications présentes dans le dépôt sont conservées.

## Pagination

Problème : les écrans de listes mobiles téléchargeaient les commandes complètes.
Trois nouveaux endpoints authentifiés sont disponibles :

- `GET /trip-requests/pages/available` : commandes publiques encore disponibles,
  pour les conducteurs autorisés ; exclut les commandes immédiates distribuées par
  le dispatch, les commandes personnelles, expirées ou déjà attribuées.
- `GET /trip-requests/pages/my-requests` : historique du compte authentifié.
- `GET /trip-requests/pages/my-offers` : offres du conducteur authentifié.

`limit` est limité à 100 (le mobile demande 20). Le curseur contient le contexte,
la recherche, une borne de création et le timestamp PostgreSQL à la microseconde.
La sélection des identifiants précède l’hydratation des relations. Une seconde
vérification après lecture exclut une commande acceptée entre les deux étapes,
sans perdre la possibilité d’avancer si la page devient vide. Le total est
indicatif pendant des mutations concurrentes, pas un instantané transactionnel.

La recherche est insensible aux accents français et à l’ordre des mots, inclut
les références d’adresses et noms des participants. Les valeurs sont paramétrées,
avec échappement des caractères LIKE, sans concaténation du texte utilisateur.
Les anciennes routes tableau restent inchangées pour les versions distribuées.
La proximité reste un classement mobile **au sein de la page**, non un classement
géographique global garanti par ces endpoints.

Fichiers : `src/trip-requests/request-pages.ts`, `trip-requests.service.ts`,
`trip-requests.controller.ts`, `src/common/history-page.ts` ; tests associés dans
`request-pages.spec.ts` et `history-page.spec.ts`.

## Transferts de jetons

Problème : une perte de réponse HTTP pouvait pousser le mobile à refaire un débit.
Le DTO accepte désormais `idempotencyKey`, UUID v4 optionnel pour la compatibilité.
Le service dérive un identifiant stable à partir du compte authentifié et de cette
clé, puis recherche les écritures **après** acquisition des verrous ordonnés des
comptes émetteur/destinataire. Un rejeu identique retourne le transfert déjà inscrit
sans refaire les mouvements, même si le solde restant ne permettrait pas un
deuxième débit. Changer montant, destinataire ou note avec la même clé est refusé.

Les règles de solde, origine des jetons, parts retirables, autorisation et atomicité
de la transaction existante sont conservées. Les anciennes applications sans clé
continuent à créer une opération distincte à chaque requête. La protection doit
donc être utilisée conjointement avec le nouveau mobile, qui persiste la référence
avant l’envoi et la conserve après un résultat ambigu. Ne pas contourner ce mécanisme
en effaçant les données de l’application.

Fichiers : `src/wallet/transfer-idempotency.ts`, `wallet.service.ts`,
`dto/wallet.dto.ts`, `entities/wallet-ledger-entry.entity.ts` ; tests dans
`transfer-idempotency.spec.ts` et `wallet.service.spec.ts`.

## Migration préparée, non exécutée

`src/database/migrations/1780000075000-IndexRequestsAndTransfers.ts`, enregistrée
dans `src/database/migrations/index.ts`, ajoute :

- index commandes par propriétaire/date/identifiant ;
- index partiel des commandes ouvertes ;
- index des offres par conducteur/date/identifiant ;
- unicité de `(relatedEntityId, type)` pour les deux directions des transferts.

Création et rollback sont transactionnels : attente de verrou limitée à 5 secondes,
durée par instruction à 30 secondes. Les réglages antérieurs sont restaurés après
succès ; seule une transaction créée par cette migration est validée/annulée ici.
Les index sont créés de façon classique, pas `CONCURRENTLY` : une fenêtre adaptée
et un essai de durée sur une base jetable sont nécessaires. Un timeout arrête la
migration, il ne supprime pas la protection. Le rollback ne supprime aucune donnée.
Des doublons comptables préexistants feraient échouer l’index unique ; les examiner
par la procédure d’exploitation, ne jamais les effacer automatiquement.

## Vérifications et limites

- Compilation TypeScript backend sans émission réussie.
- **64 tests réussis**, six suites ciblées : `wallet/transfer-idempotency.spec.ts`,
  `wallet/wallet.service.spec.ts`, `trip-requests/request-pages.spec.ts`,
  `trip-requests/trip-requests.controller.spec.ts`, `common/history-page.spec.ts`,
  `database/request-transfer-migration.spec.ts`.
- Repositories, transactions et DDL simulés : pas de validation de concurrence
  PostgreSQL réelle ni de gain SQL chiffré. Le skill PostgreSQL a guidé les curseurs,
  index et verrous ; aucune augmentation du pool ni optimisation spéculative ajoutée.
- L’accueil, la recherche globale et les compteurs mobiles n’utilisent pas encore
  tous ces endpoints. Leur migration nécessite des lectures de proximité/activité
  et des agrégats dédiés ; tronquer leurs anciennes réponses masquerait des actions.
- Les relations d’offres d’une commande très sollicitée ne sont pas paginées ici.
- Aucun test mobile physique, de provider KYC ou de transfert réel. Les mesures de
  charge décrites ailleurs dans le dépôt ne sont pas celles de ces modifications.

## Livraison

Backend compatible et migration avant le nouveau mobile. Examiner **toutes** les
migrations en attente : ce dépôt contient d’autres changements indépendants. Sur
une base jetable, tester les pages concurrentes et les doubles transferts sous
deux connexions PostgreSQL, avec perte de réponse puis reprise. Aucun lancement de
migration, déploiement ou bascule de trafic n’est autorisé par cette préparation.
