import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { DiditOtpService } from './didit-otp.service';

describe('DiditOtpService', () => {
  const phone = '+243891234567';
  const requestId = 'e39cb057-92fc-4b59-b84e-02fec29a0f24';
  const vendorData = '91c0fd8e-62a9-47c4-a1ba-e2d847fb20d8';
  let config: Record<string, string>;
  let http: { post: jest.Mock<unknown, [string, unknown, unknown]> };
  let service: DiditOtpService;

  beforeEach(() => {
    config = { DIDIT_API_KEY: 'test-key' };
    http = {
      post: jest.fn<unknown, [string, unknown, unknown]>().mockReturnValue(
        of({
          data: {
            request_id: requestId,
            status: 'Success',
            vendor_data: vendorData,
          },
        }),
      ),
    };
    service = new DiditOtpService(
      http as unknown as HttpService,
      {
        get: jest.fn((key: string) => config[key]),
      } as unknown as ConfigService,
    );
  });

  it('prefers WhatsApp with Didit SMS fallback and a five-digit French code', async () => {
    expect(
      await service.sendCode(phone, 'phone_verification', vendorData),
    ).toEqual({ requestId, status: 'Success' });
    expect(http.post.mock.calls[0][0]).toBe(
      'https://verification.didit.me/v3/phone/send/',
    );
    expect(http.post.mock.calls[0][1]).toEqual({
      phone_number: phone,
      options: { code_size: 5, preferred_channel: 'whatsapp', locale: 'fr' },
      vendor_data: vendorData,
    });
    expect(http.post.mock.calls[0][2]).toEqual({
      headers: {
        'x-api-key': 'test-key',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
      maxRedirects: 0,
    });
  });

  it('uses six digits for PIN reset and accepts a matching retry', async () => {
    http.post.mockReturnValueOnce(
      of({
        data: {
          request_id: requestId,
          status: 'Retry',
          vendor_data: vendorData,
        },
      }),
    );
    expect(await service.sendCode(phone, 'pin_reset', vendorData)).toEqual({
      requestId,
      status: 'Retry',
    });
    expect(http.post.mock.calls[0][1]).toMatchObject({
      options: { code_size: 6 },
    });
  });

  it('can explicitly request SMS and rejects an unsupported channel', async () => {
    config.DIDIT_OTP_CHANNEL = 'sms';
    await service.sendCode(phone, 'phone_verification', vendorData);
    expect(http.post.mock.calls[0][1]).toMatchObject({
      options: { preferred_channel: 'sms' },
    });
    config.DIDIT_OTP_CHANNEL = 'email';
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('requires the correct status, challenge id, vendor data and phone on verification', async () => {
    http.post.mockReturnValueOnce(
      of({
        data: {
          status: 'Approved',
          request_id: requestId,
          vendor_data: vendorData,
          phone: { full_number: phone },
        },
      }),
    );
    expect(
      await service.verifyCode(phone, '12345', requestId, vendorData),
    ).toBe(true);
    expect(http.post).toHaveBeenCalledWith(
      'https://verification.didit.me/v3/phone/check/',
      { phone_number: phone, code: '12345' },
      expect.any(Object),
    );

    for (const data of [
      { status: 'Failed' },
      { status: 'Declined', request_id: requestId },
      { status: 'Expired or Not Found' },
      {
        status: 'Approved',
        request_id: 'another-id',
        vendor_data: vendorData,
        phone: { full_number: phone },
      },
      {
        status: 'Approved',
        request_id: requestId,
        vendor_data: 'other',
        phone: { full_number: phone },
      },
      {
        status: 'Approved',
        request_id: requestId,
        vendor_data: vendorData,
        phone: { full_number: '+243899999999' },
      },
    ]) {
      http.post.mockReturnValueOnce(of({ data }));
      expect(
        await service.verifyCode(phone, '12345', requestId, vendorData),
      ).toBe(false);
    }
  });

  it('refuses blocked sends, mismatched retries and malformed replies', async () => {
    http.post.mockReturnValueOnce(of({ data: { status: 'Blocked' } }));
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toMatchObject({ status: 429 });
    http.post.mockReturnValueOnce(
      of({
        data: { request_id: requestId, status: 'Retry', vendor_data: 'other' },
      }),
    );
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toBeInstanceOf(BadGatewayException);
    http.post.mockReturnValueOnce(of({ data: { status: 'Unexpected' } }));
    await expect(
      service.verifyCode(phone, '12345', requestId, vendorData),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('requires a key and hides provider errors from callers', async () => {
    delete config.DIDIT_API_KEY;
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(http.post).not.toHaveBeenCalled();
    config.DIDIT_OTP_API_KEY = 'dedicated-key';
    http.post.mockReturnValueOnce(throwError(() => new Error('network error')));
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns client and rate-limit errors without leaking provider details', async () => {
    http.post.mockReturnValueOnce(
      throwError(() => ({ isAxiosError: true, response: { status: 400 } })),
    );
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toMatchObject({ status: 400 });
    http.post.mockReturnValueOnce(
      throwError(() => ({ isAxiosError: true, response: { status: 429 } })),
    );
    await expect(
      service.sendCode(phone, 'phone_verification', vendorData),
    ).rejects.toMatchObject({ status: 429 });
  });
});
