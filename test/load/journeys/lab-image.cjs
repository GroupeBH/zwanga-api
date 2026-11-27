'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '../../..');
const tag = 'zwanga-journey-api:local';
function sourceHash() {
  const h = createHash('sha256');
  function add(path) {
    h.update(path); h.update(readFileSync(join(root, path)));
  }
  function tree(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Lab source must not contain symlinks');
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) tree(name); else add(name);
    }
  }
  for (const name of ['.nvmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'test/load/isolation.cjs']) add(name);
  tree('src'); tree('test/load/journeys');
  return h.digest('hex');
}
function inspectImage() {
  if (process.platform !== 'linux') throw new Error('Container lab requires Linux/WSL with native Docker host networking');
  const version = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (process.versions.node !== version) throw new Error(`Generator requires Node ${version}`);
  const [image] = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8', timeout: 10000 }));
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Config?.Labels?.['zwanga.load.source'] !== sourceHash() ||
      image.Config?.Labels?.['zwanga.load.node'] !== version) throw new Error('Rebuild local lab image: source/runtime mismatch');
  return image.Id;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== '--build')) throw new Error('Only --build is supported');
  const version = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const command = ['build', '-f', 'test/load/journeys/Dockerfile.lab', '--build-arg', `NODE_VERSION=${version}`,
    '--build-arg', `SOURCE_HASH=${sourceHash()}`, '-t', tag, '.'];
  if (args[0]) execFileSync('docker', command, { cwd: root, stdio: 'inherit', timeout: 900000 });
  else console.log(JSON.stringify({ command: ['docker', ...command], downloadsDependencies: true, startsResources: false }, null, 2));
}
module.exports = { sourceHash, inspectImage };
