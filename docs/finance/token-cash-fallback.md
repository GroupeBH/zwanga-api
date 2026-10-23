# Complément de jetons vers cash — 2026-10-23

Préparé localement, sans déploiement ni migration sur une base existante.

Le complément Mobile Money est un achat de jetons : son attente ne doit plus
verrouiller le paiement cash du trajet. `POST /bookings/:id/token-cash-fallback`
enregistre ce choix explicitement, après l’arrivée et avant règlement. Le passager
paie le montant entier en cash ; ses jetons ne sont pas débités. Une recharge
tardive confirmée reste dans son portefeuille, via la réconciliation existante.
Cela n’annule pas l’opération opérateur et ne constitue pas un remboursement.

Fichiers : `src/bookings/token-cash-fallback.{controller,service}.ts`,
`bookings.module.ts`, `bookings.service.ts`, `entities/booking.entity.ts`,
`mixed-cash-payment.service.ts`, `src/driver-finance/driver-finance.service.ts`,
migration additive `1780000091000-TokenCashFallback.ts` et son index.

Précautions : propriétaire authentifié, UUID et fréquence contrôlés ; verrou
réservation partagé avec le règlement jetons ; vérification du paiement et du
ledger ; référence et transaction fournisseur conservées ; aucune opération
prestataire sous verrou ; marqueur immutable/contraintes empêchant le règlement
tardif par un ancien client. Pas de modification des commissions ni parrainages,
pas de fausse réception cash. Les collectes directes non résolues restent bloquantes.
La migration down refuse l’effacement de la preuve financière.

Tests : `token-cash-fallback-postgres.spec.ts` (PostgreSQL réel jetable avec PostGIS,
concurrence, recharge tardive, isolation propriétaire et écriture ancienne),
`test/token-cash-commission-postgres.ts` étendant la suite des commissions réelles,
régressions `mixed-cash-payment-postgres.spec.ts`, `booking-payment-recovery.spec.ts`
et `topup-recovery.spec.ts` : 47 réussites. Suite des commissions : 108 réussites,
trois tests de compatibilité ignorés (commit déployé non fourni). TypeScript build
sans émission et diff check réussis. Résultats consolidés dans le journal et le document
mobile `../zwanga/docs/PAIEMENT_BASCULE_JETONS_ESPECES_2026-10-23.md`.

Limites : pas d’appel de paiement réel ni d’essai sur appareil physique. Déploiement
de la migration puis du backend requis avant utilisation par le nouveau mobile.
