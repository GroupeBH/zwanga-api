# Alertes de demandes de trajet par vagues de quatre

## Fonctionnement

- Une demande ouverte invite au maximum **quatre conducteurs éligibles** en parallèle. La sélection conserve les critères existants (compte, KYC, véhicule, places, horaires, position, proximité) et leur classement : positions récentes prioritaires, puis distance. Moins de quatre candidats disponibles : groupe plus petit.
- La file Redis reste **propre à chaque demande**. PostgreSQL reste l'autorité pour les invitations, leurs échéances et l'attribution. Aucun appel Firebase n'est fait sous le verrou de la demande.
- Les quatre invitations et leurs notifications persistantes sont validées dans une même transaction. Un échec d'écriture annule tout ce groupe ; la reprise existante peut réessayer.
- Pas de remplacement individuel dans une vague partiellement ouverte. Le groupe suivant est sollicité lorsque **toutes** les invitations du groupe ont été refusées ou ont expiré. Une première acceptation validée réserve la commande et ferme les invitations concurrentes.
- Une contre-proposition ouvre une négociation exclusive : les trois autres invitations sont annulées. Les règles et échéances de négociation existantes restent inchangées.
- Un conducteur explicitement choisi sur la carte conserve sa priorité exclusive ; cette étape n'invite pas trois autres conducteurs.

## Délais et notifications tardives

Le contrat existant est conservé : jusqu'à 40 secondes pour recevoir l'invitation, puis une fenêtre de réponse de 40 secondes au premier accusé de réception authentifié. La fin ne dépasse ni la première échéance de livraison + 40 secondes, ni l'expiration de la demande. Des accusés répétés ne rallongent pas le délai. Chaque conducteur possède sa propre échéance ; le groupe attend le dernier encore sollicité.

Une expiration, une annulation ou une attribution rend les anciennes invitations inopérantes côté serveur et désactive leurs notifications encore en attente. Un signal temps réel demande aux mobiles de relire l'état, notamment dès la réservation préalable à la création du trajet. Cela ne peut pas retirer un message déjà remis à Firebase ni arrêter instantanément un téléphone hors connexion : les contrôles de validité du mobile restent indispensables. Aucun contrat de notification mobile n'est modifié.

## Protections

- Verrou de la demande pour sérialiser les décisions concurrentes.
- Quatre emplacements SQL (1 à 4), uniques par demande parmi les invitations séquentielles en attente.
- Une seule décision en cours par demande (acceptation en préparation ou négociation passager).
- L'unicité existante d'une invitation en attente par conducteur reste active, y compris entre deux demandes.
- Les processus peuvent se concurrencer sans créer une cinquième invitation. Redis indisponible : reprise SQL conservée ; il ne devient jamais l'autorité d'attribution.

Le guide PostgreSQL a orienté les contraintes d'unicité, les verrous courts et l'absence d'appels réseau dans la transaction.

## Configuration et livraison

`DRIVER_DISPATCH_WAVE_SIZE=4` est le comportement par défaut du nouveau code. `1` permet un retour opérationnel au mode individuel pour les **prochaines** vagues ; il ne retire pas les invitations déjà émises. Les autres valeurs sont bornées à quatre. `DRIVER_DISPATCH_ENABLED` garde son rôle d'activation général.

Migration obligatoire : `FourDriverDispatchWaves1780000123000`. Elle ajoute `waveSlot`, remplace l'unicité séquentielle par demande par quatre emplacements et conserve l'unicité par conducteur. Les anciens INSERT utilisent l'emplacement 1 par défaut. La migration est transactionnelle, avec délais de verrou et d'exécution bornés.

Pour un déploiement progressif sûr :

1. Configurer explicitement `DRIVER_DISPATCH_WAVE_SIZE=1` sur les nouveaux processus pendant le déploiement mixte.
2. Exécuter la migration par le processus habituel, puis déployer **toutes** les API et tous les workers compatibles. Ne pas activer les groupes de quatre tant qu'un ancien worker traite des réponses.
3. Passer la configuration à `4`, renouveler les processus concernés et vérifier les métriques, erreurs et invitations sur un trafic contrôlé.
4. Pour revenir à un ancien binaire : remettre d'abord le nouveau code en mode `1`, attendre la fermeture de toutes les vagues de quatre et des négociations associées. Le rollback du schéma impose l'arrêt des allocateurs et l'absence de toute invitation séquentielle en attente ; il refuse de supprimer une invitation pour réussir.

Aucun déploiement AWS, changement SSM, migration sur une base existante ou envoi réel n'est effectué par cette modification locale.

## Validation et limites

La suite `sequential-dispatch.postgres.spec.ts` inclut `test/four-driver-wave-flow.ts` sur PostgreSQL/PostGIS et Redis jetables : quatre invitations, refus partiels/complets, concurrence, première acceptation unique, réception indépendante, expiration, panne Redis, négociation, conducteur ciblé, annulation, rollback d'outbox et migration réversible après drainage.

Résultats locaux du 13 novembre 2026 :

- Suite PostgreSQL/Redis complète : 90 réussis, 3 optionnels ignorés (charge et parcours mobile inter-dépôts non activés).
- Nouvelle passe ciblée sur les 11 scénarios de vagues : 11 réussis, avec le filtre SQL réel de livraison et la lecture des offres actionnables. Les 82 autres scénarios sont exclus par le filtre de cette seconde passe, pas en échec.
- Sept suites unitaires ciblées : 50 réussis, incluant configuration, attribution, prix conservé, signal de réservation et livraison urgente.
- Compilation TypeScript de production réussie. Le contrôle TypeScript global reste bloqué par deux fixtures préexistantes sans `profilePicture` dans `src/users/driver-category.spec.ts` (lignes 124 et 144).
- Le lint des trois nouveaux fichiers TypeScript est réussi. Le lint de l'ensemble des fichiers touchés n'est pas vert (formatage et règles de typage dans les fichiers historiques) ; aucune remise en forme générale de ces services n'a été appliquée. Il ne s'agit pas d'une validation globale de release.

Ces tests ne constituent pas un test de charge ni une recette sur quatre téléphones. Une vague peut produire quatre fois plus d'envois que le premier tour individuel. Mesurer en staging le délai création → invitation → réception → affichage, les files push, verrous SQL et expirations avant généralisation. Aucun engagement de capacité à 1 000 demandes simultanées ne découle de ce changement.
