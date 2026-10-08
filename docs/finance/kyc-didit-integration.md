# KYC Didit et compatibilité Zwanga

Identifiant changement : `KYC-DIDIT-001`  
Date : 1 septembre 2026  
Périmètre : application mobile, backend NestJS, back-office admin, retraits conducteur, retraits de parrainage  
Statut : implémenté localement ; migration, variables d'environnement, configuration Didit et déploiements requis

## 8 octobre 2026 — Archivage privé des justificatifs Didit

**Implémenté dans le backend, désactivé par défaut, non déployé.** Le KYC historique
ne conservait qu'un résumé de décision. La migration additive
`1780000061000-KycEvidenceArchive` ajoute une file durable et un journal d'accès,
sans toucher aux verdicts, bonus, commissions ni notifications existants.
La migration complémentaire `1780000062000-KycEvidenceIndefiniteRetention`
permet la conservation sans expiration choisie ensuite par l'utilisateur,
sans modifier la migration 61 ni réécrire les échéances déjà enregistrées.

### Données et fonctionnement

- Après synchronisation/webhook Didit ou validation admin, un dossier Didit éligible
  est mis en file dans la même transaction que sa validation. Aucun téléchargement
  sous verrou. Les justificatifs legacy déjà envoyés restent dans leur stockage existant.
- Le worker `src/users/kyc-evidence/` traite une session par minute et par instance,
  avec bail PostgreSQL, `SKIP LOCKED`, déduplication dossier/session, cinq tentatives
  espacées de cinq minutes et récupération après arrêt d'une tâche ECS.
- Il relit `GET /v3/session/{sessionId}/decision/`, vérifie l'appartenance et exploite
  les tableaux v3. Recto, verso disponible et selfie sont copiés ; noms, numéro/type
  de pièce, dates de naissance/émission/expiration, pays/nationalité et statuts des
  contrôles sont conservés lorsqu'ils sont fournis. Une approbation sans justificatifs
  ne crée pas magiquement les pièces manquantes.
- Les images sont des **copies JPEG normalisées** (réencodage, retrait EXIF/GPS,
  côté maximal 2 560 px), pas des originaux judiciaires certifiés. Empreinte SHA-256
  par copie. Pas de vidéo, PDF, gabarit biométrique, IP, numéro personnel supplémentaire,
  recherche de visages ou données d'autres personnes issues de `matches[]`.
- Stockage dans un bundle JSON privé sous `kyc/evidence/<archive>/<tentative>.json`
  du bucket applicatif, chiffré SSE-S3 AES256. Pas de données d'identité extraites ni
  d'URL fournisseur dans les nouvelles tables SQL ; pas de lien public/présigné
  retourné au client. Limites : quatre documents et quatre contrôles selfie,
  5 Mo par image source, 24 Mo par bundle. Les absences sont signalées : `partial`
  après épuisement des tentatives, jamais un faux `ready`.
- Le choix d'un bundle permet de ne pas exposer d'URL directe ; chaque consultation
  lit le bundle côté backend, avec au maximum deux lectures simultanées par
  instance (HTTP 503 temporaire au-delà). Pour de forts volumes, surveiller mémoire/latence
  et faire évoluer le stockage sans ouvrir d'accès public.

### Endpoints admin

Tous exigent le JWT et le rôle admin (règles superadmin existantes conservées),
avec limitation de débit et `Cache-Control: no-store`. Préfixe API habituel omis :

| Méthode et chemin | Fonction |
| --- | --- |
| `POST /admin/kyc/:kycId/evidence` | Demander la collecte d'une session existante ou relancer un échec/partiel encore conservable. |
| `GET /admin/kyc/:kycId/evidence` | Lister les 20 archives les plus récentes et leurs états. |
| `GET /admin/kyc/:kycId/evidence/:archiveId` | Détails et manifeste des justificatifs, sans octets image ni URL fournisseur. |
| `GET /admin/kyc/:kycId/evidence/:archiveId/files/:index` | Télécharger une copie JPEG après nouveau contrôle d'accès. |
| `DELETE /admin/kyc/:kycId/evidence/:archiveId` | Révoquer immédiatement l'accès et programmer la purge. |

La consultation des données/images est auditée **avant** lecture S3 ; si l'audit
échoue, aucun justificatif n'est retourné. Une récupération historique est possible
uniquement si la session appartient encore au dossier local et existe chez Didit.
Pas de collecte rétroactive massive. Relances admin bornées à 30 clés planifiées
par archive, sans prolonger la conservation. Aucun changement mobile ou écran du
back-office réalisé ; ces derniers peuvent consommer les nouveaux endpoints.

### Configuration à vérifier avant activation

| Variable | Valeur / rôle |
| --- | --- |
| `DIDIT_KYC_ARCHIVE_ENABLED` | `false` par défaut ; `true` seulement après revue confidentialité et stockage. |
| `DIDIT_KYC_ARCHIVE_RETENTION_DAYS` | `0` pour la conservation sans expiration demandée ; sinon de 1 à 3 650 jours. Valeur obligatoire : vide ou absente ne signifie jamais « indéfiniment ». |
| `DIDIT_KYC_MEDIA_HOSTS` | Hôtes HTTPS exacts des médias de votre application Didit, séparés par virgules ; pas de wildcard ni URL complète. |

La clé Didit existante (`DIDIT_API_KEY`, sinon `DIDIT_KYC_API_KEY`) et
`AWS_S3_BUCKET_NAME` sont réutilisées ; aucun nouvel accès AWS statique. Les hôtes
ne sont pas devinés depuis le nom du fournisseur : vérifier les hôtes des URLs
renvoyées dans une session de test autorisée, sans copier ses données personnelles
dans des logs. DNS public épinglé, IPv4 uniquement, aucun suivi de redirection,
aucun envoi de clé Didit au serveur d'images, délais et tailles bornés.

Le bucket doit réellement bloquer l'accès public. `AWS_S3_PUBLIC_BUCKET=true`
interdit l'activation dans le code, mais un réglage local ne remplace pas la
vérification de la politique S3. Les permissions existantes couvrent Put/Get/Delete ;
**la purge requiert aussi `s3:ListBucketVersions` sur le bucket (condition
`s3:prefix` limitée à `kyc/evidence/*`) et `s3:DeleteObjectVersion` sur les objets
de ce préfixe**. Le worker énumère les versions et marqueurs de suppression de
chaque clé exacte avant de les supprimer, y compris les versions masquées et la
version `null`. Une clé planifiée mais jamais téléversée donne une liste vide ;
un refus IAM ne vaut jamais suppression réussie. L'énumération est bornée à dix
pages de 100 entrées et la purge d'une clé à deux minutes ; un dépassement conserve
l'état à purger. Voir les API AWS [ListObjectVersions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html)
et [DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html).
Aucun fichier Terraform/IAM, secret SSM ou réglage de bucket n'a été modifié.

### Conservation, suppression et limites

- Décision utilisateur du 8 octobre 2026 : **conservation sans expiration automatique**.
  Avec `DIDIT_KYC_ARCHIVE_RETENTION_DAYS=0`, les nouvelles archives ont
  `expiresAt: null` en base et dans l'API admin. Ce n'est pas une date très lointaine
  ni une suspension du worker de purge. La migration 62 conserve les échéances
  finies existantes ; changer la configuration ou rejouer un webhook ne prolonge
  pas les archives et ne restaure pas celles déjà purgées. Les exemples sont à `0`,
  mais aucun `.env` réel ou paramètre AWS n'a été modifié.
- Pour une durée positive, l'échéance reste fixée lors de la première mise en file,
  non renouvelée à chaque webhook. La politique de confidentialité doit refléter
  la décision retenue ; ce choix technique ne constitue pas une validation juridique.
- À échéance lorsqu'il y en a une, sur demande de suppression admin, ou à la suppression de `kyc_documents` lors de la suppression du
  compte, l'accès admin est refusé. Les références des objets restent dans la file
  pour la purge asynchrone, y compris après un crash entre upload et commit.
- Deux purges par cycle, sans téléchargement sous transaction. La purge continue
  même si la collecte est désactivée. Une panne/IAM/Object Lock peut retarder la
  suppression physique : alerter sur `ARCHIVE_PURGE_FAILED` et traiter le retard.
  Un upload déjà en cours termine son bail avant purge. Les retries ne recréent
  pas une archive expirée ; un marqueur minimal reste pour la déduplication/audit.
- La purge concerne les nouvelles copies Zwanga, **pas** les sessions Didit,
  anciennes pièces legacy ni les sauvegardes/répliques administrées ailleurs.
  Définir séparément les durées Didit, journaux d'audit, sauvegardes et éventuelles
  réplications/lifecycle S3 ; une règle S3 d'expiration peut effacer les fichiers
  indépendamment du `0` applicatif, donc vérifier ce préfixe avant activation.
  Le `down` refuse de supprimer les tables sans purge
  explicite ; désactiver la collecte n'efface pas instantanément les archives.
- Le backend conserve ses statuts/notifications KYC usuels indépendamment d'un
  échec réseau de collecte. L'insertion en file étant transactionnelle, une erreur
  SQL d'enqueue fait néanmoins échouer la transaction : migrations 61 et 62 obligatoires
  avant activation et surveillance des erreurs de base nécessaire.

Sources consultées le 8 octobre 2026 : [résultat de session v3](https://docs.didit.me/sessions-api/retrieve-session)
et [modèles de données / médias temporaires](https://docs.didit.me/reference/data-models).
Les anciens liens `reference/retrieve-session` renvoyaient 404 ; l'implémentation
utilise la documentation actuelle. Tests locaux et état de livraison : voir
le [journal financier](CHANGELOG.md). Aucun appel réel à Didit/S3 ni donnée réelle
récupérée ; une recette sur session synthétique autorisée reste nécessaire.

Vérifications locales : suite complète exécutée avec **1 491 tests réussis**
(138 suites, 176 tests ignorés), puis **81 tests KYC ciblés réussis** couvrant aussi
les derniers ajustements de concurrence des lectures et de purge des versions S3 ; **9 tests PostgreSQL 18 réussis**
sur cluster éphémère, transports cloud simulés et compilation backend réussie.
Après ajout du mode sans expiration : **86 tests KYC ciblés et 13 tests PostgreSQL
18 isolés réussis**, compilation réussie. Contrôles ajoutés : configuration `0`
explicite, archive sans échéance toujours consultable, purge admin/compte conservée,
absence de recollecte après purge, échéances finies préservées. La suite globale
n'a pas été relancée pour ce seul ajustement ; ses chiffres ci-dessus sont antérieurs.
Premier essai du nouveau test réseau corrigé : l'espion Jest ne pouvait pas
redéfinir le getter d'un import namespace Node ; utilisation de l'import CommonJS
du module natif, sans changement du transport pour masquer une erreur.
Les changements OTP/dispatch concurrents du workspace n'ont pas été modifiés
par cette intervention. Les résultats sont ceux de l'arbre de travail testé.

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

## Concordance des noms légaux

Le backend envoie à Didit les noms du profil dans `expected_details` :

```json
{
  "expected_details": {
    "first_name": "Eugène",
    "last_name": "Bosuku Buania"
  }
}
```

Ces valeurs sont normalisées en Unicode NFC, sans espaces en début/fin et avec
un seul espace entre les mots. Elles ne sont ni réordonnées ni abrégées :
l'utilisateur doit donc saisir ses prénom(s) et son nom comme ils apparaissent
sur la pièce d'identité. Le post-nom reste facultatif.

Le parcours mobile applique les garde-fous suivants :

1. les champs d'inscription utilisent les libellés `Prénom(s)` et `Nom`, avec
   un post-nom explicitement facultatif et une explication du contrôle Didit ;
2. les noms venant de Google restent modifiables et les valeurs confirmées
   sont envoyées au backend lors de la première inscription ;
3. avec Apple, l'app demande les scopes `FULL_NAME` et `EMAIL`, transmet le nom
   fourni lors de la première autorisation et ne réaffiche pas de champs de nom ;
4. avant toute nouvelle session Didit, l'app affiche les deux valeurs et permet
   de revenir à la modification du profil ;
5. après un KYC approuvé, le backend refuse une modification réelle des noms.
   Les différences de casse, d'accents ou d'espacement restent considérées
   comme la même identité ;
6. un changement légal doit passer par le support, qui organise une nouvelle
   vérification avant de modifier l'identité de référence.

Quand Didit renvoie `FULL_NAME_MISMATCH_WITH_PROVIDED` (ou un avertissement
équivalent de nom fourni), le backend conserve le code d'avertissement sans les
données personnelles dans `providerMetadata.warningCodes` et retourne un motif
de rejet compréhensible à l'utilisateur.

### Réglage requis dans la console Didit

Le code Zwanga ne peut pas modifier les règles de décision du workflow Didit.
Dans la version publiée du workflow KYC :

1. ouvrir les règles de décision de l'étape de vérification du document ;
2. rechercher la règle liée aux écarts entre `expected_details` et les données
   OCR, notamment `FULL_NAME_MISMATCH_WITH_PROVIDED` ;
3. configurer cet écart en `In Review` / revue manuelle, et non en refus
   automatique ;
4. conserver les contrôles de document, liveness et face match inchangés ;
5. publier une nouvelle version du workflow et tester un nom identique, un nom
   sans post-nom, puis un écart réel.

Les intitulés exacts peuvent varier selon la version de la console Didit. Le
résultat attendu est qu'un simple écart de nom soit examiné manuellement, sans
approuver automatiquement une identité différente.

## Tables et colonnes

Table touchée : `kyc_documents`

Migration : `1780000027000-AddDiditKycFields`

Colonnes ajoutées :

| Colonne              | Type                   | Rôle                                           |
| -------------------- | ---------------------- | ---------------------------------------------- |
| `provider`           | enum `legacy`, `didit` | distingue l'ancien flux du flux Didit          |
| `diditSessionId`     | varchar nullable       | identifiant de session Didit                   |
| `diditSessionNumber` | integer nullable       | numéro lisible de session Didit si fourni      |
| `diditWorkflowId`    | varchar nullable       | workflow Didit utilisé                         |
| `diditVendorData`    | varchar nullable       | identifiant métier renvoyé par Didit           |
| `diditSessionStatus` | varchar nullable       | statut brut Didit le plus récent               |
| `diditLastSyncedAt`  | timestamp nullable     | dernière synchronisation locale                |
| `providerMetadata`   | jsonb nullable         | résumé technique minimal, sans image ni secret |

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
];
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

## Notifications d'approbation — 7 octobre 2026

Statut : correction backend locale, non déployée. Aucune nouvelle migration ni
variable d'environnement pour cette correction ; le schéma d'outbox existant
doit néanmoins être installé avec les migrations du lot.

Le push `kyc_approved` est créé quand le KYC passe à `approved`, que la décision
provienne de l'admin Zwanga, du webhook Didit ou de la synchronisation serveur
Didit. Une insertion directement approuvée est également couverte. Le message
est neutre quant au fournisseur : **Identité vérifiée** — « Votre identité a été
vérifiée avec succès. Consultez votre profil pour voir les fonctionnalités
disponibles. » Il ne promet pas l'activation d'un compte suspendu ou du profil
conducteur. Les notifications de refus manuels sont conservées.

1. L'admin ou Didit enregistre la décision sous verrou utilisateur puis dossier.
2. Le subscriber TypeORM insère la notification dans la **même transaction**.
   Un rollback annule aussi le message ; aucun push ne part avant le commit.
3. `reviewedAt` identifie la décision terminale, y compris pour Didit, dont
   `reviewedBy` reste nul lors d'une nouvelle décision. Une resynchronisation
   identique ou la confirmation du même accord par un admin ne change pas cette
   date et ne crée pas une seconde notification d'approbation.
4. Le dispatcher passe toutes les 10 secondes. Il vérifie que le dossier est
   toujours le dernier KYC de cet utilisateur, avec la même décision, puis
   résout son token actuel et envoie via Expo/Firebase, **hors transaction**.
5. Un échec d'envoi ne révoque pas le KYC. La reprise existante passe toutes les
   5 minutes, pour les notifications de moins de 72 heures. Un token absent ou
   ambigu empêche l'envoi ; l'app doit enregistrer un token valide et autorisé.
6. Les approbations devenues obsolètes sont désactivées avant envoi/reprise.
   La clé unique d'événement évite les doublons d'outbox ; elle ne constitue pas
   une garantie de livraison physique « exactement une fois » par le fournisseur.

Pour une approbation depuis la console Didit alors que l'app est fermée,
configurer la destination HTTPS `/api/v1/users/kyc/didit/webhook`, l'événement
`status.updated` et le secret de signature correspondant. Une session créée
hors Zwanga doit être rattachée au bon utilisateur (`vendor_data` ou session
déjà associée). Sans webhook reçu, le backend ne découvre le changement qu'à
la prochaine synchronisation. Référence :
[webhooks Didit](https://docs.didit.me/integration/webhooks).

Pas de campagne rétroactive sur tous les dossiers déjà approuvés. Le bonus de
bienvenue et sa notification restent séparés, avec leur éligibilité et leur
déduplication existantes. Les endpoints et le type de push restent compatibles
avec les clients existants ; aucune mise à jour mobile n'est requise pour
l'envoi, sans garantir une nouvelle navigation dans les anciens builds.

Vérifications ciblées : 58 tests unitaires (admin, Didit, subscriber, dispatcher)
et 27 tests PostgreSQL 18 sur un cluster local jetable, transports simulés.
Suite backend complète : 1 363 tests réussis, 146 ignorés ; compilation réussie.
Cas supplémentaires : approbation sans admin, répétition, confirmation manuelle,
rollback, panne push puis reprise, décision révoquée/remplacée et nouveau dossier.
Aucun appel réel à Didit/Expo/Firebase et aucun test sur téléphone physique.

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
DIDIT_API_KEY=
DIDIT_WORKFLOW_ID=
DIDIT_WEBHOOK_SECRET=
DIDIT_WEBHOOK_REQUIRE_SIGNATURE=true
DIDIT_WEBHOOK_TOLERANCE_SECONDS=300
```

Alias acceptés pour faciliter la migration :

- `DIDIT_KYC_API_KEY`
- `DIDIT_KYC_WORKFLOW_ID`
- `DIDIT_KYC_WEBHOOK_SECRET`

Les valeurs secrètes doivent être stockées dans Parameter Store/Secrets Manager,
jamais dans Git.

L'origine de l'API Didit est fixée dans `DiditKycService` à
`https://verification.didit.me`. Elle n'est volontairement pas surchargeable
par une variable d'environnement, afin d'éviter une dérive de configuration ou
l'envoi de la clé API vers un hôte non approuvé.

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
