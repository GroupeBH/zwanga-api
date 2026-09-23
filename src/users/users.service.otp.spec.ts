import { PhoneVerificationContext } from './dto/user.dto';
import { UsersService } from './users.service';
import { OTP_SMS_MESSAGES } from '../keccel-otp/otp-messages';

describe('UsersService OTP messages', () => {
  it.each([
    PhoneVerificationContext.REGISTRATION,
    PhoneVerificationContext.LOGIN,
    PhoneVerificationContext.UPDATE,
  ])(
    'uses the SMS-safe template for %s and preserves accents in the app response',
    async (context) => {
      const sendOtp = jest.fn().mockResolvedValue({ success: true });
      const service = {
        logger: { log: jest.fn(), warn: jest.fn() },
        userRepository: {
          findOne: jest
            .fn()
            .mockResolvedValue(
              context === PhoneVerificationContext.REGISTRATION
                ? null
                : { id: 'user-1' },
            ),
        },
        keccelOtpService: { sendOtp },
      } as unknown as UsersService;

      const result: unknown =
        await UsersService.prototype.sendPhoneVerificationOtp.call(service, {
          phone: '+243891234567',
          context,
        });

      expect(sendOtp).toHaveBeenCalledWith(
        '+243891234567',
        OTP_SMS_MESSAGES.verification,
      );
      expect(result).toEqual({
        message: 'Code de vérification envoyé avec succès',
      });
    },
  );
});
