import test from 'node:test';
import assert from 'node:assert/strict';
import { editedSnapshot, saveReviewEdit, orderedBlankQuestion } from '../extension/lib/review-source.js';
import { trustedOriginal } from '../extension/lib/review-validator.js';
import { deepReviewQuestion, verifyOcrEvidence, parseOcrEvidence } from '../extension/lib/deep-review.js';
import { validateQuestion, exportBank } from '../extension/lib/schema.js';
import { ModelError } from '../extension/lib/model.js';
const raw = '16\n(单选题)请选择配置\nA. ip as-path-filter 1 permit _65001_\nB. ip as-path-filter 1 permit 65001$\n正确答案：A\n我要纠错';
const image = 'data:image/png;base64,aGVsbG8=';
const config = { profile: { vision: true }, key: 'fixture-key' };
const evidence = { number: '16', rawText: raw, uncertain: false };
test('dedicated OCR plaintext is interpreted as evidence and organized only by the text model', async () => {
  const requests=[];
  const vision={profile:{vision:true,purpose:'ocr',model:'qwen3.5-ocr'},key:'fixture-ocr'};
  const text={profile:{purpose:'text',model:'deepseek-flash'},key:'fixture-text'};
  const completeImpl=async(profile,key,messages)=>{requests.push({model:profile.model,key,messages});return{content:profile.model==='qwen3.5-ocr'?raw:JSON.stringify({questions:[],reviewItems:[{sourceNumber:'16',reason:'review'}]}),usage:5};};
  const result=await deepReviewQuestion({config:vision,textConfig:text,snapshot:{number:16,rawText:raw},number:16,images:[image],id:'16',paper:'paper',completeImpl});
  assert.deepEqual(result.question.answers,['A']);assert.deepEqual(requests.map(r=>r.model),['qwen3.5-ocr','deepseek-flash']);
  assert.deepEqual(requests.map(r=>r.key),['fixture-ocr','fixture-text']);assert.ok(Array.isArray(requests[0].messages.at(-1).content));assert.equal(typeof requests[1].messages[1].content,'string');
  assert.equal(requests[0].messages.length,1);assert.equal(requests[0].messages[0].role,'user');assert.ok(!requests[0].messages[0].content[0].text.includes('只输出 JSON'));
});
test('edited review source survives a refresh without mutating original canonical data or media', () => {
  const doc = {}, item = { sourceNumber: '第16题', rawText: 'old' };
  saveReviewEdit(doc, item, raw);
  const original = { number: 16, rawText: 'refreshed', question: { stem: 'stale' }, mediaAssets: [{ id: 'asset' }] };
  const updated = editedSnapshot(original, doc);
  assert.equal(updated.rawText, raw); assert.equal(updated.question, undefined);
  assert.equal(original.question.stem, 'stale'); assert.equal(original.rawText, 'refreshed');
  assert.deepEqual(updated.mediaAssets, original.mediaAssets); assert.equal(item.rawEdited, true);
  assert.throws(() => saveReviewEdit(doc, item, ' '), /不能为空/);
  assert.throws(() => saveReviewEdit(doc, item, 'x'.repeat(10001)), /10000/);
});
test('ordered two-blank source stays one APP question with exact answer order and one input slot', () => {
  const snapshot = { rawText: '146\n(填空题)greater-equal-value-( ), less-equal-value-( )。\n正确答案：\n26\n32\n答案顺序固定\n我要纠错\n解析\n前者26后者32\n下一题' };
  const q = trustedOriginal(snapshot, 'source146', 'paper');
  assert.equal(q.type, 'fill_blank'); assert.deepEqual(q.answers, ['26,32']); assert.equal(q._orderedBlankCount, 2);
  assert.equal((q.stem.match(/____/g) || []).length, 1); assert.match(q.stem, /\[空1\].*\[空2\]/);
  assert.equal(q.explanation, '前者26后者32'); assert.deepEqual(validateQuestion(q), []);
  const exported = JSON.parse(exportBank({ name: 'paper', questions: [q], reviewItems: [] }));
  assert.equal(exported.questions.length, 1); assert.deepEqual(exported.questions[0].answers, ['26,32']);
});
test('repeated ordered blank answers are retained, while missing or extra answer lines remain pending', () => {
  const stem = '(填空题)R1( ), R2( ), R3( ), R4( ), R5( )。\n正确答案：\n';
  const q = orderedBlankQuestion({ rawText: stem + '255\n254\n0\n0\n0\n答案顺序固定' }, '148', 'paper');
  assert.deepEqual(q.answers, ['255,254,0,0,0']);
  assert.equal(orderedBlankQuestion({ rawText: stem + '255\n254\n0\n0\n0\n0\n答案顺序固定' }, '148', 'paper'), null);
  assert.equal(orderedBlankQuestion({ rawText: stem + '255\n254' }, '148', 'paper'), null);
});
test('OCR evidence rejects uncertainty, wrong question/type, missing or conflicting explicit answers', () => {
  const snapshot = { rawText: raw };
  assert.equal(verifyOcrEvidence(evidence, snapshot, 16).ocrVerified, true);
  for (const value of [{ ...evidence, uncertain: true }, { ...evidence, number: '17' }, { ...evidence, rawText: raw.replace('正确答案：A', '正确答案：B') }, { ...evidence, rawText: raw.replace('单选题', '多选题') }, { ...evidence, rawText: raw.split('正确答案：')[0] }]) assert.throws(() => verifyOcrEvidence(value, snapshot, 16));
});
test('deep review uses image inputs then isolated evidence plus original text, with no chat history', async () => {
  const requests = [], usages = [];
  const completeImpl = async (_profile, _key, messages, options) => {
    requests.push({ messages, options });
    return { content: requests.length === 1 ? JSON.stringify(evidence) : JSON.stringify({ questions: [], reviewItems: [{ sourceNumber: '16', reason: 'review' }] }), usage: 10 };
  };
  const result = await deepReviewQuestion({ config, snapshot: { rawText: raw }, number: 16, images: [image], id: '16', paper: 'paper', previousReason: '选项异常', onUsage: n => usages.push(n), completeImpl });
  assert.deepEqual(result.question.answers, ['A']); assert.equal(requests.length, 2); assert.deepEqual(usages, [10, 10]);
  assert.equal(requests[0].messages[1].content[1].type, 'image_url'); assert.equal(requests[0].messages[1].content[1].image_url.detail, 'high');
  assert.match(requests[1].messages[1].content, /图片识别原文/); assert.match(requests[1].messages[1].content, /待核对原文/);
  assert.ok(requests.every(r => r.messages.length === 2 && r.options.maxTokens === 6000));
});
test('text-only configuration and truncation cannot silently count as a successful OCR supplement', async () => {
  let calls = 0;
  const args = { config, snapshot: { rawText: raw }, number: 16, images: [image], id: '16', paper: 'paper', completeImpl: async () => { calls++; throw new ModelError('truncated', 'truncated', 12); } };
  await assert.rejects(deepReviewQuestion({ ...args, config: { profile: { vision: false } } }), /图片/); assert.equal(calls, 0);
  const usage = []; await assert.rejects(deepReviewQuestion({ ...args, onUsage: n => usage.push(n) }), e => e.code === 'truncated');
  assert.equal(calls, 1); assert.deepEqual(usage, [12]);
});

test('OCR plain text preserves code punctuation and rejects missing identity, uncertainty and malformed JSON', () => {
  const source={number:16,rawText:raw};
  assert.equal(parseOcrEvidence('```text\n'+raw+'\n```',source,16).rawText,raw);
  assert.equal(parseOcrEvidence(raw.slice(3),source,16).number,'16');
  for (const value of ['{"number":"16","rawText":', '[识别不确定]'+raw, '抱歉，我不能识别图片', raw.replace('正确答案：A','我的答案：A')]) assert.throws(()=>parseOcrEvidence(value,source,16));
  assert.throws(()=>parseOcrEvidence(raw.slice(3),{},16), /题号/);
  assert.throws(()=>verifyOcrEvidence(parseOcrEvidence(raw.replace(/^16/,'17'),source,16),source,16),/题号/);
  assert.match(parseOcrEvidence(raw,source,16).rawText, /_65001_/);
});
test('dedicated OCR without a text formatter fails before any model request', async () => {
  let calls=0;
  await assert.rejects(deepReviewQuestion({config:{profile:{vision:true,model:'qwen3.5-ocr'}},snapshot:{number:16,rawText:raw},number:16,images:[image],completeImpl:async()=>{calls++;}}),e=>e.code==='missing_text_model');
  assert.equal(calls,0);
});
test('OCR evidence is retained before a formatter JSON failure, never counted as a question', async () => {
  const saved=[];let calls=0;
  await assert.rejects(deepReviewQuestion({config,snapshot:{number:16,rawText:raw},number:16,images:[image],onEvidence:async e=>saved.push(e.rawText),completeImpl:async()=>({content:++calls===1?raw:'这是题目，但不是题库 JSON',usage:7})}), e=>e.code==='bank_json_invalid'&&/整理模型/.test(e.message));
  assert.deepEqual(saved,[raw]);assert.equal(calls,2);
});

test('OCR evidence failures retain distinct diagnostic codes',()=>{
  const cases=[
    [{...evidence,number:'17'},'ocr_number_mismatch'],
    [{...evidence,uncertain:true},'ocr_uncertain'],
    [{...evidence,rawText:''},'ocr_text_invalid'],
    [{...evidence,rawText:raw.split('正确答案：')[0]},'ocr_answer_missing'],
    [{...evidence,rawText:raw.replace('正确答案：A','正确答案：B')},'ocr_answer_conflict'],
    [{...evidence,rawText:raw.replace('单选题','多选题')},'ocr_type_mismatch']
  ];
  for(const [value,code] of cases) assert.throws(()=>verifyOcrEvidence(value,{rawText:raw},16),e=>e.code===code);
});
