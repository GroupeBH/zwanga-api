# Journal des modifications financières

## 2026-10-08 — Deuxième réparation UUID, réservation et accueil cohérent

- La réparation 57 de publication ne couvrait pas `zwanga_booking_cash_guard`.
  Les logs locaux montrent un second HTTP 500 à l'insertion de réservation ;
  trois trajets provisoires sans réservation restaient affichables pour une
  demande toujours en attente. Aucune preuve de démarrage réussi pour ces essais.
- Migration additive 58 `FixBookingRequestUuid` : deux conversions du lien
  varchar en UUID, à la lecture de la demande puis au transfert de réserve.
  Corps déployé préservé, transaction et délais bornés, forme inconnue refusée,
  idempotence. Commission 5 %, dette 25 jetons, tous types de jetons débitables,
  réserves et soldes inchangés. Les anciennes migrations ne sont pas réécrites.
- Outil local de réparation étendu à 57/58 ; migration 58 appliquée à la base
  locale/non-production autorisée. Relecture : aucune migration en attente et
  conversions présentes. Aucun trajet, réservation ou portefeuille modifié.
  Les trois anciens trajets incomplets attendent une autorisation d'annulation.
  Aucun déploiement ou migration en production.
- `cancel-empty-request-trip.ts` + services trips/trip-requests : compensation
  d'un trajet privé provisoire uniquement si la création de réservation échoue
  et qu'aucune réservation n'existe. Verrou de ligne, lecture fraîche, identité
  demande/conducteur et statut vérifiés. Préserve les réservations déjà validées
  en base et l'erreur initiale ; cache invalidé après annulation. Ne garantit pas
  l'atomicité globale du parcours ni le nettoyage si la base est indisponible.
- Tests : 43 unitaires serveur ; 94 réussis / 3 ignorés sur PostgreSQL 18 isolé,
  incluant les deux comparaisons varchar réelles, transfert sans double débit,
  capture à la fin et compensation ciblée. Typage serveur de production vérifié.
  Fixture PL/pgSQL recompilée après changement de type de test pour éliminer son
  plan ancien ; aucun changement du type de colonne de l'application.
- Mobile associé : actualisation des caches après confirmation serveur uniquement,
  garde de session, premier candidat Home disponible ; 158 tests JavaScript
  ciblés réussis. Journal détaillé : `../zwanga/docs/CHANGEMENTS_TECHNIQUES.md`
  (dans le dépôt mobile voisin). Pas de test physique ni de trajet réel déclenché.

## 2026-10-08 — Correction UUID du contrôle de publication privée

- HTTP 500 à l'acceptation d'une demande : `zwanga_publication_cash_guard`
  comparait un UUID à `NEW."tripRequestId"` déclaré varchar. Migration additive
  `1780000057000-FixPublicationRequestUuid` : conversion du lien en `::uuid`, sans
  modifier les autres instructions de la fonction installée, les anciennes
  migrations, les colonnes, montants, soldes ou réserves. Migration enregistrée
  dans `src/database/migrations/index.ts` ; transaction obligatoire, délais de
  verrou/requête bornés, forme inconnue refusée et correction idempotente.
- La commission de 5 %, la tolérance de 25 jetons, la protection contre la double
  réserve dispatch et le drapeau d'activation restent inchangés. Aucun index
  rendu inutilisable par une conversion de sa colonne UUID en texte.
- `src/database/repair-local-publication-uuid.ts` : lecture seule par défaut,
  `--apply` exige une cible locale/non-production et cette seule migration en
  attente ; fonction et journal des migrations modifiés dans une seule transaction.
- Application réellement faite à la base locale de développement confirmée par
  l'utilisateur ; relecture réussie, aucune migration restante et cast présent.
  Aucune donnée métier modifiée, aucune acceptation/démarrage de trajet réel.
  Aucun déploiement/migration en production ; les autres environnements doivent
  recevoir cette migration via leur procédure habituelle.
- Vérifications : 3 tests unitaires migration réussis ; PostgreSQL 18 éphémère :
  88 tests réussis et 3 ignorés, dont 5 nouveaux cas de régression avec un lien
  varchar conforme au schéma applicatif. Reproduction de 42883 avant correctif,
  création privée après, invariance des soldes et maintien des contrôles financiers.
  TypeScript de production sans émission réussi. Aucun essai natif mobile requis
  pour le SQL, mais le parcours réel n'a pas été exécuté à la place du conducteur.

Ce fichier répertorie les changements qui influencent un prix, un paiement, un solde, une commission, une récompense ou un retrait.

## 2026-10-07 — Confirmation push du KYC admin et Didit

- Correction locale : les approbations automatiques/Didit passent désormais par la même outbox transactionnelle que les approbations admin. Le message ne cite plus une validation par l'équipe quand la décision vient de Didit.
- Décision datée sans renouvellement sur les synchronisations répétées ; confirmation admin du même accord sans second push. Le dispatcher accepte les approbations sans `reviewedBy`, vérifie le dernier dossier et écarte les décisions obsolètes. Les refus manuels restent notifiés.
- Envoi après commit, panne push sans annulation du KYC, reprises et protection de propriété du token conservées. Aucune modification des commissions, de l'éligibilité ou de l'unicité du bonus de bienvenue ; pas de notification rétroactive massive ni de migration supplémentaire.
- Vérifications : suite backend complète **1 363 tests réussis, 146 ignorés** ; 58 tests ciblés inclus dans cette suite ; **27 tests PostgreSQL 18 réussis séparément**, base éphémère et transports simulés. Compilation backend réussie. Aucun déploiement, push réel ou opération financière réelle.
- Fonctionnement, prérequis webhook `status.updated` et limites : [documentation KYC](kyc-didit-integration.md#notifications-dapprobation--7-octobre-2026).

## 2026-10-07 — Transition financière progressive et compatibilité stores

Statut : implémentation locale, aucun déploiement, crédit réel ou appel fournisseur effectué. Cette entrée complète l'audit ci-dessous ; elle ne signifie pas qu'une répétition sur une copie de RDS ou un test des binaires stores a été réalisé.

- Migration **1780000056000-StageFinancialRollout** : phase `prepared` puis activation explicite et à sens unique. Les migrations précédentes ne sont pas réécrites. Les fonctions de réservation/capture, la commission de 5 %, les 25 jetons de tolérance, les origines mixtes, Pro, les bonus et l'outbox sont conservés. Si des commissions existent déjà, la migration conserve la politique active ; elle ne désactive jamais leur traitement.
- `financial-rollout-cli prepare-legacy` vérifie l'absence d'historique cash/activation préalable, puis exécute **toutes les migrations dans une seule transaction**. Avant le commit, les anciens serveurs ne voient pas de schéma intermédiaire ; après le commit, les nouveaux contrôles cash sont en attente. Il faut utiliser cette procédure de déploiement, pas appliquer les migrations une par une avec des commits intermédiaires.
- Durant la préparation, les engagements cash restent sous la politique historique 0, sans nouvelles réserves pouvant bloquer les débits de l'ancien serveur. À l'activation, seules les demandes/réservations encore en attente passent à la politique 2. Les trajets déjà acceptés ne sont pas refacturés. Les déclencheurs couvrent aussi une création en attente concurrente avec l'activation.
- La contrainte d'unicité push est différée durant le premier remplacement pour laisser fonctionner l'ancien enregistrement d'appareil. Le nouveau dispatcher refuse les destinataires à propriété de token ambiguë. À l'activation, nettoyage transactionnel des doublons et recréation de l'index. Le déclencheur différé de bienvenue est exécuté avant ce DDL, évitant l'erreur PostgreSQL « pending trigger events ». Les appareils concernés par un doublon doivent réenregistrer leur token ; aucune propriété n'est attribuée arbitrairement.
- Publication historique sans modes explicites : si la couverture cash manque, la publication conserve les modes électroniques/jetons au lieu d'échouer globalement. Un choix cash explicite reste strictement contrôlé ; aucune exemption de commission n'est créée. `paymentModesExplicit` est conservé aussi pour les trajets récurrents. Les refus cash restent explicites lors d'une réservation/paiement incompatible.
- `WalletCompatibilityInterceptor` ne modifie que la représentation HTTP : sans `X-Zwanga-Finance-Contract: 2`, le solde et le montant retirable correspondent aux fonds disponibles, réserves déduites. Les soldes persistés, écritures et origines ne changent pas. Les totaux restent exposés dans des champs additionnels. La nouvelle app annonce le contrat 2 et conserve son affichage détaillé des réserves. L'ancien build 145 n'a aucun nouvel en-tête obligatoire à envoyer.
- Résilience : un débit protégé par `CHK_wallet_cash_reserve` produit un conflit explicatif, les erreurs transitoires PostgreSQL connues un 503, sans réexécution automatique d'une opération financière. `/health` vérifie aussi le contrat du schéma et la fonction d'activation, avec instruction SQL bornée. Les réglages de débit, seuils et mécanismes d'idempotence existants sont préservés.
- Les recommandations PostgreSQL ont guidé la transaction atomique de préparation, l'ordre des verrous, les délais bornés et le traitement des déclencheurs différés. Les transactions d'activation ne font aucun appel réseau fournisseur.

Déploiement : suivre l'entrée correspondante dans `infra-aws/docs/CHANGELOG.md`. Préparer d'abord les permissions IAM et la configuration ECS via un plan Terraform relu. Le workflow remplace les serveurs puis active automatiquement les règles, uniquement après vérification de l'arrêt des anciennes tâches. Aucune nouvelle valeur secrète/SSM requise ; `ZWANGA_FINANCE_CONTRACT=1` est un marqueur technique de la définition de tâche, pas un commutateur utilisateur.

Reprise : si le remplacement échoue avant activation, l'image précédente épinglée reste compatible avec la phase préparée. Relancer le workflow est possible sans double bonus/capture. Si l'activation a réussi, **ne jamais revenir à un backend pré-contrat** et ne pas lancer de `migration:revert` financier ; conserver le nouveau serveur et corriger en avant. Une tâche d'activation échouée n'autorise pas à supposer que son commit n'a pas eu lieu : vérifier `financial_rollout`, puis relancer la procédure idempotente.

Vérifications : **1 353 tests backend réussis, 141 ignorés** dans la suite générale ; **105 tests PostgreSQL 18 réussis** dans les clusters jetables, 3 diagnostics historiques ignorés. Ces tests couvrent préparation, ancien débit, activation, courses historiques, frontière d'activation, frais mixtes, bonus et tokens push. Les tests AWS simulés couvrent migration échouée, rollback ECS et ancienne tâche encore en arrêt. **24 tests mobiles ciblés réussis**, compilation backend et TypeScript mobile réussis, `terraform validate` réussi. Le CLI de préparation borne aussi ses connexions (5 s), attentes de verrou (5 s), instructions et transactions inactives (60 s), sans modifier les paramètres des requêtes API. Limites : pas de RDS cloné/PostGIS complet, pas de charge production, aucun push réel ni test sur téléphone physique.

## 2026-10-07 — Commission cash sur tous les types de jetons

- Problème : seuls les jetons retirables alimentaient les réserves/commissions cash.
- Migration en avant `1780000055000-CashCommissionAllTokenOrigins` et SQL
  `cash-all-token-origins.ts` : capacité sur solde total libre, réserve prioritaire
  sur les bonus, capture et remboursement traçant la part retirable réellement
  débitée (`chargedWithdrawableTokens`). Reprise historique sans recalcul de taux.
- Tous les crédits points peuvent régulariser une dette, y compris bienvenue,
  fidélité, récompenses, partages, ajustements et remboursements. Les dettes
  existantes sont rapprochées avec les fonds déjà éligibles lors de la migration.
- `wallet-origin.ts`, `wallet.service.ts`, `wallet-account.entity.ts` et
  `driver-finance.service.ts` : fonds réservés protégés et disponibilité retirable
  cohérente. Les bonus restent non retirables. Commission 5 %, dette 25 jetons,
  blocage des nouveaux engagements cash et exception de fin de course conservés.
- Tests : 134 unitaires backend, 73 PostgreSQL 17 éphémères réussis, dont 16 cas
  de nouvelle politique ; 3 diagnostics historiques opt-in ignorés. TypeScript
  applicatif validé. Aucun `.env`, paiement réel, migration applicative ni déploiement.
- Déploiement coordonné requis : ne pas laisser d'ancien serveur financier
  traiter les nouvelles réserves mixtes. Les incompatibilités de l'audit ci-dessous
  ne sont pas déclarées résolues. Pas de rollback automatique de données financières.
- Détails et vérifications mobile :
  [journal technique mobile](../../../zwanga/docs/CASH_COMMISSION_CREDIT.md#extension-à-toutes-les-origines--7-octobre-2026).

## 2026-10-07 — Audit de compatibilité AWS et versions stores

**Verdict : ne pas déployer l'ensemble du lot financier tel quel en remplacement progressif.** Les consignes d'activation ci-dessous ne constituent pas une validation de compatibilité avec l'ancien serveur.

- Contrôles AWS en lecture seule : service ECS sain, définition `zwanga-api-production-api:13`, image active correspondant au commit `0622209641443e0d5809a974f9c5900f652d6bd5` (3 octobre). RDS utilise PostgreSQL 18.3. Le remplacement est progressif (`minimumHealthyPercent=100`, `maximumPercent=200`), sans circuit breaker/rollback automatique activé. Aucune migration ni écriture en production pendant cet audit.
- Référence mobile fournie : Android 1.0.16/build 145. Les métadonnées EAS associent ce build au commit `97f93bb8f51f56823003944b61e5f7ab1cc7f059` ; le build iOS associé au même commit est 1.0.16/131. EAS établit la provenance du build, pas son statut de publication effectif dans les stores ni les éventuelles mises à jour OTA.
- Validation du code actuel : suite backend **1 328 tests réussis / 112 ignorés**, suite mobile **1 502 réussis**, compilation backend et contrôle TypeScript mobile réussis. Puis **82 tests PostgreSQL 18 isolés réussis**, dont **3 scénarios d'audit qui confirment des incompatibilités attendues** : ce dernier résultat n'est donc pas un feu vert de déploiement.
- Les migrations sont exécutées avant le remplacement de l'ancien serveur dans `.github/workflows/deploy.yml`. Sur le schéma migré, le code du commit réellement déployé ne reconnaît pas les nouveaux refus de commission cash : acceptation de réservation et publication avec fonds insuffisants peuvent devenir des HTTP 500. Son calcul de débit ignore aussi `reservedCashCommissionBalance` ; la contrainte PostgreSQL protège le solde mais rejette certains débits avec une erreur 500. Reproductions conservées dans `driver-finance-postgres.spec.ts`, opt-in `DEPLOYED_BACKEND_AUDIT_COMMIT` en plus du chemin PostgreSQL de test.
- Exécution en mémoire des adaptateurs du commit mobile du build 145 : lecture du bonus `loyalty_reward` et des nouveaux champs sans exception ; les push de bienvenue/transfert retombent sur l'accueil, pas sur le portefeuille. En revanche, cet ancien client ignore la réserve cash et peut afficher 50 jetons retirables alors que 5 sont réservés et seulement 45 disponibles. Il ne propose pas non plus la sélection des modes acceptés à la publication.
- Avant activation globale : préparer une phase backend rétrocompatible, dissocier l'installation du schéma de l'activation des contraintes métier, puis valider les parcours cash/retrait sur les anciens clients. La distribution du bonus et les push de transfert ne présentent pas, dans les contrats examinés, la même rupture que l'activation immédiate du nouveau modèle cash.

Limites : pas d'exécution des binaires stores sur téléphone, pas de test de livraison push réelle, pas de lecture de la table des migrations RDS et pas de répétition de toute la chaîne sur une copie de production avec PostGIS. Les tests PostgreSQL utilisent des schémas de test réduits et des transports push simulés. Seuls des tests d'audit et cette note ont été ajoutés pendant cette vérification ; aucune correction applicative ni aucun déploiement.

## 2026-10-07 — Push de transfert et rattrapage prioritaire des conducteurs

Statut : code local, sans déploiement, crédit réel ou push réel.

- Les transferts `WalletService.transferPoints` créent déjà deux écritures atomiques. Le subscriber transactionnel existant prépare une confirmation `wallet_transfer_out` pour l'expéditeur et `wallet_transfer_in` pour le destinataire ; il est conservé pour ne pas créer un deuxième circuit de push. `financial-notification.policy.ts` ajoute le `transferId` commun aux deux messages. Le montant et le solde sont indiqués, sans exposer la note libre du transfert sur l'écran verrouillé.
- Tests PostgreSQL du **vrai service de transfert, du subscriber et du dispatcher** : deux notifications après succès, envoi après commit, déduplication par écriture ; un échec du crédit destinataire annule les deux écritures et notifications. Un solde insuffisant ne produit aucune confirmation. Le transport Expo est simulé, pas contacté.
- Le cron de bienvenue existant est nommé `welcome-bonus-catch-up`, exécuté toutes les minutes sans chevauchement local. La migration **`1780000054000-PrioritizeDriverWelcomeBonus`** remplace sa fonction de sélection : conducteurs d'abord, puis passagers dans la capacité restante, au maximum 100 comptes examinés par passage et par instance. `SKIP LOCKED` permet aux autres instances de continuer ; un conducteur occupé est repris au passage suivant.
- Il s'agit du **même bonus de 50 jetons**, pas d'une nouvelle campagne : la preuve `welcome_bonus_grants` et le marqueur d'écriture `welcome_bonus` sont réutilisés. Aucun second crédit si un conducteur a déjà reçu le bonus en tant que passager ou lors de son KYC. Les notifications du bonus restent atomiques avec le crédit. Les recommandations PostgreSQL ont guidé les transactions bornées, les verrous et la sélection sans tri global par rôle.
- **Éligibilité inchangée en l'absence de confirmation d'un élargissement : compte actif et dernier KYC approuvé.** Pas de bonus aux comptes supprimés, suspendus ou encore en attente de KYC. Les jetons restent promotionnels/non retirables ; aucune modification des commissions ou de la tolérance cash introduite par la migration `1780000053000`.
- Mobile `zwanga` : les deux push de transfert ouvrent le portefeuille et invalident son cache à la réception au premier plan et à l'ouverture. Pas de changement d'endpoint, de payload obligatoire ou de règle de transfert. Les anciennes versions peuvent recevoir le texte push ; le nouveau routage nécessite la mise à jour mobile.

Déploiement : migrations jusqu'à `1780000054000` dans l'image compilée (`npm run migration:run:prod`), puis déploiement des instances backend, avec `TYPEORM_SYNCHRONIZE=false`. Aucune nouvelle variable d'environnement. Les migrations préexistantes de notifications et de bonus restent nécessaires. Le cron démarre automatiquement ; les logs `Welcome bonus: N accounts credited` et la table `welcome_bonus_grants` permettent le contrôle. Sans déploiement, les comptes de production ne sont pas modifiés.

Validation locale : **117 tests backend ciblés réussis**, incluant les tests PostgreSQL des transferts/notifications et des invariants financiers/bonus dans des clusters jetables ; **17 tests mobiles de navigation réussis**. Contrôles TypeScript production backend et mobile réussis. Aucun test sur téléphone physique ; aucun fournisseur push contacté. La suite backend complète n'a pas été relancée pour ce complément.

## 2026-10-07 — Bonus de bienvenue après validation du compte et du KYC

Statut : implémentation locale ; aucun compte réel crédité, aucune migration applicative ni opération AWS exécutée.

- **50 jetons, une seule fois par compte**, conducteur ou passager. Conditions cumulatives : `isActive=true`, `status=active`, dernier dossier KYC `approved` (ordre `createdAt DESC, id DESC`). Les comptes suspendus, inactifs, en attente, sans KYC approuvé et les rôles administratifs sont exclus. Un simple indicateur téléphone/email vérifié ne suffit pas ; inversement, aucune nouvelle obligation OTP n'est introduite.
- Bonus promotionnel : `balance += 50`, `withdrawableAmount=0`. Le solde acheté/retirable et les réserves de commissions cash ne sont pas augmentés. Le bonus ne règle pas une dette de commission cash. Les règles de fidélité, parrainage, Pro et commissions restent inchangées.
- Migration `1780000052000-AddVerifiedWelcomeBonus` : preuve durable `welcome_bonus_grants`, index unique d'écriture de bienvenue, index d'éligibilité et de dernier KYC. Déclencheurs différés sur utilisateurs et KYC : validation manuelle, Didit et SQL suivent la même règle à la fin de la transaction, quel que soit l'ordre des deux validations. Un rejet ou une suspension avant commit empêche l'attribution.
- Revalidations, rappels Didit, concurrence et reprise après redémarrage ne produisent pas un second crédit. La preuve reste présente si le document KYC ou l'historique portefeuille est remplacé. La garantie porte sur l'identifiant du compte : ce n'est pas une détection universelle des comptes multiples d'une même personne. Les anciens ajustements administratifs sans marqueur de bienvenue ne sont pas interprétés comme ce nouveau bonus.
- Le contrôle PostgreSQL a guidé les contraintes, transactions courtes et verrous : utilisateur avant portefeuille, `NO KEY UPDATE` compatible avec les références des recharges. Si une validation détient déjà un verrou utilisateur fort et rencontre un portefeuille occupé, l'essai de bonus est annulé isolément après contention (250 ms), sans annuler le KYC ; le rattrapage reprend ensuite.
- Crédit, écriture et notification sont atomiques. L'écriture conserve le type existant `loyalty_reward`, avec `relatedEntityType=welcome_bonus` et la description « Bonus de bienvenue : KYC et compte validés », pour rester lisible par les versions mobiles publiées. La push `wallet_loyalty_reward` annonce explicitement **50 jetons de bienvenue** ; clé unique `wallet:<ledgerEntryId>`. Aucun appel réseau sous verrou ; envoi après commit par le dispatcher existant, avec ses reprises. Une panne push ne recrédite pas le compte et n'annule pas le bonus. La réception sur l'appareil exige toujours un token push valable, les autorisations et un fournisseur opérationnel.
- `WelcomeBonusService`, enregistré dans `WalletModule`, rattrape automatiquement les comptes existants : au plus **100 comptes par minute et par instance**, verrous `SKIP LOCKED`, transaction bornée (attente verrou 2 s, instruction 15 s), reprise des comptes encore sans preuve. Aucune nouvelle variable d'environnement ni action utilisateur requise. Les nouveaux comptes éligibles sont normalement crédités dès la validation ; le job couvre aussi les attributions différées par contention.
- Mobile `zwanga` : toucher la confirmation de bienvenue ouvre `/wallet`. L'historique existant affiche déjà la description explicite et les 50 jetons. Sur une ancienne version mobile, crédit et texte push fonctionnent sans mise à jour ; le nouveau raccourci au clic nécessite la version intégrant ce changement.

### Activation et contrôle

1. Recette/staging et sauvegarde habituelles, puis image backend compilée. Garder `TYPEORM_SYNCHRONIZE=false` : les fonctions et déclencheurs nécessitent la migration, pas la synchronisation d'entités.
2. Exécuter les migrations via la tâche ECS habituelle (`npm run migration:run:prod` dans l'image compilée), jusqu'à `1780000052000`, puis déployer les instances backend. **Le déploiement active le rattrapage automatiquement** ; la migration ne distribue pas tout l'historique dans sa transaction DDL. Les validations intervenant après installation des déclencheurs peuvent déjà attribuer un bonus.
3. Suivre le journal `Welcome bonus: N accounts credited` et les éventuelles erreurs de reprise. Contrôle agrégé après migration :

```sql
SELECT count(*) AS comptes_credites, coalesce(sum(amount), 0) AS jetons_distribues
FROM welcome_bonus_grants;

SELECT n.status, count(*)
FROM welcome_bonus_grants g
JOIN notifications n ON n."eventKey" = 'wallet:' || g."ledgerEntryId"
GROUP BY n.status;
```

Ne pas utiliser `migration:revert` pour effacer des crédits déjà distribués : le rollback automatique est volontairement refusé. Un éventuel correctif financier doit être explicite et traçable.

Vérifications locales : **1 326 tests backend réussis** (96 tests opt-in ignorés dans cette commande), **63 tests PostgreSQL financiers et de notifications réussis** séparément dans des clusters jetables, **16 tests mobiles de navigation réussis** et contrôles TypeScript production backend/mobile réussis. Les tests PostgreSQL couvrent les deux ordres de validation, les exclusions, le dernier dossier KYC, les transactions annulées, les notifications invisibles avant commit, la concurrence, le rattrapage par lots et les réserves/dettes cash. Deux anciennes fixtures `users.service.fcm-token.spec.ts` ont été alignées sur l'enregistrement transactionnel et l'appartenance exclusive du token push déjà en place ; aucune modification de cette logique de production. ESLint ciblé backend sans erreur. Aucun push réel envoyé ni appareil physique testé.

## 2026-10-07 — Pro, commissions cash préfinancées et modes acceptés

Statut : code backend et application `zwanga` modifiés localement. Aucune migration d’application, modification AWS, transaction réelle ou publication mobile effectuée.

### Règles appliquées

- Pro coûte **5 000 CDF pour 30 jours**, sans renouvellement ou débit automatique. Les anciens paramètres de prix/devise/durée et de prix indépendant en jetons ne remplacent plus cette règle. Le paiement en jetons utilise l’équivalent portefeuille de 5 000 CDF. Les abonnements déjà actifs conservent leurs dates ; une transaction prestataire déjà initiée reste suivie avec son montant d’origine pour éviter un double paiement.
- L’essai offre uniquement Pro pendant **30 jours calendaires**, à partir du premier trajet conducteur terminé (première réservation terminée). Les 5 % restent dus pendant l’essai et avec Pro. Une preuve persistante par compte et empreinte du numéro empêche de renouveler l’essai via l’ancien endpoint ou une réinscription avec le même numéro. Les anciens essais gardent leurs dates, sans prolongation rétroactive. Ce contrôle n’est pas une détection universelle des comptes multiples avec des numéros différents.
- Le **plafond indépendant de 100 000 CDF** n’est pas ajouté : sa période de renouvellement n’a pas été confirmée. Les limites gratuites existantes, dont les cinq publications quotidiennes hors Pro, restent en place. Pas de suspension générale du compte faute de réserve.
- Cash : réserve de 5 % de la somme due par le passager sur les **jetons achetés disponibles**, à l’acceptation de la réservation ; débit lors de la fin de course. Les bonus fidélité, abonnement et crédits administrateur ne financent pas cette réserve. Les jetons achetés reçus par transfert gardent leur origine. À la valeur par défaut de 100 CDF/jeton, 50 jetons financent 100 000 CDF de courses cash.
- Les jetons réservés ne peuvent pas être dépensés, partagés, retirés ou enlevés par un ajustement administratif. Annulation, rejet, expiration, absence ou embarquement incertain libèrent la réserve sans commission. Une récupération GPS d’un faux absent peut terminer la course et comptabiliser un éventuel complément.
- Un changement vers le cash exige une réserve suffisante, même après l’arrivée. Un dépassement du tarif d’une **course cash déjà engagée** ne bloque pas sa fin : le manque devient une dette de commission, bloque de nouvelles acceptations cash et est régularisé, dans l’ordre chronologique, par les prochains crédits de jetons achetés. Les écritures répétées ne redébitent pas la commission. Une baisse du tarif ou un passage à un autre mode avant encaissement libère/rembourse la différence.
- Électronique/jetons : les 5 % sont retenus dans le calcul du gain conducteur ; aucun second débit sur son portefeuille de jetons. Le cash reçu ne devient pas un gain à retirer. Pour toutes les nouvelles réservations version 1, la commission porte sur la **part payée par le passager**, pas sur la subvention Zwanga. Exemple subventionné : tarif 10 000, passager 4 000, subvention 6 000 → commission 200, gain électronique/jetons 9 800. En cash : 4 000 remis au conducteur, commission de 200 financée par ses jetons et 6 000 de subvention à retirer. Les anciennes réservations version 0 conservent leur assiette historique, sans recalcul des gains déjà comptabilisés.
- Conversion figée par réservation. Arrondis aux centimes CDF puis aux centièmes de jeton, comme le portefeuille existant : la valeur effectivement débitée peut différer de la commission théorique d’au plus un demi-centième de jeton. Les nouvelles commissions cash sont limitées au CDF.

### Contrat et fiabilité

- `POST /trips`, `PUT /trips/:id` et `POST /trips/recurring` acceptent `acceptedPaymentModes` : tableau non vide parmi `cash`, `electronic`, `points`. Les occurrences récurrentes héritent du choix. Les anciens trajets/clients sans ce champ restent compatibles avec les trois modes ; une modification ultérieure du trajet ne supprime pas le mode déjà accepté d’une réservation.
- Nouveaux GET authentifiés : `/driver-finance/me` (Pro, essai, réserves, dette, capacité cash et vingt dernières commissions), `/driver-finance/trips/:id/payment-options?numberOfSeats=1`, `/driver-finance/bookings/:id/payment-options`. Les deux derniers n’exposent pas les soldes du conducteur et vérifient l’accès au trajet privé/à la réservation. La disponibilité est indicative : le verrou final est pris à l’acceptation effective, pas à l’affichage ou à la publication ni à la simple proposition de dispatch.
- Migration `1780000050000-DriverCashCommissions` : `cash_commissions`, `driver_pro_trial_claims`, modes acceptés et réserve dédiée du portefeuille. Des triggers assurent l’invariant dans la même transaction que les écritures ORM **et SQL directes** (GPS, interruptions, annulations). Verrou de référence utilisateur (`KEY SHARE`) avant portefeuille puis commission, contraintes de conservation et index de dette/historique. Le verrou de référence évite une inversion avec un retrait/ajustement tenant déjà le verrou utilisateur. Aucun appel prestataire sous verrou.
- Les notifications de débit, régularisation, réserve épuisée, dette et activation d’essai utilisent l’outbox transactionnelle existante. Les notifications financières cash ouvrent le portefeuille mobile. Un terminal joignable et ses permissions push restent nécessaires.
- Les réservations déjà acceptées/terminées/absentes/incertaines au moment de la migration sont marquées comme historiques et ne sont pas facturées rétroactivement. L’historique d’une commission encaissée est conservé même si la réservation est supprimée. Les écritures financières existantes ne sont pas recalculées.

### Déploiement et validation

1. Sauvegarde et recette staging avec les mêmes paramètres de conversion qu’en production. Conserver `TYPEORM_SYNCHRONIZE=false` : la synchronisation d’entités ne crée pas ces fonctions/triggers.
2. Compiler, puis appliquer les migrations avec la procédure ECS habituelle (`migration:run:prod` dans l’image compilée). La migration de notifications et celles déjà en attente doivent précéder cette migration. Prévoir une fenêtre sans écritures financières anciennes : ne pas laisser des processus d’ancienne version modifier des portefeuilles pendant la bascule. Le verrou DDL expire après cinq secondes : en cas de contention, l’opération échoue au lieu d’attendre indéfiniment.
3. Déployer toutes les instances backend puis la nouvelle application. L’API protège aussi les anciennes versions mobiles, mais leurs écrans n’affichent pas les nouvelles réserves. Vérifier une recharge, une acceptation/refus cash, la fin de trajet, une annulation, l’achat Pro et les notifications en staging, avec deux appareils.
4. Ne pas utiliser `migration:revert` pour cette fonctionnalité : le retour arrière automatique refuse d’effacer l’historique financier. Réconcilier puis utiliser une migration corrective en avant.

Vérifications locales : suite backend complète **1 305 tests réussis** (68 tests opt-in ignorés à cette étape), puis **12 tests de gains conducteur revalidés** après ajout de la conservation du taux historique (ensembles partiellement communs) ; **20 tests PostgreSQL financiers** et **16 tests PostgreSQL de notifications** réussis dans des clusters jetables, prestataires simulés. Une tentative simultanée avec la suite mobile a dépassé les délais d’initialisation des clusters ; les relances isolées réussissent. Tous les clusters temporaires ont été arrêtés/nettoyés, y compris les deux initialisations interrompues. Compilation production `tsc -p tsconfig.build.json --noEmit --incremental false` réussie. Le contrôle TypeScript incluant tous les fichiers de tests signale des erreurs dans des fixtures hors périmètre (activité, OTP, PawaPay, confidentialité, identité et fidélité), contrairement à la compilation production et à Jest. Mobile : **1 468 tests JavaScript réussis**, TypeScript et contrôles taille/frontière réseau réussis. ESLint ciblé sur le nouveau code de production backend et les composants/hooks mobiles contrôlés : sans erreur ni avertissement. Aucun essai sur téléphone physique ni paiement réel.

Fichiers principaux : `src/driver-finance/*`, migration ci-dessus, `wallet-origin.ts`, `subscriptions.service.ts`, `bookings.service.ts`, entités/DTO/services des trajets ; mobile : `driverFinanceApi.ts`, publication, choix du paiement, portefeuille et écrans Pro. Détails mobile dans `zwanga/docs/CHANGEMENTS_TECHNIQUES.md`.

## 2026-10-06 — Actions financières depuis la fiche utilisateur administrateur

- La fiche utilisateur de `zwanga-admin` affiche le portefeuille, sa part retirable/réservée, les 20 derniers mouvements et le parrain actuel. Les superadministrateurs peuvent ajouter/retirer des jetons ou rattacher un premier parrain ; les administrateurs ordinaires conservent la lecture seule pour ces actions.
- `GET /admin/users/:userId/financial-summary` ne crée aucun portefeuille lors de la consultation. Un premier crédit manuel crée le portefeuille dans la transaction. `POST /admin/wallets/:userId/adjustments` reste compatible, exige un motif et une clé stable, refuse les débits excessifs et une réutilisation de clé avec des paramètres différents. Les crédits manuels ne deviennent pas retirables ; les réservations de retrait restent intactes.
- Le navigateur conserve la demande de jetons non confirmée dans son stockage de session, avec le même identifiant pour la reprise après une coupure réseau. Il n'autorise pas à modifier cette demande tant que son résultat reste incertain.
- `GET /admin/referrals/candidates?search=...` recherche au maximum 15 comptes actifs par nom, téléphone, email ou identifiant. `POST /admin/users/:userId/referrer` accepte `{ referrerUserId, reason }` (UUID, motif de 10 à 300 caractères). L'acteur provient du JWT et ses droits sont revérifiés dans le service.
- Un rattachement administratif conserve les règles normales : bonus configuré au parrain une seule fois, aucune commission rétroactive, aucune modification d'un parrain existant. L'auteur, le filleul et le motif figurent dans l'écriture de bonus ; le profil indique `attributionProvider=admin`. Les rattachements mobiles et administratifs sont sérialisés pour empêcher les boucles concurrentes. Auto-parrainage et parrains indisponibles sont refusés.
- Les notifications transactionnelles existantes prennent en charge l'ajustement utilisateur et le bonus du parrain après validation de la transaction. Aucun appel push externe n'est fait sous verrou. Le texte du bonus parle maintenant de rattachement plutôt que d'une nouvelle inscription.
- Aucun changement de schéma ni nouvelle variable d'environnement. Déployer le backend avant l'administration web ; les migrations préexistantes de portefeuille, parrainage et notifications doivent déjà être appliquées.

## 4 octobre 2026

### Notifications push des opérations financières et des décisions KYC manuelles

Statut : implémentation backend locale ; migration puis déploiement requis. Aucun envoi réel, ajustement de solde de production ou changement AWS réalisé.

Les notifications manquantes sont désormais enregistrées dans la même transaction PostgreSQL que l’opération. Une transaction annulée ne laisse aucune notification. Un traitement toutes les 10 secondes récupère les notifications confirmées, puis appelle Expo/FCM hors transaction. Les gains conducteur et les récapitulatifs de trajet déjà notifiés sont conservés.

| Opération | Destinataire et déclenchement |
| --- | --- |
| Ajustement administrateur positif ou négatif | Titulaire, après écriture du mouvement ; montant signé et solde après opération |
| Recharge, paiement en jetons, remboursement, correction tarifaire | Titulaire, après mouvement comptable effectif ; une recharge prestataire réussie sans crédit de jetons ne déclenche pas de faux crédit |
| Transfert de jetons | Expéditeur et bénéficiaire, chacun pour son propre mouvement |
| Bonus de fidélité et d’abonnement | Bénéficiaire après crédit |
| Commissions et bonus de parrainage | Parrain ; attente, disponibilité ou annulation clairement distinguées ; pas de double alerte pour les deux écritures d’un changement de compartiment |
| Retraits conducteur, portefeuille et parrainage | Titulaire ; demande enregistrée, résultat confirmé ou vérification requise ; pas de deuxième alerte pour le simple accusé de réception du prestataire |
| Paiements électroniques et remboursements PawaPay | Payeur, jamais l’administrateur ayant demandé le remboursement ; seulement aux états définitifs et sans doublonner le crédit/retrait métier |
| Espèces | Passager et conducteur après confirmation explicite de l’encaissement ; aucun crédit électronique supplémentaire créé |
| Financement des services Pro | Propriétaire du dossier après acompte, financement ou remboursement enregistré ; aucun push possible pour un dossier web sans compte utilisateur lié |
| KYC manuel approuvé ou rejeté | Utilisateur concerné après validation de la transaction ; décisions administrateur répétées idempotentes, aucune donnée du document ni note interne dans le push |

Fiabilité et limites :

- Une clé métier unique `notifications.eventKey` empêche les doublons d’enregistrement dus aux callbacks/requêtes répétés. Les travailleurs utilisent `FOR UPDATE SKIP LOCKED` pour partager la file entre instances ECS.
- Une erreur du transport push ne revient pas sur une opération réussie. En revanche, l’impossibilité d’enregistrer la notification dans la transaction provoque son annulation : aucun mouvement nouvellement confirmé ne doit perdre cette notification silencieusement.
- Envoi sans quota hebdomadaire marketing. Le jeton du terminal est relu avant l’envoi. Sans jeton ou en cas d’erreur, la notification reste en historique et bénéficie des reprises existantes toutes les 5 minutes pendant 72 heures, avec suivi des reçus Expo.
- Les états de paiement/retrait ou décisions KYC remplacés par une décision plus récente sont ignorés avant envoi/reprise. Les mouvements comptables restent des événements historiques avec leur solde après opération.
- La déduplication en base ne garantit pas un affichage exactement une fois sur le téléphone : une interruption après acceptation par Expo/FCM mais avant sauvegarde locale peut provoquer une nouvelle tentative. Le système mobile, la permission de notification et la validité du jeton restent nécessaires.
- Aucun rattrapage massif des opérations historiques ; les nouveaux mouvements et transitions observés par le backend sont couverts. Les écritures métier doivent conserver les subscribers TypeORM et utiliser `save()` pour les changements d’état. Les commandes SQL directes doivent enregistrer explicitement la notification avec leur propre `EntityManager`, comme la confirmation des espèces.
- Les validations automatiques Didit ne sont pas transformées en décisions manuelles. Une identité approuvée ne signifie pas qu’un compte suspendu est réactivé ni que toutes les conditions conducteur sont remplies.
- Aucun changement mobile requis pour recevoir et afficher les push génériques existants. Les nouveaux types peuvent ouvrir l’accueil au clic tant que leur routage dédié n’est pas ajouté au mobile.

Déploiement : appliquer `1780000047000-AddTransactionalNotifications` avant de démarrer le nouveau backend, puis déployer toutes les instances. Les anciens processus n’émettent pas ces nouveaux événements durant une coexistence de versions. Aucune variable d’environnement supplémentaire. La migration conserve l’historique existant et refuse une annulation qui supprimerait des clés de notifications déjà créées.

Fichiers principaux : `src/notifications/transactional-notifications.subscriber.ts`, `financial-notification.policy.ts`, `transactional-notification.ts`, `notifications.service.ts`, `src/admin/admin.service.ts`, `src/bookings/cash-receipts.service.ts` et la migration ci-dessus.

Tests : couverture des crédits/débits, destinataires, callbacks répétés, décisions KYC, transport indisponible et jeton renouvelé. Le test PostgreSQL isolé `src/database/transactional-notifications-postgres.spec.ts` s’active uniquement avec `NOTIFICATIONS_TEST_POSTGRES_BIN` pointant vers les exécutables PostgreSQL ; il crée et nettoie son propre cluster temporaire, sans lire `.env` ni utiliser la base de l’application. Les services de push y sont simulés ; aucun test physique sur téléphone n’est revendiqué.

Validation locale finale : 1 193 tests réussis dans la suite complète (21 tests opt-in ignorés), puis les 12 nouveaux tests PostgreSQL exécutés séparément avec succès ; TypeScript et ESLint ciblé sur le nouveau code de production réussis. Les clusters temporaires ont été arrêtés et nettoyés.

Référence d’implémentation : [subscribers et gestionnaire transactionnel TypeORM](https://typeorm.io/docs/listeners-and-subscribers/).

## 19 septembre 2026

### FIN-WALLET-005 — Vérifications finales du retrait de jetons achetés

- Une recharge historique `succeeded` sans preuve prestataire complète est revérifiée avant tout nouveau crédit retirable. Le statut local seul ne suffit jamais.
- Une demande de retrait déjà réservée est reconnue avant les contrôles métier d'une nouvelle demande, pour préserver son idempotence même si l'état KYC change.
- Tests de ventilation persistée sur recharges, trajets, abonnements, transferts et remboursements successifs ; reprise mobile après passage en arrière-plan et modal hors du contenu masqué.
- Validation locale : 743 tests backend réussis, 54 tests mobiles ciblés réussis, compilations TypeScript backend/mobile réussies. Les 3 tests de migration PostgreSQL, désactivés par défaut dans la suite unitaire, ont été exécutés séparément avec succès sur un cluster local jetable.
- Aucun déploiement ou virement réel réalisé par cette intervention. Activation toujours conditionnée à la migration coordonnée et à une validation FlexPaie/staging.

## 18 septembre 2026

### FIN-WALLET-005 — Jetons achetés retirables, fidélité non retirable

Statut : implémentation locale backend/mobile ; migration et activation explicite requises, aucun virement réel ni changement en production.

- Origine conservée, consommation de la fidélité en premier, transferts et remboursements ventilés.
- Retrait Mobile Money des seuls jetons achetés, KYC, idempotence et réservation sans renvoi automatique.
- Soldes et parcours achat/retrait/fidélité/conducteur/parrainage explicités dans le mobile ; reprise après coupure réseau.
- Migration historique conservatrice, preuves FlexPaie requises ; callbacks de recharge toujours vérifiés.
- `WALLET_WITHDRAWALS_ENABLED=false` par défaut. Déploiement sans anciens écrivains et audit des soldes requis.

Voir [Retrait des jetons achetés](purchased-token-withdrawals.md).

### FIN-CASH-001 — Crédit réel des subventions et reprise automatique autorisée

Statut : implémenté localement ; migration et déploiement requis. Aucun solde modifié en production par cette intervention.

- Répartition inchangée : sur 5 000 CDF, 2 000 cash passager et 3 000 de participation Zwanga.
- Crédit cash relu sous verrou, idempotent ; notification seulement après validation de la transaction.
- Reprise autorisée des crédits manquants, 50 réservations au maximum toutes les cinq minutes, sans débit passager ni transfert FlexPay.
- Résumé basé sur les écritures réelles ; crédit en attente distinct du gain confirmé.
- Mobile : plus de confirmation cash déduite de l'arrivée ; cache revenus invalidé après événement financier.

Voir [Crédit des subventions cash](cash-subsidy-credit-reliability.md).

### FIN-BOOKING-004 — Paiement à l'approche de l'arrivée à 500 mètres

Statut : implémenté localement dans le backend et l'application mobile ; déployer le backend avant la mise à jour mobile. Aucune migration ni nouvelle variable d'environnement.

- Seuil du modal et de l'autorisation serveur porté de 150 à 500 mètres inclus de la destination personnelle du passager.
- Réservé aux passagers embarqués ayant choisi le paiement électronique ou les jetons ; pas de modal anticipé pour le cash, les trajets gratuits ou déjà payés.
- Les contrôles de fraîcheur GPS, d'embarquement et de contestation sont conservés. La proximité est revérifiée sous verrou avant un débit en jetons.
- L'ouverture du modal ne débite rien et ne termine pas le trajet ; montant, gains conducteur, fidélité et seuils de dépose/non-présentation inchangés.
- Tests des bornes 500/501 mètres côté mobile et backend, des deux modes de paiement et du maintien du modal malgré les fluctuations GPS.

Voir [Paiement à proximité de la destination](near-arrival-payment.md).

## 17 septembre 2026

### FIN-LOYALTY-001 — Base fixe par trajet, bonus réservé aux paiements non cash

Statut : implémenté localement ; migration `1780000037000` et déploiement requis, aucune modification de production.

- 1 jeton par trajet conducteur réellement démarré/terminé et par trajet passager transporté, quel que soit le paiement.
- Base passager indépendante de la finalisation financière ; bonus distance/prix seulement après paiement jetons/électronique réussi.
- Écritures séparées, verrou transactionnel et index unique contre les doublons ; anciens crédits conservés sans recalcul.
- Correction de la contrainte des gains cash subventionnés ; aucune conversion de cash encaissé en solde retirable.
- Suppression de l'exemple `ZWANGA_LOYALTY_BASE_REWARD`, désormais ignoré au profit de la base fixe de 1.
- Explication des identifiants, URL et champs FlexPaie à partir du PDF, sans modification des secrets ou du client payout.

Voir [Fidélité des trajets](trip-loyalty.md) et [Configuration FlexPaie](flexpaie-payout-configuration.md).

### FIN-DRIVER-002 — Alignement du retrait sur FlexPaie Payout v1.03

Statut : implémenté localement ; configuration marchand et validation réelle encore requises. Aucun déploiement ni transfert d'argent effectué.

- Authentification dédiée avec cache du token selon `expire_in`, sans réutiliser le token d'encaissement.
- Envoi à l'URL `/pay` fournie par FlexPaie avec `customer`, `description` et `callback_url`.
- Vérification des réponses à plat et des callbacks avec les identifiants payout, y compris pour les retraits de parrainage.
- Acceptation initiale distincte du succès final ; gains réservés en cas de réponse ambiguë, de service occupé ou de timeout. Aucun renvoi automatique de versement.
- Variables ajoutées vides aux modèles d'environnement et au `.env` local. Le PDF ne fournit pas les hôtes réels ni les identifiants.
- Aucune migration ni modification des montants, commissions, règles KYC ou clés d'idempotence.

Configuration et rapprochement des anciennes demandes : [FLEXPAY_SETUP.md](../../FLEXPAY_SETUP.md#driver-earnings-payouts-flexpaie-payout-v103).

## 4 septembre 2026

### FIN-BOOKING-003 — Subvention Zwanga du premier trajet passager

Statut : implémenté localement ; migration, import SSM et déploiement backend requis.

Résumé : le premier trajet réel d'un passager est subventionné par Zwanga. Le passager paie 40 % du prix total dû, tandis que les 60 % restants sont tracés comme subvention Zwanga. La réduction est calculée côté serveur, réservée une seule fois par passager, libérée si la réservation ne devient pas un trajet payable, et refusée si le passager possède déjà un trajet complété ou payé.

Impacts financiers et opérationnels :

- `bookings.paymentAmount` devient le montant passager lorsque la subvention s'applique ;
- `bookings.grossPaymentAmount` conserve le prix total avant subvention ;
- `bookings.zwangaSubsidyAmount` trace la part prise en charge par Zwanga ;
- les paiements FlexPay et les débits en jetons utilisent uniquement les 40 % dus par le passager ;
- les revenus conducteur électroniques/jetons restent calculés sur le prix brut du trajet ;
- pour le cash, le conducteur encaisse 40 % auprès du passager et reçoit la part subventionnée en revenu conducteur retirable ;
- les commissions de parrainage restent calculées sur le montant réellement payé par le filleul, pas sur la subvention ;
- une migration ajoute les colonnes, contraintes et index nécessaires sans recalcul historique.

Documentation complète : [first-trip-subsidy.md](./first-trip-subsidy.md).

### FIN-REF-010 — Verrouillage du partage de commission trajet parrainée

Statut : implémenté localement ; migration et déploiement backend requis.

Résumé : la commission parrain liée aux courses est verrouillée à 1 % maximum
du prix réellement payé, même si une variable d'environnement est mal configurée
à 5 %. Ce 1 % reste financé par la commission plateforme Zwanga de 5 %, ce qui
laisse économiquement 4 % à Zwanga sur une course parrainée. Le bonus fixe de
rattachement reste de 5 jetons disponibles.

Impacts financiers et opérationnels :

- une migration ajoute une contrainte PostgreSQL sur les nouvelles commissions
  de course ;
- aucune transaction historique n'est recalculée ;
- les courses FlexPay et les courses payées en jetons restent éligibles ;
- les courses en espèces restent exclues ;
- le contrat `/referrals/me` expose explicitement le financement par commission
  plateforme et le taux net conservé par Zwanga après parrainage ;
- un test anti-régression couvre le cas d'une mauvaise configuration
  `REFERRAL_BOOKING_REWARD_RATE=0.05`.

Documentation complète : [referral-program.md](./referral-program.md).

## 3 septembre 2026

### FIN-REF-009 — Partage de la commission trajet et bonus de rattachement

Statut : implémenté localement ; migration et déploiement backend requis.

Résumé : la commission de parrainage sur les courses ne vaut plus 5 % du prix
total. Zwanga conserve une commission trajet globale de 5 %, et le parrain
reçoit désormais 1 % du prix total, prélevé économiquement sur cette commission.
Zwanga garde donc 4 % net sur une course parrainée. Les courses payées en
jetons Zwanga deviennent également éligibles, sans ouvrir le cash.

Impacts financiers et opérationnels :

- le conducteur conserve le même calcul de gain : brut moins 5 % de commission
  plateforme ;
- le parrain reçoit 1 % sur les courses FlexPay ou jetons, pendant la fenêtre
  de douze mois ;
- les abonnements FlexPay restent rémunérés à 5 %, sauf configuration contraire ;
- le premier rattachement d'un filleul crédite automatiquement 5 jetons
  disponibles au parrain ;
- une nouvelle écriture `referral_ledger_entries.type = attribution_bonus`
  trace ce bonus, avec unicité par couple parrain/filleul ;
- `referral_rewards.paymentTransactionId` devient nullable afin de supporter les
  courses payées en jetons, qui n'ont pas toujours de transaction FlexPay.

Documentation complète : [referral-program.md](./referral-program.md).

### KYC-DRIVER-001 — Cohérence du profil conducteur

Statut : implémenté localement ; migration et déploiement backend requis.

Résumé : le backend ne persiste plus de contradiction entre `users.role` et
`users.isDriver`. Les inscriptions téléphone, Google et Apple normalisent les
anciennes charges utiles mobiles, la création/réactivation d'un véhicule
transforme le compte public en profil conducteur cohérent, et les synchronisations
KYC Didit/legacy alignent le profil conducteur avant sauvegarde.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde ou jeton ;
- correction des blocages conducteur où KYC et véhicules étaient présents mais
  `role` et `isDriver` se contredisaient ;
- les comptes administrateurs restent hors flux conducteur avec `isDriver=false` ;
- la migration répare les lignes existantes et ajoute une contrainte SQL contre
  les futures incohérences.

Documentation complète : [driver-role-consistency.md](./driver-role-consistency.md).

## 2 septembre 2026

### KYC-DIDIT-003 — Concordance des noms légaux

Statut : implémenté localement ; publication mobile/backend et ajustement du
workflow Didit requis.

Résumé : l'inscription et le profil demandent désormais les prénom(s) et le
nom tels qu'ils figurent sur la pièce d'identité ; le post-nom est facultatif. L'app confirme ces
valeurs avant de créer une session Didit, le backend les normalise avant de les
envoyer dans `expected_details`, et les noms sont protégés après approbation
KYC. Les connexions Google et Apple transmettent aussi les noms confirmés par
l'utilisateur lors de la première inscription. Pour Apple, le nom est récupéré
depuis l'autorisation Apple et n'est pas redemandé dans le formulaire Zwanga.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, jeton ou retrait ;
- réduction attendue des faux rejets `FULL_NAME_MISMATCH_WITH_PROVIDED` ;
- les écarts de nom doivent être orientés vers une revue manuelle dans le
  workflow Didit plutôt que vers un refus automatique ;
- un changement légal après approbation nécessite le support et une nouvelle
  vérification KYC.

Documentation complète : [kyc-didit-integration.md](./kyc-didit-integration.md).

## 1 septembre 2026

### KYC-DIDIT-002 — Typage explicite des colonnes KYC nullable

Statut : implémenté localement ; aucun changement de schéma SQL attendu, relance
de `migration:run` requise pour appliquer la migration Didit en attente.

Résumé : TypeORM refusait d'initialiser le DataSource PostgreSQL pendant
`migration:run` parce que certains champs nullable de `KycDocument`, notamment
`selfieUrl`, étaient inférés comme `Object` après leur typage TypeScript en
`string | null`. Les colonnes concernées déclarent maintenant explicitement leur
type SQL.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, jeton ou retrait ;
- aucun recalcul des dossiers KYC existants ;
- aucun changement de statut KYC existant ;
- correction bloquante pour permettre à TypeORM de lancer les migrations ;
- les retraits restent conditionnés par `kyc_documents.status = approved`.

Documentation complète : [kyc-didit-integration.md](./kyc-didit-integration.md).

### KYC-DIDIT-001 — Migration vers Didit comme fournisseur KYC

Statut : implémenté localement ; migration, variables Didit, configuration
webhook Didit, déploiement API, puis publication app/admin requis.

Résumé : le KYC peut désormais être lancé via une session Didit créée par le
backend, puis exécutée en priorité par le SDK React Native Didit dans l'app
mobile. Le backend crée la session avec `vendor_data = users.id`, synchronise la
décision côté serveur et reçoit les webhooks signés. Les modules financiers
continuent de lire `kyc_documents.status`, ce qui évite de casser les retraits
conducteur et parrainage.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, taux de conversion, solde ou montant ;
- l'app mobile utilise `session_token` avec le SDK Didit pour capturer la pièce
  d'identité et le visage/liveness ;
- l'URL Didit reste disponible en secours WebBrowser si le module natif n'est
  pas encore présent dans le build installé ;
- ajout de colonnes nullable dans `kyc_documents` pour tracer le fournisseur et
  la session Didit ;
- `approved` active le compte sauf suspension ;
- `pending` et `rejected` maintiennent le compte en `pending_kyc` sauf
  suspension ;
- les retraits restent conditionnés par un KYC `approved` ;
- `/users/kyc` reste disponible en compatibilité legacy ;
- `/users/kyc/didit/sync` ne fait jamais confiance au statut fourni par l'app
  pour approuver un KYC ;
- les webhooks Didit sont vérifiés par signature V2, avec secours simple
  limité aux sessions déjà connues localement ;
- les payloads sensibles Didit ne sont pas stockés intégralement.

Documentation complète : [kyc-didit-integration.md](./kyc-didit-integration.md).

### FIN-ADMIN-RBAC-002 — Bootstrap superadmin et création web des admins

Statut : implémenté dans le backend et l'administration web ; migration,
variables d'environnement de bootstrap, déploiement API et déploiement
`zwanga-admin` requis.

Résumé : le premier `super_admin` peut être créé par un flux OTP protégé par
clé de bootstrap. Une fois connecté, le `super_admin` peut créer les comptes
`admin` depuis `zwanga-admin` avec un mot de passe temporaire. Tous les comptes
créés par bootstrap ou par l'interface doivent changer ce mot de passe avant
d'accéder aux routes admin protégées par rôle.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, conversion ou formule ;
- nouvelle colonne `users.passwordChangeRequired` par défaut à `false` ;
- aucun compte existant n'est promu ou modifié par la migration ;
- création unique du premier `super_admin`, limitée au numéro configuré et
  protégée par OTP ;
- création ou promotion des comptes `admin` réservée au `super_admin` ;
- conversion possible d'un ancien compte `driver`/`passenger` en `admin`, sans
  suppression d'historique ni recalcul financier ;
- refus d'écraser un compte `admin` ou `super_admin` existant ;
- accès aux routes financières protégé tant que le mot de passe temporaire n'a
  pas été remplacé ;
- secrets de bootstrap à stocker dans Parameter Store/Secrets Manager puis à
  faire tourner après création.

Documentation complète : [admin-finance-access-control.md](./admin-finance-access-control.md) et [../admin-account-provisioning.md](../admin-account-provisioning.md).

## 31 août 2026

### FIN-ADMIN-RBAC-001 — Séparation admin / super administrateur

Statut : implémenté dans le backend et l'administration web ; migration de rôle, déploiement API et déploiement `zwanga-admin` requis.

Résumé : le back-office distingue désormais les administrateurs opérationnels du super administrateur. Le login web passe par `/auth/admin/login`, les comptes `admin` et `super_admin` sont acceptés dans `zwanga-admin`, et les actions financières sensibles restent réservées au super administrateur.

Impacts financiers et opérationnels :

- aucun changement de prix, commission, solde, conversion ou formule ;
- ajout de `super_admin` à l'énumération PostgreSQL des rôles utilisateur ;
- ajustements de jetons et rapprochements de retraits de parrainage réservés au `super_admin` ;
- lecture des pages Finance autorisée aux administrateurs simples ;
- interface web en lecture seule pour les actions sensibles lorsqu'un admin simple est connecté ;
- création des comptes back-office de secours par CLI avec mot de passe saisi en mode masqué ;
- refus du login admin pour les comptes `driver` et `passenger`.

Documentation complète : [admin-finance-access-control.md](./admin-finance-access-control.md).

### FIN-DRIVER-003 — Livraison fiable du gain conducteur

Statut : implémenté dans le backend et l'application mobile ; déploiement API et nouveaux binaires Android/iOS requis, sans migration.

Résumé : les notifications financières distinguent maintenant les tokens FCM natifs des `ExpoPushToken`, conservent les échecs critiques et les retentent toutes les cinq minutes pendant 72 heures. Lorsque l'application est ouverte hors de l'écran de navigation, le push de fin de trajet ouvre aussi un modal détaillant le total, le gain acquis, le liquide à encaisser et le paiement électronique attendu.

Impacts financiers et opérationnels :

- aucun changement de calcul, de commission, de solde ou de retrait ;
- notification persistée même lorsque le conducteur n'a momentanément aucun token ;
- livraison Expo pour iOS/Expo et Firebase pour les tokens natifs Android ;
- suppression conditionnelle des tokens déclarés invalides par le fournisseur ;
- reprise concurrente sûre avec `FOR UPDATE SKIP LOCKED`, réseau exécuté hors transaction ;
- aucun double modal avec le résumé temps réel de l'écran de navigation ;
- resynchronisation mobile automatique après rotation du token push ;
- aucune migration ni nouvelle variable d'environnement.

Documentation complète : [driver-trip-revenue-notification.md](./driver-trip-revenue-notification.md).

## 27 août 2026

### FIN-REF-008 — Fiabilisation PostgreSQL du rattachement

Statut : implémenté dans le backend ; déploiement API requis, sans migration.

Résumé : les rattachements ChottuLink échouaient en production parce que TypeORM combinait `FOR SHARE` avec la jointure externe utilisée pour charger le parrain. Le backend sérialise désormais chaque filleul avec un verrou transactionnel PostgreSQL et charge séparément le profil et l'utilisateur du parrain.

Impacts financiers et d'attribution :

- suppression des HTTP 500 déterministes sur `POST /referrals/me/attribution` ;
- rattachement atomique, immuable et idempotent, même pour un ancien compte sans profil ;
- sérialisation commune avec la création paresseuse du profil et du compte ;
- aucune double notification lors des reprises mobiles ;
- aucun changement du taux de 5 %, des soldes, de la retenue ou de la fenêtre de douze mois ;
- aucune migration, variable d'environnement ou modification Parameter Store.

Documentation complète : [referral-attribution-postgresql-hardening.md](./referral-attribution-postgresql-hardening.md).

### FIN-REF-007 — Fiabilisation mobile et comptes existants sans parrain

Statut : implémenté dans le backend et l'application mobile ; déploiement API et nouveaux binaires Android/iOS requis, sans migration.

Résumé : une invitation ChottuLink peut désormais rattacher un compte existant lorsque celui-ci ne possède pas encore de parrain. Le rattachement reste transactionnel, immuable et idempotent. Les App Links, Universal Links, attributions différées, caches de session, notifications et solutions de secours du partage ont été renforcés.

Impacts financiers :

- aucun changement du taux de 5 %, de la retenue de sept jours ou de la valeur du jeton ;
- aucune commission rétroactive avant le rattachement ;
- fenêtre de douze mois toujours déclenchée par le premier paiement éligible réussi ;
- aucun remplacement d'un parrain déjà enregistré ;
- aucune migration ni modification de solde ;
- nouvelle route authentifiée `POST /referrals/me/attribution`, limitée à dix appels par minute.

Documentation complète : [referral-attribution-reliability.md](./referral-attribution-reliability.md).

## 26 août 2026

### FIN-REF-006 — Administration globale du parrainage

Statut : implémenté dans le backend ; migration d'index et déploiement requis.

Résumé : la page **Finance > Parrainage** dispose désormais de routes administratives dédiées pour les comptes, les commissions et les retraits. Le rapprochement d'un retrait consulte FlexPay et réutilise le règlement idempotent existant sans permettre à l'opérateur de forcer un succès.

Impacts financiers et de confidentialité :

- aucun changement du taux de 5 %, de la retenue ou de la fenêtre de douze mois ;
- agrégats globaux des compartiments `pending`, `available`, `reserved` et `withdrawn` ;
- aucune exposition des tokens ChottuLink ou réponses FlexPay brutes ;
- rapprochement limité aux administrateurs et à cinq appels par minute ;
- chargement groupé évitant les requêtes N+1 ;
- index composites dédiés aux tris et filtres administratifs ;
- aucune nouvelle variable d'environnement ou ressource AWS.

Documentation complète : [admin-referral-management.md](./admin-referral-management.md).

### FIN-WALLET-ADMIN-001 — Consultation et ajustement audité des jetons

Statut : implémenté dans le backend et l'administration web ; migration et déploiement requis.

Résumé : les routes globales de consultation des portefeuilles et du registre alimentent désormais la page **Finance > Jetons**. Les ajustements exceptionnels utilisent un verrou pessimiste, une transaction unique, un motif obligatoire et un UUID d'idempotence protégé par un index unique.

Impacts financiers :

- aucune modification de la valeur d'un jeton ni conversion monétaire ;
- lecture globale paginée et utilisateurs assainis ;
- crédit ou débit manuel plafonné, sans solde négatif ;
- solde et registre validés ou annulés ensemble ;
- répétition HTTP sans double mouvement ;
- migration ajoutant le type `admin_adjustment`, sans modifier les soldes existants ;
- aucune nouvelle variable d'environnement ou ressource AWS.

Documentation complète : [admin-token-wallet-management.md](./admin-token-wallet-management.md).

### FIN-DRIVER-002 — Notification du montant conducteur à la fin du trajet

Statut : implémenté dans le backend et l'application mobile ; déploiement requis, sans migration.

Résumé : la clôture unique d'un trajet produit un résumé financier serveur, l'envoie au conducteur par push et l'affiche dans le modal de fin. L'interface sépare le revenu net confirmé, le prix brut à encaisser en liquide et le revenu électronique net encore attendu.

Lorsqu'un paiement électronique attendu est confirmé après la clôture, une notification supplémentaire est envoyée uniquement lors de la création unique du revenu conducteur.

Impacts financiers :

- aucune nouvelle écriture, aucun débit, aucun crédit et aucun retrait ;
- les réservations sans dépose prouvée sont exclues ;
- le liquide n'est jamais ajouté au solde retirable ;
- l'électronique en attente n'est jamais présenté comme acquis ;
- calcul serveur avec le taux de commission configuré et la devise du trajet ;
- transition conditionnelle empêchant une double notification REST/Socket.IO ;
- endpoint limité au conducteur authentifié du trajet ;
- aucune migration ni nouvelle variable d'environnement.

Documentation complète : [driver-trip-revenue-notification.md](./driver-trip-revenue-notification.md).

### FIN-DRIVER-001 — Versement Mobile Money des revenus conducteur

Statut : implémenté dans le backend et l'application mobile ; migration et déploiement de production requis.

Résumé : après confirmation du paiement de fin de course, le revenu net devient retirable par le conducteur dans l'application. Le décaissement utilise le service FlexPay `merchantPayOutService`, exige un KYC approuvé et reste réservé jusqu'à une confirmation finale. Un échec ou une annulation confirmés libèrent le montant et rendent une nouvelle demande possible depuis l'app.

Impacts financiers :

- aucune modification du prix de course ni du taux de commission de 5 % ;
- verrou pessimiste par conducteur avant calcul et réservation du solde ;
- clé d'idempotence unique par intention de retrait ;
- unicité entre retrait et transaction de paiement ;
- timeout réseau conservé en attente au lieu d'être considéré comme échec certain ;
- callbacks vérifiés par défaut auprès de FlexPay ;
- comparaison de la référence, de l'`orderNumber`, du montant et de la devise ;
- rapprochement automatique toutes les cinq minutes ;
- historique des retraits et action **Réessayer** après échec final dans l'application ;
- migration de schéma sans modification des soldes historiques.

Documentation complète : [driver-electronic-trip-payout.md](./driver-electronic-trip-payout.md).

### FIN-BOOKING-002 — Règlement atomique des courses en jetons

Statut : implémenté dans le backend et l'application mobile ; migration et déploiement de production requis.

Résumé : le débit de jetons, le statut payé de la réservation et le revenu net conducteur sont désormais enregistrés dans une seule transaction PostgreSQL. Les appels concurrents REST/Socket.IO et les répétitions réseau sont idempotents. Un réconciliateur prudent complète les anciens débits prouvés sans jamais créer de débit rétroactif. L'application rafraîchit les caches financiers et rend le compte CDF conducteur visible depuis le profil.

Impacts financiers :

- aucune modification de la valeur d'un jeton, du prix des courses ou du taux de commission ;
- débit passager et revenu conducteur validés ou annulés ensemble ;
- verrous pessimistes sur réservation et portefeuille ;
- maintien des contraintes uniques par réservation ;
- nouvelles contraintes de non-négativité et de conservation du montant ;
- réparation automatique uniquement en présence d'une écriture `booking_payment` existante ;
- anomalie `succeeded` sans débit signalée sans prélèvement automatique ;
- séparation visible entre portefeuille passager en jetons et revenus conducteur en CDF.

Documentation complète : [atomic-token-trip-settlement.md](./atomic-token-trip-settlement.md).

## 25 août 2026

### FIN-REF-005 — Accès profil et fiabilisation du partage

Statut : implémenté dans l'application mobile.

Résumé : l'espace de parrainage est désormais accessible depuis une carte mise en évidence sur le profil. Elle affiche le nombre de filleuls et le solde de jetons disponible. Le partage recharge le résumé si nécessaire, valide le lien HTTPS et ouvre la feuille de partage native avec un état de chargement. Toute indisponibilité produit maintenant un message visible au lieu d'une absence de réaction.

Impacts financiers et d'attribution :

- aucune modification du taux de 5 %, de la durée de douze mois, des soldes ou des règles de retrait ;
- aucun mouvement de jetons n'est effectué par l'affichage de la carte ou le partage ;
- les invitations WhatsApp et SMS utilisent obligatoirement le lien personnel validé ;
- le lien générique sans attribution n'est plus utilisé lorsque le résumé manque ;
- le partage reste disponible lorsque l'utilisateur refuse l'accès à ses contacts ;
- les erreurs de réseau, de configuration ChottuLink ou de lien invalide sont exposées à l'utilisateur.

Documentation : [referral-program.md](./referral-program.md).

### FIN-REF-004 — Gains détaillés par filleul

Statut : implémenté dans le backend et l'application mobile.

Résumé : le parrain voit ses filleuls directs et la commission cumulée générée par chacun. Le détail sépare les jetons en attente, les jetons libérés et les commissions inversées, sans révéler le montant ni le détail des paiements effectués par le filleul.

Impacts financiers et de confidentialité :

- le total gagné exclut toujours les récompenses `reversed` ;
- l'équivalent monétaire utilise la valeur actuelle du jeton dans la devise de retrait ;
- une récompense n'est comptée qu'une fois grâce à l'unicité financière existante par source ;
- les retraits du parrain ne réduisent pas le cumul historique attribué au filleul ;
- seuls le prénom et l'initiale du nom du filleul sont exposés au parrain ;
- aucun prix de course, abonnement, moyen de paiement ou identifiant de transaction du filleul n'est renvoyé dans cette liste.

Documentation : [referral-program.md](./referral-program.md).

### FIN-REF-003 — Remplacement de Branch par ChottuLink

Statut : implémenté dans le code ; configuration ChottuLink, migration et nouveaux builds natifs requis.

Résumé : ChottuLink remplace Branch pour la création, le partage et la résolution différée des liens de parrainage. Les règles financières, le taux de 5 %, la retenue et la fenêtre de rémunération de douze mois sont inchangés.

Impacts financiers et d'audit :

- séparation stricte entre la clé REST secrète du backend et la clé Mobile SDK ;
- migration des colonnes spécifiques à Branch vers des colonnes génériques de lien ;
- invalidation des anciennes URL Branch mises en cache, sans suppression des attributions historiques ;
- nouvelles attributions enregistrées avec `attributionProvider = chottulink` ;
- conservation du premier lien valide et du rattachement immuable ;
- aucun recalcul de commission, aucun mouvement de solde et aucune récompense rétroactive.

Documentation : [referral-program.md](./referral-program.md) et [chottulink-referral-setup.md](./chottulink-referral-setup.md).

### FIN-REF-002 — Lien Branch et attribution différée automatique

Statut : remplacé par `FIN-REF-003` avant mise en production.

Résumé : le code à saisir est remplacé dans l'application par un lien d'invitation Branch. Le premier clic valide est conservé jusqu'à 30 jours et transmis automatiquement lors d'une inscription téléphone, Google ou Apple. Le rattachement financier existant, le taux de 5 % et la fenêtre de rémunération de douze mois ne changent pas.

Impacts financiers :

- nouveau jeton opaque par parrain, sans identifiant utilisateur exposé ;
- attribution auditée avec fournisseur, lien et date de capture ;
- validation serveur avant création du compte ;
- aucun rattachement rétroactif d'un compte déjà connecté ;
- règle premier lien valide gagnant et parrain toujours immuable ;
- `referralCode` conservé uniquement pour les anciens liens ;
- aucune commission ni aucun solde recalculé par la migration.

Documentation actuelle : [referral-program.md](./referral-program.md) et [chottulink-referral-setup.md](./chottulink-referral-setup.md).

## 24 août 2026

### FIN-REF-001 — Parrainage, commissions et retraits FlexPay

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : chaque utilisateur possède un code. Le parrain reçoit 5 % du prix total effectivement payé par FlexPay pour les abonnements et courses de son filleul pendant douze mois à partir du premier paiement éligible. Les gains restent en attente sept jours, sont séparés des jetons promotionnels et deviennent retirables par FlexPay à partir de 50 jetons avec KYC approuvé.

Impacts financiers :

- cinq nouvelles tables d'audit, de solde, de récompense et de retrait ;
- aucune attribution ni commission rétroactive ;
- unicité par source de paiement et verrous pessimistes ;
- compartiments `pending`, `available`, `reserved` et `withdrawn` ;
- inversion comptable sans suppression de l'écriture originale ;
- nouveau motif de transaction `referral_payout` ;
- réconciliation idempotente des callbacks et succès FlexPay tardifs ;
- application mobile alignée pour l'inscription, le partage, le suivi et le retrait.

Documentation complète : [referral-program.md](./referral-program.md).

## 21 août 2026

### FIN-BOOKING-001 — Paiement à l'arrivée et non-embarquement automatique

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : le moyen de paiement est choisi à la réservation sans débit. Le paiement électronique et le débit de jetons deviennent possibles uniquement après l'arrivée. Après 10 minutes d'attente et un départ d'au moins 150 mètres, une réservation jamais embarquée passe automatiquement à `no_show` uniquement si une position passager fraîche prouve qu'il est resté au point de récupération. Si son GPS reprend ensuite et prouve un mouvement partagé dans le véhicule pendant le trajet, le `no_show` est récupéré automatiquement sans paiement anticipé. Sans preuve GPS suffisante, elle devient `boarding_uncertain` à la destination, sans paiement.

Impacts financiers :

- aucun prépaiement avant la prise en charge ;
- aucun débit, revenu conducteur, fidélité ou futur gain de parrainage pour `no_show` ou `boarding_uncertain` ;
- règlement FlexPay initié après arrivée ;
- débit de jetons tenté après arrivée et laissé `pending` si le solde est insuffisant ;
- suppression de la fausse réconciliation mobile qui confirmait prise en charge et dépose à la destination ;
- déclenchement de l'automate par les positions REST d'arrière-plan comme par le WebSocket ;
- acceptation du GPS passager après `no_show` tant que le trajet reste actif ;
- récupération financièrement neutre de `no_show` vers `accepted` après preuve de mouvement partagé ;
- sérialisation par trajet des décisions déclenchées simultanément par REST et Socket.IO ;
- persistance conditionnelle des positions par horodatage afin qu'un échantillon dupliqué ou ancien n'écrase jamais le plus récent ;
- dépose automatique depuis le GPS conducteur à la destination après un embarquement persisté ;
- retrait des confirmations manuelles des écrans conducteur et passager ;
- audit des méthodes de détection d'embarquement et de dépose ;
- conservation des montants ajustés lors d'une interruption ;
- affichage du montant serveur dans le modal passager de fin de trajet et bouton **Payer avec FlexPay** pour les réservations électroniques encore impayées.

Documentation complète : [booking-payment-at-arrival-and-automatic-no-show.md](./booking-payment-at-arrival-and-automatic-no-show.md).

## 20 août 2026

### FIN-TRIP-004 — Expiration douze heures après la fin de la plage de départ

Statut : implémenté.

Résumé : toute demande `pending` ou `offers_received` expire à `departureDateMax + 12 heures` tant qu'aucun conducteur n'a été accepté. Une simple offre ne maintient plus la demande ouverte indéfiniment. Le Home possède le même filtre défensif fondé sur la fin de la plage de départ.

Impacts financiers :

- aucun paiement, solde ou jeton n'est modifié ;
- aucun prix de demande historique n'est recalculé ;
- les demandes anciennes sans acceptation passent à `expired` au cron ou à la prochaine lecture ;
- les demandes associées à un conducteur accepté ou à un trajet sont protégées.

Cette règle remplace `FIN-TRIP-002`.

Documentation complète : [trip-request-response-expiration.md](./trip-request-response-expiration.md).

### FIN-WALLET-001 — Jetons Zwanga et bonus d'abonnement

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : l'appellation utilisateur « points » devient « jetons ». Chaque abonnement Pro payé et confirmé crédite exactement 25 jetons, une seule fois par abonnement.

Impacts financiers :

- nouvelle écriture `subscription_reward` de `+25` ;
- aucun bonus pour les essais, paiements en attente, échoués ou annulés ;
- index unique et verrou du portefeuille contre le double crédit ;
- paiement de l'abonnement en jetons éligible au même bonus ;
- aucune modification en masse des soldes ou transactions historiques ;
- aucun changement du taux de conversion existant.

Documentation complète : [token-denomination-subscription-reward.md](./token-denomination-subscription-reward.md).

## 19 août 2026

### FIN-TRIP-003 — Nombre de places facultatif dans une demande

Statut : implémenté.

Résumé : `numberOfSeats` peut être omis lors de la création d'une demande. Le serveur enregistre alors une place par défaut afin de conserver des calculs tarifaires, des offres et des réservations déterministes.

Impacts financiers :

- aucun tarif par kilomètre ou par place n'est modifié ;
- le champ omis produit le même prix total qu'une place explicitement demandée ;
- aucun paiement, solde, jeton ou gain de parrainage existant n'est recalculé ;
- aucune migration de données n'est nécessaire.

Documentation complète : [trip-request-optional-seat-count.md](./trip-request-optional-seat-count.md).

### FIN-TRIP-002 — Expiration après deux heures sans réponse

Statut : remplacé le 20 août 2026 par `FIN-TRIP-004`.

Résumé : une demande `pending` expire désormais à `createdAt + 2 heures` seulement lorsqu'aucune offre conducteur n'a été enregistrée. La plage de départ souhaitée ne sert plus de date d'expiration.

Impacts financiers :

- aucun montant, paiement, solde ou jeton n'est modifié ;
- une demande tarifée peut rester visible plus longtemps qu'avant ;
- une demande ayant déjà reçu une offre n'expire plus automatiquement ;
- les prix et transactions existants ne sont pas recalculés.

Documentation complète : [trip-request-response-expiration.md](./trip-request-response-expiration.md).

### FIN-VEH-001 — Type obligatoire à la création d'un véhicule

Statut : implémenté.

Résumé : toute création de véhicule exige désormais un choix explicite parmi `car`, `motorcycle_2_wheels` et `motorcycle_3_wheels`. Les mêmes valeurs sont envoyées depuis l'inscription téléphone, Apple, Google, le profil et la publication d'un trajet.

Impacts financiers :

- aucune transaction, aucun solde et aucun paiement existant ne sont modifiés ;
- la suppression du défaut implicite `car` protège la correspondance entre le véhicule réel et le type qui détermine le tarif d'une demande ;
- la grille tarifaire et les formules de `FIN-TRIP-001` restent inchangées ;
- les véhicules historiques ne sont pas reclassés.

Documentation complète : [vehicle-type-registration.md](./vehicle-type-registration.md).

## 18 août 2026

### FIN-TRIP-001 — Choix du type de véhicule et prix associés

Statut : implémenté dans le code, migration non encore appliquée à une base de production.

Résumé : le passager peut obtenir les trois choix de véhicules et leurs prix pour un même itinéraire, puis enregistrer explicitement son choix dans la demande. Les conducteurs ne peuvent proposer ou utiliser qu'un véhicule du type choisi.

Impacts financiers :

- le prix recommandé dépend maintenant explicitement du type persisté ;
- le serveur reste la source du calcul ;
- le choix est conservé jusqu'à la création du trajet et de la réservation ;
- aucun encaissement existant n'est modifié rétroactivement ;
- les anciennes demandes sont migrées vers `car`.

Documentation complète : [trip-request-vehicle-pricing.md](./trip-request-vehicle-pricing.md).

### DOC-FIN-001 — Gouvernance documentaire financière

Statut : implémenté.

Résumé : création de la documentation financière obligatoire, de ses invariants et du présent journal. Ce changement ne modifie aucun solde et ne déclenche aucun paiement.
