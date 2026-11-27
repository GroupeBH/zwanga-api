# Campagnes SMS promotionnelles — préparation locale

Date : 27 novembre 2026. Module `src/sms-marketing`, désactivé par défaut.
Aucun déploiement, paramètre AWS, SMS réel ni modification du transport OTP.

## État et limites avant activation

L'admin existant utilise `/api/v1/admin/sms-marketing` ; ses contrats sont repris
sans modification de ses composants ou de son style. Les routes sont préparées
pour les brouillons, estimations, tests, lancements, programmation, suivi,
annulation, duplication et désinscriptions. La recette navigateur connectée à
une base représentative reste nécessaire : les tests HTTP ne la remplacent pas.

**Ne pas activer en production en l'état sans terminer les confirmations** :

- choisir le domaine court réellement contrôlé par Zwanga et raccorder son chemin
  `/s/:code` aux GET/POST `/api/v1/sms/s/:code` du backend ; conserver le POST ;
- faire confirmer l'autorisation promotionnelle du Sender ID et de la route RDC ;
- confirmer le transport Unicode et la facturation des accents ;
- vérifier le cadre réglementaire applicable avec les responsables compétents.
  Il n'a pas été vérifié ici ; le mécanisme de désinscription ne vaut pas avis
  de conformité ni preuve de consentement préalable ;
- qualifier la rétention des textes et destinataires, les habilitations, les
  sauvegardes et la suppression des données de campagne ;
- vérifier la suppression des données sensibles dans la chaîne de traces AWS,
  y compris les proxys et journaux d'accès en amont. Côté backend, les routes
  SMS entrantes sont exclues de l'instrumentation HTTP ADOT avant création du
  span ; le transport sortant et les requêtes SQL suppriment leur instrumentation.
  Cette protection a été testée avec le préchargeur ADOT local utilisé par ECS,
  sans désactiver les traces des autres routes. Elle doit être revérifiée à
  chaque mise à jour ADOT et dans la chaîne AWS réelle.

## PDF Mobishastra v1.3 fourni

Lecture du document local de 22 pages, notamment 4, 6, 13–19 et 21–22 ; inspection
visuelle de la page 16. Aucun appel au compte fournisseur pour cette vérification.

| Sujet      | Constat                                                                                                                              | Choix de cette préparation                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitaire   | `https://mshastra.com/sendurl.aspx`, pages 13–14, URL déjà utilisée par les OTP                                                      | Service frère séparé, même proxy et identifiants, Sender ID marketing explicite                                                                             |
| Lot        | `sendurlcomma.aspx` page 4 ; JSON page 19 avec exemples de résultats par numéro, mais contrat incomplet                              | Pas de lot fournisseur ; soumissions unitaires bornées pour garder personnalisation et statut par personne                                                  |
| Unicode    | Pages 6/16 intitulées Unicode sans paramètre distinct ; pages 17/19 : `language=Unicode` et texte hexadécimal sur d'autres endpoints | Aucun paramètre inventé. Transport initial ASCII seulement ; `SMS_ENCODING_UNCONFIRMED` sinon, sans appel réseau ni translittération silencieuse            |
| Longueur   | 160 anglais / 70 Unicode ; concaténation 153 / **63** dans le PDF, contre 153 / **67** dans l'admin                                  | Un segment maximum. Comptage GSM/UTF-16 aligné avec l'admin pour l'estimation ; pas de qualification de la facturation fournisseur tant que l'écart demeure |
| Accusés    | Les pages 21–22 décrivent des SMS entrants, pas des accusés de livraison authentifiés                                                | Aucun callback inventé ; `delivered=0`                                                                                                                      |
| Solde      | `balance.aspx?user=…&pwd=…` page 4, sans format de réponse défini                                                                    | `credits.balance=null`, aucun appel bloquant                                                                                                                |
| Expéditeur | Autorisation opérateur requise ; défaut possible si expéditeur inconnu, sans preuve d'autorisation RDC promotionnelle                | Aucun repli sur le Sender ID OTP ; confirmation opérateur exigée                                                                                            |
| Refus      | Textes et codes 001, 003, 005–013 page 14                                                                                            | Correspondance stricte, aucun corps fournisseur renvoyé/journalisé ; inconnu = non confirmé                                                                 |

`000`, `000 - Send Successful` ou `Send Successful`, avec HTTP 200, signifie
**soumission acceptée**, pas livraison au téléphone. Aucune référence fournisseur
n'est fabriquée quand l'API choisie n'en fournit pas.

## Règles métier

- Audience publique : `driver` et `passenger`, jamais les comptes de l'équipe.
  La règle du profil conducteur est celle de `users.role`, déjà protégée en base.
- Comptes supprimés, inactifs et suspendus exclus ; téléphone normalisé avec
  `zwanga_canonical_phone`, vérifié par défaut. Les listes nominatives remplacent
  les filtres mais ne contournent jamais les exclusions.
- Filtres : rôle, dernière connexion, dates inclusives à Kinshasa, trajet terminé
  comme conducteur ou passager, abonnement actif, statut du dernier dossier KYC.
- `{prenom}` : premier mot, 20 unités UTF-16 maximum (sans couper un emoji),
  pour rester cohérent avec le compteur admin ; le rendu et le lien sont
  figés avec chaque destinataire. Les placeholders inconnus sont refusés.
  Le maximum tient compte des noms Unicode et des caractères GSM à deux unités,
  ce qui peut refuser un brouillon que l'aperçu ASCII de l'admin croit plus court.
- Estimation agrégée SQL sans retour de numéros/noms ; exclusions comptées par
  premier motif. Les textes identiques partagent leur calcul de segments.
- Écart au lancement : refus si `abs(réel-attendu) > max(10, attendu × 10 %)`,
  avant toute préparation de destinataire. Maximum 50 000 par campagne.
- Fenêtre 08:00 incluse / 20:00 exclue à Kinshasa ; planification de 5 minutes à
  30 jours. Audience immédiate figée au lancement ; audience planifiée au démarrage,
  écart conservé dans l'audit. Le worker recontrôle compte, numéro et désinscription.
- L'estimation et le figement au lancement utilisent la même vue SQL
  (`REPEATABLE READ`) : une inscription concurrente ne peut pas grossir la
  campagne après la validation du nombre de destinataires. Les dates sans
  fuseau du schéma existant sont interprétées en UTC, puis filtrées à Kinshasa.
- Un SMS marketing accepté par numéro tous les trois jours par défaut ; une
  soumission déjà en cours dans une autre campagne empêche un envoi concurrent.
- Coût exprimé en **crédits fournisseur**, jamais en jetons ou argent client.
  Le budget quotidien consomme les tentatives réservées, y compris incertaines,
  et les tests. Aucune opération des portefeuilles/paiements n'est utilisée.

### Désinscription : uniquement la publicité

Elle n'efface ni le compte ni les réservations. OTP, sécurité et messages
transactionnels de trajet restent indépendants. Le GET affiche un formulaire,
seul le POST désinscrit ; les aperçus de messagerie ne changent donc rien.
Codes base62 de huit caractères, réservés atomiquement dans un registre partagé
avec les tests, valables douze mois. Même contenu pour les codes de production
valides, inconnus ou expirés ; un lien de test annonce qu'il ne modifie rien.
Un code expiré ne désinscrit pas : le support peut enregistrer la demande.
Les deux méthodes et tous les codes partagent 20 requêtes/minute par IP.
Page sans script, traceur ni ressource externe, no-store, CSP et no-referrer.

La préférence est liée au numéro et survit à l'effacement du compte. L'équipe
peut désinscrire manuellement ; la réinscription exige le motif de la demande
de la personne et conserve l'historique. Les numéros des listes sont masqués.

## Autorisations, états et idempotence

| Permission                       | Rôles                        |
| -------------------------------- | ---------------------------- |
| `sms.read`, `sms.write`          | admin, super_admin, marketer |
| `sms.send`, `sms.optouts.manage` | admin, super_admin           |

Toutes les routes admin utilisent `@Auth()` ; chaque service relit les droits et
l'état du compte dans la base. Le worker relit aussi les droits du lanceur.
Il n'y a pas d'approbation par un second administrateur.

`draft → scheduled / sending → completed`, avec `paused`, `cancelled`, `failed`.
Les modifications exigent `revision` et invalident le test. Un lancement exige
un test accepté de cette révision vers le numéro du compte authentifié ; aucun
numéro de test libre n'est accepté. Cinq tests/heure/compte, toutes campagnes
confondues. Création, duplication, test et lancement conservent leurs intentions
idempotentes ; changer le contenu d'une même intention provoque un conflit.

Une pause fournisseur bloque le circuit partagé, puis les autres campagnes.
Une reprise exige un test réussi postérieur à la pause. Le reste des campagnes
reste en pause jusqu'à reprise explicite. Une campagne planifiée sans
destinataires repasse par la préparation, pas directement par la clôture.

## File PostgreSQL, pas BullMQ dans ce lot

Migration `1780000149000-SmsMarketing.ts` : `sms_campaigns`,
`sms_campaign_recipients`, `sms_opt_outs`, `sms_audit`, `sms_intents`,
`sms_test_sends`, `sms_runtime`, `sms_codes`, fonctions de rendu et de longueur.
Index partiels pour la file, les baux, le plafond de fréquence et les refus actifs.
Aucun index supplémentaire sur `users` sans mesure justifiant son ajout.

Worker déclenché toutes les dix secondes, réservations courtes `SKIP LOCKED`,
baux de deux minutes. Le budget SQL commun espace les soumissions sur toutes les
instances ECS, même quand plusieurs workers tournent. Aucun verrou ni connexion
SQL retenu pendant l'appel HTTPS. La préparation reste transactionnelle.
L'index partiel des destinataires `queued` suit exactement l'ordre de prise.
La récupération des baux utilise le même ordre de verrous que l'annulation
(campagne avant destinataire), par lots bornés. Le contrôle pré-HTTP vérifie
encore la propriété et la durée restante du bail, le circuit global et les droits.

Une soumission `sending` expirée devient `failed/PROVIDER_NOT_CONFIRMED`, jamais
`queued`. Après crash entre réservation et HTTP, cela peut laisser un SMS non
envoyé plutôt que risquer de le doubler. Même règle pour un timeout ou un refus
de statut incertain. Aucun repli fournisseur. Les reprises de campagne ne
rejouent pas ces destinataires.

**Limite externe :** une annulation bloque la suite, mais ne rappelle pas une
requête déjà engagée auprès du fournisseur. La relecture immédiatement avant
HTTP ne constitue pas une transaction atomique avec Mobishastra ; zéro livraison
après l'instant du clic et exactement-une-livraison ne peuvent être garantis.

## Configuration et préparation AWS ultérieure

| Variable                             | Défaut / condition                                         |
| ------------------------------------ | ---------------------------------------------------------- |
| `SMS_MARKETING_ENABLED`              | `false`                                                    |
| `SMS_MARKETING_SENDER_ID`            | vide, dédié et approuvé, 13 caractères maximum             |
| `SMS_MARKETING_PROVIDER_CONFIRMED`   | `false`, à confirmer avec l'opérateur avant activation     |
| `SMS_MARKETING_OPT_OUT_BASE_URL`     | vide, HTTPS, slash final, aucun identifiant/query/fragment |
| `SMS_MARKETING_LINK_HOST`            | vide, hôte exact contrôlé par Zwanga                       |
| `SMS_MARKETING_SENDING_WINDOW`       | `08:00-20:00`                                              |
| `SMS_MARKETING_FREQUENCY_CAP_DAYS`   | `3`                                                        |
| `SMS_MARKETING_MAX_RECIPIENTS`       | `50000`                                                    |
| `SMS_MARKETING_RATE_PER_SECOND`      | `2`, global                                                |
| `SMS_MARKETING_DAILY_LIMIT`          | `20000` segments/tentatives réservés                       |
| `SMS_MARKETING_CREDITS_PER_SEGMENT`  | `1`                                                        |
| `SMS_MARKETING_PAUSE_AFTER_FAILURES` | `20`                                                       |

Identifiants existants `MOBISHASTRA_PROFILE_ID`, `MOBISHASTRA_PASSWORD`,
`MOBISHASTRA_SMS_URL` et `MOBISHASTRA_PROXY_URL`. Pour ce module le proxy est
obligatoire même si le flux OTP permet un mode local direct. Node du projet
requis. L'agent marketing possède son propre petit pool de connexions.

1. Qualifier schéma/tests sur une copie, puis revue de la migration et des traces.
2. Configurer et vérifier le domaine de désinscription, GET sans effet et POST
   fonctionnel depuis un téléphone, y compris derrière les proxys de production.
3. Préparer les noms `/zwanga-api/production/env/SMS_MARKETING_*` en SecureString
   selon le mécanisme SSM existant, avec le module et la confirmation désactivés.
4. Revoir le plan Terraform de découverte des paramètres : une création SSM seule
   ne met pas à jour une ancienne définition de tâche ECS. Ne pas modifier les
   secrets, budgets ou variables OTP et ne pas envoyer depuis la CI.
5. Après accord de maintenance et confirmations, migrer, renouveler les tâches,
   puis autoriser séparément un test réel vers un numéro contrôlé. Surveiller le
   crédit fournisseur partagé avec l'OTP ; un plafond applicatif ne garantit pas
   qu'il reste suffisamment de crédit chez Mobishastra pour les OTP.
6. Revoir les résultats et coûts dans le portail fournisseur avant une première
   campagne limitée. Les acceptations incertaines restent à rapprocher manuellement.

Arrêt d'urgence : annuler les campagnes concernées dans l'admin, puis mettre
`SMS_MARKETING_ENABLED=false` et renouveler toutes les tâches. Une variable SSM
n'est pas rechargée dynamiquement par une tâche déjà démarrée. Conserver les
tables, l'audit et les désinscriptions. `down` est destiné aux bases jetables ou
à un retour arrière après archivage approuvé : il supprime ces tables, jamais
à exécuter automatiquement sur des campagnes réelles.

## Validation locale

Fournisseur simulé exclusivement, PostgreSQL isolé via `AUDIT_TEST_POSTGRES_BIN`,
tests de transport HTTPS et CONNECT sur boucle locale, environnement enfant réduit.
Ne pas démarrer `AppModule` avec le `.env` de production pour cette recette.

```powershell
$env:AUDIT_TEST_POSTGRES_BIN='C:\Program Files\PostgreSQL\18\bin'
node node_modules/jest/bin/jest.js --runInBand src/sms-marketing
node node_modules/jest/bin/jest.js --runInBand src/otp
node node_modules/@nestjs/cli/bin/nest.js build
```

Résultats : **102 tests SMS réussis** (5 suites). Après les derniers ajustements
de rendu et de migration, les **83 tests politiques/PostgreSQL concernés ont
été rejoués avec succès**. **166 tests OTP réussis**, 17 ignorés : la suite Redis
OTP exige son instance dédiée et ses paramètres opt-in ; aucun Redis existant
n'a été utilisé. Le build NestJS de production a réussi. Ce n'est ni un passage
de toute la suite du dépôt, ni une recette navigateur de l'admin.

Le benchmark d'audience est synthétique, pas une mesure de production. Le test
du transport cadence six soumissions simulées à deux par seconde ; il ne
mesure ni le débit Mobishastra réel ni la capacité de l'EC2 proxy. Les essais
de concurrence PostgreSQL vérifient séparément le plafond global des workers.

Mesures locales obtenues le 27 novembre : estimation agrégée de 50 000 comptes
fictifs en **1 498 ms** après optimisation (l'essai initial dépassait 3 secondes ;
`EXPLAIN ANALYZE` mesurait environ 4,6 secondes). Pas de données de production.
Six soumissions via HTTPS/CONNECT simulés : **2 939 ms**, cadence de **1,75/s**
mesurée entre les arrivées, avec zéro trace sensible. Cela ne mesure ni le
fournisseur ni le proxy AWS et n'est pas un test de charge de production.

Le runtime local était Node **24.11.0**, inférieur au minimum du projet
**24.22.1** : les tests de release doivent également passer dans la CI avec
la version imposée. La migration n'a été appliquée que sur des clusters
PostgreSQL jetables, jamais sur une base applicative.

## Fichiers de cette intégration

- `src/sms-marketing/` : politiques, DTO, configuration, audience SQL, dépôt,
  campagnes, worker, désinscriptions, transport, contrôleurs, erreurs HTTP,
  confidentialité des traces et tests ciblés.
- `src/database/migrations/1780000149000-SmsMarketing.ts` et inscription dans
  `src/database/migrations/index.ts` ; module enregistré dans `src/app.module.ts`.
- `src/common/safe-request-log.ts` : masquage des codes courts dans les chemins.
- `test/fixtures/sms-marketing-transport.cjs` et
  `test/fixtures/sms-marketing-incoming-tracing.cjs` : réseau local simulé.
- `.env.example`, ce guide et `docs/CHANGEMENTS_TECHNIQUES.md`.

Les autres modifications déjà présentes dans l'espace de travail ne font pas
partie de cette intégration. Aucun fichier de `zwanga-admin` ni `.env` modifié.

### Écarts explicites au cahier des charges

- Expéditeur distinct sans repli, confirmation opérateur et hôte de lien exigés :
  priorité à la règle de refus en l'absence d'autorisation, plutôt qu'au défaut
  contradictoire proposant le Sender ID OTP.
- Unicode bloqué avant réseau, pas envoyé avec un paramètre supposé. L'admin
  reste inchangé ; l'activation multilingue attend l'alignement fournisseur.
- Pas de statut de livraison ni de solde inventé en l'absence de contrat exploitable.
- Pas de garantie impossible de rappel des SMS déjà engagés.
- Validation navigateur et AWS, conservation des données, conformité, journaux
  des proxys et réception opérateur réelle restent à qualifier.
