# Architecture modulaire des financements

## Périmètre

Zwanga Pro reste une dénomination commerciale, pas un service métier unique. Le backend est organisé par responsabilités dans `src/financing`. `FinancingModule` assemble les modules ; il ne porte aucune opération métier. Le crédit matériel historique reste dans `src/asset-credit`, avec ses propres règles et endpoints.

## Responsabilités

| Répertoire | Responsabilité | Services principaux |
| --- | --- | --- |
| `catalogue` | Produits configurables et ouverture des offres | `CreditCatalogService` |
| `partners` | Habilitations des organisations et droits spécialisés | `CreditPartnersService` |
| `policies` | Création des politiques contractuelles versionnées | `CreditPoliciesService` |
| `eligibility` | Faits du conducteur et calcul explicable d'éligibilité | `CreditEligibilityService` et politique pure |
| `applications` | Dépôt, consultation et instruction des demandes | `CreditApplicationsService` |
| `contracts` | Acceptation, activation, mandat et consultation des contrats | `CreditContractsService` |
| `fulfilment` | Remise, attribution d'un équipement, délivrance documentaire | `CreditDeliveryService`, `EquipmentStockService`, `VehicleDocumentsService` |
| `evidence` | Téléversement privé et accès temporaire aux preuves | `CreditEvidenceService` |
| `repayments` | Versements portefeuille et retenues sur trajets réglés | `CreditWalletPaymentsService`, `TripCreditRepaymentWorker` |
| `ledger` | Journal comptable et historique des écritures | `CreditLedgerService` |
| `schedules` | Échéanciers, rééchelonnement et rappels | `CreditSchedulesService`, `CreditRemindersWorker` |
| `reporting` | Agrégats, impayés et rapprochement de dette | `CreditReportingService` |
| `collections` | Journal de recouvrement et débiteurs en retard des deux sources, sans effet financier | `CreditCollectionsService` |
| `shared` | Infrastructure transactionnelle, identités, montants exacts et modèles SQL partagés | `CreditStore`, utilitaires monétaires |

Chaque domaine exposé dispose de son contrôleur et de ses DTO. Dans l'exécution, `EquipmentStockModule` et `VehicleDocumentsModule` sont indépendants ; `CreditFulfilmentModule` les assemble pour la remise. Les règles pures de monnaie, éligibilité, allocation des retenues et calcul d'échéancier sont séparées des services d'accès aux données.

## Dépendances et transactions

Les modules de demandes et de contrats utilisent le catalogue et l'éligibilité. Les remboursements utilisent le catalogue et le journal. Les services transversaux sont fournis par `CreditCoreModule`, importé explicitement, sans module global ni `forwardRef`.

La livraison reste une opération atomique. `CreditDeliveryService` vérifie le contrat, l'habilitation et la preuve, puis transmet le même `EntityManager` transactionnel au service de stock ou au service documentaire. Ces services internes ne démarrent pas de transaction indépendante. Une erreur annule l'ensemble de la remise.

Le worker de retenues et le worker de rappels sont enregistrés chacun dans un seul module. Le point d'assemblage ne les redéclare pas. La dette, le portefeuille, les verrous et le journal conservent une seule source de vérité PostgreSQL.

## Compatibilité

Le découpage ne renomme ni les tables `pro_credit_*`, ni les champs HTTP, ni les événements, ni la version contractuelle `zwanga-pro-v1`. Les 35 couples méthode/route sous `/zwanga-pro` restent inchangés. Les migrations déjà écrites conservent leur identité et leur contenu. Aucune migration de données n'est nécessaire pour ce découpage seul ; les migrations fonctionnelles du module restent nécessaires avant son premier déploiement.

Évolution du 25 novembre : `collections` ajoute trois routes sous `/zwanga-pro` et enrichit trois lectures admin existantes sans migration. La liste canonique des routes actuelles reste contrôlée par la spec d'architecture ; contrats, droits, exemples et limites du recouvrement figurent dans [le guide d'intégration](zwanga-pro-integration.md#recouvrement--25-novembre-2026).

Le nom `PRO_CREDIT_IDENTITY_KEY` reste compatible avec la configuration existante. Aucun secret ne doit être dupliqué simplement pour refléter un changement de nom de classe. Les styles admin et partenaire ne font pas partie de cette réorganisation backend.

## Règles pour les évolutions

- Ajouter une opération dans le domaine qui en porte l'invariant, pas dans un service générique `operations` ou `finance`.
- Déclarer les dépendances NestJS explicitement et utiliser les services exportés ; ne pas importer le point d'assemblage depuis un sous-module.
- Ne pas exposer les opérations transactionnelles internes de stock ou de document directement dans un contrôleur sans les validations de livraison.
- Garder les droits, l'idempotence, les verrous et l'audit dans le chemin d'exécution d'une mutation. Une vérification d'interface ne remplace pas l'autorisation serveur.
- Ajouter les tests métier au domaine concerné et conserver les tests PostgreSQL transversaux pour les soldes, compensations et concurrences.

## Décisions pour les modules suivants

`refunds` portera les remboursements au client après retour ou annulation : proposition justifiée, montant explicite, contrôle par un second responsable, écritures compensatoires et preuve d'exécution. Il ne faut pas confondre ce remboursement au client avec `repayments`, qui diminue sa dette.

`partner-settlements` portera l'enregistrement des virements externes aux fournisseurs/financeurs, leurs preuves et leur rapprochement. Une preuve déposée ne doit pas être assimilée automatiquement à un paiement rapproché. Ce module ne déclenchera pas de virement bancaire.

Ces deux choix sont validés métier ; leurs workflows ne sont pas livrés par la seule réorganisation des modules. Le suivi fonctionnel et les autres limites restent dans [l'intégration Zwanga Pro](zwanga-pro-integration.md).

## Vérification

`src/financing/tests/financing-architecture.spec.ts` contrôle l'assemblage réel des modules avec des dépendances externes simulées, l'absence de cycle, l'unicité des fournisseurs de services et des routes, ainsi que la conservation de l'authentification sur tous les contrôleurs. Les suites `pro-credit.policy.spec.ts` et `pro-credit.postgres.spec.ts` conservent les scénarios métier, sur les nouveaux services sans façade de compatibilité monolithique.

Ces contrôles ne constituent ni un déploiement, ni une recette native mobile, ni une certification de capacité en production.

Résultats locaux du 19 novembre 2026 : 5 tests d'architecture et 16 tests de règles réussis, inclus dans une régression de 668 tests réussis sur 48 suites. Les 36 scénarios PostgreSQL Pro passent séparément sur une base jetable. Le lint des nouveaux modules passe. Les détails et limites des autres validations sont consignés dans la documentation d'intégration.
