# KYC Didit et compatibilité Zwanga

Identifiant changement : `KYC-DIDIT-001`  
Date : 1 septembre 2026  
Périmètre : application mobile, backend NestJS, back-office admin, retraits conducteur, retraits de parrainage  
Statut : implémenté localement ; migration, variables d'environnement, configuration Didit et déploiements requis

## 26 novembre 2026 — Collecte complète et saisie manuelle admin

Cette section complète et remplace les limites de la collecte d'images décrite
plus bas. Travail local uniquement : aucune activation, session réelle ou
modification AWS. La décision KYC, les permissions conducteur et les règles
de paiement restent indépendantes de l'archivage et de la saisie.

### Données disponibles chez Didit

| Source officielle | Usage du backend |
| --- | --- |
| [Décision de session](https://docs.didit.me/sessions-api/retrieve-session) | GET `/v3/session/{sessionId}/decision/`, puis la variante `?include=events,resubmissions`. Conservation des deux réponses : leurs formes ne sont pas identiques. |
| [Profil utilisateur](https://docs.didit.me/management-api/users/get) | GET `/v3/users/{vendor_data}/` avec l'ID Zwanga du propriétaire, jamais un ID trouvé dans une correspondance biométrique. |
| [Export des fichiers](https://docs.didit.me/sessions-api/export-files) | POST `/v3/session/{sessionId}/files-export/`, clé d'idempotence propre à la révision. Images, vidéos et documents originaux dans un ZIP. |
| [État de l'export](https://docs.didit.me/sessions-api/get-files-export) | GET `/v3/session/{sessionId}/files-export/{exportId}/`, puis téléchargement HTTPS contrôlé. Les liens d'export sont temporaires. |
| [Rapport PDF](https://docs.didit.me/sessions-api/generate-pdf) | GET `/v3/session/{sessionId}/generate-pdf/?language=fr`, lorsque l'état de session le permet. |

Le JSON privé conserve les champs retournés, y compris ceux ajoutés à l'avenir :
identité, MRZ/NFC, liveness, comparaison faciale, AML, adresse, téléphone/email,
appareil/IP, questionnaires, avertissements, commentaires, événements, décisions
et anciennes soumissions. Les champs absents restent absents : nous ne créons
pas de contrôles supplémentaires ni de faux résultats pour compléter le dossier.

« Tout récupérer » signifie **tout ce que ces endpoints rendent accessible pour
ce dossier et ce propriétaire**. Les [Returned data](https://help.didit.me/workflows/returned-data),
droits de la clé, fonctionnalités du workflow et rétentions Didit peuvent limiter
le résultat. Les sessions/comptes d'autres personnes mentionnés dans un résultat
ne sont jamais parcourus. Les identifiants d'accès et capacités d'URL signées
(requête, fragment, identifiants HTTP) sont retirés de l'archive JSON. Les valeurs
métier ne sont pas réduites à la liste des champs actuellement affichés par Zwanga.

La collecte est mise en file dès la création de session en mode complet, puis
mise à jour lors des webhooks/synchronisations dont le contenu change. Le hash
de déduplication et les révisions sont les seules nouvelles données de contrôle
en SQL : les réponses complètes et fichiers restent dans S3 privé. Un savepoint
isole une erreur d'enqueue du traitement KYC. Aucun téléchargement ne se fait
dans une transaction SQL. Pas de collecte rétroactive massive implicite.

Un export `PENDING`/`PROCESSING` laisse une archive partielle consultable et
relance la collecte après une minute (12 tentatives maximum). Un échec ou une
limite apparaît dans `missing` et `details.coverage` ; l'état n'est pas annoncé
complet. Une reprise admin d'une archive partielle/échouée ouvre une nouvelle
révision d'export sans prolonger la conservation. Limite de 64 tentatives
enregistrées par archive ; intervention technique au-delà.

Les objets supplémentaires, sous le même préfixe privé du bail, sont :

- `provider.json` : réponses structurées et couverture ; plafond 8 Mio.
- `originals.zip` : originaux, transférés en flux sans extraction ; plafond 128 Mio.
- `report.pdf` : rapport fournisseur ; plafond 16 Mio.

Le ZIP conserve les originaux, donc potentiellement leurs métadonnées EXIF,
contrairement aux aperçus JPEG normalisés. L'accès admin authentifié et audité
utilise `GET /admin/kyc/:kycId/evidence/:archiveId/attachments/:kind`, avec
`kind=provider_data|original_files|report`. Les détails du dossier ne chargent pas
les fichiers volumineux. Les versions, marqueurs S3 et objets d'une tentative
interrompue sont inclus dans la purge à l'échéance.

### Saisie manuelle dans zwanga-admin

Disponible dans la fiche utilisateur (y compris sans KYC) et dans la page KYC,
via « Saisie manuelle des informations et documents KYC ». Sections repliables,
composants/styles existants conservés. Le schéma reprend les catégories de
l'en-tête CSV Didit examiné ; aucune ligne contenant des données réelles n'a été
importée. `vendor_data` n'est pas éditable : le propriétaire vient de la route.

1. Saisir les informations connues et un compte rendu de 10 à 2 000 caractères.
2. Joindre facultativement recto, verso, photo du visage et justificatif de
   domicile (JPEG/PNG/WebP, 5 Mio maximum par image ; pas de PDF dans ce formulaire).
3. Enregistrer. Sans dossier existant, un dossier `legacy/pending` est créé.
   Sinon, le dossier Didit/AWS existant et ses résultats sont préservés.
4. La décision de validation/refus reste l'action existante, séparée. Une saisie
   de score AML, présence ou consentement reste une **déclaration administrative**,
   jamais un contrôle exécuté ou un consentement obtenu automatiquement.

Routes réservées aux administrateurs :

- `GET /admin/manual-kyc/schema` : champs et sections du formulaire.
- `GET /admin/users/:userId/manual-kyc` : dernière saisie privée, lecture auditée.
- `POST /admin/users/:userId/manual-kyc` : multipart ; champ `payload` JSON
  `{ kycId, baseRevision, note, fields }`, images dans `document_front`,
  `document_back`, `selfie`, `address_proof`.

Chaque version garde l'auteur, la date, l'origine `administrator`, et un événement
d'audit `manual_save`. Les saisies concurrentes/périmées reçoivent un conflit,
pas un écrasement silencieux. Une panne S3 ne publie pas la nouvelle version et
ne détruit pas la dernière version enregistrée. Les photos non remplacées sont
conservées. Les champs et images manuels restent en S3 privé, sans URL publique
ni copie dans `providerMetadata`. Les workers Didit ne traitent jamais une archive
manuelle. La création d'un dossier vide peut subsister en `pending` si le premier
upload échoue ; recharger le formulaire permet de reprendre sur ce dossier.

### Préparation et déploiement

- Appliquer les migrations `1780000146000` (révisions/export) et `1780000147000`
  (séparation manuelle/audit), après les migrations d'archivage existantes, avant
  de déployer ce backend. Aucune migration n'a été appliquée à la base applicative.
- `DIDIT_KYC_ARCHIVE_ENABLED=false` reste inchangé ;
  `DIDIT_KYC_ARCHIVE_FULL_DATA_ENABLED=true` prépare le nouveau mode dans les
  exemples et le `.env` local. Rétention nouvelles archives : 1 095 jours.
- `KYC_MANUAL_RETENTION_DAYS` vaut 1 095 par défaut et ne change pas les échéances
  déjà enregistrées. Le formulaire manuel ne nécessite ni clé Didit ni hôtes
  médias, mais exige le stockage privé et les permissions S3 d'archivage.
- Avant activation Didit : vérifier les champs retournés, scopes de lecture,
  hôtes exacts du téléchargement ZIP et des images, droits IAM, chiffrement,
  blocage public, rétention/consentement applicables, quotas et éventuelle
  facturation des appels supplémentaires. Ne pas ajouter de contrôles payants
  au workflow pour simplement rendre l'archivage fonctionnel.
- Déployer backend puis admin ; recette sur identité synthétique autorisée :
  création manuelle, complément Didit, accès hors admin refusé, conflit entre
  deux éditeurs, panne S3, export en attente, téléchargement privé et purge.

### Vérifications de cette extension

- **334 tests backend, 18 suites, réussis** : collecte complète, transport et
  stockage bornés, compatibilité Didit/AWS, saisie manuelle et 20 scénarios sur
  une instance PostgreSQL temporaire locale isolée. Les appels Didit/S3 des tests
  sont simulés ; ils ne certifient pas les scopes, quotas ou permissions réels.
- **4 tests admin réussis** : contrat multipart, maintien de la saisie après
  erreur, rendu création/complément et présence dans les deux écrans existants.
- Compilation TypeScript complète du backend réussie :
  `tsc --noEmit --incremental false -p tsconfig.build.json`.
- TypeScript ciblé du formulaire/API admin réussi avec
  `tsc --noEmit --incremental false -p tests/manualKyc.types.json`.
  La vérification TypeScript globale de l'admin a dépassé les limites de mémoire
  de processus essayées (384 puis 640 Mio) ; elle reste à refaire avec davantage
  de mémoire disponible. Pas de validation visuelle navigateur ni de test AWS réel.

## Étape précédente — Images S3 séparées et conservation de trois ans

Choix actuel : **1 095 jours à partir de la première mise en file**, pour les
nouvelles archives Didit. Le `.env` local et les exemples préparent cette durée,
mais la collecte reste désactivée et les hôtes médias restent à renseigner.
Aucun paramètre AWS ni session Didit réelle n'a été modifié pour cette préparation.
Les échéances des archives déjà enregistrées, y compris `expiresAt: null`, ne
sont pas modifiées rétroactivement.

Les nouvelles copies Didit sont des objets `image/jpeg` indépendants sous
`kyc/evidence/<archive>/<tentative>/<index>.jpg`, avec un manifeste JSON v2 privé
à côté (`<tentative>.json`). Il contient les métadonnées et empreintes SHA-256,
pas les images en base64. Les anciens bundles v1 restent lisibles ; le flux AWS
KYC interne continue à utiliser son format existant. Aucun changement de schéma
ni nouvelle migration n'est nécessaire pour ce format.

- Écriture immutable des JPEG, puis du manifeste en dernier. Une panne ne publie
  pas d'archive complète ; les fichiers d'une tentative interrompue restent
  rattachés à la clé de bail déjà enregistrée en base pour leur purge ultérieure.
- Les détails admin ne téléchargent que le manifeste ; demander une image ne
  télécharge que celle-ci. Les anciennes archives v1 nécessitent encore la lecture
  du bundle. Les routes restent compatibles, privées et auditées, sans exposer les
  clés S3 ni les URLs temporaires Didit.
- Les lectures vérifient taille, empreinte et appartenance au même dossier/bail.
  Les limites de téléchargement, la normalisation JPEG et la suppression EXIF/GPS
  restent actives. Pas de téléchargement réseau dans les transactions SQL.
- À l'échéance, l'accès est refusé et le worker purge le manifeste, les images,
  leurs versions S3 et marqueurs de suppression. La suppression physique est
  asynchrone : une panne AWS/IAM/Object Lock peut la retarder et doit être traitée.
  Une suppression de compte ou demande admin peut déclencher la purge plus tôt.

### Recette et activation à effectuer séparément

1. Vérifier les migrations existantes `1780000061000` et `1780000062000`, ainsi
   que le blocage public du bucket applicatif, son chiffrement et ses règles de
   lifecycle/réplication. Aucune règle ne doit expirer ces objets avant la durée
   convenue ; les copies externes/sauvegardes ont leur propre politique.
2. Vérifier le rôle ECS : Put/Get/DeleteObject et DeleteObjectVersion sous
   `kyc/evidence/*`, ListBucketVersions sur ce préfixe. Ces droits sont déclarés
   dans `infra-aws/kyc.tf` lorsque `enable_aws_kyc_permissions` est activé ; leur
   présence dans le code ne prouve pas leur déploiement effectif.
3. Sur une session synthétique autorisée, vérifier que le workflow Didit retourne
   bien les images et relever uniquement leurs **hôtes exacts**. Les champs exclus
   des « Returned data » du workflow ne seront pas disponibles : voir
   [la configuration Didit](https://help.didit.me/workflows/returned-data) et
   [l'API de résultat v3](https://docs.didit.me/sessions-api/retrieve-session).
4. Configurer `DIDIT_KYC_MEDIA_HOSTS`, garder
   `DIDIT_KYC_ARCHIVE_RETENTION_DAYS=1095`, puis activer explicitement
   `DIDIT_KYC_ARCHIVE_ENABLED=true` dans l'environnement de recette. Vérifier
   webhook/synchronisation → `pending` → `ready`, ouverture d'un JPEG par admin,
   refus hors admin et suppression complète des versions sur ce seul dossier test.
5. Après recette et autorisation de déploiement, reporter la configuration dans
   les paramètres runtime de production et redémarrer/déployer le backend.
   Aucun appel réel ni activation en production n'est inclus dans les tests locaux.

Les nouvelles validations éligibles sont collectées automatiquement après activation.
Pour un dossier antérieur, utiliser explicitement `POST /admin/kyc/:kycId/evidence`
si ses images existent toujours chez Didit. Aucun rattrapage massif automatique.

### Vérifications locales du 26 novembre

- **267 tests réussis, 13 suites** : archivage (stockage, worker, transport,
  politique), flux Didit/signatures et compatibilité AWS KYC/normalisation image.
- Une simulation avec PNG synthétiques utilise le vrai normaliseur et le vrai
  service de stockage, avec transport Didit et SDK S3 simulés : trois JPEG privés,
  manifeste v2, lecture admin auditée, métadonnées EXIF retirées et purge complète.
- Compilation backend validée avec
  `tsc --noEmit --incremental false -p tsconfig.build.json` sous Node 24.22.1.
- Pas de test PostgreSQL réel ni de suite globale relancés pour cette modification
  sans migration ; pas d'appel réel Didit/S3 ni de recette en production.

## 24 octobre 2026 — Validation serveur et signatures renforcées

- `POST /users/kyc/didit/sync` accepte toujours le champ mobile `status`, mais
  l'ignore pour décider du KYC. Une réponse fournisseur sans décision exploitable
  renvoie `502 KYC_PROVIDER_INVALID_RESPONSE` et conserve le statut enregistré.
  Aucune nouvelle version mobile n'est nécessaire pour ce correctif backend.
- Le `timestamp` signé doit être valide, récent et égal à `X-Timestamp`.
  Un message ancien avec un en-tête récent ou une V2 invalide est refusé (401).
  Utiliser une livraison de test fraîchement signée pour la recette, pas une
  ancienne capture. Les timestamps entiers Unix ou chaînes sont pris en charge.
- La variante Simple n'authentifie pas les pièces/`vendor_data`/`decision` :
  le backend doit obtenir la décision courante de l'API avant toute écriture.
  Une panne fournisseur produit une erreur réessayable, jamais une approbation
  à partir de données non signées. Le repli V2 récent, intégralement signé,
  reste disponible. Voir le [contrat officiel Didit](https://docs.didit.me/integration/webhooks).
- Pas de migration ni de nouvelle variable d'environnement. Les clés existantes
  restent inchangées ; recharger le backend pour appliquer le correctif.
- Tests et limites : [rapport de sécurité et suivi](../operations/penetration-tests-2026-10-24.md).

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
- Stockage dans le bucket applicatif, chiffré SSE-S3 AES256 : historiquement un
  bundle JSON v1 ; depuis le 26 novembre, JPEG séparés et manifeste v2 pour Didit.
  Pas de données d'identité extraites ni
  d'URL fournisseur dans les nouvelles tables SQL ; pas de lien public/présigné
  retourné au client. Limites : quatre documents et quatre contrôles selfie,
  5 Mo par image source, 24 Mo par bundle. Les absences sont signalées : `partial`
  après épuisement des tentatives, jamais un faux `ready`.
- Aucun format n'expose d'URL directe ; chaque consultation
  passe côté backend, avec au maximum deux lectures simultanées par
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
| `DIDIT_KYC_ARCHIVE_RETENTION_DAYS` | `1095` (trois ans), choix du 26 novembre. Valeur obligatoire ; `0` reste supporté pour compatibilité mais n'est plus la configuration retenue. |
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

- Ancienne décision du 8 octobre 2026, remplacée pour les nouvelles archives le
  26 novembre : conservation sans expiration automatique.
  Avec `DIDIT_KYC_ARCHIVE_RETENTION_DAYS=0`, les nouvelles archives ont
  `expiresAt: null` en base et dans l'API admin. Ce n'est pas une date très lointaine
  ni une suspension du worker de purge. La migration 62 conserve les échéances
  finies existantes ; changer la configuration ou rejouer un webhook ne prolonge
  pas les archives et ne restaure pas celles déjà purgées. Les exemples et le
  `.env` local sont désormais à `1095`, collecte désactivée. Les paramètres AWS
  doivent être mis à jour séparément après recette.
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

Sans activation de l'archivage, Zwanga ne stocke pas les images Didit ni le
payload complet de décision. Lorsque l'archivage privé est activé, les copies
JPEG et les métadonnées d'identité sélectionnées sont conservées dans S3 selon
la durée ci-dessus, mais jamais le payload complet.

Le résumé KYC courant en base conserve :

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
