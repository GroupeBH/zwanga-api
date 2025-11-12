# Configuration Amazon S3 et AWS Rekognition

Ce guide explique comment configurer Amazon S3 pour le stockage des fichiers multimédias et AWS Rekognition pour la modération de contenu.

## 📋 Prérequis

1. Compte AWS avec accès à :
   - Amazon S3
   - AWS Rekognition
2. Credentials AWS (Access Key ID et Secret Access Key)

## 🔧 Configuration Amazon S3

### 1. Créer un bucket S3

1. Connectez-vous à la console AWS S3
2. Cliquez sur "Create bucket"
3. Configurez le bucket :
   - **Bucket name** : `zwanga-media` (ou un nom unique de votre choix)
   - **Region** : Choisissez la région la plus proche (ex: `us-east-1`, `eu-west-1`, `af-south-1`)
   - **Block Public Access** : 
     - Si vous voulez des URLs publiques : Désactivez "Block all public access"
     - Si vous préférez des URLs présignées : Gardez activé (recommandé pour la sécurité)
   - **Versioning** : Optionnel, recommandé pour la production
   - **Encryption** : Recommandé (AES-256 ou AWS KMS)

### 2. Configurer les permissions IAM

Créez un utilisateur IAM avec les permissions suivantes :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:PutObjectAcl"
      ],
      "Resource": "arn:aws:s3:::zwanga-media/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::zwanga-media"
    }
  ]
}
```

### 3. Créer les credentials

1. Allez dans IAM > Users > [Votre utilisateur] > Security credentials
2. Cliquez sur "Create access key"
3. Choisissez "Application running outside AWS"
4. Sauvegardez l'**Access Key ID** et le **Secret Access Key**

## 🛡️ Configuration AWS Rekognition

### 1. Activer AWS Rekognition

AWS Rekognition est disponible dans toutes les régions AWS. Assurez-vous d'utiliser la même région que votre bucket S3.

### 2. Permissions IAM pour Rekognition

Ajoutez cette permission à votre utilisateur IAM :

```json
{
  "Effect": "Allow",
  "Action": [
    "rekognition:DetectModerationLabels"
  ],
  "Resource": "*"
}
```

### 3. Coûts

AWS Rekognition facture par image analysée :
- **Premiers 1 million d'images/mois** : Gratuit
- **Au-delà** : $1.00 pour 1,000 images

Voir [AWS Rekognition Pricing](https://aws.amazon.com/rekognition/pricing/) pour plus de détails.

## ⚙️ Variables d'environnement

Ajoutez ces variables à votre fichier `.env` :

```env
# Amazon S3 Configuration
AWS_S3_BUCKET_NAME=zwanga-media
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key

# Optionnel: Si votre bucket est public (défaut: false)
AWS_S3_PUBLIC_BUCKET=false

# Expiration des URLs présignées en secondes (défaut: 3600 = 1 heure)
AWS_S3_PRESIGNED_URL_EXPIRES_IN=3600

# AWS Rekognition - Modération de contenu
# Activez la modération (défaut: false)
AWS_REKOGNITION_ENABLED=true

# Seuil de confiance minimum pour les labels de modération (0-100, défaut: 50)
AWS_REKOGNITION_MIN_CONFIDENCE=50
```

## 🔒 Sécurité

### Bucket privé avec URLs présignées (Recommandé)

1. Gardez `AWS_S3_PUBLIC_BUCKET=false`
2. Les fichiers sont privés par défaut
3. Les URLs présignées expirent après 1 heure (configurable)
4. Plus sécurisé pour les données sensibles (KYC, photos de profil)

### Bucket public

1. Configurez `AWS_S3_PUBLIC_BUCKET=true`
2. Configurez une politique de bucket publique :
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::zwanga-media/*"
    }
  ]
}
```
3. Les URLs sont permanentes et publiques
4. Moins sécurisé mais plus simple

## 🚫 Modération de contenu

Le service de modération détecte automatiquement :

- **Contenu explicite** : Nudité, contenu sexuel
- **Violence** : Violence graphique, armes, autodestruction
- **Contenu choquant** : Sang, cadavres, explosions
- **Drogues et substances** : Produits et usage de drogues, tabac, alcool
- **Symboles de haine** : Symboles nazis, extrémisme
- **Harcèlement** : Abus émotionnel, spam
- **Activités illégales** : Terrorisme, activités criminelles

### Comportement

- Si du contenu inapproprié est détecté : **L'upload est rejeté** avec un message d'erreur
- Si la modération échoue : Par défaut, l'upload est bloqué (configurable dans le code)
- Seuil de confiance : Seuls les labels avec une confiance ≥ `AWS_REKOGNITION_MIN_CONFIDENCE` sont considérés

## 📝 Exemple de configuration complète

```env
# S3 activé
AWS_S3_BUCKET_NAME=zwanga-media
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_S3_PUBLIC_BUCKET=false
AWS_S3_PRESIGNED_URL_EXPIRES_IN=3600

# Modération activée
AWS_REKOGNITION_ENABLED=true
AWS_REKOGNITION_MIN_CONFIDENCE=50
```

## 🔄 Fallback vers stockage local

Si `AWS_S3_BUCKET_NAME` n'est pas défini, le système utilise automatiquement le stockage local dans `./uploads/`.

## 🧪 Test de la configuration

1. Démarrez l'application
2. Essayez d'uploader une image via l'endpoint `/api/v1/auth/register`
3. Vérifiez les logs pour confirmer l'upload vers S3
4. Testez avec une image inappropriée pour vérifier la modération

## 📚 Ressources

- [Documentation AWS S3](https://docs.aws.amazon.com/s3/)
- [Documentation AWS Rekognition](https://docs.aws.amazon.com/rekognition/)
- [AWS Rekognition Moderation Labels](https://docs.aws.amazon.com/rekognition/latest/dg/moderation.html)

