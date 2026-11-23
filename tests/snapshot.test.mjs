import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot } from '../extension/lib/snapshot-parser.js';
import { validateQuestion } from '../extension/lib/schema.js';
import { snapshotText } from '../extension/lib/bank-collector.js';

test('screenshot-shaped text preserves standard answer and explanation', () => {
  const rawText = '1\n（单选题）在 IS-IS 网络中，哪个报文用于建立邻接？\nA、CSNP\nB、LSP\nC、PSNP\nD、IIH\n正确答案是：\nD\n我要纠错\n批注\n张老师确认 D 无误\n解析\nIIH 为 IS-IS-Hello\n下一题';
  const q = parseSnapshot({ rawText }, 'q1', 'DataCom');
  assert.equal(q.stem, '在 IS-IS 网络中，哪个报文用于建立邻接？');
  assert.deepEqual(q.answers, ['D']); assert.equal(q.explanation, 'IIH 为 IS-IS-Hello');
  assert.deepEqual(validateQuestion(q), []);
});
test('own answer is never promoted to standard answer', () => {
  assert.equal(parseSnapshot({ rawText: '1.（单选题）题干\nA. 选项一\nB. 选项二\n我的答案：A' }, 'q1', '题库'), null);
});
test('multi answer letters are mapped without inference', () => {
  const q = parseSnapshot({ rawText: '2.（多选题）选择正确格式\nA. JSON\nB. ZIP\nC. DOCX\n正确答案：A、B\n下一题' }, 'q2', '题库');
  assert.deepEqual(q.answers, ['A', 'B']); assert.equal(q.type, 'multi');
});
test('explicit final source correction replaces stale displayed answer',()=>{
  const q=parseSnapshot({rawText:'61（多选题）选择错误描述\nA. 甲\nB. 乙\nC. 丙\nD. 丁\n正确答案是：ABC\n批注\n确认系统答案ABC无误\n更改试题答案 ABCD\n解析\n原文解析\n下一题'},'q61','题库');
  assert.deepEqual(q.answers,['A','B','C','D']);assert.equal(q._answerSource,'原文批注明确修正');assert.deepEqual(validateQuestion(q),[]);
});
test('judge answer is remapped by truth meaning if website labels are reversed', () => {
  const q = parseSnapshot({ rawText: '3.（判断题）必须联网导入题库。\nA. 错误\nB. 正确\n正确答案：A\n下一题' }, 'q3', '题库');
  assert.equal(q.type, 'judge'); assert.deepEqual(q.answers, ['B']); assert.deepEqual(validateQuestion(q), []);
});
test('single blank retained while multiple blanks require review', () => {
  const q = parseSnapshot({ rawText: '4.（填空题）题目数组字段名为_____。\n正确答案：questions\n解析\n数据字段\n下一题' }, 'q4', '题库');
  assert.deepEqual(q.answers, ['questions']); assert.deepEqual(q.options, []);
  assert.equal(parseSnapshot({ rawText: '4.（填空题）____和____。\n正确答案：甲乙' }, 'q4', '题库'), null);
});
test('image dependent text is not converted to an apparently complete question', () => {
  assert.equal(parseSnapshot({ rawText: '1.（单选题）看图选择\nA. 一\nB. 二\n正确答案：A', imageDependent: true }, 'q1', '题库'), null);
});

test('canonical matching snapshots sent to AI include both item lists and explicit standard pairs', () => {
  const text = snapshotText({ number: 100, question: { type: 'matching', stem: '配对', options: [], answers: [], matching: { leftItems: [{ id: '1', text: 'cat' }], rightItems: [{ id: 'A', text: '猫' }], correctPairs: [{ leftId: '1', rightId: 'A' }] } } });
  assert.match(text, /左侧\n1\. cat/); assert.match(text, /右侧\nA\. 猫/); assert.match(text, /标准答案：1→A/);
});
