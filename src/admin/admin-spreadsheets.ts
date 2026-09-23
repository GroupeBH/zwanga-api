import {
  buildSpreadsheet,
  datedFilename,
  spreadsheetAttachment,
  type SpreadsheetFile,
} from './spreadsheet';

type NamedPerson = {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
} | null;

const personName = (user?: NamedPerson) =>
  `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();

const yesNo = (value: boolean | null | undefined) => (value ? 'Oui' : 'Non');

export const buildTripsSpreadsheet = (
  trips: Array<{
    id: string;
    departureLocation?: string | null;
    arrivalLocation?: string | null;
    departureDate?: Date | string | null;
    availableSeats?: number | null;
    totalSeats?: number | null;
    pricePerSeat?: number | string | null;
    isFree?: boolean | null;
    isPrivate?: boolean | null;
    status?: string | null;
    createdAt?: Date | string | null;
    driver?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('trajets-zwanga'),
    buildSpreadsheet(
      'Trajets',
      [
        'ID',
        'Conducteur',
        'Téléphone',
        'Départ',
        'Arrivée',
        'Date de départ',
        'Places restantes',
        'Places totales',
        'Prix/place',
        'Gratuit',
        'Privé',
        'Statut',
        'Publié le',
      ],
      trips.map((trip) => [
        trip.id,
        personName(trip.driver),
        trip.driver?.phone ?? '',
        trip.departureLocation ?? '',
        trip.arrivalLocation ?? '',
        trip.departureDate,
        trip.availableSeats ?? '',
        trip.totalSeats ?? '',
        trip.isFree ? 'Gratuit' : Number(trip.pricePerSeat ?? 0),
        yesNo(Boolean(trip.isFree)),
        yesNo(Boolean(trip.isPrivate)),
        trip.status ?? '',
        trip.createdAt,
      ]),
    ),
  );

export const buildTripRequestsSpreadsheet = (
  requests: Array<{
    id: string;
    departureLocation?: string | null;
    arrivalLocation?: string | null;
    departureDateMin?: Date | string | null;
    departureDateMax?: Date | string | null;
    numberOfSeats?: number | null;
    maxPricePerSeat?: number | string | null;
    paymentMode?: string | null;
    status?: string | null;
    createdAt?: Date | string | null;
    passenger?: NamedPerson;
    driverOffersCount?: number | null;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('demandes-trajets-zwanga'),
    buildSpreadsheet(
      'Demandes',
      [
        'ID',
        'Passager',
        'Téléphone',
        'Départ',
        'Arrivée',
        'Départ min',
        'Départ max',
        'Places',
        'Prix max/place',
        'Paiement',
        'Offres',
        'Statut',
        'Créée le',
      ],
      requests.map((request) => [
        request.id,
        personName(request.passenger),
        request.passenger?.phone ?? '',
        request.departureLocation ?? '',
        request.arrivalLocation ?? '',
        request.departureDateMin,
        request.departureDateMax,
        request.numberOfSeats ?? '',
        request.maxPricePerSeat ?? '',
        request.paymentMode ?? '',
        request.driverOffersCount ?? 0,
        request.status ?? '',
        request.createdAt,
      ]),
    ),
  );

export const buildBookingsSpreadsheet = (
  bookings: Array<{
    id: string;
    numberOfSeats?: number | null;
    status?: string | null;
    paymentStatus?: string | null;
    paymentAmount?: number | string | null;
    paymentCurrency?: string | null;
    createdAt?: Date | string | null;
    passenger?: NamedPerson;
    trip?: {
      departureLocation?: string | null;
      arrivalLocation?: string | null;
      departureDate?: Date | string | null;
      driver?: NamedPerson;
    } | null;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('reservations-zwanga'),
    buildSpreadsheet(
      'Réservations',
      [
        'ID',
        'Passager',
        'Téléphone',
        'Trajet',
        'Date de départ',
        'Conducteur',
        'Places',
        'Paiement',
        'Montant',
        'Devise',
        'Statut',
        'Réservée le',
      ],
      bookings.map((booking) => [
        booking.id,
        personName(booking.passenger),
        booking.passenger?.phone ?? '',
        booking.trip
          ? `${booking.trip.departureLocation ?? ''} -> ${booking.trip.arrivalLocation ?? ''}`
          : '',
        booking.trip?.departureDate,
        personName(booking.trip?.driver),
        booking.numberOfSeats ?? '',
        booking.paymentStatus ?? '',
        booking.paymentAmount ?? '',
        booking.paymentCurrency ?? '',
        booking.status ?? '',
        booking.createdAt,
      ]),
    ),
  );

export const buildPaymentsSpreadsheet = (
  payments: Array<{
    id: string;
    reference?: string | null;
    orderNumber?: string | null;
    purpose?: string | null;
    method?: string | null;
    amount?: number | string | null;
    currency?: string | null;
    status?: string | null;
    phone?: string | null;
    paidAt?: Date | string | null;
    createdAt?: Date | string | null;
    user?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('paiements-zwanga'),
    buildSpreadsheet(
      'Paiements',
      [
        'ID',
        'Référence',
        'Commande',
        'Utilisateur',
        'Téléphone',
        'Objet',
        'Méthode',
        'Montant',
        'Devise',
        'Statut',
        'Créé le',
        'Payé le',
      ],
      payments.map((payment) => [
        payment.id,
        payment.reference ?? '',
        payment.orderNumber ?? '',
        personName(payment.user),
        payment.user?.phone ?? payment.phone ?? '',
        payment.purpose ?? '',
        payment.method ?? '',
        payment.amount ?? '',
        payment.currency ?? '',
        payment.status ?? '',
        payment.createdAt,
        payment.paidAt,
      ]),
    ),
  );

export const buildWalletAccountsSpreadsheet = (
  accounts: Array<{
    id: string;
    userId: string;
    balance?: number | string | null;
    currency?: string | null;
    updatedAt?: Date | string | null;
    createdAt?: Date | string | null;
    user?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('jetons-soldes-zwanga'),
    buildSpreadsheet(
      'Soldes',
      [
        'ID compte',
        'Utilisateur',
        'Téléphone',
        'Email',
        'Solde',
        'Devise',
        'Mis à jour le',
        'Créé le',
      ],
      accounts.map((account) => [
        account.id,
        personName(account.user) || account.userId,
        account.user?.phone ?? '',
        account.user?.email ?? '',
        account.balance ?? 0,
        account.currency ?? 'PTS',
        account.updatedAt,
        account.createdAt,
      ]),
    ),
  );

export const buildWalletLedgerSpreadsheet = (
  entries: Array<{
    id: string;
    userId: string;
    type?: string | null;
    amount?: number | string | null;
    balanceAfter?: number | string | null;
    currency?: string | null;
    relatedEntityType?: string | null;
    relatedEntityId?: string | null;
    description?: string | null;
    createdAt?: Date | string | null;
    user?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('jetons-registre-zwanga'),
    buildSpreadsheet(
      'Registre',
      [
        'ID',
        'Date',
        'Utilisateur',
        'Téléphone',
        'Type',
        'Mouvement',
        'Solde après',
        'Devise',
        'Source',
        'Référence source',
        'Description',
      ],
      entries.map((entry) => [
        entry.id,
        entry.createdAt,
        personName(entry.user) || entry.userId,
        entry.user?.phone ?? '',
        entry.type ?? '',
        entry.amount ?? 0,
        entry.balanceAfter ?? '',
        entry.currency ?? 'PTS',
        entry.relatedEntityType ?? '',
        entry.relatedEntityId ?? '',
        entry.description ?? '',
      ]),
    ),
  );

export const buildReferralAccountsSpreadsheet = (
  accounts: Array<{
    id: string;
    userId: string;
    directReferralsCount?: number | null;
    pendingTokens?: number | string | null;
    availableTokens?: number | string | null;
    reservedTokens?: number | string | null;
    withdrawnTokens?: number | string | null;
    currency?: string | null;
    profile?: { code?: string | null; attributionProvider?: string | null } | null;
    user?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('parrainage-comptes-zwanga'),
    buildSpreadsheet(
      'Parrains',
      [
        'ID',
        'Parrain',
        'Téléphone',
        'Code',
        'Attribution',
        'Filleuls',
        'En retenue',
        'Disponible',
        'Réservé',
        'Retiré',
        'Devise',
      ],
      accounts.map((account) => [
        account.id,
        personName(account.user) || account.userId,
        account.user?.phone ?? '',
        account.profile?.code ?? '',
        account.profile?.attributionProvider ?? '',
        account.directReferralsCount ?? 0,
        account.pendingTokens ?? 0,
        account.availableTokens ?? 0,
        account.reservedTokens ?? 0,
        account.withdrawnTokens ?? 0,
        account.currency ?? 'PTS',
      ]),
    ),
  );

export const buildReferralRewardsSpreadsheet = (
  rewards: Array<{
    id: string;
    createdAt?: Date | string | null;
    sourceType?: string | null;
    grossAmount?: number | string | null;
    sourceCurrency?: string | null;
    rate?: number | string | null;
    rewardTokens?: number | string | null;
    status?: string | null;
    holdUntil?: Date | string | null;
    referrerUser?: NamedPerson;
    referredUser?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('parrainage-commissions-zwanga'),
    buildSpreadsheet(
      'Commissions',
      [
        'ID',
        'Date',
        'Parrain',
        'Filleul',
        'Source',
        'Montant brut',
        'Devise',
        'Taux',
        'Jetons',
        'Statut',
        'Libération',
      ],
      rewards.map((reward) => [
        reward.id,
        reward.createdAt,
        personName(reward.referrerUser),
        personName(reward.referredUser),
        reward.sourceType ?? '',
        reward.grossAmount ?? '',
        reward.sourceCurrency ?? '',
        reward.rate ?? '',
        reward.rewardTokens ?? '',
        reward.status ?? '',
        reward.holdUntil,
      ]),
    ),
  );

export const buildReferralWithdrawalsSpreadsheet = (
  withdrawals: Array<{
    id: string;
    requestedAt?: Date | string | null;
    tokens?: number | string | null;
    amount?: number | string | null;
    currency?: string | null;
    phone?: string | null;
    status?: string | null;
    paymentTransactionId?: string | null;
    failureReason?: string | null;
    user?: NamedPerson;
  }>,
): SpreadsheetFile =>
  spreadsheetAttachment(
    datedFilename('parrainage-retraits-zwanga'),
    buildSpreadsheet(
      'Retraits',
      [
        'ID',
        'Demandé le',
        'Utilisateur',
        'Téléphone',
        'Jetons',
        'Montant',
        'Devise',
        'Statut',
        'Transaction',
        'Motif échec',
      ],
      withdrawals.map((withdrawal) => [
        withdrawal.id,
        withdrawal.requestedAt,
        personName(withdrawal.user),
        withdrawal.phone ?? withdrawal.user?.phone ?? '',
        withdrawal.tokens ?? '',
        withdrawal.amount ?? '',
        withdrawal.currency ?? '',
        withdrawal.status ?? '',
        withdrawal.paymentTransactionId ?? '',
        withdrawal.failureReason ?? '',
      ]),
    ),
  );
