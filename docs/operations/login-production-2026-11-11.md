# Connexions refusées en production — 11 novembre 2026

## Périmètre et autorisation

Diagnostic demandé après des refus de connexion entre 13 h 30 et 13 h 49,
heure de Kinshasa. Terminaisons communiquées : `710` et `654`.
Le retour arrière demandé brièvement a été annulé avant toute modification ECS.
L'utilisateur a autorisé une seule tâche Fargate temporaire de diagnostic ;
aucune réparation des comptes n'a été autorisée ou exécutée.

## Vérifications

- Service `zwanga-api-production-api`, région `eu-central-1` : révision `:41`,
  déploiement `ecs-svc/0514834474596465583` terminé, une tâche saine.
- Image active : `sha256:48a94e06021c5bd8b14e0280b0dd3a3c96f26d8de53fe3541c63e0ae8463b01d`,
  étiquetée avec le commit `31f9009154be60ce2f7eb3728fb09725dc8ce6cd`.
  Les fichiers d'authentification de ce commit ont été vérifiés dans GitHub.
- Healthcheck HTTP 200, PostgreSQL et Redis disponibles.
- Lecture complète et bornée des logs de login sur le créneau : 11 messages
  `Login failed: account not found`, entre 13:36:13 et 13:48:45, associés à
  `/auth/login`. Aucun numéro n'est présent dans ces messages : on ne peut pas
  attribuer individuellement ces onze tentatives à un compte.
- La recherche de connexion exige exactement un compte pour un numéro canonique.
  Une collision historique renvoie donc le même résultat qu'un compte absent,
  **avant la comparaison du PIN**. La recherche inclut les comptes désactivés.

## Tâche temporaire

- ID : `e4f0c88284a843d38b49254c336ce93e`.
- Même image `:41`, même réseau ; aucun démarrage NestJS, migration ou envoi SMS.
- Début ECS : 13:56:30 ; arrêt : 13:57:07, heure de Kinshasa.
- État final `STOPPED`, sortie `api=0`, collecteur `0`.
- Une connexion PostgreSQL, TLS vérifié, lecture seule par défaut et transaction
  `REPEATABLE READ READ ONLY`, délai SQL 8 s, délai global du script 45 s.
- Contrôle retourné : `transaction_read_only=on`, fonction de normalisation et
  table de réservation présentes ; transaction terminée par `ROLLBACK`.
- Aucun nom, UUID utilisateur, téléphone complet, PIN, hash de mot de passe,
  jeton ou solde n'a été sélectionné ou exporté.
- Scripts : `phone-login-diagnostic-2026-11-11.cjs` et son lanceur adjacent.
  Ne pas les relancer sans une nouvelle autorisation : ils ciblent un diagnostic
  ponctuel, pas une tâche planifiée. Le jeton d'idempotence évite une relance
  accidentelle immédiate, mais ne constitue pas une garantie perpétuelle.

## Résultat anonymisé

Neuf numéros distincts correspondent aux suffixes fournis, résultat non tronqué.

| Suffixe | Numéros distincts correspondants | Groupe en conflit | Comptes de ce groupe |
| --- | ---: | ---: | --- |
| 654 | 4 | 1 numéro, 3 comptes | Conducteur actif au format local ; deux passagers `pending_kyc`, au format international avec `+` et sous une autre écriture |
| 710 | 5 | 1 numéro, 3 comptes | Administrateur actif sous une autre écriture ; conducteur actif au format local ; conducteur `pending_kyc` au format international avec `+` |

Pour ces deux groupes, les trois comptes ont `isActive=true`, la réservation
de numéro existe avec un propriétaire NULL (`reserved_for_review=true`) et la
condition d'unicité de connexion est fausse. Les sept autres numéros trouvés
sont chacun associés à un seul compte et ne présentent pas cette ambiguïté.

Le blocage par doublon est **confirmé pour ces deux groupes**, mais trois chiffres
ne suffisent pas à confirmer que ce sont les deux comptes que l'utilisateur avait
en tête. Le message générique « identifiants incorrects » n'établit pas une erreur
de PIN. L'état `pending_kyc` seul n'est pas la cause : cette méthode de connexion
rejette les états `inactive`/`suspended` et `isActive=false`, pas `pending_kyc`.

## Suite sûre, non exécutée

1. Identifier précisément les comptes dans l'administration par UUID ou fiche
   utilisateur ; ne pas choisir sur les trois derniers chiffres seulement.
2. Faire vérifier le titulaire et décider explicitement quel compte conserve ce
   numéro. Le groupe 710 comprenant un administrateur, ne pas fusionner les rôles.
3. Préparer une correction transactionnelle, journalisée, avec sauvegarde et
   contrôles préalables, dissociant les autres comptes de ce numéro et mettant à
   jour sa réservation. Conserver les UUID et tous les historiques financiers ;
   aucune fusion de solde ou suppression automatique de compte.
4. Dans la révision `:41` diagnostiquée, une simple désactivation ne suffit pas :
   la recherche compte aussi les comptes désactivés. Un correctif local demandé
   ensuite le 11 novembre exclut `isActive=false` et `status=inactive` des
   recherches d'authentification ; après son déploiement, il devra rester un seul
   compte non désactivé. Les réservations d'inscription restent inchangées. Ne
   pas choisir arbitrairement un titulaire ni lancer un reset de PIN pour
   départager plusieurs comptes non désactivés.
5. Tester la connexion sur le compte retenu et vérifier les sessions après une
   intervention autorisée. Aucun succès de login réel n'a été testé ici.

La production et ses données restent inchangées, à l'exception de la tâche
temporaire autorisée et de ses journaux techniques. Son arrêt a été vérifié.
