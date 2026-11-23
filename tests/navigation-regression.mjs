import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectWholeBank } from '../extension/lib/bank-collector.js';
import { readQuizPage } from '../extension/lib/page-reader.js';
import { parseSnapshot } from '../extension/lib/snapshot-parser.js';
import { validateQuestion } from '../extension/lib/schema.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const sourceUrl = 'https://fixture.invalid/paper/toExamRecitePaper/123';
await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
await page.goto(sourceUrl);
globalThis.chrome = {
  tabs: { get: async () => ({ id: 1, url: sourceUrl, title: '导航回归' }) },
  scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: await page.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source: func.toString(), args }) }] }
};
const cases = [
  { name: 'zhiqiantong analysis starts D-comma but the whole third article is the question', site: true, extra: '' },
  { name: '100 pre-rendered zhiqiantong articles preserve complete questions and answers', site: true, total:100, extra:'' },
  { name: 'visible navigation does not count hidden historical question text', extra: '', historical: true },
  { name: 'hidden duplicate question 3 is not a navigation target', extra: '<aside class="old-nav" style="display:none"><button onclick="void 0">3</button></aside>' },
  { name: 'unconfirmed third question preserves two snapshots and diagnostic; resume completes', extra: '', blocked: true },
];
const checks = [];
try {
  for (const fixture of cases) {
    await page.goto(sourceUrl);
    const total = fixture.total || 5;
    if (fixture.site) {
      await page.setContent(`<!doctype html><title>职前通结构回归</title><style>.hide{display:none}</style><p>共 ${total} 题</p><aside class="answer-card">${Array.from({length:total},(_,i)=>`<button onclick="go(${i+1})">${i+1}</button>`).join('')}</aside>${Array.from({length:total},(_,i)=>`<article class="datikaQstAnchor${i+1} t-paper-one hide" ${i===0?'style="display:block"':''}><div><span>${i+1}</span><span>（单选题）第${i+1}题的完整题干，下面哪项是本题的标准正确选项？</span></div><section><p>A、域根ID</p><p>B、根交换设备ID</p><p>C、外部路径开销</p><p>D、内部路径开销</p></section><section id="reciteanalysis${i+1}" class="is-options ml60 mr60"><p>正确答案是：<span>B</span></p><div>我要纠错</div><div>批注：确认系统答案 B 无误</div><div>解析</div><p>${i===2?'参与CIST计算的优先级向量为：<br>{根交换设备ID，外部路径开销，域根ID，内部路径开销，指定交换设备ID，指定端口I<br>D，接收端口ID}<br>括号中的向量的优先级从左到右依次递减。':'该题的明确原文解析。'}</p></section><button type="button" onclick="go(${i})">上一题</button><button type="button" onclick="go(${i+2})" ${i===total-1?'disabled':''}>下一题</button></article>`).join('')}<script>function go(n){if(n<1||n>${total})return;document.querySelectorAll('article').forEach((node,i)=>node.style.display=i===n-1?'block':'none')}</script>`);
      const result = await collectWholeBank({ tab: {id:1,url:sourceUrl},timeoutMs:800 });
      console.log(JSON.stringify({name:fixture.name,captured:result.snapshots.length,diagnostics:result.diagnostics}));
      assert.equal(result.complete,true,fixture.name);
      assert.equal(result.snapshots.length,total);
      assert.ok(result.snapshots[2].rawText.includes('第3题的完整题干'));
      assert.deepEqual(result.snapshots.map(item=>Number(item.number)).sort((a,b)=>a-b),Array.from({length:total},(_,i)=>i+1));
      result.snapshots.forEach((snapshot,i)=>{
        const question=parseSnapshot(snapshot,`q${i+1}`,'结构回归');
        assert.deepEqual(validateQuestion(question),[]);
        assert.equal(question.stem,`第${i+1}题的完整题干，下面哪项是本题的标准正确选项？`);
        assert.deepEqual(question.answers,['B']); assert.equal(question.options.length,4);
        assert.ok(!question.explanation.includes('上一题'));
      });
      checks.push({name:fixture.name,captured:result.snapshots.length});
      continue;
    }
    await page.setContent(`<!doctype html><title>导航回归</title>${fixture.extra}<p>共 ${total} 题</p><aside class="answer-card">${Array.from({ length: 5 }, (_, i) => `<button type="button" onclick="go(${i + 1})">${i + 1}</button>`).join('')}</aside><main><section class="question-item" id="quiz"></section></main><script>
      let position=1;const history=${Boolean(fixture.historical)};let blocked=${Boolean(fixture.blocked)};
      function render(){document.getElementById('quiz').innerHTML=(history && position>=3?'<div style="display:none">2（单选题）旧题文字 A、旧选项 正确答案是：A</div>':'')+'<div>'+position+'（单选题）第'+position+'题的题目内容：下面哪项是该题对应的正确标准选项？</div><p>A、选项甲</p><p>B、选项乙</p><p>正确答案是：A</p><button type="button" onclick="go(position+1)" '+(position===5?'disabled':'')+'>下一题</button>'}
      function go(n){if(blocked&&n===3)return;if(n>=1&&n<=5){position=n;render()}}render();</script>`);
    let result = await collectWholeBank({ tab: { id: 1, url: sourceUrl }, timeoutMs: 800 });
    if (fixture.blocked) {
      assert.equal(result.snapshots.length, 2); assert.equal(result.complete, false);
      assert.equal(result.diagnostics.requestedNumber, 3); assert.equal(result.diagnostics.detectedNumber, 2);
      assert.ok(!JSON.stringify(result.diagnostics).includes('正确标准选项'));
      await page.evaluate('blocked=false');
      result = await collectWholeBank({ previous: result, timeoutMs: 800 });
      assert.equal(result.diagnostics, null);
    }
    console.log(JSON.stringify({ name: fixture.name, captured: result.snapshots.length, complete: result.complete, reason: result.reason }));
    assert.equal(result.complete, true, fixture.name);
    assert.deepEqual(result.snapshots.map(item => Number(item.number)).sort((a,b)=>a-b), [1,2,3,4,5]);
    assert.ok(!result.snapshots.some(item => item.rawText?.includes('旧题文字')));
    checks.push({name:fixture.name,captured:result.snapshots.length});
    await chrome.scripting.executeScript({ func: readQuizPage, args: ['cleanup'] });
  }
  await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  await writeFile(new URL('../artifacts/navigation-report.json',import.meta.url),JSON.stringify({passed:true,version:manifest.version,testedAt:new Date().toISOString(),checks},null,2));
} finally { await browser.close(); delete globalThis.chrome; }

