import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRequest, questionTotal, validTotal, completeness } from '../extension/lib/export-request.js';
import { zipStore } from '../extension/lib/package.js';
import { validateBank, exportBank } from '../extension/lib/schema.js';
import { fixtureBank } from './fixtures.mjs';
test('chat waits for both intent and total in either order without model calls', () => {
  const first=exportRequest('把这份题库导出来','bank'); assert.equal(first.ready,false); assert.equal(first.pending.count,null);
  assert.equal(exportRequest('共有一百题','chat',first.pending).pending.count,100);
  assert.equal(exportRequest('100','chat',first.pending).ready,true);
  assert.equal(exportRequest('解释TCP','chat',first.pending),null);
  const count=exportRequest('这题库有100道','chat'); assert.equal(count.ready,false);
  assert.equal(exportRequest('把题库导出来','prepare',count.pending).ready,true);
  assert.equal(questionTotal('共100题，目前88题'),100); assert.throws(()=>questionTotal('100题或者90题'));
  for(const bad of [0,-1,5001,1.5])assert.throws(()=>validTotal(bad));
});
test('88 of 100, duplicates and explicit exclusions cannot be full', () => {
  const doc={strictCount:true,requestedCount:100,coverage:{complete:true},excluded:[],bank:{questions:Array.from({length:88},(_,i)=>({id:String(i),_sourceOrder:i}))}};
  assert.equal(completeness(doc).full,false); assert.equal(completeness(doc).missing.length,12);
  doc.bank.questions=Array.from({length:100},(_,i)=>({id:String(i),_sourceOrder:i})); assert.equal(completeness(doc).full,true);
  doc.bank.questions[99]._sourceOrder=98; assert.equal(completeness(doc).full,false);
  doc.bank.questions[99]._sourceOrder=99; doc.excluded=['10']; assert.equal(completeness(doc).full,false);
});
test('image export needs local files; ordinary JSON must reject images',()=>{
  const bank=structuredClone(fixtureBank);bank.reviewItems=[];const path=`images/${'a'.repeat(64)}.png`;bank.questions[0].image=path;
  assert.ok(validateBank(bank).issues.length);assert.ok(validateBank(bank,[],{allowImages:true,assets:[]}).issues.length);
  const media={allowImages:true,assets:[{path,id:'a'.repeat(64)}]};assert.equal(validateBank(bank,[],media).issues.length,0);
  assert.equal(JSON.parse(exportBank(bank,[],0,media)).questions[0].image,path);
  bank.questions[0].image='https://private.example/image.png';assert.ok(validateBank(bank,[],media).issues.length);
});
test('ZIP rejects traversal, duplicate names and too many files',()=>{
  const bytes=new Uint8Array([1,2,3]);assert.throws(()=>zipStore([{name:'../bad.png',bytes}]));
  assert.throws(()=>zipStore([{name:'a.png',bytes},{name:'a.png',bytes}]));
  assert.throws(()=>zipStore(Array.from({length:501},(_,i)=>({name:`${i}.png`,bytes}))));
});
