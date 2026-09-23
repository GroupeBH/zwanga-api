# Contrôle d'accès financier du back-office

Identifiant : `FIN-ADMIN-RBAC-001`  
Date : 31 août 2026  
Dernière mise à jour : 1 septembre 2026  
Statut : implémenté, migrations de rôle/sécurité et déploiement backend/web requis

## Besoin métier

Zwanga doit permettre la création d'un super administrateur et de trois
administrateurs en production sans donner à tous les opérateurs le pouvoir de
modifier ou rapprocher des valeurs financières. Les administrateurs doivent
pouvoir consulter et exploiter le back-office. Le super administrateur garde la
responsabilité des actions qui peuvent modifier un solde, confirmer un retrait
ou relancer un rapprochement fournisseur.

## Comportement avant la modification

Le rôle applicatif disponible pour le back-office était uniquement `admin`.
Toutes les routes protégées par `@Roles(UserRole.ADMIN)` avaient le même niveau
d'autorisation. Le web admin validait également uniquement la valeur `admin`.

Conséquence : il n'existait pas de séparation native entre exploitation
quotidienne et opérations financières sensibles.

## Comportement après la modification

- `UserRole.SUPER_ADMIN = "super_admin"` est ajouté au modèle utilisateur.
- `super_admin` possède tous les droits de lecture et d'exploitation d'un
  `admin`.
- `admin` ne possède pas les droits réservés à `super_admin`.
- Le login web utilise `/auth/admin/login` et refuse les rôles
  `driver`/`passenger`.
- `zwanga-admin` accepte `admin` et `super_admin`, affiche le rôle réel du
  compte connecté et verrouille les actions financières sensibles pour un admin
  simple.
- Le provisioning CLI permet de choisir `--role admin` ou
  `--role super_admin` en secours opérationnel.
- Le premier `super_admin` peut être créé par un bootstrap OTP limité à un
  numéro autorisé et protégé par une clé de bootstrap.
- Un `super_admin` peut créer les comptes `admin` depuis l'interface
  `zwanga-admin`.
- Si le numéro saisi existe déjà sur un compte public `driver` ou `passenger`,
  ce compte est converti en `admin` plutôt qu'un doublon soit créé.
- Les comptes créés avec un mot de passe temporaire ont
  `passwordChangeRequired = true` et doivent changer leur mot de passe avant
  d'utiliser les routes admin protégées par rôle.

## Matrice d'autorisation financière

| Fonction | `admin` | `super_admin` | Effet financier |
| --- | --- | --- | --- |
| Consulter paiements, portefeuilles, registre, parrainage | Oui | Oui | Lecture seule |
| Export CSV des vues financières | Oui | Oui | Lecture seule |
| Ajuster un solde de jetons | Non | Oui | Crédit/débit de jetons avec registre audité |
| Rapprocher un retrait de parrainage FlexPay | Non | Oui | Peut faire évoluer le statut d'un retrait selon FlexPay |
| Rapprocher une transaction FlexPay admin | Non dans l'interface | Oui si le contrat backend dédié est disponible | Peut confirmer un état fournisseur |

## Contrats HTTP

### Login back-office

```http
POST /api/v1/auth/admin/login
Content-Type: application/json

{
  "phone": "+243900000000",
  "password": "MotDePasseAdmin"
}
```

Réponse :

```json
{
  "accessToken": "<jwt>",
  "refreshToken": "<jwt-refresh>",
  "passwordChangeRequired": false
}
```

Un compte mobile reçoit `401`, même avec un PIN correct. La réinitialisation
libre-service par `newPin` est refusée pour `admin` et `super_admin`.

### Changement obligatoire du mot de passe admin

```http
POST /api/v1/auth/admin/password/change
Authorization: Bearer <jwt-admin-ou-super-admin>
Content-Type: application/json

{
  "currentPassword": "MotDePasseTemporaire",
  "newPassword": "NouveauMotDePasseFort"
}
```

Cette route est volontairement accessible avec un simple JWT authentifié, sans
`@Roles`, pour qu'un administrateur temporairement bloqué par
`passwordChangeRequired` puisse remplacer son mot de passe. Le service vérifie
tout de même que le compte est `admin` ou `super_admin`.

### Bootstrap du premier super administrateur

```http
POST /api/v1/auth/admin/bootstrap/send-otp
x-admin-bootstrap-secret: <secret>
Content-Type: application/json

{
  "phone": "+243831919710"
}
```

```http
POST /api/v1/auth/admin/bootstrap/confirm
x-admin-bootstrap-secret: <secret>
Content-Type: application/json

{
  "phone": "+243831919710",
  "otp": "123456"
}
```

Le backend accepte uniquement le numéro configuré par
`ADMIN_BOOTSTRAP_PHONE`. La création est protégée par un verrou transactionnel
PostgreSQL et refuse toute deuxième création dès qu'un `super_admin` existe.

### Gestion des comptes back-office

```http
GET /api/v1/admin/accounts?page=1&limit=25
Authorization: Bearer <jwt-super-admin>
```

```http
POST /api/v1/admin/accounts
Authorization: Bearer <jwt-super-admin>
Content-Type: application/json

{
  "phone": "+243900000000",
  "firstName": "Alice",
  "lastName": "Admin",
  "defaultPassword": "Temporaire-2026!"
}
```

Ces routes sont réservées au `super_admin`. Elles créent ou promeuvent des
comptes `admin` opérationnels, avec mot de passe temporaire à changer.

Si le numéro appartient déjà à un compte `driver` ou `passenger`, la promotion :

- remplace le rôle par `admin` ;
- met `isDriver = false` ;
- active le compte ;
- remplace le secret de connexion par le mot de passe temporaire ;
- invalide les anciens tokens applicatifs et le token push ;
- conserve l'historique, les paiements, les écritures de jetons, les trajets et
  les réservations pour audit.

Si le numéro appartient déjà à un compte `admin` ou `super_admin`, la requête
est refusée afin de ne pas réinitialiser un compte privilégié par erreur.

### Actions financières sensibles

```http
POST /api/v1/admin/wallets/:userId/adjustments
Authorization: Bearer <jwt-super-admin>
```

```http
POST /api/v1/admin/referrals/withdrawals/:withdrawalId/reconcile
Authorization: Bearer <jwt-super-admin>
```

Ces routes sont protégées par `@Roles(UserRole.SUPER_ADMIN)` et contrôlées une
deuxième fois dans les services métier.

## Schéma et migration

La migration `1780000025000-AddSuperAdminRole.ts` ajoute la valeur
`super_admin` à l'énumération PostgreSQL `users_role_enum`.

La migration `1780000026000-AddAdminPasswordChangeRequired.ts` ajoute la colonne
`passwordChangeRequired` sur `users` avec la valeur par défaut `false`.

Ces migrations ne créent aucun utilisateur, ne modifient aucun solde et ne
changent aucun paiement. La promotion d'un compte existant se produit uniquement
lors d'une action volontaire de bootstrap ou de création admin par
`super_admin`, jamais pendant la migration.

Le retour arrière est refusé si au moins un utilisateur possède déjà le rôle
`super_admin`, afin de ne pas rendre les données incompatibles avec
l'énumération précédente.

## Fichiers modifiés

### Backend

- `src/users/entities/user.entity.ts`
- `src/users/user-role.policy.ts`
- `src/common/guards/roles.guard.ts`
- `src/auth/auth.controller.ts`
- `src/auth/auth.service.ts`
- `src/admin/admin.service.ts`
- `src/admin/admin-referrals.service.ts`
- `src/admin/admin.controller.ts`
- `src/wallet/wallet.service.ts`
- `src/support/support.service.ts`
- `src/safety/safety.service.ts`
- `src/chat/chat.service.ts`
- `src/admin/admin-account.provisioning.ts`
- `src/admin/dto/admin-account.dto.ts`
- `src/database/create-admin.ts`
- `src/database/migrations/1780000025000-AddSuperAdminRole.ts`
- `src/database/migrations/1780000026000-AddAdminPasswordChangeRequired.ts`
- `src/database/migrations/index.ts`

### Administration web

- `lib/features/admin/types.ts`
- `lib/features/auth/adminRoles.ts`
- `lib/features/api/baseApi.ts`
- `lib/features/auth/authApi.ts`
- `lib/features/users/usersApi.ts`
- `lib/utils/cookies.ts`
- `app/login/page.tsx`
- `app/components/auth/AuthGuard.tsx`
- `app/components/admin/Topbar.tsx`
- `app/(admin)/settings/page.tsx`
- `app/(admin)/payments/page.tsx`
- `app/(admin)/tokens/page.tsx`
- `app/(admin)/referrals/page.tsx`

## Idempotence et concurrence

Cette modification ne change pas les formules financières existantes. Les
garde-fous transactionnels restent ceux des lots concernés :

- ajustement de jetons : UUID `requestId`, verrou pessimiste du portefeuille et
  registre append-only ;
- retrait de parrainage : rapprochement via le service FlexPay existant et
  transition idempotente ;
- login : génération de tokens sans écriture financière.

## Déploiement

1. Déployer la migration `1780000025000-AddSuperAdminRole.ts`.
2. Déployer le backend contenant `/auth/admin/login` et la hiérarchie de rôles.
3. Déployer `zwanga-admin`.
4. Ajouter `ADMIN_BOOTSTRAP_SECRET`, `ADMIN_BOOTSTRAP_PHONE`,
   `ADMIN_BOOTSTRAP_FIRST_NAME`, `ADMIN_BOOTSTRAP_LAST_NAME` et
   `ADMIN_BOOTSTRAP_DEFAULT_PASSWORD` dans l'environnement de production.
5. Créer le premier `super_admin` avec OTP, puis changer son mot de passe.
6. Créer les trois comptes `admin` depuis `/settings`.
7. Tester un login `admin`, un login `super_admin` et un refus de login avec un
   compte passager/conducteur.
8. Vérifier que l'admin simple voit les pages Finance en lecture seule pour les
   actions sensibles.
9. Vérifier que le super administrateur peut effectuer uniquement les opérations
   financières prévues et que les écritures restent auditables.

## Rapprochement après déploiement

Contrôler les rôles back-office :

```sql
SELECT role, count(*)
FROM users
WHERE role IN ('admin', 'super_admin')
GROUP BY role
ORDER BY role;
```

Le résultat attendu après provisioning initial est :

- `admin` : 3 ;
- `super_admin` : 1.

Vérifier qu'aucun compte utilisateur mobile n'a reçu un rôle privilégié par un
flux public :

```sql
SELECT id, phone, role, "createdAt"
FROM users
WHERE role IN ('admin', 'super_admin')
ORDER BY "createdAt" DESC;
```

## Retour arrière

Avant la création du premier `super_admin`, la migration peut être annulée.
Après création d'un `super_admin`, le retour arrière sûr consiste à redéployer
une version qui n'expose pas les actions réservées, puis à décider explicitement
du devenir du compte. La suppression directe de la valeur enum est refusée par
la migration si des lignes l'utilisent.
