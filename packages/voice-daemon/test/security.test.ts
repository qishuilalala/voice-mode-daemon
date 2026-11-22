import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  evaluateLoopbackSecurity,
  isAllowedLoopbackHost,
  isAllowedOrigin,
  loadOrCreateDaemonToken,
  verifyBearerToken,
} from '../dist/index.js';

describe('voice-daemon loopback security seam', () => {
  it('generates a 256-bit hex token with 0o600 permissions and reuses it across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-token-test-'));
    try {
      const tokenPath = join(dir, 'nested', 'daemon.token');
      const first = await loadOrCreateDaemonToken(tokenPath);
      assert.match(first, /^[0-9a-f]{64}$/);

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

  it('tightens overly permissive pre-existing token file permissions to 0o600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-token-chmod-'));
    try {
      const tokenPath = join(dir, 'daemon.token');
      await writeFile(tokenPath, 'a'.repeat(64) + '\n', { mode: 0o644 });
      const loaded = await loadOrCreateDaemonToken(tokenPath);
      assert.equal(loaded, 'a'.repeat(64));
      if (process.platform !== 'win32') {
        const info = await stat(tokenPath);
        assert.equal(info.mode & 0o777, 0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies Bearer tokens using constant-time digest comparison and rejects malformed headers', () => {
    const secret = 'f'.repeat(64);
    assert.equal(verifyBearerToken(`Bearer ${secret}`, secret), true);
    assert.equal(verifyBearerToken(`bearer   ${secret}  `, secret), true);
    assert.equal(verifyBearerToken(`Bearer ${'f'.repeat(63)}e`, secret), false);
    assert.equal(verifyBearerToken(`Bearer ${'f'.repeat(32)}`, secret), false);
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

  it('evaluates full request guard across Host, Origin, CORS preflight, and Bearer token', () => {
    const token = 'b'.repeat(64);

    // Untrusted Origin rejected with 403 even if Bearer token is valid
    const csrfAttempt = evaluateLoopbackSecurity({
      method: 'POST',
      hostHeader: '127.0.0.1:18790',
      originHeader: 'https://evil.example',
      authorizationHeader: `Bearer ${token}`,
      boundPort: 18790,
      expectedToken: token,
      allowUnauthenticatedLoopback: false,
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
      allowUnauthenticatedLoopback: false,
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
      allowUnauthenticatedLoopback: false,
    });
    assert.equal(cliValid.ok, true);

    const cliMissingToken = evaluateLoopbackSecurity({
      method: 'GET',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
      allowUnauthenticatedLoopback: false,
    });
    assert.equal(cliMissingToken.ok, false);
    assert.equal(cliMissingToken.status, 401);

    // Even in --allow-unauthenticated-loopback mode, absent Origin without Bearer token is rejected
    const unauthNoOrigin = evaluateLoopbackSecurity({
      method: 'POST',
      hostHeader: '127.0.0.1:18790',
      originHeader: undefined,
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
      allowUnauthenticatedLoopback: true,
    });
    assert.equal(unauthNoOrigin.ok, false);
    assert.equal(unauthNoOrigin.status, 403);

    // Allowlisted Origin in --allow-unauthenticated-loopback mode succeeds and echoes exact Origin
    const unauthObsidian = evaluateLoopbackSecurity({
      method: 'POST',
      hostHeader: '127.0.0.1:18790',
      originHeader: 'app://obsidian.md',
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
      allowUnauthenticatedLoopback: true,
    });
    assert.equal(unauthObsidian.ok, true);
    assert.equal(unauthObsidian.headers['Access-Control-Allow-Origin'], 'app://obsidian.md');

    // OPTIONS preflight from Chrome extension succeeds without requiring Authorization header
    const preflight = evaluateLoopbackSecurity({
      method: 'OPTIONS',
      hostHeader: '127.0.0.1:18790',
      originHeader: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      authorizationHeader: undefined,
      boundPort: 18790,
      expectedToken: token,
      allowUnauthenticatedLoopback: false,
    });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.isPreflight, true);
    assert.equal(
      preflight.headers['Access-Control-Allow-Origin'],
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    );
  });
});
