import { readQuizPage } from './page-reader.js';
import { resolveMedia } from './media.js';
import { validTotal } from './export-request.js';
import { resolveQuizTab } from './source-tab.js';

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('采集已停止，已读取题目保留。')); return; }
  const timer = setTimeout(done, milliseconds);
  function done() { signal?.removeEventListener('abort', stop); resolve(); }
  function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new Error('采集已停止，已读取题目保留。')); }
  signal?.addEventListener('abort', stop, { once: true });
});

export async function getQuizTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (/^https?:\/\//.test(active?.url || '')) return active;
  const previous = (await chrome.storage.session.get('lastWebTabV2')).lastWebTabV2;
  if (previous?.windowId === active?.windowId) {
    try { const tab = await chrome.tabs.get(previous.id); if (/^https?:\/\//.test(tab.url || '')) return tab; } catch {}
  }
  throw new Error('请先在已登录的题库网页上点击插件图标，再导出题库。');
}

export async function collectWholeBank({ signal, previous = null, onProgress = async () => {}, tab: requestedTab = null, timeoutMs = 12000, expectedCount = null, refreshNumbers = [] } = {}) {
  const tab = previous ? await resolveQuizTab(previous) : requestedTab || await getQuizTab();
  const task = previous ? structuredClone(previous) : { id: crypto.randomUUID(), tabId: tab.id, stage: 'detecting', snapshots: [], expected: null, complete: false, reason: '', method: '页面数据', startedAt: new Date().toISOString() };
  task.sectionSize = 50;
  task.reason = ''; task.diagnostics = null;
  const refreshing = new Set(refreshNumbers.map(Number));
  if (expectedCount !== null) task.requestedCount = validTotal(expectedCount);
  if (task.requestedCount) task.expected = task.requestedCount;
  const publish = async (label, stage = 'collecting') => { task.stage = stage; task.label = label; task.collectionSectionsCompleted = (task.complete ? Math.ceil : Math.floor)(task.snapshots.length / task.sectionSize); await onProgress(structuredClone(task)); };
  const check = () => { if (signal?.aborted) throw new Error('采集已停止，已读取题目保留。'); };
  const invoke = async (command, argument = {}) => {
    check();
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        result = await chrome.scripting.executeScript({ target: { tabId: task.tabId, frameIds: [task.frameId || 0] }, world: 'MAIN', func: readQuizPage, args: [command, { ...argument, origin: task.origin }] });
        break;
      } catch {
        check(); const current = await chrome.tabs.get(task.tabId).catch(() => null);
        if (!current || !/^https?:\/\//.test(current.url || '') || new URL(current.url).origin !== task.topOrigin) throw new Error('原题库标签页已关闭或离开题库来源，任务已暂停。');
        if (attempt === 19) throw new Error('无法读取题库页面或内嵌页面，请在题库网页重新点击插件图标授权。');
        await wait(200, signal);
      }
    }
    const value = result?.[0]?.result;
    if (!value) throw new Error('页面没有返回可读取的题目信息。');
    if (value.error) throw new Error(value.error);
    if (value.loginRequired) throw new Error('题库登录已失效，请在原网页登录后继续。');
    return value;
  };
  const merge = async items => {
    let processed = 0;
    const checkCapacity = () => {
      if (task.snapshots.length > 5000) throw new Error('单份题库超过 5000 题，请拆分后采集。');
      if (JSON.stringify(task.snapshots).length > 3 * 1024 * 1024) throw new Error('题库内容超过当前采集容量，请分份处理。');
    };
    for (const original of items) {
      check();
      const item = await resolveMedia(original, signal);
      if (!item?.identity || !item.rawText && !item.question) continue;
      const normalized = { ...item, identity: item.number ? `number_${item.number}` : item.identity };
      const existing = task.snapshots.findIndex(old => old.identity === normalized.identity);
      if (existing < 0) task.snapshots.push(structuredClone(normalized)); else if (item.question || !task.snapshots[existing].question) task.snapshots[existing] = structuredClone(normalized);
      refreshing.delete(Number(item.number));
      if (++processed % task.sectionSize === 0) {
        checkCapacity();
        await publish(`已读取 ${task.snapshots.length}${task.expected ? ` / ${task.expected}` : ''} 题，正在读取剩余题目…`);
      }
    }
    checkCapacity();
  };
  let page;
  try {
    await publish('正在识别题库和可读取的数据…', 'detecting');
    if (!previous) {
      let frames;
      try { frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', func: readQuizPage, args: ['read'] }); }
      catch { frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readQuizPage, args: ['read'] }); }
      frames.sort((a, b) => ((b.result?.structured?.length || 0) * 100 + Number(Boolean(b.result?.screen)) * 20 + Number(Boolean(b.result?.expected)) * 10) - ((a.result?.structured?.length || 0) * 100 + Number(Boolean(a.result?.screen)) * 20 + Number(Boolean(a.result?.expected)) * 10));
      const frame = frames[0]; page = frame?.result;
      if (!page || page.loginRequired) throw new Error('请先在原浏览器标签页登录并打开背题/题库内容页。');
      if (!page.screen && !page.structured?.length) throw new Error('没有识别到题目。页面可能是图片/canvas 或未授权 iframe，无法凭空生成原题题库。');
      task.frameId = frame.frameId; task.origin = new URL(page.frameUrl).origin; task.topOrigin = new URL(tab.url).origin;
      task.title = page.title || tab.title || '网页题库'; task.url = page.url; task.topUrl = tab.url;
    }
    page = await invoke('install');
    task.expected = task.requestedCount || page.expected || task.expected;
    page = await invoke('probe');
    task.expected = task.requestedCount || page.expected || task.expected;
    if (task.requestedCount && page.expected && page.expected !== task.requestedCount) throw new Error(`网页识别到 ${page.expected} 题，与填写的 ${task.requestedCount} 题不一致，请核实总题数后重试。`);
    if (page.structured?.length && (!task.expected || page.structured.length === task.expected)) {
      await merge(page.structured); task.method = '页面/HTTP 题库数据';
      if (task.expected && task.snapshots.length === task.expected && !refreshing.size) task.complete = true;
      // An array alone does not prove a whole bank when the page exposes no total.
      if (task.complete) { await publish(`已读取 ${task.snapshots.length} / ${task.expected} 题，正在校验…`); return task; }
    }
    const navigation = page.navigation || [];
    const originalNumber = page.currentNumber;
    let startedAtFirst = navigation.length > 0 || page.currentNumber === 1;
    let clicks = 0;
    while (clicks < 5000) {
      check();
      const number = page.currentNumber;
      const desired = navigation.length ? navigation.find(entry => refreshing.has(entry.number) || !task.snapshots.some(item => Number(item.number) === entry.number))?.number : null;
      if (desired && desired !== number) {
        await publish(`定位第 ${desired} 题，已读取 ${task.snapshots.length}${task.expected ? ` / ${task.expected}` : ''} 题`);
        await invoke('navigate', { number: desired }); clicks++;
        page = await waitForChange(page, desired);
      }
      if (page.screen) {
        const candidate = page.structured?.find(item => page.screen.rawText.includes(item.question?.stem) && item.question?.stem);
        const item = candidate ? { ...candidate, number: page.screen.number || candidate.number } : page.screen;
        await merge([item]);
      } else if (page.structured?.length) await merge(page.structured);
      await publish(`正在读取题目：${task.snapshots.length}${task.expected ? ` / ${task.expected}` : ''} 题`);
      if (!refreshing.size && task.expected && task.snapshots.length === task.expected) {
        if (navigation.length && !navigation.every(entry => task.snapshots.some(item => Number(item.number) === entry.number))) {
          task.reason = '题号覆盖不完整，不能标记整库完成。'; break;
        }
        task.complete = true; break;
      }
      if (page.apiPagination?.safeOrdinal) {
        task.method = '题目接口分页';
        const spec = page.apiPagination;
        for (let n = 1; n <= spec.pages; n++) {
          check(); await publish(`后台读取第 ${n} / ${spec.pages} 页，已取得 ${task.snapshots.length} 题`);
          page = await invoke('api-page', { page: n }); await merge(page.structured || []);
        }
        if (task.expected && task.snapshots.length === task.expected) { task.complete = true; break; }
      }
      if (navigation.length) {
        if (navigation.every(entry => task.snapshots.some(item => Number(item.number) === entry.number))) {
          // A refresh may still need other answer-card entries even when every
          // question has an older snapshot and this page has no Next button.
          if (navigation.some(entry => refreshing.has(entry.number))) continue;
          task.complete = !refreshing.size && task.snapshots.length === (task.expected || navigation.length); if (task.complete || !page.nextAvailable) break;
        } else continue;
      }
      if (page.terminal) { task.complete = startedAtFirst && (!task.expected || task.expected === task.snapshots.length); if (!task.complete) task.reason = '已到末题，但起点或总题数无法核实。'; break; }
      if (!page.nextAvailable) { task.reason = '未找到下一题或可验证的末题，当前仅为部分采集。'; break; }
      task.method = '自动逐题读取';
      await invoke('navigate'); clicks++;
      page = await waitForChange(page);
    }
    if (clicks >= 5000) task.reason = '达到本次导航上限，请继续采集。';
    if (task.complete && navigation.length && originalNumber && page.currentNumber !== originalNumber && !signal?.aborted) {
      await invoke('navigate', { number: originalNumber }).catch(() => {});
    }
    if (!task.complete && !task.reason) task.reason = '无法验证题库完整性。';
    return task;
  } catch (error) {
    task.reason = error.message; task.complete = false;
    if (!task.snapshots.length) throw Object.assign(error, { task });
    return task;
  } finally {
    task.collectionSectionsCompleted = (task.complete ? Math.ceil : Math.floor)(task.snapshots.length / task.sectionSize);
    if (task.origin) {
      try { await chrome.scripting.executeScript({ target: { tabId: task.tabId, frameIds: [task.frameId || 0] }, world: 'MAIN', func: readQuizPage, args: ['cleanup', { origin: task.origin }] }); } catch {}
    }
  }

  async function waitForChange(oldPage, desired = null) {
    const deadline = Date.now() + timeoutMs;
    const before = oldPage.screen?.rawText;
    let lastSeen = oldPage;
    while (Date.now() < deadline) {
      await wait(150, signal);
      const current = await invoke('read', { numberHint: desired });
      lastSeen = current;
      const numberChanged = desired ? current.currentNumber === desired : current.currentNumber && current.currentNumber !== oldPage.currentNumber;
      const textChanged = current.screen?.rawText && current.screen.rawText !== before;
      if ((numberChanged && textChanged) || (!desired && textChanged)) {
        // Wait for answer/analysis to settle after the stem changes.
        await wait(180, signal); const stable = await invoke('read', { numberHint: desired });
        if (stable.screen?.rawText === current.screen?.rawText) return stable;
      }
    }
    task.diagnostics = { version: chrome.runtime?.getManifest?.().version || '0.2.2', url: task.url,
      failure: 'question_change_unconfirmed', requestedNumber: desired, beforeNumber: oldPage.currentNumber,
      detectedNumber: lastSeen.currentNumber, textChanged: Boolean(lastSeen.screen?.rawText && lastSeen.screen.rawText !== before),
      before: oldPage.diagnostics || null, after: lastSeen.diagnostics || null };
    throw new Error(`${desired ? `定位第 ${desired} 题后` : '点击下一题后'}未能确认新题${lastSeen.currentNumber ? `，当前识别为第 ${lastSeen.currentNumber} 题` : '，未识别到题号'}。任务已暂停，已读取题目保留。`);
  }
}

export function snapshotText(snapshot, position = 1) {
  if (snapshot.rawText) return `${snapshot.number || position}. 原题内容\n${snapshot.rawText}`;
  const q = snapshot.question;
  const matching = q.type === 'matching' && q.matching ? `\n左侧\n${(q.matching.leftItems || []).map(item => `${item.id}. ${item.text}`).join('\n')}\n右侧\n${(q.matching.rightItems || []).map(item => `${item.id}. ${item.text}`).join('\n')}` : '';
  const answer = q.type === 'matching' ? (q.matching?.correctPairs || []).map(pair => `${pair.leftId}→${pair.rightId}`).join('、') : (q.answers || []).join('、');
  return `${snapshot.number || position}. [${q.type || '题型待识别'}] ${q.stem}\n${(q.options || []).map(o => `${o.key}. ${o.text}`).join('\n')}${matching}\n标准答案：${answer}\n${q.explanation ? `解析：${q.explanation}` : ''}`;
}
