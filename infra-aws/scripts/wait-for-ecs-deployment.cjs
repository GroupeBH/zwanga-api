const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');

const execFileAsync = promisify(execFile);

/** services-stable checks task counts, but does not wait for rolloutState. */
async function waitForDeployment({
  expectedDeployment,
  describeServices,
  pause = sleep,
  log = console.log,
  attempts = 13,
  intervalMs = 10_000,
}) {
  if (typeof expectedDeployment !== 'string' || expectedDeployment.trim() !== expectedDeployment ||
      !/^ecs-svc\/\d+$/.test(expectedDeployment)) {
    throw new Error('A valid expected ECS deployment ID is required');
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await describeServices();
    if (response.failures?.length || response.services?.length !== 1) {
      throw new Error('ECS did not return the requested service successfully');
    }
    const service = response.services[0];
    const deployments = service.deployments ?? [];
    const expected = deployments.find(item => item.id === expectedDeployment);
    // Keep diagnostics on failed attempts too, without exposing task secrets.
    log(JSON.stringify({
      attempt, expectedDeployment, status: service.status,
      running: service.runningCount, desired: service.desiredCount, pending: service.pendingCount,
      deployments: deployments.map(item => ({
        id: item.id, status: item.status, rolloutState: item.rolloutState,
        reason: item.rolloutStateReason,
      })),
    }));

    if (expected?.rolloutState === 'FAILED') {
      throw new Error(`Expected deployment ${expectedDeployment} failed`);
    }
    if (service.status === 'ACTIVE' && deployments.length === 1 &&
        service.runningCount === service.desiredCount && service.pendingCount === 0 &&
        expected?.status === 'PRIMARY' && expected.rolloutState === 'COMPLETED') {
      return;
    }
    if (attempt < attempts) await pause(intervalMs);
  }

  throw new Error(`Expected deployment ${expectedDeployment} was not confirmed PRIMARY/COMPLETED within ${attempts} checks; possible rollback or unfinished deployment`);
}

module.exports = { waitForDeployment };

if (require.main === module) {
  const { ECS_CLUSTER, ECS_SERVICE, EXPECTED_DEPLOYMENT } = process.env;
  if (!ECS_CLUSTER || !ECS_SERVICE) {
    console.error('ECS_CLUSTER and ECS_SERVICE are required');
    process.exitCode = 1;
  } else {
    waitForDeployment({
      expectedDeployment: EXPECTED_DEPLOYMENT,
      describeServices: async () => {
        const { stdout } = await execFileAsync('aws', [
          'ecs', 'describe-services', '--cluster', ECS_CLUSTER,
          '--services', ECS_SERVICE, '--output', 'json', '--no-cli-pager',
          '--cli-connect-timeout', '5', '--cli-read-timeout', '10',
        ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
        return JSON.parse(stdout);
      },
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
