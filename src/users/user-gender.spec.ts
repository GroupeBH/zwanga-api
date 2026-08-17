import { validate } from 'class-validator';
import { AuthService } from '../auth/auth.service';
import { RegisterDto } from '../auth/dto/auth.dto';
import { UpdateProfileDto } from './dto/user.dto';
import { User, UserGender, UserRole, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';

describe('User gender', () => {
  describe('DTO validation', () => {
    it.each(Object.values(UserGender))(
      'accepts %s during registration',
      async (gender) => {
        const dto = Object.assign(new RegisterDto(), {
          phone: '+243900000000',
          pin: '1234',
          firstName: 'Jane',
          lastName: 'Doe',
          role: UserRole.PASSENGER,
          gender,
        });

        await expect(validate(dto)).resolves.toHaveLength(0);
      },
    );

    it('rejects an unsupported value during profile update', async () => {
      const dto = Object.assign(new UpdateProfileDto(), {
        gender: 'unsupported',
      });

      const errors = await validate(dto);

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'gender' }),
        ]),
      );
    });
  });

  it('persists the selected gender during registration', async () => {
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((payload: Partial<User>) => payload),
      save: jest.fn((payload: Partial<User>) =>
        Promise.resolve({ id: 'user-1', ...payload }),
      ),
    };
    const jwtService = {
      signAsync: jest
        .fn()
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token'),
    };
    const configService = {
      get: jest.fn((key: string) => `${key.toLowerCase()}-value`),
    };
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const service = new AuthService(
      userRepository as any,
      {} as any,
      jwtService as any,
      configService as any,
      {} as any,
      {} as any,
    );

    try {
      await service.register({
        phone: '+243900000000',
        pin: '1234',
        firstName: 'Jane',
        lastName: 'Doe',
        role: UserRole.PASSENGER,
        gender: UserGender.FEMALE,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(userRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ gender: UserGender.FEMALE }),
    );
  });

  it('updates the gender from the current user profile', async () => {
    const user = {
      id: 'user-1',
      firstName: 'Jane',
      lastName: 'Doe',
      gender: UserGender.FEMALE,
      profilePicture: null,
      role: UserRole.PASSENGER,
      status: UserStatus.ACTIVE,
      vehicles: [],
      kycDocuments: [],
    } as User;
    const userRepository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn((payload: User) => Promise.resolve(payload)),
    };
    const service = new UsersService(
      userRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.updateProfile('user-1', {
      gender: UserGender.PREFER_NOT_TO_SAY,
    });

    expect(userRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        gender: UserGender.PREFER_NOT_TO_SAY,
      }),
    );
    expect(result.gender).toBe(UserGender.PREFER_NOT_TO_SAY);
  });
});
