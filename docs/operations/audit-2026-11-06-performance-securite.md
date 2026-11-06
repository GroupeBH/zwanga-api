# Audit performance et sécurité — backend et infrastructure

Date de clôture : 6 novembre 2026, heure de Kinshasa. Audit commencé le 5 novembre.

## Synthèse

**Priorité immédiate : un plan Terraform committé contient des secrets.** Le fichier `infra-aws/tfplan` est suivi par Git et contient un état avec des valeurs JWT, PostgreSQL et Redis. Les valeurs n'ont été ni affichées ni copiées dans ce rapport. Leur validité actuelle et la diffusion du fichier sur GitHub n'ont pas été vérifiées. Traiter cette exposition comme un incident potentiel, sans affirmer qu'une compromission a eu lieu.

La performance HTTP mesurée en production est globalement bonne sur la fenêtre observée. Cela ne garantit ni la tenue à une forte charge ni la rapidité de réception d'une alerte mobile. Les principaux risques restants sont les points uniques de panne, la configuration des proxies, les requêtes administratives coûteuses et le déploiement des nouveaux index.

Le code présente déjà des protections utiles : contrôle des rôles depuis la base, révocation des sessions, OTP hachés avec HMAC, signatures de callbacks, vérifications de paiement côté prestataire, transactions et idempotence, outbox de notifications et protections SSRF. **181 tests ciblés passent ; ce n'est pas une certification de sécurité exhaustive.**

## Périmètre et méthode

- Dépôt `zwanga-backend`, HEAD local `c209603`, avec les modifications présentes et fichiers non suivis conservés.
- Revue des chemins critiques NestJS : authentification, OTP, permissions, paiements, KYC, notifications/dispatch, listes et statistiques administratives, accès SQL/Redis.
- Docker, workflows GitHub Actions, Terraform AWS principal, staging et proxy Squid.
- Lectures AWS : ECS, RDS, ElastiCache, ALB, WAF associé à l'ALB, ECR, configuration S3 et instance proxy. Aucun accès au contenu des documents utilisateurs ni aux valeurs de Parameter Store.
- Audit npm du graphe de dépendances et tests locaux isolés des réseaux externes.
- Pas de test de charge en production, d'exploitation offensive, de modification applicative, de migration, de changement Terraform, de push Git ou de déploiement.
- Les dépôts mobile et admin séparés ne font pas partie de cette revue de code. Le périmètre n'est pas une inspection exhaustive ligne par ligne ni une revue complète de tous les droits du compte AWS.

La production utilise la task definition `zwanga-api-production-api:38`, image digest `sha256:9959f48be24b9e28559431900289fcd1e4d98da26f265d844425065a7231149c`, étiquetée `9c0392f2ee574f7b7a161c977e04e7308447791f` dans ECR. Ce commit n'est pas disponible dans les objets Git locaux consultés : **les constats sur le code local ne prouvent pas à eux seuls la présence du même code dans l'image déployée**.

## Mesures de production

Fenêtre CloudWatch : 5 novembre 2026, de 00 h à 24 h à Kinshasa (4 novembre 23 h UTC au 5 novembre 23 h UTC).

| Élément | Observation |
| --- | --- |
| API | 1 tâche active, 0,5 vCPU, 1 Gio ; aucune cible d'autoscaling ECS retournée dans la région |
| CPU ECS | Moyennes horaires de 1,36 à 3,18 % ; maximum observé 89,30 % |
| Mémoire ECS | Moyenne 24,74 % ; maximum 30,86 % |
| Latence ALB `TargetResponseTime` | p95 103 ms ; p99 325 ms |
| PostgreSQL | `db.t4g.micro`, Single-AZ, stockage chiffré, privé, sauvegardes 7 jours, protection contre suppression |
| CPU PostgreSQL | Moyennes horaires de 4,89 à 5,49 % ; maximum 9,80 % |
| Mémoire libre PostgreSQL | Moyenne environ 131 Mio ; minimum environ 100 Mio |
| Connexions PostgreSQL | Moyenne 7,01 ; maximum 12 |
| Redis/Valkey | 1 nœud `cache.t4g.micro`, pas de failover/Multi-AZ, TLS + authentification + chiffrement au repos |
| Proxy Mobishastra | 1 instance `t4g.micro` active, IMDSv2 obligatoire |

Interprétation : pas de saturation CPU soutenue démontrée. La marge mémoire RDS est à surveiller, mais cette mesure seule ne prouve pas un manque de mémoire ni un besoin immédiat de redimensionnement. Les percentiles ALB agrègent les routes et peuvent inclure les sondes : ils ne représentent pas exclusivement les actions des utilisateurs, la latence réseau du téléphone ou la sonnerie FCM.

## Constats prioritaires

### F01 — Critique / P0 — Secrets présents dans un plan Terraform committé

**Preuves :** `git ls-files` inclut `infra-aws/tfplan`. Dernier commit local portant ce fichier : `ba9884f`, 26 septembre 2026. L'inspection de l'archive, limitée à des indicateurs booléens, confirme un `tfstate` contenant les valeurs de `random_password.database`, `random_password.redis_auth`, `random_password.jwt_secret`, `random_password.jwt_refresh_secret`, ainsi que les paramètres SSM correspondants. Aucun secret n'est reproduit ici.

**Cause :** `.gitignore:56` ignore `*.tfplan`, pas le nom exact `infra-aws/tfplan` ; une règle d'exclusion ne retire de toute façon pas un fichier déjà suivi.

**Impact :** un lecteur du dépôt peut récupérer ces secrets historiques. Le réseau privé et la vérification serveur des sessions limitent certains scénarios, sans rendre acceptable leur exposition.

**Action :** vérifier leur diffusion et leur période d'utilisation ; organiser une rotation coordonnée des secrets concernés ; retirer le fichier du suivi et traiter les copies/historiques avec l'équipe ; bloquer les plans/états dans Git et ajouter une détection de secrets. Ne pas réécrire l'historique ni tourner les clés à l'aveugle : cela peut interrompre les sessions ou les connexions applicatives.

**Confiance :** exposition dans le dépôt local confirmée ; validité actuelle, accès malveillant et diffusion distante non établis. HashiCorp confirme que les secrets peuvent être enregistrés en clair dans les [plans sauvegardés](https://developer.hashicorp.com/terraform/cli/commands/plan#out-filename).

### F02 — Élevé / P1 — Configuration du proxy de confiance absente de la tâche déployée

**Preuves :** `src/main.ts:165` configure `trust proxy=false` sans `TRUSTED_PROXY_CIDRS`. `src/common/guards/throttler.guard.ts:8` utilise `req.ip` pour les appels anonymes. ECS révision 38 n'injecte pas cette variable, ni via `environment` ni via `secrets`. ALB ajoute les adresses dans `X-Forwarded-For` (`append`).

**Impact attendu avec ce code :** les clients anonymes arrivant par un même nœud ALB partagent son adresse et donc le quota d'une route : des utilisateurs distincts peuvent se bloquer mutuellement sur login, OTP ou inscription.

**Action :** configurer explicitement les réseaux réels des proxies approuvés et tester la séparation des quotas derrière l'ALB. Ne pas activer un `trust proxy=true` universel et ne pas faire confiance à un `X-Forwarded-For` fourni arbitrairement par le client.

**Confiance :** absence de configuration AWS et comportement local confirmés ; effet exact en production à valider sur l'image et avec un test contrôlé. [Référence Express](https://expressjs.com/en/guide/behind-proxies/).

### F03 — Élevé / P1 — Identité PostgreSQL applicative non séparée de l'administration

**Preuves :** `infra-aws/database.tf:23` configure le compte principal RDS avec `var.database_username`. `infra-aws/ssm.tf:16` réutilise ce compte et son mot de passe pour `DATABASE_URL`. La tâche de production référence ce paramètre généré. `src/database/typeorm-options.ts:183` prévoit une URL de migration distincte, mais aucune référence `MIGRATION_DATABASE_URL` n'est injectée dans la révision observée.

**Impact :** selon l'IaC, la compromission du processus applicatif donne des droits SQL plus larges que ceux requis au quotidien, avec un risque accru de modification du schéma ou d'effacement. Il ne s'agit pas d'une injection SQL démontrée.

**Action :** compte runtime à privilèges minimaux et compte de migration séparé ; vérifier les fonctions/triggers financiers, leurs propriétaires et permissions avant de réduire les droits.

**Confiance :** montage IaC et référence ECS confirmés ; les valeurs SSM et les grants réels du rôle n'ont pas été lus. RDS n'accorde pas exactement les mêmes privilèges qu'un superutilisateur PostgreSQL autonome.

### F04 — Élevé / P1 avant déploiement — Nouvelle migration d'index potentiellement bloquante

**Preuves :** `src/database/migrations/1780000114000-AdminAnalyticsIndexes.ts:22` et `:31` créent dix index avec `CREATE INDEX`, sans `CONCURRENTLY`. `:49` les regroupe dans une transaction. Les budgets `lock_timeout=3s` et `statement_timeout=30s` s'appliquent aux instructions, pas à la durée globale de conservation des verrous. Le workflow déploie les migrations alors que l'ancienne API tourne encore (`.github/workflows/deploy.yml:162`).

**Impact :** les écritures sur les tables concernées peuvent attendre pendant la construction et jusqu'à la fin de transaction ; une table volumineuse peut faire échouer la migration et le déploiement. Les limites de temps réduisent le risque, sans garantir une exécution sans interruption. Ce n'est pas un incident déjà observé en production.

**Action :** mesurer sur une copie représentative ; préparer les index avec une stratégie concurrente hors transaction, contrôler leur validité et prévoir la reprise d'un index invalide. La migration mentionne déjà la possibilité d'une préconstruction concurrente, mais celle-ci reste manuelle. [Documentation PostgreSQL](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

### F05 — Moyen / P1 financier — Virements administratifs sans authentification renforcée

**Preuves :** `src/auth/auth.service.ts:606` délivre les tokens admin après mot de passe, sans seconde étape dans ce parcours. `src/admin/admin-direct-payout.controller.ts:29` protège l'envoi par rôle et throttling. `src/admin/admin-direct-payout.service.ts:42` vérifie l'acteur puis initie le versement. Le DTO autorise jusqu'à 99 999 999,99 CDF par ordre et une confirmation booléenne, sans preuve d'authentification récente ni validation par une seconde personne.

**Impact :** une session super admin volée peut permettre des décaissements. L'idempotence évite le doublon d'un même ordre, pas des ordres malveillants avec des identifiants distincts.

**Action :** MFA administrateur, confirmation renforcée liée au montant et au destinataire, plafonds opérationnels cumulés et double validation au-delà d'un seuil choisi par l'équipe. Préserver les contrôles actuels de preuve de non-paiement et d'idempotence.

**Confiance :** absence dans les chemins inspectés confirmée ; aucune session volée ni exploitation démontrée. Les rôles, états de compte, motifs et traces financières constituent déjà des protections.

### F06 — Élevé / P1 disponibilité — Points uniques de panne API, SQL, Redis et proxy OTP

**Preuves AWS :** une tâche API ; RDS `MultiAZ=false` ; un seul nœud Redis, failover désactivé ; une seule instance proxy. Références : `infra-aws/ecs.tf:206`, `infra-aws/database.tf`, `infra-aws/redis.tf:20`, `infra-aws/environments/mobishastra-proxy/main.tf:140`.

**Impact :** une panne d'un composant peut arrêter le flux correspondant. En particulier, `src/common/services/redis-throttler.storage.ts` échoue fermé : une panne Redis rend indisponibles les routes soumises au contrôle de débit. Le repli SQL du dispatch ne permet pas à lui seul de maintenir toute l'API. Le proxy est aussi une dépendance unique lorsque l'envoi Mobishastra l'exige.

**Action :** planifier la redondance selon budget et criticité : deux tâches distribuées, réplica Redis avec failover, RDS Multi-AZ, procédure de reconstruction/remplacement du proxy conservant son EIP et son interface privée. Tester les reprises et la restauration des sauvegardes. Ne pas supprimer les contrôles anti-abus pour masquer une panne Redis.

**Confiance :** état AWS confirmé. Pas de simulation de panne ; les sauvegardes 7 jours et le rollback ECS ne sont pas une bascule automatique des dépendances.

### F07 — Moyen / P2 — Exports et certains historiques non bornés en mémoire

**Preuves :** `src/admin/admin.service.ts:935`, `:993`, `:1077` chargent tous les trajets/réservations/demandes correspondants sans pagination. `src/admin/spreadsheet.ts:43` matérialise les lignes XML, les concatène puis crée un Buffer à `:59`. Le parcours historique KYC de `src/admin/admin.service.ts:279` charge aussi tous les dossiers en attente.

**Impact :** avec un volume élevé, une seule action admin peut accroître fortement mémoire et CPU du même processus que les paiements et alertes. Plusieurs copies du contenu coexistent. Le throttling n'impose pas de limite de taille à chaque export.

**Action :** exports asynchrones bornés, lecture par lots/curseur, écriture en flux et téléchargement temporaire protégé ; faire évoluer les anciens historiques vers les endpoints paginés sans casser leurs consommateurs.

**Confiance :** algorithme confirmé ; aucune panne mémoire ni seuil maximal de lignes mesuré pendant cet audit.

### F08 — Moyen / P2 — Amplification SQL dans la liste admin des demandes

**Preuves :** `src/admin/admin.service.ts:1063` lance `Promise.all` et `findOne` pour chaque ligne après la première requête. La limite peut atteindre 200 (`:105`). `src/trip-requests/trip-requests.service.ts:917` recharge plusieurs relations, vérifie l'expiration et peut ajouter des requêtes de fenêtre de réponse. Pool SQL applicatif par défaut : 10 (`src/database/typeorm-options.ts:113`).

**Impact :** jusqu'à 200 appels d'hydratation pour une page, et potentiellement davantage de requêtes SQL, en concurrence avec les opérations métier. Ce nombre n'est pas un chronométrage ni un compte exact de requêtes produit par TypeORM.

**Action :** projection admin dédiée, chargement groupé des relations et fenêtres, traitement d'expiration par lot ; garder les contrôles d'accès des endpoints mobiles séparés.

**Confiance :** N+1 confirmé par le chemin de code ; coût sur les données de production non mesuré.

### F09 — Moyen / P2 — Recherche globale coûteuse à mesure que les tables grandissent

**Preuves :** `src/admin/admin-analytics.service.ts:267` utilise quatre CTE matérialisées avec `ILIKE '%terme%'`, des UUID convertis en texte et des comptes complets. Les `LIMIT 10` interviennent après l'ensemble des correspondances. Aucun index trigramme correspondant trouvé dans les migrations inspectées. Le timeout SQL est limité à 8 secondes (`:29`).

**Impact :** les index classiques sur identifiant ou date ne résolvent pas ces recherches partielles ; scanner et compter les correspondances peut coûter cher malgré dix résultats affichés. La nouvelle statistique en base évite les échantillons tronqués, mais n'est pas automatiquement peu coûteuse.

**Action :** privilégier l'égalité pour un UUID complet et les références exactes, normaliser la recherche téléphonique, puis évaluer les index trigrammes utiles avec `EXPLAIN (ANALYZE, BUFFERS)` sur une copie représentative. Conserver les totaux contractuels ; envisager un cache court des agrégats avec une définition explicite de fraîcheur.

**Confiance :** forme des requêtes confirmée ; plan réel, indexes créés hors migrations et volumétrie de production non vérifiés.

### F10 — Moyen / P2 — Alertes de dépendances et contrôles CI incomplets

**Preuves :** l'exécution `npm audit --omit=dev --json` a retourné 25 entrées de paquets : 23 modérées, 2 faibles, aucune élevée/critique. Le résultat comprend aussi des outils de développement et des dépendances transitives partagées : **ce ne sont pas 25 vulnérabilités distinctes exploitables en production**. Les alertes racines concernent notamment `minimatch`, `glob` et `deepmerge`. ADOT, TypeORM et des bibliothèques Google apparaissent par propagation des dépendances.

Le workflow `.github/workflows/deploy.yml` lance les tests d'intégration de dépendances, mais pas le script `check:security`, ni un contrôle visible de résultats de scan d'image/secrets/IaC. ECR a bien `scan_on_push=true` (`infra-aws/ecr.tf:6`). Plusieurs actions sont référencées par tag plutôt que SHA ; la provenance et le SBOM de l'image sont désactivés dans ce workflow.

**Impact :** un paquet vulnérable ou un secret nouvellement committé peut ne pas bloquer le déploiement. Les tests fonctionnels ne remplacent pas un scanner. Aucun chemin d'exploitation à distance des alertes npm n'a été démontré ; la version corrigée de minimatch est documentée dans l'[avis du mainteneur](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).

**Action :** trier runtime/dev et atteignabilité, mettre à jour de façon ciblée avec tests, puis ajouter des contrôles CI adaptés. Ne pas appliquer `npm audit fix --force` : les propositions incluent des changements majeurs/rétrogradations. Ces adaptations CI nécessitent un changement séparé et n'ont pas été appliquées.

### F11 — Moyen / P2 — Protection anti-abus principalement dans l'application

**Preuves :** `src/app.module.ts:130` exécute l'authentification avant le throttler. La stratégie JWT lit l'identité en base (`src/auth/strategies/jwt.strategy.ts:36`). Aucun Web ACL associé à l'ALB n'a été retourné par AWS. Les journaux d'accès ALB sont désactivés ; la mitigation de désynchronisation HTTP est en mode `defensive`.

**Impact :** un flot de requêtes portant des tokens correctement signés peut provoquer du travail SQL avant la limitation applicative ; des tokens signés mais révoqués échouent avant ce throttler. Les JWT mal signés sont bien rejetés avant la lecture SQL. Sans contrôle en amont démontré, l'API absorbe davantage de trafic abusif ; les logs ALB manquants compliquent l'analyse.

**Action :** limiter le trafic par IP en amont de l'authentification avec une politique compatible ALB, conserver les quotas par compte et envisager un filtrage WAF ciblé selon les mesures et le budget. Journaliser de manière proportionnée, sans URL contenant OTP/tokens ni corps sensibles.

**Confiance :** ordre des guards et absence de WAF sur cet ALB confirmés ; les autres éventuelles protections amont n'ont pas été inventoriées. Ce constat ne signifie pas que les routes sont dépourvues de throttling ou qu'une attaque est en cours.

## Protections conservées et points non classés comme vulnérabilités confirmées

- Contrôles des rôles depuis l'identité SQL, empreinte de token, comptes inactifs/suspendus refusés ; tests HTTP réels avec dépendances factices.
- OTP Mobishastra : génération cryptographique, HMAC lié au contexte, cinq tentatives, transitions atomiques Redis ; transport HTTPS à URL fixe, pas de redirection, suppression des traces contenant OTP et identifiants.
- Paiements : vérification prestataire, validations de montant/devise/référence, idempotence et verrouillage. Les callbacks FlexPay publics ne sont donc pas assimilables à une validation aveugle du paiement.
- Dispatch : outbox durable, récupération des échéances SQL/Redis, concurrence bornée, relance après commit, contrôle de validité des invitations avant envoi ; erreurs Firebase classifiées et envoi interrompu à échéance. Cela ne garantit pas la livraison sur un téléphone hors connexion.
- Entrées validées, tris SQL sur liste autorisée, paramètres de requêtes séparés ; aucune injection SQL exploitable démontrée dans les chemins examinés.
- Rapports Stores et médias KYC : allowlist HTTPS, rejet des adresses privées, résolution DNS fixée, tailles et redirections bornées dans les transports examinés.
- HTTPS ALB avec redirection du port 80 ; port API accessible depuis le SG ALB uniquement ; RDS privé ; Redis chiffré/authentifié.
- Bucket `medias-zwanga` : quatre blocages d'accès public actifs, chiffrement AES256. Pas de bucket policy trouvée : ajouter une politique refusant explicitement le transport non TLS est un durcissement à étudier, pas une preuve d'accès public. Aucun objet KYC n'a été consulté.
- Docker multi-étapes, dépendances de production et utilisateur `node` ; les fichiers `.env` et l'infrastructure ne sont pas copiés dans l'image. OIDC déploiement borné à la branche prévue dans l'IaC et images déployées par digest.
- Squid : accès privé depuis ECS, CONNECT uniquement vers les hôtes autorisés, pas d'interception TLS, logs sans URL/OTP ; staging revu statiquement pour isolation réseau, stockage et IMDSv2.
- Swagger reste exposé par le code local (`src/main.ts:261`) : à restreindre si inutile publiquement, mais ce n'est pas en soi un contournement des permissions.
- Node local `24.11.0`, alors que `package.json` demande `>=24.22.1 <25` : harmoniser avant de considérer les essais locaux représentatifs du runtime prévu. Version exacte embarquée dans l'image de production non inspectée.
- `AWS_S3_SETUP.md:170` contient l'identifiant AWS officiel d'exemple ; il a été écarté comme faux positif. Le contrôle textuel de motifs n'est pas un scan exhaustif de l'historique des secrets.

## Vérifications réalisées et limites

- 14 suites ciblées, **181 tests réussis**, 70,134 secondes. Résultat : `tmp/admin-analytics-1793920009889.log` (artefact local ignoré par Git).
- Couverture exécutée : frontières JWT/RBAC/DTO, rotation de session, WebSockets, throttling, sécurité HTTP/uploads, confidentialité et instrumentation OTP, logique Mobishastra, envois Firebase bornés, signatures Didit/PawaPay.
- Audit npm terminé ; aucun paquet installé ou modifié. Pas de validation exhaustive de l'image Docker, des paquets OS ou de toutes les dépendances en conditions d'exploitation.
- Pas de suite complète du backend relancée ; pas de test mobile/admin ; pas de test des fournisseurs payants.
- Pas d'EXPLAIN sur PostgreSQL de production, pas de simulation de panne ni restauration de sauvegarde. Performance Insights RDS désactivé dans la configuration observée.
- Pas d'application ni de validation CLI Terraform complète. Aucun fichier de code, workflow, secret ou ressource AWS changé pendant cet audit. Seul ce rapport est ajouté.

## Ordre de traitement proposé

1. **P0 :** traiter l'exposition des secrets du plan Terraform, avec rotation et gestion des copies/historiques.
2. **Avant prochain déploiement :** vérifier les proxies approuvés et rendre sûre l'exécution de la migration d'index.
3. **Sécurité financière et SQL :** authentification renforcée admin et séparation compte runtime/migrations.
4. **Continuité :** prioriser Redis, API et PostgreSQL selon le budget ; documenter et tester la reprise du proxy OTP.
5. **Montée en charge :** exports asynchrones, suppression du N+1, optimisation mesurée de la recherche et des agrégats.
6. **Prévention :** contrôles de secrets/dépendances/IaC/images, observabilité et tests isolés à charge représentative.

La revue a suivi les grilles de sécurité JavaScript/Express et de bonnes pratiques PostgreSQL : distinction entre preuves et hypothèses, moindre privilège, requêtes groupées et impact des verrous. Les corrections proposées restent à implémenter et à valider séparément.
