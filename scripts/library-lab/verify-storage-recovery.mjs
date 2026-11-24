// Actual browser, IndexedDB transactions and generated MP3; simulated loopback API.
// Selected native transactions are kept alive until cancellation or their real deadline.
// node scripts/library-lab/verify-storage-recovery.mjs REPORT_DIR
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
  scope: 'Actual built desktop interface, native IndexedDB and generated MP3 with simulated loopback API. Explicit page-only fault keeps one selected native transaction alive with requests; no product timer override. Tests abort/rollback and manual recovery, not disk hardware or physical device behavior.' };
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
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    const fault = window.storageFault = { next: null, captured: [], afterPut: false };
    const held = new WeakMap();
    fault.snapshot = () => fault.captured.map(entry => ({ mode: entry.mode, done: entry.done, puts: entry.puts,
      elapsedMs: (entry.finished ?? performance.now()) - entry.started }));
    IDBDatabase.prototype.transaction = function(names, mode, options) {
      const tx = transaction.call(this, names, mode, options);
      if (this.name !== 'music-splayer-web-cache-v1' || mode !== fault.next) return tx;
      fault.next = null;
      const entry = { mode, started: performance.now(), done: null, puts: 0 }; fault.captured.push(entry); held.set(tx, entry);
      tx.addEventListener('complete', () => { entry.done = 'complete'; entry.finished = performance.now(); });
      tx.addEventListener('abort', () => { entry.done = 'abort'; entry.finished = performance.now(); });
      const store = tx.objectStore('tracks');
      const pump = () => { if (!entry.done) store.get('__storage_recovery_probe__').onsuccess = pump; }; pump();
      return tx;
    };
    IDBObjectStore.prototype.put = function(...args) {
      const entry = held.get(this.transaction); if (entry) entry.puts++;
      if (fault.afterPut) {
        fault.afterPut = false;
        this.transaction.addEventListener('complete', () => { fault.next = 'readonly'; }, { once: true });
      }
      return put.apply(this, args);
    };
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(fixture.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  const release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  if (report.release) assert.equal(release, report.release); else report.release = release;
  return { context, page };
}
async function state(page) {
  return page.evaluate(() => ({ app: window.libraryLab.snapshot(), fault: window.storageFault.snapshot(),
    notice: document.getElementById('notice').textContent, focus: document.activeElement.id }));
}
async function idle(page, timeout = 2000) {
  await page.waitForFunction(() => !window.libraryLab.snapshot().pending && !window.libraryLab.snapshot().offlineDownloads.length, null, { timeout });
}
async function saved(page, count) {
  await page.waitForFunction(count => window.libraryLab.snapshot().cache.length === count && !window.libraryLab.snapshot().pending, count);
}
async function inventory(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('music-splayer-web-cache-v1', 1); opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('tracks', 'readonly'), read = tx.objectStore('tracks').getAll();
      tx.oncomplete = () => { db.close(); resolve(read.result.map(item => ({ key: item.key, bytes: item.blob?.size || 0 }))); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function arm(page, mode = 'readwrite') { await page.evaluate(mode => { window.storageFault.next = mode; }, mode); }
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };

  const timeout = await fresh(); await timeout.page.locator('#results .save-offline').first().click(); await saved(timeout.page, 1);
  const original = await inventory(timeout.page); await arm(timeout.page);
  await timeout.page.locator('#results .save-offline').last().click();
  await timeout.page.waitForFunction(() => window.storageFault.snapshot()[0]?.puts > 0);
  await idle(timeout.page, 13000);
  await timeout.page.waitForFunction(() => window.storageFault.snapshot()[0]?.done === 'abort');
  const timed = await state(timeout.page), remaining = await inventory(timeout.page), elapsed = timed.fault[0].elapsedMs;
  check('real write deadline aborts a stalled native transaction and releases save waiting', elapsed >= 9500 && elapsed < 13000
    && timed.notice.includes('写入超时') && timed.fault[0].puts === 1, timed);
  check('timed out write rolls back its audio and preserves the previous original', remaining.length === 1 && remaining[0].key === original[0].key, remaining);
  await timeout.page.locator('#results .save-offline').last().click(); await saved(timeout.page, 2);
  check('manual save retry works after the write transaction deadline', (await inventory(timeout.page)).length === 2);
  await timeout.context.close(); contexts.splice(contexts.indexOf(timeout.context), 1);

  const cancelled = await fresh(); await arm(cancelled.page);
  await cancelled.page.locator('#results .save-offline').first().click();
  await cancelled.page.waitForFunction(() => window.storageFault.snapshot()[0]?.puts > 0);
  const started = Date.now(); await cancelled.page.locator('.cancel-save').focus(); await cancelled.page.keyboard.press('Enter'); await idle(cancelled.page);
  await cancelled.page.waitForFunction(() => window.storageFault.snapshot()[0]?.done === 'abort');
  const stopped = await state(cancelled.page);
  check('caller cancellation aborts the native write and restores offline heading focus', Date.now() - started < 2000
    && stopped.focus === 'offline-heading' && stopped.notice.includes('已取消') && (await inventory(cancelled.page)).length === 0,
    { elapsedMs: Date.now() - started, state: stopped });
  await cancelled.page.locator('#results .save-offline').first().click(); await saved(cancelled.page, 1);
  check('cancelled write leaves no poisoned storage connection or save operation', (await inventory(cancelled.page)).length === 1);
  await cancelled.context.close(); contexts.splice(contexts.indexOf(cancelled.context), 1);

  const removal = await fresh(); await removal.page.locator('#results .save-offline').first().click(); await saved(removal.page, 1);
  await arm(removal.page); await removal.page.locator('#offline-tracks [data-offline-action="remove"]').first().click();
  await removal.page.waitForFunction(() => window.storageFault.captured.length === 1); await idle(removal.page, 13000);
  await removal.page.waitForFunction(() => window.storageFault.snapshot()[0]?.done === 'abort');
  check('a stalled removal deadline preserves its existing audio record', (await inventory(removal.page)).length === 1, await state(removal.page));
  await removal.page.locator('#offline-tracks [data-offline-action="remove"]').first().click(); await saved(removal.page, 0);
  check('explicit removal retry succeeds after rollback', (await inventory(removal.page)).length === 0);
  await removal.context.close(); contexts.splice(contexts.indexOf(removal.context), 1);

  const committed = await fresh();
  await committed.page.evaluate(() => { window.storageFault.afterPut = true; });
  await committed.page.locator('#results .save-offline').first().click();
  await committed.page.waitForFunction(() => window.storageFault.captured.length === 1);
  const afterCommit = Date.now(); await committed.page.locator('.cancel-save').focus(); await committed.page.keyboard.press('Enter');
  await idle(committed.page); const kept = await state(committed.page);
  check('cancelling post-commit maintenance reports the saved audio and releases caller waiting', Date.now() - afterCommit < 2000
    && kept.notice.includes('音频已保存') && kept.notice.includes('已取消') && kept.app.cache.length === 1
    && kept.focus === 'offline-heading', { elapsedMs: Date.now() - afterCommit, state: kept });
  await committed.page.waitForFunction(() => window.storageFault.snapshot()[0]?.done === 'abort', null, { timeout: 4000 });
  check('shared readonly maintenance deadline leaves committed audio intact', (await inventory(committed.page)).length === 1);
  await committed.page.locator('#results .save-offline').last().click(); await saved(committed.page, 2);
  check('later saves recover after cancelled post-commit maintenance', (await inventory(committed.page)).length === 2);
  await committed.context.close(); contexts.splice(contexts.indexOf(committed.context), 1);
  check('no page JavaScript errors', report.errors.length === 0, report.errors);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1;
  report.failureStates = await Promise.all(contexts.flatMap(c => c.pages()).map(page => state(page).catch(() => null)));
} finally {
  await Promise.allSettled(contexts.map(c => c.close())); if (browser) await browser.close();
  report.fixtureBeforeClose = fixture.metrics(); await fixture.close(); report.fixtureClosed = true; report.fixtureAfterClose = fixture.metrics();
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'storage-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
