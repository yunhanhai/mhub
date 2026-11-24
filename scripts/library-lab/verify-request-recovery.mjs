// Actual built interface and browser, simulated loopback API and deliberately
// uncooperative fetch/body promises. The production 25-second deadline is unchanged.
// node scripts/library-lab/verify-request-recovery.mjs REPORT_DIR
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowserFixture } from './browser-fixture.mjs';

const output = process.argv[2]; assert.ok(output, 'Expected REPORT_DIR');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startBrowserFixture();
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  scope: 'Actual desktop browser and built interface with generated MP3 and simulated loopback API. Page-only fetch injection deliberately ignores abort before headers or during JSON body reading. Actual production 25000ms deadline; no shortened timer or product test switch. Blocked mutations never reach a backend. No real source, physical device or spoken screen-reader claim.' };
let browser;
const contexts = [];
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), detail }); assert.ok(passed, name); };
async function fresh() {
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } }); contexts.push(context);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === fixture.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    const state = window.requestFault = { next: null, captured: [], sessionPosts: 0, taskPosts: 0 };
    state.release = index => state.captured[index].release();
    state.snapshot = () => ({ sessionPosts: state.sessionPosts, taskPosts: state.taskPosts,
      captured: state.captured.map(item => ({ phase: item.phase, elapsedMs: (item.abortedAt ?? performance.now()) - item.started,
        aborted: item.aborted, cancelled: item.cancelled, locked: item.response?.body.locked || false })) });
    window.fetch = (input, options) => {
      const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = options?.method || input.method || 'GET';
      if (method === 'POST' && pathname.endsWith('/library/session')) state.sessionPosts++;
      if (method === 'POST' && pathname.endsWith('/library/tasks')) state.taskPosts++;
      const fault = state.next;
      if (!fault || method !== 'POST' || !pathname.endsWith('/library/' + fault.endpoint)) return original(input, options);
      state.next = null;
      const item = { phase: fault.phase, started: performance.now(), aborted: false, cancelled: 0 }; state.captured.push(item);
      options.signal.addEventListener('abort', () => { item.aborted = true; item.abortedAt = performance.now(); }, { once: true });
      const response = () => item.response = new Response(new ReadableStream({
        start(stream) { if (fault.phase === 'headers') stream.enqueue(new TextEncoder().encode(JSON.stringify(fault.payload))); },
        cancel() { item.cancelled++; return new Promise(() => {}); },
      }), { headers: { 'content-type': 'application/json' } });
      if (fault.phase === 'body') return Promise.resolve(response());
      return new Promise(resolve => { item.release = () => resolve(response()); });
    };
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(fixture.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  const release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  if (report.release) assert.equal(release, report.release); else report.release = release;
  return { page, context };
}
async function arm(page, endpoint, phase) {
  await page.evaluate(fault => { window.requestFault.next = fault; }, { endpoint, phase,
    payload: endpoint === 'session' ? { instanceId: 'accessibility-interface-fixture', user: { id: 'stale-user', username: 'stale-user' } }
      : { id: 'a'.repeat(32), state: 'ready', track: fixture.tracks[1], mediaUrl: fixture.origin + '/api/v1/library/tasks/' + 'a'.repeat(32) + '/audio' } });
}
async function login(page) {
  await page.locator('#username').fill('fixture'); await page.locator('#password').fill('fixture');
  await page.locator('#password').focus(); await page.keyboard.press('Enter');
}
async function state(page) {
  return page.evaluate(() => ({ app: window.libraryLab.snapshot(), fault: window.requestFault.snapshot(),
    focus: document.activeElement.id, notice: document.getElementById('notice').textContent }));
}
async function idle(page, timeout = 2000) {
  await page.waitForFunction(() => { const s = window.libraryLab.snapshot();
    return !s.loading && !s.pending && !s.pendingPlaybackActions && !s.resources.playbackRequests;
  }, null, { timeout });
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };
  const headerLogin = await fresh(), bodyLogin = await fresh(), bodyTask = await fresh();
  await arm(headerLogin.page, 'session', 'headers'); await login(headerLogin.page);
  await arm(bodyLogin.page, 'session', 'body'); await login(bodyLogin.page);
  await arm(bodyTask.page, 'tasks', 'body'); await bodyTask.page.locator('#results .play-track').first().click();

  // Exercise immediate caller cancellation while the three real deadlines run.
  const cancelled = await fresh(); await arm(cancelled.page, 'tasks', 'headers');
  await cancelled.page.locator('#results .play-track').first().click();
  await cancelled.page.waitForFunction(() => window.requestFault.captured.length === 1);
  const cancelStarted = Date.now(); await cancelled.page.locator('#transport').click(); await idle(cancelled.page);
  const cancelledState = await state(cancelled.page);
  check('pause settles an uncooperative task fetch promptly', Date.now() - cancelStarted < 2000 && cancelledState.fault.captured[0].aborted, { elapsedMs: Date.now() - cancelStarted, state: cancelledState });
  await cancelled.page.locator('#results .play-track').first().click();
  await cancelled.page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .1));
  check('explicit play after cancellation succeeds once', (await state(cancelled.page)).fault.taskPosts === 2);
  await cancelled.page.evaluate(() => window.requestFault.release(0));
  await cancelled.page.waitForFunction(() => window.requestFault.snapshot().captured[0].cancelled === 1);
  const lateTask = await state(cancelled.page);
  check('late cancelled task cannot replace the newer native playback', lateTask.app.track.songId === fixture.tracks[0].songId && lateTask.app.state === 'playing'
    && lateTask.fault.taskPosts === 2 && lateTask.fault.captured[0].cancelled === 1, lateTask);
  await cancelled.context.close(); contexts.splice(contexts.indexOf(cancelled.context), 1);

  await Promise.all([headerLogin, bodyLogin].map(async ({ page }) => {
    await page.waitForFunction(() => window.libraryLab.snapshot().sessionState === 'unavailable', null, { timeout: 30000 });
    await idle(page);
  }).concat(bodyTask.page.waitForFunction(() => window.libraryLab.snapshot().playbackFeedback?.canRetry, null, { timeout: 30000 })));
  for (const [label, sample] of [['headers', headerLogin], ['body', bodyLogin]]) {
    const result = await state(sample.page), fault = result.fault.captured[0];
    check('login ' + label + ' deadline exposes account retry without resubmitting credentials', fault.aborted && fault.elapsedMs >= 24500 && fault.elapsedMs < 35000
      && result.app.user === null && result.app.sessionState === 'unavailable' && result.focus === 'retry-session'
      && result.fault.sessionPosts === 1 && await sample.page.locator('#retry-session').isEnabled(), result);
    if (label === 'body') check('stalled login body cleanup does not hold the deadline', fault.cancelled === 1 && !fault.locked, fault);
    await sample.page.locator('#retry-session').click();
    await sample.page.waitForFunction(() => window.libraryLab.snapshot().sessionState === 'ready'); await idle(sample.page);
    const recovered = await state(sample.page);
    check('manual account confirmation recovers after ' + label + ' timeout', recovered.app.user === null && recovered.fault.sessionPosts === 1, recovered);
  }
  await login(headerLogin.page); await headerLogin.page.waitForFunction(() => window.libraryLab.snapshot().user?.id === 'fixture-user'); await idle(headerLogin.page);
  await headerLogin.page.evaluate(() => window.requestFault.release(0));
  await headerLogin.page.waitForFunction(() => window.requestFault.snapshot().captured[0].cancelled === 1);
  const lateLogin = await state(headerLogin.page);
  check('late login reply is released and cannot restore an older identity', lateLogin.app.user?.id === 'fixture-user' && lateLogin.app.sessionState === 'ready'
    && lateLogin.fault.sessionPosts === 2 && lateLogin.fault.captured[0].cancelled === 1, lateLogin);

  await idle(bodyTask.page);
  const timedTask = await state(bodyTask.page), fault = timedTask.fault.captured[0];
  check('stalled task body deadline clears pending playback and enables retry', fault.aborted && fault.cancelled === 1 && !fault.locked
    && fault.elapsedMs >= 24500 && fault.elapsedMs < 35000 && timedTask.app.playbackFeedback?.canRetry && timedTask.fault.taskPosts === 1, timedTask);
  await bodyTask.page.locator('#retry-playback').click();
  await bodyTask.page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .1));
  check('one explicit retry resumes native audio after a task deadline', (await state(bodyTask.page)).fault.taskPosts === 2);
  check('no page JavaScript errors or unhandled late failures', !report.errors.length, report.errors);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1;
  report.failureStates = await Promise.all(contexts.flatMap(context => context.pages()).map(page => state(page).catch(() => null)));
}
finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  if (browser) await browser.close();
  report.fixtureBeforeClose = fixture.metrics(); await fixture.close(); report.fixtureClosed = true;
  report.fixtureAfterClose = fixture.metrics();
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'request-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
