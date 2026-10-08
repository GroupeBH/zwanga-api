# Suivi des comptes sans vérification OTP du téléphone

L'inscription par PIN, Google ou Apple reste possible sans OTP téléphonique. Le champ persistant `users.isPhoneVerified` est la source de vérité : `false` signifie qu'aucune preuve OTP n'est attachée au compte. Il reste `false` par défaut à chaque inscription sans preuve ; aucun nouveau champ ou migration n'est nécessaire.

`GET /api/v1/users/me` renvoie `user.isPhoneVerified` et le signal dérivé `user.phoneVerificationRequired`. L'application pourra plus tard utiliser ce signal pour demander la vérification, sans changer le contrat d'inscription actuel. Le backend **ne bloque pas encore** la connexion ni les autres parcours sur ce statut.

Pour un compte existant et utilisable, `POST /api/v1/users/phone/send-otp` avec `context: "login"`, puis `POST /api/v1/users/phone/verify` avec le code reçu mettent `isPhoneVerified` à `true` uniquement après validation réussie chez le fournisseur OTP actif. Un code invalide ne modifie rien. Le contexte `registration` refuse un numéro réservé à un compte utilisable (`isActive=true`, statut ni `inactive` ni `suspended`), y compris un compte `pending_kyc` ; il ne doit pas être utilisé pour régulariser un compte existant. Les contextes `login` et `update` n'envoient pas de code aux comptes indisponibles.

Un changement de numéro par `PUT /api/v1/users/me` remet le statut à `false`. Une mise à jour de profil qui ne change pas le numéro préserve le statut actuel.

Une vérification faite **avant** la création du compte ne prouve pas automatiquement l'inscription ultérieure : l'API actuelle ne transmet pas de preuve liée à cette inscription. Le compte reste donc marqué comme à vérifier, même si un code a été saisi avant l'inscription. Ce comportement conservateur évite de déclarer vérifié un numéro sans preuve rattachée au compte. De même, les comptes historiques avec `isPhoneVerified=false` restent « preuve inconnue/à refaire » : ce statut ne permet pas de conclure qu'aucun OTP n'a jamais été envoyé.

Pour préparer une activation future, filtrer les comptes actifs avec téléphone et `isPhoneVerified=false`. Exclure les comptes supprimés/anonymisés et prévoir une relance progressive ; ne pas basculer globalement vers une obligation OTP avant de valider la délivrabilité, les coûts et le parcours mobile. Le changement de fournisseur Didit/Keccel ne modifie pas ce suivi.

## Réinscription après suppression, désactivation ou suspension

La suppression via `DELETE /api/v1/users/me` anonymise déjà le compte et retire son numéro. Pour les comptes historiques qui ont conservé un numéro malgré leur désactivation ou suspension, l'envoi d'OTP d'inscription est autorisé, sans modifier l'ancien compte.

À la création effective du nouveau compte (PIN, nouvelle identité Google ou Apple), une transaction verrouille le numéro, revérifie sa disponibilité, détache le numéro de l'ancien compte indisponible et crée un compte distinct. L'ancien compte reste désactivé ; ses sessions et son jeton push sont révoqués. Son UUID, son statut, ses données KYC, ses trajets, ses gains et son historique restent attachés à lui, sans transfert ni réactivation. L'ancien état de vérification téléphonique n'est pas hérité.

Si la création échoue, le détachement est annulé. Deux inscriptions concurrentes ne peuvent pas réserver le même numéro : le contrôle final et la contrainte unique PostgreSQL restent en place. Aucun changement de schéma ou variable d'environnement n'est requis.

Choix métier : un numéro associé à un compte suspendu est également réutilisable pour un **nouveau** compte ; la suspension de l'ancien compte ne constitue donc pas une interdiction de se réinscrire avec ce numéro. Les connexions ou liaisons à une identité Google/Apple déjà rattachée restent soumises aux contrôles existants : ce mécanisme ne transfère pas ces identités.

Ces changements conservent les endpoints et réponses existants ; aucune mise à jour mobile n'est nécessaire. Ils n'imposent pas encore d'OTP obligatoire à l'inscription.
