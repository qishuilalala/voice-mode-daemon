import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_PORT = 18790;
export const DAEMON_TOKEN_PREFIX = 'sk-vmd-';

export function defaultDaemonTokenPath(homeDir: string = homedir()): string {
  return join(homeDir, '.cache', 'voice-mode', 'daemon.token');
}

const CHROME_EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-z0-9_-]{16,64}$/i;
const MOZ_EXT_ORIGIN_RE = /^moz-extension:\/\/[a-f0-9-]{16,64}$/i;
const LOOPBACK_HTTP_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([1-9]\d{0,4}))?$/i;

export function isAllowedLoopbackBindHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  return trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === 'localhost';
}

export function isAllowedLoopbackHost(hostHeader: string | undefined, boundPort: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return false;

  const expectedPort = String(boundPort);
  if (
    trimmed === `127.0.0.1:${expectedPort}` ||
    trimmed === `localhost:${expectedPort}` ||
    trimmed === `[::1]:${expectedPort}`
  ) {
    return true;
  }
  if (
    boundPort === 80 &&
    (trimmed === '127.0.0.1' || trimmed === 'localhost' || trimmed === '[::1]')
  ) {
    return true;
  }
  return false;
}

export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (typeof originHeader !== 'string') return false;
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  if (trimmed.toLowerCase() === 'app://obsidian.md') return true;
  if (CHROME_EXT_ORIGIN_RE.test(trimmed) || MOZ_EXT_ORIGIN_RE.test(trimmed)) return true;

  const loopMatch = LOOPBACK_HTTP_ORIGIN_RE.exec(trimmed);
  if (!loopMatch) return false;
  const portStr = loopMatch[2];
  if (portStr !== undefined) {
    const port = Number.parseInt(portStr, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

function sha256Bytes(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function verifyBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const expected = expectedToken.trim();
  if (expected.length === 0 || typeof authorizationHeader !== 'string') {
    return false;
  }
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
  if (!match || !match[1]) {
    return false;
  }
  const candidate = match[1];
  const candidateDigest = sha256Bytes(candidate);
  const expectedDigest = sha256Bytes(expected);
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export async function loadOrCreateDaemonToken(
  tokenPath: string = defaultDaemonTokenPath(),
): Promise<string> {
  const parentDir = dirname(tokenPath);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });

  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.startsWith(DAEMON_TOKEN_PREFIX) && existing.length >= 40) {
      if (process.platform !== 'win32') {
        const info = await stat(tokenPath);
        if ((info.mode & 0o777) !== 0o600) {
          await chmod(tokenPath, 0o600);
        }
      }
      return existing;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const generated = `${DAEMON_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  const tmpPath = `${tokenPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmpPath, 'wx', 0o600);
  try {
    await fh.writeFile(`${generated}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, tokenPath);
  if (process.platform !== 'win32') {
    await chmod(tokenPath, 0o600);
  }
  return generated;
}

export interface SecurityCheckInput {
  method: string;
  hostHeader: string | undefined;
  originHeader: string | undefined;
  authorizationHeader: string | undefined;
  boundPort: number;
  expectedToken: string;
}

export type SecurityDecision =
  | {
      ok: true;
      isPreflight: boolean;
      headers: Record<string, string>;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      headers: Record<string, string>;
    };

function buildCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function evaluateLoopbackSecurity(input: SecurityCheckInput): SecurityDecision {
  if (!isAllowedLoopbackHost(input.hostHeader, input.boundPort)) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden Host header: loopback address required',
      headers: {},
    };
  }

  const rawOrigin = input.originHeader?.trim();
  const hasOrigin = rawOrigin !== undefined && rawOrigin.length > 0;
  if (hasOrigin && !isAllowedOrigin(rawOrigin)) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden Origin: origin is not in loopback/extension allowlist',
      headers: { Vary: 'Origin' },
    };
  }

  const corsHeaders = buildCorsHeaders(hasOrigin ? rawOrigin : undefined);
  const isOptions = input.method.toUpperCase() === 'OPTIONS';

  // Browser CORS preflight carries an allowlisted Origin without Authorization header.
  if (isOptions && hasOrigin) {
    return {
      ok: true,
      isPreflight: true,
      headers: corsHeaders,
    };
  }

  if (!verifyBearerToken(input.authorizationHeader, input.expectedToken)) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized: valid Bearer token required',
      headers: {
        ...corsHeaders,
        'WWW-Authenticate': 'Bearer realm="voice-daemon"',
      },
    };
  }

  return {
    ok: true,
    isPreflight: isOptions,
    headers: corsHeaders,
  };
}
