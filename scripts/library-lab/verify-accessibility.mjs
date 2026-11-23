// Exercise the built /library/ interface in a real browser, with an explicitly
// simulated local API and generated MP3. This does not verify Navidrome, a
// physical phone, or the spoken output of a screen reader.
// node scripts/library-lab/verify-accessibility.mjs REPORT_DIR
// PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE, AXE_CORE_PATH and FFMPEG_EXECUTABLE
// may select existing local tools. No personal accounts or audio are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
assert.ok(output, 'Expected REPORT_DIR');
await mkdir(output, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const audio = await new Promise((resolve, reject) => execFile(process.env.FFMPEG_EXECUTABLE || 'ffmpeg',
  ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30', '-ar', '44100', '-ac', '1', '-f', 'mp3', 'pipe:1'],
  { encoding: 'buffer', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
const version = createHash('sha256').update(audio).digest('hex');
const instanceId = 'accessibility-interface-fixture';
const tracks = ['First Light', 'Slow River'].map((title, index) => {
  const songId = 'synthetic-' + index;
  const id = 'library-lab:' + [instanceId, songId, version, 'raw'].map(encodeURIComponent).join(':');
  return { id, source_id: id, instanceId, songId, version, platform: 'navidrome', quality: 'raw', title,
    artist: 'Generated interface fixture', album: 'Keyboard verification', duration: 30000,
    format: 'mp3', content_type: 'audio/mpeg', byte_size: audio.length, access: 'public', offlineAllowed: true, streaming_mode: '' };
});
const users = new Map(), tasks = new Map(), checks = [], errors = [], scans = [], contexts = [], keyboardPaths = [];
let sessionDelay = 0, failNextMutation = false, failNextTask = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const session = /(?:^|;\s*)interface_fixture=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    if (url.pathname === '/api/v1/library/session') {
      const wait = sessionDelay;
      if (wait) await delay(wait);
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        if (failNextMutation) { failNextMutation = false; return json(response, 503, { error: { code: 'unavailable', message: '测试账号确认暂时不可用。' } }); }
        const input = JSON.parse(body);
        if (input.username !== 'fixture' || input.password !== 'fixture') return json(response, 401, { error: { code: 'source_auth', message: '账号或密码不正确，请重新输入。' } });
        const token = randomUUID(); users.set(token, { id: 'fixture-user', username: 'fixture' });
        return json(response, 200, { instanceId, user: users.get(token) }, { 'Set-Cookie': 'interface_fixture=' + token + '; HttpOnly; SameSite=Strict; Path=/' });
      }
      if (request.method === 'DELETE') { users.delete(session); return json(response, 200, { user: null }); }
      return json(response, 200, { instanceId, user: users.get(session) || null });
    }
    if (url.pathname === '/api/v1/library/search') return json(response, 200, { instanceId, tracks });
    if (url.pathname === '/api/v1/library/tasks' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body), track = tracks.find(t => t.songId === input.songId);
      if (!track) return json(response, 404, { error: { code: 'track_missing', message: '没有这首测试曲目' } });
      if (failNextTask) { failNextTask = false; return json(response, 503, { error: { code: 'source_unavailable', message: '测试音频暂时不可用，请重试播放。' } }); }
      const id = randomUUID().replaceAll('-', ''); tasks.set(id, track);
      return json(response, 200, { id, state: 'ready', track, mediaUrl: origin + '/api/v1/library/tasks/' + id + '/audio' });
    }
    const taskMatch = /^\/api\/v1\/library\/tasks\/([^/]+)(\/audio)?$/.exec(url.pathname);
    if (taskMatch) {
      const [, id, media] = taskMatch;
      if (request.method === 'DELETE') { tasks.delete(id); return json(response, 200, {}); }
      const track = tasks.get(id);
      if (!track) return json(response, 404, { error: { code: 'task_missing', message: '测试任务已结束' } });
      if (!media) return json(response, 200, { id, state: 'ready', track, mediaUrl: origin + url.pathname + '/audio' });
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      if (start >= audio.length) { response.writeHead(416, { 'Content-Range': 'bytes */' + audio.length }); return response.end(); }
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/mpeg', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}) });
      return response.end(request.method === 'HEAD' ? undefined : audio.subarray(start, end + 1));
    }
    if (!url.pathname.startsWith('/library/')) { response.writeHead(404); return response.end(); }
    const name = url.pathname.slice('/library/'.length) || 'index.html';
    if (!/^[\w.-]+$/.test(name)) { response.writeHead(404); return response.end(); }
    const bytes = await readFile(path.join(root, 'web/library', name));
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'application/javascript' : name.endsWith('.png') ? 'image/png' : 'application/manifest+json';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
} catch (error) {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;
}
const report = { startedAt: new Date().toISOString(), checks, errors, scans, keyboardPaths,
  browser: { engine: 'Chromium', version: browser.version(), executableSpecified: Boolean(process.env.BROWSER_EXECUTABLE) },
  scope: 'Actual built interface and Chromium-family browser keyboard, native generated MP3 and accessibility tree. Simulated API with two labelled synthetic metadata records sharing one generated MP3. No backend authorization, physical device or spoken screen-reader verification.' };
function check(name, passed, detail) { checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) }); }
async function fresh(width = 1440, height = 1000, theme = 'dark', touch = false) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'allow', reducedMotion: 'reduce',
    ...(touch ? { hasTouch: true, isMobile: true } : {}) }); contexts.push(context);
  await context.addInitScript(theme => localStorage.setItem('mhub-library-theme', theme), theme);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/library/'); await page.waitForFunction(() => window.libraryLabReady);
  report.release ||= await page.locator('meta[name=mhub-library-release]').getAttribute('content');
  return page;
}
async function enterCredentials(page, password = 'fixture') {
  await page.locator('#username').fill('fixture'); await page.locator('#password').fill(password);
  await page.locator('#password').focus(); await page.keyboard.press('Enter');
}
async function focusGeometry(page) {
  return page.evaluate(() => {
    const element = document.activeElement, rect = element.getBoundingClientRect(), player = document.querySelector('.player').getBoundingClientRect();
    const style = getComputedStyle(element);
    return { id: element.id, tag: element.tagName, name: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 90),
      visible: Boolean(element.getClientRects().length), disabled: Boolean(element.disabled), top: rect.top, bottom: rect.bottom,
      left: rect.left, right: rect.right, outline: style.outlineStyle,
      unobscured: rect.top >= 0 && rect.bottom <= (element.closest('main, .sidebar') ? player.top : innerHeight) + 1 && rect.left >= 0 && rect.right <= innerWidth + 1 };
  });
}
try {
  const page = await fresh();
  await page.keyboard.press('Tab');
  check('first Tab exposes skip link', await page.locator('.skip-link').evaluate(el => document.activeElement === el && el.getBoundingClientRect().top >= 0));
  await page.keyboard.press('Enter');
  check('skip link transfers focus to main content', await page.evaluate(() => document.activeElement.id === 'library-content'));
  await enterCredentials(page, 'wrong'); await page.waitForFunction(() => !document.querySelector('#login-error').hidden);
  const invalid = await page.evaluate(() => ({ focus: document.activeElement.id,
    fields: ['username', 'password'].map(id => { const el = document.getElementById(id); return { id, invalid: el.getAttribute('aria-invalid'), described: (el.getAttribute('aria-describedby') || '').split(' ').includes('login-error') }; }) }));
  check('login failure associates its error with both invalid fields', invalid.fields.every(f => f.invalid === 'true' && f.described), invalid);
  await enterCredentials(page); await page.waitForFunction(() => window.libraryLab.snapshot().user?.id === 'fixture-user');
  check('keyboard login retains visible account focus', (await focusGeometry(page)).id === 'identity' && (await focusGeometry(page)).unobscured, await focusGeometry(page));
  await page.locator('#logout').focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => !window.libraryLab.snapshot().user && window.libraryLab.snapshot().sessionState === 'ready');
  check('keyboard logout returns focus to username', (await focusGeometry(page)).id === 'username' && (await focusGeometry(page)).unobscured, await focusGeometry(page));
  sessionDelay = 250;
  await enterCredentials(page); await page.locator('#query').focus();
  await page.waitForFunction(() => window.libraryLab.snapshot().user?.id === 'fixture-user');
  check('completed login does not steal focus moved to search', await page.evaluate(() => document.activeElement.id === 'query'));
  sessionDelay = 0;

  const uncertain = await fresh();
  failNextMutation = true; await enterCredentials(uncertain);
  await uncertain.waitForFunction(() => window.libraryLab.snapshot().sessionState === 'unavailable');
  check('unconfirmed login moves focus to account retry', (await focusGeometry(uncertain)).id === 'retry-session' && (await focusGeometry(uncertain)).unobscured, await focusGeometry(uncertain));
  await uncertain.keyboard.press('Enter');
  await uncertain.waitForFunction(() => window.libraryLab.snapshot().sessionState === 'ready');
  await uncertain.waitForFunction(() => document.activeElement.id === 'identity', null, { timeout: 2000 }).catch(() => {});
  const retryFocus = await focusGeometry(uncertain);
  check('account retry preserves a visible focus after its button disappears', retryFocus.id === 'identity' && retryFocus.unobscured, retryFocus);

  const playback = await fresh();
  await playback.locator('#results .play-track').first().focus(); await playback.keyboard.press('Enter');
  await playback.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2));
  await playback.locator('#transport').focus(); await playback.keyboard.press('Space');
  await playback.waitForFunction(() => window.libraryLab.snapshot().state === 'paused');
  const before = await playback.locator('#seek').inputValue(); await playback.locator('#seek').focus(); await playback.keyboard.press('ArrowRight');
  await playback.waitForTimeout(150);
  const after = Number(await playback.locator('#seek').inputValue());
  check('ArrowRight seeks five seconds in paused native audio', Math.abs(after - Number(before) - 5) < .5, { before, after });
  const snapshot = await playback.context().newCDPSession(playback).then(async cdp => {
    const tree = await cdp.send('Accessibility.getFullAXTree'); await cdp.detach();
    return tree.nodes.filter(n => !n.ignored && ['slider', 'status', 'alert'].includes(n.role?.value)).map(n => ({ role: n.role.value, name: n.name?.value, value: n.value?.value,
      valueText: n.properties?.find(p => p.name === 'valuetext')?.value?.value, properties: n.role.value === 'slider' ? n.properties : undefined }));
  });
  report.sliderDOM = await playback.locator('#seek').evaluate(el => ({ value: el.value, valueText: el.getAttribute('aria-valuetext'), ariaValueText: el.ariaValueText }));
  check('seek exposes a named slider in browser accessibility tree', snapshot.some(n => n.role === 'slider' && n.name === '播放进度'), snapshot);
  check('seek supplies readable current and total time in ARIA', report.sliderDOM.valueText.includes('总时长') && report.sliderDOM.valueText.includes('0:30'), report.sliderDOM);
  report.accessibilityTreeLimitations = snapshot.filter(n => n.role === 'slider' && !String(n.valueText).includes(n.name === '音量' ? '%' : '总时长'))
    .map(n => ({ name: n.name, valueText: n.valueText, note: 'Accessibility-tree value text differs from the supplied readable ARIA text. Raw tree value retained; DOM attributes verified separately. Spoken screen-reader output remains untested.' }));
  check('volume exposes a percentage to assistive technology', await playback.locator('#volume').getAttribute('aria-valuetext') === '35%');
  await playback.locator('#playback-queue .queue-remove').last().focus(); await playback.keyboard.press('Enter');
  check('queue removal retains a usable focus', (await focusGeometry(playback)).id !== '' || await playback.evaluate(() => Boolean(document.activeElement.closest('#playback-queue'))));
  const saved = playback.locator('#results .track').first().locator('.save-offline');
  await saved.focus(); await playback.keyboard.press('Enter');
  await playback.waitForFunction(() => window.libraryLab.snapshot().cache.length === 1 && window.libraryLab.snapshot().pending === 0);
  check('keyboard save writes verified generated audio to IndexedDB', await playback.evaluate(() => window.libraryLab.snapshot().cache[0].bytes > 0 && document.activeElement.closest('#results') !== null));
  await playback.waitForFunction(() => document.querySelector('#offline-shell-state').textContent.includes('已准备好'));
  await playback.context().setOffline(true); await playback.reload(); await playback.waitForFunction(() => window.libraryLabReady);
  await playback.locator('#results .play-track').first().focus(); await playback.keyboard.press('Enter');
  await playback.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2));
  check('keyboard plays saved generated audio after offline reopen', await playback.evaluate(() => window.libraryLab.snapshot().offlineMode && window.libraryLab.snapshot().audio.some(a => a.source.startsWith('blob:') && !a.paused)));
  await playback.context().setOffline(false);

  for (const [width, height] of [[844, 390], [1024, 600]]) {
    const short = await fresh(width, height);
    for (const showFailure of [false, true]) {
      if (showFailure) {
        failNextTask = true; await short.locator('#results .play-track').first().click();
        await short.waitForFunction(() => !document.querySelector('#playback-feedback').hidden);
      }
      const entries = [];
      await short.locator('.brand').focus();
      for (let index = 0; index < 6; index++) {
        entries.push(await focusGeometry(short)); await short.keyboard.press('Tab');
      }
      check('short-window sidebar focus stays above player ' + width + '/' + (showFailure ? 'error' : 'normal'), entries.every(e => e.unobscured), entries);
      await short.screenshot({ path: path.join(output, `sidebar-${width}-${showFailure ? 'error' : 'normal'}.png`) });
    }
  }

  const touch = await fresh(375, 812, 'dark', true);
  await touch.locator('#results .play-track').first().tap();
  await touch.waitForFunction(() => window.libraryLab.snapshot().state === 'playing' && window.libraryLab.snapshot().audio.some(a => !a.paused && a.time > .2));
  await touch.locator('#transport').tap(); await touch.waitForFunction(() => window.libraryLab.snapshot().state === 'paused');
  const touchCdp = await touch.context().newCDPSession(touch);
  await touch.evaluate(() => {
    window.__touchSeekEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'input', 'change']) {
      document.getElementById('seek').addEventListener(type, event => window.__touchSeekEvents.push({ type, pointerType: event.pointerType, value: event.target.value }));
    }
    for (const audio of document.querySelectorAll('audio')) audio.addEventListener('seeking', () => window.__touchSeekEvents.push({ type: 'seeking', time: audio.currentTime }));
  });
  async function touchSeek(target, cancel = false) {
    const slider = touch.locator('#seek'), rect = await slider.boundingBox();
    const values = await slider.evaluate(el => ({ value: Number(el.value), max: Number(el.max) }));
    const point = ratio => ({ x: rect.x + 8 + (rect.width - 16) * ratio, y: rect.y + rect.height / 2, id: 1, radiusX: 1, radiusY: 1, force: 1 });
    const start = values.value / values.max;
    await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start)] });
    for (let index = 1; index <= 5; index++) {
      await touchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start + (target - start) * index / 5)] });
    }
    const preview = await touch.evaluate(() => window.libraryLab.snapshot());
    await touchCdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await touch.waitForTimeout(180);
    return { preview, final: await touch.evaluate(() => window.libraryLab.snapshot()) };
  }
  const gesture = await touchSeek(.55);
  const gestureEvents = await touch.evaluate(() => window.__touchSeekEvents.splice(0));
  check('synthesized touch previews before committing one native seek', gesture.preview.seekInput.preview && !gesture.final.seekInput.editing
    && Math.abs(gesture.final.seekInput.value - gesture.final.seekInput.max * .55) < 1
    && gestureEvents.filter(e => e.type === 'seeking').length === 1 && gestureEvents.some(e => e.pointerType === 'touch'), gestureEvents);
  const cancelled = await touchSeek(.8, true);
  const cancelEvents = await touch.evaluate(() => window.__touchSeekEvents.splice(0));
  check('touch cancellation discards preview without seeking', cancelled.preview.seekInput.preview && !cancelled.final.seekInput.editing
    && Math.abs(cancelled.final.seekInput.value - gesture.final.seekInput.value) < .3 && !cancelEvents.some(e => e.type === 'seeking'), cancelEvents);
  const resumed = await touchSeek(.25);
  check('new touch gesture works after cancellation', !resumed.final.seekInput.editing && Math.abs(resumed.final.seekInput.value - resumed.final.seekInput.max * .25) < 1);
  await touch.evaluate(() => window.__touchSeekEvents.splice(0));
  const tapRect = await touch.locator('#seek').boundingBox();
  await touch.touchscreen.tap(tapRect.x + 8 + (tapRect.width - 16) * .65, tapRect.y + tapRect.height / 2);
  await touch.waitForTimeout(180);
  const tapped = await touch.evaluate(() => ({ state: window.libraryLab.snapshot(), events: window.__touchSeekEvents.splice(0) }));
  check('single touch tap seeks without requiring a drag', !tapped.state.seekInput.editing && tapped.state.state === 'paused'
    && Math.abs(tapped.state.seekInput.value - tapped.state.seekInput.max * .65) < 1 && tapped.events.filter(e => e.type === 'seeking').length === 1, tapped.events);
  await touchCdp.detach();
  report.touchScope = 'CDP Input.dispatchTouchEvent on a desktop Chromium-family browser with touch/mobile context; no physical phone or lockscreen verification.';

  const configurations = [[1440, 1000, 'dark'], [1440, 1000, 'light'], [375, 812, 'dark'], [320, 700, 'light'], [844, 390, 'dark']];
  for (const [width, height, theme] of configurations) {
    const sample = await fresh(width, height, theme);
    await sample.locator('#append-results').focus(); await sample.keyboard.press('Enter');
    const pathEntries = []; await sample.evaluate(() => document.activeElement.blur());
    await sample.locator('.skip-link').focus();
    for (let index = 0; index < 65; index++) {
      await sample.keyboard.press('Tab'); const entry = await focusGeometry(sample);
      if (entry.tag === 'BODY') break;
      pathEntries.push(entry); if (entry.id === 'volume') break;
    }
    keyboardPaths.push({ width, height, theme, path: pathEntries });
    check('Tab path exposes visible unobscured controls ' + width + '/' + theme, pathEntries.length > 15 && pathEntries.every(e => e.visible && !e.disabled && e.unobscured && e.outline !== 'none'), pathEntries.filter(e => !e.visible || e.disabled || !e.unobscured || e.outline === 'none'));
    check('page fits without horizontal scrolling ' + width + '/' + theme, await sample.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await sample.locator('#results summary').first().focus(); await sample.keyboard.press('Enter'); await sample.keyboard.press('Tab'); await sample.keyboard.press('Escape');
    check('Escape closes track actions and restores summary focus ' + width + '/' + theme, await sample.evaluate(() => document.activeElement.tagName === 'SUMMARY' && !document.activeElement.parentElement.open));
    if (process.env.AXE_CORE_PATH) {
      await sample.addScriptTag({ path: process.env.AXE_CORE_PATH });
      const result = await sample.evaluate(async () => {
        const value = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return { violations: value.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })),
          incomplete: value.incomplete.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), passes: value.passes.length };
      });
      scans.push({ width, height, theme, ...result });
      check('axe WCAG rules pass ' + width + '/' + theme, result.violations.length === 0, result.violations);
      check('axe leaves no unresolved ARIA labeling findings ' + width + '/' + theme, !result.incomplete.some(v => v.id === 'aria-prohibited-attr'), result.incomplete);
    }
    await sample.locator('#username').focus();
    await sample.screenshot({ path: path.join(output, `keyboard-${width}-${theme}.png`), fullPage: false });
  }
  // At browser zoom, CSS media queries see a reduced layout viewport. CSS zoom
  // on <html> does not model that behavior; use equivalent CSS viewports here.
  for (const factor of [2, 4]) {
    const zoom = await fresh(1440 / factor, 1000 / factor);
    await zoom.locator('#username').focus();
    const layout = await zoom.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
      playerHeight: document.querySelector('.player').getBoundingClientRect().height }));
    check('zoom-equivalent viewport reflows without horizontal overflow ' + factor + 'x', layout.scrollWidth <= layout.width + 1, layout);
    check('zoom-equivalent viewport keeps account focus above player ' + factor + 'x', (await focusGeometry(zoom)).unobscured, await focusGeometry(zoom));
    await zoom.screenshot({ path: path.join(output, 'zoom-equivalent-' + factor + 'x.png') });
  }
  check('no JavaScript errors', errors.length === 0, errors);
} catch (error) { report.failure = error.message; report.stack = error.stack; }
finally {
  await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  tasks.clear(); users.clear(); report.fixtureClosed = true;
}
report.finishedAt = new Date().toISOString(); report.passed = !report.failure && checks.every(c => c.passed); report.checkCount = checks.length;
await writeFile(path.join(output, 'accessibility.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failed: checks.filter(c => !c.passed).map(c => c.name), failure: report.failure }));
if (!report.passed) process.exitCode = 1;
