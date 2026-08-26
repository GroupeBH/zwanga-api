# INFRA-2026-08-26-001 — Paramètres runtime du versement conducteur

## Métadonnées

| Champ | Valeur |
| --- | --- |
| Date et heure | 26 août 2026, Africa/Kinshasa |
| Auteur / opérateur | équipe Zwanga |
| Environnement | production AWS ECS Fargate |
| Statut | code préparé ; import SSM et déploiement non exécutés |
| Type | configuration runtime, SSM, ECS et paiement |
| Référence | `FIN-DRIVER-001` |

## Contexte et objectif

Le retrait des revenus conducteur utilise FlexPay `merchantPayOutService`. Le backend doit recevoir le minimum de retrait, les URLs FlexPay, le code marchand, le jeton d'autorisation et une URL de callback publique. Le mécanisme existant importe les entrées de `.env.production` dans AWS Systems Manager Parameter Store et rend automatiquement les paramètres externes disponibles dans la prochaine définition de tâche ECS.

## État avant la modification

- `FLEXPAY_PAYOUT_SERVICE_URL`, `FLEXPAY_CHECK_TRANSACTION_URL`, `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL`, `FLEXPAY_TOKEN`, `FLEXPAY_MERCHANT_CODE` et `FLEXPAY_VERIFY_CALLBACKS` sont déjà supportées par le code et les exemples d'environnement.
- Le minimum de retrait conducteur n'était pas configurable séparément.
- Aucune ressource AWS n'a été créée ou modifiée pendant l'implémentation locale.

## Modification préparée

| Fichier | Modification | Raison |
| --- | --- | --- |
| `.env.production` | ajout de `DRIVER_PAYOUT_MIN_AMOUNT_CDF` | configurer le seuil sans redéployer du code |
| `.env.example` | valeur locale documentée | aligner les environnements |
| `.env.docker.example` | valeur conteneur documentée | aligner Docker et ECS |
| `docs/finance/driver-electronic-trip-payout.md` | flux financier et exploitation | fournir la référence métier et comptable |

## Paramètres SSM attendus

Préfixe par défaut : `/<project_name>/<environment>/env/`.

| Variable | Type SSM attendu | Sensibilité | Valeur documentée |
| --- | --- | --- | --- |
| `DRIVER_PAYOUT_MIN_AMOUNT_CDF` | `SecureString` par le script commun | faible | montant positif, exemple `1` |
| `FLEXPAY_PAYOUT_SERVICE_URL` | `SecureString` | moyenne | URL FlexPay de production, non copiée ici |
| `FLEXPAY_CHECK_TRANSACTION_URL` | `SecureString` | moyenne | URL FlexPay de vérification, non copiée ici |
| `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL` | `SecureString` | moyenne | URL HTTPS publique dédiée ou vide avec base publique |
| `FLEXPAY_TOKEN` | `SecureString` | secret | jamais documenté |
| `FLEXPAY_MERCHANT_CODE` | `SecureString` | sensible | jamais documenté |
| `FLEXPAY_VERIFY_CALLBACKS` | `SecureString` | critique | `true` en production |

## Ressources AWS

L'import prévu crée ou met à jour les paramètres SSM sous le préfixe runtime. Terraform les découvre via `data.aws_ssm_parameters_by_path.external_runtime_environment`. La prochaine révision de la définition ECS référence leurs ARN dans `secrets`.

Aucune modification d'ACM, Route53, ALB, RDS, Redis, VPC ou IAM n'est attendue.

## Impacts

- Disponibilité : l'import SSM seul n'interrompt pas le service ; la nouvelle valeur prend effet au prochain rolling deployment ECS.
- Sécurité : aucun secret ne doit être passé en argument de ligne de commande ou affiché dans les logs. Le rôle d'exécution ECS possède déjà les permissions de lecture du préfixe.
- Données : la variable ne modifie aucun solde. La migration applicative `1780000022000` doit être exécutée séparément.
- Coûts : coût SSM/ECS inchangé à l'échelle de ce paramètre ; les transferts FlexPay peuvent avoir des frais contractuels externes.

## Procédure de déploiement

Depuis la racine du dépôt, avec le profil et la région AWS de production déjà configurés :

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\infra-aws\scripts\import-env-to-ssm.ps1 `
  -EnvFile .\.env.production
```

Puis :

1. vérifier que la sortie ne contient aucune valeur, uniquement les noms et statuts ;
2. exécuter `terraform plan` avec les variables de production auto-chargées ;
3. refuser tout plan supprimant ACM, DNS, ALB, SSM, RDS ou Redis ;
4. appliquer le plan approuvé ;
5. effectuer le rolling deployment ECS ;
6. exécuter la migration applicative selon le runbook de déploiement ;
7. vérifier `/api/v1/health` et le chargement des revenus conducteur.

## Validation attendue

| Contrôle | Résultat attendu | État |
| --- | --- | --- |
| import `.env.production` | paramètre présent sans secret affiché | à exécuter |
| découverte Terraform | variable incluse dans `external_runtime_environment` | à exécuter |
| plan Terraform | aucune destruction inattendue | à exécuter |
| nouvelle tâche ECS | conteneur `api` sain | à exécuter |
| résumé conducteur | `minimumPayoutAmount` correspond à SSM | à exécuter |
| retrait de validation | état initié puis confirmé/échoué sans double débit | à exécuter |

## Surveillance post-déploiement

Pendant au moins 30 minutes :

- erreurs `DRIVER_PAYOUT_RECONCILIATION_FAILED` ;
- retraits `pending` ou `initiated` anormalement anciens ;
- callbacks FlexPay non associés à une transaction ;
- écarts entre `driver_payouts.succeeded` et les transferts FlexPay ;
- santé ECS, erreurs HTTP 5xx et latence de l'API.

## Retour arrière

1. Ne pas supprimer les paramètres FlexPay tant qu'un retrait est en cours.
2. Remettre la définition ECS précédente uniquement après avoir recensé les retraits `pending` et `initiated`.
3. Conserver `FLEXPAY_VERIFY_CALLBACKS=true` ; ne pas l'utiliser comme mécanisme de rollback.
4. Une baisse ou hausse du minimum affecte seulement les nouvelles demandes ; aucun retrait historique n'est recalculé.

## Résultat final et reste à faire

La configuration est versionnée et documentée localement. L'import SSM, le plan Terraform, le déploiement ECS, la migration et le test FlexPay de production restent à exécuter explicitement.
