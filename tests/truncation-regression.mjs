import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const questions = Array.from({ length: 101 }, (_, i) => ({ id: `source_${i + 1}`, numberInPaper: i + 1, type: 'single', stem: `第${i + 1}题请选择正确配置。`, options: [{ key: 'A', text: '方案甲' }, { key: 'B', text: '方案乙' }], answers: ['B'], explanation: null, image: null, explanationImages: [] }));
let mode = 'adaptive'; const requests = [], held = [];
const release = () => held.splice(0).forEach(resolve => resolve());
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(`<!doctype html><title>101题回归题库</title><h1 data-bank-title>101题回归题库</h1><p>共101题</p><script>window.paperData=${JSON.stringify({questions:mode==='partial'?questions.slice(0,50):questions}).replace(/</g, '\\u003c')}</script>`); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const numbers = Array.from(body.messages.at(-1).content.matchAll(/\[原题号:(\d+)\]/g), m => Number(m[1]));
  requests.push({ body, numbers });
  if (mode === 'http401') { res.writeHead(401); res.end('must-not-surface'); return; }
  if (mode === 'cancel' && numbers.length <= 3 && numbers[0] >= 81) await new Promise(resolve => held.push(resolve));
  const truncated = mode !== 'plain' && (mode === 'single' || numbers.length > (mode === 'silent' ? 2 : 3));
  const content = mode === 'plain' ? '原文已识别，但没有输出题库 JSON' : truncated ? '{"name":"截断题库","questions":[' : JSON.stringify({ name: '101题回归题库', questions: numbers.map(n => questions[n - 1]), reviewItems: [] });
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: truncated && mode !== 'silent' ? 'length' : 'stop' }], usage: { total_tokens: 42 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-truncation-${Date.now()}`); await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')); manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context; const checks = [], failures = [], errors = [];
async function test(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push(`${name}: ${error.message}`); } }
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-truncation-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
  const source = await context.newPage(); await source.goto(`${origin}/quiz`);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const tab = await panel.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/quiz` }))[0], origin);
  const state = () => panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  async function seed(kind, missingAnswer = false, completedCount = 77, repairMode = false) {
    await panel.goto('about:blank'); await panel.waitForTimeout(350); release(); mode = kind; requests.length = 0;
    if (kind === 'partial') await source.reload();
    await worker.evaluate(async ({ origin, questions, missingAnswer, completedCount, repairMode, tabId, partial }) => {
      const snapshots = questions.slice(0,partial?50:101).map((q, i) => ({ number: i + 1, identity: `number_${i + 1}`, question: missingAnswer && i === 100 ? { ...q, answers: [] } : q }));
      const bank = { name: '101题回归题库', questions: questions.slice(0, completedCount).map((q, i) => ({ ...q, _sourceOrder: i })), reviewItems: repairMode ? questions.slice(completedCount).map(q=>({sourceNumber:String(q.numberInPaper),rawText:q.stem,reason:'等待 AI 核对'})) : [] };
      if (completedCount) bank.questions[0].stem = '人工修改的第1题必须保留';
      const source = { title: bank.name, url: `${origin}/quiz`, text: '', mode: 'bank' };
      const doc = { id: 'same-document', sessionId: 'seed-session', name: bank.name, bank, source, excluded: [], resolvedReviews: [], assets: [], requestedCount: 101, strictCount: true, formatComplete: repairMode, coverage: { complete: !partial, captured: snapshots.length, expected: 101 }, partialAccepted: false };
      const task = { id: 'same-task', tabId, documentId: doc.id, title: bank.name, url: source.url, origin, topOrigin: origin, expected: 101, requestedCount: 101, complete: !partial, snapshots, stage: repairMode ? 'review' : 'failed', status: repairMode ? 'finished' : 'paused', label: '模型输出被截断' };
      const generation = { kind: 'export', documentId: doc.id, chunks: [Array.from({ length: snapshots.length - completedCount }, (_, i) => i + completedCount)], next: repairMode ? 1 : 0, snapshotCount: snapshots.length, totalTokens: 0, hasUsage: true };
      await chrome.storage.local.set({ workspaceV1: { version: 1, sessionId: 'seed-session', sessions: [], source, bank, excluded: [], resolvedReviews: [], documents: [doc], activeDocumentId: doc.id, exportTask: task, generation, pendingExport: null, activeView: 'document', messages: [{ role: 'assistant', content: '上一份题库的聊天 SENTINEL_OLD_HISTORY' }], jsonDraft: '' }, profilesV1: { activeId: 'fixture-model', items: [{ id: 'fixture-model', name: '测试配置', baseUrl: `${origin}/v1`, model: 'fixture', remember: false }] } });
      await chrome.storage.session.set({ secretsV1: { 'fixture-model': 'fixture-only-key' } });
    }, { origin, questions, missingAnswer, completedCount, repairMode, tabId: tab.id, partial:kind==='partial' });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.locator(repairMode ? '#ai-reviews' : '#resume-generation').click();
  }
  async function finish() { await panel.locator('#task-status').waitFor({ state: 'hidden' }); await panel.locator('#save-status').filter({ hasText: '草稿已保存在本机' }).waitFor(); }
  function verifyFull(saved, completedCount = 77) {
    assert.equal(saved.documents.length, 1); assert.equal(saved.activeDocumentId, 'same-document');
    assert.equal(saved.bank.questions.length, 101); assert.equal(saved.bank.reviewItems.length, 0);
    assert.equal(saved.bank.questions[0].stem, completedCount ? '人工修改的第1题必须保留' : questions[0].stem);
    assert.deepEqual(saved.bank.questions.map(q => q._sourceOrder), Array.from({ length: 101 }, (_, i) => i));
    assert.equal(saved.exportTask.stage, 'ready');
    assert.ok(requests.every(({ body, numbers }) => body.messages.length === 2 && !JSON.stringify(body).includes('SENTINEL_OLD_HISTORY') && numbers.every(n => n > completedCount)));
    assert.ok(saved.messages.at(-1).content.includes('新对话'));
  }
  await test('collect 101 through 50+50+1 checkpoints without raising capacity', async () => {
    const result = await panel.evaluate(async tab => {
      const { collectWholeBank } = await import('./lib/bank-collector.js'); const checkpoints = [];
      const task = await collectWholeBank({ tab, expectedCount: 101, onProgress: p => checkpoints.push(p.snapshots.length) });
      return { count: task.snapshots.length, complete: task.complete, sectionSize: task.sectionSize, sections: task.collectionSectionsCompleted, checkpoints };
    }, tab);
    assert.equal(result.count, 101); assert.ok(result.complete); assert.equal(result.sectionSize, 50); assert.equal(result.sections, 3);
    for (const n of [50, 100, 101]) assert.ok(result.checkpoints.includes(n));
  });
  await test('stop at a 50-question collection checkpoint saves that section and makes no model calls', async () => {
    const result = await panel.evaluate(async tab => {
      const { collectWholeBank } = await import('./lib/bank-collector.js'); const controller = new AbortController();
      const task = await collectWholeBank({ tab, expectedCount: 101, signal: controller.signal, onProgress: p => { if (p.snapshots.length === 50) controller.abort(); } });
      return { count: task.snapshots.length, complete: task.complete, sections: task.collectionSectionsCompleted };
    }, tab);
    assert.equal(result.count, 50); assert.equal(result.complete, false); assert.equal(result.sections, 1); assert.equal(requests.length, 0);
  });
  await test('partial 50 of 101 queues AI until the remaining collection completes in the same document', async () => {
    await seed('partial', false, 40); await finish(); const partial = await state();
    assert.equal(requests.length, 0); assert.equal(partial.exportTask.snapshots.length, 50);
    assert.equal(partial.bank.questions.length, 40); assert.equal(partial.generation.next, 0); assert.equal(partial.exportTask.stage, 'partial');
    mode = 'adaptive'; await source.reload();
    await panel.locator('#resume-export').click(); await finish(); verifyFull(await state(), 40);
  });
  await test('non-JSON formatter pauses without losing 77 completed questions; OCR routing migration resumes only pending sources',async()=>{
    await seed('plain');await finish();const paused=await state();assert.equal(paused.bank.questions.length,77);assert.equal(paused.generation.next,0);assert.equal(paused.exportTask.status,'paused');assert.match(paused.messages.at(-1).content,/整理模型/);
    await panel.goto('about:blank');await worker.evaluate(async origin=>{const p=(await chrome.storage.local.get('profilesV1')).profilesV1;p.items.push({id:'ocr-only',model:'qwen3.5-ocr',vision:true,name:'OCR',baseUrl:`${origin}/v1`});p.activeId='ocr-only';await chrome.storage.local.set({profilesV1:p});await chrome.storage.session.set({secretsV1:{'fixture-model':'fixture-only-key','ocr-only':'ocr-fixture-key'}});},origin);
    mode='adaptive';await panel.goto(`chrome-extension://${id}/sidepanel.html`);await panel.waitForFunction(()=>document.querySelector('#active-profile').value==='fixture-model');await panel.locator('#resume-export').click();await finish();verifyFull(await state());assert.ok(requests.every(r=>r.body.model==='fixture'));assert.ok(!(await state()).exportTask.reason);
  });
  await test('legacy 77 of 101 splits truncated pending batch and preserves completed edits', async () => {
    await seed('adaptive'); await finish(); const saved = await state(); verifyFull(saved);
    assert.ok(requests.length > 1); assert.equal(saved.generation.totalTokens, requests.length * 42);
    const download = panel.waitForEvent('download'); await panel.locator('.document-download').click();
    await (await download).saveAs(path.join(artifacts, 'complete-101-v3.3.json'));
  });
  await test('incomplete JSON with stop reason also splits rather than restarting the whole bank', async () => {
    await seed('silent'); await finish(); verifyFull(await state());
  });
  await test('AI review also recovers truncation in the same document after collection completes', async () => {
    await seed('adaptive', false, 77, true); await finish(); verifyFull(await state());
  });
  await test('101 pending AI questions keep 50+50+1 section boundaries with smaller calls', async () => {
    await seed('adaptive', false, 0); await finish(); verifyFull(await state(), 0);
    assert.ok(requests.every(({numbers}) => numbers.length <= 6 && Math.floor((numbers[0]-1)/50) === Math.floor((numbers.at(-1)-1)/50)));
  });
  await test('single-question truncation falls back only to valid originals and retains missing answer', async () => {
    await seed('single', true); await finish(); const saved = await state();
    assert.equal(saved.bank.questions.length, 100); assert.equal(saved.bank.reviewItems.length, 1);
    assert.equal(saved.bank.reviewItems[0].sourceNumber, '101'); assert.match(saved.bank.reviewItems[0].reason, /截断/);
    assert.equal(saved.exportTask.stage, 'review'); assert.ok(await panel.locator('.document-download').isDisabled());
    assert.ok(requests.length <= 48);
  });
  await test('401 pauses without automatic retry or loss of the 77 completed questions', async () => {
    await seed('http401'); await finish(); const saved = await state();
    assert.equal(requests.length, 1); assert.equal(saved.bank.questions.length, 77); assert.equal(saved.exportTask.stage, 'failed');
  });
  await test('cancelled split persists children and resumes without repeating completed model questions', async () => {
    await seed('cancel');
    for (let i = 0; i < 200 && !held.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(held.length);
    await panel.locator('#cancel-task').click(); await finish();
    const stopped = await state(); assert.equal(stopped.bank.questions.length, 80); assert.equal(stopped.generation.next, 1);
    const count = requests.length; mode = 'adaptive'; release();
    await panel.reload(); await panel.waitForTimeout(200); assert.equal(requests.length, count);
    await panel.locator('#resume-export').click(); await finish(); verifyFull(await state());
    assert.ok(requests.slice(count).every(({ numbers }) => numbers.every(n => n >= 81)));
  });
  assert.deepEqual(errors, []);
} finally { release(); await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
await writeFile(path.join(artifacts, 'truncation-report.json'), JSON.stringify({ version: manifest.version, passed: !failures.length, checks, failures }, null, 2));
if (failures.length) throw new Error(failures.join('\n'));
console.log(JSON.stringify({ passed: true, checks }));
