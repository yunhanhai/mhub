// One external contract suite, selectable between the Node reference and the
// actual music-api executable. Rust diagnostics stay in private local files.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryLab } from './server.mjs';

export const rustBackend = process.env.LIBRARY_BACKEND === 'rust';
export const apiBase = rustBackend ? '/api/v1/library' : '/api';
export const cookieName = rustBackend ? 'mhub_library_session' : 'mhub_lab_session';
export const clientHeader = rustBackend ? 'x-mhub-library' : 'x-library-lab';
export function apiRoute(route) { return route.replace(/^\/api(?=\/(?:tasks|search|session)(?:\/|\?|$))/, apiBase); }
export function forbidsStorage(value) { return String(value || '').split(',').some(part => part.trim().toLowerCase() === 'no-store'); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function createBackend(config, options) {
  if (!rustBackend) return createLibraryLab(config, options);
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const directory = await mkdtemp(path.join(path.dirname(config.cacheDir), 'rust-service-'));
  const privateDirectory = await mkdtemp(path.join(tmpdir(), 'mhub-rust-session-'));
  const configFile = path.join(privateDirectory, 'library.json'), settings = path.join(privateDirectory, 'config.toml'), metricsFile = path.join(directory, 'metrics.json');
  const removePrivate = async () => {
    await unlink(configFile).catch(() => {});
    await unlink(settings).catch(() => {});
    await rmdir(privateDirectory).catch(() => {});
  };
  try {
    await writeFile(configFile, JSON.stringify({ origin: options?.origin || origin, source: config.source, policyFile: config.policyFile, cacheDir: config.cacheDir, cacheMaxBytes: config.cacheMaxBytes,
      sessionTtlSeconds: config.sessionTtlSeconds, taskTtlSeconds: config.taskTtlSeconds }), { mode: 0o600 });
    await writeFile(settings, '[library]\nconfig_file = ' + JSON.stringify(configFile.replaceAll('\\', '/')) + '\nexclusive = ' + Boolean(options?.exclusive) + '\n', { mode: 0o600 });
  } catch (error) { await removePrivate(); throw error; }
  let child, closing, processClosed = Promise.resolve(), logs = '', lastMetrics = {};
  const executable = process.env.MHUB_RUST_BINARY || path.join(repo, 'target', 'debug', process.platform === 'win32' ? 'music-api.exe' : 'music-api');
  const app = {
    get pid() { return child?.pid; },
    get metricsFile() { return metricsFile; },
    get metrics() {
      try { lastMetrics = JSON.parse(readFileSync(metricsFile, 'utf8')); } catch {}
      return lastMetrics;
    },
    async start() {
      try {
        child = spawn(executable, [], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MUSIC_API_BIND: '127.0.0.1:' + port, MUSIC_API_CONFIG: settings,
            MUSIC_API_DATA_DIR: path.join(directory, 'data'), MUSIC_API_SERVE_WEB: 'true', MUSIC_API_LIBRARY_METRICS_FILE: metricsFile,
            RUST_LOG: 'music_api=warn,tower_http=warn' } });
        processClosed = new Promise(resolve => child.once('close', resolve));
        let launchError;
        child.on('error', error => { launchError = error.code; });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-16000); });
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (launchError || child.exitCode !== null) throw new Error('Rust service failed to start: ' + (launchError || child.exitCode) + '\n' + logs);
          try { const r = await fetch(origin + '/health', { signal: AbortSignal.timeout(700) }); if (r.status === 200) return origin; } catch {}
          await new Promise(resolve => setTimeout(resolve, 75));
        }
        throw new Error('Rust service startup timeout');
      } catch (error) { await app.close(); throw error; }
    },
    async crash() {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('No owned running Rust child to terminate');
      child.kill('SIGKILL'); await processClosed;
    },
    async close() {
      closing ??= (async () => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
        await processClosed;
        try { await writeFile(path.join(directory, 'service.log'), logs); }
        finally { await removePrivate(); }
      })();
      await closing;
    },
  };
  return app;
}
