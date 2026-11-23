import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewCandidate, trustedOriginal } from '../extension/lib/review-validator.js';
import { parseSnapshot } from '../extension/lib/snapshot-parser.js';
import { validateQuestion } from '../extension/lib/schema.js';
import { asPathRaw } from './as-path-fixture.mjs';

const candidate = (overrides = {}) => ({
  id: 'model-id', paper: 'model-paper', type: 'single', stem: 'Question',
  options: [{ key: 'A', text: 'alpha' }, { key: 'B', text: 'beta' }],
  answers: ['A'], explanation: null, image: null, explanationImages: [], ...overrides
});
const snapshot = rawText => ({ rawText });
const inline = snapshot('1. (单选题) Question\nA. alpha B. beta\n正确答案：B');
const run = (question, original = inline) => reviewCandidate(question, original, 'source-id', 'source-paper');
const path = `images/${'a'.repeat(64)}.png`;

test('an embedded E label does not replace the real E option on its own line', () => {
  const original = { number: 16, rawText: asPathRaw };
  const result = trustedOriginal(original, 'q16', 'DataCom');
  assert.ok(result);
  assert.equal(result.options.length, 5);
  assert.equal(result.options[3].text, 'ip as-path-filter 1 permit ^65001 E. ip as-path-filter 1 permit *65001*');
  assert.equal(result.options[4].text, 'ip as-path-filter 1 permit $65001$');
  assert.deepEqual(result.answers, ['A']);
});

test('repeating the current option label inside its own line remains ambiguous', () => {
  assert.equal(trustedOriginal({ rawText: '(单选题)Question\nA. alpha\nB. 额外错误 B. beta\n正确答案：A' }, 'q', 'paper'), null);
});

test('invalid inline option parsing never overwrites the repaired AI options', () => {
  const local = parseSnapshot(inline, 'local', 'paper');
  assert.equal(local.options.length, 1);
  assert.ok(validateQuestion(local).length);
  assert.equal(trustedOriginal(inline, 'local', 'paper'), null);
  const result = run(candidate());
  assert.deepEqual(result.question.options, candidate().options);
  assert.deepEqual(result.question.answers, ['B']);
  assert.equal(result.question.id, 'source-id');
  assert.equal(result.question.paper, 'source-paper');
});

test('unlabelled fill blanks retain a valid inferred type when the parser default is invalid', () => {
  const source = snapshot('2. 在____中保存\n正确答案：A');
  assert.equal(parseSnapshot(source, 'local', 'paper').type, 'single');
  const result = run(candidate({ type: 'fill_blank', stem: '在____中保存', options: [], answers: ['model guess'] }), source);
  assert.equal(result.question.type, 'fill_blank');
  assert.deepEqual(result.question.options, []);
  assert.deepEqual(result.question.answers, ['A']);
});

test('a schema-valid original takes priority over model paraphrases and guesses', () => {
  const source = snapshot('3. (单选题) Question\nA. alpha\nB. beta\n正确答案：B\n解析：Original explanation');
  const result = run(candidate({ stem: 'Unrelated question', options: [{ key: 'A', text: 'invented' }], explanation: 'Made up' }), source);
  assert.equal(result.question.stem, 'Question');
  assert.deepEqual(result.question.answers, ['B']);
  assert.equal(result.question.explanation, 'Original explanation');
});

test('raw 对 and 错 judge labels are safely normalized', () => {
  for (const [answer, expected] of [['对', 'A'], ['错', 'B']]) {
    const source = snapshot(`4. (判断题) 地球是圆的\nA. 对\nB. 错\n正确答案：${answer}`);
    const result = run(candidate({ type: 'judge', stem: '地球是圆的', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }] }), source);
    assert.deepEqual(result.question.options, [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }]);
    assert.deepEqual(result.question.answers, [expected]);
  }
});

test('reversed raw judge B=对 maps truth instead of keeping the display key', () => {
  const source = snapshot('5. (判断题) 地球是圆的\nA. 错\nB. 对\n正确答案：B');
  const result = run(candidate({ type: 'judge', stem: '地球是圆的', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answers: ['B'] }), source);
  assert.deepEqual(result.question.answers, ['A']);
});

test('invalid canonical judge labels are repaired with their original truth mapping', () => {
  const original = { question: candidate({ type: 'judge', stem: '地球是圆的', options: [{ key: 'A', text: '错' }, { key: 'B', text: '对' }], answers: ['B'] }) };
  assert.equal(trustedOriginal(original, 'id', 'paper'), null);
  const result = run(candidate({ type: 'judge', stem: '地球是圆的', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answers: ['B'] }), original);
  assert.deepEqual(result.question.answers, ['A']);
  assert.equal(validateQuestion(result.question).length, 0);
});

const matching = () => candidate({ type: 'matching', stem: '配对', options: [], answers: [], matching: {
  mode: 'one_to_one', leftItems: [{ id: '1', text: 'cat' }, { id: '2', text: 'dog' }],
  rightItems: [{ id: 'A', text: '猫' }, { id: 'B', text: '狗' }],
  correctPairs: [{ leftId: '1', rightId: 'A' }, { leftId: '2', rightId: 'B' }]
} });
const matchingSource = answer => snapshot(`6. (连线题) 配对\n左侧\n1. cat\n2. dog\n右侧\nA. 猫\nB. 狗\n正确答案：${answer}`);

test('explicit matching standards support arrow, ASCII arrow and hyphen syntax', () => {
  for (const separator of ['→', '->', '-']) {
    const result = run(matching(), matchingSource(`1${separator}A；2${separator}B`));
    assert.deepEqual(result.question.matching.correctPairs, matching().matching.correctPairs);
    assert.deepEqual(result.question.answers, []);
  }
});

test('wrong model matching relations cannot override independently complete original standards', () => {
  const model = matching();
  model.matching.correctPairs = [{ leftId: '1', rightId: 'B' }, { leftId: '2', rightId: 'A' }];
  assert.deepEqual(run(model, matchingSource('1→A；2→B')).question.matching.correctPairs, matching().matching.correctPairs);
  const ambiguous = snapshot('(连线题)配对\ncat\ndog\n猫\n狗\n正确答案：1→A；2→B');
  assert.equal(run(model, ambiguous).code, 'ungrounded_matching');
});

test('pairs appearing outside the explicit standard answer section cannot ground a matching answer', () => {
  const source = snapshot('6. (连线题) 配对\ncat\ndog\n猫\n狗\n可能示例：1→A；2→B');
  assert.equal(run(matching(), source).code, 'ungrounded_matching');
});

test('missing original standard answers cannot be replaced by model guesses', () => {
  const source = snapshot('7. (单选题) Question\nA. alpha B. beta');
  const result = run(candidate({ answers: ['B'] }), source);
  assert.equal(result.code, 'missing_source_answer');
  assert.match(result.reason, /标准答案/);
  assert.equal(result.question, undefined);
});

test('a canonical source without answers does not borrow answers from unrelated raw text', () => {
  const source = { question: candidate({ answers: [] }), rawText: inline.rawText };
  assert.equal(run(candidate({ answers: ['B'] }), source).code, 'missing_source_answer');
});

test('an explicit original correction is used instead of the earlier answer', () => {
  const source = snapshot(`${inline.rawText}\n批注\n更改试题答案为 A`);
  assert.deepEqual(run(candidate({ answers: ['B'] }), source).question.answers, ['A']);
});

test('unlabelled multi-answer source repairs use the explicit original answer set', () => {
  const source = snapshot('8. Question\nA. alpha B. beta\n正确答案：AB');
  const result = run(candidate({ type: 'multi', answers: ['A', 'C'] }), source);
  assert.equal(result.question.type, 'multi');
  assert.deepEqual(result.question.answers, ['A', 'B']);
});

test('explicit source type cannot be changed by the model', () => {
  assert.equal(run(candidate({ type: 'fill_blank', options: [] })).code, 'source_type_mismatch');
});

test('invented stem, option text and explanation remain rejected', () => {
  for (const model of [candidate({ stem: 'invented' }), candidate({ explanation: 'invented' })]) {
    assert.equal(run(model).code, 'ungrounded_text');
  }
  assert.equal(run(candidate({ options: [{ key: 'A', text: 'invented' }, { key: 'B', text: 'beta' }] })).code, 'source_options_mismatch');
});

test('schema errors retain the precise failed fields', () => {
  const source = snapshot('在____中保存____\n正确答案：A');
  const result = run(candidate({ type: 'fill_blank', stem: '在____中保存____', options: [] }), source);
  assert.equal(result.code, 'invalid_question');
  assert.ok(result.errors.some(error => error.includes('仅支持单空填空')));
  assert.match(result.reason, /仅支持单空填空/);
});

test('swapping source option texts cannot turn the standard key into a wrong answer', () => {
  const result = run(candidate({ options: [{ key: 'A', text: 'beta' }, { key: 'B', text: 'alpha' }] }));
  assert.equal(result.code, 'source_options_mismatch');
  assert.equal(result.question, undefined);
});

test('all original option keys must remain present, even those not used by the answer', () => {
  const source = snapshot('Question\nA. alpha B. beta C. gamma D. delta\n正确答案：B');
  assert.equal(run(candidate(), source).code, 'source_options_mismatch');
  const result = run(candidate({ options: [...candidate().options, { key: 'C', text: 'gamma' }, { key: 'D', text: 'delta' }] }), source);
  assert.deepEqual(result.question.answers, ['B']);
  assert.equal(result.question.options.length, 4);
});

test('reordering or inventing source option keys remains rejected', () => {
  const reordered = candidate({ options: [{ key: 'B', text: 'beta' }, { key: 'A', text: 'alpha' }] });
  const added = candidate({ options: [...candidate().options, { key: 'C', text: 'alpha' }] });
  const invented = candidate({ options: [{ key: 'C', text: 'alpha' }, { key: 'B', text: 'beta' }] });
  for (const model of [reordered, added, invented]) assert.equal(run(model).code, 'source_options_mismatch');
});

test('canonical option maps constrain a model repairing another invalid source field', () => {
  const source = { question: candidate({ id: '', answers: ['B'] }) };
  const broken = candidate({ options: [{ key: 'A', text: 'beta' }, { key: 'B', text: 'alpha' }] });
  // A valid canonical original is preferred; use an unsupported image-free
  // multi-answer schema to make its otherwise reliable option map need AI work.
  source.question.type = 'multi';
  assert.equal(trustedOriginal(source, 'id', 'paper'), null);
  assert.equal(run({ ...broken, type: 'multi' }, source).code, 'source_options_mismatch');
});

test('option mapping accepts wrapped text without changing the original labels', () => {
  const source = snapshot('Question\nA. alpha\ncontinued B. beta\n正确答案：B');
  const result = run(candidate({ options: [{ key: 'A', text: 'alpha continued' }, { key: 'B', text: 'beta' }] }), source);
  assert.equal(result.question.options[0].text, 'alpha continued');
  assert.deepEqual(result.question.answers, ['B']);
});

test('schema-valid local parses that merged inline options are not trusted', () => {
  const source = snapshot('Question\nA. alpha B. beta\nC. gamma\n正确答案：A');
  const local = parseSnapshot(source, 'id', 'paper');
  assert.equal(validateQuestion(local).length, 0);
  assert.equal(trustedOriginal(source, 'id', 'paper'), null);
  const result = run(candidate({ options: [...candidate().options, { key: 'C', text: 'gamma' }] }), source);
  assert.equal(result.question.options.length, 3);
  assert.deepEqual(result.question.answers, ['A']);
});

test('malformed model choices return a diagnostic without throwing', () => {
  for (const options of [undefined, null, 'not an array']) {
    const result = run(candidate({ options }));
    assert.equal(result.question, undefined);
    assert.ok(result.code);
  }
});

test('media permission errors are preserved and block both model and original fallback', () => {
  const source = { ...inline, imageDependent: true, mediaError: '题图域名 static.zhiqiantong.cn 未授权。' };
  const result = run(candidate(), source);
  assert.equal(result.code, 'media_error');
  assert.equal(result.reason, source.mediaError);
  assert.equal(trustedOriginal(source, 'id', 'paper'), null);
});

test('missing saved media cannot be silently discarded', () => {
  assert.equal(run(candidate(), { ...inline, imageDependent: true, mediaAssets: [] }).code, 'missing_media');
  const canonical = { question: candidate({ answers: ['B'], image: path }), mediaAssets: [] };
  assert.equal(run(candidate(), canonical).code, 'missing_media');
  assert.equal(trustedOriginal(canonical, 'id', 'paper'), null);
});

test('saved question and explanation media remain attached to a repaired candidate', () => {
  const secondPath = `images/${'b'.repeat(64)}.jpg`;
  const source = { ...inline, imageDependent: true, mediaAssets: [{ path, role: 'question' }, { path: secondPath, role: 'explanation' }] };
  const result = run(candidate(), source);
  assert.equal(result.question.image, path);
  assert.deepEqual(result.question.explanationImages, [secondPath]);
});

test('source image references cannot silently change from question to explanation roles', () => {
  const original = { question: candidate({ image: path }), mediaAssets: [{ path, role: 'explanation' }] };
  assert.equal(run(candidate(), original).code, 'missing_media');
  assert.equal(trustedOriginal(original, 'id', 'paper'), null);
});

test('structured page-reader placeholders accept actual saved question and explanation files', () => {
  const explanationPath = `images/${'b'.repeat(64)}.jpg`;
  const original = { question: candidate({ image: 'unpackaged-question-image', explanationImages: ['unpackaged-explanation-image'] }), imageDependent: true,
    mediaAssets: [{ path, role: 'question' }, { path: explanationPath, role: 'explanation' }] };
  const result = run(candidate({ stem: 'wrong model text' }), original);
  assert.equal(result.question.image, path);
  assert.deepEqual(result.question.explanationImages, [explanationPath]);
  assert.equal(result.question.stem, 'Question');
  assert.equal(validateQuestion(result.question, { allowImages: true }).length, 0);
});

test('structured question placeholder also supports explanation-only page-reader sources', () => {
  const original = { question: candidate({ image: 'unpackaged-question-image', explanationImages: ['unpackaged-explanation-image'] }), imageDependent: true,
    mediaAssets: [{ path, role: 'explanation' }] };
  const result = run(candidate(), original);
  assert.equal(result.question.image, null);
  assert.deepEqual(result.question.explanationImages, [path]);
  assert.ok(trustedOriginal(original, 'id', 'paper'));
});

test('structured placeholders never substitute for an actual saved media descriptor', () => {
  const source = { question: candidate({ image: 'unpackaged-question-image' }), imageDependent: false, mediaAssets: [] };
  assert.equal(run(candidate(), source).code, 'missing_media');
  assert.equal(trustedOriginal(source, 'id', 'paper'), null);
  assert.equal(run(candidate(), { ...source, mediaAssets: [{ path: 'unpackaged-question-image', role: 'question' }] }).code, 'missing_media');
  assert.equal(run(candidate(), { ...source, mediaAssets: [{ path, role: 'unknown' }] }).code, 'missing_media');
});

test('structured explanation placeholder requires a saved explanation-role descriptor', () => {
  const original = { question: candidate({ image: 'unpackaged-question-image', explanationImages: ['unpackaged-explanation-image'] }), imageDependent: true,
    mediaAssets: [{ path, role: 'question' }] };
  assert.equal(run(candidate(), original).code, 'missing_media');
  assert.equal(trustedOriginal(original, 'id', 'paper'), null);
});

test('explanation-only media is retained without fabricating a question image', () => {
  const source = { ...inline, imageDependent: true, mediaAssets: [{ path, role: 'explanation' }] };
  const result = run(candidate(), source);
  assert.equal(result.question.image, null);
  assert.deepEqual(result.question.explanationImages, [path]);
});

test('invalid saved image paths return precise schema errors', () => {
  const source = { ...inline, imageDependent: true, mediaAssets: [{ path: 'https://example.com/image.png', role: 'question' }] };
  const result = run(candidate(), source);
  assert.equal(result.code, 'invalid_question');
  assert.ok(result.errors.some(error => error.includes('题图必须是已打包')));
});
