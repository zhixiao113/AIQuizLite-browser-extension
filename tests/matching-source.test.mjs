import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot } from '../extension/lib/snapshot-parser.js';
import { reviewCandidate } from '../extension/lib/review-validator.js';
import { validateQuestion } from '../extension/lib/schema.js';

import { matchingSources } from './matching-fixtures.mjs';

for (const source of matchingSources) test(`numbered matching source ${source.number} converts complete lists and explicit pairs without AI edits`, () => {
  const question = parseSnapshot(source, `q${source.number}`, 'DataCom');
  assert.ok(question, 'explicit matching source should parse');
  assert.deepEqual(validateQuestion(question), []);
  assert.equal(question.type, 'matching');
  assert.ok(question.matching.rightItems.every(item => question.matching.correctPairs.some(pair => pair.rightId === item.id)));
  assert.ok(!question.stem.includes('正确答案'));
  assert.ok(!JSON.stringify(question.matching).includes('下一题'));
  assert.ok(!question.explanation?.includes('下一题'));
  if([89,93,99,101].includes(source.number)) assert.equal(question.explanation,null);
  if ([89,96,99,101].includes(source.number)) assert.equal(question.matching.mode, 'left_reusable');
  const result = reviewCandidate({ type:'matching', stem: '模型擅自改写了题干', options:[], answers:[], matching:{} }, source, `q${source.number}`, 'DataCom');
  assert.equal(result.question?.stem, question.stem, 'complete source takes precedence over paraphrases');
  if (source.number === 93) { assert.ok(question.stem.includes('OPSF')); assert.equal(question.matching.leftItems[2].text, 'DD Sea'); }
  if (source.number === 99) assert.equal(question.matching.leftItems[0].text, 'ip ip-prefix List 1 index 10 permit 1.1.1.0 24\ngreater-equal 24 less-equal 27');
});

test('partial source lists, missing standards, contradictory reuse and invented relations stay unparsed', () => {
  for (const rawText of [
    matchingSources[0].rawText.replace('6. Cluster_List属性\n',''),
    matchingSources[0].rawText.replace('[ 1-1,1-3,2-4,3-2,4-5,4-6 ];',''),
    matchingSources[0].rawText.replace('Token可重复使用','Token不可重复使用'),
    matchingSources[0].rawText.replace('4-6','9-6'),
    matchingSources[0].rawText.replace('4-6','4-5'),
    matchingSources[2].rawText.replace('3. P2MP\n','')
  ]) assert.equal(parseSnapshot({rawText}, 'q', 'paper'), null);
});

test('explicit matching correction replaces the older standard without borrowing relations from analysis', () => {
  const source = {rawText: matchingSources[2].rawText.replace('解析\n教材内原图：', '更改连线题答案为 [1-2,2-3,4-4,4-1];\n解析\n可能的错误示例：1-1')};
  const question = parseSnapshot(source,'q96','paper');
  assert.deepEqual(question.matching.correctPairs,[{leftId:'1',rightId:'2'},{leftId:'2',rightId:'3'},{leftId:'4',rightId:'4'},{leftId:'4',rightId:'1'}]);
  assert.equal(question._answerSource,'原文批注明确修正');
});

test('separate numeric label nodes and IP command continuations are preserved', () => {
  const source = {rawText: matchingSources[3].rawText.replace('1. ip ip-prefix', '1.\nip ip-prefix').replace('1. 1.1.1.1/32','1.\n1.1.1.1/32')};
  const question = parseSnapshot(source,'q99','paper');
  assert.equal(question.matching.rightItems[0].text,'1.1.1.1/32'); assert.ok(question.matching.leftItems[0].text.includes('greater-equal 24 less-equal 27'));
});
