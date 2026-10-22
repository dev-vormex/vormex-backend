import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('API composition preserves all HTTP layers, route methods, handlers, and Socket.IO events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vormex-api-contract-'));
  const output = join(directory, 'contract.json');
  try {
    const probe = spawnSync(process.execPath, ['scripts/capture-api-contract.js', output], {
      cwd: process.cwd(),
      encoding: 'utf8',
      // Loading the complete API graph can exceed 15s on a cold Windows disk.
      // This is a composition snapshot check, not a startup latency benchmark.
      timeout: 30_000,
    });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    const expected = JSON.parse(readFileSync('src/tests/fixtures/api-contract.json', 'utf8'));
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
