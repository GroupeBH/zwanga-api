import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const { minimalEnvironment } = createRequire(__filename)(
  '../../test/load/isolation.cjs',
);
describe('SMS marketing transport, TLS CONNECT and actual tracing', () => {
  it('uses only simulated endpoints, produces no sensitive traces, measures paced delivery', async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve(__dirname, '../../test/fixtures/sms-marketing-transport.cjs')],
      {
        cwd: resolve(__dirname, '../..'),
        windowsHide: true,
        timeout: 45000,
        env: minimalEnvironment({
          NODE_ENV: 'test',
          AWS_EC2_METADATA_DISABLED: 'true',
        }),
      },
    );
    expect(stdout + stderr).not.toMatch(
      /synthetic-password|243900000001|Synthetic promotion/,
    );
    const result = JSON.parse(stdout.trim());
    expect(result.simulatedSubmissions).toBe(6);
    expect(result.sensitiveSpans).toBe(0);
    expect(result.pacedRatePerSecond).toBeLessThanOrEqual(2.05);
    console.info('SMS loopback benchmark (simulated, not production)', result);
  }, 50000);
});
