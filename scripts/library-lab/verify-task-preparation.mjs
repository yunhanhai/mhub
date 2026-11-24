// Actual built browser interface; generated MP3 and simulated loopback API.
// Page-only faults delay one creation acknowledgement and hold/alter its status.
// node scripts/library-lab/verify-task-preparation.mjs REPORT_DIR
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
  scope: 'Actual built desktop interface and generated MP3 with simulated loopback API. Page-only fetch faults delay one real fixture creation acknowledgement by 5s and stall or replace its status reply. Unchanged production 25s total preparation deadline. Mutations reach only the disposable simulated fixture; no real backend, phone, spoken output or network latency claim.' };
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
    const original = window.fetch.bind(window), json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const fault = window.preparationFault = { next: null, entries: [], creates: 0, deletes: [], media: [] };
    fault.release = index => fault.entries[index].release();
    fault.snapshot = () => ({ creates: fault.creates, deletes: [...fault.deletes], media: [...fault.media],
      entries: fault.entries.map(({ id, mode, started, abortedAt, cancelled, polls, released }) => ({ id, mode, polls, released,
        elapsedMs: performance.now() - started, abortMs: abortedAt === undefined ? null : abortedAt - started, cancelled })) });
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href), method = options.method || input.method || 'GET';
      if (method === 'POST' && url.pathname.endsWith('/library/tasks')) {
        fault.creates++; const mode = fault.next; fault.next = null;
        if (!mode) return original(input, options);
        const entry = { mode, started: performance.now(), cancelled: 0, polls: 0, released: false }; fault.entries.push(entry);
        options.signal.addEventListener('abort', () => { entry.abortedAt = performance.now(); }, { once: true });
        const response = await original(input, options), value = await response.json(); entry.id = value.id; entry.ready = value;
        if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 5000));
        return json({ ...value, state: 'preparing' });
      }
      const match = /\/library\/tasks\/([^/]+)(\/audio)?$/.exec(url.pathname);
      if (match && method === 'DELETE') fault.deletes.push(match[1]);
      if (match?.[2]) fault.media.push(match[1]);
      const entry = fault.entries.find(item => item.id === match?.[1]);
      if (entry && method === 'GET' && !match[2]) {
        entry.polls++;
        options.signal.addEventListener('abort', () => { entry.abortedAt = performance.now(); }, { once: true });
        if (entry.mode === 'changed-id') return json({ ...entry.ready, id: 'b'.repeat(32) });
        return new Promise(resolve => { entry.release = () => {
          entry.released = true;
          resolve(new Response(new ReadableStream({
            start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(entry.ready))); },
            cancel() { entry.cancelled++; return new Promise(() => {}); },
          }), { headers: { 'content-type': 'application/json' } }));
        } });
      }
      return original(input, options);
    };
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const mediaRequests = [];
  page.on('request', request => { if (/\/library\/tasks\/[^/]+\/audio$/.test(new URL(request.url()).pathname)) mediaRequests.push(request.url()); });
  await page.goto(fixture.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  const release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  if (report.release) assert.equal(release, report.release); else report.release = release;
  return { page, context, mediaRequests };
}
async function state(page) {
  return page.evaluate(() => ({ app: window.libraryLab.snapshot(), fault: window.preparationFault.snapshot(),
    notice: document.getElementById('notice').textContent }));
}
async function arm(page, mode) { await page.evaluate(mode => { window.preparationFault.next = mode; }, mode); }
async function idle(page) {
  await page.waitForFunction(() => { const s = window.libraryLab.snapshot(); return !s.pending && !s.loading && !s.pendingPlaybackActions && !s.resources.playbackRequests; });
}
async function playing(page) {
  await page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing'
    && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .1));
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };
  const deadline = await fresh(); await arm(deadline.page, 'deadline');
  await deadline.page.locator('#results .play-track').first().click();
  await deadline.page.waitForFunction(() => window.preparationFault.entries[0]?.polls === 1);
  await deadline.page.waitForFunction(() => window.libraryLab.snapshot().playbackFeedback?.canRetry, null, { timeout: 22000 }); await idle(deadline.page);
  const expired = await state(deadline.page), oldId = expired.fault.entries[0].id;
  check('creation acknowledgement and stalled poll share the real 25s preparation deadline', expired.fault.entries[0].abortMs >= 24500
    && expired.fault.entries[0].abortMs < 27000 && expired.app.resources.mediaTasks === 0 && expired.app.playbackFeedback?.canRetry, expired);
  await deadline.page.waitForFunction(() => window.preparationFault.deletes.includes(window.preparationFault.entries[0].id));
  check('deadline cleanup deletes the original owned task once without creating a replacement', (await state(deadline.page)).fault.deletes.filter(x => x === oldId).length === 1
    && (await state(deadline.page)).fault.creates === 1);
  await deadline.page.locator('#retry-playback').click(); await playing(deadline.page);
  await deadline.page.evaluate(() => window.preparationFault.release(0));
  await deadline.page.waitForFunction(() => window.preparationFault.snapshot().entries[0].cancelled === 1);
  const recovered = await state(deadline.page);
  check('late ready status cannot replace explicit playback retry after the total deadline', recovered.app.state === 'playing'
    && recovered.fault.creates === 2 && recovered.fault.entries[0].cancelled === 1 && !recovered.app.pending
    && recovered.app.audio.some(a => !a.paused && !a.source.includes('/tasks/' + oldId + '/')), recovered);
  await deadline.context.close(); contexts.splice(contexts.indexOf(deadline.context), 1);

  const mismatch = await fresh(); await arm(mismatch.page, 'changed-id');
  await mismatch.page.locator('#results .play-track').first().click();
  await mismatch.page.waitForFunction(() => window.libraryLab.snapshot().playbackFeedback?.canRetry); await idle(mismatch.page);
  const malformed = await state(mismatch.page);
  check('a replacement polling ID is rejected and releases the original owned task', malformed.app.resources.mediaTasks === 0
    && malformed.fault.deletes.filter(x => x === malformed.fault.entries[0].id).length === 1
    && !malformed.fault.deletes.includes('b'.repeat(32)) && !mismatch.mediaRequests.length, malformed);
  await mismatch.page.locator('#retry-playback').click(); await playing(mismatch.page);
  check('a malformed status reply can recover with one explicit retry', (await state(mismatch.page)).fault.creates === 2);
  await mismatch.context.close(); contexts.splice(contexts.indexOf(mismatch.context), 1);

  const cancelled = await fresh(); await arm(cancelled.page, 'cancel');
  await cancelled.page.locator('#results .play-track').first().click();
  await cancelled.page.waitForFunction(() => window.preparationFault.entries[0]?.polls === 1);
  const started = Date.now(); await cancelled.page.locator('#transport').click(); await idle(cancelled.page);
  await cancelled.page.waitForFunction(() => window.preparationFault.deletes.includes(window.preparationFault.entries[0].id));
  check('pause cancels a pending status poll and deletes its original task promptly', Date.now() - started < 2000
    && (await state(cancelled.page)).app.resources.mediaTasks === 0, { elapsedMs: Date.now() - started, state: await state(cancelled.page) });
  await cancelled.page.locator('#results .play-track').last().click(); await playing(cancelled.page);
  await cancelled.page.evaluate(() => window.preparationFault.release(0));
  await cancelled.page.waitForFunction(() => window.preparationFault.snapshot().entries[0].cancelled === 1);
  const later = await state(cancelled.page);
  check('cancelled late poll cannot restore the previous selected track', later.app.track.songId === fixture.tracks[1].songId && later.app.state === 'playing'
    && later.fault.creates === 2 && !later.app.pending, later);
  await cancelled.context.close(); contexts.splice(contexts.indexOf(cancelled.context), 1);
  check('no page JavaScript errors or unhandled late status failures', report.errors.length === 0, report.errors);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1;
  report.failureStates = await Promise.all(contexts.flatMap(c => c.pages()).map(page => state(page).catch(() => null)));
} finally {
  await Promise.allSettled(contexts.map(c => c.close())); if (browser) await browser.close();
  report.fixtureBeforeClose = fixture.metrics(); await fixture.close(); report.fixtureClosed = true; report.fixtureAfterClose = fixture.metrics();
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'task-preparation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
