import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../../scripts/library-lab/service-worker.mjs', import.meta.url), 'utf8');
const origin = 'https://library.example.test';
const body = '<html>Public static shell</html>';
const checksum = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
const build = { release: 'unit', files: [{ url: '/library/', bytes: new TextEncoder().encode(body).length, sha256: checksum, type: 'text/html' }] };

function harness({ response = () => new Response(body, { headers: { 'content-type': 'text/html' } }), registration = {}, windows = [] } = {}) {
  const handlers = new Map(), records = new Map();
  const calls = { fetch: [], put: [], remove: [], skipWaiting: 0, claim: 0 };
  class WorkerRequest extends Request {
    constructor(input, options) { super(typeof input === 'string' ? new URL(input, origin) : input, options); }
  }
  const key = request => typeof request === 'string' ? new URL(request, origin).href : request.url;
  const caches = {
    async keys() { return [...records.keys()]; },
    async delete(name) { calls.remove.push(name); return records.delete(name); },
    async open(name) {
      if (!records.has(name)) records.set(name, new Map());
      return {
        async put(request, value) { calls.put.push({ url: request.url, credentials: request.credentials }); records.get(name).set(key(request), value); },
        async match(request) { return records.get(name).get(key(request))?.clone(); },
      };
    },
  };
  vm.runInNewContext(source, { LIBRARY_BUILD: build, URL, Map, Request: WorkerRequest, Response,
    crypto: webcrypto, Uint8Array, setTimeout, clearTimeout,
    caches, fetch: async request => { calls.fetch.push(request); return response(request); },
    self: { location: { origin }, addEventListener: (name, fn) => handlers.set(name, fn),
      registration, skipWaiting: async () => { calls.skipWaiting++; }, clients: { claim: async () => { calls.claim++; }, matchAll: async () => windows } } });
  return { calls, records,
    async install() { let result; handlers.get('install')({ waitUntil: promise => { result = promise; } }); await result; },
    async activate() { let result; handlers.get('activate')({ waitUntil: promise => { result = promise; } }); await result; },
    async message(data, source = { id: 'page' }) { let result; handlers.get('message')({ data, source, waitUntil: promise => { result = promise; } }); await result; },
    dispatch(path, options = {}) {
      let response;
      handlers.get('fetch')({ request: { url: new URL(path, origin).href, method: 'GET', mode: 'cors', headers: new Headers(), ...options }, respondWith: value => { response = value; } });
      return response;
    },
  };
}

test('library app shell install verifies bytes and omits account credentials', async () => {
  const worker = harness();
  await worker.install();
  assert.equal(worker.calls.fetch[0].credentials, 'omit');
  assert.equal(worker.calls.fetch[0].cache, 'reload');
  assert.equal(worker.calls.fetch[0].redirect, 'error');
  assert.equal(worker.calls.put.length, 1);
  assert.equal(await (await worker.dispatch('/library/', { mode: 'navigate' })).text(), body);
  assert.equal(worker.calls.skipWaiting, 0, 'an installed update never activates itself');
});

test('wrong static shell bytes invalidate only that new shell cache', async () => {
  const worker = harness({ response: () => new Response('different body', { headers: { 'content-type': 'text/html' } }) });
  worker.records.set('unrelated-app-cache', new Map());
  await assert.rejects(worker.install(), /integrity/);
  assert.deepEqual(worker.calls.remove, ['mhub-library-shell-unit']);
  assert.equal(worker.records.has('unrelated-app-cache'), true);
});

test('credential-setting and wrong-type shell responses cannot enter CacheStorage', async () => {
  for (const headers of [{ 'content-type': 'text/html', 'set-cookie': 'private=not-real' }, { 'content-type': 'application/json' }]) {
    const worker = harness({ response: () => new Response(body, { headers }) });
    await assert.rejects(worker.install());
    assert.equal(worker.calls.put.length, 0);
  }
});

test('all API methods, media Range and source downloads bypass library caches', async () => {
  const worker = harness(); await worker.install();
  for (const path of ['/api/v1/library/session', '/api/v1/library/search?q=one', '/api/v1/library/tasks/task/audio', '/source.tar.gz', '/health', '/library/sw.js']) {
    for (const method of ['GET', 'POST', 'HEAD', 'DELETE']) assert.equal(worker.dispatch(path, { method }), undefined, path + ' ' + method);
  }
  assert.equal(worker.dispatch('/library/', { headers: new Headers({ range: 'bytes=0-10' }) }), undefined);
  assert.equal(worker.dispatch('/library/', { headers: new Headers({ authorization: 'Bearer example' }) }), undefined);
  assert.equal(worker.calls.fetch.length, 1, 'only static installation opened a request');
});

test('navigations outside the isolated library never fall back to its shell', async () => {
  const worker = harness(); await worker.install();
  for (const path of ['/', '/account', '/docs/', '/library/not-a-route', 'https://elsewhere.example/library/']) {
    assert.equal(worker.dispatch(path, { mode: 'navigate' }), undefined, path);
  }
});

test('activate keeps previous version caches until an explicit safe cleanup', async () => {
  const worker = harness();
  worker.records.set('mhub-library-shell-old', new Map());
  worker.records.set('music-web-app-v1', new Map());
  await worker.install(); await worker.activate();
  assert.equal(worker.calls.claim, 1);
  assert.equal(worker.records.has('mhub-library-shell-old'), true);
  assert.equal(worker.records.has('music-web-app-v1'), true);
  assert.equal(worker.calls.remove.length, 0);
});

test('an active worker never prunes an installing or waiting release', async () => {
  for (const stage of ['installing', 'waiting']) {
    const registration = { [stage]: {} };
    const worker = harness({ registration, windows: [{ id: 'page', url: origin + '/library/' }] });
    await worker.install();
    worker.records.set('mhub-library-shell-next', new Map());
    await worker.message({ type: 'LIBRARY_PRUNE_SHELLS', release: 'unit' });
    assert.equal(worker.records.has('mhub-library-shell-next'), true, stage + ' page cache must stay available');
    assert.equal(worker.calls.remove.length, 0);
  }
});

test('idle single-version cleanup affects only old library shells', async () => {
  const worker = harness({ windows: [{ id: 'page', url: origin + '/library/' }] });
  await worker.install();
  worker.records.set('mhub-library-shell-old', new Map());
  worker.records.set('music-web-app-v1', new Map());
  await worker.message({ type: 'LIBRARY_PRUNE_SHELLS', release: 'unit' });
  assert.equal(worker.records.has('mhub-library-shell-unit'), true);
  assert.equal(worker.records.has('mhub-library-shell-old'), false);
  assert.equal(worker.records.has('music-web-app-v1'), true);
});
