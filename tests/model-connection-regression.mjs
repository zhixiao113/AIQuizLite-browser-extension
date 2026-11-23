import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url)), artifacts=path.join(root,'artifacts');
await mkdir(artifacts,{recursive:true});let mode='reasoning',delay=0;const requests=[];
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  const validKey=req.headers.authorization===(body.model==='deepseek-flash'?'Bearer fixture-old-key':'Bearer fixture-new-key');
  requests.push({model:body.model,validKey,maxTokens:body.max_tokens,messages:body.messages});
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  if(!validKey||mode==='unauthorized'){res.writeHead(401);res.end('provider-private-fixture');return;}
  if(mode==='rate-limit'){res.writeHead(429);res.end('provider-private-fixture');return;}
  const limited=body.model==='deepseek-flash'&&mode==='reasoning';
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:limited?'length':'stop',message:mode==='empty'?{content:''}:limited?{content:'',reasoning_content:'fixture reasoning response'}:{content:'OK'}}],usage:{total_tokens:limited?body.max_tokens:6}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const extension=path.join(artifacts,`extension-model-connection-${Date.now()}`);await cp(path.join(root,'dist'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
const checks=[],failures=[],errors=[];let context;
async function test(name,run){console.log(`START ${name}`);try{await run();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push(`${name}: ${error.message}`);console.log(`FAIL ${name}: ${error.message}`);}}
try{
  context=await chromium.launchPersistentContext(path.join(artifacts,`profile-model-connection-${Date.now()}`),{channel:'chromium',headless:true,viewport:{width:390,height:920},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  await worker.evaluate(async origin=>{
    await chrome.storage.local.set({profilesV1:{activeId:'old-profile',items:[{id:'old-profile',name:'日常学习',baseUrl:`${origin}/v1`,model:'deepseek-flash',remember:true}]},secretsV1:{'old-profile':'fixture-old-key'}});
  },origin);
  const panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(()=>document.querySelector('#active-profile').value==='old-profile');await panel.locator('#open-settings').click();
  await panel.locator('#add-profile').click();await panel.locator('#profile-name').fill('图片识别');await panel.locator('#profile-url').fill(`${origin}/v1`);await panel.locator('#profile-model').fill('qwen35-ocr');await panel.locator('#profile-vision').check();await panel.locator('#profile-key').fill('fixture-new-key');await panel.locator('#profile-form button[type="submit"]').click();await panel.locator('#notice').filter({hasText:'模型配置已保存'}).waitFor();
  const newId=await panel.locator('#profile-selector').inputValue();
  await test('saving a dedicated OCR profile keeps the old text model active',async()=>{assert.equal(await panel.locator('#active-profile').inputValue(),'old-profile');assert.equal(await panel.locator('#active-profile option').evaluateAll((nodes,id)=>nodes.some(n=>n.value===id),newId),false);
    for(const width of [300,390,600]){await panel.setViewportSize({width,height:920});assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.screenshot({path:path.join(artifacts,`ocr-profile-settings-${width}.png`),fullPage:true});}
    await panel.setViewportSize({width:390,height:920});
  });
  async function select(id){await panel.locator('#profile-selector').selectOption(id);await panel.waitForFunction(id=>document.querySelector('#profile-selector').value===id&&document.querySelector('#key-state').textContent.includes('已有密钥'),id);}
  async function probe(){const before=requests.length;await panel.locator('#test-profile').click();const deadline=Date.now()+5000;while(requests.length===before){if(Date.now()>deadline)throw new Error('No connection request');await new Promise(resolve=>setTimeout(resolve,10));}await panel.waitForFunction(()=>document.querySelector('#task-status').hidden&&!document.querySelector('#test-profile').disabled);return{message:await panel.locator('#notice').innerText(),error:await panel.locator('#notice').evaluate(n=>n.classList.contains('error'))};}
  await test('new image profile preserves old key; reasoning-only length response means connected, not bank truncation',async()=>{
    await select('old-profile');const result=await probe();assert.equal(result.error,false, result.message);assert.match(result.message,/连接成功|服务已连接/);assert.match(result.message,/长度|截断|推理/);
    assert.equal(requests.at(-1).model,'deepseek-flash');assert.equal(requests.at(-1).validKey,true);
    const preserved=await panel.evaluate(async newId=>{const{getSecret}=await import('./lib/storage.js');const p=(await chrome.storage.local.get('profilesV1')).profilesV1;return{old:await getSecret('old-profile')==='fixture-old-key',added:await getSecret(newId)==='fixture-new-key',count:p.items.length,vision:p.visionId};},newId);
    assert.deepEqual(preserved,{old:true,added:true,count:2,vision:newId});
    assert.ok(requests.at(-1).maxTokens<=256);assert.equal(requests.at(-1).messages.length,1);
  });
  await test('old and image configurations test independently across selections and reload without losing secrets',async()=>{
    mode='ok';for(const id of[newId,'old-profile',newId]){await select(id);assert.equal((await probe()).error,false);assert.equal(requests.at(-1).model,id===newId?'qwen35-ocr':'deepseek-flash');assert.equal(requests.at(-1).validKey,true);}
    await panel.reload();await panel.waitForFunction(()=>document.querySelector('#active-profile').value!=='');await panel.locator('#open-settings').click();await select('old-profile');assert.equal((await probe()).error,false);assert.equal(requests.at(-1).validKey,true);
  });
  await test('legacy OCR active selection auto-migrates on reload while workspace and both secrets remain intact',async()=>{
    await panel.evaluate(async newId=>{const p=(await chrome.storage.local.get('profilesV1')).profilesV1;p.activeId=newId;delete p.items.find(x=>x.id===newId).purpose;await chrome.storage.local.set({profilesV1:p});},newId);
    await panel.reload();await panel.waitForFunction(()=>document.querySelector('#active-profile').value==='old-profile');
    const p=await panel.evaluate(async()=>(await chrome.storage.local.get('profilesV1')).profilesV1);assert.equal(p.visionId,newId);assert.equal(p.items.find(x=>x.id===newId).purpose,'ocr');
    await panel.locator('#open-settings').click();await select('old-profile');assert.equal((await probe()).error,false);assert.equal(requests.at(-1).validKey,true);
  });
  await test('401, 429 and empty model responses remain failures without retrying or provider text leakage',async()=>{
    for(const kind of['unauthorized','rate-limit','empty']){mode=kind;const before=requests.length,result=await probe();assert.equal(result.error,true);assert.equal(requests.length,before+1);assert.ok(!result.message.includes('provider-private-fixture'));}
  });
  await test('testing locks profile switching and duplicate submissions, cancellation restores settings',async()=>{
    mode='ok';delay=2000;const before=requests.length;await panel.locator('#test-profile').click();await panel.locator('#task-status').waitFor();assert.equal(await panel.locator('#test-profile').isDisabled(),true);assert.equal(await panel.locator('#profile-selector').isDisabled(),true);assert.equal(await panel.locator('#add-profile').isDisabled(),true);
    await panel.locator('#cancel-task').click();await panel.waitForFunction(()=>document.querySelector('#task-status').hidden);assert.ok(requests.length<=before+1);assert.equal(await panel.locator('#profile-selector').isDisabled(),false);assert.deepEqual(errors,[]);
  });
}finally{await context?.close();server.close();}
await writeFile(path.join(artifacts,'model-connection-report.json'),JSON.stringify({version:manifest.version,passed:!failures.length,checks,failures,observations:requests.map(({model,validKey,maxTokens})=>({model,validKey,maxTokens})),limitations:['Mock model response and isolated browser credentials; no user API calls.']},null,2));
if(failures.length)throw new Error(failures.join('\n'));
