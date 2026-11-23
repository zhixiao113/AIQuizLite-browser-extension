import test from 'node:test';
import assert from 'node:assert/strict';
import { bankBatches, bankSections, complete, incompleteJson, normalizeEndpoint, probeConnection, splitBankBatch, splitSource } from '../extension/lib/model.js';
const profile = { name: '测试', baseUrl: 'https://model.example/v1', model: 'test-model' };
test('connection probe accepts valid length-limited reasoning but never returns it as quiz content', async () => {
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',reasoning_content:'fixture reasoning'}}],usage:{total_tokens:256}}));
  const result=await probeConnection(profile,'fixture-key',{fetchImpl});
  assert.deepEqual(result,{usage:256,outputLimited:true});
  await assert.rejects(complete(profile,'fixture-key',[],{fetchImpl}),e=>e.code==='truncated'&&e.usage===256);
});
test('official DeepSeek connection test disables thinking; generic providers and quiz calls retain their own defaults', async () => {
  let body;const fetchImpl=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'OK'}}]}));};
  const deepseek={...profile,baseUrl:'https://api.deepseek.com',model:'deepseek-flash'};
  await probeConnection(deepseek,'fixture-key',{fetchImpl});assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.max_tokens,256);assert.equal(body.messages.length,1);
  await probeConnection(profile,'fixture-key',{fetchImpl});assert.ok(!Object.hasOwn(body,'thinking'));
  await complete(deepseek,'fixture-key',[],{fetchImpl,maxTokens:12000});assert.ok(!Object.hasOwn(body,'thinking'));assert.equal(body.max_tokens,12000);
});
test('connection probe rejects empty, filtered, malformed and reasoning-only stop responses', async () => {
  for(const body of[{choices:[]},{choices:[{finish_reason:'length',message:{content:''}}]},{choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'fixture'}}]},{choices:[{finish_reason:'content_filter',message:{content:'blocked'}}]},null]){
    await assert.rejects(probeConnection(profile,'fixture-key',{fetchImpl:async()=>new Response(JSON.stringify(body))}),e=>e.code==='invalid_response');
  }
  assert.deepEqual(await probeConnection(profile,'fixture-key',{fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}))}),{usage:null,outputLimited:false});
});
test('connection probe reports HTTP failures and cancellation without retries or exposing provider bodies', async () => {
  let count=0;
  for(const status of[401,429])await assert.rejects(probeConnection(profile,'fixture-key',{fetchImpl:async()=>{count++;return new Response('private-provider-body',{status});}}),e=>e.code===`http_${status}`&&!e.message.includes('private-provider-body'));
  assert.equal(count,2);
  const controller=new AbortController();controller.abort();
  await assert.rejects(probeConnection(profile,'fixture-key',{signal:controller.signal,fetchImpl:async(_url,{signal})=>{count++;assert.equal(signal.aborted,true);throw new Error('aborted');}}),e=>e.code==='cancelled');
  assert.equal(count,3);
});
test('endpoint handles v1 and full path, rejects credentials and non-local HTTP', () => {
  assert.equal(normalizeEndpoint(profile.baseUrl).endpoint, 'https://model.example/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://model.example/v1/chat/completions/').endpoint, 'https://model.example/v1/chat/completions');
  assert.equal(normalizeEndpoint('http://127.0.0.1:8000/v1').origin, 'http://127.0.0.1:8000/*');
  for (const url of ['http://model.example/v1', 'https://user:pass@model.example/v1', 'https://model.example/v1?key=secret']) assert.throws(() => normalizeEndpoint(url));
});
test('model call sends only explicit messages and detects usage', async () => {
  let request;
  const result = await complete(profile, 'test-key', [{ role: 'user', content: 'hello' }], { fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } })); } });
  assert.equal(result.content, 'OK'); assert.equal(result.usage, 12); assert.equal(request.options.redirect, 'error');
  assert.equal(JSON.parse(request.options.body).messages.length, 1);
});
test('401/429 mapped without exposing provider bodies or API key', async () => {
  for (const status of [401, 429]) await assert.rejects(complete(profile, 'sensitive-key', [], { fetchImpl: async () => new Response('sensitive-key provider details', { status }) }), error => error.code === `http_${status}` && !error.message.includes('sensitive-key'));
});
test('truncated and empty output rejected; missing usage stays null', async () => {
  const reply = value => async () => new Response(JSON.stringify(value));
  await assert.rejects(complete(profile, 'key', [], { fetchImpl: reply({ choices: [{ finish_reason: 'length', message: { content: '{}' } }], usage: { total_tokens: 42 } }) }), error => error.code === 'truncated' && error.usage === 42);
  await assert.rejects(complete(profile, 'key', [], { fetchImpl: reply({ choices: [] }) }), /有效文本/);
  assert.equal((await complete(profile, 'key', [], { fetchImpl: reply({ choices: [{ message: { content: 'ok' } }] }) })).usage, null);
});
test('bank batches limit question count and source length without losing or slicing a question', () => {
  const indices = Array.from({ length: 24 }, (_, i) => i + 77);
  const chunks = bankBatches(indices, () => 100);
  assert.deepEqual(chunks.map(c => c.length), [6, 6, 6, 6]); assert.deepEqual(chunks.flat(), indices);
  const large = bankBatches([0, 1, 2], i => i === 1 ? 7000 : 100);
  assert.deepEqual(large, [[0], [1], [2]]);
  assert.deepEqual(splitBankBatch([0, 1, 2]), [[0, 1], [2]]);
  assert.deepEqual(splitBankBatch([0]), []);
});
test('101 questions use 50+50+1 sections with smaller model calls entirely inside each section', () => {
  const indices = Array.from({ length: 101 }, (_, i) => i);
  assert.deepEqual(bankSections(indices).map(s => s.length), [50, 50, 1]);
  const chunks = bankBatches(indices, () => 100);
  assert.deepEqual(chunks.flat(), indices);
  assert.ok(chunks.every(c => c.length <= 6 && Math.floor(c[0] / 50) === Math.floor(c.at(-1) / 50)));
});
test('unfinished JSON is distinct from complete malformed output and quoted brackets', () => {
  for (const raw of ['{"questions":[', '{"stem":"unfinished', '```json\n{"questions":[]']) assert.equal(incompleteJson(raw), true);
  for (const raw of ['{"stem":"[text] and \\"quoted\\""}', '{bad json}', '{} trailing', '{]','not JSON']) assert.equal(incompleteJson(raw), false);
});
test('timeout and cancel abort network and do not retry paid calls', async () => {
  let count = 0;
  const pending = async (_url, { signal }) => { count++; return new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('abort')); else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); }); };
  await assert.rejects(complete(profile, 'key', [], { fetchImpl: pending, timeoutMs: 10 }), error => error.code === 'timeout');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(complete(profile, 'key', [], { fetchImpl: pending, signal: controller.signal }), error => error.code === 'cancelled');
  assert.equal(count, 2);
});
test('source chunks split at question boundaries and never silently truncate', () => {
  const source = '1. ' + 'a'.repeat(40) + '\n2. ' + 'b'.repeat(40);
  assert.equal(splitSource(source, 50).length, 2);
  assert.throws(() => splitSource('a'.repeat(100), 50), /题目边界/);
  assert.throws(() => splitSource(''), /原文/);
});
