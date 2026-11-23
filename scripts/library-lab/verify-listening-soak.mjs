// Sustained desktop native playback with generated MP3/FLAC and simulated API.
// node scripts/library-lab/verify-listening-soak.mjs REPORT_DIR [SECONDS=1800]
// PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and FFMPEG_EXECUTABLE select local tools.
// This measures this isolated browser, not backend capacity or physical phones.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBrowserFixture } from './browser-fixture.mjs';

const output = process.argv[2], seconds = Number(process.argv[3] || 1800);
assert.ok(output, 'Expected REPORT_DIR');
assert.ok(Number.isInteger(seconds) && seconds >= 48 && seconds <= 14400, 'Use 48..14400 actual seconds');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startBrowserFixture({ durationSeconds: 12, formats: ['mp3', 'flac'] });
const report = { startedAt: new Date().toISOString(), requestedSeconds: seconds, checks: [], errors: [], samples: [], cycles: [],
  scope: 'Actual desktop Chromium-family browser, rate-1 native MP3/FLAC EOF, generated originals, real IndexedDB/Service Worker and explicitly simulated loopback API. No Rust/Navidrome authorization, whole-PC memory, audible output, phone background or hours-long guarantee.' };
let browser, context, page, cdp, system, lastMemory = 0;
const check = (name, passed, detail) => { report.checks.push({ name, passed: Boolean(passed), detail }); assert.ok(passed, name); };
const dump = () => writeFile(path.join(output, 'listening-soak.json'), JSON.stringify(report, null, 2) + '\n');
async function processMemory(ids) {
  if (process.platform !== 'win32') return null;
  assert.ok(ids.length && ids.every(Number.isInteger));
  const source = '$sampleIds=@(' + ids.join(',') + '); @((Get-Process -Id $sampleIds -ErrorAction Stop) | ForEach-Object {'
    + '[pscustomobject]@{id=$_.Id;workingSetBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64;cpuSeconds=$_.TotalProcessorTime.TotalSeconds}}) | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    (error, stdout) => error ? reject(new Error('Renderer process sampling failed')) : resolve([JSON.parse(stdout)].flat())));
}
async function sample(phase, collect = false) {
  if (collect) await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const renderer = (await system.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer');
  const value = { phase, at: new Date().toISOString(), garbageCollected: collect, heapBytes: metrics.JSHeapUsedSize,
    domNodes: metrics.Nodes, listeners: metrics.JSEventListeners, taskSeconds: metrics.TaskDuration,
    rendererCpu: renderer.map(p => ({ id: p.id, cpuSeconds: p.cpuTime })),
    rendererMemory: await processMemory(renderer.map(p => p.id)), snapshot: await page.evaluate(() => window.libraryLab.snapshot()), fixture: fixture.metrics() };
  report.samples.push(value); lastMemory = Date.now(); await dump();
  return value;
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  report.browser = { engine: 'Chromium', version: browser.version(), executableSpecified: Boolean(process.env.BROWSER_EXECUTABLE) };
  system = await browser.newBrowserCDPSession();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === fixture.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    window.__soak = { ended: [], nativeErrors: [], progressCount: 0, stalledMs: 0, maxStallMs: 0, previous: null };
    document.addEventListener('ended', event => {
      const audio = event.target;
      if (audio.tagName === 'AUDIO') window.__soak.ended.push({ at: performance.now(), trusted: event.isTrusted,
        time: audio.currentTime, duration: audio.duration, rate: audio.playbackRate, source: audio.currentSrc || audio.src });
    }, true);
    document.addEventListener('error', event => {
      if (event.target.tagName === 'AUDIO') window.__soak.nativeErrors.push({ code: event.target.error?.code, at: performance.now() });
    }, true);
    setInterval(() => {
      if (!window.libraryLab) return;
      const snapshot = window.libraryLab.snapshot(), audio = snapshot.audio.find(a => !a.paused && !a.ended);
      const current = { at: performance.now(), playing: snapshot.state === 'playing' && !snapshot.loading, source: audio?.source, time: audio?.time };
      const previous = window.__soak.previous;
      if (previous?.playing && current.playing && previous.source === current.source && current.time != null && current.time <= previous.time + .01) {
        window.__soak.stalledMs += current.at - previous.at;
        window.__soak.maxStallMs = Math.max(window.__soak.maxStallMs, window.__soak.stalledMs);
      } else window.__soak.stalledMs = 0;
      window.__soak.previous = current; window.__soak.progressCount++;
    }, 500);
  });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(fixture.origin + '/library/');
  await page.waitForFunction(() => window.libraryLabReady && document.getElementById('offline-shell-state').textContent.includes('已准备好'));
  report.release = await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  report.originals = fixture.tracks.map(({ title, format, version, byte_size, duration }) => ({ title, format, version, bytes: byte_size, duration }));
  cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  await sample('initial', true);

  async function runPhase(phase) {
    const start = Date.now(), deadline = start + seconds * 500;
    let count = 0;
    while (Date.now() < deadline) {
      const eventStart = await page.evaluate(() => window.__soak.ended.length);
      await page.locator('#replace-queue').click();
      await page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().playIndex === 0);
      await page.waitForFunction(() => window.libraryLab.snapshot().state === 'stopped' && window.__soak.ended.length >= 2,
        null, { timeout: 35000 });
      const state = await page.evaluate(eventStart => ({ snapshot: window.libraryLab.snapshot(), ended: window.__soak.ended.slice(eventStart),
        progressCount: window.__soak.progressCount, maxStallMs: window.__soak.maxStallMs }), eventStart);
      check(phase + ' cycle ' + count + ' has two real EOFs at original speed', state.ended.length === 2
        && state.ended.every(e => e.trusted && e.rate === 1 && Math.abs(e.time - e.duration) < .08), state.ended);
      check(phase + ' cycle ' + count + ' keeps resource ownership bounded', state.snapshot.resources.audioUrls <= 2
        && state.snapshot.resources.mediaTasks <= 3 && state.snapshot.resources.playbackRequests === 0
        && state.snapshot.resources.offlineOperations === 0 && state.snapshot.pending === 0, state.snapshot.resources);
      report.cycles.push({ phase, index: count++, at: new Date().toISOString(), ...state, fixture: fixture.metrics() });
      if (Date.now() - lastMemory >= 60000) await sample(phase + '-periodic');
      await dump();
      console.log(JSON.stringify({ phase, cycle: count, actualPhaseSeconds: Math.round((Date.now() - start) / 1000),
        maxStallMs: state.maxStallMs, tasks: fixture.metrics().tasks, audioUrls: state.snapshot.resources.audioUrls }));
    }
    report[phase + 'Seconds'] = (Date.now() - start) / 1000;
    await sample(phase + '-complete', true);
  }
  await runPhase('online');
  for (const button of await page.locator('#results .save-offline').all()) {
    await button.click(); await page.waitForFunction(() => window.libraryLab.snapshot().pending === 0);
  }
  await page.waitForFunction(() => window.libraryLab.snapshot().cache.length === 2);
  await page.waitForTimeout(2000); await sample('saved-both', true);
  const offlineRequests = fixture.metrics().taskCreates;
  await context.setOffline(true); await page.waitForFunction(() => window.libraryLab.snapshot().offlineMode);
  await runPhase('offline');
  check('offline cycles use saved bytes without creating remote tasks', fixture.metrics().taskCreates === offlineRequests);
  const trace = await page.evaluate(() => window.__soak);
  report.observedProgress = { samples: trace.progressCount, maxStallMs: trace.maxStallMs, nativeErrors: trace.nativeErrors };
  check('no observed two-second native playback stall', trace.maxStallMs < 2000, report.observedProgress);
  check('no native or page errors', !trace.nativeErrors.length && !report.errors.length);

  await page.locator('#replace-queue').click(); await page.waitForFunction(() => window.libraryLab.snapshot().state === 'playing');
  await page.locator('#transport').click(); await page.waitForFunction(() => window.libraryLab.snapshot().state === 'paused');
  const pausedTime = await page.evaluate(() => window.libraryLab.snapshot().audio.find(a => a.attached)?.time);
  await page.waitForTimeout(1500);
  check('pause preserves attached native position', await page.evaluate(time => window.libraryLab.snapshot().audio.every(a => a.paused)
    && Math.abs(window.libraryLab.snapshot().audio.find(a => a.attached).time - time) < .08, pausedTime));
  for (let index = 0; index < 10; index++) {
    await page.locator('#next-track').click(); await page.waitForFunction(() => window.libraryLab.snapshot().pendingPlaybackActions === 0);
    await page.locator('#previous-track').click(); await page.waitForFunction(() => window.libraryLab.snapshot().pendingPlaybackActions === 0);
  }
  await page.locator('#transport').click(); await page.waitForTimeout(1600); await sample('after-reselection', true);
  check('repeated reselection keeps at most two audio Blob URLs', report.samples.at(-1).snapshot.resources.audioUrls <= 2);
  await page.reload(); await page.waitForFunction(() => window.libraryLabReady && window.libraryLab.snapshot().cache.length === 2);
  await page.waitForTimeout(1800); await sample('offline-reopened', true);
  const reopened = report.samples.at(-1).snapshot;
  check('offline reopen retains originals and releases player resources', reopened.queue.length === 0 && reopened.cache.length === 2
    && reopened.resources.audioUrls === 0 && reopened.resources.mediaTasks === 0 && reopened.audio.every(a => a.paused && !a.attached));
  report.fixtureBeforeCleanup = fixture.metrics();
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.message; report.stack = error.stack; process.exitCode = 1;
} finally {
  if (context) await context.setOffline(false).catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await fixture.close(); report.fixtureClosed = true;
  report.finishedAt = new Date().toISOString(); report.checkCount = report.checks.length;
  await dump(); console.log(JSON.stringify({ passed: report.passed, checks: report.checkCount,
    actualSeconds: (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000, failure: report.failure }));
}
