import { parseMatchingSnapshot } from './matching-parser.js';

// Conservative conversion: only use explicitly displayed standard answers.
export function parseSnapshot(snapshot, id, paper) {
  if (snapshot.question) return { ...structuredClone(snapshot.question), id, paper, _rowId: crypto.randomUUID() };
  if (!snapshot.rawText || snapshot.imageDependent && (!snapshot.mediaAssets?.length || snapshot.mediaError)) return null;
  const raw = snapshot.rawText.replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
  const answerLabel = /(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]\s*/;
  const marker = answerLabel.exec(raw);
  if (!marker) return null;
  const beforeAnswer = raw.slice(0, marker.index);
  const afterAnswer = raw.slice(marker.index + marker[0].length);
  const typeText = beforeAnswer.match(/单选题|多选题|单项选择题|多项选择题|判断题|填空题|连线题/)?.[0] || '';
  if (/连线/.test(typeText)) return parseMatchingSnapshot(snapshot, id, paper);
  const lines = beforeAnswer.split('\n').map(line => line.trim()).filter(Boolean);
  const options = []; const stemLines = [];
  for (const line of lines) {
    const option = line.match(/^([A-H])[.、．,，]\s*(.*)$/);
    if (option) options.push({ key: option[1], text: option[2] });
    else if (options.length) options.at(-1).text += `${options.at(-1).text ? '\n' : ''}${line}`;
    else stemLines.push(line);
  }
  let stem = stemLines.join('\n');
  const typeMarker = /[（(](?:单选题|多选题|单项选择题|多项选择题|判断题|填空题)[）)]/.exec(stem);
  if (typeMarker) stem = stem.slice(typeMarker.index + typeMarker[0].length).trim();
  else stem = stem.replace(/^\s*(?:第\s*)?\d+\s*(?:题)?[.、．\s]*/, '').replace(/^(?:单选题|多选题|判断题|填空题)\s*/, '').trim();
  let type = /多选|多项/.test(typeText) ? 'multi' : /判断/.test(typeText) ? 'judge' : /填空/.test(typeText) ? 'fill_blank' : 'single';
  let answers = [];
  let answerSource = '';
  if (type === 'fill_blank') {
    if ((stem.match(/_{2,}/g) || []).length > 1) return null;
    const answer = afterAnswer.split(/\n(?:解析|答案解析|批注|我要纠错|下一题|下一页)/)[0].trim();
    if (!answer || answer.includes('\n')) return null;
    answers = [answer];
  } else {
    const letters = afterAnswer.match(/^([A-H](?:[\s,，、;；]*[A-H])*)/);
    if (letters) answers = letters[1].match(/[A-H]/g) || [];
    const corrections = Array.from(afterAnswer.matchAll(/更改试题答案(?:为|[：:])?\s*([A-H](?:[\s,，、;；]*[A-H])*)/g));
    if (corrections.length) { answers = corrections.at(-1)[1].match(/[A-H]/g) || []; answerSource = '原文批注明确修正'; }
    if (type === 'judge') {
      const word = afterAnswer.match(/^(正确|错误|对|错)/)?.[1];
      if (word) answers = [/^(正确|对)$/.test(word) ? 'A' : 'B'];
      else {
        const sourceOption = options.find(option => option.key === answers[0]);
        if (/^(正确|对)$/.test(sourceOption?.text || '')) answers = ['A'];
        else if (/^(错误|错)$/.test(sourceOption?.text || '')) answers = ['B'];
        else return null;
      }
      options.splice(0, options.length, { key: 'A', text: '正确' }, { key: 'B', text: '错误' });
    } else if (!typeText && answers.length > 1) type = 'multi';
  }
  if (!answers.length) return null;
  const explanationMatch = raw.match(/(?:^|\n)(?:答案解析|解析)\s*[：:]?\s*\n?([\s\S]*?)(?=\n(?:下一题|下一页|上一题|批注|我要纠错)|$)/);
  return { id, paper, _rowId: crypto.randomUUID(), type, stem, options: type === 'fill_blank' ? [] : options, answers,
    explanation: explanationMatch?.[1].trim() || null, image: null, explanationImages: [], ...(answerSource ? { _answerSource: answerSource } : {}) };
}
