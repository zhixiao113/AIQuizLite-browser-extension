function sameSource(value, expected) {
  try {
    const a = new URL(value), b = new URL(expected);
    return /^https?:$/.test(a.protocol) && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  } catch { return false; }
}

export function sourceTabError(ambiguous = false) {
  return Object.assign(new Error(ambiguous
    ? '找到多个相同题库标签页，请切到需要核对的原题库页后重试。已采集原文和成品保留。'
    : '原题库标签页已关闭或离开这份题库。请重新打开文档上方的原题库网址，再继续采集或深度核对；已采集原文和成品保留。'),
  { code: ambiguous ? 'source_tab_ambiguous' : 'source_tab_missing' });
}

// A persisted tab ID is a hint, not a durable bank identity. Never adopt a
// different paper just because it is active or on the same host.
export async function resolveQuizTab(task) {
  const expected = task.topUrl || task.url;
  if (!sameSource(expected, expected)) throw sourceTabError();
  const original = await chrome.tabs.get(task.tabId).catch(() => null);
  if (original && sameSource(original.url, expected)) return original;
  // Frame IDs are also ephemeral. A reopened iframe bank needs fresh discovery.
  if (task.frameId) throw sourceTabError();
  const matches = (await chrome.tabs.query({})).filter(tab => sameSource(tab.url, expected));
  const active = matches.filter(tab => tab.active);
  const tab = active.length === 1 ? active[0] : matches.length === 1 ? matches[0] : null;
  if (!tab) throw sourceTabError(matches.length > 1);
  task.tabId = tab.id;
  task.frameId = 0;
  return tab;
}
