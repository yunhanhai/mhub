// Real browser, generated JPEG/audio and simulated loopback API only.
// node scripts/library-lab/verify-artwork-recovery.mjs REPORT_DIR
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowserFixture } from './browser-fixture.mjs';

const output = process.argv[2]; assert.ok(output, 'Expected REPORT_DIR');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startBrowserFixture({ artwork: true });
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  scope: 'Actual desktop browser, generated JPEG and MP3, IndexedDB and Service Worker with explicitly simulated API. Header-only stalled artwork and deliberately stalled bitmap decoding. No real backend authorization, mobile device or screen-reader claim.' };
let browser;
const contexts = [];
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), detail }); assert.ok(passed, name); };
async function pageWith(mode) {
  fixture.control.artworkMode = mode;
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } }); contexts.push(context);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === fixture.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  return { context, page };
}
async function load(page) {
  await page.goto(fixture.origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  const release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  if (report.release) assert.equal(release, report.release); else report.release = release;
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version() };

  const normal = await pageWith('normal'); await load(normal.page);
  await normal.page.waitForFunction(() => document.querySelector('#results .track-cover img'));
  check('generated authorized JPEG displays in browser', await normal.page.locator('#results .track-cover img').first().evaluate(el => el.complete && el.naturalWidth === 16));
  await normal.context.close(); contexts.splice(contexts.indexOf(normal.context), 1);

  const stalled = await pageWith('stall'); await load(stalled.page);
  await stalled.page.locator('#results .play-track').first().click();
  await stalled.page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2), null, { timeout: 2000 });
  check('stalled artwork does not block native playback', true);
  await stalled.page.locator('#transport').click();
  await stalled.page.locator('#results .save-offline').first().click();
  await stalled.page.waitForFunction(() => window.libraryLab.snapshot().cache.length === 1 && window.libraryLab.snapshot().pending === 0, null, { timeout: 5000 });
  await stalled.page.waitForTimeout(200);
  check('artwork deadline lets the saved audio operation finish', (await stalled.page.locator('#notice').innerText()).includes('已保存') && fixture.metrics().artworkClosed > 0, fixture.metrics());
  await stalled.page.waitForFunction(() => document.getElementById('offline-shell-state').textContent.includes('已准备好'));
  await stalled.context.setOffline(true); await stalled.page.reload(); await stalled.page.waitForFunction(() => window.libraryLabReady);
  await stalled.page.locator('#results .play-track').first().click();
  await stalled.page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.source.startsWith('blob:')));
  check('saved audio with missing cover reopens and plays offline', true);
  await stalled.context.close(); contexts.splice(contexts.indexOf(stalled.context), 1);

  const decoding = await pageWith('normal');
  await decoding.page.addInitScript(() => { window.createImageBitmap = () => new Promise(() => {}); });
  await load(decoding.page);
  await decoding.page.locator('#results .save-offline').first().click();
  await decoding.page.waitForFunction(() => window.libraryLab.snapshot().offlineDownloads.some(t => t.phase === 'finishing'));
  const cancel = decoding.page.locator('.cancel-save'); await cancel.focus();
  const start = Date.now(); await decoding.page.keyboard.press('Enter');
  await decoding.page.waitForFunction(() => window.libraryLab.snapshot().pending === 0, null, { timeout: 1000 });
  const state = await decoding.page.evaluate(() => ({ snapshot: window.libraryLab.snapshot(), notice: document.getElementById('notice').textContent, focus: document.activeElement.id }));
  check('cancel stops waiting for a stalled bitmap promptly', Date.now() - start < 1000, { elapsedMs: Date.now() - start });
  check('cancelled cover completion preserves committed audio', state.snapshot.cache.length === 1 && state.notice.includes('音频已保存') && state.notice.includes('已取消'), state);
  check('cancelled save restores a visible offline heading focus', state.focus === 'offline-heading');
  await decoding.page.waitForTimeout(2700);
  check('late cover timeout leaves the saved original and no pending operation', await decoding.page.evaluate(() => window.libraryLab.snapshot().cache.length === 1 && window.libraryLab.snapshot().pending === 0));
  check('no page JavaScript errors', !report.errors.length, report.errors);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1; }
finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  if (browser) await browser.close();
  report.fixture = fixture.metrics(); await fixture.close(); report.fixtureClosed = true;
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await writeFile(path.join(output, 'artwork-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount, failure: report.failure }));
}
