import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { captureError, matchingCaptureInvocation } from '../extension/lib/capture-access.js';

test('native capture permission errors are distinct from quota and generic capture failures',()=>{
  const denied=captureError(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
  assert.equal(denied.code,'capture_permission');assert.match(denied.message,/OCR 尚未开始/);
  assert.equal(captureError(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded')).code,'capture_rate_limit');
  const other=captureError(new Error('private native details'));assert.equal(other.code,'capture_failed');assert.ok(!other.message.includes('private native details'));
});
test('only a fresh invocation of the same original tab and bank can resume a blocked capture once',()=>{
  const task={captureNeedsGrant:true,status:'blocked',captureBlockedAt:9000,tabId:12,url:'https://exam.example/paper/152'};
  const invocation={nonce:'new',at:9500,tabId:12,url:task.url};
  assert.equal(matchingCaptureInvocation(invocation,task,10000),true);
  for(const changed of[{tabId:13},{url:'https://exam.example/paper/151'},{url:'https://other.example/paper/152'},{nonce:''},{at:8000},{at:20000},{at:'9500'}])assert.equal(matchingCaptureInvocation({...invocation,...changed},task,10000),false);
  assert.equal(matchingCaptureInvocation(invocation,{...task,captureGrantUsed:'new'},10000),false);
  assert.equal(matchingCaptureInvocation(invocation,{...task,status:'running'},10000),false);
  assert.equal(matchingCaptureInvocation(invocation,task,400000),false);
});
test('toolbar action opens the panel synchronously, records only that HTTP tab and supports action keyboard invocation',async()=>{
  const events={},calls=[],writes=[];
  const event=name=>({addListener:fn=>events[name]=fn});
  const chrome={storage:{local:{setAccessLevel:async()=>{}},session:{setAccessLevel:async()=>{},set:async value=>writes.push(value)}},
    sidePanel:{setPanelBehavior:async value=>calls.push({behavior:value}),open:options=>{calls.push({open:options});return Promise.resolve();}},
    runtime:{onInstalled:event('installed'),onStartup:event('startup')},tabs:{onActivated:event('activated'),onUpdated:event('updated'),get:async()=>null},action:{onClicked:event('action')}};
  vm.runInNewContext(await readFile(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,URL,crypto:{randomUUID:()=> 'fixture-nonce'},Date});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls[0].behavior.openPanelOnActionClick,false);
  calls.length=0;events.action({id:12,windowId:9,url:'https://exam.example/paper/152?private=value#fragment'});
  assert.deepEqual(calls[0].open.windowId,9);
  const grant=writes.find(value=>value.captureInvocationV1)?.captureInvocationV1;
  assert.equal(grant.tabId,12);assert.equal(grant.url,'https://exam.example/paper/152');assert.ok(grant.at>0);assert.equal(grant.nonce,'fixture-nonce');
  writes.length=0;events.action({id:13,windowId:9,url:'chrome://extensions'});assert.ok(!writes.some(value=>value.captureInvocationV1));
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.commands._execute_action.suggested_key.default,'Alt+Shift+Q');
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});
