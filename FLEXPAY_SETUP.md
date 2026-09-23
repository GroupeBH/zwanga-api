# FlexPay payments

This backend uses a reusable `PaymentsModule` to initiate and confirm FlexPay
payments. The Pro subscription is one consumer of that module, but the same
payment transaction table and service can be reused for another paid feature.

## Flow

1. The mobile app calls `POST /api/v1/subscriptions/subscribe`.
2. The backend creates a `pending` subscription and a `payment_transactions`
   row, then sends the payment request to FlexPay.
3. For Mobile Money, FlexPay sends a push prompt to the user's phone.
4. For card payments, FlexPay returns a `paymentUrl`; the app opens that URL.
5. FlexPay posts the result to `POST /api/v1/subscriptions/flexpay/callback`.
6. `PaymentsModule` verifies the `orderNumber` with FlexPay, then
   `SubscriptionsModule` activates the subscription if the payment succeeded.
7. The app can also call `GET /api/v1/subscriptions/payments/:orderNumber/status`.

Generic payments can use:

- `POST /api/v1/payments/flexpay/callback`
- `GET /api/v1/payments/:orderNumber/status`

Trip booking payments use:

- `POST /api/v1/bookings/:id/pay`
- `POST /api/v1/bookings/flexpay/callback`
- `GET /api/v1/bookings/payments/:orderNumber/status`
- `PUT /api/v1/bookings/:id/payment-mode`

The booking amount is calculated by the backend from
`trip.pricePerSeat * booking.numberOfSeats`; the app does not send the amount.

The passenger selects one of these `paymentMode` values when creating a booking
or through the payment-mode endpoint:

- `electronic`: pay the accepted booking through FlexPay with the `/pay` route.
- `points`: debit the passenger's Zwanga points wallet immediately.
- `cash`: pay physically; no electronic transaction is created.

## Zwanga points (tokens)

Points and tokens refer to the same wallet balance. By default, the wallet
currency is `PTS` and `1 point = 100 CDF`. The `amount` sent by the client to
`POST /wallet/topups` is the number of points to buy; the backend converts it to
CDF before sending the payment to FlexPay. It never credits a top-up from the
initiation response: it waits for a successful, verified FlexPay callback or
status check.

Authenticated wallet endpoints:

- `GET /api/v1/wallet/me`: current balance and 30 latest ledger entries.
- `GET /api/v1/wallet/ledger`: complete points ledger.
- `POST /api/v1/wallet/topups`: buy points with Mobile Money or card.
- `GET /api/v1/wallet/topups/:orderNumber/status`: verify a purchase and credit
  it once.

FlexPay calls the public callback
`POST /api/v1/wallet/topups/flexpay/callback`. A successful purchase is
idempotent: the unique payment transaction can create only one `top_up` ledger
entry.

Mobile Money points purchase:

```json
{
  "amount": 50,
  "method": "mobile_money",
  "phone": "243891234567"
}
```

This charges `5000 CDF` through FlexPay and credits `50 PTS` after confirmation.

Card points purchase:

```json
{
  "amount": 50,
  "method": "card",
  "approveUrl": "zwanga://wallet/topup?status=success",
  "cancelUrl": "zwanga://wallet/topup?status=cancel",
  "declineUrl": "zwanga://wallet/topup?status=decline"
}
```

To pay a booking with points:

```json
{
  "paymentMode": "points"
}
```

Send that body to `PUT /api/v1/bookings/:id/payment-mode`. If the balance is
insufficient, the request fails without marking the booking as paid. A points
payment is refunded once when the booking is cancelled or rejected. Completing
a trip grants `ZWANGA_LOYALTY_BASE_REWARD` first, then adds
`ZWANGA_LOYALTY_POINTS_PER_KM` for each travelled kilometer. When distance is
unavailable, the backend falls back to a price-based loyalty amount converted
with the same point value. With the defaults, every completed booking grants at
least `1 point`, worth `100 CDF` on the platform, plus `0.5 point/km`.

## Prix kilometrique en cas d'interruption

Le prix publie par le conducteur reste le plafond d'une course complete. Quand
le conducteur arrete le trajet avant l'arrivee ou qu'un passager descend plus
tot, le backend recalcule automatiquement la reservation avec la formule :

```text
prix final = prix publie x distance parcourue / distance prevue
```

La distance prevue est calculee entre l'origine et la destination de la
reservation. La distance parcourue va de cette origine au point
d'interruption. Google Directions fournit la distance routiere; si le service
n'est pas disponible, le backend utilise la distance geodesique. Le prix final
ne peut jamais depasser le prix publie.

La reservation expose les champs d'audit `originalPaymentAmount`,
`paymentAmount`, `plannedDistanceMeters`, `travelledDistanceMeters`,
`pricePerKilometer`, `fareAdjustmentAmount` et `fareAdjustedAt`.

- En especes, `paymentAmount` devient directement le montant restant a payer.
- Pour un paiement electronique ou par points deja confirme, la difference est
  creditee une seule fois dans le portefeuille de points Zwanga avec le type de
  mouvement `booking_fare_adjustment`.
- Les points de fidelite et le revenu du conducteur sont calcules sur le prix
  final ajuste.

## Mobile Money request

```json
{
  "plan": "pro",
  "paymentMethod": "mobile_money",
  "phone": "243891234567"
}
```

The response includes the local subscription, the FlexPay `reference`, the FlexPay
`orderNumber`, and the provider message.

## Card request

```json
{
  "plan": "pro",
  "paymentMethod": "card",
  "approveUrl": "zwanga://subscriptions/payment?status=success",
  "cancelUrl": "zwanga://subscriptions/payment?status=cancel",
  "declineUrl": "zwanga://subscriptions/payment?status=decline"
}
```

The response includes `payment.paymentUrl`. Redirect the user to that URL.

## Reusing the payment module

Inject `PaymentsService` and call `initiatePayment()` with a purpose, amount,
currency, method and optional related entity:

```ts
await paymentsService.initiatePayment({
  userId,
  purpose: 'document_fee',
  relatedEntityType: 'document_request',
  relatedEntityId: requestId,
  method: PaymentMethod.MOBILE_MONEY,
  phone: '243891234567',
  amount: 10,
  currency: 'USD',
  description: 'Frais de document',
  callbackUrl: 'https://api.zwanga.cd/api/v1/payments/flexpay/callback',
});
```

## Driver earnings payouts (FlexPaie Payout v1.03)

Guide en français, variable par variable et diagnostic de l'authentification :
[Configuration FlexPaie payout](docs/finance/flexpaie-payout-configuration.md).

The payout adapter follows `FlexPay_API_Documentation_Payout_v1_03.pdf`
(revision 22 April 2024), pages 3 and 5-13 in the document's printed numbering.
This is a separate API from Mobile Money collections: do not use
`paymentService`, the former `merchantPayOutService` URL, or the collection token.
The PDF uses placeholder hosts and a placeholder `version`; obtain the actual
payout URL, username and password from FlexPaie before enabling withdrawals.

Required configuration (also added, empty, to the environment templates):

```env
FLEXPAY_PAYOUT_SERVICE_URL=
FLEXPAY_PAYOUT_USERNAME=
FLEXPAY_PAYOUT_PASSWORD=
```

`FLEXPAY_PAYOUT_SERVICE_URL` must be the full HTTPS payout URL ending in `/pay`.
The payout merchant defaults to `FLEXPAY_MERCHANT_CODE` (or `FLEXPAY_MERCHANT`);
set `FLEXPAY_PAYOUT_MERCHANT_CODE` if FlexPaie assigned a separate merchant code.
Passwords and tokens stay on the backend, never in the mobile app.

Optional overrides if FlexPaie provides different hosts:

| Variable | Default when empty |
| --- | --- |
| `FLEXPAY_PAYOUT_AUTH_URL` | Payout origin + `/api/v1/auth/authenticate` |
| `FLEXPAY_PAYOUT_CHECK_TRANSACTION_URL` | Payout origin + `/api/rest/v1/check/{orderNumber}` |
| `FLEXPAY_PAYOUT_BALANCE_URL` | Payout origin + `/api/rest/v1/balance/{merchant}` |
| `FLEXPAY_DRIVER_PAYOUT_CALLBACK_URL` | Callback base + `/driver-settlements/payouts/flexpay/callback` |

The check/balance overrides accept the placeholders shown above; otherwise the
encoded order number / merchant is appended to the configured URL.
Confirm these default hosts with FlexPaie: the PDF does not supply them.

The mobile API is unchanged:

1. `POST /api/v1/driver-settlements/payouts` reserves the available driver earnings
   using the existing driver lock and idempotency key.
2. The backend authenticates with `{ username, password }`, caches the returned
   Bearer token in memory according to `expire_in` with an expiry margin, then
   submits `{ merchant, type, reference, amount, currency, customer, description,
   callback_url }`. The beneficiary number uses `243…`, without `+`.
3. An accepted request (`code=0`, `status=0XX0`, nonempty `orderNumber`) remains
   `initiated`, not `succeeded`. The PDF example's `OXX0` spelling is also accepted.
4. The callback or `GET /api/v1/driver-settlements/payouts/:orderNumber/status`
   verifies the flat payout check response with the payout token. Both the
   merchant reference and order number must match. Only `code=0`, `status=0`
   confirms delivery. A matching transaction with `status=1` and `code=0` or `1`
   confirms failure. A transaction-not-found response without transaction details
   does not release reserved earnings.

Payout callbacks are always verified, including failures, regardless of
`FLEXPAY_VERIFY_CALLBACKS`. The new adapter also serves referral payouts because
they share the same outgoing-payment service. Incoming collections are unchanged.

Explicit initiation rejections (`code=1`) map `0XX2` to insufficient **merchant**
funds, `0XX3` to unsupported beneficiary, `0XX4` to token/configuration failure,
and `0XX5` to another refusal. The driver is never asked to pay or replenish a
wallet to receive earnings. `0XX1` (provider busy / transaction pending), unknown
acknowledgements and uncertain network delivery keep the reservation pending.
The PDF mentions waiting 30 seconds for `0XX1`; the backend deliberately does not
resend money automatically. Reconcile using the order number or contact FlexPaie
with the merchant reference when no order number was returned.

Missing configuration or failed authentication prevents `/pay` from being called
and releases an unsent reservation. Expired/rejected tokens are discarded; no
payout POST is automatically replayed. `checkPayoutBalance()` provides an internal
authenticated diagnostic for the merchant's USD/CDF balances; it is not exposed
as a public endpoint or used as a guarantee that a payout will succeed.

Before rollout, configure the real URLs/credentials, ensure the HTTPS callback
is externally reachable, and verify the merchant's payout account is funded.
Existing withdrawals created with the former API must be reconciled with
FlexPaie before any new attempt; this change never resubmits them automatically.
Automated tests mock HTTP and do not validate credentials or transfer real funds.

## Required environment variables

```env
FLEXPAY_MERCHANT_CODE=
FLEXPAY_TOKEN=
# Also accepted for compatibility with common FlexPay snippets:
FLEX_PAIE_TOKEN=

# Mobile Money. Set the full endpoint or the base URL.
FLEXPAY_PAYMENT_SERVICE_URL=https://backend.flexpay.cd/api/rest/v1/paymentService
FLEXPAY_MOBILE_BASE_URL=https://backend.flexpay.cd

# Card payments. Set the full endpoint or the base URL.
FLEXPAY_CARD_PAYMENT_URL=https://cardpayment.flexpay.cd/v1.1/pay
FLEXPAY_CARD_BASE_URL=https://cardpayment.flexpay.cd
FLEXPAY_CARD_PAYMENT_PATH=v1.1/pay

# Transaction verification. If FLEXPAY_CHECK_TRANSACTION_URL has no
# {orderNumber} placeholder, the backend appends the order number.
FLEXPAY_CHECK_TRANSACTION_URL=https://apicheck.flexpaie.com/api/rest/v1/check/{orderNumber}
FLEXPAY_CHECK_BASE_URL=https://apicheck.flexpaie.com
FLEXPAY_REQUEST_TIMEOUT_MS=30000

# Public callback exposed by this backend.
FLEXPAY_CALLBACK_URL=
FLEXPAY_CALLBACK_BASE_URL=https://api.zwanga.cd/api/v1
FLEXPAY_SUBSCRIPTION_CALLBACK_URL=
FLEXPAY_BOOKING_CALLBACK_URL=
FLEXPAY_WALLET_CALLBACK_URL=
FLEXPAY_VERIFY_CALLBACKS=true

# Subscription amount charged in-app.
SUBSCRIPTION_PRO_PRICE=5000
SUBSCRIPTION_PRO_CURRENCY=CDF

# Trip booking payments.
TRIP_PAYMENT_CURRENCY=CDF

# Points wallet. 1 point = 100 CDF by default.
ZWANGA_POINTS_CURRENCY=PTS
ZWANGA_POINT_VALUE_CDF=100
# Base fixed at 1 token per completed ride, including cash (driver and passenger).
# The following bonus settings apply only to successfully paid points/electronic passenger rides.
ZWANGA_LOYALTY_POINTS_PER_KM=0.5
# 0.01 grants 1% of the completed trip price, converted back to points.
ZWANGA_LOYALTY_RATE=0.01

# Fallback card redirect URLs when the client does not send them.
FLEXPAY_CARD_APPROVE_URL=https://zwanga-app.com/subscriptions/payment/success
FLEXPAY_CARD_CANCEL_URL=https://zwanga-app.com/subscriptions/payment/cancel
FLEXPAY_CARD_DECLINE_URL=https://zwanga-app.com/subscriptions/payment/decline
```

Keep `FLEXPAY_VERIFY_CALLBACKS=true` in production. The FlexPay documents do not
define a webhook signature, so the backend verifies successful callbacks through
FlexPay's check endpoint before enabling Pro.
