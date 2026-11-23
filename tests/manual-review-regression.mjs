import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { asPathRaw } from './as-path-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const requests = [], errors = [], checks = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json');
  // Even an overcautious model must not defeat complete, validated source data.
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [], reviewItems: [{ sourceNumber: '16', rawText: '', reason: 'D 与 E 边界不清晰' }] }) } }], usage: { total_tokens: 10 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-manual-review-${Date.now()}`);
await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*'); await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context;
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-manual-review-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
  const url = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
  const state = () => panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  async function seed() {
    await panel.goto('about:blank');
    await worker.evaluate(async ({ rawText, origin }) => {
      const questions = Array.from({ length: 152 }, (_, i) => ({ id: `q${i + 1}`, _sourceOrder: i, type: 'single', stem: `已有题目 ${i + 1}`, paper: 'DataCom', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answers: ['A'], explanation: null, image: null, explanationImages: [] }));
      const snapshots = questions.map((question, i) => i === 15 ? { number: 16, rawText } : { number: i + 1, question }); questions.splice(15, 1);
      const bank = { name: 'DataCom', questions, reviewItems: [{ sourceNumber: '16', rawText, reason: 'D 与 E 边界不清晰' }] };
      const source = { url: 'https://exam.zhiqiantong.cn/paper/toExamRecitePaper/423820', title: bank.name, text: '', mode: 'bank' };
      const doc = { id: 'manual-doc', sessionId: 'manual-session', name: bank.name, bank, source, excluded: [], resolvedReviews: [], requestedCount: 152, strictCount: true, formatComplete: true, assets: [], coverage: { complete: true, captured: 152, expected: 152 }, lastReviewRun: { added: 0, remaining: 1, summary: '旧核对未补齐' } };
      await chrome.storage.local.set({ workspaceV1: { version: 1, sessionId: 'manual-session', sessions: [], bank, source, excluded: [], resolvedReviews: [], documents: [doc], activeDocumentId: doc.id, activeView: 'document', messages: [], generation: null, exportTask: { id: 'manual-task', documentId: doc.id, title: bank.name, url: source.url, complete: true, expected: 152, requestedCount: 152, snapshots, stage: 'review', status: 'finished' } }, profilesV1: { items: [{ id: 'test', name: 'fixture', baseUrl: origin, model: 'fixture-model' }], activeId: 'test' } });
      await chrome.storage.session.set({ secretsV1: { test: 'fixture-key' } });
    }, { rawText: asPathRaw, origin });
    await panel.goto(url); await panel.locator('#ai-reviews').waitFor({ state: 'visible' });
  }
  async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }

  await seed();
  await check('manual editor hides IDs, detects position 16 and prefills source fields', async () => {
    await panel.getByRole('button', { name: '补录为题目', exact: true }).click();
    const form = panel.locator('.question-editor');
    assert.equal(await form.getByLabel('题目排序', { exact: true }).inputValue(), '16');
    assert.equal(await form.getByLabel(/题目 ID/).count(), 0);
    assert.equal(await form.getByLabel(/^选项/).inputValue().then(v => v.split('\n').length), 5);
    assert.equal(await form.getByLabel(/^原文标准答案/).inputValue(), 'A');
    await panel.locator('#review-items .review-item').screenshot({ path: path.join(artifacts, 'manual-review-editor-0.5.7.png') });
  });
  await check('invalid answers show a local error and keep the review unresolved', async () => {
    const form = panel.locator('.question-editor');
    await form.getByLabel(/^原文标准答案/).fill('H'); await form.getByRole('button', { name: '保存题目' }).click();
    await form.getByRole('alert').filter({ hasText: '答案引用了不存在的选项' }).waitFor();
    assert.equal((await state()).bank.questions.length, 151); assert.equal((await state()).resolvedReviews.length, 0);
  });
  await check('storage failure leaves the editor open and can be retried without adding duplicate questions', async () => {
    const form = panel.locator('.question-editor'); await form.getByLabel(/^原文标准答案/).fill('A');
    await panel.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      window.restoreStorage = () => { chrome.storage.local.set = original; };
      chrome.storage.local.set = async value => { if (value.workspaceV1) throw new Error('fixture storage failure'); return original(value); };
    });
    try {
      await form.getByRole('button', { name: '保存题目' }).click();
      await form.getByRole('alert').filter({ hasText: '草稿保存失败' }).waitFor();
      assert.equal((await state()).bank.questions.length, 151); assert.equal((await state()).resolvedReviews.length, 0);
    } finally { await panel.evaluate(() => window.restoreStorage()); }
  });
  await check('common option labels save at the chosen position and persist across reload and export', async () => {
    const form = panel.locator('.question-editor');
    const options = await form.getByLabel(/^选项/).inputValue();
    await form.getByLabel(/^选项/).fill(options.replace(/^([A-H])\|/gm, '$1、'));
    await form.getByLabel(/^原文标准答案/).fill('A'); await form.getByLabel('题目排序', { exact: true }).fill('5');
    await form.getByRole('button', { name: '保存题目' }).click(); await panel.locator('#notice').filter({ hasText: '放在第 5 题' }).waitFor();
    await panel.reload(); await panel.locator('#bank-summary').filter({ hasText: '152 道有效 · 0 项待核对' }).waitFor();
    const saved = await state(); assert.equal(saved.bank.questions[4]._sourceOrder, 15); assert.equal(saved.resolvedReviews.length, 1);
    assert.equal(await panel.locator('#download-bank').isEnabled(), true); assert.equal(await panel.locator('#review-result').isVisible(), false);
    const exported = await panel.evaluate(async () => {
      const { exportBank } = await import('./lib/schema.js'); const state = (await chrome.storage.local.get('workspaceV1')).workspaceV1;
      return JSON.parse(exportBank(state.bank, state.excluded, state.bank.reviewItems.length - state.resolvedReviews.length));
    });
    assert.equal(exported.questions.length, 152); assert.equal(exported.questions[4].index, 5); assert.deepEqual(exported.questions[4].answers, ['A']);
    assert.equal(exported.questions[4].options[3].text, 'ip as-path-filter 1 permit ^65001 E. ip as-path-filter 1 permit *65001*');
  });
  await check('editing an existing question moves it while retaining its internal ID and original source number', async () => {
    const before = (await state()).bank.questions[4];
    await panel.locator('.question').nth(4).getByRole('button', { name: '编辑题目' }).click();
    const form = panel.locator('.question-editor'); await form.getByLabel('题目排序', { exact: true }).fill('152');
    await form.getByRole('button', { name: '保存题目' }).click(); await panel.locator('#notice').filter({ hasText: '放在第 152 题' }).waitFor();
    const after = (await state()).bank.questions.at(-1); assert.equal(after.id, before.id); assert.equal(after._sourceOrder, 15);
    assert.equal(await panel.locator('#download-bank').isEnabled(), true);
  });
  await seed();
  await check('AI review recovers this exact 151/152 case even when the model flags ambiguous labels', async () => {
    await panel.locator('#ai-reviews').click();
    await panel.waitForFunction(() => document.querySelector('#task-status').hidden && !document.querySelector('#new-draft').disabled);
    const saved = await state(); assert.equal(saved.bank.questions.length, 152); assert.equal(saved.bank.reviewItems.length, 0);
    assert.equal(saved.bank.questions[15]._sourceOrder, 15); assert.equal(saved.documents[0].lastReviewRun.added, 1);
    assert.deepEqual(saved.bank.questions[15].answers, ['A']); assert.equal(requests.length, 1);
    await panel.locator('.document-open').first().click(); assert.equal(await panel.locator('#download-bank').isEnabled(), true);
  });
  await seed();
  await check('hidden IDs repair import collisions and editing preserves lowercase option keys', async () => {
    await panel.goto('about:blank');
    await worker.evaluate(async () => {
      const w = (await chrome.storage.local.get('workspaceV1')).workspaceV1;
      for (const bank of [w.bank, w.documents[0].bank]) {
        bank.questions[0].id = bank.questions[1].id;
        Object.assign(bank.questions[0], { options: [{ key: 'a', text: 'alpha\n65001|65002' }, { key: 'b', text: 'beta' }], answers: ['a'] });
      }
      await chrome.storage.local.set({ workspaceV1: w });
    });
    await panel.goto(url); await panel.locator('.question').first().getByRole('button', { name: '编辑题目' }).click();
    await panel.locator('.question-editor').getByRole('button', { name: '保存题目' }).click();
    await panel.locator('#notice').filter({ hasText: '放在第 1 题' }).waitFor();
    const saved = await state(); const first = saved.bank.questions[0];
    assert.notEqual(first.id, saved.bank.questions[1].id); assert.deepEqual(first.answers, ['a']);
    assert.deepEqual(first.options, [{ key: 'a', text: 'alpha\n65001|65002' }, { key: 'b', text: 'beta' }]);
  });
  await seed();
  await check('failed saving after switching documents never rolls the old bank into the current document', async () => {
    await panel.goto('about:blank');
    await worker.evaluate(async () => {
      const w = (await chrome.storage.local.get('workspaceV1')).workspaceV1;
      const other = structuredClone(w.documents[0]); other.id = 'other-doc'; other.name = other.bank.name = '另一份题库';
      other.bank.questions[0].stem = '另一份独立题干'; w.documents.push(other);
      await chrome.storage.local.set({ workspaceV1: w });
    });
    await panel.goto(url); await panel.locator('.question').first().getByRole('button', { name: '编辑题目' }).click();
    await panel.locator('.question-editor').getByLabel('题干', { exact: true }).fill('应失败的修改');
    await panel.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local); let held = false;
      window.restoreStorage = () => { chrome.storage.local.set = original; };
      chrome.storage.local.set = value => {
        if (value.workspaceV1 && !held) { held = true; return new Promise((resolve, reject) => { window.rejectSave = () => reject(new Error('fixture delayed failure')); }); }
        return original(value);
      };
    });
    try {
      await panel.locator('.question-editor').getByRole('button', { name: '保存题目' }).click();
      await panel.waitForFunction(() => Boolean(window.rejectSave));
      await panel.locator('#close-document').click(); await panel.locator('.document-open').filter({ hasText: '另一份题库' }).click();
      await panel.evaluate(() => window.rejectSave());
      await panel.locator('#notice').filter({ hasText: '草稿保存失败' }).waitFor();
      await panel.reload(); await panel.locator('#document-heading').filter({ hasText: '另一份题库' }).waitFor();
      assert.equal(await panel.locator('.question-stem').first().innerText(), '另一份独立题干');
    } finally { await panel.evaluate(() => window.restoreStorage?.()); }
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'manual-review-report.json'), JSON.stringify({ version: manifest.version, passed: true, checks, errors }, null, 2));
} finally { await context?.close(); await new Promise(resolve => server.close(resolve)); }
