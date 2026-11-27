# Réponse à la fuite des secrets Terraform

## Statut du P0 au 26 novembre 2026

L'incident reste ouvert. Les protections CI et les contrôles de rotation sont préparés localement ; aucune rotation AWS, révocation globale de sessions ou réécriture GitHub n'a encore été effectuée dans cette intervention.

La présence de `infra-aws/tfplan` est confirmée dans l'historique local : ajout dans `ba9884f` le 26 septembre, suppression dans `c319fe8` le 6 novembre. Les références locales de `origin/master` et d'autres branches conservent cet historique. Elles ne remplacent pas un inventaire actualisé des références distantes. Le décompte de 36 valeurs exposées est fourni par le signalement, pas recompté ici. Ne pas copier le plan, ses extraits ou ses valeurs dans une issue, un chat ou un rapport public.

Les métadonnées AWS consultées le 26 novembre indiquent une version SSM **1**, modifiée le **14 août 2026**, pour `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` et `JWT_REFRESH_SECRET`. La dernière modification AUTH de Redis est aussi datée du 14 août ; aucune modification Redis n'est en attente. Ces lectures ne déchiffrent aucune valeur et ne prouvent pas une égalité octet par octet avec le plan, mais n'apportent aucune preuve de révocation après la fuite. Traiter les secrets exposés comme compromis.

Le code HTTP actuel vérifie la signature puis l'empreinte du jeton enregistré (`src/auth/strategies/jwt.strategy.ts`) et utilise le rôle en base. Le rafraîchissement vérifie également le jeton stocké (`src/auth/auth.service.ts`). Les connexions WebSocket vérifient la signature et la session enregistrée (`src/common/services/ws-session.service.ts`). Fabriquer un JWT avec la seule clé ne suffit pas à passer ces contrôles dans ce code. La version effectivement déployée et les autres usages des clés restent à vérifier ; cette défense ne remplace pas leur rotation.

## Contenir et inventorier

1. Nommer un responsable et confirmer la fenêtre de maintenance, le gel des push et des déploiements. Prévenir de la reconnexion obligatoire et de l'interruption possible des trajets, du tracking et des opérations de paiement. Ne pas effectuer de test de charge pendant l'incident.
2. Vérifier les accès GitHub, CI, AWS et au state Terraform ; conserver les preuves d'audit sans secrets. Restreindre les accès injustifiés. La suppression du fichier ne révoque aucun secret.
3. Inventorier **toutes** les valeurs exposées, y compris celles des fournisseurs, de SSM, des images, sauvegardes, caches et artefacts CI. Quatre `random_password` ne couvrent pas nécessairement les 36 occurrences signalées. Pour chaque secret distinct : propriétaire, consommateurs, date de remplacement et preuve de refus de l'ancien, jamais sa valeur ni son empreinte publique.
4. Ne pas mélanger la réponse à incident avec la mise à jour PostgreSQL ou un redimensionnement. Sauvegarder le state dans un emplacement chiffré à accès restreint ; les anciens state/plans restent sensibles, même après rotation. Conserver les preuves selon la politique d'incident puis supprimer les copies non nécessaires de façon contrôlée.

## Préparer une rotation coordonnée

Les ressources sont `random_password.database`, `random_password.redis_auth`, `random_password.jwt_secret` et `random_password.jwt_refresh_secret`. L'absence de `keepers` ne prouve pas à elle seule l'absence de rotation : un `-replace` peut régénérer une valeur sans modification du code. Ne pas ajouter de `keepers` dynamiques comme un timestamp : ils pourraient déclencher une rotation non planifiée à chaque apply.

Avant de générer le plan : vérifier le compte, la région, le workspace et le backend distant exacts, l'état non vide et les quatre adresses présentes ; prendre connaissance de toutes les modifications en attente. Le répertoire de travail contient des modifications sans rapport avec l'incident : ne pas les déployer implicitement.

Dans un terminal opérateur privé WSL/Linux, depuis `infra-aws`, après ces contrôles :

```bash
umask 077
terraform plan -input=false -var-file=operators.tfvars \
  -var='redis_auth_token_update_strategy=ROTATE' \
  -var='redis_apply_immediately=true' \
  -replace=random_password.database \
  -replace=random_password.redis_auth \
  -replace=random_password.jwt_secret \
  -replace=random_password.jwt_refresh_secret \
  -out=incident-rotation.tfplan
```

Ce plan contient des secrets malgré le masquage de la sortie texte. Ne pas publier le binaire ni `terraform show -json`. Examiner le plan complet en privé : les seuls remplacements attendus sont les quatre générateurs, avec les mises à jour de leurs consommateurs RDS, Redis et SSM. Une suppression/recréation de RDS, Redis ou une modification étrangère à l'incident bloque l'opération. `redis_apply_immediately` concerne aussi les autres modifications Redis en attente : ce n'est pas un filtre limité à AUTH.

L'apply approuvé utilise **le plan enregistré et relu** : `terraform apply incident-rotation.tfplan`. Ne pas lancer cette commande avant le gel des écritures applicatives et le drainage convenu. Sur RDS, vérifier la prise en compte réelle du nouveau mot de passe avant de relancer les clients ; un paramètre SSM modifié ne démontre pas à lui seul que la base accepte déjà le nouveau mot de passe. En cas d'échec partiel, inspecter les états RDS/Redis/SSM avant toute reprise ; ne pas réexécuter aveuglément les quatre `-replace`.

## Basculer les clients puis révoquer les anciennes valeurs

1. Protéger la fenêtre de bascule : bloquer les nouvelles sessions et mutations, drainer les opérations en cours et maîtriser l'autoscaling. Ne pas garder deux générations de clés JWT au service des utilisateurs. La procédure de maintenance doit aussi couvrir les workers et les tâches planifiées.
2. Après l'apply, vérifier une **nouvelle connexion** RDS et Redis avec les nouvelles valeurs, depuis un environnement autorisé, sans les passer en arguments de shell ni dans des logs.
3. ECS injecte les secrets SSM au démarrage uniquement. Redémarrer tous les consommateurs avec la révision et le digest applicatifs validés, pas avec les nombreuses modifications locales non déployées. Les ARN SSM inchangés peuvent être rechargés par un nouveau déploiement du service existant ; vérifier néanmoins les références de la task definition. Le champ `task_definition` du service est ignoré par Terraform : un apply ne suffit pas à basculer le service.
4. Attendre l'arrêt de toutes les anciennes tâches, workers et connexions WebSocket. Un simple rolling deployment encore mixte ne clôt pas la révocation JWT. Ne jamais réintroduire les anciennes clés comme clés de secours.
5. **Redis exige une seconde phase** : `ROTATE` accepte encore l'ancien jeton. Une fois tous les clients basculés, générer un nouveau plan avec `redis_auth_token_update_strategy=SET`, `redis_apply_immediately=true`, **sans aucun `-replace`**, puis relire et appliquer ce plan approuvé. Ne jamais utiliser `DELETE`. Conserver ensuite `SET` dans la configuration opérateur privée et remettre `redis_apply_immediately=false` après revue du plan de stabilisation. Une future rotation commence explicitement par `ROTATE`.
6. Depuis une sonde privée, vérifier que les anciens identifiants RDS et Redis ne permettent plus de **nouvelle connexion**, que les anciens JWT access/refresh sont rejetés et qu'une reconnexion normale fonctionne. Les sessions déjà établies doivent être traitées séparément : changer un mot de passe ne garantit pas leur fermeture. Ne pas inscrire les secrets dans l'historique shell ou les rapports de test.
7. Vérifier API, login/refresh, admin, queues, notifications, tracking et paiements, puis reprendre le trafic et rétablir l'autoscaling. Revenir à une ancienne image applicative peut être envisagé, mais **jamais aux secrets compromis**. Une restauration de sauvegarde doit conserver/réappliquer les nouveaux identifiants et les révocations.

La rotation d'urgence peut utiliser l'image déjà déployée et validée. Le nouveau garde CI bloque volontairement une nouvelle livraison depuis un historique encore contaminé ; ne pas le contourner pour publier du code non vérifié.

## Purger GitHub après la rotation

Cette étape nécessite l'accord de l'équipe, un inventaire des branches/tags/PR, des sauvegardes privées des travaux non poussés, et un gel vérifié des push. Ne pas utiliser `git filter-repo` dans le checkout de développement sale ou dans un worktree partagé.

Dans un **clone neuf dédié**, après vérification du dépôt cible et avec `git-filter-repo >= 2.47` :

```bash
git clone --mirror https://github.com/GroupeBH/zwanga-api.git zwanga-api-cleanup.git
cd zwanga-api-cleanup.git
git filter-repo --sensitive-data-removal --invert-paths --path infra-aws/tfplan
```

Avant filtrage, ajouter les autres chemins si le plan a été copié/renommé ou si d'autres fichiers sensibles ont été identifiés. Les copies textuelles des secrets ailleurs nécessitent une purge supplémentaire ; le retrait de ce seul chemin n'est pas une preuve d'assainissement global.

Contrôler toutes les références et les rapports `filter-repo`, scanner l'historique filtré avec Gitleaks et comparer les arbres de code à contenu non sensible égal. Le force-push de branches/tags n'est réalisé **qu'après revue de la liste exacte des références et confirmation que le gel a été respecté**. Ne pas exécuter un `push --mirror` depuis le checkout courant. Aucun script fourni ici ne force-pousse automatiquement.

Les références de PR sont gérées par GitHub ; contacter GitHub Support si nécessaire pour les vues en cache/références restantes, selon ses conditions d'intervention. Coordonner aussi les forks et les clones des collaborateurs. Repartir de clones propres ; ne pas fusionner l'ancien historique et réintroduire le plan. Reporter les travaux locaux avec des patches relus/scannés, sans secrets.

## Prévention CI et clôture

`.github/actions/secret-scan` télécharge Gitleaks 8.30.1 avec SHA-256 épinglés pour x64/ARM64, scanne toutes les références locales disponibles avec `--redact=100`, sans upload de rapport ni credentials AWS. Le workflow dédié s'exécute sur push, PR, lancement manuel et chaque semaine. Les workflows de livraison production, de nouvelles images staging et de migrations exécutent le même garde **avant** l'acquisition des credentials AWS. L'arrêt/status du staging reste utilisable.

Le contrôle `scripts/security/check-sensitive-artifacts.cjs --history` inspecte les **chemins** de l'index et de l'historique complet : plans, state, fichiers de variables privés et `.env` réels sont bloqués même s'ils ont été supprimés dans HEAD. Ce contrôle ne prétend pas détecter tous les renommages de binaires arbitraires ; Gitleaks et l'inventaire d'incident restent nécessaires. Les exemples et `production.auto.tfvars` non sensible restent autorisés.

Aucune baseline globale ni exclusion générale de tests n'est ajoutée. Les résultats historiques doivent être triés en privé ; un faux positif confirmé peut recevoir une exception étroite, documentée et revue. Un CI rouge sur l'ancien historique est attendu. La CI ne bloque pas rétroactivement une fuite déjà poussée : activer aussi le contrôle requis dans les protections de branches et la push protection GitHub lorsque disponible.

Le P0 ne se ferme qu'avec ces preuves : toutes les valeurs compromises révoquées, consommateurs renouvelés, anciennes connexions/session traitées, nouvelles authentifications validées, historique et références restants traités, forks/clones coordonnés, scans propres ou faux positifs justifiés et contrôles CI réellement activés sur GitHub.

## Répétition locale validée le 26 novembre

- Tests : **8 contrôles Node** de politique CI et de chemins sensibles, **22 tests Jest** de session/authentification, ESLint ciblé, `terraform fmt -check` et `terraform validate` réussis. Test du véritable binaire Gitleaks réussi sur entrée propre et secret aléatoire synthétique, avec vérification que sa sortie ne révèle pas cette valeur.
- Le scan des références locales détecte le chemin `infra-aws/tfplan` et Gitleaks retourne **10 détections** textuelles historiques. Elles se trouvent dans des tests et documents ; leur nature doit être triée en privé, sans conclure que ce sont dix identifiants réels ni les ignorer en bloc.
- La première copie issue du checkout local a été refusée par `filter-repo` car elle incluait des stashes. Aucun `--force` n'a été utilisé et les stashes originaux n'ont pas été modifiés.
- Un miroir **neuf de GitHub**, isolé sous `tmp/security-incident/github-cleanup.git`, a ensuite été filtré : **183 références conservées, 441 commits réécrits sur 454**, aucun écart des arbres finaux hors du seul chemin retiré, aucun commit restant pour ce chemin, blob connu du plan absent des objets atteignables. L'URL de push est `DISABLED` et aucun push n'a été exécuté.
- Après cette purge de test, Gitleaks retrouve les mêmes **10 détections** : enlever le plan ne suffit donc pas à obtenir un historique déclaré propre par le scan. Le rapport est masqué et reste sous `tmp/`, ignoré par Git.
- Ce miroir est une répétition, **pas un livrable à pousser tel quel plus tard**. Repartir d'un clone neuf après le gel effectif des push, intégrer le traitement des autres détections et vérifier à nouveau toutes les références. Les branches GitHub et la production n'ont pas été modifiées.

Références : [ElastiCache AUTH et ROTATE/SET](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/auth.html), [suppression de données sensibles sur GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), [Gitleaks](https://github.com/gitleaks/gitleaks).
