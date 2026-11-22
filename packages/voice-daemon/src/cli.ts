#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { redactSecrets } from '@voice-mode/core';
import {
  DAEMON_MODEL_BUNDLES,
  downloadModelBundle,
  inspectModelCache,
  type DaemonBundleId,
} from './model-cache.js';
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  defaultDaemonTokenPath,
  loadOrCreateDaemonToken,
} from './security.js';
import { DAEMON_VERSION, startVoiceDaemonServer } from './server.js';

function printHelp(): void {
  process.stdout.write(
    [
      `voice-daemon v${DAEMON_VERSION} — Local loopback neural speech daemon`,
      '',
      'Usage:',
      '  voice-daemon [serve] [--port 18790] [--token-file <path>] [--cache-dir <dir>]',
      '  voice-daemon models status [--cache-dir <dir>] [--json]',
      '  voice-daemon models download [kokoro-int8|zipformer2|sensevoice-int8|all] [--cache-dir <dir>] [--mirror <https-url>]',
      '  voice-daemon token-path [--token-file <path>]',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      token: { type: 'string' },
      'token-file': { type: 'string' },
      'cache-dir': { type: 'string' },
      mirror: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return;
  }

  const cmd = positionals[0] ?? 'serve';

  if (cmd === 'token-path') {
    const tokenPath = values['token-file'] ?? defaultDaemonTokenPath();
    await loadOrCreateDaemonToken(tokenPath);
    process.stdout.write(`${tokenPath}\n`);
    return;
  }

  if (cmd === 'models') {
    const sub = positionals[1] ?? 'status';
    const cacheOpts = values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {};

    if (sub === 'status') {
      const statuses = await inspectModelCache(cacheOpts);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
        return;
      }
      for (const s of statuses) {
        process.stdout.write(
          `[${s.installed ? 'INSTALLED' : 'MISSING'}] ${s.id} (${s.license}) source=${s.source}${s.dir ? ` dir=${s.dir}` : ''}\n`,
        );
        if (s.runtimeNotice) {
          process.stdout.write(`  notice: ${s.runtimeNotice}\n`);
        }
      }
      return;
    }

    if (sub === 'download') {
      const requested = positionals[2] ?? 'all';
      const targetIds: DaemonBundleId[] =
        requested === 'all'
          ? (Object.keys(DAEMON_MODEL_BUNDLES) as DaemonBundleId[])
          : [requested as DaemonBundleId];

      for (const id of targetIds) {
        const spec = DAEMON_MODEL_BUNDLES[id];
        if (!spec) {
          throw new Error(`Unknown model bundle "${id}"`);
        }
        if (spec.runtimeNotice) {
          process.stdout.write(`Notice (${id}): ${spec.runtimeNotice}\n`);
        }
        const dir = await downloadModelBundle(id, {
          ...cacheOpts,
          ...(values.mirror ? { preferredHost: values.mirror } : {}),
          onProgress: (file, index, total) => {
            process.stdout.write(`[${id}] (${index}/${total}) downloading ${file}...\n`);
          },
        });
        process.stdout.write(`[${id}] verified in ${dir}\n`);
      }
      return;
    }

    throw new Error(`Unknown models subcommand "${sub}"`);
  }

  if (cmd === 'serve') {
    const port = values.port ? Number.parseInt(values.port, 10) : DEFAULT_DAEMON_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid port: "${values.port ?? ''}"`);
    }
    const tokenPath = values['token-file'] ?? defaultDaemonTokenPath();
    const serverOpts = {
      host: values.host ?? DEFAULT_DAEMON_HOST,
      port,
      tokenPath,
      ...(values.token ? { token: values.token } : {}),
      ...(values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {}),
    };

    const handle = await startVoiceDaemonServer(serverOpts);
    process.stdout.write(
      `voice-daemon v${DAEMON_VERSION} listening on http://${handle.host}:${handle.port} (auth=bearer:${tokenPath})\n`,
    );

    const shutdown = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run voice-daemon --help for usage.`);
}

main().catch((err: unknown) => {
  const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
  process.stderr.write(`voice-daemon error: ${safeMsg}\n`);
  process.exit(1);
});
