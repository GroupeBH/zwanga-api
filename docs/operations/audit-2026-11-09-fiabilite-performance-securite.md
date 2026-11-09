# Audit transversal — 9 novembre 2026

## Conclusion

Ce rapport décrit l’état avant correction. Le [suivi des correctifs et validations](correctifs-audit-2026-11-09.md) précise les changements locaux réalisés ensuite et les travaux restant ouverts.

Les protections des flux financiers et du dispatch ont réellement progressé : mutations conditionnelles, opérations idempotentes, outbox transactionnelle, délais réseau bornés et contrôles de propriété sont présents. Cependant, il reste des défauts reproductibles dans l'admin et le module terrain, une dette de sécurité importante dans les dépendances de l'admin et des limites de disponibilité dans la configuration d'infrastructure.

**Avis : ne pas considérer cet audit comme un feu vert de non-régression globale ou de haute disponibilité.** La suite mobile est rouge ; la suite backend complète n'a pas été menée à son terme sur ce poste. Les points ci-dessous sont classés selon l'impact, en distinguant les faits reproduits des risques conditionnels.

## Périmètre et méthode

- Backend NestJS : HEAD `e4bb7eb`, notamment les ajouts d'agents terrain et de déclaration/confirmation du cash, partenaires, paiements/jetons, OTP, sessions, notifications/dispatch, Stores et supervision mobile.
- Lectures croisées de `../zwanga-admin` (HEAD `9705445`), `../zwanga` (HEAD `bd01030`) et des mécanismes de session de `../zwanga-partner`. L'admin contient des modifications préexistantes, conservées.
- Infrastructure **décrite dans le dépôt** : Terraform, ECS/RDS/Redis, proxy Mobishastra, Docker et workflow de déploiement. Aucun contrôle de l'état AWS réel, aucune panne provoquée, aucun changement en production pendant cet audit.
- Revue de sécurité TypeScript/Express/React/Next.js et de pratiques PostgreSQL : droits minimaux, transactions courtes et complètes, pagination, contrôles d'accès et bornes réseau.
- Tests locaux, scénarios de panne simulée, PostgreSQL isolé et `npm audit --omit=dev --json`. Aucun SMS, paiement réel ou appel de publication aux Stores déclenché.
- Les numéros de ligne ci-dessous correspondent à l'état inspecté. Les observations sur des fichiers en cours de modification doivent être revérifiées après fusion.

P1 : correction prioritaire avant une livraison sensible. P2 : défaut ou risque à traiter dans le prochain lot de fiabilisation. Une gravité élevée ne signifie pas qu'une exploitation ou un incident en production a été démontré.

## Constats prioritaires

### SEC-01 — P1 — Dépendances de l'admin concernées par des avis de sécurité critiques

**Preuves :** `../zwanga-admin/package.json:14`, `package-lock.json`, `next.config.mjs:42`. Le verrouillage conserve Next.js **16.1.6** et Sharp **0.34.5**. L'audit npm de l'admin signale **9 entrées de paquets : 1 critique, 6 élevées, 2 modérées** ; ce ne sont pas nécessairement neuf vulnérabilités indépendantes ou toutes exploitables dans cette application.

Les avis officiels Next.js sur l'optimisation d'images incluent des possibilités d'exécution de code dans des dépendances natives. L'avis d'octobre précise notamment la condition Linux/glibc et un correctif Next.js 16.4.1 ou Sharp 0.35.5. [Avis AVIF](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4), [avis d'octobre](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw).

La configuration autorise aussi très largement les images distantes sous `*.amazonaws.com`, `s3.*.amazonaws.com` et `*.s3.amazonaws.com`. Cela peut permettre l'utilisation d'images provenant d'un bucket qui n'appartient pas à Zwanga, si l'optimiseur est exposé.

**Limite importante :** ni l'OS d'hébergement de l'admin ni l'exposition effective de son optimiseur n'ont été vérifiés. Aucun exploit tenté. L'avis distinct sur `use cache` n'est pas retenu comme exploitable faute de preuve que ses conditions soient réunies dans l'admin.

**Action :** mettre à jour Next.js et Sharp vers des versions corrigées compatibles, conserver un lockfile reproductible, restreindre les domaines aux buckets nécessaires, refaire build et tests. Ne pas appliquer aveuglément `npm audit fix --force`.

### REL-01 — P1 — Renouvellements concurrents de session : déconnexion injustifiée de l'admin

**Preuves :** `../zwanga-admin/lib/features/api/baseApi.ts:49–68`, comparé à `src/auth/auth.service.ts:816–899`.

Chaque réponse 401 déclenche son propre `/auth/refresh`, sans mutualisation et sans `requestId` de récupération. Le backend fait correctement une rotation atomique du refresh token : deux appels avec l'ancien token ne doivent pas réussir indépendamment. Le second peut donc recevoir 401 **après** que le premier a installé les nouveaux tokens ; son traitement efface alors la session valide.

De plus, toute réponse de refresh ne contenant pas les tokens, y compris une erreur temporaire 503, entraîne `clearAuthTokens()`.

**Reproduction :** deux sondes exécutant le véritable `baseQuery` transpilé, avec réseau simulé, ont confirmé (1) l'effacement d'une session nouvellement renouvelée par la réponse perdante et (2) la déconnexion sur 503. Ce n'est pas un test HTTP de production.

**Action :** une seule rotation en vol par session, `requestId` stable pour récupérer une réponse perdue, protection contre les réponses d'une ancienne session, suppression des tokens uniquement sur invalidation définitive. Conserver les tokens et proposer un nouvel essai en cas de panne temporaire. Le mobile dispose déjà de mécanismes plus avancés de mutualisation/récupération : aligner les contrats sans affaiblir la rotation backend.

### SEC-02 — P1 — Le Terraform injecte l'identité maître RDS dans l'application

**Preuves :** `infra-aws/database.tf:23`, `infra-aws/ssm.tf:16` et `:99`. Le même `database_username` et le même mot de passe servent à créer le compte maître RDS puis le `DATABASE_URL` injecté au runtime.

**Impact :** une compromission du processus applicatif bénéficie de droits PostgreSQL plus étendus que ceux nécessaires aux opérations courantes. Cela augmente notamment le risque de modification du schéma et de contournement de protections qui reposent sur des contraintes ou triggers.

**Limite :** c'est le câblage du dépôt. Un éventuel remplacement manuel des identifiants ou des droits en production n'a pas été vérifié. Aucune injection SQL n'a été démontrée.

**Action :** séparer le rôle runtime DML et le rôle de migration DDL, limiter les grants au schéma/tables nécessaires et injecter `MIGRATION_DATABASE_URL` uniquement dans la tâche de migration. Tester les migrations et les flux financiers avec les droits réels avant activation.

### REL-02 — P2 — Ticket terrain : création partielle et doublons sur nouvel essai

**Preuves :** `src/partners/partners.service.ts:256–266`, `src/support/support.service.ts:228–257`.

Le service crée d'abord le ticket support, puis son lien terrain dans une autre écriture. Le service support sauvegarde lui-même le ticket et le premier message séparément. Il n'existe donc pas de transaction commune pour ces trois écritures, ni de clé d'idempotence du parcours.

**Impact :** si l'enregistrement du message ou du lien terrain échoue, un ticket peut subsister sans son message initial ou sans apparaître dans la liste terrain. Réessayer peut créer un autre ticket.

**Reproduction :** une sonde sur le véritable service partenaires, avec échec simulé du repository terrain, confirme deux créations support après deux essais et aucun lien terrain enregistré. La panne SQL réelle n'a pas été injectée dans la base applicative.

**Action :** regrouper les écritures SQL dans une transaction partagée et ajouter l'idempotence de création. Les éventuelles notifications doivent être déclenchées après commit ou via outbox, pas pendant une transaction longue.

### PERF-01 — P2 — Module terrain : lectures non bornées et agrégations en mémoire

**Preuves :** `src/partners/partners.service.ts:96`, `:173`, `:188–228`, `:250`.

- La vue d'ensemble charge tous les leads autorisés, sans période ni pagination.
- `leadProgress` construit une liste de variantes téléphoniques pour tout l'historique, puis charge les utilisateurs et leurs relations KYC/véhicules complètes.
- Le premier trajet est recherché pour tous les identifiants obtenus ; les résultats et objectifs sont ensuite rapprochés en mémoire.
- Les listes de membres et de tickets ne sont pas paginées non plus.

**Impact :** requêtes et réponses croissant avec l'historique, pression mémoire, jointures potentiellement multiplicatives KYC × véhicules et augmentation du nombre de paramètres SQL. Cela peut ralentir les autres traitements du même processus Node.js. L'accès est bien limité à l'organisation/à l'agent : il ne s'agit pas ici d'une fuite inter-organisations démontrée.

**Action :** listes paginées, projections minimales, statistiques agrégées en SQL et filtres de période ; vérifier les index avec `EXPLAIN (ANALYZE, BUFFERS)` sur un jeu représentatif isolé. Aucun temps de réponse de production ni seuil de charge maximal n'a été mesuré dans cet audit.

### HA-01 — P2 — Les valeurs d'infrastructure fournies ne garantissent pas la haute disponibilité

**Preuves :** `infra-aws/variables.tf:124`, `:182`, `:239`, `:245` ; `terraform.tfvars.example:17–46` ; `redis.tf:23–24` ; `environments/mobishastra-proxy/main.tf:140`.

Les valeurs par défaut/exemples sont : RDS non Multi-AZ, un nœud Redis, une tâche ECS et autoscaling désactivé. Le proxy Mobishastra utilise une seule instance EC2 avec IP fixe. L'IP fixe répond au besoin de whitelist, mais ne rend pas le proxy redondant.

Redis reste une dépendance de disponibilité pour le throttling et certains flux d'authentification/OTP. Le refus sécurisé en cas de panne est préférable à un contournement de sécurité, mais le secours SQL du dispatch ne suffit pas à rendre toute l'API disponible sans Redis.

**Action :** vérifier d'abord les valeurs effectivement appliquées dans AWS, puis planifier au moins deux tâches réparties, la redondance RDS/Redis, les alarmes et une procédure testée de remplacement du proxy. Dimensionner le pool SQL en tenant compte du nombre de tâches. Ne pas transformer cette observation de configuration en affirmation sur l'état actuel de la production.

### PERF-02 — P2 — Cache de candidats du dispatch plus court que le délai conducteur

**Preuves :** `src/trip-requests/dispatch/request-driver-queue.ts:6`, `:31–32` ; `sequential-policy.ts:4` ; `sequential-dispatch.service.ts:108–155`.

La liste Redis de candidats expire après **30 secondes**, alors que la fenêtre de réponse conducteur vaut **40 secondes**. À l'expiration normale d'une invitation sans réaction, la liste peut donc déjà avoir disparu : le service recalcule les candidats en base avant le relais suivant. Les refus rapides bénéficient davantage du cache.

**Impact :** le gain attendu de la file Redis est réduit dans un scénario fréquent. Ce n'est pas une preuve de perte de notification : le recalcul SQL est un mécanisme de récupération et permet aussi de rafraîchir les positions.

**Action :** mesurer le coût de ces recalculs ; choisir explicitement une durée de cache couvrant le relais ou un rafraîchissement anticipé, tout en revalidant le conducteur sélectionné et en conservant des limites de fraîcheur/version. Ne pas supprimer les contrôles métier pour accélérer la file.

### QA-01 — P2 — Les tests mobiles ne sont plus alignés avec les ajouts récents

**Résultat complet : 3 480 réussites, 8 échecs, 1 ignoré, sur 3 489 tests JavaScript.**

- `tests/driverEarningsPresentation.test.js:17` et `:40` : deux anciens textes « espèces » attendus au lieu de « cash ».
- `tests/driverFinance.test.js:28`, `publishPricingLayout.test.js:65` et `simpleTripForms.test.js:36` : recherches de contrôles par ancien libellé d'accessibilité, puis accès à `undefined.props`.
- `tests/frenchMessages.test.js:45` et `publishPricingLayout.test.js:35` : libellés attendus non actualisés.
- `tests/sourceExtractions.test.js:26` : empreinte de `bookingApi.ts` non actualisée pour `declareCashPayment` et le changement de `confirmCashReceipt`.

**Conclusion :** sept échecs sont expliqués par les libellés et le huitième par le contrôle de contrat/empreinte. Ils ne démontrent pas huit erreurs fonctionnelles de paiement, mais ils empêchent de déclarer la suite verte et certaines assertions métier ne sont plus atteintes.

**Action :** valider les nouveaux libellés et le contrat cash, mettre à jour les tests après cette revue, préférer des identifiants de test stables quand le texte n'est pas l'objet du test. Ne pas simplement supprimer les contrôles ou régénérer les empreintes sans comparaison.

### QA-02 — P2 — Certaines intégrations critiques restent ignorables en CI

**Preuves :** `.github/workflows/deploy.yml:61–79`, `src/app-updates/installation-updates-postgres.spec.ts:16–17`, `src/otp/mobishastra-otp.redis.spec.ts:13–17`.

Le workflow configure plusieurs suites PostgreSQL et un Redis de dispatch, ce qui est positif. Il ne fournit toutefois pas `INSTALLATION_UPDATES_TEST_POSTGRES_BIN` ni les deux paramètres nécessaires aux tests OTP Redis (`OTP_TEST_REDIS_PORT`, `OTP_TEST_REDIS_PASSWORD`). Ces suites peuvent donc être ignorées sans rendre le job rouge.

Le smoke test `test:dependencies` vérifie des intégrations mais ne remplace pas une veille des avis de vulnérabilité. Aucun appel à `npm audit` n'est présent dans le workflow de déploiement inspecté.

**Action :** matrice explicite des intégrations requises, Redis OTP isolé, contrôle du nombre de tests ignorés et vérification de vulnérabilités avec politique d'exceptions documentée. Harmoniser aussi le Node local avec `.nvmrc` : ce poste utilise 24.11.0, alors que le backend/Docker exigent 24.22.1 ou supérieur dans la branche 24.

### SEC-03 — P2 — Tokens de l'admin accessibles au JavaScript

**Preuves :** `../zwanga-admin/lib/utils/cookies.ts:6–19`, `next.config.mjs:11`.

Les tokens sont écrits par `js-cookie` : ils ne sont donc pas HttpOnly, notamment le cookie de refresh conservé jusqu'à 90 jours côté navigateur. `Secure` et `SameSite=Strict` sont présents, mais ne protègent pas contre la lecture par un script exécuté sur l'origine.

**Limite :** aucune XSS n'a été démontrée. L'absence de CSP dans cette configuration ne prouve pas son absence au niveau du CDN/proxy. La durée du cookie n'est pas nécessairement la durée de validité du JWT.

**Action :** envisager un BFF avec cookies HttpOnly, contrôle d'origine/CSRF et renouvellement centralisé, puis une CSP adaptée. Le portail partenaire utilise déjà une approche serveur qui peut servir de référence ; elle doit elle aussi être vérifiée en multi-instance et en cas de réponse de refresh perdue.

## Points solides à préserver

- **Cash :** déclaration du passager distincte de la réception confirmée par le conducteur ; vérification propriétaire/statut/mode/montant/devise ; mise à jour conditionnelle et outbox transactionnelle. La déclaration ne déclenche pas un transfert Mobile Money et ne crédite pas artificiellement le solde retirable.
- **Création d'agent :** séparation compte existant/nouveau, aucune modification du PIN d'un compte existant, création compte/affectation dans une transaction, conflit concurrent converti en erreur métier. Le PIN initial des nouveaux agents mérite néanmoins une politique explicite de remise sécurisée et de changement par son titulaire.
- **Finance admin :** OTP lié à l'administrateur, au type d'opération et à son contenu ; consommation à usage unique ; retrait du code avant passage aux services financiers. Les relances de retrait ne sont pas de simples bascules aveugles d'un état `pending` vers un nouvel envoi.
- **OTP Mobishastra :** HMAC des codes, durée et tentatives bornées, transitions atomiques, séparation des finalités, suppression des traces HTTP contenant les paramètres sensibles, TLS et proxy explicites.
- **Dispatch/alertes :** file par demande, verrous avec propriétaire, état durable SQL et outbox, déclenchement rapide après commit, récupération des échéances SQL/Redis et revalidation avant sonnerie côté mobile. Les coupures Internet et restrictions OS empêchent néanmoins toute garantie absolue de sonnerie.
- **Firebase/Redis :** envois Firebase bornés avec annulation réseau ; délais Redis et absence de réémission aveugle des écritures ; limitation du travail concurrent.
- **Infrastructure :** conteneur non-root, TLS et stockage chiffré, RDS privé, protection contre suppression et sauvegardes configurées, rôle distinct pour les tâches ECS. Ces protections ne remplacent pas la redondance et un exercice de restauration.

## Vérifications exécutées et limites

| Vérification | Résultat |
|---|---|
| TypeScript backend, `tsconfig.build.json`, sans émission | Réussi |
| TypeScript admin, sans émission | Réussi |
| Backend `test/dependency-security.test.cjs` | 7 réussis |
| Admin `tests/*.test.cjs` | 18 réussis ; ne couvre pas tous les tests colocalisés du dépôt |
| Mobile `tests/*.test.js`, concurrence 2 | 3 480 réussis, 8 échecs, 1 ignoré |
| Cash PostgreSQL isolé + HTTP/Socket.IO + harness mobile JS | 6 réussis |
| Sondes de reproduction admin/session et ticket terrain | 3 scénarios confirment les défauts REL-01/REL-02 |
| Sélection backend nouveautés et flux critiques | 15 suites, 180 tests réussis ; 178,171 s sur ce poste |
| Suite backend complète | Interrompue pour lenteur locale ; les résultats partiels ne constituent pas une validation globale |
| OTP sur Redis jetable via WSL | Non validé : Redis de test inaccessible, `ECONNREFUSED` ; aucune conclusion de régression applicative |
| Audit npm backend, dépendances non-dev | 7 entrées faibles, aucune élevée/critique signalée |
| Audit npm mobile, dépendances non-dev | 58 entrées faibles, aucune élevée/critique signalée |
| Audit npm admin, dépendances non-dev | 1 critique, 6 élevées, 2 modérées |

Les entrées faibles backend/mobile proviennent de l'avis `deepmerge` et de sa propagation dans l'arbre de dépendances ; il ne faut pas les présenter comme 65 vulnérabilités indépendantes. Les audits de dépendances ne prouvent ni l'absence de failles applicatives ni l'exploitabilité de chaque avis.

Les tests ciblés backend utilisent la transpilation isolée de ts-jest, avec le contrôle TypeScript de production exécuté séparément. Les tentatives initiales de tests PostgreSQL dans le sandbox n'ont pas pu démarrer leurs serveurs ; le test cash a ensuite réussi dans une instance PostgreSQL locale jetable autorisée. Les durées observées sur cette machine chargée ne sont pas des mesures de latence API.

Les 15 suites ciblées couvrent les services partenaires, le choix compte existant/nouveau et la normalisation téléphonique, l'OTP financier et Mobishastra/confidentialité, les annonces de versions et statistiques Stores/noms de rapports Apple, la politique/livraison de supervision mobile, la livraison des mises à jour, Firebase borné et les échéances/reprises du dispatch. Les preuves détaillées et sondes sont dans le dossier local ignoré `tmp/audit-2026-11-09/` : `backend-targeted.json`, `cash-postgres.log`, `mobile-tests.log`, `admin-tests.log`, `reproduce.cjs` et les rapports npm. Elles ne sont pas publiées ni commitées.

Ne sont **pas validés** ici : build natif Android/iOS, comportement réel écran verrouillé/Doze, livraison FCM/APNs, intégration réelle Mobishastra/FlexPay/Stores, charge de production, bascule Multi-AZ, restauration de sauvegarde et état des secrets dans AWS.

Le rapport du 6 novembre mentionnait un ancien plan Terraform contenant des secrets. Le retrait d'un fichier du suivi Git ne démontre pas leur rotation ni la disparition des anciennes copies. Ce point reste une vérification opérationnelle à clore, sans présumer que les identifiants historiques sont encore actifs.

## Ordre de traitement recommandé

1. Corriger les dépendances de l'admin et le renouvellement concurrent des sessions.
2. Rendre les tests mobiles à nouveau cohérents, puis exécuter la suite backend complète sous le Node prévu et les intégrations obligatoires en CI.
3. Rendre la création des tickets atomique/idempotente ; paginer et agréger en base les données terrain.
4. Séparer les droits PostgreSQL de runtime/migration, avec tests de non-régression financiers.
5. Mesurer la latence création → réservation → envoi fournisseur → réception/validation → sonnerie ; optimiser la durée du cache de candidats sur ces mesures.
6. Vérifier l'infrastructure effectivement déployée et planifier redondance, alertes, restauration et reprise du proxy.

Aucun correctif applicatif, changement de style, migration de la base métier, push Git ou déploiement AWS effectué dans ce passage. Seuls ce rapport et des artefacts locaux de test ont été ajoutés.
