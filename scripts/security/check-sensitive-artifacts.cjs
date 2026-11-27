// Metadata-only guard: never print blob contents, environment or credentials.
const { execFileSync } = require('node:child_process');

function forbiddenPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  return /(^|\/)\.terraform\//i.test(normalized)
    || /\.tfstate(?:\.|$)/i.test(name)
    || /\.tfplan(?:\.|$)/i.test(name)
    || /^tfplan(?:\.|$)/i.test(name)
    || /^(?:operators|terraform)\.tfvars(?:\.json)?$/i.test(name)
    || (name === '.env' || /^\.env\.(?:local|production|staging|development|test)(?:\.local)?$/i.test(name));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
}

function inspect(cwd, history = false) {
  // Index, not worktree: a locally deleted file can still be staged for commit.
  const current = git(['ls-files', '-z'], cwd).split('\0').filter(Boolean);
  const paths = new Set(current.filter(forbiddenPath));
  if (history) {
    if (git(['rev-parse', '--is-shallow-repository'], cwd).trim() !== 'false') {
      throw new Error('Full Git history is required (fetch-depth: 0).');
    }
    // Include every reachable branch/tag; inspect added/changed names, never patches.
    const historical = git(['log', '--all', '--format=', '--name-only', '-z', '--diff-filter=AM', '--no-renames'], cwd);
    for (const path of historical.split('\0').map(value => value.replace(/^\n+/, '')).filter(Boolean)) {
      if (forbiddenPath(path)) paths.add(path);
    }
  }
  return [...paths].sort();
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--history')) throw new Error('Unknown argument.');
    const paths = inspect(process.cwd(), process.argv.includes('--history'));
    if (paths.length) {
      console.error(`Blocked: ${paths.length} sensitive artifact path(s). Contents withheld.`);
      for (const path of paths.slice(0, 50)) console.error(JSON.stringify(path));
      process.exitCode = 1;
    } else console.log('No forbidden sensitive artifact paths found.');
  } catch {
    console.error('Sensitive artifact check failed; no repository content was logged.');
    process.exitCode = 2;
  }
}
module.exports = { forbiddenPath, inspect };
