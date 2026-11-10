# Dossier de documents unique — 9 novembre 2026

## Règle confirmée

Un compte conserve son dossier `pro_service_cases` de type `documents`, même après refus, annulation ou clôture. Il le modifie ou y ajoute des documents au lieu de créer une seconde demande. Les autres services professionnels restent inchangés.

## Implémentation locale

- La création authentifiée et le rattachement d’un dossier web prennent le verrou PostgreSQL du compte avant de vérifier l’existence du dossier. La transaction empêche deux instances API de créer ou rattacher simultanément deux dossiers au même compte. La recherche utilise l’index existant par propriétaire ; aucune migration ni modification de données existantes n’est requise.
- `POST /pro-services/applications` renvoie HTTP 409 avec le code `DOCUMENT_REQUEST_ALREADY_EXISTS` en cas de nouvelle demande distincte. Les répétitions identiques d’une même soumission restent idempotentes.
- `GET /pro-services/mine/current-documents` renvoie `{ request: { id, status, canEdit } | null }`, indépendamment de la pagination et des statuts.
- `PATCH /pro-services/mine/:id` reçoit `application`, `contactConsent: true`, `expectedUpdatedAt` et `mutationId` (UUID). Seul le titulaire actif peut modifier le dossier. Les champs financiers, le propriétaire et le statut ne sont pas acceptés dans ce DTO.
- La modification verrouille le dossier, contrôle la date de la version consultée et enregistre un reçu dans `pro_service_events` dans la même transaction. Le reçu permet de rejouer une réponse perdue sans écraser une modification ultérieure. Une date périmée renvoie `DOCUMENT_REQUEST_CHANGED`.
- Avant engagement, le dossier revient à `submitted`. Un ancien devis reste historisé mais n’est plus acceptable ; le prochain devis conserve une numérotation croissante.
- Après engagement, ou pour un dossier terminé, `editMode=add_documents` : seuls de nouveaux codes de documents peuvent être ajoutés. Les données validées et les documents antérieurs ne sont pas effacés. Statut contractuel, devis, acceptation, paiements, dette et garde d’originaux restent inchangés. L’ajout ne constitue pas un nouveau financement ou un avenant accepté.
- Le mobile remplace « Faire une demande » par « Modifier ma demande ». Le formulaire reprend les valeurs existantes, conserve le brouillon pendant les rafraîchissements et propose de recharger le dossier en cas de conflit. Les liens directs vers la création vérifient également le dossier existant. Les contrôles d’ajout seul sont appliqués au formulaire et au serveur.
- L’admin conserve son style : les documents apparaissent dans la demande existante ; l’historique nomme les modifications et les documents ajoutés. Une notice distingue les ajouts après engagement du contrat initial.

## Précautions et limites

- Aucun doublon historique n’est supprimé ou fusionné automatiquement. S’il en existe plusieurs, la route de reprise choisit le plus récent ; ils restent consultables. Toute consolidation de données financières nécessite une opération distincte et contrôlée.
- Le formulaire web public non authentifié ne permet pas d’identifier sûrement un compte. Son propriétaire n’est jamais déduit du téléphone déclaré. Le rattachement administratif ultérieur est soumis à la même règle d’unicité ; le présent changement concerne les dossiers rattachés à un compte.
- Les ajouts à un dossier engagé sont visibles dans le dossier et son journal ; ils ne déclenchent pas une notification externe ni un nouveau cycle de paiement. Leur traitement contractuel complémentaire demeure une intervention de l’équipe. Le statut de l’engagement initial n’est pas réinitialisé artificiellement.
- Déployer le backend avant le mobile et l’admin. Toutes les instances backend doivent utiliser cette version pour appliquer la règle partout. Les anciens clients sont bloqués côté serveur s’ils tentent de recréer une demande, mais le bouton de modification nécessite la mise à jour mobile.
- Aucun appel AWS, SMS, paiement, publication de Store ni modification native dans cette intervention.

## Validation

Les tests portent sur le code réel, avec PostgreSQL temporaire pour les accès concurrents et des dépendances natives simulées pour le mobile.

- Backend : **4 suites, 60 tests réussis**, dont le dossier unique sur PostgreSQL réel, créations et éditions concurrentes, reprise de tous les statuts, protection du propriétaire, reçus de modification, retour arrière si l’audit échoue, invariance des paiements et originaux.
- Mobile : **25 tests JavaScript réussis** ; vérification de l’existence avant création, préremplissage, mode ajout, conflits, conservation du brouillon et répétition après perte de réponse.
- TypeScript backend et mobile sans émission : réussi. ESLint ciblé mobile : aucune erreur ni avertissement.
- Tests admin généraux : **30 réussis** ; ils ne constituent pas un test visuel du nouveau message dans le dossier.
- Les essais ont révélé puis permis de corriger une qualification d’alias SQL dans le reçu de modification. Les attentes des tests PostgreSQL tiennent compte du tri canonique déjà appliqué aux codes de documents.

Un parcours tactile sur Android/iOS et une vérification visuelle dans l’admin restent nécessaires avant diffusion. Ni déploiement ni test contre la production n’ont été réalisés par cette intervention.
