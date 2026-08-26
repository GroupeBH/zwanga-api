# Documentation des changements d'infrastructure

Ce dossier est le registre opérationnel de l'infrastructure AWS de Zwanga. Toute modification qui peut changer une ressource AWS, un déploiement, une variable runtime, une permission IAM, un coût, un flux réseau, une migration ou une procédure d'exploitation doit être documentée dans le même changement Git.

## Documents

- [CHANGELOG.md](./CHANGELOG.md) : historique détaillé et chronologique des changements réellement effectués ;
- [change-template.md](./change-template.md) : modèle à copier pour chaque nouvelle entrée.
- [xray-remote-sampling.md](./xray-remote-sampling.md) : architecture, diagnostic et validation de l'échantillonnage X-Ray.
- [public-api-https.md](./public-api-https.md) : délégation DNS, certificat ACM, listener ALB et protections Terraform du domaine public.

Le [README principal](../README.md) reste la documentation de l'état courant de l'architecture. Le journal explique pourquoi et comment cet état a changé.

## Règle obligatoire

Une modification de l'un des éléments suivants doit ajouter ou mettre à jour une entrée dans `infra-aws/docs/CHANGELOG.md` :

- fichiers Terraform dans `infra-aws/` et `infra-aws/bootstrap/` ;
- scripts d'import, de migration, de validation ou d'exploitation AWS ;
- workflow GitHub de déploiement AWS ;
- image ou configuration de conteneur utilisée pour AWS ;
- paramètre SSM, secret, rôle ou politique IAM modifié directement dans AWS ;
- action manuelle qui change une ressource, une définition de tâche ou un service AWS.

Une entrée doit préciser au minimum :

1. le contexte et la raison ;
2. l'état avant et après ;
3. chaque fichier et ressource AWS concerné ;
4. les variables, paramètres et secrets concernés sans révéler leur valeur ;
5. les impacts sécurité, disponibilité, données et coûts ;
6. la procédure de déploiement ;
7. les contrôles et leurs résultats ;
8. la surveillance post-déploiement ;
9. la procédure de retour arrière.

Les mots de passe, clés, jetons, valeurs `SecureString` et chaînes de connexion ne doivent jamais apparaître dans cette documentation.

## Contrôle automatique

Le workflow `.github/workflows/infra-documentation.yml` appelle `infra-aws/scripts/check-infra-documentation.sh`. Si un fichier d'infrastructure change sans modification simultanée du journal, le contrôle échoue avant fusion ou déploiement.

Le contrôle peut aussi être lancé localement :

```bash
bash infra-aws/scripts/check-infra-documentation.sh <commit-base> HEAD
```

Pour vérifier les modifications locales non commitées :

```bash
bash infra-aws/scripts/check-infra-documentation.sh HEAD WORKTREE
```

Ce contrôle garantit la présence d'une entrée, pas sa qualité. La revue humaine doit vérifier que le modèle est entièrement renseigné et que les preuves annoncées correspondent aux commandes réellement exécutées.
