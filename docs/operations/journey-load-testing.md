# Tests de charge des trajets Zwanga

Le banc `test/load/journeys` prépare la validation de 1 000 trajets actifs avec 1 000 demandes supplémentaires. Il crée uniquement des bases locales jetables et deux à quatre instances backend selon le budget de connexions. Il ne peut pas cibler une URL de production et ne provisionne aucune ressource AWS.

Un résultat local valide le scénario sur la machine utilisée, pas la capacité de la production. Par défaut, les processus ne sont pas limités comme Fargate. Le mode `--containerized-api`, réservé à Linux/WSL, prépare des API à 0,5 vCPU et 1 Gio chacune par défaut, ou 1 vCPU et 2 Gio avec `--api-size=larger` ; le générateur, PostgreSQL et Redis restent sur le même hôte. Il ne reproduit pas RDS, ALB, les zones de disponibilité ni un générateur sur une machine séparée.

## Comparatif d'infrastructure préparé le 26 novembre 2026

Préparation locale uniquement : aucun `terraform apply`, changement de production, lancement de ressource AWS ou nouveau palier de charge. Le laboratoire à deux machines reste **à raccorder** : les machines Linux isolées, le transport privé authentifié, la collecte distante et le nettoyage distribué doivent être définis et testés. La proposition `infra-aws/profiles/journey-load-lab.proposal.json` conserve `remoteRunnerImplemented=false` et `approvedForProvisioning=false`. Un conteneur sur le même PC n'est pas un générateur séparé ; les nouveaux rapports l'indiquent explicitement.

Validation de cette préparation : **41 tests ciblés réussis** (`capacity-comparison`, `journeys`, `recovery`) sous Node 24.22.1, en série. Le précontrôle réel du profil 500/baseline refuse correctement le lancement : environ 0,21 Gio libres pour 4 Gio requis, shell Windows, moteur Docker Linux inaccessible, Redis via WSL indisponible et image non vérifiable. Aucun service jetable ni charge applicative n'a été démarré. L'opérateur demande de préparer seulement, les machines restant à préciser. Ce résultat valide le banc et son refus, pas les performances d'une nouvelle configuration.

### Comparaison locale contrôlée

Deux tailles limitées sont disponibles, sans changer les paramètres de production :

| Option | Limites par API | Pool SQL / tas V8 / garde RSS |
| --- | --- | --- |
| `--api-size=baseline` | 0,5 vCPU / 1 Gio | 10 connexions / 768 Mio / 900 Mio |
| `--api-size=larger` | 1 vCPU / 2 Gio | identiques |

Les deux profils gardent les mêmes délais, cadence GPS, limites de concurrence, reçus, vagues de quatre et vérifications métier. Le supplément de mémoire du conteneur ne relève pas la garde RSS : ce premier essai mesure surtout la marge CPU avec un budget applicatif constant. Aucune taille arbitraire ni option d'URL distante n'est acceptée. `--api-size` exige `--containerized-api` : un processus natif ne sera pas présenté comme limité par Docker.

Avant toute création de ressources jetables, le runner vérifie mémoire libre, version Node pour les paliers élevés/conteneurisés, présence du build et des dépendances, exécutables PostgreSQL et Redis. Le mode conteneur exige Linux, un moteur Docker Linux accessible et une image correspondant aux sources. Le contrôle préalable ne construit ni ne télécharge d'image. L'extension PostGIS reste vérifiée au démarrage de la base jetable. Le seuil d'admission mémoire pour les paliers supérieurs à 100 est `max(4 Gio, somme des limites mémoire API + 2 Gio)` : 4 Gio pour deux petites API, 6 Gio pour deux grandes ; ce plancher n'est pas une garantie de performance.

```bash
# Plans seulement, sans démarrer de services.
node test/load/journeys/run.cjs stage-500-mixed --containerized-api --api-size=baseline --profile-sql --fixture-seed=replica-balance-v1 --replica-offset=0
node test/load/journeys/run.cjs stage-500-mixed --containerized-api --api-size=larger --profile-sql --fixture-seed=replica-balance-v1 --replica-offset=0

# Inspection locale uniquement ; sortie 1 si un prérequis manque.
node test/load/journeys/run.cjs stage-500-mixed --containerized-api --api-size=baseline --preflight
node test/load/journeys/run.cjs stage-500-mixed --containerized-api --api-size=larger --preflight
```

Après résolution des prérequis : reconstruire l'image via `lab-image.cjs --build` (téléchargements npm/Docker), valider `smoke`, puis exécuter **séparément** les commandes de plan avec `--execute-local`. Ne pas combiner `--preflight` et `--execute-local`. Faire au moins deux répétitions par taille dans l'ordre baseline → larger → larger → baseline, même hôte, même source/image, même graine, même rotation, même instrumentation et charge hôte maîtrisée. Une modification du code exige de reconstruire et de rejouer les deux côtés.

```bash
node test/load/journeys/compare-reports.cjs tmp/load-results/ESSAI_BASELINE/report.json tmp/load-results/ESSAI_LARGER/report.json
```

Le comparateur est en lecture seule. Il refuse une comparaison valide si un essai a échoué, si son nettoyage manque, si sa source/image/runtime n'est pas identifié ou si le scénario, les garde-fous, le nombre de réplicas, la rotation, les workers ou les caractéristiques hôte diffèrent. Les anciens rapports restent consultables mais ne portent pas toutes ces preuves. Les captures d'échec sont incluses dans les pics SQL, sans exporter de message d'erreur arbitraire. Un delta de p95 n'est affiché que pour une paire admissible ; aucun résultat n'autorise automatiquement le palier suivant ou ne certifie AWS.

### Suite du laboratoire séparé

1. Confirmer deux hôtes Linux isolés (ou chiffrer un laboratoire AWS temporaire avant autorisation), sans secrets ni données de production.
2. Raccorder le générateur sur un hôte distinct des API/PostgreSQL/Redis, avec transport privé authentifié et arrêt/nettoyage bornés. Ne pas simplement remplacer l'allowlist loopback par une URL libre.
3. Reproduire 500 avec marge et observer les attentes SQL et la répartition par API ; conserver les gardes d'authentification et les fréquences GPS.
4. Tester la séparation des workers comme un changement indépendant. La taille 0,5 vCPU / 1 Gio est une proposition, pas un service ECS implémenté. Les limites SQL doivent compter workers, réplicas supplémentaires de déploiement, migrations et réserve d'exploitation.
5. Ne comparer RDS `small`/`medium` que si la saturation CPU/RAM est mesurée. Une attente d'acquisition de connexion n'est pas une preuve de manque de CPU RDS.
6. Après validation et revue, passer à 750, au maintien et aux pannes contrôlées, puis à 1 000. Le budget historique de 175 USD n'est pas un chiffrage de cette nouvelle architecture.

## Correctifs des reçus du 24 novembre 2026 — vérification ciblée

La reprise de charge est différée à la demande de l'opérateur : environ **450 Mio de RAM libre** au contrôle du PC. Aucun nouveau scénario à trois API, à 500 ou à 750 n'est exécuté pour ces changements ; les rapports historiques ci-dessous ne les valident pas.

- Le parcours d'un reçu séquentiel actif utilise **trois requêtes internes au lieu de quatre**, hors `BEGIN`/`COMMIT` : délais SQL, verrou partagé sur la demande, puis fenêtre de réponse + reçu + sonnerie. La réduction du nombre d'allers-retours est vérifiée par un test, mais le gain de latence sous charge reste à mesurer.
- Le verrou de demande reste dans une requête précédente pour relire l'offre après une attente. L'ordre demande → offre → télémétrie → sonnerie est conservé. Les dépendances entre CTE et leurs `RETURNING` transmettent le résultat actualisé ; elles ne supposent pas qu'une lecture sœur voit les nouvelles lignes ([règles PostgreSQL](https://www.postgresql.org/docs/18/queries-with.html)). Tout échec annule les écritures ensemble. Aucun cache des droits, aucune prolongation d'offre par répétition de reçu.
- Les reçus sans verrou métier protecteur, notamment anciens ou obsolètes, conservent une vérification distincte de la sonnerie après l'écriture de télémétrie. Une annulation intervenue pendant l'attente reste ainsi visible.
- `receiptAdmission` limite à **deux transactions de reçus par API** (une sur un petit pool), indépendamment des réponses : 32 attentes au plus, 750 ms avant démarrage SQL. Une saturation renvoie HTTP 503 / `NOTIFICATION_RECEIPT_BUSY`, jamais un faux reçu confirmé. Aucun commit commencé n'est interrompu ou relancé. L'admission reste locale ; les verrous PostgreSQL arbitrent les réplicas.
- Le banc ajoute `servers[].receiptAdmission`, compte ces attentes avec celles des réponses, du fond et du pool, et échoue sur tout refus. Les limites existantes ne sont pas relevées. Les lectures HTTP `findAuthIdentity`, connexions et contrôles périodiques `WsSessionService`, état de suivi et accès aux salons de trajet ont maintenant leurs contextes SQL distincts. Cette instrumentation n'en supprime aucune vérification ; son attribution en charge reste à mesurer.

Les changements ne modifient ni la cadence GPS, ni les destinataires d'alertes, ni les vagues de quatre, ni l'envoi des notifications. Aucun changement AWS, de configuration `.env`, de schéma ou de migration.

Attribution des traces antérieures : les empreintes SQL reconstruites depuis les repositories compilés, **sans connexion à une base**, correspondent exactement à `e6caafe7de1da3cf` pour `UsersService.findAuthIdentity` et `16705617ffb02890` pour la lecture des utilisateurs de `WsSessionService`. Dans le rapport `journeys-2026-11-24T08-48-14-603Z`, l'API 1 cumule 12,04 s sur 415 lectures d'identité HTTP, dont 7,23 s d'acquisition de connexion (~60 %). Ce sont des durées cumulées de requêtes concurrentes, pas 12 s de retard utilisateur ni du temps CPU PostgreSQL. Les acquisitions incluent aussi établissement de connexion et ordonnancement des callbacks ; aucune suppression de contrôle d'identité ne se justifie par ce seul constat. Les nouvelles étiquettes permettront de suivre ces familles directement au prochain essai.

Validation finale ciblée : **159 tests réussis** (112 du banc, 10 d'admission, 19 de concurrence PostgreSQL sur les reçus/fenêtres, 18 de cohérence et télémétrie audio). TypeScript `--noEmit` et compilation Nest réussis. Le premier passage plus large avait 3 échecs après le retrait d'un helper encore utilisé par les tests ; son contrat a été rétabli avec la même logique SQL partagée, puis les 19 régressions concernées ont été rejouées avec succès. Ce bilan n'est pas un passage intégral de la suite projet, ni un test mobile physique, ni une validation du débit à 500/750.

## Vérification locale antérieure du 24 novembre 2026

Le scénario `mixed-smoke-3api`, avec la graine `replica-balance-v1` et une rotation de 1, **passe**. Rapport privé : `tmp/load-results/journeys-2026-11-24T08-39-45-251Z/report.json` (terminé à 09 h 43, Kinshasa).

- 5 récupérations et 5 déposes automatiques ; 8 demandes ont reçu une offre.
- Pics de file SQL : **3 / 3 / 3** ; aucune erreur SQL/worker ni refus d'admission. Attente maximale dans la nouvelle admission : 2,19 ms.
- Première alerte p95 ≤ 300 ms et transmission GPS au pair p95 ≤ 50 ms pendant la phase soutenue, selon les bornes des histogrammes.
- Cohorte de 56 offres : 54 alertes observées et confirmées, 2 déjà obsolètes non observées, aucune alerte non obsolète manquante. Quatre offres tardives comptées séparément. Aucun doublon ni dépassement des vagues de quatre.
- PostgreSQL identifie bien les trois API ; nettoyage de la base jetable réussi.

Cette petite charge valide le raccordement, **pas le rééquilibrage à 500 ni la capacité à 750**. Après libération de mémoire (environ 3,7 Gio libres au lancement), deux comparatifs 500 sur trois API ont été exécutés, avec la même graine et les mêmes seuils :

| Rapport dans `tmp/load-results/` | Rotation | Résultat et pics de file SQL API 1 / 2 / 3 |
| --- | --- | --- |
| `journeys-2026-11-24T08-48-14-603Z/report.json` | 0 | Arrêt `inflight_quota` WebSocket ; **67 / 42 / 24** |
| `journeys-2026-11-24T08-54-38-397Z/report.json` | 1 | Arrêt au plafond du générateur de 128 opérations en vol ; **18 / 27 / 24** |

Les pics proviennent des captures d'échec, plus récentes que le dernier contrôle périodique. Le premier essai atteint 64 travaux WebSocket sur l'API 1 (8 refus globaux, aucun refus par utilisateur) ; les autres API culminent à 44 et 29. Sur cette API, 35 des 64 acquisitions SQL en attente relèvent du GPS, 5 des reçus d'alertes, 2 des réponses, 14 de contextes non encore attribués et 8 d'autres travaux. C'est une pointe mixte, pas uniquement une saturation par les réponses. Aucun refus de l'admission des réponses, aucune erreur SQL/worker, aucun doublon enregistré. Les 108 demandes créées ont une offre ; 451 récupérations et aucune dépose avant arrêt. Ce scénario incomplet échoue même si les nouveaux contrôles d'admission passent.

Après rotation, les réponses terminées à la capture sont réparties **14 / 40 / 27**, contre **62 / 52 / 34** au premier essai ; les reçus terminés sont **41 / 72 / 53**, contre **117 / 127 / 71**. Le volume GPS reste presque identique entre API. Le groupe le plus sollicité par les réponses suit donc l'affectation vers l'API 2, ce qui suggère une composante liée au trafic métier/à l'affinité des connexions. Cela ne prouve ni une cause unique ni un équilibrage résolu : les instants d'arrêt, gagnants des courses et conditions de l'hôte diffèrent. Le deuxième essai atteint le plafond de génération avec 93 opérations GPS, 17 reçus, 8 réponses et 10 autres opérations en vol ; le retard de planification atteint 77 ms, donc l'arrêt n'est pas celui du seuil de retard de 1 s. 66 demandes ont été créées, 57 ont une offre à l'arrêt, 451 récupérations, aucune dépose. Les 9 demandes sans offre ne sont pas considérées comme validées.

Les deux nettoyages réussissent et les slots WebSocket/acquisitions SQL se libèrent après drainage. Mémoire hôte minimale mesurée par le générateur : environ 1,92 puis 1,41 Gio. Ces essais sur le même PC restent sensibles à sa charge. **Aucune hausse de seuil ni exécution à 750** ; aucun changement AWS, déploiement ou envoi vers un prestataire externe.

Prochaine optimisation à mesurer : réduire le coût et la concurrence des reçus d'alertes et attribuer les lectures encore `unattributed`, sans supprimer leur persistance ni leurs vérifications fraîches. Compléter ensuite la rotation contrôlée sur un hôte de charge séparé et vérifier le routage HTTP/affinité WebSocket réel avant toute conclusion AWS. La cadence GPS, les verrous, la livraison des alertes et les plafonds restent inchangés ; la nouvelle admission protège les réponses mais ne réserve pas à elle seule les connexions nécessaires à tous les traitements.

Vérifications ciblées : 112 tests du banc, 15 tests des admissions, 173 tests dispatch/PostgreSQL, 127 tests de dispatch séquentiel/résilience, 25 tests d'alertes/PostgreSQL et 27 tests de trajets partagés réussis ; 3 tests conditionnels ignorés. Deux dépassements de préparation de fixtures du premier passage ne se reproduisent pas au rejeu complet de la suite dispatch. Les 25 tests d'alertes ont été exécutés séparément avec leur variable d'activation spécifique, après refus de démarrage PostgreSQL dans le bac à sable. Compilation Nest et TypeScript réussies. Ce n'est pas la suite entière du projet ni une validation sur téléphone réel.

## Diagnostic par réplica et admission des réponses

Le banc identifie désormais chaque API dans PostgreSQL (`zwanga-journey-api-1`, `-2`, etc.). Les groupes d'activité et les liens de blocage indiquent le réplica qui attend et celui qui bloque, sans exporter de PID, SQL brut, jeton ou identifiant métier. Le nom reste stable lors d'un redémarrage du même réplica.

Avec `--profile-sql`, `servers[].pendingAcquisitions` et `servers[].pool.pressure[].evidence.acquisitions` donnent le nombre et l'âge des acquisitions de connexion en cours par contexte. Cela inclut la création d'une connexion et l'attente de son callback : seul `pool.waiting` représente exactement la file interne PostgreSQL côté client. Les acquisitions sont retirées des diagnostics après réussite **ou** échec ; les échantillons sont bornés.

Les réponses immédiates aux offres passent par une admission locale partagée par `DataSource` : au plus deux traitements SQL simultanés par API (un pour un petit pool), 32 réponses en attente, délai maximal de 750 ms **avant la première lecture SQL du traitement de réponse** (les gardes d'authentification restent en amont). Une réponse non commencée est refusée avec HTTP 503 / `DISPATCH_RESPONSE_BUSY` si la file est pleine ou le délai dépassé. Le code ne relance aucune écriture et n'interrompt jamais un commit commencé. Les opérations Redis, notifications et vagues suivantes sont hors de cette admission. Les gardes, verrous SQL, vérifications fraîches, règles d'expiration et idempotence restent en place ; GPS et accusés de réception ne passent pas par cette nouvelle file.

`servers[].responseAdmission` expose l'attente et les refus. Le contrôle de santé additionne les attentes du pool, des traitements de fond et des réponses ; tout refus de cette nouvelle admission fait échouer l'essai. Déplacer une attente hors du pool ne peut donc pas, à lui seul, rendre un test vert.

Les deux admissions capturent maintenant le contexte asynchrone du traitement à son entrée. Deux régressions reproduisaient l'héritage du contexte de la tâche libérant une place ; elles passent après correction. Sans cette conservation, le SQL d'une tâche en attente pouvait être attribué au contexte précédent (et les traces mélangées). Les anciens totaux par API restent utilisables, mais la ventilation SQL par contexte des travaux précédemment mis en file n'est pas une attribution fiable.

Pour comparer la répartition, conserver la même graine de fixtures et faire tourner uniquement l'affectation aux API :

```powershell
# Plans uniquement ; ajouter --execute-local pour lancer chaque essai séparément.
node test/load/journeys/run.cjs stage-500-mixed-3api --profile-sql --fixture-seed=replica-balance-v1 --replica-offset=0
node test/load/journeys/run.cjs stage-500-mixed-3api --profile-sql --fixture-seed=replica-balance-v1 --replica-offset=1
node test/load/journeys/run.cjs stage-500-mixed-3api --profile-sql --fixture-seed=replica-balance-v1 --replica-offset=2
```

La graine fixe les identifiants et l'ordre des fixtures synthétiques, **pas** l'ordonnancement, les gagnants des courses ou les identifiants créés par les endpoints. Les secrets JWT, mots de passe Redis et baux d'exécution restent aléatoires. La cadence GPS, les limites et le routage des accusés/réponses vers l'API du conducteur ne changent pas. `mixed-smoke-3api` permet de vérifier les trois API et une rotation avant une charge plus élevée. Les anciens essais à fixtures aléatoires ne constituent pas un comparatif contrôlé avec ces nouveaux essais.

## État historique au 23 novembre 2026, 19 h 03 (Kinshasa)

**500 trajets + 500 demandes passent de nouveau le scénario local**, sur deux API natives Windows, après reprise accélérée, réduction des réécritures de sonnerie et régulation des nouvelles offres sous pression SQL. Rapport : `tmp/load-results/journeys-2026-11-23T17-52-50-418Z/report.json`. Les 500 récupérations/déposes réussissent, sans attribution en double ni alerte non obsolète manquante dans la cohorte finale. **750 reste non validé** : les pics d'attente SQL atteignent 33/48 (plafond 50), et le retard maximal de progression atteint 11,72 s (plafond 15). GPS inchangé à cinq secondes par téléphone, bornes p95 accusé/transmission de 100 ms pendant la phase soutenue. Aucun déploiement AWS ni test de production ; aucune capacité de production certifiée.

Comparaison de deux essais complets sur deux API et avec profilage SQL :

| Mesure | Précédent essai, 18 h 15 | Après régulation, 19 h 00 |
| --- | --- | --- |
| Première allocation p95 | 8,28 s | 5,22 s |
| Première allocation maximale | 16,90 s | 11,27 s |
| Pics d'attente du pool par API | 50 / 43 | 33 / 48 |
| Retard maximal de progression | 8,65 s | 11,72 s |
| Opérations générateur en vol, maximum | 99 / 128 | 109 / 128 |

Le délai d'allocation s'améliore sur ces essais, mais **toutes les marges ne s'améliorent pas**. La charge reste locale et les comportements concurrents font varier le nombre d'offres : ce n'est pas une preuve de gain reproductible ni de capacité AWS. Le nouvel essai compte 73 990 GPS (73 980 transmissions au pair et 10 états terminaux récupérés), 6 060 alertes reçues/confirmées et 500 demandes avec offre. La cohorte figée comprend 5 881 offres : 5 868 observées et confirmées, 13 déjà obsolètes non observées, zéro alerte non obsolète manquante ; 197 offres tardives sont comptées séparément. Zéro erreur SQL/worker et zéro abandon à l'admission SQL ; nettoyage réussi. Les mesures historiques ci-dessous ne remplacent pas cet état ; les essais à fuseaux incohérents sont explicitement signalés.

**Le comparatif final sur trois API échoue encore à 500**, avec le même correctif de régulation : rapport `tmp/load-results/journeys-2026-11-23T18-01-16-461Z/report.json`, pics SQL 73/20/20, plafond 50. L'arrêt survient après 78 créations et 450 récupérations ; ce scénario incomplet ne valide pas les 500 déposes. Le pic capturé sur la première API mêle réponses (transaction de 165 ms), préparation/livraison des alertes, accusés et GPS ; il ne permet pas d'attribuer toute l'attente à une seule requête. Les délais du générateur sont restés sous leur limite (pic 104 opérations en vol, retard maximal 124,5 ms). Nettoyage réussi, zéro doublon enregistré. **Aucun essai à 750 ni maintien à 750 n'a été lancé** : ajouter une API sur cet hôte n'a pas fourni la marge nécessaire.

Avant 750, il reste à mesurer la répartition du trafic critique et du budget SQL total entre réplicas, puis à reproduire le scénario sur un hôte de charge distinct de PostgreSQL/Redis. Les profils 750 et maintien sont prêts, mais leur exécution reste conditionnée à un palier 500 réussi avec de la marge ; ne pas relever les limites pour contourner ces arrêts. La cadence GPS, les reçus de notification et les contraintes d'unicité restent invariants.

Validation finale du code local : compilation Nest et TypeScript réussies ; 330 tests dans les cinq suites dispatch/PostgreSQL/Redis/partage/résilience, 58 tests ciblés de notifications/admission/ordonnancement, et 105 tests du banc de charge réussis, soit 493 tests exécutés avec succès. Trois tests supplémentaires restent ignorés par leur configuration. La suite complète de concurrence a été rejouée après la dernière régulation. Le premier passage avait révélé une assertion devenue obsolète (elle imposait une relance manuelle) ; le test vérifie maintenant la reprise automatique et les huit attributions distinctes, sans relâcher l'unicité métier. Ce décompte ne désigne pas la suite entière du projet ni un test sur téléphone physique.

## Charge modélisée

### Accélération du dispatch et diagnostics (23 novembre)

- Une file locale bornée à 128 identifiants reprend les demandes dès qu'un des trois relais par API se libère. Les reprises d'expiration et les nouvelles demandes alternent lorsqu'elles attendent ; aucun verrou d'attribution n'est supprimé.
- Redis ne réserve plus 50 échéances d'avance pour le relais : au plus six places, en tenant compte des traitements et de la file prêts. Une lecture pleine est suivie d'une reprise après 25 ms lorsque des places sont libres ; une lecture vide attend le cron ou un événement. Ce délai est celui du planificateur, **pas** une modification de la fenêtre de réponse du conducteur.
- Les échéances Redis sont conservées et l'état métier SQL reste durable. Une file pleine, un arrêt du processus ou une panne Redis conservent la récupération existante. Les rappels locaux ne sont pas une preuve d'autorisation.
- La découverte et la réservation d'une **nouvelle** vague sont reportées si au moins deux requêtes attendent déjà une connexion du pool primaire. Le report est planifié au plus tôt 250 ms plus tard, puis repris par les mécanismes habituels. Le retrait des offres expirées, les accusés, les réponses et le GPS ne passent pas par ce frein. Ce n'est ni une garantie de capacité ni un relèvement d'un seuil du banc.
- `lastHealth.servers[].dispatch` expose les raisons cumulées (fenêtre encore active, absence de candidat retourné, contention Redis, admission locale, concurrence à la réservation…) et les durées des phases. Une durée `state`/`discovery`/`reservation` inclut l'admission SQL ; ce n'est pas du temps CPU SQL. Les diagnostics n'enregistrent aucun identifiant ni coordonnées.
- La préparation de sonnerie conserve ses vérifications SQL fraîches et l'ordre de verrouillage état → événement. Un état sain est lu/verrouillé sans réécriture ; une échéance identique ne crée plus une nouvelle version de ligne. Les accusés de réception, les refus et les contrôles avant livraison sont conservés.
- Comparer `stage-500-mixed` puis `stage-500-mixed-3api` à charge identique. Exécuter `stage-750-mixed` seulement si les contrôles précédents passent avec une marge suffisante. Le profil `stage-750-mixed-soak` ajoute quinze minutes de maintien et renouvelle 750 demandes toutes les cinq minutes, sans relâcher les seuils ni modifier le GPS. Ces profils ne constituent pas une certification AWS.

Les deux premiers comparatifs avec reprise accélérée, **avant** la régulation du pool, se sont arrêtés :

| Rapport privé dans `tmp/load-results/` | Topologie et charge | Arrêt observé |
| --- | --- | --- |
| `journeys-2026-11-23T17-43-16-944Z/report.json` | Deux API, 500 trajets + 500 demandes prévues | Pic de 58 attentes SQL sur une API, plafond 50 ; 472 demandes avaient été émises. |
| `journeys-2026-11-23T17-47-27-041Z/report.json` | Trois API, même charge prévue | 127 opérations en vol ; la paire GPS suivante aurait dépassé 128. 155 demandes avaient été émises ; pics SQL 39/39/46. |

Ces essais incomplets ne valident ni la dépose finale ni la cohorte complète des alertes. Aucun seuil n'a été relâché. À trois API, 99 opérations GPS étaient encore en vol au refus d'admission ; les traces associent les pics à un mélange de GPS, accusés, réponses, progression et création de demandes. Elles ne prouvent pas qu'une seule requête SQL, Redis ou le générateur soit responsable. Aucun doublon d'attribution ni erreur SQL n'était enregistré au point d'arrêt ; les deux nettoyages ont réussi. La régulation ajoutée ensuite est un correctif à vérifier, pas une capacité acquise.

Chaque trajet possède un conducteur et un passager distincts, connectés à deux instances différentes. Ils envoient chacun une position toutes les cinq secondes. Les gardes JWT, sessions, quotas, écritures SQL, files de progression et l’adaptateur Redis Socket.IO sont réels.

| Profil | Trajets actifs | Demandes supplémentaires | Durée hors préparation |
| --- | --- | --- | --- |
| `smoke` | 2 pendant 75 secondes | 2 sur 10 secondes | 125 secondes |
| `intermediate-sufficient` | 10 et 50 pendant 75 secondes chacun, puis 100 pendant 180 secondes | 10, 50 puis 100 sur 60 secondes à chaque palier ; 400 conducteurs libres | 6 minutes et 20 secondes |
| `intermediate-scarce` | Mêmes paliers intermédiaires | Mêmes demandes ; seulement 100 conducteurs libres | 6 minutes et 20 secondes |
| `mixed-smoke` | 5 pendant 120 secondes | 8 ; acceptation, refus, absence de réponse, annulation ; 24 conducteurs libres | 170 secondes |
| `resilience-smoke` | 2 pendant 75 secondes, puis reprise | 2 ; 8 conducteurs libres | 155 secondes, plus la fenêtre de panne et de reconnexion |
| `renewal-smoke` | 2 pendant 75 secondes, puis maintien 90 secondes | 3 cohortes de 2 ; renouvellement accéléré toutes les 45 secondes pendant le maintien | 215 secondes |
| `stage-100` à `stage-1000` | Un palier indépendant parmi 100, 250, 500, 750, 1 000, pendant 300 secondes | Autant de demandes et de conducteurs libres que de trajets | 350 secondes |
| `stage-250-sufficient` | 250 pendant 300 secondes | 250 sur 60 secondes ; 1 000 conducteurs libres, sans réponse aux invitations | 350 secondes |
| `stage-250-mixed` | 250 pendant 300 secondes | 250 sur 60 secondes ; 250 conducteurs libres, acceptation, refus, absence de réponse et annulation | 350 secondes |
| `stage-500-mixed` | 500 pendant 300 secondes | 500 sur 60 secondes ; 500 conducteurs libres, mêmes comportements mixtes | 350 secondes |
| `stage-750-mixed` | 750 pendant 300 secondes | 750 sur 60 secondes ; 750 conducteurs libres, mêmes comportements mixtes ; trois API | 350 secondes |
| `capacity` | 100, 250, 500, 750, 1 000 ; cinq minutes par palier | Une cohorte à chaque palier, puis 1 000 renouvelées toutes les 20 minutes ; 5 600 créations au total | 85 minutes et 50 secondes, dont une heure de maintien |

Ces durées excluent la création des bases, la montée des connexions et le remplacement des cohortes. Un échec arrête la progression ; les profils indépendants ne dispensent pas de réussir le précédent.

À 1 000 trajets, la cible est de 2 000 connexions de suivi et 400 mises à jour GPS par seconde. Les 1 000 conducteurs en trajet et 1 000 autres disponibles possèdent aussi chacun une connexion aux alertes. Avec le canal chat des 1 000 passagers en trajet et des 1 000 demandeurs, le budget atteint 6 000 sockets. Les conducteurs disponibles ajoutent environ 33 positions par seconde. Le banc prévoit quatre API, soit environ 1 500 sockets chacune, pour conserver au moins 20 % de marge sous la limite existante de 2 000 sessions par instance. Il ne relève aucun quota backend. Les demandes arrivent à environ 16,7 par seconde pendant une minute, pas toutes dans la même milliseconde.

Les nouvelles demandes empruntent `POST /api/v1/trip-requests`. Tous les conducteurs écoutent `ride_alert` et confirment les réceptions via l’API. Les profils de débit ne répondent pas aux invitations. `mixed-smoke`, `stage-250-mixed` et `stage-500-mixed` exercent l’acceptation concurrente, le refus puis l’acceptation, l’absence de réponse et l’annulation par le passager. Seuls les conducteurs disponibles utilisent l’acceptation immédiate ; le consentement au covoiturage n’est pas contourné. Les conflits HTTP 409 sur ces réponses sont comptés à part ; les 401, 403, 429 et erreurs serveur restent bloquants. Un contrôle SQL refuse plusieurs acceptations gagnantes pour une demande. Cela ne teste pas la conversion complète des nouvelles demandes jusqu’au paiement.

Les trajets actifs sont des fixtures déjà acceptées. Le déplacement partagé déclenche la récupération automatique ; la phase finale conduit les véhicules à destination puis vérifie les déposes en base. Les demandes expirent après 30 minutes. Pendant le maintien, le banc annule la cohorte précédente via son API authentifiée et en crée une autre toutes les 20 minutes, avec de nouveaux comptes synthétiques. Il ne modifie pas directement les échéances en base. Les périodes de remplacement sont distinctes de la charge stable.

## Exécution locale

Prérequis : Node indiqué dans `.nvmrc`, dépendances de développement installées, PostgreSQL avec PostGIS et Redis. Sous Windows, Redis est lancé dans la distribution WSL Ubuntu ; chaque serveur écoute un port local distinct. `LOAD_TEST_PG_BIN` peut désigner les binaires PostgreSQL, jamais une base existante. Les profils au-delà de 100 trajets et le mode conteneur refusent une autre version Node ; les petits diagnostics signalent explicitement l’écart dans le rapport.

```powershell
npm.cmd run build
npm.cmd run test:load:journeys:unit

# Affiche uniquement le plan, sans démarrer de serveur.
npm.cmd run test:load:journeys -- capacity

# Crée les ressources locales, exécute le petit scénario, puis les nettoie.
npm.cmd run test:load:journeys -- smoke --execute-local
npm.cmd run test:load:journeys -- mixed-smoke --execute-local
npm.cmd run test:load:journeys -- resilience-smoke --execute-local
npm.cmd run test:load:journeys -- renewal-smoke --execute-local

# Comparaison intermédiaire : une seule exécution à la fois.
npm.cmd run test:load:journeys -- intermediate-sufficient --execute-local
npm.cmd run test:load:journeys -- intermediate-scarce --execute-local

# Un palier à la fois, après réussite du précédent.
npm.cmd run test:load:journeys -- stage-250 --execute-local

# Comparaisons à 250, une seule exécution à la fois, avec les mêmes seuils.
npm.cmd run test:load:journeys -- stage-250-sufficient --execute-local
npm.cmd run test:load:journeys -- stage-250-mixed --execute-local

# Diagnostic optionnel : 180 secondes maximum, démarrées avant le premier GPS.
# Ne pas assimiler un essai instrumenté à une mesure sans surcoût de profilage.
npm.cmd run test:load:journeys -- stage-500-mixed --execute-local --profile-cpu --profile-sql

# Long essai local, à lancer seulement après validation des paliers intermédiaires.
npm.cmd run test:load:journeys -- capacity --execute-local
```

Sous Linux, utiliser `npm` et renseigner `LOAD_TEST_PG_BIN`. Les artefacts restent dans `tmp/load-results/journeys-…/` : rapport JSON et journaux synthétiques. Les JWT et mots de passe générés ne sont pas écrits dans le rapport. Le nettoyage supprime uniquement les clusters temporaires créés pour cet essai ; il conserve les rapports.

L’exécution construit le schéma des entités puis applique les migrations requises par le dispatch et la progression. Ce n’est pas une validation de la chaîne complète des migrations de production. Les déclencheurs financiers SQL ne sont pas installés. Les écritures métier, dont certains crédits de fidélité à la fin du trajet, restent confinées à la base synthétique.

## Arrêts et interprétation

Le générateur suit une cadence indépendante des réponses, sans recalage des échéances pour masquer un retard. Dans la tolérance d'une seconde, plusieurs émissions peuvent devenir dues à la même itération ; le plafond d'admission reste alors applicable. Un retard supérieur à une seconde, une tentative de dépasser 128 opérations en vol, une erreur HTTP/socket, une tentative de connexion externe, une erreur SQL, une éviction Redis ou une progression en attente depuis plus de 15 secondes arrête l’essai. Les plafonds locaux sont de 900 Mio de RSS et 50 attentes du pool par backend.

Chaque palier doit fournir des accusés GPS et des positions à l’autre participant, avec une borne supérieure du p95 au plus égale à une seconde. Les histogrammes ont des classes fixes : `p95UpperBoundMs` est une borne, pas un percentile exact. Une valeur `null` signifie un dépassement de la dernière classe, jamais une absence de lenteur.

Le rapport distingue les émissions GPS, les réceptions entre instances, les réponses API, les premières alertes, leurs accusés de réception, les récupérations et les déposes. `productionCapacityValidated` reste toujours `false`. Les logs, compteurs SQL, mémoire, attente de connexions et ancienneté de la file aident à localiser le premier goulot d’étranglement.

Les profils intermédiaires gardent les mêmes trajets et arrivées de demandes. Seul le nombre de conducteurs libres supplémentaires change ; leurs connexions et positions ajoutent donc aussi du travail. Les conducteurs en trajet peuvent également être candidats au covoiturage. Leurs alertes sont maintenant reçues et confirmées, puis séparées dans `generator.alertGroups.active` et `available`. La variante à 100 conducteurs libres ne représente donc pas seulement 100 candidats au total.

Les délais `first_alert` et `outcomes.delivery` couvrent les deux groupes instrumentés. Les demandes commencent à chaque palier, y compris 10 et 50. Le délai de première offre comprend l’attente d’un candidat disponible et ne mesure pas uniquement le réseau.

### Clôture et récupération de l’état

Un GPS reçu après clôture reste refusé. Après vérification du propriétaire, le gateway renvoie `success:false`, `status:state_changed`, `code:TRACKING_STATE_CHANGED` et les identifiants de l’opération. Le banc appelle alors `get_tracking_state` sous la même authentification. Ce nouvel événement ne rejoint aucun salon et ne retourne aucune position : il vérifie le conducteur du trajet ou le propriétaire de la réservation liée. Seule une clôture confirmée fait arrêter le client. Les refus d’accès et les états inattendus restent des erreurs.

`terminalGps` compte ces écritures refusées et réconciliées séparément des positions acceptées et diffusées. Deux sondes finales reproduisent volontairement le GPS tardif (`terminalProbes`). Les messages et statuts HTTP 400 reconnus par les versions mobiles existantes sont conservés. L’adoption du nouvel échange par l’application mobile n’est pas incluse dans ce banc.

### Reprise après incident

`resilience-smoke` suspend le scheduler de progression du banc, enfile des travaux via de vrais GPS authentifiés, puis arrête brutalement une API créée par cet essai. La nouvelle instance doit vider la file persistante. Une coupure de 1,5 seconde du relais Redis privé force les reconnexions avec la politique Redis utilisée en production. Tous les clients se reconnectent par lots de 16, repassent l’authentification et rejoignent leurs salons. Trente secondes de GPS sous les seuils habituels doivent ensuite réussir.

La fenêtre de panne est mesurée séparément : elle ne compte pas comme une période ayant tenu le débit nominal. Les erreurs de transport Redis injectées sont exposées dans `redisTransportErrors` ; erreurs SQL, erreurs des workers et connexions externes ne sont pas effacées. Le scénario teste la reprise des travaux en attente, pas toutes les étapes possibles d’un crash au milieu d’une transaction ou d’un traitement externe. Aucun outil ne permet de choisir une cible de panne distante.

Les profils mixtes et `resilience-smoke` rejouent également deux positions anciennes et exigent `superseded`, sans les compter comme de nouvelles positions acceptées.

Le backend et le banc utilisent le même adaptateur Redis renforcé (`src/common/resilient-redis.adapter.ts`). Les promesses de publication et de souscription ignorées par l’adaptateur tiers ont un gestionnaire de rejet : une coupure ne doit pas arrêter l’API par rejet non géré. Les erreurs restent comptées et journalisées sans contenu métier ; les promesses d’origine restent rejetées pour les appelants qui les attendent. La file hors ligne reste désactivée. Les notifications dont le transport Redis est déjà indisponible restent réessayables dans leur outbox.

Cela ne rend pas Pub/Sub durable : un `emit` n’est pas une preuve de réception, et une coupure après le contrôle de disponibilité peut encore perdre un événement distant. Les accusés métier et la réconciliation authentifiée restent nécessaires. [Comportement de l’adaptateur Socket.IO lors d’une coupure Redis](https://socket.io/docs/v4/redis-adapter/#what-happens-when-the-redis-server-is-down)

## API locales avec limites de ressources

Sous Linux ou WSL avec un moteur Docker accessible, construire explicitement l’image du banc puis lancer un petit scénario :

```bash
node test/load/journeys/lab-image.cjs --build
npm run build
node test/load/journeys/run.cjs smoke --containerized-api --execute-local
```

Sans `--build`, la première commande affiche seulement le plan de construction. L’image est vérifiée par empreinte des sources et version Node, puis lancée par son identifiant immuable. Chaque API est limitée à 0,5 vCPU, 1 Gio sans swap, 128 processus, système de fichiers en lecture seule, sans capacités Linux ni montage du dépôt ou du socket Docker. Les paramètres synthétiques transitent par un fichier temporaire privé, supprimé au nettoyage. Les journaux utilisent un espace temporaire limité. Le parent ne transmet aucun accès AWS réel.

Ce mode exige le réseau hôte Linux pour joindre uniquement les bases locales jetables. Il n’est pas validé sur cette machine Windows : le moteur Docker n’est pas démarré. PostgreSQL, Redis et le générateur ne sont pas encore isolés sur des machines de tailles AWS équivalentes. `productionCapacityValidated` reste faux.

`outcomes.allocation` mesure en SQL le délai entre création de demande et première offre ; `outcomes.delivery` mesure le délai entre création de notification et réception confirmée par l’API. Ces percentiles sont exacts sur les observations disponibles, contrairement aux bornes des histogrammes GPS. Les demandes sans offre restent comptées séparément et font échouer la validation finale. `healthHistory` conserve au plus 180 échantillons avec les offres en attente et les conducteurs enregistrés non réservés. Ce dernier compteur n’est pas une preuve d’éligibilité : distance, KYC, historique des invitations et autres règles restent appliqués par le backend. `currentPhase` situe un éventuel arrêt.

L’arrêt à un palier signifie que ce scénario n’a pas respecté ses critères sur cette machine. Cela ne prouve pas, à lui seul, une limite AWS : vérifier aussi le retard du générateur, ses ressources et le stock de conducteurs disponibles. Ne pas relever les seuils simplement pour obtenir un résultat vert.

## Laboratoire AWS avant validation de capacité

Le fichier `infra-aws/profiles/journey-load-lab.proposal.json` décrit le socle de production : deux tâches ARM64 de 0,5 vCPU et 1 Gio, RDS `db.t4g.small`, deux nœuds Redis `cache.t4g.micro`, autoscaling jusqu’à trois tâches. Le scénario local complet à 1 000 trajets réserve quatre API pour sa marge de sessions ; cette différence ne modifie pas la production et doit être budgétée avant un laboratoire AWS. Le fichier reste une proposition, pas un fichier Terraform exécutable ; le provisionnement et le générateur distant restent à implémenter.

Le laboratoire doit avoir son propre état Terraform, VPC, bases, secrets, rôles et noms de ressources. Il ne doit pas partager Redis, utiliser un snapshot contenant les utilisateurs réels ou pouvoir appeler les SMS, paiements et notifications de production. Le générateur doit tourner sur une autre ressource que les API. Un environnement proche de la production est nécessaire pour une mesure de capacité représentative. [AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel12-bp03.html)

Avant création, valider le coût horaire supplémentaire et la durée maximale, préparer l’arrêt automatique, épingler l’image déployée, vérifier les alarmes et la réception des alertes. Le budget mensuel de production de 175 USD n’autorise pas implicitement le coût de ce laboratoire. Aucun `terraform apply` de production n’est nécessaire pour le banc local.

Pour annoncer une capacité de 1 000 trajets, il faudra ensuite réussir le maintien de charge dans ce laboratoire, vérifier les délais de récupération/dépose et d’alertes, puis mesurer une défaillance contrôlée et la reprise. Les paiements, la création/acceptation des trajets, les reconnexions et les téléphones en veille nécessitent des scénarios complémentaires. Les seuils d’autoscaling devront être choisis à partir de ces mesures, pas du seul nombre d’utilisateurs. [Guide ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-autoscaling-best-practice.html)

## Vérification des nouveaux scénarios

Les essais du 22 novembre 2026 utilisent toujours Node 24.11.0 et des processus locaux non limités. Les petits scénarios ci-dessous valident les mécanismes, pas le palier 1 000 ni les ressources AWS. Les rapports restent privés dans `tmp/load-results`.

| Scénario | Résultat vérifié |
| --- | --- |
| Métier mixte après correctif Redis | 5 récupérations et déposes ; 8 demandes ; 4 acceptations, 1 refus, 2 annulations ; 9 conflits concurrents comptés ; aucune double acceptation ; 302 GPS échangés sur 302 |
| Alertes du scénario mixte | 57 reçues et confirmées, dont 4 pour des conducteurs déjà en trajet |
| Reprise après correctif Redis | File en attente récupérée après crash d’une API et coupure du relais Redis ; reprise de 18 connexions puis 114 GPS reçus sur 114 émis sur l’ensemble du scénario |
| Durée de reprise observée | 9,66 secondes pour redémarrage et Redis, puis 279 ms pour les reconnexions ; mesures distinctes du débit stable |
| Renouvellement accéléré | 6 demandes en 3 cohortes ; 4 anciennes annulées ; 38 alertes confirmées ; 158 GPS échangés |
| GPS hors ordre et terminal | Deux anciennes positions reconnues `superseded` ; deux GPS après clôture refusés puis état final récupéré |
| Contrôles ciblés | 94 tests backend sur 12 suites, dont 8 tests PostgreSQL, et 59 contrôles Node du banc et de l’infrastructure réussis : 153 au total, pas la suite entière du projet |

Rapports : `journeys-2026-11-22T11-08-38-341Z` pour le métier après correctif Redis, `journeys-2026-11-22T11-03-14-642Z` pour la reprise après correctif Redis, `journeys-2026-11-22T10-39-58-016Z` pour le renouvellement. Le test de renouvellement précède l’ajout du chat des demandeurs au budget complet. Les derniers tests métier et reprise couvrent ces canaux. La reprise conserve 16 alertes reçues et confirmées, ne rencontre aucune erreur SQL/worker et traite les erreurs Redis injectées dans la seule fenêtre de panne. Les bases synthétiques correspondantes ont été nettoyées.

Le premier essai de reprise (`journeys-2026-11-22T10-22-00-975Z`) reste enregistré en échec : le générateur reprenait un calendrier de positions devenu périmé pendant la panne. Le calendrier des conducteurs disponibles est désormais réinitialisé dans la fenêtre explicite de reprise, sans rattrapage en rafale ni modification des seuils des phases stables.

L’essai `journeys-2026-11-22T10-52-45-342Z`, avec les canaux chat complets, reste lui aussi enregistré en échec. Il a révélé un défaut réel : une promesse `publish` rejetée pendant la coupure Redis n’était pas traitée par l’adaptateur Socket.IO ; le gestionnaire de rejets Winston arrêtait alors une seconde API. Ce défaut a conduit au correctif commun décrit plus haut et à six tests de régression. Aucun gestionnaire global d’erreur ni contrôle d’autorisation n’a été désactivé pour faire passer le test.

### Nouveau passage à cent trajets avec tous les canaux chat

`journeys-2026-11-22T10-44-59-341Z` réussit les paliers 10, 50 et 100 avec 100 conducteurs libres supplémentaires et une cohorte de demandes à chaque palier. Le plan couvre 600 sockets au maximum, sur deux processus non limités.

| Mesure | Résultat |
| --- | --- |
| GPS émis et reçus entre participants | 10 424 sur 10 424 |
| Récupérations et déposes automatiques | 100 et 100 |
| Demandes créées, proposées et vues en temps réel | 160 sur 160 |
| Alertes reçues et confirmées | 1 450 ; 578 aux conducteurs en trajet et 872 aux conducteurs libres |
| Accusé GPS conducteur au palier 100 | Borne supérieure du p95 de 20 ms |
| Première offre SQL | p95 de 30,44 s ; maximum de 76,79 s |
| Notification créée jusqu’à réception confirmée | p95 de 323 ms |
| Plus vieille progression en file observée | 0,97 s |
| RSS maximal des API | 329 et 334 Mio |
| Attente maximale observée des pools | 6 et 3 |
| Erreurs SQL, workers, transport Redis, évictions | 0 |
| Vagues excessives, doubles invitations simultanées et doubles acceptations finales | 0 |
| GPS tardifs après clôture | 2 refusés avec récupération authentifiée de l’état final |

Le nettoyage des bases jetables réussit. Aucun quota d’autorisation n’a été relevé. Le succès couvre le débit GPS et les résultats métier ; aucun objectif contractuel de délai de première offre n’est défini par ce banc. L’attente de candidats dans ce scénario sans acceptation reste importante et interdit de présenter ce résultat comme une garantie d’alertes immédiates. Les 250 à 1 000 trajets et l’heure complète de maintien restent à exécuter avec le runtime et les ressources représentatifs.

## Vérification locale initiale du 22 novembre 2026

Les sections historiques qui suivent conservent leurs profils et périmètres d’origine. Elles ne décrivent pas les nouveaux profils du tableau ci-dessus.

L’essai `smoke` de 01 h 57 à 01 h 59, heure de Kinshasa, a réussi sur deux processus backend locaux. Le rapport conservé est `tmp/load-results/journeys-2026-11-22T00-57-04-887Z/report.json`.

| Contrôle | Résultat |
| --- | --- |
| Positions émises et reçues par l’autre participant | 86 sur 86 |
| Récupérations puis déposes automatiques | 2 puis 2 |
| Demandes créées et vues dans les alertes | 2 sur 2 |
| Alertes uniques reçues et confirmées | 4 sur 4 |
| Accusés et diffusion GPS | Borne supérieure du p95 de 50 ms |
| Erreurs SQL et connexions externes tentées | 0 |
| Évictions Redis et attente maximale du pool observée | 0 |
| Nettoyage des bases jetables | Réussi |

Le délai maximal de première alerte était de **41,47 secondes**. Le petit scénario ne disposait que de deux conducteurs libres pour deux demandes, avec des vagues pouvant inviter jusqu’à quatre conducteurs. Ce délai est cohérent avec l’attente de libération des invitations précédentes ; il ne démontre pas une saturation de RDS ou Redis. Le succès fonctionnel ne signifie donc pas que l’objectif d’une alerte immédiate est atteint. Les essais suivants doivent comparer plusieurs stocks de conducteurs et mesurer séparément attente de disponibilité, allocation et livraison.

La compilation et 42 contrôles rapides ciblés ont réussi, dont 14 sur le nouveau banc. Aucun palier de 1 000 trajets n’a été exécuté. La machine locale utilisait Node 24.11.0 ; la plage déclarée du projet commence à 24.22.1. Le laboratoire devra utiliser la version supportée et l’image effectivement déployée avant toute conclusion de capacité.

## Essais exploratoires avant correction

Les premiers essais du 22 novembre ont révélé deux courses de concurrence WebSocket. La seconde variante s’est arrêtée pendant la montée de 10 à 50 trajets. Ces passages utilisaient cinq workers ; ils ne suffisent pas à valider la fiabilité ni à conclure sur les 1 000 trajets.

### Premier passage avec 400 conducteurs disponibles

Le rapport `tmp/load-results/journeys-2026-11-22T01-25-18-952Z/report.json` couvre les paliers 10, 50 et 100, avec 100 demandes au dernier palier. La machine dispose de 8 processeurs logiques et environ 15,7 Gio de RAM ; aucune limite Fargate n’est appliquée.

| Mesure | Résultat local exploratoire |
| --- | --- |
| Positions émises et reçues | 10 686 sur 10 686 |
| Récupérations et déposes automatiques | 100 et 100 |
| Demandes créées et vues dans les alertes | 100 sur 100 |
| Alertes uniques reçues et confirmées | 1 561 sur 1 561 |
| Borne supérieure du p95 GPS au palier 100 | 50 ms |
| Délai maximal de première alerte | 345 ms |
| Délai SQL de première offre, p95 | 83 ms |
| Notification créée jusqu’à réception confirmée, p95 | 646 ms |
| Plus vieille progression en file observée | 2,30 secondes |
| Erreurs SQL, requêtes SQL dépassant 250 ms, évictions Redis | 0 |
| RSS maximal par backend | Environ 340 Mio |
| Attente maximale observée du pool par backend | 14 |

Le transport push est synthétique : ces délais ne mesurent pas FCM/APNs ni un téléphone en veille. Les 1 561 alertes incluent les vagues successives, puisque les conducteurs n’acceptent aucune demande.

### Arrêt pendant la seconde variante

Le rapport `tmp/load-results/journeys-2026-11-22T01-33-12-632Z/report.json` valide 10 trajets puis s’arrête pendant l’ouverture des salons du palier 50 : `Authorized socket/room registration deadline`. Aucune des 100 demandes n’avait encore été créée. Les dernières mesures montrent zéro attente du pool, zéro erreur SQL et une file de progression âgée de 0,09 seconde ; elles ne désignent pas une saturation.

Deux défauts sont reproduits séparément, sans base ni réseau :

- Dans `src/common/services/ws-tracking-rooms.ts`, la liste des identifiants est prise avant la requête SQL, mais les salons sont parcourus à nouveau après. Un salon autorisé rejoint pendant cette requête n’existe pas dans son résultat et est retiré à tort. Ce mécanisme est compatible avec le salon qui ne reste pas enregistré pendant la montée ; le rapport ne contient pas la trace exacte de son retrait.
- Dans `src/common/services/ws-session.service.ts`, la vérification charge les utilisateurs d’un instant donné puis parcourt la collection courante des sessions. Une session ajoutée pendant la lecture SQL peut recevoir `session_expired` sans avoir été révoquée. Ce second défaut est reproduit, mais n’est pas identifié comme le signal d’arrêt du rapport ci-dessus.

Les correctifs locaux font porter chaque vérification sur les sessions et salons effectivement inclus dans sa lecture. Une session remplacée pendant la requête n’est pas révoquée par son résultat périmé. Les nouvelles connexions restent authentifiées à leur arrivée et sont revalidées au passage suivant. Une panne SQL ferme toujours les sessions concernées ; les comptes désactivés ou révoqués et les participants exclus restent refusés.

Les tests de régression ont d’abord reproduit cinq échecs sur le code antérieur. Après correction, les 14 tests des sessions et salons passent. La validation élargie couvre 61 tests dans sept suites : autorisation WebSocket, sessions, salons GPS, accusés de position, arrêt des connexions et sécurité du chat. La compilation réussit également.

### Corrections du banc et portée des mesures

Le banc attend désormais l’enregistrement complet dans `WsSessionService` avant d’envoyer des événements. La présence précoce de `userId`, issue du seul décodage JWT, n’était pas une preuve que les contrôles SQL étaient terminés. Les diagnostics WebSocket utilisent une liste de catégories autorisées, sans copier de messages ou jetons arbitraires.

Les passages exploratoires ci-dessus utilisaient cinq workers. Le banc a ensuite été complété avec le relais des échéances chaque seconde, la récupération des notifications sans accusé toutes les cinq secondes et la réconciliation des sonneries chaque minute. `workers.cjs` enregistre maintenant les huit cadences et chaque nouveau rapport contient `workerSchedules` pour les deux backends. Les mesures exploratoires ne constituent donc pas une comparaison définitive des délais d’alerte.

La compilation et 52 tests ciblés passent, dont 19 sur le banc. Les bases jetables des essais ont été supprimées ; les rapports restent privés et ignorés par Git. Aucun appel AWS, déploiement ou changement de production n’a été effectué pour ces essais.

## Validation après correction du 22 novembre 2026

Les deux courses de concurrence sont corrigées et les deux variantes ont franchi les paliers 10, 50 et 100. **La comparaison complète reste non validée** : la variante à stock réduit s’est arrêtée pendant la dépose finale sur un refus GPS.

Les rapports privés couvrent huit workers par backend, sur deux processus :

- Groupe libre de 400 conducteurs : `tmp/load-results/journeys-2026-11-22T09-14-34-977Z/report.json`, de 10 h 14 à 10 h 22, heure de Kinshasa.
- Groupe libre de 100 conducteurs : `tmp/load-results/journeys-2026-11-22T09-23-00-700Z/report.json`, de 10 h 23 à 10 h 29.

| Mesure | 400 conducteurs libres | 100 conducteurs libres |
| --- | --- | --- |
| Scénario complet | Réussi | Arrêt pendant la dépose finale |
| Paliers GPS validés | 10, 50 et 100 | 10, 50 et 100 |
| Positions GPS reçues sur émises | 10 730 sur 10 730 | 10 446 sur 10 448 |
| Récupérations et déposes automatiques en base | 100 et 100 | 100 et 100 |
| Demandes avec une offre SQL | 100 sur 100 | 100 sur 100 |
| Demandes vues par les clients d’alerte instrumentés | 100 sur 100 | 73 sur 100 |
| Alertes uniques reçues et confirmées | 1 858 sur 1 858 | 547 sur 547 |
| Borne supérieure du p95 GPS au palier 100 | Au plus 50 ms | Au plus 50 ms |
| Première offre en base, p95 et maximum | 93 ms et 160 ms | 46,24 s et 78,49 s |
| Première alerte reçue, maximum observé | 454 ms | 157,01 s, sur 73 demandes observées |
| Notification créée jusqu’à réception confirmée, p95 | 308 ms | 492 ms |
| Ancienneté maximale observée de la file de progression | 0,80 s | 1,71 s |
| RSS maximal par backend | 333 et 338 Mio | 329 et 329 Mio |
| Attente maximale observée du pool par backend | 5 et 12 | 7 et 9 |
| Erreurs SQL, erreurs de workers, évictions Redis | 0 | 0 |
| Requêtes SQL de plus de 250 ms | 2, maximum 344 ms | 18, maximum 298 ms |
| Nettoyage des bases jetables | Réussi | Réussi |

Les contrôles SQL finaux n’ont trouvé ni vague en attente de plus de quatre invitations ni conducteur invité simultanément par deux demandes. Les alertes incluent les vagues successives : aucun conducteur synthétique n’accepte les nouvelles demandes. Le générateur a atteint environ 40 positions GPS par seconde au palier 100 dans les deux variantes, avec un retard maximal de 202 ms et 138 ms respectivement.

### Arrêt au moment de la fin du trajet

Le second rapport conserve `localScenarioPassed=false` et `Socket business error: unclassified`. À 10 h 29 min 38 s, `backend-0.log` confirme un appel `updateDriverLocation` après le passage du trajet à `completed`. Ce code refuse les positions après clôture ; le contrôle d’autorisation n’a pas été assoupli. Le rapport comporte deux accusés GPS négatifs, un conducteur et un passager, alors que les 100 déposes sont bien présentes en base.

Le générateur arrête ses positions lorsqu’il reçoit `booking_auto_progress` avec `dropoff_confirmed`. Or la mise à jour SQL précède la publication par le worker, et la vérification périodique peut retirer les salons des trajets terminés. L’envoi tardif est confirmé par le journal ; le retard ou la perte exacte de l’événement de clôture reste à tracer. Ce n’est pas une preuve de saturation AWS ni un nouvel échec d’authentification.

Le diagnostic local reconnaît désormais les refus connus `trip_not_active` et `booking_not_trackable`, sans recopier de message arbitraire. Ils restent des erreurs bloquantes : aucun refus n’est transformé en position GPS acceptée. Cette classification a été vérifiée par test unitaire après l’essai, sans réécrire son rapport historique.

### Attente des alertes et suite

Dans la variante à stock réduit, le p95 de première offre atteint 46,24 secondes, alors que le p95 de livraison confirmée des notifications observées reste à 492 ms. L’attente concerne donc largement l’attribution en amont de la livraison. Jusqu’à 23 demandes sont observées sans offre ; les invitations réservent les candidats et leur expiration permet la progression. Le rôle des conducteurs déjà en trajet non instrumentés limite toutefois l’interprétation de cette comparaison.

Avant d’augmenter la charge :

1. Tracer et tester la transition SQL puis événement de clôture, y compris un GPS déjà en vol. Vérifier la récupération de l’état final côté client sans tolérer une position non autorisée.
2. Instrumenter aussi les alertes des conducteurs en trajet et séparer les résultats de ce groupe de ceux des conducteurs libres.
3. Rejouer les deux variantes avec une version Node supportée. Ne passer aux paliers supérieurs qu’après validation complète, sans relever les seuils pour masquer un échec.

La compilation, les 61 tests WebSocket et les 53 contrôles du banc et de l’infrastructure passent. Les bases de ces deux essais ont été supprimées ; les rapports restent ignorés par Git. Aucun appel AWS ni changement de production n’a été effectué.

Ces résultats restent locaux : Node 24.11.0, hôte de 8 processeurs logiques et 15,7 Gio de RAM, sans limites Fargate. Les 1 000 trajets, le maintien d’une heure, les téléphones en veille et les transports push réels ne sont pas validés. La version Node supportée par le projet commence à 24.22.1.

## Réduction de l’attente de première offre

Le dispatch conserve les vagues de quatre conducteurs et la fenêtre de réponse de 40 secondes. La création d’une demande déclenche déjà une recherche après commit ; les changements portent sur les reprises quand aucun conducteur n’est immédiatement disponible.

- **Réveil après disponibilité** : après un refus, le retrait d’invitations expirées ou annulées, une nouvelle disponibilité ou une position redevenue exploitable, le backend cherche des demandes voisines, de types de véhicules compatibles. Il réveille au plus une demande par conducteur libéré, avec un plafond de quatre demandes par événement. Les changements de statut ORM des demandes et des trajets ajoutent des indications après commit. Les positions GPS ordinaires et les heartbeats ne déclenchent pas cette recherche.
- **Reprises progressives** : avant toute première invitation, une recherche sans candidat est replanifiée à 1, 2, 5 puis 15 secondes. Après une invitation, une recherche vide conserve le délai de 15 secondes. Un événement de disponibilité peut avancer cette échéance. Le compteur partagé entre instances expire et disparaît après une offre ou une clôture.
- **Priorité avec ancienneté** : une demande jamais invitée est classée sur sa date de création ; une demande déjà invitée, sur la dernière invitation plus 30 secondes. Une ancienne demande retrouve ainsi progressivement sa priorité face aux demandes plus récentes. Le balayage de secours privilégie aussi les demandes non examinées depuis 30 secondes. Il ne s’agit pas d’une garantie d’offre sous 30 secondes : un conducteur compatible doit être disponible.

Les indications de disponibilité sont dédupliquées dans Redis pendant une seconde, avec au plus deux sélections géographiques et deux workers de réveil par instance, et une file locale limitée à 200 identifiants. Chaque sélection a un délai SQL maximal d’une seconde. Un budget commun limite à trois les relais simultanés par instance, qu’ils viennent de la création HTTP, des échéances, du balayage de secours ou des événements. Les reprises d’une même découverte sont regroupées par demande, configuration et génération d’offre.

Ces indications ne réservent aucun conducteur. Le relais SQL recontrôle toujours les permissions, la proximité, le KYC, le véhicule, les places, les disponibilités, les priorités ciblées et les invitations existantes. Une transaction annulée ne déclenche pas de réveil. Si Redis ou une indication échoue, les balayages SQL et les échéances existantes restent actifs. Aucune nouvelle migration ni variable d’environnement n’est nécessaire.

La comparaison utilise `intermediate-scarce`, avec les mêmes paliers et conducteurs synthétiques que le passage précédent. La mesure « première offre » désigne une invitation créée en base, pas une acceptation par un conducteur ni une notification reçue sur un téléphone réel.

### Comparaison locale du dispatch

Les trois passages ci-dessous utilisent deux API, les paliers 10, 50 et 100 trajets, 100 conducteurs libres supplémentaires et 160 demandes au total. Les fournisseurs externes restent simulés. Les rapports privés sont conservés sous `tmp/load-results` :

- Référence : `journeys-2026-11-22T10-44-59-341Z/report.json`.
- Premier réglage : `journeys-2026-11-22T13-27-55-447Z/report.json`.
- Réglage avec budget commun de trois relais : `journeys-2026-11-22T14-33-02-291Z/report.json`.

| Mesure observée | Référence | Premier réglage | Budget commun |
| --- | --- | --- | --- |
| Première invitation SQL, p95 | 30,44 s | 13,39 s | 12,53 s |
| Première invitation SQL, maximum | 76,79 s | 20,46 s | 17,42 s |
| Notification créée jusqu’à réception confirmée, p95 | 323 ms | 1 137 ms | 643 ms |
| Attente maximale du pool par API | 6 / 3 | 20 / 32 | 4 / 2 |
| Demandes ayant reçu une invitation | 160 / 160 | 160 / 160 | 160 / 160 |
| Doubles invitations simultanées d’un conducteur | 0 | 0 | 0 |
| Scénario complet | Réussi | Réussi | Arrêt pendant les déposes |

Le budget commun réduit le surcoût de concurrence du premier réglage. Sur le dernier passage, les trois paliers passent sans erreur SQL, erreur de worker ni éviction Redis. Le délai de première invitation p95 est inférieur d’environ 59 % à la référence ; la livraison confirmée reste plus lente que dans la référence. Ces observations ne constituent pas une garantie de délai en production.

**Le passage de 14 h 33 UTC est incomplet.** Pendant les déposes, un accusé GPS passager est refusé par le banc : `GPS acknowledgement rejected or mismatched`. Il compte 10 248 envois et 10 247 livraisons observées, 100 récupérations et seulement 12 déposes au moment de l’arrêt. Le rapport ne contient pas le statut précis de cet accusé ; il ne permet donc pas d’attribuer avec certitude l’arrêt à une course de clôture ou à un échantillon remplacé.

Le diagnostic du banc distingue désormais `superseded`, `state_changed`, `correlation_mismatch`, `rejected` et les réponses absentes ou inconnues. Aucun de ces cas ne devient un GPS accepté. Sept tests du banc confirment notamment la corrélation obligatoire, la récupération d’un état terminal authentifié et l’absence de données sensibles dans ce diagnostic.

La compilation et les 212 tests ciblés de dispatch, réservation et trajet passent. La suite SQL/Redis complète a réussi avec 96 tests exécutés ; les 18 cas affectés par le plafonnement final ont été rejoués avec succès. Les bases temporaires des trois passages ont été nettoyées. Aucun déploiement ni changement AWS n’a été effectué. Les limites Node 24.11.0 et absence de quotas Fargate restent applicables : la capacité de production à 1 000 trajets n’est pas certifiée.

### Correction des accusés GPS en concurrence

Un défaut est reproduit dans `updatePassengerLocation` et `updateDriverLocation` : après une lecture autorisant le suivi, la dépose peut clôturer la réservation ou le trajet avant l’écriture GPS conditionnelle. L’écriture ne modifie alors aucune ligne, mais le backend répondait `superseded` sans recontrôler l’état relu. Une disparition du dossier ou une révocation d’accès pouvaient aussi être assimilées à tort à une position plus récente.

Le backend applique maintenant les mêmes contrôles d’autorisation et de statut après cet échec d’écriture. Une clôture renvoie le refus structuré `TRACKING_STATE_CHANGED`, permettant au client de relire son état terminal authentifié. Une annulation, un dossier absent ou un changement de propriétaire restent refusés. `superseded` exige un suivi encore autorisé et un horodatage stocké égal ou supérieur à celui reçu ; un échec sans cette preuve renvoie un conflit. Le traitement normal n’ajoute ni requête ni verrou.

Les tests reproduisent la course par une transaction PostgreSQL réellement validée entre la lecture et l’écriture, côté conducteur et passager. Ils vérifient que l’écriture perdante affecte zéro ligne, ne modifie ni position ni horodatage, n’enregistre aucun historique et ne relance pas la progression. Les tests de non-régression couvrent aussi la suppression, l’annulation, le changement de conducteur et les véritables positions anciennes. Les critères d’acceptation du banc restent inchangés.

### Rejeu après correction GPS

Le scénario `intermediate-scarce` du 22 novembre 2026, de 15 h 03 à 15 h 10 UTC, réussit intégralement avec le budget commun de trois relais. Rapport privé : `tmp/load-results/journeys-2026-11-22T15-03-19-889Z/report.json`.

| Vérification locale | Résultat |
| --- | --- |
| Paliers | 10, 50 et 100 trajets réussis sur deux API |
| Récupérations et déposes automatiques | 100 / 100 pour chacune |
| Demandes avec une première invitation | 160 / 160 |
| Alertes reçues et réception confirmée | 1 454 / 1 454 |
| GPS envoyés et livrés à l’autre participant | 10 418 / 10 418 |
| GPS volontaires après clôture | 2 refusés, état terminal confirmé |
| Première invitation SQL | p95 12,28 s ; maximum 15,57 s |
| Notification créée jusqu’à réception confirmée | p95 519 ms |
| Accusés GPS conducteur et passager | p95 ≤ 20 ms / ≤ 50 ms, bornes des histogrammes |
| Évictions Redis, erreurs SQL et de workers, doublons de conducteur | 0 |

Le délai de première invitation p95 est inférieur d’environ 60 % à la référence de 30,44 s. Ce résultat porte sur ce scénario local, pas sur les délais d’un téléphone réel. Neuf requêtes SQL dépassent 250 ms, avec un maximum de 1,28 s ; l’ancienneté maximale observée des travaux de progression est de 1,51 s et le maximum d’attente du pool est de six par API. Les pics RSS sont de 332 et 325 Mio.

La course de clôture est couverte par les tests déterministes PostgreSQL ; elle ne s’est pas produite spontanément durant ce rejeu (`terminalGps=0`). Les deux sondes explicites après clôture restent comptées séparément des GPS acceptés. Les ressources temporaires ont été nettoyées sans erreur. Aucun changement AWS ni déploiement n’est effectué ; aucun changement de schéma n’est nécessaire. Ce passage à 100 trajets, sous Node 24.11.0 sans quotas Fargate, ne valide pas les 1 000 trajets en production.

Vérification finale : compilation réussie, 159 tests ciblés réussis dans neuf suites Jest (dont dix sur PostgreSQL isolé) et 27 tests du banc réussis. Les seize tests unitaires de concurrence GPS couvrent notamment les refus structurés, la propriété du trajet, les horodatages absents et les véritables positions remplacées. Aucun critère du scénario de charge n’a été assoupli.

### Palier de 250 trajets sous Node 24.22.1

Le 22 novembre 2026, le palier `stage-250` réussit sur deux API locales : 250 trajets maintenus pendant cinq minutes, 250 demandes supplémentaires réparties sur 60 secondes et 250 conducteurs libres supplémentaires. Les 1 500 connexions Socket.IO produisent 100 GPS de participants par seconde, auxquels s'ajoutent environ 8,3 mises à jour de conducteurs libres par seconde. Les nouvelles demandes restent volontairement sans acceptation ; leurs invitations expirent et sont renouvelées.

Le passage utilise le binaire officiel Windows Node 24.22.1, extrait sous `tmp/toolchains` après vérification SHA-256 de l'archive contre `SHASUMS256.txt`. Le Node global et les dépendances n'ont pas été modifiés. La compilation, le chargement des dépendances natives et les 27 tests du banc réussissent avec ce binaire. Le scénario préalable `mixed-smoke` réussit aussi : cinq récupérations et déposes, huit demandes avec offre, quatre acceptations, un refus, deux annulations et neuf conflits de réponses concurrents attendus. Les deux sondes GPS retardées et les deux sondes après clôture sont correctement refusées.

Rapports privés :

- Scénario mixte : `tmp/load-results/journeys-2026-11-22T15-43-44-089Z/report.json`.
- Palier de 250, de 15 h 48 à 15 h 56 UTC : `tmp/load-results/journeys-2026-11-22T15-48-54-456Z/report.json`.

| Vérification du palier de 250 | Résultat |
| --- | --- |
| Récupérations et déposes automatiques | 250 / 250 pour chacune |
| Demandes ayant une première invitation | 250 / 250 |
| Alertes reçues et réception confirmée | 4 250 / 4 250 |
| GPS pendant les cinq minutes de maintien | 30 000, soit 100/s |
| GPS sur l'ensemble du scénario | 34 426 envoyés ; 34 418 livrés ; 8 refusés après clôture avec état terminal récupéré |
| Sondes explicites supplémentaires après clôture | 2 refusées, état terminal confirmé |
| Accusés GPS et livraison à l'autre participant | p95 ≤ 50 ms, bornes des histogrammes |
| Création HTTP des demandes | p95 ≤ 200 ms, borne de l'histogramme |
| Première invitation SQL | p95 44,87 s ; maximum 47,62 s |
| Notification créée jusqu'à réception confirmée | p95 455 ms ; maximum 1,08 s |
| Erreurs SQL, workers et transport Redis ; évictions Redis | 0 |
| Dépassements de vague et doubles invitations simultanées de conducteur observés à la vérification finale | 0 |
| Pic RSS par API | 386 / 391 Mio |
| Attente maximale du pool par API | 12 / 19 |
| Ancienneté maximale observée de la file de progression | 4,04 s ; file vide à la fin |

Les huit refus GPS spontanés après clôture ne sont ni des positions acceptées ni des pertes silencieuses : chaque client a relu son état terminal authentifié. Ils sont distincts des deux sondes explicites. Les ressources jetables des deux essais ont été nettoyées sans erreur ; les rapports et le binaire portable restent locaux, ignorés par Git.

Le délai de première invitation reste le point faible. Jusqu'à 57 demandes sont observées sans offre, avec 500 invitations en attente et aucun conducteur libre enregistré non réservé. Avec des vagues de quatre, une fenêtre de réponse de 40 secondes et aucune réponse des conducteurs dans ce profil, ces observations indiquent une contention sur les candidats réservés. Elles ne prouvent pas la cause de chaque attente. La livraison des alertes et les GPS restent rapides ; aucune requête SQL instrumentée ne dépasse 250 ms. Le volume atteint néanmoins 562 922 requêtes SQL sur les deux API pendant l'essai, à profiler avant d'extrapoler à 1 000 trajets.

Le p95 de 44,87 s n'est pas directement comparable aux 12,28 s du précédent scénario à 100 : les profils, le rythme d'arrivée et la version Node diffèrent. Le succès du palier signifie que ses critères techniques et métier sont respectés, pas qu'un objectif de première offre rapide est atteint. Les comparaisons ci-dessous conservent les mêmes trajets, arrivées et seuils pour examiner le stock de conducteurs et leurs réponses.

Ce passage utilise Windows sur un hôte de 8 processeurs logiques et 15,7 Gio de RAM, sans quotas CPU/RAM Fargate. Les transports externes restent simulés et les déclencheurs financiers hors périmètre. Aucun changement AWS ni déploiement n'a été effectué ; les 1 000 trajets en production, les téléphones en veille et le maintien d'une heure ne sont pas validés.

### Comparaison des conducteurs disponibles et des réponses à 250 trajets

Les deux variantes du 22 novembre 2026, exécutées entre 17 h 04 et 17 h 20 à Kinshasa, réussissent. Elles utilisent le même backend compilé, Node 24.22.1, deux API, 250 trajets pendant cinq minutes, 100 GPS de participants par seconde et 250 demandes réparties sur 60 secondes. Aucun seuil ni comportement du backend n'est modifié. Le profil avec 1 000 conducteurs libres ajoute toutefois 750 sockets et 25 positions de conducteurs par seconde : ce n'est pas une charge totale identique.

| Mesure | 250 libres sans réponse, référence | 1 000 libres sans réponse | 250 libres avec réponses mixtes |
| --- | --- | --- | --- |
| Première invitation SQL, p95 | 44,87 s | 1,44 s | 123 ms |
| Première invitation SQL, maximum | 47,62 s | 11,88 s | 307 ms |
| Notification créée jusqu'à réception confirmée, p95 | 455 ms | 594 ms | 343 ms |
| Accusés GPS et livraison entre participants, p95 borné | ≤ 50 ms | ≤ 100 ms | ≤ 50 ms |
| Maximum observé de demandes sans offre | 57 | 4 | 1 |
| Attente maximale du pool par API | 12 / 19 | 23 / 40 | 7 / 9 |
| Pic RSS par API | 386 / 391 Mio | 400 / 413 Mio | 386 / 381 Mio |
| Ancienneté maximale de la file de progression | 4,04 s | 5,83 s | 2,66 s |
| Requêtes SQL instrumentées sur tout l'essai, préparation comprise | 562 922 | 824 435 | 449 221 |
| Requêtes SQL au-delà de 250 ms | 0 | 24 | 1 |

Chaque variante réussit 250 récupérations et 250 déposes, donne une offre aux 250 demandes et termine avec la file de progression vide. Aucune erreur SQL ou de worker, aucune erreur de transport Redis et aucune éviction ne sont comptées. La variante avec davantage de conducteurs transmet 36 228 GPS à l'autre participant et réconcilie dix refus après clôture ; la variante mixte en transmet 34 504 et réconcilie huit refus. Chacune valide aussi les deux sondes explicites après clôture. Le profil mixte valide les deux positions anciennes refusées avec `superseded`.

Le profil mixte aboutit à 124 acceptations, 41 refus et 61 annulations. Les 316 conflits HTTP 409 correspondent aux réponses concurrentes ; aucune double acceptation gagnante n'est trouvée en base. Au terme de l'essai, 124 demandes ont un conducteur sélectionné, 61 sont annulées et 65 restent en attente. Les décisions automatisées concernent seulement les conducteurs libres, pas les invitations au covoiturage des conducteurs déjà en trajet. Elles sont envoyées sans délai humain artificiel ; ce résultat ne mesure donc pas le temps réel de décision d'un conducteur ni le paiement des nouvelles demandes.

La baisse du délai de première offre, obtenue sans modification du dispatch, renforce l'explication par le stock de candidats et leur réservation pendant la fenêtre de 40 secondes. L'essai ne démontre pas une saturation CPU ou SQL à l'origine des 44,87 secondes. Augmenter uniquement les ressources serveur ne garantit donc pas de supprimer cette attente lorsque les conducteurs ne répondent pas. Le volume SQL et l'attente du pool restent à surveiller au prochain palier.

La variante mixte compte 2 995 invitations et 2 995 alertes observées et confirmées. Avec davantage de conducteurs, 7 469 invitations SQL sont créées, contre 7 416 alertes observées, toutes confirmées. Le banc arrête l'observation des nouvelles alertes avant ses dernières lectures d'état, alors que les workers peuvent encore créer des invitations. Le rapport ne permet pas d'attribuer précisément les 53 invitations restantes à cette fenêtre, à des invitations devenues obsolètes ou à une livraison manquante. Ce succès technique ne constitue donc pas une preuve de livraison exhaustive de toutes les invitations créées ; il faut figer une cohorte horodatée et rapprocher ses états avant une conclusion sur l'absence de pertes.

Rapports privés :

- `tmp/load-results/journeys-2026-11-22T16-04-26-417Z/report.json` pour `stage-250-sufficient`.
- `tmp/load-results/journeys-2026-11-22T16-12-54-297Z/report.json` pour `stage-250-mixed`.

Les 29 tests du banc passent, dont deux nouveaux contrôles vérifiant les paramètres comparables et l'absence d'exécution sans `--execute-local`. Les ressources temporaires sont nettoyées sans erreur. Les modifications portent uniquement sur les profils du banc, leurs tests et ce guide ; aucun déploiement ni changement AWS. Le passage suivant à 500 est décrit ci-dessous. Les limites Windows, absence de quotas Fargate et transports externes simulés restent applicables.

### Palier de 500 arrêté sur l'attente de connexion SQL

Le 22 novembre 2026, de 17 h 35 à 17 h 37 à Kinshasa, `stage-500` connecte les 500 trajets sur deux API locales sous Node 24.22.1, puis s'arrête avant de terminer la première minute d'arrivée des demandes. Le garde-fou détecte un pic de **51 opérations en attente d'une connexion PostgreSQL sur une API**, au-dessus de la limite de 50. Il s'agit de la file du pool applicatif, pas de 51 connexions SQL ouvertes ni d'un refus `max_connections` du serveur. Chaque API dispose de dix connexions dans ce laboratoire.

Le profil prévoit 500 demandes sur 60 secondes, 500 conducteurs libres supplémentaires, jusqu'à 3 000 sockets et 200 GPS de participants par seconde pendant cinq minutes. Seulement 93 demandes sont créées avant l'arrêt : la charge complète, les cinq minutes et les déposes ne sont donc pas validées. Aucun seuil n'est augmenté et le palier 750 n'est pas lancé.

| Observation sur le passage interrompu | Résultat |
| --- | --- |
| Pic d'attente du pool par API | 50 / 51 opérations |
| GPS envoyés et livrés à l'autre participant, montée comprise | 9 230 / 9 230 |
| Accusés et livraison GPS durant la portion de maintien observée | p95 ≤ 300 ms conducteur et ≤ 500 ms passager, bornes des histogrammes |
| Demandes créées / avec une première invitation SQL | 93 / 90 |
| Demandes dont une alerte est observée en temps réel | 80 |
| Alertes observées et confirmées | 314 / 314 |
| Récupérations / déposes au moment de l'arrêt | 339 / 0 ; phase de dépose non atteinte |
| Ancienneté de la file de progression au dernier contrôle | 7,99 s, avec 387 travaux en attente |
| Requêtes SQL instrumentées jusqu'au dernier contrôle | 91 214, préparation comprise |
| Requêtes SQL au-delà de 250 ms | 6 ; maximum 393 ms |
| Pic RSS par API | 423 / 417 Mio |
| Erreurs SQL, workers et transport Redis ; évictions Redis | 0 |

Entre les deux derniers contrôles espacés d'environ cinq secondes, les API comptent 14 091 requêtes SQL, soit environ 2 817/s au total. Leur consommation CPU sur cet intervalle représente respectivement 1,04 et 0,93 cœur logique. L'ancienneté de la file de progression augmente de 4,36 à 7,99 secondes. Ces mesures établissent une pression simultanée sur les processus API, les pools et les travaux de progression ; elles ne permettent pas de répartir la responsabilité entre requêtes répétées, temps CPU applicatif, exécution SQL et acquisition des connexions. Lors de ce premier passage, le banc ne collecte pas encore les familles de requêtes ni le délai d'acquisition du pool. Six requêtes lentes ne suffisent pas à expliquer seules le volume et l'attente.

La prochaine comparaison doit mesurer le nombre et le coût cumulé des requêtes par famille, le temps d'acquisition des connexions et la durée des workers, puis rejouer 500 avec les mêmes seuils après une correction ciblée. Augmenter uniquement la taille des pools déplacerait potentiellement la pression vers PostgreSQL sans établir la cause. Ce passage local interrompu ne fixe pas la capacité maximale d'AWS.

Le banc dispose désormais de `alert-cohort.cjs`. Après le drainage normal, une seule lecture SQL capture les identifiants d'offres déjà validées pendant que l'observation temps réel reste ouverte. Le rapprochement distingue les notifications observées, confirmées, absentes ou non observées, l'obsolescence à la capture et les offres créées après celle-ci. Les identifiants restent en mémoire ; le rapport ne contient que les compteurs. Une invitation non observée n'est jamais assimilée à une livraison réussie. Ce diagnostic ne modifie pas les critères d'arrêt existants.

Les 33 tests du banc réussissent. L'essai préalable de deux trajets valide aussi les requêtes de rapprochement sur PostgreSQL réel : deux récupérations, deux déposes et huit offres capturées, observées et confirmées, sans écart. Le passage à 500 s'arrête avant cette capture normale : ses 360 offres SQL et 314 alertes observées ne permettent pas de conclure à 46 pertes. Le périmètre observé est interrompu alors que des traitements peuvent encore terminer.

Rapports privés :

- Contrôle préalable : `tmp/load-results/journeys-2026-11-22T16-32-10-192Z/report.json`.
- Palier 500 interrompu : `tmp/load-results/journeys-2026-11-22T16-35-20-467Z/report.json`.

Les ressources jetables des deux essais sont nettoyées sans erreur. Le backend métier et son build ne changent pas ; seuls le diagnostic du banc, ses tests et ce guide sont modifiés. Aucun appel AWS, déploiement, changement Terraform, paiement ou notification externe réelle. Les limites Windows sur un hôte partagé, absence de quotas Fargate et services externes simulés restent applicables.

### Profilage SQL du palier de 500

Le rejeu du 22 novembre 2026, de 17 h 52 à 17 h 55 à Kinshasa, confirme le blocage sur l'attente des connexions. Les deux API atteignent des pics de 63 et 66 opérations en attente ; la limite reste à 50 et les pools restent à dix connexions chacun. Le banc s'arrête après 167 demandes créées sur les 500 prévues, sans terminer les cinq minutes ni atteindre les déposes. Les ressources sont nettoyées sans erreur ; aucun changement AWS ou métier n'est appliqué.

Le nouveau diagnostic optionnel `--profile-sql` distingue les familles de requêtes, le contexte des méthodes GPS et workers, la durée d'acquisition du pool et le temps du `QueryRunner` après connexion. Le rapport ne contient ni SQL brut, ni paramètres, ni contenu des erreurs. Les compteurs sont plafonnés à 512 groupes par API et le cache des empreintes à 256 entrées ; aucun débordement n'est observé. L'instrumentation reste désactivée par défaut et n'est pas chargée dans le serveur de production.

Au dernier contrôle, 117 832 appels SQL terminés sont profilés. **62 % de leur temps cumulé est consacré à l'obtention de la connexion**. Ce cumul additionne des appels concurrents : ce n'est ni la durée du scénario ni le temps CPU de PostgreSQL. Les 80 211 acquisitions effectives du pool totalisent 912,3 secondes cumulées, avec un maximum de 220 ms pour une acquisition. Les lectures faites sur une connexion déjà détenue restent distinctes de ces acquisitions.

| Contexte instrumenté | Appels SQL terminés | Part du temps avant obtention de la connexion |
| --- | --- | --- |
| Mise à jour GPS conducteur | 11 261 | 72,9 % |
| Mise à jour GPS passager | 28 127 | 68,0 % |
| Évaluation automatique des récupérations et déposes | 12 820 | 46,2 % |
| Worker des notifications temps réel | 6 620 | 62,3 % |
| Worker des notifications urgentes | 9 816 | 63,5 % |

Les appels hors des méthodes instrumentées figurent sous `unattributed` : 33 426 appels, dont une partie des mises en file de progression, de l'authentification et du dispatch. Les totaux par contexte ne mesurent pas un nombre d'utilisateurs. Les temps après connexion incluent le réseau local, le pilote, ses callbacks et l'ordonnancement Node ; ils ne remplacent pas `pg_stat_statements` ou un plan PostgreSQL.

Les familles et le code indiquent deux réductions concrètes d'allers-retours à examiner en priorité :

1. `BookingsService.updatePassengerLocation` utilise `findOne` avec la relation `trip`. La version TypeORM installée ajoute `take: 1`, puis réalise la pagination des jointures en deux lectures. Le profil retrouve 5 632 appels de chacune de ces deux familles. Une lecture jointe unique, filtrée par la clé primaire et le passager, permettrait d'éviter ce doublon tout en conservant les contrôles d'autorisation et la relecture après conflit GPS.
2. `finishRideProgress` effectue un DELETE conditionnel, puis un UPDATE même lorsque le DELETE a supprimé la tâche. Le profil compte 4 283 appels de chaque famille. Le résultat du DELETE permettrait d'éviter l'UPDATE dans ce cas, en conservant la branche de reprise lorsque de nouvelles positions ont changé la version ou qu'un traitement a échoué.

Les notifications partagent ces mêmes pools avec les GPS et les workers de progression. Le code possède déjà des gardes distincts et des plafonds pour les envois urgents et temps réel. Les appels imbriqués de leurs fonctions ne prouvent pas un dépassement du nombre de workers réellement actifs. Les optimisations de leurs sélections et réservations doivent préserver les contrôles de destinataire, d'expiration et de disponibilité, et l'indépendance du temps réel par rapport au transport push. Aucune de ces modifications métier n'est incluse dans ce passage de diagnostic.

Sur la portion exécutée, les 11 280 GPS sont reçus par l'autre participant et les 567 alertes observées sont confirmées. La file de progression atteint 14,45 secondes ; 413 récupérations sont réalisées et la phase de dépose n'est pas atteinte. Aucun échec SQL ou de worker, aucune erreur Redis ni éviction ne sont comptés. Une requête dépasse 250 ms après acquisition, avec un maximum de 292 ms. Le fait d'aller jusqu'à 167 demandes plutôt que 93 lors du passage précédent n'est pas un gain attribuable à une correction : le backend est inchangé, l'essai est instrumenté et l'ordonnancement varie sur cet hôte partagé.

Le contrôle préalable de deux trajets réussit avec huit alertes rapprochées sans écart. Les 40 tests du banc passent, dont sept sur la conservation des retours et erreurs, l'isolation des contextes concurrents, la séparation des mesures, l'absence de données sensibles et les limites de cardinalité. Le palier 500 reste non validé et le palier 750 n'est pas lancé.

Commande de diagnostic locale avec le binaire conforme au projet :

```powershell
& './tmp/toolchains/node-v24.22.1-win-x64/node.exe' test/load/journeys/run.cjs stage-500 --profile-sql --execute-local
```

Sans `--execute-local`, cette commande affiche seulement le plan. Pour comparer après correction, conserver les mêmes seuils et la même instrumentation, puis confirmer le résultat avec le profilage désactivé.

Rapports privés :

- Contrôle instrumenté : `tmp/load-results/journeys-2026-11-22T16-49-53-338Z/report.json`.
- Rejeu instrumenté interrompu : `tmp/load-results/journeys-2026-11-22T16-52-57-320Z/report.json`.

### Réduction des lectures GPS et des requêtes de finalisation

Les deux corrections issues du profilage sont appliquées localement le 22 novembre 2026. Le nouveau rejeu de 18 h 30 à 18 h 33 à Kinshasa reste **non validé à 500 trajets** : une API atteint 56 opérations en attente de connexion, au-dessus du seuil inchangé de 50. Aucun passage à 750 ni essai sans instrumentation n'est lancé après cet arrêt.

`BookingsService.updatePassengerLocation` charge désormais la réservation et son trajet par une jointure unique, sans pagination. Le filtre SQL conserve l'identifiant du passager sur la lecture initiale et la relecture après une écriture concurrente. Les contrôles de statut, d'horodatage et de propriété restent actifs.

`finishRideProgress` supprime conditionnellement la version traitée et utilise son résultat pour éviter une remise en file inutile. Si une nouvelle position a changé la version, la tâche reste présente et son bail est libéré avec le délai existant. Un échec de traitement conserve le délai de cinq secondes ; un ancien worker ne peut pas supprimer ou libérer le bail de son remplaçant.

| Réduction vérifiée dans le nouveau profil | Résultat |
| --- | --- |
| Lecture réservation et trajet pour les GPS passagers | Une seule famille SELECT, 5 094 appels ; les deux anciennes familles disparaissent |
| Finalisations de progression | 4 248 suppressions conditionnelles et seulement 75 UPDATE de reprise |
| UPDATE de finalisation évités sur ce passage | 4 173, soit 98,2 % des finalisations ; les reprises restent actives |

La lecture initiale passe de deux SELECT à un et le chemin GPS passager courant de cinq requêtes à quatre. Ces réductions portent sur les chemins concernés, pas sur l'ensemble du backend. Les essais s'arrêtent à des charges effectivement exécutées différentes : comparer leurs totaux SQL ou leurs durées ne mesure pas à lui seul un gain global de capacité.

| Observation sur le rejeu interrompu | Résultat |
| --- | --- |
| Pools par API | 10 connexions chacun ; pics d'attente 46 / 56 opérations |
| Demandes créées / avec première offre SQL | 117 / 110, sur 500 prévues |
| GPS envoyés / reçus par l'autre participant | 10 192 / 10 192, montée comprise |
| GPS sur la portion de maintien | 2 816 positions ; accusés et livraison p95 ≤ 300 ms conducteur et ≤ 500 ms passager |
| Alertes observées / confirmées | 398 / 398 |
| Récupérations / déposes | 389 / 0 ; phase de dépose non atteinte |
| File de progression au dernier contrôle | 407 travaux ; ancienneté 9,12 s |
| Appels SQL profilés terminés | 92 914 ; 56,6 % du temps cumulé avant obtention de la connexion |
| Pic mémoire par API | 420 / 413 Mio |
| Erreurs SQL, workers et Redis ; évictions Redis | 0 |

Sur les cinq dernières secondes observées, les API exécutent environ 2 599 requêtes SQL/s. Leur consommation CPU représente respectivement 0,91 et 1,05 cœur logique. L'ancienneté des travaux augmente de 5,43 à 9,12 secondes. Cela établit une pression persistante sur les API, les connexions partagées et la progression, sans isoler le coût CPU propre de PostgreSQL. Les mesures incluent toujours le pilote et l'ordonnancement local. Les 440 offres SQL et 398 alertes observées ne sont pas une mesure de pertes : l'arrêt précède la capture normale de cohorte et le drainage final.

Ces mesures conduisent au regroupement de l'écriture GPS conditionnelle et de sa mise en file durable dans un même aller-retour SQL, décrit dans la section suivante. Le profil montre aussi 5 085 mises à jour de l'interaction du trajet côté passager, en plus des écritures de position conducteur. Leur cadence doit être examinée avant toute modification des règles d'expiration. Les lectures et réservations des notifications partagent les mêmes pools ; leurs contrôles d'éligibilité ne doivent pas être supprimés. Augmenter les pools ou relever les seuils ne constitue pas une correction démontrée.

Vérifications réalisées :

- Compilation avec Node 24.22.1 réussie.
- 103 tests ciblés backend et 11 tests sur PostgreSQL isolé réussis, dont les refus de propriété, les conflits GPS, le nombre réel de requêtes et la conservation des tâches concurrentes.
- 40 tests du banc réussis.
- Contrôle préalable complet : deux récupérations, deux déposes et huit alertes capturées, observées et confirmées sans écart.

Rapports privés :

- Contrôle préalable : `tmp/load-results/journeys-2026-11-22T17-27-31-479Z/report.json`.
- Rejeu après correction : `tmp/load-results/journeys-2026-11-22T17-30-58-562Z/report.json`.

Les ressources jetables sont nettoyées sans erreur. Aucun déploiement, changement AWS ou Terraform, paiement ou notification externe réelle. Aucun changement de schéma n'est nécessaire pour ces deux corrections. Le dernier palier local entièrement validé reste 250 ; ces mesures Windows sur un hôte partagé ne certifient pas la capacité de production.

### Persistance GPS atomique et lectures Redis groupées

Les corrections suivantes sont appliquées localement le 22 novembre 2026, sans modification de schéma ni de configuration AWS.

La mise à jour GPS conditionnelle et l'incrément de la tâche `ride_progress_jobs` utilisent désormais une seule instruction SQL. Un échec de mise en file annule aussi l'écriture de position. Les prédicats de propriétaire, de statut et d'horodatage restent en base ; la réservation vérifie aussi son rattachement au trajet. Une position concurrente conserve la version et le bail nécessaires à la reprise. Les contrôleurs et la passerelle ne remettent plus une seconde fois en file une position déjà enregistrée par ce chemin.

Pour une nouvelle position, hors transitions métier, le chemin conducteur passe de trois à deux allers-retours SQL et le chemin passager de quatre à trois. La lecture d'autorisation et la mise à jour d'interaction du trajet côté passager sont conservées. Les doublons et conflits GPS gardent leur relecture et leur reprise conditionnelle.

Redis regroupe les historiques conducteur, passagers et candidats à l'embarquement avec `MGET`, par lots de 64 clés au maximum. Le résultat est réutilisé uniquement pendant une évaluation, dans un contexte asynchrone isolé ; il ne devient pas un cache d'autorisation partagé entre requêtes. Les historiques restent bornés à dix positions et expirent après six heures. Leur écriture conditionnelle existante empêche un ancien GPS d'écraser un historique plus récent.

L'instruction SQL peut être validée avant l'écriture de l'historique Redis. Le worker vérifie donc que l'historique contient au moins l'horodatage GPS frais chargé depuis PostgreSQL avant de prendre une décision automatique. Un historique absent ou en retard conserve la tâche et provoque une nouvelle tentative après une seconde. Les autres erreurs conservent le délai de cinq secondes. Une coupure Redis ne transforme pas un historique manquant en preuve d'embarquement ou de dépose ; après une éviction, de nouvelles positions sont nécessaires pour reconstituer l'historique perdu.

PostgreSQL reste la source des positions acceptées et des travaux durables. Redis accélère les lectures et les échanges temps réel, sans devenir l'unique détenteur des états métier. La réplication Redis asynchrone peut perdre des écritures pourtant acquittées lors d'une bascule ; elle ne remplace donc pas cette garantie transactionnelle. Voir la [documentation Redis sur la réplication](https://redis.io/docs/latest/manual/replication/).

Vérifications réalisées :

- Compilation avec Node 24.22.1 réussie ; 171 tests ciblés backend, 15 tests PostgreSQL isolés et 40 tests du banc réussis.
- Les tests PostgreSQL injectent un refus d'insertion dans la file et vérifient le retour arrière de la position, pour le conducteur et le passager. Ils couvrent aussi les propriétaires incorrects, les GPS anciens, les états clôturés et le maintien des versions sous bail.
- Les tests Redis vérifient le découpage des lectures, l'isolation des évaluations concurrentes, les erreurs et les historiques absents ou en retard.
- Le scénario `resilience-smoke --profile-sql` réussit de 18 h 57 à 19 h 00 à Kinshasa : deux récupérations, deux déposes, reprise des travaux après redémarrage d'une API et interruption Redis, puis reconnexion de 18 clients. La séquence de panne et reprise prend 10,25 secondes ; la reconnexion, 261 ms.
- Les deux GPS anciens sont ignorés et les deux sondes GPS après clôture sont refusées avec récupération de l'état final. Sur 20 offres capturées, 16 alertes sont observées et confirmées ; les quatre autres sont devenues obsolètes. Aucune alerte non obsolète ne manque dans la cohorte.

Rapport privé du scénario de reprise : `tmp/load-results/journeys-2026-11-22T17-57-32-520Z/report.json`. Les ressources jetables sont nettoyées sans erreur. Ce petit scénario valide la reprise testée, pas la capacité à 500 ou 1 000 trajets ni une panne réelle du cluster AWS.

#### Rejeu de 500 trajets après regroupement

Le rejeu instrumenté de 19 h 01 à 19 h 04 à Kinshasa reste **non validé**. Le seuil de 50 opérations en attente de connexion est dépassé sur une API : pics de 44 et 60, avec dix connexions par API. Le test s'arrête pendant le maintien, avant les déposes ; aucun essai à 750 trajets n'est lancé.

| Observation sur la portion exécutée | Résultat |
| --- | --- |
| Récupérations / déposes | 500 / 0 ; déposes non testées à ce palier |
| GPS envoyés / reçus par l'autre participant | 18 204 / 18 204, montée comprise |
| GPS pendant le maintien partiel | 11 292 ; accusés et livraison p95 ≤ 300 ms pour les deux rôles |
| Demandes créées / avec première offre SQL | 470 / 295, sur 500 prévues |
| Première allocation SQL p95 parmi les 295 demandes servies | 11,65 s ; ne représente pas les 175 demandes encore sans offre |
| Alertes observées / confirmées | 1 239 / 1 239 |
| Ancienneté de la file de progression | Maximum observé 14,55 s ; 3,58 s au dernier contrôle |
| Pic mémoire par API | 435 / 427 Mio |
| Erreurs SQL, workers et Redis pendant la mesure ; évictions Redis | 0 |

Le profil retrouve 9 091 instructions combinant position et mise en file pour chacun des deux rôles. Les mises en file séparées ont disparu de ces chemins : les réductions à deux et trois allers-retours sont effectivement présentes. Les 175 935 appels SQL profilés terminés consacrent encore 58,7 % de leur temps cumulé à l'obtention d'une connexion. Ce temps cumulé inclut des opérations concurrentes et ne mesure pas le CPU de PostgreSQL. Les contextes des notifications urgentes, temps réel et transactionnelles représentent 41 591 appels, soit environ 31 % du temps SQL cumulé. Ils partagent les pools avec le GPS et la progression.

Le nombre de demandes exécutées augmente par rapport au rejeu précédent, mais les durées, transitions métier et travaux accomplis diffèrent. Ce passage ne démontre donc ni un facteur de gain global, ni la capacité à 500 trajets. Les 1 271 offres SQL et 1 239 alertes observées ne permettent pas non plus de calculer une perte : la fermeture normale de la cohorte et son rapprochement n'ont pas été atteints.

Priorités avant le prochain palier : profiler et réduire les sélections, réservations et relectures des notifications sans retirer leurs contrôles métier ; examiner les mises à jour répétées de l'interaction des trajets sans changer implicitement leur expiration ; puis rejouer les mêmes seuils. Déplacer uniquement les états en Redis ou augmenter la taille des pools n'est pas une correction démontrée par ces mesures.

Le nettoyage signale `backend forced stop` pour une API de test : le délai de 12 secondes du lanceur inclut le drainage et les dix secondes d'attente volontaire de `TrackingShutdownService`. Le journal montre le début de cette attente sans sa fin pour cette API ; l'autre termine normalement. Cela ne prouve pas un blocage de production. Redis s'arrête et la base PostgreSQL jetable est supprimée. Le délai de nettoyage du banc devra être distingué des seuils de sécurité en charge lors du prochain passage ; ce rapport conserve l'avertissement.

Rapport privé : `tmp/load-results/journeys-2026-11-22T18-01-42-534Z/report.json`. Aucun déploiement, appel AWS, SMS, paiement ou push externe réel. Le dernier palier local complet reste celui de 250 mesuré avant ces dernières modifications ; 1 000 trajets simultanés restent à démontrer.

### Réservation atomique des notifications transactionnelles

La prise en charge d'un lot de notifications utilise désormais une seule instruction PostgreSQL avec `FOR UPDATE SKIP LOCKED`, mise à jour du bail et retour des lignes réservées dans `src/notifications/transactional-push-queue.ts`. Elle remplace la sélection puis la relecture et les mises à jour ORM dans une transaction explicite. Le commit précède les vérifications métier et tout appel au transport. Aucun changement de schéma n'est nécessaire. Le mécanisme suit les garanties des [instructions avec CTE PostgreSQL](https://www.postgresql.org/docs/current/queries-with.html).

Les voies urgentes et ordinaires restent distinctes, avec les mêmes tailles maximales de lots, ordre d'ancienneté, délais de reprise et exclusions. Chaque notification conserve son identité métier et sa date limite ; une reprise ne renouvelle pas une invitation. Le jeton de réservation empêche un ancien worker de terminer le travail d'un successeur après expiration de son bail.

Les décisions de destinataire, de disponibilité du compte, d'annulation, d'embarquement, de dépose et d'expiration restent relues depuis PostgreSQL avant l'envoi. Elles ne sont pas remplacées par un cache Redis. Le démarrage reste réservé aux passagers ayant une réservation acceptée ; les offres conducteurs gardent leurs contrôles de rôle et de propriétaire. Les reçus, les reprises du transport et la voie temps réel indépendante restent en place.

Vérifications locales de cette modification :

- 461 tests unitaires de notifications et de dispatch réussis ; compilation Node 24.22.1 réussie.
- 68 tests PostgreSQL isolés réussis, dont 24 pour la réservation atomique : concurrence, verrou occupé, retour arrière sur erreur SQL, expiration du bail et changement d'état métier entre réservation et envoi. Les scénarios autorisés émettent vers un faux transport ; les scénarios annulés ou non autorisés sont supprimés de la livraison.
- Les 96 scénarios de relais PostgreSQL et Redis passent avec Node et PostgreSQL alignés en UTC ; trois benchmarks optionnels restent exclus. Un premier lancement avait cinq échecs dus au fuseau UTC imposé seulement à la connexion SQL, avec Node à l'heure de Kinshasa. Le test utilise désormais le fuseau du serveur jetable, déjà aligné sur celui du runner, sans changement des règles d'acceptation ou de partage. Les cinq cas concernés passent aussi après cette correction à l'heure de Kinshasa.
- 44 tests du banc réussis. Son nettoyage accorde désormais 30 secondes aux processus API qu'il a lui-même lancés, puis attend leur sortie après une éventuelle terminaison forcée. Cette terminaison reste signalée comme une erreur. Les seuils de charge, de latence, de file et de mémoire ne changent pas.

Le scénario `resilience-smoke --profile-sql` de 19 h 36 à 19 h 39 à Kinshasa réussit après cette modification : deux récupérations et deux déposes automatiques, reprise après arrêt d'une API et coupure Redis en 10,27 secondes, puis reconnexion des 18 clients en 243 ms. Les 16 alertes observées sont confirmées ; les quatre autres offres de la cohorte sont devenues obsolètes. Aucune alerte encore pertinente ne manque. Les deux GPS anciens sont ignorés et les deux GPS après clôture sont refusés avec récupération de l'état terminal. Le nettoyage ne signale aucune erreur. Rapport privé : `tmp/load-results/journeys-2026-11-22T18-36-20-250Z/report.json`.

### Rejeu de 500 trajets après réservation atomique des notifications

Le passage de 19 h 40 à 19 h 42 à Kinshasa reste **non validé**. Une API atteint 52 opérations en attente de connexion SQL, au-dessus du seuil inchangé de 50 ; l'autre atteint 47. Le test s'arrête pendant le maintien, avant la phase de dépose. La file de progression atteint une ancienneté maximale observée de 10,29 secondes, sous sa limite de 15 secondes. Aucun palier supérieur n'est lancé.

| Observation sur la portion exécutée | Résultat |
| --- | --- |
| Réservations / récupérations / déposes | 500 / 390 / 0 ; scénario interrompu avant les déposes |
| GPS envoyés / livrés à l'autre participant | 10 214 / 10 214, montée comprise |
| GPS pendant le maintien partiel | 3 496 ; accusés et réception p95 ≤ 300 ms conducteur et ≤ 500 ms passager |
| Demandes créées / avec première offre SQL | 147 / 138 |
| Première allocation SQL p95 parmi les 138 servies | 3,04 s ; neuf demandes restent sans offre au relevé final |
| Offres SQL / alertes observées et confirmées | 552 / 495 ; cohorte non clôturée après arrêt anticipé |
| Doublons d'offre par conducteur / acceptations concurrentes gagnantes | 0 / 0 |
| Erreurs SQL, workers et Redis pendant la mesure ; évictions Redis | 0 |
| Pic mémoire par API | 414 / 404 Mio |

Le profil confirme l'utilisation des instructions atomiques : 430 appels dans le contexte urgent et 51 dans le contexte transactionnel ordinaire. Les vérifications métier et les mises à jour de résultat restent visibles dans le profil. Sur 86 042 appels SQL profilés terminés, 55,2 % du temps cumulé est consacré à l'obtention d'une connexion. Le GPS, les évaluations automatiques et les notifications se disputent encore les mêmes pools de dix connexions par API.

Ce passage s'arrête plus tôt que le précédent. Ses nombres de requêtes et ses percentiles ne démontrent donc pas un gain global de débit ou de délai. L'écart entre offres et alertes ne démontre pas non plus une perte : leur rapprochement normal n'a pas été atteint. La réservation SQL est simplifiée et les régressions métier testées, mais la capacité à 500 puis 1 000 trajets reste à établir. La prochaine optimisation doit réduire la contention entre travaux de fond et opérations interactives, sans supprimer les relectures d'autorisation ni allonger implicitement les échéances des alertes.

Rapport privé : `tmp/load-results/journeys-2026-11-22T18-40-11-524Z/report.json`. Le nettoyage est complet, sans arrêt forcé ni erreur ; la base jetable est supprimée. Aucun déploiement AWS ni envoi réel de push, SMS ou paiement.

### Regroupement des réveils GPS et préparation des sonneries

Le worker de progression regroupe les libérations de places sur un même tour de boucle Node avant de réserver le lot suivant. Il garde quatre traitements simultanés, ne réserve que les places disponibles et ne conserve pas de lot supplémentaire en mémoire. Une libération survenue pendant une réservation SQL déclenche une nouvelle lecture après celle-ci ; elle n'attend plus le cron suivant. L'arrêt du module annule le réveil programmé et attend les travaux déjà réservés.

La préparation des sonneries utilise une seule instruction `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` pour créer ou verrouiller l'état du conducteur et lire son horloge. Elle remplace deux requêtes, voire trois pour un ancien état de pénalité. Le cycle existant reste inchangé, comme les vérifications métier, refus, reçus et échéances. L'instruction ajoute une mise à jour de la petite ligne d'état lors d'un conflit ; il ne s'agit pas d'un cache d'autorisation ni d'une suppression des écritures d'audit. Le comportement atomique est décrit dans la [documentation PostgreSQL 18](https://www.postgresql.org/docs/18/sql-insert.html#SQL-ON-CONFLICT).

Les écritures GPS passager et de rafraîchissement du trajet restent séparées : leur fusion nécessite une revue de l'ordre des verrous avec les transactions de réservation et de clôture. Aucun pool SQL, seuil d'arrêt, délai d'alerte ou paramètre AWS n'est augmenté pour ces optimisations.

Validation locale du 22 novembre 2026, après ces deux changements :

- 509 tests de notifications, dispatch et tracking réussis, dont quatre nouveaux cas de réveil concurrent, regroupement, arrêt et reprise après erreur SQL.
- 47 tests PostgreSQL isolés réussis, dont trois nouveaux cas de préparation de sonnerie : une seule requête d'état, huit préparations simultanées sans doublon et retour arrière si l'événement ne peut pas être enregistré.
- 47 tests du banc réussis après ajout du diagnostic d'admission, et compilation Node 24.22.1 réussie.
- Scénario de résilience de 20 h 11 à 20 h 14 à Kinshasa réussi : deux récupérations, deux déposes, reprise après arrêt d'une API et coupure Redis en 10,38 secondes, reconnexion des 18 clients en 302 ms. Les 16 alertes observées sont confirmées ; quatre offres non observées sont devenues obsolètes, aucune encore pertinente ne manque dans la cohorte. Les deux anciens GPS restent ignorés, les deux GPS après clôture refusés avec récupération d'état.

Rapport privé du scénario de résilience : `tmp/load-results/journeys-2026-11-22T19-11-15-411Z/report.json`. Le nettoyage se termine sans erreur et supprime la base jetable. Ces contrôles ne mesurent pas la livraison FCM/APNs sur téléphone ni la capacité AWS.

### Arrêt du générateur au palier de 500

Le rejeu de 20 h 15 à 20 h 18 à Kinshasa s'arrête pendant le maintien : le générateur atteint sa limite de 128 opérations simultanées. Les derniers relevés disponibles montrent des pics de 38 et 44 attentes de connexion SQL, sous le seuil de 50, et une ancienneté maximale de file observée de 8,70 secondes, sous le seuil de 15. Ces relevés espacés de cinq secondes ne décrivent pas nécessairement l'instant exact de l'arrêt.

Les 500 embarquements ont réussi. Sur 443 demandes créées, 297 disposent d'une première offre SQL, avec un p95 de 8,66 secondes parmi ces seules demandes servies ; 146 restent sans offre au relevé final. Les 1 196 alertes observées sont confirmées, mais la cohorte n'est pas clôturée et les déposes n'ont pas été exécutées. Le palier reste non validé. Aucune erreur SQL, worker ou Redis ni éviction n'est signalée dans les relevés. Le temps cumulé d'acquisition des connexions représente encore 49,9 % des durées SQL profilées, sans démontrer à lui seul la cause du plafond générateur.

Le compteur historique affichait 17 566 GPS envoyés et 17 564 reçus par l'autre participant. Le banc incrémentait la paire avant d'en admettre les deux opérations ; un arrêt entre elles pouvait donc comptabiliser un envoi non effectué. Désormais, l'admission de la paire est atomique avant toute modification des compteurs. Le plafond reste 128. Le rapport conserve également, au premier refus d'admission, les types, nombres et anciennetés des opérations encore actives, sans identifiants ni données personnelles. Trois tests couvrent ce comportement.

Rapport privé de ce rejeu : `tmp/load-results/journeys-2026-11-22T19-15-27-725Z/report.json`. Le nettoyage se termine sans erreur. Aucun gain global de capacité n'est déduit de passages interrompus à des moments différents.

### Dernier rejeu de 500 avec diagnostic d'admission

Le passage de 20 h 21 à 20 h 23 à Kinshasa s'arrête sur le garde-fou SQL : une API atteint 58 opérations en attente de connexion pour une limite de 50 ; l'autre atteint 32. Le générateur n'atteint que 89 opérations simultanées sur 128. Aucun refus d'admission n'étant survenu, ce passage ne permet pas d'expliquer la répartition au plafond du rejeu précédent.

| Mesure à l'arrêt anticipé | Résultat |
| --- | --- |
| Réservations / embarquements / déposes | 500 / 413 / 0 ; arrêt avant la phase de dépose |
| GPS envoyés et livrés à l'autre participant | 10 192 / 10 192 |
| GPS pendant le maintien partiel | 1 738 par rôle ; accusés et réception p95 ≤ 200 ms conducteur, ≤ 300 ms passager |
| Demandes créées / avec première offre SQL | 146 / 146 ; les 500 demandes prévues n'ont pas toutes été émises |
| Première allocation SQL p95 sur ces 146 demandes | 388 ms |
| Offres / alertes observées / reçus confirmés | 584 / 546 / 546 ; cohorte non clôturée |
| Ancienneté maximale observée de la file de progression | 6,76 s |
| Erreurs SQL, workers, Redis et évictions observées | 0 |
| Doublons d'offres, doubles acceptations et violations de vagues | 0 |
| Pic mémoire par API | 405 / 402 Mio |

L'obtention d'une connexion représente 46,0 % du temps cumulé des 89 357 requêtes profilées terminées. Les mises à jour GPS passager et conducteur totalisent 25 450 de ces appels ; la file urgente en totalise 7 178 et la voie temps réel 5 878. Trois requêtes dépassent 250 ms dans la mesure applicative, avec un maximum de 289 ms. Ces durées comprennent l'attente et le transport ; elles ne sont pas une mesure du CPU PostgreSQL.

Le palier reste **non validé**, sans lancement de 750 ou 1 000 trajets. La suite consiste à réduire les allers-retours du tracking et à borner l'admission des travaux de fond face aux opérations interactives, en vérifiant l'ordre des verrous et l'âge des files. Il ne faut ni mettre en cache les autorisations d'alerte, ni masquer l'attente en relevant simplement les seuils. Les variations entre ces passages courts sur une machine partagée empêchent d'attribuer les différences de percentiles aux seuls correctifs.

Rapport privé : `tmp/load-results/journeys-2026-11-22T19-21-22-544Z/report.json`. Nettoyage complet, sans erreur, base jetable supprimée ; aucune modification AWS ni notification externe réelle.

### Optimiser Redis sans ralentir le suivi

La cadence GPS du banc reste de cinq secondes par conducteur et passager : 500 trajets génèrent 200 mises à jour par seconde, 1 000 en génèrent 400. Ces valeurs décrivent le scénario synthétique, pas une mesure de la cadence des téléphones en production. Aucun intervalle mobile ou WebSocket n'est modifié.

L'écriture de l'historique Redis passe d'une lecture suivie d'un compare-and-set, éventuellement répétés trois fois, à une fusion atomique sur une seule clé. Après chargement du script, chaque position nécessite un `EVALSHA` : **un aller-retour réseau au lieu de deux au minimum pour cette écriture**, sans annoncer une baisse de 50 % de toute la charge Redis ou SQL. Le serveur exécute toujours une lecture, la fusion et une écriture. La première utilisation ou la perte du cache de scripts nécessite un second appel `EVAL` après `NOSCRIPT`. Un timeout, une déconnexion ou un refus mémoire ne provoque pas de répétition aveugle.

Le module `src/common/services/location-history-store.ts` conserve les dix derniers points utiles, les métadonnées GPS, la durée de conservation de six heures et les règles existantes de fusion des relevés natifs. Une position ancienne ne remplace jamais la plus récente et ne prolonge pas sa conservation. Les doublons proches ne suppriment pas le précédent point de mouvement. Les écritures concurrentes ne dépendent plus de trois tentatives côté API pour conserver la position la plus récente.

Les garanties suivantes restent inchangées :

- PostgreSQL vérifie le propriétaire et l'état métier et enregistre chaque nouvelle position acceptée avec le travail de progression durable. Redis ne devient pas la seule source de vérité.
- La diffusion temps réel ne regroupe ni ne retarde les positions pour économiser des commandes. Les contrôles de récupération, dépose, proximité et notification restent actifs.
- La lecture groupée des historiques reste limitée à une évaluation de progression ; elle ne constitue pas un cache d'autorisation partagé entre requêtes.
- Si l'historique Redis manque ou retarde sur la position SQL, la progression automatique attend une reprise avec un historique à jour. Elle ne conclut pas un embarquement ou une dépose à partir d'une absence de données.
- Les notifications conservent leur file SQL, leurs destinataires, leurs reçus, leurs échéances et leurs revalidations métier.

Le chemin SQL courant conserve deux appels par position conducteur et trois par position passager. Avec un conducteur et un passager toutes les cinq secondes, cela représente environ 500 appels SQL par seconde pour 500 trajets, hors progression, sessions, notifications et demandes. Ce calcul de débit ne remplace pas un profil mesuré. L'optimisation Redis ne résout donc pas à elle seule les attentes de connexions du dernier test à 500 : la réduction des lectures SQL redondantes et l'admission des travaux de fond restent à traiter, sans cache d'autorisation ni relèvement artificiel des seuils.

Validation locale du 22 novembre 2026 : compilation réussie, 540 tests unitaires ciblés réussis et 11 tests supplémentaires sur Redis jetable. Ces derniers comparent 80 mises à jour à l'ancien algorithme, exercent 100 écritures sur deux connexions, le changement de jour/année et l'année bissextile, les relevés natifs invalides, la perte du cache de scripts et le report des décisions sur historique incomplet. Commande dédiée :

```bash
node test/run-location-history-redis.cjs
```

Le lanceur utilise un port local aléatoire, un mot de passe éphémère et un Redis sans persistance, puis l'arrête. Il ne charge pas `.env` et ne touche ni une base existante ni AWS.

Le scénario `resilience-smoke`, de 20 h 42 à 20 h 45 à Kinshasa, passe également avec ce code : deux récupérations et deux déposes automatiques, 16 alertes observées et confirmées, quatre offres non observées devenues obsolètes et aucune encore pertinente manquante. Les deux anciens GPS restent ignorés, les deux positions après clôture sont refusées avec récupération d'état. Après l'arrêt d'une API et la coupure Redis simulée, la reprise prend 10,22 secondes et la file se vide ; les 18 clients se reconnectent en 292 ms. La coupure produit les erreurs de transport Redis attendues ; les compteurs SQL et workers restent à zéro, sans éviction. Rapport privé : `tmp/load-results/journeys-2026-11-22T19-42-04-396Z/report.json`. Nettoyage sans erreur, base jetable supprimée. Ces contrôles n'incluent pas de livraison FCM/APNs réelle et ne valident pas la capacité de 500 ou 1 000 trajets.

## Alléger les accès SQL du suivi

Les lectures GPS utilisent désormais une projection dédiée dans `src/tracking/tracking-read-columns.ts` : sept colonnes du trajet côté conducteur, seize colonnes de réservation et quatre du trajet côté passager. Elles conservent le propriétaire, les états, les coordonnées, les horodatages et les indicateurs nécessaires aux alertes de proximité. Le contrôle SQL reste effectué à chaque position et après un échec d'écriture conditionnelle. Ces objets partiels ne doivent jamais servir à une sauvegarde d'entité, à un paiement ou à une réponse complète de trajet.

L'enregistrement d'une alerte automatique de récupération, dépose ou proximité ne contient qu'une insertion dans la file SQL. Cette insertion atomique remplace l'enchaînement explicite `BEGIN`, `INSERT`, `COMMIT`, soit deux commandes évitées par tentative d'enregistrement de ces alertes. La clé stable conserve la déduplication, l'appel attend la persistance et le worker vérifie toujours l'état et le destinataire avant livraison. Si un gestionnaire de transaction métier est fourni, l'insertion reste dans cette transaction et disparaît avec son annulation. Les transactions de paiement, de changement d'état et de délai entre notifications ne sont pas supprimées.

Ces changements ne réduisent ni la cadence GPS ni le nombre de positions persistées. Le nombre d'appels SQL courant par position reste de deux côté conducteur et trois côté passager ; la projection réduit surtout les données transférées et transformées en objets. L'écriture séparée de la date d'interaction du trajet reste conservée : la fusionner sans examiner l'ordre des verrous entre trajet, réservation et file de progression pourrait introduire un interblocage.

Validation du 22 novembre 2026 : compilation réussie, 654 tests unitaires ciblés et 18 tests sur PostgreSQL/PostGIS jetable réussis. Les tests vérifient une seule instruction pour l'alerte, huit répétitions concurrentes sans doublon, le refus en cas d'échec de persistance, l'invisibilité avant validation d'une transaction métier et son annulation. Les simulations unitaires de récupération et dépose utilisent maintenant l'interface Redis à script, avec l'algorithme de référence indépendant comme doublure.

Le scénario `resilience-smoke` passe de 21 h 07 à 21 h 11 à Kinshasa : deux récupérations et deux déposes, 16 alertes observées et confirmées, quatre offres devenues obsolètes et aucune offre encore pertinente manquante. La reprise après panne API et coupure Redis prend 10,33 secondes, avec file vidée ; les 18 clients se reconnectent en 226 ms. Les deux GPS anciens sont ignorés et les deux positions après clôture sont refusées avec récupération d'état. Aucune erreur SQL ou worker, aucune éviction ; les erreurs de transport Redis correspondent à la coupure injectée. Base jetable supprimée sans erreur. Rapport privé : `tmp/load-results/journeys-2026-11-22T20-07-45-284Z/report.json`.

### Le palier 500 reste limité par les connexions SQL

La relance de 21 h 12 à 21 h 15 à Kinshasa s'arrête automatiquement pendant la phase soutenue : pic de 68 attentes de connexion sur une API, contre une limite de 50 (45 sur l'autre API). La file de progression contient 324 travaux, avec 13,30 secondes d'ancienneté maximale. Les seuils sont inchangés, avec dix connexions SQL par API et un relevé GPS conducteur/passager toutes les cinq secondes.

Avant l'arrêt, les 12 188 positions émises sont diffusées aux pairs. Les bornes p95 des accusés et des diffusions sont de 200 ms côté conducteur et 300 ms côté passager. Sur 500 réservations, 451 récupérations sont enregistrées ; aucune dépose n'est testée car le scénario s'arrête avant cette phase. Sur les 500 demandes prévues, seules 205 sont lancées, dont 198 ont une offre. Ces observations partielles ne valident pas le palier.

Le profil contient 104 663 commandes SQL ; l'acquisition de connexion représente 58,9 % de leur temps cumulé mesuré côté client, et non une mesure de CPU PostgreSQL. Les 1 627 insertions d'alertes de progression n'ont plus de `START`/`COMMIT` explicites dans ce contexte. Les écritures GPS, les lectures d'utilisateurs et les trois voies de traitement des notifications restent coûteuses. Une part importante du SQL n'est pas encore attribuée à une méthode : elle doit être instrumentée avant de conclure quel traitement doit être limité. La prochaine expérimentation doit examiner la concurrence de ces workers et les lectures répétées, en conservant la revalidation des destinataires et une borne de délai pour les alertes.

Aucune erreur SQL, erreur worker, erreur de transport Redis ou éviction pendant ce palier. Aucun doublon d'offre conducteur ni dépassement de vague détecté. Le nettoyage termine sans erreur et supprime la base jetable. Rapport privé : `tmp/load-results/journeys-2026-11-22T20-12-34-548Z/report.json`. Pas de passage à 750, de modification AWS ni de validation de capacité de production. Les API tournent ici comme processus Windows, sans limites CPU/RAM Fargate appliquées ; comparer ces durées à un autre essai interrompu ne suffit pas à quantifier un gain de capacité.

## Borner la préparation SQL des notifications

La préparation initiale des notifications en file dispose de trois voies indépendantes par instance API : deux préparations urgentes, une ordinaire et deux temps réel. Les workers existants bornent le nombre de travaux en attente. Les appels HTTP au fournisseur push ne retiennent pas ces places ; les envois directs hors file ne passent pas par cette limitation. Ce mécanisme n'est donc pas un plafond global de toutes les requêtes SQL de notification.

La revalidation du destinataire et de l'état métier intervient après l'attente d'une place. Les contrôles d'appartenance du token, les échéances originales, les réservations durables des notifications et leur renouvellement restent actifs. Le contrôle de pertinence des alertes automatiques n'est plus exécuté deux fois dans la même tentative ; il reste renouvelé à chaque tentative. La préparation d'une sonnerie utilise le résultat `RETURNING` de l'insertion conditionnelle et ne relit l'événement que lorsque le conflit n'a rien modifié. Les transactions métier restent conservées, conformément au guide PostgreSQL ; aucun cache d'autorisation ni ralentissement de la cadence GPS n'est introduit.

Validation du 22 novembre : compilation, 658 tests unitaires ciblés, 41 tests sur PostgreSQL jetable et 47 tests du banc réussis. Le test `resilience-smoke` de 21 h 31 à 21 h 35 à Kinshasa confirme deux récupérations, deux déposes, 16 alertes observées et confirmées et quatre offres devenues obsolètes. Reprise en 10,25 secondes, reconnexion des 18 clients en 245 ms, file vidée, anciennes positions ignorées et positions après clôture refusées. Rapport privé : `tmp/load-results/journeys-2026-11-22T20-31-43-773Z/report.json`.

### Le palier 500 atteint la limite de cadence du générateur

Le test du 22 novembre de 21 h 36 à 21 h 42 à Kinshasa s'arrête sur `Generator schedule lag; throughput not achieved`, avant la phase de dépose. Les pics d'attente SQL sont de 47 et 44, sous le seuil inchangé de 50. Les 53 222 positions émises sont diffusées aux pairs ; la borne p95 GPS est de 200 ms des deux côtés. Les 500 récupérations sont enregistrées et les 500 demandes reçoivent au moins une offre. Aucune erreur SQL, worker ou Redis, aucune éviction ; la dernière file de progression contient 42 travaux, dont le plus ancien attend 0,38 seconde. Le nettoyage supprime la base jetable sans erreur. **Le palier n'est pas validé et aucun passage à 750 n'est engagé.**

Le temps d'attribution de la première offre reste élevé : p95 de 81,74 secondes, distinct du délai entre création d'une notification et confirmation de réception, dont le p95 est de 2,78 secondes. Le scénario `ignore` maintient les invitations jusqu'à leur échéance. Un relevé montre 153 demandes sans première offre, 1 000 offres en attente et aucun conducteur enregistré non réservé. Cette saturation des candidats contribue à l'attente ; elle ne permet pas d'attribuer tout le délai à la préparation des notifications. Il faudra comparer un scénario où les conducteurs acceptent ou refusent, puis un stock de candidats suffisant, sans modifier simultanément les seuils ou la cadence.

Le profil contient 589 829 commandes SQL, dont 110 109 dans `SequentialDispatchService.advance`. L'acquisition des connexions représente 31,5 % du temps SQL cumulé côté client ; ce n'est pas une mesure CPU PostgreSQL ni une amélioration de capacité certifiée par comparaison avec un essai plus court. Rapport privé : `tmp/load-results/journeys-2026-11-22T20-36-19-852Z/report.json`.

### Mesurer précisément un arrêt du générateur

Le banc précédent ne conservait que le retard des GPS admis : son maximum affiché de 304 ms excluait l'opération dépassant la limite de 1 000 ms. Depuis le 23 novembre, le rapport conserve aussi la catégorie de travail rejeté et son retard exact, sans identifiant, ainsi que le temps des relevés de santé et des écritures de rapport. L'historique conserve les totaux SQL et tous les indicateurs de sécurité, tandis que `lastHealth` garde le profil détaillé le plus récent. Il ne répète plus chaque famille SQL à chaque relevé.

Sur le rapport précédent, cette suppression des répétitions réduit la taille sérialisée de 9 918 983 à 291 087 octets. Dix sérialisations hors charge prennent environ 29,45 ms en moyenne avant et 0,90 ms après. Cela ne prouve pas que l'écriture du rapport causait à elle seule le dépassement d'une seconde. Les seuils d'arrêt et le contrôle de cadence restent identiques ; les 50 tests du banc passent après ces changements.

### La relance du 23 novembre échoue pendant la montée en charge

Le test de 6 h 54 à 7 h 00 à Kinshasa s'arrête avant la phase soutenue et avant les demandes supplémentaires, sur le plafond inchangé de 128 opérations en cours. Au refus, les 128 opérations sont 64 paires GPS conducteur/passager et la plus ancienne n'a que 1,22 ms. Le retard GPS maximal enregistré est de 804,28 ms. Cette photographie montre une rafale d'admission après un retard du générateur, pas une file composée d'appels anciens. Elle ne détermine pas l'origine de la pause : ordonnancement de l'hôte, travail du processus et collecte mémoire restent à distinguer.

Le dernier relevé couvre 482 trajets connectés pendant la montée : pics d'attente SQL de 1 et 2, aucune erreur SQL ou worker, 33 travaux de progression et 0,23 seconde d'ancienneté maximale. Sur l'ensemble de cet essai interrompu, 6 696 GPS obtiennent un accusé positif ; 6 687 diffusions sont observées avant la fermeture. Le p95 des accusés est borné à 100 ms et celui des diffusions à 200 ms. Les 269 récupérations enregistrées ne valident ni les 500 récupérations ni les déposes.

Les relevés de santé prennent au maximum 142,24 ms et les écritures de rapport 3,51 ms. Le rapport final occupe 96 849 octets ; le coût de sa sauvegarde ne suffit pas à expliquer les 804 ms de retard observés. Nettoyage sans erreur et base jetable supprimée. Rapport privé : `tmp/load-results/journeys-2026-11-23T05-54-36-651Z/report.json`. La compilation réussit ; aucun changement AWS, aucune modification de la cadence mobile et aucun passage à 750.

Les vérifications du 23 novembre passent : 658 tests unitaires ciblés, 41 tests PostgreSQL sur clusters jetables et 50 tests du banc, soit 749 tests. Ces tests de non-régression ne remplacent pas la réussite du scénario de charge complet.

La prochaine comparaison doit isoler les pauses du générateur, idéalement sur un hôte distinct des API et des services de données, avant toute augmentation de palier. Le plafond de concurrence, la limite de retard et les contrôles de latence restent des conditions de réussite. En parallèle, le délai de première offre doit être mesuré avec des réponses de conducteurs et un stock de candidats suffisants ; le scénario sans réponse ne représente pas à lui seul ce parcours utilisateur.

### Distinguer une pause du générateur et une attente du backend

Le générateur conserve désormais des observations bornées de son propre processus : retard de boucle et de minuterie, utilisation CPU, utilisation de la boucle Node, mémoire RSS et tas, mémoire libre de l'hôte et événements de ramasse-miettes. Un échantillon est pris toutes les 250 ms ; les douze incidents les plus longs de chaque catégorie sont conservés. Les intervalles entre itérations du scénario sont rapprochés des collectes de santé, écritures de rapport et événements GC qui les recouvrent. Aucun identifiant, token, contenu HTTP ou profil CPU non borné n'est enregistré.

Ces mesures distinguent un arrêt de la boucle du processus d'une attente asynchrone de collecte. Un recouvrement GC ou un pic CPU ne prouve pas à lui seul la cause de la pause ; le CPU du processus et l'utilisation de la boucle sont deux mesures différentes. Les événements conservés ne représentent pas tout le temps de pause GC. Les observations sont figées avant le nettoyage des sockets et de la base. Les API de mesure sont celles de [Node.js 24](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html).

Le profil `stage-500-mixed` conserve les 500 trajets, 500 demandes, 500 conducteurs disponibles, deux API, 3 000 sockets prévus et 200 positions GPS par seconde du profil `stage-500`. Seul le comportement face aux offres change : acceptation, premier refus puis acceptation, absence de réponse ou annulation par le passager. Les réponses concurrentes en conflit sont comptées séparément. Ce scénario doit encore satisfaire les contrôles de cadence, de latence, de destinataire et de clôture ; aucun seuil n'est relevé.

```bash
node test/load/journeys/run.cjs mixed-smoke --execute-local --profile-sql
node test/load/journeys/run.cjs stage-500-mixed --execute-local --profile-sql
```

Le second lancement ne doit suivre qu'un scénario court réussi et des ressources locales suffisantes. Sans `--execute-local`, ces commandes ne font que décrire le plan. Les 59 tests du banc passent après l'ajout des observations, des jalons de démarrage, du profil mixte à 500 et de l'attente coopérative décrite ci-dessous.

Chaque API locale écrit six jalons de démarrage numériques : chargement des dépendances, initialisation PostgreSQL, préparation Nest, connexion Redis, écoute HTTP et disponibilité. Ils permettent de localiser un prochain dépassement du délai de 120 secondes sans afficher de configuration. Le premier essai mixte à 500 du 23 novembre, de 7 h 24 à 7 h 28 à Kinshasa, s'est arrêté sur ce délai avant toute charge ; la base jetable a été supprimée sans erreur. Ce rapport (`tmp/load-results/journeys-2026-11-23T06-24-31-943Z/report.json`) ne renseigne pas la capacité des trajets.

Le scénario court exécuté juste avant, de 7 h 20 à 7 h 23, passe avec cinq récupérations et cinq déposes automatiques, 302 positions diffusées pour 302 envoyées et une borne p95 de 50 ms pour les accusés et diffusions GPS. Les huit demandes reçoivent une offre ; quatre acceptations, deux refus et deux annulations sont exercés, ainsi que l'absence de réponse et dix conflits concurrents. La cohorte contient 55 alertes observées et confirmées, une offre devenue obsolète et aucune alerte encore pertinente manquante. Aucune erreur SQL ou worker ni éviction Redis. Rapport privé : `tmp/load-results/journeys-2026-11-23T06-20-10-261Z/report.json`. Nettoyage sans erreur.

### Continuer le GPS pendant la préparation des présences

La relance de 7 h 31 à 7 h 33 le 23 novembre démarre les deux API en 10,46 et 9,31 secondes. Elle s'arrête à nouveau au plafond de 128 opérations, juste après la connexion des 500 trajets et avant toute demande supplémentaire. Les 64 paires GPS en cours ont au plus 1,08 ms au moment du refus. L'intervalle maximal entre itérations est de 896,79 ms, alors que le retard maximal de minuterie est de 16,23 ms, celui de la boucle Node de 53,90 ms et le plus long événement GC de 13,83 ms. Aucun relevé de santé ne recouvre cet intervalle ; le plus long prend 252,41 ms à un autre moment. La sauvegarde prend au plus 3,05 ms. Ces observations orientent vers une attente asynchrone du scénario, pas une pause globale de Node de 897 ms.

Le code attendait les activations de présence via HTTP avant de reprendre le GPS, avec un passage dans le planificateur seulement toutes les quatre activations. Cette préparation peut donc accumuler des émissions échues, même si Node reste disponible. `cooperative-wait.cjs` maintient désormais le planificateur ouvert pendant cette attente. Les présences restent séquentielles, leurs requêtes HTTP restent bornées à cinq secondes et leur place est comptée dans le plafond inchangé de 128 opérations. Le banc conserve les échéances GPS, le nombre de positions et tous les contrôles d'arrêt ; il ne masque pas le retard en décalant les prochaines émissions. La durée de préparation est enregistrée séparément dans `generator_presence`.

L'essai interrompu ne valide pas 500 trajets : 279 récupérations, aucune dépose et aucune nouvelle demande exercée. Les 6 892 GPS obtiennent un accusé positif ; 6 885 diffusions sont observées avant fermeture, sans conclusion de perte serveur pour les sept restantes. Pics d'attente SQL de 1 et 4, aucune erreur SQL, worker ou Redis, 51 travaux de progression dont le plus ancien attend 0,52 seconde. Rapport privé : `tmp/load-results/journeys-2026-11-23T06-31-01-111Z/report.json`. Nettoyage complet sans erreur. Aucun changement de l'application mobile, de la logique d'alerte ou d'AWS.

Après correction, le scénario court de 7 h 37 à 7 h 40 passe : cinq récupérations, cinq déposes, 304 GPS envoyés et diffusés, huit demandes avec offre, 55 alertes confirmées, une offre obsolète et aucune alerte pertinente manquante. Les 24 activations de présence prennent jusqu'à 264 ms chacune, sans suspendre le GPS ; le retard GPS maximal reste de 20,68 ms. Les cas d'acceptation, refus, annulation et absence de réponse passent. Rapport privé : `tmp/load-results/journeys-2026-11-23T06-37-17-130Z/report.json`. Nettoyage complet sans erreur ; ce petit scénario ne certifie pas le palier 500.

### Le palier 500 après correction du générateur

La relance de 7 h 42 à 7 h 45 le 23 novembre atteint les 500 trajets connectés, mais s'arrête pendant les premières activations de présence, avant les 500 nouvelles demandes. Le retard GPS maximal est de 42,64 ms, contre 873,20 ms lors du passage précédent. Le plus grand intervalle entre itérations est de 154,19 ms et recouvre une collecte de santé de 139,19 ms. La longue interruption d'émission de près de 900 ms n'est plus observée.

Le plafond inchangé de 128 opérations reste atteint, mais sa composition change : une présence en cours depuis 888 ms, 66 opérations GPS passager dont la plus ancienne attend 631 ms, et 61 GPS conducteur dont le plus ancien attend 584 ms. Ce ne sont plus 64 paires réservées dans la même milliseconde ; les appels s'accumulent en attendant les réponses. Les 7 068 positions envoyées donnent 7 067 accusés positifs et autant de diffusions observées. Une opération conducteur échoue après environ cinq secondes. Les bornes p95 des accusés et diffusions restent de 200 ms, mais ce percentile n'annule pas l'échec du plafond et l'opération manquante.

Le dernier relevé, à 7 h 44 min 59 s, montre des pics d'attente SQL de 14 et 11, aucune erreur SQL, worker ou transport Redis et aucune éviction. Il ne couvre pas intégralement les dernières secondes avant l'arrêt. La file de progression contient 128 travaux et son plus ancien attend 1,33 seconde. Les 291 récupérations enregistrées, sans dépose et sans nouvelle demande, ne valident pas le scénario complet ni les délais de première offre à 500.

Ce relevé contient 38 406 commandes SQL ; l'acquisition d'une connexion représente 7,5 % de leur durée cumulée côté client. Les trois contextes les plus coûteux sont `updatePassengerLocation`, `evaluateAutomaticRideProgressForTrip` et `updateDriverLocation`, soit environ 71,8 % de cette durée cumulée. Ces chiffres incluent transport et attente et ne mesurent pas le CPU PostgreSQL. Il faut maintenant détailler le parcours `setPresence` et les GPS pendant cette transition, puis capturer les compteurs au moment de l'arrêt, avant de décider d'une optimisation serveur. Augmenter le plafond du générateur ou attribuer la totalité du problème aux notifications masquerait le diagnostic restant.

Rapport privé : `tmp/load-results/journeys-2026-11-23T06-42-32-573Z/report.json`. Nettoyage complet sans erreur. **500, 750 et 1 000 trajets ne sont pas validés par cette relance.** Aucun seuil relevé, aucune modification AWS et aucune livraison push/SMS réelle.

### Capturer la saturation avant la vidange des opérations

Le banc capture désormais les mesures dès le premier échec du scénario, avant d'attendre les opérations en cours. Une seconde capture après leur vidange montre la récupération éventuelle ; elle ne remplace pas la première et ne peut pas rendre le test réussi. Chaque capture indique sa demande, sa fin et sa durée. Un échec ou un dépassement de délai de collecte reste explicite sans masquer l'erreur initiale. Les trois nouveaux tests portent sur la capture unique, l'absence de fuite du message d'erreur et le délai borné. Les 62 tests du banc passent.

Les relevés ajoutent les connexions occupées, libres et en attente de chaque API, ainsi que les états PostgreSQL agrégés des seules connexions du banc. Les horodatages permettent de voir le décalage entre les observations ; il ne s'agit pas d'une photographie transactionnelle commune. Aucun SQL, paramètre, identifiant métier ou PID PostgreSQL n'est exporté. Un état `idle in transaction` indique une transaction ouverte sans commande en cours, pas à lui seul une fuite de connexion ; `state` et `wait_event` sont indépendants selon la [documentation PostgreSQL 18](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW).

Le profilage optionnel distingue maintenant `setPresence`, `status`, `isBusy`, les réveils de disponibilité, l'historique Redis et les étapes de progression automatique. Les durées des méthodes imbriquées se recouvrent : elles ne doivent pas être additionnées comme du temps d'exécution indépendant.

### Résultats du 23 novembre après ajout des captures

Le scénario court de 9 h 22 à 9 h 26 à Kinshasa passe : cinq récupérations et cinq déposes, huit demandes avec offre et 60 alertes reçues et confirmées. Sur 304 tentatives GPS, 302 sont acceptées et diffusées ; les deux restantes rencontrent une clôture déjà validée et récupèrent l'état terminal sans être comptées comme des positions acceptées. Les cas d'acceptation, refus, annulation et absence de réponse passent. Rapport privé : `tmp/load-results/journeys-2026-11-23T08-22-47-584Z/report.json`.

La relance instrumentée de 9 h 26 à 9 h 29 franchit les 500 activations de présence, sans échec, puis s'arrête pendant l'envoi des demandes. Elle a envoyé 435 demandes sur les 500 prévues. Le plafond refuse une nouvelle paire GPS alors que 127 opérations occupent les 128 places. Le retard GPS maximal reste de 111 ms : l'arrêt n'est pas un dépassement du seuil de retard de 1 seconde.

La capture demandée à 9 h 29 min 33,268 s se termine en 53 ms. Les deux pools de dix connexions affichent respectivement 41 et 66 attentes. PostgreSQL observe une attente de verrou de transaction, huit connexions en transaction sans commande active et onze connexions inactives. Une observation précédente avait également vu des attentes de verrou de ligne et d'écriture WAL. Cela établit une contention des accès SQL côté application, sans suffire à désigner une transaction fautive ou un disque saturé. Environ une seconde après l'arrêt des émissions, les deux files d'attente de connexion sont retombées à zéro.

Les 173 065 commandes SQL profilées cumulent environ 50,5 % de leur durée côté client dans l'acquisition de connexion. Les GPS conducteur et passager arrivent en tête de ces durées ; `touchTripInteraction` ajoute à lui seul 9 629 mises à jour de trajet, dont celles des positions passager et des transitions métier. La préparation des notifications et l'attribution des offres contribuent aussi à la charge. Sur plusieurs intervalles de cinq secondes, chaque processus API consomme environ 0,85 à 0,99 cœur. Ces valeurs incluent le profilage et ne mesurent pas le CPU PostgreSQL.

Les 18 360 GPS envoyés sont tous accusés positivement et diffusés après vidange. Les bornes p95 sont de 200 ms pour les accusés et de 200 à 300 ms pour les diffusions. Les 500 récupérations automatiques ont eu lieu, mais aucune dépose : le scénario a été arrêté avant cette phase. Parmi les 435 demandes, 387 ont obtenu une offre au relevé final ; la première offre enregistrée a un p95 de 7,29 secondes sur ce sous-ensemble, avec 48 demandes encore sans offre. Les 1 220 alertes observées sont confirmées ; le scénario interrompu n'a pas fermé sa cohorte et ne prouve pas que toutes les alertes pertinentes ont été livrées.

Aucune erreur SQL ou worker, aucune erreur de transport Redis ni éviction au relevé d'arrêt. Le nettoyage des clusters jetables se termine sans erreur. La mémoire libre minimale de l'hôte est d'environ 1,8 Gio. Rapport privé : `tmp/load-results/journeys-2026-11-23T08-26-55-393Z/report.json`. **Ce résultat ne valide pas 500 trajets avec 500 demandes, ni le passage à 750 ou 1 000.**

### Comparaison sans profilage SQL détaillé

L'essai témoin de 9 h 32 à 9 h 34 conserve le même backend, deux API, 500 trajets, 500 conducteurs disponibles, 500 demandes prévues et tous les seuils. Seul `--profile-sql` est retiré. Les captures de santé, de panne et PostgreSQL restent actives.

Les 500 présences passent encore, puis le contrôle WebSocket renvoie `inflight_quota` après 36 demandes. Ce refus correspond à la protection de `WsSessionService.begin`, qui limite les opérations simultanées à 64 par processus et à trois par utilisateur ; ces limites n'ont pas été relevées. La capture de 9 h 33 min 58 s montre 70 et 25 appels en attente de connexion SQL, avec les vingt connexions des deux pools occupées. PostgreSQL observe quatre transactions ouvertes sans commande active et deux commandes actives. Après vidange des opérations clients, les attentes et la file de progression retombent à zéro.

Sur 9 536 GPS envoyés, 9 533 sont accusés et diffusés ; trois opérations échouent après environ cinq secondes. Les 61 alertes observées sont confirmées, mais la cohorte complète n'a pas pu être vérifiée. Les 428 récupérations, sans dépose, ne valident pas le palier. Aucun dépassement du retard autorisé du générateur : maximum de 119 ms pour une limite de 1 000 ms. Les relevés d'arrêt et de vidange ne comptent aucune erreur SQL, worker ou transport Redis. Rapport privé : `tmp/load-results/journeys-2026-11-23T08-32-05-283Z/report.json`. Nettoyage sans erreur.

Le profilage SQL détaillé n'est donc pas nécessaire pour reproduire la saturation. Ces deux essais s'arrêtent à des instants différents sur un hôte partagé ; ils ne quantifient pas précisément son surcoût. Le manque de connexions immédiatement disponibles est établi, mais il faut distinguer le volume de commandes, le temps de rétention des connexions et les verrous avant de modifier leur nombre.

La prochaine optimisation doit viser les accès SQL du GPS et les transactions concurrentes d'attribution et de notification. En particulier, le rafraîchissement de l'interaction du trajet ajoute une commande après chaque position passager. Le regrouper avec la persistance GPS exige de préserver l'ordre des verrous, l'horodatage d'activité et la mise en file atomique de la progression, avec des tests PostgreSQL de concurrence. Il ne faut ni supprimer cet horodatage sans analyser ses consommateurs, ni mettre les autorisations en cache Redis pour économiser ces lectures. Les tailles des pools, quotas WebSocket, fréquences GPS et règles de notification restent inchangées dans cette étape de diagnostic. Aucun changement fonctionnel du backend ni aucune modification AWS dans cette étape.

### Réduction des allers retours SQL du 23 novembre

La position passager, l'horodatage d'activité du trajet et la mise en file de sa progression sont maintenant enregistrés par une seule commande SQL. Le chemin normal passe de trois à deux commandes, lecture de contrôle comprise. Les coordonnées restent enregistrées et diffusées à la même fréquence ; aucun échantillon n'est supprimé pour diminuer la charge. Les autres interactions métier continuent d'actualiser le trajet.

Cette écriture prend les verrous dans l'ordre réservation, trajet, puis travail de progression. La décision d'interruption conducteur prenait auparavant le trajet avant la réservation ; elle suit désormais le même ordre, sans changer les contrôles du passager, le devis ni l'idempotence du règlement. Une erreur sur l'horodatage ou la file annule aussi la position : aucun accusé positif ne doit précéder cet enregistrement atomique.

La fin d'un travail de progression utilise également une seule commande, même lorsqu'un GPS plus récent impose de conserver le travail. Elle verrouille d'abord la version et le bail courants, puis supprime la version terminée ou libère le travail pour reprise, jamais les deux sur la même ligne. Un ancien worker ne peut pas libérer le bail de son remplaçant. Les délais de reprise de une ou cinq secondes restent identiques. Cette séparation des branches respecte les contraintes des [écritures PostgreSQL dans les CTE](https://www.postgresql.org/docs/18/queries-with.html#QUERIES-WITH-MODIFYING).

Les 22 tests PostgreSQL isolés passent, notamment les écritures GPS et la clôture concurrentes, les échecs d'enregistrement, un nouveau GPS pendant la fin d'un travail et le remplacement d'un bail pendant l'attente d'un verrou. La compilation, les 592 tests de la vérification élargie et les 62 tests du banc passent aussi. Les 79 tests ignorés par la vérification élargie restent distincts de la suite PostgreSQL explicitement exécutée.

Les pools SQL, quotas WebSocket, critères d'arrêt, règles d'alerte et contrôles d'autorisation sont inchangés. Ces vérifications fonctionnelles ne valident pas encore le palier 500 ni la capacité AWS.

Le scénario court du 23 novembre, de 9 h 57 à 10 h 00 à Kinshasa, passe après ces corrections : cinq récupérations et cinq déposes automatiques, 302 GPS confirmés et diffusés, plus deux refus de GPS avec récupération correcte de l'état terminal. Les huit demandes obtiennent une offre ; le p95 de première offre enregistrée est de 64,82 ms. La cohorte contient 59 alertes observées et confirmées, une devenue obsolète et aucune alerte pertinente manquante. Les bornes p95 GPS sont de 20 ms pour le conducteur et 50 ms pour le passager. Le nettoyage des ressources jetables se termine sans erreur. Rapport privé : `tmp/load-results/journeys-2026-11-23T08-57-09-523Z/report.json`.

Le premier nouvel essai à 500, de 10 h 01 à 10 h 03, s'arrête sur un pic de 68 attentes SQL dans une API, pour une limite inchangée de 50. Les 10 128 GPS sont tous confirmés et diffusés après vidange, avec une borne p95 de 100 ms pour chaque rôle. Les 86 demandes, 425 récupérations et aucune dépose ne constituent pas le scénario complet. Les 222 alertes observées sont confirmées ; la cohorte interrompue ne permet pas de conclure sur toutes les alertes pertinentes. Aucun doublon d'offre ou d'acceptation, aucune erreur SQL ou worker, aucune éviction Redis. Le nettoyage réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-01-16-486Z/report.json`. Le palier 500 reste non validé.

Après cet arrêt, la préparation des alertes regroupe également le contrôle de visibilité de la demande et l'acquisition de l'état conducteur dans une commande. Un refus ou un ciblage vers un autre conducteur empêche l'écriture, y compris la modification d'un état préexistant. La visibilité reste vérifiée en base à chaque préparation ; aucun droit n'est mis en cache. Les 38 tests ciblés de sonnerie et PostgreSQL passent, dont l'accès concurrent push/temps réel et le retour arrière en cas d'échec. La compilation passe à nouveau.

Le scénario court avec les trois optimisations passe de 10 h 06 à 10 h 10 : cinq récupérations, cinq déposes, 302 GPS confirmés et diffusés et deux refus terminaux correctement récupérés. Les huit demandes ont une offre ; les 60 alertes de la cohorte sont toutes observées et confirmées, sans doublon ni alerte pertinente manquante. Le nettoyage réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-06-47-538Z/report.json`.

Le nouvel essai instrumenté à 500, de 10 h 10 à 10 h 12, dépasse encore le plafond d'attente SQL : pics de 48 et 52 pour une limite de 50. Il envoie et diffuse les 12 130 GPS sans échec ; les bornes p95 des accusés sont de 200 ms. Il exerce 164 demandes, 450 récupérations, 60 acceptations, 28 refus et 34 annulations, mais aucune dépose avant l'arrêt. Les 388 alertes observées sont confirmées ; la cohorte complète n'est pas fermée. La file de progression atteint un âge de 8,45 secondes à l'arrêt, sous sa limite de 15 secondes. Aucune erreur SQL ou worker ni éviction Redis, aucun doublon d'offre ou d'acceptation, nettoyage réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-10-31-298Z/report.json`. La proximité du plafond n'autorise pas à le relever ni à valider 500. Ces essais de durées différentes sur un hôte partagé ne chiffrent pas à eux seuls le gain de capacité des corrections.

Le contrôle à 500 sans profilage SQL détaillé, de 10 h 13 à 10 h 16, s'arrête aussi sur ce garde-fou : pic de 54 attentes SQL pour une limite de 50. Les 9 202 GPS sont tous confirmés et diffusés, avec une borne p95 de 100 ms pour chaque rôle. L'essai exerce 62 demandes et 394 récupérations, mais aucune dépose avant l'arrêt. Les 158 alertes observées sont confirmées ; la cohorte interrompue ne permet pas de garantir la réception de toutes les offres. Aucun doublon d'offre ou d'acceptation, aucune erreur SQL ou worker ni éviction Redis. La plus ancienne progression en attente a 2,28 secondes à l'arrêt. Après vidange des opérations en cours, aucune acquisition de connexion n'attend, mais 138 travaux de progression restent à traiter : ce n'est pas une validation du scénario complet. Le nettoyage des ressources jetables réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-13-52-310Z/report.json`.

Ce contrôle montre que le profilage détaillé n'est pas la seule cause du dépassement. Le palier 500 reste non validé et aucun essai à 750 ou 1 000 n'est lancé. La suite consiste à mesurer puis raccourcir les transactions d'attribution et de préparation des notifications pour libérer des connexions pour le GPS, en conservant les contrôles de visibilité, les délais des offres et la livraison indépendante des alertes. Il faudra ensuite terminer le scénario à 500 avec sa cohorte d'alertes et ses déposes avant de relever la charge. Aucun pool, critère d'arrêt ou contrôle d'autorisation n'a été assoupli ; aucun changement AWS n'a été appliqué.

### Attribution et notifications par vague du 23 novembre

La réservation d'une vague immédiate de quatre conducteurs utilise désormais cinq commandes SQL au lieu de vingt dans le cas sans conflit : validation des quatre candidats verrouillés, insertion des offres, fixation des échéances réelles, mise à jour des disponibilités et insertion des quatre notifications. Ce compte porte sur cette phase uniquement, hors découverte, préparation de la demande et ouverture ou clôture de la transaction ; il ne représente pas un gain de débit mesuré.

Le module `reserve-request-wave.ts` conserve les contrôles d'éligibilité en base, l'ordre des candidats Redis, les verrous non bloquants et les index d'unicité. Il traite au plus quatre candidats à la fois et 32 candidats au total, comme l'ancienne limite d'une vague complète. En cas de conflit partiel, il réutilise les places effectivement libres sans créer de notification pour le conducteur non réservé. Un conducteur ciblé reste seul invité. Le curseur Redis avance seulement après validation de la transaction, jusqu'au dernier conducteur réservé dans l'ordre de la file.

Les notifications restent dans la transaction des offres : un échec d'écriture annule toute la vague. Les échéances renvoyées par les triggers sont conservées, ainsi que les délais de réponse et l'indépendance entre push et temps réel. Aucun changement de fréquence GPS, de taille de pool ou de critère d'arrêt.

La compilation et les suites ciblées d'attribution réussissent : 116 tests passent, trois tests optionnels restent ignorés. Les vérifications PostgreSQL/Redis incluent les acceptations concurrentes, le retour arrière sur échec de notification, le regroupement SQL, les conducteurs verrouillés ou devenus inactifs et les véhicules désactivés. La vérification élargie des notifications et du dispatch compte 403 tests réussis et 59 ignorés, distincts des tests d'intégration explicitement lancés. Les six tests unitaires de réservation sont ensuite relancés avec succès, y compris le curseur Redis après conflit partiel et un ordre de retour SQL différent de l'ordre des candidats.

Le scénario court du 23 novembre, de 10 h 33 à 10 h 36 à Kinshasa, réussit : cinq récupérations et cinq déposes automatiques, 301 GPS confirmés et diffusés et un refus terminal correctement récupéré. Les huit demandes obtiennent une offre, avec un p95 de première offre SQL de 79,36 ms. Les 60 alertes de la cohorte sont toutes observées et confirmées, sans alerte pertinente manquante, doublon d'offre ou double acceptation. Le nettoyage réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-33-05-768Z/report.json`.

L'essai à 500 qui suit, de 10 h 37 à 10 h 40, s'arrête sur le plafond de 128 opérations en cours du générateur, et non sur le plafond SQL. Les pics d'attente SQL mesurés sont de 37 et 43, sous la limite de 50. Les 500 récupérations ont lieu ; les 16 442 positions sont toutes confirmées et diffusées, avec une borne p95 de 200 ms pour chaque rôle. Le générateur tente 321 demandes ; 320 sont enregistrées et 314 ont une offre au bilan, avec un p95 de première offre SQL de 2,58 secondes pour ces dernières. Les 954 alertes observées sont confirmées, mais la cohorte complète et les déposes ne sont pas terminées. Aucun doublon d'offre ou d'acceptation ni erreur SQL ou worker ; nettoyage réussi. Ce résultat ne valide pas le palier 500. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-37-23-046Z/report.json`.

À cet arrêt, 94 des 128 opérations en cours sont des positions GPS, 13 sont des accusés de réception d'alerte et huit sont des créations de demande. Les traces montrent encore des attentes sur le verrou de demande pendant les accusés. La correction suivante regroupe la configuration des délais SQL locaux à la transaction et l'écriture de la première fenêtre de réponse. Le verrou de demande reste acquis dans une commande précédente, pour que la validation de l'offre dispose d'une nouvelle photographie SQL après une éventuelle attente. Les confirmations répétées lisent l'échéance existante sans la réécrire ; aucune limite ni cadence n'est relevée.

Après ces dernières modifications, la compilation et les quatre suites d'attribution passent à nouveau : 120 tests réussis et trois tests optionnels ignorés. Les cas ajoutés contrôlent six confirmations concurrentes, l'absence de nouvelle écriture lors d'une répétition, le refus d'un autre destinataire, les offres expirées ou antérieures à la fenêtre de réponse, et la restauration des délais SQL après commit comme après rollback.

Le contrôle à 500 sans profilage SQL détaillé, de 10 h 46 à 10 h 48, s'arrête sur `inflight_quota`, la protection WebSocket contre un trop grand nombre d'opérations en cours. Sur 9 790 opérations GPS, 9 783 sont confirmées et diffusées ; sept échouent. Les 59 demandes enregistrées obtiennent une offre au bilan ; les 146 alertes observées sont confirmées, mais la cohorte n'est pas terminée. L'essai atteint 440 récupérations et aucune dépose, sans doublon d'offre ou d'acceptation. Le nettoyage réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-46-07-711Z/report.json`.

La capture d'échec montre 69 attentes de connexion sur une API, alors que son compteur de pic échantillonné auparavant n'en avait relevé que 19 : il faut lire aussi la valeur instantanée, et non conclure à partir du dernier pic périodique. Cette API mesure un blocage maximal de boucle Node de 348 ms et neuf requêtes dépassant 250 ms. PostgreSQL relève alors cinq connexions inactives dans une transaction, dont la plus ancienne a 624 ms, et deux attentes de verrou. Après vidange des opérations en cours, les deux pools n'ont plus d'attente. Ces mesures montrent une accumulation transitoire ; elles ne prouvent pas à elles seules sa cause ni une régression attribuable à une correction précise.

**Le palier 500 reste non validé.** Aucun test à 750 ou 1 000 n'est lancé. Les regroupements SQL et les garanties fonctionnelles sont vérifiés, mais l'essai complet sous charge reste à réussir. La prochaine investigation doit corréler les pauses de boucle Node, les transactions qui gardent une connexion et les refus WebSocket pendant ce pic, puis retester sans augmenter les plafonds ni masquer les sept échecs. Aucun changement AWS n'a été effectué.

### Diagnostic CPU et lectures GPS du 23 novembre

Le compteur d'attente SQL observe désormais chaque admission dans le pool, en plus des relevés périodiques. Le garde-fou vérifie aussi la valeur instantanée : une pause Node ne doit pas masquer un pic survenu entre deux relevés. Les compteurs WebSocket distinguent les refus globaux des refus par utilisateur, sans exporter d'identifiant. Les plafonds restent de 50 attentes SQL, 64 opérations WebSocket par API et trois par utilisateur.

L'option locale `--profile-cpu` échantillonne les fonctions pendant au plus 90 secondes au début du premier palier stable. Aucun port de débogage n'est ouvert. Le rapport conserve au plus 40 agrégats de fonctions par API, sans arguments ni chemin absolu ; les échantillons bruts sont abandonnés après agrégation. Les relevés mémoire, CPU et GC des API sont bornés comme ceux du générateur. Ces durées échantillonnées incluent les attentes natives et ne mesurent pas directement le CPU PostgreSQL.

L'essai du 23 novembre, de 10 h 58 à 11 h 06 à Kinshasa, atteint 500 récupérations et 500 demandes avec une offre. Les 68 146 GPS sont tous confirmés et diffusés, avec une borne p95 de 200 ms. Il s'arrête avant les déposes sur l'échec HTTP d'une confirmation d'alerte : 5 005 alertes sont observées, 5 004 confirmées. Les pics SQL sont de 48 et 42, les pics WebSocket de 51 et 46, sans refus de quota. La capture d'arrêt montre zéro attente SQL et une file de progression âgée de 0,25 seconde ; elle ne permet pas d'attribuer l'échec HTTP à une saturation. Le nettoyage des ressources jetables réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T09-58-52-896Z/report.json`.

Le p95 de première offre SQL est de 9,35 secondes sur les 500 demandes ; celui de première alerte reçue dépasse la dernière classe de l'histogramme, fixée à dix secondes. Ce résultat demeure insuffisant pour valider le scénario complet ou annoncer une première offre rapide pour tous les passagers.

Le profil de 90 secondes fait ressortir les écritures natives `writev`, la recherche des métadonnées de validation et la construction/transformation TypeORM. Il ne fournit pas une cause unique aux anciens refus. En particulier, l'arrêt du profileur apparaît lui-même dans un échantillon de 396 et 357 ms, proche des pauses de boucle maximales de 415 et 374 ms. Ces pics instrumentés ne sont donc pas des mesures propres des pauses naturelles de l'application.

Les lectures GPS conducteur et passager utilisent maintenant des requêtes SQL paramétrées fixes, avec exactement les anciennes projections. Cela évite leur construction et hydratation TypeORM répétées, sans diminuer le nombre de positions, supprimer une lecture d'autorisation ni ajouter un cache de droits. La lecture initiale et la relecture après échec d'écriture restent fraîches ; les états terminaux, changements de propriétaire, horodatages, coordonnées et contrôles de proximité sont conservés. Les données partielles ne servent jamais aux règlements.

Un défaut indépendant est corrigé dans l'intercepteur WebSocket : l'annulation d'une souscription pendant l'attente de Redis pouvait laisser sa place occupée. La place est maintenant libérée après la réponse tardive, sans démarrer le traitement annulé. La libération est idempotente et son état appartient à chaque souscription. Ce cas est reproduit par un test, mais n'est pas établi comme cause de l'ancien pic de charge.

Les 145 tests ciblés, 23 tests PostgreSQL isolés et 70 tests du banc passent, ainsi que la compilation. Les comparaisons PostgreSQL contrôlent l'égalité avec les anciennes projections, les dates et géométries nulles ou renseignées, le changement de propriétaire et la clôture concurrente. Le diagnostic HTTP distingue maintenant les délais, réinitialisations de connexion et sockets réutilisés, sans conserver URL, jeton ou message serveur arbitraire. Il ne relance aucune requête automatiquement et conserve le délai de cinq secondes. Une course avec la fermeture d'une connexion réutilisée est un cas [documenté par Node.js](https://nodejs.org/docs/latest-v24.x/api/http.html#requestreusedsocket), mais la trace générique de cet essai ne permet pas de la confirmer.

Le scénario court après ces corrections, de 11 h 12 à 11 h 15 à Kinshasa, réussit : cinq récupérations, cinq déposes et 302 positions confirmées et diffusées. Les huit demandes obtiennent une offre, avec un p95 SQL de 79,63 ms. Sur les 60 offres de la cohorte, 59 alertes sont observées et confirmées et une est devenue obsolète ; aucune alerte encore pertinente n'est manquante. Aucun doublon d'offre ou d'acceptation, aucune erreur de nettoyage. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-12-20-830Z/report.json`.

Le contrôle sans profilage CPU/SQL détaillé, de 11 h 16 à 11 h 18, s'arrête sur le budget de 128 opérations du générateur : 127 sont en cours lorsque la paire GPS suivante est refusée. Parmi elles figurent 94 positions GPS, 12 confirmations d'alerte, 11 réponses conducteur et six créations de demande. Les 12 730 GPS envoyés finissent tous confirmés et diffusés, avec une borne p95 de 200 ms ; les maxima sont d'environ 680 ms pour l'accusé conducteur et 566 ms pour l'accusé passager. Le retard maximal de programmation du générateur est de 57 ms, donc son délai d'une seconde n'est pas dépassé.

Les pics SQL sont de 25 et 46, les pics WebSocket de 44 et 50, sans refus de quota. Les pauses Node maximales sont de 107 et 100 ms et les pauses GC de 30 et 37 ms. À la capture, chaque API a cinq connexions SQL inactives, mais garde de nombreuses opérations WebSocket en cours. Le relevé PostgreSQL indépendant montre une attente de verrou de 321 ms et deux transactions inactives, dont la plus ancienne a 321 ms. Cette photographie décalée de quelques millisecondes ne situe pas à elle seule l'attente dans SQL, Redis ou la diffusion réseau : il faut mesurer séparément ces phases du traitement GPS.

L'essai atteint 455 récupérations et aucune dépose. Sur 187 demandes enregistrées, 183 ont une offre au bilan et quatre n'en ont pas encore ; le p95 de première offre SQL de 1,76 seconde ne concerne que les 183. Les 574 alertes observées sont confirmées, mais la cohorte complète n'est pas fermée. Aucune erreur SQL, worker ou transport Redis, ni doublon d'offre ou d'acceptation. Nettoyage réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-16-20-070Z/report.json`.

Le client HTTP du banc reçoit ensuite un délai d'agent positif de cinq secondes : dans le code Node 24.22.1 utilisé, la durée annoncée par le serveur n'était pas appliquée aux connexions inactives lorsque ce délai valait zéro. Le test vérifie maintenant leur expiration avant une annonce de cinq secondes. Le délai des requêtes, les 32 sockets HTTP et l'absence de relance automatique restent inchangés. L'erreur HTTP générique de l'essai précédent n'est pas attribuée rétrospectivement à ce défaut ; elle n'est pas réapparue avant l'arrêt du contrôle suivant.

**Le palier 500 n'est toujours pas validé et aucun palier supérieur n'est lancé.** Les lectures GPS et le cycle de vie des places WebSocket sont corrigés et testés, mais le traitement GPS doit encore être décomposé en temps d'admission Redis, lecture/écriture SQL, historique Redis et diffusion. Les différences entre ces essais sur un hôte partagé ne mesurent pas isolément le gain du changement de lecture. Aucun déploiement ni changement AWS.

### Mesures par étape du tracking du 23 novembre

L'option `--profile-tracking` ajoute des mesures locales bornées, sans modifier le backend déployé, les règles métier ni les seuils du scénario :

```powershell
node test/load/journeys/run.cjs mixed-smoke --execute-local --profile-tracking
node test/load/journeys/run.cjs stage-500-mixed --execute-local --profile-tracking
```

Les mesures distinguent l'admission WebSocket (tous les messages), la validation des deux DTO GPS, les services conducteur/passager, les lectures et écritures GPS et leur acquisition de connexion SQL, l'historique Redis, l'émission locale et la publication Redis. Elles conservent des histogrammes cumulés et depuis la collecte précédente, les opérations en cours, leur pic et l'âge de la plus ancienne. Les noms de phases sont fixes ; aucun argument, identifiant métier, paquet, clé Redis, SQL, résultat ou message d'erreur n'est enregistré. Le suivi des débuts est limité à 256 opérations simultanées par phase ; un dépassement rend explicitement l'âge inconnu au lieu de le sous-estimer.

Les enveloppes conservent le récepteur, les arguments, les retours synchrones et les promesses originales, y compris leurs erreurs. Elles ne remplacent pas les contrôleurs, les handlers décorés ni les gardes. Les validations restent exécutées. Les temps des services englobent leurs sous-étapes ; les temps SQL englobent l'acquisition de connexion. Il ne faut donc pas sommer toutes les lignes, ni soustraire leurs percentiles. Le temps SQL après acquisition inclut le transport et le pilote, pas seulement l'exécution PostgreSQL.

Le gateway émet la position sans attendre la publication Redis. La mesure d'émission couvre la programmation et la diffusion locale ; celle de publication s'achève à la réponse Redis, qui ne vaut pas confirmation de réception mobile. Les accusés GPS et les réceptions croisées entre réplicas restent vérifiés indépendamment par le générateur.

Le scénario court, de 11 h 27 à 11 h 31 à Kinshasa, passe avec cinq récupérations et cinq déposes automatiques, 302 GPS confirmés et reçus par l'autre client, huit demandes avec offre et 60 alertes observées et confirmées dans la cohorte. Aucune alerte pertinente manquante, aucun doublon ni dépassement de vague. Le p95 de première offre SQL est de 69,38 ms. Les ressources jetables sont nettoyées sans erreur. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-27-56-503Z/report.json`. La mesure de validation DTO, ajoutée après le démarrage de ce scénario, est vérifiée par un test unitaire et sera présente dans l'essai suivant.

L'essai de 500 trajets avec cette instrumentation, de 11 h 31 à 11 h 34 à Kinshasa, s'arrête sur le garde-fou SQL : le pic atteint 61 requêtes en attente sur la première API, contre une limite de 50 ; la seconde atteint 39. Le pool reste de dix connexions par API. À la collecte qui déclenche l'arrêt, les attentes instantanées sont déjà redescendues à 11 et 12 : le pic historique empêche de masquer cet épisode entre deux collectes. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-31-39-237Z/report.json`.

Sur les cinq secondes précédant l'arrêt, la première API présente les durées moyennes suivantes (fourchettes conducteur/passager) :

| Étape | Durée moyenne |
| --- | --- |
| Admission WebSocket | 16,0 ms |
| Validation GPS | 1,0 à 1,4 ms |
| Lecture SQL, connexion incluse | 31,9 à 33,7 ms |
| Acquisition de connexion pour cette lecture, déjà incluse | 24,3 à 25,8 ms |
| Écriture SQL et file durable, connexion incluse | 36,1 à 37,0 ms |
| Acquisition de connexion pour cette écriture, déjà incluse | 25,7 à 25,9 ms |
| Écriture de l'historique Redis | 12,8 ms |
| Émission locale et programmation de publication | 0,24 à 0,25 ms |
| Réponse à la publication Redis, indépendante de l'accusé GPS | 12,1 à 12,5 ms |

Les acquisitions SQL culminent à 339 ms, contre 149 ms pour l'admission et 148 ms pour l'historique Redis. Les pauses maximales de boucle Node sont de 132 et 144 ms. La capture PostgreSQL après le pic ne montre plus d'attente de verrou ; elle montre cinq connexions inactives dans une transaction, dont la plus ancienne a 54 ms. Ces observations établissent une pression sur le pool et situent une part importante de la latence dans l'acquisition SQL. Elles ne prouvent ni que Redis est toujours rapide, ni que PostgreSQL manque de CPU, ni quelle transaction détenait les connexions à l'instant exact du pic. Le profil précédent et les délais du pilote restent à rapprocher avant une nouvelle optimisation.

Les 14 186 GPS envoyés sont tous confirmés et diffusés après vidange ; leur borne p95 globale est de 200 ms. Les 500 passagers sont récupérés automatiquement, mais le scénario n'atteint pas les déposes. Sur 244 demandes créées, 238 ont une offre au bilan et six n'en ont pas encore ; le p95 SQL de 1,79 seconde ne concerne que les 238. Les 724 alertes observées sont confirmées, sans fermeture complète de la cohorte. Aucun doublon d'offre ou d'acceptation, aucune violation de vague, aucune erreur SQL, worker ou transport Redis et aucun refus WebSocket. La file de progression atteint environ cinq secondes, sous la limite de quinze secondes ; le générateur culmine à 113 opérations en cours, sous son plafond de 128. Nettoyage terminé sans erreur.

Les 78 tests du banc passent, dont huit tests des nouvelles mesures. Le contrôle court et le palier 500 utilisent également l'expiration des connexions HTTP inactives ajoutée précédemment ; aucun échec HTTP n'est observé dans ces deux essais. Aucun code applicatif, cadence GPS, quota, règle d'alerte ou dimensionnement AWS n'est modifié pendant cette investigation.

**Le palier 500 mixte reste non validé.** La prochaine optimisation doit réduire les acquisitions et le temps de détention des connexions dans les chemins GPS, progression automatique et dispatch, avec tests de concurrence, plutôt que relever le plafond SQL ou mettre en cache les droits. Elle devra conserver la mise en file durable, l'historique utilisé pour les récupérations/déposes et les confirmations d'alerte. Le résultat local sur Windows avec Redis sous WSL ne constitue pas une limite de capacité AWS. Aucun essai à 750 ou 1 000 n'est lancé.

### Relais atomique des travaux de progression du 23 novembre

Le worker peut maintenant terminer un travail et réserver le suivant dans une seule requête SQL (`finishAndClaimRideProgress`). Cela supprime l'acquisition séparée qui suivait la clôture lorsqu'un relais est possible. Le gain global dépend aussi du regroupement des anciennes réservations, de la charge et des autres traitements ; ce changement ne démontre pas à lui seul une capacité supérieure.

Le relais conserve la même place parmi les quatre traitements autorisés par API et réserve au plus un successeur, immédiatement traité. Aucun travail supplémentaire n'est préchargé en mémoire. La requête verrouille la version courante, préserve un GPS reçu pendant l'évaluation et n'efface jamais le bail d'un autre worker. Elle saute les successeurs déjà verrouillés. Un échec de réservation annule également la clôture ; une réponse SQL ambiguë n'est pas rejouée automatiquement. Les reprises après expiration du bail restent durables.

Les délais de reprise restent d'une seconde pour un historique GPS encore incomplet ou une nouvelle version, et de cinq secondes pour les autres échecs. À l'arrêt, le worker finit le travail engagé sans nouveau relais. Si l'arrêt commence pendant la requête de relais, le successeur déjà réservé est remis en attente sans exécution ni suppression. Les lectures d'autorisation, positions GPS, historique Redis, contrôles de récupération/dépose et notifications restent inchangés. Aucune migration ni modification de pool n'est ajoutée.

La compilation, les 180 tests applicatifs ciblés, les 30 tests PostgreSQL isolés et les 78 tests du banc passent. Les tests PostgreSQL vérifient notamment deux relais concurrents vers des successeurs distincts, un successeur verrouillé, les mises à jour GPS et changements de bail concurrents, les délais de reprise et l'annulation atomique si la réservation échoue. Les tests du worker vérifient les quatre places, l'absence de préchargement, l'arrêt pendant le relais et l'absence de relance après une réponse incertaine.

Le contrôle mixte court avec le relais atomique passe : cinq récupérations et cinq déposes automatiques, 302 GPS confirmés et reçus par l'autre client, huit demandes avec offre et 60 alertes observées et confirmées dans la cohorte. Aucune notification manquante, aucun doublon ni dépassement de vague. Le p95 de première offre SQL est de 74,75 ms ; il s'agit d'un contrôle fonctionnel sur huit demandes, pas d'une preuve de gain de débit. Le nettoyage termine sans erreur. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-49-57-955Z/report.json`.

L'essai à 500 trajets et 500 demandes prévues, de 11 h 56 à 11 h 58 à Kinshasa, est interrompu pendant l'arrivée des demandes : le pic d'attente SQL atteint 64 sur la première API et 37 sur la seconde, pour une limite inchangée de 50 et dix connexions par API. Seules 97 demandes sont créées avant l'arrêt. Le palier mixte reste donc **non validé**. Rapport privé : `tmp/load-results/journeys-2026-11-23T10-56-18-633Z/report.json`.

Après vidange, les 10 160 positions envoyées sont toutes confirmées et reçues par l'autre client, avec une borne p95 globale de 200 ms et un maximum de réception de 640,30 ms. Le bilan compte 439 récupérations automatiques, aucune dépose (phase non atteinte), 90 demandes avec offre et sept sans offre. Le p95 SQL de première offre est de 2,68 secondes sur les 90 demandes servies uniquement. Les 237 alertes observées sont confirmées ; 360 offres existent au bilan. La cohorte n'a pas été fermée après l'arrêt de sécurité : ces chiffres ne permettent ni de certifier la livraison de toutes les alertes ni de conclure que les autres sont perdues. Aucun doublon d'offre ou d'acceptation ni dépassement de vague n'est observé.

La collecte déclenchant l'arrêt relève 309 travaux de progression en attente, dont le plus ancien a 3,44 secondes, zéro éviction Redis, zéro erreur SQL ou worker, zéro erreur de transport Redis et zéro refus WebSocket. Le générateur culmine à 94 opérations en cours (plafond 128), avec 59,78 ms de retard de programmation (plafond 1 seconde) et au moins 2 773 Mio de mémoire libre sur l'hôte. Les pauses maximales des boucles API sont de 144 et 70 ms. Les ressources jetables sont nettoyées sans erreur.

Sur la dernière fenêtre de cinq secondes de la première API, les lectures GPS prennent en moyenne 39,1 à 45,7 ms, dont 31,5 à 34,6 ms d'acquisition SQL ; les écritures prennent 41,8 à 42,9 ms, dont 31,2 à 33,2 ms d'acquisition. Les 1 556 et 3 321 appels de relais mesurés sur les deux API n'ont aucune erreur ; ces compteurs incluent les appels sans successeur et ne sont pas des nombres de transferts réussis. La capture PostgreSQL après le pic ne montre pas d'attente de verrou et relève quatre connexions inactives dans une transaction, la plus ancienne depuis 38,8 ms. Elle ne décrit pas l'état exact au sommet du pic.

Le relais réduit les acquisitions nécessaires à la transition entre deux travaux, mais cet essai n'établit **aucun gain de capacité globale**. L'arrêt survient plus tôt que lors de l'essai précédent ; un seul essai sur cet hôte partagé ne permet pas d'attribuer cette différence au changement. La pression SQL reste la limite constatée. La suite doit examiner les lectures complètes de réservations, trajets et passagers effectuées par la progression automatique, ainsi que les transactions du dispatch, puis comparer des essais répétés. Ne pas relever les garde-fous, ralentir le GPS ou mettre en cache les droits pour obtenir un passage artificiel. Aucun palier 750/1 000 ni changement AWS n'est exécuté.

### Lecture de progression et retrait atomique des invitations du 23 novembre

La lecture de progression utilise désormais une projection SQL préparée une fois par repository. Seule la structure est mémorisée : chaque évaluation relit les positions, statuts et autres valeurs en base. Toutes les colonnes normalement sélectionnées de la réservation et du trajet sont conservées pour la dépose et les traitements financiers. La relation passager ne contient que son identifiant et ses noms ; les services existants continuent à vérifier le KYC et à récupérer les destinataires des notifications. Les déclarations et autres colonnes `select: false` restent exclues. Les conversions TypeORM des dates et valeurs sont conservées ; les géographies passent par `ST_AsGeoJSON`, comme dans la lecture précédente.

Un test PostgreSQL compare les deux lectures sur les valeurs nulles et renseignées, les décimales, les dates, les coordonnées et les changements de statut, conducteur et nom. Un contrôle rend explicite l'absence actuelle de hooks de lecture, de relations chargées automatiquement et de suppression logique sur ces entités, pour détecter une évolution incompatible. Sur 80 lectures alternées par méthode, avec quatre réservations et après échauffement, la moyenne passe de 2,41 à 1,65 ms et le p95 de 3,10 à 2,31 ms. Ce petit échantillon mesure la lecture locale, pas la capacité globale.

Le retrait des invitations regroupe quatre ou cinq commandes SQL en une seule, dans la transaction qui détient déjà le verrou de la demande. Il conserve les contre-offres historiquement refusées, inclut explicitement les nouvelles annulations et désactive leurs notifications avant le commit. Les deux mises à jour de notifications ciblent des types disjoints. Les pilotes libérés ne sont communiqués qu'après la réussite de la requête ; les signaux Redis restent postérieurs au commit. Un échec d'écriture de notification annule toute l'opération.

La compilation, 218 tests applicatifs ciblés, 32 tests PostgreSQL de tracking, 101 tests PostgreSQL/Redis du dispatch et 78 tests du banc passent. Les scénarios couvrent notamment les vagues de quatre, les réponses concurrentes, le retour après panne Redis, l'expiration et le rollback des notifications. Trois scénarios optionnels du dispatch ne sont pas exécutés (benchmark spécifique et parcours mobile inter-dépôts). Sur 211 000 notifications historiques, le plan du retrait atomique utilise l'index des notifications actives par demande, sans parcours séquentiel de leur historique ; son exécution SQL mesurée est de 0,109 ms.

Les garde-fous restent inchangés : GPS toutes les cinq secondes, quatre workers de progression et dix connexions SQL par API, arrêt au-delà de 50 requêtes en attente. Les mesures locales ajoutent les durées de lecture de progression, d'acquisition de sa connexion et de retrait d'invitations, sans conserver de données utilisateur. Aucun changement de schéma, de configuration AWS ou de fréquence d'alerte n'est nécessaire à ces deux correctifs.

Le scénario mixte court passe avec cinq récupérations et cinq déposes automatiques, huit demandes ayant une offre, 302 positions confirmées et reçues par l'autre client, et les 60 alertes de la cohorte observées et confirmées. Aucune notification manquante, aucun doublon ni dépassement de vague. Le p95 de première offre SQL est de 79,93 ms sur huit demandes ; le pic d'attente SQL atteint trois par API. Les ressources jetables sont nettoyées sans erreur. Rapport privé : `tmp/load-results/journeys-2026-11-23T11-14-41-715Z/report.json`.

Le nouvel essai mixte à 500 trajets, commencé à 12 h 18 (Kinshasa), s'arrête sur le garde-fou SQL : pics de 48 et 53 requêtes en attente, pour une limite de 50 et dix connexions par API. Le palier reste **non validé**. Au bilan, 437 récupérations et aucune dépose sont exécutées avant l'arrêt. Les 10 144 positions GPS sont confirmées et reçues par l'autre client, sans erreur ; la borne supérieure du p95 est de 200 ms et la réception la plus lente de 438,14 ms. Les 109 demandes créées ont une offre en base, avec un p95 de première allocation de 950,47 ms. Parmi les 436 offres, 341 alertes sont observées et confirmées ; l'observation est interrompue avant la fermeture de la cohorte. Ces chiffres ne prouvent donc ni la livraison exhaustive ni la perte des autres alertes. Aucun doublon d'offre ou d'acceptation ni dépassement de vague n'est constaté.

La collecte déclenchant l'arrêt relève 293 travaux de progression en attente, le plus ancien depuis 3,10 secondes, zéro erreur SQL, worker ou transport Redis, zéro éviction et zéro refus WebSocket. Sur sa dernière fenêtre de cinq secondes, la lecture de progression prend en moyenne 20,23 et 23,48 ms, dont 11,37 et 14,50 ms d'acquisition de connexion. Sur la seconde API, les lectures GPS prennent 35,14 à 36,21 ms et leurs acquisitions 27,63 à 27,71 ms ; les écritures prennent 37,33 à 37,80 ms et leurs acquisitions 28,13 à 28,96 ms. Les sous-mesures couvrent les appels terminés dans la fenêtre et ne constituent pas une décomposition exacte de chaque requête. Le retrait atomique d'invitations prend en moyenne 11,42 et 10,81 ms. Le générateur culmine à 105 opérations en cours et 40,62 ms de retard, sous ses limites inchangées.

La capture PostgreSQL immédiatement après l'échec montre quatre connexions attendant un verrou (deux `transactionid`, deux `tuple`), avec au plus 74,28 ms d'activité, et deux connexions inactives dans une transaction, la plus ancienne depuis 88,39 ms. Elle confirme une contention ponctuelle, sans identifier les requêtes bloquantes ni l'état exact au sommet du pic. La suite doit attribuer ces attentes et la durée de détention des connexions aux transactions avant toute nouvelle augmentation de charge. Le pic SQL de 53 est inférieur aux 64 du précédent essai, mais un seul passage sur cet hôte partagé ne démontre pas un gain de capacité. Les ressources jetables sont nettoyées sans erreur. Aucun palier 750/1 000 ni changement AWS n'est exécuté ; les API Windows n'ont pas les limites CPU de Fargate. Rapport privé : `tmp/load-results/journeys-2026-11-23T11-18-26-093Z/report.json`.

### Attribution des attentes SQL du 23 novembre

Le profilage local identifie une contention sur les demandes de trajet : les accusés de réception des alertes, l'attribution et les réponses des conducteurs se disputent les verrous de `trip_requests`. La priorité est de raccourcir cette section critique tout en conservant l'exclusivité de l'acceptation et les contrôles de fraîcheur. Le palier 500 reste non validé ; les fréquences GPS, les plafonds et le code métier ne sont pas modifiés pendant ce diagnostic.

Avec `--profile-sql`, le banc mesure maintenant l'occupation de chaque connexion entre acquisition et restitution, ainsi que la durée des transactions externes, sans compter les savepoints comme des transactions distinctes. L'attente initiale du pool est exclue. Le temps passé dans les appels de requête inclut le réseau, le pilote, l'exécution et les attentes serveur ; il ne mesure pas le CPU PostgreSQL. Les appels simultanés sur une même connexion sont comptés comme une union de périodes, pas additionnés deux fois. Les valeurs, le SQL brut et les identifiants de connexion ne sont pas exportés.

La capture des blocages n'est activée qu'avec ce profilage. Elle interroge au plus 64 connexions API du laboratoire aux collectes de santé habituelles et ne demande les bloqueurs que pour les connexions attendant déjà un verrou. Une requête tronquée est signalée ; le dernier SQL d'une transaction inactive n'est pas forcément celui qui a pris le verrou. Ces limites suivent le comportement de [pg_stat_activity](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW) et de [pg_blocking_pids](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-INFO-SESSION).

Le scénario court profilé passe : cinq récupérations et cinq déposes, huit demandes servies, 60 alertes observées et confirmées, aucune mesure de connexion perdue et nettoyage sans erreur. Le palier 500 profilé s'arrête ensuite au pic de **56 attentes SQL**, pour une limite inchangée de 50 ; l'autre API culmine à 45. Rapport privé : `tmp/load-results/journeys-2026-11-23T11-36-29-975Z/report.json`. Le profilage ajoute une charge de mesure : ce passage ne constitue pas une comparaison de capacité avec le passage non profilé précédent.

Les transactions terminées, cumulées sur les deux API jusqu'à la dernière collecte avant l'arrêt, donnent :

| Traitement | Transactions | Durée moyenne | Maximum | Commandes SQL moyennes par transaction |
| --- | ---: | ---: | ---: | ---: |
| Attribution ou progression du dispatch `advance` | 437 | 88,49 ms | 309,15 ms | 7,35 |
| Accusé de réception `acknowledgeNotification` | 334 | 85,22 ms | 476,52 ms | 7,55 |
| Réponse d'un conducteur `respond` | 169 | 125,33 ms | 476,05 ms | 9,25 |
| Préparation de l'alerte temps réel | 341 | 50,58 ms | 519,27 ms | 5,60 |
| Préparation de la notification push | 364 | 46,29 ms | 260,10 ms | 5,12 |

Ces cinq familles représentent 154,19 secondes, soit 40,02 % des 385,30 secondes cumulées d'occupation de connexions terminées sur le passage complet, préparation comprise. Ce total additionne plusieurs connexions parallèles, pas du temps utilisateur. Pour ces transactions, seulement 0,35 à 1,65 % de leur durée est située entre les appels de requête : l'observation n'indique pas un long traitement applicatif sans requête à l'intérieur de ces transactions.

À 12 h 38 min 22 s (Kinshasa), une capture relève huit liens d'attente impliquant la lecture verrouillée des demandes et un accusé de réception en cours ; les transactions bloquantes atteignent 216,68 ms. Ce sont des liens dans une chaîne, pas huit bloqueurs indépendants. La famille ORM tronquée a été rapprochée de la requête générée hors connexion pour `TripRequest` : le préfixe de 1 023 octets et l'empreinte complète correspondent à la lecture `findOne` verrouillée utilisée dans `advance` et `respond`. Le temps moyen après acquisition de connexion de cette lecture est de 66,60 ms pour `respond`. La lecture verrouillée de `startReceivedResponseWindow` atteint 38,63 ms en moyenne. La validation SQL des candidats à réserver atteint aussi 82,23 ms après acquisition, sur 116 appels ; un plan d'exécution dédié reste nécessaire pour distinguer son coût SQL des autres composantes de cette durée.

Au bilan de l'essai, les 11 098 positions sont confirmées et reçues par l'autre client sans erreur, avec une borne supérieure du p95 de 200 ms. Il y a 450 récupérations et aucune dépose avant l'arrêt. Sur 126 demandes créées, 120 ont une offre ; 342 alertes sont observées et confirmées sur 480 offres. La cohorte n'est pas clôturée : aucune conclusion de livraison exhaustive ou de perte n'est tirée. Zéro erreur SQL, worker ou transport Redis, zéro éviction ; 264 travaux de progression attendent, le plus ancien depuis 2,77 secondes. Le nettoyage des ressources jetables réussit.

Les prochaines corrections à vérifier séparément sont :

1. Permettre aux accusés de conducteurs différents de coexister sur une demande, en étudiant un verrou partagé sur la demande tout en gardant le verrou exclusif de chaque offre. Annulation, refus, expiration, acceptation unique et rejeu des reçus doivent rester couverts par des tests concurrents avant toute modification métier.
2. Réduire les allers-retours des transactions d'attribution et de réponse, puis examiner le plan SQL de validation des candidats sur un jeu équivalent au palier 500.
3. Réduire les préparations répétées entre temps réel et push sans réutiliser de droits périmés ni supprimer les reçus, les alertes ou leur reprise après incident. Redis ne doit pas remplacer les décisions transactionnelles en base.

Les 33 tests PostgreSQL, dont un blocage réel et le comportement des savepoints, et les 86 tests du banc passent. Ils couvrent aussi la restitution des connexions, le rollback après échec de commit, les appels concurrents et la confidentialité des rapports. Aucun changement AWS, de pool, de schéma applicatif ou de cadence GPS n'est appliqué. Le scénario court est conservé dans `tmp/load-results/journeys-2026-11-23T11-32-38-278Z/report.json`.

### Accusés concurrents et nouvel essai à 500 trajets du 23 novembre

Les accusés de réception de conducteurs différents partagent désormais le verrou de lecture de la demande (`FOR SHARE`). Chaque offre conserve son verrou exclusif. L'ordre demande → offre → télémétrie et les délais restent inchangés. Une acceptation, une annulation ou une mise à jour ordinaire de la demande reste incompatible avec ce verrou partagé ; il ne faut pas le remplacer par `FOR KEY SHARE`, qui permettrait certaines mises à jour concurrentes. Voir la [matrice des verrous de ligne PostgreSQL](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS).

Dix nouveaux tests sur PostgreSQL réel vérifient la progression indépendante des quatre accusés, le rejeu d'une même offre après commit ou rollback, l'acceptation unique, l'annulation, l'expiration et le rollback conjoint du délai et du reçu si son écriture échoue. Ils exécutent la véritable méthode d'accusé et observent les attentes avec `pg_blocking_pids` avant de libérer le verrou. La suite d'attribution passe avec 111 tests et trois scénarios optionnels ignorés ; les suites tracking/notifications passent avec 57 tests, et le banc avec 86 tests. La vérification TypeScript complète et le build passent aussi après correction de quatre annotations de type dans les tests existants.

Le scénario mixte court passe : cinq récupérations et cinq déposes automatiques, huit demandes avec une offre, 302 positions GPS confirmées et reçues par l'autre client, et les 60 alertes de la cohorte observées et confirmées. Zéro doublon, zéro alerte manquante et pic d'attente SQL de trois par API. Rapport privé : `tmp/load-results/journeys-2026-11-23T12-06-39-365Z/report.json`.

L'essai mixte à 500 trajets commence à 13 h 10 (Kinshasa) et s'arrête à 13 h 13 sur `inflight_quota`. Le plafond global de 64 traitements WebSocket simultanés est atteint sur la seconde API : six opérations GPS sont refusées, aucune au titre du plafond individuel. **Le palier 500 n'est toujours pas validé.**

| Mesure | Résultat de cet essai |
| --- | ---: |
| Récupérations automatiques | 500 sur 500 |
| Déposes avant arrêt | 0 |
| Demandes créées / avec offre | 490 / 486 |
| Offres / alertes observées et confirmées | 2 076 / 1 541 |
| GPS envoyés / confirmés et reçus par l'autre client | 19 740 / 19 734 |
| Attente SQL lors de la capture immédiate, API 1 / API 2 | 10 / 68 |
| Pic d'attente SQL final, API 1 / API 2 | 39 / 85 |
| File de progression lors de la capture | 146 travaux, ancienneté maximale 1,41 s |
| Erreurs SQL, worker, transport Redis et évictions | 0 |

La capture survient entre deux collectes périodiques : le refus WebSocket est la première erreur remontée, mais l'attente SQL dépasse également le seuil de 50 à cet instant. Le pic de 85 est relevé pendant la vidange après l'arrêt. Les six opérations GPS refusées restent comptabilisées comme échecs ; aucune relance ne les masque. La borne supérieure du p95 des GPS confirmés est de 200 ms, ce qui ne compense pas ces refus. La cohorte des alertes n'est pas clôturée : les 535 offres sans observation à l'arrêt ne permettent pas de conclure à une perte ou à une livraison ultérieure.

La durée moyenne des transactions d'accusé terminées avant la dernière collecte est de 67,60 ms sur 1 457 transactions, contre 85,22 ms sur 334 transactions dans le précédent essai profilé. La lecture verrouillée de la demande prend en moyenne 21,99 ms après acquisition de connexion, contre 38,63 ms. Ces passages couvrent des charges et des durées observées différentes : la baisse observée ne constitue pas une certification de capacité ni une mesure isolée du gain causal.

Au moment de l'incident, 40 lectures GPS attendent encore une connexion sur la seconde API. Celle-ci enregistre aussi un retard maximal de boucle événementielle de 360,97 ms ; la plus longue pause GC mesurée est de 45,43 ms. La capture PostgreSQL montre six connexions inactives dans une transaction et quatorze inactives, sans lien de blocage SQL à cet instant. Cela ne prouve pas que PostgreSQL était exempt de contention avant la capture, ni que le GC explique la pause. La prochaine investigation doit corréler un profil CPU borné de l'API avec ces attentes, puis réduire les allers-retours d'attribution et de préparation des notifications, sans augmenter les plafonds pour rendre le test vert.

Les deux essais utilisent deux API natives Windows sans limite CPU équivalente à Fargate, dix connexions SQL par API et Redis local de 128 Mio. GPS toutes les cinq secondes, seuils SQL et WebSocket, permissions et règles métier sont conservés. Le nettoyage des ressources jetables réussit sans erreur. Aucun déploiement AWS ni passage à 750/1 000 n'est effectué. Rapport privé du palier : `tmp/load-results/journeys-2026-11-23T12-10-20-442Z/report.json`.

### Profilage des API et lecture du destinataire push du 23 novembre

Le profil CPU local est limité à 90 secondes, sans port de débogage ni export de SQL, de paramètres ou de jetons. L'essai diagnostique à 500 trajets s'arrête sur un pic de 52 requêtes en attente SQL sur la seconde API, contre un plafond de 50. Aucun rejet WebSocket ni erreur SQL, worker ou transport Redis n'est constaté. Les 63 228 positions émises sont confirmées et reçues par l'autre client ; les 500 récupérations sont réalisées, mais la phase de dépose n'est pas atteinte. Les 500 demandes ont une offre, avec 4 763 alertes confirmées sur 5 103 offres. La cohorte n'étant pas clôturée, cette différence ne démontre pas une perte. Rapport privé : `tmp/load-results/journeys-2026-11-23T12-21-42-980Z/report.json`.

Le profil échantillonné fait apparaître la validation `getTargetValidationMetadatas` (2,19 et 2,44 secondes), la préparation des colonnes PostgreSQL `addFields` (environ 1,99 seconde par API), et la construction des requêtes ORM. Les temps échantillonnés incluent l'attente et ne sont pas des mesures exactes de CPU. En particulier, les 9 secondes dans `writev` ne prouvent ni une saturation réseau ni un problème de logs. L'arrêt du profileur apparaît lui-même dans les échantillons, autour de 367 ms : il faut tenir compte de ce coût d'observation. Les pauses maximales de boucle de 206,83 et 386,92 ms ne sont pas expliquées par les seuls maxima GC de 28,48 et 55,53 ms.

L'occupation des connexions attribue environ 98 % du temps des transactions aux appels SQL en cours, et environ 2 % aux intervalles entre ces appels. Le temps des appels inclut les échanges client, les attentes et le décodage ; il ne représente pas le temps CPU de PostgreSQL. L'attribution des offres et les accusés restent les premiers postes d'occupation. Un doublon de lecture est confirmé dans la préparation des push : 6 969 lectures du destinataire, suivies d'autant de comptages des propriétaires du jeton.

`read-push-recipient.ts` remplace cette paire par une seule instruction paramétrée. Elle lit le rôle, l'activation, le statut et le jeton actuels, et vérifie l'absence d'un autre propriétaire avec `NOT EXISTS`. Aucun droit ni jeton n'est mis en cache. Le contrôle reste présent sans index unique, inclut les comptes désactivés et refuse les valeurs historiques entourées d'espaces plutôt que de les transformer en jeton d'un autre compte. Les contrôles de demande annulée, d'auto-notification, de délai de sonnerie et de propriété du travail de livraison restent inchangés.

Les 418 tests de notifications exécutés passent, avec 31 tests ignorés par cette configuration. Ils comprennent neuf nouveaux cas sur PostgreSQL isolé : lecture unique, changement de jeton, suppression du compte, jeton partagé sans index unique, valeurs non canoniques, changement de rôle/activation/suspension et échec SQL. Les 86 tests supplémentaires de suivi GPS et d'outbox transactionnelle passent également, ainsi que la vérification TypeScript complète et le build.

Le scénario mixte court après correctif passe : cinq récupérations, cinq déposes, huit demandes avec offre, 302 positions confirmées et reçues par le pair, et les 60 alertes de la cohorte observées et confirmées. Aucun doublon ni alerte manquante ; pic d'attente SQL de trois par API. Le profil SQL contient une lecture utilisateur par préparation, au lieu de deux. Rapport privé : `tmp/load-results/journeys-2026-11-23T12-35-45-690Z/report.json`.

### Résultat à 500 trajets après fusion de la lecture push

L'essai du 23 novembre de 13 h 39 à 13 h 47 (Kinshasa) termine le scénario local et ses contrôles de sécurité (`localScenarioPassed=true`). Les deux API gardent dix connexions SQL chacune, le GPS toutes les cinq secondes et les mêmes plafonds d'attente et de concurrence. Les mesures SQL et tracking sont actives, mais pas le profil CPU additionnel. Les 500 trajets restent simultanément actifs pendant 300 secondes, avec les 60 000 positions prévues sur ce palier.

| Mesure | Résultat |
| --- | ---: |
| Récupérations et déposes automatiques | 500 et 500 |
| Demandes créées, avec offre et vues en temps réel | 500 |
| GPS reçus par l'autre client sur le scénario complet | 73 630 |
| GPS supplémentaires refusés avec état terminal récupérable | 18 |
| Borne supérieure du p95 GPS, accusés et réception par le pair | 100 ms |
| Pic d'attente SQL par API, plafond 50 | 37 et 37 |
| Pic de traitements WebSocket par API, plafond 64 | 27 et 31 |
| Erreurs GPS, SQL, worker, Redis, rejets de quota et évictions | 0 |
| Alertes observées et confirmées | 5 733 |
| Doublons d'offre, doubles acceptations et dépassements de vague | 0 |
| Première allocation SQL, p95 sur 500 demandes | 7,09 s |
| Création d'alerte jusqu'à son accusé client, p95 | 1,64 s |

Les 73 648 opérations GPS sont donc toutes comptabilisées : 73 630 transmises et 18 réponses terminales, sans compter deux sondes terminales supplémentaires qui sont également refusées correctement. La file de progression est vide à la fin. Les comptes de comportement couvrent 245 acceptations, 117 refus, 2 140 alertes ignorées, 120 annulations et 444 conflits attendus lors d'actions devenues obsolètes. Le profil relève 8 973 lectures fusionnées de destinataire push, sans le second comptage. Ce passage complet ne permet pas d'attribuer à ce seul correctif toute la différence de latence entre essais : la dynamique des offres varie et le profil CPU additionnel n'est pas actif.

**La livraison exhaustive des alertes reste à confirmer avant 750 trajets.** La cohorte contient 6 021 offres : 5 733 alertes sont observées et confirmées, 286 offres non observées sont déjà obsolètes, et deux ne sont pas obsolètes au moment de la capture. Aucune notification associée ne manque en base et aucun reçu ne manque pour une alerte observée. Huit autres offres sont créées après la capture. Le banc ne relève pas l'âge des deux offres non observées : il ne permet pas de distinguer une invitation créée juste avant la fermeture de l'observation d'un retard anormal. Le succès des contrôles du scénario ne doit donc pas être présenté comme une preuve de livraison de toutes les offres. La prochaine répétition doit disposer d'une fenêtre d'observation bornée pour une cohorte figée, en tenant compte des annulations et expirations survenues pendant cette fenêtre.

Les 86 tests du banc passent aussi, soit 590 tests ciblés réussis au total pour ce correctif. Les ressources jetables sont nettoyées sans erreur. Il n'y a ni changement AWS, ni augmentation des seuils, ni exécution à 750 ou 1 000 trajets. Les API natives Windows restent sans limites CPU équivalentes à Fargate et les services de push sont simulés ; ce résultat ne certifie pas la capacité de production. Rapport privé : `tmp/load-results/journeys-2026-11-23T12-39-49-575Z/report.json`.

### Préparation du palier mixte à 750 du 23 novembre

La découverte des conducteurs appliquait les exclusions des invitations existantes après la réunion des conducteurs disponibles et des conducteurs en trajet. Un `EXPLAIN ANALYZE` sur une base locale jetable de 750 trajets, 750 conducteurs disponibles et 1 000 invitations en attente montre une boucle d'exclusion parcourant en moyenne 667 invitations pour chacun des 1 500 candidats. Le contrôle de disponibilité domine alors le coût de cette requête.

Les deux mêmes exclusions sont désormais placées dans chaque branche de découverte : ne pas réinviter un conducteur déjà sollicité pour cette demande et ne pas solliciter un conducteur qui détient une invitation en attente. Sur les mêmes données, les trois mesures d'exécution passent de 87,262 / 83,337 / 83,378 ms à 45,825 / 47,894 / 44,409 ms. Les 50 candidats retournés, leur ordre et leurs attributs sont identiques. Les temps de planification passent d'environ 3 ms à 6–8 ms. Ce profil SQL sans charge concurrente ne prédit pas à lui seul le délai de première offre du scénario complet.

La réservation conserve ses validations fraîches sous verrous SQL, ses vagues de quatre et son outbox transactionnelle. Aucun droit, disponibilité ou état KYC n'est mis en cache. Aucun index ni changement de schéma n'est nécessaire.

Le contrôle de fin de test fige désormais la cohorte avant les 20 secondes d'observation finale, puis prend l'état des offres avant de fermer les écouteurs. Les alertes observées doivent avoir un reçu en base. Une invitation encore valable au début de cette fenêtre, non observée et seulement expirée ensuite, fait échouer le test. Les annulations, refus et acceptations intervenus pendant l'observation sont comptés séparément, sans être présentés comme des livraisons. Les invitations déjà obsolètes à la capture et les offres créées ensuite restent explicitement distinguées : ce contrôle porte sur une cohorte bornée, pas sur une livraison exhaustive de tout l'historique.

Le profil `stage-750-mixed` prévoit 750 trajets actifs pendant 300 secondes, 750 demandes sur 60 secondes, 750 conducteurs disponibles et 4 500 connexions Socket.IO réparties sur trois API. Le GPS reste à cinq secondes, soit 300 positions par seconde. Les plafonds SQL, WebSocket, file de progression et générateur restent ceux du palier 500. Le passage de deux à trois API constitue une augmentation de ressources, pas un gain logiciel à ressources constantes.

### Répétition à 500 avec contrôle des alertes renforcé

Le scénario mixte du 23 novembre de 14 h 05 à 14 h 13 (Kinshasa) passe avec deux API natives, dix connexions SQL par API et les seuils inchangés. Il réalise 500 récupérations, 500 déposes et 500 demandes ayant toutes une offre observée en temps réel. La phase soutenue émet 60 006 positions en 300 secondes ; le scénario complet compte 74 038 transmissions GPS au pair et huit réponses terminales correctement refusées. La borne supérieure du p95 GPS reste de 100 ms pour les accusés et la réception par le pair, sans échec.

Les pics d'attente SQL sont de 47 et 39, proches du plafond de 50 sur la première API ; les pics WebSocket sont de 40 et 38 pour un plafond de 64. Aucun rejet de quota, erreur SQL/worker/transport Redis ou doublon métier n'est relevé. La file de progression est vide à la fin.

La première allocation atteint un p95 de 6,183 secondes, mais son maximum est de 20,945 secondes : la latence de première offre n'est donc pas résolue par la seule optimisation de découverte. Le p95 entre création de notification et reçu client est de 1,677 seconde. La dynamique des offres diffère de l'essai précédent, ce qui empêche d'attribuer toute variation au seul changement SQL.

La cohorte figée contient 5 736 offres : 5 428 alertes observées et confirmées, 308 invitations déjà obsolètes à la capture, aucune notification absente, aucune invitation non obsolète non observée et aucun reçu manquant. Les 143 offres créées après la capture sont hors de cette cohorte ; 138 sont observées avant la fermeture. Au total, les 5 566 alertes observées ont toutes un reçu. Le contrôle ne certifie pas la livraison des cinq offres tardives non observées.

Les 127 tests ciblés de dispatch passent, avec trois cas ignorés par leur configuration, ainsi que les 91 tests du banc, le build et la vérification TypeScript complète. Le nettoyage du laboratoire réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T13-05-06-435Z/report.json`.

### Arrêt du palier 750 et limite actuellement observée

L'essai du 23 novembre de 14 h 13 à 14 h 16 (Kinshasa) démarre trois API natives et atteint la phase soutenue avec 750 trajets. Il s'arrête immédiatement après le début des créations de demandes : le générateur compte 127 opérations en vol et refuse d'ajouter la paire GPS suivante au-delà de son plafond de 128. Le retard maximal du planificateur est de 81,43 ms, loin de son seuil d'une seconde ; ce n'est pas un arrêt pour retard de planification.

La capture déclenchée au premier échec relève une concentration de l'attente sur la première API : 67 attentes SQL au pic pour un plafond de 50, 64 traitements WebSocket actifs et six rejets de quota global. Les deux autres API ont des pics SQL de 10 et 7. Le pic SQL de la première monte ensuite à 72 pendant la vidange ; cette mesure ultérieure ne remplace pas la capture initiale. Les phases GPS montrent notamment des lectures attendant leur connexion depuis environ 391 ms sur cette API. Son maximum de boucle d'événements est de 405,54 ms, contre 290,72 et 50,76 ms sur les autres API.

Le relevé PostgreSQL trouve 24 connexions inactives, trois inactives dans une transaction et deux actives, sans blocage de verrou identifié à cet instant. Redis est disponible, sans éviction ni erreur de transport ; le plus ancien travail de progression attend 1,406 seconde. Le générateur conserve au moins 2 563 Mio de mémoire hôte libre dans ses relevés. Ces observations orientent l'investigation vers les pauses d'une API et la rétention de ses connexions, plutôt que vers une saturation globale démontrée de PostgreSQL ou Redis. Elles ne suffisent pas à attribuer la pause à une fonction précise ou au GC.

Après vidange, 20 204 des 20 210 positions envoyées ont été reçues par le pair ; les six autres correspondent aux rejets constatés. Les 676 récupérations réalisées et les 14 demandes ayant une offre ne valident pas le scénario attendu : aucune dépose et aucune cohorte d'alertes clôturée ne sont testées. Les offres créées après l'arrêt de l'observation ne constituent pas une preuve de livraison. Le nettoyage des ressources jetables réussit sans erreur.

**Le palier 750 n'est pas validé.** Le dernier scénario complet réussi reste 500 avec deux API natives. La prochaine investigation doit capturer la pile CPU et les traitements synchrones autour des premières créations de demandes, puis corréler la pause API, la libération des connexions SQL et les traitements GPS. Ne pas augmenter le pool, le plafond WebSocket ou celui du générateur pour masquer cet arrêt. Aucun déploiement AWS n'est effectué et ces API Windows sans limite CPU Fargate ne certifient aucune capacité de production. Rapport privé : `tmp/load-results/journeys-2026-11-23T13-13-34-131Z/report.json`.

### Diagnostic CPU au palier 750 le 23 novembre 2026

Le démarrage du profileur à pleine charge constitue lui-même une perturbation. Lors de l'essai de 14 h 25 à 14 h 28 (Kinshasa), `Profiler.start` occupe 515,8 à 581,3 ms selon l'API. Le générateur attend la fin de cette commande puis tente de rattraper les positions dues : son plafond de 128 est atteint avant la première demande. Cet arrêt ne mesure donc pas la capacité métier. Rapport privé : `tmp/load-results/journeys-2026-11-23T13-25-30-146Z/report.json`.

Le banc démarre désormais le profileur après la connexion des destinataires d'alertes, **avant le premier GPS**. Sa fenêtre maximale de 180 secondes inclut la montée en charge ; ses horodatages permettent de vérifier les phases effectivement couvertes. Le rapport conserve les durées de démarrage et d'arrêt, les 40 principales fonctions et les 12 plus longs intervalles d'échantillonnage, avec au plus 12 cadres de pile et sans chemins absolus ni arguments. Une pile observée à la fin d'un intervalle ne prouve pas que cette fonction a causé toute l'attente.

Le second diagnostic, de 14 h 30 à 14 h 33, atteint 30 demandes avant un refus d'admission d'accusé d'alerte au plafond de 128 opérations. À cet instant, 104 opérations GPS, 14 créations, six réponses conducteurs, trois positions de conducteurs disponibles et un accusé d'alerte sont en cours. Les pools culminent à 30, 23 et 26 attentes ; aucun rejet WebSocket n'est enregistré. Les 22 710 positions envoyées sont toutes reçues après vidange, mais l'arrêt empêche de valider les déposes et la cohorte finale d'alertes.

La pause de 406 ms du passage précédent n'est pas reproduite à l'identique. Le relevé PostgreSQL montre cette fois deux attentes de verrou, jusqu'à 471 ms, liées à la sérialisation des réponses sur une demande ; une transaction bloqueuse a 511 ms d'ancienneté. Trois sélections de candidats sont également actives, jusqu'à 255 ms. Dans une base jetable séparée et sans trafic concurrent, la découverte prend 25,9 à 45,1 ms et la vérification verrouillée de quatre candidats 0,41 à 0,50 ms, hors planification. Ces mesures ne permettent pas d'attribuer toutes les latences à une seule requête.

Les lectures du statut KYC passager et de la reprise d'acceptation sont réduites aux colonnes effectivement consommées. Les lignes restent relues en base ; le verrou de trajet, le choix du conducteur, le prix, le véhicule, l'exigence KYC et les écritures de notification sont conservés. Aucun cache de permission ni changement de cadence GPS n'est introduit. Une comparaison de 40 lectures KYC alternées par variante, sur une base jetable sans charge, donne une moyenne de 1,410 ms pour la lecture complète contre 0,928 ms pour la projection ; les p95 sont respectivement de 2,356 et 1,217 ms. Ce gain isolé ne prouve pas la résolution de la pause ni la capacité à 750 trajets. Rapport du second diagnostic : `tmp/load-results/journeys-2026-11-23T13-30-11-202Z/report.json`.

### Contre-essais sans profileur CPU après les projections SQL

Deux essais supplémentaires conservent trois API, un pool de dix connexions par API, le GPS toutes les cinq secondes et les mêmes plafonds d'admission. Les diagnostics SQL et tracking restent actifs : ces mesures Windows natives, sans quotas CPU Fargate, ne certifient pas la capacité de production.

| Essai du 23 novembre, heure de Kinshasa | Observation à l'arrêt | Résultat |
| --- | --- | --- |
| 14 h 44–14 h 47 | 63 demandes tentées ; pics d'attente SQL de 69, 58 et 52 ; pause de boucle API jusqu'à 620 ms ; 11 refus WebSocket sur l'API la plus retardée | Arrêt au plafond du générateur ; scénario incomplet |
| 14 h 49–14 h 53 | 18 demandes tentées ; pic de 66 attentes SQL sur une API ; trois refus WebSocket ; attente de verrou PostgreSQL jusqu'à 718 ms et transaction bloqueuse inactive depuis 766 ms | Arrêt `inflight_quota` ; scénario incomplet |

La pause de 620 ms du premier contre-essai ne coïncide pas avec un GC de durée équivalente : le plus long GC de cette API atteint 60 ms et son intervalle de surveillance le plus retardé consomme environ 21 % d'un cœur. Cela ne suffit pas à identifier la fonction responsable ni à exclure un effet d'ordonnancement de la machine hôte.

Le second contre-essai ajoute une observation bornée de la soumission synchrone des écritures socket, uniquement dans le banc local. Les callbacks, retours et exceptions sont conservés ; aucun paquet, SQL, port ou adresse n'est exporté. Sur l'API touchée, les maxima sont de 31 ms vers les clients et 27 ms vers PostgreSQL. La pause de 620 ms n'est pas reproduite : les trois API culminent entre 110 et 193 ms. Les écritures mesurées ne démontrent donc pas, à elles seules, la cause de l'arrêt.

À ce dernier arrêt, PostgreSQL compte notamment sept connexions inactives dans une transaction et trois attentes de verrou. Les opérations d'acceptation et d'avancement de demande retiennent des connexions pendant que les opérations GPS attendent leur admission. La file de progression contient 108 travaux, dont le plus ancien attend 0,852 seconde. Après vidange, 21 147 des 21 150 positions sont reçues par le pair ; les trois manquantes correspondent aux refus. Les 703 récupérations et 18 demandes avec offre, sans dépose ni clôture complète des alertes, **ne valident pas le palier 750**.

Les projections SQL apportent un gain isolé mesuré, mais sont insuffisantes pour ce palier. La prochaine optimisation doit réduire le nombre d'allers-retours et la durée des transactions de dispatch, d'acceptation et d'accusé d'alerte, en conservant le choix atomique du conducteur, les contrôles d'autorisation et les écritures durables de notification. Ne pas augmenter les plafonds ou espacer le GPS pour rendre le test vert. Le dernier scénario complet réussi enregistré reste celui de 500 trajets avec deux API, avant ces projections ; aucun résultat n'est présenté comme une nouvelle certification de ce palier.

Les deux essais nettoient leurs bases jetables sans erreur. Aucun changement AWS, aucun envoi réel de notification, SMS ou paiement. Rapports privés : `tmp/load-results/journeys-2026-11-23T13-44-22-536Z/report.json` et `tmp/load-results/journeys-2026-11-23T13-49-41-307Z/report.json`.

Vérifications après les modifications : 94 tests du banc réussis ; trois suites métier réussies avec 163 tests passés et trois ignorés, dont les tests PostgreSQL/Redis jetables de dispatch, de reprise d'acceptation et de KYC ; compilation Nest et vérification TypeScript sans erreur. Les assertions vérifient notamment la fraîcheur du statut KYC, l'absence de chargement du profil et des médias, ainsi que la conservation du véhicule, du prix et de l'exigence KYC lors d'une reprise. Ces résultats de non-régression ne remplacent pas la réussite du scénario complet à 750.

### Réduction des allers-retours dans les transactions de dispatch

Les optimisations suivantes du 23 novembre regroupent uniquement des écritures indépendantes ou des lectures protégées par le même verrou. Elles ne changent ni le pool, ni la cadence GPS, ni les plafonds de concurrence. Aucun changement de schéma n'est nécessaire pour ces correctifs.

| Chemin | Avant | Après | Garantie conservée |
| --- | --- | --- | --- |
| Accusé d'une invitation séquentielle encore valable | 6 instructions SQL | 4 | Verrou partagé de la demande, puis lecture fraîche et verrou exclusif de l'offre ; télémétrie et réception de sonnerie atomiques |
| Enregistrement d'un refus | 3 | 1 | Exclusion du conducteur, libération de sa priorité et retrait des notifications dans la transaction appelante |
| Finalisation d'acceptation | 7 | 4 | Réservation confirmée exigée, sélection atomique, clôture des offres concurrentes et notification durable |
| Lecture d'échéance et d'historique avant une première offre | 2 | 1 | Verrou de demande conservé et historique ignoré tant qu'une vague est active |
| Écriture des échéances réelles et de la présence après insertion d'une vague immédiate | 2 | 1 | Échéance relue après les triggers d'insertion ; aucune présence modifiée pour un trajet partagé |

Les nombres excluent `BEGIN` et `COMMIT` et ne sont pas des pourcentages de gain de latence. Les anciens accusés sans verrou de demande gardent une instruction distincte pour relire la validité de la sonnerie après une éventuelle attente sur la télémétrie. Les JSON historiques malformés ne sont pas convertis aveuglément en UUID. Les tests vérifient les comptes d'instructions, les reprises, les annulations concurrentes, les refus d'un autre compte et le rollback complet lorsqu'une écriture de télémétrie ou de sonnerie échoue.

La suite finale de dispatch séquentiel, réservation des vagues et échéances passe avec 132 tests réussis et trois ignorés. Les vérifications précédentes de cette intervention incluent 333 tests réussis sur cinq suites métier et 29 tests PostgreSQL de sonnerie/télémétrie. Les 99 tests du banc (dont cinq contrôles de fuseau), la compilation Nest et TypeScript passent également. Les ressources de ces tests sont locales et jetables.

### Contre-essais à 750 après regroupement des transactions

**Rectification : les trois essais de 15 h 17, 15 h 23 et 15 h 28 ont des fuseaux incohérents.** Ils restent conservés comme diagnostics d'échec, mais ne constituent pas une comparaison de capacité valide : le générateur et PostgreSQL utilisaient UTC alors que les API enfants conservaient le fuseau Windows de Kinshasa. Le décodage des colonnes `timestamp without time zone` décalait les dates d'une heure. Une notification nouvellement créée était ainsi journalisée avec `ageMs=3613494` ; aucun accusé d'alerte n'était observé. Cela invalide la représentativité des comportements mixtes, sans établir à lui seul la cause de toutes les pauses et saturations.

Le passage instrumenté de 15 h 17 à 15 h 21, heure de Kinshasa, s'arrête après 33 créations tentées au plafond de 128 opérations du générateur. À l'arrêt, 112 opérations GPS et 13 créations sont encore en cours. Le pic d'attente SQL atteint 67 sur une API. Les 22 034 positions sont toutes reçues après vidange, sans rejet WebSocket, mais aucune dépose ni cohorte finale d'alertes ne peut être validée. Le relevé observe aussi deux attentes de verrou sur la préparation de sonnerie, jusqu'à 332 ms ; ce relevé ponctuel n'attribue pas toutes les latences à cette seule transaction.

Un témoin de 15 h 23 à 15 h 26 conserve exactement le même code et les mêmes seuils, sans les options de profilage SQL et tracking. Il échoue lui aussi, cette fois après 36 créations tentées, avec 72 attentes SQL au maximum sur une API et 14 rejets WebSocket. Après vidange, 21 622 des 21 636 positions sont reçues. Aucune erreur SQL, erreur de worker ou éviction Redis n'est enregistrée ; cela ne compense pas les refus et l'inachèvement du scénario. Le défaut de fuseau commun aux deux essais empêche d'en déduire une comparaison fiable de l'effet du profilage.

**750 reste non validé.** Les réductions de requêtes sont vérifiées, mais ces essais ne démontrent pas un gain de capacité ni un gain de latence comparable, puisque les cohortes sont interrompues à des points différents. Aucun plafond n'est relevé et aucune notification durable n'est supprimée pour contourner la saturation. Les deux nettoyages réussissent sans erreur. Rapports privés : `tmp/load-results/journeys-2026-11-23T14-17-50-581Z/report.json` et `tmp/load-results/journeys-2026-11-23T14-23-17-326Z/report.json`.

Le troisième essai, à 500 de 15 h 28 à 15 h 30, s'arrête lui aussi : deux refus WebSocket, 61 attentes SQL au maximum, 9 520 positions reçues sur 9 522, 71 créations tentées et aucun accusé d'alerte. Son nettoyage réussit. Rapport privé : `tmp/load-results/journeys-2026-11-23T14-28-10-238Z/report.json`. Il ne remplace pas la validation antérieure à 500 par une mesure comparable ; un contrôle cohérent des fuseaux est nécessaire avant toute nouvelle conclusion.

### Précontrôle des fuseaux du laboratoire

Le lanceur fixe désormais `TZ=UTC` avant le chargement du banc. La liste blanche d'environnement transmet explicitement ce réglage aux API natives et conteneurisées, sans importer `.env` ni les accès AWS. Le démarrage vérifie sur le générateur et chaque API que `CURRENT_TIMESTAMP` et `LOCALTIMESTAMP`, décodés par le vrai pilote PostgreSQL, représentent exactement le même instant, et que Node et la session PostgreSQL sont en UTC. Une preuve manquante, invalide ou décalée bloque le test avant les connexions utilisateur. Les preuves sont enregistrées sous `timeAlignment` dans le rapport. Aucun fuseau de production ni schéma applicatif n'est modifié.

Le premier scénario après correction (`mixed-smoke`, démarré à 15 h 37 heure de Kinshasa) est entièrement validé : cinq récupérations et déposes automatiques, 302 positions émises/reçues, huit demandes proposées, 60 alertes reçues et 60 accusés en base. Les comportements accepter/refuser/ignorer/annuler sont exercés ; aucune double acceptation ni violation de vague. Les 56 offres de la cohorte finale sont observées et confirmées ; quatre offres ultérieures sont comptées séparément. Le générateur et les deux API attestent un décalage de zéro milliseconde. Nettoyage sans erreur. Il s'agit d'une validation fonctionnelle locale, pas de capacité. Rapport privé : `tmp/load-results/journeys-2026-11-23T14-37-07-234Z/report.json`.

### Reprise à 500 avec fuseaux vérifiés

Le passage sans profilage détaillé de 15 h 41 à 15 h 43 est arrêté par le seuil d'attente SQL : **64 opérations en attente au pic sur une API pour un plafond de 50** (31 sur l'autre). Les deux pools restent à dix connexions. Ce n'est ni le plafond du générateur (pic 102/128), ni le retard d'émission (maximum 41 ms), ni un refus WebSocket qui déclenche cet arrêt.

À l'arrêt, 10 180 positions sont émises et finalement reçues, 118 créations sont tentées, 116 demandes ont des offres, 362 alertes sont reçues et leurs 362 accusés enregistrés. Les réponses incluent 51 acceptations, 21 refus et 27 annulations ; aucune double acceptation. Le scénario s'interrompt avant les déposes et la réconciliation finale des alertes : on ne peut pas conclure à la livraison complète de toutes les invitations. Aucune erreur SQL/worker ou éviction Redis ; pauses de boucle événementielle maximales de 107 et 151 ms. La file de progression contient 178 travaux, avec 1,93 seconde d'âge maximal au relevé. Les états PostgreSQL montrent notamment des attentes WAL courtes (19 ms au plus dans cet échantillon), insuffisantes pour attribuer le pic passé à une seule requête.

**500 n'est pas revalidé dans ce passage ; 750 n'est pas relancé après cet arrêt.** Les anciens succès restent historiques, pas une garantie pour le code et la machine de ce passage. Le précontrôle UTC a réussi sur le générateur et les deux API. Nettoyage réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T14-41-12-059Z/report.json`.

### Validation complète à 250 et profil SQL après correction

Le scénario `stage-250-mixed --profile-sql` de 15 h 45 à 15 h 52, heure de Kinshasa, réussit avec le code optimisé, les fuseaux vérifiés et les mêmes seuils. Les deux API natives partagent cet hôte avec PostgreSQL, Redis et le générateur ; ce n'est pas une validation Fargate.

| Mesure | Résultat |
| --- | --- |
| Charge stable | 250 trajets pendant 300 secondes ; 250 demandes supplémentaires |
| GPS durant la phase stable | 30 000 émissions, cadence complète |
| GPS sur tout le scénario | 34 780 opérations : 34 772 livraisons au pair et huit refus de trajet déjà terminé, suivis d'une récupération de l'état terminal |
| Progression automatique | 250 récupérations et 250 déposes |
| Demandes proposées | 250/250 ; aucune sans offre |
| Alertes | 3 069 reçues et 3 069 accusés persistés |
| p95 GPS, accusés et livraison au pair | Au plus 20 ms, borne de l'histogramme local |
| Première alerte reçue par un conducteur depuis le lancement de la demande | Moyenne 139 ms ; p95 au plus 200 ms, borne d'histogramme |
| Création de la première offre en base | Moyenne 48 ms ; p95 75,8 ms |
| Pic d'attente SQL | 7 sur chacune des deux API, plafond 50 |
| Erreurs SQL/worker, refus de quota WS | Aucun |

Les 2 983 offres capturées pour la vérification finale comprennent 2 977 alertes observées et confirmées, plus six invitations déjà obsolètes avant l'observation. Aucune invitation encore valable n'est manquante. Les 92 offres créées après la capture et observées sont comptées séparément. Aucune double acceptation, offre conducteur en double ni dépassement de taille de vague. Les réponses incluent 122 acceptations, 54 refus et 61 annulations ; les conflits métier attendus restent comptés. Nettoyage sans erreur, base jetable supprimée. Rapport privé : `tmp/load-results/journeys-2026-11-23T14-45-20-147Z/report.json`.

Le profil cumulé des deux API compte 290 884 instructions SQL, préparation comprise. Les plus gros volumes temporels de familles SQL concernent la lecture de progression automatique (18 030 appels, 49,2 s cumulées), la relève des travaux de progression (17 530 appels, 41,8 s) et la persistance GPS passager avec sa file durable (17 386 appels, 38,1 s). Ces durées sont celles du pilote, pas du CPU PostgreSQL ; elles se chevauchent et ne doivent pas être additionnées pour calculer une latence utilisateur. Les transactions d'avancement de demande retiennent une connexion pendant 19,3 ms en moyenne sur 3 097 appels ; les accusés pendant 9,0 ms sur 3 069 appels. Il n'existe pas ici de comparaison avant/après à charge identique permettant d'attribuer un pourcentage de gain aux seuls regroupements SQL.

Ce résultat à 250 a motivé la capture suivante de l'occupation SQL pendant la rafale à 500. Les cibles restent la répétition des lectures de progression et le chevauchement dispatch/accusés/GPS, pas une réduction arbitraire des positions ou des notifications. Tout regroupement ou usage supplémentaire de Redis doit conserver la fraîcheur des autorisations, la progression récupérable après panne et les écritures métier durables. Il faut réussir 500 à nouveau avant 750, puis répéter dans un laboratoire Linux aux limites CPU/RAM explicites avant toute conclusion AWS.

### Capture du pic SQL à 500 et correctif de libération des lots

L'essai instrumenté du 23 novembre à 16 h 00 (Kinshasa) s'est arrêté au garde-fou : pics de **56 et 43 attentes SQL**, pour un plafond de 50. À l'arrêt, 19 190 positions avaient été émises et reçues par le pair, sans refus de quota WebSocket ; 1 488 alertes avaient leur accusé. Les 500 récupérations étaient effectuées, mais pas les déposes : ce n'est pas un scénario complet validé. Aucune erreur SQL ou worker et aucun doublon d'offre/acceptation. Le nettoyage du laboratoire a réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T15-00-39-082Z/report.json`.

Le banc capture désormais les connexions occupées **au moment de l'admission dans la file SQL**, et non seulement lors de la collecte suivante. Il conserve quatre captures au maximum, sans texte SQL ni paramètres. Au pic de 56, une recherche de conducteurs est active depuis environ 270 ms côté pilote, en parallèle des accusés, d'une annulation et du GPS. Sur l'autre API, les captures montrent plusieurs commits et écritures en cours pendant environ 90–104 ms. Ces observations indiquent un chevauchement de travaux ; elles ne prouvent ni que la recherche explique tout le pic, ni que ces durées sont du CPU PostgreSQL.

Le diagnostic reproductible `profile-discovery.cjs --execute-local` crée un autre PostgreSQL jetable : 500 trajets, 500 conducteurs disponibles, 500 demandes et 2 000 invitations synthétiques. Avec les index existants et les statistiques à jour, la recherche prend 18–23 ms d'exécution SQL, plus environ 6–21 ms de planification. La validation de quatre candidats prend moins d'une milliseconde d'exécution, plus 3–4 ms de planification. Ces mesures sont isolées, sans écritures concurrentes ; elles ne constituent pas une mesure de capacité ni une reproduction exacte de la distribution en production.

Un correctif backend regroupe les libérations des baux de balayage de `DriverDispatchService.tick` : jusqu'à 25 écritures deviennent une seule requête. Celle-ci ne libère que les identifiants du lot portant encore son jeton de propriété. `SKIP LOCKED` évite d'attendre une transaction métier ; un bail occupé reste récupérable par son expiration existante de dix secondes. Les tests couvrent un verrou occupé, un bail repris par un autre serveur, une allocation en échec et une panne de libération. Aucun changement de cadence GPS, de destinataires, de délai de réponse aux offres ou de seuil de sécurité. Le gain sous charge doit être évalué par l'essai suivant, pas déduit du seul nombre de requêtes supprimées.

Après ce correctif, l'essai à deux API démarré à 16 h 18 s'est arrêté sur le plafond du générateur : **128 opérations en cours**. Il restait 87 opérations GPS, 17 accusés d'alerte, 15 réponses conducteur, sept créations et deux annulations. L'opération suivante, un accusé d'alerte, a été refusée par le banc ; cela invalide le scénario, même sans erreur backend. Après vidange, les 9 316 positions envoyées étaient toutes reçues par le pair. Le bilan compte 176 alertes reçues et 175 accusés enregistrés, 62 demandes tentées, 405 récupérations et aucune dépose. Les pics SQL finaux sont de 50 et 48 attentes. Aucun refus de quota WebSocket, aucune erreur SQL/worker ni éviction Redis ; nettoyage réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T15-18-32-048Z/report.json`. L'arrêt étant plus précoce, on ne peut pas attribuer la différence de pics SQL au correctif.

Le profil distinct `stage-500-mixed-3api` compare la configuration prévue pour 750 : trois API au lieu de deux, mais toujours 500 trajets, 500 demandes, 500 conducteurs libres, 300 secondes de charge et les mêmes seuils. Le pool de dix connexions et les workers de chaque API restent inchangés ; le budget total passe donc de 20 à 30 connexions. Ce n'est pas une nouvelle validation du profil à deux API. Le test de contrat vérifie que seule la configuration du nombre d'API diffère. Aucun paramètre AWS ou Terraform n'est modifié.

Cette comparaison, démarrée à 16 h 24, échoue également au plafond d'opérations : une paire GPS exige deux places alors que 127 opérations sont encore en cours (pic observé : 128). La file comprend 94 opérations GPS, 12 créations de demande, sept réponses, sept accusés, six positions de conducteurs disponibles et une annulation. Les plus anciennes créations attendent environ deux secondes ; certaines opérations GPS environ 650 ms. Le générateur ne présente pas de retard de cadence supérieur à son seuil : maximum observé 108 ms pour une limite d'une seconde.

Après vidange : **10 050 positions envoyées et reçues**, 225 alertes observées et 225 accusés enregistrés. Seulement 80 demandes sur 500 ont été tentées, 451 passagers sur 500 sont récupérés, aucune dépose n'est terminée : ces comptes ne prouvent pas une couverture complète des alertes ou des trajets. Aucun doublon, aucune erreur SQL/worker, aucun refus de quota WebSocket ni éviction Redis. Pics SQL : 50, 41 et 27 ; file de progression la plus ancienne au relevé d'échec : 2,50 secondes. Une API présente un retard maximal de boucle de 333 ms. Les files SQL sont vides après vidange, et le nettoyage a réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T15-24-12-727Z/report.json`.

**Conclusion de cette reprise :** le regroupement des libérations ne suffit pas et la troisième API locale ne lève pas le blocage. Les opérations GPS, créations et réponses/accusés se chevauchent jusqu'à saturer le budget d'opérations du banc ; les mesures ne permettent pas d'attribuer cette saturation à Redis, ni à une seule requête. La prochaine optimisation doit cibler le travail SQL et applicatif de ces chemins et leur occupation concurrente, avec régression des alertes et de la progression automatique. Ne pas ralentir le GPS, abandonner des notifications ou relever les plafonds pour obtenir un résultat vert. Il faudra aussi distinguer les limites de cet hôte partagé Windows de celles d'un laboratoire Linux aux ressources explicites avant toute conclusion AWS.

Validation du correctif backend : cinq suites réussies, 285 tests réussis et trois tests optionnels ignorés ; compilation Nest et contrôle TypeScript sans émission réussis. Les 103 tests du banc passent, notamment la capture du pic à l'admission et le profil de comparaison à trois API.

## Regroupement des lectures GPS et progression automatique

Le correctif du 23 novembre regroupe les lectures simultanées par repository, pendant un seul tour de boucle événementielle, avec au maximum 32 appels par requête. Il ne conserve aucun résultat en cache et ne rattache jamais un nouvel appel à une requête SQL déjà partie. Les données d'autorisation, statuts et positions restent lues en base ; les écritures conditionnelles et la file durable sont inchangées.

Les lectures passager utilisent des couples `(bookingId, passengerId)` dans SQL, puis une répartition par ce même couple : la réservation d'un autre passager présent dans le lot ne peut pas autoriser l'appelant. Chaque appel reçoit sa propre projection mutable, avec ses dates et valeurs JSON. Les identifiants UUID en majuscules sont normalisés pour retrouver les lignes PostgreSQL. Les deux routes REST d'écriture GPS valident désormais leur identifiant avant le service, afin qu'un identifiant mal formé n'invalide pas le lot des autres utilisateurs ; la validation WebSocket existante reste active.

### Nouveau palier complet à 250

Rapport privé : `tmp/load-results/journeys-2026-11-23T15-41-26-635Z/report.json`. Deux API, profil `stage-250-mixed --profile-sql`, fuseaux UTC vérifiés ; cinq minutes de charge stable, puis arrivée et contrôles finaux.

- 250 demandes créées et proposées ; 250 récupérations et 250 déposes automatiques.
- 34 778 envois GPS au total : 34 770 livraisons au correspondant et huit récupérations terminales attendues. Le p95 des accusés GPS reste dans la borne de 20 ms.
- 3 000 alertes observées et 3 000 accusés. La cohorte finale de 2 914 offres contient 2 906 alertes observées et confirmées et huit offres devenues obsolètes ; aucune alerte non obsolète manquante. Les 94 alertes hors cohorte sont comptées séparément.
- Aucun doublon d'offre ou d'acceptation, aucune erreur SQL/worker, aucun refus de quota WebSocket ni éviction Redis. Pics d'attente SQL : 10 et 15 ; pic du générateur : 43 opérations.
- L'instantané final dénombre 11 391 SELECT de progression pour 18 144 appels de progression, contre un SELECT par appel dans l'ancien relevé. Les lectures GPS conducteur et passager sont respectivement 15 601 et 15 586 pour 17 390 appels chacune. Ces comptes montrent le regroupement, pas un gain de latence équivalent.

La première alerte a une moyenne de 162 ms et un p95 dans la borne de 500 ms ; l'allocation SQL a un p95 de 102 ms. L'ancien essai complet à 250 avait une première alerte moyenne de 139 ms et une borne p95 de 200 ms. Ces essais non simultanés sur hôte partagé ne démontrent donc pas une amélioration globale de latence. Le nettoyage des ressources jetables a réussi.

### Arrêt au palier de 500

Rapport privé : `tmp/load-results/journeys-2026-11-23T15-48-37-040Z/report.json`. Deux API, même profil mixte et mêmes seuils. Arrêt pour `Backend safety gate failed` : pic d'attente SQL de **62** sur une API et **35** sur l'autre, plafond autorisé de 50. Le générateur reste sous son plafond avec un pic de 100 opérations et un retard maximal de 107 ms.

À l'arrêt, 221 demandes sur 500 sont tentées, dont 218 avec offres après le délai d'observation. Les 13 246 positions envoyées ont été livrées au correspondant et les 644 alertes observées ont leurs accusés. Les 500 passagers sont récupérés mais aucune dépose n'a eu lieu : le scénario est incomplet et ne valide ni 500 trajets ni la couverture totale des alertes. La plus ancienne tâche de progression a 3,63 secondes au relevé d'échec, avec 338 tâches en attente. Après observation, les attentes de connexion SQL sont revenues à zéro mais la file de progression contient encore 266 tâches ; ne pas présenter cette file comme entièrement vidée.

Les captures prises lors du pic montrent des transactions `respond` et `advance` retenues environ 400 ms, aux côtés de créations et d'accusés de réception. Elles indiquent où les connexions sont occupées, sans attribuer toute cette durée à la dernière instruction SQL. Le relevé PostgreSQL postérieur ne montre pas de bloqueur à cet instant ; il ne permet pas d'exclure une contention antérieure. Aucun échec SQL/worker, aucune éviction ou erreur de transport Redis, aucun refus de quota WebSocket ni appel externe bloqué. Nettoyage réussi ; aucune ressource AWS modifiée.

La prochaine cible est la réduction des allers-retours et de l'occupation des connexions dans la validation et la réservation des offres, en particulier `DriverDispatchService.respond` et `reserveRequestWave`. La découverte est déjà séparée de la transaction de réservation : ne pas la déplacer à nouveau ni remplacer les contrôles conducteur, KYC, véhicule, disponibilité, unicité et outbox par un cache. Revalider 500 avant de tenter 750 et conserver tous les plafonds d'arrêt.

### Vérifications du correctif

229 tests unitaires/de régression passent dans 18 suites ; les 34 tests PostgreSQL de `performance-workflows.postgres.spec.ts` passent séparément sur une base jetable. Ils vérifient notamment les projections, les propriétaires mélangés dans un lot, les changements d'état, les écritures concurrentes, les dates, l'absence de cache et la progression durable. Les 103 tests du banc passent. Compilation Nest et contrôle TypeScript sans émission réussis. Le périmètre reste local : ni FCM/APNs réel, ni GPS en veille sur téléphone, ni capacité AWS certifiée.

## Transactions courtes pour les réponses et attributions

Le chemin `DriverDispatchService.respond` conserve les verrous dans l'ordre demande, invitation, conducteur, présence. Les contrôles de planning, proximité, compte, dernière identité KYC et véhicule sont regroupés dans une projection SQL fraîche **après** les prises de verrous. Le contrôle de planning redondant est supprimé ; aucune autorisation n'est mise en cache. Une modification validée pendant l'attente du verrou conducteur reste visible. Les conflits avec les trajets en cours ou futurs utilisent les prédicats de planning existants.

L'attribution, l'acceptation de l'invitation gagnante, l'annulation des invitations concurrentes et la mise à jour de présence utilisent une requête à écritures disjointes. L'offre métier et la notification durable restent enregistrées dans la même transaction ; les envois réseau n'interviennent qu'après validation. Le refus regroupe également la fermeture de l'invitation, son exclusion pour ce conducteur et l'invalidation de ses alertes. Les chemins de sélection du groupe suivant, les accusés de réception, les sonneries et les reprises SQL/Redis sont conservés.

Les attentes de verrou et les instructions SQL de réponse reçoivent les budgets locaux existants de deux et cinq secondes. Une expiration est revérifiée après les attentes de verrou. Le test PostgreSQL instrumenté mesure **12 échanges SQL pour une acceptation réussie**, lecture initiale, `BEGIN` et `COMMIT` compris. Cette réduction structurelle ne suffit pas, seule, à certifier une capacité de 500 ou 750 trajets.

Les régressions ajoutées couvrent les restrictions apparues après l'envoi de l'offre, les conflits de planning, les changements validés pendant une attente, l'expiration pendant cette attente et l'annulation intégrale des écritures si la notification échoue. Le refus est également annulé intégralement si l'arrêt des alertes échoue, puis peut être rejoué sans doublon. La découverte géographique et la réservation des vagues de quatre restent inchangées.

Validation locale : 388 tests réussis dans neuf suites métier, dont 18 nouveaux cas PostgreSQL ; trois tests optionnels ignorés. Les 33 tests des vagues de quatre et des courses de concurrence des accusés sont aussi rejoués avec succès sur la version finale, sans les compter deux fois dans ce total. Les 103 tests du banc de charge, le contrôle TypeScript sans émission et la compilation Nest réussissent. Aucun changement de schéma ni migration n'est nécessaire pour ce correctif.

### Palier 250 après raccourcissement des transactions

Rapport privé : `tmp/load-results/journeys-2026-11-23T16-14-29-125Z/report.json`. Profil mixte, deux API natives Windows, cinq minutes stables, mêmes plafonds et même GPS à cinq secondes. Les 250 demandes reçoivent des offres et les 250 trajets réalisent récupération et dépose automatiques. Aucun doublon d'offre ou d'acceptation, aucune erreur SQL/worker ; nettoyage réussi.

Les 34 770 envois GPS correspondent à 34 762 livraisons au correspondant et huit récupérations terminales attendues. Les 3 102 alertes observées sont confirmées. La cohorte finale contient 3 030 offres : 3 022 alertes observées et confirmées, huit offres obsolètes et aucune alerte non obsolète manquante ; 80 alertes observées sont hors cohorte. Les pics d'attente SQL sont de 7/7 ; le générateur culmine à 16 opérations. Le p95 des accusés GPS reste dans la borne de 20 ms, celui de la première alerte dans 300 ms, avec une moyenne de 147 ms.

Les 493 transactions `respond`, acceptations, refus et conflits réunis, retiennent une connexion pendant 25,8 ms en moyenne et 92,8 ms au maximum. Le relevé précédent à 250 comptait 483 transactions, une moyenne de 34,9 ms et un maximum de 540 ms. Cette comparaison sur hôte partagé, avec une répartition de réponses différente, est une observation favorable, pas une mesure isolant l'effet du correctif. Le nombre de requêtes du chemin d'acceptation reste contrôlé séparément par le test PostgreSQL.

### Nouveau point d'arrêt à 500

Rapport privé : `tmp/load-results/journeys-2026-11-23T16-22-27-171Z/report.json`. Le garde-fou arrête le test sur des pics d'attente SQL de 18 et 78, avec dix connexions par API et un plafond de 50 attentes. Le générateur reste sous son plafond : 98 opérations en cours au maximum et 31,4 ms de retard maximal. Les 63 demandes tentées produisent 55 demandes avec offres au relevé final ; 386 passagers sont récupérés et aucune dépose n'est atteinte. Le scénario est incomplet et ne valide pas 500 trajets.

Les 9 186 positions envoyées sont livrées au correspondant après observation et les 140 alertes observées sont confirmées. Cela ne démontre pas la couverture de l'ensemble des 220 offres insérées avant l'arrêt. Aucun doublon d'acceptation ou d'offre, aucune erreur SQL/worker ni éviction/erreur de transport Redis. Les ressources jetables sont nettoyées sans erreur.

La capture du pic à 78 montre deux transactions d'allocation retenues environ 97 et 118 ms, deux transactions d'accusé et plusieurs écritures GPS. Aucune transaction `respond` n'occupe une connexion dans cette capture précise ; cela n'exclut pas sa contribution avant le pic. L'occupation simultanée par l'allocation, les accusés, la progression automatique et le GPS reste à traiter. Ne pas attribuer toute la durée retenue à la dernière instruction visible, ni augmenter les plafonds pour déclarer le palier réussi. Revalider 500 avant 750.

Au relevé post-observation, les deux pools n'ont plus d'attente, mais la file de progression contient encore 198 tâches, la plus ancienne ayant 2,56 secondes : la file n'est pas entièrement vidée. Ce relevé PostgreSQL montre aussi des attentes d'écriture WAL et aucun lien bloqueur/attente entre transactions à cet instant. Il ne suffit pas à désigner le disque local comme cause unique du pic antérieur.

## Admission SQL partagée et mesures d'attente (23 novembre)

`src/database/background-sql-budget.ts` coordonne les unités SQL de fond par DataSource. Avec le pool actuel de dix connexions, le budget est de six unités simultanées, partagé entre progression, livraison, dispatch et maintenance. Les files sont FIFO par catégorie et servies en rotation pondérée ; la maintenance garde un tour, même sous charge. Ce plafond laisse une marge aux GPS, réponses conducteur, annulations et accusés, sans constituer une réservation matérielle : les autres chemins SQL non inscrits au budget utilisent toujours le pool normal.

L'admission précède la requête ou la transaction. Aucun appel Redis, push HTTP ou réveil après commit ne doit retenir une place. Un EntityManager déjà lié à un QueryRunner ne repasse pas dans la file, pour ne jamais attendre en conservant une connexion. La file est bornée à 128 unités et deux secondes ; seul un travail **non commencé** peut être différé. Une transaction en cours n'est jamais abandonnée par une course de promesses. Les lignes durables et les reprises existantes restent responsables du travail différé.

Les raccordements couvrent les transactions de sélection/réservation et leurs scans, les recherches après libération de conducteur, les préparations et réservations push/temps réel, les reprises d'accusés, les lectures groupées de progression et les réservations/transferts des jobs de progression. Les renouvellements de bail, écritures GPS et transactions de réponse ne sont pas ralentis par cette admission de fond. Les sous-limites existantes, la taille des vagues de quatre et les échéances métier sont conservées.

Autres changements : projection de demande limitée aux champs nécessaires à l'attribution/reprise, réservation et lecture des notifications temps réel en une instruction, et réservation Redis des signaux de disponibilité par lot de seize maximum, au lieu d'un aller-retour par conducteur. Les signaux Redis restent temporaires et dédupliqués entre réplicas ; ils n'accordent jamais une autorisation ni une attribution. Les lectures SQL après verrous, nécessaires aux courses de concurrence, ne sont pas supprimées pour gagner artificiellement un aller-retour.

Le rapport exporte `sqlAdmission` : attente avant admission, durée de l'unité après admission et durée totale, avec moyennes, maxima et bornes p95 par catégorie. La durée après admission inclut encore l'acquisition du pool et les traitements du pilote ; elle ne représente pas le CPU SQL. Les journaux applicatifs peuvent émettre `SQL_BACKGROUND_PRESSURE` lors d'une attente d'au moins 250 ms ou d'un refus, au plus une fois par trente secondes et par budget, sans SQL ni identifiant utilisateur.

Les garde-fous existants restent actifs. Le banc refuse aussi des métriques d'admission absentes, un cumul instantané admission + pool supérieur à 50, un pic de file d'admission supérieur à 50, une attente d'admission supérieure à une seconde ou un travail différé. Déplacer la file en amont du pool ne peut donc pas suffire à réussir le test ; les contrôles GPS, déposes, délais et cohorte d'alertes restent obligatoires.

Avec `--profile-sql`, **seul le cluster PostgreSQL jetable** active `track_io_timing` et `track_wal_io_timing`. Les captures incluent les compteurs WAL, I/O et base, leurs dates de remise à zéro ainsi que `fsync` et `synchronous_commit`. Les compteurs sont cumulatifs et incluent le peuplement initial ; comparer les captures d'une même période, pas les totaux bruts de deux essais différents. PostgreSQL 18 expose les temps WAL dans `pg_stat_io` ; des versions antérieures peuvent ne pas avoir ces lignes. Voir la [documentation PostgreSQL](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-IO-VIEW).

Le pool reste à dix connexions par API. Aucun index ni dimensionnement RDS n'est ajouté sans preuve d'un bénéfice. Pour une hausse ultérieure, compter le maximum de réplicas, les tâches supplémentaires de déploiement, les migrations et la réserve d'administration, puis vérifier CPU, RAM et I/O. Le plafond `max_connections` n'est pas un objectif de consommation. Voir le [guide de dimensionnement node-postgres](https://node-postgres.com/guides/pool-sizing).

### Vérifications après admission partagée

- 91 tests unitaires ciblés passent, dont expiration d'une admission avant toute exécution, libération après erreur, équité et retard du timer lors d'une pause de l'event loop.
- Les cinq suites PostgreSQL/Redis couvrent 328 cas réussis après reprise d'un test dont la fixture utilisait un identifiant absent ; trois cas optionnels sont ignorés. L'annulation pendant l'attente d'admission et la déduplication Redis concurrente font partie des nouveaux cas.
- Les 104 tests du banc passent, notamment le refus des métriques absentes et des files d'attente déplacées en amont du pool. Compilation et vérification TypeScript réussies.

Essai `stage-250-mixed --profile-sql`, terminé à **18 h 06 (Kinshasa)** :

- 250 récupérations, 250 déposes et 250 demandes ayant reçu des offres, sans violation de vague ni double attribution.
- 34 786 émissions GPS, dont 34 778 transmissions au participant et huit rejets terminaux réconciliés ; cadence inchangée à cinq secondes. Pendant les cinq minutes soutenues, les bornes p95 GPS accusé/transmission sont de 20 ms.
- 2 949 alertes reçues et confirmées au total. Les **2 877 offres de la cohorte figée** ont toutes leur alerte observée et confirmée ; aucune alerte non obsolète manquante. Les offres apparues après capture sont comptées séparément.
- Pics du pool : **6 / 6**. Pics d'admission : **4 / 6** ; attentes maximales **14,8 / 25,0 ms** ; aucun travail différé, aucune erreur SQL ou worker.
- Allocation de première offre : p95 **98,2 ms**. Ces chiffres ne constituent pas une mesure AWS ni une preuve causale isolée de l'amélioration : environnement partagé et profilage actif.
- Nettoyage des ressources jetables réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T16-59-08-799Z/report.json`.

Ce test utilise le budget avant l'ajout de sa dernière protection contre un timer retardé. Celle-ci est validée par le test unitaire puis incluse dans la recompilation pour le palier suivant ; aucune expiration d'admission ne s'est produite à 250.

Sur les 378,7 secondes entre première et dernière capture de santé de cet essai, PostgreSQL produit 119,4 Mio de WAL. Les temps d'écriture WAL cumulés sur les backends totalisent 19,74 s pour 82 029 écritures ; il ne s'agit ni d'un temps de blocage individuel ni d'une durée à soustraire à la latence HTTP. Aucun nouveau `wal_buffers_full`, deadlock ou fichier temporaire n'est compté dans cette fenêtre. `fsync` et `synchronous_commit` restent activés. Ces agrégats ne permettent pas d'exclure un pic I/O bref ni de déduire les performances du stockage RDS.

Essai `stage-500-mixed --profile-sql`, terminé à **18 h 15 (Kinshasa)**, après recompilation finale :

| Mesure | Résultat |
| --- | --- |
| Récupérations / déposes | 500 / 500 |
| Demandes ayant reçu une offre | 500 / 500 |
| Émissions GPS / transmissions / rejets terminaux réconciliés | 73 928 / 73 924 / 4 |
| Phase soutenue de cinq minutes | 60 002 GPS ; bornes p95 accusé et transmission : 100 ms |
| Alertes reçues et confirmées, tous groupes | 5 888 / 5 888 |
| Cohorte figée | 5 795 offres : 5 774 observées et confirmées, 21 déjà obsolètes ; aucune alerte non obsolète manquante |
| Double attribution / violation de vague | 0 / 0 |
| Pic du pool par API | 50 / 43, plafond inchangé à 50 |
| Pic d'admission / attente maximale | 10 / 9 ; 262,2 / 304,7 ms |
| Travail différé / erreurs SQL / erreurs worker | 0 / 0 / 0 |
| Ancienneté maximale de progression observée | 8,65 s, plafond inchangé à 15 s |
| Première offre : allocation p95 / maximum | 8,28 s / 16,90 s |
| Livraison des alertes : p95 | 1,145 s |

Le contrôle fonctionnel passe et le nettoyage est réussi. Rapport privé : `tmp/load-results/journeys-2026-11-23T17-07-31-238Z/report.json`. Les alertes créées après capture restent séparées ; ne pas présenter les 5 918 offres produites au total comme toutes reçues. Les 584 conflits de réponse sont des conflits métier attendus dans le scénario concurrent, pas des erreurs SQL.

**Suite recommandée :** comprendre le délai d'allocation (admission applicative, candidat disponible, réveil et scan de reprise), reproduire 500 avec marge avant 750, puis valider sur API limitées comme Fargate et générateur séparé. Le p95 d'allocation ne peut pas être attribué directement à la seule attente d'admission, dont le maximum mesuré reste 305 ms. Ne pas augmenter le pool, relever les seuils ni diminuer la fréquence GPS pour déclarer 750 validé. Aucun changement AWS, Terraform, de migration ou de `.env` n'est effectué par cette passe.

## Organisation du code

- `profile.cjs` : paliers, cadence, trajectoire et demande synthétique.
- `resources.cjs` : clusters jetables, processus, observations et nettoyage.
- `time-alignment.cjs` et son test : contrôle bloquant des fuseaux et du décodage des dates sur le générateur et chaque API, avant la charge.
- `stop-owned-backend.cjs` : arrêt borné des seuls processus API lancés par le banc, avec vérification de leur sortie avant le nettoyage de PostgreSQL.
- `fixtures.cjs` : schéma, données synthétiques et vérifications SQL.
- `alert-cohort.cjs` et `alert-cohort.test.cjs` : cohorte figée avant une fenêtre d'observation finale, contrôle des retraits métier à sa clôture et rapprochement bloquant des alertes, sans export d'identifiants.
- `server.cjs` : application réelle, adaptateur Redis, workers autorisés et transport push synthétique.
- `workers.cjs` : liste explicite des workers trajet et notification et de leurs cadences.
- `readiness.cjs` : observation de session et de salon sans contournement de l’authentification.
- `transport.cjs` : appels autorisés et validation des accusés GPS.
- `recovery.cjs` : récupération authentifiée de la clôture ; aucun refus converti en GPS accepté.
- `delayed-gps.cjs` : contrôle du rejet des positions arrivées en retard.
- `resilience.cjs` et `fault-proxy.cjs` : panne bornée, reprise de file et reconnexion dans le laboratoire local uniquement.
- `lab-image.cjs`, `container-child.cjs` et `Dockerfile.lab` : image vérifiée et limites CPU/RAM des API sous Linux.
- `simulation.cjs` : scénario et critères d’arrêt.
- `metrics.cjs` et `metrics.test.cjs` : histogrammes bornés, retard exact par type de travail et historique de santé sans duplication des profils SQL.
- `inflight-budget.cjs` : plafond inchangé d'opérations en cours, admission atomique des paires GPS et photographie agrégée au premier refus.
- `generator-runtime.cjs` et `generator-runtime.test.cjs` : observations bornées du générateur, recouvrement des pauses avec les collectes et événements GC, sans modification de la cadence ni des seuils.
- `bootstrap-diagnostics.cjs` et son test : six jalons de démarrage par API, sans secrets ni données métier.
- `cooperative-wait.cjs` et son test : maintien des émissions prévues pendant les requêtes de préparation, propagation des erreurs et attente de fin sans travail détaché.
- `failure-snapshot.cjs` et son test : capture unique dès le premier échec et observation séparée après vidange, sans remplacer l'erreur initiale.
- `postgres-activity.cjs` et son test : états et attentes PostgreSQL agrégés des seules connexions API jetables ; familles de requêtes et liens bloqueur/attente optionnels, sans SQL ni identifiants exportés.
- `connection-occupancy.cjs` et son test : durée des connexions retenues et des transactions, savepoints exclus, occupation parallèle et stockage borné.
- `profiled-tables.cjs` : liste de tables connues autorisées dans les descripteurs, y compris les tables SQL de sonnerie et de reprise sans entité ORM.
- `sql-profiler.cjs` et `sql-profiler.test.cjs` : profilage local optionnel des familles SQL, connexions et méthodes, sans export de SQL ou de paramètres.
- `cpu-diagnostics.cjs` et son test : fenêtre locale de profilage bornée, agrégats de fonctions, plus longs intervalles et surcoût de démarrage/arrêt, sans export de profil brut.
- `socket-write-diagnostics.cjs` et son test : durées synchrones des écritures socket par catégorie et douze incidents au maximum ; ne mesure pas la livraison réseau et ne conserve aucun contenu.
- `pool-diagnostics.cjs` et son test : pic d'attente SQL observé à l'admission, indépendamment des timers ; quatre captures bornées des connexions occupées en mode profilage SQL.
- `profile-discovery.cjs` : EXPLAIN local reproductible de découverte et validation des candidats, sur des données synthétiques jetables, sans export du SQL ou de ses paramètres.
- `tracking-diagnostics.cjs` et son test : étapes GPS, attente de connexion, admission et publication Redis, avec agrégats bornés et sans données métier.
- `http-diagnostics.test.cjs` : catégories d'erreur HTTP bornées, sans fuite de données ni relance masquant un échec.
- `journeys.test.cjs` : contrôles rapides exécutés en CI, sans démarrer de serveur ni accéder à AWS.
- `recovery.test.cjs` : récupération terminale, profils indépendants, limites des conteneurs et refus d’injection hors périmètre.
