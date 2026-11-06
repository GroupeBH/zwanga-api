# OTP : Mobishastra pour le téléphone et les opérations PIN

## Politique actuelle — 5 novembre 2026

Le backend peut maintenant générer lui-même les codes téléphoniques et utiliser
Mobishastra uniquement pour leur envoi SMS. Le module reste dans NestJS : aucun
microservice, aucune migration SQL, aucune modification Terraform/CI-CD.

- `OTP_PROVIDER=mobishastra` active ce flux pour `phone_verification`
  (inscription, vérification optionnelle du téléphone).
- Sans ce réglage, les anciennes valeurs, y compris `didit`, conservent Keccel.
- `OTP_PIN_RESET_PROVIDER=mobishastra` active Mobishastra pour le PIN oublié
  **et la modification authentifiée du PIN**, indépendamment de l'inscription.
  Sans cette variable, ces deux parcours suivent `OTP_PROVIDER`. Une valeur
  historique autre que `mobishastra` conserve Keccel, sans appel à Didit.
- Avec Mobishastra, le backend génère **6 chiffres pour les opérations PIN**, valables 15 minutes,
  pour conserver la compatibilité des écrans mobiles installés. Le bootstrap
  administrateur reste sur Keccel (6 chiffres, 300 secondes). KYC inchangé.
- Comme convenu, `REGISTRATION_PHONE_OTP_REQUIRED=false` par défaut : les
  anciennes applications peuvent encore s'inscrire sans OTP et restent
  `isPhoneVerified=false`. Aucun compte n'est marqué vérifié par simple saisie
  d'un numéro ou d'un booléen fourni par le mobile.

### Activation progressive et comptes existants — 5 novembre 2026

Sur demande de l’utilisateur, le fournisseur téléphone local est de nouveau
Mobishastra. Les parcours mot de passe restent inchangés et l’obligation globale
d’OTP à l’inscription reste désactivée pour préserver les clients déjà distribués.
Redémarrer le backend local pour charger cette configuration. Aucun secret,
paramètre AWS, schéma ou paiement de production modifié pour cette activation.

Le dépôt mobile prépare les prochains profils EAS avec l’OTP d’inscription et un
contrôle obligatoire des comptes existants dont le téléphone n’a jamais été
validé. Le mobile lit `isPhoneVerified` depuis le profil authentifié, distinct de
la vérification e-mail ou KYC. Pour un compte existant, il réutilise
`/users/phone/send-otp` avec le contexte `update`, puis `/users/phone/verify`.
Le backend marque uniquement le numéro prouvé d’un compte encore admissible ;
le mobile relit ensuite `/users/me` avant de libérer l’accès. Un GET commencé
avant la validation n’est pas utilisé comme confirmation finale.

Les anciens clients restent compatibles : aucune nouvelle garde serveur globale
ni exigence de version HTTP ajoutée. Le contrôle obligatoire après mise à jour
concerne le nouveau client officiel, pas les appels directs d’un ancien client.
Les comptes déjà vérifiés ne reçoivent pas de SMS automatique. Un compte sans
accès à son numéro dispose d’une aide pour contacter le support, sans changement
de numéro non vérifié dans ce parcours.

Validation : 227 tests backend ciblés réussis, puis 20 tests des routes OTP
utilisateurs réussis (dont deux nouveaux cas pour comptes existants), et 167
tests JavaScript mobile réussis sous Node 24.22.1. Tests simulés, sans SMS réel,
recette native, build cloud ni déploiement. L’activation AWS du fournisseur
d’inscription, la vérification de son accès réseau/liste blanche et une réception
SMS de test explicitement autorisée restent nécessaires avant publication.
Voir aussi le journal `zwanga/docs/CHANGEMENTS_TECHNIQUES.md` du même jour.

### Historique : pause locale — 29 octobre 2026

Mobishastra est désactivé dans la configuration locale : une seule définition
`OTP_PROVIDER=keccel` remplace les deux valeurs contradictoires précédentes.
`REGISTRATION_PHONE_OTP_REQUIRED=false` reste inchangé. Redémarrer le backend
pour prendre en compte ce réglage; aucune configuration AWS ou mobile n'est
modifiée par cette pause. Les nouvelles demandes OTP sont routées vers Keccel.
Le code et les secrets Mobishastra sont conservés pour une réactivation future.
Les codes Mobishastra déjà émis restent vérifiables localement jusqu'à leur
expiration, sans nouvel appel d'envoi au fournisseur.

Le 3 novembre, `OTP_PIN_RESET_PROVIDER=mobishastra` est ajouté au `.env` local :
seuls les parcours PIN basculent. La configuration d'inscription reste inchangée.
Redémarrer le backend pour charger cette valeur. Aucun SMS réel n'a été envoyé.

### Modification et réinitialisation du PIN

| Parcours | Routes sous `/api/v1` | Contrôles |
| --- | --- | --- |
| Modifier depuis le profil | `POST /users/pin/change/request-otp`, puis `POST /users/pin/change` | JWT, ancien PIN, OTP `pin_change`, numéro enregistré du compte |
| PIN oublié | `POST /auth/pin/reset/request-otp`, `/auth/pin/reset/verify-otp`, `/auth/pin/reset` | OTP `pin_reset`, puis jeton de reset à usage unique valable 5 minutes |

L'envoi authentifié n'accepte aucun numéro de destination fourni par le client.
La modification exige `{ "oldPin": "1234", "newPin": "5678", "otp": "123456" }`
(valeurs fictives). L'OTP est vérifié et consommé une seule fois avant l'écriture,
après contrôle de l'ancien PIN. Les comptes désactivés/suspendus et les comptes
administrateurs sont exclus de ce parcours. L'écriture compare aussi le PIN,
le téléphone et le rôle lus auparavant : une modification concurrente entraîne
un conflit, jamais l'écrasement aveugle d'un changement de compte. Aucun appel
SMS/Redis ni calcul bcrypt ne retient de verrou PostgreSQL. En cas d'échec après
consommation de l'OTP, recommencer avec un nouveau code; ne pas rejouer la mutation.

Le reset conserve une réponse d'envoi générique pour les comptes inconnus ou
inéligibles. Son marqueur Redis d'attente suit le délai restant de l'OTP
Mobishastra (au plus 900 secondes), tandis que son jeton final reste à 300 secondes.
Le stockage du nouveau PIN et l'invalidation des sessions restent les mécanismes
existants. Le PIN lui-même reste un secret à quatre chiffres, distinct de l'OTP.

La clé Redis **et le HMAC** distinguent `phone_verification`, `pin_reset` et
`pin_change`. Les OTP PIN sont supprimés atomiquement après validation et ne
produisent jamais de preuve d'inscription. Cinq essais maximum, TTL non prolongé,
budgets d'envoi partagés et suppression des anciens challenges à chaque renvoi
autorisé restent appliqués. Les anciens challenges Mobishastra sans champ
`purpose` ne sont acceptés que pour le téléphone; les codes Keccel déjà émis
restent validés par Keccel après un changement de configuration.

**Compatibilité mobile :** `zwanga` réutilise le modal existant, avec ancien PIN →
OTP → nouveau PIN. L'OTP n'est réellement validé qu'à la soumission finale de la
modification; le bouton intermédiaire dit « Continuer ». Les anciennes versions
qui modifient sans OTP seront refusées dès le déploiement backend; « PIN oublié »
reste compatible grâce aux six chiffres et aux endpoints inchangés. Livrer le
mobile pour le parcours normal, sans réintroduire de contournement de l'OTP.

**Activation AWS ultérieure :** définir `OTP_PIN_RESET_PROVIDER=mobishastra`,
vérifier `OTP_CODE_HMAC_SECRET`, les identifiants/Sender ID et l'URL Mobishastra,
ainsi que le proxy et la liste blanche IP. Déployer le backend sur toutes les
répliques, injecter la variable dans ECS via le mécanisme existant et renouveler
les tâches. Une configuration manquante bloque l'envoi, sans repli fournisseur.
Le retour explicite à `OTP_PIN_RESET_PROVIDER=keccel` conserve l'obligation
d'OTP pour modifier le PIN. Ne pas retirer le secret HMAC avant expiration des
codes Mobishastra en attente. Aucun changement Terraform, AWS ou CI/CD effectué.

### Contrat de vérification du téléphone

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
OTP_PIN_RESET_PROVIDER=mobishastra
REGISTRATION_PHONE_OTP_REQUIRED=false
MOBISHASTRA_PROFILE_ID=<profil fourni par Mobishastra>
MOBISHASTRA_PASSWORD=<mot de passe API>
MOBISHASTRA_SENDER_ID=<expediteur approuve>
MOBISHASTRA_SMS_URL=https://mshastra.com/sendurl.aspx
OTP_CODE_HMAC_SECRET=<secret aleatoire dedie, au moins 32 octets>
```

Générer le secret avec un gestionnaire de secrets ou, en local,
`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"`.
Ne pas réutiliser un mot de passe utilisateur ou une clé JWT. Toutes les répliques
doivent partager ce secret et Redis. Sa rotation invalide les codes encore en
attente; prévoir un nouvel envoi. Les preuves déjà validées restent à usage unique.
Conserver les identifiants Keccel pour le bootstrap administrateur et tout parcours
qui l'utilise encore. Redémarrer le backend
après modification des variables; aucune valeur réelle n'est ajoutée par ce correctif.

### Endpoint confirmé et confidentialité — 3 novembre 2026

Transport aligné sur l'URL confirmée pour ce compte et les **pages 13–14 du PDF
Mobishastra v1.3 fourni** : `https://mshastra.com/sendurl.aspx`, HTTPS GET,
paramètres `user`, `pwd`, `senderid`, `mobileno`, `msgtext`, `priority=High`,
`CountryCode=ALL`, `ShowError=C`. Les paramètres sont encodés par le client HTTP.
Timeout global 10 s, aucune redirection, réponse limitée à 16 Kio. Le texte ASCII
reste inférieur à 160 caractères. Seule cette URL exacte est autorisée.

L'ancien endpoint JSON de la page 19 n'est plus utilisé ni accepté en configuration.
Si `MOBISHASTRA_SMS_URL` est déjà défini dans l'environnement ou SSM, remplacer sa
valeur par l'URL ci-dessus lors du déploiement du nouveau code, puis renouveler
les tâches ECS pour charger la valeur. Une ancienne valeur JSON bloque l'envoi;
elle n'est pas ignorée silencieusement. Aucun paramètre AWS n'a été modifié ici.
L'activation de `OTP_PROVIDER` et de l'obligation d'OTP reste une étape séparée.

L'envoi est confirmé uniquement par HTTP 200 accompagné du texte `Send Successful`,
du code `000`, ou de `000 - Send Successful`. Une réponse vide, JSON, contradictoire
ou contenant un écho du message est refusée. Cette confirmation signifie acceptation
de la soumission, pas preuve de réception du SMS par le téléphone.

Les erreurs de crédit, d'identifiants, de pays non activé ou les réponses
inattendues donnent une erreur contrôlée, sans journaliser le mot de passe, le
code, le corps HTTP ou le numéro. Le journal `MOBISHASTRA_SMS_NOT_CONFIRMED` permet
de repérer ces envois non confirmés. Consulter le portail fournisseur pour le détail.

Le code n'est renvoyé ni dans les réponses REST ni dans les journaux Zwanga. Redis
ne conserve que son HMAC, puis le hash de la preuve après validation. Puisque l'API
unitaire transporte les secrets dans la query HTTPS, l'instrumentation OpenTelemetry
est supprimée **uniquement pour cet appel sortant** (succès et erreur). Les autres
traces restent actives. Le tunnel Squid ne déchiffre pas le SMS et ses journaux ne
contiennent pas l'URL. Ne pas ajouter de logs Axios, de hooks qui enregistrent les
paramètres HTTP, de `NODE_DEBUG=http,https` ou d'interception TLS sur ce flux.

Limite importante : le backend manipule brièvement le code en mémoire pour générer
et envoyer le SMS. Mobishastra et l'opérateur destinataire traitent nécessairement
le message en clair. Le PDF ne décrit aucun paramètre pour masquer l'OTP dans leur
portail. Faire confirmer par leur support le masquage, les habilitations et la durée
de conservation des messages. Le code ne peut pas garantir cette confidentialité
chez le fournisseur, ni sur un téléphone compromis.

### Tests et activation progressive

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/otp/mobishastra-sms.service.spec.ts src/otp/mobishastra-otp.service.spec.ts src/otp/otp.service.spec.ts src/users/users.service.otp.spec.ts src/auth/driver-signup.spec.ts src/auth/registration-compatibility.spec.ts src/auth/pin-reset.spec.ts
node test/run-otp-redis.cjs
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/otp/mobishastra-proxy.integration.spec.ts src/otp/mobishastra-tracing.spec.ts src/otp/mobishastra-confidentiality.spec.ts
npm.cmd run build
```

Le deuxième test lance un Redis local temporaire avec mot de passe, sans
persistance, puis l'arrête. Il utilise `redis-server` (WSL Ubuntu sur Windows),
ne charge pas `.env` et ne contacte aucun fournisseur SMS. Il couvre les vraies
opérations Lua, le TTL, les tentatives, le renvoi, les courses entre validations
et la consommation unique de preuve. Il ne teste pas la livraison opérateur.

Validation locale du correctif PIN du 3 novembre : **255 tests backend ciblés**
(15 suites : transport, confidentialité, OTP, modification du PIN et compatibilité
inscription/réinitialisation), **15 tests avec un Redis jetable** et **68 tests
mobiles ciblés** réussis. Les 6 tests Python du proxy avaient été validés lors du
correctif d'endpoint précédent; ils n'ont pas été relancés pour cette extension PIN.
Les tests vérifient notamment que les
requêtes SMS réelles vers un serveur HTTPS de boucle locale ne génèrent pas de
spans HTTP, même si le fournisseur renvoie les secrets dans une erreur, et que
les autres requêtes restent tracées. Vérification TypeScript sans émission réussie
sur le backend et le mobile. Exécution
sur le Node 24.11.0 du poste; recette CI sur le Node 24.22.1 déclaré par le projet
et réception d'un vrai SMS encore à effectuer. La suite complète du dépôt n'a
pas été exécutée pour ce correctif. Aucun test sur appareil ni SMS réel effectué.

Tests complémentaires de modification du PIN :

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/users/pin-change-otp.spec.ts
# Depuis le dépôt mobile zwanga :
node --test tests/pinReset.test.js tests/profileModules.test.js tests/otpDelivery.test.js tests/otpCodeInput.test.js
```

Avant production :

1. Faire confirmer par Mobishastra l'activation de la route RDC, le crédit du
   compte et le Sender ID; l'URL unitaire ci-dessus a été confirmée par l'opérateur
   Zwanga. Vérifier la réponse réelle sans exporter l'URL contenant les secrets ni le SMS dans les logs.
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
