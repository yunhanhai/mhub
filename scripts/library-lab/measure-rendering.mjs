// Comparable desktop Edge measurements. Added metadata rows never represent new playable files.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=process.argv[2],origin=process.argv[3]||'http://127.0.0.1:8002';assert.ok(output);await mkdir(output,{recursive:true});
const target=new URL(origin);assert.ok(['http:','https:'].includes(target.protocol)&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&!target.username&&!target.password&&target.origin===origin,'Use an explicitly owned loopback origin');
const durationMs=15000,checks=[],errors=[],cases=[],contexts=[],accepted=[],responses=[];
const report={startedAt:new Date().toISOString(),origin,durationMs,checks,errors,cases,
  scope:'Actual desktop Edge/CDP and native generated MP3 with fixed 1440x1000 viewport. 100-row cases add labelled synthetic catalogue metadata only; original MP3 is looped solely to span CPU measurement. Same MutationObserver/CDP instrumentation in every sample; metrics do not prove physical-device or long-term memory behavior.'};
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})});
const system=await browser.newBrowserCDPSession();
const metrics=async session=>Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const check=(name,ok,detail)=>{checks.push({name,passed:Boolean(ok),detail});assert.ok(ok,name);};
async function clean(ctx){await Promise.allSettled(responses);report.taskCleanup??=[];
  for(const id of [...new Set(accepted.filter(a=>a.ctx===ctx).map(a=>a.id))]){try{const response=await ctx.request.delete(origin+'/api/v1/library/tasks/'+encodeURIComponent(id),{headers:{Origin:origin,'x-mhub-library':'1'},timeout:5000});report.taskCleanup.push({id,status:response.status()});}catch(error){report.taskCleanup.push({id,error:error.message});}}}
try{
  for(let round=0;round<2;round++){
    const names=round===0?['small-idle','large-idle','small-playing','large-playing']:['large-playing','small-playing','large-idle','small-idle'];
    for(const name of names){
      const large=name.startsWith('large'),playing=name.endsWith('playing');
      const ctx=await browser.newContext({serviceWorkers:'allow',viewport:{width:1440,height:1000},reducedMotion:'reduce'});contexts.push(ctx);
      ctx.on('response',response=>{if(response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/tasks'))responses.push(response.json().then(v=>{if(v.id)accepted.push({ctx,id:v.id});}).catch(()=>{}));});
      if(large)await ctx.route('**/api/v1/library/search',async route=>{
        const response=await route.fetch(),value=await response.json(),sample=value.tracks[0];
        assert.ok(value.tracks.length===2&&value.tracks.every(t=>t.access==='public'), 'Use a dedicated two-original public test fixture');
        await route.fulfill({response,json:{...value,tracks:[...value.tracks,...Array.from({length:98},(_,i)=>({...sample,songId:'profile-metadata-'+i,
          id:'profile-metadata:'+i,source_id:'profile-metadata:'+i,title:'Profile Metadata '+i}))]}});
      });
      const page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/library/');
      await page.waitForFunction(()=>window.libraryLabReady&&document.querySelector('#offline-shell-state').textContent.includes('已准备好'));
      assert.equal(await page.locator('#results .track').count(),large?24:2,'Use a dedicated two-original public test fixture');
      const release=await page.locator('meta[name=mhub-library-release]').getAttribute('content');if(!report.release)report.release=release;else assert.equal(release,report.release);
      await page.locator('#append-results').click();await page.waitForFunction(n=>window.libraryLab.snapshot().queue.length===n,large?100:2);
      if(playing){await page.locator('#playback-queue .queue-play').first().click();await page.waitForFunction(()=>window.libraryLab.snapshot().state==='playing'&&window.libraryLab.snapshot().pendingPlaybackActions===0&&window.libraryLab.snapshot().audio.some(a=>!a.paused&&a.time>.3));
        await page.evaluate(()=>{document.querySelector('audio').loop=true;});}
      await page.waitForTimeout(800);
      const cdp=await ctx.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('HeapProfiler.collectGarbage');
      await page.evaluate(()=>{
        window.__perf={mutations:0,queueMutations:0,textWrites:0,attributes:0,longTasks:[],source:window.libraryLab.snapshot().audio.find(a=>!a.paused)?.source||''};
        window.__perfDom=new MutationObserver(records=>{window.__perf.mutations+=records.length;for(const r of records){if(r.type==='attributes')window.__perf.attributes++;else window.__perf.textWrites++;if(r.target.closest?.('#playback-queue'))window.__perf.queueMutations++;}});
        window.__perfDom.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
        try{window.__perfLong=new PerformanceObserver(list=>window.__perf.longTasks.push(...list.getEntries().map(e=>e.duration)));window.__perfLong.observe({type:'longtask',buffered:false});}catch{}
      });
      const start=await metrics(cdp),processesBefore=(await system.send('SystemInfo.getProcessInfo')).processInfo;
      await page.waitForTimeout(durationMs);
      const end=await metrics(cdp),processesAfter=(await system.send('SystemInfo.getProcessInfo')).processInfo;
      const raw=await page.evaluate(()=>{window.__perfDom.disconnect();window.__perfLong?.disconnect();return{...window.__perf,snapshot:window.libraryLab.snapshot()};});
      await cdp.send('HeapProfiler.collectGarbage');const collected=await metrics(cdp);
      const cpu=processesAfter.filter(p=>p.type==='renderer').map(p=>{const prior=processesBefore.find(v=>v.id===p.id);return{id:p.id,seconds:prior?Math.max(0,p.cpuTime-prior.cpuTime):null};});
      const sample={name,round,release,queueRows:raw.snapshot.queue.length,displayedRows:raw.snapshot.browse.displayed,startedMetrics:start,endedMetrics:end,collectedMetrics:collected,
        taskSeconds:end.TaskDuration-start.TaskDuration,scriptSeconds:end.ScriptDuration-start.ScriptDuration,
        layoutSeconds:end.LayoutDuration-start.LayoutDuration,layoutCount:end.LayoutCount-start.LayoutCount,recalcStyleCount:end.RecalcStyleCount-start.RecalcStyleCount,
        rendererProcesses:cpu,rendererCpuSeconds:cpu.reduce((sum,p)=>sum+(p.seconds??0),0),mutations:raw.mutations,queueMutations:raw.queueMutations,
        textWrites:raw.textWrites,attributeWrites:raw.attributes,longTasks:raw.longTasks,heapUsedAfterGC:collected.JSHeapUsedSize,
        audioStillPlaying:raw.snapshot.audio.some(a=>!a.paused&&a.source===raw.source),audioPosition:raw.snapshot.audio.find(a=>!a.paused)?.time??null};
      cases.push(sample);check(name+' row count and audio intent round '+round,raw.snapshot.queue.length===(large?100:2)&&(!playing||sample.audioStillPlaying),{queue:raw.snapshot.queue.length,audioStillPlaying:sample.audioStillPlaying});
      if(playing)await page.locator('#transport').click();await clean(ctx);await ctx.close();contexts.splice(contexts.indexOf(ctx),1);
      console.log(JSON.stringify({sample:name,round,taskSeconds:sample.taskSeconds,cpuSeconds:sample.rendererCpuSeconds,mutations:sample.mutations,queueMutations:sample.queueMutations}));
    }
  }
  check('no page errors during measured idle and playback phases',errors.length===0,errors);report.passed=true;
}catch(error){report.passed=false;report.failure=error.message;report.errorStack=error.stack;process.exitCode=1;}
finally{for(const ctx of contexts)await clean(ctx);await Promise.allSettled(contexts.map(ctx=>ctx.close()));await browser.close();}
report.finishedAt=new Date().toISOString();report.checkCount=checks.length;
await writeFile(output+'/listening-performance.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,samples:cases.length,release:report.release,failure:report.failure}));
