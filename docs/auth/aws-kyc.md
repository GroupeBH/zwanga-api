# KYC AWS — backend et application mobile

## Périmètre livré le 11 octobre 2026

Parcours additionnel, désactivé par défaut : carte d’électeur, passeport et permis
de conduire **émis en RDC** (`COD`). Le backend reste dans sa région actuelle ;
Rekognition Liveness, CompareFaces et Textract sont appelés en `eu-west-1`.
Pas de modification du CI/CD, de Terraform, d’ECS, des paramètres AWS réels ni de
l’OTP. Didit est conservé ; aucune bascule automatique payante vers Didit après
un échec AWS.

Depuis le 13 octobre 2026, le bundle mobile choisit son fournisseur via
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
