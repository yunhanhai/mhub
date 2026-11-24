// Actual browser and built interface, generated MP3 and simulated loopback API.
// Faults replace only a selected Blob read or WebCrypto digest in the page.
// node scripts/library-lab/verify-audio-integrity.mjs REPORT_DIR
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
  scope: 'Actual built desktop interface, generated MP3, IndexedDB and Service Worker with simulated loopback API. Page-only injection stalls a selected audio Blob read or WebCrypto digest. Production verification deadline is not shortened. No real source, physical phone, screen-reader or CPU preemption claim.' };
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
    const originalRead = Blob.prototype.arrayBuffer, originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const fault = window.audioIntegrityFault = { next: null, captured: [] };
    const hold = (phase, complete) => {
      const entry = { phase, started: performance.now(), released: false, settled: false }; fault.captured.push(entry);
      return new Promise((resolve, reject) => {
        entry.release = async fail => {
          entry.released = true;
          if (fail) { entry.settled = true; reject(new Error('Injected late verification failure')); return; }
          try { const value = await complete(); entry.settled = true; resolve(value); }
          catch (error) { entry.settled = true; reject(error); }
        };
      });
    };
    Blob.prototype.arrayBuffer = function(...args) {
      if (fault.next === 'read' && this.type.startsWith('audio/')) { fault.next = null; return hold('read', () => originalRead.apply(this, args)); }
      return originalRead.apply(this, args);
    };
    crypto.subtle.digest = function(algorithm, bytes) {
      if (fault.next === 'mismatch' && bytes.byteLength > 4096) { fault.next = null; return Promise.resolve(new Uint8Array(32).buffer); }
      if (fault.next === 'digest' && bytes.byteLength > 4096) { fault.next = null; return hold('digest', () => originalDigest(algorithm, bytes)); }
      return originalDigest(algorithm, bytes);
    };
    fault.release = (index, fail = false) => fault.captured[index].release(fail);
    fault.snapshot = () => fault.captured.map(({ phase, started, released, settled }) => ({ phase, elapsedMs: performance.now() - started, released, settled }));
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(fixture.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  const release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  if (report.release) assert.equal(release, report.release); else report.release = release;
  return { page, context };
}
async function state(page) {
  return page.evaluate(() => ({ app: window.libraryLab.snapshot(), fault: window.audioIntegrityFault.snapshot(),
    notice: document.getElementById('notice').textContent, focus: document.activeElement.id }));
}
async function idle(page, timeout = 1500) {
  await page.waitForFunction(() => { const s = window.libraryLab.snapshot();
    return !s.pending && !s.loading && !s.pendingPlaybackActions && !s.resources.playbackRequests;
  }, null, { timeout });
}
async function saved(page, count = 1) {
  await page.waitForFunction(count => window.libraryLab.snapshot().cache.length === count && !window.libraryLab.snapshot().pending, count);
}
async function arm(page, phase) { await page.evaluate(phase => { window.audioIntegrityFault.next = phase; }, phase); }
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };
  const deadlines = [];
  for (const phase of ['read', 'digest']) {
    const sample = await fresh(); await arm(sample.page, phase);
    await sample.page.locator('#results .save-offline').first().click();
    await sample.page.waitForFunction(() => window.audioIntegrityFault.captured.length === 1);
    deadlines.push({ ...sample, phase });
  }
  for (const phase of ['read', 'digest']) {
    const sample = await fresh(), { page } = sample;
    await arm(page, phase); await page.locator('#results .save-offline').first().click();
    await page.waitForFunction(() => window.audioIntegrityFault.captured.length === 1);
    const started = Date.now(); await page.locator('.cancel-save').focus(); await page.keyboard.press('Enter'); await idle(page);
    const cancelled = await state(page);
    check('cancel save settles a stalled audio ' + phase + ' promptly', Date.now() - started < 1500 && cancelled.app.cache.length === 0
      && !cancelled.app.offlineDownloads.length && cancelled.focus === 'offline-heading' && cancelled.notice.includes('已取消'), { elapsedMs: Date.now() - started, state: cancelled });
    await page.locator('#results .save-offline').first().click(); await saved(page);
    check('manual save retry succeeds while the cancelled ' + phase + ' is still pending', (await state(page)).fault[0].settled === false);
    await page.evaluate(fail => window.audioIntegrityFault.release(0, fail), phase === 'digest');
    await page.waitForTimeout(150);
    const late = await state(page);
    check('late cancelled ' + phase + ' cannot replace the committed retry or revive pending work', late.app.cache.length === 1 && !late.app.pending
      && late.fault[0].settled && late.notice.includes('已保存'), late);
    await sample.context.close(); contexts.splice(contexts.indexOf(sample.context), 1);
  }

  await Promise.all(deadlines.map(async sample => {
    await idle(sample.page, 13000);
    const timed = await state(sample.page), elapsedMs = timed.fault[0].elapsedMs;
    check('real verification deadline releases a stalled ' + sample.phase + ' without saving unverified audio', elapsedMs >= 9500 && elapsedMs < 15000
      && timed.app.cache.length === 0 && !timed.app.offlineDownloads.length && timed.notice.includes('校验超时'), { elapsedMs, state: timed });
    await sample.page.locator('#results .save-offline').first().click(); await saved(sample.page);
    await sample.page.evaluate(fail => window.audioIntegrityFault.release(0, fail), sample.phase === 'digest');
    await sample.page.waitForTimeout(150);
    const late = await state(sample.page);
    check('manual save retry survives late ' + sample.phase + ' after its verification deadline', late.app.cache.length === 1 && !late.app.pending
      && late.fault[0].settled && late.notice.includes('已保存'), late);
    await sample.context.close(); contexts.splice(contexts.indexOf(sample.context), 1);
  }));

  const corrupt = await fresh(); await arm(corrupt.page, 'mismatch');
  await corrupt.page.locator('#results .save-offline').first().click(); await idle(corrupt.page, 5000);
  const rejected = await state(corrupt.page);
  const records = await corrupt.page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('music-splayer-web-cache-v1', 1); opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { const db = opening.result, request = db.transaction('tracks', 'readonly').objectStore('tracks').getAll();
      request.onsuccess = () => { db.close(); resolve(request.result.length); }; request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
  check('a mismatching digest never commits an audio record to IndexedDB', records === 0 && rejected.app.cache.length === 0 && rejected.notice.includes('校验失败'), rejected);
  await corrupt.page.locator('#results .save-offline').first().click(); await saved(corrupt.page);
  check('a rejected hash can be retried with complete matching audio', true);
  await corrupt.context.close(); contexts.splice(contexts.indexOf(corrupt.context), 1);

  const playback = await fresh(), { page, context } = playback;
  await page.locator('#results .save-offline').first().click(); await saved(page);
  await page.locator('#results .save-offline').nth(1).click(); await saved(page, 2);
  await page.waitForFunction(() => document.getElementById('offline-shell-state').textContent.includes('已准备好'));
  await context.setOffline(true); await page.reload(); await page.waitForFunction(() => window.libraryLabReady);
  const selectedSong = await page.evaluate(() => window.libraryLab.snapshot().cache[1].songId);
  await arm(page, 'digest'); await page.locator('#results .play-track').first().click();
  await page.waitForFunction(() => window.audioIntegrityFault.captured.length === 1);
  const stoppedAt = Date.now(); await page.locator('#transport').click(); await idle(page);
  check('pause settles verification of a saved original promptly', Date.now() - stoppedAt < 1500 && (await state(page)).app.cache.length === 2, { elapsedMs: Date.now() - stoppedAt });
  await page.locator('#results .play-track').nth(1).click();
  await page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.source.startsWith('blob:') && a.time > .1));
  check('another saved original plays offline while the old digest is still pending', (await state(page)).fault[0].settled === false);
  await page.evaluate(() => window.audioIntegrityFault.release(0)); await page.waitForTimeout(150);
  const later = await state(page);
  check('late offline digest cannot switch the newer audio or reenter pending state', later.app.track.songId === selectedSong
    && later.app.state === 'playing' && !later.app.pending && !later.app.pendingPlaybackActions && later.app.cache.length === 2, later);

  await page.locator('#transport').click();
  await arm(page, 'read'); await page.locator('#results .play-track').first().click();
  await page.waitForFunction(() => window.audioIntegrityFault.captured.length === 2);
  await page.waitForFunction(() => window.libraryLab.snapshot().playbackFeedback?.canRetry, null, { timeout: 13000 }); await idle(page);
  const offlineTimeout = await state(page);
  check('offline verification deadline preserves both saved originals and enables playback retry', offlineTimeout.app.cache.length === 2
    && offlineTimeout.app.playbackFeedback?.canRetry && offlineTimeout.notice.includes('校验超时'), offlineTimeout);
  await page.locator('#retry-playback').click();
  await page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.source.startsWith('blob:') && a.time > .1));
  const recovered = await state(page);
  check('explicit retry after an offline verification deadline plays the saved original', recovered.app.cache.length === 2 && recovered.app.offlineMode);
  await page.evaluate(() => window.audioIntegrityFault.release(1, true)); await page.waitForTimeout(150);
  const lateFailure = await state(page);
  check('late failed Blob read cannot replace successful offline retry feedback', lateFailure.app.state === 'playing' && !lateFailure.app.playbackFeedback
    && !lateFailure.app.pending && lateFailure.notice.includes('正在播放'), lateFailure);
  check('no page JavaScript errors or unhandled late verification failures', report.errors.length === 0, report.errors);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1;
  report.failureStates = await Promise.all(contexts.flatMap(context => context.pages()).map(page => state(page).catch(() => null)));
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  if (browser) await browser.close();
  report.fixtureBeforeClose = fixture.metrics(); await fixture.close(); report.fixtureClosed = true; report.fixtureAfterClose = fixture.metrics();
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'audio-integrity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
