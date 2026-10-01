# Suivi des comptes sans vérification OTP du téléphone

L'inscription par PIN, Google ou Apple reste possible sans OTP téléphonique. Le champ persistant `users.isPhoneVerified` est la source de vérité : `false` signifie qu'aucune preuve OTP n'est attachée au compte. Il reste `false` par défaut à chaque inscription sans preuve ; aucun nouveau champ ou migration n'est nécessaire.

`GET /api/v1/users/me` renvoie `user.isPhoneVerified` et le signal dérivé `user.phoneVerificationRequired`. L'application pourra plus tard utiliser ce signal pour demander la vérification, sans changer le contrat d'inscription actuel. Le backend **ne bloque pas encore** la connexion ni les autres parcours sur ce statut.

Pour un compte existant, `POST /api/v1/users/phone/send-otp` avec `context: "login"`, puis `POST /api/v1/users/phone/verify` avec le code reçu mettent `isPhoneVerified` à `true` uniquement après validation réussie chez le fournisseur OTP actif. Un code invalide ne modifie rien. Le contexte `registration` de l'envoi refuse un numéro déjà inscrit ; il ne doit pas être utilisé pour régulariser un compte existant.

Un changement de numéro par `PUT /api/v1/users/me` remet le statut à `false`. Une mise à jour de profil qui ne change pas le numéro préserve le statut actuel.

Une vérification faite **avant** la création du compte ne prouve pas automatiquement l'inscription ultérieure : l'API actuelle ne transmet pas de preuve liée à cette inscription. Le compte reste donc marqué comme à vérifier, même si un code a été saisi avant l'inscription. Ce comportement conservateur évite de déclarer vérifié un numéro sans preuve rattachée au compte. De même, les comptes historiques avec `isPhoneVerified=false` restent « preuve inconnue/à refaire » : ce statut ne permet pas de conclure qu'aucun OTP n'a jamais été envoyé.

Pour préparer une activation future, filtrer les comptes actifs avec téléphone et `isPhoneVerified=false`. Exclure les comptes supprimés/anonymisés et prévoir une relance progressive ; ne pas basculer globalement vers une obligation OTP avant de valider la délivrabilité, les coûts et le parcours mobile. Le changement de fournisseur Didit/Keccel ne modifie pas ce suivi.
