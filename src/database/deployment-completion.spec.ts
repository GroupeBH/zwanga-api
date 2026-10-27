const { waitForDeployment } = require('../../infra-aws/scripts/wait-for-ecs-deployment.cjs');

describe('ECS deployment completion confirmation', () => {
  const expectedDeployment = 'ecs-svc/123';
  const snapshot = (rolloutState = 'COMPLETED', deployment = {}) => ({
    failures: [],
    services: [{
      status: 'ACTIVE', runningCount: 1, desiredCount: 1, pendingCount: 0,
      deployments: [{ id: expectedDeployment, status: 'PRIMARY', rolloutState, ...deployment }],
    }],
  });
  const options = () => ({
    expectedDeployment,
    describeServices: jest.fn().mockResolvedValue(snapshot()),
    pause: jest.fn().mockResolvedValue(undefined),
    log: jest.fn(),
  });

  it('accepts the expected completed deployment without waiting', async () => {
    const f = options();
    await expect(waitForDeployment(f)).resolves.toBeUndefined();
    expect(f.describeServices).toHaveBeenCalledTimes(1);
    expect(f.pause).not.toHaveBeenCalled();
  });

  it('waits when task counts stabilize before rolloutState becomes COMPLETED', async () => {
    const f = options();
    f.describeServices.mockResolvedValueOnce(snapshot('IN_PROGRESS'));
    await expect(waitForDeployment(f)).resolves.toBeUndefined();
    expect(f.describeServices).toHaveBeenCalledTimes(2);
    expect(f.pause).toHaveBeenCalledWith(10_000);
    expect(f.log).toHaveBeenCalledTimes(2);
  });

  it('fails immediately when ECS explicitly fails the expected deployment', async () => {
    const f = options();
    f.describeServices.mockResolvedValue(snapshot('FAILED'));
    await expect(waitForDeployment(f)).rejects.toThrow('ecs-svc/123 failed');
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stable rollback', { id: 'ecs-svc/456' }],
    ['completed but no longer primary', { status: 'ACTIVE' }],
    ['missing rollout state', { rolloutState: undefined }],
  ])('never accepts a %s', async (_description, deployment) => {
    const f = options();
    f.describeServices.mockResolvedValue(snapshot('COMPLETED', deployment));
    await expect(waitForDeployment({ ...f, attempts: 2 })).rejects.toThrow('not confirmed');
    expect(f.describeServices).toHaveBeenCalledTimes(2);
    expect(f.pause).toHaveBeenCalledTimes(1);
  });

  it('bounds an unfinished rollout to thirteen reads and twelve delays', async () => {
    const f = options();
    f.describeServices.mockResolvedValue(snapshot('IN_PROGRESS'));
    await expect(waitForDeployment(f)).rejects.toThrow('within 13 checks');
    expect(f.describeServices).toHaveBeenCalledTimes(13);
    expect(f.pause).toHaveBeenCalledTimes(12);
  });

  it('rechecks stability if task counts changed after the AWS waiter', async () => {
    const f = options();
    const incomplete = snapshot();
    incomplete.services[0].runningCount = 0;
    incomplete.services[0].pendingCount = 1;
    f.describeServices.mockResolvedValueOnce(incomplete);
    await expect(waitForDeployment(f)).resolves.toBeUndefined();
    expect(f.describeServices).toHaveBeenCalledTimes(2);
  });

  it.each([
    { failures: [{ reason: 'MISSING' }], services: [] },
    { services: [] },
    { services: [snapshot().services[0], snapshot().services[0]] },
  ])('rejects missing or ambiguous service results: %j', async (response) => {
    const f = options();
    f.describeServices.mockResolvedValue(response);
    await expect(waitForDeployment(f)).rejects.toThrow('requested service');
    expect(f.pause).not.toHaveBeenCalled();
  });

  it('does not turn AWS read errors into a successful release', async () => {
    const f = options();
    f.describeServices.mockRejectedValue(new Error('AccessDenied'));
    await expect(waitForDeployment(f)).rejects.toThrow('AccessDenied');
    expect(f.pause).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'None', 'ecs-svc/123\n'])('rejects an invalid expected deployment: %j', async (id) => {
    const f = options();
    await expect(waitForDeployment({ ...f, expectedDeployment: id })).rejects.toThrow('valid expected');
    expect(f.describeServices).not.toHaveBeenCalled();
  });
});
