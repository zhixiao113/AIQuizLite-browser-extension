const KEY = 'downloadPrefsV1';
const defaults = () => ({ folder: 'AIQuizLite', locations: [] });
let updating = Promise.resolve();

export function normalizeDownloadFolder(value) {
  if (typeof value !== 'string') throw new Error('请填写下载文件夹名称。');
  const folder = value.trim().replace(/\\/g, '/');
  if (!folder) return '';
  if (folder.length > 180 || folder.startsWith('/') || /^[A-Za-z]:/.test(folder)) throw new Error('请填写浏览器下载目录下的子文件夹，例如 AIQuizLite，不能填写磁盘绝对路径。');
  const parts = folder.split('/');
  if (parts.some(part => !part || ['.', '..'].includes(part) || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('文件夹名称不能包含上级目录、空路径或系统不支持的字符。');
  return folder;
}

export function downloadFilename(folder, name) {
  const normalized = normalizeDownloadFolder(folder);
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) throw new Error('下载文件名无效。');
  return normalized ? `${normalized}/${name}` : name;
}

export async function loadDownloadPrefs() {
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  if (!saved) return defaults();
  let folder;
  try { folder = normalizeDownloadFolder(saved.folder); } catch { folder = defaults().folder; }
  return { folder, locations: Array.isArray(saved.locations) ? saved.locations.filter(item => Number.isInteger(item?.id) && typeof item.folder === 'string' && typeof item.filename === 'string').slice(-20) : [] };
}

export async function saveDownloadFolder(folder) {
  const normalized = normalizeDownloadFolder(folder);
  return updatePrefs(prefs => ({ ...prefs, folder: normalized }));
}

function updatePrefs(change) {
  updating = updating.catch(() => {}).then(async () => {
    const next = change(await loadDownloadPrefs());
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
  return updating;
}

async function rememberDownload(folder, item) {
  await updatePrefs(prefs => {
    const previous = prefs.locations.find(location => location.folder === folder);
    const parsed = Date.parse(item.startTime);
    const startedAt = Number.isFinite(parsed) ? parsed : Date.now();
    if (previous?.startedAt > startedAt) return prefs;
    const locations = [...prefs.locations.filter(location => location.folder !== folder), { folder, id: item.id, filename: item.filename || '', startedAt }].slice(-20);
    return { ...prefs, locations };
  });
}

// Only question-bank downloads use the configured folder. Diagnostic files
// retain their independent save dialog and never become the folder target.
export async function saveQuizDownload(blob, name) {
  const { folder } = await loadDownloadPrefs();
  const url = URL.createObjectURL(blob);
  let id, listener;
  try {
    id = await chrome.downloads.download({ url, filename: downloadFilename(folder, name), saveAs: false, conflictAction: 'uniquify' });
    const [started] = await chrome.downloads.search({ id });
    await rememberDownload(folder, started || { id, filename: '' });
    const inspect = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item?.state === 'complete') { await rememberDownload(folder, item); return item; }
      if (item?.state === 'interrupted') throw new Error('题库下载未完成，请检查浏览器下载记录后重试。');
      return null;
    };
    let item = await inspect();
    if (!item) item = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('题库仍在下载，请在浏览器下载记录中确认结果。')); }, 60000);
      const cleanup = () => { clearTimeout(timer); if (listener) chrome.downloads.onChanged.removeListener(listener); };
      listener = delta => { if (delta.id === id && delta.state) inspect().then(value => { if (value) { cleanup(); resolve(value); } }).catch(error => { cleanup(); reject(error); }); };
      chrome.downloads.onChanged.addListener(listener);
      // A small file may finish between the first search and listener setup.
      inspect().then(value => { if (value) { cleanup(); resolve(value); } }).catch(error => { cleanup(); reject(error); });
    });
    return { id, folder, filename: item.filename };
  } finally {
    if (listener) chrome.downloads.onChanged.removeListener(listener);
    // Keep the Blob available for a slow native download after a timeout.
    const cleanupTimer = setTimeout(() => URL.revokeObjectURL(url), 60000);
    cleanupTimer.unref?.();
  }
}

export async function openQuizDownloadFolder() {
  const prefs = await loadDownloadPrefs();
  const location = prefs.locations.find(item => item.folder === prefs.folder);
  if (location) {
    const [item] = await chrome.downloads.search({ id: location.id });
    const owned = location.filename ? (!item?.byExtensionId || item.byExtensionId === chrome.runtime.id) : item?.byExtensionId === chrome.runtime.id;
    if (item?.state === 'complete' && item.exists !== false && (!location.filename || item.filename === location.filename) && owned) {
      await rememberDownload(prefs.folder, item);
      chrome.downloads.show(item.id);
      return { exact: true, filename: item.filename };
    }
  }
  chrome.downloads.showDefaultFolder();
  return { exact: !prefs.folder, folder: prefs.folder };
}

export function savedFolderPath(filename) {
  const last = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  return last >= 0 ? filename.slice(0, last) : '';
}
