import test from 'node:test';
import assert from 'node:assert/strict';
import { assignIds, exportBank, parseJson, readBank, safeFilename, validateBank, validateQuestion } from '../extension/lib/schema.js';
import { classifyIntent } from '../extension/lib/collectors.js';
import { fixtureBank } from './fixtures.mjs';
const completeBank = { ...fixtureBank, reviewItems: [] };

test('all five APP types export with required fields and no review metadata', () => {
  const result = JSON.parse(exportBank(completeBank));
  assert.equal(result.questions.length, 5);
  assert.equal(result.questions[4].matching.correctPairs[1].rightId, 'R2');
  assert.equal(result.questions[0].index, 1);
  assert.equal(result.questions[4].numberInPaper, 5);
  assert.equal(result.questions[0].explanation, null);
  assert.deepEqual(result.questions[0].explanationImages, []);
  assert.equal(result.reviewItems, undefined);
});
test('unknown answers, duplicate IDs and bad matching references block export', () => {
  const bank = structuredClone(fixtureBank);
  bank.questions[0].answers = ['X']; bank.questions[1].id = 'q1'; bank.questions[4].matching.correctPairs[0].leftId = 'bad';
  assert.equal(validateBank(bank).issues.length, 3);
  assert.throws(() => exportBank(bank, [], 0), /未通过校验/);
});
test('missing answers and unresolved source cannot be exported', () => {
  const bank = structuredClone(fixtureBank); bank.questions[0].answers = [];
  assert.throws(() => exportBank(bank, [], 0), /未通过校验/);
  assert.throws(() => exportBank(fixtureBank, [], 1), /原文/);
});
test('explicit exclusion preserves other questions and renumbers export', () => {
  const bank = structuredClone(fixtureBank); bank.questions[0].answers = [];
  const result = JSON.parse(exportBank(bank, ['q1'], 0));
  assert.equal(result.questions.length, 4); assert.equal(result.questions[0].id, 'q2'); assert.equal(result.questions[0].index, 1);
  assert.deepEqual(bank.questions[0].answers, []);
});
test('matching reused left accepted only in left_reusable mode', () => {
  const q = structuredClone(fixtureBank.questions[4]); q.matching.correctPairs[1].leftId = 'L1';
  assert.ok(validateQuestion(q).length); q.matching.mode = 'left_reusable'; assert.deepEqual(validateQuestion(q), []);
});
test('images cannot silently disappear from text-only export', () => {
  const q = structuredClone(fixtureBank.questions[0]); q.image = 'image/q1.png'; assert.ok(validateQuestion(q).some(e => e.includes('图片')));
  q.image = null; q.explanationImages = ['https://example.org/image.png']; assert.ok(validateQuestion(q).length);
});
test('Markdown/BOM JSON is read, malformed JSON and prose rejected', () => {
  assert.deepEqual(parseJson('\uFEFF```json\n{"name":"测试","questions":[]}\n```'), { name: '测试', questions: [] });
  assert.throws(() => parseJson('题库是…'), /无法解析/); assert.throws(() => readBank('{}'), /questions/);
});
test('malformed options and answers produce errors rather than crashing', () => {
  const bank = readBank({ questions: [{ id: 'q1', type: 'single', stem: '题', options: 'bad', answers: null }] });
  assert.equal(validateBank(bank).issues.length, 1);
});
test('IDs stable within generated batch and filenames strip path characters', () => {
  assert.deepEqual(assignIds([{ id: 'q' }, { id: 'q' }, {}], 'batch').map(q => q.id), ['q', 'web_batch_2', 'web_batch_3']);
  assert.equal(safeFilename('../题库:一'), '.._题库_一.json');
});
test('whole bank intent is routed to the automatic export workflow', () => {
  for (const value of ['把这份题库导出来', '导出全部题目', '采集整份题库']) assert.equal(classifyIntent(value), 'bank');
  assert.equal(classifyIntent('整理已采集的题目'), 'prepare'); assert.equal(classifyIntent('解释 TCP'), 'chat');
  for (const value of ['继续导出这份题库', '恢复采集', '接着整理题目']) assert.equal(classifyIntent(value), 'resume');
});
test('malformed matching members and null judge options are validation errors', () => {
  const matching = structuredClone(fixtureBank.questions[4]); matching.matching.leftItems[0] = null;
  assert.ok(validateQuestion(matching).length);
  const judge = structuredClone(fixtureBank.questions[2]); judge.options[0] = null;
  assert.ok(validateQuestion(judge).length);
});
test('duplicate imported IDs can exclude a single row without removing its sibling', () => {
  const bank = readBank({ name: '重复 ID', questions: [fixtureBank.questions[0], fixtureBank.questions[0]] });
  assert.equal(validateBank(bank).issues.length, 1);
  const exported = JSON.parse(exportBank(bank, [bank.questions[0]._rowId]));
  assert.equal(exported.questions.length, 1); assert.equal(exported.questions[0]._rowId, undefined);
});
