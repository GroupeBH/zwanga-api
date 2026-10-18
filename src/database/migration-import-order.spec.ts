import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

it('loads the migration registry in emitted CommonJS without temporal-dead-zone errors', () => {
  const source = readFileSync(join(__dirname, 'migrations/index.ts'), 'utf8');
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2023 },
  }).outputText;
  const exported: { databaseMigrations?: unknown[] } = {};
  // Only validate import/evaluation order; do not import providers or execute SQL.
  const migrationStub = new Proxy({}, { get: () => class Migration {} });
  runInNewContext(compiled, { exports: exported, require: () => migrationStub });
  expect(exported.databaseMigrations?.length).toBeGreaterThan(0);
  expect(exported.databaseMigrations?.every(migration => typeof migration === 'function')).toBe(true);
});
