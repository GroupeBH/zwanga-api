# Retrait des jetons achetés

Date : 18 septembre 2026. Référence : FIN-WALLET-005.

Implémentation locale backend + mobile. Aucun déploiement, retrait réel ou crédit de production exécuté.
Activation fermée par défaut : `WALLET_WITHDRAWALS_ENABLED=true` est nécessaire après validation.

## Règles confirmées

| Origine | Utilisation | Retrait |
| --- | --- | --- |
| Achat confirmé, y compris reçu par transfert après migration | Trajets, abonnements, partage | Mobile Money, KYC approuvé |
| Fidélité, bonus abonnement, crédit admin sans preuve d'achat | Trajets, abonnements, partage | Non, même après transfert |
| Revenus conducteur | Compte conducteur séparé | Parcours conducteur existant |
| Parrainage et commissions des filleuls | Compte parrainage séparé | Parcours existant, après les délais applicables |

Les paiements et partages consomment d'abord les jetons non retirables, puis les achetés.
Un remboursement restaure la part achetée effectivement débitée, sans dépasser cette part.
Lors d'un remboursement partiel, la part achetée est restituée en premier ; un remboursement intégral ultérieur ne restitue que le reliquat.
Les allocations anciennes inconnues et les différences tarifaires électroniques sans débit de jetons restent non retirables.

## Comptabilité et garanties

- `wallet_accounts.balance` : jetons utilisables, hors retraits réservés.
- `withdrawableBalance` : sous-ensemble acheté disponible, entre zéro et `balance`.
- La différence est non retirable (pas exclusivement de fidélité).
- `reservedWithdrawalBalance` : jetons achetés bloqués pour versements en attente.
- `wallet_ledger_entries.withdrawableAmount` : allocation signée de chaque nouvelle écriture ; `NULL` pour l'historique non ventilé.
- `wallet_withdrawals` : montant, devise, taux, téléphone et clé d'idempotence figés à la réservation.
- Journal `withdrawal` à la réservation, `withdrawal_refund` en cas d'échec confirmé. Le succès ne redébite rien.

Une clé utilisateur/UUID ne déclenche jamais deux envois, même simultanés. Seule la transaction créant la réservation peut soumettre au prestataire, hors verrou SQL.
Un timeout ou une absence de commande conserve la réservation : jamais de renvoi ou remboursement automatique après délai.
L'échec confirmé restitue une fois les jetons achetés. Un succès tardif après restitution produit `review` et bloque les débits du portefeuille pour rapprochement manuel ; aucune dette n'est effacée ni débit inventé.

## Migration et anciens soldes

Migration `1780000038000-AddPurchasedTokenWithdrawals`, après `1780000037000`. Aucun solde total ou journal historique n'est supprimé/réécrit.
Les anciennes dépenses n'ayant pas d'origine enregistrée, la migration calcule une borne basse :

`retirable historique = min(solde, max(0, achats vérifiés - tous les anciens débits))`

Un achat éligible possède un paiement `succeeded`, le bon propriétaire, et une réponse de vérification FlexPay complète : succès, commande, référence, montant et devise concordants. Un simple callback ou statut local sans preuve ne suffit pas.
Une divergence entre somme du journal et solde rend le compte historique non retirable automatiquement.
Les anciens transferts reçus, remboursements et crédits non prouvés restent utilisables, mais non retirables. Cela peut sous-estimer les achats restants : examiner ces cas avec les preuves prestataire avant tout ajustement audité. Ne pas rejouer les recharges ni rendre tout le solde retirable.
La consommation « fidélité d'abord » s'applique aux nouvelles opérations après migration.

## API, mobile et FlexPaie

- `GET /wallet/me` : ventilation et objet `withdrawal` (activation, conversion, minimum, disponibilité, blocage).
- `POST /wallet/withdrawals` : `{ tokens, phone, idempotencyKey }`, authentifié, KYC approuvé, minimum 1 jeton, deux décimales maximum, numéro RDC international.
- `GET /wallet/withdrawals` : 50 derniers retraits du seul utilisateur connecté.
- `GET /wallet/withdrawals/:id/status` : vérification de son retrait, même sans commande connue.
- `POST /wallet/withdrawals/flexpay/callback` : public, vérification prestataire obligatoire, réponse limitée à un accusé de réception.

`PaymentPurpose.WALLET_PAYOUT` utilise le client payout existant et ses sept paramètres `FLEXPAY_PAYOUT_*`. Aucun nouvel identifiant marchand.
Callback dérivé de `FLEXPAY_CALLBACK_BASE_URL`, sinon `PUBLIC_API_BASE_URL` : base HTTPS incluant le préfixe API, suffixe `/wallet/withdrawals/flexpay/callback`.
Le taux suit `ZWANGA_POINT_VALUE_CURRENCY` / `TRIP_PAYMENT_CURRENCY` et `ZWANGA_POINT_VALUE_<DEVISE>` / `ZWANGA_POINT_VALUE`. Par défaut : 100 CDF/jeton. Ne pas changer les taux pendant des recharges en attente.
Les callbacks de recharge sont toujours vérifiés, même si `FLEXPAY_VERIFY_CALLBACKS=false`, avec concordance commande/montant/devise. Sans preuve complète, pas de crédit nouveau.

Un cron toutes les cinq minutes réconcilie jusqu'à 50 retraits en attente, sans nouveau virement ; il continue lorsque l'activation est désactivée.
Le mobile persiste la demande avant envoi et reprend la même clé après coupure/redémarrage. Il distingue attente, succès, restitution et vérification manuelle. Une initiation n'est jamais présentée comme un versement réussi.

## Déploiement, surveillance et retour arrière

1. Sauvegarder et examiner les soldes sur copie/staging ; garder le commutateur désactivé.
2. Suspendre les écritures portefeuille des anciennes instances, y compris cron et callbacks : aucun écrivain ancien pendant/après migration.
3. Appliquer les migrations en transaction puis démarrer seulement le nouveau backend. Le verrou échoue après cinq secondes plutôt que bloquer indéfiniment.
4. Vérifier soldes, contraintes, achats, transferts et remboursements en staging ; valider le vrai contrat FlexPaie et les callbacks.
5. Publier le mobile ; importer le commutateur SSM et sa référence ECS ; activer explicitement après validation payout dans l'environnement approprié.
6. Surveiller `WALLET_WITHDRAWAL_RECONCILIATION_PENDING`, `WALLET_WITHDRAWAL_LATE_SUCCESS_REVIEW` et les retraits sans commande. Rapprocher les orphelins avec le prestataire, sans libération automatique.

Désactivation : commutateur à `false`, conserver callbacks et réconciliation. Ne pas remettre un backend ignorant la ventilation. La migration inverse refuse dès qu'une nouvelle écriture ventilée ou un retrait existe : corriger en avant sans effacer la comptabilité.

## Tests

Tests d'origine, transferts en chaîne, remboursements, KYC, double clic, concurrence, statuts, isolation utilisateur, cohérence paiement/retrait et reprise mobile après erreur réseau/stockage.
Test PostgreSQL isolé : `src/database/wallet-withdrawals-postgres.spec.ts`, activé par `WALLET_TEST_POSTGRES_BIN` (dossier des exécutables). Il crée un cluster temporaire sans jamais lire `.env` ni une URL de base existante.
Aucun transfert FlexPaie réel dans les tests. Validation staging et sur appareils requise avant activation.
