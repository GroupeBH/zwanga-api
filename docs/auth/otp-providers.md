# OTP dans l’application : SMS uniquement pour le PIN oublié

## Politique actuelle — 12 octobre 2026

Cette section remplace les instructions historiques ci-dessous pour les parcours
utilisateur. L’inscription classique, Google/Apple, la connexion et la modification
du profil ne demandent plus d’OTP. Les routes `users/phone/send-otp` et
`users/phone/verify` sont conservées pour répondre explicitement **410**, sans
envoi, consommation de challenge ni modification d’un compte. Le profil retourne
`phoneVerificationRequired: false`, sans falsifier `isPhoneVerified`.

Les nouveaux codes du parcours `auth/pin/reset/*` sont envoyés par **SMS Keccel**,
six chiffres, validité de cinq minutes. Le routage est fixe pour ce parcours :
l’ancien réglage `OTP_PIN_RESET_PROVIDER` est ignoré. Aucun repli vers Didit à
l’envoi. Les identifiants SMS doivent être disponibles au serveur; aucun secret
réel ni paramètre de production n’a été modifié par cette intervention.

La consommation unique et les protections du reset restent inchangées. Pour ne
pas casser un reset déjà commencé, seuls les challenges historiques déjà émis
peuvent encore être vérifiés avec leur fournisseur d’origine jusqu’à expiration.
La vérification d’identité et le bootstrap administratif sécurisé sont séparés
des parcours OTP grand public et ne sont pas modifiés ici.

L’application ne cite aucun fournisseur : « Code par SMS ». Les anciens brouillons
à l’étape OTP d’inscription sont migrés vers la saisie du PIN ou du téléphone
social. Coordonner la livraison mobile et backend : un ancien client configuré
pour imposer l’OTP d’inscription devra être mis à jour. Les anciennes versions
utilisant déjà l’inscription sans OTP continuent le parcours habituel.

Les vérifications et limites de cette évolution sont consignées dans
`../zwanga/docs/CHANGEMENTS_TECHNIQUES.md` (chemin depuis la racine du backend).
Livraison SMS réelle et essais iOS/Android restent à vérifier; aucun déploiement
n’a été réalisé pour cette évolution.

## Archive — ancien routage configurable (ne plus appliquer à l’inscription ou au PIN oublié)

Le backend conserve les endpoints mobiles existants pour la vérification du téléphone, la réinitialisation du PIN et le bootstrap administrateur. Depuis le 12 octobre 2026, **les nouveaux codes de récupération du PIN utilisent Keccel par défaut**, indépendamment de `OTP_PROVIDER`. `OTP_PROVIDER=didit` continue de sélectionner Didit pour la vérification du téléphone et le bootstrap administrateur ; `keccel` reste possible pour ces usages. Si cette variable est absente, ces usages restent aussi sur Keccel. **Il n'y a jamais de bascule automatique vers un autre fournisseur après un échec d'envoi**, qui pourrait provoquer un second message facturé. Infobip n'est plus un fournisseur OTP. Ses éventuels services WhatsApp de notification sont distincts. Le KYC Didit est indépendant et inchangé.

Le fournisseur ayant envoyé un code est conservé dans Redis pendant la durée du challenge, puis utilisé pour la vérification même si `OTP_PROVIDER` ou `OTP_PIN_RESET_PROVIDER` a changé entre-temps. Les codes Didit de récupération déjà envoyés restent ainsi vérifiables jusqu'à leur expiration, tant que leurs identifiants fournisseur restent configurés. Un nouvel envoi réussi remplace le challenge du même usage. Un OTP sans challenge ou déjà consommé est refusé. Les anciens codes Infobip ne sont plus pris en charge.

## PIN oublié : Keccel (12 octobre 2026)

Le routage est défini dans `src/otp/otp.service.ts`. La configuration cible est :

```dotenv
OTP_PROVIDER=didit
OTP_PIN_RESET_PROVIDER=keccel
```

`OTP_PIN_RESET_PROVIDER` est facultatif : sa valeur par défaut est `keccel`.
Définir explicitement `didit` permet un retour manuel pour ce seul parcours,
sans toucher aux autres OTP. Les valeurs non reconnues sont refusées au démarrage.

Les tâches du backend doivent disposer de **`KECCEL_TOKEN` et `KECCEL_FROM` valides**.
Les endpoints existants de l'adaptateur Keccel sont utilisés ; les éventuelles
surcharges sont `KECCEL_OTP_URL_GENERATE` et `KECCEL_OTP_URL_VALIDATE`.
`KECCEL_SMS_URL` n'est pas utilisé par cet adaptateur OTP. Vérifier le crédit et
l'autorisation de l'expéditeur chez Keccel avant de tester une livraison réelle.
Si le fournisseur général reste Didit et les identifiants Keccel manquent, le
backend peut démarrer, mais une demande de récupération éligible échoue en `503` :
aucun code n'est accepté et aucun envoi Didit de remplacement n'est effectué.

Le contrat de l'application ne change pas :

1. `POST /api/v1/auth/pin/reset/request-otp` avec `{ phone }` : SMS Keccel de
   **6 chiffres**, valide **300 secondes**, pour un compte éligible.
2. `POST /api/v1/auth/pin/reset/verify-otp` avec `{ phone, otp }` : vérification
   auprès du fournisseur stocké et émission d'une preuve à usage unique de 5 minutes.
3. `POST /api/v1/auth/pin/reset` avec `{ resetToken, newPin }` : enregistrement
   du PIN haché et révocation des sessions, selon les protections existantes.

Les réponses génériques pour les comptes inconnus/inéligibles, les limites de
tentatives et la consommation unique sont conservées. Une vérification téléphonique
Didit en cours n'empêche pas une récupération via Keccel : leurs challenges sont
distincts. Aucune migration de base de données ni nouvelle route publique.

Pour le déploiement, conserver `OTP_PROVIDER` actuel, rendre les identifiants
Keccel accessibles au conteneur, puis déployer le backend. L'ajout de la variable
facultative dans Parameter Store seul ne modifie pas une tâche ECS déjà lancée :
elle doit être référencée par la définition de tâche si l'on souhaite surcharger
le défaut. Aucune modification d'AWS, de Terraform, du CI/CD ou des secrets réels
n'a été effectuée pour ce changement. Les anciennes applications appellent les
mêmes routes ; leurs textes peuvent encore mentionner Didit/WhatsApp jusqu'à
leur mise à jour mobile. Une livraison réelle doit être validée avant généralisation.

Vérifications locales : **109 tests réussis dans 6 suites ciblées** (routage OTP,
adaptateurs Didit/Keccel, normalisation téléphone, récupération du PIN et OTP users),
et `npm run build` réussi. Le test de parcours complet utilise le vrai service
de récupération, le routeur OTP et l'adaptateur Keccel, avec HTTP et stockage simulés.
Il couvre le refus d'un mauvais code, l'enregistrement du nouveau PIN, la révocation
des sessions et le refus de réutilisation. Aucun SMS réel ni test AWS n'a été exécuté.

## Flux Didit

Le backend utilise l'[API autonome Phone Verification](https://docs.didit.me/standalone-apis/phone-verification) : `POST https://verification.didit.me/v3/phone/send/` avec `x-api-key`, puis `POST /v3/phone/check/` avec le même numéro en format E.164 et le code. Didit associe les appels par application et numéro ; l'appel `check` **n'accepte pas `request_id` en entrée**. Le backend exige donc que la réponse finale `Approved` porte le `request_id`, le `vendor_data` opaque et le numéro du challenge qu'il a lui-même stocké. `Failed`, `Declined` et `Expired or Not Found` ne valident jamais un code. Les rapports détaillés Didit ne sont ni renvoyés au mobile ni journalisés.

Le canal préféré est `whatsapp`, conformément au [comportement par défaut documenté par Didit](https://docs.didit.me/standalone-apis/phone-send). Didit peut utiliser SMS si le canal préféré n'est pas disponible pour le destinataire. `DIDIT_OTP_CHANNEL=sms` permet de demander SMS directement si la politique produit change. La langue est `fr`. La longueur reste compatible avec l'application : **5 chiffres** pour le téléphone, **6 chiffres** pour reset PIN et bootstrap admin. Le [schéma OpenAPI Didit](https://docs.didit.me/openapi-25.json) autorise 4 à 8 chiffres et la locale `fr`.

Un envoi `Success` crée une vérification de cinq minutes. Un `Retry` réutilise le même `request_id` et la fenêtre **ne repart pas de zéro** ; le TTL Redis suit cette échéance initiale. Au plus un renvoi est lié à la même vérification ; un envoi ultérieur peut créer une nouvelle session Didit. Le backend n'autorise qu'un usage OTP Didit actif à la fois par numéro (téléphone, reset PIN ou bootstrap admin), car Didit ne distingue pas ces usages lors du `check`. Un `Blocked` ou une limite d'envoi donne `429` au client, et non une fausse panne `503`. Les tentatives de code erroné sont limitées par Didit à trois par vérification ; ses limites d'envoi s'appliquent également. Voir [Send Phone Code](https://docs.didit.me/standalone-apis/phone-send) et [Check Phone Code](https://docs.didit.me/standalone-apis/phone-check).

| Variable | Rôle |
| --- | --- |
| `OTP_PROVIDER` | Téléphone et bootstrap admin : `didit` ou `keccel` ; défaut `keccel` |
| `OTP_PIN_RESET_PROVIDER` | PIN oublié uniquement : `keccel` par défaut, `didit` pour retour manuel |
| `KECCEL_TOKEN` / `KECCEL_FROM` | Identifiants de l'adaptateur Keccel requis pour le PIN oublié par défaut |
| `DIDIT_OTP_API_KEY` | Clé Didit dédiée à l'OTP, prioritaire si renseignée |
| `DIDIT_API_KEY` | Clé Didit existante (KYC), utilisée si la clé OTP dédiée est vide |
| `DIDIT_OTP_CHANNEL` | `whatsapp` (défaut Didit) ou `sms` ; le repli de canal est géré par Didit |

Une clé sandbox ne délivre aucun message et Didit renvoie un résultat `Approved` statique, sans les mêmes identifiants de corrélation qu'une vraie session. Le backend **refuse donc ce résultat comme preuve OTP réelle**. Pour un test d'intégration sans livraison, utiliser les tests automatisés ; pour tester la réception sur mobile, il faut une clé live et un numéro contrôlé.

## Activation et coût

Selon [Didit](https://docs.didit.me/standalone-apis/phone-send), l'envoi live est désactivé jusqu'au premier rechargement du compte (`403`). Un solde nul et une clé KYC valide ne suffisent donc pas. Didit peut facturer un envoi non bloqué même si la livraison n'a pas été confirmée ; les appels `check` sont gratuits. Le [tarif de base publié](https://docs.didit.me/getting-started/pricing) est de **0,04 $ plus frais opérateur** ; le [prix total dépend du pays et du canal](https://docs.didit.me/getting-started/phone-verification-pricing). Vérifier le montant pour la RDC dans le compte Didit avant l'activation. La documentation générale mentionne des vérifications gratuites, mais ne garantit pas clairement que ces crédits couvrent ce flux autonome : ne pas les supposer disponibles pour les OTP.

En local, `.env` peut contenir `OTP_PROVIDER=didit` et une des clés Didit. Démarrer le backend avec `npm.cmd run start:dev`. Les endpoints mobiles restent `/api/v1/users/phone/send-otp`, `/api/v1/users/phone/verify`, `/api/v1/auth/pin/reset/request-otp`, `/api/v1/auth/pin/reset/verify-otp`, `/api/v1/auth/admin/bootstrap/send-otp` et `/api/v1/auth/admin/bootstrap/confirm`. Le parcours d'inscription n'exige toujours pas d'OTP ; pour régulariser un compte déjà créé, utiliser `context: "login"` avec l'endpoint d'envoi et vérifier le code reçu. Voir [le suivi des comptes à vérifier](phone-verification-tracker.md).

En production AWS, activer Didit **seulement après** rechargement, essai réel sur un numéro autorisé et vérification du coût. Les paramètres SSM et une nouvelle définition de tâche ECS sont nécessaires pour exposer la clé et `OTP_PROVIDER=didit` au backend ; modifier `.env` local ou SSM seul ne met pas à jour les tâches déjà lancées. Aucun changement AWS n'est effectué par ce document.
