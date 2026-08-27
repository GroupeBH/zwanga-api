# FIN-REF-007 — Fiabilisation mobile et rattachement des comptes existants

Date : 27 août 2026  
Statut : implémenté ; déploiement backend et nouveaux binaires mobiles requis  
Migration : aucune  
Périmètre : attribution ChottuLink, authentification, cache mobile, partage, notifications et audit

## 1. Objectif métier

Une invitation s'applique désormais dans deux cas :

1. création d'un nouveau compte ;
2. connexion ou utilisation d'un compte existant dont `referredByUserId` est encore `null`.

Un compte déjà rattaché ne peut jamais changer de parrain. Le premier rattachement validé par le serveur est définitif. Cette extension ne génère aucune rémunération rétroactive.

## 2. Garanties financières inchangées

Cette modification ne change aucun calcul monétaire :

- commission : 5 % du paiement FlexPay éligible réellement confirmé ;
- retenue : sept jours ;
- durée : douze mois à partir du premier paiement éligible réussi ;
- conversion : valeur du jeton figée dans chaque récompense ;
- sources : abonnement FlexPay et course électronique terminée puis payée ;
- unicité : une seule récompense par source grâce à l'index existant.

Le rattachement d'un ancien compte ne crée ni écriture comptable, ni jeton, ni récompense. Les événements antérieurs sont ignorés.

## 3. Contrat backend

### 3.1 Route

```http
POST /api/v1/referrals/me/attribution
Authorization: Bearer <JWT>
Content-Type: application/json
```

```json
{
  "referralProvider": "chottulink",
  "referralToken": "jeton-opaque",
  "referralReferringLink": "https://zwanga-app.chottu.link/abc123",
  "referralCapturedAt": "2026-08-27T10:00:00.000Z"
}
```

Réponse :

```json
{
  "attached": true,
  "newlyAttached": true,
  "referredAt": "2026-08-27T10:01:00.000Z",
  "referrer": { "firstName": "Amina" }
}
```

La route exige un JWT, limite les appels, valide le format du jeton et refuse une capture vieille de plus de 30 jours.

### 3.2 Atomicité et concurrence

La transaction verrouille le profil du filleul avec `pessimistic_write`. Elle garantit qu'entre deux invitations concurrentes :

- une seule peut écrire `referredByUserId` ;
- une répétition du même lien est idempotente ;
- un lien différent reçoit un refus ;
- l'auto-parrainage est refusé ;
- le compte de parrainage vide est créé si nécessaire dans la même transaction.

Les champs `referredAt`, `attributionProvider`, `attributionLinkToken`, `attributionReferringLink` et `attributionCapturedAt` constituent la preuve d'attribution persistée.

## 4. Cycle mobile

### 4.1 Réception

Android déclare un App Link HTTPS vérifié pour `zwanga-app.chottu.link`. iOS déclare le même domaine dans `com.apple.developer.associated-domains`. L'application couvre :

- lancement à froid ;
- application en arrière-plan ;
- application déjà ouverte ;
- installation différée depuis un store.

Après l'initialisation du SDK, l'application écoute l'événement natif et lit également `getAttributionData()`. Une deuxième lecture différée couvre la fin asynchrone de l'initialisation.

### 4.2 Premier lien et consommation

Le premier lien valide est conservé pendant 30 jours. Il n'est supprimé qu'après :

- création de compte confirmée ;
- rattachement authentifié confirmé ;
- refus définitif du backend.

Une erreur réseau conserve le lien pour une nouvelle tentative au retour au premier plan ou au prochain lancement.

Les attributions différées consommées sont mémorisées pendant 90 jours, dans une liste limitée à dix entrées, afin que le cache natif d'installation ne rattache pas silencieusement plusieurs comptes. Un nouveau clic direct reste autorisé.

### 4.3 Compte existant

La connexion ne supprime plus l'invitation. Dès que le JWT est disponible, le coordinateur global appelle la route authentifiée. Le serveur décide si le compte est libre, déjà rattaché au même parrain ou rattaché à un autre.

L'utilisateur reçoit une confirmation visible après succès et un message explicite en cas de refus définitif.

## 5. Isolation des comptes

Le cache RTK Query est purgé à la déconnexion et lorsqu'une identité différente remplace la session courante. Les écrans de profil et de parrainage rechargent leurs données au montage, au retour au premier plan et après reconnexion réseau.

Cette mesure empêche l'affichage temporaire des filleuls, jetons, retraits ou données KYC du compte précédent sur un appareil partagé.

## 6. Partage et notifications

Le partage natif valide l'URL HTTPS et bloque les doubles clics. Si le menu natif échoue, l'utilisateur peut copier le lien avec `expo-clipboard`.

Lors du premier rattachement, le backend journalise uniquement les identifiants utilisateur, le fournisseur et le résultat, jamais le jeton complet. Si le parrain possède un token FCM, il reçoit « Nouveau filleul Zwanga ». Un appui ouvre `/referrals`. La répétition idempotente n'envoie aucune seconde notification.

## 7. Configuration et déploiement

Le profil EAS production doit fournir :

```text
CHOTTULINK_MOBILE_API_KEY
CHOTTULINK_DOMAIN=zwanga-app.chottu.link
```

`eas.json` charge l'environnement EAS `production`. `app.config.js` refuse une compilation EAS production incomplète. Exécuter avant le build :

```powershell
npm run validate:referrals
npx tsc --noEmit
```

Le backend n'ajoute aucune variable ni migration. Il doit être déployé avant le nouveau binaire, sinon l'application conservera l'attribution après une erreur réseau. Une réponse 404 est cependant considérée comme définitive par cette version : respecter obligatoirement l'ordre backend, contrôle de route, Android, puis iOS.

## 8. Recette obligatoire

Tester sur de vrais appareils :

1. nouveau compte après installation différée ;
2. nouveau compte avec application déjà installée ;
3. compte existant sans parrain, connecté avant le clic ;
4. compte existant sans parrain, connexion après le clic ;
5. compte déjà rattaché au même parrain ;
6. compte déjà rattaché à un autre parrain ;
7. auto-parrainage ;
8. deux liens concurrents ;
9. coupure réseau puis retour au premier plan ;
10. déconnexion puis connexion d'un autre compte sur le même appareil ;
11. partage WhatsApp, SMS et copie de secours ;
12. apparition unique du filleul et de la notification chez le parrain.

Vérifier ensuite qu'un paiement éligible postérieur au rattachement génère exactement une commission de 5 %, et qu'aucun paiement antérieur n'est récompensé.

## 9. Retour arrière

Le backend peut retirer la route authentifiée sans migration, mais il faut d'abord publier une application qui ne l'appelle plus. Les rattachements déjà enregistrés restent valides et ne doivent pas être supprimés. Un retour arrière ne doit jamais modifier les soldes, récompenses ou écritures comptables existantes.
