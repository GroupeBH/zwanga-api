# KYC AWS — backend et application mobile

## Livraison Amplify / SSM après diagnostic du 13 octobre

Le [guide de livraison](../operations/aws-kyc-amplify-rollout-2026-10-13.md)
complète la préparation ci-dessous : dépendances Android corrigées, huit paramètres
AWS_KYC_* désormais gérés et injectés par Terraform, activation séparée et diagnostics
publics sans configuration sensible. Pas d'application AWS exécutée.

## Bascule complète préparée le 13 octobre 2026

Le nouveau mobile choisit désormais AWS par défaut, et les profils EAS `dev`,
`dev-device` et `production` fixent `EXPO_PUBLIC_KYC_PROVIDER=aws`. Une ancienne
variable Expo explicite `didit` reste un choix de retour arrière : la supprimer
ou la remplacer dans `.env.local`/l'environnement de compilation pour les tests.
Le flag historique `EXPO_PUBLIC_AWS_KYC_ENABLED` ne sélectionne plus Didit.

Avec **`KYC_PROVIDER=aws`** côté backend :

- `POST /users/kyc/didit/session` retourne HTTP 400, code
  `KYC_APP_UPDATE_REQUIRED`, avec un message demandant une mise à jour ; aucun
  appel fournisseur ni création facturable, sans provoquer une déconnexion 401/403.
  Attention : le présentateur d'erreurs du code mobile historique `1.0.16` masque
  ce message derrière une erreur générique. La nouvelle version reconnaît le code
  et affiche « Mise à jour nécessaire » ; le backend ne peut pas modifier ce rendu
  d'un ancien binaire. Prévoir une communication support/store pour ces utilisateurs.
- Les comptes déjà approuvés ne repassent pas le KYC. L'authentification, l'OTP,
  les trajets, les paiements et les décisions précédentes ne changent pas.
- Un utilisateur avec un dossier **Didit pending** peut commencer AWS. Le dossier
  Didit reste dans l'historique ; le nouveau dossier devient le dernier au commit.
  Les quotas et le verrou utilisateur restent applicables. Un double appui ne
  crée pas deux dossiers AWS. Un dossier AWS en attente, un dossier manuel legacy
  en attente ou une approbation existante restent bloquants.
- Le profil mobile permet cette reprise (passager et parcours conducteur).
  Les callbacks Didit tardifs ne remplacent pas le nouveau dossier AWS.
- La synchronisation et les webhooks Didit historiques sont conservés : ne pas
  retirer leurs clés ou secret pendant le traitement des anciens dossiers.
  En mode AWS ils peuvent encore relire les résultats, même si l'ancien flag
  `DIDIT_KYC_ENABLED` est désactivé. Seules les **nouvelles** sessions sont bloquées.
- Pas de repli implicite vers Didit après une erreur AWS. Le SDK Didit reste dans
  les sources pour compatibilité/retour arrière, mais n'est pas lancé en mode AWS.

Cette préparation **n'active pas AWS en production** : aucun apply Terraform,
changement SSM, déploiement ECS ou publication store effectué. Le `.env` backend
local était encore désactivé, sans ARN de capture configuré ; il n'est pas activé
avec un ARN fictif. Les anciennes versions sans module natif doivent être mises
à jour pour un nouveau KYC (choix produit confirmé). Une mise à jour backend/OTA
ne peut pas ajouter un module natif manquant.

### 1. Préparer les permissions, sans basculer les utilisateurs

`infra-aws/kyc.tf` ajoute des ressources **optionnelles**. Par défaut, le flag est
`false`, donc aucun rôle/policy KYC supplémentaire n'est créé. Dans le fichier
de variables de l'environnement à préparer :

```hcl
enable_aws_kyc_permissions = true
manage_aws_kyc_runtime_configuration = true
aws_kyc_enabled           = false
aws_kyc_region            = "eu-west-1"
# Facultatif pour un backend local : rôle de développement exact, du même compte.
# Ne pas utiliser une identité mobile, un wildcard ou ajouter des clés permanentes.
# aws_kyc_development_role_arns = ["arn:aws:iam::<ACCOUNT_ID>:role/<DEVELOPER_ROLE>"]
```

Puis, dans `infra-aws`, examiner un **nouveau** plan avant toute application :

```sh
terraform plan -out=aws-kyc-iam.tfplan
terraform show -no-color aws-kyc-iam.tfplan
# Uniquement après revue/accord : terraform apply aws-kyc-iam.tfplan
terraform output -json aws_kyc_runtime_configuration
```

Ajouts attendus propres à ce fichier : un rôle de capture, sa policy limitée à
`StartFaceLivenessSession`, une policy backend (Liveness/Textract/AssumeRole et
archives privées). La région est imposée pour les nouvelles permissions d'analyse.
Les anciennes permissions Rekognition/modération ne sont pas supprimées. Le rôle
de capture ne peut pas lire les pièces ni les résultats. Les credentials émis par
le backend durent 900 secondes et contiennent une policy de session restrictive.

La préparation SSM ajoute les références ECS et attend les policies IAM KYC.
`oidc.tf` et le workflow CI/CD restent inchangés.
Le fichier ne crée pas de bucket, de serveur ni de base. Vérifier réellement Block
Public Access et les policies du bucket : `AWS_S3_PUBLIC_BUCKET=false` ne change
pas ses ACL/policies AWS. Ne pas activer sur un bucket exposant les preuves.

### 2. Tester en local avec un nouveau binaire

Utiliser une base locale de test, pas la base de production. Appliquer les
migrations avec le mécanisme existant ; la migration 69 est déjà dans le dépôt,
aucune nouvelle migration n'est introduite par cette bascule. Utiliser les
identifiants temporaires du rôle de développement via la chaîne AWS habituelle ;
il lui faut les droits backend et `sts:AssumeRole` sur le rôle de capture.
Le simple ajout dans la trust policy ne lui accorde pas les droits Textract/S3.

Dans le `.env` **backend**, après préparation IAM/stockage :

```dotenv
KYC_PROVIDER=aws
AWS_KYC_ENABLED=true
AWS_KYC_REGION=eu-west-1
AWS_KYC_LIVENESS_ROLE_ARN=arn:aws:iam::<ACCOUNT_ID>:role/<LIVENESS_CAPTURE_ROLE>
AWS_S3_PUBLIC_BUCKET=false
AWS_KYC_DAILY_LIMIT=100
AWS_KYC_MONTHLY_LIMIT=1000
AWS_KYC_USER_DAILY_LIMIT=3
AWS_KYC_LIVENESS_THRESHOLD=95
AWS_KYC_FACE_THRESHOLD=95
```

Conserver `AWS_REGION` à la région réelle du bucket existant. Ne pas la remplacer
par la région Liveness si elles diffèrent. Les quotas réservent des tentatives,
pas un montant garanti de facture ; les appels réels sont facturables par AWS.
Dans le mobile, `EXPO_PUBLIC_KYC_PROVIDER=aws` et une URL API pointant vers le PC.
Recompiler Android/iOS avec le pont natif : pas Expo Go. Redémarrer le serveur
local existant et Metro après changement de configuration, sans lancer de doublon.

Recette : capacités activées → pièce recto/verso → OCR → selfie vidéo → résultat
serveur → activation du bon rôle et notification. Vérifier aussi : ancien dossier
Didit en attente, compte déjà approuvé, double appui, noms différents, caméra
refusée, réseau coupé, expiration et reprise, revue manuelle puis push admin.
Ne pas considérer les tests simulés comme une validation des vraies pièces RDC.

### 3. Livraison après recette

Les huit AWS_KYC_* sont gérés par Terraform quand la préparation runtime est
sélectionnée ; ne pas les importer depuis un `.env` en parallèle. Les paramètres
existants `KYC_PROVIDER` et `AWS_S3_PUBLIC_BUCKET` restent opérateur, **sans toucher
aux paramètres OTP**. Ne pas
mettre de credentials permanents dans le mobile. Le mécanisme Terraform existant
découvre les noms SSM : refaire un plan pour que la nouvelle task definition les
référence. Vérifier les éventuels paramètres déjà gérés par Terraform pour ne pas
créer deux sources de vérité. L'ajout SSM seul ne met pas à jour une tâche ECS active.

Publier le binaire natif testé, puis effectuer la bascule backend via le CI/CD
existant et attendre le remplacement des tâches. `AWS_KYC_ENABLED=true` active le
worker ; `KYC_PROVIDER=aws` ferme les nouvelles sessions Didit et autorise la
reprise de ses dossiers pending. Les capacités ne testent pas IAM/S3 en direct :
une vraie recette de capture reste nécessaire avant activation générale.

Les logs AWS KYC exposent désormais seulement des catégories fixes :
`ACCESS_DENIED`, `CREDENTIALS_UNAVAILABLE`, `AWS_LIMIT`, `RESOURCE_UNAVAILABLE`,
`TIMEOUT`, `INVALID_PARAMETERS`, `PROCESSING_UNAVAILABLE`. Pas de documents,
messages fournisseur bruts, credentials ou scores biométriques dans ces logs.

Retour arrière : désactiver les nouvelles tentatives via `AWS_KYC_ENABLED=false`
en tenant compte des captures en cours (elles expireront si le worker est arrêté).
Ne pas supprimer le schéma ni les archives ; rétablir Didit exige un choix explicite
côté backend/mobile et un compte fournisseur opérationnel. Aucun repli automatique.

### Vérifications de cette bascule

- Backend : suite complète, **170 suites / 1 932 tests réussis** (11 suites /
  221 tests optionnels ignorés dans cette commande). Puis **71 tests KYC ciblés**
  réussis après le dernier ajustement de lecture des dossiers Didit historiques.
- PostgreSQL isolé : **13 tests réussis**, incluant reprise Didit, doublons
  concurrents, approbation conservée et rollback d'une réservation hors quota.
  Aucune connexion à la base applicative ou de production pour ces tests.
- Mobile : **66 tests ciblés**, TypeScript et frontière réseau réussis. Suite
  complète finale : **1 915 tests réussis**. Une première exécution sous charge
  avait 2 échecs sur `activeRideResume`, sans lien de code avec KYC : ses 26 tests
  passent isolément avec Didit puis AWS ; la suite complète relancée passe aussi.
  Aucun changement de navigation de trajet effectué pour masquer ces échecs.
- Terraform : formatage du nouveau fichier et validation réussis. Lecture IAM :
  le rôle prévu `zwanga-api-production-KycCaptureRole` n'existe pas encore.
  Aucun plan appliqué ; aucun paramètre réel remplacé.
- Build Android tenté avec réseau : échec avant compilation du pont Kotlin,
  artefacts AndroidX/Compose introuvables. Leurs adresses officielles Google Maven
  renvoient aussi HTTP 404 aux lectures de diagnostic, y compris les chemins
  officiels équivalents. Pas de miroir ajouté ni version abaissée au hasard.
  iOS non compilé sous Windows ; **pas de test caméra/biométrique réel effectué**.

## Périmètre livré le 11 octobre 2026

Parcours additionnel, désactivé par défaut : carte d’électeur, passeport et permis
de conduire **émis en RDC** (`COD`). Le backend reste dans sa région actuelle ;
Rekognition Liveness, CompareFaces et Textract sont appelés en `eu-west-1`.
Pas de modification du CI/CD, de Terraform, d’ECS, des paramètres AWS réels ni de
l’OTP. Didit est conservé ; aucune bascule automatique payante vers Didit après
un échec AWS.

Avant la bascule complète décrite ci-dessus, le bundle mobile choisissait son fournisseur via
`EXPO_PUBLIC_KYC_PROVIDER=didit|aws`. Didit est le défaut ; il ne consulte pas les
capacités AWS. Le choix explicite est prioritaire sur l’ancien flag
`EXPO_PUBLIC_AWS_KYC_ENABLED`, encore reconnu uniquement si le sélecteur est absent
ou vide. Avec `aws`, l’application exige des capacités serveur activées et un
binaire contenant le pont natif Liveness. Un backend désactivé/ancien ou une panne
ne déclenche pas de session Didit de remplacement. L’activation backend
`AWS_KYC_ENABLED=true` seule ne fait pas basculer le mobile. Les actions internes
d’approbation et notifications restent communes à Didit et AWS. Guide mobile :
`zwanga/docs/AWS_KYC.md` ; aucune configuration réelle de production modifiée.

Mise à jour produit : **approbation automatique si tous les contrôles sont
concluants, revue humaine en cas de doute**. La politique versionnée
`aws-kyc-auto-v1` exige :

- émetteur RDC et un seul type autorisé cohérents ;
- champs de noms uniques correspondant exactement aux noms légaux normalisés
  du profil, avec prise en compte du post-nom lorsqu’il est lu ;
- confiance OCR d’au moins 95 sur les champs déterminants ;
- expiration lisible et non dépassée pour passeport/permis ; absence d’expiration
  admise pour la carte d’électeur, mais une expiration lue doit être valide ;
- Liveness et comparaison faciale réussis aux seuils serveur, par défaut 95.

Un champ manquant, un format de date non pris en charge, des noms ambigus,
une pièce non reconnue, des données anciennes sans ces contrôles ou un doute
sur la comparaison faciale conservent `pending` pour revue humaine. Une capture
Liveness échouée, trop peu confiante, incomplète ou expirée doit être refaite :
l’admin ne peut pas contourner cette preuve de présence réelle.

**Limite importante** : Rekognition/Textract ne certifient pas l’authenticité
d’une pièce RDC. Cette approbation automatique est une décision produit fondée
sur des contrôles de cohérence et des scores probabilistes ; elle ne prouve pas
la non-falsification, l’existence dans un registre officiel ou la validité
cryptographique/NFC. Les mises en page inconnues sont envoyées en revue plutôt
que devinées. Les taux d’approbation/erreur restent à mesurer sur des documents
réels consentis avant mise en service.

## Parcours et contrats

Toutes les routes ci-dessous sont préfixées par `/api/v1/users/kyc/aws`, requièrent
le JWT de l’utilisateur, sont limitées en fréquence et retournent `no-store`.

| Route | Usage |
| --- | --- |
| `GET /capabilities` | Activation, pièces autorisées, pays, version de consentement |
| `POST /sessions` | Multipart : `requestId` UUID v4, `documentType`, `country=COD`, `consentVersion=aws-kyc-v1`, `front`, `back` |
| `GET /sessions/current` | Reprendre le dernier dossier, 404 si aucun |
| `GET /sessions/:id` | État public du dossier appartenant à l’utilisateur |
| `POST /sessions/:id/liveness` | Créer/retrouver la session AWS, obtenir les identifiants STS temporaires |
| `POST /sessions/:id/complete` | Signaler la fin ; **aucun score, selfie ou résultat client accepté** |

Types : `voter_card`, `passport`, `driving_license`. Recto + verso pour les cartes,
page d’identité pour le passeport. Maximum 5 Mio par image, deux fichiers ; décodage
réel JPEG/PNG/WebP, taille/pixels bornés, conversion JPEG et suppression EXIF/GPS.
Le selfie de référence est récupéré exclusivement depuis AWS.

États : `uploading → documents → ready → creating → liveness → compare → review`.
`review` est un état technique terminal d’évaluation : lire **`status`** pour la
décision (`approved` automatiquement, ou `pending` si revue humaine nécessaire).
Cela conserve les états techniques introduits par la migration 69.
`failed` permet une nouvelle tentative avec un nouveau `requestId` ; répéter la
même demande ne recrée pas de dossier. Les noms sont liés à un instantané du
profil ; leur modification invalide les contrôles. Une session de capture a une
fenêtre locale de 175 secondes ; le reste du traitement a une fenêtre de 30 min.
Une interruption de capture peut nécessiter d’attendre son expiration avant de
reprendre. Fermer l’écran n’annule pas un traitement déjà soumis.

Le worker toutes les 5 secondes réserve une tâche en base avec `SKIP LOCKED`,
lease et jeton de possession ; pas d’appel réseau dans les transactions. Les
captures en cours sont prioritaires. Le serveur interroge AWS même si l’app ne
peut pas envoyer `/complete`. Une référence expirée/manquante n’est jamais
remplacée par une photo fournie par le client. Une panne prolongée ou une trop
grande file peut imposer une nouvelle capture ; ne pas promettre une durée fixe.

## Décision administrative et push

Les routes existantes `/admin/kyc/:kycId/evidence` donnent la liste des archives,
leurs détails OCR/scores et les images avec contrôle de rôle et journal d’accès.
Les URL et documents privés ne figurent pas dans le statut public AWS.

Pour approuver : `PUT /admin/kyc/:kycId/verify` avec
`{"approved":true,"reason":"Note de contrôle de la pièce, de sa validité et des noms"}`.
L’admin doit avoir consulté une image d’archive ; le contrôle de présence réelle
doit avoir réussi et la comparaison du visage doit avoir été exécutée. Un doute
de comparaison (`face=review`) peut être tranché en examinant la pièce et le selfie.
L’archive doit être disponible
et les noms du profil inchangés. La note (minimum 10 caractères) est conservée
dans la session interne, pas dans les métadonnées renvoyées à l’utilisateur.
En cas de noms OCR différents/non lisibles ou de type non reconnu, l’admin doit
vérifier les originaux photographiés et expliquer sa décision. Une pièce hors
liste doit être rejetée. Il n’existe pas de contournement administratif du
contrôle Liveness échoué dans ce parcours.

L’enregistrement du statut `approved` utilise le mécanisme transactionnel de
notifications existant : push après succès, pas de deuxième push sur une décision
identique répétée. Les règles et montants des bonus ne sont pas modifiés.
Une application d’administration qui n’affiche pas encore les archives et la note
doit utiliser ces API ou adapter son formulaire avant de traiter des dossiers AWS.

### Hook interne d’approbation et rôle du compte

Le besoin confirmé est **interne à Zwanga**, sans destinataire HTTP externe.
`applyKycApprovalHook` (`src/users/kyc-approval.hook.ts`) est appelé par le subscriber
transactionnel sur un nouveau passage à `approved`, qu’il vienne de l’admin,
du worker AWS, de Didit ou du parcours historique. Le webhook Didit signé existant
reste `POST /api/v1/users/kyc/didit/webhook`. Aucun endpoint public capable de
valider un compte n’a été ajouté.

1. La source autorisée enregistre sa décision sous verrou utilisateur/KYC.
2. Le hook relit le **dernier dossier** et le compte, dans la même transaction.
3. Pour un compte actif non suspendu : statut de compte `active`. S’il était
   passager et possède déjà un véhicule **actif qui lui appartient**, rôle
   `driver`, `isDriver=true` et dates d’activation/intention renseignées. L’ancienne
   intention explicite n’est plus un prérequis à cette nouvelle approbation.
4. Sans véhicule actif : le compte reste passager, avec KYC `approved`. Un
   conducteur existant n’est pas rétrogradé ; un admin n’est pas converti.
   Suspension/désactivation ne sont jamais levées par le hook.
5. La notification est ajoutée à l’outbox dans cette même transaction. Tout échec
   annule ensemble décision, activation et notification. Le push est envoyé
   uniquement après commit, avec le mécanisme existant de reprise.

Les décisions répétées n’activent pas deux fois le compte et n’ajoutent pas un
second événement. Une décision admin sur un ancien dossier est refusée. Pas de
réactivation massive des comptes déjà approuvés ni d’attribution de rôle lors
d’un simple GET. L’ajout ultérieur d’un véhicule garde le parcours conducteur
existant ; le nouveau hook concerne les véhicules présents à l’approbation.

Dans le mobile, réception/appui du push KYC → invalidation du profil → lecture
`/users/me` → synchronisation du rôle confirmé. Aucun rôle n’est accordé à partir
du contenu d’un push. Le parcours affiche « Vérification complémentaire »
uniquement pour les dossiers réellement en revue manuelle.

## Stockage et conservation

Le bucket privé existant (`AWS_S3_BUCKET_NAME`, région `AWS_REGION`) stocke des
instantanés immuables sous `kyc/evidence/<archive>/<uuid>.json`, chiffrés SSE-S3,
contenant les images, leur SHA-256, le texte OCR, les noms du profil et les résultats.
Aucun bucket Liveness supplémentaire : `GetFaceLivenessSessionResults` retourne
les octets au backend. Ne pas rendre ce préfixe public ni l’exposer via CDN.

Conservation sans expiration automatique, conformément au choix produit exprimé.
Ce choix ne remplace pas l’analyse des obligations de protection des données ni
la politique de confidentialité : faire valider la base applicable et les droits
des utilisateurs avant lancement. Consentement explicite versionné dans l’app.
La suppression du compte ou la demande de purge administrative conserve le
mécanisme existant d’effacement des objets **et de leurs versions**, avec traces
d’accès. Les compteurs de tentatives ne sont pas effacés avec les documents.

## Configuration et IAM — à réaliser séparément

La migration additive `1780000069000-AwsKycSessions` ajoute les sessions, les
compteurs de quota et la valeur de provider `aws`. Appliquer via le processus de
migration existant, **avant** d’activer le parcours. `synchronize` reste interdit
en production. Aucun retour arrière destructif : désactiver le flag et conserver
le schéma/les preuves en attendant une procédure de conservation explicite.

```dotenv
AWS_KYC_ENABLED=false
AWS_KYC_REGION=eu-west-1
AWS_KYC_LIVENESS_ROLE_ARN=arn:aws:iam::<ACCOUNT_ID>:role/<LIVENESS_CAPTURE_ROLE>
AWS_KYC_DAILY_LIMIT=100
AWS_KYC_MONTHLY_LIMIT=1000
AWS_KYC_USER_DAILY_LIMIT=3
AWS_KYC_LIVENESS_THRESHOLD=95
AWS_KYC_FACE_THRESHOLD=95
```

Ces variables sont celles du **backend**, pas des variables Expo publiques.
Conserver `AWS_S3_PUBLIC_BUCKET=false` et un bucket réellement privé avec Block
Public Access. Le backend utilise sa chaîne d’identifiants AWS habituelle (rôle
de tâche ECS en production), aucune clé permanente embarquée dans le mobile.

Permissions du rôle backend, à limiter à la région de traitement :

- `rekognition:CreateFaceLivenessSession`, `rekognition:GetFaceLivenessSessionResults`,
  `rekognition:DetectFaces`, `rekognition:CompareFaces` ;
- `textract:DetectDocumentText` (pas `AnalyzeID`, qui ne couvre pas ces pièces RDC) ;
- `sts:AssumeRole` sur le seul rôle de capture ;
- droits existants `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`,
  `s3:DeleteObjectVersion` sur le préfixe des preuves et `s3:ListBucketVersions`
  sur le bucket avec condition de préfixe.

Le rôle de capture fait confiance **uniquement au rôle backend**. Sa permission
est limitée à `rekognition:StartFaceLivenessSession`, `Resource: "*"`, condition
`aws:RequestedRegion=eu-west-1`. La session STS ajoute cette même restriction,
expire en 900 secondes, et n’autorise ni création/lecture de session ni S3.
AWS ne fournit pas de restriction IAM à l’ARN d’une session Liveness : le `*`
est requis ici, les identifiants UUID et l’appartenance sont contrôlés côté backend.

## Budget, compatibilité et mise en service

Les réservations sont atomiques et persistantes : 100 tentatives/jour,
1 000/mois, 3/utilisateur/jour par défaut, périodes UTC. Ce sont des plafonds de
volume **pas des plafonds financiers AWS**. Une tentative réserve sa place avant
les appels payants et n’est pas remboursée après une erreur. Trois exécutions au
maximum de chaque phase OCR/comparaison, y compris après crash du worker ; SDK
sans relance implicite pour ces appels. Conserver aussi des alertes AWS Budgets.
S3, trafic, reprises et revue humaine s’ajoutent au coût unitaire des analyses.

Les endpoints Didit restent inchangés. Un callback Didit tardif ne remplace pas un
dossier AWS plus récent. Quand AWS est activé, l’ancien endpoint d’envoi de photos
reste accepté **pour revue manuelle**, sans son ancienne approbation automatique
Rekognition dépourvue de Liveness. Il n’écrase pas un dossier plus récent.
Les anciens stores ne reçoivent pas magiquement le SDK natif : ils restent sur
leur parcours existant. Pas de modification du format de statut `pending/approved/rejected`.

Ordre conseillé : migration et déploiement backend flag désactivé ; IAM/stockage ;
compilation et recette mobile sur environnement de test avec les deux flags activés ; test
de plusieurs vraies pièces consenties et des rejets ; calibration des seuils ;
formation/revue admin ; publication mobile ; activation contrôlée. Aucun test
avec des données réelles ni appel AWS payant n’a été effectué durant cette livraison.

## Vérifications locales

- Build backend et tests de politique/worker ; régression Didit/admin.
- Tests PostgreSQL isolés : doublons simultanés, plafond global concurrent,
  propriétaire, leases, changement de noms, suppression et maintien des quotas.
- Suite backend exécutée après cette évolution : 164 suites passées, 1 796 tests passés ; 11 suites
  d’intégration optionnelles ignorées dans cette commande générale.
- Vérification PostgreSQL séparée : 37 tests passés (KYC et outbox), notamment
  activation avec/sans véhicule, propriétaire, deux approbations admin simultanées
  et rollback intégral de la décision/du rôle/du push.
- Tests mobile ciblés après sélection explicite du fournisseur : 63 passés, dont
  priorité de configuration, parcours Didit/AWS et refus des bascules implicites ; TypeScript et
  frontière réseau vérifiés séparément. Ce ne sont pas des essais caméra.
- Compilation et essais iOS nécessitent macOS/Xcode ; validation physique Android
  et iOS obligatoire, notamment annulation, réseau lent, rotation, arrière-plan,
  refus caméra, double appui, reprise et notification après décision.
- La compilation Android tentée a échoué sur les téléchargements des dépôts
  Google/Maven (AndroidX, Hermes, etc.), avant validation du module Kotlin.
  Nouvel essai mobile hors ligne le 13 octobre : dépendances AndroidX/Compose/Hermes
  absentes du cache. Reprendre avec accès réseau aux dépôts officiels.
  Aucun succès natif revendiqué.

## Références officielles vérifiées

- [AWS Face Liveness](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness.html)
- [Résultats Liveness récupérés par le backend](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_GetFaceLivenessSessionResults.html)
- [Composant Android et credentials personnalisés](https://ui.docs.amplify.aws/android/connected-components/liveness)
- [Composant Swift](https://ui.docs.amplify.aws/swift/connected-components/liveness)
- [Textract : limites et documents](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)
- [Textract : seuils de confiance et revue humaine](https://docs.aws.amazon.com/textract/latest/dg/textract-best-practices.html)
- [Rekognition : limites probabilistes et seuils](https://docs.aws.amazon.com/rekognition/latest/dg/thresholds-collections.html)
