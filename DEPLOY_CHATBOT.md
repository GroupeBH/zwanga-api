# 🚀 Guide de Déploiement Rapide - Chatbot Ollama

Guide rapide pour déployer le chatbot en production.

## Option 1 : Docker Compose (Recommandé) ⭐

### Étapes

1. **Mettre à jour votre `.env`** :

```env
# Configuration Ollama
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=phi3
```

2. **Démarrer Ollama** :

```bash
docker-compose up -d ollama
```

3. **Télécharger le modèle** (attendre 10-15 secondes que Ollama démarre) :

```bash
docker-compose exec ollama ollama pull phi3
```

4. **Démarrer tous les services** :

```bash
docker-compose up -d
```

5. **Vérifier que tout fonctionne** :

```bash
# Vérifier les conteneurs
docker-compose ps

# Tester le chatbot
curl -X POST http://localhost:5000/api/v1/chatbot/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Bonjour"}'
```

✅ **C'est tout !** Le chatbot est maintenant opérationnel.

---

## Option 2 : Installation Directe sur Serveur

### Étapes

1. **Installer Ollama** :

```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

2. **Télécharger un modèle** :

```bash
ollama pull phi3
```

3. **Créer un service systemd** (pour démarrer automatiquement) :

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

Activer :

```bash
sudo systemctl enable ollama
sudo systemctl start ollama
```

4. **Mettre à jour votre `.env`** :

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=phi3
```

5. **Redémarrer votre backend** :

```bash
pm2 restart ecosystem.config.js --env production
```

✅ **Terminé !**

---

## 🔍 Vérification

### Test rapide

```bash
# Vérifier que Ollama fonctionne
curl http://localhost:11434/api/tags

# Tester le chatbot
curl -X POST http://localhost:5000/api/v1/chatbot/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Comment réserver un trajet ?"}'
```

### Vérifier les logs

```bash
# Docker
docker-compose logs -f ollama

# Serveur direct
journalctl -u ollama -f
```

---

## 📊 Choix du Modèle

| Modèle | RAM | Vitesse | Qualité | Recommandation |
|--------|-----|---------|---------|----------------|
| **phi3** | ~2.5GB | ⚡⚡⚡ | ⭐⭐⭐ | ✅ Production |
| **llama3.2** | ~2GB | ⚡⚡⚡ | ⭐⭐⭐⭐ | ✅ Production |
| **mistral** | ~4.5GB | ⚡⚡ | ⭐⭐⭐⭐⭐ | Qualité max |

**Recommandation** : `phi3` pour la production (léger et rapide)

---

## ⚠️ Important - Sécurité

**NE JAMAIS exposer Ollama publiquement !**

- En Docker : Ollama est sur le réseau interne (`zwanga-network`)
- Sur serveur : Utilisez un firewall pour bloquer le port 11434 depuis Internet
- Le backend communique avec Ollama en interne uniquement

---

## 🐛 Dépannage

### Ollama ne démarre pas

```bash
# Vérifier les logs
docker-compose logs ollama
# ou
journalctl -u ollama

# Vérifier les ressources
docker stats zwanga-ollama
```

### Erreur "Model not found"

```bash
# Télécharger le modèle
docker-compose exec ollama ollama pull phi3
# ou
ollama pull phi3
```

### Réponses lentes

- Utiliser un modèle plus léger (`phi3` au lieu de `mistral`)
- Augmenter les ressources dans `docker-compose.yml`
- Vérifier la charge CPU/RAM du serveur

---

## 📚 Documentation Complète

Pour plus de détails, voir : `src/chatbot/PRODUCTION.md`

