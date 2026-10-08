/* The only writer is the deployment workflow. Importing this module is inert. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const CONTRACT = '1';
function taskInput(definition, image, containerName, modern) {
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('An immutable image digest is required');
  const fields = [
    'family',
    'taskRoleArn',
    'executionRoleArn',
    'networkMode',
    'containerDefinitions',
    'volumes',
    'placementConstraints',
    'requiresCompatibilities',
    'cpu',
    'memory',
    'pidMode',
    'ipcMode',
    'proxyConfiguration',
    'inferenceAccelerators',
    'ephemeralStorage',
    'runtimePlatform',
    'enableFaultInjection',
  ];
  const result = JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        fields
          .filter((key) => definition[key] !== undefined)
          .map((key) => [key, definition[key]]),
      ),
    ),
  );
  const app = result.containerDefinitions.find((c) => c.name === containerName);
  if (!app) throw new Error('Application container missing');
  app.image = image;
  if (modern) {
    app.environment = [
      ...(app.environment || []).filter(
        (e) => e.name !== 'ZWANGA_FINANCE_CONTRACT',
      ),
      { name: 'ZWANGA_FINANCE_CONTRACT', value: CONTRACT },
    ];
  }
  return result;
}

function assertReady(service, tasks, target, containerName) {
  if (
    service.taskDefinition !== target ||
    service.desiredCount < 1 ||
    service.pendingCount !== 0 ||
    service.runningCount !== service.desiredCount ||
    service.deployments.length !== 1 ||
    service.deployments[0].rolloutState !== 'COMPLETED'
  )
    throw new Error('Target deployment is not complete (or ECS rolled back)');
  if (
    tasks.length < service.desiredCount ||
    tasks.some(
      (task) =>
        task.taskDefinitionArn !== target ||
        task.lastStatus !== 'RUNNING' ||
        !task.containers.some(
          (c) =>
            c.name === containerName &&
            c.lastStatus === 'RUNNING' &&
            c.healthStatus === 'HEALTHY',
        ),
    )
  ) {
    throw new Error('Not every service task runs the healthy target version');
  }
}

async function deploy({ aws, env, log = console.log }) {
  const {
    ECS_CLUSTER: cluster,
    ECS_SERVICE: serviceName,
    ECS_APP_CONTAINER: app = 'api',
    DEPLOY_IMAGE: image,
  } = env;
  if (!cluster || !serviceName || !image)
    throw new Error('Missing deployment environment');
  const service = async () => {
    const result = await aws('ecs', 'describe-services', {
      cluster,
      services: [serviceName],
    });
    if (result.failures?.length || !result.services?.[0])
      throw new Error('Unable to read ECS service');
    return result.services[0];
  };
  const tasks = async () => {
    const { taskArns = [] } = await aws('ecs', 'list-tasks', {
      cluster,
      'service-name': serviceName,
    });
    if (!taskArns.length) return [];
    const all = [];
    for (let offset = 0; offset < taskArns.length; offset += 100) {
      const found = await aws('ecs', 'describe-tasks', {
        cluster,
        tasks: taskArns.slice(offset, offset + 100),
      });
      if (found.failures?.length)
        throw new Error('Unable to inspect service tasks');
      all.push(...found.tasks);
    }
    return all;
  };
  const register = async (input) =>
    (
      await aws('ecs', 'register-task-definition', {
        'cli-input-json': JSON.stringify(input),
      })
    ).taskDefinition.taskDefinitionArn;
  const update = async (target, rollback) =>
    aws('ecs', 'update-service', {
      cluster,
      service: serviceName,
      'task-definition': target,
      'deployment-configuration': JSON.stringify({
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        deploymentCircuitBreaker: { enable: true, rollback },
      }),
    });
  const waitReady = async (target) => {
    // A stable service can be a rolled-back OLD version. Always verify the ARN.
    await aws('ecs', 'wait', {
      waiter: 'services-stable',
      cluster,
      services: [serviceName],
    });
    assertReady(await service(), await tasks(), target, app);
  };
  const initial = await service();
  const initialTasks = await tasks();
  assertReady(initial, initialTasks, initial.taskDefinition, app);
  const original = (
    await aws('ecs', 'describe-task-definition', {
      'task-definition': initial.taskDefinition,
    })
  ).taskDefinition;
  // Terraform can register a newer infrastructure template (SSM references,
  // resources, sidecars) without moving the service back to its bootstrap image.
  const template = (
    await aws('ecs', 'describe-task-definition', {
      'task-definition': original.family,
    })
  ).taskDefinition;
  const oldApp = original.containerDefinitions.find((c) => c.name === app);
  const legacy = !oldApp?.environment?.some(
    (e) => e.name === 'ZWANGA_FINANCE_CONTRACT' && e.value === CONTRACT,
  );
  const digests = new Set(
    initialTasks.map(
      (t) => t.containers.find((c) => c.name === app)?.imageDigest,
    ),
  );
  if (digests.size !== 1 || !/^sha256:[a-f0-9]{64}$/.test([...digests][0]))
    throw new Error('Current service image is ambiguous');
  const repository = oldApp.image.split('@')[0].replace(/:[^/:]+$/, '');
  const rollbackImage = `${repository}@${[...digests][0]}`;
  let rollback = initial.taskDefinition;
  if (oldApp.image !== rollbackImage) {
    rollback = await register(taskInput(original, rollbackImage, app, false));
    // Never auto-roll back this pinning step to a mutable :latest image.
    await update(rollback, false);
    await waitReady(rollback);
  }
  log(`Known-good task definition: ${rollback}`);
  const target = await register(taskInput(template, image, app, true));
  const network = {
    awsvpcConfiguration: initial.networkConfiguration.awsvpcConfiguration,
  };
  const run = async (command, label) => {
    const result = await aws('ecs', 'run-task', {
      cluster,
      'launch-type': 'FARGATE',
      'task-definition': target,
      'network-configuration': JSON.stringify(network),
      overrides: JSON.stringify({
        containerOverrides: [{ name: app, command: ['sh', '-c', command] }],
      }),
    });
    if (result.failures?.length || !result.tasks?.[0]?.taskArn)
      throw new Error(`${label}: unable to start task`);
    const taskArn = result.tasks[0].taskArn;
    log(`${label}: ${taskArn}`);
    await aws('ecs', 'wait', {
      waiter: 'tasks-stopped',
      cluster,
      tasks: [taskArn],
    });
    const completed = await aws('ecs', 'describe-tasks', {
      cluster,
      tasks: [taskArn],
    });
    if (
      completed.failures?.length ||
      completed.tasks?.[0]?.containers?.find((c) => c.name === app)
        ?.exitCode !== 0
    ) {
      throw new Error(
        `${label} failed; inspect the task's CloudWatch logs. No activation/automatic data rollback.`,
      );
    }
  };
  await run(
    `npm run database:assert-bootstrap:prod && node dist/database/financial-rollout-cli.js ${legacy ? 'prepare-legacy' : 'prepare'}`,
    'Prepare schema',
  );
  const oldTasks = new Set(
    [...initialTasks, ...(await tasks())].map((t) => t.taskArn),
  );
  await update(target, true);
  await waitReady(target);
  // Draining tasks may already have desiredStatus STOPPED but still execute code.
  // Wait for the old ARNs themselves, not only the service's healthy target count.
  const draining = await aws('ecs', 'list-tasks', {
    cluster,
    'service-name': serviceName,
    'desired-status': 'STOPPED',
  });
  for (const arn of draining.taskArns || []) oldTasks.add(arn);
  const previousTasks = [...oldTasks];
  for (let offset = 0; offset < previousTasks.length; offset += 100) {
    const batch = previousTasks.slice(offset, offset + 100);
    await aws('ecs', 'wait', {
      waiter: 'tasks-stopped',
      cluster,
      tasks: batch,
    });
    const result = await aws('ecs', 'describe-tasks', {
      cluster,
      tasks: batch,
    });
    if (
      result.failures?.length ||
      result.tasks.length !== batch.length ||
      result.tasks.some((t) => t.lastStatus !== 'STOPPED')
    ) {
      throw new Error(
        'Old servers may still be running; financial activation refused',
      );
    }
  }
  // Also catch tasks spawned by autoscaling during the replacement.
  assertReady(await service(), await tasks(), target, app);
  await run(
    'node dist/database/financial-rollout-cli.js activate',
    'Activate financial policy',
  );
  await waitReady(target);
  log(
    `Deployment complete: ${target}. Cash policy active; do NOT roll back to a pre-contract image.`,
  );
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Resilient ECS deployment\n- Target: \`${target}\`\n- Pinned previous image: \`${rollback}\`\n- Financial policy: active\n- Legacy rollback forbidden after activation.\n`,
    );
  return { target, rollback };
}

function cliAws(service, operation, params) {
  const args = [service, operation];
  if (params.waiter) args.push(params.waiter);
  for (const [key, value] of Object.entries(params)) {
    if (key === 'waiter') continue;
    args.push(`--${key}`, ...(Array.isArray(value) ? value : [String(value)]));
  }
  if (operation !== 'wait') args.push('--output', 'json');
  try {
    const output = execFileSync('aws', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 1_200_000,
      env: { ...process.env, AWS_PAGER: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim() ? JSON.parse(output) : {};
  } catch {
    throw new Error(
      `AWS ${service} ${operation} failed; sensitive CLI output was suppressed`,
    );
  }
}

module.exports = { taskInput, assertReady, deploy };
if (require.main === module)
  deploy({ aws: cliAws, env: process.env }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
