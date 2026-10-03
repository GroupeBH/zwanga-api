# OTP : Didit principal, Keccel de secours

Le backend conserve les endpoints mobiles existants pour la vérification du téléphone, la réinitialisation du PIN et le bootstrap administrateur. `OTP_PROVIDER=didit` sélectionne Didit pour les nouveaux codes ; `keccel` reste possible pour un retour manuel. Si la variable est absente, le backend garde Keccel comme repli de déploiement : **il n'y a jamais de bascule automatique après un échec d'envoi**, qui pourrait provoquer un second message facturé. Infobip n'est plus un fournisseur OTP. Ses éventuels services WhatsApp de notification sont distincts.

Le fournisseur ayant envoyé un code est conservé dans Redis pendant la durée du challenge, puis utilisé pour la vérification même si `OTP_PROVIDER` a changé entre-temps. Après le retrait du code OTP Infobip, ses codes déjà en circulation ne peuvent plus être vérifiés : attendre au moins cinq minutes après le dernier envoi Infobip avant de remplacer le backend en production, ou demander un nouveau code Didit. Un OTP sans challenge ou déjà consommé est refusé.

## Flux Didit

Le backend utilise l'[API autonome Phone Verification](https://docs.didit.me/standalone-apis/phone-verification) : `POST https://verification.didit.me/v3/phone/send/` avec `x-api-key`, puis `POST /v3/phone/check/` avec le même numéro en format E.164 et le code. Didit associe les appels par application et numéro ; l'appel `check` **n'accepte pas `request_id` en entrée**. Le backend exige donc que la réponse finale `Approved` porte le `request_id`, le `vendor_data` opaque et le numéro du challenge qu'il a lui-même stocké. `Failed`, `Declined` et `Expired or Not Found` ne valident jamais un code. Les rapports détaillés Didit ne sont ni renvoyés au mobile ni journalisés.

Le canal préféré est `whatsapp`, conformément au [comportement par défaut documenté par Didit](https://docs.didit.me/standalone-apis/phone-send). Didit peut utiliser SMS si le canal préféré n'est pas disponible pour le destinataire. `DIDIT_OTP_CHANNEL=sms` permet de demander SMS directement si la politique produit change. La langue est `fr`. La longueur reste compatible avec l'application : **5 chiffres** pour le téléphone, **6 chiffres** pour reset PIN et bootstrap admin. Le [schéma OpenAPI Didit](https://docs.didit.me/openapi-25.json) autorise 4 à 8 chiffres et la locale `fr`.

Un envoi `Success` crée une vérification de cinq minutes. Un `Retry` réutilise le même `request_id` et la fenêtre **ne repart pas de zéro** ; le TTL Redis suit cette échéance initiale. Au plus un renvoi est lié à la même vérification ; un envoi ultérieur peut créer une nouvelle session Didit. Le backend n'autorise qu'un usage OTP Didit actif à la fois par numéro (téléphone, reset PIN ou bootstrap admin), car Didit ne distingue pas ces usages lors du `check`. Un `Blocked` ou une limite d'envoi donne `429` au client, et non une fausse panne `503`. Les tentatives de code erroné sont limitées par Didit à trois par vérification ; ses limites d'envoi s'appliquent également. Voir [Send Phone Code](https://docs.didit.me/standalone-apis/phone-send) et [Check Phone Code](https://docs.didit.me/standalone-apis/phone-check).

| Variable | Rôle |
| --- | --- |
| `OTP_PROVIDER` | `didit` ou `keccel` ; valeur du code si absente : `keccel` |
| `DIDIT_OTP_API_KEY` | Clé Didit dédiée à l'OTP, prioritaire si renseignée |
| `DIDIT_API_KEY` | Clé Didit existante (KYC), utilisée si la clé OTP dédiée est vide |
| `DIDIT_OTP_CHANNEL` | `whatsapp` (défaut Didit) ou `sms` ; le repli de canal est géré par Didit |

Une clé sandbox ne délivre aucun message et Didit renvoie un résultat `Approved` statique, sans les mêmes identifiants de corrélation qu'une vraie session. Le backend **refuse donc ce résultat comme preuve OTP réelle**. Pour un test d'intégration sans livraison, utiliser les tests automatisés ; pour tester la réception sur mobile, il faut une clé live et un numéro contrôlé.

## Activation et coût

Selon [Didit](https://docs.didit.me/standalone-apis/phone-send), l'envoi live est désactivé jusqu'au premier rechargement du compte (`403`). Un solde nul et une clé KYC valide ne suffisent donc pas. Didit peut facturer un envoi non bloqué même si la livraison n'a pas été confirmée ; les appels `check` sont gratuits. Le [tarif de base publié](https://docs.didit.me/getting-started/pricing) est de **0,04 $ plus frais opérateur** ; le [prix total dépend du pays et du canal](https://docs.didit.me/getting-started/phone-verification-pricing). Vérifier le montant pour la RDC dans le compte Didit avant l'activation. La documentation générale mentionne des vérifications gratuites, mais ne garantit pas clairement que ces crédits couvrent ce flux autonome : ne pas les supposer disponibles pour les OTP.

En local, `.env` peut contenir `OTP_PROVIDER=didit` et une des clés Didit. Démarrer le backend avec `npm.cmd run start:dev`. Les endpoints mobiles restent `/api/v1/users/phone/send-otp`, `/api/v1/users/phone/verify`, `/api/v1/auth/pin/reset/request-otp`, `/api/v1/auth/pin/reset/verify-otp`, `/api/v1/auth/admin/bootstrap/send-otp` et `/api/v1/auth/admin/bootstrap/confirm`. Le parcours d'inscription n'exige toujours pas d'OTP ; pour régulariser un compte déjà créé, utiliser `context: "login"` avec l'endpoint d'envoi et vérifier le code reçu. Voir [le suivi des comptes à vérifier](phone-verification-tracker.md).

En production AWS, activer Didit **seulement après** rechargement, essai réel sur un numéro autorisé et vérification du coût. Les paramètres SSM et une nouvelle définition de tâche ECS sont nécessaires pour exposer la clé et `OTP_PROVIDER=didit` au backend ; modifier `.env` local ou SSM seul ne met pas à jour les tâches déjà lancées. Aucun changement AWS n'est effectué par ce document.
