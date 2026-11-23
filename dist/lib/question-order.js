const order = (question, fallback) => Number.isFinite(question._sortOrder) ? question._sortOrder : Number.isFinite(question._sourceOrder) ? question._sourceOrder : fallback;

export function detectedQuestionNumber(value) {
  const match = String(value ?? '').normalize('NFKC').trim().match(/^(?:第\s*)?(\d+)\s*(?:题|[.、]|\s|[(（]|$)/);
  const number = Number(match?.[1]);
  return Number.isInteger(number) && number >= 1 && number <= 5000 ? number : null;
}

export function suggestedPosition(question, questions) {
  const sourceOrder = Number.isInteger(question._sourceOrder) && question._sourceOrder >= 0 ? question._sourceOrder
    : (detectedQuestionNumber(question.numberInPaper) || detectedQuestionNumber(question.stem)) - 1;
  if (sourceOrder < 0) return questions.length + 1;
  const following = questions.findIndex((item, index) => order(item, index) > sourceOrder);
  return following < 0 ? questions.length + 1 : following + 1;
}

// Display ordering is independent of source coverage and stable internal IDs.
export function placeQuestion(questions, question, position, replaceIndex = -1) {
  const result = questions.map((item, index) => Number.isFinite(item._sortOrder) || Number.isFinite(item._sourceOrder) ? item : { ...item, _sortOrder: index })
    .filter((_, index) => index !== replaceIndex);
  if (!Number.isInteger(position) || position < 1 || position > result.length + 1) throw new Error(`题目排序需要是 1–${result.length + 1} 的整数。`);
  const index = position - 1;
  let before = index ? order(result[index - 1], index - 1) : null;
  let after = index < result.length ? order(result[index], index) : null;
  if (before !== null && after !== null && (before >= after || (before + after) / 2 <= before || (before + after) / 2 >= after)) {
    result.forEach((item, i) => { result[i] = { ...item, _sortOrder: i }; });
    before = index - 1; after = index;
  }
  const rank = before === null ? after === null ? 0 : after - 1 : after === null ? before + 1 : (before + after) / 2;
  result.splice(index, 0, { ...question, _sortOrder: rank });
  return result;
}

export function sortQuestions(questions) {
  return questions.map((question, index) => ({ question, rank: order(question, index) }))
    .sort((a, b) => a.rank - b.rank).map(item => item.question);
}
