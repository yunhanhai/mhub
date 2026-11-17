/** Actual Navidrome same-size file replacement with a paused real HTTP reader.
 * SOURCE_ADMIN_CREDENTIALS=... LIBRARY_BACKEND=rust node verify-versioning.mjs CONFIG MUSIC_ROOT REPORT_DIR
 * MUSIC_ROOT must be the explicitly owned local Navidrome test library.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rename, stat, utimes, readdir, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createBackend, apiBase, clientHeader, rustBackend } from './backend.mjs';
const [configPath, musicRoot, output] = process.argv.slice(2);
if(!rustBackend || !process.env.SOURCE_ADMIN_CREDENTIALS) throw new Error('Real Rust and explicitly supplied local fixture administrator required');
const json = async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const config=await json(configPath), admin=await json(process.env.SOURCE_ADMIN_CREDENTIALS);
assert.ok(['127.0.0.1','[::1]'].includes(new URL(config.source.baseUrl).hostname));
await mkdir(output,{recursive:true});
const run=await mkdtemp(path.join(output,'version-run-')), owned=await mkdtemp(path.join(path.resolve(musicRoot),'Lifecycle-'));
const file=path.join(owned,'versioned.flac'), policyFile=path.join(run,'policy.json'), cacheDir=path.join(run,'cache');
const checks=[], requests=[], apps=[], heldReaders=[];
const report={recordedAt:new Date().toISOString(),scope:'Own generated FLAC replaced on disk and rescanned by real Navidrome; unchanged song id/length, changed metadata/hash. An actual HTTP response is paused during retirement.',checks,requests};
const check=(name,passed,details)=>checks.push({name,passed:Boolean(passed),...(details?{details}:{})});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return true;await pause(125);}throw new Error('Timed out: '+label);}
function ffmpeg(args){const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error',...args],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});if(r.status!==0)throw new Error('Generated fixture FFmpeg operation failed');return r.stdout.toString().trim();}
let nativeAuth, app, entry;
async function source(method,extra={},auth=config.source.auth){
  const r=await fetch(config.source.baseUrl+'/rest/'+method+'.view',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({u:auth.username,s:auth.salt,t:auth.token,v:'1.16.1',c:'mhub-lifecycle-test',f:'json',...extra}),signal:AbortSignal.timeout(25000)});
  if(method==='stream'){assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());}
  const body=await r.json(), value=body['subsonic-response'];assert.equal(value?.status,'ok','Owned source operation must succeed');return value;
}
async function rescan(){await source('startScan',{},nativeAuth);await until(async()=>!(await source('getScanStatus',{},nativeAuth)).scanStatus.scanning,'Navidrome scan');}
async function start(){const s=await createBackend({...config,policyFile,cacheDir,cacheMaxBytes:entry.size},{exclusive:true});apps.push(s);s.origin=await s.start();return s;}
async function request(route,{method='GET',data,headers={}}={}){
  const r=await fetch(app.origin+route,{method,headers:{origin:app.origin,[clientHeader]:'1',...(data?{'content-type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(25000)});
  const bytes=Buffer.from(await r.arrayBuffer()), value=/json/.test(r.headers.get('content-type')||'')&&bytes.length?JSON.parse(bytes):null;
  requests.push({route,method,status:r.status,bytes:bytes.length,sha256:digest(bytes),...(value?.error?{error:value.error.code}:{})});
  return {status:r.status,bytes,value,headers:r.headers};
}
async function task(){let t=(await request(apiBase+'/tasks',{method:'POST',data:{instanceId:config.source.instanceId,songId:entry.songId,version:entry.sha256}})).value;await until(async()=>{t=(await request(apiBase+'/tasks/'+t.id)).value;return t.state!=='preparing';},'task preparation');return t;}
async function held(url){
  let res, first, finish, failStart, failDone; const started=new Promise((r,j)=>{first=r;failStart=j;});const done=new Promise((r,j)=>{finish=r;failDone=j;});
  done.catch(()=>{});const fail=error=>{failStart(error);failDone(error);};
  const chunks=[];let total=0;
  const req=http.get(url,{headers:{origin:app.origin}},r=>{res=r;if(r.statusCode!==200){fail(new Error('Expected original HTTP response'));r.destroy();return;}r.on('data',chunk=>{chunks.push(chunk);total+=chunk.length;if(chunks.length===1){r.pause();first();}});r.on('end',()=>finish(Buffer.concat(chunks)));r.on('error',fail);});
  req.setTimeout(20000,()=>req.destroy(new Error('Paused reader timed out')));req.on('error',fail);await started;
  const reader={initialBytes:total,done,resume:()=>res.resume(),close:()=>{res?.destroy();req.destroy();}};heldReaders.push(reader);return reader;
}
try{
  const login=await fetch(config.source.baseUrl+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:admin.username,password:admin.password}),signal:AbortSignal.timeout(10000)});
  assert.equal(login.status,200,'Owned fixture administrator login');const identity=await login.json();nativeAuth={username:admin.username,salt:identity.subsonicSalt,token:identity.subsonicToken};
  const nonce=randomBytes(4).toString('hex'), titleA='MHub Lifecycle A '+nonce, titleB='MHub Lifecycle B '+nonce;
  ffmpeg(['-n','-f','lavfi','-i','aevalsrc=random(0)|random(1):s=48000:d=90','-c:a','flac','-sample_fmt','s16','-compression_level','0','-metadata','title='+titleA,'-metadata','artist=Music Lab',file]);
  const original=await readFile(file), replacement=Buffer.from(original), offset=original.indexOf(Buffer.from(titleA));
  assert.ok(offset>0&&original.length>8*1024*1024&&original.length<=32*1024*1024,'Large valid fixture needed to exercise actual backpressure');
  replacement.set(Buffer.from(titleB),offset);
  const pcmA=ffmpeg(['-i',file,'-f','hash','-hash','sha256','-']);
  await rescan();let song;
  await until(async()=>{song=(await source('search3',{query:nonce,songCount:'100',albumCount:'0',artistCount:'0'})).searchResult3?.song?.find(s=>s.title===titleA);return Boolean(song);},'new owned song indexed');
  entry={songId:song.id,title:titleA,artist:'Music Lab',duration:90000,format:'flac',contentType:'audio/flac',size:original.length,sha256:digest(original),modifiedAt:(await stat(file)).mtime.toISOString(),access:'public',allowedUserIds:[]};
  const savePolicy=async()=>{const next=policyFile+'.next';await writeFile(next,JSON.stringify({instanceId:config.source.instanceId,tracks:[entry]}));await rename(next,policyFile);};
  await savePolicy();app=await start();const oldTask=await task();assert.equal(oldTask.state,'ready');
  const oldFile=(await readdir(cacheDir)).find(n=>n.endsWith('.audio'));
  const reader=await held(app.origin+oldTask.mediaUrl);
  await request(apiBase+'/session');
  check('a real original response remains paused before EOF',reader.initialBytes>0&&reader.initialBytes<original.length,{received:reader.initialBytes,total:original.length,activeLeases:app.metrics.activeFileLeases??null});
  await writeFile(file+'.next',replacement);await rename(file+'.next',file);const mtime=new Date(Date.now()+2500);await utimes(file,mtime,mtime);
  const pcmB=ffmpeg(['-i',file,'-f','hash','-hash','sha256','-']);
  await rescan();await until(async()=>(await source('getSong',{id:song.id})).song.title===titleB,'same id rescanned with new metadata');
  const raw=await source('stream',{id:song.id,format:'raw'});
  report.fixture={songId:song.id,bytes:original.length,versionA:digest(original),versionB:digest(replacement),decodedPcmA:pcmA,decodedPcmB:pcmB};
  check('source replacement keeps id and size while changing real bytes',raw.length===original.length&&digest(raw)===digest(replacement)&&digest(raw)!==digest(original));
  check('both versions are valid FLAC with the same decoded PCM',pcmA.startsWith('SHA256=')&&pcmA===pcmB);
  entry={...entry,title:titleB,sha256:digest(replacement),modifiedAt:(await stat(file)).mtime.toISOString()};await savePolicy();
  const opens=app.metrics.mediaOpens;
  const stale=await request(oldTask.mediaUrl,{headers:{range:'bytes=4096-8191','if-none-match':'"'+digest(original)+'"'}});
  check('old version Range/ETag is denied without representation headers',stale.status===409&&!stale.headers.has('etag')&&!stale.headers.has('content-range'));
  check('stale version denial opens no extra cached media',app.metrics.mediaOpens===opens);
  const blocked=await task();
  check('an open retired response reserves its bytes against the next version',blocked.state==='failed'&&blocked.error==='cache_capacity');
  const during=await readdir(cacheDir), stored=await Promise.all(during.filter(n=>n.endsWith('.audio')).map(async n=>(await stat(path.join(cacheDir,n))).size));
  check('version overlap stays within the byte quota',stored.reduce((a,b)=>a+b,0)<=entry.size,{storedBytes:stored.reduce((a,b)=>a+b,0),limit:entry.size});
  reader.resume();const delivered=await reader.done;
  check('the previously authorized response finishes with exactly v1 bytes',digest(delivered)===digest(original));
  const next=await task();assert.equal(next.state,'ready');
  check('new task returns exactly v2 bytes',digest((await request(next.mediaUrl)).bytes)===digest(replacement));
  const ranged=await request(next.mediaUrl,{headers:{range:'bytes=2097152-2101247'}});
  check('nonzero Range belongs entirely to v2',ranged.status===206&&ranged.bytes.equals(replacement.subarray(2097152,2101248)));
  check('retired v1 is reclaimed after its reader releases',!(await readdir(cacheDir)).includes(oldFile));
  await app.crash();await app.close();app=await start();const restarted=await task();
  check('a crash after v2 publication retains only verified v2',restarted.state==='ready'&&app.metrics.cacheHits===1&&app.metrics.sourceDownloads===0&&digest((await request(restarted.mediaUrl)).bytes)===digest(replacement));
}catch(e){report.failure=e.message;check('version experiment completes without a harness failure',false);}
finally{
  for(const reader of heldReaders)reader.close();for(const s of apps.reverse())await s.close().catch(()=>{});
  try{
    for(const name of await readdir(owned)){assert.ok(['versioned.flac','versioned.flac.next'].includes(name),'Do not remove unexpected user files');await unlink(path.join(owned,name));}
    await rmdir(owned);if(nativeAuth)await rescan();report.ownedFixtureRemoved=true;
  }catch{report.fixtureCleanupFailed=true;}
  report.checkCount=checks.length;report.passed=checks.every(c=>c.passed)&&!report.fixtureCleanupFailed;
  await writeFile(path.join(output,'versioning.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,checks:checks.length,failures:checks.filter(c=>!c.passed),failure:report.failure,fixtureCleanupFailed:report.fixtureCleanupFailed},null,2));if(!report.passed)process.exitCode=1;
}
