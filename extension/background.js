async function configure() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Handle the actual action invocation rather than only the panel toggle.
  // Native toolbar/command invocations are the activeTab permission gesture.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}
chrome.runtime.onInstalled.addListener(() => { configure().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { configure().catch(() => {}); });
configure().catch(() => {});

async function rememberWebTab(tab) {
  if (tab?.id && /^https?:\/\//.test(tab.url || '')) await chrome.storage.session.set({ lastWebTabV2: { id: tab.id, windowId: tab.windowId } });
}
chrome.tabs.onActivated.addListener(({ tabId }) => { chrome.tabs.get(tabId).then(rememberWebTab).catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete' && tab.active) rememberWebTab(tab).catch(() => {}); });
chrome.action.onClicked.addListener(tab => {
  // open() must occur before storage awaits, while the user gesture is active.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  rememberWebTab(tab).catch(() => {});
  if (tab?.id && /^https?:\/\//.test(tab.url || '')) {
    const url = new URL(tab.url);
    chrome.storage.session.set({ captureInvocationV1: { tabId: tab.id, windowId: tab.windowId,
      url: `${url.origin}${url.pathname}`, at: Date.now(), nonce: crypto.randomUUID() } }).catch(() => {});
  }
});
