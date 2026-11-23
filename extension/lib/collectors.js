export const COLLECTORS = [
  { id: 'selection', label: '选中文字', available: true },
  { id: 'page', label: '当前页正文', available: true },
  { id: 'paste', label: '粘贴原文', available: true },
  { id: 'bank', label: '整份题库', available: true }
];

// This function is serialized by chrome.scripting. Keep it self-contained.
export function captureDocument(mode) {
  const clean = value => value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let content = '';
  if (mode === 'selection') {
    content = window.getSelection()?.toString() || '';
    if (!content.trim()) return { error: '本页没有选中文字，请先选中题目，或使用当前页正文。' };
  } else {
    const container = document.querySelector('main, [role="main"], article') || document.body;
    if (!container) return { error: '本页没有可读取的正文。' };
    const ignored = 'script,style,noscript,nav,header,footer,aside,button,input,textarea,select,[hidden],[aria-hidden="true"],dialog';
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const lines = [];
    let node;
    let size = 0;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest(ignored) || !parent.getClientRects().length) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const value = node.textContent.trim();
      if (!value) continue;
      lines.push(value);
      size += value.length + 1;
      if (size > 120000) return { error: '本页正文超过 120000 字符，请选中完整题目范围后再采集。' };
    }
    content = lines.join('\n');
  }
  content = clean(content);
  if (!content) return { error: '未找到正文，图片文字和未加载题目暂无法采集，请使用粘贴原文。' };
  if (content.length > 120000) return { error: '选中内容超过 120000 字符，请缩小范围。' };
  const url = new URL(location.href);
  return { text: content, title: document.title, url: `${url.origin}${url.pathname}`, mode, capturedAt: new Date().toISOString() };
}

export async function collect(mode) {
  if (mode === 'bank') {
    const { collectWholeBank } = await import('./bank-collector.js');
    return collectWholeBank();
  }
  const adapter = COLLECTORS.find(item => item.id === mode);
  if (!adapter?.available || mode === 'paste') throw new Error(adapter?.reason || '请在原文框中粘贴题目。');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw new Error('请先切到普通网页并点击插件图标授权；浏览器内部页面无法采集。');
  let results;
  try { results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: captureDocument, args: [mode] }); }
  catch { throw new Error('无法读取本页，请在这个网页上重新点击插件图标授权，或粘贴题目原文。'); }
  const result = results[0]?.result;
  if (result?.error) throw new Error(result.error);
  if (!result?.text) throw new Error('未取得网页正文，请改用粘贴原文。');
  return { ...result, tabId: tab.id };
}

export function classifyIntent(message) {
  if (/(?:继续|恢复|接着).*?(?:导出|采集|整理|题库|题目)|(?:导出|采集|整理).*?(?:继续|恢复)/.test(message)) return 'resume';
  if (/(?:这份|整份|整套|全部|整个|整库|全库).*?(?:题库|题目)?.*?(?:导出|导出来|抓取|采集)|(?:导出|抓取|采集).*?(?:这份|整份|整套|全部|整个|整库|全库)/.test(message)) return 'bank';
  if (/(?:整理|制作|生成|导出).*(?:题库|题目|JSON)|(?:题库|题目).*?(?:整理|导出)/i.test(message)) return 'prepare';
  return 'chat';
}
