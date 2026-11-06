# Correctifs locaux de sécurité et performance du 6 novembre 2026

Cette livraison complète l’audit `audit-2026-11-06-performance-securite.md`. Elle modifie le backend et les formulaires financiers de `zwanga-admin`, sans changer leur CSS. Aucun déploiement, push, changement AWS, modification Terraform ou workflow CI n’a été effectué. Les autres modifications déjà présentes dans les dépôts sont conservées.

## Confirmation OTP des opérations financières

Les virements libres et les relances de retraits conducteur/parrainage exigent désormais un OTP supplémentaire du super administrateur. Cette protection ne change ni les soldes, ni les règles de retrait, ni la vérification de non-exécution par FlexPay.

1. Remplir le virement ou les justificatifs de relance, puis demander le code.
2. `POST /api/v1/admin/finance/otp` reçoit `action`, `payload` et, pour une relance, `targetId`. Les actions possibles sont `direct_payout`, `driver_payout_retry` et `referral_withdrawal_retry`.
3. Le backend relit le compte super admin actif, sans changement initial de mot de passe en attente. Le SMS part vers **son numéro enregistré**, jamais vers un numéro choisi dans le formulaire de confirmation.
4. Le code comporte six chiffres et expire après quinze minutes. Redis conserve une empreinte HMAC, pas le code en clair. Cinq essais sont autorisés, et la validation est consommée atomiquement une seule fois.
5. Envoyer `otpCode` avec la requête financière habituelle. Le code est lié à l’administrateur et à l’opération exacte : identifiant d’idempotence, numéro, montant, devise et motif pour un virement ; retrait, type de relance et preuves pour une relance. Une modification exige un nouveau code.

Les trois routes protégées sont :

- `POST /api/v1/admin/payments/direct-payouts`
- `POST /api/v1/admin/driver-payouts/:id/retry`
- `POST /api/v1/admin/referrals/withdrawals/:withdrawalId/retry`

Les erreurs `FINANCE_OTP_REQUIRED` et `FINANCE_OTP_INVALID` refusent l’exécution. Le code n’est transmis ni au service financier ni au prestataire de paiement. Il n’est pas conservé dans le stockage navigateur ; les actions financières sont expurgées dans Redux DevTools, désactivé en production. Une modification du téléphone d’un compte administrateur via la modification ordinaire du profil est refusée : son changement doit passer par une procédure de support contrôlée.

L’envoi financier utilise explicitement Mobishastra et nécessite la configuration SMS, `OTP_CODE_HMAC_SECRET`, Redis et, si requis, le proxy et l’IP autorisée. **Sans ces dépendances, les virements et relances protégés restent bloqués**, sans repli vers un OTP non lié à l’opération. Aucune nouvelle clé HMAC distincte n’est nécessaire.

Déployer les formulaires admin et le backend de manière coordonnée. Un ancien formulaire ne fournissant pas le code ne pourra plus exécuter ces actions. Après un résultat de paiement incertain, vérifier le même ordre et conserver son identifiant d’idempotence ; ne jamais créer un nouvel ordre simplement pour contourner l’OTP ou le statut en attente. Un nouveau code ne prouve pas la non-réception d’un retrait : la preuve prestataire reste obligatoire.

La protection est un renforcement par SMS, pas une double approbation ni une MFA résistante au phishing. Les plafonds cumulés et une validation par une seconde personne restent des décisions métier à définir.

## Correspondance avec les constats d’audit

| Constat | Correction locale | Reste à réaliser |
| --- | --- | --- |
| F01 Plan Terraform sensible | Retrait de `infra-aws/tfplan` du suivi Git, fichier local conservé ; règles d’exclusion et test de fichiers interdits | Rotation coordonnée des secrets concernés, vérification de diffusion et traitement de l’historique/copies. Le retrait courant ne purge pas l’historique. |
| F02 Proxy de confiance | Validation d’IP/CIDR explicites ; rejet des valeurs universelles et avertissement de configuration absente en production | Injecter les véritables CIDR des proxies approuvés dans ECS et vérifier les IP clientes et les quotas derrière ALB. |
| F03 Identité SQL runtime | Support existant de `MIGRATION_DATABASE_URL` conservé | Séparer les rôles runtime/migration et vérifier grants, fonctions et triggers. Aucun rôle ou droit de base n’a été modifié. |
| F04 Index bloquants | Dix constructions concurrentes, contrôle de validité, reprise des index invalides et budgets de durée ; exécution TypeORM en mode `each` | Tester la durée sur un volume représentatif avant déploiement ; surveiller les verrous et index invalides. |
| F05 Confirmation financière | OTP obligatoire sur les trois routes et deux formulaires admin | Recette SMS réelle avec un numéro contrôlé ; choix des plafonds/double approbation. |
| F06 Disponibilité AWS | Aucune modification d’infrastructure | Redondance API/Redis/RDS et reprise du proxy à planifier et tester, avec budget et fenêtre de changement. |
| F07 Exports non bornés | Sept exports AdminService lus par lots de 500, flux XML, deux exports simultanés par processus et délai maximal ; arrêt sur déconnexion | Anciens historiques détaillés utilisateur, route KYC historique et exports parrainage hors de ce lot ; éventuelle génération asynchrone sur stockage privé. |
| F08 Liste admin N+1 | Hydratation des demandes par lots de 100, abonnements et fenêtres/refus groupés, sérialisation séquentielle des demandes | Mesurer sur volumétrie représentative ; les transitions d’expiration transactionnelles conservent leurs contrôles individuels. |
| F09 Recherche | UUID complets comparés nativement, suppression des CTE matérialisées | Recherches partielles et comptes exacts encore coûteux : mesurer les plans puis choisir les index trigrammes pertinents. |
| F10 Dépendances/CI | Test de fichiers sensibles intégré à la suite Jest existante | Tri et mise à jour ciblée des dépendances, scan de secrets/contenu/images et adaptation CI séparée. Aucun `audit fix --force` appliqué. |
| F11 Anti-abus avant SQL | Garde IP partagé Redis avant JWT, configurable, quotas existants conservés | Définir et activer `PRE_AUTH_IP_LIMIT_PER_MINUTE` après configuration de confiance ALB ; valeur par défaut 0, désactivée. WAF et observabilité AWS non modifiés. |

## Migration et téléchargements

Le mode `each` maintient les transactions des migrations ordinaires mais autorise l’indexation concurrente hors transaction. Les migrations précédentes restent appliquées si une migration suivante échoue : contrôler la table des migrations avant de relancer. La nouvelle migration répare les index invalides laissés par une construction interrompue.

Le rollback standard TypeORM utilise une transaction même si une migration indique `transaction=false`. La suppression des index dans ce cas est bornée par un `lock_timeout` de trois secondes et un `statement_timeout` de trente secondes. Un rollback explicitement hors transaction emploie `DROP INDEX CONCURRENTLY`. Aucun index ni table métier n’a été changé dans les bases applicatives pendant les tests.

Les exports trajets, réservations, demandes, paiements et grand livre utilisent un curseur date/UUID conservant les microsecondes. Les exports utilisateurs et comptes de portefeuille conservent leurs tris existants avec des pages bornées. Les exports ne constituent pas un instantané transactionnel immuable : des modifications concurrentes peuvent affecter leur contenu, surtout avec le tri par nom ou date de mise à jour. Un échec en cours de téléchargement interrompt le flux ; il ne produit pas volontairement un fichier réussi incomplet.

## Vérification et limites

- Tests HTTP des trois routes financières : authentification, rôle, compte actif, intention modifiée, code incorrect/absent, utilisation unique et retrait du code avant exécution.
- Redis jetable : 17 tests réussis, dont concurrence de 20 validations, expiration, cinq essais et absence de repli non lié à l’opération. Aucun vrai SMS envoyé.
- PostgreSQL jetable : 14 tests réussis, dont export de plus de 1 000 trajets, conservation des microsecondes après suppression du dernier élément d’une page, migration TypeORM, réexécution et rollback.
- Tests backend ciblés : 229 tests réussis dans 18 suites. Une seconde exécution, avec la configuration Jest/TypeScript habituelle, valide 91 tests dans neuf suites, dont les contrôleurs financiers et les tests corrigés.
- Tests admin : 58 tests réussis couvrant les formulaires financiers, le rapprochement, l’OTP, sa confidentialité et l’idempotence des campagnes. Les contrôles incluent le double clic, le changement d’intention et une réponse SMS tardive. Aucun style modifié par cette livraison ; les modifications de style préexistantes sont conservées. Aucune recette visuelle de navigateur ni vrai virement exécuté.
- Vérification TypeScript backend et admin réussie. L’environnement local utilise Node 24.11.0, inférieur au minimum 24.22.1 déclaré par le projet : la CI avec la version supportée reste nécessaire.
- Le premier passage de la suite générale a exécuté 304 suites : 299 réussies, cinq en échec et 43 autres suites ignorées (3 669 tests réussis, 17 en échec, 830 ignorés). Les cinq échecs provenaient de simulations devenues incompatibles avec les contrôles transactionnels des comptes et le nouveau type d’alerte ; leurs simulations/attentes ont été corrigées, sans retirer les protections applicatives. Les cinq suites passent désormais dans les relances ciblées ci-dessus. La suite générale entière n’a pas été relancée après ces corrections : ne pas assimiler ces résultats à une exécution intégrale verte, ni les tests ignorés à des validations.
- La suite générale et la compilation doivent rester des prérequis au déploiement. Ces contrôles ne prouvent ni la disponibilité des fournisseurs réels, ni l’absence de vulnérabilité, ni un gain de latence mesuré en production.

Les grilles de sécurité JavaScript/Express et PostgreSQL ont guidé la liaison de l’OTP à l’intention, les contrôles d’autorisation, la lecture par lots et la stratégie de verrous. Les correctifs locaux ne règlent pas seuls les opérations AWS et la rotation de secrets.
