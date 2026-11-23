import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixtureBank } from './fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const items = Array.from({ length: 6 }, (_, i) => ({ id: `new_${i + 1}`, numberInPaper: i + 1, type: 'single', stem: `新题库第${i + 1}题。`, options: [{ key: 'A', text: '方案甲' }, { key: 'B', text: '方案乙' }], answers: i === 5 ? [] : ['B'], explanation: null, image: null, explanationImages: [] }));
let holdModel = true; const held = [];
const release = () => { holdModel = false; held.splice(0).forEach(resolve => resolve()); };
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (holdModel) await new Promise(resolve => held.push(resolve));
    const numbers = Array.from(body.messages.at(-1).content.matchAll(/\[原题号:(\d+)\]/g), m => Number(m[1]));
    const content = JSON.stringify({ name: '新题库', questions: numbers.filter(n => n < 6).map(n => items[n - 1]), reviewItems: numbers.filter(n => n === 6).map(n => ({ sourceNumber: String(n), rawText: '没有标准答案', reason: '原文缺少标准答案' })) });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 42 } })); return;
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><title>新题库</title><h1 data-bank-title>新题库</h1><p>共6题</p><script>window.paperData=${JSON.stringify({ questions: items }).replace(/</g, '\\u003c')}</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = path.join(artifacts, `extension-chat-task-${Date.now()}`);
await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
let context; const checks = [], failures = [], errors = [];
async function test(name, run) {
  try { await run(); checks.push(name); } catch (error) { failures.push(`${name}: ${error.message}`); }
}
async function waitForModel() {
  for (let i = 0; i < 200; i++) { if (held.length) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Model did not reach the controlled request gate');
}
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-chat-task-${Date.now()}`), { channel: 'chromium', headless: true, viewport: { width: 390, height: 920 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async ({ origin, question }) => {
    const bank = { name: '已完成的旧题库', questions: [{ ...question, _sourceOrder: 0 }], reviewItems: [] };
    const source = { title: bank.name, url: `${origin}/old`, text: '', mode: 'bank' };
    const doc = { id: 'finished-old', sessionId: 'seed-session', name: bank.name, bank, source, excluded: [], resolvedReviews: [], assets: [], requestedCount: 1, strictCount: true, formatComplete: true, coverage: { complete: true, captured: 1, expected: 1 }, partialAccepted: false };
    const task = { id: 'old-task', documentId: doc.id, expected: 1, requestedCount: 1, complete: true, snapshots: [{ number: 1, identity: 'number_1', question }], stage: 'ready', status: 'finished' };
    await chrome.storage.local.set({ workspaceV1: { version: 1, sessionId: 'seed-session', sessions: [], source, bank, excluded: [], resolvedReviews: [], documents: [doc], activeDocumentId: doc.id, exportTask: task, generation: null, pendingExport: null, activeView: 'chat', messages: [{ role: 'user', content: '把题库导出来，共1题' }], jsonDraft: '' }, profilesV1: { activeId: 'fixture-model', items: [{ id: 'fixture-model', name: '测试配置', baseUrl: `${origin}/v1`, model: 'fixture', remember: false }] } });
    await chrome.storage.session.set({ secretsV1: { 'fixture-model': 'fixture-only-key' } });
  }, { origin, question: fixtureBank.questions[0] });
  const panel = await context.newPage(); panel.on('dialog', dialog => dialog.accept()); panel.on('pageerror', error => errors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator('#export-progress').waitFor();
  const olderFixture = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
  await test('confirmed clear removes document and task together and stays empty after reload', async () => {
    await panel.locator('#clear-chat').click();
    await panel.locator('#notice').filter({hasText:'已清空本地对话和题库草稿'}).waitFor();
    assert.equal(await panel.locator('#export-progress').isVisible(), false);
    await panel.locator('#save-status').filter({ hasText: '草稿已保存在本机' }).waitFor();
    await panel.reload();
    assert.equal(await panel.locator('#export-progress').isVisible(), false);
    assert.equal(await panel.locator('.document-card').count(), 0);
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(state.exportTask, null); assert.equal(state.documents.length,0);
  });
  await panel.goto('about:blank');await panel.waitForTimeout(350);
  await worker.evaluate(async workspace=>chrome.storage.local.set({workspaceV1:workspace}),olderFixture);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);await panel.locator('.document-card').waitFor();
  const source = await context.newPage(); await source.goto(`${origin}/new`); await source.bringToFront();
  await panel.evaluate(async origin => { const tab = (await chrome.tabs.query({ url: `${origin}/new` }))[0]; await chrome.storage.session.set({ lastWebTabV2: { id: tab.id, windowId: tab.windowId } }); }, origin);
  await panel.locator('#chat-bank').click(); await panel.locator('#expected-total').fill('6');
  await panel.locator('#export-setup-form').getByRole('button', { name: '开始导出' }).click();
  await waitForModel();
  await test('finished older bank downloads during new collection without altering either document', async () => {
    const oldCard = panel.locator('.document-card').filter({ hasText: '已完成的旧题库' });
    assert.ok(await oldCard.locator('.document-download').isEnabled());
    assert.ok(await panel.locator('#export-progress').isVisible());
    const before = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    const download = panel.waitForEvent('download'); await oldCard.locator('.document-download').click();
    const file = path.join(artifacts, 'older-bank-during-task.json'); await (await download).saveAs(file);
    const exported = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(exported.name, '已完成的旧题库'); assert.equal(exported.questions.length, 1); assert.equal(exported.questions[0].stem, fixtureBank.questions[0].stem);
    const after = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(after.exportTask.id, before.exportTask.id); assert.equal(after.exportTask.status, 'running');
    assert.equal(after.documents.length, 2); assert.ok(await panel.locator('.document-card').first().locator('.document-download').isDisabled());
  });
  release(); await panel.locator('#export-stage').filter({ hasText: '题库待核对' }).waitFor();
  holdModel = true;
  await panel.locator('.document-open').first().click(); await panel.locator('#ai-reviews').click();
  await waitForModel();
  await test('review action shows AI review progress without a fabricated resume user message', async () => {
    const messages = await panel.locator('.message-content').allTextContents();
    assert.ok(messages.some(text => text.includes('AI 核对中')));
    assert.ok(!messages.includes('继续导出这份题库'));
    assert.equal(await panel.locator('.message.user .message-label').count(), 0);
    assert.equal(await panel.locator('#export-stage').textContent(), 'AI 核对中');
    assert.match(await panel.locator('#task-label').textContent(), /AI 核对中/);
    await panel.screenshot({ path: path.join(artifacts, 'ai-review-progress-v3.2.png'), fullPage: true });
  });
  release(); await panel.locator('#task-status').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
} finally { release(); await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
await writeFile(path.join(artifacts, 'chat-task-report.json'), JSON.stringify({ version: manifest.version, passed: !failures.length, checks, failures }, null, 2));
if (failures.length) throw new Error(failures.join('\n'));
console.log(JSON.stringify({ passed: true, checks }));
