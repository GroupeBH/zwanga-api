# Proxy sortant Mobishastra avec IP fixe

Ce module prépare une EC2 dédiée aux connexions HTTPS de Mobishastra. Le backend
reste sur ECS et conserve sa sortie Internet actuelle pour les autres services.
La configuration est préparée localement ; son application AWS et l'activation
du fournisseur OTP sont des opérations distinctes.

## Architecture et périmètre

```text
MobishastraSmsService → IP privée EC2:3128 → tunnel HTTPS → Mobishastra
                                           sortie par Elastic IP fixe
Tous les autres appels ECS → sortie actuelle, inchangée
```

- Compte `046374119247`, région `eu-central-1`, VPC existant `10.42.0.0/16`.
- EC2 Ubuntu 24.04 ARM64 `t4g.micro`, disque gp3 chiffré de 8 Gio, crédits CPU
  standard pour éviter la facturation Unlimited. Pas d'instance Spot.
- Elastic IP et interface réseau indépendantes de l'EC2, protégées par
  `prevent_destroy`. Leur conservation stabilise à la fois la liste blanche
  Mobishastra et l'adresse privée utilisée par ECS.
- Squid configuré par Ansible au démarrage. Aucun conteneur applicatif,
  code OTP, secret Mobishastra ou donnée utilisateur sur l'instance.
- État Terraform séparé : `zwanga/mobishastra-proxy/terraform.tfstate`.
  Ne jamais copier/importer l'état de production, ni utiliser `-migrate-state`.
- Aucune modification des routes, sous-réseaux, ALB, tâches ECS, bases ou CI/CD.
  Une seule règle s'ajoute au groupe ECS existant : sortie TCP 3128 vers le
  nouveau groupe de sécurité du proxy. Les autres règles restent inchangées.

Les identifiants de sous-réseau et de groupe ECS proposés dans `main.tf` ont été
relevés dans l'infrastructure existante. Les vérifier avant application.
Le module refuse un groupe d'un autre VPC ou un sous-réseau sans route Internet
Gateway ; Ansible refuse un hôte hors du VPC et de l'OS prévus.

## Protection du transport

Squid n'accepte que `CONNECT` vers `valuesms.ae:443` et `mshastra.com:443`.
Les sous-domaines, IP littérales, autres ports, autres méthodes et adresses
privées/réservées sont refusés, y compris si un domaine autorisé résout vers
une adresse privée. Le proxy n'a pas d'entrée publique ; le groupe ECS est
la seule source réseau autorisée. La boucle locale sert à l'administration SSM.

Le tunnel conserve TLS jusqu'au fournisseur : pas de `ssl_bump`, pas de certificat
d'interception, pas de secret API dans Squid. L'application continue de contrôler
l'URL exacte `/sendsms_api_json.aspx` et refuse les redirections ; un proxy CONNECT
ne peut pas contrôler le chemin HTTP chiffré.

Les journaux d'accès contiennent uniquement date, durée, état et volume, jamais
l'URL, les en-têtes, le corps SMS ou le téléphone. Rotation quotidienne, sept
archives, seuil de taille de 5 Mio vérifié lors du passage de logrotate.
Le rôle EC2 autorise les canaux SSM et une métrique CloudWatch dédiée, sans lecture
des paramètres applicatifs ni accès aux buckets de données. Aucun SSH public.
Les sorties 80/443 de l'hôte permettent aussi Ubuntu, SSM et CloudWatch : la
restriction par domaine est appliquée par Squid, pas par le groupe de sécurité.

## Configuration du backend

| Variable | Valeur après mise en service |
| --- | --- |
| `MOBISHASTRA_PROXY_URL` | Sortie Terraform `backend_proxy_url`, par exemple `http://10.42.0.123:3128` |
| `MOBISHASTRA_PROXY_REQUIRED` | `true` pour refuser une URL manquante |

Ces variables ne remplacent ni `MOBISHASTRA_SMS_URL`, ni les identifiants SMS.
Elles ne modifient pas `OTP_PROVIDER` et ne rendent pas l'OTP obligatoire.
Sans URL et sans obligation, le mode direct reste disponible. Une URL renseignée
mais invalide échoue toujours, même si l'obligation est désactivée.

La seule forme acceptée est `http://IPv4-privee:port`, sans identifiants, chemin,
paramètres ou fragment. L'IP privée provient de l'interface persistante : aucune
résolution DNS du proxy n'est nécessaire. `127.0.0.1` est autorisé uniquement avec
`NODE_ENV=development` ou `test`, pour un tunnel SSM local.

Le client utilise un agent HTTPS natif Node dédié, avec un pool limité à huit
connexions. Node du projet est requis (`>=24.22.1 <25`). Les variables globales
`HTTP_PROXY`, `HTTPS_PROXY` et `NO_PROXY` ne pilotent pas ce transport. L'URL SMS
reste HTTPS même si l'adresse du tunnel privé commence par `http://`.

Une limite de dix secondes couvre la requête et la création du tunnel. Un refus,
timeout ou certificat invalide renvoie `OTP_SMS_UNAVAILABLE` ; une configuration
invalide renvoie `OTP_SMS_PROXY_MISCONFIGURED`. Aucune tentative directe ni répétition
automatique d'un SMS après un résultat ambigu. La vérification d'un OTP déjà reçu
continue à utiliser Redis, sans dépendre de la disponibilité du proxy.

## Créer le proxy après validation du plan

Les commandes suivantes sont destinées à l'opérateur et créent des ressources
facturables uniquement lors de `apply`. Elles n'ont pas été exécutées sur AWS.

```bash
cd infra-aws/environments/mobishastra-proxy
terraform init -reconfigure
terraform plan -out=proxy.tfplan
terraform show proxy.tfplan
# Après revue du compte, des ajouts, du coût et de la règle ECS :
terraform apply proxy.tfplan
terraform output -raw mobishastra_whitelist_ipv4
terraform output -raw backend_proxy_url
terraform output -raw instance_id
```

L'Elastic IP est attachée avant le démarrage de l'instance pour permettre
l'installation des paquets. Attendre la fin de cloud-init : un `apply` réussi
ne prouve pas que Squid est prêt.

Via Session Manager, vérifier sur l'instance :

```bash
cloud-init status --wait
sudo systemctl status squid --no-pager
sudo python3 /opt/zwanga-mobishastra-proxy/health.py --check-only
sudo systemctl status zwanga-proxy-health.timer --no-pager
```

Faire autoriser **`mobishastra_whitelist_ipv4`** par Mobishastra, pas l'IP privée
et pas l'ALB. Vérifier ensuite une connexion TLS sans envoyer de SMS :

```bash
curl --proxy http://127.0.0.1:3128 --connect-timeout 5 --max-time 10 \
  --head https://valuesms.ae/sendsms_api_json.aspx
```

Un code HTTP de refus de méthode peut être normal pour HEAD : il ne valide pas
les identifiants SMS. Un tunnel refusé, une erreur TLS ou un timeout ne sont pas
un succès. Les domaines de vérification d'IP publique ne sont volontairement
pas autorisés par ce proxy ; demander au support l'IP vue lors du test SMS final.

## Raccorder ECS et tester depuis le PC

1. Déployer d'abord le backend comprenant ce transport sur toutes les tâches,
   en conservant le fournisseur OTP actuel.
2. Après préparation du proxy et confirmation de la liste blanche, créer les
   deux paramètres sous `/zwanga-api/production/env/`, selon la procédure SSM
   existante du [guide infra](../../README.md#variables-denvironnement-dans-ssm).
   Utiliser `SecureString` et la clé KMS applicative existante.
3. Dans la racine Terraform de production, le mécanisme existant découvre les
   nouveaux noms SSM. Revoir son plan séparément puis appliquer uniquement une
   évolution approuvée et redéployer le backend. Créer un paramètre SSM seul
   n'ajoute pas sa référence à une ancienne définition de tâche ECS.
4. Vérifier que toutes les nouvelles tâches reçoivent les deux noms de variables,
   sans afficher les secrets. Effectuer un test SMS vers un numéro contrôlé.
5. Activer Mobishastra et l'obligation d'OTP séparément, selon le calendrier mobile.

Pour tester le backend **local** avec la même IP fixe, ouvrir un tunnel SSM depuis
le PC (AWS CLI et Session Manager Plugin requis ; remplacer l'identifiant) :

```bash
aws ssm start-session --region eu-central-1 --target i-REMPLACER \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3128"],"localPortNumber":["13128"]}'
```

Garder cette session ouverte et utiliser localement :

```dotenv
NODE_ENV=development
MOBISHASTRA_PROXY_URL=http://127.0.0.1:13128
MOBISHASTRA_PROXY_REQUIRED=true
```

Redémarrer le backend local. L'émulateur appelle toujours le backend habituel ;
aucune configuration proxy ni clé Mobishastra ne va dans le mobile. Ne jamais
ouvrir le port 3128 à Internet pour faciliter ce test.

## Exploitation et retour arrière

Une seule EC2 est un point de panne pour les nouveaux SMS. Le service redémarre
automatiquement après un crash, mais il n'y a ni bascule multi-AZ ni remplacement
automatique d'instance. Prévoir une intervention lors d'une panne d'hôte/AZ.
Le remplacement conserve l'ENI et l'EIP, mais interrompt les SMS pendant le
provisionnement ; ne pas utiliser `create_before_destroy` avec une ENI unique.
Les changements de user-data entraînent un remplacement planifié. Les mises à
jour de sécurité Ubuntu sont activées sans redémarrage automatique de l'hôte.
Les reboots et les changements d'AMI restent à planifier explicitement.

Le heartbeat vérifie toutes les deux minutes que Squid refuse les métadonnées
AWS. Il ne prouve ni la délivrance d'un SMS ni la disponibilité de Mobishastra.
CloudWatch alerte sur l'absence de heartbeat, l'état EC2 et un CPU élevé. Renseigner
`alarm_actions` avec un topic SNS existant et des destinataires confirmés : la
valeur vide par défaut change seulement l'état des alarmes, sans prévenir personne.

En incident, conserver les preuves sans exporter de codes OTP ou secrets.
Ne pas basculer automatiquement en direct : cette IP ne serait pas autorisée.
Si nécessaire, sélectionner un autre fournisseur OTP déjà configuré et testé,
puis déployer les paramètres correspondants. Ne pas détruire le proxy pendant
que des tâches l'utilisent. Revenir au mode direct exige une autorisation explicite
de sa nouvelle IP, `MOBISHASTRA_PROXY_REQUIRED=false` et le retrait de l'URL sur
toutes les tâches. Ne pas libérer l'Elastic IP lors d'un simple rollback.

Le coût récurrent comprend l'EC2, le disque, l'IPv4 publique, les métriques/alarmes
et le trafic éventuel inter-AZ/Internet. Arrêter l'EC2 coupe les SMS et ne supprime
pas les frais du disque et de l'Elastic IP. Aucun tarif NAT Gateway ne s'applique.

## Validation locale

Depuis la racine du dépôt :

```bash
npm test -- --runInBand --runTestsByPath \
  src/otp/mobishastra-proxy.spec.ts src/otp/mobishastra-proxy.integration.spec.ts \
  src/otp/mobishastra-sms.service.spec.ts src/otp/mobishastra-otp.service.spec.ts \
  src/otp/otp.service.spec.ts
python -m unittest discover -s infra-aws/environments/mobishastra-proxy/tests -p test_proxy.py -v
terraform -chdir=infra-aws/environments/mobishastra-proxy init -backend=false
terraform -chdir=infra-aws/environments/mobishastra-proxy validate
terraform -chdir=infra-aws/environments/mobishastra-proxy test
ansible-playbook --syntax-check -i localhost, infra-aws/environments/mobishastra-proxy/ansible/configure.yml
```

Les tests Terraform utilisent exclusivement un fournisseur simulé, y compris
leur commande `apply`. Les tests HTTPS utilisent un certificat fictif dans
`test/fixtures`, une origine et un proxy de boucle locale : aucun SMS réel.
Le test Squid supplémentaire se lance sous Linux avec un binaire extrait et ses
dépendances, sans installation système :

```bash
python3 infra-aws/environments/mobishastra-proxy/tests/check_squid.py /chemin/racine-paquets-extraits
```

Il nécessite Python/Jinja2, Squid 6 et ses ressources (`squid-common`,
`squid-langpack`, bibliothèques indiquées par `ldd`). Tous les écouteurs sont
locaux ; un relais parent fictif empêche tout accès à Mobishastra pendant ce test.

Références : [Elastic IP AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html),
[Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html),
[contrôles Squid](https://www.squid-cache.org/Doc/config/http_access/),
[agent HTTP Node](https://nodejs.org/docs/latest-v24.x/api/http.html#new-agentoptions).
