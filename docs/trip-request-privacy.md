# Confidentialité des demandes de trajet

## Accès

- `GET /trip-requests` exige un JWT valide et le rôle `driver` : 401 sans authentification, 403 pour un autre rôle. Les demandes déjà acceptées ne sont pas listées.
- `GET /trip-requests/:id` est accessible au propriétaire et, avant sélection, aux conducteurs authentifiés. Après sélection, seul le propriétaire et le conducteur retenu peuvent lire le détail.
- Le conducteur ne reçoit que ses propres offres. Le passager propriétaire peut consulter toutes les offres de sa demande.
- `my-offers`, la création d'une offre, l'acceptation directe et le démarrage exigent également le rôle conducteur.
- Les réponses GET portent `Cache-Control: private, no-store`.

## Données visibles

Les adresses, références et coordonnées GPS exactes de départ/arrivée restent visibles aux conducteurs authentifiés avant acceptation : c'est un choix fonctionnel explicite pour leur permettre d'évaluer le trajet. Les coordonnées ne sont pas arrondies. Ce choix ne supprime donc pas le risque de collecte de positions par un compte conducteur autorisé.

Le champ de profil `phone` est absent par défaut (et non une chaîne vide). Il est révélé entre le passager et le conducteur retenu après acceptation. Les offres concurrentes, refusées ou annulées ne permettent pas de récupérer ce téléphone via `my-offers` ou les offres imbriquées. Libérer le conducteur révoque cette visibilité lors des lectures suivantes.

La protection porte sur le champ de profil ; elle ne détecte pas un numéro saisi volontairement dans une adresse, un message ou une description libre.

Les nouvelles notifications diffusées aux conducteurs pour une demande créée ou rouverte invitent à ouvrir l'application sans inclure les adresses privées. Les notifications déjà enregistrées ou livrées ne sont pas effacées par ce correctif.

## Intégration mobile et déploiement

- Envoyer le bearer token pour charger la liste, uniquement dans le parcours conducteur. Utiliser `my-requests` pour les demandes du passager.
- Conserver l'affichage des adresses et marqueurs GPS existants.
- Traiter `phone` comme optionnel et afficher l'action d'appel seulement lorsqu'il est présent. Recharger la demande après acceptation ou libération du conducteur.
- Aucun changement de schéma ou de variable d'environnement. Déployer le backend pour activer la correction ; le dépôt mobile n'est pas modifié ici.

Les contrôles aux différents points d'entrée et les tests de refus suivent les principes de [validation systématique des autorisations d'OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## Vérification

`npm test -- --runInBand src/trip-requests` couvre les accès HTTP, les champs de contact, les coordonnées conservées avant acceptation et la révocation après libération.
