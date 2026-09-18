# Paiement à proximité de la destination

Depuis le 18 septembre 2026, le seuil d'autorisation du paiement anticipé passe de 150 à **500 mètres inclus** de la destination personnelle du passager (à défaut, destination du trajet).

Le mobile ouvre le modal existant pour un passager embarqué avec un paiement électronique ou en jetons encore dû. Le passager doit valider pour payer : aucune transaction n'est déclenchée par la seule proximité. Le cash, les trajets gratuits et les paiements déjà confirmés ne déclenchent pas ce modal anticipé.

Le backend et le mobile utilisent chacun `EARLY_PAYMENT_DISTANCE_METERS = 500` :

- Backend : `src/bookings/near-arrival-payment.ts`.
- Application `zwanga` : `features/arrival-payment/nearArrivalPolicy.ts`.

Les positions doivent toujours être fraîches (30 secondes maximum) et valides. La distance est géographique, pas routière ; le déclenchement dépend des mises à jour reçues. Les règles d'embarquement, de contestation et de paiement après l'arrivée sont inchangées. Le débit en jetons revérifie la proximité dans la transaction existante.

Un paiement anticipé ne termine pas le trajet et ne libère pas les gains ou la fidélité avant le transport effectué. Les seuils distincts de dépose et de non-présentation restent inchangés.

Déployer le backend avant la nouvelle version mobile pour éviter un refus serveur entre 150 et 500 mètres. Aucune migration SQL, nouvelle variable d'environnement ou dépendance n'est nécessaire pour ce changement. Les autres migrations en attente du dépôt restent indépendantes de ce seuil.

Validation : tester les modes électronique et jetons à 501 mètres (pas de modal), puis 500 mètres (modal), les positions anciennes, le report du paiement à l'arrivée et les fluctuations GPS après ouverture. Tests automatisés : `src/bookings/near-arrival-payment.spec.ts`, `src/bookings/bookings.service.spec.ts` et, dans le mobile, `tests/nearArrivalPayment.test.js` / `tests/arrivalPaymentSubmission.test.js`. Aucun paiement réel n'est exécuté par ces tests.
