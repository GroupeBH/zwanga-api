# FIN-REF-008 — Fiabilisation PostgreSQL du rattachement de parrainage

Date : 27 août 2026  
Statut : implémenté dans le backend ; déploiement API requis  
Migration : aucune  
Variables d'environnement : aucune  
Périmètre : `POST /api/v1/referrals/me/attribution`, création des profils de parrainage, concurrence et reprise mobile

## 1. Incident constaté en production

Le 27 août 2026, CloudWatch a reçu douze appels authentifiés à
`POST /api/v1/referrals/me/attribution` provenant de deux comptes Android.
Les douze appels ont retourné HTTP 500 avec l'erreur PostgreSQL suivante :

```text
FOR SHARE cannot be applied to the nullable side of an outer join
```

Aucun journal `Referral attribution attached` n'a été produit. La transaction
était donc annulée avant l'enregistrement de `referredByUserId`. L'application
mobile a correctement conservé l'invitation et répété la demande au retour au
premier plan.

Les corps HTTP et les jetons ChottuLink ne sont pas journalisés. Les journaux
permettent d'auditer le compte authentifié et le résultat sans exposer le secret
d'attribution.

## 2. Cause technique

Le service demandait simultanément à TypeORM :

```ts
relations: ['user'],
lock: { mode: 'pessimistic_read' },
```

TypeORM matérialisait la relation avec une jointure externe puis ajoutait
`FOR SHARE` à toute la requête. PostgreSQL interdit de verrouiller le côté
nullable d'une jointure externe. Le défaut était déterministe dès qu'une
attribution par code ou par jeton atteignait cette requête.

Les tests unitaires antérieurs utilisaient un `EntityManager` simulé. Ils
validaient les règles métier, mais ne pouvaient pas reproduire le SQL généré par
PostgreSQL.

## 3. Correction appliquée

### 3.1 Sérialisation par filleul

Au début de la transaction, le backend prend le verrou transactionnel suivant :

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1, 0));
```

La valeur passée est `zwanga:referral-user:<userId>`. Le préfixe isole ce verrou
des autres usages éventuels des advisory locks et le hachage 64 bits réduit le
risque de collision.

Le verrou est automatiquement libéré au `COMMIT` ou au `ROLLBACK`. Il n'est donc
pas conservé par une connexion rendue au pool.

Cette sérialisation fonctionne même pour un ancien utilisateur dont la ligne
`referral_profiles` n'existe pas encore. Une deuxième demande concernant le
même filleul attend la première, relit ensuite le profil validé et retourne un
succès idempotent sans seconde notification.

Le même verrou est utilisé par la création paresseuse du profil et du compte de
parrainage. Une ouverture simultanée de l'écran Parrainage et d'un lien
d'invitation ne peut donc plus tenter de créer deux profils ou deux comptes.

### 3.2 Chargement du parrain

Le profil correspondant au code ou au jeton est désormais lu directement,
sans relation et sans verrou de jointure. L'utilisateur parrain est ensuite lu
séparément et son état est contrôlé :

- utilisateur existant ;
- compte actif ;
- statut différent de `suspended` et `inactive` ;
- utilisateur différent du filleul.

Les codes et jetons sont uniques et ne sont jamais modifiés pendant une
attribution. Le verrou exclusif par filleul protège la seule donnée mutable du
flux : le premier choix de `referredByUserId`.

### 3.3 Ordre transactionnel

La transaction suit désormais cet ordre :

1. acquisition du verrou transactionnel du filleul ;
2. vérification de l'existence du filleul ;
3. lecture ou création de son profil ;
4. lecture du profil puis de l'utilisateur parrain ;
5. contrôles d'immuabilité, d'activité et d'auto-parrainage ;
6. écriture de la preuve d'attribution si elle est nouvelle ;
7. création éventuelle du compte de gains vide ;
8. validation de la transaction ;
9. journalisation et notification du parrain après validation.

La notification FCM reste hors transaction. Son indisponibilité ne peut donc
pas annuler un rattachement déjà validé. Une répétition idempotente ne renvoie
pas de deuxième notification.

## 4. Garanties métier et financières

La correction ne change pas les règles financières :

- commission de 5 % sur le paiement FlexPay éligible réellement confirmé ;
- retenue de sept jours ;
- fenêtre de rémunération de douze mois à partir du premier paiement éligible ;
- aucune commission rétroactive ;
- aucun remplacement d'un parrain existant ;
- aucune création de jeton ou d'écriture comptable au moment du rattachement.

En cas d'erreur avant le commit, tous les champs d'attribution et la création
éventuelle du compte sont annulés ensemble. Aucun état partiel ne peut être
validé.

## 5. Compatibilité et déploiement

La correction ne nécessite :

- aucune migration ;
- aucune nouvelle variable d'environnement ;
- aucune modification Parameter Store ;
- aucun nouveau binaire Android ou iOS.

Déployer uniquement le backend. Les applications qui ont conservé une
attribution après l'ancien HTTP 500 retentent automatiquement au prochain
démarrage ou retour au premier plan. Si l'attribution locale a été supprimée ou
a expiré, l'utilisateur doit rouvrir le lien d'invitation.

## 6. Vérifications après déploiement

Pour chacun des deux comptes de test :

1. remettre l'application au premier plan ;
2. attendre la confirmation « Invitation prise en compte » ;
3. vérifier un HTTP 201 sur `/referrals/me/attribution` ;
4. vérifier un seul journal `Referral attribution attached` ;
5. vérifier l'apparition unique du filleul dans `/referrals/me/referrals` et
   dans l'administration ;
6. répéter le même appel et contrôler `newlyAttached = false` sans nouvelle
   notification ;
7. essayer un autre lien et contrôler le refus sans modification du parrain.

Dans CloudWatch Logs Insights :

```text
fields @timestamp, @message
| filter @message like /referrals\/me\/attribution/
| sort @timestamp desc
```

```text
fields @timestamp, @message
| filter @message like /Referral attribution attached/
| sort @timestamp desc
```

L'erreur `FOR SHARE cannot be applied to the nullable side of an outer join`
ne doit plus apparaître.

## 7. Tests de régression

Les tests ciblés vérifient :

- le rattachement initial ;
- la répétition idempotente ;
- l'absence de seconde notification ;
- l'impossibilité de remplacer un parrain ;
- le refus de l'auto-parrainage ;
- l'acquisition du verrou transactionnel par filleul ;
- l'absence de toute requête combinant une relation TypeORM et un verrou.

Commande :

```powershell
npm test -- --runInBand referrals.service.spec.ts
```

## 8. Retour arrière

Le retour arrière consiste à redéployer l'image backend précédente. Il ne
requiert aucune migration, mais réintroduit l'erreur PostgreSQL et doit donc
rester réservé à un incident plus grave. Les rattachements validés par cette
version restent compatibles et ne doivent jamais être supprimés.
