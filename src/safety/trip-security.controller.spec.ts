import { Test, TestingModule } from '@nestjs/testing';
import { TripSecurityController } from './trip-security.controller';
import { TripSecurityService } from './trip-security.service';

describe('TripSecurityController', () => {
  let controller: TripSecurityController;
  const service = {
    startTracking: jest.fn(),
    notifyTrustedContacts: jest.fn(),
    confirmParticipant: jest.fn(),
    updateParticipantConfiguration: jest.fn(),
    escalateParticipant: jest.fn(),
    cancelTracking: jest.fn(),
    getParticipant: jest.fn(),
    getParticipantHistory: jest.fn(),
    getTripParticipants: jest.fn(),
    getTripHistory: jest.fn(),
    processAutomaticFollowUps: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TripSecurityController],
      providers: [
        {
          provide: TripSecurityService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<TripSecurityController>(TripSecurityController);
    jest.clearAllMocks();
  });

  it('delegates start tracking request to service', async () => {
    service.startTracking.mockResolvedValue({ id: 'participant-1' });

    const result = await controller.startTracking(
      { user: { userId: 'driver-1' } },
      { tripId: 'trip-1' },
    );

    expect(service.startTracking).toHaveBeenCalledWith('driver-1', { tripId: 'trip-1' });
    expect(result).toEqual({ id: 'participant-1' });
  });

  it('delegates confirmation request to service', async () => {
    service.confirmParticipant.mockResolvedValue({ status: 'completed' });

    const result = await controller.confirmParticipant(
      { user: { userId: 'passenger-1' } },
      'participant-1',
      { outcome: 'dropped_off' as any },
    );

    expect(service.confirmParticipant).toHaveBeenCalledWith(
      'participant-1',
      'passenger-1',
      { outcome: 'dropped_off' },
    );
    expect(result).toEqual({ status: 'completed' });
  });

  it('returns trip history from service', async () => {
    service.getTripHistory.mockResolvedValue({ tripId: 'trip-42', events: [] });

    const result = await controller.getTripHistory(
      { user: { userId: 'driver-42' } },
      'trip-42',
    );

    expect(service.getTripHistory).toHaveBeenCalledWith('trip-42', 'driver-42');
    expect(result).toEqual({ tripId: 'trip-42', events: [] });
  });
});
