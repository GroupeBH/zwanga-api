# Échange sécurisé après connexion Google web

Le callback Google ne redirige plus avec `accessToken` ou `refreshToken`. La réponse 302 pointe vers :

```text
https://<frontend>/auth/callback#code=<code-opaque>
```

Ce changement concerne `GET /auth/google/callback`. Les endpoints natifs `POST /auth/google/mobile` et `POST /auth/apple/mobile` conservent leur réponse JSON actuelle.

## Contrat frontend

1. Lire `code` dans le fragment de l'URL (`location.hash`), pas dans la query string.
2. Effacer immédiatement ce fragment avec `history.replaceState`, avant de charger les outils d'analytics ou des scripts tiers. Ne jamais journaliser le code ni les tokens.
3. Envoyer une seule requête, dans les 60 secondes, au backend :

```http
POST /auth/exchange
Content-Type: application/json

{"code":"<code reçu dans le fragment>"}
```

Une authentification JWT préalable n'est pas requise. Le code joue le rôle de secret temporaire. La réponse 200 contient les champs habituels `accessToken` et `refreshToken`, uniquement dans le corps JSON. Ne pas réintroduire ces tokens dans une URL côté frontend.

- 400 : corps invalide (le code est une chaîne hexadécimale de 64 caractères).
- 401 : code inconnu, expiré ou déjà consommé. Relancer la connexion Google.
- 429 : limite de tentatives atteinte.
- 503 : stockage temporairement indisponible. Relancer la connexion, sans repli vers des tokens dans l'URL.

En cas de perte de la réponse après consommation, le code ne peut pas être rejoué : recommencer la connexion. Éviter également les appels doubles dus au montage du composant frontend.

## Garanties et limites

Le code contient 32 octets aléatoires. Les tokens sont stockés dans Redis pendant 60 secondes sous une clé contenant le SHA-256 du code. L'échange utilise une seule commande [Redis GETDEL](https://redis.io/docs/latest/commands/getdel/) pour lire puis supprimer la valeur, y compris lorsque plusieurs instances du backend reçoivent simultanément la même demande.

Le callback et l'échange portent `Cache-Control: no-store`, `Pragma: no-cache` et `Referrer-Policy: no-referrer`. Les erreurs Redis ne renvoient ni contenu stocké ni message technique sensible. Aucun fallback vers des JWT en query ou en fragment n'est prévu.

Le code reste sensible pendant sa courte durée de vie. Le fragment réduit son exposition aux requêtes HTTP et aux Referer, mais les scripts frontend peuvent le lire ; l'effacement immédiat et l'absence d'analytics sur cette étape restent nécessaires. Ce correctif ne constitue pas une refonte complète du flux OAuth, notamment de sa liaison au navigateur via state/PKCE.

## Configuration et déploiement

`FRONTEND_URL` est désormais lu par `ConfigService`. En production, il doit être explicitement défini avec une URL HTTPS, sans identifiants, query ni fragment. Un éventuel chemin de base est conservé avant `/auth/callback`.

```dotenv
FRONTEND_URL=https://votre-frontend.example
```

Le repli `http://localhost:3000` n'est autorisé qu'hors production. Une configuration manquante ou invalide fait échouer le callback avant émission des tokens. Vérifier cette variable dans la configuration réellement injectée sur AWS ; sa présence dans un fichier local ne suffit pas.

Redis doit prendre en charge GETDEL (Redis 6.2+ ; les configurations du dépôt utilisent Redis 7/7.2). Le backend réutilise la connexion Redis existante : aucune nouvelle variable Redis ni migration SQL.

Déployer conjointement l'adaptation du frontend web et le backend. Le frontend n'est pas présent dans ce dépôt et n'a pas été modifié. Les anciens tokens déjà présents dans des historiques ou journaux ne sont pas effacés ni révoqués automatiquement par cette modification.

## Tests

`npm test -- --runInBand src/auth/oauth-exchange.spec.ts` vérifie notamment le TTL, le rejeu, deux échanges concurrents, les erreurs Redis, la configuration de redirection, les en-têtes HTTP et l'absence de JWT dans la redirection.
