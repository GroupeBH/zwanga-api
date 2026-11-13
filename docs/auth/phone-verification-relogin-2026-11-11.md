# Vérification téléphonique et reconnexion — 11 novembre 2026

## Signalement et diagnostic

Un numéro déjà validé par OTP est redemandé après déconnexion/reconnexion.
La version mobile et le titre exact du modal restent à confirmer. Aucune lecture
ni modification AWS n'a été réalisée dans cette intervention.

Le code local de `AuthService.logout` révoque les sessions et le jeton push, mais
ne modifie pas `isPhoneVerified`. La connexion et le renouvellement des sessions
ne doivent pas effacer cette preuve non plus. Le mobile lit `GET /users/me` ;
`AccountPhoneVerificationGate` reste fermé dès que le profil du compte courant
renvoie explicitement `isPhoneVerified=true`. Le code SMS et son état Redis sont
temporaires ; la validation du numéro est un état PostgreSQL persistant.

Le scénario avec un OTP téléphonique à cinq chiffres, puis trois déconnexions et
reconnexions avec les formats local, international sans `+` et avec `+`, conserve
bien le statut vérifié dans les tests PostgreSQL. **La redemande du parcours
ordinaire n'est pas reproduite localement** : ne pas annoncer sa résolution en
production sans vérifier la version et le compte concernés.

## Incohérence corrigée localement

Les codes SMS dédiés à la réinitialisation/modification du PIN étaient bien
validés, mais cette preuve ne renseignait pas `users.isPhoneVerified`. Un compte
non vérifié pouvait donc recevoir un second modal téléphonique à sa connexion.

- `AuthService.verifyPinResetOtp` marque désormais le numéro vérifié après
  validation et consommation du challenge. L'écriture cible l'identifiant, le
  numéro exact, le rôle et le statut lus avant validation ; le compte doit rester
  actif. Aucun jeton de réinitialisation n'est émis si cette écriture échoue.
- `UsersService.changePin` persiste la validation avec le nouveau PIN dans
  l'écriture conditionnelle existante, après ancien PIN et OTP dédiés valides.
- Aucune migration, aucune mise à jour globale des comptes historiques, aucune
  récupération d'un code OTP depuis les logs. Les numéros équivalents de comptes
  distincts ne reçoivent pas la preuve d'un autre compte.
- Les futurs changements de PIN, opérations financières et changements réels
  de numéro gardent leurs contrôles. Les codes de cinq et six chiffres ne sont
  pas interchangeables. Les styles et sources mobiles ne sont pas modifiés.

Le guide PostgreSQL a orienté l'écriture conditionnelle ciblée et l'absence de
verrou SQL conservé pendant l'appel au fournisseur SMS.

## Vérifications

- 106 tests unitaires backend ciblés réussis : PIN oublié, changement de PIN,
  vérification téléphonique et inscription PIN/Google/Apple.
- 46 tests PostgreSQL 18 isolés réussis : persistance après reconnexion,
  normalisation, comptes désactivés, conflits actifs et changement concurrent de
  numéro, rôle, statut ou activation pendant la vérification.
- 38 tests JavaScript mobiles existants réussis : politique du modal, lecture du
  profil après OTP, confirmation après panne réseau, changement de session et
  preuve d'inscription. Ce ne sont pas des essais sur téléphone physique.
- TypeScript backend sans émission réussi.
- Non-régression complémentaire : 114 tests réussis sur les sessions, les identités,
  les fournisseurs OTP et les OTP financiers. Les 17 tests Redis optionnels sont
  ignorés faute d'environnement dédié activé ; pas de validation Redis réelle
  revendiquée pour cette intervention.

Le premier démarrage PostgreSQL a échoué dans le sandbox avant les assertions ;
la relance autorisée sur une base temporaire locale a réussi. Les SMS sont simulés,
la base de travail et la production sont inchangées. Pas de déploiement réalisé.

## Suite du diagnostic du signalement

Confirmer le titre du modal, la version installée et le type de code précédemment
validé. Pour un OTP téléphonique à cinq chiffres déjà confirmé, vérifier ensuite
que la reconnexion retrouve le même identifiant de compte et que `/users/me`
renvoie bien le booléen persistant, sans publier de numéro complet, PIN, code OTP
ou jeton de session. Ne pas masquer le modal en mémorisant un simple booléen local
qui contournerait la vérification serveur.
