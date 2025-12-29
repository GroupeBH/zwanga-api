# Guide de Déploiement Production - Chatbot Ollama

Ce guide explique comment déployer le chatbot avec Ollama en production.

## 🎯 Options de Déploiement

### Option 1 : Docker Compose (Recommandé) ⭐

La solution la plus simple et recommandée est d'ajouter Ollama à votre `docker-compose.yml` existant.

#### Avantages
- ✅ Isolation complète
- ✅ Facile à gérer et mettre à jour
- ✅ Configuration centralisée
- ✅ Pas besoin d'installer Ollama sur le serveur

#### Configuration

1. **Ajoutez Ollama à votre `docker-compose.yml`** :

```yaml
services:
  # ... vos autres services (postgres, redis, api)
  
  ollama:
    image: ollama/ollama:latest
    container_name: zwanga-ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    networks:
      - zwanga-network
    restart: unless-stopped
    # Optionnel : limiter les ressources
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          cpus: '1.0'
          memory: 2G

volumes:
  # ... vos autres volumes
  ollama_data:
    driver: local
```

2. **Mettez à jour votre `.env`** :

```env
# Configuration Ollama pour Docker
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2
```

3. **Démarrer les services** :

```bash
docker-compose up -d ollama
# Attendre que Ollama démarre (environ 10-15 secondes)
docker-compose exec ollama ollama pull llama3.2
docker-compose up -d
```

---

### Option 2 : Installation Directe sur le Serveur

Si vous préférez installer Ollama directement sur votre serveur de production.

#### Étapes

1. **Installer Ollama** :

```bash
# Sur Ubuntu/Debian
curl -fsSL https://ollama.ai/install.sh | sh

# Ou sur d'autres systèmes
# Voir https://ollama.ai/download
```

2. **Télécharger un modèle** :

```bash
ollama pull llama3.2
# Ou un modèle plus léger pour la production
ollama pull phi3  # Plus léger, nécessite moins de RAM
```

3. **Créer un service systemd** (optionnel mais recommandé) :

```bash
sudo nano /etc/systemd/system/ollama.service
```

Contenu :

```ini
[Unit]
Description=Ollama Service
After=network.target

[Service]
Type=simple
User=ollama
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Activer le service :

```bash
sudo systemctl enable ollama
sudo systemctl start ollama
sudo systemctl status ollama
```

4. **Configuration `.env`** :

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

---

### Option 3 : Service Ollama Distant/Séparé

Si vous avez un serveur dédié pour Ollama ou utilisez un service cloud.

#### Configuration

1. **Installer Ollama sur un serveur séparé** (suivre Option 2)

2. **Sécuriser l'accès** (IMPORTANT pour la production) :

```bash
# Option A : Utiliser un reverse proxy avec authentification
# Option B : Utiliser un VPN/network privé
# Option C : Utiliser Ollama avec authentification (si disponible)
```

3. **Configuration `.env`** :

```env
OLLAMA_BASE_URL=http://ollama-server.example.com:11434
OLLAMA_MODEL=llama3.2
```

⚠️ **Sécurité** : Ne jamais exposer Ollama directement sur Internet sans protection !

---

## 🔒 Sécurité en Production

### 1. Ne pas exposer Ollama publiquement

Ollama ne doit être accessible que depuis votre backend, pas depuis Internet.

**Docker Compose** : Utilisez le réseau interne Docker (`zwanga-network`)

**Serveur séparé** : 
- Utilisez un VPN ou réseau privé
- Configurez un reverse proxy avec authentification
- Utilisez un firewall pour bloquer l'accès externe au port 11434

### 2. Limiter les ressources

Dans `docker-compose.yml` :

```yaml
ollama:
  deploy:
    resources:
      limits:
        cpus: '2.0'
        memory: 4G
```

### 3. Monitoring

Surveillez l'utilisation des ressources :

```bash
# Vérifier l'utilisation
docker stats zwanga-ollama

# Ou sur serveur direct
htop
# ou
top
```

---

## 📊 Choix du Modèle pour la Production

### Modèles Recommandés

| Modèle | Taille | RAM Requise | Vitesse | Qualité |
|--------|--------|-------------|---------|---------|
| **phi3** | 3.8B | ~2.5GB | ⚡⚡⚡ | ⭐⭐⭐ |
| **llama3.2** | 3B | ~2GB | ⚡⚡⚡ | ⭐⭐⭐⭐ |
| **mistral** | 7B | ~4.5GB | ⚡⚡ | ⭐⭐⭐⭐⭐ |
| **llama3.1** | 8B | ~5GB | ⚡⚡ | ⭐⭐⭐⭐⭐ |

**Recommandation pour production** : `phi3` ou `llama3.2` pour un bon équilibre vitesse/qualité.

### Télécharger un modèle

```bash
# Dans Docker
docker-compose exec ollama ollama pull phi3

# Sur serveur direct
ollama pull phi3
```

---

## 🚀 Déploiement avec PM2

Si vous utilisez PM2 (comme dans votre `ecosystem.config.js`), ajoutez Ollama comme service séparé :

### Option A : Ollama dans Docker + Backend avec PM2

1. Démarrer Ollama avec Docker :
```bash
docker-compose up -d ollama
```

2. Backend avec PM2 :
```bash
pm2 start ecosystem.config.js --env production
```

### Option B : Ollama comme service systemd + Backend avec PM2

1. Installer Ollama sur le serveur (Option 2)
2. Démarrer Ollama :
```bash
sudo systemctl start ollama
```

3. Backend avec PM2 :
```bash
pm2 start ecosystem.config.js --env production
```

---

## 🔧 Configuration des Variables d'Environnement

Ajoutez dans votre `.env` de production :

```env
# ============================================
# Chatbot Ollama
# ============================================
# URL du service Ollama (interne Docker ou localhost)
OLLAMA_BASE_URL=http://ollama:11434
# Pour installation directe : http://localhost:11434
# Pour service distant : http://ollama-server:11434

# Modèle à utiliser (phi3 recommandé pour production)
OLLAMA_MODEL=phi3
# Alternatives : llama3.2, mistral, llama3.1
```

---

## ✅ Checklist de Déploiement

- [ ] Ollama installé et démarré
- [ ] Modèle téléchargé (`ollama pull <model>`)
- [ ] Variables d'environnement configurées
- [ ] Ollama accessible depuis le backend (test de connexion)
- [ ] Sécurité : Ollama non exposé publiquement
- [ ] Monitoring des ressources configuré
- [ ] Tests du chatbot effectués
- [ ] Rate limiting activé (déjà configuré dans le controller)

---

## 🧪 Tests de Vérification

### 1. Vérifier que Ollama fonctionne

```bash
# Dans Docker
docker-compose exec ollama ollama list

# Sur serveur direct
ollama list
```

### 2. Tester une requête

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "phi3",
  "prompt": "Bonjour",
  "stream": false
}'
```

### 3. Tester depuis le backend

```bash
curl -X POST http://localhost:5000/api/v1/chatbot/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Bonjour"}'
```

---

## 🐛 Dépannage Production

### Erreur "ECONNREFUSED"

- Vérifier que Ollama est démarré : `docker ps` ou `systemctl status ollama`
- Vérifier l'URL dans `OLLAMA_BASE_URL`
- Vérifier le réseau Docker (si en Docker)

### Réponses lentes

- Utiliser un modèle plus léger (`phi3` au lieu de `mistral`)
- Augmenter les ressources allouées à Ollama
- Réduire `maxHistoryLength` dans `chatbot.service.ts`

### Consommation mémoire élevée

- Utiliser un modèle plus petit
- Limiter les ressources dans Docker
- Réduire le nombre de conversations simultanées

---

## 📈 Optimisations Production

1. **Cache des réponses** : Implémenter un cache Redis pour les questions fréquentes
2. **Queue system** : Utiliser une queue (Bull/BullMQ) pour gérer les requêtes
3. **Load balancing** : Plusieurs instances Ollama si nécessaire
4. **Monitoring** : Intégrer Prometheus/Grafana pour surveiller les performances

---

## 🔄 Mise à Jour

Pour mettre à jour Ollama :

```bash
# Docker
docker-compose pull ollama
docker-compose up -d ollama

# Serveur direct
ollama serve --update
```

Pour mettre à jour un modèle :

```bash
# Docker
docker-compose exec ollama ollama pull llama3.2

# Serveur direct
ollama pull llama3.2
```

