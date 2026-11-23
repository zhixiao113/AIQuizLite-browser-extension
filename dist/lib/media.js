const MAX_IMAGE = 8 * 1024 * 1024;
let database;
export function requestQuizMediaAccess(pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch { return Promise.resolve(true); }
  if (!['https://exam.zhiqiantong.cn', 'https://www.zhiqiantong.cn'].includes(page.origin)) return Promise.resolve(true);
  // Invoke directly inside the repair click; request only the known quiz image hosts.
  return chrome.permissions.request({ origins: ['https://static.zhiqiantong.cn/*', 'https://image.zhiqiantong.cn/*'] });
}
export function hasQuizMediaAccess(pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch { return Promise.resolve(true); }
  if (!['https://exam.zhiqiantong.cn', 'https://www.zhiqiantong.cn'].includes(page.origin)) return Promise.resolve(true);
  return chrome.permissions.contains({ origins: ['https://static.zhiqiantong.cn/*', 'https://image.zhiqiantong.cn/*'] });
}
function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('AIQuizLiteMedia', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('图片存储无法打开。'));
  });
  return database;
}
export async function mediaAsset(id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('assets').objectStore('assets').get(id);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('无法读取已保存图片。'));
  });
}

export async function clearQuizMedia() {
  const database = await db();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('assets', 'readwrite');
    transaction.objectStore('assets').clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('图片缓存清理失败。'));
    transaction.onabort = () => reject(new Error('图片缓存清理未完成。'));
  });
}
async function saveAsset(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
  const asset = { id: hash, path: `images/${hash}.${extension}`, blob }; const database = await db();
  await new Promise((resolve, reject) => { const tx = database.transaction('assets', 'readwrite'); tx.objectStore('assets').put(asset); tx.oncomplete = resolve; tx.onerror = () => reject(new Error('图片保存失败。')); });
  return { id: asset.id, path: asset.path };
}
async function decodedImage(blob) {
  if (blob.size > MAX_IMAGE) throw new Error('单张图片超过 8 MiB，请拆分处理。');
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new Error('题图无法解码，不能用错误图片充当原图。'); }
  if (!bitmap.width || bitmap.width * bitmap.height > 24000000) { bitmap.close(); throw new Error('题图尺寸超过当前处理上限。'); }
  return bitmap;
}
async function fetchImage(url, signal) {
  if (!/^data:image\//.test(url)) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('题图地址不受支持。');
    if (!await chrome.permissions.contains({ origins: [`${parsed.origin}/*`] })) throw new Error(`题图域名 ${parsed.hostname} 未授权。`);
  }
  const abort = new AbortController(); const stop = () => abort.abort(); signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(url, { credentials: 'include', signal: abort.signal });
    if (!response.ok) throw new Error(`题图读取失败（HTTP ${response.status}）。`);
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_IMAGE) throw new Error('题图超过 8 MiB。');
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_IMAGE) { await reader.cancel(); throw new Error('题图超过 8 MiB。'); } chunks.push(value); }
    return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
async function normalizedAsset(sources, signal) {
  const blobs = []; const bitmaps = [];
  try {
    for (const source of sources) { const blob = await fetchImage(source.url, signal); blobs.push(blob); bitmaps.push(await decodedImage(blob)); }
    if (bitmaps.length === 1 && ['image/png', 'image/jpeg', 'image/webp'].includes(blobs[0].type)) return saveAsset(blobs[0]);
    const width = Math.max(...bitmaps.map(image => image.width)); const height = bitmaps.reduce((n, image) => n + image.height + 16, -16);
    if (width * height > 24000000) throw new Error('多张题图合并后的尺寸过大。');
    // Preserve source pixels when APP's single question-image field needs multiple figures.
    const canvas = new OffscreenCanvas(width, height); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    let y = 0; for (const image of bitmaps) { ctx.drawImage(image, 0, y); y += image.height + 16; }
    return saveAsset(await canvas.convertToBlob({ type: 'image/png' }));
  } finally { bitmaps.forEach(bitmap => bitmap.close()); }
}
export async function resolveMedia(snapshot, signal) {
  if (!snapshot.mediaSources) return snapshot;
  const clean = { ...snapshot }; delete clean.mediaSources;
  clean.mediaAssets = []; clean.mediaError = snapshot.mediaError || '';
  const sources = snapshot.mediaSources.filter((source, index, all) => all.findIndex(item => item.url === source.url && item.role === source.role) === index);
  try {
    const questions = sources.filter(image => image.role === 'question');
    if (questions.length) clean.mediaAssets.push({ ...await normalizedAsset(questions, signal), role: 'question' });
    for (const source of sources.filter(image => image.role === 'explanation')) clean.mediaAssets.push({ ...await normalizedAsset([source], signal), role: 'explanation' });
  } catch (error) { if (signal?.aborted) throw error; clean.mediaError = error.message; }
  clean.imageDependent = Boolean(snapshot.mediaSources.length || clean.mediaError);
  return clean;
}
export function attachMedia(question, snapshot) {
  return { ...question, image: snapshot.mediaAssets?.find(asset => asset.role === 'question')?.path || null,
    explanationImages: (snapshot.mediaAssets || []).filter(asset => asset.role === 'explanation').map(asset => asset.path) };
}
export async function assetUrl(path, assets) {
  const descriptor = assets.find(asset => asset.path === path); if (!descriptor) throw new Error('图片引用缺失。');
  const asset = await mediaAsset(descriptor.id); if (!asset) throw new Error('已保存题图缺失，请重新采集。');
  return URL.createObjectURL(asset.blob);
}
