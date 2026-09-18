# FlexPaie Payout v1.03 : variables et diagnostic

Source : PDF fourni `FlexPay_API_Documentation_Payout_v1_03.pdf`, révision du 22 avril 2024. Les pages ci-dessous désignent la pagination imprimée (la page 3 est la quatrième page du fichier).

Le payout est un **versement du compte marchand Zwanga vers le Mobile Money du conducteur**. L'encaissement client utilise une autre API. Les identifiants restent exclusivement sur le backend.

## 1. Authentification — pages 3 et 5

| Variable Zwanga | Signification et valeur à obtenir |
| --- | --- |
| `FLEXPAY_PAYOUT_USERNAME` | Login du module **PayoutService** attribué au marchand par FlexPaie. Ce n'est pas automatiquement le code marchand, l'email administrateur Zwanga ou le téléphone du conducteur. |
| `FLEXPAY_PAYOUT_PASSWORD` | Mot de passe correspondant à ce login payout. Ce n'est ni le PIN utilisateur ni le token d'encaissement. Conserver exactement les caractères fournis. |
| `FLEXPAY_PAYOUT_AUTH_URL` | URL complète recevant le POST JSON `{ username, password }`. Chemin du PDF : `/api/v1/auth/authenticate`. Si la variable est vide, le backend utilise ce chemin sur l'origine de `FLEXPAY_PAYOUT_SERVICE_URL`. |

Une authentification exploitable doit renvoyer les trois champs à la racine :

```json
{
  "code": "0",
  "token": "Bearer <token-renvoye-par-FlexPaie>",
  "expire_in": 1234
}
```

`code=0` signifie succès métier, `code=1` signale un problème. `expire_in` est une durée en **secondes**, pas une date ni des millisecondes. Le backend récupère et renouvelle ce token automatiquement : il n'y a pas de variable `FLEXPAY_PAYOUT_TOKEN` à remplir. `FLEXPAY_TOKEN` reste le token d'encaissement et ne remplace pas cette authentification.

**HTTP 200 seul ne signifie pas que les identifiants ont été acceptés.** Le contenu peut contenir `code=1`, ne pas contenir de token exploitable ou présenter un format différent de celui du PDF. Le client actuel masque ces variantes derrière `PAYOUT_SERVICE_UNAVAILABLE` sans écrire de secrets dans les logs.

## 2. Versement — pages 5 à 8

| Variable Zwanga | Signification et valeur à obtenir |
| --- | --- |
| `FLEXPAY_PAYOUT_SERVICE_URL` | URL HTTPS **complète**, se terminant par `/pay`, fournie par FlexPaie pour le compte payout. Le PDF utilise `https://host:port/version/pay` : ni `host`, ni `port`, ni `version` ne sont des valeurs réelles à copier. |
| `FLEXPAY_PAYOUT_MERCHANT_CODE` | Code du marchand débité chez FlexPaie, transmis dans le champ `merchant`. Le nom fictif du PDF n'est pas le code Zwanga. À défaut, le code utilise `FLEXPAY_MERCHANT_CODE`, puis `FLEXPAY_MERCHANT` ; ce repli ne prouve pas que le compte d'encaissement est habilité au payout. |
| `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL` | URL publique HTTPS **du backend Zwanga** recevant le résultat asynchrone, pas une URL FlexPaie ou un lien mobile. Route : `/api/v1/driver-settlements/payouts/flexpay/callback` si le préfixe de l'API est `api/v1`. |

Sans callback explicite, le backend ajoute `driver-settlements/payouts/flexpay/callback` à `FLEXPAY_CALLBACK_BASE_URL`, sinon `PUBLIC_API_BASE_URL`. La base doit contenir le préfixe API correct. Le repli local `localhost` ne convient pas en production.

Les autres champs obligatoires sont construits par le backend, pas saisis dans des variables d'environnement :

| Champ envoyé | Valeur / rôle |
| --- | --- |
| En-tête `Authorization` | `Bearer` + token obtenu par l'authentification payout. |
| `type` | `1` pour Mobile Money. |
| `reference` | Référence du retrait générée par Zwanga ; à conserver pour le rapprochement. |
| `amount` | Montant demandé, validé par rapport aux gains disponibles. |
| `currency` | `CDF` ou `USD` dans la documentation ; les gains conducteur utilisent la devise configurée côté Zwanga. |
| `customer` | Compte Mobile Money bénéficiaire : numéro international `243…`, sans `+` dans ce client. |
| `description` | Libellé du versement. |
| `callback_url` | Callback public déterminé ci-dessus. |

L'acceptation initiale (`code=0`, `status=0XX0`, `orderNumber` fourni) n'est pas la confirmation de réception de l'argent. Le PDF présente aussi la graphie `OXX0` dans son exemple ; le client accepte les deux. `0XX2` concerne un **solde marchand insuffisant**, pas le solde du conducteur. `0XX4` concerne le token. `0XX1` demande d'attendre une opération déjà en cours : ne pas renvoyer aveuglément le versement.

## 3. Vérification et solde — pages 9 à 13

| Variable Zwanga | Usage / chemin du PDF |
| --- | --- |
| `FLEXPAY_PAYOUT_CHECK_TRANSACTION_URL` | GET de vérification du résultat : `/api/rest/v1/check/{orderNumber}`. `orderNumber` vient de FlexPaie, ce n'est pas la référence Zwanga. |
| `FLEXPAY_PAYOUT_BALANCE_URL` | GET du solde disponible **du marchand** en USD/CDF : `/api/rest/v1/balance/{merchant}`. Ce n'est pas le portefeuille du conducteur. |

Les deux appels utilisent le token d'authentification payout. Les surcharges acceptent `{orderNumber}` et `{merchant}` ; sans placeholder, le code ajoute la valeur en fin d'URL. Ne pas mettre un identifiant fixe puis laisser le backend en ajouter un deuxième. Si elles sont vides, les URL sont reconstruites avec les chemins du PDF sur l'origine de l'URL `/pay`.

Le callback payout est vérifié par un appel de contrôle, même si `FLEXPAY_VERIFY_CALLBACKS=false`. Aucun paramètre ne doit contourner cette vérification. `FLEXPAY_REQUEST_TIMEOUT_MS` règle le délai des appels (30 000 ms par défaut) ; l'augmenter ne corrige pas des identifiants refusés.

## 4. Points à confirmer pour l'incident du 17 septembre 2026

Les traces AWS précédemment consultées montrent un POST d'authentification HTTP 200 suivi du rejet local de la réponse, **sans appel de versement**. Les sept noms payout étaient référencés dans ECS, ce qui ne valide pas leurs valeurs.

Contrôle de forme du `.env.production` local, sans afficher les identifiants :

- Login, mot de passe et code marchand présents ; aucune espace extérieure détectée. Leur validité chez FlexPaie n'a pas été testée.
- Authentification : chemin `/api/v1/auth/authenticate`, conforme au chemin du PDF.
- Versement : chemin `/api/v1/merchant/pay`. La partie `version` n'est pas précisée par le PDF ; FlexPaie doit confirmer cette URL.
- Vérification et solde : chemins `/api/v1/merchant/check/...` et `/api/v1/merchant/balance/...`, différents de `/api/rest/v1/...` dans le PDF. Une variante de serveur est possible : confirmation nécessaire, pas de remplacement automatique.

Demander à FlexPaie de confirmer le **login payout activé**, le mot de passe via un canal sécurisé, le code marchand associé, l'environnement production et les quatre URL exactes (auth/pay/check/balance). Si un contrôle d'authentification est autorisé, ne conserver que le code métier, les noms/types des champs et la validité de la durée ; ne jamais copier le token ou le mot de passe dans une discussion ou les logs.

Un `.env.production` local modifié ne change pas une tâche ECS déjà lancée. Il faut importer les valeurs validées dans SSM puis renouveler les tâches ECS par le déploiement prévu. Vérifier ce parcours sans afficher les secrets. Ne pas ajouter de commentaires en fin de ligne aux valeurs sensibles : le parseur d'import SSM et `dotenv` peuvent les interpréter différemment. Utiliser les guillemets de façon cohérente, notamment pour un mot de passe contenant `#`, et préserver tout caractère réellement fourni par FlexPaie.

Aucun identifiant, paramètre SSM, endpoint, déploiement ou paiement réel n'a été modifié pour ce compte rendu.
