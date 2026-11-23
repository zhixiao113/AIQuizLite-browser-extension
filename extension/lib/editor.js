import { TYPES, validateQuestion } from './schema.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function parseEditorOptions(value, existingKeys = []) {
  const options = [];
  for (const line of value.replace(/\r/g, '').split('\n').filter(line => line.trim())) {
    let match = line.match(/^\s*([A-Ha-h])[.、．,，:：)）]\s*(.*)$/) || line.match(/^\s*([^|\s]+)\s*\|\s*(.*)$/);
    if (match && /^\d{2,}$/.test(match[1]) && !existingKeys.includes(match[1])) match = null;
    if (match) options.push({ key: match[1].trim(), text: match[2].trim() });
    else if (options.length) options.at(-1).text += `\n${line.trim()}`;
    else throw new Error('选项每行需以 A|内容、A. 内容或 A、内容 开头。');
  }
  return options;
}

export function questionEditor(question, onSave, onCancel, onError, { position = 1, total = 1 } = {}) {
  const form = el('form', 'question-editor');
  const controls = {};
  const add = (key, label, value, multiline = false) => {
    const id = `edit-${crypto.randomUUID()}`;
    const caption = el('label', '', label); caption.htmlFor = id;
    const input = el(multiline ? 'textarea' : 'input'); input.id = id; input.value = value ?? '';
    if (multiline) input.rows = 3;
    controls[key] = input; form.append(caption, input); return input;
  };
  const positionInput = add('position', '题目排序', position);
  positionInput.type = 'number'; positionInput.min = '1'; positionInput.max = String(total); positionInput.step = '1'; positionInput.required = true;
  form.append(el('p', 'field-hint', `保存后放在第几题（1–${total}），已自动识别，可手动修改。`));
  const typeLabel = el('label', '', '题型');
  const select = el('select'); select.id = `type-${crypto.randomUUID()}`; typeLabel.htmlFor = select.id;
  for (const [value, label] of Object.entries(TYPES)) { const option = el('option', '', label); option.value = value; select.append(option); }
  select.value = Object.hasOwn(TYPES, question.type) ? question.type : 'single';
  form.append(typeLabel, select);
  add('stem', '题干', question.stem, true);
  const optionInput = add('options', '选项（每行：A|内容，也支持 A. 或 A、）', (Array.isArray(question.options) ? question.options : []).map(o => `${o?.key || ''}|${o?.text || ''}`).join('\n'), true);
  const answerInput = add('answers', '原文标准答案（每行一个；选择题填写 key）', (Array.isArray(question.answers) ? question.answers : []).join('\n'), true);
  add('explanation', '原文解析（没有可留空）', question.explanation, true);
  add('paper', '试卷或分组名称', question.paper);
  const matching = add('matching', '连线结构 JSON（左右项目及标准关系）', JSON.stringify(question.matching || { mode: 'one_to_one', leftItems: [], rightItems: [], correctPairs: [] }, null, 2), true);
  matching.classList.add('raw-question');
  const showRelevant = () => {
    const isMatching = select.value === 'matching';
    optionInput.hidden = ['fill_blank', 'matching'].includes(select.value); optionInput.previousElementSibling.hidden = optionInput.hidden;
    answerInput.hidden = isMatching; answerInput.previousElementSibling.hidden = isMatching;
    matching.hidden = !isMatching; matching.previousElementSibling.hidden = !isMatching;
  };
  select.addEventListener('change', showRelevant); showRelevant();
  const actions = el('div', 'editor-actions');
  const save = el('button', 'primary', '保存题目'); save.type = 'submit';
  const cancel = el('button', 'secondary', '取消编辑'); cancel.type = 'button'; cancel.onclick = onCancel;
  actions.append(save, cancel); form.append(actions);
  const errorMessage = el('p', 'question-errors editor-error'); errorMessage.setAttribute('role', 'alert'); errorMessage.tabIndex = -1; errorMessage.hidden = true; form.append(errorMessage);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    errorMessage.hidden = true;
    try {
      const position = Number(positionInput.value);
      if (!Number.isInteger(position) || position < 1 || position > total) throw new Error(`题目排序需要是 1–${total} 的整数。`);
      const type = select.value;
      const options = ['fill_blank', 'matching'].includes(type) ? [] : parseEditorOptions(controls.options.value, (Array.isArray(question.options) ? question.options : []).map(option => option?.key));
      const item = { ...question, id: typeof question.id === 'string' && question.id.trim() || `manual_${crypto.randomUUID()}`, type, stem: controls.stem.value.trim(), paper: controls.paper.value.trim(), options,
        answers: type === 'matching' ? [] : controls.answers.value.split('\n').map(v => v.trim()).filter(Boolean), explanation: controls.explanation.value.trim() || null };
      if (type === 'matching') {
        try { item.matching = JSON.parse(controls.matching.value); } catch { throw new Error('连线结构 JSON 无法解析。'); }
      } else delete item.matching;
      const errors = validateQuestion(item, { allowImages: true });
      if (errors.length) throw new Error(errors.join(' '));
      save.disabled = true; cancel.disabled = true;
      await onSave(item, position);
    } catch (error) {
      errorMessage.textContent = error.message; errorMessage.hidden = false; errorMessage.focus();
      onError?.(error.message);
    } finally { save.disabled = false; cancel.disabled = false; }
  });
  return form;
}
