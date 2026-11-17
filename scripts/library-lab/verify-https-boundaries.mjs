/** Actual TLS, browser cookie policy and Rust exposure checks against an owned source.
 * LIBRARY_BACKEND=rust node verify-https-boundaries.mjs CONFIG CREDENTIALS REPORT_DIR
 * OPENSSL_EXECUTABLE, PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE may select installed tools.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend, apiBase, clientHeader, rustBackend, forbidsStorage } from './backend.mjs';
import { createTlsFixture, hostnames } from './tls-fixture.mjs';

const [configFile, credentialsFile, output] = process.argv.slice(2);
if (!rustBackend || ![configFile, credentialsFile, output].every(Boolean)) throw new Error('Expected Rust, CONFIG CREDENTIALS REPORT_DIR');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = await json(configFile), credentials = await json(credentialsFile), policy = await json(config.policyFile);
assert.ok(['127.0.0.1', '[::1]'].includes(new URL(config.source.baseUrl).hostname), 'Use an explicitly owned loopback Navidrome');
const selected = policy.tracks.find(track => track.access === 'restricted' && track.allowedUserIds.includes(credentials.accounts.a.id));
assert.ok(selected, 'An owned A-only audio fixture is required');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'https-run-'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const checks = [], exchanges = [], contexts = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { recordedAt: new Date().toISOString(), scope: 'Owned loopback Rust/Navidrome with real TLS and isolated browser origins; no public deployment or OS trust changes.', checks, exchanges };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(75); }
  throw new Error('Condition timed out: ' + label);
}
let tls, app, browser, internalOrigin, cookie = '';
const io = () => JSON.stringify({ mediaOpens: app.metrics.mediaOpens, sourceDownloads: app.metrics.sourceDownloads, cacheValidations: app.metrics.cacheValidations });
async function request(route, options = {}) {
  const result = await tls.request(route, { ...options, headers: { origin: tls.origin, [clientHeader]: '1', ...(cookie ? { cookie } : {}), ...options.headers } });
  const value = /json/.test(result.headers['content-type'] || '') && result.bytes.length ? JSON.parse(result.bytes) : null;
  exchanges.push({ route, method: options.method || 'GET', status: result.status, bytes: result.bytes.length, sha256: hash(result.bytes), ...(value?.error ? { error: value.error.code } : {}) });
  return { ...result, value };
}
async function newContext() {
  const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: 'block', viewport: { width: 1280, height: 920 } });
  contexts.push(context); return context;
}
async function libraryPage(context) {
  const page = await context.newPage();
  await page.goto(tls.origin + '/library/');
  await page.waitForFunction(() => window.libraryLabReady);
  return page;
}
async function createTask() {
  let task = (await request(apiBase + '/tasks', { method: 'POST', data: { instanceId: policy.instanceId, songId: selected.songId, version: selected.sha256 } })).value;
  assert.ok(task?.id, 'Authorized preparation must return a task');
  await until(async () => { task = (await request(apiBase + '/tasks/' + task.id)).value; return task.state !== 'preparing'; }, 'authorized task');
  assert.equal(task.state, 'ready', 'Authorized original must become ready');
  return task;
}
try {
  tls = await createTlsFixture();
  report.tls = { ...tls.certificate, browserTrust: 'Only the ephemeral leaf SPKI is excepted in this browser process; Node separately validates CA and hostname.', systemTrustChanged: false, globalIgnoreHTTPSErrors: false };
  await writeFile(path.join(output, 'tls-public-ca.pem'), tls.ca);
  await writeFile(path.join(output, 'tls-public-leaf.pem'), tls.cert);
  app = await createBackend({ ...config, cacheDir: path.join(run, 'cache') }, { origin: tls.origin, exclusive: true });
  internalOrigin = await app.start(); tls.setTarget(internalOrigin);
  const health = await request('/health');
  check('TLS client validates the supplied CA and real Rust health', health.status === 200 && health.value.service === 'music-api' && health.authorized === true);
  report.negotiatedTLS = health.protocol;
  let untrusted, wrongName;
  try { await tls.request('/health', { trust: false }); } catch (error) { untrusted = error.code; }
  try { await tls.request('https://wrong.example.test:' + new URL(tls.origin).port + '/health'); } catch (error) { wrongName = error.code; }
  check('the same client rejects the certificate without its CA', /CERT|ISSUER|SIGNATURE/.test(untrusted || ''), { code: untrusted || null });
  check('a trusted CA does not authorize a different server name', wrongName === 'ERR_TLS_CERT_ALTNAME_INVALID', { code: wrongName || null });

  const landing = await request('/');
  check('exclusive root leads only to the library page', [302, 303, 307, 308].includes(landing.status) && landing.headers.location === '/library/');
  const pageResponse = await request('/library/');
  check('the shared library player is served over TLS', pageResponse.status === 200 && pageResponse.bytes.includes(Buffer.from('mhub-library-api')));
  check('the library document forbids framing', /frame-ancestors\s+'none'/.test(pageResponse.headers['content-security-policy'] || '') && pageResponse.headers['x-frame-options'] === 'DENY');
  const scriptPath = pageResponse.bytes.toString().match(/src="(\/library\/player-[a-f0-9]+\.js)"/)?.[1];
  assert.ok(scriptPath, 'Expected the actual built player');
  check('the required player asset remains available', (await request(scriptPath)).status === 200);
  const archive = await request('/source.tar.gz');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  check('the corresponding source archive remains available', archive.status === 200 && archive.bytes.equals(await readFile(path.join(repo, 'web/source.tar.gz'))));

  for (const [method, route, data] of [
    ['GET', '/api/v1/platforms'], ['GET', '/api/v1/search?platform=unsupported-fixture&q=test'],
    ['POST', '/api/v1/playbacks', {}], ['GET', '/api/v1/playbacks/absent/audio'],
    ['GET', '/api/v1/auth/config'], ['POST', '/api/v1/sync/library', {}],
    ['GET', '/api/v1/sync/ws'], ['GET', '/index.html'], ['GET', '/sw.js'],
    ['GET', '/api/v1/library/../platforms'], ['GET', '/library/%2e%2e/config.example.toml'],
  ]) {
    const result = await request(route, { method, ...(data ? { data } : {}) });
    check('exclusive surface omits ' + method + ' ' + route, result.status === 404, { status: result.status });
  }
  const preflight = await request('/api/v1/platforms', { method: 'OPTIONS', headers: { origin: tls.attackerOrigin, 'access-control-request-method': 'POST' } });
  check('omitted legacy routes have no permissive CORS preflight', preflight.status === 404 && !preflight.headers['access-control-allow-origin']);

  // Obtain an ordinary B session, then let an owned sibling origin attempt to
  // plant it into a fresh victim context. No credentials are put in the report.
  const b = await request(apiBase + '/session', { method: 'POST', data: credentials.accounts.b });
  assert.equal(b.status, 200, 'Owned B native login is a prerequisite');
  const bSetCookie = b.headers['set-cookie'][0], bPair = bSetCookie.split(';')[0];
  const sessionName = bPair.split('=')[0], bPath = bSetCookie.match(/Path=([^;]+)/)[1];
  browser = await chromium.launch({ headless: true, args: tls.browserArgs, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = browser.version();
  const poisoned = await newContext(), siblingPage = await poisoned.newPage();
  await siblingPage.goto(tls.siblingOrigin);
  await siblingPage.evaluate(value => { document.cookie = value; }, bPair + '; Domain=example.test; Path=' + bPath + '; Secure; SameSite=Strict');
  const planted = (await poisoned.cookies(tls.origin + apiBase + '/session')).some(value => value.name === sessionName && value.domain === '.example.test');
  const victim = await libraryPage(poisoned);
  const injectedUser = await victim.evaluate(() => window.libraryLab.snapshot().user?.id || null);
  check('a sibling origin cannot plant the server session cookie', !planted, { browserAcceptedParentDomainCookie: planted });
  check('a fresh visitor is not signed into the sibling-selected account', injectedUser === null, { injectedAccountWasObserved: injectedUser === credentials.accounts.b.id });
  await poisoned.close();

  const context = await newContext(), page = await libraryPage(context);
  check('the browser treats the named TLS origin as a secure context', await page.evaluate(() => window.isSecureContext));
  check('anonymous HTTPS UI shows only the two public tracks', await page.locator('#results .track').count() === 2);
  await page.locator('#username').fill(credentials.accounts.a.username);
  await page.locator('#password').fill(credentials.accounts.a.password);
  await page.locator('#login-form button').click();
  await page.waitForFunction(id => window.libraryLab.snapshot().user?.id === id, credentials.accounts.a.id);
  await page.waitForFunction(() => document.querySelectorAll('#results .track').length === 3);
  check('A logs in through the real HTTPS form and sees its restricted track', (await page.evaluate(() => window.libraryLab.snapshot().user.id)) === credentials.accounts.a.id);
  check('the login form clears the submitted password', await page.locator('#password').inputValue() === '' && !await page.locator('#login-form').isVisible());
  const sessionCookie = (await context.cookies(tls.origin + apiBase + '/session')).find(value => value.name.endsWith('mhub_library_session'));
  assert.ok(sessionCookie, 'The browser must hold a session');
  report.cookie = { name: sessionCookie.name, domain: sessionCookie.domain, path: sessionCookie.path, secure: sessionCookie.secure, httpOnly: sessionCookie.httpOnly, sameSite: sessionCookie.sameSite };
  check('HTTPS sessions use a host-prefixed cookie at the host root', sessionCookie.name === '__Host-mhub_library_session' && sessionCookie.path === '/' && sessionCookie.domain === hostnames.library);
  check('HTTPS session attributes are Secure HttpOnly and SameSite Strict', sessionCookie.secure && sessionCookie.httpOnly && sessionCookie.sameSite === 'Strict');
  cookie = sessionCookie.name + '=' + sessionCookie.value;
  const documentProbe = await context.newPage(); await documentProbe.goto(tls.origin + apiBase + '/session');
  check('JavaScript cannot read the session even within its cookie path', !await documentProbe.evaluate(name => document.cookie.split(';').some(value => value.trim().startsWith(name + '=')), sessionCookie.name));
  await documentProbe.close();
  const httpProbe = await context.newPage(); await httpProbe.goto(tls.httpOrigin + apiBase + '/session');
  check('the browser sends no session on the same named host over HTTP', tls.records.filter(record => record.transport === 'http').every(record => !record.sessionCookiePresent));
  await httpProbe.close();

  const ambiguous = await request(apiBase + '/session', { headers: { cookie: cookie + '; ' + sessionCookie.name + '=' + 'z'.repeat(43) } });
  check('ambiguous duplicate session cookies fail closed', ambiguous.value.user === null);
  const legacyCookie = await request(apiBase + '/session', { headers: { cookie: 'mhub_library_session=' + sessionCookie.value } });
  check('HTTPS does not accept the unprefixed HTTP development cookie', legacyCookie.value.user === null);

  const wanted = { instanceId: policy.instanceId, songId: selected.songId, version: selected.sha256 };
  const beforeForbidden = io();
  for (const [label, method, route, headers, data] of [
    ['missing Origin on write', 'POST', apiBase + '/tasks', { origin: undefined }, wanted],
    ['null Origin on write', 'POST', apiBase + '/tasks', { origin: 'null' }, wanted],
    ['missing custom header on write', 'POST', apiBase + '/tasks', { [clientHeader]: undefined }, wanted],
    ['same-site fetch metadata', 'GET', apiBase + '/session', { 'sec-fetch-site': 'same-site', origin: undefined }],
    ['foreign Origin on read', 'GET', apiBase + '/session', { origin: tls.attackerOrigin }],
    ['proxy dropped the external port', 'GET', apiBase + '/session', { 'x-mhub-test-backend-host': hostnames.library }],
    ['forged forwarding headers', 'GET', apiBase + '/session', { 'x-mhub-test-backend-host': 'untrusted.example.test', 'x-forwarded-host': new URL(tls.origin).host, 'x-forwarded-proto': 'https', forwarded: 'proto=https;host="' + new URL(tls.origin).host + '"' }],
  ]) {
    const result = await request(route, { method, headers, ...(data ? { data } : {}) });
    check('boundary rejects ' + label, result.status === 403);
  }
  check('forbidden requests open no source downloads or cache files', io() === beforeForbidden);
  const task = await createTask();
  const original = await request(task.mediaUrl);
  check('authorized TLS media matches the trusted original SHA256', original.status === 200 && hash(original.bytes) === selected.sha256);
  check('private media remains no-store through TLS termination', forbidsStorage(original.headers['cache-control']));
  const range = await request(task.mediaUrl, { headers: { range: 'bytes=12345-16440', 'if-range': original.headers.etag } });
  check('TLS byte Range belongs to exactly the same representation', range.status === 206 && range.bytes.equals(original.bytes.subarray(12345, 16441)) && range.headers.etag === original.headers.etag);

  for (const [role, origin] of [['sibling', tls.siblingOrigin], ['cross-site', tls.attackerOrigin]]) {
    const foreign = await context.newPage(); await foreign.goto(origin);
    const start = tls.records.length, before = io();
    await foreign.evaluate(async target => {
      try { await fetch(target + '/api/v1/library/session', { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{}' }); } catch {}
    }, tls.origin);
    await until(() => tls.records.slice(start).some(record => record.method === 'POST' && record.path === apiBase + '/session' && record.status), role + ' simple POST');
    const sent = tls.records.slice(start).find(record => record.method === 'POST' && record.path === apiBase + '/session');
    check(role + ' browser POST is denied before login processing', sent.status === 403 && sent.origin === origin);
    check(role + ' cookie transport follows SameSite rather than CORS', sent.sessionCookiePresent === (role === 'sibling'), { cookieSent: sent.sessionCookiePresent, fetchSite: sent.fetchSite });
    const canRead = await foreign.evaluate(async target => {
      try { const response = await fetch(target + '/api/v1/library/session', { credentials: 'include' }); await response.text(); return true; } catch { return false; }
    }, tls.origin);
    check(role + ' JavaScript cannot read the private session response', !canRead);
    const mediaStart = tls.records.length;
    await foreign.evaluate(url => { const media = document.createElement('audio'); media.preload = 'auto'; media.src = url; document.body.append(media); media.load(); }, tls.origin + task.mediaUrl);
    await until(() => tls.records.slice(mediaStart).some(record => record.path === task.mediaUrl && record.status), role + ' media request');
    const mediaRequest = tls.records.slice(mediaStart).find(record => record.path === task.mediaUrl);
    check(role + ' media embedding cannot obtain private bytes', mediaRequest.status === 403);
    check(role + ' browser attempts cause no source or cache media IO', io() === before);
    if (role === 'sibling') {
      await foreign.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, tls.origin + '/library/');
      let embeddedReady = false, embeddedUser = false;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && !embeddedReady) {
        const frame = foreign.frames().find(item => item.url().startsWith(tls.origin + '/library/'));
        if (frame) {
          embeddedReady = await frame.evaluate(() => Boolean(window.libraryLabReady)).catch(() => false);
          if (embeddedReady) embeddedUser = await frame.evaluate(id => window.libraryLab.snapshot().user?.id === id, credentials.accounts.a.id).catch(() => false);
        }
        if (!embeddedReady) await pause(100);
      }
      check('a sibling-origin frame cannot render the authenticated library', !embeddedReady, { rendered: embeddedReady, renderedWithAuthenticatedUser: embeddedUser });
    }
    await foreign.close();
  }
  check('browser origin attacks leave the intended A session intact', (await request(apiBase + '/session')).value.user?.id === credentials.accounts.a.id);

  await page.locator('#results .track').filter({ hasText: 'Long Journey' }).locator('.play-track').click();
  await page.waitForFunction(() => window.libraryLab.snapshot().audio.some(audio => !audio.paused && audio.time > .3));
  check('the real browser plays authorized audio over HTTPS', (await page.evaluate(() => window.libraryLab.snapshot().track.access)) === 'restricted');
  await page.screenshot({ path: path.join(output, 'https-authorized-playback.png'), fullPage: true });
  await page.locator('#logout').click();
  await page.waitForFunction(() => window.libraryLab.snapshot().user === null && window.libraryLab.snapshot().audio.every(audio => audio.paused));
  check('HTTPS logout stops playback and removes the browser cookie', !(await context.cookies(tls.origin + apiBase + '/session')).some(value => value.name === sessionCookie.name));
  const beforeStale = io();
  const stale = await request(task.mediaUrl, { headers: { range: 'bytes=12345-16440', 'if-none-match': original.headers.etag } });
  check('a replayed logged-out cookie cannot obtain Range or 304 bytes', stale.status === 401 && !stale.headers.etag && !stale.headers['content-range']);
  check('logged-out denial opens no private cache file', io() === beforeStale);
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  if (app) { report.metrics = { ...app.metrics }; await app.close(); }
  if (tls) { report.transport = tls.records; await tls.close(); report.tlsPrivateFilesRemoved = tls.privateFilesRemoved; }
  report.checkCount = checks.length;
  report.passed = !report.failure && checks.length > 0 && checks.every(check => check.passed) && report.tlsPrivateFilesRemoved === true;
  if (!report.passed) process.exitCode = 1;
  await writeFile(path.join(output, 'https-boundaries.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failedChecks: checks.filter(check => !check.passed).map(check => check.name), ...(report.failure ? { failure: report.failure } : {}), tlsPrivateFilesRemoved: report.tlsPrivateFilesRemoved }, null, 2));
}
