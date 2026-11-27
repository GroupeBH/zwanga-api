import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isSmsPrivateRequest } from './sms.trace-privacy';
const { minimalEnvironment } = createRequire(__filename)(
  '../../test/load/isolation.cjs',
);

describe('SMS incoming tracing privacy', () => {
  it.each([
    '/api/v1/admin/sms-marketing/opt-outs?search=secret',
    '/sms/s/Ab3dE9xK',
    '/api/v1/%73ms/s/Ab3dE9xK',
    '/admin/sms-marketing',
  ])('classifies %s', (path) => {
    expect(isSmsPrivateRequest(path)).toBe(true);
  });
  it.each(['/trips', '/admin/users', '/sms/similar', undefined])(
    'preserves non-SMS route %s',
    (path) => {
      expect(isSmsPrivateRequest(path)).toBe(false);
    },
  );
  it('protects real inbound HTTP instrumentation from the production ADOT preloader', async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        resolve(
          __dirname,
          '../../test/fixtures/sms-marketing-incoming-tracing.cjs',
        ),
      ],
      {
        cwd: resolve(__dirname, '../..'),
        windowsHide: true,
        timeout: 45000,
        env: minimalEnvironment({
          NODE_ENV: 'test',
          AWS_EC2_METADATA_DISABLED: 'true',
          OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'http',
          OTEL_NODE_RESOURCE_DETECTORS: 'none',
          OTEL_TRACES_EXPORTER: 'none',
          OTEL_LOGS_EXPORTER: 'none',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_TRACES_SAMPLER: 'always_on',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
          OTEL_AWS_SERVICE_EVENTS_ENABLED: 'false',
          OTEL_LOG_LEVEL: 'none',
        }),
      },
    );
    expect(stdout + stderr).not.toMatch(/243900000001|Ab3dE9xK/);
    expect(JSON.parse(stdout.trim())).toEqual({
      protectedRequests: 4,
      sensitiveSpans: 0,
      otherRoutesTraced: true,
    });
  }, 50000);
});
