# Livraison des correctifs de fiabilité et de sécurité

Les correctifs conservent les routes existantes et les réponses en tableau utilisées par les anciens clients. Ils ajoutent deux migrations, la reprise durable des dépôts FlexPay et un déploiement ECS par digest. Aucun déploiement ni changement de données AWS n'a été effectué pendant leur préparation.

## Prérequis de livraison

1. Relire le plan Terraform **de production**, sans appliquer le staging par inadvertance. Appliquer les permissions OIDC `ecs:DescribeTaskDefinition` et `ecs:RegisterTaskDefinition`, ainsi que la configuration du circuit breaker ECS, **avant** le premier lancement du nouveau workflow. Ne pas appliquer aveuglément d'autres changements présents dans le plan.
2. Valider cette révision en staging avec ses propres paramètres et services de test. Tester notamment connexion/refresh, reset PIN, inscription avec plaque déjà utilisée, recharge et abonnement avec callback répété, avis et notifications.
3. Lancer le workflow depuis `release`. Il exécute les tests, construit l'image, copie la dernière configuration de la famille ECS et fixe l'image de l'API au digest construit. Les variables SSM, rôles, volumes, health checks et sidecars sont conservés.
4. La même nouvelle révision ECS exécute les migrations puis sert l'API. Les migrations `1780000067000` et `1780000068000` doivent avoir réussi **avant** le lancement du nouveau code, y compris hors CI. Les migrations précédentes ne sont ni supprimées ni renommées.
5. Après stabilisation, vérifier la santé HTTP et les scénarios métier avec des comptes de test. La vérification ECS refuse un faux succès lorsque le service s'est stabilisé en revenant à l'ancienne version.

Terraform continue à définir la configuration des tâches. Le service ignore désormais les changements de `task_definition` apportés par Terraform : **après une modification de configuration/SSM, relancer le workflow pour la déployer**. Cela empêche un `terraform apply` de rétablir accidentellement une ancienne image. Aucun mécanisme financier `prepare` / `activate` n'est réintroduit.

Le circuit breaker peut revenir au dernier déploiement sain, mais **n'annule pas les migrations SQL**. Les deux nouvelles migrations sont additives ; un retour applicatif à l'ancienne image laisse les nouveaux champs et travaux en place. Ne pas supprimer la file de reprise ni les avis pour revenir en arrière. Les nouvelles garanties de sessions, d'avis et de traitement ne s'appliquent plus si l'ancien code est remis en service.

## Corrections applicatives

| Constat de l'audit | Correctif ou limite |
| --- | --- |
| 01 Dépendances exposées | Multer 2.4.0, Engine.IO 6.6.11, proxy-addr 2.0.8, Axios 1.20.0, Handlebars 4.7.10, Joi 17.13.8 et js-yaml 4.3.2 sur les branches 4.x concernées. Les autres alertes transitives nécessitent encore un triage. |
| 02 Sessions HTTP | Contrôle de l'empreinte du JWT stocké ; compatibilité avec les anciennes valeurs brutes. Logout et reset PIN révoquent désormais aussi les requêtes HTTP. Un identifiant aléatoire empêche de recréer le même JWT dans la même seconde. |
| 03 Données privées dans les avis | Projection publique de l'auteur, tout en conservant la réponse historique en tableau et ses champs d'avis. |
| 04 Redis | Reconnexion avec attente progressive et aléatoire, sans file hors ligne. Démarrage borné à 10 secondes, déconnexion sans attente infinie, erreurs des sondes gérées. Les contrôles de sécurité ne sont pas contournés pendant une panne. |
| 05 Crons | Les quatre promesses détachées sont attendues par Nest ; leurs exécutions ne se chevauchent plus dans le même processus. |
| 06 FlexPay | File PostgreSQL, prise de travail avec `SKIP LOCKED`, bail et tentatives espacées. La finalisation métier doit réussir avant clôture. Un résultat tardif en attente ne remplace pas un succès confirmé. |
| 08 Validation | Assertion d'ordre des migrations corrigée. Les suites PostgreSQL/PostGIS jetables sont activées dans le CI de production, sans identifiants applicatifs. |
| 09 Livraison ECS | Révision par digest, même image pour migrations/API, circuit breaker et contrôle explicite du déploiement attendu. Activation IAM/Terraform préalable requise. |
| 10 Attentes SQL | Pool et délais explicites pour l'API, distincts des migrations. Les constructions d'index transactionnelles restent un point de vigilance sur une grosse base. |
| 11 Traitements volumineux | Destinataires de notifications parcourus par lots de 100 ; contrôle hebdomadaire et insertion atomiques, puis livraison par la file existante. Les anciens historiques non paginés et les contrôles financiers exhaustifs sont conservés pour ne pas changer leur contrat ou supprimer des protections. |
| 12 Inscription | Numéro, compte, parrainage et véhicule partagent la même transaction. Pour l'inscription téléphone, documents et jetons de connexion y participent aussi ; nettoyage des fichiers de cette tentative en cas d'échec de la transaction. |
| 13 Avis | Un trajet effectué entre conducteur et passager est requis. Sans `tripId`, résolution du dernier trajet commun non évalué. Verrou par paire et index unique pour les nouveaux avis vérifiés ; conservation des avis historiques. |

L'absence de numéro dans les auteurs des avis est volontaire. Les clients affichent le nom ou « Utilisateur ». Les nouveaux contrôles refusent les sessions révoquées et les avis sans trajet réel ; ces refus ne nécessitent pas de nouvelle route mobile.

## Exploitation des reprises FlexPay

La migration inscrit les dépôts FlexPay encore `pending` ou `initiated` dans `payment_reconciliation_jobs`. Un trigger inscrit aussi les nouveaux dépôts et les dépôts modifiés. Les retraits gardent leur propre rapprochement et sont exclus de cette file.

Chaque minute, une instance prend au plus cinq travaux, avec un bail de quinze minutes. Après une tentative non terminée, l'attente augmente jusqu'à six heures. Un arrêt du processus n'efface pas le travail : il devient reprenable après expiration du bail. Une commande manquante reste en attente ; le worker **ne relance jamais un débit** pour la remplacer.

Une modification du statut ou du numéro de commande rouvre le travail et incrémente sa révision. Une confirmation reçue pendant la finalisation ne peut donc pas être acquittée par un ancien worker. Un callback identique ne rouvre pas inutilement un travail terminé.

Le registre métier applique le résultat aux jetons, à la réservation ou à l'abonnement. Les abonnements déjà actifs ou expirés ne sont pas prolongés par rejeu. Un paiement réussi concernant un abonnement annulé est laissé en régularisation, sans remplacer l'abonnement actuel : vérifier le paiement et décider du remboursement ou du traitement avec le support.

Requête de suivi, en lecture seule, à exécuter avec un compte autorisé :

```sql
SELECT "paymentId", attempts, "createdAt", "nextAttemptAt", "leaseUntil", "lastError"
FROM payment_reconciliation_jobs
WHERE "completedAt" IS NULL
ORDER BY "createdAt"
LIMIT 100;
```

Les messages `Payment reconciliation pending` signalent les erreurs et l'ancienneté. Une alerte CloudWatch dédiée reste à configurer. Les paiements déjà terminés avant migration ne sont pas rejoués en masse ; examiner séparément les incidents historiques de finalisation.

## Variables et limites restantes

Aucune nouvelle variable n'est obligatoire pour les correctifs applicatifs :

| Variable facultative | Défaut | Portée |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | 10 | Connexions maximum par processus API |
| `DATABASE_CONNECTION_TIMEOUT_MS` | 5000 | Acquisition/connexion PostgreSQL |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30000 | Durée d'une instruction API |
| `DATABASE_LOCK_TIMEOUT_MS` | 5000 | Attente d'un verrou API |
| `MIGRATION_DATABASE_POOL_MAX` | 2 | Pool du CLI de migrations |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Identité distincte pour le CLI, si elle est préparée |

Le budget `idle_in_transaction_session_timeout` de l'API est de 60 secondes. Les migrations gardent leurs propres délais locaux. Dimensionner le pool sur l'ensemble des tâches ECS, pas seulement sur une instance.

**Le constat 07 sur le compte maître RDS n'est pas résolu en production.** Prévoir un rôle applicatif limité et un rôle de migration, tester les triggers et les tâches de maintenance avec ces droits, puis retirer les identifiants maître de la tâche API. Ajouter seulement `MIGRATION_DATABASE_URL` à la même tâche ne réalise pas cette séparation.

**Le constat 14 sur la redondance AWS reste un arbitrage de budget.** Aucun passage automatique à deux tâches, à un réplica Valkey ou à RDS Multi-AZ n'est réalisé. Le staging occasionnel reste économique.

Les versions réellement distribuées sur les stores, Node 22/ARM64 dans l'image et le comportement du service AWS doivent encore être validés par le workflow/staging. Les tests locaux ne constituent pas une garantie d'absence de régression.

## Vérifications locales

- Suite générale Jest : **156 suites et 1 656 tests réussis** ; 10 suites et 205 tests SQL optionnels ignorés lors de cette exécution. Ils ne sont pas comptés comme réussis.
- Après le dernier garde-fou d'abonnement, nouvelle exécution ciblée : **4 suites, 25 tests réussis** (abonnements, reprise des paiements, inscription).
- Migrations 67/68 et file de reprise sur PostgreSQL 18 jetable : **6 tests réussis**, dont concurrence entre workers, bail expiré, rollback, callback tardif et unicité des nouveaux avis.
- Ensemble des suites PostgreSQL/PostGIS activées séparément : **11 suites et 205 tests réussis**. Trois scénarios de compatibilité avec le code réellement déployé restent ignorés, faute de référence `DEPLOYED_BACKEND_AUDIT_COMMIT`. Les six tests de migrations ci-dessus font partie de ces 205 tests ; ne pas additionner les exécutions ciblées à la suite générale pour en déduire un total unique.
- Vérification TypeScript sans émission, `terraform fmt -check`, `terraform validate`, contrôle documentaire et syntaxe YAML/Bash du workflow : réussis. Aucun `terraform apply` exécuté.
- `npm audit --omit=dev` : **29 alertes**, dont **0 critique, 13 élevées et 16 modérées**, contre 36 à l'audit initial. Les alertes transitives restantes ne sont ni ignorées ni considérées comme corrigées ; les rétrogradations majeures suggérées par `audit fix --force` n'ont pas été appliquées.

Ces contrôles locaux utilisent Node 24 et PostgreSQL 18 ; la validation Linux/Node 22/ARM64 et PostgreSQL 16 reste à exécuter dans le CI. Les services externes sont simulés : aucun paiement, OTP ou push réel n'a été émis.

## Références techniques

Les versions des dépendances corrigent notamment les dénis de service publiés par [Multer](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm) et [Engine.IO](https://github.com/socketio/socket.io/security/advisories/GHSA-2gc4-cqfq-p2gv). Le comportement de retour arrière et les droits ECS suivent la documentation [circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html) et [autorisations ECS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html).
