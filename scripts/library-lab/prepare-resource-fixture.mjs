/** Prepare/remove one explicitly owned large FLAC for resource experiments.
 * SOURCE_ADMIN_CREDENTIALS=... node prepare-resource-fixture.mjs prepare CONFIG MUSIC_ROOT STATE_FILE
 * SOURCE_ADMIN_CREDENTIALS=... node prepare-resource-fixture.mjs cleanup CONFIG MUSIC_ROOT STATE_FILE
 * STATE_FILE is private; no authentication values are written to it.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [mode, configPath, musicRootPath, statePath] = process.argv.slice(2);
assert.ok(['prepare', 'cleanup'].includes(mode));
assert.ok(process.env.SOURCE_ADMIN_CREDENTIALS, 'Explicit owned source administrator required');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = await json(configPath), admin = await json(process.env.SOURCE_ADMIN_CREDENTIALS);
assert.ok(['127.0.0.1', '[::1]'].includes(new URL(config.source.baseUrl).hostname));
const musicRoot = await realpath(musicRootPath);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let auth;
async function login() {
  const response = await fetch(config.source.baseUrl + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: admin.username, password: admin.password }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'Owned administrator login');
  const identity = await response.json();
  auth = { u: identity.username, s: identity.subsonicSalt, t: identity.subsonicToken };
}
async function source(method, extra = {}) {
  const response = await fetch(config.source.baseUrl + '/rest/' + method + '.view', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...auth, v: '1.16.1', c: 'mhub-resource-fixture', f: 'json', ...extra }),
    signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, 200);
  if (method === 'stream') return Buffer.from(await response.arrayBuffer());
  const value = (await response.json())['subsonic-response'];
  assert.equal(value?.status, 'ok', 'Owned source operation');
  return value;
}
async function scan() {
  await source('startScan');
  for (let n = 0; n < 150; n++) {
    if (!(await source('getScanStatus')).scanStatus.scanning) return;
    await pause(200);
  }
  throw new Error('Owned fixture scan timed out');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const seconds = Number(process.env.RESOURCE_FIXTURE_SECONDS || 90);
assert.ok(Number.isInteger(seconds) && seconds >= 90 && seconds <= 300, 'Owned fixture duration: 90..300 seconds');
await login();
if (mode === 'cleanup') {
  const state = await json(statePath), directory = await realpath(state.directory);
  assert.equal(path.dirname(directory).toLowerCase(), musicRoot.toLowerCase());
  assert.ok(path.basename(directory).startsWith('Resource-'));
  const names = await readdir(directory);
  assert.deepEqual(names, ['resource.flac'], 'Do not delete unexpected files');
  assert.equal(digest(await readFile(path.join(directory, 'resource.flac'))), state.track.sha256);
  await unlink(path.join(directory, 'resource.flac')); await rmdir(directory); await scan();
  await writeFile(statePath, JSON.stringify({ ...state, removedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(JSON.stringify({ removedOwnedFixture: true, rescanned: true }));
} else {
  try { await stat(statePath); throw new Error('Fixture state already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(statePath), { recursive: true });
  const directory = await mkdtemp(path.join(musicRoot, 'Resource-'));
  const file = path.join(directory, 'resource.flac'), title = 'MHub ' + path.basename(directory);
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i',
    'aevalsrc=random(0)|random(1):s=48000:d=' + seconds, '-c:a', 'flac', '-sample_fmt', 's16',
    '-compression_level', '0', '-metadata', 'title=' + title, '-metadata', 'artist=Music Lab', file],
  { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(run.status, 0, 'Generate an owned valid FLAC');
  const bytes = await readFile(file);
  assert.ok(bytes.length > 8 * 1024 * 1024 && bytes.length <= 32 * 1024 * 1024);
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'hash', '-hash', 'sha256', '-'],
    { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0); assert.match(decoded.stdout.toString(), /^SHA256=/);
  await scan();
  const result = await source('search3', { query: title, songCount: '100', albumCount: '0', artistCount: '0' });
  const song = result.searchResult3?.song?.find(value => value.title === title); assert.ok(song);
  const raw = await source('stream', { id: song.id, format: 'raw' });
  assert.equal(digest(raw), digest(bytes));
  const oldPolicy = await json(config.policyFile), restricted = oldPolicy.tracks.find(value => value.access === 'restricted');
  assert.ok(restricted.allowedUserIds.length);
  const track = { songId: song.id, title, artist: 'Music Lab', duration: seconds * 1000, format: 'flac', contentType: 'audio/flac',
    size: bytes.length, sha256: digest(bytes), modifiedAt: (await stat(file)).mtime.toISOString(),
    access: 'restricted', allowedUserIds: restricted.allowedUserIds };
  await writeFile(statePath, JSON.stringify({ recordedAt: new Date().toISOString(), directory, file,
    track, decodedPcmSHA256: decoded.stdout.toString().trim(), sourceMatches: true }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, bytes: bytes.length, sha256: track.sha256, sourceMatches: true }));
}
