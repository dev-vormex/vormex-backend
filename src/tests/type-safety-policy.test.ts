import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function checkPolicy(source: string, options = {}, debt: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'vormex-type-policy-'));
  try {
    for (const directory of ['src', 'scripts', 'docs/architecture']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, 'src/fixture.ts'), source);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, ...options },
        include: ['src/**/*.ts'],
      })
    );
    writeFileSync(join(root, 'docs/architecture/type-safety-debt.json'), JSON.stringify(debt));
    return spawnSync(process.execPath, [resolve('scripts/check-type-safety.js'), root], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('type policy accepts strict source and ignores directive text in strings', () => {
  const result = checkPolicy('export const text = "// @ts-nocheck";');
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('type policy rejects disabling strict checking or an individual strict check', () => {
  for (const options of [
    { strict: false },
    { noImplicitAny: false },
    { strictNullChecks: false },
    { useUnknownInCatchVariables: false },
  ]) {
    const result = checkPolicy('export const value = 1;', options);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /strict checking/);
  }
});

test('type policy prevents new unchecked files while accepting recorded legacy debt', () => {
  const source = '// @ts-nocheck\nexport const value = 1;';
  const rejected = checkPolicy(source);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /new @ts-nocheck/);
  const accepted = checkPolicy(source, {}, [{ file: 'src/fixture.ts', nocheck: 1 }]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
});

test('type policy requires removing stale debt and rejects silent or unexplained suppression', () => {
  const stale = checkPolicy('export const value = 1;', {}, [{ file: 'src/fixture.ts', nocheck: 1 }]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /remove the resolved entry/);
  for (const directive of ['// @ts-ignore', '/* @ts-ignore */', '// @ts-expect-error']) {
    const result = checkPolicy(`${directive}\nexport const value = 1;`);
    assert.equal(result.status, 1, result.stderr || result.stdout);
  }
});
