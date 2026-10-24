# Tests de sécurité locaux — Zwanga

Date : 24 octobre 2026. Périmètre : backend NestJS local et application mobile `../zwanga`.

## Suivi du 24 octobre — correctifs locaux

Les résultats initiaux ci-dessous sont conservés pour traçabilité. Les correctifs
suivants ont ensuite été appliqués à la demande de l'utilisateur, sans déploiement.

- **SEC-001 corrigé :** suppression du repli sur le statut client. Le DTO accepte
  toujours `status` pour les anciennes applications, mais ne l'utilise plus pour
  décider. Une décision Didit absente, vide ou de mauvais type provoque un HTTP
  502 `KYC_PROVIDER_INVALID_RESPONSE` avant toute écriture, activation ou collecte
  de justificatifs. Le dossier précédent reste inchangé, y compris s'il était
  déjà approuvé/rejeté. La création initiale sans statut reste `pending`.
- **SEC-002 corrigé pour le rejeu reproduit :** la fraîcheur est vérifiée sur
  l'horodatage du corps signé ; il doit correspondre à `X-Timestamp`. Les dates
  absentes, invalides, trop anciennes/futures ou contradictoires sont refusées
  avant accès à la base ou au fournisseur. Les entiers Unix et les chaînes sont
  acceptés. Les livraisons légitimes re-signées avec une date récente restent
  acceptées. Une V2 invalide ne peut plus être rétrogradée vers Simple.
- **Protection complémentaire Simple :** cette signature ne couvre que quatre
  champs. Une décision fraîche obtenue auprès de l'API est obligatoire ; en cas
  de panne/configuration manquante, réponse d'erreur sans modification du compte
  ni stockage des données non signées. Le repli sur un webhook V2 récent dont
  le corps entier est signé reste disponible pendant une panne fournisseur.
- **SEC-003 corrigé à l'origine :** `X-Powered-By` désactivé, `nosniff` global,
  `Cache-Control: private, no-store` pour auth/KYC et les requêtes portant une
  autorisation. Cache des médias publics, CORS et accès Swagger inchangés.

Validation après correctifs : **499 tests backend réussis dans 31 suites**, dont
les nouveaux cas de réponses incomplètes et de signatures, et **47 tests JS
mobile** KYC/identité/notifications réussis dans trois fichiers. TypeScript
backend sans émission validé. Les deux scripts Didit ci-dessous terminent
désormais à **0, aucun cas vulnérable reproduit** ; les appels fournisseur et les
dépôts de ces tests sont simulés. Les erreurs de prestataire affichées par Jest
proviennent des scénarios simulés, pas d'appels réels.

La sonde a aussi été rejouée sur le processus local : 28 observations, toujours
26 conformes et deux informatives ; liveness finale à 200, en-tête Express absent
et `nosniff` présent. Aucun redémarrage manuel du serveur n'a été effectué.

Portée : aucun changement mobile, migration, variable d'environnement, clé,
Terraform, CI/CD, AWS ou publication GitHub. Les routes et formats de succès
restent compatibles ; les réponses fournisseur incomplètes sont volontairement
traitées comme erreurs temporaires et non comme approbations. Le code doit être
rechargé/redémarré avant de prendre effet sur un processus déjà lancé.

Limites restantes : pas de validation avec un compte Didit réel ni un binaire
store. Le contrôle temporel ne remplace pas une déduplication durable complète
par `event_id` ni un contrôle général d'ordre de tous les événements : un
événement signé encore dans la fenêtre reste recevable. Ces mécanismes ne sont
pas ajoutés dans ce correctif ; les protections transactionnelles et la stabilité
des décisions répétées existantes restent en place.

## Synthèse

Deux défauts KYC ont été reproduits **avec les services du dépôt et des dépendances simulées**, sans contacter Didit : approbation à partir du statut client lorsque la réponse fournisseur est incomplète, et acceptation d'un ancien webhook signé avec un en-tête temporel rafraîchi. Ils ne prouvent pas une exploitation en production. Le premier doit être corrigé en priorité.

Sur le serveur déjà démarré à `127.0.0.1:5200`, les contrôles anonymes/faux JWT essayés n'ont pas donné accès aux routes privées ni aux namespaces chat/tracking. Aucun compte réel n'a été connecté, modifié ou supprimé. La campagne est ciblée, pas un pentest exhaustif ni une certification de sécurité.

## Périmètre confirmé et précautions

- L'utilisateur a confirmé PostgreSQL/Redis réservés aux tests et un émulateur Android disponible.
- La configuration consultée indique des services de données en boucle locale, mais contient aussi des identifiants de prestataires. Leurs valeurs ne sont ni publiées ni utilisées dans les reproductions.
- Aucun paiement, envoi OTP, création de session KYC fournisseur, push, migration ou changement AWS/Terraform/CI/CD. Aucun push GitHub.
- Les seuls ajouts sont des tests, reproductions et documents. Aucun correctif métier n'est appliqué dans cette campagne.
- Android testé : `com.zwanga`, version installée 1.0.17/build 172, **debug**. Ce n'est pas une validation des binaires des stores. Aucun appareil iOS testé.

## Résultats mesurés

| Vérification | Résultat | Portée réelle |
|---|---|---|
| Sonde réseau reproductible | 28 observations : 26 conformes, 2 informatives | 24 requêtes HTTP et 4 connexions WebSocket sur le serveur local existant |
| Tests backend ciblés | 388 réussis dans 27 suites | Logique réelle, dépôts/prestataires simulés ; certaines suites utilisent HTTP/Socket.IO réels en local |
| Tests mobile ciblés | 194 réussis dans 15 fichiers | JavaScript/TypeScript avec modules natifs simulés |
| Reproduction KYC statut incomplet | 3 cas vulnérables, 1 contrôle correct | Méthode `syncSession`, fournisseur et dépôts en mémoire |
| Reproduction rejeu webhook | 2 cas vulnérables, 2 contrôles corrects | Vérification HMAC réelle, clé synthétique, aucun webhook envoyé au serveur actif |
| Android : lancement externe de `IncomingRideActivity` | Refus `Permission Denial`, activité non exportée | Essai ADB réel sur l'émulateur |
| Android : résolution du lien `zwanga://kyc/didit-return` | Dirigé vers `MainActivity` | Résolution seulement, sans ouverture de vérification |
| TypeScript backend | Compilation sans émission réussie | `tsconfig.build.json` ; tests exclus de ce build mais compilés par Jest |

La sonde vérifie notamment : neuf routes privées sans JWT, JWT malformé, algorithme `none`, fausse signature, faux en-têtes d'identité/rôle, rôle dans la query string, HEAD sur portefeuille, fichiers `.env`/`.git` et traversée encodée non servis, JSON invalide (400), corps de 130 Kio refusé (413). Liveness à 200 avant et après. Aucune pile technique détectée dans ces réponses.

Les 24 nouveaux tests HTTP isolés vérifient les vrais `JwtStrategy`, `JwtAuthGuard`, `RolesGuard` et DTO, sur un contrôleur de fixture : rôle serveur prioritaire sur le JWT, séparation admin/super-admin, comptes désactivés/suspendus, sessions révoquées, changement obligatoire du mot de passe admin, rejet d'auto-attribution des rôles privilégiés et de neuf champs sensibles de profil. Cela ne remplace pas un test de chaque route métier avec deux comptes réels.

## SEC-001 — Approbation KYC possible sur statut envoyé par le client

**Priorité élevée — violation confirmée de la frontière de confiance, exploitation conditionnelle.**

Impact : un utilisateur authentifié disposant d'une session Didit rattachée à son compte peut obtenir un dossier `approved` et un compte `active` sans décision d'approbation fournisseur **si la réponse HTTP 200 du fournisseur ne contient pas de statut exploitable**.

- Entrée : `POST /api/v1/users/kyc/didit/sync`, `src/users/users.controller.ts:175`.
- `src/users/didit-kyc.service.ts:272` transmet `fallbackStatus: dto.status`.
- `src/users/didit-kyc.service.ts:552` choisit `diditPayload.status ?? input.fallbackStatus` après normalisation.
- La transaction enregistre ensuite ce statut et peut activer le compte. Le contrôle d'appartenance de session existe et a été conservé dans le scénario : ce n'est pas une usurpation de session d'un autre utilisateur.

Reproduction locale :

```powershell
node test/security/didit-status-probe.cjs
```

| Statut fournisseur simulé | Statut client | Résultat |
|---|---|---|
| `In Review` | `Approved` | `pending` — contrôle correct |
| absent | `Approved` | `approved`, compte `active` — défaut |
| `null` | `Approved` | `approved`, compte `active` — défaut |
| chaîne vide | `Approved` | `approved`, compte `active` — défaut |

Le script termine avec le code 1 quand il reproduit le défaut. Ce n'est pas un test de non-régression qui approuve ce comportement.

**Correction recommandée :** ne jamais utiliser le statut client pour une décision KYC, même comme repli. Conserver le statut durable précédent et signaler une réponse fournisseur invalide lorsque la décision manque ; déclencher une reprise contrôlée. Ajouter ces trois cas à la suite métier avec l'attente « aucune approbation/activation ». Les bénéfices dépendant de l'approbation doivent rester bloqués.

**Limite :** nous n'avons pas démontré que le prestataire réel renvoie actuellement ces réponses ni qu'un attaquant peut les provoquer. Le défaut est démontré dans la gestion de réponse incomplète.

## SEC-002 — Fraîcheur des webhooks vérifiée sur un en-tête non signé

**Priorité moyenne — rejeu reproduit, possession d'un webhook signé nécessaire.**

Impact : un ancien événement authentique peut repasser la vérification. Lors d'une indisponibilité du rafraîchissement fournisseur, le code peut appliquer cet ancien événement à un dossier dont la décision a changé.

- `src/users/didit-kyc.service.ts:799` lit `X-Timestamp`.
- `src/users/didit-kyc.service.ts:809` ne contrôle la fenêtre temporelle que sur cet en-tête.
- La signature V2 couvre le JSON ; la signature Simple utilise le `timestamp` du corps lorsqu'il est présent (`:851`). Ces horodatages peuvent donc être différents.
- `handleWebhook` retombe sur le payload signé lorsque la consultation fournisseur échoue (`:352`). En fonctionnement nominal, cette consultation réduit le risque d'appliquer une décision périmée.

Reproduction :

```powershell
node test/security/didit-replay-probe.cjs
```

Un corps signé datant de 24 heures est refusé avec son ancien en-tête, mais accepté avec `X-Timestamp` courant, **sans modifier la signature**, pour V2 et Simple. Le test utilise une clé artificielle, jamais un secret du projet. Il retourne 1 lorsque le défaut est présent.

**Correction recommandée :** vérifier la fraîcheur de l'horodatage authentifié dans le corps et sa cohérence avec l'en-tête ; refuser les ambiguïtés ; compléter par une déduplication durable des événements et des contrôles de progression des décisions. Ne pas confondre une signature valide avec une décision actuelle. Le format des signatures est documenté par [Didit](https://docs.didit.me/integration/webhooks) ; son [intégration WordPress officielle](https://github.com/didit-protocol/plugin-wordpress) explicite également le rejet d'un rejeu avec en-tête rafraîchi.

**Limite :** connaître une session ne suffit pas. Il faut déjà posséder un message authentiquement signé, par exemple à la suite d'une fuite distincte. Aucun secret ni webhook réel n'a été extrait et aucune modification réelle de dossier n'a été tentée.

## SEC-003 — Durcissement HTTP incomplet à l'origine

**Priorité faible — observation réseau confirmée, pas de vol de données démontré.**

Sur les réponses locales testées : présence de `X-Powered-By: Express`, absence de `X-Content-Type-Options: nosniff`. Le bootstrap `src/main.ts:157` ne pose pas de politique globale de ces en-têtes ; `/uploads` a sa propre politique restrictive.

Recommandation : supprimer l'en-tête de version technologique et appliquer une politique HTTP centrale compatible avec Swagger et les applications existantes. Définir explicitement `Cache-Control: no-store` pour les réponses contenant des sessions/KYC sensibles. L'absence de `Cache-Control` sur une réponse 401 ne démontre pas à elle seule la mise en cache de données privées.

Les en-têtes éventuellement ajoutés par l'infrastructure de production n'ont pas été vérifiés. HTTP local et absence de HSTS en développement ne sont pas classés comme vulnérabilités.

## Observations et protections mobile

- Swagger JSON accessible sans authentification en local ; montage inconditionnel à `src/main.ts:259`. Utile en développement ; décider explicitement de sa visibilité en production. Ce n'est pas un contournement des permissions métier.
- CORS accepte l'origine synthétique en développement, conformément à `src/common/cors-policy.ts`. La politique de production est distincte ; aucune conclusion de CORS permissif en production.
- Le backend et Metro écoutent sur toutes les interfaces. La joignabilité depuis un autre ordinateur dépend du pare-feu et n'a pas été testée. Réserver l'accès au réseau de test.
- `../zwanga/services/tokenStorage.ts` utilise SecureStore pour les jetons ; les règles Android observées excluent SecureStore des sauvegardes. `allowBackup=true` ne signifie donc pas que les jetons sont sauvegardés en clair.
- Le binaire Android inspecté est débogable et autorise le HTTP local. C'est un build debug : **pas une preuve de défaut dans le build release**.
- Tests mobile : refus de résultats KYC tardifs après changement de compte, validation stricte des URL Didit, préservation de la révocation lors de renouvellements concurrents, séparation des intentions de retrait, protection des reprises PIN et reconnexions socket bornées.
- Le plugin Babel de production retire les logs `log/info/debug`. Les logs de développement ne permettent pas de conclure à une fuite équivalente en production.

## Rejouer les contrôles

```powershell
# Serveur local déjà lancé ; aucune cible distante acceptée.
node test/security/local-boundary-probe.cjs 5200

# HTTP authentifié synthétique, sans DB ni prestataire.
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/common/security-boundaries.integration.spec.ts

# Reproductions hors réseau — code de sortie 1 attendu tant que le défaut subsiste.
node test/security/didit-status-probe.cjs
node test/security/didit-replay-probe.cjs
```

Les 22 suites initiales couvrent chat/Socket.IO, sessions/JWT/PIN/OAuth, throttling, uploads et médias KYC, règles AWS KYC, signatures PawaPay, preuve de recharge, retraits et idempotence. S'y ajoutent la nouvelle suite HTTP et quatre suites Didit/filtre d'erreurs/masquage des logs. Les tests automatiques utilisent des dépendances simulées et ne sont pas des transactions exécutées sur le backend en service.

## Limites et suite recommandée

Pas de test destructif, saturation/DoS, brute force de PIN, injection exécutée contre PostgreSQL, tentative de paiement, campagne exhaustive BOLA avec deux comptes API, extraction du stockage du téléphone, interception TLS, instrumentation/root, scan de dépendances npm, ni test iOS/release. Les prestataires externes et AWS sont hors périmètre. Les suites globales des deux dépôts n'ont pas été relancées.

Prochaine étape : corriger SEC-001 puis SEC-002, rejouer les reproductions en exigeant le refus des cinq cas, puis compléter les tests avec des comptes de recette et un APK release. Le [modèle de menaces](../../zwanga-backend-threat-model.md) distingue les défauts confirmés des scénarios restant à tester.
