# Guide de configuration Firebase Cloud Messaging (FCM)

## Option 1: Utiliser le fichier JSON complet en base64 (Recommandé)

Cette méthode est plus simple et sécurisée car elle utilise le fichier JSON complet fourni par Firebase.

### Étapes :

1. **Télécharger le fichier de clé de compte de service depuis Firebase Console**
   - Allez sur https://console.firebase.google.com/
   - Sélectionnez votre projet
   - Paramètres du projet > Comptes de service
   - Cliquez sur "Générer une nouvelle clé privée"
   - Téléchargez le fichier JSON (ex: `service-account-key.json`)

2. **Encoder le fichier en base64**

   **Sur Linux/Mac :**
   ```bash
   cat service-account-key.json | base64
   ```

   **Sur Windows (PowerShell) :**
   ```powershell
   $content = Get-Content -Path "service-account-key.json" -Raw -Encoding UTF8
   [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))
   ```

   **Sur Windows (CMD avec certutil) :**
   ```cmd
   certutil -encode service-account-key.json temp.txt
   type temp.txt
   del temp.txt
   ```

3. **Copier le résultat dans `.env`**
   ```env
   FCM_CREDENTIALS_BASE64=<votre-chaîne-base64>
   ```

## Option 2: Utiliser les credentials individuels

Si vous préférez utiliser les variables individuelles, vous pouvez encoder uniquement la clé privée en base64.

### Étapes :

1. **Extraire les valeurs du fichier JSON**
   - `project_id` → `FCM_PROJECT_ID`
   - `client_email` → `FCM_CLIENT_EMAIL`
   - `private_key` → Encoder en base64 pour `FCM_PRIVATE_KEY`

2. **Encoder la clé privée en base64**

   **Sur Linux/Mac :**
   ```bash
   echo -n "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" | base64
   ```

   **Sur Windows (PowerShell) :**
   ```powershell
   $privateKey = "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($privateKey))
   ```

3. **Configurer dans `.env`**
   ```env
   FCM_PROJECT_ID=votre-project-id
   FCM_CLIENT_EMAIL=votre-client-email@project.iam.gserviceaccount.com
   FCM_PRIVATE_KEY=<votre-clé-privée-base64>
   ```

## Note de sécurité

⚠️ **Important** : Ne commitez jamais le fichier `.env` ou les fichiers de credentials Firebase dans votre dépôt Git. Ils contiennent des informations sensibles.

Le fichier `.env` est déjà dans `.gitignore` pour éviter les commits accidentels.

