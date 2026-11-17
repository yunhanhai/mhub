/** Owned, disposable Navidrome identities and originals for multi-user trials.
 * SOURCE_ADMIN_CREDENTIALS=... node multi-user-fixtures.mjs prepare|cleanup CONFIG STATE PARENT OUTPUT
 * All credentials and recovery state stay in STATE outside the repository.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rmdir, unlink, stat, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { json, pause, digest, request } from './resource-client.mjs';
import { apiBase } from './backend.mjs';

export const loginGapMs = 8500;
let lastLogin = 0;
export async function pacedLogin(action) {
  await pause(Math.max(0, loginGapMs - (Date.now() - lastLogin)));
  lastLogin = Date.now();
  return action();
}
export async function clientFor(app, fixture, role, logins) {
  const account = fixture.accounts[role]; assert.ok(account && !account.isAdmin);
  const client = { origin: app.origin, role };
  const response = await pacedLogin(() => request(client, apiBase + '/session', { method: 'POST', data: { username: account.username, password: account.password } }));
  logins?.push({ role, status: response.status, userMatches: response.value?.user?.id === account.id });
  assert.equal(response.status, 200, 'Owned native login for ' + role);
  assert.equal(response.value.user.id, account.id, 'Rust must return the real upstream identity');
  client.cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(client.cookie);
  return client;
}
export function fixtureConfig(base, fixture) {
  assert.ok(fixture.ready && !fixture.removedAt);
  return { ...base, source: fixture.source };
}
export async function administrator(base) {
  assert.ok(['127.0.0.1', '[::1]'].includes(new URL(base.source.baseUrl).hostname));
  assert.ok(process.env.SOURCE_ADMIN_CREDENTIALS, 'Explicit fixture administrator required');
  const credentials = await json(process.env.SOURCE_ADMIN_CREDENTIALS);
  const response = await pacedLogin(() => fetch(base.source.baseUrl + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }), signal: AbortSignal.timeout(15000),
  }));
  assert.equal(response.status, 200, 'Owned fixture administrator login');
  const session = await response.json(); assert.equal(session.isAdmin, true);
  const headers = Object.fromEntries([...response.headers].filter(([name]) => /^(?:x-)?ratelimit-|^retry-after$/.test(name)));
  return {
    headers,
    auth: { username: session.username, salt: session.subsonicSalt, token: session.subsonicToken },
    async native(route, method = 'GET', body) {
      const response = await fetch(base.source.baseUrl + '/api/' + route, {
        method, headers: { 'x-nd-authorization': 'Bearer ' + session.token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
      });
      assert.ok(response.ok, 'Owned fixture administration: ' + method + ' HTTP ' + response.status);
      const text = await response.text(); return text ? JSON.parse(text) : null;
    },
  };
}
export async function source(base, auth, method, extra = {}) {
  const response = await fetch(base.source.baseUrl + '/rest/' + method + '.view', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ u: auth.username, s: auth.salt, t: auth.token, v: '1.16.1', c: 'mhub-multi-user-test', f: 'json', ...extra }),
    signal: AbortSignal.timeout(25000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, value: /json/.test(response.headers.get('content-type') || '') ? JSON.parse(bytes)['subsonic-response'] : null };
}
async function rescan(base, admin) {
  assert.equal((await source(base, admin.auth, 'startScan')).value?.status, 'ok');
  for (let index = 0; index < 300; index++) {
    const result = await source(base, admin.auth, 'getScanStatus');
    assert.equal(result.value?.status, 'ok');
    if (!result.value.scanStatus.scanning) return;
    await pause(200);
  }
  throw new Error('Owned fixture scan deadline');
}
async function existingState(admin, exclude = { users: [], libraries: [] }) {
  const users = (await admin.native('user')).filter(user => !exclude.users.includes(user.id));
  const libraries = (await admin.native('library')).filter(library => !exclude.libraries.includes(Number(library.id)));
  const accounts = [];
  for (const user of users) accounts.push({ id: user.id, username: user.userName, isAdmin: user.isAdmin,
    libraryIds: (await admin.native('user/' + encodeURIComponent(user.id) + '/library')).map(library => Number(library.id)).filter(id => !exclude.libraries.includes(id)).sort((a, b) => a - b) });
  return { users: accounts.sort((a, b) => a.id.localeCompare(b.id)), libraries: libraries.map(library => ({ id: Number(library.id), name: library.name, path: library.path, defaultNewUsers: Boolean(library.defaultNewUsers) })).sort((a, b) => a.id - b.id) };
}
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function ffmpeg(arguments_) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...arguments_], { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, 'Owned signal generation/decoding must succeed');
  return result.stdout.toString().trim();
}

async function main() {
  const [mode, configFile, stateFile, parent, output] = process.argv.slice(2);
  assert.ok(['prepare', 'cleanup'].includes(mode) && [configFile, stateFile, parent, output].every(Boolean));
  const base = await json(configFile), root = await realpath(parent);
  await mkdir(output, { recursive: true });
  const admin = await administrator(base);
  if (mode === 'prepare') {
    try { await stat(stateFile); throw new Error('Use a fresh private state file'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const previous = await existingState(admin), directory = await mkdtemp(path.join(root, 'MultiUser-'));
    const tag = 'mhub-mu-' + randomBytes(5).toString('hex');
    const state = { recordedAt: new Date().toISOString(), tag, directory, previous, ready: false,
      libraries: {}, accounts: {}, files: [], tracks: [], source: { instanceId: randomUUID(), baseUrl: base.source.baseUrl } };
    await save(stateFile, state);
    for (const kind of ['audio', 'empty']) {
      const folder = path.join(directory, kind); await mkdir(folder);
      const name = 'MHub multi-user ' + tag + ' ' + kind;
      const library = await admin.native('library', 'POST', { name, path: folder, defaultNewUsers: false });
      assert.ok(Number.isInteger(Number(library.id)) && Number(library.id) > 0);
      state.libraries[kind] = { id: Number(library.id), name, path: folder }; await save(stateFile, state);
    }
    for (const role of ['service', ...Array.from({ length: 8 }, (_, i) => 'u' + (i + 1))]) {
      const account = { username: tag + '-' + role, password: randomBytes(24).toString('base64url'), isAdmin: false };
      assert.ok(!(await admin.native('user')).some(user => user.userName === account.username), 'Never reuse another account');
      state.accounts[role] = account; await save(stateFile, state);
      const created = await admin.native('user', 'POST', { userName: account.username, name: 'MHub multi-user fixture ' + role, password: account.password, isAdmin: false });
      assert.ok(created.id); account.id = created.id; await save(stateFile, state);
      const verified = await admin.native('user/' + encodeURIComponent(account.id));
      assert.equal(verified.userName, account.username); assert.equal(verified.isAdmin, false);
      await admin.native('user/' + encodeURIComponent(account.id) + '/library', 'PUT', { libraryIds: [state.libraries.audio.id] });
    }
    for (let index = 0; index < 20; index++) {
      const label = 'track-' + String(index + 1).padStart(2, '0'), file = path.join(state.libraries.audio.path, label + '.flac');
      const title = tag + ' ' + label;
      ffmpeg(['-n', '-f', 'lavfi', '-i', `aevalsrc=0.7*random(0)+0.2*sin(2*PI*${200 + index * 13}*t)|0.7*random(1)+0.2*sin(2*PI*${260 + index * 17}*t):s=48000:d=24`,
        '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '0', '-metadata', 'title=' + title, '-metadata', 'artist=Music Lab Multi-User', file]);
      const bytes = await readFile(file);
      const decoded = ffmpeg(['-i', file, '-f', 'hash', '-hash', 'sha256', '-']); assert.match(decoded, /^SHA256=[a-f0-9]{64}$/);
      state.files.push({ label, title, file, bytes: bytes.length, sha256: digest(bytes), decodedPcmSHA256: decoded.slice(7) });
      await save(stateFile, state);
      assert.ok(bytes.length >= 2 * 1024 * 1024 && bytes.length <= 5 * 1024 * 1024);
    }
    assert.ok(state.files.reduce((sum, file) => sum + file.bytes, 0) < 110 * 1024 * 1024);
    await rescan(base, admin);
    const authHeaders = [];
    for (const [role, account] of Object.entries(state.accounts)) {
      const response = await pacedLogin(() => fetch(base.source.baseUrl + '/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: account.username, password: account.password }), signal: AbortSignal.timeout(15000),
      }));
      authHeaders.push({ role, status: response.status, headers: Object.fromEntries([...response.headers].filter(([name]) => /^(?:x-)?ratelimit-|^retry-after$/.test(name))) });
      assert.equal(response.status, 200, 'Owned native fixture login for ' + role);
      const value = await response.json(); assert.equal(value.id, account.id); assert.equal(value.isAdmin, false);
      account.sourceAuth = { username: value.username, salt: value.subsonicSalt, token: value.subsonicToken };
      await save(stateFile, state);
      console.log(JSON.stringify({ verifiedRealIdentity: role, nonAdmin: true }));
    }
    state.source.auth = state.accounts.service.sourceAuth;
    const found = await source(base, state.source.auth, 'search3', { query: tag, songCount: '100', albumCount: '0', artistCount: '0' });
    assert.equal(found.value?.status, 'ok');
    const ids = Object.entries(state.accounts).filter(([role]) => role !== 'service').map(([, account]) => account.id);
    for (const file of state.files) {
      const song = found.value.searchResult3?.song?.find(song => song.title === file.title); assert.ok(song);
      const response = await source(base, state.source.auth, 'stream', { id: song.id, format: 'raw' });
      assert.equal(response.status, 200); assert.equal(digest(response.bytes), file.sha256);
      state.tracks.push({ songId: song.id, title: file.title, artist: 'Music Lab Multi-User', duration: 24000,
        format: 'flac', contentType: 'audio/flac', size: file.bytes, sha256: file.sha256,
        modifiedAt: (await stat(file.file)).mtime.toISOString(), access: 'restricted', allowedUserIds: ids });
    }
    const unchanged = await existingState(admin, { users: Object.values(state.accounts).map(account => account.id), libraries: Object.values(state.libraries).map(library => library.id) });
    assert.deepEqual(unchanged, previous, 'Existing users and libraries must be preserved');
    state.ready = true; await save(stateFile, state);
    await save(path.join(output, 'fixture-setup.json'), { recordedAt: new Date().toISOString(), prepared: true,
      realNonAdminUsers: 8, dedicatedNonAdminService: true, allSourceOriginalsVerified: true,
      totalBytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
      originals: state.files.map(({ label, bytes, sha256, decodedPcmSHA256 }) => ({ label, bytes, sha256, decodedPcmSHA256 })),
      existingUsersAndLibrariesPreserved: true, previousStateSHA256: digest(Buffer.from(JSON.stringify(previous))),
      loginGapMs, authHeaders, administratorRateHeaders: admin.headers });
    console.log(JSON.stringify({ prepared: true, users: 8, originals: state.files.length, allSourceOriginalsVerified: true }));
  } else {
    const state = await json(stateFile); assert.ok(!state.removedAt);
    const directory = await realpath(state.directory);
    assert.equal(path.dirname(directory).toLowerCase(), root.toLowerCase()); assert.ok(path.basename(directory).startsWith('MultiUser-'));
    const users = await admin.native('user');
    for (const account of Object.values(state.accounts)) {
      const user = users.find(user => user.id === account.id || user.userName === account.username);
      if (!user) continue;
      assert.equal(user.userName, account.username); assert.ok(user.userName.startsWith(state.tag + '-')); assert.equal(user.isAdmin, false);
      if (account.id) assert.equal(user.id, account.id);
      await admin.native('user/' + encodeURIComponent(user.id), 'DELETE');
    }
    const libraries = await admin.native('library');
    for (const library of Object.values(state.libraries)) {
      const current = libraries.find(value => Number(value.id) === library.id);
      if (!current) continue;
      assert.equal(current.name, library.name); assert.equal(path.resolve(current.path).toLowerCase(), path.resolve(library.path).toLowerCase());
      assert.equal(path.dirname(path.resolve(library.path)).toLowerCase(), directory.toLowerCase());
      await admin.native('library/' + library.id, 'DELETE');
    }
    const audio = state.libraries.audio.path, empty = state.libraries.empty.path;
    assert.deepEqual((await readdir(audio)).sort(), state.files.map(file => path.basename(file.file)).sort(), 'Never delete unexpected files');
    assert.deepEqual(await readdir(empty), []);
    for (const file of state.files) {
      assert.equal(path.dirname(path.resolve(file.file)).toLowerCase(), path.resolve(audio).toLowerCase());
      assert.equal(digest(await readFile(file.file)), file.sha256);
      await unlink(file.file);
    }
    await rmdir(audio); await rmdir(empty); assert.deepEqual(await readdir(directory), []); await rmdir(directory);
    await rescan(base, admin);
    assert.deepEqual(await existingState(admin), state.previous, 'Restore the exact original users and library assignments');
    state.removedAt = new Date().toISOString(); await save(stateFile, state);
    await save(path.join(output, 'fixture-cleanup.json'), { recordedAt: state.removedAt, removedNonAdminAccounts: Object.keys(state.accounts).length,
      removedLibraries: Object.keys(state.libraries).length, removedOriginals: state.files.length,
      fileHashesChecked: true, ownedDirectoryRemoved: true, rescanned: true, existingUsersAndLibrariesPreserved: true,
      restoredStateSHA256: digest(Buffer.from(JSON.stringify(state.previous))) });
    console.log(JSON.stringify({ removedAccounts: Object.keys(state.accounts).length, removedLibraries: 2, removedOriginals: state.files.length, existingUsersAndLibrariesPreserved: true }));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
