# OTP : Mobishastra pour le téléphone, Keccel pour le PIN oublié

## Politique actuelle — 29 octobre 2026

Le backend peut maintenant générer lui-même les codes téléphoniques et utiliser
Mobishastra uniquement pour leur envoi SMS. Le module reste dans NestJS : aucun
microservice, aucune migration SQL, aucune modification Terraform/CI-CD.

- `OTP_PROVIDER=mobishastra` active ce flux pour `phone_verification`
  (inscription, vérification optionnelle du téléphone).
- Sans ce réglage, les anciennes valeurs, y compris `didit`, conservent Keccel.
- Le PIN oublié et le bootstrap administrateur restent sur Keccel, 6 chiffres,
  300 secondes. `OTP_PIN_RESET_PROVIDER` reste ignoré. Le KYC est indépendant.
- Comme convenu, `REGISTRATION_PHONE_OTP_REQUIRED=false` par défaut : les
  anciennes applications peuvent encore s'inscrire sans OTP et restent
  `isPhoneVerified=false`. Aucun compte n'est marqué vérifié par simple saisie
  d'un numéro ou d'un booléen fourni par le mobile.

### Pause locale de Mobishastra — 29 octobre 2026

Mobishastra est désactivé dans la configuration locale : une seule définition
`OTP_PROVIDER=keccel` remplace les deux valeurs contradictoires précédentes.
`REGISTRATION_PHONE_OTP_REQUIRED=false` reste inchangé. Redémarrer le backend
pour prendre en compte ce réglage; aucune configuration AWS ou mobile n'est
modifiée par cette pause. Les nouvelles demandes OTP sont routées vers Keccel.
Le code et les secrets Mobishastra sont conservés pour une réactivation future.
Les codes Mobishastra déjà émis restent vérifiables localement jusqu'à leur
expiration, sans nouvel appel d'envoi au fournisseur.

### Contrat du nouveau flux

Toutes les routes sont sous `/api/v1`. Les champs existants sont conservés.

1. `POST /users/phone/send-otp` avec `{ "phone": "+243…", "context": "registration" }`.
   Réponse : `{ message, codeLength: 5, expiresInSeconds }`.
2. Le serveur génère 5 chiffres avec `crypto.randomInt`, stocke un challenge
   Redis, puis envoie le SMS. Le numéro international transmis est sans `+`.
3. `POST /users/phone/verify` avec `{ "phone": "+243…", "otp": "12345" }`.
   Réponse Mobishastra : `{ message, valid: true, verificationToken, expiresInSeconds }`.
   Pour un compte déjà existant et utilisable, le statut de téléphone est mis à
   jour comme auparavant; aucun compte suspendu/désactivé n'est réactivé.
4. Pour une nouvelle inscription, transmettre `verificationToken` sous le nom
   `phoneVerificationToken`, avec les autres champs de `POST /auth/register`
   (ou de `/auth/google/mobile`, `/auth/apple/mobile` lors de la création).
   Le serveur consomme cette preuve atomiquement et enregistre
   `isPhoneVerified=true`. Elle ne donne ni accès au compte, ni droit de reset PIN.

Le code expire **15 minutes après sa génération**. Le délai renvoyé tient compte
du temps d'envoi. La preuve d'inscription expire à la même échéance : une
validation ou un essai erroné ne prolonge pas ces 15 minutes. Le mobile doit garder
la preuve en mémoire, pas dans ses journaux ou son stockage persistant. Une
preuve ne fonctionne qu'avec le numéro validé, même sous un autre format accepté.

### Stockage et protections

- Aucun OTP en clair dans Redis : HMAC-SHA256 avec secret dédié, téléphone, usage
  et identifiant aléatoire du challenge. Un simple hash du code à 5 chiffres ne
  suffirait pas à le protéger contre une recherche exhaustive hors ligne.
- État `pending` pendant l'envoi, puis `sent` seulement après confirmation de
  l'API. `verified` conserve uniquement le hash de la preuve aléatoire.
- **5 essais erronés maximum** par code, puis suppression. Le bon code n'est
  accepté qu'une fois, même avec plusieurs répliques.
- Scripts Redis atomiques pour validation, compteur et consommation de preuve;
  conservation du TTL initial à chaque transition. Les verrous par téléphone
  existants sérialisent les opérations (409 si une autre est déjà en cours).
- Les budgets d'envoi existants s'appliquent : 30 s entre envois, 5 par heure et
  10 par jour par numéro, plafond global de 10 000/jour par défaut. Variables
  `OTP_SEND_COOLDOWN_SECONDS`, `OTP_SEND_PHONE_HOURLY_LIMIT`,
  `OTP_SEND_PHONE_DAILY_LIMIT`, `OTP_SEND_GLOBAL_DAILY_LIMIT` inchangées.
- Un renvoi refusé par ces limites conserve le code précédent. Un renvoi autorisé
  invalide les anciens challenges et preuves du téléphone, y compris les autres
  usages (protection du contrat Keccel historique par numéro).
- Aucun repli fournisseur ni renvoi automatique en cas de timeout : le SMS peut
  déjà être facturé. Un envoi échoué consomme quand même son budget.
- Redis indisponible : aucune vérification fictive; pas de SMS si le challenge
  initial ne peut pas être stocké. Une éviction/perte Redis impose un nouvel OTP.
- Preuve consommée avant création du compte : si l'inscription échoue ensuite,
  il faut demander un nouveau code. Elle n'est jamais remise en circulation.

### Configuration locale

Renseigner les secrets dans `.env` local, jamais dans Git ni dans le mobile :

```dotenv
OTP_PROVIDER=mobishastra
REGISTRATION_PHONE_OTP_REQUIRED=false
MOBISHASTRA_PROFILE_ID=<profil fourni par Mobishastra>
MOBISHASTRA_PASSWORD=<mot de passe API>
MOBISHASTRA_SENDER_ID=<expediteur approuve>
MOBISHASTRA_SMS_URL=https://valuesms.ae/sendsms_api_json.aspx
OTP_CODE_HMAC_SECRET=<secret aleatoire dedie, au moins 32 octets>
```

Générer le secret avec un gestionnaire de secrets ou, en local,
`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"`.
Ne pas réutiliser un mot de passe utilisateur ou une clé JWT. Toutes les répliques
doivent partager ce secret et Redis. Sa rotation invalide les codes encore en
attente; prévoir un nouvel envoi. Les preuves déjà validées restent à usage unique.
Conserver les identifiants Keccel pour les autres parcours. Redémarrer le backend
après modification des variables; aucune valeur réelle n'est ajoutée par ce correctif.

Transport implémenté d'après la **page 19 du PDF Mobishastra v1.3 fourni** : tableau
JSON `user`, `pwd`, `number`, `msg`, `sender`, `language`, réponse `msg_id`,
`number`, `response: "send success"`. HTTPS POST, timeout 10 s, aucune redirection,
réponse limitée à 16 Kio. Le texte ASCII reste inférieur à 160 caractères.
Seules les URLs JSON HTTPS `valuesms.ae` et `mshastra.com` prévues sont acceptées;
le défaut est celui du PDF joint. La page décrit le JSON sans expliciter le verbe
HTTP : le POST et la forme exacte de réponse doivent être confirmés par le test
réel ci-dessous avant activation en production. Aucun succès n'est déduit du
seul HTTP 200; le destinataire, l'identifiant et le résultat doivent correspondre.

Les erreurs de crédit, d'identifiants, de pays non activé ou les réponses
inattendues donnent une erreur contrôlée, sans journaliser le mot de passe, le
code, le corps HTTP ou le numéro. Le journal `MOBISHASTRA_SMS_NOT_CONFIRMED` permet
de repérer ces envois non confirmés. Consulter le portail fournisseur pour le détail.

### Tests et activation progressive

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/otp/mobishastra-sms.service.spec.ts src/otp/mobishastra-otp.service.spec.ts src/otp/otp.service.spec.ts src/users/users.service.otp.spec.ts src/auth/driver-signup.spec.ts src/auth/registration-compatibility.spec.ts src/auth/pin-reset.spec.ts
node test/run-otp-redis.cjs
npm.cmd run build
```

Le deuxième test lance un Redis local temporaire avec mot de passe, sans
persistance, puis l'arrête. Il utilise `redis-server` (WSL Ubuntu sur Windows),
ne charge pas `.env` et ne contacte aucun fournisseur SMS. Il couvre les vraies
opérations Lua, le TTL, les tentatives, le renvoi, les courses entre validations
et la consommation unique de preuve. Il ne teste pas la livraison opérateur.

Avant production :

1. Faire confirmer par Mobishastra l'activation de la route RDC, le crédit du
   compte, le Sender ID et l'endpoint JSON du compte.
2. Effectuer un envoi explicitement autorisé vers un numéro de test contrôlé;
   vérifier la réception, le code, l'inscription et `isPhoneVerified=true`.
3. Déployer le backend sur **toutes** les répliques avant de basculer
   `OTP_PROVIDER=mobishastra`. Les anciennes répliques ne connaissent pas ce code
   local. Ne pas mélanger les versions au moment d'activer le fournisseur.
4. Livrer l'étape OTP et le transport de `phoneVerificationToken` dans le mobile;
   les écrans actuels qui sautent l'OTP ne sont pas réactivés par le backend.
5. Activer `REGISTRATION_PHONE_OTP_REQUIRED=true` uniquement après cette livraison
   et validation des inscriptions téléphone, Google et Apple. Garder Mobishastra
   actif : les anciens challenges Keccel ne produisent pas cette nouvelle preuve.

Le retour à `OTP_PROVIDER=keccel` conserve la validation des codes Mobishastra en
cours **avec ce nouveau backend**. Ne pas retirer le secret ni restaurer une
ancienne image avant leur expiration. Repasser aussi l'obligation à `false` si
le mobile doit revenir à l'ancien parcours. Aucun changement AWS effectué ici.
