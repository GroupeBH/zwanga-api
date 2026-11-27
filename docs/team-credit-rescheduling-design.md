# Rééchelonnement des offres de l’équipe — conception à valider

25 novembre 2026 · Lot 4 **non implémenté** · Backend et compatibilité clients.

## Schéma et activation

Proposer trois tables dédiées au domaine historique, rattachées à `asset_credits.id` : état courant (`creditId`, `scheduleVersion`, `scheduleBaselineMinor`), échéances immuables (`creditId`, `version`, `ordinal`, `dueAt`, `amountMinor`), propositions (`proposedBy`, motif, version et solde attendus, échéances proposées, consentement du débiteur, approbateur, horodatages). Types monétaires `bigint`, dates `timestamptz`, unicité crédit/version/ordinal et contraintes de sommes, de positivité et d’acteurs distincts. Aucun nouveau principal, intérêt ou frais ; les nouvelles échéances couvrent exactement le restant dû.

Migration additive avec délais DDL et index des clés étrangères ; aucun recalcul massif des anciens contrats. Sans état versionné, conserver le calcul actuel. À la première approbation, figer aussi l’échéancier d’origine pour l’audit puis publier la nouvelle version et sa baseline égale au `paidMinor` courant. Transaction courte suivant l’ordre de verrouillage existant utilisateur/crédit : recontrôler statut actif, version, solde, consentement et approbateur ; refuser une proposition devenue obsolète après paiement. Aucun paiement ni effacement de dette lors de cette publication. Audit append-only des trois décisions.

## Lectures, minimums et appels existants

Conserver `creditSchedule()` comme fonction pure de calcul initial. Ajouter un résolveur de lecture, avec chargement groupé des versions courantes : échéancier versionné s’il existe, sinon calcul historique. Sur une version approuvée, imputer seulement `paidMinor - scheduleBaselineMinor`, plus anciennes échéances d’abord ; signaler une baseline devenue incohérente après compensation, sans solde négatif silencieux.

Adapter **tous les appels relevés** : `AssetCreditService.list` (`minimumDueMinor`, `nextInstallment`, tableau de bord mobile et liste admin) et `AssetCreditService.detail` (échéancier détaillé). `repaymentPlanPreviews()` continue d’utiliser le calcul pur sans date pour les offres initiales, jamais comme échéancier d’un contrat rééchelonné. Mettre à jour également le calcul SQL de `collections` pour lire cette version ; tester l’équivalence entre liste, détail, minimums et recouvrement. Conserver la sémantique historique de `nextInstallment` (première échéance non couverte, même passée), distincte de `collections.nextDueAt` (prochaine échéance future). Les collecteurs financiers et taux ne changent pas.

## Mobiles installés et droits

Préserver les formes et types historiques des réponses, ajouter seulement version et proposition facultatives. Les anciens clients lisent les échéances approuvées sans mise à jour obligatoire ; ils ne peuvent pas consentir à une proposition qu’ils n’affichent pas. Garder donc l’ancien échéancier tant qu’un client compatible n’a pas présenté le nouveau calendrier et recueilli un consentement explicite, lié à son empreinte et sa version. Pas d’accord implicite ni d’approbation admin à la place du débiteur.

Proposition : grants `collector`/`manager` ; consentement : propriétaire du crédit ; approbation : grant `analyst`, autre que le proposant et le débiteur. `super_admin` reste soumis à la séparation des personnes. Lectures personnelles limitées aux rôles internes autorisés, `no-store`, pas de `funder` ; droits historiques d’émission/remise inchangés. Mutations idempotentes, erreurs françaises et tests de courses paiement/approbation obligatoires.

## Retour arrière et décision attendue

Reprendre les garde-fous des migrations financières : `down` refusé dès qu’une proposition/version est utilisée, aucune suppression de preuve ou restauration silencieuse de l’ancien calendrier. Privilégier une correction en avant ; revenir à un ancien binaire non compatible avec les versions actives serait incorrect. Valider ce schéma, les rôles et le parcours de consentement avant toute migration ou code du lot 4.
