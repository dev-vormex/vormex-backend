import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function script(name: string): string {
  return readFileSync(join(process.cwd(), 'scripts', name), 'utf8');
}

test('development launchers use Node entrypoints without shell command concatenation', () => {
  const dev = script('dev.js');
  const schema = script('ensure-dev-schema.js');
  const compiled = script('run-compiled.js');

  assert.match(dev, /tsx.*dist.*cli\.mjs/s);
  assert.match(dev, /\[tsxCliPath, 'watch', 'src\/api\.ts'\]/);
  assert.doesNotMatch(dev, /ts-node-dev|shell:\s*true|\.cmd/);

  assert.match(schema, /prisma.*build.*index\.js/s);
  assert.match(schema, /spawnSync\(\s*process\.execPath/);
  assert.doesNotMatch(schema, /shell:\s*true|\.cmd/);

  assert.match(compiled, /scripts', 'build\.js'/);
  assert.doesNotMatch(compiled, /npm\.cmd|shell:\s*true/);
});
