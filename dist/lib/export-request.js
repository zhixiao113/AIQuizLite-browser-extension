export function validTotal(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('总题数需要是 1–5000 的整数。');
  return n;
}
function chineseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九'; let result = 0, digit = 0;
  for (const char of text.replace(/两/g, '二').replace(/〇/g, '零')) {
    if (digits.includes(char)) digit = digits.indexOf(char);
    else { result += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char] || 0); digit = 0; }
  }
  return result + digit;
}
export function questionTotal(message) {
  const total = message.match(/(?:总共|一共|共有|总计|共|总题数(?:是|为|[：:])?)\s*([\d零〇一二两三四五六七八九十百千]+)\s*(?:道|题)/);
  const numbers = total ? [chineseNumber(total[1])] : Array.from(message.matchAll(/(?<![\d.])([\d零〇一二两三四五六七八九十百千]+)\s*(?:道|题)/g), m => chineseNumber(m[1]));
  if (!numbers.length) return null;
  if (new Set(numbers).size > 1) throw new Error('消息中有多个题数，请明确这份题库的总题数。');
  return validTotal(numbers[0]);
}
export function exportRequest(message, intent, pending = null) {
  const hasIntent = ['bank', 'prepare'].includes(intent);
  const newCount = pending?.wantsExport && /^\s*\d+\s*$/.test(message) ? validTotal(message.trim()) : questionTotal(message);
  if (!hasIntent && newCount === null) return null;
  const count = newCount ?? pending?.count ?? null;
  const wantsExport = hasIntent || Boolean(pending?.wantsExport);
  if (!wantsExport && count === null) return null;
  return { ready: wantsExport && count !== null, pending: { wantsExport, count }, message: !wantsExport ? `收到，共 ${count} 题。要导出的话，请说“把这份题库导出来”。` : count === null ? '请补充这份题库共有多少题，例如“共 100 题”。' : '' };
}
export function completeness(doc) {
  if (!doc.strictCount) return { full: Boolean(doc.coverage.complete), missing: [], expected: doc.coverage.expected };
  const expected = doc.requestedCount; const excluded = new Set(doc.excluded);
  const orders = doc.bank.questions.filter(q => !excluded.has(q._rowId || q.id)).map(q => q._sourceOrder);
  const present = new Set(orders);
  const missing = Array.from({ length: expected }, (_, i) => i).filter(i => !present.has(i));
  return { expected, missing, full: Boolean(doc.coverage.complete && !missing.length && orders.length === expected && present.size === expected && orders.every(i => Number.isInteger(i) && i >= 0 && i < expected)) };
}
