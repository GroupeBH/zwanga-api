import { PaymentMethod, PaymentStatus } from './entities/payment-transaction.entity';
import { PaymentsService } from './payments.service';

describe('Messages de paiement en français', () => {
  // Pure presentation checks: no database, HTTP call or real payment.
  const service = new PaymentsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { register() {}, async apply() {} } as never,
  );

  it.each([
    ['Transaction envoyee avec succes. Push', 'Demande de paiement envoyée. Veuillez valider sur votre téléphone'],
    ['Transaction envoyée avec succès. Push', 'Demande de paiement envoyée. Veuillez valider sur votre téléphone'],
    ['Declined by the operator', 'Paiement refusé par l’opérateur. Aucun montant confirmé.'],
    ['Refuse par l operateur', 'Paiement refusé par l’opérateur. Aucun montant confirmé.'],
    ['Refusé par l’opérateur', 'Paiement refusé par l’opérateur. Aucun montant confirmé.'],
    ['Operation annulee par le client', 'Paiement annulé. Aucun montant confirmé.'],
    ['Opération annulée par le client', 'Paiement annulé. Aucun montant confirmé.'],
    ['Insufficient balance', 'Paiement échoué : solde insuffisant.'],
  ])('traduit le message prestataire %s', (providerMessage, expected) => {
    expect(service.getClientPaymentMessage({
      status: PaymentStatus.PENDING,
      method: PaymentMethod.MOBILE_MONEY,
      paymentUrl: null,
      providerMessage,
    })).toBe(expected);
  });

  it('ne transforme pas une attente en confirmation de paiement', () => {
    expect(service.getClientPaymentMessage({
      status: PaymentStatus.PENDING,
      method: PaymentMethod.MOBILE_MONEY,
      paymentUrl: null,
      providerMessage: null,
    })).toBe('Paiement en attente de confirmation');
  });

  it('annonce en français une confirmation acquise', () => {
    expect(service.getClientPaymentMessage({
      status: PaymentStatus.SUCCEEDED,
      method: PaymentMethod.MOBILE_MONEY,
      paymentUrl: null,
      providerMessage: null,
    })).toBe('Paiement confirmé avec succès');
  });
});
