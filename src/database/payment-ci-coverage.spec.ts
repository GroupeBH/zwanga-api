import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) =>
  readFileSync(resolve(__dirname, '../..', file), 'utf8');
const binVariable = 'MIXED_CASH_TEST_POSTGRES_BIN';

describe('Payment integration tests are enabled before deployment', () => {
  it.each([
    'src/bookings/mixed-cash-payment-postgres.spec.ts',
    'src/bookings/token-cash-fallback-postgres.spec.ts',
    'src/notifications/driver-payment-postgres.spec.ts',
  ])('%s uses the PostgreSQL gate supplied by CI', (file) => {
    expect(read(file)).toContain(`process.env.${binVariable}`);
  });

  it('socket/REST tests do not require the sibling mobile checkout', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['socket.io-client']).toBe('4.8.3');
    const receiptTest = read(
      'src/notifications/driver-payment-postgres.spec.ts',
    );
    expect(receiptTest).toContain("require('socket.io-client')");
    expect(receiptTest).toContain('() => verifySocketAndRest()');
    expect(receiptTest).toContain('(mobileRoot ? it : it.skip)');
    expect(receiptTest).not.toContain('Set RIDE_AUDIT_MOBILE_ROOT');
  });

  it('production supplies disposable PostgreSQL to all three payment suites', () => {
    const workflow = read('.github/workflows/deploy.yml');
    const setup = workflow.slice(
      workflow.indexOf(
        '- name: Enable disposable PostgreSQL integration tests',
      ),
      workflow.indexOf('- name: Run tests'),
    );
    const suites = setup.match(/for suite in ([A-Z_ ]+); do/)?.[1].split(/\s+/);
    expect(suites).toContain('MIXED_CASH');
    expect(setup).toContain('postgresql-16 postgresql-16-postgis-3');
    expect(setup).toContain(
      '${suite}_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin',
    );
    expect(setup).toContain('>> "${GITHUB_ENV}"');
    expect(workflow).toContain('npm run test -- --runInBand');
  });

  it('staging deploy/bootstrap run the same payment tests before any AWS action', () => {
    const workflow = read('.github/workflows/deploy-staging.yml');
    const setupIndex = workflow.indexOf(
      '- name: Enable disposable PostgreSQL payment tests',
    );
    const testsIndex = workflow.indexOf('- name: Test and compile backend');
    const awsIndex = workflow.indexOf(
      '- uses: aws-actions/configure-aws-credentials',
    );
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(testsIndex).toBeGreaterThan(setupIndex);
    expect(awsIndex).toBeGreaterThan(testsIndex);
    const setup = workflow.slice(setupIndex, testsIndex);
    expect(setup).toContain(
      "if: inputs.action == 'deploy' || inputs.action == 'bootstrap'",
    );
    expect(setup).toContain('postgresql-16 postgresql-16-postgis-3');
    expect(setup).toContain(`${binVariable}=/usr/lib/postgresql/16/bin`);
    expect(setup).toContain('>> "${GITHUB_ENV}"');
    expect(workflow.slice(testsIndex, awsIndex)).toContain(
      'npm run test -- --runInBand',
    );
  });
});
