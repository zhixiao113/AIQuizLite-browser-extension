// Manual source corrections belong to a document, not a refreshable webpage snapshot.
export const reviewNumber = value => String(value ?? '').trim().replace(/^第\s*(\d+)\s*题$/, '$1').replace(/^(\d+)[.、．]$/, '$1');

export function editedSnapshot(snapshot, doc, position = 1) {
  const edit = doc?.reviewEdits?.[reviewNumber(snapshot.number || position)];
  if (!edit) return snapshot;
  return { ...snapshot, question: undefined, originalRawText: snapshot.originalRawText ?? snapshot.rawText,
    rawText: edit.rawText, manuallyEdited: true };
}

export function saveReviewEdit(doc, item, rawText) {
  const number = reviewNumber(item.sourceNumber);
  if (!/^\d+$/.test(number) || Number(number) < 1) throw new Error('原题号缺失，无法保存对应原文。');
  if (!rawText.trim()) throw new Error('原文不能为空。');
  if (rawText.length > 10000) throw new Error('单题原文不能超过 10000 字符。');
  doc.reviewEdits ||= {};
  doc.reviewEdits[number] = { rawText: rawText.trim(), updatedAt: new Date().toISOString() };
  item.rawText = rawText.trim(); item.rawEdited = true;
  item.reason = '原文已编辑，下次 AI 核对将使用修改后的内容。';
  delete item.code; delete item.errors;
}

// Keep one original question as one APP question. Never infer missing answers.
export function orderedBlankQuestion(snapshot, id, paper) {
  const raw = String(snapshot.rawText || '').replace(/\r/g, '');
  const marker = /(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]\s*/.exec(raw);
  if (!marker) return null;
  let stem = raw.slice(0, marker.index);
  const type = /[（(]填空题[）)]/.exec(stem);
  if (!type) return null;
  stem = stem.slice(type.index + type[0].length).trim();
  const blanks = stem.match(/_{2,}|[（(]\s*[）)]/g) || [];
  if (blanks.length < 2 || blanks.length > 30) return null;
  const answerText = raw.slice(marker.index + marker[0].length).split(/\n\s*(?:答案顺序固定|答案解析|解析|批注|我要纠错|下一题|上一题)(?:\s|[：:]|$)/)[0].trim();
  const answers = answerText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (answers.length !== blanks.length || answers.some(s => /[,，]/.test(s))) return null;
  let n = 0;
  stem = stem.replace(/_{2,}|[（(]\s*[）)]/g, () => `[空${++n}]`);
  const explanation = raw.match(/(?:^|\n)(?:答案解析|解析)\s*[：:]?\s*\n?([\s\S]*?)(?=\n(?:下一题|上一题|批注|我要纠错)|$)/)?.[1].trim() || null;
  return { id, paper, _rowId: crypto.randomUUID(), type: 'fill_blank', options: [],
    stem: `${stem}\n请按空位顺序填写全部答案，用英文逗号分隔：____`, answers: [answers.join(',')],
    explanation, image: null, explanationImages: [], _orderedBlankCount: blanks.length,
    _answerSource: '原文多空标准答案，按空位顺序合并' };
}
