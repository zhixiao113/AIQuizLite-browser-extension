export const fixtureBank = {
  name: '五种题型兼容样例',
  questions: [
    { id: 'q1', type: 'single', stem: '题库数据文件的格式是什么？', options: [{ key: 'A', text: 'JSON' }, { key: 'B', text: 'DOCX' }], answers: ['A'], explanation: null, image: null },
    { id: 'q2', type: 'multi', stem: 'APP 支持哪些题库格式？', options: [{ key: 'A', text: 'JSON' }, { key: 'B', text: 'ZIP' }, { key: 'C', text: 'DOCX' }], answers: ['A', 'B'], explanation: '支持已有 JSON 和图文 ZIP。', image: null },
    { id: 'q3', type: 'judge', stem: '导入已有题库必须配置模型。', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answers: ['B'], explanation: null, image: null },
    { id: 'q4', type: 'fill_blank', stem: '题目数组字段名为_______。', options: [], answers: ['questions'], explanation: null, image: null },
    { id: 'q5', type: 'matching', stem: '连接文件与用途。', options: [], answers: [], matching: { mode: 'one_to_one', leftItems: [{ id: 'L1', text: 'JSON' }, { id: 'L2', text: 'ZIP' }], rightItems: [{ id: 'R1', text: '数据' }, { id: 'R2', text: '打包' }], correctPairs: [{ leftId: 'L1', rightId: 'R1' }, { leftId: 'L2', rightId: 'R2' }] }, explanation: null, image: null }
  ],
  reviewItems: [{ sourceNumber: '6', rawText: '第 6 题仅有题干，没有标准答案。', reason: '缺少标准答案。' }]
};
