import { attachMedia } from './media.js';
import { parseSnapshot } from './snapshot-parser.js';
import { TYPES, validateQuestion } from './schema.js';
import { orderedBlankQuestion } from './review-source.js';

const normalize = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '') : '';
const failure = (code, reason, errors = []) => ({ code, reason, errors });
const answerLabel = /(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]\s*/;
const typeLabels = { 单选题: 'single', 单项选择题: 'single', 多选题: 'multi', 多项选择题: 'multi', 判断题: 'judge', 填空题: 'fill_blank', 连线题: 'matching' };

function mediaFailure(snapshot) {
  if (snapshot.mediaError) return failure('media_error', snapshot.mediaError);
  if (snapshot.imageDependent && !snapshot.mediaAssets?.length) return failure('missing_media', '题图未取得，请重新读取原题。');
  const sourceImage = snapshot.question?.image;
  const sourceExplanations = Array.isArray(snapshot.question?.explanationImages) ? snapshot.question.explanationImages : [];
  const assets = Array.isArray(snapshot.mediaAssets) ? snapshot.mediaAssets : [];
  const savedPath = path => typeof path === 'string' && /^images\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(path);
  // The page reader uses the question placeholder for any detected image,
  // including explanation-only sources. resolveMedia supplies actual roles.
  const questionSaved = sourceImage === 'unpackaged-question-image'
    ? assets.some(asset => ['question', 'explanation'].includes(asset.role) && savedPath(asset.path))
    : assets.some(asset => asset.path === sourceImage && asset.role === 'question');
  const explanationSaved = path => path === 'unpackaged-explanation-image'
    ? assets.some(asset => asset.role === 'explanation' && savedPath(asset.path))
    : assets.some(asset => asset.path === path && asset.role === 'explanation');
  if (sourceImage && !questionSaved || sourceExplanations.some(path => !explanationSaved(path))) return failure('missing_media', '原题图片引用没有对应的已保存文件。');
  return null;
}

function mediaSaved(question, snapshot) {
  const paths = [question.image, ...(Array.isArray(question.explanationImages) ? question.explanationImages : [])].filter(Boolean);
  return paths.every(path => snapshot.mediaAssets?.some(asset => asset.path === path));
}

export function trustedOriginal(snapshot, id, paper) {
  if (mediaFailure(snapshot)) return null;
  const parsed = orderedBlankQuestion(snapshot, id, paper) || parseSnapshot(snapshot, id, paper);
  if (!parsed) return null;
  const question = attachMedia(parsed, snapshot);
  return !validateQuestion(question, { allowImages: true }).length && mediaSaved(question, snapshot) &&
    (!['single', 'multi'].includes(question.type) || choiceOptionsMatch(question, snapshot)) ? question : null;
}

function sourceType(snapshot) {
  if (snapshot.question?.type) return snapshot.question.type;
  const beforeAnswer = String(snapshot.rawText || '').split(answerLabel)[0];
  const label = beforeAnswer.match(/单项选择题|多项选择题|单选题|多选题|判断题|填空题|连线题/)?.[0];
  return label ? typeLabels[label] : null;
}

function sourceText(snapshot) {
  const question = snapshot.question;
  return [snapshot.rawText || '', question?.stem || '', question?.explanation || '',
    ...(Array.isArray(question?.options) ? question.options.map(option => option?.text || '') : []),
    ...(Array.isArray(question?.matching?.leftItems) ? question.matching.leftItems.map(item => item?.text || '') : []),
    ...(Array.isArray(question?.matching?.rightItems) ? question.matching.rightItems.map(item => item?.text || '') : [])].join('\n');
}

function sourceOptions(snapshot) {
  if (snapshot.question) return Array.isArray(snapshot.question.options) ? snapshot.question.options : [];
  const raw = String(snapshot.rawText || '').normalize('NFKC').split(answerLabel)[0];
  let markers = [...raw.matchAll(/(?:^|\s)([A-H])[.、,，:：)）]\s*/g)];
  const startsLine = marker => {
    const labelIndex = marker.index + marker[0].indexOf(marker[1]);
    return !raw.slice(raw.lastIndexOf('\n', labelIndex) + 1, labelIndex).trim();
  };
  const lineMarkers = markers.filter(startsLine);
  // A complete A/B/C/... line structure is stronger evidence than a repeated
  // label embedded in an option's text. Keep that embedded text verbatim.
  if (lineMarkers.length >= 2 && lineMarkers.every((marker, index) => marker[1] === 'ABCDEFGH'[index])) {
    markers = markers.filter(marker => startsLine(marker) || !lineMarkers.some(line => line[1] === marker[1] && line.index > marker.index));
  }
  return markers.map((marker, index) => ({ key: marker[1], text: raw.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? raw.length).trim() }));
}

function choiceOptionsMatch(question, snapshot) {
  const original = sourceOptions(snapshot);
  const candidate = Array.isArray(question.options) ? question.options : [];
  if (original.length < 2 || candidate.length !== original.length || new Set(original.map(option => normalize(option?.key))).size !== original.length) return false;
  return original.every((option, index) => normalize(option?.key) && normalize(option?.text) &&
    normalize(candidate[index]?.key) === normalize(option.key) && normalize(candidate[index]?.text) === normalize(option.text));
}

function rawAnswer(snapshot) {
  const raw = String(snapshot.rawText || '').normalize('NFKC');
  const marker = answerLabel.exec(raw);
  if (!marker) return null;
  const remaining = raw.slice(marker.index + marker[0].length);
  const answer = remaining.split(/\n\s*(?:答案解析|解析|批注|我要纠错|下一题|下一页|上一题)(?:\s|[：:]|$)/)[0].trim();
  const correction = [...remaining.matchAll(/更改试题答案(?:为|[：:])?\s*([^\n]+)/g)].at(-1);
  return (correction?.[1] || answer).trim() || null;
}

function choiceAnswers(value, options) {
  if (typeof value !== 'string') return null;
  const keys = options.map(option => option?.key).filter(key => typeof key === 'string');
  const text = value.normalize('NFKC').trim();
  let answers = text.split(/[\s,，、;；]+/).filter(Boolean);
  if (answers.length === 1 && /^[A-H]+$/.test(answers[0]) && !keys.includes(answers[0])) answers = [...answers[0]];
  return answers.length && answers.every(answer => keys.includes(answer)) ? answers : null;
}

function truth(value) {
  const word = normalize(value).toLowerCase();
  if (['正确', '对', 'true', '√', '✓'].includes(word)) return 'A';
  if (['错误', '错', 'false', '×', '✗'].includes(word)) return 'B';
  return null;
}

function judgeAnswer(snapshot, value) {
  const direct = truth(value);
  if (direct) return direct;
  const key = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  const sourceOption = snapshot.question?.options?.find(option => option?.key === key);
  if (sourceOption) return truth(sourceOption.text);
  const raw = String(snapshot.rawText || '').normalize('NFKC').split(answerLabel)[0];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  const option = new RegExp(`(?:^|\\n|\\s)${escaped}[.、,:：)）]\\s*(正确|错误|对|错|true|false|√|✓|×|✗)(?=\\s|$|[A-H][.、,:：)）])`, 'i').exec(raw);
  return option ? truth(option[1]) : null;
}

function explicitAnswers(snapshot, question) {
  const source = snapshot.question;
  if (source) {
    if (!Array.isArray(source.answers) || !source.answers.length || source.answers.some(answer => typeof answer !== 'string' || !answer.trim())) return null;
    if (question.type === 'judge') {
      if (source.answers.length !== 1) return null;
      const answer = judgeAnswer(snapshot, source.answers[0]);
      return answer ? [answer] : null;
    }
    return source.answers.map(answer => answer.trim());
  }
  const value = rawAnswer(snapshot);
  if (!value) return null;
  if (question.type === 'fill_blank') return value.includes('\n') ? null : [value];
  if (question.type === 'judge') {
    const answer = judgeAnswer(snapshot, value);
    return answer ? [answer] : null;
  }
  return choiceAnswers(value, Array.isArray(question.options) ? question.options : []);
}

function matchingGrounded(question, snapshot) {
  const pairs = question.matching?.correctPairs;
  if (!Array.isArray(pairs) || !pairs.length) return false;
  let sourcePairs;
  if (snapshot.question) sourcePairs = snapshot.question.matching?.correctPairs;
  else {
    const value = rawAnswer(snapshot);
    if (!value) return false;
    sourcePairs = [...value.matchAll(/([A-Za-z0-9_]+)\s*(?:->|→|-)\s*([A-Za-z0-9_]+)/g)].map(match => ({ leftId: match[1], rightId: match[2] }));
  }
  if (!Array.isArray(sourcePairs) || sourcePairs.length !== pairs.length) return false;
  return pairs.every(pair => typeof pair?.leftId === 'string' && typeof pair?.rightId === 'string' && sourcePairs.some(source => source?.leftId === pair.leftId && source?.rightId === pair.rightId));
}

export function reviewCandidate(modelQuestion, snapshot, id, paper) {
  const mediaError = mediaFailure(snapshot);
  if (mediaError) return mediaError;
  const original = trustedOriginal(snapshot, id, paper);
  if (original) return { question: original };
  if (!modelQuestion || typeof modelQuestion !== 'object' || Array.isArray(modelQuestion)) return failure('invalid_question', 'AI 返回的题目结构无效。');
  const explicitType = sourceType(snapshot);
  if (explicitType && !Object.hasOwn(TYPES, explicitType)) return failure('unsupported_source_type', '原题题型暂不支持，请人工核对。');
  if (explicitType && modelQuestion.type !== explicitType) return failure('source_type_mismatch', 'AI 返回的题型与原文明示题型不一致。');
  if (!Object.hasOwn(TYPES, modelQuestion.type)) return failure('unsupported_type', 'AI 返回了不支持的题型。');
  const question = structuredClone(modelQuestion);
  if (['single', 'multi'].includes(question.type) && !choiceOptionsMatch(question, snapshot)) return failure('source_options_mismatch', 'AI 返回的选项标号、内容、数量或顺序未完整对应原文，不能套用原文标准答案。');
  const raw = normalize(sourceText(snapshot));
  const options = Array.isArray(question.options) ? question.options : [];
  const matchingItems = question.type === 'matching' ? [
    ...(Array.isArray(question.matching?.leftItems) ? question.matching.leftItems : []),
    ...(Array.isArray(question.matching?.rightItems) ? question.matching.rightItems : [])] : [];
  const fragments = [question.stem, ...options.filter(option => question.type !== 'judge' || !truth(option?.text)).map(option => option?.text), ...matchingItems.map(item => item?.text)];
  if (fragments.some(fragment => !normalize(fragment) || !raw.includes(normalize(fragment))) || question.explanation && !raw.includes(normalize(question.explanation))) return failure('ungrounded_text', 'AI 返回的题干、选项或解析与原文不一致。');
  if (question.type === 'matching') {
    if (!matchingGrounded(question, snapshot)) return failure('ungrounded_matching', 'AI 返回的连线关系未在原文标准答案中明确出现。');
    question.answers = [];
  } else {
    const answers = explicitAnswers(snapshot, question);
    if (!answers) return failure('missing_source_answer', '原文没有可确认的标准答案，不能采用 AI 推测答案。');
    question.answers = answers;
    if (question.type === 'judge') question.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
  }
  const candidate = attachMedia({ ...question, id, paper }, snapshot);
  const errors = validateQuestion(candidate, { allowImages: true });
  if (errors.length) return failure('invalid_question', `AI 整理后仍未通过校验：${errors.join(' ')}`, errors);
  if (!mediaSaved(candidate, snapshot)) return failure('missing_media', '题图引用没有对应的已保存文件。');
  return { question: candidate };
}
