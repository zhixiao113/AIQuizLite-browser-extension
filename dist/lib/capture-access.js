export const CAPTURE_HELP = '截图权限未就绪，OCR 尚未开始。请切回原题库网页，点击浏览器工具栏的插件图标，或按 Alt+Shift+Q；取得本页截图权限后会自动继续。';

export function captureError(error) {
  const message = String(error?.message || '');
  let code = 'capture_failed', text = '浏览器截图失败，OCR 尚未开始，请重新打开原题库页面后重试。';
  if (/<all_urls>|activeTab|permission|权限|授权/i.test(message)) { code = 'capture_permission'; text = CAPTURE_HELP; }
  else if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|too many|quota/i.test(message)) { code = 'capture_rate_limit'; text = '浏览器截图过于频繁，本题尚未识别，请稍后重试。'; }
  return Object.assign(new Error(text), { code });
}

export function matchingCaptureInvocation(invocation, task, now = Date.now()) {
  if (!task?.captureNeedsGrant || task.status !== 'blocked' || !invocation?.nonce || invocation.nonce === task.captureGrantUsed) return false;
  if (invocation.tabId !== task.tabId || !Number.isFinite(invocation.at) || invocation.at <= (task.captureBlockedAt || 0) || now - invocation.at > 300000 || invocation.at > now + 5000) return false;
  try {
    const source = new URL(task.url), clicked = new URL(invocation.url);
    return /^https?:$/.test(source.protocol) && clicked.origin === source.origin && clicked.pathname === source.pathname;
  } catch { return false; }
}
