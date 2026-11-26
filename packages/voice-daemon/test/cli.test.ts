import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const cli = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('CLI surface', () => {
  it('prints usage with every documented command', () => {
    const help = run('--help');
    for (const command of ['serve', 'models status', 'models download', 'models clean', 'token-path']) {
      assert.ok(help.includes(command), `usage should document "${command}"`);
    }
  });

  it('prints the token path without leaking the token', () => {
    const out = run('token-path');
    assert.match(out, /daemon\.token/);
    assert.ok(!/sk-vmd-/.test(out), 'token value must never be printed');
  });

  it('previews model cleanup without deleting anything', () => {
    const out = run('models', 'clean');
    // Three environments: bundles under the primary dir (Would remove...), fallback-only
    // (No installed bundles...), and a completely empty cache (Nothing to clean...).
    assert.match(out, /Would remove|No installed bundles|Nothing to clean/);
    assert.ok(!/Removed \d/.test(out), 'preview must not report deletions');
  });
});
