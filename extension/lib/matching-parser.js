import { validateQuestion } from './schema.js';

const answerLabel = /(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]\s*/;
const uiBoundary = /\n\s*(?:连线图形|答案解析|解析|批注|我要纠错|下一题|下一页|上一题|更改(?:连线题|试题)答案)/;

function explicitPairs(value) {
  const input = value.normalize('NFKC').trim();
  const pattern = /([A-Za-z0-9_]+)\s*(?:->|→|-)\s*([A-Za-z0-9_]+)/g;
  const pairs = [...input.matchAll(pattern)].map(match => ({ leftId: match[1], rightId: match[2] }));
  if (!pairs.length || input.replace(pattern, '').replace(/[\s\[\]{}();；,，、]/g, '')) return null;
  return pairs;
}

// Convert only two identifiable source lists and explicit standard relations.
// Numeric IDs are scoped to each list; repeated left IDs mean reusable tokens.
export function parseMatchingSnapshot(snapshot, id, paper) {
  if (!snapshot.rawText || snapshot.imageDependent && (!snapshot.mediaAssets?.length || snapshot.mediaError)) return null;
  const raw = snapshot.rawText.replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
  const marker = answerLabel.exec(raw);
  if (!marker) return null;
  const before = raw.slice(0, marker.index);
  const type = /[（(](?:连线题|匹配题)[）)]/.exec(before);
  if (!type) return null;
  const after = raw.slice(marker.index + marker[0].length);
  let pairs = explicitPairs(after.split(uiBoundary)[0]);
  if (!pairs) return null;
  let corrected = false;
  for (const correction of after.matchAll(/更改(?:连线题|试题)答案(?:为|[：:])?\s*([^\n]*)/g)) {
    const amended = explicitPairs(correction[1]);
    if (amended) { pairs = amended; corrected = true; }
  }
  const leftIds = new Set(pairs.map(pair => pair.leftId));
  const rightIds = new Set(pairs.map(pair => pair.rightId));
  const groups = [[], []], stem = [];
  let side = 0;
  for (const value of before.slice(type.index + type[0].length).split('\n')) {
    const line = value.trim();
    if (!line) continue;
    if (/^左(?:侧|边|项)(?:项目|选项|列表)?[：:]?$/.test(line)) {
      if (groups[0].length || side) return null;
      continue;
    }
    if (/^右(?:侧|边|项)(?:项目|选项|列表)?[：:]?$/.test(line)) {
      if (!groups[0].length || side) return null;
      side = 1; continue;
    }
    const item = /^([1-9]\d*|[A-Za-z]\d*)(?:[.．](?!\d)|[、)）])\s*(.*)$/.exec(line);
    if (item) {
      const itemId = item[1];
      const family = value => /^\d/.test(value) ? 'number' : value[0];
      if (!side && groups[0].length && (groups[0].some(previous => previous.id === itemId) || rightIds.has(itemId) && !leftIds.has(itemId) && family(itemId) !== family(groups[0][0].id))) side = 1;
      if (groups[side].some(previous => previous.id === itemId)) return null;
      groups[side].push({ id: itemId, text: item[2] });
    } else if (groups[side].length) {
      const last = groups[side].at(-1);
      last.text += `${last.text ? '\n' : ''}${line}`;
    } else stem.push(line);
  }
  const reused = new Set(pairs.map(pair => pair.leftId)).size < pairs.length;
  const stemText = stem.join('\n');
  if (!stemText || groups.some(items => !items.length || items.some(item => !item.text.trim()))) return null;
  if (groups.some(items => items.every(item => /^\d+$/.test(item.id)) && items[0].id === '1' && items.some((item, index) => item.id !== String(index + 1)))) return null;
  if (reused && /(?:Token|左侧|左项)\s*(?:不(?:可|能)|禁止)重复使用/i.test(stemText)) return null;
  const reusable = reused || /(?:Token|左侧|左项)\s*(?:可|可以|允许)重复使用/i.test(stemText);
  const explanationMarker = /(?:^|\n)(?:答案解析|解析)[ \t]*[：:]?[ \t]*(?:\n)?/.exec(after);
  const explanation = explanationMarker ? after.slice(explanationMarker.index + explanationMarker[0].length).split(/(?:^|\n)[ \t]*(?:下一题|下一页|上一题|批注|我要纠错)(?=\s|$)/)[0].trim() || null : null;
  const question = { id, paper, _rowId: crypto.randomUUID(), type: 'matching', stem: stemText, options: [], answers: [],
    matching: { mode: reusable ? 'left_reusable' : 'one_to_one', leftItems: groups[0], rightItems: groups[1], correctPairs: pairs },
    explanation, image: null, explanationImages: [], ...(corrected ? { _answerSource: '原文批注明确修正' } : {}) };
  return validateQuestion(question).length ? null : question;
}
