import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url)), artifacts=path.join(root,'artifacts');
await mkdir(artifacts,{recursive:true});
const stamp=Date.now(), extension=path.join(artifacts,`extension-settings-${stamp}`), profile=path.join(artifacts,`profile-settings-${stamp}`), downloadRoot=path.join(artifacts,`native-downloads-${stamp}`);
await cp(path.join(root,'dist'),extension,{recursive:true});await mkdir(path.join(profile,'Default'),{recursive:true});await mkdir(downloadRoot,{recursive:true});
await writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadRoot,prompt_for_download:false,directory_upgrade:true}}));
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
const checks=[],failures=[],errors=[],dialogs=[];let context,acceptReset=false;
async function test(name,fn){try{await fn();checks.push(name);}catch(error){failures.push(`${name}: ${error.message}`);}}
try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:390,height:920},acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  // Use Chrome's actual configured directory rather than Playwright's GUID
  // download interception. Native file-manager opening is the only UI seam stub.
  const cdp=await context.newCDPSession(context.pages()[0]);await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  const panel=await context.newPage();panel.on('pageerror',error=>errors.push(error.message));panel.on('dialog',async dialog=>{dialogs.push(dialog.message());if(acceptReset)await dialog.accept();else await dialog.dismiss();});
  await panel.addInitScript(()=>{if(!globalThis.chrome?.downloads)return;window.folderCalls=[];chrome.downloads.show=id=>window.folderCalls.push(id);chrome.downloads.showDefaultFolder=()=>window.folderCalls.push('default');});
  await worker.evaluate(async()=>{await chrome.storage.local.set({profilesV1:{activeId:'fixture-profile',items:[{id:'fixture-profile',name:'日常学习',baseUrl:'https://fixture.invalid/v1',model:'fixture',remember:true}]},secretsV1:{'fixture-profile':'fixture-local-key'}});});
  const url=`chrome-extension://${id}/sidepanel.html`;await panel.goto(url);await panel.waitForFunction(()=>document.querySelector('#active-profile').value==='fixture-profile');
  async function seedBanks(){
    const image=await panel.evaluate(async()=>{
      const {resolveMedia}=await import('./lib/media.js');const canvas=new OffscreenCanvas(20,10);const ctx=canvas.getContext('2d');ctx.fillStyle='#2563eb';ctx.fillRect(0,0,20,10);
      const blob=await canvas.convertToBlob({type:'image/png'});const encoded=btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      return (await resolveMedia({mediaSources:[{url:`data:image/png;base64,${encoded}`,role:'question'}]})).mediaAssets[0];
    });
    await panel.goto('about:blank');await panel.waitForTimeout(350);
    await worker.evaluate(async image=>{
      const q={id:'json-question',paper:'JSON题库',type:'single',stem:'原有题目必须保留。',options:[{key:'A',text:'甲'},{key:'B',text:'乙'}],answers:['B'],explanation:null,image:null,explanationImages:[],_sourceOrder:0};
      const source={title:'测试题库',url:'',text:'',mode:'bank'},bank={name:'JSON题库',questions:[q],reviewItems:[]};
      const oldBank={name:'图片题库',questions:[{...q,id:'image-question',paper:'图片题库',image:image.path}],reviewItems:[]};
      const doc=(id,name,bank,sessionId,assets=[])=>({id,name,bank,sessionId,source,excluded:[],resolvedReviews:[],assets,formatComplete:true,strictCount:true,requestedCount:1,coverage:{captured:1,expected:1,complete:true}});
      const state={version:1,sessionId:'current-session',sessions:[{sessionId:'legacy-session',source,messages:[],activeDocumentId:'old-bank',exportTask:null,generation:null}],source,bank,excluded:[],resolvedReviews:[],messages:[{role:'user',content:'旧对话'}],documents:[doc('current-bank','JSON题库',bank,'current-session'),doc('old-bank','图片题库',oldBank,'legacy-session',[image])],activeDocumentId:'current-bank',activeView:'chat',exportTask:{id:'finished-task',documentId:'current-bank',stage:'ready',status:'finished',complete:true,expected:1,requestedCount:1,snapshots:[{number:1,question:q}]},generation:null,pendingExport:null,jsonDraft:'',progressHidden:false};
      await chrome.storage.local.set({workspaceV1:state});
    },image);
    await panel.goto(url);await panel.locator('.document-card').first().waitFor();await panel.waitForFunction(()=>!document.querySelector('#new-draft').disabled);return image;
  }
  const image=await seedBanks();const state=()=>panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1);
  const persisted=()=>panel.locator('#save-status').filter({hasText:'草稿已保存在本机'}).waitFor();
  await test('settings opens an extensible option list; model page and shortcut have clear back navigation',async()=>{
    await panel.locator('[data-view="settings"]').click();assert.equal(await panel.locator('.settings-row').count(),2);assert.ok(await panel.locator('#settings-model').isVisible());assert.equal(await panel.locator('#profile-form').isVisible(),false);assert.equal(await panel.locator('#saved-documents').count(),0);
    await panel.screenshot({path:path.join(artifacts,'settings-menu-390.png'),fullPage:true});
    await panel.locator('#settings-model').click();assert.ok(await panel.locator('#profile-form').isVisible());assert.equal(await panel.locator('#profile-name').inputValue(),'日常学习');assert.equal(await panel.locator('[data-view="settings"]').getAttribute('aria-current'),'page');
    await panel.locator('#back-model-settings').click();assert.ok(await panel.locator('#settings-download').isVisible());await panel.locator('#open-settings').click();assert.ok(await panel.locator('#profile-form').isVisible());await panel.locator('#back-model-settings').click();
  });
  await test('download path persists independently; invalid absolute path cannot replace it',async()=>{
    await panel.locator('#settings-download').click();await panel.locator('#download-folder').fill('题库/网络工程');await panel.locator('#save-download-folder').click();await panel.locator('#notice').filter({hasText:'下载文件路径已保存'}).waitFor();
    await panel.locator('#download-folder').fill('E:\\非法绝对路径');await panel.locator('#save-download-folder').click();await panel.locator('#notice').filter({hasText:'不能填写磁盘绝对路径'}).waitFor();
    assert.equal((await panel.evaluate(async()=>(await chrome.storage.local.get('downloadPrefsV1')).downloadPrefsV1)).folder,'题库/网络工程');
    await panel.reload();await panel.locator('#download-folder').waitFor();assert.equal(await panel.locator('#download-folder').inputValue(),'题库/网络工程');
    await panel.screenshot({path:path.join(artifacts,'download-settings-390.png'),fullPage:true});
  });
  await test('opening the folder before its first download uses the browser root with an explicit explanation',async()=>{
    await panel.locator('#open-download-folder').click();assert.deepEqual(await panel.evaluate(()=>window.folderCalls),['default']);await panel.locator('#notice').filter({hasText:'首次下载会创建'}).waitFor();
  });
  const downloaded=[];
  await test('JSON and ZIP physically save to the configured subfolder; repeated names get a separate file',async()=>{
    await panel.locator('[data-view="chat"]').click();
    for(const name of ['JSON题库','图片题库','JSON题库']){
      const before=await panel.evaluate(async()=>(await chrome.storage.local.get('downloadPrefsV1')).downloadPrefsV1?.locations?.[0]?.id||0);
      await panel.locator('.document-card').filter({hasText:name}).locator('.document-download').click();
      await panel.waitForFunction(async previous=>{const p=(await chrome.storage.local.get('downloadPrefsV1')).downloadPrefsV1;return (p?.locations?.[0]?.id||0)>previous;},before);
      await panel.locator('#notice').filter({hasText:'题库已保存到'}).waitFor();await panel.waitForFunction(()=>!document.querySelector('#clear-chat').disabled);
      const prefs=await panel.evaluate(async()=>(await chrome.storage.local.get('downloadPrefsV1')).downloadPrefsV1);const record=prefs.locations[0];
      const filename=path.resolve(record.filename);assert.ok(filename.startsWith(path.resolve(downloadRoot)+path.sep));assert.equal(path.relative(downloadRoot,path.dirname(filename)).split(path.sep).join('/'),'题库/网络工程');
      const bytes=await readFile(filename);assert.ok(bytes.length);if(name==='JSON题库')assert.equal(JSON.parse(bytes.toString('utf8')).questions[0].stem,'原有题目必须保留。');else assert.equal(bytes.readUInt32LE(0),0x04034b50);
      downloaded.push({id:record.id,filename});
    }
    assert.notEqual(downloaded[0].filename,downloaded[2].filename);await writeFile(path.join(artifacts,'settings-download-result.json'),JSON.stringify({version:manifest.version,files:downloaded.map(item=>({id:item.id,name:path.basename(item.filename),relative:path.relative(downloadRoot,item.filename)}))},null,2));
  });
  await test('chat open-bank action reveals the configured download folder instead of importing JSON',async()=>{
    await panel.locator('#open-bank-folder').click();assert.equal((await panel.evaluate(()=>window.folderCalls)).at(-1),downloaded.at(-1).id);assert.equal((await state()).documents.length,2);
  });
  await test('cancelled cleanup warns about undownloaded banks and preserves drafts',async()=>{
    await persisted();const before=await state();await panel.locator('#clear-chat').click();assert.ok(dialogs.at(-1).includes('未下载的题库会丢失'));assert.deepEqual(await state(),before);assert.equal(await panel.locator('.document-card').count(),2);
  });
  await test('confirmed clear removes all documents, archived sessions, progress and image cache, retaining settings and disk files',async()=>{
    const prefs=await panel.evaluate(async()=>await chrome.storage.local.get(['profilesV1','secretsV1','downloadPrefsV1']));acceptReset=true;await panel.locator('#clear-chat').click();await panel.locator('#notice').filter({hasText:'已清空本地对话和题库草稿'}).waitFor();await persisted();
    const cleared=await state();assert.equal(cleared.documents.length,0);assert.equal(cleared.sessions.length,0);assert.equal(cleared.messages.length,0);assert.equal(cleared.exportTask,null);assert.equal(cleared.generation,null);assert.equal(await panel.locator('#export-progress').isVisible(),false);assert.equal(await panel.locator('.document-card').count(),0);
    assert.deepEqual(await panel.evaluate(async()=>await chrome.storage.local.get(['profilesV1','secretsV1','downloadPrefsV1'])),prefs);
    assert.equal(await panel.evaluate(async id=>{const{mediaAsset}=await import('./lib/media.js');return Boolean(await mediaAsset(id));},image.id),false);
    for(const item of downloaded)assert.ok((await readFile(item.filename)).length);
    await panel.reload();await panel.locator('#settings-model').waitFor({state:'attached'});assert.equal(await panel.locator('.document-card').count(),0);await panel.locator('#open-bank-folder').click();assert.equal((await panel.evaluate(()=>window.folderCalls)).at(-1),downloaded.at(-1).id);
  });
  await test('new conversation uses the same discard warning and clears the same data',async()=>{
    await seedBanks();acceptReset=false;const before=await state();await panel.locator('#new-draft').click();assert.deepEqual(await state(),before);acceptReset=true;await panel.locator('#new-draft').click();await panel.locator('#notice').filter({hasText:'已开始新对话'}).waitFor();assert.equal((await state()).documents.length,0);assert.equal((await state()).sessions.length,0);
  });
  await test('message-only cleanup has no bank-loss warning; settings fits 300/390/600 pixel widths',async()=>{
    await panel.goto('about:blank');await panel.waitForTimeout(350);
    await worker.evaluate(async()=>{const saved=(await chrome.storage.local.get('workspaceV1')).workspaceV1;saved.messages=[{role:'user',content:'只有对话，没有题库'}];await chrome.storage.local.set({workspaceV1:saved});});
    await panel.goto(url);await panel.locator('.message.user').waitFor();await panel.waitForFunction(()=>!document.querySelector('#clear-chat').disabled);
    const count=dialogs.length;await panel.locator('#clear-chat').click();await panel.locator('#notice').filter({hasText:'已清空本地对话和题库草稿'}).waitFor();assert.equal(dialogs.length,count);
    for(const width of [300,390,600]){await panel.setViewportSize({width,height:920});await panel.locator('[data-view="settings"]').click();assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.screenshot({path:path.join(artifacts,`settings-menu-${width}.png`),fullPage:true});}
    assert.deepEqual(errors,[]);
  });
}finally{await context?.close();}
await writeFile(path.join(artifacts,'settings-workspace-report.json'),JSON.stringify({version:manifest.version,passed:!failures.length,checks,failures},null,2));
if(failures.length)throw new Error(failures.join('\n'));console.log(JSON.stringify({passed:true,checks}));
