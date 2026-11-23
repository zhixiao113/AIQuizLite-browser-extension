import { mediaAsset } from './media.js';
const encoder = new TextEncoder();
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ -1) >>> 0; }
export function zipStore(entries) {
  if (entries.length > 500) throw new Error('图文包超过 APP 的 500 文件限制。');
  const local = [], central = []; let offset = 0, total = 0; const names = new Set();
  for (const { name, bytes } of entries) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '..') || names.has(name)) throw new Error('图文包路径无效或重复。');
    names.add(name); total += bytes.length;
    if (bytes.length > 25 * 1024 * 1024 || total > 100 * 1024 * 1024) throw new Error('图文包超过 APP 解压大小限制。');
    const filename = encoder.encode(name), crc = crc32(bytes); const header = new Uint8Array(30 + filename.length); const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint16(12, 33, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, filename.length, true); header.set(filename, 30);
    const directory = new Uint8Array(46 + filename.length), dir = new DataView(directory.buffer);
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x800, true); dir.setUint16(14, 33, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, bytes.length, true); dir.setUint32(24, bytes.length, true); dir.setUint16(28, filename.length, true); dir.setUint32(42, offset, true); directory.set(filename, 46);
    local.push(header, bytes); central.push(directory); offset += header.length + bytes.length;
  }
  const end = new Uint8Array(22), endView = new DataView(end.buffer); const centralSize = central.reduce((n, part) => n + part.length, 0);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}
export async function packageBank(json, assets) {
  const bank = JSON.parse(json); bank.formatVersion = 2;
  const references = new Set(bank.questions.flatMap(q => [q.image, ...q.explanationImages]).filter(Boolean));
  const entries = [{ name: 'question-bank.json', bytes: encoder.encode(JSON.stringify(bank)) }];
  for (const reference of references) {
    const descriptor = assets.find(asset => asset.path === reference); const asset = descriptor && await mediaAsset(descriptor.id);
    if (!asset) throw new Error('成品引用的题图未保存，不能下载不完整的图文包。');
    entries.push({ name: reference, bytes: new Uint8Array(await asset.blob.arrayBuffer()) });
  }
  return zipStore(entries);
}
