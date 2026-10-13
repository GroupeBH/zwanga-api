# Livraison AWS KYC / Amplify — 13 octobre 2026

## État et périmètre

Le parcours KYC existe déjà : Textract, Rekognition Liveness/CompareFaces,
preuve privée S3 et décision serveur. Amplify UI fournit le composant de capture
natif Android/iOS ; il ne remplace ni NestJS, ni l'authentification Zwanga.
Pas de Cognito, Amplify Hosting, clé permanente mobile ou nouveau fournisseur.

Le build Android joint échouait sur des ELF de Liveness 1.5.0 et TensorFlow Lite
2.7.0. Le mobile passe à Liveness 1.6.0 et à ses dépendances LiteRT 1.4.0. Le
plugin migre le bloc Gradle géré, reste idempotent et refuse une version personnalisée
à revoir. Le garde 16 Ko et les quatre architectures sont conservés. iOS n'est pas
mis à niveau avec ce numéro de version Android ; ses packages Swift restent inchangés.

La production examinée avait une tâche sans les paramètres AWS_KYC_* et sans le
rôle de capture attendu. Le bucket consulté bloquait les accès publics, sans policy
de bucket. Ces lectures ne valident pas une vraie capture ni toutes les autorisations.

**Les fichiers sont préparés localement, pas appliqués sur AWS.** Aucune session
AWS payante, modification SSM, publication store ou activation en production.
Les capacités publiques distinguent maintenant `AWS_KYC_DISABLED` et
`AWS_KYC_CONFIGURATION_REQUIRED`, sans exposer de configuration. Une capacité
activée indique une configuration syntaxiquement prête, pas un test IAM/S3 réel.

## 1. Préparer IAM et SSM, sans activer les captures

Terraform >= 1.10, accès au compte de provisioning et au state S3 existant.
Ne pas recréer le state, ne pas lancer le bootstrap et ne pas réutiliser l'ancien
plan Didit. Dans `production.auto.tfvars`, la préparation est déjà sélectionnée :

```hcl
enable_aws_kyc_permissions           = true
manage_aws_kyc_runtime_configuration = true
aws_kyc_region                      = "eu-west-1"
aws_kyc_enabled                     = false
```

Depuis le dépôt backend :

```powershell
terraform -chdir=infra-aws init
terraform -chdir=infra-aws fmt -check
terraform -chdir=infra-aws validate
terraform -chdir=infra-aws plan -out=aws-kyc-prepare.tfplan
terraform -chdir=infra-aws show -no-color aws-kyc-prepare.tfplan
# Après revue et accord seulement :
terraform -chdir=infra-aws apply aws-kyc-prepare.tfplan
```

L'application prépare un rôle de capture et ses permissions limitées, la policy
backend, huit SecureString chiffrés par le KMS existant et leurs références ECS.
Les quotas/seuils sont configurables dans `aws_kyc_limits`, bornés comme le backend.
L'activation reste désactivée : ni worker ni capture facturable ne démarrent avec
la seule préparation. Pas de nouvelle base, bucket, serveur ou déplacement d'ECS/S3.

Examiner le plan entier : d'autres changements du worktree peuvent être présents.
Ne pas accepter un remplacement inattendu de RDS/Redis/S3/KMS. Garder le fichier
plan hors Git et ne pas le partager : il peut contenir des secrets du state.
Si un AWS_KYC_* existe déjà, l'importer dans la ressource correspondante avant
l'application ; ne pas l'écraser ou le déclarer dans deux sources de configuration.

`KYC_PROVIDER` et `AWS_S3_PUBLIC_BUCKET` restent des paramètres existants
opérateur : pas d'import ni de remplacement silencieux par ce changement.
La région Liveness ne remplace pas `AWS_REGION`, qui reste celle du stockage.

## 2. Recette native avant bascule générale

Pour le backend local, utiliser une base de test et une identité AWS temporaire
autorisée à analyser, archiver et assumer le rôle de capture. La confiance du rôle
de capture seule ne suffit pas. Ne pas donner de clés permanentes au mobile.
Vérifier les migrations existantes (dont 69) via la procédure normale ; pas de
nouvelle migration introduite ici. Activer uniquement le backend de recette.

Depuis le dépôt mobile :

```powershell
npx.cmd eas-cli build --platform android --profile dev-device
npx.cmd eas-cli build --platform ios --profile dev-device
```

Ces commandes créent de vrais builds EAS et peuvent consommer des crédits : elles
n'ont pas été lancées pour ce correctif. Le pont natif exige un nouveau binaire,
pas Expo Go ni une OTA envoyée à un ancien binaire sans module.

Tester sur Android physique, puis sur iPhone physique : pièce RDC consentie,
recto/verso ou passeport, OCR, vidéo, retour dans Zwanga, décision relue du serveur.
Tester faible lumière, caméra refusée, annulation, réseau coupé, expiration,
double appui, dossier Didit pending, compte déjà approuvé et revue humaine.
Vérifier aussi l'AAB/APK final et un appareil/émulateur configuré en pages 16 Ko.
Le contrôle d'AAR seul ne valide pas le packaging ZIP du binaire final.

## 3. Activation et livraison

Après recette et publication du binaire compatible, activer `aws_kyc_enabled` et
examiner un nouveau plan Terraform avant application. Configurer les deux paramètres
opérateur existants selon le guide KYC : fournisseur AWS et stockage non public.
Conserver les secrets/webhooks Didit historiques pour les dossiers déjà créés.
Ne pas toucher aux paramètres OTP.

Livrer le backend par le CI/CD `release` existant. Terraform enregistre la
configuration ; le service ECS ne bascule pas directement sa task definition.
Le workflow utilise la dernière configuration de la famille, remplace son image,
exécute les migrations normales puis remplace les tâches. Ne pas lancer un
redémarrage aveugle de l'ancienne révision, qui n'injecte pas les paramètres KYC.
Vérifier la nouvelle révision, les huit noms injectés, la santé ALB/ECS et une
vraie vérification. Les comptes approuvés et les règles de rôle/bonus sont conservés.

## Surveillance, limites et retour arrière

Surveiller les catégories AWS (permissions, credentials, throttling, timeout),
les quotas, les dossiers bloqués, les expirations et le coût des opérations réelles.
Ne jamais logger images, clés STS, texte OCR ou résultats biométriques bruts.
Rekognition/Textract ne certifient pas l'authenticité d'une pièce ni un registre RDC.

Pour stopper les nouvelles captures : `aws_kyc_enabled=false`, plan revu puis
application et remplacement des tâches par le mécanisme normal. Le worker s'arrête
aussi : une capture en cours peut expirer ; prévenir et permettre une nouvelle
tentative après rétablissement. Ne pas supprimer les paramètres, le rôle, les
tables ou les archives pour simuler un rollback. Les paramètres sont protégés par
`prevent_destroy` ; la suppression exige une procédure distincte relue.
Rétablir Didit nécessite un choix explicite et un fournisseur fonctionnel.

## Vérifications réalisées

Vérifications locales : 92 tests backend ciblés réussis (13 tests PostgreSQL
optionnels ignorés), compilation backend réussie, formatage/validation Terraform
réussis. Les 64 tests mobiles ciblés, TypeScript et frontière réseau passent.
Les huit ELF des AAR Liveness/LiteRT téléchargés depuis les dépôts officiels passent
le contrôle, et Gradle ne trouve plus d'ancien TensorFlow Lite dans le graphe.
Une première compilation Android a été bloquée par des téléchargements AndroidX,
pas déclarée réussie. Les deux adresses officielles relues répondent HTTP 200 ;
la relance avec `--refresh-dependencies` dépasse ce blocage mais échoue ensuite
sur `hermes-engine:configureBuildForHermes` : `nmake` et le compilateur C/C++ de
l'hôte Windows sont absents. Pas d'installation système lourde ni de suppression
du patch React Native pour contourner ce contrôle. Le binaire final doit donc
être recompilé dans EAS/Linux (ou sur un hôte correctement équipé), puis vérifié.
iOS n'est pas compilé sur le PC Windows et aucune caméra
physique n'a été testée dans cette préparation.

Plan réel de préparation sauvegardé, non appliqué : **12 créations, 0 modification,
1 suppression**, cette dernière correspondant uniquement au remplacement de la
définition de tâche Terraform. Pas de changement du service ECS actif ni de
RDS/Redis/S3/KMS. Lecture structurée du plan confirme l'activation désactivée.
Le plan reste un artefact sensible, non versionné ; le régénérer si le code ou
l'infrastructure change avant application.

## Références

- [Correctif AWS Liveness Android 16 Ko](https://github.com/aws-amplify/amplify-ui-android/releases/tag/release_liveness_v1.6.0)
- [Capture et décision Rekognition](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness.html)
- [Credentials personnalisés Amplify](https://ui.docs.amplify.aws/android/connected-components/liveness)
