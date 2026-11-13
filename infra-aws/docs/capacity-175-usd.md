# Dimensionnement progressif — plafond de 175 USD/mois

État initial au 10 novembre 2026 : **préparé localement, non appliqué à AWS**.

Suite du 12 novembre : [modèle de charge, sensibilité du coût et validation locale](capacity-175-validation-2026-11-12.md).
Les observations AWS et prix ci-dessous restent datés du 10 novembre.

## Décision et limites

Le profil `profiles/capacity-175.tfvars.json` est un premier palier économique,
pas une certification de 1 000 trajets ET 1 000 demandes simultanés. Il faut
valider la charge sur une infrastructure de même taille avant de promettre cette
capacité. La création de 1 000 demandes en quelques secondes est très différente
du maintien de 1 000 trajets ouverts dans la base.

Le plafond de 175 USD est une contrainte de planification. AWS Budgets alerte
avec un délai : ce n'est pas un coupe-circuit de facturation. Aucun arrêt
automatique de l'API, de Redis ou de PostgreSQL n'est prévu.

## Profil préparé

| Composant | État AWS observé le 10 novembre | Premier palier proposé |
| --- | --- | --- |
| API ECS ARM64 | 1 tâche, 0,5 vCPU / 1 Gio | 2 tâches, chacune 0,5 vCPU / 1 Gio |
| PostgreSQL RDS | `db.t4g.micro`, Single-AZ, 20 Gio gp3 | `db.t4g.small` (2 Gio), Single-AZ, stockage conservé |
| Valkey | 1 `cache.t4g.micro` | 2 nœuds, réplication et basculement automatique |
| Load balancer | ALB existant | Conservé, affinité Socket.IO conservée |
| Proxy Mobishastra | EC2 `t4g.micro`, EIP, disque 8 Gio | Inchangé, inclus dans le chiffrage |
| Traces X-Ray | Échantillonnage configuré à 5 % | 1 %, à surveiller avec le réservoir existant |
| Autoscaling API | Désactivé | Désactivé ; 2 tâches fixes pour borner le coût du calcul |

La dernière lecture ECS de cette préparation voit la révision `:41`, un
déploiement terminé et 1 tâche en cours. Aucun changement de cette révision.

Deux tâches API évitent le point de panne d'un seul processus. Il faut vérifier
leur répartition sur les deux AZ et tester la reconnexion Socket.IO après perte
d'une tâche. Deux nœuds Redis améliorent la disponibilité, **pas la capacité
d'écriture du primaire**. PostgreSQL et le proxy restent Single-AZ : ce profil
n'est donc pas une architecture entièrement hautement disponible.

Le passage RDS micro → small améliore la marge mémoire, mais ne garantit pas le
débit SQL ; T4g reste une famille à crédits CPU. Ne pas désactiver les sauvegardes,
la protection contre la suppression ou TLS pour financer cette montée en charge.

## Coût reproductible

Tarifs publics On-Demand de Francfort relevés auprès de l'API AWS Price List le
10 novembre 2026. Sans crédits promotionnels, remise contractuelle ni taxes.
Hypothèses : mois complet de 744 heures, **1 LCU moyen**, cinq IPv4 publiques
(2 ALB + 2 ECS + 1 proxy), disque RDS 20 Gio et 20 heures-tâches supplémentaires
pour les déploiements/migrations. Les 20 heures sont une provision, pas une limite.

| Poste | USD/mois estimés |
| --- | ---: |
| Deux tâches Fargate | 33,80 |
| RDS small | 27,53 |
| Stockage RDS | 2,74 |
| Deux nœuds Valkey | 21,43 |
| ALB fixe | 20,09 |
| ALB, 1 LCU moyen | 5,95 |
| IPv4 publiques | 18,60 |
| Proxy SMS existant et disque | 7,90 |
| Tâches temporaires et leurs IP | 0,55 |
| Provision autres services | 25,00 |
| **Total estimé** | **163,59** |
| **Marge avant 175 USD** | **11,41** |

Les arrondis des lignes peuvent différer du total calculé avant arrondi.
La provision de 25 USD doit couvrir KMS, Route 53, ECR, journaux, métriques,
traces, S3, transferts, sauvegardes supplémentaires, crédits CPU et les autres
ressources du compte, notamment staging/Lightsail. Ce n'est pas un forfait AWS.
SMS Mobishastra, Google Maps, frais des prestataires de paiement et autres
fournisseurs non AWS sont hors de ce budget AWS.

Cost Explorer a été lu avec exclusion des écritures `Credit` et `Refund` : les
crédits masquent une grande partie du coût net actuel. X-Ray représente déjà
environ 4,19 USD dans la période disponible du 1er au 10 novembre. Ne pas déduire
du net proche de zéro que l'infrastructure est gratuite ni extrapoler ces données
partielles en promesse de facture mensuelle.

```sh
node infra-aws/scripts/capacity-cost.cjs
node infra-aws/scripts/capacity-cost.cjs --hours=730
# Scénarios de dépassement : code de sortie 2, aucun appel AWS.
node infra-aws/scripts/capacity-cost.cjs --extra-task-hours=764
node infra-aws/scripts/capacity-cost.cjs --lcu=5
node infra-aws/scripts/capacity-cost.cjs --overhead=50
```

Une troisième tâche permanente ou RDS medium dépassent le budget dans ce modèle.
Une hausse du trafic, le stockage autoscalé jusqu'à 100 Gio, des CPU saturés ou
des taxes peuvent aussi consommer la marge. Si 175 USD est un plafond taxes
comprises, **le profil doit être recalculé avant application**.

Sources : [Fargate](https://aws.amazon.com/fargate/pricing/),
[RDS PostgreSQL](https://aws.amazon.com/rds/postgresql/pricing/),
[ElastiCache](https://aws.amazon.com/elasticache/pricing/),
[ALB](https://aws.amazon.com/elasticloadbalancing/pricing/),
[IPv4](https://aws.amazon.com/vpc/pricing/),
[EC2](https://aws.amazon.com/ec2/pricing/on-demand/),
[EBS](https://aws.amazon.com/ebs/pricing/).
Les tarifs régionaux utilisés sont archivés dans
`profiles/prices-eu-central-1-2026-11-10.json` ; les vérifier avant une application
ultérieure. Le nombre de LCU dépend notamment des connexions et des octets,
pas seulement du nombre de requêtes.

## Limites applicatives à mesurer

- Le dispatch séquentiel borne les recherches à 3 simultanées par instance.
  Deux tâches donnent potentiellement 6 recherches, pas 1 000.
- Les réveils Redis/SQL traitent des lots bornés à 50, avec 3 travailleurs par
  instance et des passages toutes les secondes. Les répliques peuvent consulter
  les mêmes candidats ; ne pas additionner leurs limites comme un débit garanti.
- Les alertes urgentes ont 8 travailleurs par défaut et un plafond de 20.
  Monter ce plafond sans mesurer FCM et le pool SQL peut dégrader les délais.
- Redis conserve une file de candidats **par demande**. PostgreSQL conserve
  l'exclusivité, les états et l'outbox. Ne pas supprimer la revalidation SQL ni
  les protections anti-doublons pour accélérer les envois.
- Les messages Socket.IO ne sont pas représentés individuellement dans le
  compteur de requêtes HTTP ALB. Un futur autoscaling doit prendre aussi en
  compte CPU, retard des files, connexions et latence, pas uniquement HTTP.
- Les tâches stores, analytics, KYC et paiements partagent actuellement les
  ressources avec les trajets. Inclure leur exécution dans le test mixte.

### Connexions PostgreSQL

Vérifier la valeur effective `DATABASE_POOL_MAX` dans la tâche déployée. Le code
a un défaut de 10 par processus ; avec 2 tâches cela donne un plafond de 20
connexions applicatives et jusqu'à **40 pendant le rolling deployment**, plus 2 pour une migration,
les outils d'administration et les autres clients. Ce calcul suppose un seul
processus applicatif par tâche. Ne pas porter le pool à 1 000 parce qu'il y a
1 000 trajets. Mesurer attente du pool, transactions, mémoire et verrous.

Le profil ne remplace pas `runtime_environment_variables`, n'importe pas `.env`
et ne reprend la gestion d'aucun secret existant. Une modification des pools ou
travailleurs sera une étape distincte après mesure.

## Recette de capacité obligatoire avant promesse « 1 000 + 1 000 »

Protocole à exécuter sur une préproduction représentative, après accord sur son
coût. Il n'a **pas encore été exécuté** à cette échelle.

| Étape | Charge / vérification |
| --- | --- |
| Paliers | 100, 250, 500, puis 1 000 trajets en cours ET autant de demandes nouvelles |
| Conducteurs | 1 000 occupés + au moins 1 000 disponibles ; répartitions réalistes, puis forte concentration autour du même départ |
| Temps réel | Environ 4 000 connexions (conducteurs et passagers des deux populations), à ajuster au produit réel |
| GPS | Hypothèse 1 position / 5 s pour les 1 000 trajets = 200 mises à jour/s ; ajouter les positions des conducteurs disponibles |
| Rafale | 1 000 créations en 5 s = 200 créations/s, puis essai en 1 s ; conserver le délai depuis l'arrivée HTTP, pas seulement le temps du worker |
| Retours | Réception mobile, refus, acceptation, absence de réponse, annulation et demandes expirées |
| Durée | 30 min au pic, puis essai prolongé de 2 h ; suivre la baisse des crédits CPU |
| Pannes | Perte d'une tâche, basculement Redis, lenteur SQL, FCM lent/429, réseau mobile coupé puis rétabli |
| Historique | Volumes réalistes de trajets, invitations, notifications, utilisateurs, paiements et indexes/migrations de production |

Critères proposés, à confirmer par mesure : p95 création HTTP < 1 s ; p95 de
l'enregistrement de la demande à l'outbox < 2 s ; p95 première alerte reçue sur
un appareil connecté < 5 s ; relais serveur après refus < 2 s ; moins de 1 %
d'erreurs techniques. Séparer clairement arrivée FCM, réception sur le téléphone
et début réel de la sonnerie. La connexion mobile peut empêcher un SLA absolu.

Invariants obligatoires : zéro double acceptation, zéro conducteur attribué à
deux courses incompatibles, zéro débit financier double, aucune sonnerie périmée,
aucun travail perdu après reprise. Une erreur fonctionnelle attendue (refus,
conducteur devenu indisponible) n'est pas une panne technique.

Mesures : p50/p95/p99 de chaque étape, ancienneté des files, pool SQL en attente,
verrous, CPU et mémoire API/RDS/Redis, retard de réplication, crédits T4g,
connexions WebSocket et reconnexions, taux d'erreurs, coût projeté à 744 h.
Arrêter l'essai si les invariants sont violés ou si la file croît sans résorption.

## Vérification locale déjà disponible

Le benchmark existant `bounded local benchmark` a été exécuté avec succès sur
PostgreSQL/PostGIS et Redis jetables : deux scénarios de 60 demandes, 120
conducteurs, 211 000 anciennes notifications, 3 instances de service **dans le
même processus**, concurrence 1 puis 8. Il vérifie une invitation durable par
demande et l'absence de conducteur réservé deux fois. Les autres tests de la
suite sont exclus par le filtre, pas déclarés validés par cette exécution.

Dernière exécution locale du 10 novembre :

| Scénario | Demandes traitées | Durée du lot | p50 par demande | p95 par demande | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Série, concurrence 1 | 60 / 60 | 4 051 ms | 65 ms | 82 ms | 171 ms |
| Concurrence 8 | 60 / 60 | 1 702 ms | 162 ms | 608 ms | 838 ms |

Périmètre mesuré : file Redis → invitation SQL et outbox durables, sans envoi
push réel. Ces résultats dépendent de la machine locale et ne sont pas un SLO
de production. Ce sont des tests de dispatch ; aucun paiement réel n'est exécuté.

Ce benchmark ne couvre ni 1 000 trajets actifs, ni leurs GPS, ni 1 000 demandes,
ni HTTP/JWT/ALB, ni FCM/APNs réels, ni les téléphones, ni les ressources Fargate.
Il ne permet donc pas d'extrapoler une capacité AWS.

```powershell
$env:DISPATCH_TEST_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
$env:DISPATCH_TEST_LOAD = '1'
node test/run-sequential-dispatch.cjs src/trip-requests/dispatch/sequential-dispatch.postgres.spec.ts --testNamePattern='bounded local benchmark' --testTimeout=30000
```

## Préparation du déploiement — ne pas appliquer sans revue

1. Confirmer si le budget inclut les taxes et tous les services existants. Choisir
   de vraies adresses opérateur : aucun destinataire fictif n'est préconfiguré.
2. Confirmer les abonnements SNS. Le dernier audit a trouvé zéro abonné au topic
   d'alertes ; les alarmes proxy n'avaient pas d'action. Les raccorder séparément
   après autorisation, sinon les alarmes ne préviennent personne.
3. Vérifier sauvegarde RDS, restauration, migrations, image ARM64 et compatibilité
   avec deux tâches. Le redimensionnement Single-AZ RDS peut interrompre les
   connexions ; prévoir une fenêtre et la reprise applicative.
4. Le fichier de profil est **explicite**, pas `.auto.tfvars` : un `apply`
   ordinaire ne l'active pas. Ne pas remplacer le fichier de configuration
   historique ni supprimer les paramètres SSM existants.
5. Préparer un plan avec le même état Terraform que la production, ses variables
   existantes, puis ce profil en dernier et les vraies adresses d'alerte. Examiner
   toutes les dérives préexistantes ; refuser tout remplacement de base/VPC,
   suppression de secret, changement de rôle WIF ou retour à une ancienne image.
   Le budget est compte entier, hors crédits/remboursements, taxes incluses ; il
   alerte à 80 % réel, 100 % réel et 100 % prévisionnel. Il bloque le plan si aucun
   destinataire n'est fourni.

```sh
# Depuis infra-aws, après préparation des variables habituelles et d'un fichier
# local operators.tfvars définissant alert_email_addresses (adresses réelles).
terraform plan -var-file=profiles/capacity-175.tfvars.json -var-file=operators.tfvars -out=capacity.tfplan
```

Cette commande n'a pas été exécutée contre l'état AWS pendant cette préparation.
Le plan peut contenir des données sensibles : ne pas le committer. Faire relire
son coût et son contenu avant toute application. Un simple `terraform validate`
ne prouve pas que le plan sera sans remplacement.

Après application autorisée : vérifier réellement les deux cibles saines et leur
répartition AZ, le primaire et la réplique Redis, les paramètres de tâche, les
alertes reçues, puis réaliser la recette de charge. Le fichier ECS actuel ignore
les changements de `task_definition` : une nouvelle révision de configuration
nécessite le déploiement contrôlé prévu par la CI pour être consommée.

Retour arrière : l'ancien profil doit être connu et sauvegardé. Ne pas réduire
automatiquement RDS ou supprimer une réplique pendant un incident ; d'abord
réduire la charge, maintenir les sauvegardes et examiner un nouveau plan. Le
stockage RDS augmenté ne se réduit pas par un simple changement de variable.

## Suite recommandée

Valider d'abord ce palier, mesurer le chemin création → invitation → réception,
puis corriger les goulots SQL/dispatch. Si 1 000 + 1 000 ne passent pas, arbitrer
explicitement entre budget, latence et disponibilité ; ne pas annoncer la capacité
sur la base du seul nombre de tâches. Isoler les traitements lourds peut aider,
mais ajouter des services permanents, une NAT Gateway ou migrer vers Go ne crée
pas à lui seul une garantie de débit.

Références : [ECS target tracking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html),
[délais des alertes AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
