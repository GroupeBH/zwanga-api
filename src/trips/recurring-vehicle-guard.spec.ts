import { BadRequestException } from '@nestjs/common';
import { TripsService } from './trips.service';
import { RecurringTripTemplateStatus } from './entities/recurring-trip-template.entity';

describe('resuming a recurring trip after vehicle deactivation', () => {
  const template = {
    id: 'template-1',
    driverId: 'driver-1',
    vehicleId: 'vehicle-1',
    status: RecurringTripTemplateStatus.PAUSED,
  };

  function serviceWithVehicle(vehicle: { id: string } | null) {
    const vehicleRepository = {
      findOne: jest.fn().mockResolvedValue(vehicle),
    };
    const ownerRead = jest.fn().mockResolvedValue({ isActive: true, status: 'active' });
    const recurringTripTemplateRepository = { save: jest.fn(), manager: {} as any };
    recurringTripTemplateRepository.manager.transaction = (run: any) => run({
      findOne: ownerRead, getRepository: () => recurringTripTemplateRepository,
    });
    const generateTripsForTemplate = jest.fn().mockResolvedValue(0);
    const service = Object.assign(Object.create(TripsService.prototype), {
      findRecurringTemplateEntity: jest.fn().mockResolvedValue({ ...template }),
      vehicleRepository,
      recurringTripTemplateRepository,
      generateTripsForTemplate,
      findRecurringById: jest.fn().mockResolvedValue({ id: template.id }),
    }) as TripsService;
    return {
      service,
      vehicleRepository,
      recurringTripTemplateRepository,
      generateTripsForTemplate,
      ownerRead,
    };
  }

  it('does not reactivate a template whose vehicle is inactive', async () => {
    const {
      service,
      vehicleRepository,
      recurringTripTemplateRepository,
      generateTripsForTemplate,
    } = serviceWithVehicle(null);

    await expect(
      service.resumeRecurring('template-1', 'driver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(vehicleRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'vehicle-1', ownerId: 'driver-1', isActive: true },
    });
    expect(recurringTripTemplateRepository.save).not.toHaveBeenCalled();
    expect(generateTripsForTemplate).not.toHaveBeenCalled();
  });

  it('allows a paused template to resume with an active owned vehicle', async () => {
    const {
      service,
      recurringTripTemplateRepository,
      generateTripsForTemplate,
    } = serviceWithVehicle({ id: 'vehicle-1' });

    await expect(
      service.resumeRecurring('template-1', 'driver-1'),
    ).resolves.toEqual({
      id: 'template-1',
    });
    expect(recurringTripTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: RecurringTripTemplateStatus.ACTIVE }),
    );
    expect(generateTripsForTemplate).toHaveBeenCalled();
  });

  it('cannot resume after the owner was disabled while the request was in flight', async () => {
    const ctx = serviceWithVehicle({ id: 'vehicle-1' });
    ctx.ownerRead.mockResolvedValue({ isActive: false, status: 'suspended' });
    await expect(ctx.service.resumeRecurring('template-1', 'driver-1')).rejects.toMatchObject({
      response: { code: 'ACCOUNT_UNAVAILABLE' },
    });
    expect(ctx.recurringTripTemplateRepository.save).not.toHaveBeenCalled();
    expect(ctx.generateTripsForTemplate).not.toHaveBeenCalled();
  });
});
