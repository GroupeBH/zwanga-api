# Sécurité et Logging - ZWANGA Backend

Ce document décrit les mesures de sécurité et le système de logging implémentés dans l'application.

## 🔐 Sécurité des Routes

### Authentification JWT

Toutes les routes sont protégées par défaut avec JWT. Les routes publiques doivent être marquées avec le décorateur `@Public()`.

**Exemple :**
```typescript
@Post('register')
@Public() // Route publique
async register() { ... }

@Get('profile')
@Auth() // Route protégée (authentification requise)
async getProfile() { ... }
```

### Contrôle d'accès basé sur les rôles (RBAC)

Les routes peuvent être restreintes à des rôles spécifiques :

- **`@Roles(UserRole.ADMIN)`** : Accès réservé aux administrateurs
- **`@Roles(UserRole.DRIVER)`** : Accès réservé aux conducteurs
- **`@Roles(UserRole.PASSENGER)`** : Accès réservé aux passagers
- **`@Roles(UserRole.DRIVER, UserRole.PASSENGER)`** : Accès pour plusieurs rôles

**Exemple :**
```typescript
@Post('trips')
@Auth()
@Roles(UserRole.DRIVER) // Seuls les conducteurs peuvent créer des trajets
async createTrip() { ... }

@Get('admin/users')
@Auth()
@Roles(UserRole.ADMIN) // Seuls les admins peuvent voir tous les utilisateurs
async getAllUsers() { ... }
```

## 🚦 Rate Limiting

Le rate limiting est configuré pour protéger les routes critiques contre les abus et les attaques par déni de service (DDoS).

### Configuration globale

Par défaut, toutes les routes ont un rate limit de **10 requêtes par minute**.

### Rate limiting spécifique par route

Les routes critiques ont des limites personnalisées :

#### Routes d'authentification
- **`POST /auth/register`** : 5 requêtes/minute
- **`POST /auth/login`** : 10 requêtes/minute
- **`POST /auth/refresh`** : 20 requêtes/minute

#### Routes de création
- **`POST /trips`** : 10 requêtes/minute (conducteurs uniquement)
- **`POST /bookings`** : 10 requêtes/minute (passagers uniquement)

#### Routes administratives
- **`GET /admin/*`** : 30 requêtes/minute
- **`PUT /admin/users/:id/suspend`** : 10 requêtes/minute
- **`PUT /admin/kyc/:id/verify`** : 20 requêtes/minute

#### Routes publiques
- **`GET /trips`** : 30 requêtes/minute (recherche de trajets)

**Exemple d'utilisation :**
```typescript
@Post('register')
@Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 requêtes par minute
async register() { ... }
```

### Gestion des erreurs de rate limiting

Lorsqu'une limite est dépassée, l'API retourne :
- **Status Code** : `429 Too Many Requests`
- **Headers** :
  - `X-RateLimit-Limit` : Limite de requêtes
  - `X-RateLimit-Remaining` : Requêtes restantes
  - `X-RateLimit-Reset` : Temps de réinitialisation (timestamp)

## 📝 Logging

### Configuration

Le système de logging utilise **Winston** avec les transports suivants :

1. **Console** : Logs colorés en développement
2. **Fichiers** :
   - `logs/error.log` : Erreurs uniquement
   - `logs/combined.log` : Tous les logs
   - `logs/exceptions.log` : Exceptions non gérées
   - `logs/rejections.log` : Promesses rejetées

### Niveaux de logging

- **`error`** : Erreurs critiques nécessitant une attention immédiate
- **`warn`** : Avertissements (tentatives d'accès non autorisées, etc.)
- **`info`** : Informations générales (opérations réussies)
- **`debug`** : Informations détaillées (développement uniquement)

### Logging automatique des requêtes HTTP

Toutes les requêtes HTTP sont automatiquement loggées avec :
- Méthode HTTP
- URL
- Code de statut
- Temps de réponse
- IP du client
- User-Agent
- ID utilisateur (si authentifié)

**Exemple de log :**
```
2024-01-15 10:30:45 info [LoggingInterceptor] HTTP POST /api/v1/auth/login {
  "method": "POST",
  "url": "/api/v1/auth/login",
  "statusCode": 200,
  "responseTime": "45ms",
  "ip": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "userId": "anonymous"
}
```

### Logging dans les services

Les services utilisent le logger NestJS pour enregistrer les opérations importantes :

**Exemple :**
```typescript
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  async login(loginDto: LoginDto) {
    this.logger.log(`Login attempt for phone: ${loginDto.phone}`);
    
    // ... logique de connexion ...
    
    this.logger.log(`User logged in successfully: ${user.id}`);
  }
}
```

### Logs d'erreur

Les erreurs sont automatiquement loggées avec :
- Message d'erreur
- Stack trace
- Contexte de la requête
- Informations utilisateur

## 🛡️ Bonnes pratiques de sécurité

### 1. Validation des entrées

Tous les DTOs utilisent `class-validator` pour valider les données d'entrée :

```typescript
export class CreateTripDto {
  @IsNotEmpty()
  @IsString()
  origin: string;

  @IsNotEmpty()
  @IsString()
  destination: string;
}
```

### 2. Protection CSRF

Les tokens JWT sont utilisés pour l'authentification, réduisant les risques CSRF.

### 3. Headers de sécurité

Les headers de sécurité suivants sont recommandés (à configurer dans le reverse proxy) :
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000`

### 4. Gestion des secrets

⚠️ **IMPORTANT** : Ne jamais commiter les secrets dans le code source.

Utilisez les variables d'environnement pour :
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DATABASE_PASSWORD`

### 5. Rotation des tokens

Les tokens JWT ont des durées de validité limitées :
- **Access Token** : 1 jour
- **Refresh Token** : 3 semaines

### 6. Validation des fichiers uploadés

- Types de fichiers autorisés : JPEG, PNG, WebP
- Taille maximale : 5MB
- Modération de contenu automatique avec AWS Rekognition

## 📊 Monitoring

### Logs à surveiller

1. **Erreurs d'authentification** : Tentatives de connexion échouées
2. **Rate limiting** : Requêtes bloquées par le rate limiter
3. **Erreurs de validation** : Données invalides reçues
4. **Erreurs de modération** : Contenu inapproprié détecté

### Métriques recommandées

- Nombre de requêtes par minute
- Taux d'erreur (4xx, 5xx)
- Temps de réponse moyen
- Nombre d'utilisateurs actifs
- Tentatives d'accès non autorisées

## 🔍 Dépannage

### Problème : Rate limiting trop strict

**Solution** : Ajuster les limites dans les contrôleurs ou la configuration globale.

### Problème : Logs trop volumineux

**Solution** : Ajuster le niveau de logging dans `.env` :
```env
LOG_LEVEL=info  # ou warn, error en production
```

### Problème : Erreurs d'authentification fréquentes

**Vérifier** :
1. Validité des tokens JWT
2. Configuration des secrets
3. Expiration des tokens
4. Statut des utilisateurs (suspendus, etc.)

## 📚 Ressources

- [NestJS Security](https://docs.nestjs.com/security/authentication)
- [Winston Documentation](https://github.com/winstonjs/winston)
- [Rate Limiting Best Practices](https://www.cloudflare.com/learning/bots/what-is-rate-limiting/)

