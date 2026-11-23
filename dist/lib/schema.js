export const TYPES = { single: '单选', multi: '多选', judge: '判断', fill_blank: '填空', matching: '连线' };
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const text = value => typeof value === 'string' ? value.trim() : '';
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');

export function parseJson(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_JSON_BYTES) throw new Error('JSON 文件不能超过 4 MiB。');
  const cleaned = raw.replace(/^\uFEFF/, '').trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  try { return JSON.parse(cleaned); } catch { throw new Error('无法解析 JSON，请检查括号、引号和模型输出是否被截断。'); }
}

export function readBank(raw) {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  const questions = Array.isArray(value) ? value : value?.questions;
  if (!Array.isArray(questions)) throw new Error('根节点需要是题目数组，或含 questions 数组的题库对象。');
  if (questions.length > 5000) throw new Error('本版单个草稿最多 5000 道题，请拆分题库。');
  return {
    name: text(value?.name) || '网页题库',
    questions: questions.map(item => ({ ...(item && typeof item === 'object' && !Array.isArray(item) ? structuredClone(item) : { stem: '', options: [], answers: [] }), _rowId: crypto.randomUUID() })),
    reviewItems: Array.isArray(value?.reviewItems) ? value.reviewItems.slice(0, 5000).map(item => ({
      sourceNumber: item?.sourceNumber == null ? '' : String(item.sourceNumber).trim(), rawText: text(item?.rawText), reason: text(item?.reason) || '原文信息不完整，请核对。'
    })) : []
  };
}

export function validateQuestion(q, { allowImages = false } = {}) {
  const errors = [];
  if (!q || typeof q !== 'object') return ['题目不是对象。'];
  if (!text(q.id)) errors.push('题目 ID 不能为空。');
  if (!Object.hasOwn(TYPES, q.type)) errors.push('请选择支持的题型。');
  if (!text(q.stem)) errors.push('题干不能为空。');
  if (!Array.isArray(q.options)) errors.push('options 必须是数组。');
  if (!strings(q.answers)) errors.push('answers 必须是字符串数组。');
  const options = Array.isArray(q.options) ? q.options : [];
  const answers = strings(q.answers) ? q.answers.map(text) : [];
  if (answers.some(answer => !answer)) errors.push('答案不能包含空内容。');
  if (new Set(answers).size !== answers.length) errors.push('答案存在重复项。');
  if (['single', 'multi', 'judge'].includes(q.type)) {
    const keys = options.map(option => text(option?.key));
    if (options.length < 2 || options.some(option => !text(option?.key) || !text(option?.text))) errors.push('选择题至少需要两个完整选项。');
    if (new Set(keys).size !== keys.length) errors.push('选项 key 存在重复。');
    if (answers.some(answer => !keys.includes(answer))) errors.push('答案引用了不存在的选项。');
    if (q.type === 'multi' ? answers.length < 2 : answers.length !== 1) errors.push(q.type === 'multi' ? '多选题需要至少两个标准答案。' : '单选或判断题需要一个标准答案。');
    if (q.type === 'judge' && (options.length !== 2 || !keys.includes('A') || !keys.includes('B') || options.find(o => o?.key === 'A')?.text !== '正确' || options.find(o => o?.key === 'B')?.text !== '错误')) errors.push('判断题选项需为 A=正确、B=错误。');
  }
  if (['fill_blank', 'matching'].includes(q.type) && options.length) errors.push('填空或连线题的 options 必须为空数组。');
  if (q.type === 'fill_blank' && !answers.length) errors.push('缺少明确的标准答案。');
  if (q.type === 'fill_blank' && (text(q.stem).match(/_{2,}/g) || []).length > 1) errors.push('本版仅支持单空填空，请人工处理多个空。');
  if (q.type === 'matching') {
    if (answers.length) errors.push('连线题的 answers 必须为空数组。');
    const m = q.matching;
    if (!m || !['one_to_one', 'left_reusable'].includes(m.mode)) errors.push('缺少有效的连线模式。');
    const left = Array.isArray(m?.leftItems) ? m.leftItems : [];
    const right = Array.isArray(m?.rightItems) ? m.rightItems : [];
    const pairs = Array.isArray(m?.correctPairs) ? m.correctPairs : [];
    for (const [label, items] of [['左侧', left], ['右侧', right]]) {
      if (!items.length || items.some(item => !text(item?.id) || !text(item?.text))) errors.push(`${label}项目不能为空。`);
      if (new Set(items.map(item => item?.id)).size !== items.length) errors.push(`${label}项目 ID 重复。`);
    }
    if (pairs.some(p => !left.some(item => item?.id === p?.leftId) || !right.some(item => item?.id === p?.rightId))) errors.push('连线关系引用了不存在的项目。');
    if (pairs.length !== right.length || new Set(pairs.map(p => p?.rightId)).size !== right.length) errors.push('每个右侧项目必须恰好对应一个左侧项目。');
    if (m?.mode === 'one_to_one' && new Set(pairs.map(p => p?.leftId)).size !== pairs.length) errors.push('一对一模式不能重复使用左侧项目。');
  }
  const imagePath = value => /^images\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value);
  if (q.image != null && q.image !== '' && (!allowImages || !imagePath(q.image))) errors.push('题图必须是已打包的有效图片，不能丢弃或引用远程图片。');
  if (q.explanationImages != null && (!Array.isArray(q.explanationImages) || q.explanationImages.some(value => !allowImages || !imagePath(value)))) errors.push('解析图必须是已打包的有效图片。');
  if (q.explanation != null && typeof q.explanation !== 'string') errors.push('解析必须是文字或 null。');
  return errors;
}

export function validateBank(bank, excluded = [], { allowImages = false, assets = [] } = {}) {
  const excludedSet = new Set(excluded);
  const included = bank.questions.map((q, index) => ({ q, index })).filter(item => !excludedSet.has(item.q._rowId || item.q.id));
  const ids = new Set();
  const issues = [];
  for (const { q, index } of included) {
    const errors = validateQuestion(q, { allowImages });
    if (allowImages && [q.image, ...(Array.isArray(q.explanationImages) ? q.explanationImages : [])].filter(Boolean).some(path => !assets.some(asset => asset.path === path))) errors.push('题图引用没有对应的已保存文件。');
    if (ids.has(q.id)) errors.push('题库内 ID 重复。');
    ids.add(q.id);
    if (errors.length) issues.push({ index, id: q.id, errors });
  }
  return { issues, includedCount: included.length, validCount: included.length - issues.length, excludedCount: bank.questions.length - included.length };
}

export function assignIds(questions, prefix = crypto.randomUUID()) {
  const seen = new Set();
  return questions.map((q, index) => {
    let id = text(q.id);
    if (!id || seen.has(id)) {
      id = `web_${prefix}_${index + 1}`;
      while (seen.has(id)) id += '_';
    }
    seen.add(id);
    return { ...q, id };
  });
}

export function exportBank(bank, excluded = [], unresolvedCount = bank.reviewItems?.length || 0, media = {}) {
  if (unresolvedCount) throw new Error('请先核对或明确排除待核对原文。');
  if (!text(bank.name)) throw new Error('请填写题库名称。');
  const result = validateBank(bank, excluded, media);
  if (!result.includedCount) throw new Error('没有可导出的题目。');
  if (result.issues.length) throw new Error(`还有 ${result.issues.length} 道题未通过校验，请编辑或明确排除。`);
  const skip = new Set(excluded);
  const papers = new Map();
  const questions = bank.questions.filter(q => !skip.has(q._rowId || q.id)).map((q, index) => {
    const paper = text(q.paper) || bank.name.trim();
    const number = (papers.get(paper) || 0) + 1;
    papers.set(paper, number);
    const item = {
      id: q.id.trim(), index: index + 1, paper, numberInPaper: number, type: q.type,
      stem: q.stem.trim(), options: q.options.map(o => ({ key: o.key.trim(), text: o.text.trim() })),
      answers: q.answers.map(answer => answer.trim()), explanation: text(q.explanation) || null,
      image: media.allowImages ? q.image || null : null, explanationImages: media.allowImages ? q.explanationImages || [] : []
    };
    if (q.type === 'matching') item.matching = structuredClone(q.matching);
    return item;
  });
  const json = JSON.stringify({ name: bank.name.trim(), questions }, null, 2);
  if (new TextEncoder().encode(json).length > MAX_JSON_BYTES) throw new Error('导出 JSON 超过 APP 的 4 MiB 限制，请拆分题库。');
  return json;
}

export function safeFilename(name) {
  let base = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80).replace(/[. ]+$/g, '') || '题库';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `题库_${base}`;
  return base + '.json';
}
