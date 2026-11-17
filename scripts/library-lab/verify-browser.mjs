/** Actual Edge/Chromium, MHub player and IndexedDB; no synthetic player/API.
 * PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE may point to installed local tools.
 * node scripts/library-lab/verify-browser.mjs ORIGIN CREDENTIALS REPORT_DIR
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { apiBase, apiRoute, cookieName, rustBackend, forbidsStorage } from './backend.mjs';

const [origin, credentialsPath, reportDir] = process.argv.slice(2);
if (![origin, credentialsPath, reportDir].every(Boolean)) throw new Error('Expected ORIGIN CREDENTIALS REPORT_DIR');
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('This test is restricted to the loopback lab');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const credentials = JSON.parse((await readFile(credentialsPath, 'utf8')).replace(/^\uFEFF/, ''));
await mkdir(reportDir, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const checks = [], errors = [], external = [], requests = [], apiBodies = [], mediaResponses = [], snapshots = {}, contexts = [];
const report = { recordedAt: new Date().toISOString(), backend: rustBackend ? 'music-api Rust' : 'Node reference', browser: browser.version(), checks, snapshots, scope: 'Real desktop browser on loopback. No mobile device, speaker measurement or offline shell installation.' };
const check = (name, condition, details) => { checks.push({ name, passed: Boolean(condition), ...(details ? { details } : {}) }); assert.ok(condition, name); };
const snapshot = page => page.evaluate(() => window.libraryLab.snapshot());
async function until(page, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const s = await snapshot(page); if (predicate(s)) return s; await page.waitForTimeout(100); }
  throw new Error('Browser condition timed out: ' + JSON.stringify(await snapshot(page)) + '; ' + await page.locator('#notice').innerText());
}
async function attach(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { const u = new URL(req.url()); if (u.origin === origin) requests.push({ method: req.method(), path: u.pathname, query: u.search }); });
  page.on('response', async response => {
    const u = new URL(response.url());
    if (u.origin !== origin) return;
    if (u.pathname.endsWith('/audio')) mediaResponses.push({ path: u.pathname, status: response.status(), cacheControl: response.headers()['cache-control'] });
    else if (u.pathname.startsWith('/api/')) { try { apiBodies.push(await response.text()); } catch {} }
  });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === origin || ['blob:', 'data:'].includes(u.protocol)) return route.continue();
    external.push(u.origin); return route.abort();
  });
  await page.goto(origin + (rustBackend ? '/library/' : '')); await page.waitForFunction(() => window.libraryLabReady);
  return page;
}
async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 940 }, serviceWorkers: 'block' }); contexts.push(context);
  return { context, page: await attach(await context.newPage()) };
}
async function login(page, role) {
  await page.locator('#username').fill(credentials.accounts[role].username);
  await page.locator('#password').fill(credentials.accounts[role].password);
  await page.locator('#login-form button').click();
  const s = await until(page, v => v.user?.id === credentials.accounts[role].id);
  await page.waitForFunction(() => document.querySelectorAll('#results .track').length > 0);
  check(role + ' logs in through the visible form', s.user.id === credentials.accounts[role].id);
  check(role + ' password field cleared and login form hidden', await page.locator('#password').inputValue() === '' && !await page.locator('#login-form').isVisible());
}
const resultRow = (page, title) => page.locator('#results .track').filter({ hasText: title });
async function cacheRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('music-splayer-web-cache-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction('tracks', 'readonly').objectStore('tracks').getAll(); r.onsuccess = () => resolve(r.result.map(x => ({ key: x.key, songId: x.track?.songId, access: x.track?.access, blobSize: x.blob?.size || 0 }))); r.onerror = () => reject(r.error); }); }
    finally { db.close(); }
  });
}
try {
  const { context: publicContext, page: publicPage } = await fixture();
  check('anonymous UI shows the two public tracks', await publicPage.locator('#results .track').count() === 2);
  await resultRow(publicPage, 'First Light').locator('.play-track').click();
  const started = await until(publicPage, s => s.audio.some(a => !a.paused && a.time > .3));
  check('actual MHub player advances native MP3 time', started.state === 'playing' && started.track?.access === 'public');
  await resultRow(publicPage, 'First Light').locator('.save-offline').click();
  await until(publicPage, s => s.cache.length === 1);
  await resultRow(publicPage, 'Slow River').locator('.save-offline').click();
  const saved = await until(publicPage, s => s.cache.length === 2);
  check('explicit saves use real IndexedDB with instance/version keys', (await cacheRecords(publicPage)).every(r => r.blobSize > 0 && r.access === 'public' && r.key.startsWith('library-lab:' + saved.instanceId + ':')));
  const ended = await until(publicPage, s => s.audio.some(a => a.ended) && s.state === 'stopped', 16000);
  snapshots.naturalEnd = ended;
  check('real MP3 natural EOF stops without a stale replay', ended.audio.every(a => a.paused));
  await publicPage.waitForTimeout(600);
  check('natural EOF remains stopped', (await snapshot(publicPage)).state === 'stopped');
  await publicPage.reload(); await publicPage.waitForFunction(() => window.libraryLabReady);
  await until(publicPage, s => s.cache.length === 2);
  await publicContext.setOffline(true);
  const requestsBeforeOffline = requests.length;
  for (const title of ['First Light', 'Slow River']) {
    await publicPage.locator('#offline-tracks .track').filter({ hasText: title }).locator('.play-track').click();
    const offline = await until(publicPage, s => s.audio.some(a => !a.paused && a.time > .25 && a.source.startsWith('blob:')));
    check(title + ' plays the persisted Blob after reload and network loss', offline.state === 'playing');
  }
  check('offline playback starts no HTTP task or media request', requests.length === requestsBeforeOffline);
  await publicContext.setOffline(false);
  await publicPage.screenshot({ path: path.join(reportDir, 'public-library.png'), fullPage: true });

  const { context: aContext, page: aPage } = await fixture();
  await login(aPage, 'a');
  check('A can see the restricted long track', await resultRow(aPage, 'Long Journey').count() === 1);
  const cookies = await aContext.cookies(origin + apiBase + '/session');
  check('browser session cookie is HttpOnly and SameSite Strict', cookies.some(c => c.name === cookieName && c.httpOnly && c.sameSite === 'Strict'));
  check('page JavaScript cannot read the session cookie', !(await aPage.evaluate(() => document.cookie)).includes(cookieName));
  await resultRow(aPage, 'Long Journey').locator('.play-track').click();
  const playing = await until(aPage, s => s.track?.access === 'restricted' && s.audio.some(a => !a.paused && a.time > .3));
  const mediaUrl = playing.audio.find(a => !a.paused).source;
  check('restricted media plays using same-origin cookie authentication', playing.state === 'playing' && new URL(mediaUrl).origin === origin);
  const seek = await aPage.locator('#seek').boundingBox();
  await aPage.mouse.click(seek.x + seek.width * .65, seek.y + seek.height / 2);
  const sought = await until(aPage, s => s.audio.some(a => !a.paused && a.time > 55 && a.time < 65));
  const before = sought.audio[0].time;
  await aPage.waitForTimeout(650);
  const advanced = await snapshot(aPage); snapshots.seek = advanced;
  check('actual progress slider seeks the FLAC and time continues advancing', advanced.audio[0].time > before + .2 && advanced.state === 'playing');
  await aPage.locator('#transport').click();
  const paused = await until(aPage, s => s.state === 'paused' && s.audio.every(a => a.paused));
  await aPage.waitForTimeout(350);
  check('explicit pause holds media time', Math.abs((await snapshot(aPage)).audio[0].time - paused.audio[0].time) < .05);
  await aPage.locator('#transport').click(); await until(aPage, s => s.state === 'playing' && s.audio.some(a => !a.paused));
  check('restricted track offers no offline save action', await resultRow(aPage, 'Long Journey').locator('.save-offline').count() === 0);
  check('restricted playback creates no IndexedDB audio record', (await cacheRecords(aPage)).length === 0);
  check('restricted media response is no-store', mediaResponses.filter(r => r.path === new URL(mediaUrl).pathname).every(r => forbidsStorage(r.cacheControl)));
  await aPage.screenshot({ path: path.join(reportDir, 'authorized-playback.png'), fullPage: true });

  const { page: bPage } = await fixture(); await login(bPage, 'b');
  check('B is logged in but cannot see the restricted track', await resultRow(bPage, 'Long Journey').count() === 0 && await bPage.locator('#results .track').count() === 2);
  const denied = await bPage.evaluate(async url => { const r = await fetch(url, { headers: { range: 'bytes=100-200' } }); return { status: r.status, type: r.headers.get('content-type') }; }, mediaUrl);
  check('B browser cannot reuse A media URL after cache warm', denied.status === 403 && /json/.test(denied.type));

  const sibling = await attach(await aContext.newPage());
  check('second tab sees the same A session', (await snapshot(sibling)).user?.id === credentials.accounts.a.id);
  // Playing the already-current track resumes it without creating a new task.
  // Select a different real track first so the following private play resolves.
  await resultRow(aPage, 'First Light').locator('.play-track').click();
  await until(aPage, s => s.track?.access === 'public' && s.audio.some(a => !a.paused && a.time > .2));
  let release, heldResolve;
  const gate = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { heldResolve = resolve; });
  await aPage.route(origin + apiRoute('/api/tasks'), async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); heldResolve(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await resultRow(aPage, 'Long Journey').locator('.play-track').click();
  await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(new Error('Delayed task request not observed')), 8000))]);
  await sibling.locator('#logout').click();
  const cleared = await until(aPage, s => !s.user && !s.track && s.audio.every(a => a.paused && !a.attached) && s.pending === 0);
  release(); await aPage.waitForTimeout(900);
  const settled = await snapshot(aPage); snapshots.logoutAfterDelayedTask = settled;
  check('logout in another tab cancels pending work and detaches private audio', !cleared.user && !cleared.track && cleared.pending === 0);
  check('delayed old task response cannot restore playback after logout', !settled.track && settled.audio.every(a => a.paused && !a.attached));
  const storage = await aPage.evaluate(() => JSON.stringify({ ...localStorage }));
  check('logout clears the persisted private queue', !storage.includes(playing.track.songId));
  const loggedOut = await aPage.evaluate(async url => (await fetch(url, { headers: { range: 'bytes=0-20' } })).status, mediaUrl);
  check('logged-out browser cannot fetch cached private bytes', loggedOut === 401);
  check('private audio remains absent from actual IndexedDB', (await cacheRecords(aPage)).every(r => r.access === 'public'));
  await login(aPage, 'b');
  const switched = await snapshot(aPage);
  check('switching A to B keeps the private source and queue cleared', switched.user?.id === credentials.accounts.b.id && !switched.track && switched.audio.every(a => a.paused && !a.attached));
  check('account switch shows only B permitted tracks', await resultRow(aPage, 'Long Journey').count() === 0 && await aPage.locator('#results .track').count() === 2);
  check('browser receives no upstream tokens or passwords', !apiBodies.some(b => /subsonicToken|subsonicSalt|"password"|"token"|"salt"/.test(b)) && !Object.values(credentials.accounts).some(c => storage.includes(c.password)));
  check('browser never calls the upstream source or sends URL credentials', external.length === 0 && !requests.some(r => r.path.startsWith('/rest/') || /[?&](?:t|s|u|p|token|password|jwt)=/i.test(r.query)));
  check('no page JavaScript exceptions', errors.length === 0, errors);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
finally {
  report.checkCount = checks.length; report.pageErrors = errors; report.externalOrigins = external; report.mediaResponses = mediaResponses;
  report.requests = requests; report.limitations = ['Network loss is tested after a successful page reload; there is no offline application shell/service worker.', 'Already delivered bytes cannot be remotely recalled.', 'Desktop Edge results do not establish mobile background playback or output-device fidelity.'];
  await Promise.allSettled(contexts.map(c => c.close())); await browser.close();
  await writeFile(path.join(reportDir, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, browser: report.browser, ...(report.failure ? { failure: report.failure } : {}) }, null, 2));
}
