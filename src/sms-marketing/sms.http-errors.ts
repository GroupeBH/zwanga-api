import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/filters/api-exception.filter';

/** Translate validation/auth/throttle errors without echoing submitted data. */
@Catch(HttpException)
export class SmsHttpErrors extends ApiExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = exception.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'code' in response
    ) {
      super.catch(exception, host);
      return;
    }
    const status = exception.getStatus();
    const messages: Record<number, [string, string]> = {
      400: [
        'SMS_INVALID_INPUT',
        'Vérifiez les champs, dates et numéros saisis.',
      ],
      401: [
        'AUTHENTICATION_REQUIRED',
        'Reconnectez-vous pour accéder aux campagnes SMS.',
      ],
      403: ['SMS_FORBIDDEN', 'Vous ne disposez pas de cette autorisation.'],
      404: ['SMS_NOT_FOUND', 'Cette ressource SMS est introuvable.'],
      429: [
        'SMS_RATE_LIMITED',
        'Trop de demandes. Patientez avant de réessayer.',
      ],
    };
    const request = host.switchToHttp().getRequest<{ url?: string }>();
    if (
      status === 429 &&
      /\/campaigns\/[^/]+\/test(?:\?|$)/.test(request.url ?? '')
    )
      messages[429] = [
        'SMS_TEST_RATE_LIMITED',
        'Vous avez atteint cinq tests en une heure.',
      ];
    const translated = messages[status];
    super.catch(
      translated
        ? new HttpException(
            { code: translated[0], message: translated[1] },
            status,
          )
        : exception,
      host,
    );
  }
}
