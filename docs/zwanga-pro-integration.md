# Zwanga Pro et gestion des crédits

## Audit et choix d'intégration

Le backend NestJS utilise TypeORM et PostgreSQL. `asset_credits` porte déjà la dette, `asset_credit_entries` les remboursements, et `wallet_accounts` le portefeuille. `driver_earnings` n'est alimenté pour un paiement électronique qu'après règlement confirmé. Les retraits verrouillent la ligne utilisateur ; les débits de jetons verrouillent le portefeuille. Ces mécanismes doivent être conservés.

Les contrats historiques `asset-credit-v1` et `asset-credit-v2` ont des règles différentes. Ils ne seront ni convertis ni repricés. La nouvelle version `zwanga-pro-v1` étend la même dette avec un catalogue, un créancier et des conditions figées. Les dossiers documentaires réutilisent `pro_service_cases` ; les entreprises réutilisent `partner_organizations`. Aucun portefeuille supplémentaire.

Manques identifiés : types documentaires historiques statiques, absence de stock individualisé, absence de créancier contractuel dans les crédits matériels, échéances calculées mais non versionnées, journal de crédit simple et non en partie double. Les retenues historiques sont des triggers synchrones : ne pas leur faire traiter les nouveaux contrats.

## Ordre d'intégration

1. Fondations : catalogue détaillé, habilitations des organisations, politiques versionnées, droits spécialisés, stock et données contractuelles.
2. Octroi : demande liée au catalogue, évaluation explicable, offre figée, acceptation et mandat, acompte, livraison et activation.
3. Remboursement : portefeuille existant, revenus effectivement réglés, journal exact, échéances et rapprochement.
4. Exploitation : API d'administration, notifications durables, impayés et documentation de recette.

Chaque étape doit être testée avant la suivante. Les tests utilisent des utilisateurs et une base PostgreSQL jetables, jamais des fonds ou notifications réels.

## Garde-fous

- Les nouvelles offres sont fermées par défaut. Une habilitation et une validation juridique documentées sont nécessaires pour les ouvrir. Une référence enregistrée est une preuve de contrôle interne, pas une certification réglementaire.
- Les sommes sont des chaînes d'entiers en centimes de CDF ; les calculs utilisent `bigint`. Le portefeuille impose une précision de 10 centimes de CDF. Aucun change implicite.
- Les contrats acceptés sont figés. Une modification du catalogue ne modifie pas une dette existante.
- Les pièces restent privées ; aucun IMEI, numéro de série ni montant de dette dans les notifications.
- Une dette n'entraîne pas la suspension du transport. Aucun verrouillage de téléphone et aucune pénalité automatique.
- Aucun déploiement, activation de production ou migration sur une base existante ne fait partie de cette implémentation locale.

## Ce qui est implémenté

`FinancingModule`, dans `src/financing`, est importé par `AssetCreditModule`. Ce point d'assemblage ne contient ni service métier ni contrôleur : il importe les modules spécialisés décrits dans [l'architecture des financements](financing-architecture.md). Ils réutilisent l'authentification JWT, les identités existantes, le portefeuille, les revenus réglés, S3 et l'outbox de notifications. Aucune dépendance npm ni aucun prestataire de paiement supplémentaire.

- Catalogue : smartphones, équipements et documents définis par des produits configurables ; prix, frais, fournisseurs, vendeur, créancier, modèles `ZWANGA_DIRECT` et `PARTNER_DIRECT`, garanties et justificatifs requis.
- Octroi : contrôle conducteur actif/KYC, ancienneté, trajets réglés distincts, revenus et engagements actifs, impayés ; politique spécifique aux nouveaux conducteurs ; validation humaine distincte du bénéficiaire ; contrat figé avec empreinte SHA-256, consentement et mandat daté.
- Exécution : acompte depuis le portefeuille, stock individualisé, affectation exclusive et preuve de remise ; documents associés au véhicule et au dossier documentaire existant. Traitement documentaire distinct du financement. Un démarrage avant délivrance n'est possible que si la politique contractuelle l'autorise explicitement.
- Finance : versements partiels ou anticipés ; retenues asynchrones sur gains réglés ; montant fixe par trajet, pourcentage du revenu net et contribution de commission ; plafonds au disponible et au solde dû ; journal en partie double, compensations et rapprochement.
- Exploitation : échéances hebdomadaires/mensuelles versionnées, imputation des paiements, jours de retard, rappels, révocation du mandat et rééchelonnement avec consentement du conducteur puis validation par un autre analyste.
- Administration : `/zwanga-pro` dans `zwanga-admin`, accessible depuis Crédit matériel. Consultation paginée, examen des demandes, activation sous conditions, soldes, échéances, impayés, anomalies et téléchargement JSON des écritures. Réutilisation des feuilles de style existantes ; aucune feuille CSS modifiée.

La configuration détaillée des offres, les habilitations, le stock et les livraisons disposent d'API ; leurs formulaires admin complets ne sont pas encore réalisés. Les écrans mobiles et le portail partenaire ne sont pas adaptés à ce nouveau parcours.

## Modèle de données et relations

Les modèles de lecture typés sont dans `src/financing/shared/credit.rows.ts`. Comme le crédit matériel existant, les modules utilisent des requêtes SQL paramétrées via TypeORM ; ils ne dupliquent pas ces tables sous de nouvelles entités ORM synchronisées automatiquement.

| Ensemble | Tables et relations |
| --- | --- |
| Acteurs | `pro_credit_parties` étend `partner_organizations` ; `pro_credit_grants` lie les droits spécialisés aux utilisateurs et organisations |
| Catalogue | `pro_credit_products` référence fournisseur, vendeur, créancier et `pro_credit_policies` immuable |
| Demandes et dette | `asset_credit_requests` reçoit produit et dossier figé ; `asset_credits` conserve principal/solde/statut ; `pro_credit_contracts` complète le même identifiant avec conditions, mandat, acompte et livraison |
| Exécution | `pro_credit_stock` associe un exemplaire unique au contrat ; `pro_credit_documents` référence véhicule et preuve privée dans `pro_credit_attachments` |
| Finance | `asset_credit_entries` conserve les remboursements ; `pro_credit_journals` expose les deux jambes via `pro_credit_ledger_lines` ; `pro_credit_installments` conserve chaque version d'échéancier |
| Fiabilité | `pro_credit_work` conserve les versions à traiter ; `pro_credit_allocations` conserve les imputations par gain/contrat ; `pro_credit_mutations` conserve les réponses idempotentes |
| Contrôle | `pro_credit_audit` est append-only ; `pro_credit_reschedules` conserve proposition, consentement et approbation |

Les clés étrangères et index sont créés dans les migrations. Journaux, politiques, instantanés contractuels, échéances et preuves d'idempotence sont protégés des modifications. Une contrainte différée contrôle que `paidMinor` correspond à la somme du registre de remboursement.

## Règles financières

### Convention monétaire

Tous les nouveaux champs `*Minor` sont des **chaînes** d'entiers en centimes de CDF : `"85000"` représente 850 FC. Les calculs utilisent `bigint`. La granularité est de 10 centimes, compatible avec le portefeuille existant (0,01 jeton). Un montant incompatible est refusé, pas arrondi silencieusement. Les pourcentages utilisent des points de base : `500` signifie 5 %. Les retenues sont arrondies vers le bas à la granularité du portefeuille ; l'acompte minimum est arrondi vers le haut. La dernière échéance reçoit le reliquat exact.

`principalMinor = prix au comptant - acompte + frais contractuels`. L'acompte n'est pas un remboursement de ce principal et n'augmente donc pas `paidMinor`. Les frais sont enregistrés séparément en produits différés, pas automatiquement reconnus comme bénéfice.

### Retenues sur revenus

Un trigger léger réserve le revenu et crée un travail durable lors du règlement. Le worker indépendant traite au maximum 30 travaux par passage, toutes les 15 secondes. Le transport n'attend aucun fournisseur de crédit externe ; les écritures de réserve/outbox restent transactionnelles dans PostgreSQL.

Le worker exige un gain disponible en CDF et une réservation effectivement réglée en mode électronique ou jetons. Un trajet terminé, un paiement initié ou des espèces théoriquement dues ne suffisent pas. Les espèces ne déclenchent aucune retenue Pro ; le conducteur peut rembourser volontairement depuis son portefeuille alimenté.

Le fixe s'applique une seule fois au couple trajet/financement, même avec plusieurs passagers. Le pourcentage s'applique à chaque revenu net réglé, après les retenues matérielles historiques, sans base négative. Les contrats Pro se partagent le disponible dans l'ordre d'activation. Les retenues s'arrêtent à dette nulle ou mandat expiré/révoqué. Un retour ou rejet documentaire suspend les nouvelles retenues automatiques sans effacer la dette.

Exemple contractuel : 20 000 FC encaissés, 3 000 FC de commission, 17 000 FC nets, retenue de 5 % du net = 850 FC. Le disponible conducteur est 16 150 FC. Une contribution de commission est une autre écriture ; elle ne diminue pas une deuxième fois le revenu conducteur.

### Concurrence, panne et compensations

Le verrou utilisateur est partagé avec les retraits ; le verrou crédit existant est réutilisé. Les versements volontaires verrouillent aussi le portefeuille et respectent ses réserves de commission cash. Un retrait ne peut utiliser un revenu marqué `proCreditPending`. Une correction tarifaire ne peut consommer les montants déjà réservés pour des versements.

Les mutations financières et d'exécution exigent un UUID `mutationId`, à conserver avec son contenu lors d'un nouvel essai après timeout. Même UUID avec contenu différent : refus. Les écritures de retenue sont identifiées par gain, financement et version. Une annulation financière génère une compensation, jamais une modification d'écriture. Le passage d'un revenu à `paid` n'est pas assimilé à une annulation. Les corrections de déduction historique ou de devise réactivent le traitement ; aucune conversion de devise implicite n'est effectuée.

Une panne du worker laisse le règlement acquis et sa réserve intacte. Les reprises ont un délai croissant, plafonné à 10 minutes. Surveiller `queue.pending`, `queue.oldestSeconds`, `queue.retrying` et les logs `PRO_CREDIT_WORK_RETRY`. Ne jamais vider les réserves manuellement pour masquer une panne.

Le rapprochement compare dette, remboursements et compte `credit_receivable`. Une annulation portant sur des paiements antérieurs à un rééchelonnement peut nécessiter un nouvel échéancier : `scheduleReviewRequired` et le rapprochement signalent ce cas, sans modifier le contrat en silence.

## API

Préfixe : `/zwanga-pro`. Authentification JWT existante obligatoire. DTO validés ; pages `{ items, nextCursor }`, `limit` de 1 à 100, curseur `after`. Les montants sont des chaînes, pas des nombres JSON.

| Route | Utilisation |
| --- | --- |
| `GET /catalogue` | Produits ouverts, caractéristiques, conditions et stock |
| `POST /applications` | Demande ; produit, acompte, échéancier, justificatifs et, pour un document, véhicule/dossier existants |
| `GET /applications`, `GET /applications/:id` | Demandes du conducteur |
| `GET /mine`, `GET /mine/:id` | Financements, solde, contrat, mandat, échéances et propositions de rééchelonnement |
| `POST /mine/:id/accept` | `{ mutationId, consent: true, termsHash, mandateUntil }` |
| `POST /mine/:id/wallet-payments` | `{ mutationId, purpose: "deposit" ou "repayment", amountMinor }` ; réponse confirmée après commit |
| `GET /mine/:id/receipts` | Écritures et justificatifs paginés |
| `POST /mine/:id/revoke-mandate` | Arrêt des futures retenues automatiques, sans remise de dette |
| `POST /reschedules/:id/consent` | Acceptation explicite du nouvel échéancier proposé |
| `POST /attachments`, `GET /attachments/:id` | Image justificative privée et URL temporaire après contrôle des droits |
| `GET /admin/access`, `/admin/configuration`, `/admin/overview` | Capacités d'interface, paramètres et supervision comptable |
| `PUT /admin/parties/:id`, `POST /admin/grants`, `/admin/policies` | Organisations existantes, habilitations et nouvelles versions de politique |
| `GET /admin/catalogue`, `POST /admin/products`, `PATCH /admin/products/:id` | Catalogue et ouverture/fermeture d'une offre |
| `GET /admin/applications`, `GET /admin/applications/:id`, `POST /admin/applications/:id/review` | Instruction et décision motivée |
| `GET /admin/contracts`, `GET /admin/contracts/:id`, `GET /admin/contracts/:id/receipts` | Suivi des financements et écritures |
| `POST /admin/stock`, `GET /admin/products/:id/stock` | Enregistrement et liste des exemplaires, sans exposition des identifiants sensibles |
| `POST /admin/contracts/:id/deliver`, `POST /admin/contracts/:id/activate` | Preuve de remise puis activation séparée |
| `PATCH /admin/contracts/:id/execution` | Traitement, rejet, retour ; retour/rejet requiert une revue financière distincte |
| `POST /admin/contracts/:id/reschedules`, `POST /admin/reschedules/:id/approve` | Proposition puis approbation par un analyste distinct, après consentement |

Les contrôleurs et DTO sont propres à chaque domaine, avec des tags Swagger `Financing - catalogue`, `Financing - contracts`, etc. Le préfixe `/zwanga-pro` reste stable pour les clients existants. Cette version n'inclut pas de client mobile généré ni de schémas Swagger complets pour toutes les réponses SQL.

### Droits et pièces privées

Le super-administrateur habilite les organisations, ouvre les offres et attribue les droits. Les autres administrateurs n'obtiennent pas automatiquement tous les droits Pro. Rôles spécialisés : `manager`, `analyst`, `stock`, `documents`, `accountant`, `collector`, `funder`, `supplier`, `auditor`.

Les droits fournisseur/financeur sont liés à une organisation et exigent une adhésion active dans `partner_members`. Les actions vérifient aussi l'organisation du produit ou du contrat ; une identité d'organisation envoyée par le client ne fait pas autorité. Les listes globales sont réservées aux équipes internes ; un portail de liste dédié aux partenaires reste à réaliser.

Les justificatifs sont limités aux images JPEG/PNG/WebP validées et réencodées, 5 Mo maximum. Pas de PDF dans cette version. S3 utilise le préfixe privé `pro/` et le chiffrement SSE-S3. Les URLs signées durent 120 secondes. L'accès est journalisé ; aucune URL signée ni identité matérielle n'est placée dans une notification.

Les IMEI et numéros de série sont chiffrés AES-256-GCM ; des empreintes HMAC assurent l'unicité. Les réponses d'inventaire n'exposent ni chiffrements ni empreintes. Aucun verrouillage de téléphone n'est développé.

## Configuration et déploiement contrôlé

Nouvelle variable : `PRO_CREDIT_IDENTITY_KEY`, clé de 32 octets encodée sur 64 caractères hexadécimaux. Son absence interdit l'enregistrement du stock, sans empêcher le démarrage de l'API. Générer la clé dans le circuit de secrets autorisé ; ne pas la copier dans Git, un formulaire admin ou les logs. Ne pas la remplacer directement en production : chiffrement et empreintes d'unicité nécessitent une procédure de rotation/rechiffrement qui n'est pas implémentée ici.

Les paramètres S3 existants (`AWS_REGION`, `AWS_S3_BUCKET_NAME`) restent utilisés. Le rôle ECS déclaré dans `infra-aws/iam-ecs.tf` prévoit déjà les actions objet sur le bucket applicatif. Vérifier les politiques effectives du bucket, son accès public bloqué et les permissions en préproduction ; aucun test S3/AWS réel n'a été lancé.

Ordre de déploiement **à faire après recette et approbation, pas exécuté ici** :

1. Faire une sauvegarde et vérifier une restauration de préproduction. PostgreSQL 15 minimum (`UNIQUE NULLS NOT DISTINCT`), extensions et migrations historiques présentes.
2. Déployer sur une base de préproduction les migrations `1780000137000`, `1780000138000`, `1780000139000`, dans cet ordre, avec transactions activées. Ne pas utiliser `synchronize`. Les DDL ont des délais de verrouillage courts : en cas de contention, attendre une fenêtre adaptée plutôt que supprimer les limites.
3. Déployer le backend **après** les migrations, puis l'admin. Les lectures de gains utilisent les nouvelles colonnes ; l'ancien schéma ne suffit pas. Le workflow de déploiement existant dispose d'une étape de migration ECS avant mise à jour du service : contrôler ses résultats, ne pas la contourner.
4. Vérifier l'API protégée, les logs, l'absence de travaux bloqués, les droits S3 et un parcours complet avec des identités de test. Vérifier sur appareil le parcours mobile lorsqu'il sera développé.
5. Enregistrer les acteurs habilités et les politiques légalement approuvées. Créer les produits désactivés. Ne les ouvrir qu'après validation explicite des conditions, du fournisseur, du financeur et des parcours manquants.

### Repli

Avant toute ouverture d'offre, un repli du binaire est possible en conservant les migrations additives et en vérifiant qu'aucun contrat Pro ni travail n'a été créé. Après activation, **ne pas revenir à un backend ignorant `proCreditPending`** : il pourrait rendre les revenus réservés disponibles aux retraits.

Fermer d'abord les offres par l'API, conserver le worker et les réserves, rapprocher les opérations, puis appliquer un correctif en avant. Les migrations `down()` refusent délibérément d'effacer les preuves financières. Aucun `DROP`, effacement du ledger ni remise à zéro du solde ne constitue une procédure de rollback.

## Vérifications locales

Les suites PostgreSQL créent leurs propres utilisateurs, portefeuilles et bases temporaires sur `127.0.0.1` (`test/isolated-postgres.ts` pour Pro et les crédits historiques ; lanceur isolé existant pour les retraits). Elles ne lisent pas `.env`, n'appellent aucun prestataire et ne manipulent pas de fonds réels.

- Règles unitaires : montants exacts, arrondis, plafonds, nouveaux conducteurs, échéanciers fin de mois.
- PostgreSQL Pro : document et smartphone, deux modèles de financeur, acompte, consentement, livraison, remboursements partiels/anticipés, paiements non réglés ou espèces ignorés, concurrence, reprise, compensation, stock exclusif, droits partenaires, rééchelonnement, impayés, notifications et rapprochement.
- HTTP local : authentification simulée uniquement pour injecter les identités de test ; services et autorisations persistées réels. Contrôles 401/403/404/400, validation de montant et pagination. Ce n'est pas un test de l'émission des JWT de production.
- Régression ciblée après découpage modulaire du 19 novembre 2026 : **668 tests réussis**, 48 suites exécutées ; 6 suites d'intégration, soit 98 tests, non activées dans ce passage sont signalées comme ignorées, pas comme réussies. Les 5 contrôles d'architecture vérifient notamment les 35 routes, l'authentification, l'injection NestJS et l'absence de cycle ou de worker déclaré deux fois.
- PostgreSQL Pro après découpage : **36 tests réussis**, exécutés séparément sur une base temporaire. Les **33 tests des crédits historiques**, **8 tests de reprise des retraits** et **6 tests de subvention cash** avaient été exécutés avec succès lors du passage précédent, avant découpage. Les 16 tests unitaires des règles Pro et les 5 tests d'architecture passent également et sont déjà inclus dans les 668 tests ci-dessus.
- Des passages initiaux ont dépassé les délais de démarrage de PostgreSQL temporaire et du scénario de stock concurrent. Les suites ont été rejouées isolément ; le délai du scénario de stock est de 20 secondes et celui du démarrage du test de retrait est aligné à 60 secondes. Aucun délai de transaction de production n'a été augmenté.
- TypeScript backend et admin : contrôles sans émission réussis. Compilation NestJS et lint du nouveau module, de ses tests, du fixture et des trois migrations : réussis. Ce résultat n'est pas une validation du lint de tout l'historique du dépôt.
- CI : les deux contrôles de politique CI passent. Production et staging activent désormais les suites `ASSET` et `PRO_CREDIT` sur leurs PostgreSQL jetables. Le contrôle documentaire infrastructure passe ; aucun workflow distant n'a été lancé.

Le message `PRO_CREDIT_WORK_RETRY` observé pendant la suite Pro correspond au scénario d'injection volontaire d'une panne du journal. Ce scénario vérifie la conservation de la réserve puis la reprise ; il ne provient pas d'un appel à la production.

Commandes locales (PowerShell ; ajuster uniquement le chemin des binaires PostgreSQL) :

```powershell
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='financing|asset-credit|driver-settlements|payments|wallet'
$env:PRO_CREDIT_TEST_POSTGRES_BIN='C:/Program Files/PostgreSQL/18/bin'
$env:ASSET_TEST_POSTGRES_BIN=$env:PRO_CREDIT_TEST_POSTGRES_BIN
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='pro-credit.postgres|pro-credit.policy'
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='asset-credit.postgres'
$env:PAYOUT_TEST_POSTGRES_BIN=$env:PRO_CREDIT_TEST_POSTGRES_BIN
node node_modules/jest/bin/jest.js --runInBand --testPathPatterns='driver-payout-recovery-postgres'
node --test test/ci-integration-policy.test.cjs
```

## Limites et suites nécessaires avant lancement

Cette livraison est un socle backend testé avec une première supervision admin, **pas la réalisation complète de tous les parcours du cahier des charges**.

Décisions confirmées pour les prochains modules : les remboursements aux clients seront décidés dossier par dossier, motivés, avec un montant explicite et validation par un second responsable. Aucun retour ne déclenchera seul un remboursement ou un effacement de dette. Les règlements fournisseurs/financeurs concerneront des virements effectués hors de Zwanga, avec preuve et rapprochement ; aucun ordre bancaire ne sera envoyé depuis l'administration. Ces circuits doivent être implémentés dans des modules dédiés `refunds` et `partner-settlements`, sans les ajouter aux services de remboursement de crédit ou de livraison. Leur validation métier n'est pas une autorisation de mouvement financier réel.

1. **Mobile et interface partenaire** : catalogue Pro, demande, contrat/mandat, versement, échéances et justificatifs à brancher. Les anciens crédits restent sur leurs anciens écrans et endpoints.
2. **Mobile Money direct vers un contrat** : pas de nouvel encaissement direct. Utiliser le parcours de recharge existant puis le versement portefeuille. Les états prestataire PENDING/FAILED et webhooks restent gérés par le module paiement existant ; pas de déduction Pro avant crédit effectif du portefeuille. Les tests existants de paiement couvrent doublons/échecs, mais pas un nouveau webhook Pro inexistant.
3. **Retours, annulations après acompte, garanties et litiges** : refus/retour suspend la collecte automatique et demande une revue financière. Aucun remboursement automatique d'acompte, effacement de dette, changement d'appareil déjà livré ni correction comptable discrétionnaire. Développer un circuit de correction compensatoire à double validation avant d'ouvrir ces opérations aux équipes.
4. **Règlements fournisseurs/financeurs** : les dettes fournisseurs et créances sont séparées par créancier dans le journal, mais les virements, relevés de rapprochement prestataire et calculs de rentabilité complets ne sont pas intégrés. Une dette fournisseur enregistrée n'est pas présentée comme un virement réussi.
5. **Cofinancement, MDM et autres devises** : `CO_FINANCED` est réservé au schéma et non activable. Aucun adaptateur MDM connecté ni commande de verrouillage. CDF uniquement, sans conversion monétaire.
6. **Éligibilité avancée** : règles explicables présentes ; régularité fine, incidents de fraude confirmés et procédure de dérogation manuelle restent à enrichir avec des sources validées. Aucun score d'IA ni pénalité ajouté.
7. **Exploitation** : rotation de la clé de stock, rétention légale, nettoyage des pièces orphelines, PDF, métriques CloudWatch dédiées et recette sur gros volumes restent à préparer. Rappels génériques dédupliqués par dossier/jour, pas encore un calendrier de recouvrement multicanal personnalisable.
8. **Validation restante** : contrôle visuel navigateur, tests natifs Android/iOS, prestataires en sandbox, restauration complète et charge en préproduction. Aucune de ces validations ni aucune activation AWS n'est revendiquée.
