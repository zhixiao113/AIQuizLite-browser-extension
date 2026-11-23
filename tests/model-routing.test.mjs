import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfileRouting, profilePurpose } from '../extension/lib/model-routing.js';
const text={id:'text',model:'deepseek-flash'},ocr={id:'ocr',model:'qwen3.5-ocr',vision:true};
test('legacy active OCR migrates to text and retains its separate vision selection and profile IDs',()=>{
 const input={activeId:'ocr',items:[text,ocr]}; const migrated=normalizeProfileRouting(input);
 assert.equal(migrated.activeId,'text');assert.equal(migrated.visionId,'ocr');assert.deepEqual(migrated.items.map(p=>p.id),['text','ocr']);assert.equal(input.activeId,'ocr');
 assert.deepEqual(normalizeProfileRouting(migrated),migrated);
});
test('purpose is independent of image capability and can be explicitly overridden',()=>{
 assert.equal(profilePurpose({model:'qwen3.5-plus',vision:true}),'text');assert.equal(profilePurpose({model:'custom-ocr-alias',purpose:'text'}),'text');assert.equal(profilePurpose({model:'custom',purpose:'ocr'}),'ocr');
 assert.equal(profilePurpose({model:'qwen-vl-ocr-2025-11-20'}),'ocr');
});
test('OCR-only profiles cannot become fallback text configs or imply image capability from names',()=>{
 const p=normalizeProfileRouting({activeId:'ocr',items:[{...ocr,vision:false}]});assert.equal(p.activeId,'');assert.equal(p.visionId,'');assert.equal(p.items[0].vision,false);
});
test('existing normal and vision selections survive migration independently',()=>{
 const p=normalizeProfileRouting({activeId:'text',visionId:'vision',items:[ocr,text,{id:'vision',model:'general',vision:true}]});assert.equal(p.activeId,'text');assert.equal(p.visionId,'vision');
});
