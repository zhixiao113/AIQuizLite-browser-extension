import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixtureBank } from './fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const items = fixtureBank.questions.map((q, index) => ({ ...q, numberInPaper: index + 1 }));
items.push({ id: 'q6', numberInPaper: 6, type: 'single', stem: '没有提供标准答案的题目', options: [{ key: 'A', text: '选项一' }, { key: 'B', text: '选项二' }], answers: [], image: null });
const serialize = value => JSON.stringify(value).replace(/</g, '\\u003c');
let mode = 'ok'; let requests = []; let apiRequests = 0;
const mediaNumbers = [4,5,9,10,12,24,35,38,59,60,61,80];
const mediaQuestion = number => ({ id:`media_${number}`,numberInPaper:number,type:'single',stem:`媒体题第${number}题：请选择正确方案${mediaNumbers.includes(number)?'（如图）':''}。`,options:[{key:'A',text:'方案甲'},{key:'B',text:'方案乙'}],answers:['B'],explanation:`第${number}题的原文解析。`,image:null,explanationImages:[] });
function mediaHtml() {
  const avatar='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="red"/></svg>').toString('base64');
  return `<!doctype html><title>媒体题库</title><style>.hide{display:none}</style><h1 data-bank-title>媒体题库</h1><p>共 100 题</p><aside>${Array.from({length:100},(_,i)=>`<button type="button" onclick="go(${i+1})">${i+1}</button>`).join('')}</aside>${Array.from({length:100},(_,i)=>{
    const n=i+1,q=mediaQuestion(n),graph=mediaNumbers.includes(n)?'<canvas width="180" height="90"></canvas>':'';
    return `<article class="datikaQstAnchor${n} t-paper-one hide" ${n===1?'style="display:block"':''}><div>${n}（单选题）${q.stem}</div>${n===80?'':graph}<p>A、方案甲</p><p>B、方案乙</p><section id="reciteanalysis${n}"><p>正确答案是：<span>B</span></p><div>批注</div><img src="${avatar}"><p>老师：确认系统答案 B 无误</p><div>解析</div><p>${q.explanation}</p>${n===80?graph:''}</section><button type="button" onclick="go(${n+1})" ${n===100?'disabled':''}>下一题</button></article>`;
  }).join('')}<script>document.querySelectorAll('canvas').forEach(c=>{const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,180,90);x.fillStyle='blue';x.fillRect(20,20,140,50)});function go(n){if(n<1||n>100)return;document.querySelectorAll('article').forEach((a,i)=>a.style.display=i===n-1?'block':'none')}</script>`;
}
function quizHtml(kind) {
  const total = kind === 'data' ? 5 : 6;
  const dataItems = items.slice(0, 5).map(q => q.type === 'judge' ? { ...q, options: [{ key: 'A', text: '错误' }, { key: 'B', text: '正确' }], answers: ['A'] } : q);
  const data = kind === 'data' ? `<script>window.paperData=${serialize({ questions: dataItems, token: 'must-not-export' })}</script>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>模拟无法复制题库</title><style>body{user-select:none;font:16px sans-serif} main{margin:20px}aside button{margin:4px}.question-item{padding:16px;background:#f5f7fa}.active{background:#2563eb;color:white}</style></head><body oncopy="return false"><h1 data-bank-title>模拟逐题题库</h1><p>共 ${total} 题</p><aside class="answer-card">${Array.from({ length: kind === 'partial' ? 3 : total }, (_, i) => `<button type="button" id="n${i + 1}" onclick="go(${i + 1})">${i + 1}</button>`).join('')}</aside><main><section id="quiz" class="question-item"></section></main>${data}<script>
  const items=${serialize(items)}; let position=Number(new URLSearchParams(location.search).get('start'))||1;
  window.availableTotal=${kind === 'partial' ? 3 : total};
  const names={single:'单选题',multi:'多选题',judge:'判断题',fill_blank:'填空题',matching:'连线题'};
  function render(){const q=items[position-1];document.querySelectorAll('aside button').forEach(b=>b.classList.toggle('active',b.id==='n'+position)); const opts=q.options.map(o=>'<p>'+o.key+'、'+o.text+'</p>').join('');const match=q.matching?'<p>'+q.matching.leftItems.map(i=>i.id+' '+i.text).join('；')+'</p><p>'+q.matching.rightItems.map(i=>i.id+' '+i.text).join('；')+'</p>':'';const answer=q.matching?q.matching.correctPairs.map(p=>p.leftId+'-'+p.rightId).join('；'):q.answers.join('、'); document.getElementById('quiz').innerHTML='<div>'+position+'（'+names[q.type]+'）'+q.stem+'</div>'+opts+match+(answer?'<p>正确答案是：'+answer+'</p>':'<p>标准答案缺失</p>')+(q.explanation?'<p>解析</p><p>'+q.explanation+'</p>':'')+'<button type="button" '+(position===window.availableTotal?'disabled':'')+' onclick="go(position+1)">下一题</button>'}
  async function go(n){if(n<1||n>window.availableTotal)return;${kind === 'api' ? "await fetch('/api/questions?page='+n).then(r=>r.json());" : ''}${kind === 'stuck' ? 'if(!window.navigationUnlocked)return;' : ''}position=n;render()}
  function unlock(){window.navigationUnlocked=true;window.availableTotal=${total};document.querySelector('aside').innerHTML=Array.from({length:${total}},(_,i)=>'<button id="n'+(i+1)+'" onclick="go('+(i+1)+')">'+(i+1)+'</button>').join('');render()}
  render();</script></body></html>`;
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
    if (mode === '401') { res.writeHead(401); res.end('private-provider-details'); return; }
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 5000));
    const source = body.messages.at(-1)?.content || '';
    let content = '示例回复：<img src=x onerror="alert(1)"> 安全文本。';
    if (body.messages[0]?.content.includes('题库整理助手')) {
      const numbers = Array.from(source.matchAll(/\[原题号:(\d+)\]/g)).map(m => Number(m[1]));
      content = source.includes('媒体题第') ? JSON.stringify({name:'媒体题库',questions:numbers.map(mediaQuestion),reviewItems:[]}) : JSON.stringify({ name: '模拟逐题题库', questions: numbers.filter(n => n <= 5).map(n => items[n - 1]), reviewItems: numbers.filter(n => n > 5).map(n => ({ sourceNumber: String(n), rawText: '原文没有标准答案', reason: '缺少标准答案' })) });
    }
    if (mode === 'bad-json') content = '{truncated';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 42 } })); return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/questions') {
    apiRequests++; const page = Number(url.searchParams.get('page')) || 1;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { questions: [items[page - 1]], totalPages: 6, pageSize: 1, total: 6 } })); return;
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (url.pathname === '/quiz-media') res.end(mediaHtml());
  else if (url.pathname === '/embed') res.end('<!doctype html><title>外层页面</title><nav>首页导航</nav><iframe src="/quiz-click?start=3" style="width:700px;height:800px"></iframe>');
  else if (url.pathname === '/login') res.end('<!doctype html><title>用户登录</title><h1>登录</h1><input type="password" value="never-export-this">');
  else res.end(quizHtml(url.pathname === '/quiz-data' ? 'data' : url.pathname === '/quiz-api' ? 'api' : url.pathname === '/quiz-stuck' ? 'stuck' : url.pathname === '/quiz-partial' ? 'partial' : 'click'));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const testExtension = path.join(artifacts, `extension-v2-${Date.now()}`); await cp(path.join(root, 'dist'), testExtension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(testExtension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*']; await writeFile(path.join(testExtension, 'manifest.json'), JSON.stringify(manifest));
let context; const checks = []; const errors = [];
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-v2-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, acceptDownloads: true, args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message)); panel.on('dialog', dialog => dialog.accept());
  await panel.goto(`chrome-extension://${id}/sidepanel.html`); await panel.locator('#profile-selector').waitFor({ state: 'attached' });
  assert.equal(await panel.locator('[data-view="bank"]').count(), 0);
  assert.equal(await panel.locator('#source-input').count(), 0);
  assert.ok(await panel.locator('#view-chat').isVisible());
  assert.equal(await panel.locator('#extension-version').textContent(),manifest.version);
  checks.push('chat-first UI; no making-bank tab or copy/paste collection controls');
  await panel.locator('#open-settings').click();
  await panel.locator('#profile-name').fill('本地验收模型'); await panel.locator('#profile-url').fill(`${origin}/v1`); await panel.locator('#profile-model').fill('fixture'); await panel.locator('#profile-key').fill('fixture-only-key');
  await panel.locator('#test-profile').click(); await panel.locator('#notice').filter({ hasText: '连接成功' }).waitFor();
  assert.ok(!await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('fixture-only-key')));
  checks.push('real extension model request and session-only secret');
  const source = await context.newPage(); source.on('pageerror', error => errors.push(`source:${error.message}`));
  async function activate(route) {
    await source.goto(`${origin}${route}`); await source.bringToFront();
    const sourceTab = await panel.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id, origin);
    await panel.evaluate(async tabId => { const tab = await chrome.tabs.get(tabId); await chrome.storage.session.set({ lastWebTabV2: { id: tab.id, windowId: tab.windowId } }); }, sourceTab);
    await panel.locator('[data-view="chat"]').click(); return sourceTab;
  }
  async function startExport(count=6) {
    await panel.locator('#chat-bank').click(); await panel.locator('#export-setup').waitFor();
    await panel.locator('#expected-total').fill(String(count)); await panel.locator('#export-setup-form').getByRole('button',{name:'开始导出'}).click();
  }
  await activate('/quiz-data'); const beforeData = requests.length;
  await startExport(5);
  await panel.locator('#export-stage').filter({ hasText: '题库已完成' }).waitFor();
  assert.equal(await panel.locator('.document-card').count(), 1); assert.ok(await panel.locator('.document-download').first().isEnabled());
  assert.equal(requests.length, beforeData);
  assert.ok(!await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get('workspaceV1')).includes('must-not-export')));
  checks.push('whole runtime dataset exported without navigating or leaking unrelated state');
  await panel.screenshot({ path: path.join(artifacts, 'chat-documents-v2.png'), fullPage: true });
  await panel.locator('.document-open').first().click(); assert.equal(await panel.locator('.question').count(), 5);
  await panel.locator('.question').first().getByText('编辑题目', { exact: true }).click();
  await panel.locator('.question-editor').getByLabel('题干', { exact: true }).fill('人工修改的题干'); await panel.locator('.question-editor').getByRole('button', { name: '保存题目' }).click();
  await panel.waitForTimeout(300); await panel.reload(); await panel.locator('.question-stem').first().filter({ hasText: '人工修改' }).waitFor();
  await panel.locator('#close-document').click();
  const downloadPromise = panel.waitForEvent('download'); await panel.locator('.document-download').first().click(); const download = await downloadPromise;
  const downloaded = path.join(artifacts, 'chat-export-v2.json'); await download.saveAs(downloaded);
  const bank = JSON.parse(await readFile(downloaded, 'utf8')); assert.equal(bank.questions.length, 5); assert.equal(bank.questions[0]._sourceOrder, undefined); assert.equal(bank.questions[0].image, null);
  assert.deepEqual(bank.questions.find(q => q.type === 'judge').answers, ['B']);
  checks.push('document card opens editable preview; changes persist; card downloads JSON');

  await activate('/quiz-click?start=3'); const beforeClick = requests.length;
  await panel.locator('#chat-input').fill('把这份题库导出来'); await panel.locator('#send-chat').click();
  await panel.locator('.message.assistant').last().filter({hasText:'共有多少题'}).waitFor(); assert.equal(requests.length,beforeClick);
  await panel.locator('#chat-input').fill('共 6 题'); await panel.locator('#send-chat').click();
  await panel.locator('#export-progress').waitFor();
  await panel.locator('#export-stage').filter({ hasText: '读取题目' }).waitFor();
  await panel.screenshot({ path: path.join(artifacts, 'chat-progress-v2.png'), fullPage: true });
  await panel.locator('#export-stage').filter({ hasText: '题库待核对' }).waitFor();
  assert.equal(requests.length, beforeClick + 1);
  const task = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1.exportTask);
  assert.equal(task.snapshots.length, 6); assert.equal(task.complete, true);
  assert.ok(await panel.locator('.document-download').first().isDisabled());
  await panel.locator('.document-open').first().click(); assert.equal(await panel.locator('.question').count(), 5); assert.equal(await panel.locator('#review-items .review-item').count(), 1);
  await panel.locator('#review-items .text-button').filter({ hasText: '排除此条原文' }).click(); assert.ok(await panel.locator('#download-bank').isDisabled());
  await panel.locator('#accept-partial').check(); assert.ok(await panel.locator('#download-bank').isEnabled());
  await panel.screenshot({ path: path.join(artifacts, 'document-preview-v2.png'), fullPage: true });
  checks.push('uncopyable sequential page from question 3 visits all six; model handles matching; missing answer stays review');

  await activate('/quiz-api'); apiRequests = 0;
  await startExport(); await panel.locator('#export-stage').filter({ hasText: '题库待核对' }).waitFor();
  const apiTask = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1.exportTask);
  assert.equal(apiTask.complete, true); assert.equal(apiTask.method, '题目接口分页'); assert.ok(apiRequests >= 6);
  checks.push('observed read-only GET pagination is fetched in background with coverage validation');

  await activate('/embed'); await startExport(); await panel.locator('#export-stage').filter({ hasText: '题库待核对' }).waitFor();
  const frameTask = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1.exportTask);
  assert.ok(frameTask.frameId > 0); assert.equal(frameTask.snapshots.length, 6);
  checks.push('same-origin iframe quiz is selected instead of outer-page navigation');

  await activate('/quiz-stuck'); await startExport();
  await panel.locator('#export-count').filter({ hasText: '1 / 6' }).waitFor(); await panel.locator('#cancel-task').click();
  await panel.locator('#export-stage').filter({ hasText: '部分采集' }).waitFor();
  await panel.locator('.document-open').first().click(); assert.ok(await panel.locator('#coverage-warning').isVisible()); assert.ok(await panel.locator('#download-bank').isDisabled());
  await panel.locator('#accept-partial').check(); assert.ok(await panel.locator('#download-bank').isEnabled());
  await panel.waitForTimeout(300); await panel.reload(); assert.ok(await panel.locator('#accept-partial').isChecked());
  checks.push('stop preserves partial document and requires explicit partial-export acceptance');

  const stoppedDocs = await panel.locator('.document-card').count();
  await source.evaluate(() => window.unlock()); await panel.locator('#close-document').click();
  await panel.locator('#resume-export').click(); await panel.locator('#export-stage').filter({ hasText:'题库待核对' }).waitFor();
  const stoppedResume = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  const stoppedDoc = stoppedResume.documents.find(doc => doc.id === stoppedResume.exportTask.documentId);
  assert.equal(stoppedDoc.bank.questions.length,5); assert.equal(stoppedDoc.bank.reviewItems.length,1);
  assert.equal(await panel.locator('.document-card').count(),stoppedDocs);
  checks.push('resuming stopped capture reuses the document and does not duplicate shown questions');

  await activate('/quiz-partial'); await startExport(); await panel.locator('#export-stage').filter({ hasText: '部分采集' }).waitFor();
  const partialDocs = await panel.locator('.document-card').count();
  await source.evaluate(() => window.unlock()); await panel.locator('#chat-input').fill('继续导出这份题库'); await panel.locator('#send-chat').click(); await panel.locator('#export-stage').filter({ hasText: '题库待核对' }).waitFor();
  const resumed = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  const resumedDoc = resumed.documents.find(doc => doc.id === resumed.exportTask.documentId);
  assert.equal(resumedDoc.coverage.complete, true); assert.equal(resumedDoc.bank.questions.length, 5); assert.equal(resumedDoc.bank.reviewItems.length, 1); assert.equal(await panel.locator('.document-card').count(), partialDocs);
  checks.push('resuming formatted partial bank adds new snapshots into same document and updates coverage');

  await activate('/login'); await startExport(); await panel.locator('#notice').filter({ hasText: '登录' }).waitFor();
  assert.ok(await panel.locator('#chat-bank').isEnabled());
  checks.push('login page is rejected rather than converted into fictitious questions');
  await panel.locator('#chat-input').fill('解释 TCP'); await panel.locator('#send-chat').click(); await panel.locator('.message.assistant').last().filter({ hasText: '安全文本' }).waitFor();
  assert.equal(await panel.locator('.messages img').count(), 0);
  mode = '401'; await panel.locator('#chat-input').fill('解释 UDP'); await panel.locator('#send-chat').click(); await panel.locator('#notice').filter({ hasText: 'API Key 无效' }).waitFor();
  mode = 'slow'; await panel.locator('#chat-input').fill('测试取消'); await panel.locator('#send-chat').click(); await panel.locator('#task-status').waitFor(); await panel.locator('#cancel-task').click(); await panel.locator('#notice').filter({ hasText: '已停止请求' }).waitFor(); mode = 'ok';
  checks.push('ordinary chat stays safe; model errors and cancellation recover controls');

  assert.ok(await panel.locator('.document-card').count()); await panel.locator('#new-draft').click(); await panel.locator('#notice').filter({hasText:'已开始新对话'}).waitFor(); assert.equal(await panel.locator('.document-card').count(), 0);
  assert.equal(await panel.locator('#saved-documents').count(),0);
  assert.equal((await panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1)).documents.length,0);
  for (const width of [300, 390, 600]) {
    await panel.setViewportSize({ width, height: 920 });
    assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.screenshot({ path: path.join(artifacts, `chat-v2-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  checks.push('confirmed new chat removes old drafts and saved-bank entry; responsive 300/390/600px; no uncaught errors');
  await activate('/quiz-media'); await panel.setViewportSize({width:390,height:920});
  const beforeMedia=requests.length;
  await panel.locator('#chat-input').fill('这份题库有100道题');await panel.locator('#send-chat').click();
  await panel.locator('.message.assistant').last().filter({hasText:'要导出的话'}).waitFor();assert.equal(requests.length,beforeMedia);
  await panel.locator('#chat-input').fill('把这份题库导出来');await panel.locator('#send-chat').click();
  await panel.locator('#export-stage').filter({hasText:'题库已完成'}).waitFor({timeout:120000});
  const mediaState=await panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1);
  const mediaDoc=mediaState.documents.find(doc=>doc.id===mediaState.exportTask.documentId);
  assert.equal(mediaDoc.bank.questions.length,100);assert.equal(mediaDoc.bank.reviewItems.length,0);assert.equal(mediaDoc.assets.length,1);
  assert.equal(requests.length,beforeMedia+2);assert.equal(mediaDoc.bank.questions.filter(q=>q.image||q.explanationImages.length).length,12);
  await panel.screenshot({path:path.join(artifacts,'complete-100-v3.png'),fullPage:true});
  checks.push('declared total plus chat intent collects 100; comments ignored; 12 real images invoke AI and preserve original assets');
  // Recreate an old 88-question draft with 12 image reviews, preserving a manual edit.
  await panel.goto('about:blank'); await panel.waitForTimeout(400);
  await worker.evaluate(async(numbers)=>{
    const state=(await chrome.storage.local.get('workspaceV1')).workspaceV1;const task=state.exportTask;const doc=state.documents.find(d=>d.id===task.documentId);
    doc.bank.questions=doc.bank.questions.filter(q=>!numbers.includes(q._sourceOrder+1));doc.bank.questions[0].stem='人工校对保留的题干';
    doc.bank.reviewItems=numbers.map(n=>({sourceNumber:String(n),rawText:task.snapshots[n-1].rawText,reason:'题目依赖图片，当前版本无法打包，需人工补齐或排除。'}));
    doc.assets=[];doc.strictCount=false;doc.requestedCount=null;task.requestedCount=null;
    for(const n of numbers){task.snapshots[n-1].imageDependent=true;delete task.snapshots[n-1].mediaAssets;}
    state.bank=doc.bank;await chrome.storage.local.set({workspaceV1:state});
  },mediaNumbers);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);const beforeRepair=requests.length;const oldDocs=await panel.locator('.document-card').count();
  assert.equal(await panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1.bank.reviewItems.length),12);
  const beforeRepairMessages=await panel.locator('#messages .message').count();
  await panel.locator('.document-open').first().click();await panel.locator('#ai-reviews').click();assert.equal(await panel.locator('#export-setup').isVisible(),false);
  await panel.waitForFunction(count=>document.querySelectorAll('#messages .message').length>=count+2&&document.querySelector('#task-status').hidden,beforeRepairMessages,{timeout:90000});
  await panel.locator('#save-status').filter({hasText:'草稿已保存在本机'}).waitFor();
  await panel.locator('#export-stage').filter({hasText:'题库已完成'}).waitFor({timeout:90000});
  const repaired=await panel.evaluate(async()=>(await chrome.storage.local.get('workspaceV1')).workspaceV1);
  const repairedDoc=repaired.documents.find(d=>d.id===repaired.exportTask.documentId);
  assert.equal(repairedDoc.bank.questions.length,100);assert.equal(repairedDoc.bank.reviewItems.length,0);assert.equal(repairedDoc.bank.questions[0].stem,'人工校对保留的题干');
  assert.equal(requests.length,beforeRepair+2);assert.equal(await panel.locator('.document-card').count(),oldDocs);
  const zipDownload=panel.waitForEvent('download');await panel.locator('.document-download').first().click();await(await zipDownload).saveAs(path.join(artifacts,'complete-100-v3.zip'));
  checks.push('legacy 88 plus 12 reviews repaired by AI into same 100-question document; manual edits persist; ZIP downloaded');
  await activate('/quiz-data');await startExport(6);await panel.locator('#notice').filter({hasText:'不一致'}).waitFor();
  assert.ok(await panel.locator('#chat-bank').isEnabled());
  checks.push('user total conflicts with page total and cannot be reported as complete');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(artifacts, 'browser-report-v2.json'), JSON.stringify({ passed: true, version: manifest.version, testedAt: new Date().toISOString(), checks, limitations: ['authenticated zhiqiantong page not available to agent', 'mock model and test-origin pregrant', 'real phone import pending'] }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }


