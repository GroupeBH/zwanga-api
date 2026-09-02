# KYC Didit et compatibilité Zwanga

Identifiant changement : `KYC-DIDIT-001`  
Date : 1 septembre 2026  
Périmètre : application mobile, backend NestJS, back-office admin, retraits conducteur, retraits de parrainage  
Statut : implémenté localement ; migration, variables d'environnement, configuration Didit et déploiements requis

## Objectif

Zwanga remplace progressivement la vérification KYC interne basée sur l'upload
de photos CNI/selfie et la validation Rekognition/manuelle par une vérification
hébergée chez Didit.

Le changement est volontairement conçu comme un adaptateur : les autres modules
continuent de lire `kyc_documents.status` avec les valeurs historiques :

- `pending`
- `approved`
- `rejected`

Les modules de retrait conducteur, retrait de parrainage, abonnement et
back-office ne doivent donc pas connaître Didit directement.

## Comportement avant

1. L'utilisateur envoyait `cniFront`, `cniBack` optionnel et `selfie` via
   `POST /users/kyc`.
2. Le backend stockait les fichiers en local/S3.
3. Si `AWS_REKOGNITION_KYC_ENABLED=true`, Rekognition comparait les visages.
4. Sinon, ou en cas d'erreur technique, le dossier restait en revue manuelle.
5. Un admin pouvait approuver/rejeter via `/admin/kyc/:kycId/verify`.

## Comportement après

1. L'app mobile appelle `POST /users/kyc/didit/session`.
2. Le backend crée une session hébergée Didit avec :
   - `workflow_id` configuré côté serveur ;
   - `vendor_data = users.id` ;
   - une URL de retour mobile/web fournie par l'app ;
   - des métadonnées minimales de contexte.
3. L'app mobile lance en priorité le SDK React Native Didit avec le
   `session_token` retourné par le backend. Ce mode capture la pièce d'identité
   et le visage/liveness dans le module natif Didit.
4. Si le SDK natif n'est pas encore disponible dans le build installé, l'app
   utilise temporairement l'URL Didit avec `WebBrowser.openAuthSessionAsync`.
5. Après retour du SDK ou du navigateur, `POST /users/kyc/didit/sync` demande au backend de
   relire la décision Didit côté serveur.
6. Didit peut aussi appeler `POST /users/kyc/didit/webhook`.
7. Le backend convertit le statut Didit en statut Zwanga :
   - `Approved` -> `approved`
   - `Declined`, `Expired`, `Abandoned`, `KYC Expired` -> `rejected`
   - tout statut intermédiaire -> `pending`
8. Si le statut devient `approved`, `users.status` passe à `active` sauf si le
   compte est suspendu.
9. Si le statut reste `pending` ou devient `rejected`, `users.status` reste ou
   repasse à `pending_kyc` sauf si le compte est suspendu.

L'ancien endpoint `POST /users/kyc` reste présent pour compatibilité et secours,
mais le flux mobile principal doit utiliser Didit.

## Tables et colonnes

Table touchée : `kyc_documents`

Migration : `1780000027000-AddDiditKycFields`

Colonnes ajoutées :

| Colonne | Type | Rôle |
| --- | --- | --- |
| `provider` | enum `legacy`, `didit` | distingue l'ancien flux du flux Didit |
| `diditSessionId` | varchar nullable | identifiant de session Didit |
| `diditSessionNumber` | integer nullable | numéro lisible de session Didit si fourni |
| `diditWorkflowId` | varchar nullable | workflow Didit utilisé |
| `diditVendorData` | varchar nullable | identifiant métier renvoyé par Didit |
| `diditSessionStatus` | varchar nullable | statut brut Didit le plus récent |
| `diditLastSyncedAt` | timestamp nullable | dernière synchronisation locale |
| `providerMetadata` | jsonb nullable | résumé technique minimal, sans image ni secret |

Index :

- index unique partiel sur `diditSessionId` quand non nul ;
- index de lecture sur `("userId", "provider")`.

## Typage TypeORM

Les champs nullable de l'entité `KycDocument` doivent déclarer leur type SQL de
façon explicite. Sans cela, TypeORM peut inférer `string | null` comme `Object`
au moment de `migration:run`, puis échouer avec :

```text
DataTypeNotSupportedError: Data type "Object" in "KycDocument.selfieUrl" is not supported by "postgres" database.
```

Champs explicités :

- `userId` -> `uuid`
- `selfieUrl` -> `varchar`
- `rejectionReason` -> `text`
- `reviewedBy` -> `uuid`
- `documentNumber` -> `varchar`

Cette correction ne crée pas de mouvement financier et ne modifie aucun statut
KYC existant. Elle sécurise seulement l'initialisation TypeORM nécessaire aux
migrations.

## Endpoints

### Créer une session Didit

`POST /api/v1/users/kyc/didit/session`

Authentification : utilisateur connecté.

Corps :

```json
{
  "callbackUrl": "zwanga://kyc/didit-return",
  "language": "fr",
  "source": "profile"
}
```

Réponse :

```json
{
  "sessionId": "didit-session-id",
  "session_id": "didit-session-id",
  "sessionNumber": 123,
  "session_number": 123,
  "sessionToken": "didit-sdk-session-token",
  "session_token": "didit-sdk-session-token",
  "url": "https://verification.didit.me/...",
  "verification_url": "https://verification.didit.me/...",
  "status": "Not Started",
  "vendorData": "zwanga-user-id",
  "vendor_data": "zwanga-user-id",
  "workflowId": "didit-workflow-id",
  "workflow_id": "didit-workflow-id"
}
```

L'URL `url` reste retournée pour compatibilité navigateur. Le SDK mobile doit
utiliser `sessionToken/session_token` quand il est présent.

## Intégration mobile React Native

Package ajouté dans l'app mobile `zwanga` :

```bash
npm install @didit-protocol/sdk-react-native
```

Configuration Expo ajoutée :

```js
[
  '@didit-protocol/sdk-react-native',
  {
    iosVariant: 'autodetection',
    androidVariant: 'autodetection',
  },
]
```

Choix retenu : `autodetection`, car le besoin Zwanga est de comparer l'image de
la pièce d'identité avec le visage capturé/liveness de l'utilisateur, sans
exiger la lecture NFC.

Flux mobile :

1. l'app appelle `POST /users/kyc/didit/session` ;
2. si `sessionToken` est présent, l'app appelle
   `startVerification(sessionToken)` du SDK Didit ;
3. si le module natif n'est pas disponible dans le build installé, l'app bascule
   sur l'URL Didit en WebBrowser ;
4. dans tous les cas, l'app appelle ensuite `POST /users/kyc/didit/sync` ;
5. le backend relit Didit côté serveur avant de modifier `kyc_documents.status`.

Important : le SDK Didit ne fonctionne pas dans Expo Go. Il faut un development
build ou un build EAS intégrant le module natif.

### Synchroniser une session Didit

`POST /api/v1/users/kyc/didit/sync`

Authentification : utilisateur connecté.

Corps :

```json
{
  "sessionId": "didit-session-id",
  "status": "Approved"
}
```

Important : le champ `status` envoyé par l'app n'approuve jamais un KYC à lui
seul. Le backend interroge Didit côté serveur avant de passer à `approved`.

### Webhook Didit

`POST /api/v1/users/kyc/didit/webhook`

Authentification : publique, mais signature obligatoire par défaut.

Headers attendus :

- `X-Timestamp`
- `X-Signature-V2` recommandé
- `X-Signature-Simple` supporté en secours

Le backend refuse :

- les webhooks sans signature ;
- les timestamps hors fenêtre de tolérance ;
- les signatures invalides ;
- les webhooks `X-Signature-Simple` qui ne correspondent pas à une session déjà
  connue localement.

## Idempotence et concurrence

Les callbacks Didit peuvent arriver plusieurs fois ou dans un ordre différent du
retour mobile. Pour cette raison :

1. `diditSessionId` est unique.
2. L'application d'un statut se fait en transaction.
3. `users` et `kyc_documents` sont verrouillés avec `pessimistic_write`.
4. Un événement intermédiaire `pending` provenant d'une ancienne session ne
   rétrograde pas un dossier déjà terminal (`approved` ou `rejected`).
5. Les webhooks répétés réécrivent le même état sans créer de doublon.

## Impact financier

Aucun montant, taux, commission, solde ou conversion ne change.

Le KYC reste toutefois un prérequis de décaissement :

- retrait des gains conducteur ;
- retrait des gains de parrainage ;
- opérations back-office sensibles liées à l'argent.

L'invariant financier reste :

```text
un retrait réel FlexPay n'est autorisé que si kyc_documents.status = approved
```

## Données personnelles

Zwanga ne stocke pas les images Didit ni le payload complet de décision.

Zwanga conserve seulement :

- l'identifiant de session ;
- le workflow ;
- le statut brut ;
- un résumé technique minimal ;
- le statut Zwanga normalisé.

Les documents déjà stockés par l'ancien flux restent inchangés.

## Variables d'environnement

```env
KYC_PROVIDER=didit
DIDIT_KYC_ENABLED=true
DIDIT_API_BASE_URL=https://verification.didit.me
DIDIT_API_KEY=
DIDIT_WORKFLOW_ID=
DIDIT_WEBHOOK_SECRET=
DIDIT_WEBHOOK_REQUIRE_SIGNATURE=true
DIDIT_WEBHOOK_TOLERANCE_SECONDS=300
```

Alias acceptés pour faciliter la migration :

- `DIDIT_KYC_API_KEY`
- `DIDIT_KYC_WORKFLOW_ID`
- `DIDIT_BASE_URL`
- `DIDIT_KYC_WEBHOOK_SECRET`

Les valeurs secrètes doivent être stockées dans Parameter Store/Secrets Manager,
jamais dans Git.

## Configuration côté Didit

Dans Didit :

1. créer ou sélectionner le workflow KYC ;
2. récupérer l'API key serveur ;
3. récupérer l'identifiant du workflow ;
4. configurer l'URL webhook :

```text
https://<api-production>/api/v1/users/kyc/didit/webhook
```

5. récupérer le secret webhook et le stocker côté backend.

Références Didit utilisées :

- création de session : `https://docs.didit.me/sessions-api/create-session`
- décision/session : `https://docs.didit.me/sessions-api/retrieve-session`
- webhooks : `https://docs.didit.me/integration/webhooks`
- statuts : `https://docs.didit.me/integration/verification-statuses`

## Déploiement

1. Déployer la migration sur une copie de base ou staging.
2. Ajouter les variables Didit dans l'environnement local/staging.
3. Tester `POST /users/kyc/didit/session`.
4. Tester le SDK Didit dans un development build ou build EAS de l'app mobile.
5. Vérifier `POST /users/kyc/didit/sync`.
6. Simuler ou déclencher un webhook signé.
7. Vérifier que :
   - `kyc_documents.provider = didit` ;
   - `kyc_documents.status` reflète la décision ;
   - `users.status` passe à `active` uniquement quand Didit approuve ;
   - les retraits restent bloqués tant que KYC n'est pas approuvé.
8. En production AWS, importer les variables sous le préfixe SSM runtime puis
   régénérer la task definition ECS avec Terraform.

## Rollback

Rollback applicatif :

```env
KYC_PROVIDER=legacy
DIDIT_KYC_ENABLED=false
```

L'ancien endpoint `POST /users/kyc` reste disponible.

Rollback DB :

- la migration possède une méthode `down` qui retire les colonnes et index
  Didit ;
- ne l'exécuter qu'après avoir confirmé qu'aucun dossier Didit n'est nécessaire
  pour l'audit ou le support.

## Tests

Tests ajoutés :

```bash
npm test -- didit-kyc.service.spec.ts
```

Scénarios couverts :

- création d'une session Didit avec `vendor_data = user.id` ;
- création d'une session Didit SDK quand Didit retourne un `session_token`
  sans URL hébergée ;
- synchronisation qui approuve uniquement après appel serveur vers Didit ;
- impossibilité de s'approuver soi-même si Didit n'est pas configuré ;
- rejet d'un webhook avec signature invalide ;
- webhook V2 signé qui applique la décision rafraîchie.
