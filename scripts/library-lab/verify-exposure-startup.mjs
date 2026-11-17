/** Real child-process startup checks. No source credentials or external services. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [output] = process.argv.slice(2);
if (!output) throw new Error('Expected a new report directory');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'startup-run-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = process.env.MHUB_RUST_BINARY || path.join(repo, 'target/debug', process.platform === 'win32' ? 'music-api.exe' : 'music-api');
const checks = [], cases = [];
const report = { recordedAt: new Date().toISOString(), scope: 'Owned loopback Rust children; no credentials and no upstream requests.', checks, cases };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
for (const item of [
  { name: 'explicit missing config fails closed', kind: 'missing', reject: true },
  { name: 'explicit directory instead of config fails closed', kind: 'directory', reject: true },
  { name: 'invalid TOML fails closed', text: '[library', reject: true },
  { name: 'misspelled library section fails closed', text: '[libray]\nexclusive=true\n', reject: true },
  { name: 'misspelled exposure option fails closed', text: '[library]\nexclusiv=true\n', reject: true },
  { name: 'exclusive mode without its library config fails closed', text: '[library]\nexclusive=true\n', reject: true },
  { name: 'implicit absent development config remains supported', kind: 'implicit', reject: false },
  { name: 'explicit valid combined-mode config remains supported', text: '[library]\nexclusive=false\n', reject: false },
]) {
  const directory = await mkdtemp(path.join(run, 'case-'));
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  const file = path.join(directory, 'settings.toml');
  if (item.text !== undefined) await writeFile(file, item.text);
  const env = { ...process.env, MUSIC_API_BIND: '127.0.0.1:' + port, MUSIC_API_SERVE_WEB: 'false', MUSIC_API_DATA_DIR: path.join(directory, 'data'), RUST_LOG: 'music_api=warn,tower_http=warn' };
  if (item.kind === 'implicit') delete env.MUSIC_API_CONFIG;
  else env.MUSIC_API_CONFIG = item.kind === 'directory' ? path.resolve(directory) : path.resolve(file);
  let logs = '', launchError, healthy = false, platformStatus = null;
  const child = spawn(binary, [], { cwd: path.resolve(directory), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => { launchError = error.code; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-16000); });
  try {
    const end = Date.now() + 12000;
    while (Date.now() < end && !launchError && child.exitCode === null) {
      try {
        const result = await fetch(origin + '/health', { signal: AbortSignal.timeout(500) });
        if (result.status === 200) { healthy = true; break; }
      } catch {}
      await pause(60);
    }
    if (healthy) platformStatus = (await fetch(origin + '/api/v1/platforms', { signal: AbortSignal.timeout(1000) })).status;
    const rejected = !healthy && !launchError && child.exitCode !== null && child.exitCode !== 0;
    checks.push({ name: item.name, passed: item.reject ? rejected : healthy, details: { healthy, platformStatus, exitCodeBeforeCleanup: child.exitCode, launchError: launchError || null } });
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    cases.push({ name: item.name, logFile: path.relative(output, path.join(directory, 'service.log')).split(path.sep).join('/'), logsSHA256: createHash('sha256').update(logs).digest('hex'), configReadFailure: logs.includes('failed to read config'), configParseFailure: logs.includes('failed to parse config'), exclusiveConfigFailure: logs.includes('library.exclusive requires'), childClosed: true });
    await writeFile(path.join(directory, 'service.log'), logs);
  }
}
report.checkCount = checks.length;
report.passed = checks.every(check => check.passed) && cases.every(item => item.childClosed);
await writeFile(path.join(output, 'exposure-startup.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failedChecks: checks.filter(check => !check.passed).map(check => check.name) }, null, 2));
if (!report.passed) process.exitCode = 1;
