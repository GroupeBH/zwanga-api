const fs = require('node:fs');

function pinTaskDefinition(response, containerName, image) {
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('An immutable ECR image digest is required');
  const definition = structuredClone(response.taskDefinition);
  if (!definition?.family || !Array.isArray(definition.containerDefinitions))
    throw new Error('Invalid ECS task definition');
  const matches = definition.containerDefinitions.filter(
    (container) => container.name === containerName,
  );
  if (matches.length !== 1)
    throw new Error('Expected exactly one application container');
  matches[0].image = image;
  for (const key of [
    'taskDefinitionArn',
    'revision',
    'status',
    'requiresAttributes',
    'compatibilities',
    'registeredAt',
    'registeredBy',
    'deregisteredAt',
  ])
    delete definition[key];
  return definition;
}

module.exports = { pinTaskDefinition };
if (require.main === module) {
  const result = pinTaskDefinition(
    JSON.parse(fs.readFileSync(0, 'utf8')),
    process.argv[2],
    process.argv[3],
  );
  process.stdout.write(JSON.stringify(result));
}
