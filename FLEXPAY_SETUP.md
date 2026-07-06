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

The booking amount is calculated by the backend from
`trip.pricePerSeat * booking.numberOfSeats`; the app does not send the amount.

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
FLEXPAY_VERIFY_CALLBACKS=true

# Subscription amount charged in-app.
SUBSCRIPTION_PRO_PRICE=5000
SUBSCRIPTION_PRO_CURRENCY=CDF

# Trip booking payments.
TRIP_PAYMENT_CURRENCY=CDF

# Fallback card redirect URLs when the client does not send them.
FLEXPAY_CARD_APPROVE_URL=https://zwanga-app.com/subscriptions/payment/success
FLEXPAY_CARD_CANCEL_URL=https://zwanga-app.com/subscriptions/payment/cancel
FLEXPAY_CARD_DECLINE_URL=https://zwanga-app.com/subscriptions/payment/decline
```

Keep `FLEXPAY_VERIFY_CALLBACKS=true` in production. The FlexPay documents do not
define a webhook signature, so the backend verifies successful callbacks through
FlexPay's check endpoint before enabling Pro.
