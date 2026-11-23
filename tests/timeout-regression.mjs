import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const questions = Array.from({ length: 152 }, (_, i) => ({ id: `source_${i + 1}`, numberInPaper: i + 1, type: 'single', stem: `第${i + 1}题请选择正确配置。`, options: [{ key: 'A', text: '方案甲' }, { key: 'B', text: '方案乙' }], answers: ['B'], explanation: null, image: null, explanationImages: [] }));
let mode = 'adaptive'; const requests = [], held = [];
const release = () => held.splice(0).forEach(resolve => resolve());
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(`<!doctype html><title>152题回归题库</title><h1 data-bank-title>152题回归题库</h1><p>共152题</p><script>window.paperData=${JSON.stringify({questions:mode==='partial'?questions.slice(0,50):questions}).replace(/</g, '\\u003c')}</script>`); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const numbers = Array.from(body.messages.at(-1).content.matchAll(/\[原题号:(\d+)\]/g), m => Number(m[1]));
  requests.push({ body, numbers });
  if (mode === 'http504') { res.writeHead(504);res.end('private-upstream-timeout');return; }
  if (mode === 'timeout-all' || mode === 'timeout-batch' && numbers.length>3) await new Promise(resolve=>held.push(resolve));
  if (res.destroyed) return;
  if (mode === 'http401') { res.writeHead(401); res.end('must-not-surface'); return; }
  if (mode === 'cancel' && numbers.length <= 3 && numbers[0] >= 81) await new Promise(resolve => held.push(resolve));
  const truncated = mode !== 'plain' && (mode === 'single' || numbers.length > (mode === 'silent' ? 2 : 3));
  const content = mode === 'plain' ? '原文已识别，但没有输出题库 JSON' : truncated ? '{"name":"截断题库","questions":[' : JSON.stringify({ name: '152题回归题库', questions: numbers.map(n => questions[n - 1]), reviewItems: [] });
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: truncated && mode !== 'silent' ? 'length' : 'stop' }], usage: { total_tokens: 42 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-timeout-${Date.now()}`); await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')); manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context; const checks = [], failures = [], errors = [];
async function test(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push(`${name}: ${error.message}`); } }
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-timeout-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.addInitScript(()=>{const native=window.setTimeout;window.setTimeout=(handler,ms,...args)=>native(handler,ms===90000?200:ms,...args);}); panel.on('pageerror', error => errors.push(error.message));
  const source = await context.newPage(); await source.goto(`${origin}/quiz`);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const tab = await panel.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/quiz` }))[0], origin);
  const state = () => panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  async function seed(kind, missingAnswer = false, completedCount = 125, repairMode = false) {
    await panel.goto('about:blank'); await panel.waitForTimeout(350); release(); mode = kind; requests.length = 0;
    if (kind === 'partial') await source.reload();
    await worker.evaluate(async ({ origin, questions, missingAnswer, completedCount, repairMode, tabId, partial }) => {
      const snapshots = questions.slice(0,partial?50:152).map((q, i) => ({ number: i + 1, identity: `number_${i + 1}`, question: missingAnswer && i === 100 ? { ...q, answers: [] } : q }));
      const bank = { name: '152题回归题库', questions: questions.slice(0, completedCount).map((q, i) => ({ ...q, _sourceOrder: i })), reviewItems: repairMode ? questions.slice(completedCount).map(q=>({sourceNumber:String(q.numberInPaper),rawText:q.stem,reason:'等待 AI 核对'})) : [] };
      if (completedCount) bank.questions[0].stem = '人工修改的第1题必须保留';
      const source = { title: bank.name, url: `${origin}/quiz`, text: '', mode: 'bank' };
      const doc = { id: 'same-document', sessionId: 'seed-session', name: bank.name, bank, source, excluded: [], resolvedReviews: [], assets: [], requestedCount: 152, strictCount: true, formatComplete: repairMode, coverage: { complete: !partial, captured: snapshots.length, expected: 152 }, partialAccepted: false };
      const task = { id: 'same-task', tabId, documentId: doc.id, title: bank.name, url: source.url, origin, topOrigin: origin, expected: 152, requestedCount: 152, complete: !partial, snapshots, stage: repairMode ? 'review' : 'failed', status: repairMode ? 'finished' : 'paused', label: '模型输出被截断' };
      const generation = { kind: 'export', documentId: doc.id, chunks: [Array.from({ length: snapshots.length - completedCount }, (_, i) => i + completedCount)], next: repairMode ? 1 : 0, snapshotCount: snapshots.length, totalTokens: 0, hasUsage: true };
      await chrome.storage.local.set({ workspaceV1: { version: 1, sessionId: 'seed-session', sessions: [], source, bank, excluded: [], resolvedReviews: [], documents: [doc], activeDocumentId: doc.id, exportTask: task, generation, pendingExport: null, activeView: 'document', messages: [{ role: 'assistant', content: '上一份题库的聊天 SENTINEL_OLD_HISTORY' }], jsonDraft: '' }, profilesV1: { activeId: 'fixture-model', items: [{ id: 'fixture-model', name: '测试配置', baseUrl: `${origin}/v1`, model: 'fixture', remember: false }] } });
      await chrome.storage.session.set({ secretsV1: { 'fixture-model': 'fixture-only-key' } });
    }, { origin, questions, missingAnswer, completedCount, repairMode, tabId: tab.id, partial:kind==='partial' });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.locator(repairMode ? '#ai-reviews' : '#resume-generation').click();
  }
  async function finish() { await panel.locator('#task-status').waitFor({ state: 'hidden' }); await panel.locator('#save-status').filter({ hasText: '草稿已保存在本机' }).waitFor(); }
  function verifyFull(saved, completedCount = 125) {
    assert.equal(saved.documents.length, 1); assert.equal(saved.activeDocumentId, 'same-document');
    assert.equal(saved.bank.questions.length, 152); assert.equal(saved.bank.reviewItems.length, 0);
    assert.equal(saved.bank.questions[0].stem, completedCount ? '人工修改的第1题必须保留' : questions[0].stem);
    assert.deepEqual(saved.bank.questions.map(q => q._sourceOrder), Array.from({ length: 152 }, (_, i) => i));
    assert.equal(saved.exportTask.stage, 'ready');
    assert.ok(requests.every(({ body, numbers }) => body.messages.length === 2 && !JSON.stringify(body).includes('SENTINEL_OLD_HISTORY') && numbers.every(n => n > completedCount)));
    assert.ok(saved.messages.at(-1).content.includes('新对话'));
  }
  await test('actual fetch timeout at 125 of 152 shrinks the failed batch and completes only remaining sources',async()=>{
    await seed('timeout-batch');await finish();const saved=await state();verifyFull(saved);assert.equal(saved.generation.timeoutSplits,1);assert.equal(requests[0].numbers.length,6);assert.ok(requests[1].numbers.length<=3);assert.ok(requests.every(r=>r.body.max_tokens===12000));
  });
  await test('repeated timeouts have a bounded automatic retry and persist smaller children across reload',async()=>{
    await seed('timeout-all');await finish();const saved=await state();assert.equal(saved.bank.questions.length,125);assert.equal(saved.exportTask.status,'paused');assert.equal(requests.length,2);assert.equal(saved.generation.chunks[saved.generation.next].length,2);assert.equal(saved.generation.next,0);assert.match(saved.messages.at(-1).content,/超时/);
    const before=requests.length;mode='adaptive';release();await panel.reload();await panel.locator('#resume-export').waitFor();assert.equal(requests.length,before);await panel.locator('#resume-export').click();await finish();verifyFull(await state());assert.equal(requests[before].numbers.length,2);
  });
  await test('one-question timeout remains pending with no guessed fallback and no automatic retry',async()=>{
    await seed('timeout-all',false,151);await finish();const saved=await state();assert.equal(requests.length,1);assert.equal(saved.bank.questions.length,151);assert.equal(saved.generation.next,0);assert.equal(saved.exportTask.status,'paused');assert.equal(saved.bank.reviewItems.length,0);assert.match(saved.messages.at(-1).content,/单题/);
  });
  await test('upstream 504 stays a manual pause instead of causing a retry storm',async()=>{
    await seed('http504');await finish();const saved=await state();assert.equal(requests.length,1);assert.equal(saved.bank.questions.length,125);assert.equal(saved.exportTask.status,'paused');assert.ok(!saved.messages.at(-1).content.includes('private-upstream-timeout'));
  });
  assert.deepEqual(errors,[]);
} finally {release();await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
await writeFile(path.join(artifacts,'timeout-report.json'),JSON.stringify({version:manifest.version,passed:!failures.length,checks,failures,limitations:['Isolated local model fixture; real browser fetch abort with only the 90s test timer shortened to 200ms. No user keys or service calls.']},null,2));
if(failures.length)throw new Error(failures.join('\n'));console.log(JSON.stringify({passed:true,checks}));

