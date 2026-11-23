import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuizTab } from '../extension/lib/source-tab.js';
const url = 'https://exam.zhiqiantong.cn/paper/toExamRecitePaper/495034';
function setup(tabs) {
  globalThis.chrome = {tabs:{get:async id=>{const tab=tabs.find(t=>t.id===id);if(!tab)throw new Error(`No tab with id: ${id}.`);return tab;},query:async()=>tabs}};
}
test('retains the original live tab even with duplicate bank tabs',async()=>{
  setup([{id:1,url},{id:2,url,active:true}]); const task={tabId:1,url,frameId:0};
  assert.equal((await resolveQuizTab(task)).id,1);
});
test('rebinds a closed tab to the same bank and updates the task',async()=>{
  setup([{id:2,url}]); const task={tabId:1,url,frameId:0};
  assert.equal((await resolveQuizTab(task)).id,2);assert.equal(task.tabId,2);
});
test('rejects reused IDs, different banks, query and hash identities',async()=>{
  for(const other of [url.replace('495034','495035'),url+'?paper=other',url+'#other']){
    setup([{id:1,url:other}]);const task={tabId:1,url};
    await assert.rejects(resolveQuizTab(task),e=>e.code==='source_tab_missing'&&!e.message.includes('No tab'));assert.equal(task.tabId,1);
  }
});
test('prefers the active exact match and rejects ambiguous inactive matches',async()=>{
  setup([{id:2,url},{id:3,url,active:true}]);assert.equal((await resolveQuizTab({tabId:1,url})).id,3);
  setup([{id:2,url},{id:3,url}]);await assert.rejects(resolveQuizTab({tabId:1,url}),e=>e.code==='source_tab_ambiguous');
});
test('does not re-use an obsolete iframe ID in a new tab',async()=>{
  setup([{id:2,url}]);await assert.rejects(resolveQuizTab({tabId:1,url,frameId:9}),e=>e.code==='source_tab_missing');
});
test('missing or invalid source identity cannot adopt an arbitrary active tab',async()=>{
  setup([{id:2,url,active:true}]);for(const original of ['', 'file:///private'])await assert.rejects(resolveQuizTab({tabId:1,url:original}),e=>e.code==='source_tab_missing');
});
test('deep capture uses the saved full top URL, including bank query identity',async()=>{
  const { captureReviewQuestion } = await import('../extension/lib/deep-capture.js');
  const topUrl = url + '?paper=495034'; setup([{id:2,url:topUrl}]);
  chrome.tabs.update = async id => ({id,url:topUrl});
  chrome.scripting = {executeScript:async()=>[{result:{loginRequired:true}}]};
  const task={tabId:1,url,topUrl,frameId:0};
  await assert.rejects(captureReviewQuestion(task,16),/登录已失效/);
  assert.equal(task.tabId,2);
});

test('partial collection targets the recovered tab and preserves the task identity',async()=>{
  const { collectWholeBank } = await import('../extension/lib/bank-collector.js');
  setup([{id:2,url}]); const targets=[];
  chrome.scripting={executeScript:async config=>{targets.push(config.target.tabId);return [{result:{expected:1,structured:[{number:1,identity:'number_1',rawText:'1. (单选题)题目\nA. 甲\nB. 乙\n正确答案：B'}]}}];}};
  const previous={id:'kept-task',tabId:1,url,frameId:0,origin:new URL(url).origin,topOrigin:new URL(url).origin,snapshots:[],complete:false,expected:1};
  const task=await collectWholeBank({previous,expectedCount:1});
  assert.equal(task.id,'kept-task');assert.equal(task.tabId,2);assert.equal(task.complete,true);assert.equal(task.snapshots.length,1);assert.ok(targets.every(id=>id===2));
});
