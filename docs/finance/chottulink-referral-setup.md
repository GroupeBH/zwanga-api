# Configuration ChottuLink du parrainage Zwanga

Date : 25 août 2026  
Périmètre : actions d'exploitation nécessaires après l'intégration du code

## 1. Ce qui est déjà intégré

Le backend crée un lien ChottuLink propre à chaque parrain, conserve son URL, valide le jeton reçu à l'inscription et rattache le filleul. L'application iOS/Android écoute ChottuLink, conserve la première attribution valide, ouvre l'inscription et transmet automatiquement l'attribution pour les flux téléphone, Google et Apple.

Le SDK mobile livré est `react-native-chottulink-sdk@1.1.2`. Il fonctionne avec un development build Expo ou un binaire natif, jamais avec Expo Go.

## 2. Créer et configurer l'application ChottuLink

Dans le tableau de bord ChottuLink :

1. créer l'organisation et le projet Zwanga ;
2. choisir un domaine, par exemple `zwanga.chottu.link` ;
3. configurer Android avec le package `com.zwanga` et l'URL Play Store ;
4. configurer iOS avec le bundle ID `com.biso.zwanga`, l'Apple Team ID et l'URL App Store ;
5. vérifier Android App Links et iOS Universal Links dans le tableau de bord ;
6. relever séparément la **REST API Integration Key** et la **Mobile SDK Integration Key**.

Ces deux clés n'ont pas le même usage. La clé REST `c_api_...` donne accès à la gestion des liens et doit rester exclusivement sur le backend. Seule la clé Mobile SDK est intégrée au binaire mobile.

## 3. Variables du backend

Renseigner dans l'environnement de production du backend :

```dotenv
REFERRAL_ATTRIBUTION_DAYS=30
CHOTTULINK_REST_API_KEY=c_api_...
CHOTTULINK_API_URL=https://api2.chottulink.com/chotuCore/pa/v1/create-link
CHOTTULINK_DOMAIN=zwanga.chottu.link
CHOTTULINK_LINK_REFRESH_DAYS=330
```

Le domaine ne contient ni `https://` ni chemin. Ne jamais placer `CHOTTULINK_REST_API_KEY` dans EAS, l'application mobile ou le dépôt Git.

## 4. Variables des builds EAS

Ajouter aux environnements EAS utilisés pour les builds, au minimum `production` :

```dotenv
CHOTTULINK_MOBILE_API_KEY=...
CHOTTULINK_DOMAIN=zwanga.chottu.link
```

La clé Mobile SDK est obtenue dans la section des clés d'intégration mobile du tableau de bord. Ne pas utiliser la clé REST à sa place.

## 5. Base de données et déploiement

Après sauvegarde de la base :

```powershell
npm run migration:run
```

La commande doit appliquer, dans l'ordre, les migrations `1780000018000`, `1780000019000` et `1780000020000`. La dernière migration rend les colonnes de lien indépendantes du fournisseur et invalide les anciennes URL Branch mises en cache afin qu'elles soient recréées avec ChottuLink. Elle ne modifie aucune attribution, commission, écriture comptable ou solde.

Déployer ensuite le backend, appeler `GET /api/v1/referrals/me` avec un compte de test et vérifier que `shareLink` utilise le domaine `*.chottu.link`.

## 6. Nouveau build natif obligatoire

L'ajout du SDK, du domaine universel et de l'intent filter ne peut pas être livré par une mise à jour JavaScript OTA. Produire et publier de nouveaux binaires :

```powershell
npx expo prebuild --clean
eas build --platform android --profile production
eas build --platform ios --profile production
```

Exécuter `expo prebuild` dans le dépôt mobile, avec `CHOTTULINK_MOBILE_API_KEY` et `CHOTTULINK_DOMAIN` déjà définis. Cette étape synchronise le domaine associé dans `ios/zwanga/zwanga.entitlements`, l'intent filter dans `android/app/src/main/AndroidManifest.xml` et l'autolinking du SDK. Les dossiers natifs étant suivis par Git, contrôler leur diff avant de le valider ; sans cette synchronisation, EAS compile les anciens projets natifs et le lien universel ne peut pas ouvrir l'application.

Incrémenter auparavant `android.versionCode` et `ios.buildNumber` s'ils ont déjà été publiés. Utiliser un development build Expo pour les essais locaux ; Expo Go ne charge pas le module ChottuLink.

## 7. Recette différée obligatoire

Effectuer au moins les contrôles suivants sur de vrais appareils :

1. générer le lien depuis le compte du parrain ;
2. vérifier que le lien partagé utilise `*.chottu.link` ;
3. désinstaller Zwanga de l'appareil du filleul ;
4. ouvrir le lien depuis WhatsApp ou SMS ;
5. passer par le store, installer et ouvrir Zwanga ;
6. vérifier que l'inscription s'ouvre et affiche « Invitation prise en compte » sans champ de code ;
7. créer un compte téléphone, puis répéter avec Google et Apple ;
8. vérifier en base `referredByUserId`, `attributionProvider = chottulink`, `attributionLinkToken`, `attributionReferringLink` et `attributionCapturedAt` ;
9. ouvrir un second lien avant inscription et vérifier que le premier reste prioritaire ;
10. ouvrir un lien avec un compte déjà connecté et vérifier qu'il n'est pas rattaché ;
11. confirmer un paiement FlexPay éligible et vérifier la commission de 5 %.

Tester aussi le parcours avec l'application déjà installée, un jeton invalide, une attribution locale vieille de plus de 30 jours et un parrain suspendu.

## 8. Fenêtres temporelles

ChottuLink remet l'URL de destination et une date `resolvedAt` à l'application. Il ne remet pas de date de clic dans l'événement utilisé. Zwanga conserve donc l'attribution pendant 30 jours à partir de la résolution du lien, notamment la première ouverture après installation.

Cette fenêtre n'affecte pas la rémunération : les 5 % restent valables pendant douze mois à partir du premier paiement éligible du filleul.

## 9. Supervision

Surveiller :

- les erreurs `ChottuLink referral link generation failed` du backend ;
- les réponses 401 de l'API, qui indiquent généralement une mauvaise clé REST ;
- le taux lien → première ouverture → inscription dans ChottuLink ;
- les refus de `resolve-attribution` et les dates expirées ;
- le nombre de profils `chottulink` sans `referredByUserId`, qui doit rester nul ;
- la correspondance entre `attributionLinkToken` du filleul et `linkToken` du parrain.

En cas d'indisponibilité de l'API ChottuLink, le backend conserve un ancien lien ChottuLink valide lorsqu'il existe et retente la génération au prochain chargement du récapitulatif.
