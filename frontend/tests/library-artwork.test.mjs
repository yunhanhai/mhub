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
