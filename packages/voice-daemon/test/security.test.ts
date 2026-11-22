import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { redactSecrets } from '@voice-mode/core';
import {
  evaluateLoopbackSecurity,
  isAllowedLoopbackHost,
  isAllowedOrigin,
  loadOrCreateDaemonToken,
  verifyBearerToken,
} from '../dist/index.js';

describe('voice-daemon loopback security seam', () => {
  it('generates an sk-vmd- prefixed 192-bit token redacted by redactSecrets with 0o600 permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-token-test-'));
    try {
      const tokenPath = join(dir, 'nested', 'daemon.token');
      const first = await loadOrCreateDaemonToken(tokenPath);
      assert.match(first, /^sk-vmd-[0-9a-f]{48}$/);
      assert.equal(redactSecrets(`Authorization: ${first}`).includes(first), false);
      assert.equal(redactSecrets(`leaked ${first} in log`).includes(first), false);

      const info = await stat(tokenPath);
      if (process.platform !== 'win32') {
        assert.equal(info.mode & 0o777, 0o600);
      }

      const second = await loadOrCreateDaemonToken(tokenPath);
      assert.equal(second, first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rotates legacy unprefixed tokens and tightens overly permissive modes to 0o600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-token-chmod-'));
    try {
      const tokenPath = join(dir, 'daemon.token');
      // Legacy bare 64-hex token must be rotated to sk-vmd-*
      await writeFile(tokenPath, 'a'.repeat(64) + '\n', { mode: 0o644 });
      const rotated = await loadOrCreateDaemonToken(tokenPath);
      assert.match(rotated, /^sk-vmd-[0-9a-f]{48}$/);

      // Existing sk-vmd- token with 0o644 is preserved and tightened to 0o600
      const validPrefixed = `sk-vmd-${'b'.repeat(48)}`;
      await writeFile(tokenPath, `${validPrefixed}\n`, { mode: 0o644 });
      const loaded = await loadOrCreateDaemonToken(tokenPath);
      assert.equal(loaded, validPrefixed);
      if (process.platform !== 'win32') {
        const info = await stat(tokenPath);
        assert.equal(info.mode & 0o777, 0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies Bearer tokens using constant-time digest comparison and rejects malformed headers', () => {
    const secret = `sk-vmd-${'f'.repeat(48)}`;
    assert.equal(verifyBearerToken(`Bearer ${secret}`, secret), true);
    assert.equal(verifyBearerToken(`bearer   ${secret}  `, secret), true);
    assert.equal(verifyBearerToken(`Bearer sk-vmd-${'f'.repeat(47)}e`, secret), false);
    assert.equal(verifyBearerToken(`Bearer sk-vmd-${'f'.repeat(24)}`, secret), false);
    assert.equal(verifyBearerToken(`Basic ${secret}`, secret), false);
    assert.equal(verifyBearerToken('Bearer ', secret), false);
    assert.equal(verifyBearerToken(undefined, secret), false);
    assert.equal(verifyBearerToken(`Bearer ${secret}`, ''), false);
  });

  it('blocks DNS rebinding via strict Host header loopback verification', () => {
    assert.equal(isAllowedLoopbackHost('127.0.0.1:18790', 18790), true);
    assert.equal(isAllowedLoopbackHost('localhost:18790', 18790), true);
    assert.equal(isAllowedLoopbackHost('[::1]:18790', 18790), true);
    assert.equal(isAllowedLoopbackHost('127.0.0.1:9999', 18790), false);
    assert.equal(isAllowedLoopbackHost('evil.rebind.example:18790', 18790), false);
    assert.equal(isAllowedLoopbackHost('127.0.0.1.evil.example:18790', 18790), false);
    assert.equal(isAllowedLoopbackHost(undefined, 18790), false);
  });

  it('enforces strict Origin allowlist and rejects untrusted web or null origins', () => {
    assert.equal(isAllowedOrigin('app://obsidian.md'), true);
    assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop'), true);
    assert.equal(isAllowedOrigin('moz-extension://12345678-1234-1234-1234-123456789abc'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:8000'), true);
    assert.equal(isAllowedOrigin('http://localhost:5173'), true);
    assert.equal(isAllowedOrigin('http://[::1]:8080'), true);

    assert.equal(isAllowedOrigin('https://evil.example'), false);
    assert.equal(isAllowedOrigin('http://evil.example:18790'), false);
    assert.equal(isAllowedOrigin('https://chat.deepseek.com'), false);
    assert.equal(isAllowedOrigin('null'), false);
    assert.equal(isAllowedOrigin('file://'), false);
    assert.equal(isAllowedOrigin('app://evil.md'), false);
  });

  it('enforces Host, Origin, authenticated absent-Origin OPTIONS, and mandatory Bearer token', () => {
    const token = `sk-vmd-${'b'.repeat(48)}`;

    // Untrusted Origin rejected with 403 even if Bearer token is valid
    const csrfAttempt = evaluateLoopbackSecurity({
      method: 'POST',
      hostHeader: '127.0.0.1:18790',
      originHeader: 'https://evil.example',
      authorizationHeader: `Bearer ${token}`,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(csrfAttempt.ok, false);
    assert.equal(csrfAttempt.status, 403);

    // DNS rebinding Host rejected with 403
    const rebindAttempt = evaluateLoopbackSecurity({
      method: 'GET',
      hostHeader: 'rebind.attacker.test:18790',
      originHeader: undefined,
      authorizationHeader: `Bearer ${token}`,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(rebindAttempt.ok, false);
    assert.equal(rebindAttempt.status, 403);

    // Absent Origin allowed ONLY when valid Bearer token is supplied
    const cliValid = evaluateLoopbackSecurity({
      method: 'GET',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: `Bearer ${token}`,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(cliValid.ok, true);

    const cliMissingToken = evaluateLoopbackSecurity({
      method: 'GET',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(cliMissingToken.ok, false);
    assert.equal(cliMissingToken.status, 401);

    // OPTIONS preflight from allowlisted Chrome extension succeeds for CORS handshake
    const preflight = evaluateLoopbackSecurity({
      method: 'OPTIONS',
      hostHeader: '127.0.0.1:18790',
      originHeader: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.isPreflight, true);
    assert.equal(
      preflight.headers['Access-Control-Allow-Origin'],
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    );

    // OPTIONS with ABSENT Origin must require valid Bearer auth (401 when missing/invalid!)
    const unauthOptions = evaluateLoopbackSecurity({
      method: 'OPTIONS',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(unauthOptions.ok, false);
    assert.equal(unauthOptions.status, 401);

    const authedOptions = evaluateLoopbackSecurity({
      method: 'OPTIONS',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: `Bearer ${token}`,
      boundPort: 18790,
      expectedToken: token,
    });
    assert.equal(authedOptions.ok, true);
    assert.equal(authedOptions.isPreflight, true);
  });
});
