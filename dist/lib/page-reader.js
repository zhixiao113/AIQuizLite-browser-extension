// Runs in the webpage's MAIN world. Return only question content, never session data.
// All helpers stay inside this function so chrome.scripting can serialize it.
export async function readQuizPage(command = 'read', argument = {}) {
  const key = '__AIQuizLiteReaderV2';
  const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (argument.origin && location.origin !== argument.origin) return { error: '页面已离开原题库来源，已停止采集。' };
  const strip = value => {
    let html = String(value ?? '');
    if (!/<\/?(?:p|div|span|br|img|table|tr|td|strong|em|sup|sub|pre|code|ul|ol|li|a|b|i)\b/i.test(html)) html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return normalize(new DOMParser().parseFromString(html, 'text/html').body.textContent);
  };
  const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden],[aria-hidden="true"]');
  const words = node => {
    const result = [];
    // Sites often retain earlier questions in hidden elements. Reject the whole
    // hidden subtree so its number/answer cannot become the current question.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(child) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.matches('script,style,noscript,input,textarea,select,[hidden],[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(child);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement?.closest('script,style,noscript,input,textarea,select')) continue;
      const value = normalize(text.textContent); if (value) result.push(value);
    }
    return result.join('\n');
  };
  const path = node => {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const parts = [];
    while (node && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = Array.from(node.parentElement?.children || []).filter(child => child.tagName === node.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`); node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const field = (obj, names) => { for (const name of names) if (obj?.[name] !== undefined && obj[name] !== null && obj[name] !== '') return obj[name]; return null; };
  const paperId = location.pathname.match(/toExamRecitePaper\/(\d+)/)?.[1] || '';
  const title = normalize(document.querySelector('[data-bank-title],.paper-title,.paperTitle,.exam-title,.test-title,h1')?.textContent || document.title).slice(0, 160);
  const imageSource = (url, role) => {
    if (!url) return null;
    try { const parsed = new URL(url, location.href); if (/^https?:$/.test(parsed.protocol) || /^data:image\//.test(parsed.href)) return { url: parsed.href, role }; } catch {}
    return null;
  };
  const htmlImages = (html, role) => Array.from(new DOMParser().parseFromString(String(html || ''), 'text/html').querySelectorAll('img')).map(img => imageSource(img.getAttribute('src'), role)).filter(Boolean);

  function canonical(obj, index) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const owner = field(obj, ['paperId', 'examPaperId']);
    if (paperId && owner && String(owner) !== paperId) return null;
    const stem = field(obj, ['stem', 'questionContent', 'qstContent', 'questionTitle', 'questionName', 'subject', 'question', 'content']);
    if (typeof stem !== 'string' || !strip(stem)) return null;
    const rawOptions = field(obj, ['options', 'optionList', 'questionOptions', 'answerOptions', 'qstOptions']);
    let options = [];
    if (Array.isArray(rawOptions)) options = rawOptions.map((o, i) => typeof o === 'string' ? { key: String.fromCharCode(65 + i), text: strip(o) } : { key: normalize(field(o, ['key', 'label', 'optionKey', 'optionLabel']) || String.fromCharCode(65 + i)), text: strip(field(o, ['text', 'content', 'optionContent', 'value'])) });
    else for (const letter of 'ABCDEFGH') {
      const value = field(obj, [`option${letter}`, `qst${letter}`, `answer${letter}`]);
      if (typeof value === 'string' && strip(value)) options.push({ key: letter, text: strip(value) });
    }
    let answer = field(obj, ['correctAnswer', 'standardAnswer', 'rightAnswer', 'qstAnswer', 'answerKeys', 'correctAnswers', 'answers', 'answer']);
    if (!options.length && !answer && !obj.matching) return null;
    let type = normalize(field(obj, ['type', 'questionTypeName', 'qstTypeName', 'questionType']));
    if (/多选|多项/.test(type)) type = 'multi'; else if (/单选|单项/.test(type)) type = 'single'; else if (/判断/.test(type)) type = 'judge'; else if (/填空/.test(type)) type = 'fill_blank'; else if (/连线|匹配/.test(type)) type = 'matching';
    let answers = Array.isArray(answer) ? answer.filter(a => typeof a === 'string').map(normalize) : typeof answer === 'string' || typeof answer === 'boolean' ? [normalize(answer)] : [];
    if (!['single', 'multi', 'judge', 'fill_blank', 'matching'].includes(type)) type = options.length ? (/^[A-H\s,，、;；]+$/.test(answers.join('')) && answers.join('').replace(/[^A-H]/g, '').length > 1 ? 'multi' : 'single') : '';
    if (type === 'single' || type === 'multi') answers = answers.flatMap(a => /^[A-H\s,，、;；]+$/.test(a) ? a.match(/[A-H]/g) || [] : [a]);
    if (type === 'judge') {
      if (answers.length === 1 && /^(正确|对|true)$/i.test(answers[0])) answers = ['A'];
      else if (answers.length === 1 && /^(错误|错|false)$/i.test(answers[0])) answers = ['B'];
      else {
        const selected = options.find(option => option.key === answers[0]);
        if (answers.length === 1 && /^(正确|对|true)$/i.test(selected?.text || '')) answers = ['A'];
        else if (answers.length === 1 && /^(错误|错|false)$/i.test(selected?.text || '')) answers = ['B'];
        else answers = [];
      }
      options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
    }
    const id = normalize(field(obj, ['id', 'questionId', 'qstId'])) || `item_${index}`;
    const explanation = field(obj, ['explanation', 'analysis', 'answerAnalysis', 'qstAnalyse', 'qstAnalysis', 'qstAnalyze']);
    const mediaSources = [...htmlImages(stem, 'question'), ...htmlImages(explanation, 'explanation')];
    for (const option of Array.isArray(rawOptions) ? rawOptions : Array.from('ABCDEFGH', letter => field(obj, [`option${letter}`, `qst${letter}`, `answer${letter}`]))) {
      mediaSources.push(...htmlImages(typeof option === 'string' ? option : field(option, ['text', 'content', 'optionContent', 'value']), 'question'));
    }
    const directImage = field(obj, ['image', 'questionImage']); if (typeof directImage === 'string') { const source = imageSource(directImage, 'question'); if (source) mediaSources.push(source); }
    for (const image of Array.isArray(obj.explanationImages) ? obj.explanationImages : []) { const source = imageSource(image, 'explanation'); if (source) mediaSources.push(source); }
    const imageDependent = mediaSources.length > 0;
    const sourceNumber = field(obj, ['numberInPaper', 'questionNumber', 'number', 'index', 'sort']);
    const matching = type === 'matching' && obj.matching ? { mode: obj.matching.mode,
      leftItems: Array.isArray(obj.matching.leftItems) ? obj.matching.leftItems.map(i => ({ id: normalize(i?.id), text: strip(i?.text) })) : [],
      rightItems: Array.isArray(obj.matching.rightItems) ? obj.matching.rightItems.map(i => ({ id: normalize(i?.id), text: strip(i?.text) })) : [],
      correctPairs: Array.isArray(obj.matching.correctPairs) ? obj.matching.correctPairs.map(p => ({ leftId: normalize(p?.leftId), rightId: normalize(p?.rightId) })) : [] } : null;
    return { identity: id, number: normalize(sourceNumber || index), numberKnown: sourceNumber !== null, question: {
      id: `web_${paperId || 'bank'}_${id}`, type, stem: strip(stem), options, answers, explanation: explanation ? strip(explanation) : null,
      image: imageDependent ? 'unpackaged-question-image' : null, explanationImages: explanation && /<img\b/i.test(explanation) ? ['unpackaged-explanation-image'] : [], ...(matching ? { matching } : {})
    }, imageDependent, mediaSources };
  }
  function scan(value) {
    const candidates = []; const seen = new WeakSet(); let visits = 0;
    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 7 || visits++ > 12000 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node.length <= 5000) {
          const items = node.map((item, i) => canonical(item, i + 1)).filter(Boolean);
          if (items.length && items.length === node.length) candidates.push(items);
        }
        for (const child of node.slice(0, 5000)) walk(child, depth + 1);
      } else for (const [name, child] of Object.entries(node)) {
        if (/(token|cookie|password|credential|session|auth|user|member|login)/i.test(name)) continue;
        walk(child, depth + 1);
      }
    }
    walk(value); return candidates;
  }
  function inlineData(doc) {
    const lists = [];
    for (const script of Array.from(doc.querySelectorAll('script')).slice(0, 150)) {
      const source = script.textContent || ''; if (source.length > 4 * 1024 * 1024) continue;
      if (script.type === 'application/json') { try { lists.push(...scan(JSON.parse(source))); } catch {} }
      const pattern = /(?:var|let|const)\s+\w*(?:question|qst|paper|exam)\w*\s*=\s*/gi;
      let match;
      while ((match = pattern.exec(source))) {
        let start = pattern.lastIndex; if (!['[', '{'].includes(source[start])) continue;
        let depth = 0, quoted = false, escaped = false;
        for (let end = start; end < source.length; end++) {
          const c = source[end];
          if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
          else if (c === '"') quoted = true;
          else if (c === '[' || c === '{') depth++;
          else if ((c === ']' || c === '}') && --depth === 0) { try { lists.push(...scan(JSON.parse(source.slice(start, end + 1)))); } catch {} break; }
        }
      }
    }
    return lists;
  }
  const state = window[key] || { apiItems: [], apiPagination: null, armed: false };
  function captureJson(value, requestUrl, method = 'GET') {
    const lists = scan(value).sort((a, b) => b.length - a.length);
    if (lists[0]) for (const item of lists[0]) {
      const old = state.apiItems.findIndex(q => q.identity === item.identity);
      if (old < 0) state.apiItems.push(item); else state.apiItems[old] = item;
      if (state.apiItems.length >= 5000) break;
    }
    if (method !== 'GET' || !lists[0]) return;
    try {
      const url = new URL(requestUrl, location.href);
      if (url.origin !== location.origin || /token|sid|key|auth|session/i.test(url.search)) return;
      const name = Array.from(url.searchParams.keys()).find(n => /^(page|pageNo|pageNum|pageNumber)$/i.test(n));
      const current = name && Number(url.searchParams.get(name));
      const meta = value?.data || value;
      const pages = Number(meta?.totalPages || meta?.pages || value?.totalPages);
      const size = Number(meta?.pageSize || meta?.size);
      const knownNumbers = lists[0].every(item => item.numberKnown);
      const safeOrdinal = knownNumbers || Number.isInteger(size) && size > 0 && size <= 5000;
      if (name && Number.isInteger(current) && current >= 1 && Number.isInteger(pages) && pages >= current && pages <= 500) {
        state.apiPagination = { url: url.href, parameter: name, current, pages, safeOrdinal };
        if (!knownNumbers && safeOrdinal) for (const [i, item] of lists[0].entries()) item.number = String((current - 1) * size + i + 1);
      }
    } catch {}
  }
  if (command === 'install' && !state.armed) {
    state.armed = true; state.fetch = window.fetch; state.xhrSend = XMLHttpRequest.prototype.send;
    state.fetchWrapper = function (...args) {
      const response = state.fetch.apply(this, args);
      response.then(r => {
        if (r.ok && r.headers.get('content-type')?.includes('json')) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          r.clone().text().then(raw => { if (raw.length <= 4 * 1024 * 1024) { try { captureJson(JSON.parse(raw), url, args[1]?.method || args[0]?.method || 'GET'); } catch {} } }).catch(() => {});
        }
      }).catch(() => {}); return response;
    };
    state.xhrWrapper = function (...args) {
      this.addEventListener('load', () => { try { if (this.status >= 200 && this.status < 300 && this.getResponseHeader('content-type')?.includes('json')) { const value = this.responseType === 'json' ? this.response : this.responseText?.length <= 4 * 1024 * 1024 ? JSON.parse(this.responseText) : null; captureJson(value, this.responseURL, 'UNKNOWN'); } } catch {} }, { once: true });
      return state.xhrSend.apply(this, args);
    };
    window.fetch = state.fetchWrapper; XMLHttpRequest.prototype.send = state.xhrWrapper; window[key] = state;
  }
  if (command === 'cleanup') {
    if (window.fetch === state.fetchWrapper) window.fetch = state.fetch;
    if (XMLHttpRequest.prototype.send === state.xhrWrapper) XMLHttpRequest.prototype.send = state.xhrSend;
    delete window[key]; return { cleaned: true };
  }
  const candidates = inlineData(document);
  for (const name of Object.keys(window).filter(name => /question|qst|paper|exam/i.test(name) && name !== key).slice(0, 80)) {
    try { if (typeof window[name] === 'object') candidates.push(...scan(window[name])); } catch {}
  }
  for (const node of Array.from(document.querySelectorAll('#app,[data-v-app],main,.exam-content,.paper-content')).slice(0, 15)) {
    try { if (node.__vue__?.$data) candidates.push(...scan(node.__vue__.$data)); } catch {}
  }
  if (command === 'probe') {
    // Re-read only the current page, in its own logged-in browser context.
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await state.fetch?.call(window, location.href, { credentials: 'same-origin', signal: abort.signal }) || await fetch(location.href, { credentials: 'same-origin', signal: abort.signal });
      const html = await response.text();
      if (response.ok && html.length < 4 * 1024 * 1024 && !/<title>\s*用户登录/.test(html)) candidates.push(...inlineData(new DOMParser().parseFromString(html, 'text/html')));
    } catch {} finally { clearTimeout(timeout); }
  }
  if (command === 'api-page' && state.apiPagination) {
    const spec = state.apiPagination; const url = new URL(spec.url);
    const requested = Number(argument.page);
    if (!Number.isInteger(requested) || requested < 1 || requested > spec.pages || url.origin !== location.origin) return { error: '分页范围无效。' };
    url.searchParams.set(spec.parameter, String(requested));
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 12000);
    try { const r = await state.fetch.call(window, url, { credentials: 'same-origin', signal: abort.signal }); if (!r.ok) return { error: r.status === 401 ? '登录已失效，请重新登录。' : `题目接口返回 ${r.status}，任务已暂停。` }; captureJson(await r.json(), url.href); }
    catch { return { error: '题目接口读取失败，已保留采集结果。' }; } finally { clearTimeout(timer); }
  }
  const elements = Array.from(document.querySelectorAll('a,button,[onclick],[role="button"],[data-question-index],[data-qst-id]'));
  const numeric = elements.filter(node => /^\d{1,4}$/.test(normalize(node.textContent)) && visible(node));
  const numbers = Array.from(new Set(numeric.map(node => Number(normalize(node.textContent))))).sort((a, b) => a - b);
  const contiguous = numbers.length >= 2 && numbers[0] === 1 && numbers.at(-1) === numbers.length;
  const totalText = words(document.body).match(/(?:共|总计|总题数[：:]?)\s*(\d{1,4})\s*(?:道|题)/)?.[1];
  const expected = contiguous ? Math.max(numbers.length, Number(totalText) || 0) : totalText ? Number(totalText) : null;
  const navigation = contiguous ? numbers.map(number => {
    const node = numeric.find(n => Number(normalize(n.textContent)) === number);
    return { number, selector: path(node) };
  }) : [];
  const currentNavigation = numeric.find(n => n.matches('.active,.current,.selected,[aria-current="true"],[aria-current="page"]'));
  const markerFor = text => text.match(/(?:^|\n)\s*(\d{1,4})\s*(?:[.、．]\s*|\n\s*|\s*)[（(]?(?:单选|多选|单项|多项|判断|填空|连线)/);
  const anchorNumber = node => Number(String(node.className).match(/(?:^|\s)datikaQstAnchor(\d+)(?:\s|$)/)?.[1]) || null;
  const questionBody = node => {
    const text = words(node);
    const answerAt = text.search(/(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]/);
    const beforeAnswer = answerAt < 0 ? text : text.slice(0, answerAt);
    if (!/单选题|多选题|单项选择题|多项选择题|填空题|判断题|连线题/.test(beforeAnswer)) return false;
    return answerAt >= 0 || (beforeAnswer.match(/(?:^|\n)[A-H][.、．,，]\s*/g) || []).length >= 2 || /填空题|判断题|连线题/.test(beforeAnswer);
  };
  // Prefer the site's complete question article. An analysis may contain an
  // uppercase letter after a line break; that alone is never an option list.
  const siteRoots = Array.from(document.querySelectorAll('article.t-paper-one')).filter(node => visible(node) && questionBody(node));
  const preferred = siteRoots.find(node => Number(markerFor(words(node))?.[1] || anchorNumber(node)) === Number(argument.numberHint)) || siteRoots[0];
  const containers = Array.from(document.querySelectorAll('[data-question-id],[data-qst-id],.question-item,.questionItem,.question-content,.questionContent,.qst-content,.question,.exam-content,.paper-content,[class*="testContent"],[class*="question-detail"]'));
  const rawBlocks = containers.filter(node => visible(node) && /正确答案|标准答案|参考答案|单选题|多选题|单项选择|多项选择|填空题|判断题|连线题/.test(words(node))).sort((a, b) => words(a).length - words(b).length);
  let root = preferred || rawBlocks.find(node => questionBody(node));
  if (!root) {
    const answerNode = Array.from(document.querySelectorAll('p,div,span')).find(node => visible(node) && /^(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]/.test(normalize(node.textContent)) && node.textContent.length < 300);
    let parent = answerNode;
    while (parent && parent !== document.body) {
      if (questionBody(parent)) { root = parent; break; }
      parent = parent.parentElement;
    }
  }
  if (!root) root = document.querySelector('main,[role="main"],article') || document.body;
  const raw = words(root).slice(0, 50000);
  const typeWords = raw.match(/单选题|多选题|单项选择题|多项选择题|填空题|判断题|连线题/)?.[0] || '';
  const marker = markerFor(raw);
  const number = Number(marker?.[1] || (root.matches('article.t-paper-one') ? anchorNumber(root) : null) || normalize(currentNavigation?.textContent)) || null;
  const next = elements.find(node => visible(node) && /^(?:下一题|下一道题|下一页|下题|Next)$/i.test(normalize(node.textContent || node.getAttribute('aria-label'))));
  const nextDisabled = next ? next.disabled || next.getAttribute('aria-disabled') === 'true' || /(?:^|\s)disabled(?:\s|$)/.test(next.className) : true;
  const hasQuestion = Boolean(typeWords || /正确答案|标准答案|参考答案/.test(raw));
  const textNodes = Array.from(root.querySelectorAll('span,p,div,button')).filter(visible);
  const answerNode = textNodes.find(node => /^(?:正确答案|标准答案|参考答案)(?:是|为)?\s*[：:]/.test(normalize(node.textContent)) && node.textContent.length < 100);
  const analysisNode = textNodes.find(node => /^(?:答案解析|解析)\s*[：:]?$/.test(normalize(node.textContent)));
  const after = (node, reference) => reference && Boolean(reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  const mediaSources = []; let mediaError = '';
  for (const image of Array.from(root.querySelectorAll('img,canvas')).filter(visible)) {
    if (/头像|avatar|profile|emoji|icon/i.test(`${image.getAttribute('alt') || ''} ${image.className}`)) continue;
    if (image.closest('button,[role="button"]') && /批注|纠错|上一题|下一题|解析/.test(words(image.closest('button,[role="button"]')))) continue;
    let role = 'question';
    if (after(image, answerNode)) { if (!after(image, analysisNode)) continue; role = 'explanation'; }
    let url = image.currentSrc || image.src;
    if (image.tagName === 'CANVAS') { try { url = image.toDataURL('image/png'); } catch { mediaError = '题图 canvas 读取受限，请补齐原图。'; url = ''; } }
    const source = imageSource(url, role); if (source) mediaSources.push(source); else mediaError ||= '可见题图没有有效来源，请补齐原图。';
  }
  const screen = hasQuestion ? { identity: number ? `number_${number}` : raw, number: number ? String(number) : '', rawText: raw, imageDependent: mediaSources.length > 0 || Boolean(mediaError), mediaSources, mediaError } : null;
  if (command === 'capture-layout') {
    if (!screen || number !== Number(argument.numberHint) || root === document.body || root === document.documentElement) return { error: '无法确认原题号或题目区域，不能截图其他内容。' };
    if (window.top !== window) return { error: '内嵌题库暂不支持截图定位，请编辑原文后使用普通 AI 核对。' };
    const offset = Number(argument.offset) || 0;
    const initial = root.getBoundingClientRect();
    if (initial.height > 12000 || initial.width > innerWidth) return { error: '题目区域过大，请缩小网页显示比例后重试。' };
    let header = 16;
    for (const node of document.querySelectorAll('header,nav,[class*="header"]')) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (['fixed', 'sticky'].includes(style.position) && rect.top <= 0 && rect.bottom < innerHeight / 3) header = Math.max(header, rect.bottom + 8);
    }
    window.scrollTo({ top: Math.max(0, scrollY + initial.top + offset - header), behavior: 'instant' });
    // A user can switch tabs mid-capture; hidden tabs may suspend animation
    // frames indefinitely. Bound this wait so cancellation still takes effect.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 180);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
    const rect = root.getBoundingClientRect(), y = rect.top + offset;
    if (y < header - 1 || rect.left < 0 || rect.right > innerWidth + 1 || y >= innerHeight - 20) return { error: '题目区域未完整进入可见页面，请滚动到原题后重试。' };
    const height = Math.min(rect.height - offset, innerHeight - y - 8);
    if (height < 1) return { error: '无法取得完整题目截图。' };
    return { screen, url: `${location.origin}${location.pathname}`, rect: { x: rect.left, y, width: rect.width, height },
      viewport: { width: innerWidth, height: innerHeight }, totalHeight: rect.height };
  }
  if (state.apiItems.length) candidates.push(state.apiItems);
  candidates.sort((a, b) => (expected ? Number(b.length === expected) - Number(a.length === expected) : 0) || b.length - a.length);
  const structured = candidates.find(list => !expected || list.length <= expected) || [];
  const selected = command === 'navigate' ? (argument.number ? navigation.find(item => item.number === argument.number)?.selector : next && !nextDisabled ? path(next) : null) : null;
  if (command === 'navigate') {
    const node = selected && document.querySelector(selected);
    if (!node) return { error: argument.number ? '无法定位指定题号，任务已暂停。' : '没有可用的下一题入口。' };
    if (node.closest('form') && node.tagName === 'BUTTON' && node.type !== 'button') return { error: '该按钮可能提交作答，已停止自动点击。' };
    const href = node.getAttribute('href');
    if (href && !href.startsWith('javascript:') && new URL(href, location.href).origin !== location.origin) return { error: '下一题跳转到其他来源，已停止自动采集。' };
    node.click(); return { clicked: true };
  }
  return { title, url: `${location.origin}${location.pathname}`, structured, screen, expected, navigation, currentNumber: number,
    viewport: { width: innerWidth, height: innerHeight },
    nextAvailable: Boolean(next && !nextDisabled), terminal: Boolean(next && nextDisabled), apiPagination: state.apiPagination,
    diagnostics: { readerVersion: '0.5.7', rootTag: root.tagName.toLowerCase(), rootId: root.id.slice(0, 120), rootClasses: String(root.className).slice(0, 240),
      markerNumber: Number(marker?.[1]) || null, navigationNumber: Number(normalize(currentNavigation?.textContent)) || null,
      navigationCount: navigation.length, visibleQuestionRootCount: rawBlocks.length, textLength: raw.length },
    loginRequired: /用户登录/.test(document.title) && !screen, frameUrl: location.href };
}
