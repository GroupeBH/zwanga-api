# Endpoints de l’API Zwanga

Référence des opérations HTTP publiées par Swagger (`ZWANGA API`, version déclarée `1.0`). Elle décrit ce que l’interface montre et ce que le serveur valide réellement lorsque le schéma Swagger est incomplet.

### Ajout du 21 octobre 2026 — retraits de parrainage

- `POST /api/v1/referrals/me/withdrawals` : `{ tokens, phone?, idempotencyKey? }`. La clé est un UUID réutilisé à chaque reprise de la même intention. Minimum 1 000 jetons disponibles, compte/KYC éligibles, téléphone RDC ; même clé et paramètres = même retrait sans nouvel envoi. Conflit de paramètres ou autre intention en cours = HTTP 409. Les anciens clients sans clé restent acceptés avec la protection de reprise limitée décrite dans la politique financière.
- `GET /api/v1/referrals/me/withdrawals/:id` : lecture du retrait du compte authentifié, même sans commande prestataire. UUID obligatoire, 404 si absent ou appartenant à un autre compte.
- `GET /api/v1/referrals/me` : `rules.bookingPaymentModes` inclut `cash`, `rules.cashRewardRequiresReceipt=true` ; `eligiblePayments` conserve ses anciennes valeurs et ajoute PawaPay et `booking_cash_confirmed`. Abonnements payés en jetons toujours exclus.

Voir [les règles et limites de reprise](finance/referral-program.md#21-octobre-2026--cash-confirmé-et-reprises-financières). Migrations 85/86 requises.

## Où ouvrir Swagger

- Interface : `GET /api/v1/docs`
- Document OpenAPI : `GET /api/v1/docs-json`
- Préfixe des routes : `/api/v1`, pris dans `API_PREFIX` (valeur par défaut `api/v1`)
- Port local par défaut : `5200`

Le titre, la version et le schéma d’authentification sont définis dans `src/main.ts`. Le schéma Bearer s’appelle `JWT-auth`.

## Conventions qui s’appliquent à toutes les routes

### Authentification

Un garde JWT est enregistré globalement. Toute route sans `@Public()` exige :

```http
Authorization: Bearer <jwt>
```

Le cadenas Swagger n’est dessiné que si le contrôleur porte `@ApiBearerAuth()` ou `@Auth()`. L’absence de cadenas ne rend pas la route publique. Seul `@Public()` le fait.

Le rôle `@Roles(admin)` autorise `admin` et `super_admin`. Le rôle `@Roles(super_admin)` n’autorise pas un simple `admin`. Le rôle `@Roles(driver)` n’autorise pas un passager. Un administrateur dont le mot de passe doit encore être changé reçoit 403 sur les routes à rôle, avec le message « Changement du mot de passe administrateur requis ».

### Validation

Le corps JSON, les objets de query et les paramètres décorés passent par un `ValidationPipe` global :

- les propriétés inconnues sont refusées (`forbidNonWhitelisted`), pas ignorées ;
- les types simples sont convertis (`enableImplicitConversion`) ;
- une erreur de validation répond `400` avec la forme `{ "error": "Bad Request", "message": ["..."], "statusCode": 400 }`.

Sans le plugin Swagger de Nest, un champ n’entre dans le schéma OpenAPI que s’il a `@ApiProperty`. Les fiches ci-dessous marquent ces champs « présent dans le schéma Swagger ». Les autres restent exigés ou acceptés par `class-validator` et sont marqués « absent du schéma Swagger ».

### Codes habituels

| Situation | Code |
| --- | --- |
| Lecture ou mise à jour réussie | 200 |
| Création `POST` réussie, sauf `@HttpCode` contraire | 201 |
| Corps ou paramètre invalide | 400 |
| JWT absent ou invalide | 401 |
| Rôle insuffisant, ou mot de passe administrateur à changer | 403 |
| Trop de requêtes | 429 |

Le message de quota global est « Trop de demandes. Réessayez dans un instant. » Le plafond par défaut est 10 requêtes par 60 secondes (`THROTTLE_LIMIT`, `THROTTLE_TTL` ou `THROTTLE_TTL_MS`). Une route décorée avec `@SensitiveThrottle` remplace ce plafond. Le compteur suit l’utilisateur du JWT, ou l’adresse IP si la route est anonyme. Le serveur ne fait confiance au proxy que pour les CIDR listés dans `TRUSTED_PROXY_CIDRS`.

### Ce que Swagger ne contient pas

Deux namespaces Socket.IO authentifiés vivent à côté de l’API HTTP : `/chat` et `/tracking`. Leurs événements ne figurent pas dans `/api/v1/docs`. La sonde `GET /health` est aussi absente du document, par choix (`swaggerDocumentation: false`). Elle est décrite en fin de fichier parce qu’elle fait partie du service.

## Index (373 opérations)

### Auth (16)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/auth/admin/bootstrap/confirm](#post-api-v1-auth-admin-bootstrap-confirm) | public | — | Create the initial super administrator with OTP |
| POST | [/api/v1/auth/admin/bootstrap/send-otp](#post-api-v1-auth-admin-bootstrap-send-otp) | public | — | Send OTP for the initial super administrator |
| POST | [/api/v1/auth/admin/login](#post-api-v1-auth-admin-login) | public | — | Login administrator with phone number and password |
| POST | [/api/v1/auth/admin/password/change](#post-api-v1-auth-admin-password-change) | JWT | — | Change administrator password |
| POST | [/api/v1/auth/apple/mobile](#post-api-v1-auth-apple-mobile) | public | — | Apple Sign-In (mobile): identityToken + phone -> JWT tokens |
| POST | [/api/v1/auth/exchange](#post-api-v1-auth-exchange) | public | — | Exchange a one-time OAuth code for JWT tokens |
| GET | [/api/v1/auth/google](#get-api-v1-auth-google) | public | — | Initiate Google OAuth authentication |
| GET | [/api/v1/auth/google/callback](#get-api-v1-auth-google-callback) | public | — | Google OAuth callback |
| POST | [/api/v1/auth/google/mobile](#post-api-v1-auth-google-mobile) | public | — | Google Sign-In (mobile): idToken + phone -> JWT tokens |
| POST | [/api/v1/auth/login](#post-api-v1-auth-login) | public | — | Login user with phone number and PIN |
| POST | [/api/v1/auth/logout](#post-api-v1-auth-logout) | JWT | — | Logout user and invalidate refresh token |
| POST | [/api/v1/auth/pin/reset](#post-api-v1-auth-pin-reset) | public | — | Set a new PIN with a one-time reset token |
| POST | [/api/v1/auth/pin/reset/request-otp](#post-api-v1-auth-pin-reset-request-otp) | public | — | Send an OTP to reset a forgotten PIN |
| POST | [/api/v1/auth/pin/reset/verify-otp](#post-api-v1-auth-pin-reset-verify-otp) | public | — | Verify the OTP and issue a one-time reset token |
| POST | [/api/v1/auth/refresh](#post-api-v1-auth-refresh) | public | — | Refresh access token |
| POST | [/api/v1/auth/register](#post-api-v1-auth-register) | public | — | Register a new user with optional files |

### Users (15)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/users/:id/public](#get-api-v1-users-id-public) | JWT | — | Get public profile of a user (driver or passenger) |
| POST | [/api/v1/users/driver-activation](#post-api-v1-users-driver-activation) | JWT | — | Activate the driver profile only after all requirements are met |
| POST | [/api/v1/users/driver-onboarding](#post-api-v1-users-driver-onboarding) | JWT | — | Request driver onboarding; activation requires approved identity and an active owned vehicle |
| POST | [/api/v1/users/fcm-token](#post-api-v1-users-fcm-token) | JWT | — | Update FCM token for push notifications |
| POST | [/api/v1/users/kyc](#post-api-v1-users-kyc) | JWT | — | Upload KYC documents |
| POST | [/api/v1/users/kyc/didit/session](#post-api-v1-users-kyc-didit-session) | JWT | — | Create a hosted Didit KYC verification session |
| POST | [/api/v1/users/kyc/didit/sync](#post-api-v1-users-kyc-didit-sync) | JWT | — | Synchronize the current user Didit KYC session |
| POST | [/api/v1/users/kyc/didit/webhook](#post-api-v1-users-kyc-didit-webhook) | public | — | Receive signed Didit KYC webhook events |
| GET | [/api/v1/users/kyc/status](#get-api-v1-users-kyc-status) | JWT | — | Get KYC verification status |
| GET | [/api/v1/users/me](#get-api-v1-users-me) | JWT | — | Get current user profile |
| PUT | [/api/v1/users/me](#put-api-v1-users-me) | JWT | — | Update user profile |
| DELETE | [/api/v1/users/me](#delete-api-v1-users-me) | JWT | — | Delete current user account |
| POST | [/api/v1/users/phone/send-otp](#post-api-v1-users-phone-send-otp) | public | — | Send OTP code to phone number for verification |
| POST | [/api/v1/users/phone/verify](#post-api-v1-users-phone-verify) | public | — | Verify OTP code sent to phone number |
| POST | [/api/v1/users/pin/change](#post-api-v1-users-pin-change) | JWT | — | Change user PIN code |

### Admin (55)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/admin/accounts](#get-api-v1-admin-accounts) | JWT | super_admin | List back-office administrator accounts |
| POST | [/api/v1/admin/accounts](#post-api-v1-admin-accounts) | JWT | super_admin | Create a back-office administrator account |
| PUT | [/api/v1/admin/accounts/:userId/activate](#put-api-v1-admin-accounts-userid-activate) | JWT | super_admin | Reactivate a back-office administrator account |
| PUT | [/api/v1/admin/accounts/:userId/deactivate](#put-api-v1-admin-accounts-userid-deactivate) | JWT | super_admin | Deactivate a back-office administrator account |
| PUT | [/api/v1/admin/accounts/:userId/password](#put-api-v1-admin-accounts-userid-password) | JWT | super_admin | Set a temporary password for a back-office administrator account |
| GET | [/api/v1/admin/bookings](#get-api-v1-admin-bookings) | JWT | admin | Get all bookings as admin |
| PUT | [/api/v1/admin/bookings/:bookingId/accept](#put-api-v1-admin-bookings-bookingid-accept) | JWT | admin | Accept a booking as admin |
| PUT | [/api/v1/admin/bookings/:bookingId/cancel](#put-api-v1-admin-bookings-bookingid-cancel) | JWT | admin | Cancel a booking as admin |
| PUT | [/api/v1/admin/bookings/:bookingId/reject](#put-api-v1-admin-bookings-bookingid-reject) | JWT | admin | Reject a booking as admin |
| GET | [/api/v1/admin/bookings/export](#get-api-v1-admin-bookings-export) | JWT | admin | Export bookings as Excel .xls |
| GET | [/api/v1/admin/kyc](#get-api-v1-admin-kyc) | JWT | admin | List all KYC documents as consultable history, optionally filtered by status |
| GET | [/api/v1/admin/kyc/:kycId](#get-api-v1-admin-kyc-kycid) | JWT | admin | Get one KYC document with user details |
| GET | [/api/v1/admin/kyc/:kycId/evidence](#get-api-v1-admin-kyc-kycid-evidence) | JWT | admin | — |
| POST | [/api/v1/admin/kyc/:kycId/evidence](#post-api-v1-admin-kyc-kycid-evidence) | JWT | admin | — |
| GET | [/api/v1/admin/kyc/:kycId/evidence/:archiveId](#get-api-v1-admin-kyc-kycid-evidence-archiveid) | JWT | admin | — |
| DELETE | [/api/v1/admin/kyc/:kycId/evidence/:archiveId](#delete-api-v1-admin-kyc-kycid-evidence-archiveid) | JWT | admin | — |
| GET | [/api/v1/admin/kyc/:kycId/evidence/:archiveId/files/:index](#get-api-v1-admin-kyc-kycid-evidence-archiveid-files-index) | JWT | admin | — |
| PUT | [/api/v1/admin/kyc/:kycId/verify](#put-api-v1-admin-kyc-kycid-verify) | JWT | admin | Verify or reject KYC document |
| GET | [/api/v1/admin/kyc/pending](#get-api-v1-admin-kyc-pending) | JWT | admin | Get all pending KYC verifications |
| GET | [/api/v1/admin/payments](#get-api-v1-admin-payments) | JWT | admin | List payment transactions |
| GET | [/api/v1/admin/payments/export](#get-api-v1-admin-payments-export) | JWT | admin | Export payment transactions as Excel .xls |
| GET | [/api/v1/admin/referrals/accounts](#get-api-v1-admin-referrals-accounts) | JWT | admin | List referral accounts and global balances |
| GET | [/api/v1/admin/referrals/accounts/export](#get-api-v1-admin-referrals-accounts-export) | JWT | admin | Export referral accounts as Excel .xls |
| GET | [/api/v1/admin/referrals/candidates](#get-api-v1-admin-referrals-candidates) | JWT | admin | Find active referrers by name, phone, email or user ID |
| GET | [/api/v1/admin/referrals/rewards](#get-api-v1-admin-referrals-rewards) | JWT | admin | List referral rewards and commissions |
| GET | [/api/v1/admin/referrals/rewards/export](#get-api-v1-admin-referrals-rewards-export) | JWT | admin | Export referral rewards as Excel .xls |
| GET | [/api/v1/admin/referrals/withdrawals](#get-api-v1-admin-referrals-withdrawals) | JWT | admin | List referral withdrawal requests |
| POST | [/api/v1/admin/referrals/withdrawals/:withdrawalId/reconcile](#post-api-v1-admin-referrals-withdrawals-withdrawalid-reconcile) | JWT | super_admin | Reconcile a referral withdrawal with FlexPay |
| GET | [/api/v1/admin/referrals/withdrawals/export](#get-api-v1-admin-referrals-withdrawals-export) | JWT | admin | Export referral withdrawals as Excel .xls |
| GET | [/api/v1/admin/trip-requests](#get-api-v1-admin-trip-requests) | JWT | admin | Get all trip requests as admin |
| GET | [/api/v1/admin/trip-requests/:tripRequestId](#get-api-v1-admin-trip-requests-triprequestid) | JWT | admin | Get one trip request as admin |
| PUT | [/api/v1/admin/trip-requests/:tripRequestId](#put-api-v1-admin-trip-requests-triprequestid) | JWT | admin | Update a trip request as admin |
| DELETE | [/api/v1/admin/trip-requests/:tripRequestId](#delete-api-v1-admin-trip-requests-triprequestid) | JWT | admin | Delete a trip request as admin |
| PUT | [/api/v1/admin/trip-requests/:tripRequestId/deactivate](#put-api-v1-admin-trip-requests-triprequestid-deactivate) | JWT | admin | Deactivate/cancel a trip request as admin |
| GET | [/api/v1/admin/trip-requests/export](#get-api-v1-admin-trip-requests-export) | JWT | admin | Export trip requests as Excel .xls |
| GET | [/api/v1/admin/trips](#get-api-v1-admin-trips) | JWT | admin | Get all trips (paginated) |
| PUT | [/api/v1/admin/trips/:tripId](#put-api-v1-admin-trips-tripid) | JWT | admin | Update a trip as admin |
| DELETE | [/api/v1/admin/trips/:tripId](#delete-api-v1-admin-trips-tripid) | JWT | admin | Delete a trip as admin |
| PUT | [/api/v1/admin/trips/:tripId/deactivate](#put-api-v1-admin-trips-tripid-deactivate) | JWT | admin | Deactivate/cancel a trip as admin |
| GET | [/api/v1/admin/trips/:tripId/statement](#get-api-v1-admin-trips-tripid-statement) | JWT | admin | Trip detail with the gain of each party |
| GET | [/api/v1/admin/trips/export](#get-api-v1-admin-trips-export) | JWT | admin | Export trips as Excel .xls |
| GET | [/api/v1/admin/users](#get-api-v1-admin-users) | JWT | admin | Get all users (paginated) |
| PUT | [/api/v1/admin/users/:userId/activate](#put-api-v1-admin-users-userid-activate) | JWT | admin | Activate a user |
| PUT | [/api/v1/admin/users/:userId/deactivate](#put-api-v1-admin-users-userid-deactivate) | JWT | admin | Deactivate a user account |
| GET | [/api/v1/admin/users/:userId/details](#get-api-v1-admin-users-userid-details) | JWT | admin | Get a full admin view of a user, including trips, bookings, trip requests and payments |
| GET | [/api/v1/admin/users/:userId/financial-summary](#get-api-v1-admin-users-userid-financial-summary) | JWT | admin | Get token wallet, recent movements and current referrer for a user |
| POST | [/api/v1/admin/users/:userId/referrer](#post-api-v1-admin-users-userid-referrer) | JWT | admin | Attach a first referrer with an audited, non-retroactive attribution bonus |
| PUT | [/api/v1/admin/users/:userId/suspend](#put-api-v1-admin-users-userid-suspend) | JWT | admin | Suspend a user |
| GET | [/api/v1/admin/users/export](#get-api-v1-admin-users-export) | JWT | admin | Export users as an Excel .xls spreadsheet, optionally filtered by driver role |
| GET | [/api/v1/admin/users/stats](#get-api-v1-admin-users-stats) | JWT | admin | Get platform user counts by role |
| GET | [/api/v1/admin/wallets](#get-api-v1-admin-wallets) | JWT | admin | List token wallets and their global summary |
| POST | [/api/v1/admin/wallets/:userId/adjustments](#post-api-v1-admin-wallets-userid-adjustments) | JWT | admin | Apply an audited token balance adjustment |
| GET | [/api/v1/admin/wallets/export](#get-api-v1-admin-wallets-export) | JWT | admin | Export token wallet balances as Excel .xls |
| GET | [/api/v1/admin/wallets/ledger](#get-api-v1-admin-wallets-ledger) | JWT | admin | List the immutable token ledger |
| GET | [/api/v1/admin/wallets/ledger/export](#get-api-v1-admin-wallets-ledger-export) | JWT | admin | Export the token ledger as Excel .xls |

### Vehicles (5)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/vehicles](#get-api-v1-vehicles) | JWT | — | Get all vehicles of the current user |
| POST | [/api/v1/vehicles](#post-api-v1-vehicles) | JWT | — | Create a new vehicle |
| GET | [/api/v1/vehicles/:id](#get-api-v1-vehicles-id) | JWT | — | Get a vehicle by ID |
| PUT | [/api/v1/vehicles/:id](#put-api-v1-vehicles-id) | JWT | — | Update a vehicle |
| DELETE | [/api/v1/vehicles/:id](#delete-api-v1-vehicles-id) | JWT | — | Deactivate a vehicle only when no ongoing, upcoming or active recurring trip uses it |

### Favorite Places (8)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/favorite-places](#get-api-v1-favorite-places) | JWT | — | Get all favorite places for the current user |
| POST | [/api/v1/favorite-places](#post-api-v1-favorite-places) | JWT | — | Create a new favorite place |
| GET | [/api/v1/favorite-places/:id](#get-api-v1-favorite-places-id) | JWT | — | Get a favorite place by ID |
| PUT | [/api/v1/favorite-places/:id](#put-api-v1-favorite-places-id) | JWT | — | Update a favorite place |
| DELETE | [/api/v1/favorite-places/:id](#delete-api-v1-favorite-places-id) | JWT | — | Delete a favorite place |
| PUT | [/api/v1/favorite-places/:id/set-default](#put-api-v1-favorite-places-id-set-default) | JWT | — | Set a favorite place as default for its type |
| GET | [/api/v1/favorite-places/default](#get-api-v1-favorite-places-default) | JWT | — | Get default favorite place (optionally filtered by type) |
| GET | [/api/v1/favorite-places/type/:type](#get-api-v1-favorite-places-type-type) | JWT | — | Get favorite places by type (home, work, other) |

### Trips (28)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/trips](#get-api-v1-trips) | public | — | Rechercher des trajets ou obtenir tous les trajets disponibles |
| POST | [/api/v1/trips](#post-api-v1-trips) | JWT | — | Create a new trip |
| GET | [/api/v1/trips/:id](#get-api-v1-trips-id) | JWT | — | Get a trip by ID |
| PUT | [/api/v1/trips/:id](#put-api-v1-trips-id) | JWT | — | Update a trip |
| DELETE | [/api/v1/trips/:id](#delete-api-v1-trips-id) | JWT | — | Delete a trip unless a passenger has boarded and has not yet been dropped off |
| PUT | [/api/v1/trips/:id/complete](#put-api-v1-trips-id-complete) | JWT | — | Complete/end an active trip (driver only) |
| PUT | [/api/v1/trips/:id/driver-emergency-contacts](#put-api-v1-trips-id-driver-emergency-contacts) | JWT | — | Select driver's emergency contacts for trip WhatsApp safety notifications |
| GET | [/api/v1/trips/:id/driver-location](#get-api-v1-trips-id-driver-location) | JWT | — | Get driver location for an active trip |
| PUT | [/api/v1/trips/:id/driver-location](#put-api-v1-trips-id-driver-location) | JWT | — | Update driver location for an active trip |
| POST | [/api/v1/trips/:id/interruption-request](#post-api-v1-trips-id-interruption-request) | JWT | — | Request interruption of an active trip; onboard passengers must confirm |
| PUT | [/api/v1/trips/:id/interruption-request/cancel](#put-api-v1-trips-id-interruption-request-cancel) | JWT | — | Cancel a pending driver interruption request |
| PUT | [/api/v1/trips/:id/interruption-request/confirm](#put-api-v1-trips-id-interruption-request-confirm) | JWT | — | Confirm a driver interruption request as an onboard passenger |
| PUT | [/api/v1/trips/:id/interruption-request/decision](#put-api-v1-trips-id-interruption-request-decision) | JWT | — | — |
| GET | [/api/v1/trips/:id/interruption-request/fare](#get-api-v1-trips-id-interruption-request-fare) | JWT | — | — |
| PUT | [/api/v1/trips/:id/interruption-request/reject](#put-api-v1-trips-id-interruption-request-reject) | JWT | — | Reject a driver interruption request as an onboard passenger |
| PUT | [/api/v1/trips/:id/make-public](#put-api-v1-trips-id-make-public) | JWT | — | Make a private trip public |
| PUT | [/api/v1/trips/:id/pause](#put-api-v1-trips-id-pause) | JWT | — | Pause/interrupt an active trip |
| POST | [/api/v1/trips/:id/reprogram](#post-api-v1-trips-id-reprogram) | JWT | — | Reprogrammer un trajet expiré en nouvelle publication, sans reprendre ses réservations |
| PUT | [/api/v1/trips/:id/start](#put-api-v1-trips-id-start) | JWT | — | Start a trip |
| GET | [/api/v1/trips/all-trips](#get-api-v1-trips-all-trips) | JWT | ...ADMIN_USER_ROLES | Get all trips completed or not |
| POST | [/api/v1/trips/discovery](#post-api-v1-trips-discovery) | public | — | — |
| GET | [/api/v1/trips/my-trips](#get-api-v1-trips-my-trips) | JWT | — | Get trips created by current user |
| GET | [/api/v1/trips/my-trips/history](#get-api-v1-trips-my-trips-history) | JWT | — | — |
| POST | [/api/v1/trips/recurring](#post-api-v1-trips-recurring) | JWT | — | Create a recurring trip template |
| PUT | [/api/v1/trips/recurring/:id/pause](#put-api-v1-trips-recurring-id-pause) | JWT | — | Pause a recurring trip template |
| PUT | [/api/v1/trips/recurring/:id/resume](#put-api-v1-trips-recurring-id-resume) | JWT | — | Resume a recurring trip template |
| GET | [/api/v1/trips/recurring/my](#get-api-v1-trips-recurring-my) | JWT | — | Get recurring trip templates created by current user |
| POST | [/api/v1/trips/search/coordinates](#post-api-v1-trips-search-coordinates) | public | — | Rechercher des trajets par coordonnées |

### Trip Requests (16)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/trip-requests](#get-api-v1-trip-requests) | JWT | driver | Get all pending trip requests |
| POST | [/api/v1/trip-requests](#post-api-v1-trip-requests) | JWT | — | Create a trip request |
| GET | [/api/v1/trip-requests/:id](#get-api-v1-trip-requests-id) | JWT | — | Get a trip request by ID |
| PUT | [/api/v1/trip-requests/:id](#put-api-v1-trip-requests-id) | JWT | — | Update a trip request |
| DELETE | [/api/v1/trip-requests/:id](#delete-api-v1-trip-requests-id) | JWT | — | Cancel a trip request |
| POST | [/api/v1/trip-requests/:id/accept](#post-api-v1-trip-requests-id-accept) | JWT | driver | Accept a trip request directly (Uber/Bolt/Yango style) |
| POST | [/api/v1/trip-requests/:id/accept-offer](#post-api-v1-trip-requests-id-accept-offer) | JWT | — | Accept a driver offer |
| GET | [/api/v1/trip-requests/:id/offers](#get-api-v1-trip-requests-id-offers) | JWT | — | Get all offers for a trip request |
| POST | [/api/v1/trip-requests/:id/offers](#post-api-v1-trip-requests-id-offers) | JWT | driver | Create a driver offer for a trip request |
| GET | [/api/v1/trip-requests/:id/passenger-contact](#get-api-v1-trip-requests-id-passenger-contact) | JWT | driver | Contact the passenger of an open request before accepting |
| PUT | [/api/v1/trip-requests/:id/release-driver](#put-api-v1-trip-requests-id-release-driver) | JWT | — | Release an overdue selected driver |
| PUT | [/api/v1/trip-requests/:id/start-trip](#put-api-v1-trip-requests-id-start-trip) | JWT | driver | Start a trip from an accepted trip request |
| GET | [/api/v1/trip-requests/my-offers](#get-api-v1-trip-requests-my-offers) | JWT | driver | Get my driver offers |
| GET | [/api/v1/trip-requests/my-requests](#get-api-v1-trip-requests-my-requests) | JWT | — | Get my trip requests |
| POST | [/api/v1/trip-requests/recommended-price](#post-api-v1-trip-requests-recommended-price) | JWT | — | Recommend a trip request price |
| POST | [/api/v1/trip-requests/vehicle-options](#post-api-v1-trip-requests-vehicle-options) | JWT | — | List vehicle choices and their recommended prices |

### Driver Dispatch (6)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/driver-dispatch/notifications](#post-api-v1-driver-dispatch-notifications) | JWT | — | — |
| GET | [/api/v1/driver-dispatch/offers/:id](#get-api-v1-driver-dispatch-offers-id) | JWT | driver | — |
| PUT | [/api/v1/driver-dispatch/offers/:id/respond](#put-api-v1-driver-dispatch-offers-id-respond) | JWT | driver | — |
| PUT | [/api/v1/driver-dispatch/position](#put-api-v1-driver-dispatch-position) | JWT | driver | — |
| PUT | [/api/v1/driver-dispatch/presence](#put-api-v1-driver-dispatch-presence) | JWT | driver | — |
| GET | [/api/v1/driver-dispatch/status](#get-api-v1-driver-dispatch-status) | JWT | — | — |

### Bookings (30)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/bookings](#post-api-v1-bookings) | JWT | — | Create a new booking |
| GET | [/api/v1/bookings/:id](#get-api-v1-bookings-id) | JWT | — | Get a booking by ID |
| PUT | [/api/v1/bookings/:id/accept](#put-api-v1-bookings-id-accept) | JWT | — | Accept a booking (driver only) |
| PUT | [/api/v1/bookings/:id/cancel](#put-api-v1-bookings-id-cancel) | JWT | — | Cancel a booking (passenger or driver before pickup) |
| PUT | [/api/v1/bookings/:id/cash-receipt](#put-api-v1-bookings-id-cash-receipt) | JWT | — | Confirmer explicitement le cash reçu après la dépose (conducteur du trajet uniquement) |
| PUT | [/api/v1/bookings/:id/confirm-dropoff](#put-api-v1-bookings-id-confirm-dropoff) | JWT | — | Record driver dropoff confirmation (both parties required) |
| PUT | [/api/v1/bookings/:id/confirm-dropoff-passenger](#put-api-v1-bookings-id-confirm-dropoff-passenger) | JWT | — | Confirm dropoff by the reservation holder |
| PUT | [/api/v1/bookings/:id/confirm-pickup](#put-api-v1-bookings-id-confirm-pickup) | JWT | — | Record driver pickup confirmation (both parties required) |
| PUT | [/api/v1/bookings/:id/confirm-pickup-passenger](#put-api-v1-bookings-id-confirm-pickup-passenger) | JWT | — | Confirm pickup by passenger |
| GET | [/api/v1/bookings/:id/driver-contact](#get-api-v1-bookings-id-driver-contact) | JWT | — | Get driver contact information for a booking |
| POST | [/api/v1/bookings/:id/interruption-request](#post-api-v1-bookings-id-interruption-request) | JWT | — | Request an early trip interruption for this passenger booking |
| PUT | [/api/v1/bookings/:id/interruption-request/cancel](#put-api-v1-bookings-id-interruption-request-cancel) | JWT | — | Cancel a pending passenger interruption request |
| PUT | [/api/v1/bookings/:id/interruption-request/confirm](#put-api-v1-bookings-id-interruption-request-confirm) | JWT | — | Confirm a passenger early interruption request (driver only) |
| POST | [/api/v1/bookings/:id/interruption-request/preview](#post-api-v1-bookings-id-interruption-request-preview) | JWT | — | Estimer le montant d’une descente anticipée sans la demander |
| PUT | [/api/v1/bookings/:id/interruption-request/reject](#put-api-v1-bookings-id-interruption-request-reject) | JWT | — | Reject a passenger early interruption request (driver only) |
| PUT | [/api/v1/bookings/:id/passenger-location](#put-api-v1-bookings-id-passenger-location) | JWT | — | Update passenger current location (passenger only) |
| POST | [/api/v1/bookings/:id/pay](#post-api-v1-bookings-id-pay) | JWT | — | Initiate electronic payment for a booking |
| PUT | [/api/v1/bookings/:id/payment-mode](#put-api-v1-bookings-id-payment-mode) | JWT | — | Update payment mode for a booking |
| PUT | [/api/v1/bookings/:id/reject](#put-api-v1-bookings-id-reject) | JWT | — | Reject a booking with a reason (driver only) |
| POST | [/api/v1/bookings/:id/report-problem](#post-api-v1-bookings-id-report-problem) | JWT | — | Report a problem related to a booking (driver or passenger) |
| PUT | [/api/v1/bookings/:id/respond-invitation](#put-api-v1-bookings-id-respond-invitation) | JWT | — | — |
| PUT | [/api/v1/bookings/:id/status](#put-api-v1-bookings-id-status) | JWT | — | Update booking status (driver only) |
| POST | [/api/v1/bookings/:id/whatsapp-notification-data](#post-api-v1-bookings-id-whatsapp-notification-data) | JWT | — | Récupérer les données pour envoyer des notifications WhatsApp aux contacts d'urgence (2 à 3 contacts) |
| POST | [/api/v1/bookings/flexpay/callback](#post-api-v1-bookings-flexpay-callback) | public | — | Receive FlexPay payment callback for trip bookings |
| GET | [/api/v1/bookings/my-bookings](#get-api-v1-bookings-my-bookings) | JWT | — | Get all bookings of the current user |
| GET | [/api/v1/bookings/my-bookings/history](#get-api-v1-bookings-my-bookings-history) | JWT | — | — |
| GET | [/api/v1/bookings/my-bookings/trip/:tripId](#get-api-v1-bookings-my-bookings-trip-tripid) | JWT | — | — |
| GET | [/api/v1/bookings/payments/:orderNumber/status](#get-api-v1-bookings-payments-ordernumber-status) | JWT | — | Check a trip booking payment status and update the booking |
| GET | [/api/v1/bookings/trip/:tripId](#get-api-v1-bookings-trip-tripid) | JWT | — | Get all bookings for a trip (driver only) |
| GET | [/api/v1/bookings/trip/:tripId/passengers-locations](#get-api-v1-bookings-trip-tripid-passengers-locations) | JWT | — | Get all passengers locations for a trip (driver only) |

### Ride declarations (3)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/ride-declarations/booking/:id](#get-api-v1-ride-declarations-booking-id) | JWT | — | — |
| PUT | [/api/v1/ride-declarations/booking/:id](#put-api-v1-ride-declarations-booking-id) | JWT | — | — |
| GET | [/api/v1/ride-declarations/trip/:id](#get-api-v1-ride-declarations-trip-id) | JWT | — | — |

### Tracking (2)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/tracking/public/:token](#get-api-v1-tracking-public-token) | public | — | Read a public trip tracking link |
| POST | [/api/v1/tracking/trips/:tripId/share-links](#post-api-v1-tracking-trips-tripid-share-links) | JWT | — | Create a public tracking link for a trip |

### Ratings (4)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/ratings](#post-api-v1-ratings) | JWT | — | Create a rating |
| GET | [/api/v1/ratings/user/:userId](#get-api-v1-ratings-user-userid) | JWT | — | Get ratings for a user |
| GET | [/api/v1/ratings/user/:userId/average](#get-api-v1-ratings-user-userid-average) | JWT | — | Get average rating for a user |
| GET | [/api/v1/ratings/user/:userId/page](#get-api-v1-ratings-user-userid-page) | JWT | — | Get a bounded page of public reviews |

### Payments (12)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/payments/:orderNumber/status](#get-api-v1-payments-ordernumber-status) | JWT | — | Check a payment status for the current user |
| GET | [/api/v1/payments/:paymentId/details](#get-api-v1-payments-paymentid-details) | JWT | — | Get sanitized payment details for the current user |
| POST | [/api/v1/payments/flexpay/callback](#post-api-v1-payments-flexpay-callback) | public | — | Receive a generic FlexPay payment callback |
| GET | [/api/v1/payments/history](#get-api-v1-payments-history) | JWT | — | Get sanitized payment history for the current user |
| GET | [/api/v1/payments/history/context](#get-api-v1-payments-history-context) | JWT | — | — |
| GET | [/api/v1/payments/history/page](#get-api-v1-payments-history-page) | JWT | — | — |
| GET | [/api/v1/payments/history/summary](#get-api-v1-payments-history-summary) | JWT | — | — |
| GET | [/api/v1/payments/my-transactions](#get-api-v1-payments-my-transactions) | JWT | — | Get all payment transactions for the current user |
| POST | [/api/v1/payments/pawapay/deposits/callback](#post-api-v1-payments-pawapay-deposits-callback) | public | — | Receive a PawaPay deposit callback |
| POST | [/api/v1/payments/pawapay/payouts/callback](#post-api-v1-payments-pawapay-payouts-callback) | public | — | Receive a PawaPay payout callback |
| POST | [/api/v1/payments/pawapay/refunds/callback](#post-api-v1-payments-pawapay-refunds-callback) | public | — | Receive a PawaPay refund callback |
| GET | [/api/v1/payments/providers](#get-api-v1-payments-providers) | JWT | — | List available payment providers and configured callback URLs |

### PawaPay (14)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/payments/pawapay/availability](#get-api-v1-payments-pawapay-availability) | JWT | — | Get live COD provider availability |
| GET | [/api/v1/payments/pawapay/methods](#get-api-v1-payments-pawapay-methods) | JWT | — | Get configured COD mobile money providers and payment limits |
| POST | [/api/v1/payments/pawapay/predict-provider](#post-api-v1-payments-pawapay-predict-provider) | JWT | — | Predict the COD mobile money provider for a phone number |
| POST | [/api/v1/payments/pawapay/refunds](#post-api-v1-payments-pawapay-refunds) | JWT | super_admin | Initiate an idempotent partial or full refund of a confirmed pawaPay deposit |
| GET | [/api/v1/payments/pawapay/refunds/:refundId](#get-api-v1-payments-pawapay-refunds-refundid) | JWT | admin | — |
| POST | [/api/v1/payments/pawapay/refunds/:refundId/check](#post-api-v1-payments-pawapay-refunds-refundid-check) | JWT | admin | — |
| POST | [/api/v1/payments/pawapay/refunds/:refundId/fail-enqueued](#post-api-v1-payments-pawapay-refunds-refundid-fail-enqueued) | JWT | super_admin | — |
| POST | [/api/v1/payments/pawapay/refunds/:refundId/resend-callback](#post-api-v1-payments-pawapay-refunds-refundid-resend-callback) | JWT | admin | — |
| POST | [/api/v1/payments/pawapay/refunds/:refundId/retry](#post-api-v1-payments-pawapay-refunds-refundid-retry) | JWT | super_admin | Retry a refund with its original UUID only after pawaPay returns NOT_FOUND |
| POST | [/api/v1/payments/pawapay/transactions/:paymentId/check](#post-api-v1-payments-pawapay-transactions-paymentid-check) | JWT | admin | — |
| POST | [/api/v1/payments/pawapay/transactions/:paymentId/fail-enqueued](#post-api-v1-payments-pawapay-transactions-paymentid-fail-enqueued) | JWT | super_admin | — |
| GET | [/api/v1/payments/pawapay/transactions/:paymentId/refunds](#get-api-v1-payments-pawapay-transactions-paymentid-refunds) | JWT | admin | — |
| POST | [/api/v1/payments/pawapay/transactions/:paymentId/resend-callback](#post-api-v1-payments-pawapay-transactions-paymentid-resend-callback) | JWT | admin | — |
| GET | [/api/v1/payments/pawapay/wallet-balances](#get-api-v1-payments-pawapay-wallet-balances) | JWT | admin | Get pawaPay merchant wallet balances |

### Wallet (11)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/wallet/ledger](#get-api-v1-wallet-ledger) | JWT | — | Get current user Zwanga token ledger |
| GET | [/api/v1/wallet/ledger/page](#get-api-v1-wallet-ledger-page) | JWT | — | Get a cursor page of current user token ledger |
| GET | [/api/v1/wallet/me](#get-api-v1-wallet-me) | JWT | — | Get current user Zwanga token wallet |
| POST | [/api/v1/wallet/topups](#post-api-v1-wallet-topups) | JWT | — | Buy Zwanga tokens through FlexPay |
| GET | [/api/v1/wallet/topups/:orderNumber/status](#get-api-v1-wallet-topups-ordernumber-status) | JWT | — | Check wallet topup payment status |
| POST | [/api/v1/wallet/topups/flexpay/callback](#post-api-v1-wallet-topups-flexpay-callback) | public | — | Receive FlexPay callback for wallet topups |
| POST | [/api/v1/wallet/transfers](#post-api-v1-wallet-transfers) | JWT | — | Share Zwanga tokens with another platform user |
| GET | [/api/v1/wallet/withdrawals](#get-api-v1-wallet-withdrawals) | JWT | — | — |
| POST | [/api/v1/wallet/withdrawals](#post-api-v1-wallet-withdrawals) | JWT | — | Withdraw purchased tokens to Mobile Money (KYC required) |
| GET | [/api/v1/wallet/withdrawals/:id/status](#get-api-v1-wallet-withdrawals-id-status) | JWT | — | — |
| POST | [/api/v1/wallet/withdrawals/flexpay/callback](#post-api-v1-wallet-withdrawals-flexpay-callback) | public | — | — |

### Driver Settlements (10)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/driver-settlements/bookings/:bookingId/revenue-summary](#get-api-v1-driver-settlements-bookings-bookingid-revenue-summary) | JWT | — | Afficher le gain du conducteur pour une réservation après dépose |
| GET | [/api/v1/driver-settlements/earnings](#get-api-v1-driver-settlements-earnings) | JWT | — | Get current driver earnings |
| GET | [/api/v1/driver-settlements/earnings/page](#get-api-v1-driver-settlements-earnings-page) | JWT | — | — |
| GET | [/api/v1/driver-settlements/me](#get-api-v1-driver-settlements-me) | JWT | — | Get current driver settlement balance |
| GET | [/api/v1/driver-settlements/payouts](#get-api-v1-driver-settlements-payouts) | JWT | — | Get current driver payouts |
| POST | [/api/v1/driver-settlements/payouts](#post-api-v1-driver-settlements-payouts) | JWT | — | Request a FlexPay Mobile Money driver payout |
| GET | [/api/v1/driver-settlements/payouts/:orderNumber/status](#get-api-v1-driver-settlements-payouts-ordernumber-status) | JWT | — | Check driver payout status |
| POST | [/api/v1/driver-settlements/payouts/flexpay/callback](#post-api-v1-driver-settlements-payouts-flexpay-callback) | public | — | Receive FlexPay callback for driver payouts |
| GET | [/api/v1/driver-settlements/payouts/page](#get-api-v1-driver-settlements-payouts-page) | JWT | — | — |
| GET | [/api/v1/driver-settlements/trips/:tripId/revenue-summary](#get-api-v1-driver-settlements-trips-tripid-revenue-summary) | JWT | — | Get the authenticated driver trip revenue summary |

### Driver Payout Recovery (2)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/driver-settlements/payouts/:id/refresh](#post-api-v1-driver-settlements-payouts-id-refresh) | JWT | — | Vérifier un retrait par son ID Zwanga, même sans numéro FlexPay |
| POST | [/api/v1/driver-settlements/payouts/:id/review](#post-api-v1-driver-settlements-payouts-id-review) | JWT | — | Signaler un retrait bloqué, sans annulation ni nouvel envoi |

### Admin Driver Payout Recovery (5)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/admin/driver-payouts](#get-api-v1-admin-driver-payouts) | JWT | admin | — |
| GET | [/api/v1/admin/driver-payouts/:id](#get-api-v1-admin-driver-payouts-id) | JWT | admin | — |
| POST | [/api/v1/admin/driver-payouts/:id/close-late-success](#post-api-v1-admin-driver-payouts-id-close-late-success) | JWT | admin | — |
| POST | [/api/v1/admin/driver-payouts/:id/reconcile](#post-api-v1-admin-driver-payouts-id-reconcile) | JWT | admin | — |
| POST | [/api/v1/admin/driver-payouts/:id/resolve-not-paid](#post-api-v1-admin-driver-payouts-id-resolve-not-paid) | JWT | admin | Libérer les gains après confirmation définitive FlexPay de non-paiement (preuve obligatoire) |

### Driver finance (3)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/driver-finance/bookings/:id/payment-options](#get-api-v1-driver-finance-bookings-id-payment-options) | JWT | — | — |
| GET | [/api/v1/driver-finance/me](#get-api-v1-driver-finance-me) | JWT | — | — |
| GET | [/api/v1/driver-finance/trips/:id/payment-options](#get-api-v1-driver-finance-trips-id-payment-options) | JWT | — | — |

### Subscriptions (14)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/subscriptions/document-funding-requests](#get-api-v1-subscriptions-document-funding-requests) | JWT | admin | List document funding requests (Admin) |
| POST | [/api/v1/subscriptions/document-funding-requests](#post-api-v1-subscriptions-document-funding-requests) | JWT | — | Create a document funding request for a premium driver |
| PUT | [/api/v1/subscriptions/document-funding-requests/:requestId/status](#put-api-v1-subscriptions-document-funding-requests-requestid-status) | JWT | admin | Update a document funding request status (Admin) |
| GET | [/api/v1/subscriptions/document-funding-requests/my](#get-api-v1-subscriptions-document-funding-requests-my) | JWT | — | Get my document funding requests |
| POST | [/api/v1/subscriptions/flexpay/callback](#post-api-v1-subscriptions-flexpay-callback) | public | — | Receive FlexPay payment callback |
| GET | [/api/v1/subscriptions/my-subscription](#get-api-v1-subscriptions-my-subscription) | JWT | — | Get current active subscription |
| GET | [/api/v1/subscriptions/my-subscriptions](#get-api-v1-subscriptions-my-subscriptions) | JWT | — | Get all subscriptions of the current user |
| GET | [/api/v1/subscriptions/payments/:orderNumber/status](#get-api-v1-subscriptions-payments-ordernumber-status) | JWT | — | Check FlexPay payment status and activate if paid |
| GET | [/api/v1/subscriptions/plans](#get-api-v1-subscriptions-plans) | public | — | List premium subscription plans and benefits |
| GET | [/api/v1/subscriptions/premium-overview](#get-api-v1-subscriptions-premium-overview) | JWT | — | Get premium subscription benefits for the current driver |
| GET | [/api/v1/subscriptions/status](#get-api-v1-subscriptions-status) | JWT | — | Check subscription status |
| POST | [/api/v1/subscriptions/subscribe](#post-api-v1-subscriptions-subscribe) | JWT | — | Initiate payment for a premium subscription |
| POST | [/api/v1/subscriptions/subscribe/points](#post-api-v1-subscriptions-subscribe-points) | JWT | — | Pay a premium subscription with Zwanga tokens |
| POST | [/api/v1/subscriptions/trial](#post-api-v1-subscriptions-trial) | JWT | — | Start trial period |

### Referrals (14)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/referrals/me](#get-api-v1-referrals-me) | JWT | — | Get referral link, balances and program rules |
| POST | [/api/v1/referrals/me/attribution](#post-api-v1-referrals-me-attribution) | JWT | — | Attach the authenticated account to its first referrer when none exists |
| GET | [/api/v1/referrals/me/ledger](#get-api-v1-referrals-me-ledger) | JWT | — | — |
| GET | [/api/v1/referrals/me/referrals](#get-api-v1-referrals-me-referrals) | JWT | — | List direct referrals and the earnings generated by each one |
| GET | [/api/v1/referrals/me/referrals/page](#get-api-v1-referrals-me-referrals-page) | JWT | — | — |
| GET | [/api/v1/referrals/me/rewards](#get-api-v1-referrals-me-rewards) | JWT | — | — |
| GET | [/api/v1/referrals/me/rewards/page](#get-api-v1-referrals-me-rewards-page) | JWT | — | — |
| GET | [/api/v1/referrals/me/withdrawals](#get-api-v1-referrals-me-withdrawals) | JWT | — | — |
| POST | [/api/v1/referrals/me/withdrawals](#post-api-v1-referrals-me-withdrawals) | JWT | — | — |
| GET | [/api/v1/referrals/me/withdrawals/page](#get-api-v1-referrals-me-withdrawals-page) | JWT | — | — |
| POST | [/api/v1/referrals/resolve-attribution](#post-api-v1-referrals-resolve-attribution) | public | — | Resolve an automatic ChottuLink referral attribution |
| POST | [/api/v1/referrals/validate-code](#post-api-v1-referrals-validate-code) | public | — | Validate a legacy referral code |
| GET | [/api/v1/referrals/withdrawals/:orderNumber/status](#get-api-v1-referrals-withdrawals-ordernumber-status) | JWT | — | — |
| POST | [/api/v1/referrals/withdrawals/flexpay/callback](#post-api-v1-referrals-withdrawals-flexpay-callback) | public | — | — |

### Notifications (6)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/notifications](#get-api-v1-notifications) | JWT | — | Récupérer toutes les notifications de l'utilisateur |
| PUT | [/api/v1/notifications/disable](#put-api-v1-notifications-disable) | JWT | — | Désactiver des notifications (les retirer de la liste affichée) |
| PUT | [/api/v1/notifications/enable](#put-api-v1-notifications-enable) | JWT | — | Réactiver des notifications (les remettre dans la liste affichée) |
| PUT | [/api/v1/notifications/mark-all-as-read](#put-api-v1-notifications-mark-all-as-read) | JWT | — | Marquer toutes les notifications comme lues |
| PUT | [/api/v1/notifications/mark-as-read](#put-api-v1-notifications-mark-as-read) | JWT | — | Marquer des notifications comme lues |
| PUT | [/api/v1/notifications/mark-as-unread](#put-api-v1-notifications-mark-as-unread) | JWT | — | Marquer des notifications comme non lues |

### Chat (2)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/chat/booking/:bookingId/messages](#get-api-v1-chat-booking-bookingid-messages) | JWT | — | Get messages for a booking |
| PUT | [/api/v1/chat/messages/:messageId/read](#put-api-v1-chat-messages-messageid-read) | JWT | — | Mark a message as read |

### Conversations (13)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/conversations](#get-api-v1-conversations) | JWT | — | Lister les conversations |
| POST | [/api/v1/conversations](#post-api-v1-conversations) | JWT | — | Créer une conversation |
| GET | [/api/v1/conversations/:id](#get-api-v1-conversations-id) | JWT | — | Récupérer une conversation |
| DELETE | [/api/v1/conversations/:id](#delete-api-v1-conversations-id) | JWT | — | Supprimer une conversation |
| GET | [/api/v1/conversations/:id/messages](#get-api-v1-conversations-id-messages) | JWT | — | Liste des messages d’une conversation |
| POST | [/api/v1/conversations/:id/messages](#post-api-v1-conversations-id-messages) | JWT | — | Envoyer un message dans une conversation |
| GET | [/api/v1/conversations/:id/messages/page](#get-api-v1-conversations-id-messages-page) | JWT | — | Messages paginés, du plus récent au plus ancien |
| POST | [/api/v1/conversations/:id/participants](#post-api-v1-conversations-id-participants) | JWT | — | Ajouter des participants |
| DELETE | [/api/v1/conversations/:id/participants/:userId](#delete-api-v1-conversations-id-participants-userid) | JWT | — | Retirer un participant |
| POST | [/api/v1/conversations/:id/read](#post-api-v1-conversations-id-read) | JWT | — | Marquer la conversation comme lue |
| POST | [/api/v1/conversations/direct](#post-api-v1-conversations-direct) | JWT | — | — |
| PATCH | [/api/v1/conversations/messages/:messageId](#patch-api-v1-conversations-messages-messageid) | JWT | — | Modifier un message envoyé |
| DELETE | [/api/v1/conversations/messages/:messageId](#delete-api-v1-conversations-messages-messageid) | JWT | — | Supprimer un message envoyé |

### Chatbot (3)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/chatbot/chat](#post-api-v1-chatbot-chat) | public | — | Envoyer un message au chatbot |
| POST | [/api/v1/chatbot/chat/authenticated](#post-api-v1-chatbot-chat-authenticated) | JWT | — | Envoyer un message au chatbot (utilisateur authentifié) |
| DELETE | [/api/v1/chatbot/conversation/:conversationId](#delete-api-v1-chatbot-conversation-conversationid) | JWT | — | Supprimer l'historique d'une conversation |

### Support (22)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/support/admin/tickets](#get-api-v1-support-admin-tickets) | JWT | admin | Lister tous les tickets (Admin) |
| GET | [/api/v1/support/admin/tickets/:id](#get-api-v1-support-admin-tickets-id) | JWT | admin | Récupérer un ticket (Admin) |
| PATCH | [/api/v1/support/admin/tickets/:id/assign](#patch-api-v1-support-admin-tickets-id-assign) | JWT | admin | Assigner un ticket a un admin |
| POST | [/api/v1/support/admin/tickets/:id/messages](#post-api-v1-support-admin-tickets-id-messages) | JWT | admin | Ajouter un message ticket (Admin) |
| PATCH | [/api/v1/support/admin/tickets/:id/status](#patch-api-v1-support-admin-tickets-id-status) | JWT | admin | Mettre à jour le statut d’un ticket (Admin) |
| GET | [/api/v1/support/config](#get-api-v1-support-config) | public | — | Récupérer la configuration publique du support center |
| GET | [/api/v1/support/conversations](#get-api-v1-support-conversations) | JWT | — | Lister les conversations de support |
| POST | [/api/v1/support/conversations](#post-api-v1-support-conversations) | JWT | — | Créer une conversation avec le support |
| GET | [/api/v1/support/conversations/:id](#get-api-v1-support-conversations-id) | JWT | — | Obtenir une conversation de support |
| GET | [/api/v1/support/conversations/:id/messages](#get-api-v1-support-conversations-id-messages) | JWT | — | Lister les messages d’une conversation de support |
| POST | [/api/v1/support/conversations/:id/messages](#post-api-v1-support-conversations-id-messages) | JWT | — | Envoyer un message au support |
| GET | [/api/v1/support/faq](#get-api-v1-support-faq) | public | — | Lister les FAQ depuis le support center |
| POST | [/api/v1/support/faq](#post-api-v1-support-faq) | JWT | admin | Créer une entrée FAQ (Admin) |
| GET | [/api/v1/support/faq/:id](#get-api-v1-support-faq-id) | public | — | Récupérer une FAQ depuis le support center |
| PUT | [/api/v1/support/faq/:id](#put-api-v1-support-faq-id) | JWT | admin | Mettre à jour une entrée FAQ (Admin) |
| DELETE | [/api/v1/support/faq/:id](#delete-api-v1-support-faq-id) | JWT | admin | Supprimer une entrée FAQ (Admin) |
| GET | [/api/v1/support/tickets](#get-api-v1-support-tickets) | JWT | — | Lister mes tickets de support |
| POST | [/api/v1/support/tickets](#post-api-v1-support-tickets) | JWT | — | Créer un ticket de support |
| GET | [/api/v1/support/tickets/:id](#get-api-v1-support-tickets-id) | JWT | — | Récupérer un ticket de support |
| PATCH | [/api/v1/support/tickets/:id/close](#patch-api-v1-support-tickets-id-close) | JWT | — | Fermer mon ticket de support |
| POST | [/api/v1/support/tickets/:id/messages](#post-api-v1-support-tickets-id-messages) | JWT | — | Ajouter un message a mon ticket |
| PATCH | [/api/v1/support/tickets/:id/reopen](#patch-api-v1-support-tickets-id-reopen) | JWT | — | Rouvrir mon ticket de support |

### FAQ (5)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/faq](#get-api-v1-faq) | JWT | — | Liste des questions fréquentes |
| POST | [/api/v1/faq](#post-api-v1-faq) | JWT | admin | Créer une entrée FAQ |
| GET | [/api/v1/faq/:id](#get-api-v1-faq-id) | JWT | — | Récupérer une FAQ |
| PUT | [/api/v1/faq/:id](#put-api-v1-faq-id) | JWT | admin | Mettre à jour une entrée FAQ |
| DELETE | [/api/v1/faq/:id](#delete-api-v1-faq-id) | JWT | admin | Supprimer une entrée FAQ |

### Safety (15)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/safety/admin/reports](#get-api-v1-safety-admin-reports) | JWT | admin | Lister tous les signalements de la plateforme (Admin) |
| GET | [/api/v1/safety/alerts](#get-api-v1-safety-alerts) | JWT | — | Récupérer toutes les alertes de sécurité |
| POST | [/api/v1/safety/alerts](#post-api-v1-safety-alerts) | JWT | — | Créer une alerte de sécurité |
| GET | [/api/v1/safety/alerts/:id](#get-api-v1-safety-alerts-id) | JWT | — | Récupérer une alerte de sécurité spécifique |
| PUT | [/api/v1/safety/alerts/:id/status](#put-api-v1-safety-alerts-id-status) | JWT | — | Mettre à jour le statut d'une alerte de sécurité |
| GET | [/api/v1/safety/emergency-contacts](#get-api-v1-safety-emergency-contacts) | JWT | — | Récupérer tous les contacts d'urgence de l'utilisateur |
| POST | [/api/v1/safety/emergency-contacts](#post-api-v1-safety-emergency-contacts) | JWT | — | Créer un contact d'urgence |
| PUT | [/api/v1/safety/emergency-contacts/:id](#put-api-v1-safety-emergency-contacts-id) | JWT | — | Mettre à jour un contact d'urgence |
| DELETE | [/api/v1/safety/emergency-contacts/:id](#delete-api-v1-safety-emergency-contacts-id) | JWT | — | Supprimer un contact d'urgence |
| POST | [/api/v1/safety/emergency-contacts/batch](#post-api-v1-safety-emergency-contacts-batch) | JWT | — | Créer plusieurs contacts d'urgence en une seule requête (jusqu'à 5 au total) |
| POST | [/api/v1/safety/location/update](#post-api-v1-safety-location-update) | JWT | — | Mettre à jour la position et l'état du téléphone |
| GET | [/api/v1/safety/reports](#get-api-v1-safety-reports) | JWT | — | Récupérer tous les signalements de l'utilisateur |
| POST | [/api/v1/safety/reports](#post-api-v1-safety-reports) | JWT | — | Signaler un utilisateur |
| GET | [/api/v1/safety/reports/:id](#get-api-v1-safety-reports-id) | JWT | — | Récupérer un signalement spécifique |
| PUT | [/api/v1/safety/reports/:id/status](#put-api-v1-safety-reports-id-status) | JWT | — | Mettre à jour le statut d'un signalement (Admin uniquement) |

### Google Maps (7)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/google-maps/directions](#post-api-v1-google-maps-directions) | public | — | Get directions between origin and destination |
| POST | [/api/v1/google-maps/geocode](#post-api-v1-google-maps-geocode) | public | — | Geocode an address to coordinates |
| GET | [/api/v1/google-maps/places/autocomplete](#get-api-v1-google-maps-places-autocomplete) | public | — | Get place autocomplete predictions |
| GET | [/api/v1/google-maps/places/details](#get-api-v1-google-maps-places-details) | public | — | Get place details by place ID |
| GET | [/api/v1/google-maps/places/landmarks](#get-api-v1-google-maps-places-landmarks) | public | — | Get curated landmarks for a city, with Kinshasa enabled by default |
| GET | [/api/v1/google-maps/places/search](#get-api-v1-google-maps-places-search) | public | — | Search for places using text query |
| POST | [/api/v1/google-maps/reverse-geocode](#post-api-v1-google-maps-reverse-geocode) | public | — | Reverse geocode coordinates to address |

### Yandex Maps (4)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/yandex-maps/geocode](#post-api-v1-yandex-maps-geocode) | public | — | Geocode an address using Yandex Geocoder API |
| GET | [/api/v1/yandex-maps/geosuggest](#get-api-v1-yandex-maps-geosuggest) | public | — | Get suggestions using Yandex Geosuggest API |
| GET | [/api/v1/yandex-maps/places/search](#get-api-v1-yandex-maps-places-search) | public | — | Search places using Yandex Places HTTP API |
| POST | [/api/v1/yandex-maps/reverse-geocode](#post-api-v1-yandex-maps-reverse-geocode) | public | — | Reverse geocode coordinates using Yandex Geocoder API |

### Activity (1)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/me/activity](#get-api-v1-me-activity) | JWT | — | État léger de l’activité personnelle, sans historique ni données GPS |

### Pro Services (16)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1/pro-services/admin/cases](#get-api-v1-pro-services-admin-cases) | JWT | admin | — |
| GET | [/api/v1/pro-services/admin/cases/:id](#get-api-v1-pro-services-admin-cases-id) | JWT | admin | — |
| POST | [/api/v1/pro-services/admin/cases/:id/documents/:documentId](#post-api-v1-pro-services-admin-cases-id-documents-documentid) | JWT | admin | — |
| POST | [/api/v1/pro-services/admin/cases/:id/ledger](#post-api-v1-pro-services-admin-cases-id-ledger) | JWT | admin | — |
| POST | [/api/v1/pro-services/admin/cases/:id/owner](#post-api-v1-pro-services-admin-cases-id-owner) | JWT | admin | — |
| POST | [/api/v1/pro-services/admin/cases/:id/quote](#post-api-v1-pro-services-admin-cases-id-quote) | JWT | admin | — |
| PUT | [/api/v1/pro-services/admin/cases/:id/status](#put-api-v1-pro-services-admin-cases-id-status) | JWT | admin | — |
| GET | [/api/v1/pro-services/admin/catalogue](#get-api-v1-pro-services-admin-catalogue) | JWT | admin | — |
| PUT | [/api/v1/pro-services/admin/catalogue/:code](#put-api-v1-pro-services-admin-catalogue-code) | JWT | super_admin | — |
| POST | [/api/v1/pro-services/applications](#post-api-v1-pro-services-applications) | JWT | — | — |
| GET | [/api/v1/pro-services/catalogue](#get-api-v1-pro-services-catalogue) | public | — | — |
| GET | [/api/v1/pro-services/mine](#get-api-v1-pro-services-mine) | JWT | — | — |
| GET | [/api/v1/pro-services/mine/:id](#get-api-v1-pro-services-mine-id) | JWT | — | — |
| POST | [/api/v1/pro-services/mine/:id/accept](#post-api-v1-pro-services-mine-id-accept) | JWT | — | — |
| POST | [/api/v1/pro-services/mine/:id/cancel](#post-api-v1-pro-services-mine-id-cancel) | JWT | — | — |
| POST | [/api/v1/pro-services/public-applications](#post-api-v1-pro-services-public-applications) | public | — | — |

### App Updates (5)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| POST | [/api/v1/app-updates/client](#post-api-v1-app-updates-client) | JWT | — | — |
| GET | [/api/v1/app-updates/latest](#get-api-v1-app-updates-latest) | public | — | — |
| GET | [/api/v1/app-updates/releases](#get-api-v1-app-updates-releases) | JWT | admin | — |
| POST | [/api/v1/app-updates/releases](#post-api-v1-app-updates-releases) | JWT | admin | — |
| POST | [/api/v1/app-updates/releases/:id/withdraw](#post-api-v1-app-updates-releases-id-withdraw) | JWT | admin | — |

### Application (1)

| Méthode | Chemin | Accès | Rôle | Résumé Swagger |
| --- | --- | --- | --- | --- |
| GET | [/api/v1](#get-api-v1) | public | — | — |

## Détail par domaine

## Auth

Inscription, connexion par numéro et PIN, réinitialisation du PIN, session JWT, connexion administrateur et authentification Google ou Apple. Le mot de passe des comptes mobiles est un PIN à 4 chiffres. Les comptes administrateur utilisent un mot de passe distinct.

<a id="post-api-v1-auth-admin-bootstrap-confirm"></a>
### POST `/api/v1/auth/admin/bootstrap/confirm`

Swagger résume l’opération ainsi : « Create the initial super administrator with OTP ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 3 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AdminBootstrapConfirmDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.confirmAdminBootstrap` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**En-têtes de requête**

- `x-admin-bootstrap-secret` — facultatif.

**Corps**

Classe `AdminBootstrapConfirmDto`.

- **`phone`** — obligatoire, string. exemple `+243831919710`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`otp`** — obligatoire, string. exemple `123456`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`firstName`** — facultatif, string. exemple `Buania`. chaîne de caractères ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — facultatif, string. exemple `Superadmin`. chaîne de caractères ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`password`** — facultatif, string. Mot de passe temporaire. Si absent, ADMIN_BOOTSTRAP_DEFAULT_PASSWORD est utilisé côté serveur.. exemple `MotDePasseTemporaire-2026!`. chaîne de caractères ; au moins 8 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-auth-admin-bootstrap-send-otp"></a>
### POST `/api/v1/auth/admin/bootstrap/send-otp`

Swagger résume l’opération ainsi : « Send OTP for the initial super administrator ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 3 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AdminBootstrapSendOtpDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.sendAdminBootstrapOtp` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**En-têtes de requête**

- `x-admin-bootstrap-secret` — facultatif.

**Corps**

Classe `AdminBootstrapSendOtpDto`.

- **`phone`** — obligatoire, string. exemple `+243831919710`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

<a id="post-api-v1-auth-admin-login"></a>
### POST `/api/v1/auth/admin/login`

Swagger résume l’opération ainsi : « Login administrator with phone number and password ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Un second plafond suit l’empreinte du numéro de téléphone envoyé dans le corps : 20 tentatives par 15 minutes et 60 par 24 heures. Le corps suit `AdminLoginDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.adminLogin` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `AdminLoginDto`.

- **`phone`** — obligatoire, string. exemple `+243900000000`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`password`** — conditionnel, string. Mot de passe administrateur. Les anciens PIN admin de 4 chiffres restent acceptés à la connexion.. exemple `Temporaire-2026!`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.
- **`pin`** — conditionnel, string. Compatibilité temporaire avec les anciens PIN admin.. exemple `1234`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « Le code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **401** — Invalid admin phone number or password

<a id="post-api-v1-auth-admin-password-change"></a>
### POST `/api/v1/auth/admin/password/change`

Swagger résume l’opération ainsi : « Change administrator password ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AdminChangePasswordDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.changeAdminPassword` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `AdminChangePasswordDto`.

- **`currentPassword`** — obligatoire, string. exemple `Temporaire-2026!`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.
- **`newPassword`** — obligatoire, string. exemple `NouveauMotDePasse-2026!`. chaîne de caractères ; ne doit pas être vide ; au moins 8 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-auth-apple-mobile"></a>
### POST `/api/v1/auth/apple/mobile`

Swagger résume l’opération ainsi : « Apple Sign-In (mobile): identityToken + phone -> JWT tokens ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AppleMobileAuthDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.appleMobile` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `AppleMobileAuthDto`.

- **`referralProvider`** — facultatif, énumération. Fournisseur ayant resolu le lien. valeur autorisée : `chottulink`, `branch` ; énumération Swagger : `chottulink`, `branch`. présent dans le schéma Swagger.
- **`referralToken`** — facultatif, string. chaîne de caractères ; au plus 64 caractère(s) ; motif `/^[A-Za-z0-9_-]+$/`. présent dans le schéma Swagger.
- **`referralReferringLink`** — facultatif, string. exemple `https://zwanga.chottu.link/abc123`. chaîne de caractères ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`referralCapturedAt`** — facultatif, string. exemple `2026-08-25T10:00:00.000Z`. date ISO. présent dans le schéma Swagger.
- **`referralCode`** — facultatif, string. exemple `ZW7K9M2P4Q`. chaîne de caractères ; au plus 16 caractère(s) ; motif `/^[A-Za-z0-9]+$/`. présent dans le schéma Swagger.
- **`idToken`** — obligatoire, string. Apple identity token obtenu cote mobile (Sign in with Apple). chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`nonce`** — facultatif, string. Nonce envoyé à Apple au moment de la demande, si utilisé. chaîne de caractères. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro de téléphone requis au premier login Apple. exemple `+243900000000`. chaîne de caractères. présent dans le schéma Swagger.
- **`firstName`** — facultatif, string. Prénom fourni par Apple uniquement lors de la première autorisation. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — facultatif, string. Nom fourni par Apple uniquement lors de la première autorisation. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`gender`** — facultatif, énumération. Sexe choisi lors de la première inscription Apple. exemple `female`. valeur autorisée : `male`, `female`, `other`, `prefer_not_to_say` ; énumération Swagger : `male`, `female`, `other`, `prefer_not_to_say`. présent dans le schéma Swagger.
- **`role`** — facultatif, énumération. Rôle choisi pendant la première inscription Apple. exemple `passenger`. valeur autorisée : `driver`, `passenger` ; énumération Swagger : `driver`, `passenger`. présent dans le schéma Swagger.
- **`isDriver`** — facultatif, boolean. Indique si utilisateur est conducteur. exemple `false`. booléen. présent dans le schéma Swagger.
- **`vehicle`** — facultatif, CreateVehicleDto. Infos véhicule pour la première inscription Apple conducteur. objet imbriqué validé. présent dans le schéma Swagger.
  - **`brand`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`model`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`color`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. Type du véhicule. Une moto à 2 roues accepte au maximum 2 places, une moto à 3 roues 3 places.. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels` ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
  - **`licensePlate`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`photoUrl`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **401** — La connexion avec Apple n’a pas pu être vérifiée. Réessayez.

<a id="post-api-v1-auth-exchange"></a>
### POST `/api/v1/auth/exchange`

Swagger résume l’opération ainsi : « Exchange a one-time OAuth code for JWT tokens ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `OAuthExchangeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.exchange` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **En-têtes de réponse imposés :** `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`

**Corps**

Classe `OAuthExchangeDto`.

- **`code`** — obligatoire, string. Code de connexion à usage unique, valable 60 secondes. chaîne de caractères ; ne doit pas être vide ; motif `/^[a-f0-9]{64}$/`. Message renvoyé : « Code de connexion invalide. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **401** — Invalid, expired or already consumed code

<a id="get-api-v1-auth-google"></a>
### GET `/api/v1/auth/google`

Swagger résume l’opération ainsi : « Initiate Google OAuth authentication ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `AuthController.googleAuth` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200

**Réponses déclarées dans Swagger**

- **302** — Redirects to Google OAuth

<a id="get-api-v1-auth-google-callback"></a>
### GET `/api/v1/auth/google/callback`

Swagger résume l’opération ainsi : « Google OAuth callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le contrôleur écrit lui-même la réponse HTTP, en pratique une redirection. Le corps JSON habituel ne s’applique pas.

- **Contrôleur :** `AuthController.googleAuthCallback` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200
- **En-têtes de réponse imposés :** `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`

**Réponses déclarées dans Swagger**

- **302** — Redirects with a one-time exchange code, never JWTs
- **401** — La connexion a échoué. Veuillez réessayer.

<a id="post-api-v1-auth-google-mobile"></a>
### POST `/api/v1/auth/google/mobile`

Swagger résume l’opération ainsi : « Google Sign-In (mobile): idToken + phone -> JWT tokens ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `GoogleMobileAuthDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.googleMobile` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `GoogleMobileAuthDto`.

- **`referralProvider`** — facultatif, énumération. Fournisseur ayant resolu le lien. valeur autorisée : `chottulink`, `branch` ; énumération Swagger : `chottulink`, `branch`. présent dans le schéma Swagger.
- **`referralToken`** — facultatif, string. chaîne de caractères ; au plus 64 caractère(s) ; motif `/^[A-Za-z0-9_-]+$/`. présent dans le schéma Swagger.
- **`referralReferringLink`** — facultatif, string. exemple `https://zwanga.chottu.link/abc123`. chaîne de caractères ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`referralCapturedAt`** — facultatif, string. exemple `2026-08-25T10:00:00.000Z`. date ISO. présent dans le schéma Swagger.
- **`referralCode`** — facultatif, string. exemple `ZW7K9M2P4Q`. chaîne de caractères ; au plus 16 caractère(s) ; motif `/^[A-Za-z0-9]+$/`. présent dans le schéma Swagger.
- **`idToken`** — obligatoire, string. Google ID token obtenu cote mobile (Expo / React Native). chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro de téléphone requis au premier login Google. exemple `+243900000000`. chaîne de caractères. présent dans le schéma Swagger.
- **`firstName`** — facultatif, string. Prénom(s) légaux confirmés pendant la première inscription. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — facultatif, string. Nom légal confirmé pendant la première inscription (post-nom facultatif). chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`gender`** — facultatif, énumération. Sexe choisi lors de la première inscription Google. exemple `female`. valeur autorisée : `male`, `female`, `other`, `prefer_not_to_say` ; énumération Swagger : `male`, `female`, `other`, `prefer_not_to_say`. présent dans le schéma Swagger.
- **`role`** — facultatif, énumération. Rôle choisi pendant la première inscription Google. exemple `passenger`. valeur autorisée : `driver`, `passenger` ; énumération Swagger : `driver`, `passenger`. présent dans le schéma Swagger.
- **`isDriver`** — facultatif, boolean. Indique si utilisateur est conducteur. exemple `false`. booléen. présent dans le schéma Swagger.
- **`vehicle`** — facultatif, CreateVehicleDto. Infos véhicule pour la première inscription Google conducteur. objet imbriqué validé. présent dans le schéma Swagger.
  - **`brand`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`model`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`color`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. Type du véhicule. Une moto à 2 roues accepte au maximum 2 places, une moto à 3 roues 3 places.. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels` ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
  - **`licensePlate`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`photoUrl`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **401** — La connexion avec Google n’a pas pu être vérifiée. Réessayez.

<a id="post-api-v1-auth-login"></a>
### POST `/api/v1/auth/login`

Swagger résume l’opération ainsi : « Login user with phone number and PIN ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Un second plafond suit l’empreinte du numéro de téléphone envoyé dans le corps : 20 tentatives par 15 minutes et 60 par 24 heures. Le corps suit `LoginDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.login` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `LoginDto`.

- **`phone`** — obligatoire, string. exemple `0831919710`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`pin`** — obligatoire, string. PIN a 4 chiffres. exemple `1234`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « Le code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **401** — Invalid phone number or PIN

<a id="post-api-v1-auth-logout"></a>
### POST `/api/v1/auth/logout`

Swagger résume l’opération ainsi : « Logout user and invalidate refresh token ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `AuthController.logout` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Logged out successfully
- **401** — Unauthorized

<a id="post-api-v1-auth-pin-reset"></a>
### POST `/api/v1/auth/pin/reset`

Swagger résume l’opération ainsi : « Set a new PIN with a one-time reset token ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `PinResetConfirmDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.resetPin` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `PinResetConfirmDto`.

- **`resetToken`** — obligatoire, string. Jeton de reinitialisation a usage unique obtenu apres OTP. chaîne de caractères ; ne doit pas être vide ; au plus 256 caractère(s). présent dans le schéma Swagger.
- **`newPin`** — obligatoire, string. Nouveau PIN a 4 chiffres. exemple `5678`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « Le nouveau code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — PIN reset successfully
- **400** — Invalid or expired reset token

<a id="post-api-v1-auth-pin-reset-request-otp"></a>
### POST `/api/v1/auth/pin/reset/request-otp`

Swagger résume l’opération ainsi : « Send an OTP to reset a forgotten PIN ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 3 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `PinResetRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.requestPinResetOtp` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `PinResetRequestDto`.

- **`phone`** — obligatoire, string. Numero de telephone du compte. exemple `+243831919710`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Generic response whether or not the account exists

<a id="post-api-v1-auth-pin-reset-verify-otp"></a>
### POST `/api/v1/auth/pin/reset/verify-otp`

Swagger résume l’opération ainsi : « Verify the OTP and issue a one-time reset token ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `PinResetVerifyOtpDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.verifyPinResetOtp` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `PinResetVerifyOtpDto`.

- **`phone`** — obligatoire, string. Numero de telephone du compte. exemple `+243831919710`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`otp`** — obligatoire, string. Code OTP recu par SMS. exemple `123456`. chaîne de caractères ; ne doit pas être vide ; motif `/^\d{4,8}$/`. Message renvoyé : « Le code OTP doit contenir entre 4 et 8 chiffres. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Reset token issued for 5 minutes
- **400** — Invalid or expired OTP

<a id="post-api-v1-auth-refresh"></a>
### POST `/api/v1/auth/refresh`

Swagger résume l’opération ainsi : « Refresh access token ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RefreshTokenDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.refresh` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `RefreshTokenDto`.

- **`refreshToken`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Token refreshed successfully
- **401** — Invalid refresh token

<a id="post-api-v1-auth-register"></a>
### POST `/api/v1/auth/register`

Swagger résume l’opération ainsi : « Register a new user with optional files ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RegisterDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AuthController.register` dans `src/auth/auth.controller.ts`
- **Succès par défaut :** 201
- **Content-Type déclaré :** `multipart/form-data`
- **Fichiers :** `profilePicture` (maximum 1), `cniImage` (maximum 1), `selfieImage` (maximum 1)

**Corps**

Classe `RegisterDto`.

- **`referralProvider`** — facultatif, énumération. Fournisseur ayant resolu le lien. valeur autorisée : `chottulink`, `branch` ; énumération Swagger : `chottulink`, `branch`. présent dans le schéma Swagger.
- **`referralToken`** — facultatif, string. chaîne de caractères ; au plus 64 caractère(s) ; motif `/^[A-Za-z0-9_-]+$/`. présent dans le schéma Swagger.
- **`referralReferringLink`** — facultatif, string. exemple `https://zwanga.chottu.link/abc123`. chaîne de caractères ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`referralCapturedAt`** — facultatif, string. exemple `2026-08-25T10:00:00.000Z`. date ISO. présent dans le schéma Swagger.
- **`referralCode`** — facultatif, string. Code du parrain, applicable uniquement à la création du compte. exemple `ZW7K9M2P4Q`. chaîne de caractères ; au plus 16 caractère(s) ; motif `/^[A-Za-z0-9]+$/`. présent dans le schéma Swagger.
- **`phone`** — obligatoire, string. exemple `+243900000000`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`pin`** — obligatoire, string. PIN a 4 chiffres. exemple `1234`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « Le code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.
- **`isDriver`** — facultatif, boolean. Indique si utilisateur est conducteur. exemple `true`. booléen. présent dans le schéma Swagger.
- **`firstName`** — obligatoire, string. exemple `John`. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — obligatoire, string. exemple `Doe`. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`gender`** — facultatif, énumération. Sexe choisi par l'utilisateur. exemple `female`. valeur autorisée : `male`, `female`, `other`, `prefer_not_to_say` ; énumération Swagger : `male`, `female`, `other`, `prefer_not_to_say`. présent dans le schéma Swagger.
- **`role`** — obligatoire, énumération. Role public autorise: driver ou passenger. exemple `driver`. valeur autorisée : `driver`, `passenger` ; ne doit pas être vide ; énumération Swagger : `driver`, `passenger`. présent dans le schéma Swagger.
- **`vehicle`** — facultatif, CreateVehicleDto. Infos vehicule (conducteurs uniquement). objet imbriqué validé. présent dans le schéma Swagger.
  - **`brand`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`model`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`color`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. Type du véhicule. Une moto à 2 roues accepte au maximum 2 places, une moto à 3 roues 3 places.. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels` ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
  - **`licensePlate`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`photoUrl`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

**Schéma `@ApiBody` publié dans Swagger**

- **`phone`** — déclaré. string. exemple `+243900000000`.
- **`referralCode`** — déclaré. string. Ancien code de parrainage, conserve pour compatibilite. exemple `ZW7K9M2P4Q`.
- **`referralToken`** — déclaré. string. Jeton opaque capture automatiquement depuis le lien ChottuLink. exemple `Z5MJkPNEXwlUzvLTWajEGIzXq3u5PF9W`.
- **`referralProvider`** — déclaré. string. Fournisseur ayant resolu le lien. exemple `chottulink`. valeurs `chottulink`, `branch`.
- **`referralReferringLink`** — déclaré. string. Lien ChottuLink d'origine, conserve pour audit. exemple `https://zwanga.chottu.link/AbCdEf`.
- **`referralCapturedAt`** — déclaré. string. format `date-time`. Date de capture de l'attribution ChottuLink.
- **`pin`** — déclaré. string. PIN à 4 chiffres. exemple `1234`.
- **`firstName`** — déclaré. string. exemple `John`.
- **`lastName`** — déclaré. string. exemple `Doe`.
- **`gender`** — déclaré. string. Sexe choisi par l'utilisateur (optionnel). exemple `female`.
- **`role`** — déclaré. string. Rôle public de l'utilisateur (driver ou passenger). exemple `driver`. valeurs `driver`, `passenger`.
- **`isDriver`** — déclaré. boolean. Indique si l’utilisateur souhaite conduire. exemple `true`.
- **`vehicle`** — déclaré. object. Informations du véhicule (optionnel, conducteurs uniquement).
  - **`type`** — obligatoire. string. exemple `motorcycle_2_wheels`.
  - **`brand`** — obligatoire. string. exemple `Toyota`.
  - **`model`** — obligatoire. string. exemple `Corolla`.
  - **`color`** — obligatoire. string. exemple `Noir`.
  - **`licensePlate`** — obligatoire. string. exemple `ABC-1234`.
  - **`photoUrl`** — déclaré. string. exemple `https://...`.
- **`profilePicture`** — déclaré. string. format `binary`. Photo de profil (optionnel).
- **`cniImage`** — déclaré. string. format `binary`. Image de la pièce d'identité (optionnel).
- **`selfieImage`** — déclaré. string. format `binary`. Photo selfie pour validation (optionnel).

**Réponses déclarées dans Swagger**

- **201** — objet `AuthResponseDto`
  - **`accessToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`refreshToken`** — obligatoire, string. présent dans le schéma Swagger.
  - **`passwordChangeRequired`** — facultatif, boolean. présent dans le schéma Swagger.
- **400** — Bad request

## Users

Profil de l’utilisateur connecté, suppression de compte, parcours conducteur, dossier KYC, jeton de notification et vérification du téléphone. L’identité vient toujours du JWT, sauf sur les routes explicitement publiques.

<a id="get-api-v1-users-id-public"></a>
### GET `/api/v1/users/:id/public`

Swagger résume l’opération ainsi : « Get public profile of a user (driver or passenger) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.getPublicProfile` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-users-driver-activation"></a>
### POST `/api/v1/users/driver-activation`

Swagger résume l’opération ainsi : « Activate the driver profile only after all requirements are met ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.activateDriver` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-users-driver-onboarding"></a>
### POST `/api/v1/users/driver-onboarding`

Swagger résume l’opération ainsi : « Request driver onboarding; activation requires approved identity and an active owned vehicle ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.requestDriverOnboarding` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-users-fcm-token"></a>
### POST `/api/v1/users/fcm-token`

Swagger résume l’opération ainsi : « Update FCM token for push notifications ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.updateFcmToken` dans `src/users/users.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Propriétés lues une à une dans le JSON :

- `fcmToken` — obligatoire, string.

<a id="post-api-v1-users-kyc"></a>
### POST `/api/v1/users/kyc`

Swagger résume l’opération ainsi : « Upload KYC documents ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UploadKycDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.uploadKyc` dans `src/users/users.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer
- **Content-Type déclaré :** `multipart/form-data`
- **Fichiers :** `cniFront` (maximum 1), `cniBack` (maximum 1), `selfie` (maximum 1)

**Corps**

Classe `UploadKycDto`.

- **`documentNumber`** — facultatif, string. Numéro de document ou référence. chaîne de caractères. présent dans le schéma Swagger.

**Schéma `@ApiBody` publié dans Swagger**

- **`cniFront`** — obligatoire. string. format `binary`.
- **`selfie`** — obligatoire. string. format `binary`.

<a id="post-api-v1-users-kyc-didit-session"></a>
### POST `/api/v1/users/kyc/didit/session`

Swagger résume l’opération ainsi : « Create a hosted Didit KYC verification session ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateDiditKycSessionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.createDiditKycSession` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateDiditKycSessionDto`.

- **`callbackUrl`** — facultatif, string. URL de retour mobile/web appelée après la session Didit. Les schémas d'application mobile sont acceptés.. exemple `zwanga://kyc/didit-return`. chaîne de caractères ; au plus 2048 caractère(s). présent dans le schéma Swagger.
- **`language`** — facultatif, string. Langue préférée pour la session Didit. exemple `fr`. chaîne de caractères ; au plus 10 caractère(s). présent dans le schéma Swagger.
- **`source`** — facultatif, string. Ecran ou contexte d'origine cote application. exemple `profile`. chaîne de caractères ; au plus 80 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-users-kyc-didit-sync"></a>
### POST `/api/v1/users/kyc/didit/sync`

Swagger résume l’opération ainsi : « Synchronize the current user Didit KYC session ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SyncDiditKycSessionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.syncDiditKycSession` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `SyncDiditKycSessionDto`.

- **`sessionId`** — facultatif, string. Identifiant de session Didit retourné par le callback. S'il est absent, la dernière session Didit de l'utilisateur est utilisée.. chaîne de caractères ; au plus 128 caractère(s). présent dans le schéma Swagger.
- **`status`** — facultatif, string. Statut reçu côté app. Il n'est jamais utilisé seul pour approuver un KYC ; le backend vérifie Didit côté serveur.. chaîne de caractères ; au plus 80 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-users-kyc-didit-webhook"></a>
### POST `/api/v1/users/kyc/didit/webhook`

Swagger résume l’opération ainsi : « Receive signed Didit KYC webhook events ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.handleDiditKycWebhook` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**En-têtes de requête**

- Tous les en-têtes de la requête sont lus par le contrôleur.

**Corps**

Le corps est un `Record<string, unknown>` sans classe DTO. Swagger ne publie pas ses propriétés.

<a id="get-api-v1-users-kyc-status"></a>
### GET `/api/v1/users/kyc/status`

Swagger résume l’opération ainsi : « Get KYC verification status ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.getKycStatus` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-users-me"></a>
### GET `/api/v1/users/me`

Swagger résume l’opération ainsi : « Get current user profile ». profileState v1 exposes server-owned identity status, driver eligibility and nextAction. Reading it never activates a driver. user.isPhoneVerified and user.phoneVerificationRequired report optional phone OTP verification. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.getProfile` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="put-api-v1-users-me"></a>
### PUT `/api/v1/users/me`

Swagger résume l’opération ainsi : « Update user profile ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateProfileDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.updateProfile` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **Content-Type déclaré :** `multipart/form-data`
- **Fichiers :** `profilePicture` (maximum 1)

**Corps**

Classe `UpdateProfileDto`.

- **`firstName`** — facultatif, string. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — facultatif, string. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`gender`** — facultatif, énumération. Sexe choisi par l'utilisateur. exemple `female`. valeur autorisée : `male`, `female`, `other`, `prefer_not_to_say` ; énumération Swagger : `male`, `female`, `other`, `prefer_not_to_say`. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`profilePicture`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`role`** — facultatif, énumération. Indique si l’utilisateur souhaite devenir conducteur. valeur autorisée : `driver`, `passenger` ; énumération Swagger : `driver`, `passenger`. présent dans le schéma Swagger.

<a id="delete-api-v1-users-me"></a>
### DELETE `/api/v1/users/me`

Swagger résume l’opération ainsi : « Delete current user account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `UsersController.deactivateAccount` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Account deleted successfully
  - **`message`** — déclaré. string. exemple `Compte supprimé avec succès`.

<a id="post-api-v1-users-phone-send-otp"></a>
### POST `/api/v1/users/phone/send-otp`

Swagger résume l’opération ainsi : « Send OTP code to phone number for verification ». Registration rejects numbers reserved by enabled active/pending-KYC accounts. Inactive or suspended accounts do not block a new signup; their number is released only when the new account is created. Login/update require a usable account. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SendPhoneVerificationOtpDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.sendPhoneVerificationOtp` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `SendPhoneVerificationOtpDto`.

- **`phone`** — obligatoire, string. Numéro de téléphone à vérifier. exemple `+243900000000`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`context`** — obligatoire, énumération. Contexte de la vérification : registration (inscription), login (connexion), ou update (mise à jour). exemple `login`. ne doit pas être vide. Message renvoyé : « context should not be empty » ; valeur autorisée : `registration`, `login`, `update`. Message renvoyé : « Le contexte de vérification est invalide. Choisissez l’inscription, la connexion ou la mise à jour. » ; énumération Swagger : `registration`, `login`, `update`. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — OTP sent successfully
  - **`message`** — déclaré. string. exemple `Code de vérification envoyé avec succès`.
- **400** — Bad request - Phone reserved by a usable account, or no usable account found for login/update

<a id="post-api-v1-users-phone-verify"></a>
### POST `/api/v1/users/phone/verify`

Swagger résume l’opération ainsi : « Verify OTP code sent to phone number ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `VerifyPhoneOtpDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.verifyPhoneOtp` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `VerifyPhoneOtpDto`.

- **`phone`** — obligatoire, string. Numéro de téléphone à vérifier. exemple `+243900000000`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`otp`** — obligatoire, string. Code OTP reçu par SMS. exemple `123456`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — OTP verified successfully
  - **`message`** — déclaré. string. exemple `Code OTP vérifié avec succès`.
  - **`valid`** — déclaré. boolean. exemple `true`.
- **400** — Bad request - Invalid or expired OTP

<a id="post-api-v1-users-pin-change"></a>
### POST `/api/v1/users/pin/change`

Swagger résume l’opération ainsi : « Change user PIN code ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ChangePinDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `UsersController.changePin` dans `src/users/users.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `ChangePinDto`.

- **`oldPin`** — obligatoire, string. Ancien PIN (4 chiffres). exemple `1234`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « L’ancien code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.
- **`newPin`** — obligatoire, string. Nouveau PIN (4 chiffres). exemple `5678`. chaîne de caractères ; ne doit pas être vide ; au moins 4 caractère(s) ; au plus 4 caractère(s) ; motif `/^\d{4}$/`. Message renvoyé : « Le nouveau code PIN doit contenir exactement 4 chiffres. ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — PIN changed successfully
  - **`message`** — déclaré. string. exemple `Code PIN modifié avec succès`.
- **400** — Bad request - Invalid PIN or same PIN
- **401** — Unauthorized - Invalid old PIN

## Admin

Back-office : revue KYC, comptes internes, portefeuilles, paiements, parrainage, utilisateurs, trajets, réservations et demandes de trajet. Le rôle `admin` suffit pour la plupart des lectures et des décisions. La création des comptes internes et certaines corrections financières exigent `super_admin`.

<a id="get-api-v1-admin-accounts"></a>
### GET `/api/v1/admin/accounts`

Swagger résume l’opération ainsi : « List back-office administrator accounts ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAdminAccounts` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.

<a id="post-api-v1-admin-accounts"></a>
### POST `/api/v1/admin/accounts`

Swagger résume l’opération ainsi : « Create a back-office administrator account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateAdminAccountDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.createAdminAccount` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateAdminAccountDto`.

- **`phone`** — obligatoire, string. exemple `+243900000000`. chaîne de caractères ; ne doit pas être vide ; motif `/^\+?\d[\d\s().-]{7,20}$/`. présent dans le schéma Swagger.
- **`firstName`** — obligatoire, string. exemple `Alice`. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`lastName`** — obligatoire, string. exemple `Admin`. chaîne de caractères ; ne doit pas être vide ; au plus 100 caractère(s). présent dans le schéma Swagger.
- **`defaultPassword`** — obligatoire, string. Mot de passe temporaire transmis hors de l'application à l'administrateur concerné. Si le numéro appartient déjà à un compte public, il devient le nouveau mot de passe admin.. exemple `Temporaire-2026!`. chaîne de caractères ; ne doit pas être vide ; au moins 8 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.

<a id="put-api-v1-admin-accounts-userid-activate"></a>
### PUT `/api/v1/admin/accounts/:userId/activate`

Swagger résume l’opération ainsi : « Reactivate a back-office administrator account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.activateAdminAccount` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId` — doit être un UUID

<a id="put-api-v1-admin-accounts-userid-deactivate"></a>
### PUT `/api/v1/admin/accounts/:userId/deactivate`

Swagger résume l’opération ainsi : « Deactivate a back-office administrator account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deactivateAdminAccount` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId` — doit être un UUID

<a id="put-api-v1-admin-accounts-userid-password"></a>
### PUT `/api/v1/admin/accounts/:userId/password`

Swagger résume l’opération ainsi : « Set a temporary password for a back-office administrator account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ResetAdminAccountPasswordDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.resetAdminAccountPassword` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId` — doit être un UUID

**Corps**

Classe `ResetAdminAccountPasswordDto`.

- **`newPassword`** — obligatoire, string. Nouveau mot de passe temporaire. L'administrateur devra le changer à la prochaine connexion.. exemple `Temporaire-2026!`. chaîne de caractères ; ne doit pas être vide ; au moins 8 caractère(s) ; au plus 128 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-admin-bookings"></a>
### GET `/api/v1/admin/bookings`

Swagger résume l’opération ainsi : « Get all bookings as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAllBookings` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `10`.
- `status` — facultatif. Type `BookingStatus`.

<a id="put-api-v1-admin-bookings-bookingid-accept"></a>
### PUT `/api/v1/admin/bookings/:bookingId/accept`

Swagger résume l’opération ainsi : « Accept a booking as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.acceptBooking` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `bookingId`

<a id="put-api-v1-admin-bookings-bookingid-cancel"></a>
### PUT `/api/v1/admin/bookings/:bookingId/cancel`

Swagger résume l’opération ainsi : « Cancel a booking as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.cancelBooking` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `bookingId`

<a id="put-api-v1-admin-bookings-bookingid-reject"></a>
### PUT `/api/v1/admin/bookings/:bookingId/reject`

Swagger résume l’opération ainsi : « Reject a booking as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.rejectBooking` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `bookingId`

**Corps**

Propriétés lues une à une dans le JSON :

- `reason` — facultatif, string.

<a id="get-api-v1-admin-bookings-export"></a>
### GET `/api/v1/admin/bookings/export`

Swagger résume l’opération ainsi : « Export bookings as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportBookings` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `status` — facultatif. Type `BookingStatus`.

<a id="get-api-v1-admin-kyc"></a>
### GET `/api/v1/admin/kyc`

Swagger résume l’opération ainsi : « List all KYC documents as consultable history, optionally filtered by status ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getKycDocuments` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `status` — facultatif. Type `string`.
- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-kyc-kycid"></a>
### GET `/api/v1/admin/kyc/:kycId`

Swagger résume l’opération ainsi : « Get one KYC document with user details ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getKycDocument` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `kycId` — doit être un UUID

<a id="get-api-v1-admin-kyc-kycid-evidence"></a>
### GET `/api/v1/admin/kyc/:kycId/evidence`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `KycEvidenceController.list` dans `src/users/kyc-evidence/kyc-evidence.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: no-store`

**Paramètres de chemin**

- `kycId` — doit être un UUID

<a id="post-api-v1-admin-kyc-kycid-evidence"></a>
### POST `/api/v1/admin/kyc/:kycId/evidence`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `KycEvidenceController.request` dans `src/users/kyc-evidence/kyc-evidence.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: no-store`

**Paramètres de chemin**

- `kycId` — doit être un UUID

<a id="get-api-v1-admin-kyc-kycid-evidence-archiveid"></a>
### GET `/api/v1/admin/kyc/:kycId/evidence/:archiveId`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `KycEvidenceController.details` dans `src/users/kyc-evidence/kyc-evidence.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: no-store`

**Paramètres de chemin**

- `kycId` — doit être un UUID
- `archiveId` — doit être un UUID

<a id="delete-api-v1-admin-kyc-kycid-evidence-archiveid"></a>
### DELETE `/api/v1/admin/kyc/:kycId/evidence/:archiveId`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `KycEvidenceController.expire` dans `src/users/kyc-evidence/kyc-evidence.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: no-store`

**Paramètres de chemin**

- `kycId` — doit être un UUID
- `archiveId` — doit être un UUID

<a id="get-api-v1-admin-kyc-kycid-evidence-archiveid-files-index"></a>
### GET `/api/v1/admin/kyc/:kycId/evidence/:archiveId/files/:index`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `KycEvidenceController.file` dans `src/users/kyc-evidence/kyc-evidence.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`

**Paramètres de chemin**

- `kycId` — doit être un UUID
- `archiveId` — doit être un UUID
- `index` — ParseIntPipe

<a id="put-api-v1-admin-kyc-kycid-verify"></a>
### PUT `/api/v1/admin/kyc/:kycId/verify`

Swagger résume l’opération ainsi : « Verify or reject KYC document ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.verifyKyc` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `kycId`

**Corps**

Propriétés lues une à une dans le JSON :

- `approved` — obligatoire, boolean.
- `reason` — facultatif, string.

<a id="get-api-v1-admin-kyc-pending"></a>
### GET `/api/v1/admin/kyc/pending`

Swagger résume l’opération ainsi : « Get all pending KYC verifications ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getPendingKycs` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-admin-payments"></a>
### GET `/api/v1/admin/payments`

Swagger résume l’opération ainsi : « List payment transactions ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAllPayments` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `status` — facultatif. Type `string`.
- `purpose` — facultatif. Type `string`.
- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-payments-export"></a>
### GET `/api/v1/admin/payments/export`

Swagger résume l’opération ainsi : « Export payment transactions as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportPayments` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `status` — facultatif. Type `string`.
- `purpose` — facultatif. Type `string`.
- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-accounts"></a>
### GET `/api/v1/admin/referrals/accounts`

Swagger résume l’opération ainsi : « List referral accounts and global balances ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getReferralAccounts` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-accounts-export"></a>
### GET `/api/v1/admin/referrals/accounts/export`

Swagger résume l’opération ainsi : « Export referral accounts as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportReferralAccounts` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-candidates"></a>
### GET `/api/v1/admin/referrals/candidates`

Swagger résume l’opération ainsi : « Find active referrers by name, phone, email or user ID ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.searchReferrers` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-rewards"></a>
### GET `/api/v1/admin/referrals/rewards`

Swagger résume l’opération ainsi : « List referral rewards and commissions ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getReferralRewards` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `search` — facultatif. Type `string`.
- `status` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-rewards-export"></a>
### GET `/api/v1/admin/referrals/rewards/export`

Swagger résume l’opération ainsi : « Export referral rewards as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportReferralRewards` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.
- `status` — facultatif. Type `string`.

<a id="get-api-v1-admin-referrals-withdrawals"></a>
### GET `/api/v1/admin/referrals/withdrawals`

Swagger résume l’opération ainsi : « List referral withdrawal requests ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getReferralWithdrawals` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `search` — facultatif. Type `string`.
- `status` — facultatif. Type `string`.

<a id="post-api-v1-admin-referrals-withdrawals-withdrawalid-reconcile"></a>
### POST `/api/v1/admin/referrals/withdrawals/:withdrawalId/reconcile`

Swagger résume l’opération ainsi : « Reconcile a referral withdrawal with FlexPay ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.reconcileReferralWithdrawal` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `withdrawalId`

<a id="get-api-v1-admin-referrals-withdrawals-export"></a>
### GET `/api/v1/admin/referrals/withdrawals/export`

Swagger résume l’opération ainsi : « Export referral withdrawals as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportReferralWithdrawals` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.
- `status` — facultatif. Type `string`.

<a id="get-api-v1-admin-trip-requests"></a>
### GET `/api/v1/admin/trip-requests`

Swagger résume l’opération ainsi : « Get all trip requests as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAllTripRequests` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `50`.
- `status` — facultatif. Type `string`.

<a id="get-api-v1-admin-trip-requests-triprequestid"></a>
### GET `/api/v1/admin/trip-requests/:tripRequestId`

Swagger résume l’opération ainsi : « Get one trip request as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getTripRequest` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripRequestId`

<a id="put-api-v1-admin-trip-requests-triprequestid"></a>
### PUT `/api/v1/admin/trip-requests/:tripRequestId`

Swagger résume l’opération ainsi : « Update a trip request as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateTripRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.updateTripRequest` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripRequestId`

**Corps**

Classe `UpdateTripRequestDto`.

- **`expectedUpdatedAt`** — facultatif, string. updatedAt lu à l’ouverture du formulaire ; refuse une modification concurrente.. date ISO. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`departureDateMin`** — facultatif, string. Date/heure de départ minimum souhaitée. exemple `2025-12-20T08:00:00Z`. date ISO. présent dans le schéma Swagger.
- **`departureDateMax`** — facultatif, string. Date/heure de départ maximum acceptée (délai). exemple `2025-12-20T18:00:00Z`. date ISO. présent dans le schéma Swagger.
- **`numberOfSeats`** — facultatif, number. Nombre de places nécessaires. Jusqu’à 2 sans KYC ; au-delà, le KYC du passager doit être approuvé et la capacité du véhicule respectée.. exemple `3`. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPricePerSeat`** — facultatif, number. Prix maximum par place accepté (optionnel). exemple `5000`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`vehicleType`** — facultatif, énumération. Type de véhicule à utiliser si le backend doit recalculer le prix recommandé : voiture = 500 FC/km, moto = 1000 FC/km. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. Message renvoyé : « Le type de véhicule sélectionné est invalide » ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode de règlement : paiement électronique via FlexPay, jetons Zwanga ou paiement physique à l’arrivée. exemple `electronic`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

<a id="delete-api-v1-admin-trip-requests-triprequestid"></a>
### DELETE `/api/v1/admin/trip-requests/:tripRequestId`

Swagger résume l’opération ainsi : « Delete a trip request as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deleteTripRequest` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripRequestId`

<a id="put-api-v1-admin-trip-requests-triprequestid-deactivate"></a>
### PUT `/api/v1/admin/trip-requests/:tripRequestId/deactivate`

Swagger résume l’opération ainsi : « Deactivate/cancel a trip request as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deactivateTripRequest` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripRequestId`

<a id="get-api-v1-admin-trip-requests-export"></a>
### GET `/api/v1/admin/trip-requests/export`

Swagger résume l’opération ainsi : « Export trip requests as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportTripRequests` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `status` — facultatif. Type `string`.

<a id="get-api-v1-admin-trips"></a>
### GET `/api/v1/admin/trips`

Swagger résume l’opération ainsi : « Get all trips (paginated) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAllTrips` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `10`.

<a id="put-api-v1-admin-trips-tripid"></a>
### PUT `/api/v1/admin/trips/:tripId`

Swagger résume l’opération ainsi : « Update a trip as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateTripDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.updateTrip` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

**Corps**

Classe `UpdateTripDto`.

- **`acceptedPaymentModes`** — facultatif, tableau de énumération. tableau ; au moins 1 élément(s) ; au plus 3 élément(s) ; valeur autorisée : `electronic`, `cash`, `points` ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour le départ. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées de départ [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées d’arrivée [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`totalSeats`** — facultatif, number. Nombre total de places (si modifié, availableSeats sera recalculé). Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`pricePerSeat`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Exige que chaque passager ait un KYC approuvé avant de réserver ou embarquer.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `upcoming`, `ongoing`, `completed`, `cancelled` ; énumération Swagger : `upcoming`, `ongoing`, `completed`, `cancelled`. présent dans le schéma Swagger.
- **`vehicleId`** — facultatif, string | null. ID du véhicule à associer au trajet (doit appartenir au driver). Passer null pour retirer l'association.. chaîne de caractères. présent dans le schéma Swagger.

<a id="delete-api-v1-admin-trips-tripid"></a>
### DELETE `/api/v1/admin/trips/:tripId`

Swagger résume l’opération ainsi : « Delete a trip as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deleteTrip` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

<a id="put-api-v1-admin-trips-tripid-deactivate"></a>
### PUT `/api/v1/admin/trips/:tripId/deactivate`

Swagger résume l’opération ainsi : « Deactivate/cancel a trip as admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deactivateTrip` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

<a id="get-api-v1-admin-trips-tripid-statement"></a>
### GET `/api/v1/admin/trips/:tripId/statement`

Swagger résume l’opération ainsi : « Trip detail with the gain of each party ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getTripStatement` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId` — doit être un UUID

<a id="get-api-v1-admin-trips-export"></a>
### GET `/api/v1/admin/trips/export`

Swagger résume l’opération ainsi : « Export trips as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportTrips` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-admin-users"></a>
### GET `/api/v1/admin/users`

Swagger résume l’opération ainsi : « Get all users (paginated) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getAllUsers` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `10`.
- `role` — facultatif. Type `string`.
- `registeredFrom` — facultatif. Type `string`.
- `registeredTo` — facultatif. Type `string`.

<a id="put-api-v1-admin-users-userid-activate"></a>
### PUT `/api/v1/admin/users/:userId/activate`

Swagger résume l’opération ainsi : « Activate a user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.activateUser` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId`

<a id="put-api-v1-admin-users-userid-deactivate"></a>
### PUT `/api/v1/admin/users/:userId/deactivate`

Swagger résume l’opération ainsi : « Deactivate a user account ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.deactivateUser` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId`

<a id="get-api-v1-admin-users-userid-details"></a>
### GET `/api/v1/admin/users/:userId/details`

Swagger résume l’opération ainsi : « Get a full admin view of a user, including trips, bookings, trip requests and payments ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getUserDetails` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId`

<a id="get-api-v1-admin-users-userid-financial-summary"></a>
### GET `/api/v1/admin/users/:userId/financial-summary`

Swagger résume l’opération ainsi : « Get token wallet, recent movements and current referrer for a user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getUserFinancialSummary` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId` — doit être un UUID

<a id="post-api-v1-admin-users-userid-referrer"></a>
### POST `/api/v1/admin/users/:userId/referrer`

Swagger résume l’opération ainsi : « Attach a first referrer with an audited, non-retroactive attribution bonus ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AdminAttachReferrerDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.attachUserReferrer` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId` — doit être un UUID

**Corps**

Classe `AdminAttachReferrerDto`.

- **`referrerUserId`** — obligatoire, string. Utilisateur à rattacher comme parrain.. UUID. présent dans le schéma Swagger.
- **`reason`** — obligatoire, string. chaîne de caractères ; au moins 10 caractère(s) ; au plus 300 caractère(s). présent dans le schéma Swagger.

<a id="put-api-v1-admin-users-userid-suspend"></a>
### PUT `/api/v1/admin/users/:userId/suspend`

Swagger résume l’opération ainsi : « Suspend a user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.suspendUser` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId`

<a id="get-api-v1-admin-users-export"></a>
### GET `/api/v1/admin/users/export`

Swagger résume l’opération ainsi : « Export users as an Excel .xls spreadsheet, optionally filtered by driver role ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportUsers` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `role` — facultatif. Type `string`.
- `registeredFrom` — facultatif. Type `string`.
- `registeredTo` — facultatif. Type `string`.

<a id="get-api-v1-admin-users-stats"></a>
### GET `/api/v1/admin/users/stats`

Swagger résume l’opération ainsi : « Get platform user counts by role ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getUserStats` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-admin-wallets"></a>
### GET `/api/v1/admin/wallets`

Swagger résume l’opération ainsi : « List token wallets and their global summary ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getWalletAccounts` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `search` — facultatif. Type `string`.

<a id="post-api-v1-admin-wallets-userid-adjustments"></a>
### POST `/api/v1/admin/wallets/:userId/adjustments`

Swagger résume l’opération ainsi : « Apply an audited token balance adjustment ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AdminWalletAdjustmentDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminController.adjustWallet` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `userId`

**Corps**

Classe `AdminWalletAdjustmentDto`.

- **`requestId`** — obligatoire, string. Identifiant unique stable de la demande, utilisé pour garantir l'idempotence.. exemple `123e4567-e89b-12d3-a456-426614174000`. UUID. présent dans le schéma Swagger.
- **`amount`** — obligatoire, number. Nombre signé de jetons. Une valeur positive crédite le compte et une valeur négative le débite.. exemple `25`. nombre ; NotEquals ; minimum -1000000 ; maximum 1000000. converti en nombre. présent dans le schéma Swagger.
- **`reason`** — obligatoire, string. exemple `Régularisation validée sous le ticket SUP-1042`. chaîne de caractères ; au moins 10 caractère(s) ; au plus 500 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-admin-wallets-export"></a>
### GET `/api/v1/admin/wallets/export`

Swagger résume l’opération ainsi : « Export token wallet balances as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportWalletAccounts` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.

<a id="get-api-v1-admin-wallets-ledger"></a>
### GET `/api/v1/admin/wallets/ledger`

Swagger résume l’opération ainsi : « List the immutable token ledger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminController.getWalletLedger` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `page` — facultatif. Type `number`. Valeur par défaut : `1`.
- `limit` — facultatif. Type `number`. Valeur par défaut : `25`.
- `search` — facultatif. Type `string`.
- `type` — facultatif. Type `string`.

<a id="get-api-v1-admin-wallets-ledger-export"></a>
### GET `/api/v1/admin/wallets/ledger/export`

Swagger résume l’opération ainsi : « Export the token ledger as Excel .xls ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. La réponse est un fichier produit par le contrôleur, en pratique un export de tableur. Swagger ne décrit pas ce binaire.

- **Contrôleur :** `AdminController.exportWalletLedger` dans `src/admin/admin.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `search` — facultatif. Type `string`.
- `type` — facultatif. Type `string`.

## Vehicles

Véhicules rattachés au conducteur connecté : création, consultation, modification et suppression.

<a id="get-api-v1-vehicles"></a>
### GET `/api/v1/vehicles`

Swagger résume l’opération ainsi : « Get all vehicles of the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `VehiclesController.findAll` dans `src/vehicles/vehicles.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-vehicles"></a>
### POST `/api/v1/vehicles`

Swagger résume l’opération ainsi : « Create a new vehicle ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateVehicleDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `VehiclesController.create` dans `src/vehicles/vehicles.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateVehicleDto`.

- **`brand`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`model`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`color`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`type`** — obligatoire, énumération. Type du véhicule. Une moto à 2 roues accepte au maximum 2 places, une moto à 3 roues 3 places.. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels` ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
- **`licensePlate`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`photoUrl`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-vehicles-id"></a>
### GET `/api/v1/vehicles/:id`

Swagger résume l’opération ainsi : « Get a vehicle by ID ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `VehiclesController.findOne` dans `src/vehicles/vehicles.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-vehicles-id"></a>
### PUT `/api/v1/vehicles/:id`

Swagger résume l’opération ainsi : « Update a vehicle ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateVehicleDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `VehiclesController.update` dans `src/vehicles/vehicles.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateVehicleDto`.

- **`brand`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`model`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`color`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`type`** — facultatif, énumération. Type du véhicule. Une moto à 2 roues accepte au maximum 2 places, une moto à 3 roues 3 places.. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels` ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
- **`licensePlate`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`photoUrl`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`isActive`** — facultatif, boolean. booléen. présent dans le schéma Swagger.

<a id="delete-api-v1-vehicles-id"></a>
### DELETE `/api/v1/vehicles/:id`

Swagger résume l’opération ainsi : « Deactivate a vehicle only when no ongoing, upcoming or active recurring trip uses it ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `VehiclesController.remove` dans `src/vehicles/vehicles.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

## Favorite Places

Lieux enregistrés par l’utilisateur (domicile, travail ou autre), avec un lieu par défaut pour accélérer la saisie des départs et des arrivées.

<a id="get-api-v1-favorite-places"></a>
### GET `/api/v1/favorite-places`

Swagger résume l’opération ainsi : « Get all favorite places for the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.findAll` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — tableau `FavoritePlaceResponse` — Favorite places retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="post-api-v1-favorite-places"></a>
### POST `/api/v1/favorite-places`

Swagger résume l’opération ainsi : « Create a new favorite place ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateFavoritePlaceDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `FavoritePlacesController.create` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 201 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateFavoritePlaceDto`.

- **`name`** — obligatoire, string. Name of the place (e.g., "Domicile", "Bureau"). chaîne de caractères. présent dans le schéma Swagger.
- **`address`** — obligatoire, string. Full address. chaîne de caractères. présent dans le schéma Swagger.
- **`coordinates`** — obligatoire, CoordinatesDto. Coordinates of the place. objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
- **`type`** — facultatif, énumération. valeur autorisée : `home`, `work`, `other` ; énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
- **`isDefault`** — facultatif, boolean. Set as default place for this type. booléen. présent dans le schéma Swagger.
- **`placeId`** — facultatif, string. Google Maps Place ID. chaîne de caractères. présent dans le schéma Swagger.
- **`notes`** — facultatif, string. Additional landmark notes shown to the user. chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **201** — objet `FavoritePlaceResponse` — Favorite place created successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="get-api-v1-favorite-places-id"></a>
### GET `/api/v1/favorite-places/:id`

Swagger résume l’opération ainsi : « Get a favorite place by ID ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.findOne` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **200** — objet `FavoritePlaceResponse` — Favorite place retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="put-api-v1-favorite-places-id"></a>
### PUT `/api/v1/favorite-places/:id`

Swagger résume l’opération ainsi : « Update a favorite place ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateFavoritePlaceDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `FavoritePlacesController.update` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateFavoritePlaceDto`.

- **`name`** — facultatif, string. Name of the place. chaîne de caractères. présent dans le schéma Swagger.
- **`address`** — facultatif, string. Full address. chaîne de caractères. présent dans le schéma Swagger.
- **`coordinates`** — facultatif, CoordinatesDto. Coordinates of the place. objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
- **`type`** — facultatif, énumération. valeur autorisée : `home`, `work`, `other` ; énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
- **`isDefault`** — facultatif, boolean. Set as default place for this type. booléen. présent dans le schéma Swagger.
- **`placeId`** — facultatif, string. Google Maps Place ID. chaîne de caractères. présent dans le schéma Swagger.
- **`notes`** — facultatif, string. Additional landmark notes shown to the user. chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `FavoritePlaceResponse` — Favorite place updated successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="delete-api-v1-favorite-places-id"></a>
### DELETE `/api/v1/favorite-places/:id`

Swagger résume l’opération ainsi : « Delete a favorite place ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.remove` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 204 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **204** — Favorite place deleted successfully

<a id="put-api-v1-favorite-places-id-set-default"></a>
### PUT `/api/v1/favorite-places/:id/set-default`

Swagger résume l’opération ainsi : « Set a favorite place as default for its type ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.setAsDefault` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **200** — objet `FavoritePlaceResponse` — Favorite place set as default successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="get-api-v1-favorite-places-default"></a>
### GET `/api/v1/favorite-places/default`

Swagger résume l’opération ainsi : « Get default favorite place (optionally filtered by type) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.findDefault` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `type` — facultatif. Type `FavoritePlaceType`.

**Réponses déclarées dans Swagger**

- **200** — objet `FavoritePlaceResponse` — Default favorite place retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

<a id="get-api-v1-favorite-places-type-type"></a>
### GET `/api/v1/favorite-places/type/:type`

Swagger résume l’opération ainsi : « Get favorite places by type (home, work, other) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FavoritePlacesController.findByType` dans `src/favorite-places/favorite-places.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `type`

**Réponses déclarées dans Swagger**

- **200** — tableau `FavoritePlaceResponse` — Favorite places retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`coordinates`** — obligatoire, CoordinatesDto. présent dans le schéma Swagger.
    - **`latitude`** — obligatoire, number. Latitude. latitude. présent dans le schéma Swagger.
    - **`longitude`** — obligatoire, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`type`** — obligatoire, énumération. énumération Swagger : `home`, `work`, `other`. présent dans le schéma Swagger.
  - **`isDefault`** — obligatoire, boolean. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`notes`** — facultatif, string | null. présent dans le schéma Swagger.
  - **`createdAt`** — obligatoire, Date. présent dans le schéma Swagger.
  - **`updatedAt`** — obligatoire, Date. présent dans le schéma Swagger.

## Trips

Offres de covoiturage publiées par les conducteurs : recherche, création, récurrence, position, démarrage, interruption et clôture. La découverte et la recherche sont publiques. Le cycle de vie du trajet exige le compte du conducteur.

<a id="get-api-v1-trips"></a>
### GET `/api/v1/trips`

Swagger résume l’opération ainsi : « Rechercher des trajets ou obtenir tous les trajets disponibles ». Recherche flexible par coordonnées : vous pouvez fournir uniquement departureCoordinates, uniquement arrivalCoordinates, ou les deux. Le rayon de recherche (departureRadiusKm, arrivalRadiusKm) est optionnel pour chaque point (défaut: 50 km). Si aucun critère n'est fourni, retourne tous les trajets disponibles. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.findAll` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `SearchTripsDto` :

- **`direction`** — facultatif, énumération. valeur autorisée : `next`, `previous`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`cursor`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`sort`** — facultatif, énumération. valeur autorisée : `price`, `date`, `nearby`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`keywords`** — facultatif, string. Mots-clés de recherche. Chaque mot est testé sur l'adresse de départ ou d'arrivée.. exemple `gombe aeroport`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. Nom du lieu de départ (recherche textuelle). chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. Peut être utilisé seul ou avec arrivalCoordinates.. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. Nom du lieu d'arrivée (recherche textuelle). chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. Peut être utilisé seul ou avec departureCoordinates.. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureRadiusKm`** — facultatif, number. Rayon de recherche autour du point de départ en kilomètres (défaut: 50 km). Optionnel si departureCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`arrivalRadiusKm`** — facultatif, number. Rayon de recherche autour du point d'arrivée en kilomètres (défaut: 50 km). Optionnel si arrivalCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`minSeats`** — facultatif, number. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPrice`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Filtrer uniquement les trajets gratuits. exemple `false`. booléen. présent dans le schéma Swagger.


<a id="post-api-v1-trips"></a>
### POST `/api/v1/trips`

Swagger résume l’opération ainsi : « Create a new trip ». Permet à un utilisateur de créer un trajet. Si l'utilisateur est un passager et fournit un véhicule, il sera automatiquement promu en conducteur. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateTripDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.create` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateTripDto`.

- **`acceptedPaymentModes`** — facultatif, tableau de énumération. tableau ; au moins 1 élément(s) ; au plus 3 élément(s) ; valeur autorisée : `electronic`, `cash`, `points` ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`departureLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour le départ. exemple `Devant la station, côté parking`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour l'arrivée. exemple `Entrée principale, près du rond-point`. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d’arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureDate`** — obligatoire, string. date ISO ; ne doit pas être vide. présent dans le schéma Swagger.
- **`totalSeats`** — obligatoire, number. Nombre total de places disponibles. Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. nombre ; minimum 1 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`pricePerSeat`** — obligatoire, number. Prix par place en francs congolais. Mettre 0 pour un trajet gratuit.. exemple `0`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Exige que chaque passager ait un KYC approuvé avant de réserver ou embarquer.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`vehicleId`** — facultatif, string. ID du véhicule à associer au trajet (doit appartenir au driver). chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-trips-id"></a>
### GET `/api/v1/trips/:id`

Swagger résume l’opération ainsi : « Get a trip by ID ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.findOne` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id"></a>
### PUT `/api/v1/trips/:id`

Swagger résume l’opération ainsi : « Update a trip ». Permet de modifier un trajet existant, y compris l'adresse de départ et/ou d'arrivée. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateTripDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.update` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateTripDto`.

- **`acceptedPaymentModes`** — facultatif, tableau de énumération. tableau ; au moins 1 élément(s) ; au plus 3 élément(s) ; valeur autorisée : `electronic`, `cash`, `points` ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour le départ. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées de départ [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées d’arrivée [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`totalSeats`** — facultatif, number. Nombre total de places (si modifié, availableSeats sera recalculé). Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`pricePerSeat`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Exige que chaque passager ait un KYC approuvé avant de réserver ou embarquer.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `upcoming`, `ongoing`, `completed`, `cancelled` ; énumération Swagger : `upcoming`, `ongoing`, `completed`, `cancelled`. présent dans le schéma Swagger.
- **`vehicleId`** — facultatif, string | null. ID du véhicule à associer au trajet (doit appartenir au driver). Passer null pour retirer l'association.. chaîne de caractères. présent dans le schéma Swagger.

<a id="delete-api-v1-trips-id"></a>
### DELETE `/api/v1/trips/:id`

Swagger résume l’opération ainsi : « Delete a trip unless a passenger has boarded and has not yet been dropped off ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.remove` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id-complete"></a>
### PUT `/api/v1/trips/:id/complete`

Swagger résume l’opération ainsi : « Complete/end an active trip (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.completeTrip` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id-driver-emergency-contacts"></a>
### PUT `/api/v1/trips/:id/driver-emergency-contacts`

Swagger résume l’opération ainsi : « Select driver's emergency contacts for trip WhatsApp safety notifications ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `DriverEmergencyContactsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.setDriverEmergencyContacts` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `DriverEmergencyContactsDto`.

- **`emergencyContactIds`** — obligatoire, tableau. IDs des contacts d'urgence du conducteur a notifier (1 a 5 contacts). tableau ; au moins 1 élément(s). Message renvoyé : « Vous devez sélectionner au moins 1 contact d'urgence » ; au plus 5 élément(s). Message renvoyé : « Vous ne pouvez pas sélectionner plus de 5 contacts d'urgence » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de contact doit être un UUID valide ». présent dans le schéma Swagger.

<a id="get-api-v1-trips-id-driver-location"></a>
### GET `/api/v1/trips/:id/driver-location`

Swagger résume l’opération ainsi : « Get driver location for an active trip ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.getDriverLocation` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id-driver-location"></a>
### PUT `/api/v1/trips/:id/driver-location`

Swagger résume l’opération ainsi : « Update driver location for an active trip ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateDriverLocationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.updateDriverLocation` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateDriverLocationDto`.

- **`coordinates`** — obligatoire, [number, number]. Coordonnées actuelles du conducteur [longitude, latitude]. exemple `15.3136`, `-4.3276`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`accuracy`** — facultatif, number. Precision GPS en metres. nombre ; minimum 0 ; maximum 1000. présent dans le schéma Swagger.
- **`speed`** — facultatif, number. Vitesse GPS en m/s. nombre ; minimum 0 ; maximum 100. présent dans le schéma Swagger.
- **`heading`** — facultatif, number. Cap GPS en degres. nombre ; minimum 0 ; maximum 360. présent dans le schéma Swagger.
- **`recordedAt`** — facultatif, string. Horodatage ISO de la mesure GPS sur le terminal. date ISO. présent dans le schéma Swagger.

<a id="post-api-v1-trips-id-interruption-request"></a>
### POST `/api/v1/trips/:id/interruption-request`

Swagger résume l’opération ainsi : « Request interruption of an active trip; onboard passengers must confirm ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestTripInterruptionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.requestTripInterruption` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `RequestTripInterruptionDto`.

- **`reason`** — obligatoire, énumération. exemple `emergency`. valeur autorisée : `emergency`, `health`, `safety`, `route_issue`, `personal`, `other` ; ne doit pas être vide ; énumération Swagger : `emergency`, `health`, `safety`, `route_issue`, `personal`, `other`. présent dans le schéma Swagger.
- **`note`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`coordinates`** — facultatif, TripInterruptionCoordinatesDto. objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. exemple `15.3136`. nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.

<a id="put-api-v1-trips-id-interruption-request-cancel"></a>
### PUT `/api/v1/trips/:id/interruption-request/cancel`

Swagger résume l’opération ainsi : « Cancel a pending driver interruption request ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.cancelTripInterruption` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id-interruption-request-confirm"></a>
### PUT `/api/v1/trips/:id/interruption-request/confirm`

Swagger résume l’opération ainsi : « Confirm a driver interruption request as an onboard passenger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ConfirmDriverTripInterruptionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.confirmTripInterruption` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ConfirmDriverTripInterruptionDto`.

- **`bookingId`** — facultatif, string. UUID. présent dans le schéma Swagger.

<a id="put-api-v1-trips-id-interruption-request-decision"></a>
### PUT `/api/v1/trips/:id/interruption-request/decision`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `DriverInterruptionDecisionDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `TripsController.interruptionDecision` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `DriverInterruptionDecisionDto`.

- **`requestId`** — obligatoire, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`bookingId`** — obligatoire, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`decision`** — obligatoire, énumération. valeur autorisée : `wait`, `stop`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`quoteId`** — facultatif, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-trips-id-interruption-request-fare"></a>
### GET `/api/v1/trips/:id/interruption-request/fare`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.interruptionFare` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Paramètres de requête**

Objet `DriverInterruptionFareQueryDto` :

- **`requestId`** — obligatoire, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`bookingId`** — obligatoire, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="put-api-v1-trips-id-interruption-request-reject"></a>
### PUT `/api/v1/trips/:id/interruption-request/reject`

Swagger résume l’opération ainsi : « Reject a driver interruption request as an onboard passenger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RejectTripInterruptionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.rejectTripInterruption` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `RejectTripInterruptionDto`.

- **`reason`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. UUID. présent dans le schéma Swagger.

<a id="put-api-v1-trips-id-make-public"></a>
### PUT `/api/v1/trips/:id/make-public`

Swagger résume l’opération ainsi : « Make a private trip public ». Permet au passager qui a créé la demande de trajet d'autoriser que le trajet devienne public. Le conducteur du trajet doit avoir passé le KYC et avoir au moins un véhicule actif pour que le trajet soit effectivement publié. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.makeTripPublic` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-id-pause"></a>
### PUT `/api/v1/trips/:id/pause`

Swagger résume l’opération ainsi : « Pause/interrupt an active trip ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.pauseTrip` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-trips-id-reprogram"></a>
### POST `/api/v1/trips/:id/reprogram`

Swagger résume l’opération ainsi : « Reprogrammer un trajet expiré en nouvelle publication, sans reprendre ses réservations ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateTripDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.reprogram` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateTripDto`.

- **`acceptedPaymentModes`** — facultatif, tableau de énumération. tableau ; au moins 1 élément(s) ; au plus 3 élément(s) ; valeur autorisée : `electronic`, `cash`, `points` ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour le départ. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées de départ [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Nouvelles coordonnées d’arrivée [longitude, latitude]. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`totalSeats`** — facultatif, number. Nombre total de places (si modifié, availableSeats sera recalculé). Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`pricePerSeat`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Indique si le trajet est gratuit. Si true, pricePerSeat sera automatiquement mis à 0.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Exige que chaque passager ait un KYC approuvé avant de réserver ou embarquer.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `upcoming`, `ongoing`, `completed`, `cancelled` ; énumération Swagger : `upcoming`, `ongoing`, `completed`, `cancelled`. présent dans le schéma Swagger.
- **`vehicleId`** — facultatif, string | null. ID du véhicule à associer au trajet (doit appartenir au driver). Passer null pour retirer l'association.. chaîne de caractères. présent dans le schéma Swagger.

<a id="put-api-v1-trips-id-start"></a>
### PUT `/api/v1/trips/:id/start`

Swagger résume l’opération ainsi : « Start a trip ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.startTrip` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-trips-all-trips"></a>
### GET `/api/v1/trips/all-trips`

Swagger résume l’opération ainsi : « Get all trips completed or not ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `...ADMIN_USER_ROLES`. Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.findAllTrips` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de requête**

Objet `LegacyPageQuery` :

- **`page`** — facultatif, number. entier ; minimum 1 ; maximum 10000. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-trips-discovery"></a>
### POST `/api/v1/trips/discovery`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SearchTripsDto`. Swagger ne publie que les champs marqués `@ApiProperty` (11 sur 15).

- **Contrôleur :** `TripsController.discovery` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `SearchTripsDto`.

- **`direction`** — facultatif, énumération. valeur autorisée : `next`, `previous`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`cursor`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`sort`** — facultatif, énumération. valeur autorisée : `price`, `date`, `nearby`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`keywords`** — facultatif, string. Mots-clés de recherche. Chaque mot est testé sur l'adresse de départ ou d'arrivée.. exemple `gombe aeroport`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. Nom du lieu de départ (recherche textuelle). chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. Peut être utilisé seul ou avec arrivalCoordinates.. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. Nom du lieu d'arrivée (recherche textuelle). chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. Peut être utilisé seul ou avec departureCoordinates.. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.
- **`departureRadiusKm`** — facultatif, number. Rayon de recherche autour du point de départ en kilomètres (défaut: 50 km). Optionnel si departureCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`arrivalRadiusKm`** — facultatif, number. Rayon de recherche autour du point d'arrivée en kilomètres (défaut: 50 km). Optionnel si arrivalCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`minSeats`** — facultatif, number. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPrice`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Filtrer uniquement les trajets gratuits. exemple `false`. booléen. présent dans le schéma Swagger.

<a id="get-api-v1-trips-my-trips"></a>
### GET `/api/v1/trips/my-trips`

Swagger résume l’opération ainsi : « Get trips created by current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.findMyTrips` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `scope` — facultatif. Type `string`.

<a id="get-api-v1-trips-my-trips-history"></a>
### GET `/api/v1/trips/my-trips/history`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.history` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageQuery` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`search`** — facultatif, string. chaîne de caractères ; au plus 100 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-trips-recurring"></a>
### POST `/api/v1/trips/recurring`

Swagger résume l’opération ainsi : « Create a recurring trip template ». Permet à un conducteur de créer un schéma récurrent et de générer automatiquement les prochaines occurrences. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateRecurringTripDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripsController.createRecurring` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateRecurringTripDto`.

- **`acceptedPaymentModes`** — facultatif, tableau de énumération. tableau ; au moins 1 élément(s) ; au plus 3 élément(s) ; valeur autorisée : `electronic`, `cash`, `points` ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`departureLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour le départ. exemple `Devant la station, côté parking`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu donné par le conducteur pour l'arrivée. exemple `Entrée principale, près du rond-point`. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`startDate`** — obligatoire, string. Date de début du schéma récurrent (format YYYY-MM-DD). exemple `2026-03-30`. date ISO ; ne doit pas être vide. présent dans le schéma Swagger.
- **`endDate`** — facultatif, string. Date de fin optionnelle du schéma récurrent (format YYYY-MM-DD). exemple `2026-06-30`. date ISO. présent dans le schéma Swagger.
- **`departureTime`** — obligatoire, string. Heure de départ quotidienne (format HH:mm). exemple `07:30`. motif `/^([01]\d|2[0-3]):([0-5]\d)$/` ; ne doit pas être vide. présent dans le schéma Swagger.
- **`weekdays`** — obligatoire, tableau. Jours de repetition ISO (1 = lundi, 7 = dimanche). exemple `1`, `2`, `3`, `4`, `5`. tableau ; au moins 1 élément(s) ; au plus 7 élément(s) ; entier ; minimum 1 ; maximum 7. présent dans le schéma Swagger.
- **`totalSeats`** — obligatoire, number. Nombre total de places disponibles. Maximum 2 pour une moto a 2 roues et 3 pour une moto a 3 roues.. nombre ; minimum 1 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`pricePerSeat`** — obligatoire, number. Prix par place en francs congolais. Mettre 0 pour un trajet gratuit.. exemple `0`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`isFree`** — facultatif, boolean. Indique si le trajet récurrent est gratuit.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Exige que chaque passager ait un KYC approuvé sur les occurrences générées.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`vehicleId`** — obligatoire, string. ID du véhicule à associer au schéma récurrent. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

<a id="put-api-v1-trips-recurring-id-pause"></a>
### PUT `/api/v1/trips/recurring/:id/pause`

Swagger résume l’opération ainsi : « Pause a recurring trip template ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.pauseRecurringTrip` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trips-recurring-id-resume"></a>
### PUT `/api/v1/trips/recurring/:id/resume`

Swagger résume l’opération ainsi : « Resume a recurring trip template ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.resumeRecurringTrip` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-trips-recurring-my"></a>
### GET `/api/v1/trips/recurring/my`

Swagger résume l’opération ainsi : « Get recurring trip templates created by current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripsController.findMyRecurringTrips` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-trips-search-coordinates"></a>
### POST `/api/v1/trips/search/coordinates`

Swagger résume l’opération ainsi : « Rechercher des trajets par coordonnées ». Recherche flexible : vous pouvez fournir uniquement departureCoordinates, uniquement arrivalCoordinates, ou les deux. Le rayon de recherche est optionnel pour chaque point (défaut: 50 km). La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SearchByPointsDto`. Swagger ne publie que les champs marqués `@ApiProperty` (8 sur 12).

- **Contrôleur :** `TripsController.searchByCoordinates` dans `src/trips/trips.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `SearchByPointsDto`.

- **`direction`** — facultatif, énumération. valeur autorisée : `next`, `previous`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`cursor`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`sort`** — facultatif, énumération. valeur autorisée : `price`, `date`, `nearby`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`keywords`** — facultatif, string. Mots-clés de recherche. Chaque mot est testé sur l'adresse de départ ou d'arrivée.. exemple `gombe aeroport`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. Peut être utilisé seul ou avec arrivalCoordinates.. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. Peut être utilisé seul ou avec departureCoordinates.. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`departureRadiusKm`** — facultatif, number. Rayon de recherche autour du point de départ en kilomètres (défaut: 50 km). Optionnel si departureCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`arrivalRadiusKm`** — facultatif, number. Rayon de recherche autour du point d'arrivée en kilomètres (défaut: 50 km). Optionnel si arrivalCoordinates est fourni.. nombre ; minimum 1. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. date ISO. présent dans le schéma Swagger.
- **`minSeats`** — facultatif, number. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPrice`** — facultatif, number. nombre ; minimum 0. présent dans le schéma Swagger.

## Trip Requests

Demandes de trajet créées par un passager, auxquelles les conducteurs répondent par une offre. Le passager accepte une offre, puis le trajet peut démarrer. Plusieurs lectures sont réservées au rôle `driver`.

<a id="get-api-v1-trip-requests"></a>
### GET `/api/v1/trip-requests`

Swagger résume l’opération ainsi : « Get all pending trip requests ». Conducteurs authentifiés uniquement. Adresses et coordonnées exactes visibles ; aucun téléphone avant acceptation. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.findAll` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

<a id="post-api-v1-trip-requests"></a>
### POST `/api/v1/trip-requests`

Swagger résume l’opération ainsi : « Create a trip request ». Permet à un passager de créer une demande de trajet avec un délai pour le départ. Le KYC approuvé est requis uniquement au-delà de 2 places. Les drivers pourront ensuite faire des offres. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateTripRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.create` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateTripRequestDto`.

- **`immediateDispatch`** — facultatif, boolean. Départ immédiat demandé par le passager. Le serveur décide de son activation ; les commandes programmées gardent leur parcours habituel.. booléen. présent dans le schéma Swagger.
- **`departureLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge. exemple `Entrée principale, devant la station`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée. exemple `Portail noir, à côté du supermarché`. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`departureDateMin`** — obligatoire, string. Date/heure de départ minimum souhaitée. exemple `2025-12-20T08:00:00Z`. date ISO ; ne doit pas être vide. présent dans le schéma Swagger.
- **`departureDateMax`** — obligatoire, string. Date/heure de départ maximum acceptée (délai). exemple `2025-12-20T18:00:00Z`. date ISO ; ne doit pas être vide. présent dans le schéma Swagger.
- **`numberOfSeats`** — facultatif, number. Nombre de places nécessaires (1 par défaut). Jusqu’à 2 sans KYC ; au-delà, le KYC du passager doit être approuvé et la capacité du véhicule respectée.. exemple `3`. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPricePerSeat`** — facultatif, number. Prix maximum par place accepté (optionnel). exemple `5000`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`vehicleType`** — obligatoire, énumération. Type de véhicule choisi par le passager. Le prix est toujours recalculé côté serveur.. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. Message renvoyé : « Le type de véhicule sélectionné est invalide » ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode de règlement : paiement électronique via FlexPay, jetons Zwanga ou paiement physique à l’arrivée. exemple `electronic`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-trip-requests-id"></a>
### GET `/api/v1/trip-requests/:id`

Swagger résume l’opération ainsi : « Get a trip request by ID ». Récupère une demande de trajet spécifique. Tant qu’aucune offre n’est acceptée, tous les drivers peuvent la voir (avec uniquement leurs offres). Après acceptation, seule la passager et le driver sélectionné y ont accès. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.findOne` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trip-requests-id"></a>
### PUT `/api/v1/trip-requests/:id`

Swagger résume l’opération ainsi : « Update a trip request ». Permet au passager de modifier sa demande de trajet (dont l'adresse de départ et/ou d'arrivée). La modification n'est possible que si aucun driver n'a été sélectionné et qu'aucune offre n'a été acceptée. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateTripRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.update` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateTripRequestDto`.

- **`expectedUpdatedAt`** — facultatif, string. updatedAt lu à l’ouverture du formulaire ; refuse une modification concurrente.. date ISO. présent dans le schéma Swagger.
- **`departureLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d'arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`departureDateMin`** — facultatif, string. Date/heure de départ minimum souhaitée. exemple `2025-12-20T08:00:00Z`. date ISO. présent dans le schéma Swagger.
- **`departureDateMax`** — facultatif, string. Date/heure de départ maximum acceptée (délai). exemple `2025-12-20T18:00:00Z`. date ISO. présent dans le schéma Swagger.
- **`numberOfSeats`** — facultatif, number. Nombre de places nécessaires. Jusqu’à 2 sans KYC ; au-delà, le KYC du passager doit être approuvé et la capacité du véhicule respectée.. exemple `3`. nombre ; minimum 1. présent dans le schéma Swagger.
- **`maxPricePerSeat`** — facultatif, number. Prix maximum par place accepté (optionnel). exemple `5000`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`vehicleType`** — facultatif, énumération. Type de véhicule à utiliser si le backend doit recalculer le prix recommandé : voiture = 500 FC/km, moto = 1000 FC/km. exemple `car`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. Message renvoyé : « Le type de véhicule sélectionné est invalide » ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode de règlement : paiement électronique via FlexPay, jetons Zwanga ou paiement physique à l’arrivée. exemple `electronic`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.
- **`description`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

<a id="delete-api-v1-trip-requests-id"></a>
### DELETE `/api/v1/trip-requests/:id`

Swagger résume l’opération ainsi : « Cancel a trip request ». Permet au passager d'annuler sa demande de trajet, même après l'acceptation par un conducteur, tant que le trajet n'a pas démarré. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.cancel` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-trip-requests-id-accept"></a>
### POST `/api/v1/trip-requests/:id/accept`

Swagger résume l’opération ainsi : « Accept a trip request directly (Uber/Bolt/Yango style) ». Permet à un driver d'accepter directement une demande de trajet. Le driver voit le nombre de places demandées par le passager et le prix maximum accepté. Il accepte ou refuse selon que la demande lui convient ou non. Le prix utilisé est le prix maximum accepté par le passager (ou 0 si non spécifié). Crée automatiquement un trajet et une réservation pour le passager avec le nombre de places demandées. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AcceptTripRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.acceptTripRequest` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AcceptTripRequestDto`.

- **`vehicleId`** — facultatif, string. ID du véhicule à utiliser (doit appartenir au driver). Si non fourni, le premier véhicule actif sera utilisé.. chaîne de caractères. présent dans le schéma Swagger.
- **`departureDate`** — facultatif, string. Date/heure de départ proposée. Si non fournie, utilise la date minimum de la demande.. exemple `2025-12-20T10:00:00Z`. date ISO. présent dans le schéma Swagger.
- **`totalSeats`** — facultatif, number. Nombre total de places disponibles dans le véhicule. Si non fourni, sera déterminé automatiquement. Doit être au moins égal au nombre de places demandées par le passager. Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. exemple `4`. nombre ; minimum 1. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Indique que le conducteur exige un KYC approuvé avant embarquement.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère ajouté par le conducteur pour la prise en charge. exemple `Je vous prends devant la station`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées de prise en charge ajoutées par le conducteur [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère ajouté par le conducteur pour l'arrivée. exemple `Arrivee au parking principal`. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées d'arrivée ajoutées par le conducteur [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.

<a id="post-api-v1-trip-requests-id-accept-offer"></a>
### POST `/api/v1/trip-requests/:id/accept-offer`

Swagger résume l’opération ainsi : « Accept a driver offer ». Permet au passager de choisir et accepter une offre de driver. Toutes les autres offres seront automatiquement rejetées. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AcceptDriverOfferDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.acceptDriverOffer` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AcceptDriverOfferDto`.

- **`offerId`** — obligatoire, string. ID de l'offre du driver à accepter. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

<a id="get-api-v1-trip-requests-id-offers"></a>
### GET `/api/v1/trip-requests/:id/offers`

Swagger résume l’opération ainsi : « Get all offers for a trip request ». Récupère toutes les offres faites par les conducteurs pour une demande de trajet. Seul le passager peut voir toutes les offres. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.getOffers` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

**Paramètres de chemin**

- `id`

<a id="post-api-v1-trip-requests-id-offers"></a>
### POST `/api/v1/trip-requests/:id/offers`

Swagger résume l’opération ainsi : « Create a driver offer for a trip request ». Permet à un driver de faire une offre pour une demande de trajet La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateDriverOfferDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.createDriverOffer` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `CreateDriverOfferDto`.

- **`proposedDepartureDate`** — obligatoire, string. Date/heure de départ proposée par le driver. exemple `2025-12-20T10:00:00Z`. date ISO ; ne doit pas être vide. présent dans le schéma Swagger.
- **`pricePerSeat`** — obligatoire, number. Prix proposé par place. exemple `4500`. nombre ; minimum 0 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`availableSeats`** — obligatoire, number. Nombre de places disponibles. Maximum 2 pour une moto à 2 roues et 3 pour une moto à 3 roues.. exemple `4`. nombre ; minimum 1 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`vehicleId`** — facultatif, string. ID du véhicule à utiliser (doit appartenir au driver). chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`requiresPassengerKyc`** — facultatif, boolean. Indique que le conducteur exige un KYC approuvé avant embarquement.. exemple `false`. booléen. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère proposé par le conducteur pour la prise en charge. exemple `Je m'arrête devant la station`. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées de prise en charge proposées par le conducteur [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère proposé par le conducteur pour l'arrivée. exemple `Arrivee possible au parking principal`. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées d'arrivée proposées par le conducteur [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.

<a id="get-api-v1-trip-requests-id-passenger-contact"></a>
### GET `/api/v1/trip-requests/:id/passenger-contact`

Swagger résume l’opération ainsi : « Contact the passenger of an open request before accepting ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.getPassengerContact` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="put-api-v1-trip-requests-id-release-driver"></a>
### PUT `/api/v1/trip-requests/:id/release-driver`

Swagger résume l’opération ainsi : « Release an overdue selected driver ». Permet au passager, après dépassement de sa plage de prise en charge et avant embarquement, de libérer le conducteur sélectionné et de rendre la demande à nouveau visible aux autres conducteurs. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.releaseOverdueSelectedDriver` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-trip-requests-id-start-trip"></a>
### PUT `/api/v1/trip-requests/:id/start-trip`

Swagger résume l’opération ainsi : « Start a trip from an accepted trip request ». Permet au driver sélectionné de lancer le trajet à partir d'une demande acceptée. Crée un trajet et une réservation automatique pour le passager. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TripRequestsController.startTripFromRequest` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-trip-requests-my-offers"></a>
### GET `/api/v1/trip-requests/my-offers`

Swagger résume l’opération ainsi : « Get my driver offers ». Récupère toutes les offres faites par le driver connecté, avec les détails des demandes de trajet associées La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403.

- **Contrôleur :** `TripRequestsController.findMyOffers` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

<a id="get-api-v1-trip-requests-my-requests"></a>
### GET `/api/v1/trip-requests/my-requests`

Swagger résume l’opération ainsi : « Get my trip requests ». Récupère toutes les demandes de trajet créées par l'utilisateur connecté La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `TripRequestsController.findMyRequests` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

<a id="post-api-v1-trip-requests-recommended-price"></a>
### POST `/api/v1/trip-requests/recommended-price`

Swagger résume l’opération ainsi : « Recommend a trip request price ». Calcule le prix recommandé pour une demande de trajet : voiture = 500 FC par kilomètre et par passager, moto = 1000 FC par kilomètre et par passager. Une forte pluie dans une zone du parcours applique un coefficient de 1.3. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RecommendTripRequestPriceDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.recommendPrice` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `RecommendTripRequestPriceDto`.

- **`departureLocation`** — facultatif, string. Adresse de départ, utilisée si les coordonnées ne sont pas fournies. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. Adresse d’arrivée, utilisée si les coordonnées ne sont pas fournies. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d’arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`numberOfSeats`** — facultatif, number. Nombre de passagers pour calculer le total recommandé. exemple `3`. nombre ; minimum 1. présent dans le schéma Swagger.
- **`vehicleType`** — facultatif, énumération. Type de véhicule utilisé pour la grille tarifaire : voiture = 500 FC/km, moto = 1000 FC/km. exemple `motorcycle_2_wheels`. valeur autorisée : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. Message renvoyé : « Le type de véhicule sélectionné est invalide » ; énumération Swagger : `car`, `motorcycle_2_wheels`, `motorcycle_3_wheels`. présent dans le schéma Swagger.

<a id="post-api-v1-trip-requests-vehicle-options"></a>
### POST `/api/v1/trip-requests/vehicle-options`

Swagger résume l’opération ainsi : « List vehicle choices and their recommended prices ». Retourne, pour un même itinéraire, chaque type de véhicule disponible avec son tarif par kilomètre, son prix par place et son prix total. Ce endpoint doit être appelé avant la création de la demande. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `TripRequestVehicleOptionsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TripRequestsController.getVehicleOptions` dans `src/trip-requests/trip-requests.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `TripRequestVehicleOptionsDto`.

- **`departureLocation`** — facultatif, string. Adresse de départ, utilisée si les coordonnées ne sont pas fournies. chaîne de caractères. présent dans le schéma Swagger.
- **`departureReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge. chaîne de caractères. présent dans le schéma Swagger.
- **`departureCoordinates`** — facultatif, [number, number]. Coordonnées du point de départ [longitude, latitude]. exemple `15.2663`, `-4.325`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`arrivalLocation`** — facultatif, string. Adresse d’arrivée, utilisée si les coordonnées ne sont pas fournies. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée. chaîne de caractères. présent dans le schéma Swagger.
- **`arrivalCoordinates`** — facultatif, [number, number]. Coordonnées du point d’arrivée [longitude, latitude]. exemple `15.3222`, `-4.4419`. tableau ; au moins 2 élément(s) ; au plus 2 élément(s) ; nombre. présent dans le schéma Swagger.
- **`numberOfSeats`** — facultatif, number. Nombre de passagers pour calculer le total recommandé. exemple `3`. nombre ; minimum 1. présent dans le schéma Swagger.

## Driver Dispatch

Présence du conducteur disponible, position, et réponse à une offre de dispatch. Ces routes n’ont pas de `@ApiTags` : elles apparaissent sans groupe nommé dans Swagger, alors que le serveur les expose sous `/api/v1/driver-dispatch`.

Ces opérations ne portent pas `@ApiTags`. Dans l’interface Swagger elles ne rejoignent pas un des groupes nommés dans `DocumentBuilder`.

<a id="post-api-v1-driver-dispatch-notifications"></a>
### POST `/api/v1/driver-dispatch/notifications`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `NotificationCapabilityDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `DriverDispatchController.register` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `NotificationCapabilityDto`.

- **`version`** — obligatoire, number. entier ; valeur autorisée : `1`, `2`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-driver-dispatch-offers-id"></a>
### GET `/api/v1/driver-dispatch/offers/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403.

- **Contrôleur :** `DriverDispatchController.offer` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="put-api-v1-driver-dispatch-offers-id-respond"></a>
### PUT `/api/v1/driver-dispatch/offers/:id/respond`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `DispatchResponseDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `DriverDispatchController.respond` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `DispatchResponseDto`.

- **`decision`** — obligatoire, énumération. valeur autorisée : `accept`, `decline`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

**Comportement des commandes immédiates (20 octobre 2026)**

`decline` enregistre le refus et prépare immédiatement la proposition au conducteur éligible suivant par proximité, dans la même transaction. Le push est déclenché après commit. Une répétition du même refus reste idempotente : elle ne passe pas au-delà du conducteur suivant. Une seule invitation active est créée par demande ; une acceptation arrête la recherche. La réponse reste `{ status, requestId }`, sans changement du contrat mobile. La réception physique du push dépend du téléphone et du fournisseur.

<a id="put-api-v1-driver-dispatch-position"></a>
### PUT `/api/v1/driver-dispatch/position`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 6 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `DriverPositionDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `DriverDispatchController.position` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `DriverPositionDto`.

- **`latitude`** — obligatoire, number. nombre ; minimum -90 ; maximum 90. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`longitude`** — obligatoire, number. nombre ; minimum -180 ; maximum 180. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`accuracy`** — obligatoire, number. nombre ; minimum 0 ; maximum 250. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`recordedAt`** — obligatoire, string. date ISO 8601. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="put-api-v1-driver-dispatch-presence"></a>
### PUT `/api/v1/driver-dispatch/presence`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `driver`. Sinon la réponse est 403. Le plafond de cette route est de 12 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `DriverPresenceDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `DriverDispatchController.presence` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `DriverPresenceDto`.

- **`leaseId`** — facultatif, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`available`** — obligatoire, boolean. booléen. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`vehicleId`** — conditionnel, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`seats`** — conditionnel, number. entier ; minimum 1 ; maximum 20. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`latitude`** — conditionnel, number. nombre ; minimum -90 ; maximum 90. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`longitude`** — conditionnel, number. nombre ; minimum -180 ; maximum 180. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-driver-dispatch-status"></a>
### GET `/api/v1/driver-dispatch/status`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `DriverDispatchController.status` dans `src/trip-requests/dispatch/dispatch.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

## Bookings

Réservation d’une place, paiement, choix du mode de règlement, décisions du conducteur, annulation, descente anticipée, contacts et confirmation de prise en charge ou de dépose. Le callback FlexPay est public.

<a id="post-api-v1-bookings"></a>
### POST `/api/v1/bookings`

Swagger résume l’opération ainsi : « Create a new booking ». La réservation de 1 ou 2 places ne requiert pas de KYC approuvé, sauf si le conducteur l'exige. Au-delà de 2 places, le KYC du passager doit être approuvé. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateBookingDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.create` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateBookingDto`.

- **`tripId`** — obligatoire, string. ID du trajet. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`numberOfSeats`** — obligatoire, number. Nombre de places à réserver. Jusqu’à 2 sans KYC ; au-delà, le KYC du passager doit être approuvé et les places doivent être disponibles.. nombre ; minimum 1. Message renvoyé : « Le nombre de places doit être au moins 1 » ; ne doit pas être vide. présent dans le schéma Swagger.
- **`passengerOrigin`** — facultatif, string. Point de départ du passager (optionnel - si non spécifié, utilise le point de départ du trajet). exemple `Centre-ville de Kinshasa`. chaîne de caractères. présent dans le schéma Swagger.
- **`passengerOriginReference`** — facultatif, string. Référence ou repère connu pour faciliter la prise en charge du passager. exemple `Devant la pharmacie, portail bleu`. chaîne de caractères. présent dans le schéma Swagger.
- **`passengerOriginCoordinates`** — facultatif, PassengerOriginCoordinatesDto. Coordonnées géographiques du point de départ du passager (optionnel). objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. Latitude du point de départ du passager. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90 ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. Longitude du point de départ du passager. exemple `15.3136`. nombre ; minimum -180 ; maximum 180 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`passengerDestination`** — facultatif, string. Destination du passager (optionnel - si non spécifié, utilise la destination du trajet). exemple `Aéroport de Kinshasa`. chaîne de caractères. présent dans le schéma Swagger.
- **`passengerDestinationReference`** — facultatif, string. Référence ou repère connu pour faciliter l'arrivée du passager. exemple `Entrée principale, près du rond-point`. chaîne de caractères. présent dans le schéma Swagger.
- **`passengerDestinationCoordinates`** — facultatif, PassengerDestinationCoordinatesDto. Coordonnées géographiques de la destination du passager (optionnel). objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. Latitude de la destination du passager. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90 ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. Longitude de la destination du passager. exemple `15.3136`. nombre ; minimum -180 ; maximum 180 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode choisi à la réservation. Aucun débit n'est effectué avant l'arrivée du passager.. exemple `electronic`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.

<a id="get-api-v1-bookings-id"></a>
### GET `/api/v1/bookings/:id`

Swagger résume l’opération ainsi : « Get a booking by ID ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.findOne` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-bookings-id-accept"></a>
### PUT `/api/v1/bookings/:id/accept`

Swagger résume l’opération ainsi : « Accept a booking (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.accept` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-bookings-id-cancel"></a>
### PUT `/api/v1/bookings/:id/cancel`

Swagger résume l’opération ainsi : « Cancel a booking (passenger or driver before pickup) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.cancel` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-bookings-id-cash-receipt"></a>
### PUT `/api/v1/bookings/:id/cash-receipt`

Swagger résume l’opération ainsi : « Confirmer explicitement le cash reçu après la dépose (conducteur du trajet uniquement) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `ConfirmCashReceiptDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `CashReceiptsController.confirm` dans `src/bookings/cash-receipts.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `ConfirmCashReceiptDto`.

- **`amount`** — obligatoire, number. nombre ; minimum 0.01 ; maximum 99999999.99. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`currency`** — obligatoire, string. valeur autorisée : `CDF`, `USD`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="put-api-v1-bookings-id-confirm-dropoff"></a>
### PUT `/api/v1/bookings/:id/confirm-dropoff`

Swagger résume l’opération ainsi : « Record driver dropoff confirmation (both parties required) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ConfirmDropoffDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.confirmDropoff` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ConfirmDropoffDto`.

- **`confirmed`** — facultatif, boolean. Confirmer ou signaler l'arrivée du passager. exemple `true`. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode de règlement choisi par le passager au moment de signaler son arrivée : paiement électronique, jetons Zwanga ou paiement physique. exemple `cash`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-confirm-dropoff-passenger"></a>
### PUT `/api/v1/bookings/:id/confirm-dropoff-passenger`

Swagger résume l’opération ainsi : « Confirm dropoff by the reservation holder ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ConfirmDropoffDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.confirmDropoffByPassenger` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ConfirmDropoffDto`.

- **`confirmed`** — facultatif, boolean. Confirmer ou signaler l'arrivée du passager. exemple `true`. présent dans le schéma Swagger.
- **`paymentMode`** — facultatif, énumération. Mode de règlement choisi par le passager au moment de signaler son arrivée : paiement électronique, jetons Zwanga ou paiement physique. exemple `cash`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-confirm-pickup"></a>
### PUT `/api/v1/bookings/:id/confirm-pickup`

Swagger résume l’opération ainsi : « Record driver pickup confirmation (both parties required) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ConfirmPickupDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.confirmPickup` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ConfirmPickupDto`.

- **`confirmed`** — facultatif, boolean. Confirmer la récupération du passager. exemple `true`. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-confirm-pickup-passenger"></a>
### PUT `/api/v1/bookings/:id/confirm-pickup-passenger`

Swagger résume l’opération ainsi : « Confirm pickup by passenger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ConfirmPickupDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.confirmPickupByPassenger` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ConfirmPickupDto`.

- **`confirmed`** — facultatif, boolean. Confirmer la récupération du passager. exemple `true`. présent dans le schéma Swagger.

<a id="get-api-v1-bookings-id-driver-contact"></a>
### GET `/api/v1/bookings/:id/driver-contact`

Swagger résume l’opération ainsi : « Get driver contact information for a booking ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.getDriverContact` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-bookings-id-interruption-request"></a>
### POST `/api/v1/bookings/:id/interruption-request`

Swagger résume l’opération ainsi : « Request an early trip interruption for this passenger booking ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestTripInterruptionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.requestTripInterruption` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `RequestTripInterruptionDto`.

- **`reason`** — obligatoire, énumération. exemple `emergency`. valeur autorisée : `emergency`, `health`, `safety`, `route_issue`, `personal`, `other` ; ne doit pas être vide ; énumération Swagger : `emergency`, `health`, `safety`, `route_issue`, `personal`, `other`. présent dans le schéma Swagger.
- **`note`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`coordinates`** — facultatif, TripInterruptionCoordinatesDto. objet imbriqué validé. présent dans le schéma Swagger.
  - **`latitude`** — obligatoire, number. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. exemple `15.3136`. nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-interruption-request-cancel"></a>
### PUT `/api/v1/bookings/:id/interruption-request/cancel`

Swagger résume l’opération ainsi : « Cancel a pending passenger interruption request ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.cancelTripInterruption` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="put-api-v1-bookings-id-interruption-request-confirm"></a>
### PUT `/api/v1/bookings/:id/interruption-request/confirm`

Swagger résume l’opération ainsi : « Confirm a passenger early interruption request (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.confirmTripInterruption` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-bookings-id-interruption-request-preview"></a>
### POST `/api/v1/bookings/:id/interruption-request/preview`

Swagger résume l’opération ainsi : « Estimer le montant d’une descente anticipée sans la demander ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `PassengerInterruptionPreviewDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `BookingsController.previewTripInterruption` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `PassengerInterruptionPreviewDto`.

- **`coordinates`** — facultatif, TripInterruptionCoordinatesDto. objet imbriqué validé. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`latitude`** — obligatoire, number. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90. présent dans le schéma Swagger.
  - **`longitude`** — obligatoire, number. exemple `15.3136`. nombre ; minimum -180 ; maximum 180. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-interruption-request-reject"></a>
### PUT `/api/v1/bookings/:id/interruption-request/reject`

Swagger résume l’opération ainsi : « Reject a passenger early interruption request (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RejectTripInterruptionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.rejectTripInterruption` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `RejectTripInterruptionDto`.

- **`reason`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. UUID. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-passenger-location"></a>
### PUT `/api/v1/bookings/:id/passenger-location`

Swagger résume l’opération ainsi : « Update passenger current location (passenger only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdatePassengerLocationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.updatePassengerLocation` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdatePassengerLocationDto`.

- **`latitude`** — obligatoire, number. Latitude de la position actuelle du passager. exemple `-4.3276`. nombre ; minimum -90 ; maximum 90 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`longitude`** — obligatoire, number. Longitude de la position actuelle du passager. exemple `15.3136`. nombre ; minimum -180 ; maximum 180 ; ne doit pas être vide. présent dans le schéma Swagger.
- **`accuracy`** — facultatif, number. Precision GPS en metres. nombre ; minimum 0 ; maximum 1000. présent dans le schéma Swagger.
- **`speed`** — facultatif, number. Vitesse GPS en m/s. nombre ; minimum 0 ; maximum 100. présent dans le schéma Swagger.
- **`heading`** — facultatif, number. Cap GPS en degres. nombre ; minimum 0 ; maximum 360. présent dans le schéma Swagger.
- **`recordedAt`** — facultatif, string. Horodatage ISO de la mesure GPS sur le terminal. date ISO. présent dans le schéma Swagger.

<a id="post-api-v1-bookings-id-pay"></a>
### POST `/api/v1/bookings/:id/pay`

Swagger résume l’opération ainsi : « Initiate electronic payment for a booking ». Disponible uniquement après l'arrivée du passager. Calcule le montant côté backend puis initialise le paiement FlexPay ou PawaPay. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `InitiatePaymentDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.initiatePayment` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `InitiatePaymentDto`.

- **`method`** — obligatoire, énumération. Canal technique utilisé pour la transaction (FlexPay ou PawaPay).. exemple `mobile_money`. valeur autorisée : `mobile_money`, `card`. Message renvoyé : « La méthode de paiement sélectionnée est invalide » ; énumération Swagger : `mobile_money`, `card`. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro du client au format international pour Mobile Money. exemple `243891234567`. chaîne de caractères. Message renvoyé : « Le numéro de téléphone doit être une chaîne de caractères » ; au plus 20 caractère(s). Message renvoyé : « Le numéro de téléphone ne peut pas dépasser 20 caractères ». présent dans le schéma Swagger.
- **`approveUrl`** — facultatif, string. URL appelée après un paiement carte approuvé. exemple `zwanga://payments/trips?status=success`. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`cancelUrl`** — facultatif, string. URL appelée après une annulation du paiement carte. exemple `zwanga://payments/trips?status=cancel`. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`declineUrl`** — facultatif, string. URL appelée après un refus du paiement carte. exemple `zwanga://payments/trips?status=decline`. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`preferredProvider`** — facultatif, énumération. Prestataire préféré. Si indisponible, le backend bascule vers l’autre canal Mobile Money.. exemple `pawapay`. valeur autorisée : `flexpay`, `pawapay`. Message renvoyé : « Le prestataire de paiement sélectionné est invalide » ; énumération Swagger : `flexpay`, `pawapay`. présent dans le schéma Swagger.
- **`pawaPayOperator`** — facultatif, string. Opérateur Mobile Money pawaPay choisi par le client. chaîne de caractères ; au plus 40 caractère(s). présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-payment-mode"></a>
### PUT `/api/v1/bookings/:id/payment-mode`

Swagger résume l’opération ainsi : « Update payment mode for a booking ». Enregistre le moyen choisi sans débiter avant l'arrivée. Après l'arrivée, sélectionner les jetons déclenche le débit si nécessaire. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateBookingPaymentModeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.updatePaymentMode` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateBookingPaymentModeDto`.

- **`paymentMode`** — obligatoire, énumération. Nouveau mode de règlement. Avant l'arrivée, ce choix n'effectue aucun débit.. exemple `cash`. valeur autorisée : `electronic`, `cash`, `points`. Message renvoyé : « Le mode de paiement sélectionné est invalide » ; ne doit pas être vide ; énumération Swagger : `electronic`, `cash`, `points`. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-reject"></a>
### PUT `/api/v1/bookings/:id/reject`

Swagger résume l’opération ainsi : « Reject a booking with a reason (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RejectBookingDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.reject` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `RejectBookingDto`.

- **`reason`** — obligatoire, string. exemple `Le véhicule est déjà complet`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

<a id="post-api-v1-bookings-id-report-problem"></a>
### POST `/api/v1/bookings/:id/report-problem`

Swagger résume l’opération ainsi : « Report a problem related to a booking (driver or passenger) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ReportBookingProblemDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.reportProblem` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `ReportBookingProblemDto`.

- **`reason`** — obligatoire, énumération. Raison du signalement. valeur autorisée : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other` ; ne doit pas être vide ; énumération Swagger : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other`. présent dans le schéma Swagger.
- **`description`** — obligatoire, string. Description détaillée du problème. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.

<a id="put-api-v1-bookings-id-respond-invitation"></a>
### PUT `/api/v1/bookings/:id/respond-invitation`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `BookingInvitationResponseDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `BookingsController.respondToInvitation` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `BookingInvitationResponseDto`.

- **`accept`** — obligatoire, boolean. booléen. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="put-api-v1-bookings-id-status"></a>
### PUT `/api/v1/bookings/:id/status`

Swagger résume l’opération ainsi : « Update booking status (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateBookingStatusDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.updateStatus` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateBookingStatusDto`.

- **`status`** — obligatoire, énumération. valeur autorisée : `pending`, `accepted`, `rejected`, `cancelled`, `no_show`, `boarding_uncertain`, `completed`, `expired` ; ne doit pas être vide ; énumération Swagger : `pending`, `accepted`, `rejected`, `cancelled`, `no_show`, `boarding_uncertain`, `completed`, `expired`. présent dans le schéma Swagger.
- **`rejectionReason`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.

<a id="post-api-v1-bookings-id-whatsapp-notification-data"></a>
### POST `/api/v1/bookings/:id/whatsapp-notification-data`

Swagger résume l’opération ainsi : « Récupérer les données pour envoyer des notifications WhatsApp aux contacts d'urgence (2 à 3 contacts) ». Retourne le message formaté et les informations des contacts d'urgence sélectionnés. Le frontend se charge de l'envoi WhatsApp. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SendWhatsAppNotificationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.getWhatsAppNotificationData` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `SendWhatsAppNotificationDto`.

- **`emergencyContactIds`** — obligatoire, tableau. IDs des contacts d'urgence a notifier (1 a 5 contacts). tableau ; au moins 1 élément(s). Message renvoyé : « Vous devez sélectionner au moins 1 contact d'urgence » ; au plus 5 élément(s). Message renvoyé : « Vous ne pouvez pas sélectionner plus de 5 contacts d'urgence » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de contact doit être un UUID valide ». présent dans le schéma Swagger.

<a id="post-api-v1-bookings-flexpay-callback"></a>
### POST `/api/v1/bookings/flexpay/callback`

Swagger résume l’opération ainsi : « Receive FlexPay payment callback for trip bookings ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `BookingsController.handleFlexPayCallback` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-bookings-my-bookings"></a>
### GET `/api/v1/bookings/my-bookings`

Swagger résume l’opération ainsi : « Get all bookings of the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.findMyBookings` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `scope` — facultatif. Type `string`.

<a id="get-api-v1-bookings-my-bookings-history"></a>
### GET `/api/v1/bookings/my-bookings/history`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.history` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageQuery` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`search`** — facultatif, string. chaîne de caractères ; au plus 100 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-bookings-my-bookings-trip-tripid"></a>
### GET `/api/v1/bookings/my-bookings/trip/:tripId`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.mineForTrip` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId` — doit être un UUID

<a id="get-api-v1-bookings-payments-ordernumber-status"></a>
### GET `/api/v1/bookings/payments/:orderNumber/status`

Swagger résume l’opération ainsi : « Check a trip booking payment status and update the booking ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.checkPaymentStatus` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="get-api-v1-bookings-trip-tripid"></a>
### GET `/api/v1/bookings/trip/:tripId`

Swagger résume l’opération ainsi : « Get all bookings for a trip (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.findByTrip` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

<a id="get-api-v1-bookings-trip-tripid-passengers-locations"></a>
### GET `/api/v1/bookings/trip/:tripId/passengers-locations`

Swagger résume l’opération ainsi : « Get all passengers locations for a trip (driver only) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `BookingsController.getPassengersLocations` dans `src/bookings/bookings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

## Ride declarations

Déclarations de prise en charge et de dépose liées à un trajet ou à une réservation. Le contrôleur n’a pas de `@ApiTags`. Chaque appel est authentifié et plafonné.

Ces opérations ne portent pas `@ApiTags`. Dans l’interface Swagger elles ne rejoignent pas un des groupes nommés dans `DocumentBuilder`.

<a id="get-api-v1-ride-declarations-booking-id"></a>
### GET `/api/v1/ride-declarations/booking/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `RideDeclarationsController.booking` dans `src/ride-declarations/ride-declarations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="put-api-v1-ride-declarations-booking-id"></a>
### PUT `/api/v1/ride-declarations/booking/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 40 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `RideDeclarationDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `RideDeclarationsController.declare` dans `src/ride-declarations/ride-declarations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `RideDeclarationDto`.

- **`actorUserId`** — obligatoire, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`eventId`** — obligatoire, string. UUID version 4. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`stage`** — obligatoire, énumération. valeur autorisée : `pickup`, `dropoff`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`decision`** — obligatoire, énumération. valeur autorisée : `confirm`, `reject`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`occurredAt`** — obligatoire, string. date ISO 8601. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`latitude`** — facultatif, number. nombre ; minimum -90 ; maximum 90. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`longitude`** — facultatif, number. nombre ; minimum -180 ; maximum 180. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`accuracy`** — facultatif, number. nombre ; minimum 0 ; maximum 10000. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-ride-declarations-trip-id"></a>
### GET `/api/v1/ride-declarations/trip/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `RideDeclarationsController.trip` dans `src/ride-declarations/ride-declarations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

## Tracking

Création d’un lien de suivi pour un trajet, et consultation publique de ce lien par jeton. Le suivi temps réel passe aussi par Socket.IO, hors Swagger.

<a id="get-api-v1-tracking-public-token"></a>
### GET `/api/v1/tracking/public/:token`

Swagger résume l’opération ainsi : « Read a public trip tracking link ». Retourne les informations publiques de suivi du trajet pour une page web sans authentification. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `TrackingController.getPublicTripTracking` dans `src/tracking/tracking.controller.ts`
- **Succès par défaut :** 200

**Paramètres de chemin**

- `token`

<a id="post-api-v1-tracking-trips-tripid-share-links"></a>
### POST `/api/v1/tracking/trips/:tripId/share-links`

Swagger résume l’opération ainsi : « Create a public tracking link for a trip ». Génère un lien web limité dans le temps pour permettre à un proche de suivre un trajet sans installer l'application. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateTripShareLinkDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `TrackingController.createTripShareLink` dans `src/tracking/tracking.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

**Corps**

Classe `CreateTripShareLinkDto`.

- **`bookingId`** — facultatif, string. Réservation à associer au lien public lorsque le passager partage son propre suivi. UUID. présent dans le schéma Swagger.
- **`recipientEmail`** — facultatif, string. Adresse email du proche. Optionnelle si l'utilisateur veut remplir le destinataire dans son client mail.. exemple `proche@example.com`. adresse e-mail ; au plus 160 caractère(s). présent dans le schéma Swagger.
- **`recipientName`** — facultatif, string. Nom du proche a afficher dans le brouillon email. exemple `Maman`. chaîne de caractères ; au plus 120 caractère(s). présent dans le schéma Swagger.
- **`message`** — facultatif, string. Message personnel ajoute au brouillon email. exemple `Voici le lien pour suivre mon trajet.`. chaîne de caractères ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`expiresInHours`** — facultatif, number. Durée de validité du lien public en heures. entier ; minimum 1 ; maximum 168. présent dans le schéma Swagger.

## Ratings

Création d’une note après une interaction vérifiée, puis lecture des avis publics et de la moyenne d’un utilisateur.

<a id="post-api-v1-ratings"></a>
### POST `/api/v1/ratings`

Swagger résume l’opération ainsi : « Create a rating ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateRatingDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `RatingsController.create` dans `src/ratings/ratings.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateRatingDto`.

- **`ratedUserId`** — obligatoire, string. UUID. présent dans le schéma Swagger.
- **`tripId`** — facultatif, string. UUID. présent dans le schéma Swagger.
- **`rating`** — obligatoire, number. entier ; minimum 1 ; maximum 5. présent dans le schéma Swagger.
- **`comment`** — facultatif, string. chaîne de caractères ; au plus 2000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-ratings-user-userid"></a>
### GET `/api/v1/ratings/user/:userId`

Swagger résume l’opération ainsi : « Get ratings for a user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `RatingsController.findByUser` dans `src/ratings/ratings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `userId`

<a id="get-api-v1-ratings-user-userid-average"></a>
### GET `/api/v1/ratings/user/:userId/average`

Swagger résume l’opération ainsi : « Get average rating for a user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `RatingsController.getAverageRating` dans `src/ratings/ratings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `userId`

<a id="get-api-v1-ratings-user-userid-page"></a>
### GET `/api/v1/ratings/user/:userId/page`

Swagger résume l’opération ainsi : « Get a bounded page of public reviews ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `RatingsController.findPage` dans `src/ratings/ratings.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `userId` — doit être un UUID

**Paramètres de requête**

Objet `HistoryPageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


## Payments

Moyens de paiement, callbacks FlexPay et PawaPay, historique et statut d’un ordre. Les callbacks sont publics. L’historique concerne le compte du JWT.

<a id="get-api-v1-payments-ordernumber-status"></a>
### GET `/api/v1/payments/:orderNumber/status`

Swagger résume l’opération ainsi : « Check a payment status for the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.checkPaymentStatus` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="get-api-v1-payments-paymentid-details"></a>
### GET `/api/v1/payments/:paymentId/details`

Swagger résume l’opération ainsi : « Get sanitized payment details for the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getPaymentDetails` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `paymentId`

<a id="post-api-v1-payments-flexpay-callback"></a>
### POST `/api/v1/payments/flexpay/callback`

Swagger résume l’opération ainsi : « Receive a generic FlexPay payment callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `PaymentsController.handleFlexPayCallback` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-payments-history"></a>
### GET `/api/v1/payments/history`

Swagger résume l’opération ainsi : « Get sanitized payment history for the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getPaymentHistory` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-payments-history-context"></a>
### GET `/api/v1/payments/history/context`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getPaymentContext` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `PaymentContextDto` :

- **`kind`** — obligatoire, énumération. valeur autorisée : `booking`, `subscription`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`bookingId`** — conditionnel, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`reference`** — facultatif, string. chaîne de caractères ; au plus 120 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`tripId`** — facultatif, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`transactionId`** — facultatif, string. UUID. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-payments-history-page"></a>
### GET `/api/v1/payments/history/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getPaymentHistoryPage` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `PaymentHistoryPageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`filter`** — facultatif, énumération. valeur autorisée : `all`, `succeeded`, `pending`, `failed`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-payments-history-summary"></a>
### GET `/api/v1/payments/history/summary`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getPaymentHistorySummary` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-payments-my-transactions"></a>
### GET `/api/v1/payments/my-transactions`

Swagger résume l’opération ainsi : « Get all payment transactions for the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getMyTransactions` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-payments-pawapay-deposits-callback"></a>
### POST `/api/v1/payments/pawapay/deposits/callback`

Swagger résume l’opération ainsi : « Receive a PawaPay deposit callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.handlePawaPayDepositCallback` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

<a id="post-api-v1-payments-pawapay-payouts-callback"></a>
### POST `/api/v1/payments/pawapay/payouts/callback`

Swagger résume l’opération ainsi : « Receive a PawaPay payout callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.handlePawaPayPayoutCallback` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

<a id="post-api-v1-payments-pawapay-refunds-callback"></a>
### POST `/api/v1/payments/pawapay/refunds/callback`

Swagger résume l’opération ainsi : « Receive a PawaPay refund callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.handlePawaPayRefundCallback` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

<a id="get-api-v1-payments-providers"></a>
### GET `/api/v1/payments/providers`

Swagger résume l’opération ainsi : « List available payment providers and configured callback URLs ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PaymentsController.getProviders` dans `src/payments/payments.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

## PawaPay

Opérations PawaPay réservées à l’exploitation : moyens disponibles, prédiction d’opérateur, soldes, remboursements et relance des transactions. Ce ne sont pas les callbacks, qui vivent sous Payments.

<a id="get-api-v1-payments-pawapay-availability"></a>
### GET `/api/v1/payments/pawapay/availability`

Swagger résume l’opération ainsi : « Get live COD provider availability ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.availability` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-payments-pawapay-methods"></a>
### GET `/api/v1/payments/pawapay/methods`

Swagger résume l’opération ainsi : « Get configured COD mobile money providers and payment limits ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.methods` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-payments-pawapay-predict-provider"></a>
### POST `/api/v1/payments/pawapay/predict-provider`

Swagger résume l’opération ainsi : « Predict the COD mobile money provider for a phone number ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `PawaPayPredictProviderDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `PawaPayOperationsController.predictProvider` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `PawaPayPredictProviderDto`.

- **`phone`** — obligatoire, string. exemple `+243891234567`. chaîne de caractères ; Length. présent dans le schéma Swagger.

<a id="post-api-v1-payments-pawapay-refunds"></a>
### POST `/api/v1/payments/pawapay/refunds`

Swagger résume l’opération ainsi : « Initiate an idempotent partial or full refund of a confirmed pawaPay deposit ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `PawaPayCreateRefundDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `PawaPayOperationsController.createRefund` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `PawaPayCreateRefundDto`.

- **`refundId`** — obligatoire, string. UUIDv4 stable pour les reprises idempotentes. UUID version 4. présent dans le schéma Swagger.
- **`paymentTransactionId`** — obligatoire, string. Identifiant interne du dépôt Zwanga. UUID. présent dans le schéma Swagger.
- **`amount`** — obligatoire, number. Montant à rembourser dans la devise du dépôt. nombre ; minimum 0.01 ; maximum 99999999.99. présent dans le schéma Swagger.
- **`reason`** — obligatoire, string. chaîne de caractères ; Length. présent dans le schéma Swagger.
- **`businessReversalReference`** — facultatif, string. Référence de la régularisation métier déjà effectuée. chaîne de caractères ; Length. présent dans le schéma Swagger.

<a id="get-api-v1-payments-pawapay-refunds-refundid"></a>
### GET `/api/v1/payments/pawapay/refunds/:refundId`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.getRefund` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `refundId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-refunds-refundid-check"></a>
### POST `/api/v1/payments/pawapay/refunds/:refundId/check`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.checkRefund` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `refundId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-refunds-refundid-fail-enqueued"></a>
### POST `/api/v1/payments/pawapay/refunds/:refundId/fail-enqueued`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.failEnqueuedRefund` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `refundId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-refunds-refundid-resend-callback"></a>
### POST `/api/v1/payments/pawapay/refunds/:refundId/resend-callback`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.resendRefundCallback` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `refundId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-refunds-refundid-retry"></a>
### POST `/api/v1/payments/pawapay/refunds/:refundId/retry`

Swagger résume l’opération ainsi : « Retry a refund with its original UUID only after pawaPay returns NOT_FOUND ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.retryRefund` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `refundId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-transactions-paymentid-check"></a>
### POST `/api/v1/payments/pawapay/transactions/:paymentId/check`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.checkPayment` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `paymentId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-transactions-paymentid-fail-enqueued"></a>
### POST `/api/v1/payments/pawapay/transactions/:paymentId/fail-enqueued`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.failEnqueuedPayout` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `paymentId` — doit être un UUID

<a id="get-api-v1-payments-pawapay-transactions-paymentid-refunds"></a>
### GET `/api/v1/payments/pawapay/transactions/:paymentId/refunds`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.listRefunds` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `paymentId` — doit être un UUID

<a id="post-api-v1-payments-pawapay-transactions-paymentid-resend-callback"></a>
### POST `/api/v1/payments/pawapay/transactions/:paymentId/resend-callback`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.resendPaymentCallback` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `paymentId` — doit être un UUID

<a id="get-api-v1-payments-pawapay-wallet-balances"></a>
### GET `/api/v1/payments/pawapay/wallet-balances`

Swagger résume l’opération ainsi : « Get pawaPay merchant wallet balances ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `PawaPayOperationsController.walletBalances` dans `src/payments/pawapay-operations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

## Wallet

Portefeuille de jetons Zwanga : solde, journal, achat via FlexPay, transfert entre utilisateurs et retrait. Les callbacks de paiement et de retrait sont publics.

<a id="get-api-v1-wallet-ledger"></a>
### GET `/api/v1/wallet/ledger`

Swagger résume l’opération ainsi : « Get current user Zwanga token ledger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.getMyLedger` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-wallet-ledger-page"></a>
### GET `/api/v1/wallet/ledger/page`

Swagger résume l’opération ainsi : « Get a cursor page of current user token ledger ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.getMyLedgerPage` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-wallet-me"></a>
### GET `/api/v1/wallet/me`

Swagger résume l’opération ainsi : « Get current user Zwanga token wallet ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.getMyWallet` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-wallet-topups"></a>
### POST `/api/v1/wallet/topups`

Swagger résume l’opération ainsi : « Buy Zwanga tokens through FlexPay ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `InitiateWalletTopUpDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `WalletController.initiateTopUp` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `InitiateWalletTopUpDto`.

- **`amount`** — obligatoire, number. Nombre de jetons Zwanga a acheter. 1 jeton = 100 FC/CDF.. exemple `50`. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`method`** — obligatoire, énumération. Canal FlexPay ou PawaPay utilisé pour acheter les jetons.. exemple `mobile_money`. valeur autorisée : `mobile_money`, `card` ; énumération Swagger : `mobile_money`, `card`. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro Mobile Money du client.. exemple `+243891234567`. chaîne de caractères ; au plus 20 caractère(s). présent dans le schéma Swagger.
- **`approveUrl`** — facultatif, string. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`cancelUrl`** — facultatif, string. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`declineUrl`** — facultatif, string. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.
- **`preferredProvider`** — facultatif, énumération. valeur autorisée : `flexpay`, `pawapay` ; énumération Swagger : `flexpay`, `pawapay`. présent dans le schéma Swagger.
- **`pawaPayOperator`** — facultatif, string. Opérateur Mobile Money pawaPay choisi par le client. chaîne de caractères ; au plus 40 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-wallet-topups-ordernumber-status"></a>
### GET `/api/v1/wallet/topups/:orderNumber/status`

Swagger résume l’opération ainsi : « Check wallet topup payment status ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.checkTopUpStatus` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="post-api-v1-wallet-topups-flexpay-callback"></a>
### POST `/api/v1/wallet/topups/flexpay/callback`

Swagger résume l’opération ainsi : « Receive FlexPay callback for wallet topups ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `WalletController.handleTopUpCallback` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

<a id="post-api-v1-wallet-transfers"></a>
### POST `/api/v1/wallet/transfers`

Swagger résume l’opération ainsi : « Share Zwanga tokens with another platform user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `TransferWalletPointsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `WalletController.transferPoints` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `TransferWalletPointsDto`.

- **`amount`** — obligatoire, number. Nombre de jetons Zwanga a partager avec un autre utilisateur.. exemple `2500`. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`recipientUserId`** — facultatif, string. ID de l'utilisateur destinataire.. exemple `123e4567-e89b-12d3-a456-426614174000`. UUID. présent dans le schéma Swagger.
- **`recipientPhone`** — facultatif, string. Téléphone du destinataire déjà inscrit sur Zwanga.. exemple `+243891234567`. chaîne de caractères ; au plus 20 caractère(s). présent dans le schéma Swagger.
- **`recipientEmail`** — facultatif, string. Email du destinataire déjà inscrit sur Zwanga.. exemple `client@zwanga.cd`. adresse e-mail ; au plus 160 caractère(s). présent dans le schéma Swagger.
- **`note`** — facultatif, string. Petit message associé au partage de jetons.. exemple `Pour ton prochain trajet`. chaîne de caractères ; au plus 200 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-wallet-withdrawals"></a>
### GET `/api/v1/wallet/withdrawals`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.listWithdrawals` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-wallet-withdrawals"></a>
### POST `/api/v1/wallet/withdrawals`

Swagger résume l’opération ainsi : « Withdraw purchased tokens to Mobile Money (KYC required) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestWalletWithdrawalDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `WalletController.requestWithdrawal` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `RequestWalletWithdrawalDto`.

- **`tokens`** — obligatoire, number. exemple `50`. nombre ; minimum 1 ; maximum 1000000. converti en nombre. présent dans le schéma Swagger.
- **`phone`** — obligatoire, string. exemple `243891234567`. chaîne de caractères ; motif `/^\+?243\d{9}$/`. présent dans le schéma Swagger.
- **`idempotencyKey`** — obligatoire, string. UUID stable pour une seule demande de retrait, y compris ses retries.. UUID version 4. présent dans le schéma Swagger.

<a id="get-api-v1-wallet-withdrawals-id-status"></a>
### GET `/api/v1/wallet/withdrawals/:id/status`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `WalletController.withdrawalStatus` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-wallet-withdrawals-flexpay-callback"></a>
### POST `/api/v1/wallet/withdrawals/flexpay/callback`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `WalletController.withdrawalCallback` dans `src/wallet/wallet.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

## Driver Settlements

Gains du conducteur, résumé de revenu d’un trajet ou d’une réservation, et demande de reversement. Le callback FlexPay du reversement est public.

<a id="get-api-v1-driver-settlements-bookings-bookingid-revenue-summary"></a>
### GET `/api/v1/driver-settlements/bookings/:bookingId/revenue-summary`

Swagger résume l’opération ainsi : « Afficher le gain du conducteur pour une réservation après dépose ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getBookingRevenueSummary` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `bookingId`

<a id="get-api-v1-driver-settlements-earnings"></a>
### GET `/api/v1/driver-settlements/earnings`

Swagger résume l’opération ainsi : « Get current driver earnings ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getMyEarnings` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-driver-settlements-earnings-page"></a>
### GET `/api/v1/driver-settlements/earnings/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getMyEarningsPage` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-driver-settlements-me"></a>
### GET `/api/v1/driver-settlements/me`

Swagger résume l’opération ainsi : « Get current driver settlement balance ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getMySummary` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-driver-settlements-payouts"></a>
### GET `/api/v1/driver-settlements/payouts`

Swagger résume l’opération ainsi : « Get current driver payouts ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getMyPayouts` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-driver-settlements-payouts"></a>
### POST `/api/v1/driver-settlements/payouts`

Swagger résume l’opération ainsi : « Request a FlexPay Mobile Money driver payout ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestDriverPayoutDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `DriverSettlementsController.requestPayout` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `RequestDriverPayoutDto`.

- **`amount`** — obligatoire, number. Montant a retirer depuis le solde chauffeur disponible.. exemple `9500`. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro Mobile Money receveur. Si absent, le téléphone du compte chauffeur est utilisé.. exemple `+243891234567`. chaîne de caractères ; au plus 20 caractère(s). présent dans le schéma Swagger.
- **`idempotencyKey`** — facultatif, string. Clé stable générée par l’application. Rejouer la même clé retourne le même retrait sans nouveau transfert.. format `uuid`. UUID version 4. présent dans le schéma Swagger.

<a id="get-api-v1-driver-settlements-payouts-ordernumber-status"></a>
### GET `/api/v1/driver-settlements/payouts/:orderNumber/status`

Swagger résume l’opération ainsi : « Check driver payout status ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.checkPayoutStatus` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="post-api-v1-driver-settlements-payouts-flexpay-callback"></a>
### POST `/api/v1/driver-settlements/payouts/flexpay/callback`

Swagger résume l’opération ainsi : « Receive FlexPay callback for driver payouts ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `DriverSettlementsController.handlePayoutCallback` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-driver-settlements-payouts-page"></a>
### GET `/api/v1/driver-settlements/payouts/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getMyPayoutsPage` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-driver-settlements-trips-tripid-revenue-summary"></a>
### GET `/api/v1/driver-settlements/trips/:tripId/revenue-summary`

Swagger résume l’opération ainsi : « Get the authenticated driver trip revenue summary ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverSettlementsController.getTripRevenueSummary` dans `src/driver-settlements/driver-settlements.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `tripId`

## Driver Payout Recovery

Côté conducteur : demander une revue ou un rafraîchissement de l’état d’un reversement en incident.

<a id="post-api-v1-driver-settlements-payouts-id-refresh"></a>
### POST `/api/v1/driver-settlements/payouts/:id/refresh`

Swagger résume l’opération ainsi : « Vérifier un retrait par son ID Zwanga, même sans numéro FlexPay ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `DriverPayoutRecoveryController.refresh` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-driver-settlements-payouts-id-review"></a>
### POST `/api/v1/driver-settlements/payouts/:id/review`

Swagger résume l’opération ainsi : « Signaler un retrait bloqué, sans annulation ni nouvel envoi ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestPayoutReviewDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `DriverPayoutRecoveryController.review` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `RequestPayoutReviewDto`.

- **`reason`** — obligatoire, string. Motif du signalement. chaîne de caractères ; au moins 5 caractère(s) ; au plus 500 caractère(s). présent dans le schéma Swagger.

## Admin Driver Payout Recovery

Côté administration : lister les reversements en incident, les réconcilier, les clôturer comme non payés ou enregistrer un succès tardif.

<a id="get-api-v1-admin-driver-payouts"></a>
### GET `/api/v1/admin/driver-payouts`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminDriverPayoutRecoveryController.list` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `PayoutRecoveryListDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`offset`** — facultatif, number. entier ; minimum 0 ; maximum 100000. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-admin-driver-payouts-id"></a>
### GET `/api/v1/admin/driver-payouts/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AdminDriverPayoutRecoveryController.detail` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-admin-driver-payouts-id-close-late-success"></a>
### POST `/api/v1/admin/driver-payouts/:id/close-late-success`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ClosePayoutIncidentDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminDriverPayoutRecoveryController.close` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `ClosePayoutIncidentDto`.

- **`reason`** — obligatoire, string. Motif du signalement. chaîne de caractères ; au moins 5 caractère(s) ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`evidenceReference`** — obligatoire, string. Référence du rapprochement financier effectué après succès tardif. chaîne de caractères ; au moins 5 caractère(s) ; au plus 200 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-admin-driver-payouts-id-reconcile"></a>
### POST `/api/v1/admin/driver-payouts/:id/reconcile`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ReconcileDriverPayoutDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminDriverPayoutRecoveryController.reconcile` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `ReconcileDriverPayoutDto`.

- **`orderNumber`** — facultatif, string. Numéro obtenu de FlexPay ; vérifié avant association au retrait. chaîne de caractères ; au moins 1 caractère(s) ; au plus 120 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-admin-driver-payouts-id-resolve-not-paid"></a>
### POST `/api/v1/admin/driver-payouts/:id/resolve-not-paid`

Swagger résume l’opération ainsi : « Libérer les gains après confirmation définitive FlexPay de non-paiement (preuve obligatoire) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ResolveDriverPayoutDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `AdminDriverPayoutRecoveryController.resolve` dans `src/driver-settlements/driver-payout-recovery.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `ResolveDriverPayoutDto`.

- **`reason`** — obligatoire, string. Motif du signalement. chaîne de caractères ; au moins 5 caractère(s) ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`expectedReference`** — obligatoire, string. Référence Zwanga attendue (ID du retrait si aucune transaction). chaîne de caractères ; au moins 1 caractère(s) ; au plus 120 caractère(s). présent dans le schéma Swagger.
- **`evidenceReference`** — obligatoire, string. Référence de confirmation définitive FlexPay ou du dossier de rapprochement, sans secrets. chaîne de caractères ; au moins 5 caractère(s) ; au plus 200 caractère(s). présent dans le schéma Swagger.
- **`confirmedNotPaid`** — obligatoire, true. Attestation administrateur : non-exécution ou annulation définitive confirmée par FlexPay. doit valoir exactement `true` ; énumération Swagger : `true`. présent dans le schéma Swagger.

## Driver finance

Synthèse financière du conducteur connecté et options de paiement proposées pour un trajet ou une réservation.

<a id="get-api-v1-driver-finance-bookings-id-payment-options"></a>
### GET `/api/v1/driver-finance/bookings/:id/payment-options`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `DriverFinanceController.bookingOptions` dans `src/driver-finance/driver-finance.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="get-api-v1-driver-finance-me"></a>
### GET `/api/v1/driver-finance/me`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `DriverFinanceController.summary` dans `src/driver-finance/driver-finance.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-driver-finance-trips-id-payment-options"></a>
### GET `/api/v1/driver-finance/trips/:id/payment-options`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `DriverFinanceController.tripOptions` dans `src/driver-finance/driver-finance.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Paramètres de requête**

- `numberOfSeats` — facultatif. Type `string`.

## Subscriptions

Formules d’abonnement, essai, paiement monétaire ou en jetons, état premium et demandes de financement de documents. Le catalogue des formules et le callback FlexPay sont publics.

<a id="get-api-v1-subscriptions-document-funding-requests"></a>
### GET `/api/v1/subscriptions/document-funding-requests`

Swagger résume l’opération ainsi : « List document funding requests (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getDocumentFundingRequests` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListDocumentFundingRequestsQueryDto` :

- **`status`** — facultatif, énumération. valeur autorisée : `pending`, `approved`, `rejected`, `funded`, `cancelled` ; énumération Swagger : `pending`, `approved`, `rejected`, `funded`, `cancelled`. présent dans le schéma Swagger.
- **`dateFrom`** — facultatif, date valide au format `YYYY-MM-DD`. Début inclus de la période de **création** des demandes, à minuit en `Africa/Kinshasa` (UTC+1).
- **`dateTo`** — facultatif, date valide au format `YYYY-MM-DD`. Fin incluse : toute la journée en `Africa/Kinshasa` est retenue. Une période inversée produit une erreur 400.
- **`requesterName`** — facultatif, chaîne de 160 caractères maximum. Recherche partielle insensible à la casse sur le prénom, le nom ou le nom complet du conducteur demandeur, dans les deux ordres. Les espaces superflus de la recherche sont normalisés ; une recherche vide est ignorée. Les caractères `%`, `_` et `!` sont recherchés littéralement, sans joker SQL.

Les filtres se combinent avec `status`. Chaque borne de date peut être utilisée seule ; pour une journée précise, passer la même date aux deux bornes. Sans nouveaux paramètres, le comportement reste inchangé : tableau de demandes, relations `driver` et `subscription`, tri de la plus récente à la plus ancienne. Aucun filtre n'est ajouté à la route personnelle `/my`.

Exemple :

```http
GET /api/v1/subscriptions/document-funding-requests?status=pending&dateFrom=2026-10-01&dateTo=2026-10-21&requesterName=Jean%20Mukendi
Authorization: Bearer <jwt>
```


<a id="post-api-v1-subscriptions-document-funding-requests"></a>
### POST `/api/v1/subscriptions/document-funding-requests`

Swagger résume l’opération ainsi : « Create a document funding request for a premium driver ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateDocumentFundingRequestDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SubscriptionsController.createDocumentFundingRequest` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateDocumentFundingRequestDto`.

- **`documentType`** — obligatoire, énumération. exemple `technical_inspection`. valeur autorisée : `driver_license`, `vehicle_registration`, `vehicle_insurance`, `technical_inspection`, `road_tax`, `operating_permit`, `other` ; ne doit pas être vide ; énumération Swagger : `driver_license`, `vehicle_registration`, `vehicle_insurance`, `technical_inspection`, `road_tax`, `operating_permit`, `other`. présent dans le schéma Swagger.
- **`documentName`** — facultatif, string. Nom libre du document si le type choisi ne suffit pas. exemple `Contrôle technique du véhicule`. chaîne de caractères ; au plus 120 caractère(s). présent dans le schéma Swagger.
- **`amountRequested`** — facultatif, number. Montant demande pour le financement. exemple `25000`. nombre ; minimum 0. présent dans le schéma Swagger.
- **`currency`** — facultatif, string. Devise du montant demande. exemple `CDF`. chaîne de caractères ; au plus 8 caractère(s). présent dans le schéma Swagger.
- **`description`** — facultatif, string. Détails utiles pour analyser la demande. exemple `Le document expire cette semaine.`. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.

<a id="put-api-v1-subscriptions-document-funding-requests-requestid-status"></a>
### PUT `/api/v1/subscriptions/document-funding-requests/:requestId/status`

Swagger résume l’opération ainsi : « Update a document funding request status (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateDocumentFundingRequestStatusDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SubscriptionsController.updateDocumentFundingRequestStatus` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `requestId`

**Corps**

Classe `UpdateDocumentFundingRequestStatusDto`.

- **`status`** — obligatoire, énumération. exemple `approved`. valeur autorisée : `pending`, `approved`, `rejected`, `funded`, `cancelled` ; ne doit pas être vide ; énumération Swagger : `pending`, `approved`, `rejected`, `funded`, `cancelled`. présent dans le schéma Swagger.
- **`adminNote`** — facultatif, string. Note interne ou message expliquant la decision. chaîne de caractères ; au plus 1000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-subscriptions-document-funding-requests-my"></a>
### GET `/api/v1/subscriptions/document-funding-requests/my`

Swagger résume l’opération ainsi : « Get my document funding requests ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getMyDocumentFundingRequests` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-subscriptions-flexpay-callback"></a>
### POST `/api/v1/subscriptions/flexpay/callback`

Swagger résume l’opération ainsi : « Receive FlexPay payment callback ». C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SubscriptionsController.handleFlexPayCallback` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-subscriptions-my-subscription"></a>
### GET `/api/v1/subscriptions/my-subscription`

Swagger résume l’opération ainsi : « Get current active subscription ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getActiveSubscription` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-subscriptions-my-subscriptions"></a>
### GET `/api/v1/subscriptions/my-subscriptions`

Swagger résume l’opération ainsi : « Get all subscriptions of the current user ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getUserSubscriptions` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-subscriptions-payments-ordernumber-status"></a>
### GET `/api/v1/subscriptions/payments/:orderNumber/status`

Swagger résume l’opération ainsi : « Check FlexPay payment status and activate if paid ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.checkPaymentStatus` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="get-api-v1-subscriptions-plans"></a>
### GET `/api/v1/subscriptions/plans`

Swagger résume l’opération ainsi : « List premium subscription plans and benefits ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getPlans` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200

<a id="get-api-v1-subscriptions-premium-overview"></a>
### GET `/api/v1/subscriptions/premium-overview`

Swagger résume l’opération ainsi : « Get premium subscription benefits for the current driver ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.getPremiumOverview` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-subscriptions-status"></a>
### GET `/api/v1/subscriptions/status`

Swagger résume l’opération ainsi : « Check subscription status ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.checkStatus` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-subscriptions-subscribe"></a>
### POST `/api/v1/subscriptions/subscribe`

Swagger résume l’opération ainsi : « Initiate payment for a premium subscription ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SubscribeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SubscriptionsController.subscribe` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `SubscribeDto`.

- **`plan`** — obligatoire, énumération. exemple `pro`. valeur autorisée : `pro`, `monthly`, `yearly`. Message renvoyé : « Le type d'abonnement sélectionné est invalide » ; valeur autorisée : `pro`. Message renvoyé : « Le seul abonnement disponible est le pack pro » ; ne doit pas être vide. Message renvoyé : « Le type d'abonnement est requis » ; énumération Swagger : `pro`. présent dans le schéma Swagger.
- **`paymentMethod`** — obligatoire, énumération. exemple `mobile_money`. valeur autorisée : `mobile_money`, `card`. Message renvoyé : « La méthode de paiement sélectionnée est invalide » ; ne doit pas être vide. Message renvoyé : « La méthode de paiement est requise » ; énumération Swagger : `mobile_money`, `card`. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro du client pour Mobile Money, commence obligatoirement par +243. exemple `+243891234567`. chaîne de caractères. Message renvoyé : « Le numéro de téléphone doit être une chaîne de caractères » ; au plus 20 caractère(s). Message renvoyé : « Le numéro de téléphone ne peut pas dépasser 20 caractères » ; motif `/^\+243\d{9}$/`. Message renvoyé : « Le numéro de téléphone doit commencer par +243, par exemple +243891234567 ». présent dans le schéma Swagger.
- **`approveUrl`** — facultatif, string. URL de redirection après paiement carte approuvé. exemple `zwanga://subscriptions/payment?status=success`. motif `/^[a-z][a-z0-9+.-]*:\/\//i`. Message renvoyé : « approveUrl doit être une URL valide » ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`cancelUrl`** — facultatif, string. URL de redirection après annulation du paiement carte. exemple `zwanga://subscriptions/payment?status=cancel`. motif `/^[a-z][a-z0-9+.-]*:\/\//i`. Message renvoyé : « cancelUrl doit être une URL valide » ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`declineUrl`** — facultatif, string. URL de redirection après échec du paiement carte. exemple `zwanga://subscriptions/payment?status=decline`. motif `/^[a-z][a-z0-9+.-]*:\/\//i`. Message renvoyé : « declineUrl doit être une URL valide » ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`preferredProvider`** — facultatif, énumération. Prestataire préféré. Si indisponible, le backend bascule vers l’autre canal Mobile Money.. valeur autorisée : `flexpay`, `pawapay` ; énumération Swagger : `flexpay`, `pawapay`. présent dans le schéma Swagger.
- **`pawaPayOperator`** — facultatif, string. Opérateur Mobile Money pawaPay choisi par le client. chaîne de caractères ; au plus 40 caractère(s). présent dans le schéma Swagger.

<a id="post-api-v1-subscriptions-subscribe-points"></a>
### POST `/api/v1/subscriptions/subscribe/points`

Swagger résume l’opération ainsi : « Pay a premium subscription with Zwanga tokens ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SubscribeWithPointsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SubscriptionsController.subscribeWithPoints` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `SubscribeWithPointsDto`.

- **`plan`** — obligatoire, énumération. exemple `pro`. valeur autorisée : `pro`, `monthly`, `yearly`. Message renvoyé : « Le type d'abonnement sélectionné est invalide » ; valeur autorisée : `pro`. Message renvoyé : « Le seul abonnement disponible est le pack pro » ; ne doit pas être vide. Message renvoyé : « Le type d'abonnement est requis » ; énumération Swagger : `pro`. présent dans le schéma Swagger.

<a id="post-api-v1-subscriptions-trial"></a>
### POST `/api/v1/subscriptions/trial`

Swagger résume l’opération ainsi : « Start trial period ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SubscriptionsController.startTrial` dans `src/subscriptions/subscriptions.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

## Referrals

Parrainage : validation d’un code, attribution, liste des filleuls, récompenses, journal et retraits. La validation publique sert avant même l’inscription.

<a id="get-api-v1-referrals-me"></a>
### GET `/api/v1/referrals/me`

Swagger résume l’opération ainsi : « Get referral link, balances and program rules ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.getMySummary` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-referrals-me-attribution"></a>
### POST `/api/v1/referrals/me/attribution`

Swagger résume l’opération ainsi : « Attach the authenticated account to its first referrer when none exists ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AttachReferralAttributionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ReferralsController.attachMyAttribution` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `AttachReferralAttributionDto`.

- **`referralProvider`** — obligatoire, "chottulink". exemple `chottulink`. valeur autorisée : `chottulink` ; énumération Swagger : `chottulink`. présent dans le schéma Swagger.
- **`referralToken`** — obligatoire, string. exemple `a19d93f458a64d75b0e2b0f36073cd51`. chaîne de caractères ; ne doit pas être vide ; au plus 64 caractère(s) ; motif `/^[A-Za-z0-9_-]+$/`. présent dans le schéma Swagger.
- **`referralReferringLink`** — facultatif, string. exemple `https://zwanga-app.chottu.link/abc123`. chaîne de caractères ; au plus 500 caractère(s). présent dans le schéma Swagger.
- **`referralCapturedAt`** — obligatoire, string. exemple `2026-08-27T10:00:00.000Z`. date ISO. présent dans le schéma Swagger.

<a id="get-api-v1-referrals-me-ledger"></a>
### GET `/api/v1/referrals/me/ledger`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.getMyLedger` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-referrals-me-referrals"></a>
### GET `/api/v1/referrals/me/referrals`

Swagger résume l’opération ainsi : « List direct referrals and the earnings generated by each one ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.getMyReferrals` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-referrals-me-referrals-page"></a>
### GET `/api/v1/referrals/me/referrals/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.referralPage` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageQuery` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`search`** — facultatif, string. chaîne de caractères ; au plus 100 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-referrals-me-rewards"></a>
### GET `/api/v1/referrals/me/rewards`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.getMyRewards` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="get-api-v1-referrals-me-rewards-page"></a>
### GET `/api/v1/referrals/me/rewards/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.rewardPage` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageQuery` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`search`** — facultatif, string. chaîne de caractères ; au plus 100 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-referrals-me-withdrawals"></a>
### GET `/api/v1/referrals/me/withdrawals`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.getMyWithdrawals` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="post-api-v1-referrals-me-withdrawals"></a>
### POST `/api/v1/referrals/me/withdrawals`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `RequestReferralWithdrawalDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ReferralsController.requestWithdrawal` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `RequestReferralWithdrawalDto`.

- **`tokens`** — obligatoire, number. exemple `50`. nombre ; minimum 0.01. converti en nombre. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. exemple `+243891234567`. chaîne de caractères ; au plus 20 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-referrals-me-withdrawals-page"></a>
### GET `/api/v1/referrals/me/withdrawals/page`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.withdrawalPage` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `HistoryPageQuery` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`search`** — facultatif, string. chaîne de caractères ; au plus 100 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-referrals-resolve-attribution"></a>
### POST `/api/v1/referrals/resolve-attribution`

Swagger résume l’opération ainsi : « Resolve an automatic ChottuLink referral attribution ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ResolveReferralAttributionDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ReferralsController.resolveAttribution` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `ResolveReferralAttributionDto`.

- **`referralToken`** — obligatoire, string. exemple `a19d93f458a64d75b0e2b0f36073cd51`. chaîne de caractères ; ne doit pas être vide ; au plus 64 caractère(s) ; motif `/^[A-Za-z0-9_-]+$/`. présent dans le schéma Swagger.

<a id="post-api-v1-referrals-validate-code"></a>
### POST `/api/v1/referrals/validate-code`

Swagger résume l’opération ainsi : « Validate a legacy referral code ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ValidateReferralCodeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ReferralsController.validateCode` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `ValidateReferralCodeDto`.

- **`code`** — obligatoire, string. exemple `ZW7K9M2P4Q`. chaîne de caractères ; ne doit pas être vide ; au plus 16 caractère(s) ; motif `/^[A-Za-z0-9]+$/`. présent dans le schéma Swagger.

<a id="get-api-v1-referrals-withdrawals-ordernumber-status"></a>
### GET `/api/v1/referrals/withdrawals/:orderNumber/status`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ReferralsController.checkWithdrawalStatus` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `orderNumber`

<a id="post-api-v1-referrals-withdrawals-flexpay-callback"></a>
### POST `/api/v1/referrals/withdrawals/flexpay/callback`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. C’est un point d’entrée de prestataire ou de service externe. Il est public parce que l’appelant ne présente pas le JWT d’un utilisateur Zwanga. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `FlexPayCallbackDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ReferralsController.handleWithdrawalCallback` dans `src/referrals/referrals.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `FlexPayCallbackDto`.

- **`status`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`created_at`** — facultatif, string. exemple `20/03/2024 17:30:45`. chaîne de caractères. présent dans le schéma Swagger.
- **`code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`Code`** — facultatif, string. exemple `0`. chaîne de caractères. présent dans le schéma Swagger.
- **`message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`Message`** — facultatif, string. exemple `Transaction traitee`. chaîne de caractères. présent dans le schéma Swagger.
- **`reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`Reference`** — facultatif, string. exemple `SUB-1700000000000-ABCD1234`. chaîne de caractères. présent dans le schéma Swagger.
- **`provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`Provider_reference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`providerReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`ProviderReference`** — facultatif, string. Référence de la transaction chez l’opérateur. exemple `7KI81020PHS`. chaîne de caractères. présent dans le schéma Swagger.
- **`orderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`OrderNumber`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.
- **`order_number`** — facultatif, string. Numéro de commande généré par FlexPay. exemple `9bsTX7qXdpQe243815877848`. chaîne de caractères. présent dans le schéma Swagger.

## Notifications

Centre de notifications du compte connecté : liste, lecture, non-lecture, désactivation et réactivation.

<a id="get-api-v1-notifications"></a>
### GET `/api/v1/notifications`

Swagger résume l’opération ainsi : « Récupérer toutes les notifications de l'utilisateur ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `NotificationsController.findAll` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

- `limit` — facultatif. Type `number`.
- `offset` — facultatif. Type `number`.
- `scope` — facultatif. Type `string`.

**Réponses déclarées dans Swagger**

- **200** — Liste des notifications

<a id="put-api-v1-notifications-disable"></a>
### PUT `/api/v1/notifications/disable`

Swagger résume l’opération ainsi : « Désactiver des notifications (les retirer de la liste affichée) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `MarkNotificationsAsReadDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `NotificationsController.disableNotifications` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `MarkNotificationsAsReadDto`.

- **`notificationIds`** — obligatoire, tableau. IDs des notifications à marquer comme lues. tableau ; au moins 1 élément(s). Message renvoyé : « Au moins une notification doit être sélectionnée » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de notification doit être un UUID valide ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Notifications désactivées avec succès

<a id="put-api-v1-notifications-enable"></a>
### PUT `/api/v1/notifications/enable`

Swagger résume l’opération ainsi : « Réactiver des notifications (les remettre dans la liste affichée) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `MarkNotificationsAsReadDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `NotificationsController.enableNotifications` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `MarkNotificationsAsReadDto`.

- **`notificationIds`** — obligatoire, tableau. IDs des notifications à marquer comme lues. tableau ; au moins 1 élément(s). Message renvoyé : « Au moins une notification doit être sélectionnée » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de notification doit être un UUID valide ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Notifications réactivées avec succès

<a id="put-api-v1-notifications-mark-all-as-read"></a>
### PUT `/api/v1/notifications/mark-all-as-read`

Swagger résume l’opération ainsi : « Marquer toutes les notifications comme lues ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `NotificationsController.markAllAsRead` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Toutes les notifications marquées comme lues

<a id="put-api-v1-notifications-mark-as-read"></a>
### PUT `/api/v1/notifications/mark-as-read`

Swagger résume l’opération ainsi : « Marquer des notifications comme lues ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `MarkNotificationsAsReadDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `NotificationsController.markAsRead` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `MarkNotificationsAsReadDto`.

- **`notificationIds`** — obligatoire, tableau. IDs des notifications à marquer comme lues. tableau ; au moins 1 élément(s). Message renvoyé : « Au moins une notification doit être sélectionnée » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de notification doit être un UUID valide ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Notifications marquées comme lues

<a id="put-api-v1-notifications-mark-as-unread"></a>
### PUT `/api/v1/notifications/mark-as-unread`

Swagger résume l’opération ainsi : « Marquer des notifications comme non lues ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `MarkNotificationsAsReadDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `NotificationsController.markAsUnread` dans `src/notifications/notifications.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `MarkNotificationsAsReadDto`.

- **`notificationIds`** — obligatoire, tableau. IDs des notifications à marquer comme lues. tableau ; au moins 1 élément(s). Message renvoyé : « Au moins une notification doit être sélectionnée » ; chaque élément est un UUID. Message renvoyé : « Chaque ID de notification doit être un UUID valide ». présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Notifications marquées comme non lues

## Chat

Ancien fil de discussion attaché à une réservation : lecture des messages et accusé de lecture. La messagerie temps réel est le namespace Socket.IO `/chat`, absent de Swagger.

<a id="get-api-v1-chat-booking-bookingid-messages"></a>
### GET `/api/v1/chat/booking/:bookingId/messages`

Swagger résume l’opération ainsi : « Get messages for a booking ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ChatController.getMessages` dans `src/chat/chat.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `bookingId`

**Paramètres de requête**

Objet `LegacyPageQuery` :

- **`page`** — facultatif, number. entier ; minimum 1 ; maximum 10000. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="put-api-v1-chat-messages-messageid-read"></a>
### PUT `/api/v1/chat/messages/:messageId/read`

Swagger résume l’opération ainsi : « Mark a message as read ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ChatController.markAsRead` dans `src/chat/chat.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `messageId`

## Conversations

Conversations directes ou de groupe : création, participants, messages, pagination, lecture et suppression.

<a id="get-api-v1-conversations"></a>
### GET `/api/v1/conversations`

Swagger résume l’opération ainsi : « Lister les conversations ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.list` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListConversationsQueryDto` :

- **`page`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. présent dans le schéma Swagger.


<a id="post-api-v1-conversations"></a>
### POST `/api/v1/conversations`

Swagger résume l’opération ainsi : « Créer une conversation ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateConversationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ConversationsController.create` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateConversationDto`.

- **`participantIds`** — obligatoire, tableau. Liste des participants (IDs utilisateurs). tableau ; au moins 1 élément(s) ; au plus 50 élément(s) ; chaque élément est un UUID version 4. présent dans le schéma Swagger.
- **`title`** — facultatif, string. Titre de la conversation. chaîne de caractères ; au plus 200 caractère(s). présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. Associer à une réservation existante. UUID. présent dans le schéma Swagger.
- **`initialMessage`** — facultatif, string. Premier message à envoyer. chaîne de caractères ; au plus 4000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-conversations-id"></a>
### GET `/api/v1/conversations/:id`

Swagger résume l’opération ainsi : « Récupérer une conversation ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.getConversation` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="delete-api-v1-conversations-id"></a>
### DELETE `/api/v1/conversations/:id`

Swagger résume l’opération ainsi : « Supprimer une conversation ». Supprime la conversation pour l’utilisateur courant. Si aucun participant ne reste, la conversation et ses messages sont supprimés. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.deleteConversation` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-conversations-id-messages"></a>
### GET `/api/v1/conversations/:id/messages`

Swagger résume l’opération ainsi : « Liste des messages d’une conversation ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.getMessages` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Paramètres de requête**

Objet `LegacyPageQuery` :

- **`page`** — facultatif, number. entier ; minimum 1 ; maximum 10000. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-conversations-id-messages"></a>
### POST `/api/v1/conversations/:id/messages`

Swagger résume l’opération ainsi : « Envoyer un message dans une conversation ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SendMessageDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ConversationsController.sendMessage` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `SendMessageDto`.

- **`content`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide ; au plus 4000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-conversations-id-messages-page"></a>
### GET `/api/v1/conversations/:id/messages/page`

Swagger résume l’opération ainsi : « Messages paginés, du plus récent au plus ancien ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.getMessagePage` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Paramètres de requête**

Objet `MessagePageDto` :

- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`before`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`after`** — facultatif, string. chaîne de caractères ; au plus 256 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-conversations-id-participants"></a>
### POST `/api/v1/conversations/:id/participants`

Swagger résume l’opération ainsi : « Ajouter des participants ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AddParticipantsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ConversationsController.addParticipants` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AddParticipantsDto`.

- **`userIds`** — obligatoire, tableau. tableau ; au moins 1 élément(s) ; au plus 50 élément(s) ; chaque élément est un UUID version 4. présent dans le schéma Swagger.

<a id="delete-api-v1-conversations-id-participants-userid"></a>
### DELETE `/api/v1/conversations/:id/participants/:userId`

Swagger résume l’opération ainsi : « Retirer un participant ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.removeParticipant` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`
- `userId`

<a id="post-api-v1-conversations-id-read"></a>
### POST `/api/v1/conversations/:id/read`

Swagger résume l’opération ainsi : « Marquer la conversation comme lue ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.markRead` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-conversations-direct"></a>
### POST `/api/v1/conversations/direct`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `ResolveDirectConversationDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ConversationsController.direct` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `ResolveDirectConversationDto`.

- **`userId`** — obligatoire, string. UUID version 4. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="patch-api-v1-conversations-messages-messageid"></a>
### PATCH `/api/v1/conversations/messages/:messageId`

Swagger résume l’opération ainsi : « Modifier un message envoyé ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SendMessageDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `ConversationsController.editMessage` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `messageId`

**Corps**

Classe `SendMessageDto`.

- **`content`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide ; au plus 4000 caractère(s). présent dans le schéma Swagger.

<a id="delete-api-v1-conversations-messages-messageid"></a>
### DELETE `/api/v1/conversations/messages/:messageId`

Swagger résume l’opération ainsi : « Supprimer un message envoyé ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ConversationsController.deleteMessage` dans `src/chat/conversations.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `messageId`

## Chatbot

Assistant conversationnel. L’envoi anonyme est public ; la variante authentifiée relie l’échange au compte. Une conversation peut être effacée.

<a id="post-api-v1-chatbot-chat"></a>
### POST `/api/v1/chatbot/chat`

Swagger résume l’opération ainsi : « Envoyer un message au chatbot ». Permet d'interagir avec le chatbot intelligent basé sur LangChain et Ollama La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ChatbotMessageDto`. Swagger ne publie que les champs marqués `@ApiProperty` (2 sur 3).

- **Contrôleur :** `ChatbotController.chat` dans `src/chatbot/chatbot.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `ChatbotMessageDto`.

- **`message`** — obligatoire, string. Message de l'utilisateur au chatbot. exemple `Comment réserver un trajet ?`. chaîne de caractères ; ne doit pas être vide ; au plus 1000 caractère(s). Message renvoyé : « Le message ne peut pas dépasser 1000 caractères ». présent dans le schéma Swagger.
- **`conversationId`** — facultatif, string. ID de la conversation pour maintenir le contexte. exemple `conversation-id-123`. chaîne de caractères ; au plus 80 caractère(s). présent dans le schéma Swagger.
- **`conversationToken`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

**Réponses déclarées dans Swagger**

- **200** — objet `ChatbotResponseDto` — Réponse du chatbot
  - **`conversationToken`** — facultatif, string. Preuve de session anonyme à renvoyer avec conversationId. présent dans le schéma Swagger.
  - **`response`** — obligatoire, string. exemple `Pour réserver un trajet, vous devez...`. présent dans le schéma Swagger.
  - **`conversationId`** — obligatoire, string. exemple `conversation-id-123`. présent dans le schéma Swagger.
  - **`relatedFaqs`** — facultatif, tableau. exemple `faq-1`, `faq-2`. présent dans le schéma Swagger.
- **400** — Erreur de validation ou service indisponible

<a id="post-api-v1-chatbot-chat-authenticated"></a>
### POST `/api/v1/chatbot/chat/authenticated`

Swagger résume l’opération ainsi : « Envoyer un message au chatbot (utilisateur authentifié) ». Version authentifiée du chatbot avec historique de conversation La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `ChatbotMessageDto`. Swagger ne publie que les champs marqués `@ApiProperty` (2 sur 3).

- **Contrôleur :** `ChatbotController.chatAuthenticated` dans `src/chatbot/chatbot.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `ChatbotMessageDto`.

- **`message`** — obligatoire, string. Message de l'utilisateur au chatbot. exemple `Comment réserver un trajet ?`. chaîne de caractères ; ne doit pas être vide ; au plus 1000 caractère(s). Message renvoyé : « Le message ne peut pas dépasser 1000 caractères ». présent dans le schéma Swagger.
- **`conversationId`** — facultatif, string. ID de la conversation pour maintenir le contexte. exemple `conversation-id-123`. chaîne de caractères ; au plus 80 caractère(s). présent dans le schéma Swagger.
- **`conversationToken`** — facultatif, string. chaîne de caractères ; au plus 1024 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

**Réponses déclarées dans Swagger**

- **200** — objet `ChatbotResponseDto` — Réponse du chatbot
  - **`conversationToken`** — facultatif, string. Preuve de session anonyme à renvoyer avec conversationId. présent dans le schéma Swagger.
  - **`response`** — obligatoire, string. exemple `Pour réserver un trajet, vous devez...`. présent dans le schéma Swagger.
  - **`conversationId`** — obligatoire, string. exemple `conversation-id-123`. présent dans le schéma Swagger.
  - **`relatedFaqs`** — facultatif, tableau. exemple `faq-1`, `faq-2`. présent dans le schéma Swagger.

<a id="delete-api-v1-chatbot-conversation-conversationid"></a>
### DELETE `/api/v1/chatbot/conversation/:conversationId`

Swagger résume l’opération ainsi : « Supprimer l'historique d'une conversation ». Nettoie l'historique de conversation pour libérer la mémoire La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `ChatbotController.clearConversation` dans `src/chatbot/chatbot.controller.ts`
- **Succès par défaut :** 204 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `conversationId`

**Réponses déclarées dans Swagger**

- **204** — Historique supprimé avec succès

## Support

Aide : FAQ publique, configuration du support, conversations et tickets. La file d’administration permet d’assigner un ticket et d’en changer le statut.

<a id="get-api-v1-support-admin-tickets"></a>
### GET `/api/v1/support/admin/tickets`

Swagger résume l’opération ainsi : « Lister tous les tickets (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.listAdminTickets` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListAdminSupportTicketsQueryDto` :

- **`page`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `open`, `in_progress`, `waiting_user`, `resolved`, `closed` ; énumération Swagger : `open`, `in_progress`, `waiting_user`, `resolved`, `closed`. présent dans le schéma Swagger.
- **`priority`** — facultatif, énumération. valeur autorisée : `low`, `medium`, `high`, `urgent` ; énumération Swagger : `low`, `medium`, `high`, `urgent`. présent dans le schéma Swagger.
- **`category`** — facultatif, énumération. valeur autorisée : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other` ; énumération Swagger : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other`. présent dans le schéma Swagger.
- **`search`** — facultatif, string. Recherche sur le sujet. chaîne de caractères. présent dans le schéma Swagger.
- **`userId`** — facultatif, string. Filtrer par utilisateur. UUID. présent dans le schéma Swagger.
- **`assignedAdminId`** — facultatif, string. Filtrer par admin assigné. UUID. présent dans le schéma Swagger.
- **`unassignedOnly`** — facultatif, boolean. Limiter aux tickets non assignés. booléen. présent dans le schéma Swagger.


<a id="get-api-v1-support-admin-tickets-id"></a>
### GET `/api/v1/support/admin/tickets/:id`

Swagger résume l’opération ainsi : « Récupérer un ticket (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getAdminTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="patch-api-v1-support-admin-tickets-id-assign"></a>
### PATCH `/api/v1/support/admin/tickets/:id/assign`

Swagger résume l’opération ainsi : « Assigner un ticket a un admin ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AssignSupportTicketDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.assignTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AssignSupportTicketDto`.

- **`adminId`** — facultatif, string. ID de l’admin à assigner. Si absent, assigne le ticket à l’admin courant.. UUID. présent dans le schéma Swagger.

<a id="post-api-v1-support-admin-tickets-id-messages"></a>
### POST `/api/v1/support/admin/tickets/:id/messages`

Swagger résume l’opération ainsi : « Ajouter un message ticket (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AddSupportTicketMessageDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.addAdminTicketMessage` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AddSupportTicketMessageDto`.

- **`content`** — obligatoire, string. Contenu du message. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`isInternal`** — facultatif, boolean. Message interne (visible uniquement par les admins). booléen. présent dans le schéma Swagger.

<a id="patch-api-v1-support-admin-tickets-id-status"></a>
### PATCH `/api/v1/support/admin/tickets/:id/status`

Swagger résume l’opération ainsi : « Mettre à jour le statut d’un ticket (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateSupportTicketStatusDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.updateTicketStatus` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateSupportTicketStatusDto`.

- **`status`** — obligatoire, énumération. valeur autorisée : `open`, `in_progress`, `waiting_user`, `resolved`, `closed` ; énumération Swagger : `open`, `in_progress`, `waiting_user`, `resolved`, `closed`. présent dans le schéma Swagger.
- **`resolutionSummary`** — facultatif, string. Résumé de résolution (utile quand statut resolved/closed). chaîne de caractères. présent dans le schéma Swagger.
- **`internalNote`** — facultatif, string. Note interne admin ajoutée lors du changement de statut. chaîne de caractères. présent dans le schéma Swagger.

<a id="get-api-v1-support-config"></a>
### GET `/api/v1/support/config`

Swagger résume l’opération ainsi : « Récupérer la configuration publique du support center ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getSupportConfig` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200

<a id="get-api-v1-support-conversations"></a>
### GET `/api/v1/support/conversations`

Swagger résume l’opération ainsi : « Lister les conversations de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.listConversations` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListConversationsQueryDto` :

- **`page`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 50. converti en nombre. présent dans le schéma Swagger.


<a id="post-api-v1-support-conversations"></a>
### POST `/api/v1/support/conversations`

Swagger résume l’opération ainsi : « Créer une conversation avec le support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateSupportConversationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.createConversation` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateSupportConversationDto`.

- **`subject`** — facultatif, string. Sujet de la demande. chaîne de caractères ; au plus 200 caractère(s). présent dans le schéma Swagger.
- **`message`** — obligatoire, string. Message à envoyer au support. chaîne de caractères ; ne doit pas être vide ; au plus 4000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-support-conversations-id"></a>
### GET `/api/v1/support/conversations/:id`

Swagger résume l’opération ainsi : « Obtenir une conversation de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getConversation` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-support-conversations-id-messages"></a>
### GET `/api/v1/support/conversations/:id/messages`

Swagger résume l’opération ainsi : « Lister les messages d’une conversation de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getMessages` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Paramètres de requête**

Objet `LegacyPageQuery` :

- **`page`** — facultatif, number. entier ; minimum 1 ; maximum 10000. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`limit`** — facultatif, number. entier ; minimum 1 ; maximum 100. converti en nombre. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="post-api-v1-support-conversations-id-messages"></a>
### POST `/api/v1/support/conversations/:id/messages`

Swagger résume l’opération ainsi : « Envoyer un message au support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `SendMessageDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.sendMessage` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `SendMessageDto`.

- **`content`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide ; au plus 4000 caractère(s). présent dans le schéma Swagger.

<a id="get-api-v1-support-faq"></a>
### GET `/api/v1/support/faq`

Swagger résume l’opération ainsi : « Lister les FAQ depuis le support center ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.listFaq` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `ListFaqQueryDto` :

- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`search`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`page`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.


<a id="post-api-v1-support-faq"></a>
### POST `/api/v1/support/faq`

Swagger résume l’opération ainsi : « Créer une entrée FAQ (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateFaqEntryDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.createFaq` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateFaqEntryDto`.

- **`question`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`answer`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`keywords`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`isPublished`** — facultatif, boolean. booléen. présent dans le schéma Swagger.
- **`order`** — facultatif, number. entier. présent dans le schéma Swagger.

<a id="get-api-v1-support-faq-id"></a>
### GET `/api/v1/support/faq/:id`

Swagger résume l’opération ainsi : « Récupérer une FAQ depuis le support center ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getFaq` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200

**Paramètres de chemin**

- `id`

<a id="put-api-v1-support-faq-id"></a>
### PUT `/api/v1/support/faq/:id`

Swagger résume l’opération ainsi : « Mettre à jour une entrée FAQ (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `UpdateFaqEntryDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.updateFaq` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateFaqEntryDto`.

- **`question`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`answer`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`keywords`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`isPublished`** — facultatif, boolean. booléen. présent dans le schéma Swagger.
- **`order`** — facultatif, number. entier. présent dans le schéma Swagger.

<a id="delete-api-v1-support-faq-id"></a>
### DELETE `/api/v1/support/faq/:id`

Swagger résume l’opération ainsi : « Supprimer une entrée FAQ (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.removeFaq` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="get-api-v1-support-tickets"></a>
### GET `/api/v1/support/tickets`

Swagger résume l’opération ainsi : « Lister mes tickets de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.listMyTickets` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListSupportTicketsQueryDto` :

- **`page`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `open`, `in_progress`, `waiting_user`, `resolved`, `closed` ; énumération Swagger : `open`, `in_progress`, `waiting_user`, `resolved`, `closed`. présent dans le schéma Swagger.
- **`priority`** — facultatif, énumération. valeur autorisée : `low`, `medium`, `high`, `urgent` ; énumération Swagger : `low`, `medium`, `high`, `urgent`. présent dans le schéma Swagger.
- **`category`** — facultatif, énumération. valeur autorisée : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other` ; énumération Swagger : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other`. présent dans le schéma Swagger.
- **`search`** — facultatif, string. Recherche sur le sujet. chaîne de caractères. présent dans le schéma Swagger.


<a id="post-api-v1-support-tickets"></a>
### POST `/api/v1/support/tickets`

Swagger résume l’opération ainsi : « Créer un ticket de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `CreateSupportTicketDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.createTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateSupportTicketDto`.

- **`subject`** — obligatoire, string. Sujet du ticket. exemple `Problème de paiement`. chaîne de caractères ; ne doit pas être vide ; au plus 120 caractère(s). présent dans le schéma Swagger.
- **`message`** — obligatoire, string. Message initial du ticket. exemple `Le paiement est débité mais la réservation reste en attente.`. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`category`** — facultatif, énumération. valeur autorisée : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other` ; énumération Swagger : `general`, `account`, `payment`, `booking`, `safety`, `technical`, `other`. présent dans le schéma Swagger.
- **`priority`** — facultatif, énumération. valeur autorisée : `low`, `medium`, `high`, `urgent` ; énumération Swagger : `low`, `medium`, `high`, `urgent`. présent dans le schéma Swagger.

<a id="get-api-v1-support-tickets-id"></a>
### GET `/api/v1/support/tickets/:id`

Swagger résume l’opération ainsi : « Récupérer un ticket de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.getMyTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="patch-api-v1-support-tickets-id-close"></a>
### PATCH `/api/v1/support/tickets/:id/close`

Swagger résume l’opération ainsi : « Fermer mon ticket de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.closeMyTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

<a id="post-api-v1-support-tickets-id-messages"></a>
### POST `/api/v1/support/tickets/:id/messages`

Swagger résume l’opération ainsi : « Ajouter un message a mon ticket ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `AddSupportTicketMessageDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SupportController.addMyTicketMessage` dans `src/support/support.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `AddSupportTicketMessageDto`.

- **`content`** — obligatoire, string. Contenu du message. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`isInternal`** — facultatif, boolean. Message interne (visible uniquement par les admins). booléen. présent dans le schéma Swagger.

<a id="patch-api-v1-support-tickets-id-reopen"></a>
### PATCH `/api/v1/support/tickets/:id/reopen`

Swagger résume l’opération ainsi : « Rouvrir mon ticket de support ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `SupportController.reopenMyTicket` dans `src/support/support.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

## FAQ

Foire aux questions gérée à part du module Support. La lecture exige un JWT. La création, la modification et la suppression sont réservées à `admin`.

<a id="get-api-v1-faq"></a>
### GET `/api/v1/faq`

Swagger résume l’opération ainsi : « Liste des questions fréquentes ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FaqController.findAll` dans `src/faq/faq.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de requête**

Objet `ListFaqQueryDto` :

- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`search`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`page`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.


<a id="post-api-v1-faq"></a>
### POST `/api/v1/faq`

Swagger résume l’opération ainsi : « Créer une entrée FAQ ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le corps suit `CreateFaqEntryDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `FaqController.create` dans `src/faq/faq.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateFaqEntryDto`.

- **`question`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`answer`** — obligatoire, string. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`keywords`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`isPublished`** — facultatif, boolean. booléen. présent dans le schéma Swagger.
- **`order`** — facultatif, number. entier. présent dans le schéma Swagger.

<a id="get-api-v1-faq-id"></a>
### GET `/api/v1/faq/:id`

Swagger résume l’opération ainsi : « Récupérer une FAQ ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `FaqController.findOne` dans `src/faq/faq.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `id`

<a id="put-api-v1-faq-id"></a>
### PUT `/api/v1/faq/:id`

Swagger résume l’opération ainsi : « Mettre à jour une entrée FAQ ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le corps suit `UpdateFaqEntryDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `FaqController.update` dans `src/faq/faq.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateFaqEntryDto`.

- **`question`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`answer`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`category`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`locale`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`audience`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`keywords`** — facultatif, string. chaîne de caractères. présent dans le schéma Swagger.
- **`isPublished`** — facultatif, boolean. booléen. présent dans le schéma Swagger.
- **`order`** — facultatif, number. entier. présent dans le schéma Swagger.

<a id="delete-api-v1-faq-id"></a>
### DELETE `/api/v1/faq/:id`

Swagger résume l’opération ainsi : « Supprimer une entrée FAQ ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403.

- **Contrôleur :** `FaqController.remove` dans `src/faq/faq.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

## Safety

Contacts d’urgence, alertes, position pendant une alerte et signalements d’utilisateurs. La file globale des signalements et le changement de statut sont réservés à `admin`.

<a id="get-api-v1-safety-admin-reports"></a>
### GET `/api/v1/safety/admin/reports`

Swagger résume l’opération ainsi : « Lister tous les signalements de la plateforme (Admin) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403.

- **Contrôleur :** `SafetyController.listAdminUserReports` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListAdminUserReportsQueryDto` :

- **`page`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. nombre ; minimum 1. converti en nombre. présent dans le schéma Swagger.
- **`status`** — facultatif, énumération. valeur autorisée : `pending`, `under_review`, `resolved`, `dismissed` ; énumération Swagger : `pending`, `under_review`, `resolved`, `dismissed`. présent dans le schéma Swagger.
- **`reason`** — facultatif, énumération. valeur autorisée : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other` ; énumération Swagger : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other`. présent dans le schéma Swagger.
- **`search`** — facultatif, string. Recherche sur le nom ou le telephone des personnes concernees. chaîne de caractères. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — Liste paginée des signalements

<a id="get-api-v1-safety-alerts"></a>
### GET `/api/v1/safety/alerts`

Swagger résume l’opération ainsi : « Récupérer toutes les alertes de sécurité ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.findAllSafetyAlerts` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Liste des alertes de sécurité

<a id="post-api-v1-safety-alerts"></a>
### POST `/api/v1/safety/alerts`

Swagger résume l’opération ainsi : « Créer une alerte de sécurité ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `CreateSafetyAlertDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.createSafetyAlert` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateSafetyAlertDto`.

- **`type`** — obligatoire, énumération. Type d'alerte. valeur autorisée : `phone_shutdown`, `low_battery`, `manual_alert`, `no_response`, `emergency` ; énumération Swagger : `phone_shutdown`, `low_battery`, `manual_alert`, `no_response`, `emergency`. présent dans le schéma Swagger.
- **`message`** — facultatif, string. Message optionnel. chaîne de caractères. présent dans le schéma Swagger.
- **`latitude`** — facultatif, number. Latitude GPS. latitude. présent dans le schéma Swagger.
- **`longitude`** — facultatif, number. Longitude GPS. longitude. présent dans le schéma Swagger.
- **`batteryLevel`** — facultatif, number. Niveau de batterie (%). nombre ; minimum 0 ; maximum 100. présent dans le schéma Swagger.
- **`tripId`** — facultatif, string. ID du trip associé. UUID. présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. ID du booking associé. UUID. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **201** — Alerte de sécurité créée

<a id="get-api-v1-safety-alerts-id"></a>
### GET `/api/v1/safety/alerts/:id`

Swagger résume l’opération ainsi : « Récupérer une alerte de sécurité spécifique ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.findOneSafetyAlert` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **200** — Détails de l'alerte

<a id="put-api-v1-safety-alerts-id-status"></a>
### PUT `/api/v1/safety/alerts/:id/status`

Swagger résume l’opération ainsi : « Mettre à jour le statut d'une alerte de sécurité ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `UpdateSafetyAlertStatusDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.updateSafetyAlertStatus` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateSafetyAlertStatusDto`.

- **`status`** — obligatoire, énumération. Nouveau statut de l'alerte. valeur autorisée : `resolved`, `false_alarm` ; énumération Swagger : `resolved`, `false_alarm`. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Statut de l'alerte mis à jour

<a id="get-api-v1-safety-emergency-contacts"></a>
### GET `/api/v1/safety/emergency-contacts`

Swagger résume l’opération ainsi : « Récupérer tous les contacts d'urgence de l'utilisateur ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.findAllEmergencyContacts` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Liste des contacts d'urgence

<a id="post-api-v1-safety-emergency-contacts"></a>
### POST `/api/v1/safety/emergency-contacts`

Swagger résume l’opération ainsi : « Créer un contact d'urgence ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `CreateEmergencyContactDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.createEmergencyContact` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateEmergencyContactDto`.

- **`name`** — obligatoire, string. Nom du contact d'urgence. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`phone`** — obligatoire, string. Numéro de téléphone du contact. chaîne de caractères ; ne doit pas être vide ; motif `/^\+?[1-9]\d{1,14}$/`. Message renvoyé : « Le numéro de téléphone doit être au format international valide ». présent dans le schéma Swagger.
- **`email`** — facultatif, string. Email du contact. adresse e-mail. présent dans le schéma Swagger.
- **`relationship`** — facultatif, string. Relation avec le contact (famille, ami, etc.). chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **201** — Contact d'urgence créé avec succès

<a id="put-api-v1-safety-emergency-contacts-id"></a>
### PUT `/api/v1/safety/emergency-contacts/:id`

Swagger résume l’opération ainsi : « Mettre à jour un contact d'urgence ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `UpdateEmergencyContactDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.updateEmergencyContact` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateEmergencyContactDto`.

- **`name`** — facultatif, string. Nom du contact d'urgence. chaîne de caractères. présent dans le schéma Swagger.
- **`phone`** — facultatif, string. Numéro de téléphone du contact. chaîne de caractères ; motif `/^\+?[1-9]\d{1,14}$/`. Message renvoyé : « Le numéro de téléphone doit être au format international valide ». présent dans le schéma Swagger.
- **`email`** — facultatif, string. Email du contact. adresse e-mail. présent dans le schéma Swagger.
- **`relationship`** — facultatif, string. Relation avec le contact. chaîne de caractères. présent dans le schéma Swagger.
- **`isActive`** — facultatif, boolean. Si le contact est actif. booléen. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Contact d'urgence mis à jour

<a id="delete-api-v1-safety-emergency-contacts-id"></a>
### DELETE `/api/v1/safety/emergency-contacts/:id`

Swagger résume l’opération ainsi : « Supprimer un contact d'urgence ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.deleteEmergencyContact` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 204 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **204** — Contact d'urgence supprimé

<a id="post-api-v1-safety-emergency-contacts-batch"></a>
### POST `/api/v1/safety/emergency-contacts/batch`

Swagger résume l’opération ainsi : « Créer plusieurs contacts d'urgence en une seule requête (jusqu'à 5 au total) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `CreateMultipleEmergencyContactsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.createMultipleEmergencyContacts` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateMultipleEmergencyContactsDto`.

- **`contacts`** — obligatoire, tableau de CreateEmergencyContactDto. Liste des contacts d'urgence à créer (maximum 5 au total par utilisateur). exemple `{"name":"Jean Dupont","phone":"+33612345678","relationship":"Famille"}`, `{"name":"Marie Martin","phone":"+33687654321","relationship":"Ami"}`. tableau ; au moins 1 élément(s). Message renvoyé : « Vous devez fournir au moins un contact » ; au plus 5 élément(s). Message renvoyé : « Vous ne pouvez pas ajouter plus de 5 contacts en une seule fois » ; objet imbriqué validé. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. Nom du contact d'urgence. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
  - **`phone`** — obligatoire, string. Numéro de téléphone du contact. chaîne de caractères ; ne doit pas être vide ; motif `/^\+?[1-9]\d{1,14}$/`. Message renvoyé : « Le numéro de téléphone doit être au format international valide ». présent dans le schéma Swagger.
  - **`email`** — facultatif, string. Email du contact. adresse e-mail. présent dans le schéma Swagger.
  - **`relationship`** — facultatif, string. Relation avec le contact (famille, ami, etc.). chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **201** — Contacts d'urgence créés avec succès

<a id="post-api-v1-safety-location-update"></a>
### POST `/api/v1/safety/location/update`

Swagger résume l’opération ainsi : « Mettre à jour la position et l'état du téléphone ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `UpdateLocationDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.updateLocation` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 204 (imposé par `@HttpCode`)
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `UpdateLocationDto`.

- **`latitude`** — obligatoire, number. Latitude GPS. latitude. présent dans le schéma Swagger.
- **`longitude`** — obligatoire, number. Longitude GPS. longitude. présent dans le schéma Swagger.
- **`batteryLevel`** — facultatif, number. Niveau de batterie (%). nombre ; minimum 0 ; maximum 100. présent dans le schéma Swagger.
- **`tripId`** — facultatif, string. ID du trip associé. UUID. présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. ID du booking associé. UUID. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **204** — Position mise à jour

<a id="get-api-v1-safety-reports"></a>
### GET `/api/v1/safety/reports`

Swagger résume l’opération ainsi : « Récupérer tous les signalements de l'utilisateur ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.findAllUserReports` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Réponses déclarées dans Swagger**

- **200** — Liste des signalements

<a id="post-api-v1-safety-reports"></a>
### POST `/api/v1/safety/reports`

Swagger résume l’opération ainsi : « Signaler un utilisateur ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `CreateUserReportDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.createUserReport` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateUserReportDto`.

- **`reportedUserId`** — obligatoire, string. ID de l'utilisateur signalé. UUID ; ne doit pas être vide. présent dans le schéma Swagger.
- **`reason`** — obligatoire, énumération. Raison du signalement. valeur autorisée : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other` ; énumération Swagger : `inappropriate_behavior`, `harassment`, `safety_concern`, `fraud`, `other`. présent dans le schéma Swagger.
- **`description`** — obligatoire, string. Description détaillée du signalement. chaîne de caractères ; ne doit pas être vide. présent dans le schéma Swagger.
- **`tripId`** — facultatif, string. ID du trip associé (si applicable). UUID. présent dans le schéma Swagger.
- **`bookingId`** — facultatif, string. ID du booking associé (si applicable). UUID. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **201** — Signalement créé

<a id="get-api-v1-safety-reports-id"></a>
### GET `/api/v1/safety/reports/:id`

Swagger résume l’opération ainsi : « Récupérer un signalement spécifique ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `SafetyController.findOneUserReport` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Réponses déclarées dans Swagger**

- **200** — Détails du signalement

<a id="put-api-v1-safety-reports-id-status"></a>
### PUT `/api/v1/safety/reports/:id/status`

Swagger résume l’opération ainsi : « Mettre à jour le statut d'un signalement (Admin uniquement) ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le corps suit `UpdateReportStatusDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `SafetyController.updateReportStatus` dans `src/safety/safety.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id`

**Corps**

Classe `UpdateReportStatusDto`.

- **`status`** — obligatoire, énumération. Nouveau statut du signalement. valeur autorisée : `under_review`, `resolved`, `dismissed` ; énumération Swagger : `under_review`, `resolved`, `dismissed`. présent dans le schéma Swagger.
- **`adminNotes`** — facultatif, string. Notes de l'admin. chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — Statut du signalement mis à jour

## Google Maps

Géocodage, recherche de lieux, points d’intérêt et itinéraires. Toutes ces routes sont publiques et servent de proxy vers Google, avec les quotas du serveur.

<a id="post-api-v1-google-maps-directions"></a>
### POST `/api/v1/google-maps/directions`

Swagger résume l’opération ainsi : « Get directions between origin and destination ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `DirectionsDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `GoogleMapsController.getDirections` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `DirectionsDto`.

- **`origin`** — obligatoire, WaypointDto. Origin waypoint. objet imbriqué validé. présent dans le schéma Swagger.
  - **`address`** — facultatif, string. Address or place name. chaîne de caractères. présent dans le schéma Swagger.
  - **`lat`** — facultatif, number. Latitude. latitude. présent dans le schéma Swagger.
  - **`lng`** — facultatif, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string. Place ID. chaîne de caractères. présent dans le schéma Swagger.
- **`destination`** — obligatoire, WaypointDto. Destination waypoint. objet imbriqué validé. présent dans le schéma Swagger.
  - **`address`** — facultatif, string. Address or place name. chaîne de caractères. présent dans le schéma Swagger.
  - **`lat`** — facultatif, number. Latitude. latitude. présent dans le schéma Swagger.
  - **`lng`** — facultatif, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string. Place ID. chaîne de caractères. présent dans le schéma Swagger.
- **`waypoints`** — facultatif, tableau de WaypointDto. Intermediate waypoints. tableau ; objet imbriqué validé. présent dans le schéma Swagger.
  - **`address`** — facultatif, string. Address or place name. chaîne de caractères. présent dans le schéma Swagger.
  - **`lat`** — facultatif, number. Latitude. latitude. présent dans le schéma Swagger.
  - **`lng`** — facultatif, number. Longitude. longitude. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string. Place ID. chaîne de caractères. présent dans le schéma Swagger.
- **`mode`** — facultatif, énumération. valeur autorisée : `driving`, `walking`, `bicycling`, `transit` ; énumération Swagger : `driving`, `walking`, `bicycling`, `transit`. présent dans le schéma Swagger.
- **`avoid`** — facultatif, tableau de énumération. Avoid specific features. tableau ; valeur autorisée : `tolls`, `highways`, `ferries`, `indoor` ; énumération Swagger : `tolls`, `highways`, `ferries`, `indoor`. présent dans le schéma Swagger.
- **`optimizeWaypoints`** — facultatif, boolean. Optimize waypoints order. booléen. présent dans le schéma Swagger.
- **`alternatives`** — facultatif, boolean. Deprecated and ignored: directions always return a single route. booléen. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code. chaîne de caractères. présent dans le schéma Swagger.
- **`region`** — facultatif, string. Region code. chaîne de caractères. présent dans le schéma Swagger.
- **`departureTime`** — facultatif, number. Departure time (Unix timestamp). nombre. présent dans le schéma Swagger.
- **`arrivalTime`** — facultatif, number. Arrival time (Unix timestamp). nombre. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `DirectionsResponse` — Directions retrieved successfully
  - **`routes`** — obligatoire, tableau de Route. présent dans le schéma Swagger.
    - **`summary`** — obligatoire, string. présent dans le schéma Swagger.
    - **`legs`** — obligatoire, tableau de RouteLeg. présent dans le schéma Swagger.
      - **`distance`** — obligatoire, number. présent dans le schéma Swagger.
      - **`duration`** — obligatoire, number. présent dans le schéma Swagger.
      - **`startAddress`** — obligatoire, string. présent dans le schéma Swagger.
      - **`endAddress`** — obligatoire, string. présent dans le schéma Swagger.
      - **`startLocation`** — obligatoire, { lat: number; lng: number; }. présent dans le schéma Swagger.
      - **`endLocation`** — obligatoire, { lat: number; lng: number; }. présent dans le schéma Swagger.
      - **`steps`** — obligatoire, tableau de RouteStep. présent dans le schéma Swagger.
        - **`distance`** — obligatoire, number. présent dans le schéma Swagger.
        - **`duration`** — obligatoire, number. présent dans le schéma Swagger.
        - **`htmlInstructions`** — obligatoire, string. présent dans le schéma Swagger.
        - **`polyline`** — obligatoire, string. présent dans le schéma Swagger.
        - **`startLocation`** — obligatoire, { lat: number; lng: number; }. présent dans le schéma Swagger.
        - **`endLocation`** — obligatoire, { lat: number; lng: number; }. présent dans le schéma Swagger.
    - **`overviewPolyline`** — obligatoire, string. présent dans le schéma Swagger.
    - **`bounds`** — obligatoire, { northeast: { lat: number; lng: number; }; southwest: { lat: number; lng: number; }; }. présent dans le schéma Swagger.
    - **`copyrights`** — obligatoire, string. présent dans le schéma Swagger.
    - **`warnings`** — obligatoire, tableau. présent dans le schéma Swagger.
  - **`status`** — obligatoire, string. présent dans le schéma Swagger.
  - **`errorMessage`** — facultatif, string. présent dans le schéma Swagger.

<a id="post-api-v1-google-maps-geocode"></a>
### POST `/api/v1/google-maps/geocode`

Swagger résume l’opération ainsi : « Geocode an address to coordinates ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le corps suit `GeocodeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `GoogleMapsController.geocode` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `GeocodeDto`.

- **`address`** — obligatoire, string. Address to geocode. chaîne de caractères. présent dans le schéma Swagger.
- **`region`** — facultatif, string. Region code (e.g., "CD" for Congo). chaîne de caractères. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code for returned address text (e.g., "fr"). chaîne de caractères. présent dans le schéma Swagger.
- **`components`** — facultatif, string. Google components filter, e.g. "country:CD|locality:Kinshasa". chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `GeocodeResponse` — Address geocoded successfully
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string. présent dans le schéma Swagger.
  - **`locationType`** — facultatif, string. Google geometry location type, e.g. ROOFTOP or APPROXIMATE. présent dans le schéma Swagger.
  - **`partialMatch`** — facultatif, boolean. Indicates that Google returned a partial match. présent dans le schéma Swagger.
  - **`resultTypes`** — facultatif, tableau. Google result types, e.g. street_address, route, locality. présent dans le schéma Swagger.
  - **`addressComponents`** — facultatif, tableau de GeocodeAddressComponent. présent dans le schéma Swagger.
    - **`longName`** — obligatoire, string. présent dans le schéma Swagger.
    - **`shortName`** — obligatoire, string. présent dans le schéma Swagger.
    - **`types`** — obligatoire, tableau. présent dans le schéma Swagger.
  - **`addressDetails`** — facultatif, StructuredAddressDetails. présent dans le schéma Swagger.
    - **`streetNumber`** — facultatif, string. présent dans le schéma Swagger.
    - **`street`** — facultatif, string. présent dans le schéma Swagger.
    - **`fullStreet`** — facultatif, string. présent dans le schéma Swagger.
    - **`neighborhood`** — facultatif, string. présent dans le schéma Swagger.
    - **`sublocality`** — facultatif, string. présent dans le schéma Swagger.
    - **`commune`** — facultatif, string. présent dans le schéma Swagger.
    - **`city`** — facultatif, string. présent dans le schéma Swagger.
    - **`district`** — facultatif, string. présent dans le schéma Swagger.
    - **`province`** — facultatif, string. présent dans le schéma Swagger.
    - **`country`** — facultatif, string. présent dans le schéma Swagger.
    - **`countryCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`postalCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`premise`** — facultatif, string. présent dans le schéma Swagger.
    - **`subpremise`** — facultatif, string. présent dans le schéma Swagger.
  - **`viewport`** — facultatif, GeocodeBounds. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`bounds`** — facultatif, GeocodeBounds. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`plusCode`** — facultatif, GeocodePlusCode. présent dans le schéma Swagger.
    - **`globalCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`compoundCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`precision`** — facultatif, GeocodePrecision. présent dans le schéma Swagger.
    - **`level`** — obligatoire, énumération. énumération Swagger : `EXACT`, `HIGH`, `MEDIUM`, `LOW`. présent dans le schéma Swagger.
    - **`isExactAddress`** — obligatoire, boolean. présent dans le schéma Swagger.
    - **`isStreetLevel`** — obligatoire, boolean. présent dans le schéma Swagger.
    - **`isApproximate`** — obligatoire, boolean. présent dans le schéma Swagger.

<a id="get-api-v1-google-maps-places-autocomplete"></a>
### GET `/api/v1/google-maps/places/autocomplete`

Swagger résume l’opération ainsi : « Get place autocomplete predictions ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `GoogleMapsController.placesAutocomplete` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `PlacesAutocompleteDto` :

- **`input`** — obligatoire, string. Input text for autocomplete. chaîne de caractères. présent dans le schéma Swagger.
- **`locationLat`** — facultatif, number. Location bias: latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`locationLng`** — facultatif, number. Location bias: longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`radius`** — facultatif, number. Radius in meters for location bias. nombre. converti en nombre. présent dans le schéma Swagger.
- **`region`** — facultatif, string. Region code (e.g., "CD" for Congo). chaîne de caractères. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code (e.g., "fr", "en"). chaîne de caractères. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — tableau `PlacePrediction` — Autocomplete predictions retrieved successfully
  - **`placeId`** — obligatoire, string. présent dans le schéma Swagger.
  - **`description`** — obligatoire, string. présent dans le schéma Swagger.
  - **`mainText`** — facultatif, string. présent dans le schéma Swagger.
  - **`secondaryText`** — facultatif, string. présent dans le schéma Swagger.

<a id="get-api-v1-google-maps-places-details"></a>
### GET `/api/v1/google-maps/places/details`

Swagger résume l’opération ainsi : « Get place details by place ID ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `GoogleMapsController.getPlaceDetails` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `PlaceDetailsDto` :

- **`placeId`** — obligatoire, string. Place ID from Places API. chaîne de caractères. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code. chaîne de caractères. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — objet `PlaceDetails` — Place details retrieved successfully
  - **`placeId`** — obligatoire, string. présent dans le schéma Swagger.
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`name`** — facultatif, string. présent dans le schéma Swagger.
  - **`phoneNumber`** — facultatif, string. présent dans le schéma Swagger.
  - **`website`** — facultatif, string. présent dans le schéma Swagger.
  - **`rating`** — facultatif, number. présent dans le schéma Swagger.
  - **`types`** — facultatif, tableau. présent dans le schéma Swagger.

<a id="get-api-v1-google-maps-places-landmarks"></a>
### GET `/api/v1/google-maps/places/landmarks`

Swagger résume l’opération ainsi : « Get curated landmarks for a city, with Kinshasa enabled by default ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `GoogleMapsController.getLandmarks` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `LandmarkPlacesQueryDto` :

- **`city`** — facultatif, string. City key. For now only kinshasa is supported.. chaîne de caractères. présent dans le schéma Swagger.
- **`search`** — facultatif, string. Free-text filter on name, commune, category, address or keywords. chaîne de caractères. présent dans le schéma Swagger.
- **`commune`** — facultatif, string. Filter by commune. chaîne de caractères. présent dans le schéma Swagger.
- **`category`** — facultatif, string. Filter by category. chaîne de caractères. présent dans le schéma Swagger.
- **`limit`** — facultatif, number. Maximum number of landmarks to return. entier ; minimum 1. converti en nombre. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — tableau `LandmarkPlace` — Landmarks retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`query`** — obligatoire, string. présent dans le schéma Swagger.
  - **`address`** — obligatoire, string. présent dans le schéma Swagger.
  - **`commune`** — obligatoire, string. présent dans le schéma Swagger.
  - **`category`** — obligatoire, string. présent dans le schéma Swagger.
  - **`description`** — facultatif, string. présent dans le schéma Swagger.
  - **`keywords`** — obligatoire, tableau. présent dans le schéma Swagger.

<a id="get-api-v1-google-maps-places-search"></a>
### GET `/api/v1/google-maps/places/search`

Swagger résume l’opération ainsi : « Search for places using text query ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `GoogleMapsController.placesSearch` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `PlacesSearchDto` :

- **`query`** — obligatoire, string. Search query. chaîne de caractères. présent dans le schéma Swagger.
- **`locationLat`** — facultatif, number. Location: latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`locationLng`** — facultatif, number. Location: longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`radius`** — facultatif, number. Radius in meters. nombre. converti en nombre. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code. chaîne de caractères. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — tableau `PlaceDetails` — Places found successfully
  - **`placeId`** — obligatoire, string. présent dans le schéma Swagger.
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`name`** — facultatif, string. présent dans le schéma Swagger.
  - **`phoneNumber`** — facultatif, string. présent dans le schéma Swagger.
  - **`website`** — facultatif, string. présent dans le schéma Swagger.
  - **`rating`** — facultatif, number. présent dans le schéma Swagger.
  - **`types`** — facultatif, tableau. présent dans le schéma Swagger.

<a id="post-api-v1-google-maps-reverse-geocode"></a>
### POST `/api/v1/google-maps/reverse-geocode`

Swagger résume l’opération ainsi : « Reverse geocode coordinates to address ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le corps suit `ReverseGeocodeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `GoogleMapsController.reverseGeocode` dans `src/google-maps/google-maps.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `ReverseGeocodeDto`.

- **`lat`** — obligatoire, number. Latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`lng`** — obligatoire, number. Longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`language`** — facultatif, string. Language code for returned address text (e.g., "fr"). chaîne de caractères. présent dans le schéma Swagger.
- **`region`** — facultatif, string. Region code (e.g., "CD" for Congo). chaîne de caractères. présent dans le schéma Swagger.
- **`resultType`** — facultatif, string. Reverse geocoding result type filter, e.g. "street_address|premise|route". chaîne de caractères. présent dans le schéma Swagger.
- **`locationType`** — facultatif, string. Reverse geocoding location type filter, e.g. "ROOFTOP|RANGE_INTERPOLATED". chaîne de caractères. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — objet `GeocodeResponse` — Coordinates reverse geocoded successfully
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`placeId`** — facultatif, string. présent dans le schéma Swagger.
  - **`locationType`** — facultatif, string. Google geometry location type, e.g. ROOFTOP or APPROXIMATE. présent dans le schéma Swagger.
  - **`partialMatch`** — facultatif, boolean. Indicates that Google returned a partial match. présent dans le schéma Swagger.
  - **`resultTypes`** — facultatif, tableau. Google result types, e.g. street_address, route, locality. présent dans le schéma Swagger.
  - **`addressComponents`** — facultatif, tableau de GeocodeAddressComponent. présent dans le schéma Swagger.
    - **`longName`** — obligatoire, string. présent dans le schéma Swagger.
    - **`shortName`** — obligatoire, string. présent dans le schéma Swagger.
    - **`types`** — obligatoire, tableau. présent dans le schéma Swagger.
  - **`addressDetails`** — facultatif, StructuredAddressDetails. présent dans le schéma Swagger.
    - **`streetNumber`** — facultatif, string. présent dans le schéma Swagger.
    - **`street`** — facultatif, string. présent dans le schéma Swagger.
    - **`fullStreet`** — facultatif, string. présent dans le schéma Swagger.
    - **`neighborhood`** — facultatif, string. présent dans le schéma Swagger.
    - **`sublocality`** — facultatif, string. présent dans le schéma Swagger.
    - **`commune`** — facultatif, string. présent dans le schéma Swagger.
    - **`city`** — facultatif, string. présent dans le schéma Swagger.
    - **`district`** — facultatif, string. présent dans le schéma Swagger.
    - **`province`** — facultatif, string. présent dans le schéma Swagger.
    - **`country`** — facultatif, string. présent dans le schéma Swagger.
    - **`countryCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`postalCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`premise`** — facultatif, string. présent dans le schéma Swagger.
    - **`subpremise`** — facultatif, string. présent dans le schéma Swagger.
  - **`viewport`** — facultatif, GeocodeBounds. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`bounds`** — facultatif, GeocodeBounds. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, GeocodeLatLng. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`plusCode`** — facultatif, GeocodePlusCode. présent dans le schéma Swagger.
    - **`globalCode`** — facultatif, string. présent dans le schéma Swagger.
    - **`compoundCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`precision`** — facultatif, GeocodePrecision. présent dans le schéma Swagger.
    - **`level`** — obligatoire, énumération. énumération Swagger : `EXACT`, `HIGH`, `MEDIUM`, `LOW`. présent dans le schéma Swagger.
    - **`isExactAddress`** — obligatoire, boolean. présent dans le schéma Swagger.
    - **`isStreetLevel`** — obligatoire, boolean. présent dans le schéma Swagger.
    - **`isApproximate`** — obligatoire, boolean. présent dans le schéma Swagger.

## Yandex Maps

Équivalent Yandex du géocodage, de la recherche de lieux et de la suggestion. Toutes ces routes sont publiques.

<a id="post-api-v1-yandex-maps-geocode"></a>
### POST `/api/v1/yandex-maps/geocode`

Swagger résume l’opération ainsi : « Geocode an address using Yandex Geocoder API ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `YandexGeocodeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `YandexMapsController.geocode` dans `src/yandex-maps/yandex-maps.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `YandexGeocodeDto`.

- **`address`** — obligatoire, string. Address or place text to geocode. chaîne de caractères. présent dans le schéma Swagger.
- **`lang`** — facultatif, string. Yandex language code, for example en_US, ru_RU, tr_TR. chaîne de caractères. présent dans le schéma Swagger.
- **`longitude`** — facultatif, number. Longitude for search bias. longitude. converti en nombre. présent dans le schéma Swagger.
- **`latitude`** — facultatif, number. Latitude for search bias. latitude. converti en nombre. présent dans le schéma Swagger.
- **`span`** — facultatif, string. Viewport span as "longitudeDelta,latitudeDelta". chaîne de caractères. présent dans le schéma Swagger.
- **`bbox`** — facultatif, string. Bounding box as "lon1,lat1~lon2,lat2". chaîne de caractères. présent dans le schéma Swagger.
- **`strictBounds`** — facultatif, boolean. Restrict search to the provided ll/spn or bbox area. booléen. présent dans le schéma Swagger.
- **`results`** — facultatif, number. Maximum result count. entier ; minimum 1 ; maximum 50. converti en nombre. présent dans le schéma Swagger.
- **`skip`** — facultatif, number. Number of results to skip. entier ; minimum 0. converti en nombre. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — tableau `YandexGeocodeResult` — Address geocoded successfully
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`name`** — facultatif, string. présent dans le schéma Swagger.
  - **`description`** — facultatif, string. présent dans le schéma Swagger.
  - **`kind`** — facultatif, string. présent dans le schéma Swagger.
  - **`precision`** — facultatif, string. présent dans le schéma Swagger.
  - **`countryCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`postalCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`boundedBy`** — facultatif, YandexBounds. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, YandexPoint. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, YandexPoint. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`rawId`** — facultatif, string. présent dans le schéma Swagger.

<a id="get-api-v1-yandex-maps-geosuggest"></a>
### GET `/api/v1/yandex-maps/geosuggest`

Swagger résume l’opération ainsi : « Get suggestions using Yandex Geosuggest API ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `YandexMapsController.geosuggest` dans `src/yandex-maps/yandex-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `YandexGeosuggestDto` :

- **`text`** — obligatoire, string. Text to suggest locations for. chaîne de caractères. présent dans le schéma Swagger.
- **`lang`** — facultatif, string. Response language code, for example fr, en, ru. chaîne de caractères. présent dans le schéma Swagger.
- **`sessionToken`** — facultatif, string. Unique session token used by Yandex for Geosuggest billing. chaîne de caractères. présent dans le schéma Swagger.
- **`types`** — facultatif, string. Suggestion types supported by Yandex, comma separated. chaîne de caractères. présent dans le schéma Swagger.
- **`latitude`** — facultatif, number. Location bias latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`longitude`** — facultatif, number. Location bias longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`span`** — facultatif, string. Viewport span as "longitudeDelta,latitudeDelta". chaîne de caractères. présent dans le schéma Swagger.
- **`bbox`** — facultatif, string. Bounding box as "lon1,lat1~lon2,lat2". chaîne de caractères. présent dans le schéma Swagger.
- **`strictBounds`** — facultatif, boolean. Strictly limit suggestions to the provided search window. booléen. présent dans le schéma Swagger.
- **`countries`** — facultatif, string. Comma-separated ISO country codes, for example cd,ru,kz. chaîne de caractères. présent dans le schéma Swagger.
- **`printAddress`** — facultatif, boolean. Return post-component address in the suggestion response. booléen. présent dans le schéma Swagger.
- **`attrs`** — facultatif, string. Additional attributes to return, for example uri. chaîne de caractères. présent dans le schéma Swagger.
- **`results`** — facultatif, number. Maximum result count. entier ; minimum 1 ; maximum 10. converti en nombre. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — tableau `YandexSuggestResult` — Suggestions retrieved successfully
  - **`title`** — obligatoire, string. présent dans le schéma Swagger.
  - **`subtitle`** — facultatif, string. présent dans le schéma Swagger.
  - **`uri`** — facultatif, string. présent dans le schéma Swagger.
  - **`formattedAddress`** — facultatif, string. présent dans le schéma Swagger.
  - **`lat`** — facultatif, number. présent dans le schéma Swagger.
  - **`lng`** — facultatif, number. présent dans le schéma Swagger.
  - **`tags`** — facultatif, tableau. présent dans le schéma Swagger.
  - **`distance`** — facultatif, number. présent dans le schéma Swagger.

<a id="get-api-v1-yandex-maps-places-search"></a>
### GET `/api/v1/yandex-maps/places/search`

Swagger résume l’opération ainsi : « Search places using Yandex Places HTTP API ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `YandexMapsController.searchPlaces` dans `src/yandex-maps/yandex-maps.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `YandexPlacesSearchDto` :

- **`text`** — obligatoire, string. Free-text place search query. chaîne de caractères. présent dans le schéma Swagger.
- **`type`** — facultatif, string. Yandex search type, usually biz for organizations or geo. chaîne de caractères. présent dans le schéma Swagger.
- **`lang`** — facultatif, string. Yandex language code, for example en_US, ru_RU, tr_TR. chaîne de caractères. présent dans le schéma Swagger.
- **`latitude`** — facultatif, number. Location bias latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`longitude`** — facultatif, number. Location bias longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`span`** — facultatif, string. Viewport span as "longitudeDelta,latitudeDelta". chaîne de caractères. présent dans le schéma Swagger.
- **`bbox`** — facultatif, string. Bounding box as "lon1,lat1~lon2,lat2". chaîne de caractères. présent dans le schéma Swagger.
- **`strictBounds`** — facultatif, boolean. Restrict search to the provided ll/spn or bbox area. booléen. présent dans le schéma Swagger.
- **`results`** — facultatif, number. Maximum result count. entier ; minimum 1 ; maximum 50. converti en nombre. présent dans le schéma Swagger.
- **`skip`** — facultatif, number. Number of results to skip. entier ; minimum 0. converti en nombre. présent dans le schéma Swagger.


**Réponses déclarées dans Swagger**

- **200** — tableau `YandexPlaceResult` — Places retrieved successfully
  - **`id`** — obligatoire, string. présent dans le schéma Swagger.
  - **`name`** — obligatoire, string. présent dans le schéma Swagger.
  - **`formattedAddress`** — facultatif, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`description`** — facultatif, string. présent dans le schéma Swagger.
  - **`uri`** — facultatif, string. présent dans le schéma Swagger.
  - **`phoneNumber`** — facultatif, string. présent dans le schéma Swagger.
  - **`website`** — facultatif, string. présent dans le schéma Swagger.
  - **`rating`** — facultatif, number. présent dans le schéma Swagger.
  - **`categories`** — facultatif, tableau. présent dans le schéma Swagger.
  - **`source`** — facultatif, string. présent dans le schéma Swagger.

<a id="post-api-v1-yandex-maps-reverse-geocode"></a>
### POST `/api/v1/yandex-maps/reverse-geocode`

Swagger résume l’opération ainsi : « Reverse geocode coordinates using Yandex Geocoder API ». La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps suit `YandexReverseGeocodeDto`, et ses champs sont publiés dans Swagger.

- **Contrôleur :** `YandexMapsController.reverseGeocode` dans `src/yandex-maps/yandex-maps.controller.ts`
- **Succès par défaut :** 200 (imposé par `@HttpCode`)

**Corps**

Classe `YandexReverseGeocodeDto`.

- **`lat`** — obligatoire, number. Latitude. latitude. converti en nombre. présent dans le schéma Swagger.
- **`lng`** — obligatoire, number. Longitude. longitude. converti en nombre. présent dans le schéma Swagger.
- **`kind`** — facultatif, string. Yandex object kind filter, for example house, street, metro, district, locality. chaîne de caractères. présent dans le schéma Swagger.
- **`lang`** — facultatif, string. Yandex language code, for example en_US, ru_RU, tr_TR. chaîne de caractères. présent dans le schéma Swagger.
- **`results`** — facultatif, number. Maximum result count. entier ; minimum 1 ; maximum 50. converti en nombre. présent dans le schéma Swagger.

**Réponses déclarées dans Swagger**

- **200** — tableau `YandexGeocodeResult` — Coordinates reverse geocoded successfully
  - **`formattedAddress`** — obligatoire, string. présent dans le schéma Swagger.
  - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
  - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`name`** — facultatif, string. présent dans le schéma Swagger.
  - **`description`** — facultatif, string. présent dans le schéma Swagger.
  - **`kind`** — facultatif, string. présent dans le schéma Swagger.
  - **`precision`** — facultatif, string. présent dans le schéma Swagger.
  - **`countryCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`postalCode`** — facultatif, string. présent dans le schéma Swagger.
  - **`boundedBy`** — facultatif, YandexBounds. présent dans le schéma Swagger.
    - **`southwest`** — obligatoire, YandexPoint. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
    - **`northeast`** — obligatoire, YandexPoint. présent dans le schéma Swagger.
      - **`lat`** — obligatoire, number. présent dans le schéma Swagger.
      - **`lng`** — obligatoire, number. présent dans le schéma Swagger.
  - **`rawId`** — facultatif, string. présent dans le schéma Swagger.

## Activity

Résumé léger de l’activité du compte connecté, sans historique détaillé et sans trace GPS.

<a id="get-api-v1-me-activity"></a>
### GET `/api/v1/me/activity`

Swagger résume l’opération ainsi : « État léger de l’activité personnelle, sans historique ni données GPS ». La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource.

- **Contrôleur :** `ActivityController.read` dans `src/activity/activity.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer
- **En-têtes de réponse imposés :** `Cache-Control: private, no-store`

## Pro Services

Services professionnels (documents, véhicules, équipement, flotte) : catalogue public, dépôt d’un dossier, suivi par le demandeur, puis devis, statut, finance et garde de documents côté administration. Le contrôleur n’a pas de `@ApiTags`.

Ces opérations ne portent pas `@ApiTags`. Dans l’interface Swagger elles ne rejoignent pas un des groupes nommés dans `DocumentBuilder`.

<a id="get-api-v1-pro-services-admin-cases"></a>
### GET `/api/v1/pro-services/admin/cases`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.list` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListServiceCasesDto` :

- **`status`** — facultatif, énumération. valeur autorisée : `submitted`, `reviewing`, `needs_info`, `quoted`, `accepted`, `processing`, `ready`, `completed`, `rejected`, `cancelled`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`cursor`** — facultatif, string. chaîne de caractères ; au plus 200 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-pro-services-admin-cases-id"></a>
### GET `/api/v1/pro-services/admin/cases/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.adminDetail` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-pro-services-admin-cases-id-documents-documentid"></a>
### POST `/api/v1/pro-services/admin/cases/:id/documents/:documentId`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `CustodyDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.document` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID
- `documentId` — doit être un UUID

**Corps**

Classe `CustodyDto`.

- **`action`** — obligatoire, énumération. valeur autorisée : `receive`, `return`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`receipt`** — obligatoire, string. chaîne de caractères ; au moins 3 caractère(s) ; au plus 300 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`storageLocation`** — facultatif, string. chaîne de caractères ; au plus 160 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-pro-services-admin-cases-id-ledger"></a>
### POST `/api/v1/pro-services/admin/cases/:id/ledger`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `ServiceLedgerDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.ledger` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `ServiceLedgerDto`.

- **`kind`** — obligatoire, énumération. valeur autorisée : `deposit`, `funding`, `repayment`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`amountMinor`** — obligatoire, number. entier ; minimum 1 ; maximum 1000000000. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`reference`** — obligatoire, string. chaîne de caractères ; au moins 6 caractère(s) ; au plus 160 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`evidence`** — obligatoire, string. chaîne de caractères ; au moins 10 caractère(s) ; au plus 2000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-pro-services-admin-cases-id-owner"></a>
### POST `/api/v1/pro-services/admin/cases/:id/owner`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `LinkServiceOwnerDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.owner` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `LinkServiceOwnerDto`.

- **`ownerId`** — obligatoire, string. UUID version 4. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`evidence`** — obligatoire, string. chaîne de caractères ; au moins 10 caractère(s) ; au plus 2000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-pro-services-admin-cases-id-quote"></a>
### POST `/api/v1/pro-services/admin/cases/:id/quote`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `QuoteServiceDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.quote` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `QuoteServiceDto`.

- **`currency`** — obligatoire, énumération. valeur autorisée : `CDF`, `USD`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`totalMinor`** — obligatoire, number. entier ; minimum 1 ; maximum 1000000000. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`depositMinor`** — obligatoire, number. entier ; minimum 0 ; maximum 1000000000. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`providerName`** — obligatoire, string. chaîne de caractères ; au moins 3 caractère(s) ; au plus 200 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`description`** — obligatoire, string. chaîne de caractères ; au moins 10 caractère(s) ; au plus 3000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`validUntil`** — obligatoire, string. date ISO 8601. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`installments`** — obligatoire, tableau de InstallmentDto. tableau ; au plus 52 élément(s) ; objet imbriqué validé. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`dueDate`** — obligatoire, string. date ISO 8601. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`amountMinor`** — obligatoire, number. entier ; minimum 1 ; maximum 1000000000. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`retainedDocuments`** — obligatoire, tableau de RetainedDocumentDto. tableau ; au plus 10 élément(s) ; objet imbriqué validé. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`code`** — obligatoire, string. chaîne de caractères ; au moins 2 caractère(s) ; au plus 60 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`label`** — obligatoire, string. chaîne de caractères ; au moins 2 caractère(s) ; au plus 160 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="put-api-v1-pro-services-admin-cases-id-status"></a>
### PUT `/api/v1/pro-services/admin/cases/:id/status`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `CaseStatusDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.status` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `CaseStatusDto`.

- **`status`** — obligatoire, énumération. valeur autorisée : `submitted`, `reviewing`, `needs_info`, `quoted`, `accepted`, `processing`, `ready`, `completed`, `rejected`, `cancelled`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`message`** — obligatoire, string. chaîne de caractères ; au plus 2000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-pro-services-admin-catalogue"></a>
### GET `/api/v1/pro-services/admin/catalogue`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.adminCatalogue` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

<a id="put-api-v1-pro-services-admin-catalogue-code"></a>
### PUT `/api/v1/pro-services/admin/catalogue/:code`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige exclusivement le rôle `super_admin`. Sinon la réponse est 403. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `OfferingUpdateDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.configure` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `code`

**Corps**

Classe `OfferingUpdateDto`.

- **`availability`** — obligatoire, énumération. valeur autorisée : `open`, `coming_soon`, `paused`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`legalValidated`** — obligatoire, boolean. booléen. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`termsVersion`** — obligatoire, string. chaîne de caractères ; au plus 80 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`termsText`** — obligatoire, string. chaîne de caractères ; au plus 20000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`validationReference`** — obligatoire, string. chaîne de caractères ; au plus 300 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`custodyCodes`** — obligatoire, tableau. tableau ; au plus 20 élément(s) ; valeurs uniques ; chaque élément est une chaîne ; chaque texte fait au plus 60 caractères. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-pro-services-applications"></a>
### POST `/api/v1/pro-services/applications`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `CreateServiceCaseDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.create` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Corps**

Classe `CreateServiceCaseDto`.

- **`contactConsent`** — obligatoire, boolean. valeur autorisée : `true`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`serviceCode`** — obligatoire, énumération. valeur autorisée : `documents`, `vehicles`, `equipment`, `fleet`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`submissionKey`** — obligatoire, string. UUID version 4. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`application`** — obligatoire, ApplicationDto. doit être envoyé ; objet imbriqué validé. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`fullName`** — obligatoire, string. chaîne de caractères ; au moins 3 caractère(s) ; au plus 180 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`phone`** — obligatoire, string. chaîne de caractères ; motif `/^\+?[\d ()-]{8,20}$/`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`vehicleDescription`** — obligatoire, string. chaîne de caractères ; au plus 180 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`plate`** — facultatif, string. chaîne de caractères ; au plus 40 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`documents`** — obligatoire, tableau. tableau ; au plus 10 élément(s) ; valeurs uniques ; chaque élément est une chaîne ; chaque texte fait au plus 60 caractères. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`description`** — obligatoire, string. chaîne de caractères ; au plus 2000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-pro-services-catalogue"></a>
### GET `/api/v1/pro-services/catalogue`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.catalogue` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200

<a id="get-api-v1-pro-services-mine"></a>
### GET `/api/v1/pro-services/mine`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.mine` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de requête**

Objet `ListServiceCasesDto` :

- **`status`** — facultatif, énumération. valeur autorisée : `submitted`, `reviewing`, `needs_info`, `quoted`, `accepted`, `processing`, `ready`, `completed`, `rejected`, `cancelled`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`cursor`** — facultatif, string. chaîne de caractères ; au plus 200 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-pro-services-mine-id"></a>
### GET `/api/v1/pro-services/mine/:id`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 30 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.detail` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-pro-services-mine-id-accept"></a>
### POST `/api/v1/pro-services/mine/:id/accept`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `AcceptServiceQuoteDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.accept` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

**Corps**

Classe `AcceptServiceQuoteDto`.

- **`quoteVersion`** — obligatoire, number. entier ; minimum 1. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`consent`** — obligatoire, boolean. valeur autorisée : `true`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-pro-services-mine-id-cancel"></a>
### POST `/api/v1/pro-services/mine/:id/cancel`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 5 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `ProServicesController.cancel` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** oui, schéma Bearer

**Paramètres de chemin**

- `id` — doit être un UUID

<a id="post-api-v1-pro-services-public-applications"></a>
### POST `/api/v1/pro-services/public-applications`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 3 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `CreateServiceCaseDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `ProServicesController.publicApplication` dans `src/pro-services/pro-services.controller.ts`
- **Succès par défaut :** 201

**Corps**

Classe `CreateServiceCaseDto`.

- **`contactConsent`** — obligatoire, boolean. valeur autorisée : `true`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`serviceCode`** — obligatoire, énumération. valeur autorisée : `documents`, `vehicles`, `equipment`, `fleet`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`submissionKey`** — obligatoire, string. UUID version 4. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`application`** — obligatoire, ApplicationDto. doit être envoyé ; objet imbriqué validé. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`fullName`** — obligatoire, string. chaîne de caractères ; au moins 3 caractère(s) ; au plus 180 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`phone`** — obligatoire, string. chaîne de caractères ; motif `/^\+?[\d ()-]{8,20}$/`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`vehicleDescription`** — obligatoire, string. chaîne de caractères ; au plus 180 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`plate`** — facultatif, string. chaîne de caractères ; au plus 40 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`documents`** — obligatoire, tableau. tableau ; au plus 10 élément(s) ; valeurs uniques ; chaque élément est une chaîne ; chaque texte fait au plus 60 caractères. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
  - **`description`** — obligatoire, string. chaîne de caractères ; au plus 2000 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

## App Updates

Version publiée des applications iOS et Android, enregistrement du client connecté, et publication ou retrait d’une annonce par un administrateur. Le contrôleur n’a pas de `@ApiTags`.

Ces opérations ne portent pas `@ApiTags`. Dans l’interface Swagger elles ne rejoignent pas un des groupes nommés dans `DocumentBuilder`.

<a id="post-api-v1-app-updates-client"></a>
### POST `/api/v1/app-updates/client`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Aucun rôle n’est exigé sur le contrôleur. Le service limite ensuite l’action au compte du jeton, et parfois au conducteur, au passager ou au propriétaire de la ressource. Le plafond de cette route est de 20 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `AppUpdateClientDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `AppUpdatesController.register` dans `src/app-updates/app-updates.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Corps**

Classe `AppUpdateClientDto`.

- **`platform`** — obligatoire, énumération. valeur autorisée : `ios`, `android`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`version`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`build`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`pushToken`** — facultatif, string. chaîne de caractères ; au plus 2048 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="get-api-v1-app-updates-latest"></a>
### GET `/api/v1/app-updates/latest`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 60 requête(s) par 60 seconde(s). Il remplace le plafond global.

- **Contrôleur :** `AppUpdatesController.latest` dans `src/app-updates/app-updates.controller.ts`
- **Succès par défaut :** 200

**Paramètres de requête**

Objet `AppVersionDto` :

- **`platform`** — obligatoire, énumération. valeur autorisée : `ios`, `android`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`version`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`build`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).


<a id="get-api-v1-app-updates-releases"></a>
### GET `/api/v1/app-updates/releases`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403.

- **Contrôleur :** `AppUpdatesController.list` dans `src/app-updates/app-updates.controller.ts`
- **Succès par défaut :** 200
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

<a id="post-api-v1-app-updates-releases"></a>
### POST `/api/v1/app-updates/releases`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403. Le plafond de cette route est de 10 requête(s) par 60 seconde(s). Il remplace le plafond global. Le corps est validé par `PublishAppReleaseDto`, mais aucun champ n’a de `@ApiProperty` : Swagger affiche l’opération sans détailler ce schéma. Les champs ci-dessous sont pourtant ceux que le serveur contrôle.

- **Contrôleur :** `AppUpdatesController.publish` dans `src/app-updates/app-updates.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Corps**

Classe `PublishAppReleaseDto`.

- **`platform`** — obligatoire, énumération. valeur autorisée : `ios`, `android`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`version`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`build`** — obligatoire, string. chaîne de caractères ; motif `/^\d{1,10}(\.\d{1,10}){0,2}$/` ; au plus 32 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`notes`** — obligatoire, string. chaîne de caractères ; au plus 500 caractère(s). validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).
- **`storeAvailabilityConfirmed`** — obligatoire, boolean. booléen ; doit valoir exactement `true`. validé par le serveur, absent du schéma Swagger (pas de `@ApiProperty`).

<a id="post-api-v1-app-updates-releases-id-withdraw"></a>
### POST `/api/v1/app-updates/releases/:id/withdraw`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est protégée. Il faut envoyer `Authorization: Bearer <jwt>`. Un jeton absent, expiré ou invalide produit une erreur 401. Le garde de rôles exige le rôle `admin` (un compte `super_admin` est aussi accepté). Sinon la réponse est 403.

- **Contrôleur :** `AppUpdatesController.withdraw` dans `src/app-updates/app-updates.controller.ts`
- **Succès par défaut :** 201
- **Cadenas Swagger :** non. Le JWT reste obligatoire à cause du garde global.

**Paramètres de chemin**

- `id`

## Application

Route racine de démonstration, publique, qui répond par un texte fixe. Elle n’a pas de décoration Swagger.

Ces opérations ne portent pas `@ApiTags`. Dans l’interface Swagger elles ne rejoignent pas un des groupes nommés dans `DocumentBuilder`.

<a id="get-api-v1"></a>
### GET `/api/v1`

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`.

- **Contrôleur :** `AppController.getHello` dans `src/app.controller.ts`
- **Succès par défaut :** 200

## Hors Swagger

Ces routes répondent sur le serveur et sont retirées du document OpenAPI.

### GET `/health`

Sonde de disponibilité. Elle est volontairement exclue de Swagger par `swaggerDocumentation: false`, mais le processus l’expose quand même.

Swagger ne donne pas de résumé : l’opération existe, mais son intitulé n’a pas été décoré avec `@ApiOperation`. La route est publique : le garde JWT, actif sur toute l’API, est écarté par `@Public()`. Le plafond de cette route est de 120 requête(s) par 60 seconde(s). Il remplace le plafond global.

La sonde vérifie PostgreSQL, Redis, puis la table `financial_rollout` : `contractVersion` doit valoir 1 et la fonction `zwanga_cash_policy_enabled()` doit exister. Sinon la réponse est 503, « Le schéma financier du serveur n’est pas prêt. » Une sonde saine renvoie `{ status, db, redis, uptime }`.

- **Contrôleur :** `HealthController.check` dans `src/health/health.controller.ts`
- **Authentification :** publique
- **Plafond :** 120 requêtes / 60 s

## Groupes nommés dans le DocumentBuilder

`main.ts` enregistre des descriptions courtes pour une partie des tags : Auth, Users, Vehicles, Trips, Bookings, Tracking, Chat, Ratings, Payments, Wallet, Driver Settlements, Subscriptions, Admin, Support et FAQ. Les autres groupes existent parce que leur contrôleur porte `@ApiTags`, ou, à défaut, n’ont pas de groupe dans l’interface.
