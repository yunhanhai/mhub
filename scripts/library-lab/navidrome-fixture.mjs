// A fresh real Navidrome instance. Never accepts an existing database/library.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat } from 'node:fs/promises';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
  (error, stdout) => error ? reject(new Error('Fixture tool failed: ' + path.basename(file))) : resolve(stdout.trim())));

export async function startNavidromeFixture() {
  const executable = process.env.NAVIDROME_EXECUTABLE;
  assert.ok(executable, 'Set NAVIDROME_EXECUTABLE to an existing Navidrome binary');
  const version = await command(executable, ['--version']);
  const directory = await mkdtemp(path.join(tmpdir(), 'mhub-navidrome-'));
  const expected = await realpath(directory), music = path.join(directory, 'music'), empty = path.join(directory, 'empty');
  let child, closed, logs = '', appOrigin, administrator, lastLogin = 0, removed = false;
  const users = {};
  const fixture = { directory, music, version, executableSHA256: hash(await readFile(executable)),
    originals: [], accounts: users, instanceId: randomUUID(), source: null,
    get origin() { return appOrigin; },
    get pid() { return child?.pid; },
    get cleanup() { return { removed, childClosed: !child || child.exitCode !== null || child.signalCode !== null, logSHA256: hash(logs) }; },
    async paced(action) {
      await pause(Math.max(0, 8500 - (Date.now() - lastLogin))); lastLogin = Date.now(); return action();
    },
    async native(route, method = 'GET', data) {
      const response = await fetch(appOrigin + '/api/' + route, { method,
        headers: { 'x-nd-authorization': 'Bearer ' + administrator.token, 'content-type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15000) });
      assert.ok(response.ok, 'Owned Navidrome administration HTTP ' + response.status);
      const body = await response.text(); return body ? JSON.parse(body) : null;
    },
    async subsonic(role, method, extra = {}) {
      const user = role === 'admin' ? { auth: { username: administrator.username, salt: administrator.subsonicSalt, token: administrator.subsonicToken } } : users[role];
      assert.ok(user?.auth);
      const response = await fetch(appOrigin + '/rest/' + method + '.view', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ u: user.auth.username, s: user.auth.salt, t: user.auth.token, v: '1.16.1', c: 'mhub-isolated-test', f: 'json', ...extra }),
        signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, bytes, value: /json/.test(response.headers.get('content-type') || '') ? JSON.parse(bytes)['subsonic-response'] : null };
    },
    async close() {
      if (removed) return;
      if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) await closed;
      const current = await realpath(directory);
      assert.ok(current === expected && path.basename(current).startsWith('mhub-navidrome-'), 'Disposable fixture path must match');
      await rm(current, { recursive: true, force: true, maxRetries: 3 }); removed = true;
    },
  };
  try {
    await mkdir(music); await mkdir(empty);
    for (const [index, title] of ['First Light', 'Slow River', 'Long Journey'].entries()) {
      const format = index === 0 ? 'mp3' : 'flac', file = path.join(music, 'generated-' + index + '.' + format);
      await command(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', `sine=frequency=${220 + index * 100}:duration=6`, '-ar', '44100', '-ac', '1', '-metadata', 'title=' + title,
        '-metadata', 'artist=Generated Navidrome fixture', '-metadata', 'album=Disposable integration signals', '-y', file]);
      const bytes = await readFile(file);
      fixture.originals.push({ file, title, format, size: bytes.length, sha256: hash(bytes), duration: 6000, modifiedAt: (await stat(file)).mtime.toISOString() });
    }
    const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); appOrigin = 'http://127.0.0.1:' + port;
    const config = path.join(directory, 'navidrome.toml');
    const tomlPath = value => JSON.stringify(value.replaceAll('\\', '/'));
    await writeFile(config, ['Address = "127.0.0.1"', 'Port = ' + port, 'DataFolder = ' + tomlPath(path.join(directory, 'data')),
      'MusicFolder = ' + tomlPath(music), 'CacheFolder = ' + tomlPath(path.join(directory, 'cache')), 'LogLevel = "warn"',
      'EnableExternalServices = false', 'EnableInsightsCollector = false', 'EnableSharing = false', 'EnableGravatar = false',
      'FFmpegPath = ' + tomlPath(process.env.FFMPEG_EXECUTABLE || 'ffmpeg'), '[Scanner]', 'Schedule = "0"'].join('\n') + '\n');
    // Do not inherit another instance's ND_* settings into this new database.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ND_/i.test(key)));
    child = spawn(executable, ['--configfile', config], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError;
    closed = new Promise(resolve => child.once('close', resolve)); child.once('error', error => { launchError = error.code; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-24000); });
    let healthy = false;
    for (let index = 0; index < 200; index++) {
      if (launchError || child.exitCode !== null) throw new Error('Disposable Navidrome launch failed');
      try { healthy = (await fetch(appOrigin + '/ping', { signal: AbortSignal.timeout(500) })).status === 200; } catch {}
      if (healthy) break; await pause(100);
    }
    assert.ok(healthy, 'Disposable Navidrome must become healthy');
    const initial = { username: 'generated-admin', password: randomBytes(24).toString('base64url') };
    const created = await fixture.paced(() => fetch(appOrigin + '/auth/createAdmin', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(initial), signal: AbortSignal.timeout(10000) }));
    assert.equal(created.status, 200, 'Initialize only this brand-new Navidrome database');
    administrator = await created.json(); assert.equal(administrator.isAdmin, true);
    const libraries = await fixture.native('library');
    const audioLibrary = libraries.find(l => path.resolve(l.path) === path.resolve(music)); assert.ok(audioLibrary);
    const emptyLibrary = await fixture.native('library', 'POST', { name: 'Generated empty library', path: empty, defaultNewUsers: false });
    fixture.libraries = { audio: Number(audioLibrary.id), empty: Number(emptyLibrary.id) };
    for (const role of ['service', 'a', 'b']) {
      const user = { username: 'generated-' + role, password: randomBytes(24).toString('base64url') };
      const created = await fixture.native('user', 'POST', { userName: user.username, name: 'Generated ' + role, password: user.password, isAdmin: false });
      const verified = await fixture.native('user/' + created.id); assert.equal(verified.isAdmin, false);
      await fixture.native('user/' + created.id + '/library', 'PUT', { libraryIds: [fixture.libraries.audio] });
      const response = await fixture.paced(() => fetch(appOrigin + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(user), signal: AbortSignal.timeout(10000) }));
      assert.equal(response.status, 200, 'Real native non-admin login');
      const session = await response.json(); assert.equal(session.isAdmin, false); assert.equal(session.id, created.id);
      users[role] = { ...user, id: session.id, auth: { username: session.username, salt: session.subsonicSalt, token: session.subsonicToken } };
    }
    fixture.source = { instanceId: fixture.instanceId, baseUrl: appOrigin, auth: users.service.auth };
    assert.equal((await fixture.subsonic('admin', 'startScan')).value.status, 'ok');
    let songs = [];
    for (let index = 0; index < 150; index++) {
      const scan = await fixture.subsonic('admin', 'getScanStatus');
      const result = await fixture.subsonic('service', 'search3', { query: '""', songCount: '100', albumCount: '0', artistCount: '0' });
      songs = result.value?.searchResult3?.song || [];
      if (!scan.value.scanStatus.scanning && songs.length === 3) break; await pause(200);
    }
    for (const original of fixture.originals) { const song = songs.find(s => s.title === original.title); assert.ok(song, 'Generated original must be indexed'); original.songId = song.id; }
    return fixture;
  } catch (error) { await fixture.close(); error.fixtureCleanup = fixture.cleanup; throw error; }
}
