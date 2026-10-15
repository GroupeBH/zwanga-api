import { Controller, INestApplication, Logger, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FileInterceptor } from '@nestjs/platform-express';
import { request as httpRequest, ClientRequest } from 'node:http';
import { IMAGE_UPLOAD_OPTIONS } from '../image-upload-policy';
import { ApiExceptionFilter } from '../filters/api-exception.filter';
import { LoggingInterceptor } from './logging.interceptor';

const updateProfile = jest.fn();
@Controller()
class UploadProbe {
  @Put('profile')
  @UseInterceptors(FileInterceptor('profilePicture', IMAGE_UPLOAD_OPTIONS))
  upload(@UploadedFile() file?: Express.Multer.File) {
    updateProfile(file);
    return { ok: true };
  }
}

describe('real HTTP multipart disconnect (no database or external service)', () => {
  let app: INestApplication;
  let client: ClientRequest | undefined;

  afterEach(async () => {
    client?.destroy();
    await app?.close();
    jest.restoreAllMocks();
    updateProfile.mockClear();
  });

  it('never calls the profile handler for a partial body, then still accepts a complete upload', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ controllers: [UploadProbe] }).compile();
    app = module.createNestApplication({ logger: false });
    const filter = new ApiExceptionFilter();
    const originalCatch = filter.catch.bind(filter);
    let receivedError: unknown;
    let finishAbort!: () => void;
    const aborted = new Promise<void>(resolve => { finishAbort = resolve; });
    jest.spyOn(filter, 'catch').mockImplementation((error, host) => {
      receivedError = error;
      originalCatch(error, host);
      finishAbort();
    });
    app.useGlobalInterceptors(new LoggingInterceptor());
    app.useGlobalFilters(filter);
    app.use((req, _res, next) => {
      if (req.headers['x-synthetic-abort']) req.once('data', () => setImmediate(() => client?.destroy()));
      next();
    });
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/profile`;
    const prefix = '--test-boundary\r\nContent-Disposition: form-data; name="profilePicture"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
    client = httpRequest(url, { method: 'PUT', headers: {
      'content-type': 'multipart/form-data; boundary=test-boundary',
      'content-length': '2000', 'x-synthetic-abort': 'true',
    } });
    client.on('error', () => undefined); // Expected peer closure, not an unhandled event.
    client.write(`${prefix}partial`);
    await aborted;
    expect(receivedError).toBeInstanceOf(Error);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);

    const completed = await fetch(url, { method: 'PUT', headers: {
      'content-type': 'multipart/form-data; boundary=test-boundary',
    }, body: `${prefix}synthetic-image-bytes\r\n--test-boundary--\r\n` });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ ok: true });
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile.mock.calls[0][0].buffer.toString()).toBe('synthetic-image-bytes');
  }, 10_000);
});
