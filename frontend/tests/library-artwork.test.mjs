import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkDescriptor, createArtworkCache } from '../../scripts/library-lab/artwork.mjs';
import { createHash } from 'node:crypto';

const origin='https://music.example.test';
const base='/api/v1/library';
const track=()=>({instanceId:'instance',songId:'song',version:'a'.repeat(64),cover_url:base+'/artwork/song?instanceId=instance&version='+'a'.repeat(64),
  artwork:{sha256:'b'.repeat(64),size:1000,width:256,height:256,contentType:'image/jpeg'}});

test('artwork requires the exact authorized song/version URL',()=>{
  const item=track();
  assert.equal(artworkDescriptor(item,base,origin).url,origin+item.cover_url);
  for(const url of ['https://other.example.test'+item.cover_url,base+'/artwork/other?instanceId=instance&version='+item.version,item.cover_url+'&token=unexpected',item.cover_url.replace('instanceId=instance','instanceId=other'),item.cover_url+'#fragment']){
    assert.equal(artworkDescriptor({...item,cover_url:url},base,origin),null);
  }
});
test('artwork forbids unbounded bytes/dimensions and non-JPEG formats',()=>{
  for(const patch of [{size:65537},{size:0},{width:257},{height:0},{contentType:'image/svg+xml'},{sha256:'../escape'}]){
    const item=track();item.artwork={...item.artwork,...patch};assert.equal(artworkDescriptor(item,base,origin),null);
  }
});
test('artwork cannot fall back to arbitrary endpoint when metadata is incomplete',()=>{
  for(const patch of [{songId:''},{instanceId:''},{version:'not-a-file-version'},{cover_url:'data:image/jpeg;base64,abc'},{cover_url:'javascript:alert(1)'}]){
    assert.equal(artworkDescriptor({...track(),...patch},base,origin),null);
  }
  assert.equal(artworkDescriptor({},base,origin),null);
});

test('corrupted saved public artwork falls back online without replacing the audio record',async()=>{
  const originalFetch=globalThis.fetch, originalBitmap=globalThis.createImageBitmap, originalLocation=globalThis.location;
  const bytes=Buffer.from([255,216,1,2,3,255,217]), item=track();
  item.access='public';item.offlineAllowed=true;
  item.artwork={...item.artwork,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const calls=[];
  globalThis.location={origin};
  globalThis.createImageBitmap=async()=>({width:256,height:256,close(){}});
  globalThis.fetch=async(url,options)=>{calls.push({url,credentials:options.credentials});return new Response(bytes,{headers:{'content-type':'image/jpeg'}});};
  const cache=createArtworkCache({apiBase:base,keyFor:()=> 'saved',cachedTrack:async()=>({track:item,artwork_blob:new Blob(['broken'])}),isOffline:()=>false});
  try{
    const value=await cache.get(item);
    assert.ok(value?.url.startsWith('blob:'));
    assert.equal(value.blob.size,bytes.length);
    assert.equal(calls.length,1);
    assert.equal(calls[0].credentials,'omit');
  }finally{
    cache.invalidate();globalThis.fetch=originalFetch;globalThis.createImageBitmap=originalBitmap;globalThis.location=originalLocation;
  }
});

test('a private cover response arriving after logout cannot create a usable cached URL',async()=>{
  const originalFetch=globalThis.fetch, originalBitmap=globalThis.createImageBitmap, originalLocation=globalThis.location;
  const bytes=Buffer.from([255,216,1,2,3,255,217]),item=track();item.access='restricted';item.offlineAllowed=false;
  item.artwork={...item.artwork,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  let release,options;
  globalThis.location={origin};globalThis.createImageBitmap=async()=>({width:256,height:256,close(){}});
  globalThis.fetch=async(url,value)=>{options=value;return await new Promise(resolve=>{release=()=>resolve(new Response(bytes,{headers:{'content-type':'image/jpeg'}}));});};
  const cache=createArtworkCache({apiBase:base,keyFor:()=> 'private',cachedTrack:async()=>null,isOffline:()=>false});
  try{
    const pending=cache.get(item);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(options.credentials,'same-origin');cache.invalidate();assert.equal(options.signal.aborted,true);
    release();assert.equal(await pending,null);
  }finally{cache.invalidate();globalThis.fetch=originalFetch;globalThis.createImageBitmap=originalBitmap;globalThis.location=originalLocation;}
});

function artworkHarness(t, { saved, fetchImpl, bitmap, timeoutMs = 40 } = {}) {
  const bytes = Buffer.from([255, 216, 1, 2, 3, 255, 217]), item = track();
  item.access = 'public'; item.offlineAllowed = true;
  item.artwork = { ...item.artwork, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const originals = { fetch: globalThis.fetch, bitmap: globalThis.createImageBitmap, location: globalThis.location };
  globalThis.location = { origin };
  globalThis.fetch = fetchImpl || (async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }));
  globalThis.createImageBitmap = bitmap || (async () => ({ width: 256, height: 256, close() {} }));
  const cache = createArtworkCache({ apiBase: base, keyFor: () => 'generated', cachedTrack: saved || (async () => null), isOffline: () => false, timeoutMs });
  t.after(() => { cache.invalidate(); globalThis.fetch = originals.fetch; globalThis.createImageBitmap = originals.bitmap; globalThis.location = originals.location; });
  return { cache, item, bytes };
}

const bounded = promise => Promise.race([promise, new Promise(resolve => {
  const timer = setTimeout(() => resolve('still-pending'), 160); timer.unref?.();
})]);

test('artwork deadline settles an unresponsive saved-cover lookup without starting fetch', async t => {
  let fetched = false;
  const { cache, item } = artworkHarness(t, { saved: () => new Promise(() => {}), fetchImpl: async () => { fetched = true; throw new Error('Unexpected fetch'); } });
  assert.equal(await bounded(cache.get(item)), null);
  assert.equal(fetched, false);
});

test('artwork deadline does not depend on a transport honoring abort', async t => {
  let options;
  const { cache, item } = artworkHarness(t, { fetchImpl: (_url, value) => { options = value; return new Promise(() => {}); } });
  assert.equal(await bounded(cache.get(item)), null);
  assert.equal(options.signal.aborted, true);
});

test('invalidating a cache settles a pending lookup and prevents later network work', async t => {
  let release, fetched = false;
  const { cache, item } = artworkHarness(t, { timeoutMs: 1000, saved: () => new Promise(resolve => { release = resolve; }),
    fetchImpl: async () => { fetched = true; throw new Error('Unexpected fetch'); } });
  const pending = cache.get(item);
  await new Promise(resolve => setImmediate(resolve)); cache.invalidate();
  assert.equal(await bounded(pending), null);
  release(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, false);
});

test('a bitmap arriving after deadline is closed and never exposed as a URL', async t => {
  let release, closed = 0;
  const { cache, item } = artworkHarness(t, { bitmap: () => new Promise(resolve => { release = resolve; }) });
  const pending = cache.get(item);
  assert.equal(await bounded(pending), null);
  assert.equal(typeof release, 'function');
  release({ width: 256, height: 256, close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('cancelling one artwork caller does not cancel another caller sharing the cover', async t => {
  let release, requests = 0;
  const { cache, item, bytes } = artworkHarness(t, { timeoutMs: 1000,
    fetchImpl: () => { requests++; return new Promise(resolve => { release = () => resolve(new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })); }); } });
  const controller = new AbortController();
  const cancelled = cache.get(item, { signal: controller.signal }), retained = cache.get(item);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal(await bounded(cancelled), null);
  release();
  assert.ok((await retained)?.url.startsWith('blob:'));
  assert.equal(requests, 1);
});

test('a rejected artwork body is cancelled without waiting for transport cleanup', async t => {
  let cancelled = false;
  const { cache, item } = artworkHarness(t, { fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'text/html' } }) });
  assert.equal(await bounded(cache.get(item)), null);
  assert.equal(cancelled, true);
});

test('streamed artwork stops at its trusted length and cancels the remaining body', async t => {
  let cancelled = false;
  const { cache, item } = artworkHarness(t, { fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(await bounded(cache.get(item)), null);
  assert.equal(cancelled, true);
});

test('artwork deadline cancels a stalled reader without awaiting its cleanup', async t => {
  let cancelled = false;
  const { cache, item } = artworkHarness(t, { fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(await bounded(cache.get(item)), null);
  assert.equal(cancelled, true);
});

test('a late response is cleaned up without replacing a successful retry', async t => {
  let release, count = 0, lateCancelled = false;
  const { cache, item, bytes } = artworkHarness(t, { fetchImpl: () => {
    count++;
    return count === 1 ? new Promise(resolve => { release = resolve; })
      : Promise.resolve(new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }));
  } });
  assert.equal(await bounded(cache.get(item)), null);
  const retry = await cache.get(item);
  assert.ok(retry?.url.startsWith('blob:'));
  release(new Response(new ReadableStream({ cancel() { lateCancelled = true; } }), { headers: { 'content-type': 'image/jpeg' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateCancelled, true);
  assert.equal((await cache.get(item)).url, retry.url);
  assert.equal(count, 2);
});
