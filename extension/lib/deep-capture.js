import { readQuizPage } from './page-reader.js';
import { resolveMedia } from './media.js';
import { captureError } from './capture-access.js';
import { resolveQuizTab, sourceTabError } from './source-tab.js';

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('深度核对已停止。')); return; }
  const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(new Error('深度核对已停止。')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});

export async function captureReviewQuestion(task, number, { signal, onProgress = async () => {} } = {}) {
  if (task.frameId) throw new Error('内嵌题库暂不支持截图定位，请编辑原文后使用普通 AI 核对。');
  const check = () => { if (signal?.aborted) throw new Error('深度核对已停止。'); };
  const invoke = async (command, argument = {}) => {
    check(); const tab = await chrome.tabs.get(task.tabId).catch(() => { throw sourceTabError(); });
    const expected = new URL(task.topUrl || task.url), current = new URL(tab.url || '');
    if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.search !== expected.search || current.hash !== expected.hash) throw sourceTabError();
    const result = (await chrome.scripting.executeScript({ target: { tabId: task.tabId, frameIds: [0] }, world: 'MAIN', func: readQuizPage,
      args: [command, { ...argument, origin: task.origin, numberHint: number }] }))[0]?.result;
    if (!result || result.error) throw new Error(result?.error || '无法读取原题库页面。');
    if (result.loginRequired) throw new Error('原题库登录已失效，请重新登录后核对。');
    return result;
  };
  const tab = await resolveQuizTab(task);
  await chrome.tabs.update(tab.id, { active: true });
  let page = await invoke('read');
  if (Number(page.currentNumber) !== number) await invoke('navigate', { number });
  const deadline = Date.now() + 12000;
  let previous = '';
  for (;;) {
    await pause(250, signal); page = await invoke('read');
    if (Number(page.currentNumber) === number && page.screen?.rawText && page.screen.rawText === previous) break;
    previous = Number(page.currentNumber) === number ? page.screen?.rawText || '' : '';
    if (Date.now() > deadline) throw new Error(`定位第 ${number} 题未成功，未发送截图。`);
  }
  const raw = page.screen.rawText;
  const images = []; let offset = 0, total = 0;
  while (!total || offset < total - 1) {
    check(); await onProgress(`第 ${number} 题：正在读取题目截图…`);
    const layout = await invoke('capture-layout', { offset });
    if (layout.screen.rawText !== raw || Number(layout.screen.number) !== number) throw new Error('截图过程中原题发生变化，请重新核对。');
    if (total && Math.abs(total - layout.totalHeight) > 1) throw new Error('截图过程中题目布局发生变化，请等待图片加载后重试。');
    total = layout.totalHeight;
    if (images.length >= 12) throw new Error('单题截图过长，原文已保留，请编辑后重试。');
    // Below Chrome's two captures/second limit, across questions as well as tiles.
    await pause(550, signal);
    const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (active?.id !== tab.id) throw new Error('当前标签页已改变，未发送其他页面截图。');
    let data;
    try { data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
    catch (error) { throw captureError(error); }
    const capturedTab = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (capturedTab?.id !== tab.id) throw new Error('截图时切换了标签页，本次截图未发送，请重新核对。');
    const after = await invoke('read');
    if (after.screen?.rawText !== raw || Number(after.currentNumber) !== number) throw new Error('截图时原题发生变化，本次截图未发送。');
    if (after.viewport?.width !== layout.viewport.width || after.viewport?.height !== layout.viewport.height) throw new Error('截图过程中窗口尺寸改变，请重新深度核对。');
    const bitmap = await createImageBitmap(await (await fetch(data)).blob());
    try {
      const sx = bitmap.width / layout.viewport.width, sy = bitmap.height / layout.viewport.height;
      if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.01) throw new Error('截图显示尺寸与网页不一致，请恢复网页显示或重新打开原题库页面后核对。');
      const r = layout.rect;
      const width = Math.round(r.width * sx), height = Math.round(r.height * sy);
      if (!width || !height || width * height > 24000000) throw new Error('截图尺寸过大，请缩小网页显示比例。');
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, r.x * sx, r.y * sy, r.width * sx, r.height * sy, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      images.push(await blobDataUrl(blob));
    } finally { bitmap.close(); }
    offset += layout.rect.height;
  }
  const snapshot = await resolveMedia(page.screen, signal);
  return { snapshot, images };
}

export function blobDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败。')); reader.readAsDataURL(blob); });
}
