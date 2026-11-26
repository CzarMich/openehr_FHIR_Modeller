import {createHash} from 'node:crypto';
import {fail} from './common.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const escape = text => text.replaceAll('~', '~0').replaceAll('/', '~1');
function tokens(path) {
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || /~(?![01])/u.test(path)) fail('RULE_PATH', 'A non-root JSON Pointer is required.');
  const parts = path.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.some(p => forbidden.has(p) || p === '' || /^\d+$/.test(p))) fail('RULE_PATH', 'Only named object members are supported.');
  return parts;
}
function leaves(value, prefix = '', output = {}) {
  for (const key of Object.keys(value).sort()) {
    if (forbidden.has(key)) fail('SOURCE_FIELD', 'Reserved object member.');
    const path = `${prefix}/${escape(key)}`;
    if (path.length > 512) fail('SOURCE_DEPTH', 'Source nesting exceeds the supported bound.');
    const field = value[key];
    if (plain(field) && Object.keys(field).length) leaves(field, path, output);
    else output[path] = field === null ? 'null' : Array.isArray(field) ? 'array' : typeof field;
  }
  if (Object.keys(output).length > 256) fail('SOURCE_FIELDS', 'At most 256 fields are supported.');
  return output;
}
function recordsCheck(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 100 || !records.every(plain) || Buffer.byteLength(JSON.stringify(records)) > 262144) fail('SOURCE_BOUND', 'Provide 1 to 100 synthetic records, at most 256 KiB.');
  records.forEach(record => leaves(record));
}
export function describe(records, sourceId, sourceVersion) {
  recordsCheck(records);
  for (const value of [sourceId, sourceVersion]) if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value)) fail('SOURCE_ID', 'A bounded source identifier and version are required.');
  const counts = new Map();
  for (const record of records) {
    for (const [path, type] of Object.entries(leaves(record))) {
      const field = counts.get(path) || {path, types: new Set(), present: 0, nulls: 0};
      field.types.add(type); field.present++; if (type === 'null') field.nulls++;
      counts.set(path, field);
    }
  }
  const fields = [...counts.values()].sort((a,b) => a.path.localeCompare(b.path)).map(f => ({path:f.path, types:[...f.types].sort(), absent:records.length-f.present, nulls:f.nulls, meaning:{status:'unresolved', evidence:'structure-only', confidence:0}}));
  const schema = fields.map(f => ({path:f.path, types:f.types}));
  return {schemaVersion:1, sourceId, sourceVersion, schemaSha256:hash(schema), count:records.length, fields,
    classification:'custom-source', clinicalInterpretation:'UNRESOLVED', sampleValues:'NOT_INCLUDED'};
}
// RFC-style quoted CSV, bounded before parsing. No file/network access.
function csv(content) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const emit = () => { row.push(field); field = ''; closed = false; };
  for (let i=0; i<content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"') { if (content[i+1] === '"') { field += '"'; i++; } else { quoted=false; closed=true; } }
      else field += c;
    } else if (c === ',' ) emit();
    else if (c === '\n' || c === '\r') { if(c === '\r' && content[i+1] === '\n') i++; emit(); rows.push(row); row=[]; }
    else if (c === '"' && field === '' && !closed) quoted=true;
    else { if (closed || c === '"') fail('CSV_SYNTAX', 'Malformed quoted CSV.'); field += c; }
    if (rows.length > 101 || row.length > 256) fail('SOURCE_BOUND', 'CSV exceeds preview bounds.');
  }
  if (quoted) fail('CSV_SYNTAX', 'Unterminated CSV field.');
  if (field !== '' || row.length || closed) { emit(); rows.push(row); }
  const headers = rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length || headers.some(h => !h || forbidden.has(h))) fail('CSV_HEADERS', 'Unique nonempty headers are required.');
  return rows.map(row => { if (row.length !== headers.length) fail('CSV_WIDTH', 'CSV record width differs from headers.'); return Object.fromEntries(headers.map((h,i) => [h,row[i]])); });
}
export function inspectDataset(parameters) {
  if (parameters.synthetic !== true) fail('SYNTHETIC_REQUIRED', 'MCP inspection accepts synthetic fixtures only.');
  if (typeof parameters.content !== 'string' || Buffer.byteLength(parameters.content) > 262144) fail('SOURCE_BOUND', 'Content must be at most 256 KiB.');
  let records;
  if (parameters.format === 'csv') records=csv(parameters.content.replace(/^\uFEFF/,''));
  else if (parameters.format === 'json') { try { records=JSON.parse(parameters.content); } catch { fail('SOURCE_JSON', 'Invalid JSON.'); } }
  else fail('SOURCE_FORMAT', 'Only CSV and custom JSON are implemented.');
  return {...describe(records, parameters.sourceId, parameters.sourceVersion), format:parameters.format,
    provenance:{sourceId:parameters.sourceId, sourceVersion:parameters.sourceVersion, recordLocations:records.map((_,i) => ({record:i+1, location:parameters.format === 'csv' ? `record:${i+2}` : `/${i}`}))}};
}
function get(record, parts) {
  let value=record;
  for (const part of parts) { if (!plain(value) || !Object.hasOwn(value,part)) return {present:false}; value=value[part]; }
  return {present:true,value};
}
function put(record, parts, value) {
  let current=record;
  for (const part of parts.slice(0,-1)) current=current[part] ||= {};
  current[parts.at(-1)]=structuredClone(value);
}
function validateMapping(mapping) {
  if (!plain(mapping) || mapping.schemaVersion !== 1 || typeof mapping.version !== 'string' || !mapping.version || !['source-to-fhir','fhir-to-openehr'].includes(mapping.direction)
    || !['lossless-within-scope','retained-context','lossy','unresolved'].includes(mapping.reversibility)) fail('MAPPING_SCHEMA','Version, direction and reversibility are required.');
  if (!Array.isArray(mapping.stages) || mapping.stages.length !== (mapping.direction === 'source-to-fhir' ? 2 : 1)) fail('MAPPING_STAGES','Forward requires two explicit stages; reverse requires independent rules.');
  for (const stage of mapping.stages) {
    if (!Array.isArray(stage.rules) || !stage.rules.length || stage.rules.length > 256) fail('MAPPING_RULES','Provide 1 to 256 explicit rules per stage.');
    const targets=[];
    for (const rule of stage.rules) {
      if (!plain(rule) || typeof rule.description !== 'string' || !rule.description.trim() || !['copy','number','translate'].includes(rule.operation) || !['reject','omit'].includes(rule.missing) || !['reject','omit','preserve'].includes(rule.null)) fail('MAPPING_RULE','Unsupported or incomplete rule.');
      tokens(rule.source); tokens(rule.target);
      if (targets.some(p => p === rule.target || p.startsWith(rule.target+'/') || rule.target.startsWith(p+'/'))) fail('MAPPING_TARGET','Overlapping targets are unsupported.');
      targets.push(rule.target);
      if (rule.operation === 'number' && ((!Number.isFinite(rule.factor ?? 1)) || !Number.isFinite(rule.offset ?? 0))) fail('MAPPING_NUMBER','Finite conversion parameters are required.');
      if (rule.operation === 'translate' && (!plain(rule.dictionary) || Object.keys(rule.dictionary).some(k=>forbidden.has(k)))) fail('MAPPING_DICTIONARY','An explicit terminology dictionary is required.');
    }
  }
}
export function previewMapping(parameters) {
  if (parameters.synthetic !== true) fail('SYNTHETIC_REQUIRED','Only synthetic previews are allowed through MCP.');
  const {records,mapping,sourceId,sourceVersion}=parameters;
  const description=describe(records,sourceId,sourceVersion); validateMapping(mapping);
  if (mapping.sourceSchemaSha256 !== description.schemaSha256) fail('MAPPING_STALE','Source structure changed; inspect and review mapping again.');
  const outputs=[], rejected=[];
  const mappingSha256=hash(mapping);
  for (const [index,record] of records.entries()) {
    let current=record; const stages=[], provenance=[], unmapped=[];
    try {
      for (const [stageIndex,stage] of mapping.stages.entries()) {
        const target={}, used=new Set();
        for (const rule of stage.rules) {
          const input=get(current,tokens(rule.source));
          if (!input.present || input.value === null) {
            const policy=!input.present ? rule.missing : rule.null;
            if (policy === 'reject') fail('RECORD_REQUIRED','Required value absent or null.');
            if (policy === 'omit') continue;
          }
          let value=input.value;
          if (value !== null && rule.operation === 'number') {
            if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) fail('RECORD_NUMBER','Expected explicit numeric value.');
            const numeric=Number(value);
            if (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) fail('RECORD_NUMBER','Integer exceeds exact numeric precision.');
            value=numeric*(rule.factor ?? 1)+(rule.offset ?? 0);
            if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('RECORD_NUMBER','Numeric conversion is not finite.');
          }
          if (value !== null && rule.operation === 'translate') {
            if (!['string','number'].includes(typeof value) || !Object.hasOwn(rule.dictionary,String(value))) fail('RECORD_TERMINOLOGY','Unmapped terminology value.');
            value=rule.dictionary[String(value)];
          }
          put(target,tokens(rule.target),value); used.add(rule.source);
          provenance.push({stage:stageIndex,source:rule.source,target:rule.target,sourceId,sourceVersion,location:`/${index}${rule.source}`});
        }
        for (const path of Object.keys(leaves(current))) if (![...used].some(p => path === p || path.startsWith(p+'/'))) unmapped.push({stage:stageIndex,path,reason:'no-rule'});
        stages.push(target); current=target;
      }
      outputs.push({record:index+1,id:hash({sourceId,sourceVersion,index,record,mappingSha256}),stages,output:current,provenance,unmapped,
        informationLoss:unmapped.length ? 'UNMAPPED_CONTENT' : 'NOT_ESTABLISHED', validation:{openEHR:'NOT_EXECUTED',FHIR:'NOT_EXECUTED'}});
    } catch (error) {
      if (!['RECORD_REQUIRED','RECORD_NUMBER','RECORD_TERMINOLOGY'].includes(error.code)) throw error;
      rejected.push({record:index+1,code:error.code,location:`/${index}`});
    }
  }
  return {schemaVersion:1,mappingSha256,sourceSchemaSha256:description.schemaSha256,mode:'synthetic-preview',clinicalApproval:false,
    counts:{read:records.length,transformed:outputs.length,rejected:rejected.length,emitted:0},outputs,rejected,
    validation:{status:'NOT_EXECUTED',scope:'Deterministic rule execution only; no clinical conformance claim.'}};
}
