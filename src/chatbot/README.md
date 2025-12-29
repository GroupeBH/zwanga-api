# Module Chatbot

Ce module implémente un chatbot intelligent utilisant LangChain et Ollama pour répondre aux questions des utilisateurs de la plateforme Zwanga.

## Configuration

### Variables d'environnement

Ajoutez les variables suivantes dans votre fichier `.env` :

```env
# Configuration Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

### Installation d'Ollama

1. **Installer Ollama** : Téléchargez et installez Ollama depuis [https://ollama.ai](https://ollama.ai)

2. **Démarrer Ollama** : Lancez le service Ollama sur votre machine

3. **Télécharger un modèle** : Téléchargez un modèle compatible (recommandé: llama3.2, mistral, ou phi3)
   ```bash
   ollama pull llama3.2
   ```

4. **Vérifier que Ollama fonctionne** :
   ```bash
   curl http://localhost:11434/api/tags
   ```

### Modèles recommandés

- **llama3.2** : Modèle léger et rapide, bon pour les réponses courtes
- **mistral** : Modèle équilibré entre performance et vitesse
- **phi3** : Modèle très léger, idéal pour les environnements avec ressources limitées

## Utilisation

### Endpoint public (sans authentification)

```http
POST /api/v1/chatbot/chat
Content-Type: application/json

{
  "message": "Comment réserver un trajet ?",
  "conversationId": "optional-conversation-id"
}
```

### Endpoint authentifié

```http
POST /api/v1/chatbot/chat/authenticated
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "Comment modifier mon profil ?",
  "conversationId": "optional-conversation-id"
}
```

### Réponse

```json
{
  "response": "Pour réserver un trajet, vous devez...",
  "conversationId": "conv-user-id-timestamp",
  "relatedFaqs": ["faq-id-1", "faq-id-2"]
}
```

## Fonctionnalités

- **Gestion du contexte** : Le chatbot maintient un historique de conversation pour chaque utilisateur
- **Intégration FAQ** : Utilise automatiquement les FAQ pertinentes pour enrichir les réponses
- **Rate limiting** : Protection contre l'abus avec throttling (20-30 requêtes/minute)
- **Gestion de la mémoire** : Limite l'historique à 10 messages pour optimiser les performances

## Architecture

- **ChatbotService** : Service principal gérant les interactions avec LangChain/Ollama
- **ChatbotController** : Contrôleur exposant les endpoints REST
- **Intégration FAQ** : Utilise le service FAQ pour enrichir le contexte

## Dépannage

### Erreur "ECONNREFUSED"

- Vérifiez que Ollama est bien démarré : `ollama serve`
- Vérifiez l'URL dans `OLLAMA_BASE_URL`
- Vérifiez que le port 11434 est accessible

### Erreur "Model not found"

- Vérifiez que le modèle est bien téléchargé : `ollama list`
- Téléchargez le modèle : `ollama pull <model-name>`
- Vérifiez le nom du modèle dans `OLLAMA_MODEL`

### Réponses lentes

- Utilisez un modèle plus léger (phi3 au lieu de llama3.2)
- Réduisez `maxHistoryLength` dans le service
- Vérifiez les ressources système (CPU/RAM)

