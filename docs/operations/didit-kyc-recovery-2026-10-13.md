# Livraison du correctif KYC Didit — 13 octobre 2026

## 14 octobre 2026 — Reprise d'un KYC déjà approuvé et d'un compte existant

Le diagnostic en lecture seule a confirmé des réponses `409` à la création de
session parce que l'identité était déjà vérifiée, et des refus d'inscription pour
un numéro déjà enregistré. Le message mobile générique masquait ces états métier.
Ces observations ne démontrent pas une indisponibilité générale de l'inscription.

Correctifs locaux :

- `src/users/didit-kyc.service.ts` conserve `409 KYC_ALREADY_APPROVED`, désormais
  prioritaire sur la configuration Didit et la bascule AWS. Aucun dossier approuvé
  n'est réinitialisé ; aucun fournisseur n'est appelé pour le recréer. Les nouvelles
  vérifications restent soumises à la configuration et aux contrôles existants.
- `src/auth/auth.service.ts` et `src/users/registration-phone.policy.ts` ajoutent
  `PHONE_ALREADY_REGISTERED` aux refus existants, y compris lors de la vérification
  concurrente. Les statuts HTTP historiques (401/400), messages et règles de
  réutilisation des numéros des comptes indisponibles restent inchangés.
- Dans le dépôt mobile `zwanga`, le flux lit `/users/kyc/status` sans préférence
  pour le cache avant de choisir un fournisseur. Si le statut est `approved`, il
  invalide les caches du profil, recharge le compte et poursuit sans SDK ni navigateur.
  Un `KYC_ALREADY_APPROVED` reçu après cette première lecture provoque une nouvelle
  lecture serveur : un autre conflit, un statut en attente ou un échec réseau ne
  vaut jamais approbation. Un changement de compte interrompt la reprise.
- L'inscription mobile propose « Se connecter » (numéro conservé, PIN et contexte
  d'inscription effacés) ou « Modifier le numéro ». La récupération du PIN reste
  accessible par le bouton existant de connexion, avec ses contrôles OTP inchangés.
  Le refus métier 401 ne provoque plus de renouvellement de session/rejeu du POST.

Compatibilité et livraison : aucune migration, variable d'environnement, modification
Terraform/CI/CD ou opération AWS. Les contrats de création/synchronisation Didit restent
compatibles ; aucune fausse URL ou réponse 200 sans session n'est introduite. **Le
backend seul ne change pas le message des anciennes applications : le nouveau parcours
nécessite de livrer aussi les changements mobiles.** Le nouveau mobile reconnaît les
anciens messages de doublon en attendant la livraison du backend.

Vérifications locales : 422 tests backend réussis (30 suites auth/users/filtre),
compilation backend réussie ; 99 tests mobiles ciblés et suite JavaScript mobile
complète réussis (`node --test --test-reporter=dot --test-concurrency=4 tests/*.test.js`),
contrôle TypeScript et contrôles de frontière réseau/taille des sources réussis. Fournisseurs et entrées/
sorties natives simulés ; aucun SMS, dossier Didit/AWS, compte réel ou déploiement créé.
Les essais Android/iOS réels restent à faire : compte déjà validé (Didit ou AWS),
nouveau compte sans KYC, validation manuelle pendant le démarrage du parcours,
numéro déjà utilisé puis connexion/récupération du PIN, erreur réseau sans faux succès.

## Ce qui est prêt et ce qui reste à livrer

Le code local appelle directement `POST /v3/session/` avec le workflow configuré,
comme le backend historique. Le contrôle de publication ajouté pendant le diagnostic
a été retiré du parcours utilisateur : il produisait un nouveau `503` avant même
d'interroger l'API de sessions. Didit décide si le workflow permet de créer une session ;
ses refus restent propagés. Les sessions terminales/expirées sont toujours refusées
et l'échéance est transmise quand Didit la fournit.
Le mode opérationnel `DIDIT_KYC_LAUNCH_MODE=hosted` permet aux applications déjà
installées d’ouvrir le parcours web Didit au lieu du SDK natif : même session,
même compte, mêmes règles d’identité, pas de deuxième vérification créée.
Le choix local absent reste `native`. La production Terraform prépare `hosted`.

**Aucun déploiement AWS, publication Didit ou changement de statut KYC réalisé ici.**
Le diagnostic administratif a trouvé un workflow en brouillon, sans version publiée de son groupe.
Cela ne prouve pas que la publication explique la régression mobile signalée par
l'utilisateur après mise à jour. Ne pas publier ou remplacer ce workflow pour
contourner l'erreur SDK sans preuve et décision explicite. Le précontrôle administratif
n'est plus une condition de disponibilité de l'endpoint de création.
Les sessions examinées n’étaient pas expirées côté fournisseur ; cela ne démontre
pas à lui seul la cause du message d’expiration du SDK Android. Le parcours hébergé
est une solution de continuité à tester sur téléphone réel, pas une preuve que le SDK
est réparé. Les anciens dossiers ne changent pas de version après publication.

## Vérification du contournement sans livraison mobile

Le message utilisateur confirmé est « votre session a expiré, veuillez recommencer
votre validation ». Le correctif contourne le SDK natif : il ne répare pas son binaire
et ne prolonge pas une session réellement expirée. L'utilisateur doit relancer le
parcours depuis Zwanga après livraison du backend et de sa configuration.

Contrôles réalisés le 13 octobre 2026 :

- Les sources mobiles historiques du commit `433165a` (configuration `1.0.16`)
  et du commit `57dcb28` possèdent déjà le parcours navigateur quand
  `sessionToken` est absent. Le normaliseur utilise aussi `session_token` : les
  **deux** champs doivent donc être `null`, avec l'URL du même dossier Didit.
- Exécution JavaScript des hooks et normaliseurs de ces deux commits, lus par
  `git show`, avec la réponse du helper backend réel et des entrées/sorties natives
  simulées : **12 scénarios réussis** (2 commits × Android/iOS simulés × validation,
  attente, annulation). Aucun appel SDK ; une seule création par tentative ;
  synchronisation du même dossier au retour. Un statut serveur en attente reste
  en attente même si le lien de retour indique `Approved`.
- Avant retrait du précontrôle, `npm.cmd test -- --runInBand --silent didit` :
  **5 suites, 65 tests réussis**.
  Les régressions couvrent les deux alias de jeton, le lien de retour applicatif,
  le refus d'une URL hébergée absente/non autorisée sans repli natif ni deuxième
  création, et le refus d'approuver sur la seule déclaration du navigateur.
- `npm.cmd run build` : compilation réussie. Aucun serveur local démarré.
- Nouveau contrôle en lecture seule avec les paramètres SSM de production :
  `KYC_WORKFLOW_NOT_PUBLISHED`. Aucun workflow publié ni session créée par ce
  contrôle. Ce résultat concernait le contrôle administratif ajouté, pas un refus
  observé de `POST /v3/session/`. Il ne doit plus empêcher la recette du parcours existant.

Correction du précontrôle : tests de non-régression ajoutés pour les modes `native`
et `hosted`, avec un seul POST au fournisseur, le même identifiant de workflow et
aucun appel à l'API de gestion des workflows. Les refus HTTP 400/403/503 du fournisseur
restent bloquants, sans sauvegarde d'un dossier ni approbation. L'appel SDK et la
version npm Didit sont identiques dans les sources mobiles `433165a` et `57dcb28` ;
cela ne prouve pas l'identité des binaires distribués ni la cause de leur régression.
Après cette correction : **5 suites Didit, 69 tests réussis**, avec fournisseur
simulé. Aucun appel de création réel, aucune publication ni modification de workflow.

Limites : il ne s'agit pas d'essais caméra/navigateur sur appareils physiques.
Le commit exact du binaire des stores (build 145 annoncé) n'est pas établi ;
EAS utilise une numérotation distante. La présence du parcours web dans l'historique
`1.0.16` est vérifiée, mais ne remplace pas un essai avec l'application réellement
installée depuis chaque store. Aucun fichier mobile, CI/CD ou Terraform supplémentaire
n'a été modifié lors de ces contrôles de compatibilité.

## Test local sans modification du workflow

Conserver la clé et le workflow existants dans le `.env` backend et sélectionner
`DIDIT_KYC_LAUNCH_MODE=hosted`. Le fichier local a été constaté avec cette valeur.
Arrêter le serveur existant dans son terminal avant de relancer `npm run start:dev`
(ou recompiler puis `npm start` si l'on exécute `dist`). Aucun serveur supplémentaire
n'est démarré par ce correctif. L'application de développement doit viser l'API du PC.

Lancer une tentative KYC avec son compte de test : l'endpoint doit appeler directement
Didit et retourner l'URL de la session, avec les deux alias de jeton SDK à `null`.
Vérifier l'ouverture du navigateur, la capture et la synchronisation du même dossier
au retour. Si le fournisseur refuse lui-même la création, examiner ce refus précis :
ne pas générer d'URL artificielle, approuver le dossier ou publier automatiquement.
Un essai local avec des clés live reste une véritable opération chez Didit.

## Diagnostic administratif optionnel

Depuis le dépôt backend, avec Node 22+ et les accès AWS de l’opérateur :

```powershell
npm.cmd test -- --runInBand didit
npm.cmd run build
node dist/users/didit-kyc-preflight.js --ssm --profile default --region eu-central-1
```

Le contrôle est en lecture seule et ne crée aucune session. Il lit uniquement la
clé et la référence de workflow dans SSM, en mémoire. Sa sortie contient un résultat
et un code, jamais la clé, la référence, un document ou une donnée utilisateur.
Dans ECS, les variables déjà injectées peuvent être utilisées sans `--ssm`.

L'outil conserve son ancien champ `available` : il indique seulement si une version
publiée a été trouvée par l'API de gestion, **pas** si l'API de sessions acceptera une
demande ni si le SDK fonctionnera. Il n'est plus un prérequis au test ou à la livraison.

L'option explicite `--publish` reste un outil d'administration séparé, non utilisé
par le serveur et non nécessaire au contournement SDK. Ne l'utiliser qu'après demande
et revue du workflow. Elle écrit `{ "status": "published" }` sur la version configurée.
Elle refuse une version archivée, une autre référence, l’absence des contrôles de
présence/comparaison ou des documents RDC. Les seuils, types de documents, graphe,
options et durées suivis sont comparés avant/après. Elle relit ensuite les versions
publiées. Aucun remplacement automatique par un autre workflow. Si la réponse de
publication est perdue, relancer d’abord le contrôle sans `--publish` ; une version
déjà publiée ne déclenche pas une nouvelle écriture. Toute divergence après écriture
exige une revue dans Didit, sans restauration automatique des règles d’identité.

## Configuration et déploiement backend

Le paramètre `didit_kyc_launch_mode` est validé par Terraform. La configuration
`production.auto.tfvars` sélectionne le mode hébergé, et `ecs.tf` produit le paramètre
SSM `DIDIT_KYC_LAUNCH_MODE` par le mécanisme existant. Il est réservé à Terraform
pour éviter deux sources de configuration. Aucune clé Didit n’est créée ou modifiée.

```powershell
terraform -chdir=infra-aws fmt -check
terraform -chdir=infra-aws validate
terraform -chdir=infra-aws plan -out=kyc-hosted.tfplan
```

Examiner le plan complet, en particulier les autres changements locaux : liveness
`/health/live`, disponibilité et correctifs de livraison peuvent également être présents.
Appliquer le plan approuvé, puis livrer le backend par le workflow existant de la branche
`release`. Ne pas pousser un worktree non relu pour déclencher la production.

```powershell
terraform -chdir=infra-aws apply kyc-hosted.tfplan
```

Le workflow existant utilise la configuration de tâche la plus récente et une nouvelle
image immuable. Les secrets SSM sont chargés au démarrage : une tâche déjà active ne
reçoit pas le nouveau mode en direct. Vérifier la nouvelle révision effectivement
utilisée, la présence du nom du paramètre dans la définition et la stabilité ALB/ECS.
Aucun nouveau build mobile n’est requis pour le mode web dans les versions utilisant
déjà l’URL de secours. Les correctifs mobiles en cours ont leur propre livraison.

## Recette nécessaire et surveillance

- Android physique : compte existant, créer une nouvelle session après livraison,
  photographier recto/verso (ou passeport), poursuivre le selfie, revenir à Zwanga et
  constater le statut issu du serveur. Tester aussi annulation et réseau interrompu.
- iPhone physique : ouverture du navigateur, caméra, retour par le lien applicatif
  et synchronisation de statut. Aucun résultat natif n’a été obtenu pendant la préparation.
- Confirmer que le mode hébergé renvoie les deux alias de jeton à `null`, les deux
  alias d’URL cohérents et aucune URL hors `https://verify.didit.me/session/...`.
- Les signatures de webhook, propriétaire du dossier, comparaison d’identité,
  activation conducteur et bonus restent validés par le serveur. Ne jamais approuver
  un dossier pour contourner un message d’expiration. Les retours de comptes inconnus
  doivent être rapprochés de leur environnement d’origine, pas rattachés arbitrairement.
- Suivre les codes `KYC_PROVIDER_REJECTED_REQUEST`, `KYC_PROVIDER_UNUSABLE_SESSION` et
  `KYC_HOSTED_URL_UNAVAILABLE`, les erreurs Didit et les transitions de statut pendant
  la recette et les premières tentatives réelles. Les codes `KYC_WORKFLOW_*` du
  diagnostic administratif ne sont plus émis par le parcours de création de session.

## Retour arrière et coûts

Le code sans variable conserve le lancement natif. Pour le rétablir, passer
`didit_kyc_launch_mode` à `native`, examiner/appliquer le plan et remplacer les tâches,
uniquement après confirmation que le SDK fonctionne. Revenir à l’image précédente
conserve le même schéma ; aucune migration ni restauration de base ajoutée par ce correctif.
La publication Didit est distincte du déploiement ECS et rend une version immuable :
ne pas tenter de la remettre en brouillon pour simuler un rollback. Une restauration
de règles suit le mécanisme Didit de nouvelle version/publiée après revue.

Pas de nouvelle ressource facturable structurelle, dépendance, permission IAM ou
migration. La recette réalise de vraies vérifications Didit susceptibles d’être
facturées selon les features complétées et le contrat courant. Le contrôle et la
publication n’en créent aucune. L’outil opérationnel exige une clé ayant les droits
de lecture des workflows et, avec `--publish`, le droit de les modifier.

## Références fournisseur

- [Versions publiées](https://docs.didit.me/console/workflows#workflow-versioning)
- [Liste des workflows](https://docs.didit.me/management-api/workflows/list)
- [Publication ciblée](https://docs.didit.me/management-api/workflows/update)

