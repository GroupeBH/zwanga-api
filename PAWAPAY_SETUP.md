# PawaPay alongside FlexPay

FlexPay stays the primary provider. PawaPay supports DRC Mobile Money. Card payments stay on FlexPay. Automatic fallback is allowed only after a proven pre-processing rejection or missing configuration detected before sending, never after an ambiguous outage.

Set `PAWAPAY_API_TOKEN` before PawaPay is used. Without that token, only FlexPay is offered.

## Callback URLs to save in the PawaPay dashboard

Use the public API base, for example `https://api.zwanga.cd/api/v1`:

- Deposits: `https://api.zwanga.cd/api/v1/payments/pawapay/deposits/callback`
- Payouts: `https://api.zwanga.cd/api/v1/payments/pawapay/payouts/callback`

Do not configure refunds: there is no local accounting workflow for PawaPay refunds. The route explicitly rejects them and the capabilities endpoint returns no usable refund callback URL.

The routes are public, but callback contents are never financial proof. Each callback triggers an authenticated status read using the stored operation ID. Provider, operation type, ID, amount and currency must match. HTTP 200 is returned only after successful verification and business settlement. Errors propagate to allow retry. Existing ledger idempotency guards are preserved; concurrent end-to-end validation in PostgreSQL is still required.

Consult the [official callback documentation](https://docs.pawapay.io/v2/docs/what_to_know) for current network requirements and retry behaviour. Cryptographic callback signature validation is not implemented; authenticated server-side status verification is mandatory and cannot be disabled. `PAWAPAY_VERIFY_CALLBACKS` is obsolete and removed from environment examples.

Customer return pages, used after a redirect flow:

- Success: `https://zwanga-app.com/payments/return/success`
- Failed: `https://zwanga-app.com/payments/return/failed`

Authenticated clients can read the active URLs from `GET /api/v1/payments/providers`.

## Behaviour

1. A Mobile Money payment tries the preferred provider, otherwise FlexPay. Only proven safe failures allow switching provider.
2. Timeouts, connection resets, HTTP 5xx and malformed acknowledgements stay pending. The saved UUID is reused for checks, not replayed at another provider.
3. Final status comes from authenticated provider status reads. `NOT_FOUND` is not evidence of failure. A final callback not yet confirmed by the read must be retried.
4. Booking, subscription, wallet top-up and payout records are updated from verified evidence. Failed business settlement is retried on subsequent status checks, including locally terminal payments.
5. Exact amounts are preserved. Airtel/Orange allow fractional CDF; fractional Vodacom CDF is rejected before POST, never silently rounded. Current routing is limited to supported DRC operators and CDF/USD.
6. Short database locks protect status updates against stale responses. A contradictory success after final failure/cancellation requires manual reconciliation, not automatic release or credit of funds.

## Before production

- Verify the existing registered migration `1780000042000-AddPawapayPaymentProvider` before enabling the provider. This review did not run it.
- Configure API access, public HTTPS callback URLs and enabled providers through your secrets/configuration management. No key belongs in the mobile application.
- Check account permissions, supported operators, currencies and limits in the merchant dashboard. Dynamic provider prediction/configuration is not implemented yet.
- Run sandbox deposit, subscription, top-up and payout flows; test operator refusal, lost POST response, repeated callbacks, restart recovery and exactly one ledger credit per payment.
- Automated tests use HTTP/ORM doubles. No live transaction, sandbox transaction, real PostgreSQL concurrency test or native device test was performed during the review.
- Full change report: `zwanga/docs/PAWAPAY_REVIEW.md` in the neighbouring mobile repository.
