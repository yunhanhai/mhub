/** Real Rust process termination, disk recovery and capacity checks.
 * LIBRARY_BACKEND=rust node verify-lifecycle.mjs CONFIG CREDENTIALS REPORT_DIR
 * MHUB_RUST_BINARY may select a frozen earlier binary for the same checks.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackend, apiBase, clientHeader, rustBackend } from './backend.mjs';
if (!rustBackend) throw new Error('This suite requires the actual Rust backend');
const [configFile, credentialsFile, output] = process.argv.slice(2);
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const config = await json(configFile), credentials = await json(credentialsFile), policy = await json(config.policyFile);
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'lifecycle-run-'));
const checks = [], scenarios = [], exchanges = [], apps = [];
const report = { recordedAt: new Date().toISOString(), scope: 'Real music-api child processes and real Navidrome original files; only owned child processes receive SIGKILL.', checks, scenarios, exchanges };
const check = (name, passed, details) => checks.push({ name, passed: Boolean(passed), ...(details ? { details } : {}) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await predicate()) return; await pause(50); } throw new Error('Timed out: ' + label); }
async function files(dir) { return (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.audio') || n.endsWith('.partial')); }
async function bytes(dir) { let size = 0; for (const n of await files(dir)) { const s = await stat(path.join(dir,n)); if (s.isFile()) size += s.size; } return size; }
async function request(app, route, { method = 'GET', data, headers = {} } = {}) {
  const r = await fetch(app.origin + route, { method, signal: AbortSignal.timeout(25000), headers: { origin: app.origin, [clientHeader]: '1', ...(app.cookie ? { cookie: app.cookie } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const body = Buffer.from(await r.arrayBuffer()), value = /json/.test(r.headers.get('content-type') || '') && body.length ? JSON.parse(body) : null;
  exchanges.push({ route, method, status: r.status, bytes: body.length, sha256: digest(body), ...(value?.error ? { error: value.error.code } : {}) });
  return { status: r.status, body, value, headers: r.headers };
}
async function start(dir, changes = {}) {
  await mkdir(dir, { recursive: true });
  const app = await createBackend({ ...config, ...changes, cacheDir: path.join(dir,'cache') }); apps.push(app);
  app.origin = await app.start(); return app;
}
async function login(app) {
  const r = await request(app, apiBase + '/session', { method: 'POST', data: credentials.accounts.a });
  assert.equal(r.status,200,'Owned A login must succeed'); app.cookie = r.headers.get('set-cookie').split(';')[0];
}
const selection = track => ({ instanceId: policy.instanceId, songId: track.songId, version: track.sha256 });
async function create(app, track) {
  const r = await request(app, apiBase + '/tasks', { method: 'POST', data: selection(track) });
  assert.equal(r.status,202,'Task must enter the real preparation path'); return r.value;
}
async function complete(app, task) {
  await until(async () => { task = (await request(app, apiBase + '/tasks/' + task.id)).value; return task.state !== 'preparing'; }, 'task completion'); return task;
}
async function scenario(name, operation) {
  const from = checks.length;
  try { await operation(); scenarios.push({ name, completed: true, checks: checks.length - from }); }
  catch (e) { checks.push({ name: name + ' completed without harness failure', passed: false, error: e.message }); scenarios.push({ name, completed: false }); }
}

let hold = false, prefixDelivered = false, streamClosed = false;
const proxy = http.createServer(async (req,res) => {
  const controller = new AbortController(); let closed;
  const ended = new Promise(resolve => { closed = resolve; });
  res.on('close', () => { controller.abort(); closed(); });
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const upstream = await fetch(config.source.baseUrl + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/x-www-form-urlencoded' }, body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error' });
    if (hold && req.url === '/rest/stream.view' && upstream.ok && /audio/.test(upstream.headers.get('content-type') || '')) {
      const reader = upstream.body.getReader(), prefix = Buffer.alloc(4096); let offset = 0;
      while (offset < prefix.length) { const part = await reader.read(); assert.ok(!part.done); const n = Math.min(part.value.length,prefix.length-offset); prefix.set(part.value.subarray(0,n),offset); offset += n; }
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type'), 'content-length': upstream.headers.get('content-length') });
      res.write(prefix); prefixDelivered = true; await ended; streamClosed = true; await reader.cancel().catch(()=>{});
    } else {
      const body = Buffer.from(await upstream.arrayBuffer()); res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type'), 'content-length': body.length }).end(body);
    }
  } catch (e) { if (!controller.signal.aborted) { res.destroy(); report.proxyError = e.message; } }
});
await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
const source = { ...config.source, baseUrl: 'http://127.0.0.1:' + proxy.address().port };
const [first, second] = policy.tracks.filter(t => t.access === 'public');
const restricted = policy.tracks.find(t => t.access === 'restricted');

try {
  await scenario('forced termination during a private original download', async () => {
    const dir = path.join(run,'crash'), cache = path.join(dir,'cache');
    hold = true; prefixDelivered = false; streamClosed = false;
    let app = await start(dir, { source }); await login(app);
    const task = await create(app,restricted);
    await until(async () => prefixDelivered && (await bytes(cache)) >= 4096,'partial reaches disk');
    check('real incomplete bytes exist before SIGKILL', (await bytes(cache)) === 4096);
    const other = await createBackend({ ...config, source, cacheDir: cache }); apps.push(other);
    let rejected = false; try { await other.start(); } catch { rejected = true; }
    check('a second process cannot manage an active cache directory', rejected);
    check('rejected process cannot erase the active partial', (await bytes(cache)) === 4096);
    await other.close(); const oldCookie = app.cookie;
    await app.crash(); await until(() => streamClosed,'source socket closes after process death'); await app.close();
    check('SIGKILL leaves a real partial for recovery to handle', (await files(cache)).some(n => n.endsWith('.partial')));
    await writeFile(path.join(cache,'keep-me.txt'),'unrelated sentinel');
    await mkdir(path.join(cache,'unrelated-directory'));
    await writeFile(path.join(cache,'unrelated-directory','keep-me.txt'),'nested sentinel');
    hold = false; app = await start(dir,{ source }); app.cookie = oldCookie;
    check('startup removes the abandoned owned partial before serving requests', !(await files(cache)).some(n => n.endsWith('.partial')));
    check('startup preserves unrelated files and directories', (await readFile(path.join(cache,'unrelated-directory','keep-me.txt'),'utf8')) === 'nested sentinel' && (await readFile(path.join(cache,'keep-me.txt'),'utf8')) === 'unrelated sentinel');
    check('crashed task id cannot be resumed', (await request(app,apiBase+'/tasks/'+task.id)).status === 404);
    check('crashed private session cannot use the cache', (await request(app,apiBase+'/tasks',{method:'POST',data:selection(restricted)})).status === 401);
    await login(app); const recovered = await complete(app,await create(app,restricted));
    assert.equal(recovered.state,'ready');
    check('recovery downloads and hashes the complete original', digest((await request(app,recovered.mediaUrl)).body) === restricted.sha256 && app.metrics.sourceDownloads === 1);
    check('recovery leaves no abandoned partial', !(await files(cache)).some(n => n.endsWith('.partial')));
    await app.close();
  });
  hold = false;
  await scenario('published file survival and corruption repair', async () => {
    const dir = path.join(run,'published'), cache = path.join(dir,'cache');
    let app = await start(dir); let task = await complete(app,await create(app,first)); assert.equal(task.state,'ready');
    await app.crash(); await app.close(); app = await start(dir);
    task = await complete(app,await create(app,first));
    check('a published file survives process death and is revalidated', task.state === 'ready' && app.metrics.cacheHits === 1 && app.metrics.sourceDownloads === 0 && digest((await request(app,task.mediaUrl)).body) === first.sha256);
    await app.close();
    const file = path.join(cache,(await files(cache)).find(n => n.endsWith('.audio')));
    const bad = await readFile(file); bad[bad.length-9] ^= 1; await writeFile(file,bad);
    app = await start(dir); task = await complete(app,await create(app,first));
    check('same-length corrupt persisted bytes are rejected and replaced', task.state === 'ready' && app.metrics.cacheHits === 0 && app.metrics.sourceDownloads === 1 && digest((await request(app,task.mediaUrl)).body) === first.sha256);
    await app.close();
  });
  await scenario('capacity respects ready tasks and evicts idle bytes', async () => {
    const dir = path.join(run,'capacity'), cache = path.join(dir,'cache'), max = Math.max(first.size,second.size);
    const app = await start(dir,{cacheMaxBytes:max}); const pinned = await complete(app,await create(app,first)); assert.equal(pinned.state,'ready');
    const blocked = await complete(app,await create(app,second));
    check('a live ready task prevents destructive eviction', blocked.state === 'failed' && blocked.error === 'cache_capacity');
    check('capacity rejection opens no second source download', app.metrics.sourceDownloads === 1);
    check('capacity remains within the configured byte budget', (await bytes(cache)) <= max, {bytes:await bytes(cache),max});
    check('the pinned task still returns its original bytes', digest((await request(app,pinned.mediaUrl)).body) === first.sha256);
    await request(app,apiBase+'/tasks/'+pinned.id,{method:'DELETE'});
    const replacement = await complete(app,await create(app,second));
    check('idle bytes can be reclaimed for another original', replacement.state === 'ready' && (await bytes(cache)) <= max && digest((await request(app,replacement.mediaUrl)).body) === second.sha256);
    await app.close();
  });
  await scenario('parallel download reservations', async () => {
    const dir = path.join(run,'reservations'), cache = path.join(dir,'cache'), max = first.size + second.size - 1;
    hold = true; prefixDelivered = false; streamClosed = false;
    const app = await start(dir,{source,cacheMaxBytes:max}); const a = await create(app,first);
    await until(async()=>prefixDelivered && (await bytes(cache)) >= 4096,'first reservation has partial bytes');
    // Second transfer must be rejected before it asks the held source for bytes.
    const b = await create(app,second); let result = b;
    for(let i=0;i<15&&result.state==='preparing';i++){await pause(75);result=(await request(app,apiBase+'/tasks/'+b.id)).value;}
    check('reserved future bytes prevent concurrent overcommit', result.state === 'failed' && result.error === 'cache_capacity');
    await request(app,apiBase+'/tasks/'+a.id,{method:'DELETE'});
    if(result.state==='preparing') await request(app,apiBase+'/tasks/'+b.id,{method:'DELETE'});
    await until(async()=>!(await files(cache)).some(n=>n.endsWith('.partial')),'reservations cancel and close files');
    hold = false; const restored = await complete(app,await create(app,second));
    check('cancellation releases reserved capacity for the next task', restored.state==='ready' && (await bytes(cache))<=max);
    await app.close();
  });
  await scenario('manifest replacement cancels an obsolete in-flight original', async () => {
    const dir=path.join(run,'obsolete-download'), cache=path.join(dir,'cache'), policyFile=path.join(dir,'policy.json');
    await mkdir(dir);await writeFile(policyFile,JSON.stringify(policy));
    hold=true;prefixDelivered=false;streamClosed=false;
    const app=await start(dir,{source,policyFile});const old=await create(app,first);
    await until(async()=>prefixDelivered&&(await bytes(cache))>=4096,'obsolete original starts');
    const changed=structuredClone(policy);changed.tracks.find(t=>t.songId===first.songId).sha256='f'.repeat(64);
    await writeFile(policyFile,JSON.stringify(changed));
    let stopped=false;try{await until(async()=>streamClosed&&!(await files(cache)).some(n=>n.endsWith('.partial')),'obsolete download cancelled');stopped=true;}catch{}
    await request(app,apiBase+'/session');
    check('manifest replacement closes the obsolete source and releases partial capacity',stopped&&app.metrics.reservedBytes===0);
    check('obsolete in-flight task cannot expose a response for the new version',(await request(app,apiBase+'/tasks/'+old.id)).status===409);
    await app.close();hold=false;
  });
  await scenario('an invalid policy cannot become a delete-all instruction', async () => {
    const dir=path.join(run,'invalid-policy'), cache=path.join(dir,'cache'), policyFile=path.join(dir,'policy.json');
    await mkdir(dir);await writeFile(policyFile,JSON.stringify(policy));
    const app=await start(dir,{policyFile});const ready=await complete(app,await create(app,first));assert.equal(ready.state,'ready');
    const original=await files(cache);await writeFile(policyFile,'{');await pause(5300);
    check('invalid policy fails closed for media access',(await request(app,ready.mediaUrl)).status===500);
    check('invalid policy leaves cached originals intact',JSON.stringify(await files(cache))===JSON.stringify(original));
    await writeFile(policyFile,JSON.stringify(policy));
    check('restoring valid policy restores the existing original',digest((await request(app,ready.mediaUrl)).body)===first.sha256);
    await app.close();
  });
} finally {
  for (const app of apps.reverse()) await app.close().catch(()=>{});
  proxy.closeAllConnections(); await new Promise(resolve=>proxy.close(resolve));
  report.checkCount=checks.length; report.passed=checks.every(c=>c.passed) && !report.proxyError;
  await writeFile(path.join(output,'lifecycle.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,checks:checks.length,failures:checks.filter(c=>!c.passed)},null,2));
  if(!report.passed)process.exitCode=1;
}
