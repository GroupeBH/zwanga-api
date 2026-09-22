import { NotificationStatus } from './entities/notification.entity';
import { NotificationService } from './notifications.service';
import { TripRequestStatus } from '../trip-requests/entities/trip-request.entity';

describe('NotificationService critical push reliability', () => {
  const buildService = () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const transactionalRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue(transactionalRepository),
    };
    const notificationRepository = {
      create: jest.fn((value: Record<string, unknown>) => ({
        id: 'notification-1',
        messageId: null,
        errorMessage: null,
        ...value,
      })),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(
          (work: (transactionManager: typeof manager) => Promise<unknown>) =>
            work(manager),
        ),
      },
    };
    const userRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const tripRequestRepository = {
      findOne: jest.fn(),
    };
    const configService = { get: jest.fn() };
    const service = new NotificationService(
      configService as any,
      notificationRepository as any,
      userRepository as any,
      tripRequestRepository as any,
    );

    return {
      service,
      notificationRepository,
      userRepository,
      tripRequestRepository,
      queryBuilder,
      transactionalRepository,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes an Expo token through Expo Push and persists the ticket', async () => {
    const { service, notificationRepository, userRepository } = buildService();
    userRepository.findOne.mockResolvedValue({
      id: 'driver-1',
      fcmToken: 'ExponentPushToken[expo-driver-token]',
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: { status: 'ok', id: 'expo-ticket-1' },
      }),
    } as unknown as Response);

    await expect(
      service.sendNotificationToUser(
        'driver-1',
        'Votre gain du trajet',
        '9 500 CDF disponibles',
        { type: 'driver_trip_revenue', amount: 9500 },
      ),
    ).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(notificationRepository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: NotificationStatus.SENT,
        messageId: 'expo-ticket:expo-ticket-1',
      }),
    );
  });

  it('keeps a financial notification for retry when no token is registered', async () => {
    const { service, notificationRepository, userRepository } = buildService();
    userRepository.findOne.mockResolvedValue({
      id: 'driver-1',
      fcmToken: null,
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      service.sendNotificationToUser(
        'driver-1',
        'Votre gain du trajet',
        '5 000 CDF a encaisser',
        { type: 'driver_trip_revenue' },
      ),
    ).resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notificationRepository.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: NotificationStatus.FAILED,
        errorMessage: 'Aucun token push actif pour cet utilisateur',
      }),
    );
  });

  it('clears an Expo token rejected as DeviceNotRegistered', async () => {
    const { service, userRepository } = buildService();
    const token = 'ExpoPushToken[expired-driver-token]';
    userRepository.findOne.mockResolvedValue({
      id: 'driver-1',
      fcmToken: token,
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: {
          status: 'error',
          message: 'Device is not registered',
          details: { error: 'DeviceNotRegistered' },
        },
      }),
    } as unknown as Response);

    await expect(
      service.sendNotificationToUser(
        'driver-1',
        'Votre gain du trajet',
        'Gain disponible',
        { type: 'driver_trip_revenue' },
      ),
    ).resolves.toBe(false);

    expect(userRepository.update).toHaveBeenCalledWith(
      { id: 'driver-1', fcmToken: token },
      { fcmToken: null },
    );
  });

  it('claims critical notifications with FOR UPDATE SKIP LOCKED', async () => {
    const { service, queryBuilder, transactionalRepository } = buildService();
    const failedNotification = {
      id: 'notification-failed',
      status: NotificationStatus.FAILED,
      errorMessage: 'temporary error',
    };
    queryBuilder.getMany.mockResolvedValue([failedNotification]);

    const claimed = await (
      service as unknown as {
        claimCriticalFinancialNotifications: () => Promise<unknown[]>;
      }
    ).claimCriticalFinancialNotifications();

    expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(queryBuilder.setOnLocked).toHaveBeenCalledWith('skip_locked');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "notification.data ->> 'type' IN (:...types)",
      {
        types: expect.arrayContaining(['trip_request_driver_overdue']),
      },
    );
    expect(transactionalRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        status: NotificationStatus.PENDING,
        errorMessage: 'CRITICAL_PUSH_RETRY_CLAIMED',
      }),
    ]);
    expect(claimed).toHaveLength(1);
  });

  it('does not retry an overdue pickup notification once the trip request expired', async () => {
    const {
      service,
      queryBuilder,
      notificationRepository,
      userRepository,
      tripRequestRepository,
    } = buildService();
    queryBuilder.getMany.mockResolvedValue([
      {
        id: 'notification-overdue',
        userId: 'passenger-1',
        fcmToken: '',
        data: {
          type: 'trip_request_driver_overdue',
          tripRequestId: 'request-expired',
        },
        status: NotificationStatus.FAILED,
        isActive: true,
        errorMessage: 'Aucun token push actif pour cet utilisateur',
      },
    ]);
    tripRequestRepository.findOne.mockResolvedValue({
      id: 'request-expired',
      passengerId: 'passenger-1',
      status: TripRequestStatus.EXPIRED,
      selectedDriverId: null,
      driverPickupOverdueNotifiedAt: null,
      departureDateMax: new Date(Date.now() - 60_000),
    });

    await service.retryCriticalFinancialNotifications();

    expect(userRepository.findOne).not.toHaveBeenCalled();
    expect(notificationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'notification-overdue',
        status: NotificationStatus.FAILED,
        isActive: false,
        messageId: null,
        errorMessage:
          'Notification critique obsolete: demande de trajet non recuperable',
      }),
    );
  });

  it('checks Expo receipts and clears a token rejected by APNs or FCM', async () => {
    const { service, queryBuilder, notificationRepository, userRepository } =
      buildService();
    const token = 'ExpoPushToken[expired-after-ticket]';
    queryBuilder.getMany.mockResolvedValue([
      {
        id: 'notification-receipt',
        userId: 'driver-1',
        fcmToken: token,
        status: NotificationStatus.SENT,
        messageId: 'expo-ticket:receipt-1',
        errorMessage: null,
      },
    ]);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: {
          'receipt-1': {
            status: 'error',
            message: 'Device is no longer registered',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      }),
    } as unknown as Response);

    await service.reconcileExpoPushReceipts();

    expect(userRepository.update).toHaveBeenCalledWith(
      { id: 'driver-1', fcmToken: token },
      { fcmToken: null },
    );
    expect(notificationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: NotificationStatus.FAILED,
        errorMessage: 'Device is no longer registered',
      }),
    );
  });
});

describe('NotificationService inbox scopes', () => {
  const buildService = () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getCount: jest.fn().mockResolvedValue(0),
    };
    const notificationRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new NotificationService(
      { get: jest.fn() } as any,
      notificationRepository as any,
      {} as any,
      {} as any,
    );

    return { service, queryBuilder };
  };

  const conditions = (queryBuilder: { andWhere: jest.Mock }) =>
    queryBuilder.andWhere.mock.calls.map((call) => String(call[0])).join(' | ');

  it('keeps every active notification when no scope is requested', async () => {
    const { service, queryBuilder } = buildService();

    await service.findAllByUser('admin-1');

    expect(conditions(queryBuilder)).not.toContain('routineTypes');
  });

  it('hides routine trip and conversation notifications for the back-office', async () => {
    const { service, queryBuilder } = buildService();

    await service.findAllByUser('admin-1', { scope: 'critical', limit: 20 });

    const applied = conditions(queryBuilder);
    expect(applied).toContain('routineTypes');
    expect(applied).toContain("data ->> 'conversationId' IS NULL");

    const routineTypes = queryBuilder.andWhere.mock.calls
      .map((call) => call[1] as { routineTypes?: string[] } | undefined)
      .find((parameters) => parameters?.routineTypes)?.routineTypes;
    expect(routineTypes).toContain('trip_request');
    expect(routineTypes).toContain('pickup_confirmed');
    expect(routineTypes).not.toContain('driver_trip_revenue');
  });

  it('counts unread notifications within the same scope', async () => {
    const { service, queryBuilder } = buildService();
    queryBuilder.getCount.mockResolvedValue(3);

    const result = await service.findAllByUser('admin-1', {
      scope: 'critical',
    });

    expect(result.unreadCount).toBe(3);
    expect(conditions(queryBuilder)).toContain('notification.isRead = false');
  });
});
