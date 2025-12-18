# Correction du fichier .env pour Docker

## Problème
L'erreur `variable 'CORS_ORIGINs ' contains whitespaces` indique qu'il y a un espace dans le nom de la variable ou après le nom.

## Solution

Ouvrez votre fichier `.env` et vérifiez/corrigez la ligne `CORS_ORIGINS` :

### ❌ Incorrect (avec espace)
```env
CORS_ORIGINs =http://localhost:3000
CORS_ORIGINS =http://localhost:3000
CORS_ORIGINS= http://localhost:3000
```

### ✅ Correct (sans espaces)
```env
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

## Règles pour le fichier .env avec Docker

1. **Pas d'espaces autour du `=`** :
   - ❌ `VARIABLE = value`
   - ✅ `VARIABLE=value`

2. **Pas d'espaces dans le nom de la variable** :
   - ❌ `CORS_ORIGINs ` (avec espace à la fin)
   - ✅ `CORS_ORIGINS`

3. **Pour les valeurs avec espaces, utilisez des guillemets** :
   - ✅ `DESCRIPTION="Une description avec espaces"`

4. **Pas de lignes vides avec des espaces**

## Vérification rapide

Pour vérifier votre fichier `.env`, utilisez cette commande PowerShell :

```powershell
Get-Content .env | Select-String -Pattern "CORS_ORIGIN"
```

Cela affichera toutes les lignes contenant "CORS_ORIGIN" pour que vous puissiez voir le problème.

## Correction automatique (PowerShell)

Pour supprimer les espaces autour des `=` dans tout le fichier :

```powershell
(Get-Content .env) | ForEach-Object { $_ -replace '\s*=\s*', '=' } | Set-Content .env
```

**⚠️ Attention :** Faites une sauvegarde de votre fichier `.env` avant d'exécuter cette commande !

