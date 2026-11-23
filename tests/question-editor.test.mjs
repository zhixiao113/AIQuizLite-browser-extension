import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEditorOptions } from '../extension/lib/editor.js';
import { detectedQuestionNumber, placeQuestion, sortQuestions, suggestedPosition } from '../extension/lib/question-order.js';
import { completeness } from '../extension/lib/export-request.js';
import { asPathRaw } from './as-path-fixture.mjs';

test('manual options accept common delimiters and preserve wrapped commands and pipes', () => {
  for (const separator of ['|', '.', '、', '．', '：', ')']) {
    const options = parseEditorOptions(`A${separator}ip as-path-filter 1 permit _65001_\nB${separator}^65001|65002$\ncontinued`);
    assert.deepEqual(options, [{ key: 'A', text: 'ip as-path-filter 1 permit _65001_' }, { key: 'B', text: '^65001|65002$\ncontinued' }]);
  }
  assert.throws(() => parseEditorOptions('missing option key'), /选项/);
  assert.equal(parseEditorOptions('true|True')[0].key, 'true');
  assert.deepEqual(parseEditorOptions('a|甲\nb|乙').map(option => option.key), ['a', 'b']);
  assert.deepEqual(parseEditorOptions('A|first\n65001|65002\nB|second'), [{ key: 'A', text: 'first\n65001|65002' }, { key: 'B', text: 'second' }]);
});

test('question numbers are recognized without treating digits in ordinary text as a number', () => {
  for (const value of ['16', '第 16 题', '１６、题干', '16（单选题）题干', asPathRaw]) assert.equal(detectedQuestionNumber(value), 16);
  for (const value of ['', 'IP65001', '65001', '2024年题库']) assert.equal(detectedQuestionNumber(value), null);
});

test('inserting and moving questions preserves source coverage, IDs and the chosen order on later sorting', () => {
  const questions = Array.from({ length: 152 }, (_, i) => ({ id: `q${i + 1}`, _sourceOrder: i }));
  const missing = questions.splice(15, 1)[0];
  assert.equal(suggestedPosition(missing, questions), 16);
  let result = placeQuestion(questions, missing, 16);
  assert.equal(result[15].id, 'q16');
  result = placeQuestion(result, result[15], 5, 15);
  assert.equal(result[4].id, 'q16');
  assert.equal(result[4]._sourceOrder, 15);
  assert.deepEqual(sortQuestions(result).map(q => q.id), result.map(q => q.id));
  assert.ok(completeness({ bank: { questions: result }, strictCount: true, requestedCount: 152, excluded: [], coverage: { complete: true } }).full);
  assert.throws(() => placeQuestion(result, missing, 0), /题目排序/);
  assert.throws(() => placeQuestion(result, missing, 154), /题目排序/);
});

test('first, last and empty insertion positions work and unresolved numbering falls back to the end', () => {
  assert.equal(suggestedPosition({}, [{ id: 'a' }]), 2);
  const a = { id: 'a', _sourceOrder: 3 }, b = { id: 'b', _sourceOrder: 5 };
  assert.equal(placeQuestion([], a, 1)[0].id, 'a');
  assert.deepEqual(sortQuestions(placeQuestion([b], a, 1)).map(q => q.id), ['a', 'b']);
  assert.deepEqual(sortQuestions(placeQuestion([a], b, 2)).map(q => q.id), ['a', 'b']);
});

test('repeated moves in an imported bank keep stable coordinates', () => {
  let questions = ['A', 'B', 'C', 'D'].map(id => ({ id }));
  questions = placeQuestion(questions, questions[2], 2, 2);
  questions = placeQuestion(questions, questions[2], 3, 2);
  questions = placeQuestion(questions, questions[3], 1, 3);
  assert.deepEqual(sortQuestions(questions).map(q => q.id), questions.map(q => q.id));
});
