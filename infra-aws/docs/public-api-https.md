# HTTPS de l'API publique

## Objectif

L'API de production doit être accessible sur `https://compute-api.zwanga-app.com` avec un certificat public renouvelable, une résolution DNS autoritaire et une redirection permanente de HTTP vers HTTPS.

## Architecture DNS

Le domaine parent `zwanga-app.com` utilise les serveurs DNS de Vercel. Le sous-domaine API est délégué à une zone publique Route53 séparée :

```text
zwanga-app.com — DNS Vercel
        |
        | NS pour compute-api.zwanga-app.com
        v
compute-api.zwanga-app.com — Route53 Z0100742PIM0UW6FZED7
        |
        | A/ALIAS
        v
Application Load Balancer eu-central-1
```

La zone enfant Route53 possède les quatre serveurs autoritaires suivants :

- `ns-529.awsdns-02.net` ;
- `ns-441.awsdns-55.com` ;
- `ns-2030.awsdns-61.co.uk` ;
- `ns-1105.awsdns-10.org`.

Ces valeurs ne sont pas secrètes. La délégation NS existe chez Vercel ; les autres enregistrements du sous-domaine doivent être créés dans la zone enfant Route53, pas en doublon chez Vercel.

## Chaîne HTTPS gérée par Terraform

Terraform gère :

1. un certificat ACM public pour `compute-api.zwanga-app.com` dans `eu-central-1` ;
2. le CNAME Route53 prouvant le contrôle du domaine à ACM ;
3. le CAA autorisant les autorités de certification Amazon ;
4. un alias `A` Route53 vers l'Application Load Balancer ;
5. l'entrée publique `443/TCP` du Security Group de l'ALB ;
6. le listener ALB HTTPS avec la politique `ELBSecurityPolicy-TLS13-1-2-2021-06` ;
7. la redirection du listener HTTP `80` vers HTTPS `443`.

Le health check interne de l'ALB reste `/health`. La route NestJS est volontairement exclue du préfixe global : l'URL correcte est donc `/health`, et non `/api/v1/health`.

## Source de vérité des variables

Le fichier `production.auto.tfvars` est versionné et chargé automatiquement. Il contient uniquement des identifiants non sensibles indispensables : dépôt GitHub, bucket d'uploads, domaine public et Hosted Zone ID.

Les mots de passe, jetons et clés API ne doivent jamais y être ajoutés. Ils restent dans AWS SSM Parameter Store.

Cette source auto-chargée évite qu'un opérateur oublie `api_domain_name` ou `route53_hosted_zone_id` lors d'un `terraform apply`.

## Protections contre une suppression accidentelle

Deux niveaux de protection sont appliqués :

- `terraform_data.production_https_guard` bloque un plan de production si le domaine ou la source du certificat manque ;
- `prevent_destroy` protège le certificat, les enregistrements DNS critiques, le listener HTTPS et la règle réseau `443`.

Une suppression volontaire exige donc une modification de code explicite retirant temporairement ces protections, une revue du plan et une entrée dédiée dans le journal d'infrastructure.

## Diagnostic

### `Could not resolve host`

Cette erreur signifie que le client n'a obtenu aucun enregistrement `A` ou `AAAA`. Vérifier dans l'ordre :

1. les NS publics de `compute-api.zwanga-app.com` ;
2. l'alias `A` dans la zone Route53 enfant ;
3. l'état `ISSUED` du certificat ACM ;
4. le listener `443` de l'ALB.

### Mauvais chemin de santé

Utiliser :

```bash
curl -v https://compute-api.zwanga-app.com/health
```

`/api/v1/health` n'est pas la route de santé publiée par l'application.

## Validation après déploiement

1. `terraform plan` ne doit contenir aucune destruction.
2. ACM doit afficher le certificat en état `ISSUED`.
3. Route53 doit contenir le CNAME de validation, le CAA et l'alias `A`.
4. La résolution publique doit retourner les adresses de l'ALB.
5. `https://compute-api.zwanga-app.com/health` doit répondre `200`.
6. `http://compute-api.zwanga-app.com/health` doit répondre par une redirection `301` vers HTTPS.
7. Un plan Terraform après application ne doit proposer aucune modification.

## Retour arrière

Ne pas supprimer le certificat ou l'alias DNS pendant un incident applicatif : ils ne contiennent aucune donnée métier et leur suppression rend l'API inaccessible.

Si le listener HTTPS présente un problème, conserver le DNS et le certificat, puis restaurer la dernière configuration de listener connue comme saine. Toute désactivation complète du domaine public nécessite une fenêtre de maintenance, le retrait explicite des protections Terraform et une validation des applications mobiles qui consomment cette URL.
