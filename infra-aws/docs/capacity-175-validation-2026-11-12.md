# Dimensionnement : poursuite du 12 novembre 2026

Statut : préparation et mesures locales uniquement. Aucun plan connecté à AWS,
aucun apply, aucune modification des paramètres de production. Le profil reste
celui décrit dans [capacity-175-usd.md](capacity-175-usd.md).

## Conclusion de planification

Deux tâches ARM64 de 0,5 vCPU / 1 Gio, RDS `db.t4g.small` et deux nœuds Valkey
`cache.t4g.micro` constituent un **palier à tester**, pas une capacité certifiée.
Ne pas dimensionner uniquement sur « 1 000 trajets dans la base » : les écritures
GPS, les connexions, les nouvelles invitations, les reprises et les paiements
doivent tenir ensemble. La réplication Redis améliore la disponibilité, pas le
débit d'écriture du primaire. RDS Single-AZ et le proxy restent des points de panne.

## Charge à reproduire

Le calculateur hors ligne `scripts/capacity-workload.cjs` rend ses hypothèses
explicites ; aucune de ces fréquences n'est une mesure du trafic actuel.

| Hypothèse | Besoin estimé |
| --- | --- |
| 1 000 trajets, un conducteur et un passager connectés par trajet | 2 000 connexions |
| 1 000 autres conducteurs disponibles, 1 000 passagers en recherche | 2 000 connexions supplémentaires |
| Position des conducteurs en trajet toutes les 5 s | 200 événements entrants/s |
| Position des conducteurs disponibles toutes les 15 s | 66,7 événements entrants/s |
| Une retransmission GPS à un passager par trajet | 200 événements sortants/s |
| 1 000 créations en 5 s / en 1 s | 200 / 1 000 créations/s |
| Reconnexion des 4 000 clients en 10 s | 400 connexions/s pendant l'incident |

Les connexions de reconnexion sont une **pointe technique**, pas une moyenne
horaire à facturer comme si elle durait un mois. Les créations HTTP, paiements,
médias, battements de connexion et retransmissions sont à ajouter au trafic GPS.
Avec plusieurs passagers par trajet, augmenter `passengersPerTrip`.

### Connexions SQL

Le défaut applicatif est de 10 connexions par processus, pas par utilisateur.
Deux processus utilisent donc au maximum 20 connexions ; un déploiement à 200 %
peut en utiliser 40. Avec un processus de migration à 2 et une réserve opérateur
illustrative de 10, prévoir **52 connexions**. Vérifier les overrides réellement
déployés, les autres workers et `max_connections` avant application. Cette réserve
ne mesure ni le débit SQL ni la RAM disponible ; ne pas augmenter le pool à 1 000.
Le guide PostgreSQL utilisé pour cette préparation a conduit à expliciter ce
budget par processus et à conserver les transactions/verrous de production.

## Sensibilité du budget

Prix régionaux **archivés au 10 novembre**, non actualisés le 12. Modèle 744 h,
20 heures-tâches supplémentaires et provision de 25 USD inchangée. Cette provision
doit absorber les autres services et le transfert Internet, non chiffré séparément.
Les taxes, SMS et fournisseurs tiers ne sont pas inclus.

| Hypothèse de trafic GPS | LCU moyenne modélisée | Sortie GPS mensuelle seule | Estimation AWS illustrative |
| --- | ---: | ---: | ---: |
| Pointe de 2 h/jour, messages de 512 octets | 1,028 | 22,86 Go | 163,76 USD |
| Charge continue, messages de 512 octets | 1,333 | 274,27 Go | 165,58 USD |
| Charge continue, messages de 2 048 octets | 3,441 | 1 097,07 Go | **178,12 USD** |

Hors pointe, le modèle conserve l'hypothèse initiale de 1 LCU moyen. Les volumes
GPS indiqués ne comprennent pas le reste du trafic. Même 165,58 USD ne garantit
donc pas une facture sous 175 USD : la provision peut être insuffisante.

Les dimensions ALB utilisées (3 000 connexions actives et 1 Go traité/h par LCU
pour des cibles conteneurs) proviennent de la
[tarification officielle AWS](https://aws.amazon.com/elasticloadbalancing/pricing/).
Le calcul GPS est un minimum : nouvelles connexions, règles et autres requêtes
peuvent augmenter le nombre de LCU. Le volume facturable doit être observé.

## Mesure locale de dispatch

Le benchmark existant est maintenant paramétrable de 1 à 1 000 demandes,
1 à 32 appels concurrents et 1 à 4 objets de service. Les valeurs sont contrôlées
avant de lancer les bases. Par défaut, il conserve 60 demandes et trois objets.

Il utilise PostgreSQL/PostGIS et Redis jetables, 211 000 notifications historiques,
et deux conducteurs disponibles par demande. Les demandes sont précréées puis
traitées en rafale. **Un seul processus Node et un seul pool SQL** : deux objets
ne représentent pas deux tâches Fargate. Les 1 000 trajets actifs, GPS, HTTP,
FCM/APNs et téléphones ne sont pas simulés par ce benchmark.

Un retour `advance(false)` peut indiquer une limitation volontaire du travail
simultané. Le test ne le confond plus avec une perte : il exerce les reprises
Redis/SQL réelles, attend au plus 60 s supplémentaires entre cycles de reprise,
et exige une invitation durable pour chaque demande. Un cycle en cours peut
dépasser ce délai ; le test complet reste plafonné à 300 s. Il contrôle aussi
l'unicité des invitations actuellement en attente par conducteur et demande.

Les métriques séparent le temps d'un appel, le temps du premier passage, et le
temps d'observation de la première invitation durable depuis le début de rafale.
Ce dernier inclut l'attente et, en reprise, la fréquence de vérification (1 s).
Ce n'est **pas** le délai de sonnerie d'un téléphone.

Résultats et contrôles finaux : voir la section ajoutée en fin de document.

### Reproduction locale

Depuis la racine du backend, avec PostgreSQL 18/PostGIS et Redis dans Ubuntu WSL :

```powershell
node --test test/capacity-budget.test.cjs test/capacity-workload.test.cjs test/dispatch-benchmark-settings.test.cjs
node infra-aws/scripts/capacity-workload.cjs
$env:DISPATCH_TEST_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
$env:DISPATCH_TEST_LOAD = '1'
$env:DISPATCH_TEST_LOAD_REPLICAS = '2'
$env:DISPATCH_TEST_LOAD_STAGE = 'concurrent'
$env:DISPATCH_TEST_LOAD_CONCURRENCY = '8'
$env:DISPATCH_TEST_LOAD_REQUESTS = '1000'
node test/run-sequential-dispatch.cjs src/trip-requests/dispatch/sequential-dispatch.postgres.spec.ts --testNamePattern='bounded local benchmark' --testTimeout=60000
```

Ces variables sont uniquement des réglages de test ; ne pas les ajouter à SSM.
Ne pas exécuter ce scénario contre une base applicative ou Redis de production.

## Ordre recommandé avant toute montée en capacité

1. Vérifier les défauts de compilation/tests indépendants et terminer la CI.
2. Mesurer les tailles réelles de messages, le trafic horaire et les crédits CPU
   RDS/Valkey ; confronter la facture sans crédits au budget, taxes comprises si
   le plafond de 175 USD les inclut.
3. Examiner un plan explicite du profil existant : sauvegardes, absence de
   remplacement destructeur, variables runtime conservées et destinataires
   Budgets/SNS confirmés. Faire approuver les coûts et changements avant apply.
4. Sur une infrastructure représentative, monter 100 → 250 → 500 → 1 000 trajets
   avec autant de demandes, conducteurs occupés/disponibles distincts et GPS réel.
   Mesurer p95/p99 depuis la création jusqu'à l'accusé de réception mobile.
5. Tester perte d'une tâche, basculement Redis, SQL lent, quotas push et reconnexion
   en masse. Garder les contrôles anti-double attribution et les délais existants.
6. Si les seuils ne tiennent pas, arbitrer coût ou objectif de latence sur mesures.
   Une troisième tâche permanente ou RDS medium dépasse déjà le modèle initial.

Retour arrière de cette préparation : retirer les nouveaux outils de mesure
n'affecte pas AWS ; aucune migration ni modification du runtime n'est incluse.

## Résultats du 12 novembre

**Rectification du banc d'essai :** les trois mesures ci-dessous ont été faites
avant de constater que la fixture omettait l'index KYC existant
`IDX_kyc_welcome_latest` de la migration `AddVerifiedWelcomeBonus1780000052000`.
Elles restent l'historique des essais, mais ne représentent pas les performances
du schéma complet de production. Voir le complément ci-dessous pour la base de
comparaison corrigée et les optimisations applicatives locales.

| Rafale / concurrence / objets de service | Invitations au premier passage | Demandes avec invitation après reprise | Durée du dispatch observé | Verdict |
| --- | ---: | ---: | ---: | --- |
| 100 / 8 / 2 | 93 | 100 | 3,229 s | Exhaustivité et unicité validées |
| 1 000 / 8 / 2 | 46 | 196 | 68,700 s | **Échec : 804 demandes sans invitation observée à la fin du test** |
| 1 000 / 6 / 2 | 1 000 | 1 000 | 209,443 s | Exhaustivité/unicité validées, **latence cible non atteinte** |

Le premier essai de 100 demandes avait échoué car il exigeait un succès immédiat
pour chaque appel. Inspection : `SequentialDispatchService` limite la découverte
à trois traitements par objet et diffère le reste. Le benchmark a donc été
complété avec les reprises réelles, sans modifier le service. Le résultat à 100
ci-dessus correspond à ce second essai, réussi.

À 1 000 / 8, le premier passage finit en 7,268 s, mais la plupart des appels sont
différés : son p95 de 41 ms **ne représente pas une livraison rapide**. Le p95
d'observation de la première invitation vaut 68,700 s parmi les 196 demandes
servies seulement ; il n'est pas calculable pour les 804 restantes. L'échec
prouve une limite dans ce scénario, pas une perte définitive ni une capacité
maximale universelle d'AWS.

À 1 000 / 6, tous les appels aboutissent au premier passage. Le traitement d'un
appel prend au p50 1,200 s et au p95 1,631 s ; le p95 depuis le début de rafale
jusqu'à l'observation d'une invitation durable monte à **198,646 s**, pour un
débit moyen d'environ **4,77 premières invitations/s**. Le test est vert parce
que l'exhaustivité et l'unicité passent, pas parce que la cible de latence passe.
Les 301,677 s affichées par Jest incluent l'initialisation, les fixtures et le
nettoyage ; les 209,443 s correspondent à la phase de dispatch mesurée.

Cette comparaison montre pourquoi augmenter simplement la concurrence n'est pas
un correctif suffisant : à 8, davantage d'appels sont différés ; à 6, la file
d'attente de la rafale domine. Ces mesures sur PC, Windows/PostgreSQL et Redis
WSL ne sont pas normalisées à la puissance d'une tâche ECS. Elles ne permettent
pas de déduire un nombre de vCPU AWS ou une capacité de production garantie.

Points confirmés par lecture du code : trois recherches simultanées par objet,
50 candidats par recherche, lecture des échéances Redis par lots de 50 et trois
traitements simultanés par boucle de reprise. Plusieurs objets peuvent lire les
mêmes échéances ; les verrous empêchent les doublons mais le coût de contention
et l'équité entre demandes neuves et relances doivent être mesurés. Ne pas
augmenter aveuglément les lots ou supprimer les vérifications d'éligibilité.

Les horloges de notification continuent normalement pendant le test, et aucun
téléphone ne répond : les invitations expirent puis repartent. Cela représente
une rafale sans réponse, pas le débit commercial avec des conducteurs qui acceptent.
Le scénario mixte complet et la résilience après panne restent à exécuter.

Contrôles : 13 tests hors ligne réussis ; `terraform validate`,
`terraform fmt -check budget.tf` et contrôle de documentation infra réussis ;
`tsc --project tsconfig.build.json --noEmit --incremental false` réussi.
`tsc --noEmit --incremental false` échoue sur deux appels de test sans
`profilePicture` dans le fichier préexistant `src/users/driver-category.spec.ts`
(lignes 124 et 144 à cette date), laissé intact. Aucune validation globale de la
suite de tests, aucun essai mobile réel, aucun déploiement n'est revendiqué.

### Priorités techniques issues de ces mesures

1. Profiler les recherches géographiques et exclusions de conducteurs avec les
   volumes réels ; mesurer temps SQL, attente du pool, CPU et verrouillage avant
   de choisir une instance RDS plus grande. Aucun index ou invariant métier n'a
   été changé sur la base d'une supposition.
2. Mesurer puis améliorer la reprise équitable des premières invitations sous
   rafale, notamment les lots d'échéances lus par plusieurs workers. Une limite
   de travail doit protéger la base sans faire attendre excessivement les
   demandes neuves. Conserver la persistance SQL et l'unicité des invitations.
3. Répéter le benchmark dans deux processus séparés, puis la charge mixte sur un
   environnement représentatif, avec CPU/mémoire limités comme ECS, GPS et vrais
   accusés mobiles. Ne pas augmenter le pool pour masquer une requête coûteuse.
4. Refaire le choix de capacité/coût après ces mesures. Le profil actuel peut
   améliorer la disponibilité de l'API et de Redis ; il n'est pas qualifié pour
   garantir 1 000 trajets et 1 000 demandes avec sonnerie rapide.

## Complément : profilage et correctifs locaux

Le guide PostgreSQL a conduit à mesurer `EXPLAIN (ANALYZE, BUFFERS)` sur les
seules fixtures jetables avant de modifier la requête. L'outil optionnel
`test/sequential-query-profile.ts`, activé par `DISPATCH_TEST_LOAD_PROFILE=1`,
affiche les temps et opérateurs, sans paramètres ni identifiants des fixtures.

- La fixture de charge recrée maintenant l'index KYC déjà livré par une migration
  existante. Ce n'est pas un nouvel index de production et aucune migration
  applicative n'a été exécutée.
- Avec cet index mais avant optimisation de la requête, 1 000 demandes à
  concurrence 6 aboutissent toutes en **133,110 s**, p95 d'observation depuis la
  rafale **127,173 s**, soit **7,51 premières invitations/s**. Le gain par rapport
  aux 209,443 s précédentes corrige le banc d'essai : il ne doit pas être présenté
  comme un gain du code déployé.
- Le plan avec index prenait 586,625 ms dans la mesure isolée : la jointure finale
  vers `users`, après les deux contrôles d'éligibilité déjà présents, entraînait
  un parcours répété inutile. Cette jointure seule a été retirée. Les deux
  contrôles d'activité/KYC, de disponibilité et le verrou sur le conducteur
  sélectionné restent en place.
- La lecture des lots d'échéances Redis devient une prise atomique par Lua :
  deux workers ne lisent plus systématiquement les mêmes 50 échéances. Les
  éléments ne sont pas supprimés ; un worker arrêté laisse son lot récupérable
  après une réserve de planification de 30 s. Ce délai **n'est pas** celui de
  réponse du conducteur. Les replanifications, annulations, contraintes SQL et
  la récupération SQL restent actives. Le scan SQL peut encore chevaucher un
  autre worker : les contraintes et verrous restent donc indispensables.

Ces modifications touchent désormais le code applicatif local, contrairement
au premier lot de préparation purement documentaire ci-dessus. Aucun changement
AWS, aucune augmentation de pool, aucun tarif véhicule et aucun délai de réponse
conducteur n'ont été appliqués dans ce complément. Pour revenir en arrière,
restaurer ensemble la lecture des échéances et son appel dans le service, ainsi
que la requête de découverte, puis repasser les tests ; aucune conversion de
données persistées n'est nécessaire.

### Mesure après correctifs

Même scénario de 1 000 demandes précréées, 2 000 conducteurs, 211 000 notifications,
concurrence 6, deux objets de service dans un processus et un pool SQL :

| Mesure | Avant, fixture corrigée | Après correctifs |
| --- | ---: | ---: |
| Invitations au premier passage | 1 000 | 1 000 |
| Durée mesurée du dispatch | 133,110 s | 59,702 s |
| p95 depuis le début de rafale | 127,173 s | 56,293 s |
| p95 d'un appel | 1,155 s | 0,583 s |
| Premières invitations/s | 7,51 | 16,75 |

Le benchmark passe (1 test, 81 autres volontairement filtrés, 153,376 s avec
initialisation/nettoyage). Les contraintes d'unicité des invitations en attente
par demande et par conducteur sont vérifiées. Le plan isolé de découverte avec
l'index existant passe de 586,625 ms à 60,437 ms ; ce n'est pas une mesure p95.
Les machines de test n'étaient pas calibrées comme ECS : ce sont deux essais
locaux comparables, pas un engagement de performance.

Cette rafale à concurrence 6 ne diffère aucune première invitation : elle
mesure principalement la requête optimisée, pas le gain du partage Redis.
La reprise Redis concurrente fait l'objet d'un test d'intégration distinct.
Le scénario surchargé à concurrence 8 n'a pas encore été rejoué après correctifs.
La charge mixte (trajets actifs, GPS, HTTP, FCM/APNs, réception réelle et pannes)
reste à qualifier. Même avec ce gain, 56,293 s au p95 depuis la rafale ne permet
pas de promettre une sonnerie rapide pour 1 000 demandes simultanées.

### Validation de non-régression du 13 novembre

Après adaptation des deux derniers mocks `due` vers `claimDue`, la suite
`sequential-dispatch.postgres.spec.ts` passe sur PostgreSQL/PostGIS et Redis
jetables : **79 tests réussis, 3 ignorés**, 216,649 s. Elle couvre notamment le
partage atomique des lots, leur récupération après arrêt d'un worker, les
replanifications/annulations, la récupération SQL en panne Redis et l'unicité
des invitations. Ce n'est pas un nouvel essai de charge à 1 000 demandes.

Les 13 tests hors ligne de dimensionnement et la compilation de production
passent également. Le contrôle TypeScript global ne signale plus de référence
à `due`, mais conserve deux erreurs préexistantes de fixtures GoogleAuthProfile
sans `profilePicture` dans `src/users/driver-category.spec.ts` (124 et 144).
Aucun changement AWS ni nouvelle certification de capacité.
