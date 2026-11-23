import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFilename, loadDownloadPrefs, normalizeDownloadFolder, openQuizDownloadFolder, saveDownloadFolder, savedFolderPath, saveQuizDownload } from '../extension/lib/downloads.js';
import { emptyWorkspace, hasQuizDrafts, newConversation } from '../extension/lib/storage.js';

function fixture() {
  const storage = {}, requests = [], shown = [], listeners = new Set(), records = new Map(); let pending = false, nextId = 1;
  globalThis.chrome = {
    runtime: { id:'fixture-extension' },
    storage: { local: { get: async key => ({[key]:structuredClone(storage[key])}), set: async data => Object.assign(storage,structuredClone(data)) } },
    downloads: {
      download: async options => {requests.push(options);const id=nextId++;records.set(id,{id,filename:`E:/fixture-downloads/${options.filename}`,startTime:new Date().toISOString(),state:pending?'in_progress':'complete',exists:true,byExtensionId:'fixture-extension'});return id;},
      search:async ({id}) => records.has(id)?[records.get(id)]:[],
      show:id=>shown.push(id),showDefaultFolder:()=>shown.push('default'),
      onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}
    }
  };
  return {storage,requests,shown,records,listeners,pause:()=>{pending=true;},finish:id=>{records.get(id).state='complete';for(const listener of listeners)listener({id,state:{current:'complete'}});}};
}

test('download folder accepts nested Unicode paths and empty default root, rejects unsafe or absolute paths',()=>{
  assert.equal(normalizeDownloadFolder('  题库\\网络工程  '),'题库/网络工程');
  assert.equal(downloadFilename('题库/网络工程','DataCom.zip'),'题库/网络工程/DataCom.zip');
  assert.equal(downloadFilename('','题库.json'),'题库.json');
  for(const folder of ['E:\\题库','/tmp/quiz','../题库','题库/../其他','题库//网络','CON','quiz/COM1.txt','quiz.','a|b']) assert.throws(()=>normalizeDownloadFolder(folder));
});

test('JSON and ZIP download directly to the persisted folder without a dialog or overwriting existing files',async()=>{
  const f=fixture();await saveDownloadFolder('题库/网络');
  const json=await saveQuizDownload(new Blob(['{"questions":[]}']),'样例.json');
  const zip=await saveQuizDownload(new Blob(['zip-fixture']),'样例.zip');
  assert.deepEqual(f.requests.map(r=>({filename:r.filename,saveAs:r.saveAs,conflictAction:r.conflictAction})),[
    {filename:'题库/网络/样例.json',saveAs:false,conflictAction:'uniquify'}, {filename:'题库/网络/样例.zip',saveAs:false,conflictAction:'uniquify'}
  ]);
  assert.equal(json.id,1);assert.equal(zip.id,2);assert.equal((await loadDownloadPrefs()).locations[0].id,2);
  assert.equal((await openQuizDownloadFolder()).exact,true);assert.deepEqual(f.shown,[2]);
});

test('path settings are independent of a download completing under the previous folder',async()=>{
  const f=fixture();await saveDownloadFolder('Before');f.pause();
  const pending=saveQuizDownload(new Blob(['quiz']),'one.json');
  for(let i=0;i<20 && !f.listeners.size;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(f.listeners.size,1);await saveDownloadFolder('After');f.finish(1);await pending;
  const prefs=await loadDownloadPrefs();assert.equal(prefs.folder,'After');assert.equal(prefs.locations[0].folder,'Before');
  assert.equal((await openQuizDownloadFolder()).exact,false);assert.deepEqual(f.shown,['default']);
});

test('removed or foreign download records open only the default folder and do not reveal unrelated files',async()=>{
  const f=fixture();await saveQuizDownload(new Blob(['quiz']),'one.json');f.records.get(1).byExtensionId='other-extension';
  assert.equal((await openQuizDownloadFolder()).exact,false);assert.deepEqual(f.shown,['default']);
  f.records.get(1).byExtensionId='fixture-extension';f.records.get(1).exists=false;await openQuizDownloadFolder();assert.deepEqual(f.shown,['default','default']);
});

test('a new valid download replaces an older saved record even if native IDs are lower',async()=>{
  const f=fixture();f.storage.downloadPrefsV1={folder:'AIQuizLite',locations:[{folder:'AIQuizLite',id:99,filename:'E:/old/old.json',startedAt:1}]};
  await saveQuizDownload(new Blob(['new']),'new.json');assert.equal((await loadDownloadPrefs()).locations[0].id,1);await openQuizDownloadFolder();assert.deepEqual(f.shown,[1]);
});

test('new conversation discards all draft sessions, documents and task state without mutating the original',()=>{
  const state=emptyWorkspace();state.documents=[{id:'old'}];state.sessions=[{sessionId:'old-session'}];state.bank.questions=[{id:'q'}];state.messages=[{role:'user',content:'hello'}];state.exportTask={snapshots:[{}]};state.generation={next:0};
  assert.equal(hasQuizDrafts(state),true);const next=newConversation(state);
  assert.equal(next.documents.length,0);assert.equal(next.sessions.length,0);assert.equal(next.bank.questions.length,0);assert.equal(next.messages.length,0);assert.equal(next.exportTask,null);assert.equal(next.generation,null);assert.notEqual(next.sessionId,state.sessionId);
  assert.equal(state.documents.length,1);const onlyChat=emptyWorkspace();onlyChat.messages=state.messages;assert.equal(hasQuizDrafts(onlyChat),false);
});

test('saved folder paths preserve native Windows and POSIX spelling',()=>{
  assert.equal(savedFolderPath('E:\\下载\\题库\\a.zip'),'E:\\下载\\题库');assert.equal(savedFolderPath('/tmp/题库/a.json'),'/tmp/题库');
});
