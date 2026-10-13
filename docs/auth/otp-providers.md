# OTP : compatibilité des applications publiées, Keccel uniquement

## Politique temporaire — 13 octobre 2026

Toutes les demandes et validations OTP du backend passent par **SMS Keccel** :
vérification du téléphone, PIN oublié et bootstrap administrateur.
`OTP_PROVIDER` et `OTP_PIN_RESET_PROVIDER` sont ignorés, même si leurs valeurs
déployées sont encore `didit`. Il n'y a aucun appel OTP Didit ni repli vers Didit
en cas d'échec Keccel. L'adaptateur Didit reste dans les sources pour un éventuel
retour ultérieur, mais n'est plus enregistré dans le module OTP.

Cette politique remplace celle du 12 octobre : les routes téléphoniques qui
répondaient 410 sont rétablies pour les anciens clients. **L'OTP ne devient pas
obligatoire à l'inscription**, à la connexion ou pour modifier le profil.
`phoneVerificationRequired` reste à `false` ; `isPhoneVerified` ne devient vrai
qu'après une vérification réussie pour un compte existant et utilisable.

Le KYC AWS/Didit, ses sessions et ses webhooks ne sont pas des OTP téléphoniques
et ne sont pas modifiés par cette bascule. Ne pas supprimer les clés KYC au
motif que l'OTP ne passe plus par Didit.

## Contrats mobiles conservés

Toutes les routes ci-dessous sont des `POST` sous `/api/v1`.

| Route | Corps | Résultat |
| --- | --- | --- |
| `users/phone/send-otp` | `{ phone, context }` ; registration/login/update | `{ message }` ; SMS de 5 chiffres |
| `users/phone/verify` | `{ phone, otp }` | `{ message, valid: true }` ; aucune autorisation de reset PIN |
| `auth/pin/reset/request-otp` | `{ phone }` | `{ message }` générique ; SMS de 6 chiffres pour un compte éligible |
| `auth/pin/reset/verify-otp` | `{ phone, otp }` | `{ resetToken, expiresInSeconds: 300 }` |
| `auth/pin/reset` | `{ resetToken, newPin }` | Enregistre le PIN haché et révoque les sessions |
| `auth/admin/bootstrap/send-otp` | Corps existant et secret de bootstrap | SMS de 6 chiffres |
| `auth/admin/bootstrap/confirm` | Corps existant, OTP et secret de bootstrap | Contrat administrateur inchangé |

Les routes mobiles présentes dans le code ne portent pas le nom de Didit :
elles utilisaient Didit derrière le routeur OTP du backend. Elles utilisent
désormais Keccel sans changer d'URL ni de corps. Aucun endpoint KYC
`users/kyc/didit/*` n'est détourné en endpoint OTP. Les anciens écrans peuvent
encore afficher « WhatsApp » ou « Didit » : le backend ne peut pas remplacer un
texte compilé dans l'application, mais les codes sont envoyés **par SMS**.

Pour la vérification téléphonique, `registration` refuse un numéro réservé par
un compte utilisable ; `login` et `update` exigent un compte utilisable.
Un ancien compte désactivé/suspendu n'est jamais réactivé par l'OTP.
Une vérification avant création du compte ne transmet pas de preuve à une
inscription ultérieure : le nouveau compte conserve `isPhoneVerified=false`.

## Codes en cours et sécurité

- Validité inchangée : 300 secondes. Codes à usage unique, contrôles de compte,
  preuve de reset et limites HTTP existantes conservés.
- Un code **déjà envoyé par Didit est refusé** sans appeler le fournisseur :
  demander un nouveau code, envoyé par Keccel. Il n'est pas techniquement
  possible de faire valider un ancien code Didit par Keccel.
- Un challenge Keccel déjà en cours reste accepté s'il n'est pas ambigu.
- Une nouvelle demande d'envoi invalide les anciens challenges du même téléphone,
  même si l'envoi échoue (un timeout peut survenir après génération chez Keccel).
  Après réussite de cette demande, seul le nouveau code est utilisable dans
  l'usage demandé. Ainsi un SMS de vérification
  du téléphone ne peut pas servir à réinitialiser le PIN ou créer un admin.
- Un verrou Redis par téléphone sérialise envois et validations entre les
  nouvelles répliques. Une opération simultanée reçoit 409 et peut être
  retentée. Le verrou expire automatiquement en cas d'arrêt du processus.
- Un identifiant unique distingue les renvois ; une validation concurrente
  ne peut pas consommer un challenge remplacé.
- Pendant un déploiement progressif, les anciennes répliques n'ont pas encore
  cette politique. Attendre la stabilisation du service puis demander un nouveau
  code si un parcours commencé pendant le déploiement échoue.
- Une absence de configuration Keccel donne 503 sur l'OTP, sans empêcher le
  serveur de démarrer ni simuler une validation réussie.

## Configuration et livraison

Les seules valeurs indispensables à cette bascule sont `KECCEL_TOKEN` et
`KECCEL_FROM`, avec un compte Keccel approvisionné et un expéditeur autorisé.
Les URLs existantes sont utilisées par défaut :

- `KECCEL_OTP_URL_GENERATE` : `https://api.keccel.com/otp/generate`
- `KECCEL_OTP_URL_VALIDATE` : `https://api.keccel.com/otp/validate`

Ces URLs sont celles de l'adaptateur existant, pas de nouvelles intégrations.
`KECCEL_SMS_URL` n'est pas utilisé pour les OTP. `DEFAULT_COUNTRY_CODE` reste
facultatif (défaut +243). Aucune migration SQL et aucun nouveau paramètre de
bascule obligatoire. `OTP_PROVIDER=keccel` peut être conservé pour la lisibilité,
mais une ancienne valeur `didit` ne change plus le routage.

Pour AWS : vérifier que les deux identifiants sont **effectivement injectés dans
le conteneur**, puis déployer le backend selon le processus habituel. Ajouter un
paramètre SSM sans le référencer dans la définition de tâche ne suffit pas ; une
tâche déjà démarrée ne relit pas automatiquement les paramètres.
Cette modification n'applique aucun changement AWS, Terraform ou CI/CD et ne
modifie aucun secret réel.

## Vérifications avant production

En local :

```powershell
npm.cmd test -- --runInBand --runTestsByPath src/otp/otp.service.spec.ts src/keccel-otp/keccel-otp.service.spec.ts src/users/users.service.otp.spec.ts src/auth/pin-reset.spec.ts
npm.cmd run build
```

Les tests simulés couvrent les anciens réglages Didit, les réponses mobiles,
la séparation des usages, les codes invalides/expirés/rejoués, les appels
concurrents et le reset complet du PIN avec le vrai adaptateur Keccel
(HTTP et stockage simulés). Ils n'envoient aucun SMS.

Vérification locale du 13 octobre : **201 tests réussis dans 11 suites** (OTP,
reset PIN, compatibilité d'inscription, statut profil et limitation HTTP),
**compilation backend réussie** et contrôle des espaces du diff réussi.

Avant de généraliser, faire un test autorisé sur un numéro contrôlé avec une
version réellement publiée : demander un SMS, vérifier le code, enregistrer un
nouveau PIN, puis se connecter avec ce PIN. Vérifier également l'ancien écran de
vérification téléphonique s'il est encore utilisé. Les tests automatisés ne
prouvent ni le crédit Keccel, ni la livraison opérateur, ni le comportement d'un
binaire store qui n'a pas été exécuté.
