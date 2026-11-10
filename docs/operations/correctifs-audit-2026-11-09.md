# Correctifs et suites de l’audit du 9 novembre 2026

Les correctifs sont locaux, sans push, déploiement, modification de secrets, migration de la base applicative ou opération AWS. Les changements simultanés dans le mobile et les écrans Agents de terrain sont préservés. Cette livraison ne constitue pas une validation globale de leur état mouvant.

## Correctifs appliqués

- Admin : Next.js 16.4.3, sharp 0.35.5 et dépendances compatibles corrigées, verrou npm actualisé. Vérification npm après installation : aucune vulnérabilité connue signalée. Hôtes S3 de l’optimiseur d’images limités au bucket `medias-zwanga`, en-têtes anti-encadrement et `nosniff`. La CSP ajoutée ne remplace pas une politique de scripts stricte.
- Sessions admin : un seul renouvellement simultané par session dans un onglet ; identifiant de rotation reproductible pour les réponses perdues et les onglets concurrents, compatible avec les reçus du backend ; une erreur réseau/503 conserve la session ; une réponse tardive ne peut pas écraser une nouvelle connexion. Les requêtes HTTP sont bornées à 20 secondes, avec 120 secondes pour les exports. Aucun changement de style.
- Support et terrain : le ticket support, son premier message et son lien terrain sont créés dans la même transaction. Une erreur d’écriture annule l’ensemble. Aucun appel fournisseur dans cette transaction.
- Progression terrain : lecture du dernier KYC uniquement et test d’existence d’un véhicule actif ; suppression du produit cartésien historique KYC × véhicules et de l’hydratation des données sensibles inutiles ; paramètres téléphoniques regroupés par lots de 200. Les règles de statut restent calculées par `buildProfileState`.
- Dispatch : cache des candidats porté de 30 à 110 secondes, pour survivre à la livraison et à la fenêtre de réponse. **Le conducteur conserve 40 secondes**, et les contrôles SQL de disponibilité, refus, expiration et acceptation restent en place. Le cache n’allonge pas la validité d’une invitation.
- CI : suites PostgreSQL critiques activées, Redis isolé du dispatch en staging comme en production, test OTP sur Redis protégé exécuté séparément, audit npm runtime bloquant dès le niveau élevé. Les workflows ne sont pas exécutés sur AWS dans cette intervention.

## Validation

Les résultats de fin d’intervention sont consignés ci-dessous. Les tests TypeScript et PostgreSQL isolés ne mesurent pas la latence de production et ne prouvent pas la livraison sur téléphone verrouillé.

- TypeScript backend et admin sans émission : réussi. Tests admin : 30 réussis ; nouveau contrôle ciblé sessions/configuration : 10 réussis après la dernière protection des réponses tardives.
- Backend ciblé support/terrain/cache dispatch : 5 suites, 50 tests réussis. Contrôle de structure des workflows : 2 tests réussis. Garde de documentation infra : réussie.
- Redis OTP réel et isolé : 17 tests réussis après correction du démarrage WSL du serveur de test. Le mot de passe temporaire passe par stdin, pas par les arguments de processus.
- PostgreSQL isolé : atomicité ticket et projection terrain (4 tests), installations/mises à jour et subvention cash payée validées ; suite résilience validée après alignement de ses fixtures sur les gardes de compte et de planification récurrente ; sonneries de proximité : 20 tests réussis après correction des fixtures et du nettoyage concurrent.
- Recherche de trajets PostgreSQL : validation complète non obtenue sur cette machine ; expiration du démarrage `initdb` à 60 secondes lors du rejeu. À rejouer dans la CI Linux avant publication, sans masquer ce test.
- Mobile : 35 tests ciblés de non-régression cash/contrats réussis sur les changements parallèles. Pas de recette native ni de suite globale certifiée dans cette intervention. Le travail ultérieur sur le dossier de documents est décrit séparément dans `document-dossier-unique-2026-11-09.md`.

## Travaux restant nécessaires

1. Stabiliser les modifications parallèles, puis exécuter toute la recette sous la version Node de `.nvmrc` (24.22.1 minimum ; poste local observé en 24.11.0). Les tests Agents de terrain, initialement en conflit avec une extraction parallèle, ont été rejoués avec succès après sa finalisation.
2. Migrer les sessions admin vers un intermédiaire serveur same-origin avec cookies HttpOnly, protection CSRF et politique CSP stricte. Les cookies actuels restent lisibles par JavaScript : le correctif de concurrence ne supprime pas ce risque XSS. Tester connexions, exports, uploads, OTP financier, multi-onglets et déconnexion avant bascule.
3. Paginer les listes terrain de bout en bout (API et interfaces) et calculer les objectifs mensuels en SQL. L’optimisation de projection livrée ne borne pas encore le nombre total de dossiers. Ne pas tronquer silencieusement les listes consommées par les interfaces existantes. Ajouter également une clé d’idempotence durable aux créations de tickets pour dédupliquer une requête répétée après perte de la réponse ; l’atomicité ne couvre pas ce cas.
4. Séparer les identités PostgreSQL : runtime sans droits de création/altération de schéma, rôle de migration séparé et absent des secrets du processus API. Préparer les droits sur tables/séquences existantes et futures, tester paiements/jetons/transactions, puis basculer les secrets et tâches ECS pendant une fenêtre contrôlée. Ne pas retirer les droits du compte actuellement utilisé avant cette validation.
5. Vérifier l’état réellement déployé avant de décider de la redondance : au moins deux tâches applicatives réparties par zone, RDS Multi-AZ, Redis avec réplication/bascule et procédure de reprise du proxy sortant. Chiffrer et approuver séparément les ressources ; aucune de ces protections n’est activée par les changements locaux.
6. Mesurer les p50/p95/p99 de création → attribution → acceptation fournisseur → réception mobile → sonnerie, ainsi que retard des files, saturation SQL, erreurs Redis et reprises. Comparer avant/après sous charge isolée puis surveiller le déploiement progressif. L’extension du cache devrait réduire les redécouvertes SQL ; aucun gain chiffré n’est revendiqué sans mesure.

## Déploiement et retour arrière

Après recette complète, déployer le backend et l’admin par les procédures existantes. Aucun changement de schéma n’est nécessaire pour les correctifs applicatifs de ce lot. Vérifier les sessions concurrentes, un ticket terrain et les métriques du dispatch. Retour arrière par retour à l’image/revision précédente, sans migration inverse ni destruction de données. Maintenir les versions de dépendances corrigées plutôt que réintroduire une version vulnérable.
