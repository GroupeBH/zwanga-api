# Création sécurisée des comptes back-office

Ce document décrit le flux de création des comptes qui donnent accès à
`zwanga-admin`. Il concerne une zone sensible parce que ces comptes peuvent
consulter des données financières, et le `super_admin` peut déclencher des
actions qui modifient des soldes ou rapprochent des retraits.

Le flux recommandé est désormais :

1. créer une seule fois le premier `super_admin` avec OTP et clé de bootstrap ;
2. obliger ce `super_admin` à changer son mot de passe temporaire ;
3. créer les trois comptes `admin` depuis l'interface `zwanga-admin` ;
4. obliger chaque `admin` à changer son mot de passe temporaire à la première
   connexion.

## Rôles disponibles

- `admin` : accès opérationnel au back-office, lecture des données financières,
  gestion KYC, utilisateurs, trajets, réservations et support.
- `super_admin` : mêmes droits que `admin`, plus les actions financières
  sensibles : ajustement manuel des jetons, rapprochement de retraits et
  rapprochements FlexPay réservés au contrôle financier.

Le compte `super_admin` doit rester rare. Pour la production actuelle, la
recommandation est : **un super administrateur** pour les opérations sensibles
et **trois administrateurs** pour l'exploitation quotidienne.

## Variables d'environnement de bootstrap

Les variables suivantes doivent être ajoutées en production, idéalement via AWS
SSM Parameter Store en `SecureString` pour les secrets :

```env
ADMIN_BOOTSTRAP_SECRET=
ADMIN_BOOTSTRAP_PHONE=+243831919710
ADMIN_BOOTSTRAP_FIRST_NAME=Buania
ADMIN_BOOTSTRAP_LAST_NAME=Superadmin
ADMIN_BOOTSTRAP_DEFAULT_PASSWORD=
```

Règles :

- `ADMIN_BOOTSTRAP_SECRET` protège les deux routes publiques de bootstrap ;
- `ADMIN_BOOTSTRAP_DEFAULT_PASSWORD` est le mot de passe temporaire initial ;
- `ADMIN_BOOTSTRAP_PHONE` est le seul numéro autorisé à recevoir et confirmer
  l'OTP du premier super administrateur ;
- après la création du premier `super_admin`, le bootstrap refuse toute nouvelle
  création ;
- après succès, il faut faire tourner ou désactiver les deux secrets de
  bootstrap.

Ne jamais mettre les vraies valeurs dans Git, dans une capture d'écran ou dans
une documentation partagée.

## Bootstrap du premier super administrateur

Envoyer l'OTP :

```http
POST /api/v1/auth/admin/bootstrap/send-otp
x-admin-bootstrap-secret: <ADMIN_BOOTSTRAP_SECRET>
Content-Type: application/json

{
  "phone": "+243831919710"
}
```

Confirmer l'OTP et créer le compte :

```http
POST /api/v1/auth/admin/bootstrap/confirm
x-admin-bootstrap-secret: <ADMIN_BOOTSTRAP_SECRET>
Content-Type: application/json

{
  "phone": "+243831919710",
  "otp": "123456"
}
```

La réponse ne renvoie jamais le mot de passe. Le compte créé possède :

- `role = super_admin` ;
- `isPhoneVerified = true` ;
- `passwordChangeRequired = true`.

À la première connexion, l'interface admin redirige le compte vers
`/settings` pour changer le mot de passe avant d'accéder aux autres routes
protégées.

## Création des administrateurs depuis `zwanga-admin`

Une fois connecté avec un compte `super_admin` dont le mot de passe a été
changé, ouvrir **Paramètres > Comptes back-office**.

Le formulaire demande :

- numéro de téléphone ;
- prénom ;
- nom ;
- mot de passe temporaire.

Le backend crée uniquement des comptes `admin`. Si le numéro existe déjà sur un
compte public `passenger` ou `driver`, ce compte est promu en `admin` au lieu de
créer une deuxième identité. Il n'est alors plus conducteur ni passager dans
l'application courante : `role` devient `admin`, `isDriver` devient `false`,
ses anciens tokens applicatifs sont invalidés, et le mot de passe temporaire
remplace son PIN mobile.

L'historique métier du compte est conservé pour audit : anciens trajets,
réservations, paiements, KYC et écritures financières ne sont pas supprimés ni
recalculés.

Le compte créé ou promu est actif, mais son `passwordChangeRequired` vaut
`true`. L'administrateur reçoit son mot de passe temporaire par un canal
sécurisé hors de l'application, puis doit le remplacer à sa première connexion.

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

Lister les comptes back-office :

```http
GET /api/v1/admin/accounts?page=1&limit=25
Authorization: Bearer <jwt-super-admin>
```

## En développement

```bash
npm run admin:create -- \
  --phone +243900000000 \
  --first-name Alice \
  --last-name Admin \
  --role admin
```

Créer le super administrateur :

```bash
npm run admin:create -- \
  --phone +243900000001 \
  --first-name Eugene \
  --last-name Superadmin \
  --role super_admin
```

La commande compile le projet, puis demande le mot de passe et sa confirmation
dans une saisie masquée. Le mot de passe ne doit jamais être fourni dans les
arguments de la commande ni ajouté en clair dans un ticket.

## Dans le conteneur de production

Le build de production contient la commande compilée :

```bash
docker compose exec -it api npm run admin:create:prod -- \
  --phone +243900000000 \
  --first-name Alice \
  --last-name Admin \
  --role admin
```

En ECS, exécuter la même commande au moyen d'une session interactive ECS Exec.
Ne pas exposer cette commande via une route, un bouton ou un job publiquement
déclenchable.

Exemple de lot production :

```bash
node dist/database/create-admin.js --phone +243000000001 --first-name Eugene --last-name Superadmin --role super_admin
node dist/database/create-admin.js --phone +243000000002 --first-name Ops --last-name One --role admin
node dist/database/create-admin.js --phone +243000000003 --first-name Ops --last-name Two --role admin
node dist/database/create-admin.js --phone +243000000004 --first-name Ops --last-name Three --role admin
```

Chaque ligne demandera son mot de passe masqué. Remplacer les numéros et noms
par les personnes réelles avant exécution.

Ce chemin CLI reste utile comme secours opérationnel, mais le flux recommandé
pour les trois administrateurs après création du premier `super_admin` est
l'interface web.

## Connexion web

`zwanga-admin` utilise l'endpoint dédié :

```http
POST /api/v1/auth/admin/login
Content-Type: application/json

{
  "phone": "+243900000000",
  "password": "MotDePasseAdmin"
}
```

Le endpoint accepte uniquement les rôles `admin` et `super_admin`. Les comptes
`driver` et `passenger` continuent d'utiliser le flux mobile `/auth/login`.

Si la réponse contient `"passwordChangeRequired": true`, l'interface web
redirige vers `/settings`.

Changement de mot de passe :

```http
POST /api/v1/auth/admin/password/change
Authorization: Bearer <jwt-admin-ou-super-admin>
Content-Type: application/json

{
  "currentPassword": "MotDePasseTemporaire",
  "newPassword": "NouveauMotDePasseFort"
}
```

## Garanties

- seuls les rôles `driver` et `passenger` sont acceptés par l'inscription
  publique, Google, Apple et la mise à jour du profil ;
- le bootstrap et l'interface `super_admin` peuvent promouvoir un compte public
  existant en compte back-office ;
- la commande CLI de secours refuse par défaut un numéro déjà utilisé, sauf
  évolution explicite de son mode opératoire ;
- aucun compte `admin` ou `super_admin` existant n'est écrasé silencieusement ;
- le compte créé est actif, possède le rôle demandé et son mot de passe est
  haché ;
- la réinitialisation libre-service du PIN mobile est refusée aux administrateurs et
  super administrateurs ;
- un compte back-office avec `passwordChangeRequired = true` ne peut pas
  accéder aux routes protégées par rôle avant changement de mot de passe ;
- un `super_admin` satisfait les routes protégées par `@Roles(UserRole.ADMIN)`,
  mais un `admin` ne satisfait pas les routes `@Roles(UserRole.SUPER_ADMIN)` ;
- un admin simple ne peut pas suspendre, réactiver ou désactiver un autre admin
  ou le super administrateur.

## Après création

1. Se connecter à `zwanga-admin` avec le `super_admin`.
2. Changer immédiatement le mot de passe temporaire.
3. Créer les trois comptes `admin` depuis `/settings`.
4. Se connecter à `zwanga-admin` avec chaque compte.
5. Vérifier que le nom et le rôle affichés dans la barre supérieure sont
   corrects.
6. Avec un compte `admin`, vérifier que les pages Finance sont accessibles en
   lecture seule pour les actions sensibles.
7. Avec le compte `super_admin`, vérifier qu'un ajustement de jetons de test ou
   un rapprochement de retrait de test reste audité et idempotent.
