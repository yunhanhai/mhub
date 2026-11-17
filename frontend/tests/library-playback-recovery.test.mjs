import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackRecovery, failedPlaybackTask } from '../../scripts/library-lab/playback-recovery.mjs';
import { createLibraryRequest } from '../../scripts/library-lab/request.mjs';

test('real HTTP login and permission failures direct account recovery', () => {
  for (const [status,code] of [[401,'login_required'],[403,'task_owner'],[403,'track_permission']]) {
    assert.equal(playbackRecovery({kind:'http',status,code}).recovery,'identity');
  }
  assert.equal(playbackRecovery({kind:'http',status:404,code:'instance_missing'}).recovery,'identity');
});
test('old catalogue identifiers and permissions require a refreshed catalogue', () => {
  for (const [status,code] of [[404,'track_missing'],[409,'version_changed'],[409,'source_changed'],[409,'policy_changed']]) {
    assert.equal(playbackRecovery({kind:'http',status,code}).recovery,'catalogue');
  }
});
test('temporary failures and missing task IDs remain explicit audio retries', () => {
  for (const error of [{kind:'network'},{name:'TimeoutError'},{kind:'http',status:429,code:'task_limit'},
    {kind:'http',status:404,code:'task_missing'},{kind:'task',code:'integrity_failed'}]) {
    assert.equal(playbackRecovery(error).recovery,'retry');
  }
});
test('messages and unrelated status codes never impersonate account or catalogue failures', () => {
  for (const error of [{message:'login_required'},{kind:'http',status:503,code:'login_required'},
    {kind:'protocol',status:401,code:'login_required'},{kind:'http',status:403,code:'origin_denied'},
    {kind:'http',status:400,code:'version_changed'}]) {
    assert.equal(playbackRecovery(error).recovery,'retry');
  }
});
test('failed task protocol retains actionable causes without arbitrary error strings', () => {
  for (const [code,recovery] of [['login_required','identity'],['version_changed','catalogue'],['integrity_failed','retry']]) {
    const error=failedPlaybackTask(code);assert.equal(error.kind,'task');assert.equal(error.code,code);
    assert.equal(playbackRecovery(error).recovery,recovery);
  }
  const invalid=failedPlaybackTask('<script>private');assert.equal(invalid.message,'音频准备失败');assert.equal(invalid.code,'');
});
test('control requests retain a safe server code along with HTTP status and message', async () => {
  const request=createLibraryRequest({apiBase:'/api/v1/library',clientHeader:'x-mhub-library',fetchImpl:async()=>new Response(
    JSON.stringify({error:{code:'version_changed',message:'原件已更新'}}),{status:409,headers:{'content-type':'application/json'}})});
  await assert.rejects(request('/api/tasks'),error=>error.kind==='http'&&error.status===409&&error.code==='version_changed'
    &&error.message==='原件已更新'&&playbackRecovery(error).recovery==='catalogue');
});
test('non-string or malformed server codes cannot direct an account recovery action', async () => {
  for(const code of [null,{action:'login_required'},'login_required\nprivate','x'.repeat(65)]){
    const request=createLibraryRequest({apiBase:'/api/v1/library',clientHeader:'x-mhub-library',fetchImpl:async()=>new Response(
      JSON.stringify({error:{code,message:'失败'}}),{status:401,headers:{'content-type':'application/json'}})});
    await assert.rejects(request('/api/tasks'),error=>error.code===''&&playbackRecovery(error).recovery==='retry');
  }
});
