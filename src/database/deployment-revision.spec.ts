const {
  pinTaskDefinition,
} = require('../../infra-aws/scripts/pin-task-definition.cjs');

describe('Immutable ECS deployment payload', () => {
  const image = `registry.invalid/api@sha256:${'a'.repeat(64)}`;
  const source = {
    taskDefinition: {
      family: 'test-api',
      revision: 42,
      taskDefinitionArn: 'old',
      status: 'ACTIVE',
      registeredBy: 'test',
      requiresAttributes: [],
      compatibilities: ['FARGATE'],
      executionRoleArn: 'execution',
      taskRoleArn: 'runtime',
      runtimePlatform: { cpuArchitecture: 'ARM64' },
      containerDefinitions: [
        {
          name: 'api',
          image: 'old:latest',
          secrets: [{ name: 'OTP_PROVIDER', valueFrom: 'synthetic-arn' }],
          healthCheck: { command: ['CMD', 'check'] },
        },
        { name: 'otel', image: 'collector:fixed' },
      ],
    },
  };
  it('changes only the application image and strips response-only metadata', () => {
    const result = pinTaskDefinition(source, 'api', image);
    expect(result.containerDefinitions[0]).toEqual({
      ...source.taskDefinition.containerDefinitions[0],
      image,
    });
    expect(result.containerDefinitions[1]).toEqual(
      source.taskDefinition.containerDefinitions[1],
    );
    expect(result.executionRoleArn).toBe('execution');
    expect(result).not.toHaveProperty('revision');
    expect(result).not.toHaveProperty('taskDefinitionArn');
    expect(source.taskDefinition.containerDefinitions[0].image).toBe(
      'old:latest',
    );
  });
  it('fails closed on a tag or missing container', () => {
    expect(() =>
      pinTaskDefinition(source, 'api', 'registry.invalid/api:latest'),
    ).toThrow('digest');
    expect(() => pinTaskDefinition(source, 'missing', image)).toThrow(
      'exactly one',
    );
  });
});
