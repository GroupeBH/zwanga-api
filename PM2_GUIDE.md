# Guide PM2 - Gestion des processus

PM2 est un gestionnaire de processus pour les applications Node.js qui permet de maintenir l'application en vie, de la redémarrer automatiquement et de gérer le clustering.

## Installation

PM2 est déjà inclus dans les dépendances du projet. Si nécessaire, installez-le globalement :

```bash
npm install -g pm2
```

## Configuration

Le fichier `ecosystem.config.js` contient la configuration PM2 pour l'application.

### Configuration actuelle :
- **Mode cluster** : Utilise tous les CPU disponibles
- **Instances** : Maximum (une par CPU)
- **Auto-restart** : Activé
- **Memory limit** : Redémarre si > 1GB
- **Logs** : Stockés dans `./logs/`

## Commandes disponibles

### Scripts npm :

```bash
# Démarrer l'application avec PM2
npm run pm2:start

# Arrêter l'application
npm run pm2:stop

# Redémarrer l'application
npm run pm2:restart

# Supprimer l'application de PM2
npm run pm2:delete

# Voir les logs
npm run pm2:logs

# Monitoring en temps réel
npm run pm2:monit
```

### Commandes PM2 directes :

```bash
# Démarrer
pm2 start ecosystem.config.js

# Démarrer en mode production
pm2 start ecosystem.config.js --env production

# Arrêter
pm2 stop zwanga-backend

# Redémarrer
pm2 restart zwanga-backend

# Supprimer
pm2 delete zwanga-backend

# Voir le statut
pm2 status

# Voir les logs
pm2 logs zwanga-backend

# Monitoring
pm2 monit

# Sauvegarder la configuration actuelle
pm2 save

# Configurer PM2 pour démarrer au boot (Linux)
pm2 startup
pm2 save
```

## Workflow de déploiement

### 1. Build de l'application

```bash
npm run build
```

### 2. Démarrer avec PM2

```bash
npm run pm2:start
```

### 3. Vérifier le statut

```bash
pm2 status
```

### 4. Voir les logs

```bash
npm run pm2:logs
```

## Monitoring

PM2 fournit plusieurs outils de monitoring :

- **pm2 monit** : Interface de monitoring en temps réel
- **pm2 logs** : Affichage des logs en temps réel
- **pm2 status** : Statut des processus

## Redémarrage automatique

PM2 redémarre automatiquement l'application en cas de :
- Crash de l'application
- Redémarrage du serveur (si configuré avec `pm2 startup`)
- Changement de fichiers (si `watch: true`)

## Logs

Les logs sont stockés dans le dossier `./logs/` :
- `pm2-error.log` : Erreurs
- `pm2-out.log` : Sortie standard
- `pm2-combined.log` : Logs combinés

## Performance

Le mode cluster permet de :
- Utiliser tous les CPU disponibles
- Répartir la charge entre les instances
- Améliorer la disponibilité (si une instance crash, les autres continuent)

## Variables d'environnement

Les variables d'environnement sont chargées depuis le fichier `.env`. Pour utiliser différentes configurations :

```bash
# Développement
pm2 start ecosystem.config.js --env development

# Production
pm2 start ecosystem.config.js --env production
```

## Dépannage

### L'application ne démarre pas
```bash
pm2 logs zwanga-backend --err
```

### Redémarrer après modification du code
```bash
npm run build
pm2 restart zwanga-backend
```

### Vider les logs
```bash
pm2 flush
```

