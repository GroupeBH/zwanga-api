# Retraits des jetons et valeur de 25 FC

Dernière mise à jour : 14 octobre 2026. Référence : FIN-WALLET-005.

Correctif backend local, sans déploiement AWS ni opération financière réelle. Cette règle remplace l'interdiction générale temporaire du parrainage décidée plus tôt le même jour.

## Politique actuelle

| Origine | Utilisation | Retrait en argent |
| --- | --- | --- |
| Jetons achetés, transférés, fidélité, bonus ou ajustement admin | Trajets, abonnements, partage | Interdit, même avec KYC ou ancien commutateur activé |
| Jetons de parrainage disponibles | Compte parrainage séparé | Dès **1 000 jetons par demande**, soit **25 000 FC**, avec KYC et solde suffisants |
| Gains de trajets du conducteur | Solde monétaire conducteur séparé | Parcours existant conservé |

La valeur courante est **1 jeton = 25 FC**, pour les jetons d'usage comme de parrainage. Le nombre de jetons existants est conservé : aucun solde n'est multiplié par quatre. Un compte de 100 jetons conserve 100 jetons et représente désormais 2 500 FC.

L'abonnement Pro reste à 5 000 FC : un nouveau paiement Pro coûte donc 200 jetons. Le bonus d'abonnement reste 25 jetons. La limite de dette cash reste 25 jetons (625 FC à la nouvelle valeur). Les taux des commissions, prix monétaires des trajets et soldes monétaires conducteur ne changent pas.

Le bonus de bienvenue est désormais **200 jetons = 5 000 FC pour les futures attributions**, y compris le rattrapage des comptes éligibles n'ayant jamais reçu ce bonus. Les anciens bonus de 50 jetons et tous les soldes existants restent inchangés : ni multiplication, ni complément de 150 jetons, ni second bonus.

L'éligibilité reste identique : compte actif, rôle conducteur ou passager et dernier KYC approuvé. Le cron existant privilégie toujours les conducteurs. La notification conducteur annonce « 5 000 FC vous sont offerts sous forme de 200 jetons Zwanga pour vous permettre de payer votre abonnement Pro ». Le Pro n'est pas activé automatiquement : le bénéficiaire doit toujours le payer. Le bonus reste promotionnel, non retirable.

## Contrats API conservés

- `POST /wallet/withdrawals` : refus **403 TOKEN_WITHDRAWALS_DISABLED**, avant lecture/réservation de solde, même pour une reprise avec une ancienne clé.
- `GET /wallet/me` : `withdrawal.enabled=false`, `blocked=true`, `availableMoney=0`, `moneyPerToken=25` en CDF et motif explicite. La ventilation comptable du compte reste présente.
- `POST /referrals/me/withdrawals` : `tokens >= 1000`, KYC et solde disponible requis. 999,99 jetons sont refusés ; 1 000 donnent un retrait de 25 000 CDF. La limite porte sur le montant demandé, pas uniquement sur le solde.
- `GET /referrals/me` : `withdrawal.enabled=true`, `minimumTokens=1000`, `moneyPerToken=25`, `currency=CDF`, `blocked` si le KYC ou le solde disponible manque.
- Les routes de statut/historique/callback restent actives pour les opérations déjà engagées, y compris les anciens retraits portefeuille.
- Le service de paiement refuse les retraits portefeuille et les sources inconnues. Il accepte les gains conducteur et les retraits de parrainage explicitement liés à une demande, en CDF et d'au moins 25 000 FC.

Un bouton encore affiché dans une ancienne app ne permet pas de contourner le contrôle serveur.

## Conservation de la comptabilité et des opérations engagées

- `balance`, `withdrawableBalance`, réserves et écritures existantes ne sont pas modifiés par la migration. `withdrawableBalance` reste une ventilation d'origine achetée, pas une autorisation de retrait.
- Les retraits déjà créés gardent leur montant monétaire et leur taux enregistrés. Les callbacks continuent à régler succès/échec une seule fois. Un transfert déjà envoyé n'est pas annulé arbitrairement.
- Une nouvelle recharge enregistre sa quantité dans `payment_transactions.tokenQuantity`. Une ancienne recharge en attente récupère sa quantité depuis la description exacte générée par le serveur (`Achat de X jetons Zwanga`). En l'absence de preuve de quantité, le crédit est refusé pour vérification, jamais recalculé arbitrairement au taux du jour.
- Une réservation déjà créée garde son taux immuable `cashCommissionTokenValue`, également enregistré historiquement pour le paiement en jetons. Les reprises de débits et ajustements de paiements en jetons gardent cette référence ; les nouvelles réservations utilisent 25.
- Un remboursement de débit restitue les jetons réellement débités. Un crédit de différence tarifaire issu d'un paiement électronique est converti au nouveau taux.
- Les récompenses de parrainage déjà enregistrées gardent leur quantité ; seules les nouvelles récompenses monétaires utilisent la conversion à 25.
- Une erreur technique après initiation d'un retrait de parrainage conserve la réservation ou reprend son règlement depuis la transaction existante ; elle ne libère pas arbitrairement le solde.

## Migration et déploiement

1. Migration `1780000070000-TokenValue25Cdf` : colonne nullable `tokenQuantity` avec contrainte, défaut 25 pour les nouvelles réservations. Aucun recalcul de solde, de journal ou de retrait.
2. Migration `1780000071000-WelcomeBonus25CdfCopy` : étape historique conservée, corrigeant le texte du bonus de 50 jetons à 1 250 FC. Puis `1780000072000-WelcomeBonus200Tokens` : futures attributions à 200, journal et notification cohérents, contrainte acceptant les anciens 50 et les nouveaux 200. Aucune attribution pendant la migration. Les anciens bénéficiaires ne sont pas recrédités, même si seul leur journal permet de retrouver l'attribution.
3. Les migrations sont transactionnelles, avec délais bornés. Elles doivent précéder le backend mis à jour. Leurs méthodes `down` demandent une correction en avant pour ne pas supprimer des devis ni restaurer une fausse promesse.
4. Utiliser le pipeline existant, **sans modification CI/CD ou Terraform**. Éviter les opérations financières pendant le remplacement des instances : les anciennes calculent encore à 100. Attendre la fin complète du déploiement.
5. Aligner les valeurs existantes de configuration pour éviter l'ambiguïté opérationnelle : `ZWANGA_POINT_VALUE=25`, `ZWANGA_POINT_VALUE_CDF=25`, `ZWANGA_POINT_VALUE_CURRENCY=CDF`, `REFERRAL_MONEY_PER_TOKEN_CDF=25`, `REFERRAL_MIN_WITHDRAWAL_TOKENS=1000`, `REFERRAL_PAYOUT_CURRENCY=CDF`. Le code impose déjà ces règles CDF malgré une ancienne valeur. `WALLET_WITHDRAWALS_ENABLED` reste sans effet sur l'interdiction des retraits portefeuille.
6. Vérifier les résumés et les refus de retrait sans déclencher de versement réel. Surveiller les règlements et les anciennes recharges sans quantité récupérable.

Ne pas rétablir un ancien backend sans analyse : il peut réautoriser des retraits ou appliquer le tarif 100.

### Bonus de bienvenue : activation et contrôle

- La migration 72 est enregistrée après 71 dans `databaseMigrations`. Aucun nouveau paramètre d'environnement, endpoint ou changement du pipeline n'est requis pour ce bonus.
- Le déclencheur de validation et le cron appellent la même fonction SQL : après le commit de la migration, chaque **première attribution** éligible vaut 200. Le crédit, le journal, le marqueur d'attribution et la notification sont atomiques. Les échecs isolés et la reprise différée de 15 minutes restent en place ; aucun envoi réseau n'est effectué dans la transaction.
- Le guide `supabase-postgres-best-practices` a guidé la migration : verrous et délais bornés, aucun recalcul des lignes historiques, ordre de verrouillage utilisateur puis portefeuille inchangé. La nouvelle contrainte est ajoutée `NOT VALID` pour éviter un parcours complet sous verrou exclusif ; l'ancienne contrainte garantissait déjà 50 pour les lignes historiques, et toutes les nouvelles écritures sont contrôlées.
- Après déploiement, vérifier un nouveau bénéficiaire éligible : crédit 200, `withdrawableAmount=0`, une seule attribution et notification en attente d'envoi. Un ancien bénéficiaire de 50 ne doit recevoir ni complément ni nouvelle notification. Les notifications historiques ne sont pas réécrites.
- Le contenu `wallet_loyalty_reward`, l'identité d'événement `wallet:<ledgerId>` et les champs envoyés au mobile restent identiques. La notification confirme l'offre, pas l'activation du Pro.

## Application mobile : limite restante

Aucune modification mobile n'a été effectuée dans ce correctif backend. Le code inspecté dans `zwanga/constants/paymentFeatures.ts` possède encore une valeur par défaut de 100 via `EXPO_PUBLIC_ZWANGA_POINT_VALUE_CDF`, utilisée notamment par `useArrivalPaymentState.ts`. Ces estimations doivent être harmonisées, idéalement sur les taux renvoyés par le serveur et la réservation, avant la bascule utilisateur. Le changement d'une variable backend ne met pas à jour une constante déjà intégrée dans une app publiée.

Les écrans de parrainage et d'abonnement lisent déjà les seuils/prix de l'API, mais aucun essai sur appareil physique n'a été effectué ici.

## Vérifications

Résultats après ajout du bonus de 200, le 14 octobre 2026 : **880 tests ciblés réussis dans 63 suites**, **15 tests PostgreSQL réels du bonus réussis sur un cluster jetable**, compilation `npm run build` réussie et `git diff --check` sans erreur. Les 3 tests PostgreSQL des migrations 70/71 avaient également réussi lors de l'étape précédente. Aucun paiement/push réel, aucune base applicative ni infrastructure AWS modifiée. Le cluster de test est arrêté et supprimé automatiquement.

Tests ciblés : seuil inclusif, soldes insuffisants, KYC, prestataires simulés, protection des anciens retraits/recharges, paiements de trajets, Pro, commissions, notifications et absence de multiplication des soldes.

Le test `src/database/token-value-postgres.spec.ts` utilise uniquement un cluster PostgreSQL jetable sur une adresse locale et un port aléatoire. Activation par `TOKEN_VALUE_TEST_POSTGRES_BIN` ; aucune URL de base applicative ni fichier `.env` n'est lu.

Le test `src/database/welcome-bonus-200-postgres.spec.ts`, activé par `WELCOME_BONUS_TEST_POSTGRES_BIN` pointant vers les binaires PostgreSQL, utilise lui aussi un cluster local jetable sans `.env` applicatif. Il couvre le maintien des anciens 50, la récupération des crédits sans marqueur, les 200 sur `PTS`/`POINTS`, l'éligibilité, la concurrence, le rattrapage et le rollback complet si la notification ne peut pas être enregistrée.
