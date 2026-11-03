import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const { minimalEnvironment } = createRequire(__filename)(
  '../../test/load/isolation.cjs',
) as {
  minimalEnvironment: (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

describe('Mobishastra OTP tracing confidentiality', () => {
  it('suppresses actual HTTP spans on success and failure without disabling other traces', async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve(__dirname, '../../test/fixtures/mobishastra-tracing.cjs')],
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
      /synthetic-password|12345|243900000000/,
    );
  }, 50000);
});
