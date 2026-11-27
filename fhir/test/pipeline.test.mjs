import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describe,inspectDataset,previewMapping} from '../lib/pipeline.mjs';
const rule=(source,target,extra={}) => ({source,target,description:'Explicit synthetic rule',operation:'copy',missing:'reject',null:'reject',...extra});
const records=[{patient:'synthetic-1',value:0,unit:'mg',extra:'unmapped'},{patient:'synthetic-2',value:null,unit:'mg'},{patient:'synthetic-3',unit:'mg'},{patient:'synthetic-4',value:'bad',unit:'mg'}];
const mapping=() => ({schemaVersion:1,version:'1.0.0',direction:'source-direct-to-fhir',reversibility:'lossy',sourceSchemaSha256:describe(records,'lab','1').schemaSha256,
  stages:[{rules:[rule('/patient','/subject/reference'),rule('/value','/valueQuantity/value',{operation:'number'}),rule('/unit','/valueQuantity/unit',{operation:'translate',dictionary:{mg:'mg'}})]}]});
const preview=(map=mapping(),input=records) => previewMapping({synthetic:true,sourceId:'lab',sourceVersion:'1',records:input,mapping:map});
test('CSV/JSON preserve structure, missingness and locations without exposing sample values',()=>{
  const result=inspectDataset({synthetic:true,format:'csv',content:'patient,value\r\n"synthetic,one",0\r\nsynthetic-two,\r\n',sourceId:'lab',sourceVersion:'1'});
  assert.equal(result.count,2); assert.equal(result.provenance.recordLocations[0].location,'record:2');
  assert.equal(JSON.stringify(result).includes('synthetic,one'),false);
  const json=inspectDataset({synthetic:true,format:'json',content:JSON.stringify(records),sourceId:'lab',sourceVersion:'1'});
  assert.equal(json.fields.find(f=>f.path==='/value').absent,1);
  assert.equal(json.fields.find(f=>f.path==='/value').nulls,1);
  assert.equal(json.clinicalInterpretation,'UNRESOLVED');
});
test('independent source-to-FHIR rules preserve zero, reject absent/null/bad values and report loss',()=>{
  const result=preview(); assert.deepEqual(result.counts,{read:4,transformed:1,rejected:3,emitted:0});
  assert.equal(result.outputs[0].output.valueQuantity.value,0);
  assert.equal(result.outputs[0].stages[0].valueQuantity.value,0);
  assert.equal(result.outputs[0].unmapped[0].path,'/extra');
  assert.equal(JSON.stringify(result.rejected).includes('bad'),false);
  assert.equal(result.validation.status,'NOT_EXECUTED');
  assert.equal(result.outputs[0].id,preview().outputs[0].id);
});
test('null preservation and omission are explicit; empty string is never zero',()=>{
  const input=[{value:null},{value:''}]; const map={schemaVersion:1,version:'1',direction:'fhir-to-openehr',reversibility:'unresolved',sourceSchemaSha256:describe(input,'lab','1').schemaSha256,stages:[{rules:[rule('/value','/value',{null:'preserve',operation:'number'})]}]};
  const result=preview(map,input); assert.equal(result.outputs[0].output.value,null); assert.equal(result.rejected[0].code,'RECORD_NUMBER');
});
test('reverse mapping is explicit and can preserve declared semantic invariants',()=>{
  const input=[{valueQuantity:{value:5},subject:{reference:'synthetic-1'}}];
  const map={schemaVersion:1,version:'1',direction:'fhir-to-openehr',reversibility:'lossless-within-scope',sourceSchemaSha256:describe(input,'lab','1').schemaSha256,stages:[{rules:[rule('/valueQuantity/value','/magnitude'),rule('/subject/reference','/subject')]}]};
  assert.deepEqual(preview(map,input).outputs[0].output,{magnitude:5,subject:'synthetic-1'});
  map.stages=[]; assert.throws(()=>preview(map,input),{code:'MAPPING_STAGES'});
});
test('schema drift, unsafe paths, overlapping targets and implicit rules are rejected',()=>{
  const map=mapping(); map.sourceSchemaSha256='stale'; assert.throws(()=>preview(map),{code:'MAPPING_STALE'});
  for(const target of ['/__proto__/polluted','/constructor/x','/a/0','/a~9']) {
    const unsafe=mapping(); unsafe.stages[0].rules[0].target=target; assert.throws(()=>preview(unsafe),{code:'RULE_PATH'});
  }
  const overlap=mapping(); overlap.stages[0].rules[1].target='/subject'; assert.throws(()=>preview(overlap),{code:'MAPPING_TARGET'});
  const invalid=mapping(); invalid.stages[0].rules[0].operation='eval'; assert.throws(()=>preview(invalid),{code:'MAPPING_RULE'});
});
test('terminology translation rejects unknown values rather than silently copying',()=>{
  const map=mapping(); map.stages[0].rules[2].dictionary={g:'g'};
  assert.equal(preview(map).rejected[0].code,'RECORD_TERMINOLOGY');
});
test('source boundaries fail closed and custom FHIR-like JSON remains custom',()=>{
  assert.throws(()=>inspectDataset({format:'json',content:'[]'}),{code:'SYNTHETIC_REQUIRED'});
  const inspect=content=>inspectDataset({synthetic:true,format:'csv',content,sourceId:'lab',sourceVersion:'1'});
  for(const content of ['a,a\n1,2','a,b\n1','a\n"unclosed']) assert.throws(()=>inspect(content));
  assert.throws(()=>describe(Array.from({length:101},()=>({a:1})),'lab','1'),{code:'SOURCE_BOUND'});
  const result=describe([{resourceType:'Observation'}],'lab','1');assert.equal(result.classification,'custom-source');
});

test('numeric conversion rejects unsafe integer precision',()=>{
  const input=[{value:'9007199254740993'}];
  const map={schemaVersion:1,version:'1',direction:'fhir-to-openehr',reversibility:'unresolved',sourceSchemaSha256:describe(input,'lab','1').schemaSha256,stages:[{rules:[rule('/value','/value',{operation:'number'})]}]};
  assert.equal(preview(map,input).rejected[0].code,'RECORD_NUMBER');
});

test('preview record bounds count UTF-8 bytes, including multibyte values',()=>{
  assert.throws(()=>describe([{value:'é'.repeat(140000)}],'lab','1'),{code:'SOURCE_BOUND'});
});

test('all four independent routes use one stage and retired combined definitions require review',()=>{
  for (const direction of ['source-direct-to-fhir','source-to-openehr','openehr-to-fhir','fhir-to-openehr']) {
    const map=mapping();map.direction=direction;assert.equal(preview(map).outputs[0].stages.length,1);
  }
  const old=mapping();old.direction='source-to-fhir';assert.throws(()=>preview(old),{code:'LEGACY_CHAINED_MAPPING_REVIEW_REQUIRED'});
});
