# Cohérence du profil conducteur

Identifiant changement : `KYC-DRIVER-001`  
Date : 3 septembre 2026  
Périmètre : inscription, profil utilisateur, KYC Didit/legacy, véhicules, trajets et retraits conducteur

## Problème corrigé

Zwanga conservait deux indicateurs pour représenter le même choix métier :

- `users.role`, avec notamment `driver` ou `passenger` ;
- `users.isDriver`, booléen historique utilisé par certaines réponses API et
  par l'application mobile.

Certains flux pouvaient sauvegarder des valeurs contradictoires :

- `role = driver` avec `isDriver = false` ;
- `role = passenger` avec `isDriver = true` ;
- compte public possédant un véhicule actif mais restant `passenger`.

Ce mélange pouvait produire un refus côté app ou API alors que le KYC et les
véhicules semblaient corrects.

## Règle métier retenue

Pour les comptes publics :

- conducteur = `role = driver` et `isDriver = true` ;
- passager = `role = passenger` et `isDriver = false`.

Pour les comptes administrateurs :

- `role = admin` ou `super_admin` ;
- `isDriver = false`.

Un véhicule actif enregistré depuis l'application est considéré comme une
intention conducteur et aligne le profil sur `driver`.

## Modifications backend

### Politique commune

`src/users/user-role.policy.ts` expose maintenant deux fonctions :

- `resolveSelfServiceDriverState` : normalise les entrées d'inscription mobile ;
- `normalizeUserDriverFlags` : répare un objet utilisateur avant sauvegarde.

### Inscription téléphone, Google et Apple

Les flux acceptent encore les anciennes charges utiles mobiles qui envoient
`isDriver` et `role` séparément, mais le backend ne persiste plus de
contradiction.

Exemples :

| Entrée reçue                       | Valeur persistée                   |
| ---------------------------------- | ---------------------------------- |
| `role=driver`, `isDriver=false`    | `role=driver`, `isDriver=true`     |
| `role=passenger`, `isDriver=true`  | `role=driver`, `isDriver=true`     |
| `role=passenger`, véhicule présent | `role=driver`, `isDriver=true`     |
| `role=passenger`, pas de véhicule  | `role=passenger`, `isDriver=false` |

### Création/réactivation de véhicule

Lorsqu'un compte public crée ou réactive un véhicule, le propriétaire est aligné
sur `role=driver` et `isDriver=true`.

Les comptes `admin` et `super_admin` ne peuvent pas enregistrer de véhicule via
le flux self-service `/vehicles`.

### Synchronisation KYC Didit et upload KYC legacy

Quand un dossier KYC est traité, le backend réaligne aussi les indicateurs
conducteur :

- si l'utilisateur a déjà une intention conducteur ou un véhicule actif, le
  profil reste conducteur ;
- si Didit approuve, `users.status` passe à `active` sauf compte suspendu ;
- si Didit reste `pending` ou `rejected`, le compte reste `pending_kyc`, mais
  l'intention conducteur n'est plus perdue.

## Migration base de données

Migration : `1780000028000-EnforceUserDriverRoleConsistency`

Elle corrige les données existantes puis ajoute la contrainte :

`CHK_users_role_is_driver_consistency`

Cette contrainte interdit de nouvelles contradictions entre `role` et
`isDriver`.

La migration ne change pas les statuts KYC, ne valide pas un KYC à la place de
Didit et ne rend pas actif un utilisateur suspendu.

## Impact financier

Aucun prix, solde, commission ou jeton n'est recalculé.

L'impact financier est indirect mais important : les retraits et revenus
conducteur dépendent d'un profil conducteur/KYC cohérent. Cette correction évite
qu'un conducteur approuvé soit bloqué simplement parce que `isDriver` et `role`
se contredisent.

## Vérifications attendues

Après migration et déploiement :

1. aucun utilisateur ne doit vérifier la condition :
   `role = 'driver' AND isDriver = false` ;
2. aucun utilisateur ne doit vérifier la condition :
   `role <> 'driver' AND isDriver = true` ;
3. un conducteur Didit approuvé avec véhicule actif doit retourner :
   `role=driver`, `isDriver=true`, `status=active` ;
4. un conducteur Didit non terminé doit retourner :
   `role=driver`, `isDriver=true`, `status=pending_kyc` ;
5. un admin doit toujours retourner `isDriver=false`.
