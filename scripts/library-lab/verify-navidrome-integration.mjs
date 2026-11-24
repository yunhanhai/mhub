// New real Navidrome database + real Rust music-api + actual browser.
// LIBRARY_BACKEND=rust NAVIDROME_EXECUTABLE=... node verify-navidrome-integration.mjs REPORT_DIR
// PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, MHUB_RUST_BINARY and FFMPEG_EXECUTABLE
// select existing tools. Never reuses a running Navidrome or personal music.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { startNavidromeFixture } from './navidrome-fixture.mjs';
import { createBackend, rustBackend, apiBase } from './backend.mjs';

assert.ok(rustBackend, 'Set LIBRARY_BACKEND=rust');
const output = process.argv[2]; assert.ok(output, 'Expected REPORT_DIR'); await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  scope: 'New disposable real Navidrome database/accounts/library, real Rust music-api and actual desktop browser, generated MP3/FLAC. No simulated API/source, existing user library, production deployment, phone or spoken screen-reader verification.' };
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) }); assert.ok(passed, name); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let fixture, app, browser, origin, assignmentChanged = false;
const contexts = [], cookies = {}, browserTasks = new Set(), taskResponses = [], externalRequests = [];
try {
  fixture = await startNavidromeFixture();
  report.navidrome = { version: fixture.version, executableSHA256: fixture.executableSHA256, freshDatabase: true, nonAdminServiceAndUsers: true };
  console.log(JSON.stringify({ stage: 'fresh-navidrome-ready', version: fixture.version, originals: fixture.originals.length }));
  for (const original of fixture.originals) {
    const response = await fixture.subsonic('service', 'stream', { id: original.songId, format: 'raw' });
    check('real Navidrome preserves original ' + original.format + ': ' + original.title,
      response.status === 200 && response.bytes.length === original.size && digest(response.bytes) === original.sha256);
  }
  const tracks = fixture.originals.map((original, index) => ({ songId: original.songId, title: original.title, artist: 'Generated Navidrome fixture',
    duration: original.duration, format: original.format, contentType: original.format === 'mp3' ? 'audio/mpeg' : 'audio/flac',
    size: original.size, sha256: original.sha256, modifiedAt: original.modifiedAt,
    access: index === 2 ? 'restricted' : 'public', allowedUserIds: index === 2 ? [fixture.accounts.a.id] : [] }));
  const policyFile = path.join(fixture.directory, 'policy.json');
  await writeFile(policyFile, JSON.stringify({ instanceId: fixture.instanceId, tracks }));
  app = await createBackend({ source: fixture.source, policyFile, cacheDir: path.join(fixture.directory, 'rust-cache') }, { exclusive: true });
  origin = await app.start();
  report.rust = { executableSHA256: digest(await readFile(process.env.MHUB_RUST_BINARY || path.resolve('target/debug', process.platform === 'win32' ? 'music-api.exe' : 'music-api'))) };
  const exchange = async (route, { method = 'GET', role, data, headers = {} } = {}) => {
    const r = await fetch(origin + route, { method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { origin, 'x-mhub-library': '1', ...(cookies[role] ? { cookie: cookies[role] } : {}),
        ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const bytes = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, bytes, body: /json/.test(r.headers.get('content-type') || '') && bytes.length ? JSON.parse(bytes) : null };
  };
  const selection = entry => ({ instanceId: fixture.instanceId, songId: entry.songId, version: entry.sha256 });
  const create = async (entry, role) => {
    const accepted = await exchange(apiBase + '/tasks', { method: 'POST', role, data: selection(entry) });
    assert.equal(accepted.status, 202); let task = accepted.body;
    for (let index = 0; task.state === 'preparing' && index < 100; index++) {
      await new Promise(resolve => setTimeout(resolve, 50)); task = (await exchange(apiBase + '/tasks/' + task.id, { role })).body;
    }
    return task;
  };
  check('real Rust anonymous catalogue exposes only public entries', (await exchange(apiBase + '/search')).body.tracks.length === 2);
  for (const role of ['a', 'b']) {
    const account = fixture.accounts[role];
    const r = await fixture.paced(() => exchange(apiBase + '/session', { method: 'POST', data: { username: account.username, password: account.password } }));
    check(role + ' authenticates through Rust to real Navidrome', r.status === 200 && r.body.user.id === account.id);
    cookies[role] = r.headers.get('set-cookie').split(';')[0];
  }
  check('real source results remain filtered by application ACL', (await exchange(apiBase + '/search', { role: 'a' })).body.tracks.length === 3
    && (await exchange(apiBase + '/search', { role: 'b' })).body.tracks.length === 2);
  const privateTask = await create(tracks[2], 'a'); check('private original becomes ready through actual Navidrome', privateTask.state === 'ready');
  const privateRoute = privateTask.mediaUrl.startsWith('/') ? privateTask.mediaUrl : new URL(privateTask.mediaUrl).pathname;
  const full = await exchange(privateRoute, { role: 'a' });
  check('real Rust private bytes equal independently generated original', full.status === 200 && digest(full.bytes) === tracks[2].sha256);
  const range = await exchange(privateRoute, { role: 'a', headers: { range: 'bytes=17-99' } });
  check('real source-backed Range matches original bytes', range.status === 206 && range.bytes.equals(full.bytes.subarray(17, 100)));
  check('another real user cannot access a warmed private representation', (await exchange(privateRoute, { role: 'b' })).status === 403);

  const accountRoute = 'user/' + fixture.accounts.a.id + '/library';
  await fixture.native(accountRoute, 'PUT', { libraryIds: [fixture.libraries.empty] }); assignmentChanged = true;
  const sourceDenied = await fixture.subsonic('a', 'getSong', { id: tracks[2].songId });
  check('real Navidrome revocation denies the still-authenticated account', sourceDenied.status === 200 && sourceDenied.value?.status === 'failed'
    && sourceDenied.value.error?.code === 70, { httpStatus: sourceDenied.status, protocolCode: sourceDenied.value?.error?.code });
  const afterRevoke = await exchange(privateRoute, { role: 'a' });
  check('warm Rust cache rechecks real upstream access after library revocation', [401, 403, 404].includes(afterRevoke.status)
    && !afterRevoke.headers.has('etag') && !afterRevoke.headers.has('content-range'));
  await fixture.native(accountRoute, 'PUT', { libraryIds: [fixture.libraries.audio] }); assignmentChanged = false;
  check('restoring real upstream grant permits the original cached representation', (await exchange(privateRoute, { role: 'a' })).status === 200);

  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };
  async function fresh() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' }); contexts.push(context);
    context.on('response', response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === apiBase + '/tasks') {
        taskResponses.push(response.json().then(value => { if (value.id) browserTasks.add(value.id); }).catch(() => {}));
      }
    });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.origin === origin || ['blob:', 'data:'].includes(u.protocol)) return route.continue();
      externalRequests.push(u.origin); return route.abort();
    });
    await context.addInitScript(() => {
      window.__navidromeEnded = [];
      document.addEventListener('ended', event => {
        if (event.target.tagName === 'AUDIO') window.__navidromeEnded.push({ trusted: event.isTrusted,
          time: event.target.currentTime, duration: event.target.duration, rate: event.target.playbackRate });
      }, true);
    });
    const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
    await page.goto(origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
    report.release ||= await page.locator('meta[name=mhub-library-release]').getAttribute('content');
    return { context, page };
  }
  const visitor = await fresh();
  await visitor.page.locator('#results .play-track').first().click();
  await visitor.page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2));
  check('actual browser plays public MP3 through Rust and real Navidrome', true);
  await visitor.page.locator('#transport').click();
  for (const button of await visitor.page.locator('#results .save-offline').all()) {
    await button.click(); await visitor.page.waitForFunction(() => window.libraryLab.snapshot().pending === 0);
  }
  await visitor.page.waitForFunction(() => window.libraryLab.snapshot().cache.length === 2 && document.getElementById('offline-shell-state').textContent.includes('已准备好'));
  await visitor.context.setOffline(true); await visitor.page.reload(); await visitor.page.waitForFunction(() => window.libraryLabReady);
  await visitor.page.locator('#start-listening').click();
  await visitor.page.waitForFunction(() => window.libraryLab.snapshot().state === 'stopped' && window.libraryLab.snapshot().playIndex === 1, null, { timeout: 20000 });
  check('real-source MP3 and FLAC saved copies naturally complete after offline reopen', await visitor.page.evaluate(() => {
    const s = window.libraryLab.snapshot(); return s.offlineMode && s.cache.length === 2 && s.audio.every(a => a.paused)
      && window.__navidromeEnded.length === 2 && window.__navidromeEnded.every(e => e.trusted && e.rate === 1 && Math.abs(e.time - e.duration) < .1);
  }));
  report.naturalEnds = await visitor.page.evaluate(() => window.__navidromeEnded);
  await visitor.context.close(); contexts.splice(contexts.indexOf(visitor.context), 1);

  const member = await fresh();
  await member.page.locator('#username').fill(fixture.accounts.a.username); await member.page.locator('#password').fill(fixture.accounts.a.password);
  await fixture.paced(async () => { await member.page.locator('#password').press('Enter'); await member.page.waitForFunction(() => window.libraryLab.snapshot().user); });
  await member.page.locator('#results .track').filter({ hasText: 'Long Journey' }).locator('.play-track').click();
  await member.page.waitForFunction(() => window.libraryLab.snapshot().track?.access === 'restricted' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2));
  check('visible login and private playback use actual upstream identity', true);
  check('restricted original is absent from actual IndexedDB records', await member.page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('music-splayer-web-cache-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('tracks', 'readonly').objectStore('tracks').getAll();
      request.onsuccess = () => resolve(request.result.every(item => item.track?.access === 'public')); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }));
  await member.page.locator('#logout').click();
  await member.page.waitForFunction(() => !window.libraryLab.snapshot().user && window.libraryLab.snapshot().audio.every(a => a.paused && !a.attached));
  check('visible logout detaches private audio and clears its queue', await member.page.evaluate(() => window.libraryLab.snapshot().queue.length === 0));
  await member.context.close(); contexts.splice(contexts.indexOf(member.context), 1);

  await Promise.allSettled(taskResponses);
  await exchange(apiBase + '/session'); report.beforeExplicitCleanup = app.metrics;
  report.cleanupRequests = [];
  for (const id of browserTasks) {
    const response = await exchange(apiBase + '/tasks/' + id, { method: 'DELETE' });
    report.cleanupRequests.push({ status: response.status });
  }
  await exchange(apiBase + '/session', { method: 'DELETE', role: 'a' });
  await exchange(apiBase + '/session', { method: 'DELETE', role: 'b' });
  let metrics;
  for (let index = 0; index < 100; index++) {
    await exchange(apiBase + '/session'); metrics = app.metrics;
    if (['activeTasks', 'activeSessions', 'activeJobs', 'activeMediaResponses', 'activeFileLeases', 'runningPreparations', 'queuedPreparations'].every(k => metrics[k] === 0)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // The API task's old session has been revoked. Its terminal record can remain,
  // but the private source must have no live task, stream or lease after logout.
  check('real source integration releases all active Rust resources', ['activeTasks', 'activeSessions', 'activeJobs', 'activeMediaResponses', 'activeFileLeases', 'runningPreparations', 'queuedPreparations'].every(k => metrics[k] === 0), metrics);
  check('no browser JavaScript errors', report.errors.length === 0, report.errors);
  check('browser calls only the Rust origin without source requests', externalRequests.length === 0, externalRequests);
  report.metrics = metrics; report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; report.stack = error.stack;
  if (error.fixtureCleanup) report.cleanup = error.fixtureCleanup; process.exitCode = 1; }
finally {
  await Promise.allSettled(contexts.map(c => c.close()));
  const cleanupErrors = [];
  if (browser) await browser.close().catch(() => cleanupErrors.push('Test browser did not close cleanly'));
  if (assignmentChanged && fixture) await fixture.native('user/' + fixture.accounts.a.id + '/library', 'PUT', { libraryIds: [fixture.libraries.audio] }).catch(() => {});
  if (app) await app.close().then(() => { report.backendClosed = true; }, () => cleanupErrors.push('Owned Rust process did not close cleanly'));
  if (fixture) {
    await fixture.close().catch(() => cleanupErrors.push('Disposable Navidrome did not close cleanly'));
    report.cleanup = fixture.cleanup;
  }
  if (cleanupErrors.length) { report.passed = false; report.errors.push(...cleanupErrors); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'navidrome-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
