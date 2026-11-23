import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const clean = '2\n(单选题)请选择配置\nA. ip as-path-filter 1 permit _65001_\nB. ip as-path-filter 1 permit 65001$\n正确答案：A\n我要纠错';
const broken = clean.replace('B. ip as-path-filter', 'B. 额外错误 B. ip as-path-filter');
const blank = '3\n(填空题)greater-equal-value-( ), less-equal-value-( )。\n正确答案：\n26\n32\n答案顺序固定\n我要纠错';
let mode = 'success', delay = 0; const calls = [];
const sourceHtml = `<!doctype html><meta charset="utf-8"><title>深度核对回归题库</title>
<style>body{margin:0;font:18px sans-serif}nav{padding:20px;background:#eee}button{margin:4px}.t-paper-one{margin:30px;width:700px;background:white}pre{white-space:pre-wrap;font:18px monospace;margin:0;min-height:1100px}#outside{background:#fa0000;height:100px}canvas{background:#00ff00}</style>
<nav>共3题<button type="button" onclick="show(1)">1</button><button type="button" onclick="show(2)">2</button><button type="button" onclick="show(3)">3</button></nav><div id="outside">PRIVATE_OUTSIDE_QUESTION</div><main></main>
<script>const data=${JSON.stringify(['1\n(单选题)第一题\nA. 甲\nB. 乙\n正确答案：B',broken,blank])};function show(n){document.querySelector('main').innerHTML='<article class="t-paper-one datikaQstAnchor'+n+'"><pre></pre></article>';document.querySelector('pre').textContent=data[n-1];if(n===2){const c=document.createElement('canvas');c.width=100;c.height=60;c.getContext('2d').fillRect(10,10,40,20);document.querySelector('article').prepend(c);}}show(1);</script>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(sourceHtml); return; }
  let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); calls.push(body);
  if (req.headers.authorization !== `Bearer ${body.model==='text'?'text-fixture-key':'vision-fixture-key'}`) {res.writeHead(401);res.end('wrong-config-key');return;}
  if (body.model === 'qwen3.5-ocr' && (body.messages.some(m=>m.role==='system') || body.max_tokens>4096)) {res.writeHead(400);res.end('unsupported-system-message');return;}
  const content = body.messages.at(-1).content;
  let reply;
  if (Array.isArray(content)) {
    const detectedNumber=mode==='all-success'?content[0].text.match(/\[原题号:(\d+)\]/)[1]:'2';
    reply = { number: mode === 'wrong-number' ? '3' : detectedNumber, rawText: detectedNumber==='3'?blank:mode === 'conflict' ? clean.replace('正确答案：A','正确答案：B') : clean, uncertain: mode === 'uncertain', reason: mode === 'uncertain' ? '代码标点看不清' : '' };
  } else {
    const numbers = [...content.matchAll(/\[原题号:(\d+)\]/g)].map(m => m[1]);
    reply = { name: '深度核对回归题库', questions: [], reviewItems: numbers.map(n => ({ sourceNumber: n, rawText: n === '2' ? clean : blank, reason: '选项格式异常或多空待核对' })) };
  }
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: mode === 'plain-ocr' && Array.isArray(content) ? reply.rawText : mode === 'formatter-invalid' && !Array.isArray(content) ? '不是 JSON 的整理回复' : JSON.stringify(reply) }, finish_reason: mode === 'truncated' && Array.isArray(content) ? 'length' : 'stop' }], usage: { total_tokens: 11 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-deep-review-${Date.now()}`); await cp(path.join(root,'dist'),extension,{recursive:true});
const withoutGrant = process.argv.includes('--without-capture-grant');
const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
// Test copy only: captureVisibleTab cannot receive a toolbar activeTab grant in
// headless mode. Shipped manifest stays on explicit hosts + activeTab.
manifest.host_permissions.push(withoutGrant ? 'http://127.0.0.1/*' : '<all_urls>'); await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
let nativeGestureVerified = false, nativeGestureDispatched = false;
const focusedCase = process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
const checks = [], failures = [], errors = []; let context, inspectState;
async function test(name,run){if(focusedCase&&!name.includes(focusedCase))return;console.log(`START ${name}`);try{await run();checks.push(name);console.log(`PASS ${name}`);}catch(error){failures.push(`${name}: ${error.stack}`); if(inspectState) await writeFile(path.join(artifacts,'deep-debug-'+name.split(' ')[0]+'.json'),JSON.stringify(await inspectState(),null,2));console.log(`FAIL ${name}: ${error.message}`);}}
try {
  context = await chromium.launchPersistentContext(path.join(artifacts,`profile-deep-review-${Date.now()}`),{channel:'chromium',headless:true,viewport:{width:1100,height:780},acceptDownloads:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  let source=await context.newPage();await source.goto(`${origin}/quiz`);
  const panel=await context.newPage();panel.on('pageerror',e=>errors.push(e.message));
  const url=`chrome-extension://${id}/sidepanel.html`;await panel.goto(url);
  let tab=await panel.evaluate(async origin=>(await chrome.tabs.query({url:`${origin}/quiz`}))[0],origin);
  const state=inspectState=()=>panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1);
  async function seed(attempted=true,vision=true){
    await panel.goto('about:blank');await panel.waitForTimeout(300);mode='success';delay=0;calls.length=0;
    if (source.url() !== `${origin}/quiz`) await source.goto(`${origin}/quiz`);
    await source.evaluate(broken=>{data[1]=broken;show(1);},broken);
    await worker.evaluate(async({origin,tabId,clean,broken,blank,attempted,vision})=>{
      const q={id:'original1',type:'single',stem:'人工编辑的第一题',options:[{key:'A',text:'甲'},{key:'B',text:'乙'}],answers:['B'],explanation:null,image:null,explanationImages:[],_sourceOrder:0};
      const bank={name:'深度核对回归题库',questions:[q],reviewItems:[{sourceNumber:'2',rawText:broken,reason:'选项格式异常'},{sourceNumber:'3',rawText:blank,reason:'多空待核对'}]};
      const source={url:`${origin}/quiz`,title:bank.name,mode:'bank',text:''};
      const doc={id:'doc',sessionId:'session',name:bank.name,bank,source,excluded:[],resolvedReviews:[],assets:[],strictCount:true,requestedCount:3,formatComplete:true,coverage:{complete:true,captured:3,expected:3},...(attempted?{lastReviewRun:{added:0,remaining:2,noProgress:true,summary:'普通核对没有补齐'}}:{})};
      const task={id:'task',documentId:'doc',tabId,frameId:0,url:source.url,origin,topOrigin:origin,title:bank.name,expected:3,requestedCount:3,complete:true,stage:'review',status:'finished',snapshots:[{number:1,identity:'number_1',question:q},{number:2,identity:'number_2',rawText:broken},{number:3,identity:'number_3',rawText:blank}]};
      await chrome.storage.local.set({workspaceV1:{version:1,sessionId:'session',sessions:[],source,bank,excluded:[],resolvedReviews:[],messages:[{role:'assistant',content:'OLD_PRIVATE_HISTORY'}],documents:[doc],activeDocumentId:'doc',activeView:'document',exportTask:task,generation:{kind:'export',documentId:'doc',chunks:[],next:0,snapshotCount:3,totalTokens:0,hasUsage:true}},profilesV1:{activeId:'text',visionId:'vision',items:[{id:'text',name:'文本模型',baseUrl:`${origin}/v1`,model:'text'},{id:'vision',name:'图片模型',baseUrl:`${origin}/v1`,model:'vision',vision}]}});
      await chrome.storage.session.set({secretsV1:{text:'text-fixture-key',vision:'vision-fixture-key'}});
    },{origin,tabId:tab.id,clean,broken,blank,attempted,vision});
    await panel.setViewportSize({width:1100,height:780});await panel.goto(url);await panel.addStyleTag({content:'body{max-width:390px}'});await panel.waitForFunction(()=>!document.querySelector('#ai-reviews').disabled&&document.querySelector('#active-profile').value==='text');
  }
  const waitDone=()=>panel.waitForFunction(()=>document.querySelector('#task-status').hidden&&document.querySelector('#new-draft').disabled===false);
  async function deep(){await source.evaluate(clean=>{data[1]=clean;show(1);},clean);await panel.locator('#deep-reviews').click();await waitDone();return state();}
  if (withoutGrant) {
    await test('actual screenshot permission failure pauses before OCR and never reports completion',async()=>{
      await seed();const saved=await deep();assert.equal(calls.length,0);assert.equal(saved.bank.questions.length,1);assert.equal(saved.exportTask.status,'blocked');assert.equal(saved.exportTask.stage,'capture-blocked');assert.ok(saved.exportTask.captureNeedsGrant);assert.ok(!saved.messages.at(-1).content.includes('已结束'));assert.equal(saved.documents[0].lastDeepReviewRun.attempted,0);assert.equal(await panel.locator('#export-stage').innerText(),'等待截图授权');await panel.screenshot({path:path.join(artifacts,'capture-waiting-permission.png'),clip:{x:0,y:0,width:390,height:780}});
    });
    await test('blocked capture remains actionable after reload and clears with the conversation',async()=>{
      await panel.reload();await panel.locator('#capture-help').waitFor();assert.equal(await panel.locator('#export-stage').innerText(),'等待截图授权');await panel.locator('#focus-quiz-tab').click();assert.equal((await source.evaluate(()=>location.pathname)),'/quiz');panel.once('dialog',d=>d.accept());await panel.locator('#clear-chat').click();await panel.locator('#notice').filter({hasText:'已清空本地对话和题库草稿'}).waitFor();assert.equal(await panel.locator('#capture-help').isVisible(),false);
    });
    await test('matching native-invocation signal resumes only once; wrong tab cannot trigger OCR',async()=>{
      await seed();await deep();const initial=await state();const time=Date.now()+2;await panel.evaluate(async ({tabId,url,at})=>chrome.storage.session.set({captureInvocationV1:{tabId:tabId+1,url,at,nonce:'wrong-tab'}}),{tabId:tab.id,url:initial.exportTask.url,at:time});await panel.waitForTimeout(150);assert.equal((await state()).exportTask.captureBlockedAt,initial.exportTask.captureBlockedAt);
      await panel.evaluate(async ({tabId,url,at})=>chrome.storage.session.set({captureInvocationV1:{tabId,url,at,nonce:'correct-tab'}}),{tabId:tab.id,url:initial.exportTask.url,at:Date.now()+2});await panel.waitForFunction(()=>!document.querySelector('#task-status').hidden);await waitDone();const saved=await state();assert.equal(saved.exportTask.captureGrantUsed,'correct-tab');assert.equal(saved.exportTask.status,'blocked');assert.ok(saved.exportTask.captureBlockedAt>initial.exportTask.captureBlockedAt);assert.equal(calls.length,0);
    });
    await test('automatic continuation checks existing media permissions instead of requesting a new user gesture',async()=>{
      await seed();await deep();const initial=await state();
      await panel.evaluate(async()=>{window.permissionRequestCalls=0;window.oldRequest=chrome.permissions.request;chrome.permissions.request=()=>{window.permissionRequestCalls++;throw new Error('Permissions request requires a user gesture');};const state=(await chrome.storage.local.get('workspaceV1')).workspaceV1;state.documents[0].source.url='https://exam.zhiqiantong.cn/paper/toExamRecitePaper/495034';state.source.url=state.documents[0].source.url;await chrome.storage.local.set({workspaceV1:state});});
      await panel.reload();await panel.locator('#capture-help').waitFor();
      // Reload restores the native request function; install the guard again.
      await panel.evaluate(()=>{window.permissionRequestCalls=0;window.oldRequest=chrome.permissions.request;chrome.permissions.request=()=>{window.permissionRequestCalls++;throw new Error('Permissions request requires a user gesture');};});
      try{await panel.evaluate(async ({tabId,url})=>chrome.storage.session.set({captureInvocationV1:{tabId,url,at:Date.now()+2,nonce:'media-check'}}),{tabId:tab.id,url:initial.exportTask.url});await panel.waitForFunction(()=>!document.querySelector('#task-status').hidden);await waitDone();const saved=await state();assert.ok(saved.exportTask.captureBlockedAt>initial.exportTask.captureBlockedAt);assert.equal(saved.exportTask.status,'blocked');assert.equal(await panel.evaluate(()=>window.permissionRequestCalls),0);assert.equal(calls.length,0);}
      finally{await panel.evaluate(()=>{chrome.permissions.request=window.oldRequest;});}
    });
    // Try the real registered action shortcut in this isolated browser. Some
    // headless builds do not dispatch browser accelerators; record that limit.
    await source.bringToFront();await source.keyboard.press('Alt+Shift+Q');await panel.waitForTimeout(500);
    const nativeSignal=await panel.evaluate(async()=> (await chrome.storage.session.get('captureInvocationV1')).captureInvocationV1);
    nativeGestureDispatched=Boolean(nativeSignal?.nonce&&!['correct-tab','wrong-tab','media-check'].includes(nativeSignal.nonce));
    if(nativeGestureDispatched){
      await waitDone();const nativeState=await state();nativeGestureVerified=calls.length>0&&nativeState.bank.questions.some(q=>q._reviewMethod==='deep-ocr');
    }
    console.log(JSON.stringify({nativeGestureVerified,nativeGestureDispatched}));
  } else {
  await test('deep button appears only after ordinary review, which converts complete ordered blanks',async()=>{
    await seed(false);assert.equal(await panel.locator('#deep-reviews').isVisible(),false);
    await panel.locator('#ai-reviews').click();await waitDone();const saved=await state();assert.equal(saved.bank.questions.length,2);assert.deepEqual(saved.bank.questions.find(q=>q._sourceOrder===2).answers,['26,32']);
    await panel.locator('.document-open').click();assert.equal(await panel.locator('#deep-reviews').isVisible(),true);assert.equal(saved.bank.reviewItems.length,1);
  });
  await test('raw edit is cancellable, saved across reload and used after webpage refresh',async()=>{
    await seed();let block=panel.locator('.review-item').filter({has:panel.locator('strong',{hasText:'2 · 待核对'})});
    await block.getByRole('button',{name:'编辑第 2 题待核对原文'}).click();await block.locator('textarea').fill(clean);await block.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await state()).bank.reviewItems[0].rawText,broken);
    await block.getByRole('button',{name:'编辑第 2 题待核对原文'}).click();await block.locator('textarea').fill(clean);await block.getByRole('button',{name:'保存原文'}).click();await panel.locator('#notice').filter({hasText:'原文已保存'}).waitFor();await panel.reload();await panel.locator('#ai-reviews').waitFor();
    await panel.locator('#ai-reviews').click();await waitDone();const saved=await state();assert.equal(saved.bank.questions.length,3);assert.deepEqual(saved.bank.questions.find(q=>q._sourceOrder===1).answers,['A']);assert.equal(saved.documents[0].reviewEdits['2'].rawText,clean);assert.equal(saved.bank.questions[0].stem,'人工编辑的第一题');
    assert.ok(calls.some(c=>typeof c.messages.at(-1).content==='string'&&c.messages.at(-1).content.includes(clean)));assert.ok(!JSON.stringify(calls).includes('OLD_PRIVATE_HISTORY'));
  });
  await test('text-only models stop before screenshots or paid OCR calls with a configuration message',async()=>{
    await seed(true,false);await deep();assert.equal(calls.length,0);assert.match(await panel.locator('#notice').innerText(),/图片模型/);assert.equal((await state()).bank.questions.length,1);
  });
  await test('deep review captures real cropped question tiles and uses the separate vision model, preserving source counts',async()=>{
    await seed();await source.evaluate(clean=>{data[1]=clean;show(1);},clean);delay=250;
    await panel.locator('#deep-reviews').click();await panel.locator('#export-stage').filter({hasText:'深度核对中'}).waitFor();assert.match(await panel.locator('#export-detail').innerText(),/时间稍长，请耐心等待/);
    await panel.screenshot({path:path.join(artifacts,'deep-review-progress-390.png'),clip:{x:0,y:0,width:390,height:780}});
    await waitDone();const saved=await state();assert.equal(saved.bank.questions.length,2);assert.ok(saved.bank.questions.some(q=>q._sourceOrder===1&&q._reviewMethod==='deep-ocr'));
    assert.equal(saved.bank.questions[0].stem,'人工编辑的第一题');assert.equal(saved.documents[0].lastDeepReviewRun.added,1);assert.equal(saved.exportTask.expected,3);assert.equal(saved.exportTask.snapshots.length,3);
    const imageCall=calls.find(c=>Array.isArray(c.messages.at(-1).content));assert.equal(imageCall.model,'vision');assert.ok(imageCall.messages.at(-1).content.filter(c=>c.type==='image_url').length>=2);
    const images=imageCall.messages.at(-1).content.filter(c=>c.type==='image_url');const bytes=Buffer.from(images[0].image_url.url.split(',')[1],'base64');assert.equal(bytes.subarray(1,4).toString(),'PNG');await writeFile(path.join(artifacts,'deep-review-cropped-question.png'),bytes);
    const dimension=await panel.evaluate(async data=>{const b=await createImageBitmap(await(await fetch(data)).blob());const c=new OffscreenCanvas(b.width,b.height);const x=c.getContext('2d');x.drawImage(b,0,0);const pixel=Array.from(x.getImageData(0,0,1,1).data);return{width:b.width,height:b.height,pixel};},images[0].image_url.url);assert.equal(dimension.width,700);assert.ok(dimension.height>100&&dimension.width*dimension.height<=24000000);assert.deepEqual(dimension.pixel,[0,255,0,255]);
    assert.ok(!JSON.stringify(calls).includes('OLD_PRIVATE_HISTORY'));const q=saved.bank.questions.find(q=>q._sourceOrder===1);assert.match(q.image,/^images\//);assert.equal(saved.documents[0].assets.length,1);assert.ok(images.length>=3);const original=await panel.evaluate(async asset=>{const {mediaAsset}=await import('./lib/media.js');const b=await createImageBitmap((await mediaAsset(asset.id)).blob);return{width:b.width,height:b.height};},saved.documents[0].assets[0]);assert.deepEqual(original,{width:100,height:60});
  });
  await test('dedicated OCR plaintext is organized by the text model with its own key and saved as evidence',async()=>{
    await seed();await panel.goto('about:blank');await worker.evaluate(async()=>{const p=(await chrome.storage.local.get('profilesV1')).profilesV1;p.items.find(x=>x.id==='vision').model='qwen3.5-ocr';p.items.find(x=>x.id==='vision').purpose='ocr';await chrome.storage.local.set({profilesV1:p});});
    await panel.goto(url);await panel.locator('#deep-reviews').waitFor();mode='plain-ocr';const saved=await deep();
    assert.equal(saved.bank.questions.length,2);assert.equal(saved.documents[0].lastDeepReviewRun.added,1);assert.ok(saved.exportTask.snapshots[1].ocrRawText.includes('_65001_'));
    assert.ok(calls.filter(c=>Array.isArray(c.messages.at(-1).content)).every(c=>c.model==='qwen3.5-ocr'));
    assert.ok(calls.filter(c=>typeof c.messages.at(-1).content==='string').every(c=>c.model==='text'));
    assert.equal(await panel.locator('#active-profile').inputValue(),'text');
  });
  await test('formatter invalid JSON reports its stage and retains OCR evidence and completed questions',async()=>{
    await seed();mode='formatter-invalid';const saved=await deep();assert.equal(saved.bank.questions.length,1);assert.equal(saved.exportTask.status,'needs_review');assert.match(saved.bank.reviewItems[0].reason,/整理模型/);assert.ok(saved.bank.reviewItems[0].ocrRawText.includes('_65001_'));assert.ok(saved.exportTask.snapshots[1].ocrRawText.includes('_65001_'));assert.equal(saved.bank.questions[0].stem,'人工编辑的第一题');
    assert.match(await panel.locator('#export-detail').innerText(),/第 2 题.*整理模型/);
    assert.match(saved.messages.at(-1).content,/第 2 题.*整理模型/);
    // Older drafts only persisted a count summary; render their item reason
    // without another paid model request.
    await panel.goto('about:blank');await worker.evaluate(async()=>{const w=(await chrome.storage.local.get('workspaceV1')).workspaceV1;w.exportTask.label='本轮深度核对补齐 0 道';w.documents[0].lastDeepReviewRun.summary=w.exportTask.label;await chrome.storage.local.set({workspaceV1:w});});
    const beforeReloadCalls=calls.length;await panel.goto(url);await panel.locator('#export-detail').filter({hasText:'整理模型'}).waitFor();assert.equal(calls.length,beforeReloadCalls);
    await panel.locator('.document-open').click();const downloaded=panel.waitForEvent('download');await panel.locator('#download-review-diagnostics').click();const diagnosticPath=path.join(artifacts,'deep-formatter-diagnostic.json');await(await downloaded).saveAs(diagnosticPath);const diagnosticText=await readFile(diagnosticPath,'utf8'),diagnostic=JSON.parse(diagnosticText);assert.equal(diagnostic.unresolved[0].code,'bank_json_invalid');assert.equal(diagnostic.unresolved[0].hasOcrEvidence,true);assert.equal(diagnostic.lastDeepReview.added,0);assert.ok(!/fixture-key|rawText|_65001_|Authorization/.test(diagnosticText));
  });
  await test('only full verified coverage reports a completed deep review',async()=>{
    await seed();mode='all-success';const saved=await deep();assert.equal(saved.bank.questions.length,3);assert.equal(saved.exportTask.status,'finished');assert.equal(saved.exportTask.stage,'ready');assert.equal(saved.documents[0].lastDeepReviewRun.status,'completed');assert.deepEqual(saved.bank.questions.map(q=>q._sourceOrder),[0,1,2]);assert.ok(saved.messages.at(-1).content.includes('题库已完成'));
  });
  await test('explicitly accepted partial export does not claim the whole bank is complete',async()=>{
    await seed();await panel.locator('#accept-partial').check();await panel.locator('.question input[type="checkbox"]').first().check();mode='all-success';const saved=await deep();assert.equal(saved.bank.questions.length,3);assert.equal(saved.exportTask.status,'needs_review');assert.equal(saved.documents[0].lastDeepReviewRun.status,'needs_review');assert.ok(!saved.messages.at(-1).content.includes('题库已完成'));assert.ok(saved.messages.at(-1).content.includes('未完成'));
  });
  for(const failureMode of ['conflict','uncertain','wrong-number','truncated'])await test(`${failureMode} OCR stays pending without invented questions`,async()=>{
    await seed();mode=failureMode;const saved=await deep();assert.equal(saved.bank.questions.length,1);assert.equal(saved.resolvedReviews.length,0);assert.ok(saved.bank.reviewItems[0].reason.includes('深度核对未完成'));assert.ok(calls.filter(c=>Array.isArray(c.messages.at(-1).content)).length===2);
  });
  await test('stop aborts OCR without clearing pending sources, and page mismatch sends no screenshot',async()=>{
    await seed();delay=5000;await panel.locator('#deep-reviews').click();await panel.waitForFunction(()=>document.querySelector('#task-label').textContent.includes('图片识别中'));await panel.locator('#cancel-task').click();await waitDone();assert.equal((await state()).bank.questions.length,1);assert.equal((await state()).exportTask.status,'paused');
    await seed();await source.goto(`${origin}/other-paper`);await deep();assert.equal(calls.length,0);assert.equal((await state()).exportTask.status,'paused');assert.ok((await state()).messages.at(-1).content.includes('离开这份题库'));await source.goto(`${origin}/quiz`);
  });
  await test('switching active tabs during capture rejects the screenshot before a vision request',async()=>{
    await seed();
    await panel.evaluate(async()=>{
      const id=(await chrome.tabs.getCurrent()).id;
      const original=chrome.tabs.captureVisibleTab.bind(chrome.tabs);
      window.restoreCapture=()=>{chrome.tabs.captureVisibleTab=original;};
      chrome.tabs.captureVisibleTab=async(...args)=>{const png=await original(...args);await chrome.tabs.update(id,{active:true});return png;};
    });
    try{const saved=await deep();assert.equal(calls.length,0);assert.equal(saved.bank.questions.length,1);assert.ok(saved.bank.reviewItems[0].reason.includes('切换了标签页'));}
    finally{await panel.evaluate(()=>window.restoreCapture());}
  });
  await test('deep review rebinds a reopened original bank and persists the new tab ID',async()=>{
    await seed(); const previousId=tab.id; await source.close();
    source=await context.newPage(); await source.goto(`${origin}/quiz`);
    const saved=await deep();
    tab=await panel.evaluate(async origin=>(await chrome.tabs.query({url:`${origin}/quiz`}))[0],origin);
    assert.notEqual(tab.id,previousId);assert.equal(saved.exportTask.tabId,tab.id);
    assert.ok(calls.some(call=>Array.isArray(call.messages.at(-1).content)));
    assert.ok(saved.bank.questions.some(q=>q._sourceOrder===1));
    assert.equal(saved.bank.questions[0].stem,'人工编辑的第一题');
    assert.ok(!saved.messages.some(m=>m.content.includes('No tab with id')));
  });
  await test('deep review with no original bank pauses before OCR and keeps all pending sources',async()=>{
    await seed();await source.goto(`${origin}/different-paper`);
    await panel.locator('#deep-reviews').click();await waitDone();const saved=await state();
    assert.equal(calls.length,0);assert.equal(saved.bank.questions.length,1);assert.equal(saved.bank.reviewItems.length,2);
    assert.equal(saved.exportTask.status,'paused');assert.match(saved.messages.at(-1).content,/原题库标签页/);
    await source.goto(`${origin}/quiz`);
  });
  await test('review action and editor layouts fit 300, 390 and 600 pixels with no browser errors',async()=>{
    await seed();for(const width of [300,390,600]){await panel.setViewportSize({width,height:920});assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await panel.screenshot({path:path.join(artifacts,`deep-review-actions-${width}.png`),fullPage:true});}assert.deepEqual(errors,[]);
  });
  }
}finally{await context?.close();server.close();}
await writeFile(path.join(artifacts,focusedCase?'deep-review-focused-report.json':withoutGrant?'capture-permission-report.json':'deep-review-report.json'),JSON.stringify({version:manifest.version,nativeGestureVerified,nativeGestureDispatched,passed:!failures.length,checks,failures,limitations:['Real Chromium navigation and screenshots; mocked vision API responses, no live OCR quality claim.','Authenticated user bank and phone import not accessed.',withoutGrant?'No all_urls capture grant; native browser denial reproduced. Headless accelerators may not deliver a real action gesture.':'Extra screenshot permission in isolated test manifest only.']},null,2));
if(failures.length)throw new Error(failures.join('\n'));console.log(JSON.stringify({passed:true,checks}));
