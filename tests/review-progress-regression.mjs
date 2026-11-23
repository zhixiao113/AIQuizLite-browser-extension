import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateQuestion } from '../extension/lib/schema.js';
import { parseSnapshot } from '../extension/lib/snapshot-parser.js';
import { matchingSources } from './matching-fixtures.mjs';

// Exercise real repair/persistence/model/download code. Only webpage reading is
// replaced with a deterministic fixture; these are not the user's unknown 4 items.
const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const valid = Array.from({ length: 96 }, (_, i) => ({ id: `original_${i + 1}`, numberInPaper: i + 1, type: 'single', stem: `第${i + 1}题请选择正确配置。`, options: [{ key: 'A', text: '方案甲' }, { key: 'B', text: '方案乙' }], answers: ['B'], explanation: null, image: null, explanationImages: [] }));
const rawItems = [
  { number: 97, identity: 'number_97', rawText: '97. (单选题)请选择正确配置\nA. alpha B. beta\n正确答案：B' },
  { number: 98, identity: 'number_98', rawText: '在____中保存\n正确答案：A' },
  { number: 99, identity: 'number_99', rawText: '99. (判断题)地球是圆的\nA. 对\nB. 错\n正确答案：对' },
  { number: 100, identity: 'number_100', rawText: '100. (连线题)配对\n左侧\n1. cat\n右侧\nA. 猫\n正确答案：1→A' }
];
const models = [
  { id: 'model_97', numberInPaper: 97, type: 'single', stem: '请选择正确配置', options: [{ key: 'A', text: 'alpha' }, { key: 'B', text: 'beta' }], answers: ['B'], explanation: null, image: null, explanationImages: [] },
  { id: 'model_98', numberInPaper: 98, type: 'fill_blank', stem: '在____中保存', options: [], answers: ['A'], explanation: null, image: null, explanationImages: [] },
  { id: 'model_99', numberInPaper: 99, type: 'judge', stem: '地球是圆的', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answers: ['A'], explanation: null, image: null, explanationImages: [] },
  { id: 'model_100', numberInPaper: 100, type: 'matching', stem: '配对', options: [], answers: [], explanation: null, image: null, explanationImages: [], matching: { mode: 'one_to_one', leftItems: [{ id: '1', text: 'cat' }], rightItems: [{ id: 'A', text: '猫' }], correctPairs: [{ leftId: '1', rightId: 'A' }] } }
];
let mode = 'correct'; const requests = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><title>AI 核对回归题库</title><p>共100题</p>'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const numbers = Array.from(body.messages.at(-1).content.matchAll(/\[原题号:(\d+)\]/g), m => Number(m[1]));
  requests.push({ body, numbers });
  const matchingMode = mode.startsWith('matching');
  const questions = matchingMode && mode !== 'matching-output' ? [] : numbers.map(n => {
    const q = matchingMode ? parseSnapshot(matchingSources.find(source => source.number === n), `model_${n}`, 'DataCom') : structuredClone(models[n - 97]);
    if (matchingMode) {
      q.numberInPaper = n; q.stem = `AI改写：${q.stem}`;
      q.matching.leftItems.forEach(item => item.id = `L${item.id}`);
      q.matching.rightItems.forEach(item => item.id = `R${item.id}`);
      q.matching.correctPairs.forEach(pair => { pair.leftId = `L${pair.leftId}`; pair.rightId = `R${pair.rightId}`; });
    }
    if (mode === 'prefix' && n === 98) q.numberInPaper = '第98题';
    if (mode === 'mismatch' && n === 97) q.numberInPaper = 5000;
    if (mode === 'wrong-answer' && n === 97) q.answers = ['A'];
    return q;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  res.setHeader('Content-Type', 'application/json');
  const reviewItems = matchingMode && mode !== 'matching-output' ? numbers.map(n => ({ sourceNumber: String(n), rawText: '', reason: mode === 'matching-missing' && n === 100 ? '原文缺少标准答案' : '原文 DD Sea 或 OPSF 疑似不完整，请核对。' })) : [];
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: 'AI 核对回归题库', questions, reviewItems }) }, finish_reason: 'stop' }], usage: { total_tokens: 42 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-review-progress-${Date.now()}`); await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')); manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context; const checks = [], failures = [], errors = [], observations = [];
async function test(name, run) { console.log(`START ${name}`); try { await run(); checks.push(name); console.log(`PASS ${name}`); } catch (error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); } }
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-review-progress-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
  const source = await context.newPage(); await source.goto(`${origin}/quiz`);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const tab = await panel.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/quiz` }))[0], origin);
  await panel.addInitScript(({ origin }) => {
    if (!chrome.scripting?.executeScript) return;
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async config => {
      if (config.func?.name !== 'readQuizPage') return execute(config);
      const { workspaceV1: workspace } = await chrome.storage.local.get('workspaceV1');
      return [{ frameId: 0, result: { url: `${origin}/quiz`, frameUrl: `${origin}/quiz`, title: 'AI 核对回归题库', expected: workspace.exportTask.expected, currentNumber: 1, structured: workspace.exportTask.snapshots, navigation: [], screen: null, nextAvailable: false } }];
    };
  }, { origin });
  const state = () => panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  async function seed(kind = 'correct', overlap = false, reviewPrefix = false) {
    const matchingMode = kind.startsWith('matching');
    const imageAsset = matchingMode ? await panel.evaluate(async () => {
      const { resolveMedia } = await import('./lib/media.js');
      const canvas = new OffscreenCanvas(180, 90), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 180, 90); ctx.fillStyle = '#2563eb'; ctx.fillRect(15, 15, 50, 30); ctx.fillRect(110, 45, 50, 30);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const encoded = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      return (await resolveMedia({ mediaSources: [{ url: `data:image/png;base64,${encoded}`, role: 'question' }] })).mediaAssets[0];
    }) : null;
    await panel.goto('about:blank'); await panel.waitForTimeout(350); mode = kind; requests.length = 0;
    await worker.evaluate(async ({ origin, valid, rawItems, tabId, overlap, missing, reviewPrefix, matchingMode, matchingSources, imageAsset, missingMatching }) => {
      const expected = matchingMode ? 101 : 100;
      const snapshots = matchingMode ? Array.from({length:101},(_,i) => ({ number: i + 1, identity: `number_${i + 1}`, question: {...valid[0],id:`original_${i+1}`,numberInPaper:i+1,stem:`第${i+1}题请选择正确配置。`} })) : [...valid.map((q, i) => ({ number: i + 1, identity: `number_${i + 1}`, question: q })), ...rawItems];
      if (matchingMode) {
        for (const source of matchingSources) snapshots[source.number-1] = {...source};
        Object.assign(snapshots[99], {imageDependent:true,mediaAssets:[imageAsset]});
        if (missingMatching) snapshots[99].rawText = snapshots[99].rawText.replace('[ 2-1,3-2,4-3 ];','');
      }
      if (missing) snapshots[96].rawText = snapshots[96].rawText.replace('\n正确答案：B', '');
      const pending = snapshots.map((s,i)=>s.rawText ? i : null).filter(i=>i!==null);
      const bank = { name: 'AI 核对回归题库', questions: matchingMode ? snapshots.filter(s=>s.question).map(s=>({...s.question,_sourceOrder:s.number-1})) : valid.map((q, i) => ({ ...q, _sourceOrder: i })), reviewItems: (matchingMode ? snapshots.filter(s=>s.rawText) : snapshots.slice(96)).map(s => ({ sourceNumber: reviewPrefix && s.number === 98 ? '第98题' : String(s.number), rawText: s.rawText, reason: '等待 AI 修正格式，原题信息已经保存。' })) };
      bank.questions[0].stem = '人工修改的第1题必须保留';
      const source = { title: bank.name, url: `${origin}/quiz`, text: '', mode: 'bank' };
      const doc = { id: 'same-document', sessionId: 'seed-session', name: bank.name, bank, source, excluded: [], resolvedReviews: [], assets: imageAsset ? [imageAsset] : [], requestedCount: expected, strictCount: true, formatComplete: true, coverage: { complete: true, captured: expected, expected }, partialAccepted: false };
      const task = { id: 'same-task', tabId, frameId: 0, documentId: doc.id, title: bank.name, url: source.url, origin, topOrigin: origin, expected, requestedCount: expected, complete: true, snapshots, stage: 'review', status: 'finished', label: '待核对回归' };
      const generation = { kind: 'export', documentId: doc.id, chunks: [matchingMode ? pending : [96, 97, 98, 99]], next: overlap ? 0 : 1, snapshotCount: expected, totalTokens: 0, hasUsage: true };
      await chrome.storage.local.set({ workspaceV1: { version: 1, sessionId: 'seed-session', sessions: [], source, bank, excluded: [], resolvedReviews: [], documents: [doc], activeDocumentId: doc.id, exportTask: task, generation, pendingExport: null, activeView: 'document', messages: [{ role: 'assistant', content: '上一份题库的聊天 SENTINEL_OLD_HISTORY' }], jsonDraft: '' }, profilesV1: { activeId: 'fixture-model', items: [{ id: 'fixture-model', name: '测试配置', baseUrl: `${origin}/v1`, model: 'fixture', remember: false }] } });
      await chrome.storage.session.set({ secretsV1: { 'fixture-model': 'fixture-only-key' } });
    }, { origin, valid, rawItems, tabId: tab.id, overlap, missing: kind === 'missing', reviewPrefix, matchingMode, matchingSources, imageAsset, missingMatching:kind==='matching-missing' });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.locator('#ai-reviews').waitFor({ state: 'visible' });
    await panel.waitForFunction(() => !document.querySelector('#view-document').hidden && !document.querySelector('#ai-reviews').disabled && document.querySelector('#active-profile').value === 'fixture-model');
  }
  async function repair(expectModel = true) {
    const before = requests.length;
    const messageCount = await panel.locator('#messages .message').count();
    if (!await panel.locator('#ai-reviews').isVisible()) await panel.locator('.document-open').click();
    await panel.locator('#ai-reviews').click();
    await panel.waitForFunction(count => document.querySelectorAll('#messages .message').length >= count + 2, messageCount);
    await panel.locator('#task-status').waitFor({ state: 'hidden', timeout: 30000 });
    await panel.locator('#save-status').filter({ hasText: '草稿已保存在本机' }).waitFor();
    if (expectModel) assert.ok(requests.length > before, 'uncertain repair must send the pending sources to the model');
    else assert.equal(requests.length,before,'complete original matching standards need no extra model call');
    return state();
  }
  function verifyFull(saved) {
    assert.equal(saved.documents.length, 1); assert.equal(saved.activeDocumentId, 'same-document');
    assert.equal(saved.bank.questions.length, 100); assert.equal(saved.bank.reviewItems.length, 0);
    assert.equal(saved.bank.questions[0].stem, '人工修改的第1题必须保留');
    assert.deepEqual(saved.bank.questions.map(q => q._sourceOrder), Array.from({ length: 100 }, (_, i) => i));
    assert.equal(new Set(saved.bank.questions.map(q => q.id)).size, 100);
    assert.equal(saved.exportTask.stage, 'ready');
    assert.deepEqual(saved.bank.questions.slice(96).map(q => q.type), ['single', 'fill_blank', 'judge', 'matching']);
    assert.deepEqual(saved.bank.questions[96].answers, ['B']);
    assert.deepEqual(saved.bank.questions[97].answers, ['A']);
    assert.deepEqual(saved.bank.questions[98].answers, ['A']);
    assert.deepEqual(saved.bank.questions[99].matching.correctPairs, [{ leftId: '1', rightId: 'A' }]);
    assert.ok(saved.bank.questions.every(q => validateQuestion(q, { allowImages: true }).length === 0));
    assert.ok(requests.every(({ body, numbers }) => body.messages.length === 2 && !JSON.stringify(body).includes('SENTINEL_OLD_HISTORY') && numbers.every(n => n >= 97)));
  }
  await test('96 of 100 completes inline options, inferred fill, judge aliases and arrow matching without replacing 96 edits', async () => {
    await seed(); const saved = await repair();
    observations.push({ case: 'four-fixtures', count: saved.bank.questions.length, remaining: saved.bank.reviewItems.map(r => ({ number: r.sourceNumber, reason: r.reason })), requests: requests.length });
    verifyFull(saved);
    assert.equal(saved.documents[0].lastReviewRun.added, 4); assert.equal(saved.documents[0].lastReviewRun.remaining, 0); assert.equal(saved.documents[0].lastReviewRun.noProgress, false);
    await panel.screenshot({ path: path.join(artifacts, 'review-progress-complete-390.png'), fullPage: true });
    const download = panel.waitForEvent('download'); await panel.locator('.document-download').click();
    const downloaded = path.join(artifacts, 'complete-100-review-progress.json'); await (await download).saveAs(downloaded);
    const output = JSON.parse(await readFile(downloaded, 'utf8'));
    assert.equal(output.questions.length, 100); assert.deepEqual(output.questions.map(q => q.numberInPaper), Array.from({ length: 100 }, (_, i) => i + 1));
    assert.equal(output.questions[0].stem, '人工修改的第1题必须保留'); assert.ok(output.questions.every(q => !Object.hasOwn(q, '_sourceOrder') && validateQuestion(q).length === 0));
  });
  await test('repair overlapping an unfinished checkpoint sends each source once and cannot duplicate completed questions', async () => {
    await seed('correct', true); const saved = await repair();
    observations.push({ case: 'overlap', count: saved.bank.questions.length, sent: requests.flatMap(r => r.numbers) });
    verifyFull(saved); assert.deepEqual(requests.flatMap(r => r.numbers), [97, 98, 99]);
  });
  await test('missing source standard answer remains pending and a repeat reports no progress with bounded feedback', async () => {
    await seed('missing'); let saved = await repair();
    assert.equal(saved.bank.questions.length, 99); assert.equal(saved.bank.reviewItems.length, 1);
    assert.equal(saved.bank.reviewItems[0].sourceNumber, '97'); assert.match(saved.bank.reviewItems[0].reason, /标准答案/);
    assert.equal(saved.bank.reviewItems[0].code, 'missing_source_answer'); assert.ok(await panel.locator('#download-bank').isDisabled());
    const firstReason = saved.bank.reviewItems[0].reason; const before = requests.length; saved = await repair();
    assert.equal(saved.bank.questions.length, 99); assert.equal(saved.bank.reviewItems.length, 1);
    assert.equal(saved.documents[0].lastReviewRun.added, 0); assert.equal(saved.documents[0].lastReviewRun.remaining, 1); assert.equal(saved.documents[0].lastReviewRun.noProgress, true);
    const retry = requests.slice(before); assert.deepEqual(retry.flatMap(r => r.numbers), [97]);
    assert.ok(retry[0].body.messages.at(-1).content.includes(firstReason));
    assert.ok(!JSON.stringify(retry).includes('SENTINEL_OLD_HISTORY'));
    assert.match(saved.messages.at(-1).content, /新增.*0|补齐.*0|未新增/);
    assert.ok(await panel.locator('#download-bank').isDisabled());
    await panel.locator('.document-open').click();
    await panel.screenshot({ path: path.join(artifacts, 'review-progress-no-progress-390.png'), fullPage: true });
    const download = panel.waitForEvent('download'); await panel.locator('#download-review-diagnostics').click();
    const diagnosticFile = path.join(artifacts, 'review-progress-missing-answer-diagnostic.json'); await (await download).saveAs(diagnosticFile);
    const diagnosticText = await readFile(diagnosticFile, 'utf8'); const diagnostic = JSON.parse(diagnosticText);
    assert.equal(diagnostic.valid, 99); assert.equal(diagnostic.expected, 100);
    assert.equal(diagnostic.unresolved.length, 1); assert.equal(diagnostic.unresolved[0].number, 97);
    assert.equal(diagnostic.unresolved[0].code, 'missing_source_answer'); assert.equal(diagnostic.unresolved[0].hasStandardAnswer, false);
    assert.deepEqual(diagnostic.lastReview, { added: 0, remaining: 1, noProgress: true });
    assert.ok(!/fixture-only-key|SENTINEL_OLD_HISTORY|alpha|beta|rawText|stem|messages|baseUrl/.test(diagnosticText));
  });
  await test('model numberInPaper with explicit 第98题 prefix still maps to its original source', async () => {
    await seed('prefix'); verifyFull(await repair());
  });
  await test('a pending sourceNumber with 第98题 prefix is refreshed and repaired without losing that source', async () => {
    await seed('correct', false, true); verifyFull(await repair()); assert.deepEqual(requests.flatMap(r => r.numbers), [97, 98, 99]);
  });
  await test('explicit original standard answer takes precedence over model-guessed choice', async () => {
    await seed('wrong-answer'); const saved = await repair(); verifyFull(saved); assert.deepEqual(saved.bank.questions[96].answers, ['B']);
  });
  await test('mismatched model source numbers recover only trusted originals and retain assignment feedback for the other sources', async () => {
    await seed('mismatch'); let saved = await repair();
    assert.equal(saved.bank.questions.length, 98);
    assert.deepEqual(saved.bank.reviewItems.map(r => r.sourceNumber), ['97', '98']);
    assert.ok(saved.bank.reviewItems.every(r => r.code === 'source_assignment'));
    assert.equal(saved.documents[0].lastReviewRun.added, 2); assert.equal(saved.documents[0].lastReviewRun.remaining,2);
    const reasons = saved.bank.reviewItems.map(r => r.reason); const before = requests.length;
    saved = await repair(); assert.equal(saved.bank.questions.length,98); assert.equal(saved.bank.reviewItems.length,2);
    assert.equal(saved.documents[0].lastReviewRun.added, 0); assert.equal(saved.documents[0].lastReviewRun.noProgress, true);
    const retry = requests.slice(before); assert.deepEqual(retry.flatMap(r => r.numbers), [97,98]);
    assert.ok(reasons.every(reason => retry[0].body.messages.at(-1).content.includes(reason)));
    assert.ok(await panel.locator('.document-download').isDisabled());
  });
  await test('95 of 101 recovers six numeric matching sources and original images without new paid requests', async () => {
    const kind='matching-review'; await seed(kind); const saved = await repair(false);
    observations.push({case:kind,count:saved.bank.questions.length,remaining:saved.bank.reviewItems.length});
    assert.equal(saved.bank.questions.length,101); assert.equal(saved.bank.reviewItems.length,0); assert.equal(saved.documents.length,1);
    assert.equal(saved.bank.questions[0].stem,'人工修改的第1题必须保留');
    assert.deepEqual(saved.bank.questions.map(q=>q._sourceOrder),Array.from({length:101},(_,i)=>i));
    assert.equal(saved.documents[0].lastReviewRun.added,6); assert.equal(saved.exportTask.stage,'ready');
    for(const source of matchingSources) {
      const q=saved.bank.questions[source.number-1]; assert.equal(q.type,'matching'); assert.deepEqual(validateQuestion(q,{allowImages:true}),[]);
      if(source.number===93) {assert.ok(q.stem.includes('OPSF'));assert.equal(q.matching.leftItems[2].text,'DD Sea');}
      assert.ok(!q.stem.startsWith('AI改写')); assert.ok(q.matching.leftItems.every(item=>!item.id.startsWith('L')));
    }
    assert.ok(saved.bank.questions[99].image); assert.equal(saved.documents[0].assets.length,1);
    const download=panel.waitForEvent('download'); await panel.locator('.document-download').click();
    await (await download).saveAs(path.join(artifacts,`complete-101-matching-${kind}.zip`));
  });
  await test('matching source with missing standard stays pending and cannot export a complete 101 bank',async()=>{
    await seed('matching-missing');const saved=await repair();assert.equal(saved.bank.questions.length,100);assert.equal(saved.bank.reviewItems.length,1);
    assert.equal(saved.bank.reviewItems[0].sourceNumber,'100');assert.match(saved.bank.reviewItems[0].reason,/标准答案/);
    assert.ok(await panel.locator('.document-download').isDisabled());
  });
  await test('closed source tab does not block cached review or continuing remaining items', async () => {
    await seed(); await source.close();
    const saved = await repair(); verifyFull(saved);
    await seed('missing'); await repair();
    let pending = await state(); assert.equal(pending.bank.questions.length, 99);
    assert.ok(pending.documents[0].normalReviewAttempted);
    await panel.locator('.document-open').click(); assert.ok(await panel.locator('#deep-reviews').isVisible());
    await panel.locator('[data-view="chat"]').click();
    await panel.locator('#chat-input').fill('继续导出这份题库'); await panel.locator('#send-chat').click();
    await panel.locator('#task-status').waitFor({state:'hidden'});
    await panel.locator('#save-status').filter({hasText:'草稿已保存在本机'}).waitFor();
    pending = await state(); assert.equal(pending.bank.questions.length,99);
    assert.ok(!pending.messages.some(m=>m.content.includes('No tab with id')));
    assert.equal(pending.exportTask.operation,'review');
  });
  await test('missing image and closed tab keep only that source pending while cached text still repairs',async()=>{
    await seed();await panel.goto('about:blank');
    await worker.evaluate(async()=>{const w=(await chrome.storage.local.get('workspaceV1')).workspaceV1;w.exportTask.snapshots[96].imageDependent=true;w.exportTask.snapshots[96].mediaError='原题图片尚未取得';await chrome.storage.local.set({workspaceV1:w});});
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);await panel.locator('#ai-reviews').waitFor();
    const saved=await repair();assert.equal(saved.bank.questions.length,99);assert.equal(saved.bank.reviewItems.length,1);
    assert.equal(saved.bank.reviewItems[0].sourceNumber,'97');assert.equal(saved.bank.reviewItems[0].code,'missing_media');
    assert.equal(saved.bank.questions[0].stem,'人工修改的第1题必须保留');assert.ok(saved.exportTask.complete);
    assert.ok(!saved.messages.some(m=>m.content.includes('No tab with id')));
  });
  await test('panel reports no browser JavaScript errors', async () => { assert.deepEqual(errors, []); });
} finally { await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
const report = { version: manifest.version, passed: !failures.length, checks, failures, observations };
await writeFile(path.join(artifacts, `review-progress-report-${manifest.version}.json`), JSON.stringify(report, null, 2));
await writeFile(path.join(artifacts, 'review-progress-report.json'), JSON.stringify(report, null, 2));
if (failures.length) throw new Error(failures.join('\n'));
console.log(JSON.stringify({ passed: true, checks }));
