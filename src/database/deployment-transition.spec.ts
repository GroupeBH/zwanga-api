const {
  taskInput,
  assertReady,
  deploy,
} = require('../../infra-aws/scripts/deploy-resilient.cjs');

describe('immutable ECS financial transition (AWS fully mocked)', () => {
  const oldDigest = `sha256:${'a'.repeat(64)}`,
    newImage = `registry/repo@sha256:${'b'.repeat(64)}`;
  const definition = {
    family: 'api',
    taskRoleArn: 'role',
    executionRoleArn: 'exec',
    cpu: '512',
    memory: '1024',
    runtimePlatform: {
      cpuArchitecture: 'ARM64',
      operatingSystemFamily: 'LINUX',
    },
    containerDefinitions: [
      {
        name: 'api',
        image: 'registry/repo:latest',
        secrets: [{ name: 'DB', valueFrom: 'ssm-reference' }],
      },
    ],
    revision: 13,
    taskDefinitionArn: 'old',
    registeredAt: 'date',
    status: 'ACTIVE',
  };
  const fixture = (failure?: string) => {
    let current = 'old',
      revision = 13;
    const definitions: Record<string, any> = {
      old: definition,
      api: definition,
    };
    const records: Record<string, any> = {
      original: {
        taskArn: 'original',
        taskDefinitionArn: 'old',
        lastStatus: 'RUNNING',
        containers: [
          {
            name: 'api',
            healthStatus: 'HEALTHY',
            lastStatus: 'RUNNING',
            imageDigest: oldDigest,
          },
        ],
      },
    };
    const calls: { operation: string; args: any }[] = [];
    const aws = jest.fn(
      async (_service: string, operation: string, args: any) => {
        calls.push({ operation, args });
        if (operation === 'describe-services')
          return {
            services: [
              {
                taskDefinition: current,
                desiredCount: 1,
                runningCount: 1,
                pendingCount: 0,
                deployments: [{ rolloutState: 'COMPLETED' }],
                networkConfiguration: {
                  awsvpcConfiguration: {
                    subnets: ['subnet'],
                    securityGroups: ['sg'],
                    assignPublicIp: 'ENABLED',
                  },
                },
              },
            ],
          };
        if (operation === 'describe-task-definition')
          return { taskDefinition: definitions[args['task-definition']] };
        if (operation === 'register-task-definition') {
          const arn = `task:${++revision}`;
          definitions[arn] = JSON.parse(args['cli-input-json']);
          return { taskDefinition: { taskDefinitionArn: arn } };
        }
        if (operation === 'list-tasks')
          return {
            taskArns: Object.values(records)
              .filter(
                (t) =>
                  !t.job &&
                  (args['desired-status'] === 'STOPPED'
                    ? t.lastStatus !== 'RUNNING'
                    : t.lastStatus === 'RUNNING'),
              )
              .map((t) => t.taskArn),
          };
        if (operation === 'describe-tasks')
          return { tasks: args.tasks.map((arn: string) => records[arn]) };
        if (operation === 'update-service') {
          const target = args['task-definition'];
          if (failure === 'rollback' && target === 'task:15') return {};
          for (const t of Object.values(records))
            if (!t.job && t.lastStatus === 'RUNNING')
              t.lastStatus =
                failure === 'draining' && target === 'task:15'
                  ? 'STOPPING'
                  : 'STOPPED';
          current = target;
          records[target] = {
            taskArn: target,
            taskDefinitionArn: target,
            lastStatus: 'RUNNING',
            containers: [
              {
                name: 'api',
                healthStatus: 'HEALTHY',
                lastStatus: 'RUNNING',
                imageDigest: oldDigest,
              },
            ],
          };
          return {};
        }
        if (operation === 'run-task') {
          const command = JSON.parse(args.overrides).containerOverrides[0]
            .command[2];
          const arn = `job:${Object.keys(records).length}`;
          records[arn] = {
            taskArn: arn,
            job: true,
            lastStatus: 'STOPPED',
            containers: [
              {
                name: 'api',
                exitCode:
                  failure === 'migration' && command.includes('prepare')
                    ? 1
                    : 0,
              },
            ],
          };
          return { tasks: [{ taskArn: arn }] };
        }
        if (operation === 'wait') return {};
        throw new Error(`Unexpected ${operation}`);
      },
    );
    return {
      aws,
      calls,
      env: {
        ECS_CLUSTER: 'cluster',
        ECS_SERVICE: 'api',
        ECS_APP_CONTAINER: 'api',
        DEPLOY_IMAGE: newImage,
      },
      log: jest.fn(),
    };
  };
  it('preserves task resources/secret references but strips non-registerable metadata', () => {
    const result = taskInput(definition, newImage, 'api', true);
    expect(result.revision).toBeUndefined();
    expect(result.taskDefinitionArn).toBeUndefined();
    expect(result.runtimePlatform).toEqual(definition.runtimePlatform);
    expect(result.containerDefinitions[0].secrets).toEqual(
      definition.containerDefinitions[0].secrets,
    );
    expect(result.containerDefinitions[0].environment).toContainEqual({
      name: 'ZWANGA_FINANCE_CONTRACT',
      value: '1',
    });
    expect(definition.containerDefinitions[0].image).toBe(
      'registry/repo:latest',
    );
    expect(() =>
      taskInput(definition, 'registry/repo:latest', 'api', true),
    ).toThrow('immutable');
  });
  it('pins rollback first, prepares atomically, replaces, waits for old shutdown, then activates', async () => {
    const f = fixture();
    const result = await deploy(f);
    expect(result).toEqual({ rollback: 'task:14', target: 'task:15' });
    const jobs = f.calls.filter((c) => c.operation === 'run-task');
    expect(
      JSON.parse(jobs[0].args.overrides).containerOverrides[0].command[2],
    ).toContain('prepare-legacy');
    expect(
      JSON.parse(jobs[1].args.overrides).containerOverrides[0].command[2],
    ).toContain(' activate');
    const activation = f.calls.indexOf(jobs[1]);
    expect(
      f.calls
        .slice(0, activation)
        .some(
          (c) =>
            c.operation === 'wait' &&
            c.args.waiter === 'tasks-stopped' &&
            c.args.tasks.includes('original'),
        ),
    ).toBe(true);
    const updates = f.calls.filter((c) => c.operation === 'update-service');
    expect(
      JSON.parse(updates[0].args['deployment-configuration'])
        .deploymentCircuitBreaker.rollback,
    ).toBe(false);
    expect(
      JSON.parse(updates[1].args['deployment-configuration'])
        .deploymentCircuitBreaker.rollback,
    ).toBe(true);
  });
  it.each(['migration', 'rollback', 'draining'])(
    'never activates after %s failure and never reverts financial data',
    async (failure) => {
      const f = fixture(failure);
      await expect(deploy(f)).rejects.toThrow();
      const commands = f.calls
        .filter((c) => c.operation === 'run-task')
        .map(
          (c) => JSON.parse(c.args.overrides).containerOverrides[0].command[2],
        );
      expect(commands.some((c) => c.endsWith(' activate'))).toBe(false);
      expect(commands.some((c) => /revert|down/.test(c))).toBe(false);
    },
  );
  it('rejects a healthy service when its deployment is the old version', () => {
    expect(() =>
      assertReady({ taskDefinition: 'old' }, [], 'new', 'api'),
    ).toThrow('rolled back');
  });
});
