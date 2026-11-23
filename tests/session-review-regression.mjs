import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const failures = [], checks = [];
async function test(name, run) {
  try { await run(); checks.push(name); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}
const extension = path.join(artifacts, `extension-session-${Date.now()}`);
await cp(path.join(root, 'dist'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const testedVersion = manifest.version;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-session-${Date.now()}`), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    const source = { title: '原题库', url: 'https://exam.zhiqiantong.cn/paper/toExamRecitePaper/423820', text: '', mode: 'whole' };
    const bank = { name: '原题库', questions: [], reviewItems: [{ sourceNumber: '4', rawText: '原题内容', reason: '题图域名 static.zhiqiantong.cn 未授权。' }] };
    const doc = { id: 'known-document', name: bank.name, source, bank, excluded: [], resolvedReviews: [], requestedCount: 100, strictCount: true, formatComplete: true, assets: [], coverage: { complete: true, expected: 100, captured: 100, reason: '' } };
    await chrome.storage.local.set({ workspaceV1: { version: 1, source, bank, excluded: [], resolvedReviews: [], messages: [], generation: null, activeView: 'chat', jsonDraft: '', documents: [doc], activeDocumentId: doc.id, pendingExport: null, exportTask: { id: 'known-task', documentId: doc.id, expected: 100, requestedCount: 100, snapshots: [], complete: true, stage: 'review', status: 'finished' } } });
  });
  let acceptCleanup = false;
  const panel = await context.newPage(); panel.on('dialog', dialog => acceptCleanup ? dialog.accept() : dialog.dismiss());
  await panel.addInitScript(() => {
    window.permissionRequests = [];
    chrome.permissions.request = async input => { window.permissionRequests.push(input); return false; };
  });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator('.document-open').first().click();
  await test('known total starts review repair without asking total again', async () => {
    await panel.locator('#ai-reviews').click();
    assert.equal(await panel.locator('#export-setup').isVisible(), false);
  });
  if (await panel.locator('#export-setup').isVisible()) await panel.locator('#cancel-export-setup').click();
  await panel.waitForTimeout(300);
  await test('repair requests only known image hosts and preserves the document on denial', async () => {
    await panel.locator('#notice').filter({ hasText: '题图读取未获授权' }).waitFor();
    assert.deepEqual(await panel.evaluate(() => window.permissionRequests), [{ origins: ['https://static.zhiqiantong.cn/*', 'https://image.zhiqiantong.cn/*'] }]);
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(state.documents.length, 1); assert.equal(state.bank.reviewItems.length, 1);
    assert.equal(state.exportTask.id, 'known-task');
  });
  await test('cancelling the download reminder preserves the old document and task', async () => {
    await panel.locator('#new-draft').click();
    assert.equal(await panel.locator('.document-card').count(), 1);
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(state.documents.length, 1);
    assert.equal(state.exportTask.id,'known-task');
  });
  await test('confirmed new conversation clears old sessions and task across reload; settings has independent options', async () => {
    acceptCleanup = true;
    await panel.locator('#new-draft').click();await panel.locator('#notice').filter({hasText:'已开始新对话'}).waitFor();
    await panel.reload();
    await panel.locator('[data-view="settings"]').click();
    await panel.locator('#settings-model').waitFor();assert.equal(await panel.locator('#saved-documents').count(),0);
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(state.activeDocumentId, '');assert.equal(state.exportTask,null);assert.equal(state.sessions.length,0);assert.equal(state.documents.length,0);
    assert.equal(await panel.locator('.document-card').count(),0);assert.ok(await panel.locator('#settings-download').isVisible());
  });
} finally { await context?.close(); }
// A stale runtime manifest is a separate Chrome context, matching the user's 0.2.2 footer.
manifest.version = '0.2.2';
manifest.host_permissions = manifest.host_permissions.filter(origin => !origin.includes('static.zhiqiantong.cn') && !origin.includes('image.zhiqiantong.cn'));
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
try {
  context = await chromium.launchPersistentContext(path.join(artifacts, `profile-stale-${Date.now()}`), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await test('stale runtime keeps reload notice visible and blocks export before old permissions fail', async () => {
    await panel.locator('#version-warning').waitFor();
    assert.ok(await panel.locator('#reload-extension').isVisible());
    assert.ok(await panel.locator('#chat-bank').isDisabled());
    await panel.locator('#chat-input').fill('把题库导出来，共100题');
    await panel.locator('#send-chat').click();
    await panel.locator('#notice').filter({ hasText: '请先点击' }).waitFor();
    assert.ok(await panel.locator('#version-warning').isVisible());
    assert.equal(await panel.locator('#export-setup').isVisible(), false);
    await panel.locator('#save-status').filter({ hasText: '草稿已保存在本机' }).waitFor();
    const state = await panel.evaluate(async () => (await chrome.storage.local.get('workspaceV1')).workspaceV1);
    assert.equal(state.exportTask, null);
    assert.equal(state.documents.length, 0);
    await panel.screenshot({ path: path.join(artifacts, `stale-runtime-${testedVersion}.png`), fullPage: true });
  });
} finally { await context?.close(); }
await writeFile(path.join(artifacts, 'session-review-report.json'), JSON.stringify({ version: testedVersion, passed: !failures.length, checks, failures }, null, 2));
if (failures.length) throw new Error(failures.join('\n'));
console.log(JSON.stringify({ passed: true, checks }));
