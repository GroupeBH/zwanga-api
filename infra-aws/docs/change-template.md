# INFRA-AAAA-MM-JJ-NNN — Titre court

## Métadonnées

| Champ | Valeur |
| --- | --- |
| Date et heure | AAAA-MM-JJ HH:MM, fuseau |
| Auteur / opérateur | Nom ou rôle |
| Environnement | développement, staging ou production |
| Statut | planifié, appliqué, validé ou annulé |
| Type | Terraform, CI/CD, réseau, données, sécurité, observabilité ou opération manuelle |
| Référence | ticket, incident, commit ou workflow |

## Contexte et objectif

Décrire le problème, le besoin, le signal observé et le résultat attendu.

## État avant la modification

Décrire les ressources, dépendances et comportements existants. Inclure les noms ou ARN non secrets utiles au diagnostic.

## Cause racine ou justification

Présenter les faits vérifiés. Distinguer explicitement les preuves des hypothèses.

## Modifications réalisées

### Code et configuration

| Fichier | Modification | Raison |
| --- | --- | --- |
| `chemin/fichier` | Description précise | Justification |

### Ressources AWS

| Ressource | Action | État final |
| --- | --- | --- |
| Type et nom/ARN | création, modification, remplacement ou suppression | Résultat attendu |

### Variables et paramètres

| Nom | Source | Type | Valeur documentée |
| --- | --- | --- | --- |
| `VARIABLE` | Terraform, SSM ou GitHub | texte ou `SecureString` | ne jamais copier un secret |

## Impacts

### Disponibilité

Préciser l'interruption possible, le comportement pendant le déploiement et le rayon d'impact.

### Sécurité et IAM

Préciser toute permission ajoutée ou retirée, ainsi que le principe du moindre privilège.

### Données et migrations

Préciser les écritures, migrations, sauvegardes et risques de perte ou de divergence.

### Coûts

Préciser les services facturables créés, redimensionnés ou supprimés, même si l'impact estimé est nul.

## Procédure de déploiement

1. Préconditions et sauvegardes.
2. Commandes de planification.
3. Lecture et approbation du plan.
4. Commandes d'application.
5. Redéploiement ou migration.

Ne jamais inclure de secret dans les commandes documentées.

## Validation réalisée

| Contrôle | Résultat attendu | Résultat obtenu |
| --- | --- | --- |
| `terraform fmt -check -recursive` | format valide | à renseigner |
| `terraform validate` | configuration valide | à renseigner |
| Test AWS ou applicatif | résultat | à renseigner |

## Surveillance post-déploiement

Lister les métriques, alarmes, journaux et durée de surveillance.

## Retour arrière

Décrire les commandes et l'ordre exact. Indiquer les conditions où le retour arrière est interdit ou nécessite une sauvegarde/validation supplémentaire.

## Résultat final et éléments restant à faire

Résumer l'état réellement atteint, les limites connues et les actions encore ouvertes.
